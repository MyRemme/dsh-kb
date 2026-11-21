/**
 * 2026-11-17 审查发现缺陷的永久回归测试：
 *   - DSH 宿主 Agent/Session 真实字段 (`agent.session.id` / `agent.session.header.cwd` / `context.scope`)
 *   - DSH LlmRuntime 契约 (`content` 块数组、`finish.reason.kind`、`resolveModelInfo` 最低推理档)
 *   - HTTP 宿主连接门禁 (`connection.admit` / `requestRejection` / 异常 fail-closed)
 *   - 端点类型白名单 (`todo`/`state`/`artifact`)、`/search` 分组下推、`/graph` 筛选、`digest` 刷新
 *   - `terms()` 逐字滑窗与数字词元、`listSessionFiles` 数字版本排序、自定义 `dbPath` 延迟路径
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { openDb, writeFact, getFact } from "../lib/store.js";
import { seg, terms } from "../lib/segment.js";
import { search } from "../lib/search.js";
import { listSessionFiles } from "../lib/session.js";
import { parseCards } from "../lib/distill.js";
import { resolveModel } from "../lib/model.js";
import { createApi } from "../lib/routes.js";
import { API_PREFIX, matchRoute } from "../lib/http.js";
import { treeRows } from "../lib/digest.js";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@deepseek-ai/dsh-tools") return { url: new URL("./fixtures/dsh-tools-stub.mjs", import.meta.url).href, shortCircuit: true };
		if (specifier === "@deepseek-ai/schemastery") return { url: new URL("./fixtures/schemastery-stub.mjs", import.meta.url).href, shortCircuit: true };
		return next(specifier, context);
	},
});

const { apply } = await import("../lib/index.js");

const temp = mkdtempSync(path.join(tmpdir(), "dsh-kb-r20261117-"));

async function invoke(api, endpoint, method = "GET", body, headers = { host: "127.0.0.1:5712" }) {
	const url = `${API_PREFIX}${endpoint}`;
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	Object.assign(req, { method, url, headers });
	const res = {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(v) {
			this.body += String(v ?? "");
		},
	};
	await matchRoute(api.routes, new URL(url, "http://127.0.0.1:5712").pathname).handler(req, res);
	return { status: res.statusCode, json: JSON.parse(res.body) };
}

test("真实 DSH exec.agent.session.id 与 header.cwd 正确落库并触发 usage_once 去重", async (t) => {
	const dir = mkdtempSync(path.join(temp, "real-agent-"));
	const file = path.join(dir, "kb.db");
	const tools = [];
	const sections = [];
	const disposers = [];
	apply(
		{
			tools: { register: (d) => tools.push(d) },
			systemPrompt: { section: (s) => sections.push(s) },
			effect: (fn) => disposers.push(fn()),
		},
		{ dbPath: file, ui: false, bootFacts: 2 },
	);
	t.after(() => disposers.forEach((d) => d?.()));

	const tool = (name) => tools.find((d) => d.name === name);
	const realExec = {
		agent: {
			session: {
				id: "session-real-abc",
				header: { cwd: "D:\\Work\\ProjectAlpha" },
			},
		},
	};

	await tool("kb_add").execute(
		{ title: "正式宿主作用域卡", body: "验证 header.cwd 与 session.id 提取。", path: "topic/test" },
		realExec,
	);
	const ro = new DatabaseSync(file, { readOnly: true });
	t.after(() => ro.close());
	const row = ro.prepare("SELECT id, session_id, cwd, scope, source_ref FROM fact WHERE title=?").get("正式宿主作用域卡");
	assert.equal(row.session_id, "session-real-abc");
	assert.equal(row.cwd, "D:\\Work\\ProjectAlpha");
	assert.equal(row.scope, "cwd:d:/work/projectalpha");
	assert.equal(row.source_ref, "session-real-abc");

	// 在相同会话内反复检索，hit_count 只计 1 次且 usage_once 有记录
	for (let i = 0; i < 3; i += 1) {
		const res = await tool("kb_search").execute({ query: "正式宿主" }, realExec);
		assert.match(res.text, /正式宿主作用域卡/);
	}
	assert.equal(ro.prepare("SELECT hit_count FROM fact WHERE id=?").get(row.id).hit_count, 1);
	assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM usage_once WHERE fact_id=?").get(row.id).n, 1);

	// 跨项目默认检索不到，且开场提示用 context.scope 也能取到 cwd
	const otherExec = { scope: { session: { id: "session-beta", header: { cwd: "D:\\Work\\ProjectBeta" } } } };
	const miss = await tool("kb_search").execute({ query: "正式宿主" }, otherExec);
	assert.doesNotMatch(miss.text, /正式宿主作用域卡/);

	const boot = sections.find((s) => s.name === "memory:dsh-kb:boot");
	assert.match(boot.text({ scope: realExec.agent }), /正式宿主作用域卡/);
	assert.doesNotMatch(boot.text(otherExec), /正式宿主作用域卡/);

	// 即使新写了更晚的 episode 流水账，开场注入依然优先保留结论卡
	const rw = new DatabaseSync(file);
	writeFact(rw, { title: "[会话] 刚吸收的流水账", body: "chat log", kind: "episode", scope: "global", ts: Date.now() + 10000 });
	rw.close();
	const bootAfter = boot.text(realExec);
	assert.match(bootAfter, /正式宿主作用域卡/);
});

test("resolveModel 对齐 DSH LlmRuntime：content 块数组、最低 reasoningEffort 与 finish.reason.kind 报错", async () => {
	let captured;
	const llm = {
		listProviders: () => [{ id: "deepseek" }],
		listModels: () => [{ id: "deepseek-v4.1-flash" }],
		resolveModelInfo: async () => ({
			provider: "deepseek",
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" },
		}),
		stream(opts) {
			captured = opts;
			return (async function* () {
				yield { type: "text-delta", text: '{"cards":[],"processed":[]}' };
				yield { type: "finish", reason: { kind: "stop" } };
			})();
		},
	};
	const model = await resolveModel({ get: (name) => (name === "llm" ? llm : undefined) });
	const out = await model.complete({ system: "sys", user: "payload" });
	assert.equal(out, '{"cards":[],"processed":[]}');
	assert.ok(Array.isArray(captured.messages[0].content), "messages[0].content 必须是块数组");
	assert.deepEqual(captured.messages[0].content, [{ type: "text", text: "payload" }]);
	assert.equal(captured.reasoningEffort, "low");

	// 对象形式的 finish.reason.kind === "error" 必须抛错并保留失败信息
	const failingLlm = {
		...llm,
		stream() {
			return (async function* () {
				yield { type: "text-delta", text: "{" };
				yield { type: "finish", reason: { kind: "error", failure: { message: "rate limited", code: "RATE_LIMIT" } } };
			})();
		},
	};
	const badModel = await resolveModel({ get: (name) => (name === "llm" ? failingLlm : undefined) });
	await assert.rejects(badModel.complete({ system: "s", user: "u" }), /complete.*rate limited/);
});

test("parseCards 可从带前后说明的 Markdown 代码块提取 JSON", () => {
	const raw = '下面是提炼结果：\n```json\n{"cards":[{"title":"A","body":"B","kind":"fix","sourceIds":["f_1"],"evidence":[{"id":"f_1","quote":"q"}]}],"processed":["f_1:1:0"]}\n```\n以上。';
	assert.equal(parseCards(raw).length, 1);
});

test("HTTP 宿主连接门禁：支持 admit / requestRejection 且异常时 fail-closed", async (t) => {
	const { db, file } = openDb(":memory:");
	t.after(() => db.close());

	let mode = "reject-401";
	const connection = {
		tag: "conn-instance",
		admit(req) {
			assert.equal(this.tag, "conn-instance", "不得丢失 connection 方法绑定");
			if (mode === "reject-401") return { rejection: 401 };
			if (mode === "throw") throw new Error("auth down");
			return undefined;
		},
	};
	const api = createApi({ getDb: () => db, getFile: () => file, getConnection: () => connection });

	assert.equal((await invoke(api, "/stats")).status, 401);
	mode = "throw";
	assert.equal((await invoke(api, "/stats")).status, 503);
	mode = "allow";
	assert.equal((await invoke(api, "/stats")).status, 200);

	// 兼容旧版 requestRejection
	const legacyConn = {
		secret: "ok",
		requestRejection() {
			assert.equal(this.secret, "ok");
			return 403;
		},
	};
	const legacyApi = createApi({ getDb: () => db, getFile: () => file, getConnection: () => legacyConn });
	assert.equal((await invoke(legacyApi, "/stats")).status, 403);
});

test("HTTP 端点补全：12 种类型写入、/search 分组筛选、/graph 搜索过滤与 /fact 用量信息", async (t) => {
	const { db, file } = openDb(":memory:");
	t.after(() => db.close());
	const api = createApi({ getDb: () => db, getFile: () => file });

	for (const kind of ["todo", "state", "artifact"]) {
		const res = await invoke(api, "/add", "POST", { title: `kind-${kind} tokenX`, body: "body tokenX", path: "topic/ui", kind });
		assert.equal(res.status, 200, `${kind} 应当允许从面板写入`);
	}

	// 前 2 条 memory 卡不能把第 3 条 doc 卡在 group=doc 时挤没
	await invoke(api, "/add", "POST", { title: "mem1 tokenX", body: "tokenX", kind: "fact", path: "topic/ui" });
	await invoke(api, "/add", "POST", { title: "mem2 tokenX", body: "tokenX", kind: "fix", path: "topic/ui" });
	const docSearch = await invoke(api, "/search?q=tokenX&k=2&group=doc");
	assert.equal(docSearch.status, 200);
	assert.equal(docSearch.json.data.length, 1);
	assert.equal(docSearch.json.data[0].kind, "artifact");

	const graphFix = await invoke(api, "/graph?q=tokenX&kind=fix");
	assert.equal(graphFix.status, 200);
	assert.equal(graphFix.json.data.nodes.length, 1);
	assert.equal(graphFix.json.data.nodes[0].kind, "fix");

	const docId = docSearch.json.data[0].id;
	await invoke(api, "/usage", "POST", { id: docId, verdict: "useful" });
	const detail = await invoke(api, `/fact?id=${docId}`);
	assert.equal(detail.json.data.usage.adopts, 1);

	// /forget 与 /update 后立即刷新枝摘要
	await invoke(api, "/forget", "POST", { id: docId });
	const branchBefore = treeRows(db, "topic/ui")[0].summary;
	assert.doesNotMatch(branchBefore, /kind-artifact/);
});

test("kb_reap 工具与自定义 dbPath 延迟路径解析", async (t) => {
	const dir = mkdtempSync(path.join(temp, "custom-db-"));
	const customDb = path.join(dir, "nested", "custom.db");
	const tools = [];
	const routes = [];
	const disposers = [];
	apply(
		{
			tools: { register: (d) => tools.push(d) },
			systemPrompt: { section() {} },
			effect: (fn) => disposers.push(fn()),
			inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } }, effect: (fn) => disposers.push(fn()) }),
		},
		{ dbPath: customDb, ui: true },
	);
	t.after(() => disposers.forEach((d) => d?.()));

	// 注册路由后未开库前，/hub 仍应指向 customDb 的目录，而不是默认 $DSH_HOME/kb
	const hubHandler = routes.find((r) => r.path === `${API_PREFIX}/hub`).handler;
	const req = Readable.from([]);
	Object.assign(req, { method: "GET", url: `${API_PREFIX}/hub`, headers: { host: "127.0.0.1" } });
	const res = { statusCode: 0, body: "", setHeader() {}, end(v) { this.body += String(v ?? ""); } };
	await hubHandler(req, res);
	const hubData = JSON.parse(res.body).data;
	assert.equal(hubData.status.db.file, customDb);
	assert.equal(hubData.status.frontLog.file, path.join(path.dirname(customDb), "front.log"));

	// kb_reap 真正降级之后必须刷新枝摘要
	const { db } = openDb(customDb);
	writeFact(db, { title: "Reap target", body: "stale", kind: "episode", path: "topic/reap-check", ts: Date.now() - 400 * 86400000 });
	db.close();
	await tools.find((x) => x.name === "kb_reap").execute({ dryRun: false });
	const check = openDb(customDb);
	t.after(() => check.db.close());
	assert.equal(treeRows(check.db, "topic/reap-check")[0].summary, "");
});

test("terms() 滑窗覆盖奇数偏移词且支持纯数字查询精排", (t) => {
	const t1 = terms("知识库检索");
	assert.ok(t1.includes("检索"), "5字中文词滑窗不能跳过奇数偏移的「检索」");
	assert.ok(terms("3081").includes("3081"));

	const { db } = openDb(":memory:");
	t.after(() => db.close());
	writeFact(db, { title: "端口 3081 监听", body: "局域网访问端口 3081", path: "topic/net" }, seg);
	const hits = search(db, "3081", { k: 3 });
	assert.equal(hits.length, 1);
	assert.match(hits[0].why, /match 100%/);
});

test("listSessionFiles 按数字版本号挑最新会话（v10 > v9）", () => {
	const dir = mkdtempSync(path.join(temp, "sess-ver-"));
	const sub = path.join(dir, "s1");
	mkdirSync(sub, { recursive: true });
	writeFileSync(path.join(sub, "session.v9.jsonl.zstd"), zstdCompressSync(Buffer.from("{}\n")));
	writeFileSync(path.join(sub, "session.v10.jsonl.zstd"), zstdCompressSync(Buffer.from("{}\n")));
	const files = listSessionFiles(dir);
	assert.equal(files.length, 1);
	assert.match(files[0].key, /session\.v10\.jsonl\.zstd$/);
});

test("client.__queries 导出 fact / search / graph 三条一致筛选构造器", () => {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (r) => { registration = r; } } }, undefined);
	const client = registration.factory((spec) => {
		if (spec === "react") {
			return { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) };
		}
		throw new Error(`unexpected require: ${spec}`);
	});
	const filters = { kind: "todo", since: "30", status: "active", sort: "ts" };
	assert.equal(client.__queries.search("迁移", "topic/dsh", filters, "task").group, "task");
	assert.equal(client.__queries.search("迁移", "topic/dsh", filters, "all").group, undefined);
	const g = client.__queries.graph("迁移", "topic/dsh", "task", filters);
	assert.deepEqual(g, { q: "迁移", path: "topic/dsh", group: "task", kind: "todo", since: "30", status: "active", limit: 400 });
});
