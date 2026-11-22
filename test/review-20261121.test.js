/**
 * 2026-11-21 审查修复回归测试（0.9.3）：
 * - P1-1: 旧版 6000 字截断卡与 NULL 基线解死锁 + backfillBaselines
 * - P1-2: updateFact / POST /update / kb_update 保留多归属副路径
 * - P1-3: backfillToolProvenance 从会话事件流回填 kb_add 缺失归因与作用域
 * - P2-1: /graph 与 buildGraphQuery 支持 session 筛选
 * - P2-2: 状态/标签变更不破坏 distill_progress 且不误报 withEvidence.changed
 * - P2-3: /distill 与 /mirror 业务错误返回 4xx 可读错误而非 500
 * - P2-4: importFromDir 自动刷摘要、/usage 方法校验与面板去重、/link 短前缀与 cite
 * - P3: pscore 副路径与路径段边界、entity/session/resolveFact 字面量匹配、静态导出 12 类型与子树过滤
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { zstdCompressSync } from "node:zlib";

import {
	openDb,
	writeFact,
	updateFact,
	getFact,
	resolveFact,
	backfillBaselines,
} from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { search } from "../lib/search.js";
import { digest, treeRows } from "../lib/digest.js";
import { collectMaterial, distillWithModel } from "../lib/distill.js";
import { mirrorToDir, importFromDir } from "../lib/markdown.js";
import { ingest, backfillToolProvenance } from "../lib/ingest.js";
import { createApi } from "../lib/routes.js";
import { API_PREFIX, matchRoute } from "../lib/http.js";
import { renderHtml } from "../lib/export.js";

const temp = mkdtempSync(path.join(tmpdir(), "dsh-kb-review-20261121-"));

async function invoke(api, url, method = "GET", body) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	Object.assign(req, { method, url: `${API_PREFIX}${url}`, headers: { host: "127.0.0.1" } });
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
	const pathname = new URL(req.url, "http://127.0.0.1").pathname;
	const found = matchRoute(api.routes, pathname);
	assert.ok(found, `route missing: ${pathname}`);
	await found.handler(req, res);
	return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}

test("P1-1: 旧版 6000 字截断卡在 NULL 基线下自动补全，backfillBaselines 解锁未改过正文的 NULL 基线", (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());

	const prefix = "A".repeat(6000);
	const fullBody = `${prefix} 后续完整内容不会被锁死`;
	const saved = writeFact(db, {
		title: "[会话] 截断测试",
		body: `${prefix}\n…[truncated]`,
		kind: "episode",
		source_kind: "session",
		source_ref: "s-trunc",
		session_id: "s-trunc",
		cwd: "D:/Code",
	});
	// 模拟 v4->v5 迁移留下的 NULL 基线
	db.prepare("UPDATE source_binding SET baseline=NULL WHERE fact_id=?").run(saved.id);

	const res = writeFact(db, {
		title: "[会话] 截断测试",
		body: fullBody,
		kind: "episode",
		source_kind: "session",
		source_ref: "s-trunc",
		session_id: "s-trunc",
		cwd: "D:/Code",
	});
	assert.equal(res.result, "updated");
	assert.equal(getFact(db, saved.id).body, fullBody);
	assert.ok(db.prepare("SELECT baseline FROM source_binding WHERE fact_id=?").get(saved.id).baseline);

	// 另一张未改过正文但仅降级过状态的 NULL 基线卡，通过 backfillBaselines 补齐基线并清掉死锁报错
	const appended = writeFact(db, {
		title: "[会话] 追加测试",
		body: "第一段对话",
		kind: "episode",
		source_kind: "session",
		source_ref: "s-append",
		session_id: "s-append",
		cwd: "D:/Code",
	});
	updateFact(db, appended.id, { status: "doubtful" });
	db.prepare("UPDATE source_binding SET baseline=NULL WHERE fact_id=?").run(appended.id);
	db.prepare("INSERT INTO ingest_log VALUES ('k1','f1',10,100,0,0,'Source conflict x: source-baseline-missing',1)").run();

	assert.equal(backfillBaselines(db), 1);
	assert.equal(db.prepare("SELECT err FROM ingest_log WHERE session_key='k1'").get().err, "");
	const res2 = writeFact(db, {
		title: "[会话] 追加测试",
		body: "第一段对话\n第二段对话",
		kind: "episode",
		source_kind: "session",
		source_ref: "s-append",
		session_id: "s-append",
		cwd: "D:/Code",
	});
	assert.equal(res2.result, "updated");
	assert.equal(getFact(db, appended.id).status, "doubtful", "状态保持人工/遗忘降级不变");
});

test("P1-2: updateFact 与 POST /update 传单值 path 时保留多归属副路径", async (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());
	const api = createApi({ getDb: () => db, getFile: () => ":memory:" });

	const saved = writeFact(db, {
		title: "多归属测试卡",
		body: "原始内容",
		paths: ["topic/dsh", "topic/windows", "project/code"],
		kind: "fix",
	});

	// 仅改正文且携带原主路径：不丢失副路径
	const r1 = await invoke(api, "/update", "POST", {
		id: saved.id,
		title: "多归属测试卡",
		body: "修订内容",
		path: "topic/dsh",
	});
	assert.equal(r1.status, 200);
	assert.deepEqual(JSON.parse(getFact(db, saved.id).paths), ["topic/dsh", "topic/windows", "project/code"]);

	// 改主路径：替换主路径并保留原副路径
	const r2 = await invoke(api, "/update", "POST", {
		id: saved.id,
		path: "topic/knowledge",
	});
	assert.equal(r2.status, 200);
	assert.deepEqual(JSON.parse(getFact(db, saved.id).paths), ["topic/knowledge", "topic/windows", "project/code"]);

	// 显式传 paths 数组才覆盖全量
	const r3 = await invoke(api, "/update", "POST", {
		id: saved.id,
		paths: ["topic/only"],
	});
	assert.equal(r3.status, 200);
	assert.deepEqual(JSON.parse(getFact(db, saved.id).paths), ["topic/only"]);
});

test("P1-3: backfillToolProvenance 从会话事件流精确回填 kb_add 历史归因与作用域", (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());

	const sessDir = mkdtempSync(path.join(temp, "prov-sess-"));
	const sub = path.join(sessDir, "ws", "session-prov-01");
	mkdirSync(sub, { recursive: true });
	const events = [
		{ type: "session", id: "session-prov-01", cwd: "D:\\Code\\proj-x", createdAt: Date.now() },
		{ type: "tool/call", data: { name: "kb_add", args: { title: "回填归因的唯一结论标题", body: "修复 lib/foo.js" } } },
	];
	writeFileSync(path.join(sub, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(events.map(JSON.stringify).join("\n") + "\n")));

	const added = writeFact(db, {
		title: "回填归因的唯一结论标题",
		body: "修复 lib/foo.js",
		kind: "fix",
		path: "topic/dsh",
		source_kind: "kb_add",
		source_ref: "tool",
		session_id: "",
		cwd: "",
	});
	assert.equal(getFact(db, added.id).scope, "global");

	const fixed = backfillToolProvenance(db, { sessionsDir: sessDir });
	assert.equal(fixed, 1);
	const after = getFact(db, added.id);
	assert.equal(after.session_id, "session-prov-01");
	assert.equal(after.cwd, "D:\\Code\\proj-x");
	assert.equal(after.scope, "cwd:d:/code/proj-x");
	assert.ok(after.mentions.some((m) => m.token === "d:/code/proj-x/lib/foo.js"));
});

test("P2-1: /graph 与 client.__queries.graph 支持 session 筛选", async (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());
	const api = createApi({ getDb: () => db, getFile: () => ":memory:" });

	writeFact(db, { title: "会话一卡", body: "tokenS", path: "topic/s", session_id: "sess-aaa" });
	writeFact(db, { title: "会话二卡", body: "tokenS", path: "topic/s", session_id: "sess-bbb" });

	const g1 = await invoke(api, "/graph?session=sess-aaa");
	assert.equal(g1.status, 200);
	assert.equal(g1.json.data.nodes.length, 1);
	assert.equal(g1.json.data.nodes[0].title, "会话一卡");

	const g2 = await invoke(api, "/graph?q=tokenS&session=sess-bbb");
	assert.equal(g2.status, 200);
	assert.equal(g2.json.data.nodes.length, 1);
	assert.equal(g2.json.data.nodes[0].title, "会话二卡");

	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (r) => { registration = r; } } }, undefined);
	const client = registration.factory((spec) => {
		if (spec === "react") {
			return { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) };
		}
		throw new Error(`unexpected require: ${spec}`);
	});
	const q = client.__queries.graph("", "topic/s", "all", { kind: "", since: "", status: "" }, "sess-aaa");
	assert.equal(q.session, "sess-aaa");
});

test("P2-2: 状态降级/恢复或改标签不导致 distill_progress 失效，也不误报证据正文变更", async (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());

	const raw = writeFact(db, { title: "待提炼原料", body: "重要依据原文在这里", kind: "episode", path: "topic/dsh" });
	const fakeModel = {
		provider: "fake",
		model: "fake-1",
		async complete(prompt) {
			const mat = JSON.parse(prompt.user.slice(prompt.user.indexOf("\n") + 1));
			return JSON.stringify({
				cards: [{
					title: "提炼结论",
					body: "基于原文的结论",
					kind: "fact",
					path: mat[0].path,
					sourceIds: [mat[0].id],
					evidence: [{ id: mat[0].id, quote: "重要依据原文在这里" }],
				}],
				processed: [mat[0].chunkId],
			});
		},
	};
	const res = await distillWithModel(db, fakeModel);
	assert.equal(res.added, 1);
	const conclusionId = res.ids[0];

	// 降级再恢复 + 改标签（version 1 -> 2 -> 3，正文 hash 不变）
	updateFact(db, raw.id, { status: "doubtful" });
	updateFact(db, raw.id, { status: "active", tags: ["reviewed"] });

	assert.equal(collectMaterial(db).length, 0, "正文未变不应重新进入待提炼队列");
	const detail = getFact(db, conclusionId);
	assert.equal(detail.outbound[0].provenance.changed, false, "正文未变不应误报来源已变更");
	assert.ok(detail.outbound[0].provenance.snapshot, "正文未变仍应返回完整快照");

	// 真正修改正文后，changed 必须为 true
	updateFact(db, raw.id, { body: "正文已经被彻底重写" });
	const detailAfter = getFact(db, conclusionId);
	assert.equal(detailAfter.outbound[0].provenance.changed, true);
});

test("P2-3 & P2-4: /distill 返回可读 422、/usage 405 与面板去重、/link 前缀与 cite、importFromDir 刷摘要", async (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());
	const api = createApi({
		getDb: () => db,
		getFile: () => ":memory:",
		distill: async () => {
			throw new Error("Source quote does not match supplied evidence");
		},
	});

	// /distill 业务异常返回 422 而非 500
	const badDistill = await invoke(api, "/distill", "POST", {});
	assert.equal(badDistill.status, 422);
	assert.equal(badDistill.json.error.code, "distill-failed");
	assert.match(badDistill.json.error.message, /Source quote/);

	// /usage 非 GET/POST 返回 405
	const delUsage = await invoke(api, "/usage", "DELETE");
	assert.equal(delUsage.status, 405);
	assert.equal(delUsage.headers.allow, "GET, POST");

	// /usage 面板同版本重复点击去重
	const a = writeFact(db, { title: "卡 A", body: "正文 A", path: "topic/u" });
	const b = writeFact(db, { title: "卡 B", body: "正文 B", path: "topic/u" });
	const u1 = await invoke(api, "/usage", "POST", { id: a.id, verdict: "useful" });
	const u2 = await invoke(api, "/usage", "POST", { id: a.id, verdict: "useful" });
	assert.equal(u1.json.data.recorded, true);
	assert.equal(u2.json.data.recorded, false);
	assert.equal(db.prepare("SELECT explicit_adopt_count FROM fact WHERE id=?").get(a.id).explicit_adopt_count, 1);

	// /link 支持短前缀并记录 cite
	const lnk = await invoke(api, "/link", "POST", { src: a.id.slice(0, 10), dst: b.id.slice(0, 10), rel: "references" });
	assert.equal(lnk.status, 200);
	assert.equal(lnk.json.data.src, a.id);
	assert.equal(lnk.json.data.dst, b.id);
	assert.equal(db.prepare("SELECT cite_count FROM fact WHERE id=?").get(b.id).cite_count, 1);

	// importFromDir 修改状态为 superseded 后自动刷新骨架树摘要
	const mdir = mkdtempSync(path.join(temp, "mirror-digest-"));
	digest(db);
	mirrorToDir(db, mdir);
	const files = treeRows(db, "topic/u");
	assert.match(files[0].summary, /2 张卡/);
	const mdA = path.join(mdir, "topic", "u");
	for (const name of [a.id, b.id]) {
		const row = getFact(db, name);
		const file = path.join(mdA, `${row.title.replace(/ /g, "-")}--${row.id.slice(2, 10)}.md`);
		writeFileSync(file, readFileSync(file, "utf8").replace('status: "active"', 'status: "superseded"'));
	}
	const imp = importFromDir(db, mdir);
	assert.equal(imp.updated, 2);
	assert.equal(treeRows(db, "topic/u")[0].summary, "", "导入使枝变空后应自动清空节点摘要");
});

test("P3: pscore 副路径加分、字面量匹配防通配符、export.js 支持 12 类型与子树前缀", (t) => {
	const { db } = openDb(":memory:");
	t.after(() => db.close());

	const c1 = writeFact(db, { title: "常规技巧", body: "关于 powershell 配置的记录", paths: ["topic/dsh", "topic/windows"], kind: "howto" }, seg);
	const c2 = writeFact(db, { title: "常规技巧", body: "关于 powershell 配置的记录（无关枝）", paths: ["topic/media"], kind: "howto" }, seg);
	const hits = search(db, "powershell", { expand: false });
	assert.equal(hits[0].id, c1.id, "副路径命中 topic/windows 应获得路径加分排在前面");

	// resolveFact 字面量前缀：单卡库中 "%" 不能误命中
	const { db: singleDb } = openDb(":memory:");
	t.after(() => singleDb.close());
	const only = writeFact(singleDb, { title: "唯一卡", body: "含实体 `kb_search` 与路径", session_id: "sess-1" }, seg);
	assert.equal(resolveFact(singleDb, "%"), undefined);
	assert.equal(resolveFact(singleDb, "f__"), undefined);
	assert.equal(resolveFact(singleDb, only.id.slice(0, 10)).id, only.id);

	// entity / session 字面量匹配："_" 不当通配符
	assert.equal(search(singleDb, "", { entity: "___", expand: false }).length, 0);
	assert.equal(search(singleDb, "", { entity: "kb_search", expand: false }).length, 1);
	assert.equal(search(singleDb, "", { session: "___", expand: false }).length, 0);
	assert.equal(search(singleDb, "", { session: "sess-1", expand: false }).length, 1);

	// export.js 包含 todo/state/artifact 标签与 matchPath 前缀过滤
	const html = renderHtml({ facts: [], tree: [], edges: [] });
	assert.match(html, /todo:\s*"待办"/);
	assert.match(html, /state:\s*"进度"/);
	assert.match(html, /artifact:\s*"产物"/);
	assert.match(html, /function matchPath/);
});
