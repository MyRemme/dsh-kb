/**
 * 生命周期：修订（id 稳定）、全文读、实体提及、过期降级、检索过滤。
 *
 * 这一组是"记忆能不能被维护"的核心：写进去的东西改得动、查得全、放久了不毒化检索。
 * 每条都按"用户会踩到"的顺序断言，不测内部实现细节。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	openDb,
	upsertFact,
	updateFact,
	getFact,
	resolveFact,
	extractMentions,
	sweepStale,
} from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { search } from "../lib/search.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-life-"));
const { db } = openDb(path.join(dir, "kb.db"));

/** 写一张卡并返回 id。 */
function write(fields) {
	upsertFact(db, { kind: "fact", path: "topic/test", confidence: 0.8, ...fields }, seg);
	return db.prepare("SELECT id FROM fact WHERE title=?").get(fields.title).id;
}

test("updateFact 保持 id 不变，旧版本进历史", () => {
	const id = write({ title: "同一结论会演进", body: "第一版：先这么做。" });
	const result = updateFact(db, id, { body: "第二版：补上边界，并发下不适用。" }, seg);
	assert.equal(result.result, "updated");
	assert.equal(result.id, id);
	assert.equal(result.version, 2);

	const row = db.prepare("SELECT * FROM fact WHERE id=?").get(id);
	assert.match(row.body, /第二版/);
	assert.equal(Number(row.version), 2);

	const history = db.prepare("SELECT * FROM fact_history WHERE id=? ORDER BY version").all(id);
	assert.equal(history.length, 1);
	assert.match(history[0].body, /第一版/);
});

test("updateFact 内容没变返回 unchanged，不写历史", () => {
	const id = write({ title: "重复修订不该产生版本", body: "正文保持不变。" });
	const before = db.prepare("SELECT COUNT(*) AS n FROM fact_history WHERE id=?").get(id).n;
	const result = updateFact(db, id, { body: "正文保持不变。" }, seg);
	assert.equal(result.result, "unchanged");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fact_history WHERE id=?").get(id).n, before);
});

test("updateFact 找不到就是 not-found", () => {
	assert.equal(updateFact(db, "f_nope", { body: "x" }, seg).result, "not-found");
});

test("resolveFact 支持 id 前缀", () => {
	const id = write({ title: "前缀也能找到", body: "人肉抄 id 通常只抄前 8 位。" });
	assert.equal(resolveFact(db, id.slice(0, 8)).id, id);
});

test("getFact 返回全文、历史、关系与实体", () => {
	const id = write({
		title: "实体抽取从正文来",
		body: "改 D:/Code/dsh-kb/lib/http.js 之前先看 `originAllowed`，报错常见 ERR_MODULE_NOT_FOUND。",
	});
	updateFact(db, id, { body: `${getFact(db, id).body}\n补充：v0.3.0 之后加了 /api/dsh-kb/update。` }, seg);

	const detail = getFact(db, id);
	assert.equal(detail.id, id);
	assert.match(detail.body, /originAllowed/);
	assert.equal(detail.history.length, 1);
	const tokens = detail.mentions.map((m) => m.token);
	assert.ok(tokens.some((t) => t.includes("lib/http.js")), `路径没抽到：${tokens.join(",")}`);
	assert.ok(tokens.includes("originallowed"), "反引号符号没抽到");
	assert.ok(tokens.some((t) => t.includes("err_module_not_found")), "错误码没抽到");
});

test("extractMentions 抽路径 / 版本 / 错误码，去重", () => {
	const tokens = extractMentions("装插件", "用了 v1.2.3，报 ERR_MODULE_NOT_FOUND，路径 D:\\Code\\a\\b.js 和 /usr/local/bin/x.sh");
	const types = new Set(tokens.map((t) => t.type));
	assert.ok(types.has("version"));
	assert.ok(types.has("error"));
	assert.ok(types.has("path"));
	assert.equal(new Set(tokens.map((t) => t.token)).size, tokens.length, "有重复实体");
});

test("sweepStale 只降级过期快照卡，结论卡不动", () => {
	const old = Date.now() - 90 * 86400000;
	upsertFact(db, { title: "当时的待办", body: "这件事早做完了。", kind: "todo", path: "topic/test", ts: old }, seg);
	upsertFact(db, { title: "当时的进度", body: "快照型。", kind: "state", path: "topic/test", ts: old }, seg);
	upsertFact(db, { title: "过期但仍是结论", body: "三个月前的决定依然有效。", kind: "decision", path: "topic/test", ts: old }, seg);

	const staled = sweepStale(db, { days: 30 });
	assert.ok(staled >= 2);
	const todo = db.prepare("SELECT status FROM fact WHERE title=?").get("当时的待办").status;
	assert.equal(todo, "doubtful");
	const decision = db.prepare("SELECT status FROM fact WHERE title=?").get("过期但仍是结论").status;
	assert.equal(decision, "active", "结论卡被误降级了");
});

test("快照型卡写入即低置信", () => {
	upsertFact(db, { title: "又一条待办", body: "低置信。", kind: "todo", path: "topic/test" }, seg);
	const row = db.prepare("SELECT confidence FROM fact WHERE title=?").get("又一条待办");
	assert.ok(Number(row.confidence) <= 0.4, `置信度应被压低，实际 ${row.confidence}`);
});

test("检索按类型过滤：只要 fix/decision", () => {
	const rows = search(db, "", { kinds: ["decision"], k: 20 });
	assert.ok(rows.length > 0);
	assert.ok(rows.every((r) => r.kind === "decision"));
});

test("检索按时间过滤：since 只回最近的卡", () => {
	const fresh = write({ title: "刚写的卡", body: "时间过滤应该留住它。" });
	const rows = search(db, "时间过滤", { since: Date.now() - 3600000, k: 10 });
	assert.ok(rows.some((r) => r.id === fresh));
	const old = search(db, "时间过滤", { since: Date.now() + 3600000, k: 10 });
	assert.equal(old.length, 0);
});

test("检索按实体命中：给文件路径就能找到相关卡", () => {
	const id = write({ title: "改这个文件之前", body: "D:/Code/dsh-kb/lib/routes.js 里加端点要同步 ENDPOINTS。" });
	const rows = search(db, "", { entity: "lib/routes.js", k: 10 });
	assert.ok(rows.some((r) => r.id === id), "实体检索没命中");
});

test("检索按来源会话过滤", () => {
	upsertFact(db, { title: "来自会话 A", body: "带 session_id 的卡。", kind: "fact", path: "topic/test", session_id: "session-abc123" }, seg);
	const rows = search(db, "来自会话", { session: "abc123", k: 10 });
	assert.ok(rows.length > 0);
	assert.ok(rows.every((r) => String(r.id) !== ""), "结果为空");
	const none = search(db, "来自会话", { session: "zzz999", k: 10 });
	assert.equal(none.length, 0);
});

test("默认检索不含已降级的卡，includeSuperseded 才可见", () => {
	const id = write({ title: "降级后默认看不见", body: "它会被标成 superseded。" });
	updateFact(db, id, { status: "superseded" }, seg);
	assert.equal(search(db, "降级后默认看不见", { k: 10 }).length, 0);
	const all = search(db, "降级后默认看不见", { k: 10, includeSuperseded: true });
	assert.ok(all.some((r) => r.id === id));
});
