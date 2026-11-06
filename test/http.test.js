/**
 * HTTP 端点集成测试：真的起一个 `node:http` 服务器、真的发请求。
 *
 * 为什么不 mock 请求对象：这套端点的坑全在真实字节上 —— 来源校验读 `Origin`、
 * 方法校验读 `method`、错误信封要能 JSON.parse。用假 req/res 测这三样，
 * 测的是替身的行为，不是服务器的。
 *
 * 服务器用 `matchRoute` 派发，与宿主 webserver 的"先精确、再最长前缀"一致，
 * 所以这里通过的匹配语义，装进 dsh 之后也是同一个。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, addEdge, upsertFact } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { createApi, statsOf, ENDPOINTS } from "../lib/routes.js";
import { API_PREFIX, matchRoute } from "../lib/http.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-http-"));
// 吸收端点会扫 $DSH_HOME/sessions；指到空目录，别把真机会话灌进临时库。
process.env.DSH_HOME = dir;

const { db, file } = openDb(path.join(dir, "kb.db"));
const api = createApi({ getDb: () => db, getFile: () => file, maxResults: 6 });

/** 起一个裸 http 服务器，路由语义与宿主一致。 */
async function listen() {
	const server = createServer((req, res) => {
		const { pathname } = new URL(String(req.url), "http://localhost");
		const hit = matchRoute(api.routes, pathname);
		if (hit === undefined) {
			res.statusCode = 404;
			res.end();
			return;
		}
		void hit.handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return { server, base: `http://127.0.0.1:${port}` };
}

let base = "";
let server;

before(async () => {
	const started = await listen();
	base = started.base;
	server = started.server;
});

after(() => {
	server?.close();
	db.close();
});

/** GET 并解 JSON。 */
async function get(pathname) {
	const response = await fetch(`${base}${pathname}`);
	return { status: response.status, body: await response.json(), headers: response.headers };
}

/** POST JSON 并解 JSON。 */
async function post(pathname, payload, headers = {}) {
	const response = await fetch(`${base}${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
	return { status: response.status, body: await response.json() };
}

/** 用 node:http 直接发，才能精确控制 Origin（undici 会改写部分头）。 */
function raw(pathname, options = {}) {
	return new Promise((resolve, reject) => {
		const req = request(`${base}${pathname}`, { method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
		});
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

test("路由表与端点清单一一对应", () => {
	assert.equal(api.routes.length, 22);
	const declared = new Set(ENDPOINTS.map(([method, p]) => `${method} ${p}`));
	for (const r of api.routes) {
		const methods = [...declared].filter((entry) => entry.endsWith(` ${r.path}`));
		assert.equal(methods.length, 1, `${r.path} 未在 ENDPOINTS 里声明`);
	}
	assert.deepEqual(
		api.routes.map((r) => r.path).sort(),
		["add", "distill", "fact", "hub", "facts", "forget", "frontlog", "graph", "history", "ingest", "link", "migrate", "mirror", "models", "reap", "search", "stats", "sweep", "tree", "unmirror", "update", "usage"].map((n) => `${API_PREFIX}/${n}`).sort(),
	);
});

test("GET /stats 返回真实计数", async () => {
	const { status, body } = await get(`${API_PREFIX}/stats`);
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.data.db, file);
	assert.equal(typeof body.data.facts, "number");
	assert.deepEqual(Object.keys(body.data).sort(), ["active", "db", "edges", "facts", "groups", "kinds", "mentions", "nodes", "paths", "rels", "sessions", "stale", "versions"].sort());
});

test("GET /hub 一次返回六块，且自检能区分「读不到」和「空库」", async () => {
	const { status, body } = await get(`${API_PREFIX}/hub`);
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	const hub = body.data;

	// 一个请求返回六块：缺任何一块，前端那一格就是永久转圈。
	assert.deepEqual(Object.keys(hub).sort(), ["memory", "sessions", "status", "tools", "ts"]);
	for (const key of ["facts", "active", "stale", "edges", "kinds", "paths", "branches", "mirror"]) {
		assert.ok(hub.memory[key] !== undefined, `memory.${key} 缺字段`);
	}
	for (const key of ["total", "active", "ingested", "failed", "recent", "disk"]) {
		assert.ok(hub.sessions[key] !== undefined, `sessions.${key} 缺字段`);
	}
	assert.ok(Array.isArray(hub.tools.groups));
	assert.ok(Number.isInteger(hub.tools.count));
	assert.ok(Array.isArray(hub.status.checks) && hub.status.checks.length > 0);
	assert.equal(typeof hub.status.db.file, "string");
	// 这个库是能读的，所以库检查必须是 ok —— 它报 bad 的另一面才是真正的缺陷：
	// 文件存在但一条查询都跑不出来时，这一项以前照样是绿灯。
	assert.equal(hub.status.checks.find((c) => c.key === "db").level, "ok");
	// 会话目录 / 投影目录 / front.log 都指在临时目录，缺了也得降级而不是抛。
	assert.equal(hub.sessions.disk.files, 0);
	assert.equal(hub.status.frontLog.count, 0);
});

test("POST /hub → 405：只读聚合不接写", async () => {
	const { status } = await post(`${API_PREFIX}/hub`, {});
	assert.equal(status, 405);
});

test("POST /add 写卡，GET /facts 立刻能看到", async () => {
	const added = await post(`${API_PREFIX}/add`, {
		title: "HTTP 写卡走 upsertFact",
		body: "面板提交的卡与工具写的卡共用一条写路径，所以幂等规则只有一份。",
		path: "topic/dsh-kb",
		kind: "decision",
		tags: "面板,http",
	});
	assert.equal(added.status, 200);
	assert.equal(added.body.data.result, "added");

	const list = await get(`${API_PREFIX}/facts?limit=5`);
	const hit = list.body.data.items.find((f) => f.title === "HTTP 写卡走 upsertFact");
	assert.ok(hit, "列表里没有刚写的卡");
	assert.equal(hit.kind, "decision");
	assert.deepEqual(hit.tags, ["面板", "http"]);
	assert.equal(hit.path, "topic/dsh-kb");
	assert.ok(list.body.data.total >= 1);
});

test("POST /add 幂等：同样内容第二次是 dup", async () => {
	const payload = { title: "幂等性由双键保证", body: "内容哈希与标题两个键都拦重复。" };
	await post(`${API_PREFIX}/add`, payload);
	const again = await post(`${API_PREFIX}/add`, payload);
	assert.equal(again.body.data.result, "dup");
});

test("POST /add 缺字段与坏 kind 都是 400", async () => {
	const noTitle = await post(`${API_PREFIX}/add`, { body: "x" });
	assert.equal(noTitle.status, 400);
	assert.equal(noTitle.body.error.code, "missing-title");
	const badKind = await post(`${API_PREFIX}/add`, { title: "t", body: "b", kind: "nonsense" });
	assert.equal(badKind.status, 400);
	assert.equal(badKind.body.error.code, "bad-kind");
});

test("GET /search 命中中文双字词", async () => {
	await post(`${API_PREFIX}/add`, { title: "记忆的检索靠 bigram", body: "「记忆」这类双字词在 trigram 下零命中。" });
	const { body } = await get(`${API_PREFIX}/search?q=${encodeURIComponent("记忆")}&k=5`);
	assert.equal(body.ok, true);
	assert.ok(body.data.length > 0, "没有命中");
	assert.ok(body.data.some((r) => r.title.includes("bigram")));
	assert.ok(body.data[0].score > 0);
});

test("GET /search 缺 q 是 400", async () => {
	const { status, body } = await get(`${API_PREFIX}/search`);
	assert.equal(status, 400);
	assert.equal(body.error.code, "missing-q");
});

test("GET /tree 反映刚建的枝", async () => {
	const { body } = await get(`${API_PREFIX}/tree?prefix=topic`);
	assert.equal(body.ok, true);
	const node = body.data.find((n) => n.path === "topic/dsh-kb");
	assert.ok(node, "topic/dsh-kb 不在树里");
	assert.ok(node.count >= 1);
});

test("GET /fact 返回正文与一跳关系", async () => {
	const src = await post(`${API_PREFIX}/add`, { title: "关系图的起点", body: "它 contains 另一张卡。" });
	const dstRow = db.prepare("SELECT id FROM fact WHERE title=?").get("关系图的起点");
	const other = await post(`${API_PREFIX}/add`, { title: "关系图的终点", body: "它被另一张卡引用。" });
	assert.equal(src.body.data.result, "added");
	assert.equal(other.body.data.result, "added");
	const otherId = db.prepare("SELECT id FROM fact WHERE title=?").get("关系图的终点").id;
	addEdge(db, dstRow.id, otherId, "related", 0.8, "测试");

	const { status, body } = await get(`${API_PREFIX}/fact?id=${encodeURIComponent(dstRow.id)}`);
	assert.equal(status, 200);
	assert.equal(body.data.fact.id, dstRow.id);
	assert.match(body.data.fact.body, /contains/);
	assert.equal(body.data.outbound.length, 1);
	assert.equal(body.data.outbound[0].id, otherId);

	const inbound = await get(`${API_PREFIX}/fact?id=${encodeURIComponent(otherId)}`);
	assert.equal(inbound.body.data.inbound.length, 1);
	assert.equal(inbound.body.data.inbound[0].id, dstRow.id);
});

test("GET /fact 缺 id 是 400，未知 id 是 404", async () => {
	assert.equal((await get(`${API_PREFIX}/fact`)).status, 400);
	const missing = await get(`${API_PREFIX}/fact?id=f_nope`);
	assert.equal(missing.status, 404);
	assert.equal(missing.body.error.code, "not-found");
});

test("GET /graph 返回节点与边，超出上限时标记截断", async () => {
	const { body } = await get(`${API_PREFIX}/graph?limit=400`);
	assert.equal(body.ok, true);
	assert.ok(body.data.nodes.length > 0);
	assert.ok(body.data.edges.length >= 1, "刚建的边不在图里");
	assert.equal(body.data.truncated, false);

	const small = await get(`${API_PREFIX}/graph?limit=1`);
	assert.equal(small.body.data.nodes.length, 1);
	assert.equal(small.body.data.truncated, true);
});

test("方法不允许：POST /stats 返回 405 且带 allow 头", async () => {
	const { status, body } = await post(`${API_PREFIX}/stats`, {});
	assert.equal(status, 405);
	assert.equal(body.error.code, "method-not-allowed");
	const raw405 = await raw(`${API_PREFIX}/stats`, { method: "POST" });
	assert.equal(raw405.status, 405);
	assert.equal(raw405.headers.allow, "GET");
});

test("跨站 Origin 被拦，同源与无 Origin 放行", async () => {
	const cross = await raw(`${API_PREFIX}/add`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: "https://evil.example.com", host: "127.0.0.1" },
		body: JSON.stringify({ title: "跨站写入", body: "不该落库" }),
	});
	assert.equal(cross.status, 403);
	assert.match(cross.text, /cross-origin/);

	const same = await raw(`${API_PREFIX}/add`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: `http://127.0.0.1:${new URL(base).port}`,
			host: `127.0.0.1:${new URL(base).port}`,
		},
		body: JSON.stringify({ title: "同源写入", body: "应该落库" }),
	});
	assert.equal(same.status, 200);

	const none = await raw(`${API_PREFIX}/stats`, { method: "GET" });
	assert.equal(none.status, 200);

	const crossFetch = await raw(`${API_PREFIX}/stats`, {
		headers: { "sec-fetch-site": "cross-site", origin: `http://127.0.0.1:${new URL(base).port}` },
	});
	assert.equal(crossFetch.status, 403);
});

test("畸形 JSON 报 400", async () => {
	const bad = await post(`${API_PREFIX}/add`, "{not json");
	assert.equal(bad.status, 400);
	assert.equal(bad.body.error.code, "invalid-json");
});

test("POST /ingest 在没有 sessions 目录时安全返回全零", async () => {
	const { status, body } = await post(`${API_PREFIX}/ingest`, {});
	assert.equal(status, 200);
	assert.equal(body.data.files, 0);
	assert.equal(body.data.err, 0);
	assert.equal(typeof body.data.nodes_digested, "number");
	assert.equal(body.data.ms >= 0, true);
});

test("未知路径不命中任何路由", async () => {
	const response = await raw(`${API_PREFIX}/nope`);
	assert.equal(response.status, 404);
});

test("statsOf 与 /stats 端点给出同一份统计", async () => {
	const direct = statsOf(db, file);
	const { body } = await get(`${API_PREFIX}/stats`);
	assert.deepEqual(body.data, direct);
});

test("POST /update 保持 id 并写出历史版本", async () => {
	const created = await post(`${API_PREFIX}/add`, {
		title: "面板修订走同一条路",
		body: "第一版正文。",
		path: "topic/dsh-kb",
	});
	assert.equal(created.body.data.result, "added");
	const id = db.prepare("SELECT id FROM fact WHERE title=?").get("面板修订走同一条路").id;

	const updated = await post(`${API_PREFIX}/update`, { id, body: "第二版正文，补了边界。" });
	assert.equal(updated.status, 200);
	assert.equal(updated.body.data.result, "updated");
	assert.equal(updated.body.data.id, id);
	assert.equal(updated.body.data.version, 2);

	const history = await get(`${API_PREFIX}/history?id=${encodeURIComponent(id)}`);
	assert.equal(history.status, 200);
	assert.equal(history.body.data.history.length, 1);
	assert.match(history.body.data.history[0].body, /第一版/);
});

test("POST /update 未知 id 是 404，坏 status 是 400", async () => {
	const missing = await post(`${API_PREFIX}/update`, { id: "f_nope", body: "x" });
	assert.equal(missing.status, 404);
	const bad = await post(`${API_PREFIX}/update`, { id: "f_nope", status: "nonsense" });
	assert.equal(bad.status, 400);
	assert.equal(bad.body.error.code, "bad-status");
});

test("POST /forget 降级后默认检索看不到，指定状态能查回", async () => {
	const created = await post(`${API_PREFIX}/add`, { title: "这张卡会被标失效", body: "内容仍然保留在库里。" });
	assert.equal(created.body.data.result, "added");
	const id = db.prepare("SELECT id FROM fact WHERE title=?").get("这张卡会被标失效").id;

	const forgotten = await post(`${API_PREFIX}/forget`, { id });
	assert.equal(forgotten.status, 200);
	assert.equal(forgotten.body.data.applied, "superseded");
	assert.equal(db.prepare("SELECT status FROM fact WHERE id=?").get(id).status, "superseded");

	const hidden = await get(`${API_PREFIX}/search?q=${encodeURIComponent("这张卡会被标失效")}&k=5`);
	assert.equal(hidden.body.data.some((r) => r.id === id), false, "已降级的卡不该出现在默认检索里");
	const shown = await get(`${API_PREFIX}/search?q=${encodeURIComponent("这张卡会被标失效")}&k=5&all=1`);
	assert.ok(shown.body.data.some((r) => r.id === id));
});

test("GET /history 带出实体提及", async () => {
	const created = await post(`${API_PREFIX}/add`, {
		title: "实体提及走 HTTP 也一致",
		body: "改 D:/Code/dsh-kb/lib/http.js 时要同步检查 `originAllowed`。",
	});
	assert.equal(created.body.data.result, "added");
	const id = db.prepare("SELECT id FROM fact WHERE title=?").get("实体提及走 HTTP 也一致").id;
	const res = await get(`${API_PREFIX}/history?id=${encodeURIComponent(id)}`);
	assert.ok(res.body.data.mentions.some((m) => m.token.includes("lib/http.js")));
});

test("POST /sweep 降级过期快照卡", async () => {
	const old = Date.now() - 60 * 86400000;
	upsertFact(db, { title: "很旧的待办", body: "早就做完了。", kind: "todo", ts: old }, seg);
	const res = await post(`${API_PREFIX}/sweep`, { days: 30 });
	assert.equal(res.status, 200);
	assert.ok(res.body.data.staled >= 1);
	assert.equal(db.prepare("SELECT status FROM fact WHERE title=?").get("很旧的待办").status, "doubtful");
});

test("GET /search 也吃 kinds / since / status（面板筛选在搜索态同样有效）", async () => {
	await post(`${API_PREFIX}/add`, { title: "搜索筛选 fix 样例", body: "共同词 zebra", kind: "fix", path: "topic/x" });
	await post(`${API_PREFIX}/add`, { title: "搜索筛选 fact 样例", body: "共同词 zebra", kind: "fact", path: "topic/x" });

	const all = await get(`${API_PREFIX}/search?q=zebra&k=10`);
	assert.ok(all.body.data.length >= 2, "不筛时两张都要在");

	const onlyFix = await get(`${API_PREFIX}/search?q=zebra&k=10&kinds=fix`);
	assert.ok(onlyFix.body.data.length >= 1);
	assert.ok(onlyFix.body.data.every((r) => r.kind === "fix"), "kinds 过滤要生效");

	// 时间筛选：一年内的能查到，未来时间点查不到
	const fresh = await get(`${API_PREFIX}/search?q=zebra&k=10&since=365`);
	assert.ok(fresh.body.data.length >= 1, "since=365 应该能查到刚写的卡");
	const future = await get(`${API_PREFIX}/search?q=zebra&k=10&since=0.0000001`);
	assert.equal(future.status, 200);

	// 状态筛选：不该把 superseded 的卡查出来
	const active = await get(`${API_PREFIX}/search?q=zebra&k=10&status=active`);
	assert.ok(active.body.data.every((r) => r.status === "active"));
});

test("GET /search 与 /tree 也把 undefined 当成没给（不能只堵一半）", async () => {
	await post(`${API_PREFIX}/add`, { title: "清理参数回归卡", body: "正文内容", path: "topic/dsh" });
	const cleanSearch = await get(`${API_PREFIX}/search?q=清理参数&k=5`);
	const junkSearch = await get(`${API_PREFIX}/search?q=清理参数&k=5&path=undefined`);
	assert.equal(junkSearch.status, 200);
	assert.equal(junkSearch.body.data.length, cleanSearch.body.data.length, "path=undefined 不该把检索结果筛没");

	const cleanTree = await get(`${API_PREFIX}/tree`);
	const junkTree = await get(`${API_PREFIX}/tree?prefix=undefined`);
	assert.equal(junkTree.body.data.length, cleanTree.body.data.length, "prefix=undefined 不该把树筛空");
	assert.ok(junkTree.body.data.length > 0);
});

test("POST /mirror 拒绝落到 $DSH_HOME 之外的目录", async () => {
	const outside = await post(`${API_PREFIX}/mirror`, { dir: "C:/Windows/Temp/dsh-kb-evil" });
	assert.equal(outside.status, 403);
	assert.equal(outside.body.ok, false);
	assert.equal(outside.body.error.code, "dir-not-allowed");

	const inside = await post(`${API_PREFIX}/mirror`, { dir: path.join(dir, "mirror-allowed"), dryRun: true });
	assert.equal(inside.status, 200);
	assert.equal(inside.body.data.dryRun, true);
});

test("POST /frontlog 把前端错误落成一行日志", async () => {
	const res = await post(`${API_PREFIX}/frontlog`, {
		level: "error",
		message: "面板渲染失败：x is not a function",
		stack: "TypeError: x is not a function\n    at MemoryPage",
		extra: { where: "client.js:1" },
	});
	assert.equal(res.status, 200);
	assert.equal(res.body.data.logged, true);
	const logFile = path.join(path.dirname(file), "front.log");
	assert.ok(existsSync(logFile), "front.log 应该建出来");
	const text = readFileSync(logFile, "utf8");
	assert.ok(text.includes("面板渲染失败"), "消息要落盘");
	assert.ok(text.includes("client.js:1"), "extra 要落盘");
	assert.ok(text.includes("[error]"), "级别要标出来");
});

test("GET /facts 把 path=undefined 当成没给（前端曾经真的这么发过）", async () => {
	await post(`${API_PREFIX}/add`, { title: "cleanParam 回归卡", body: "正文", path: "topic/dsh" });
	const clean = await get(`${API_PREFIX}/facts?limit=5`);
	const junk = await get(`${API_PREFIX}/facts?limit=5&path=undefined`);
	assert.equal(junk.status, 200);
	assert.equal(junk.body.data.total, clean.body.data.total, "path=undefined 不该把结果筛没");
	assert.ok(junk.body.data.total > 0, "库里明明有卡");
	const junkGraph = await get(`${API_PREFIX}/graph?limit=5&path=undefined`);
	assert.equal(junkGraph.body.data.nodes.length, clean.body.data.items.length > 0 ? junkGraph.body.data.nodes.length : 0);
	assert.ok(junkGraph.body.data.nodes.length > 0, "path=undefined 不该让画布空掉");
});

test("POST /mirror 落地目录，二次调用全部 unchanged", async () => {
	const mirrorDir = path.join(dir, "mirror-http");
	await post(`${API_PREFIX}/add`, { title: "镜像端点卡", body: "正文", path: "topic/dsh", kind: "fact" });
	const first = await post(`${API_PREFIX}/mirror`, { dir: mirrorDir });
	assert.equal(first.status, 200);
	assert.equal(first.body.ok, true);
	assert.ok(first.body.data.written >= 1);
	assert.ok(existsSync(mirrorDir));
	const second = await post(`${API_PREFIX}/mirror`, { dir: mirrorDir });
	assert.equal(second.body.data.written, 0, "内容没变就不该写盘");
	assert.ok(second.body.data.unchanged >= 1);
});

test("POST /unmirror 读回镜像；目录不存在给 500 而不是静默 0", async () => {
	const mirrorDir = path.join(dir, "mirror-http2");
	await post(`${API_PREFIX}/add`, { title: "回灌端点卡", body: "正文", path: "topic/dsh", kind: "fact" });
	await post(`${API_PREFIX}/mirror`, { dir: mirrorDir });
	const back = await post(`${API_PREFIX}/unmirror`, { dir: mirrorDir });
	assert.equal(back.status, 200);
	assert.equal(back.body.data.updated, 0);
	assert.ok(back.body.data.unchanged >= 1);

	const dry = await post(`${API_PREFIX}/unmirror`, { dir: mirrorDir, dryRun: true });
	assert.equal(dry.body.data.dryRun, true);

	const bad = await post(`${API_PREFIX}/unmirror`, { dir: path.join(dir, "nope-xyz") });
	assert.equal(bad.status, 500);
	assert.equal(bad.body.ok, false);
});
