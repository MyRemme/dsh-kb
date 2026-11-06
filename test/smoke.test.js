import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { openDb, upsertFact, factHash, makeId, reindex } from "../lib/store.js";
import { seg, queryTokens, terms } from "../lib/segment.js";
import { search, inferPaths } from "../lib/search.js";
import { decompressFrames, eventsToFacts } from "../lib/session.js";
import { digest, treeRows } from "../lib/digest.js";

const fresh = () => openDb(":memory:").db;

test("seg 把中文切成 bigram，拉丁词保持整体", () => {
	const s = seg("知识库 memory");
	assert.ok(s.includes("知识"));
	assert.ok(s.includes("识库"));
	assert.ok(s.includes("memory"));
	// 单字 CJK 保留
	assert.equal(seg("树"), "树");
});

test("queryTokens 把长 CJK 串拆成扁平 bigram，交给调用方决定 AND/OR", () => {
	assert.deepEqual(queryTokens("知识库"), ['"知识"', '"识库"']);
});

test("queryTokens 单字退化为前缀匹配", () => {
	assert.deepEqual(queryTokens("树"), ["树*"]);
});

test("terms 对中文补 2 字滑窗", () => {
	const t = terms("材质节点");
	assert.ok(t.includes("材质节点"));
	assert.ok(t.includes("材质"));
});

test("同一内容写入两次只留一张卡", () => {
	const db = fresh();
	const f = { title: "结论 A", body: "正文 A", path: "topic/x" };
	assert.equal(upsertFact(db, f, seg), "added");
	assert.equal(upsertFact(db, f, seg), "dup");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fact").get().n, 1);
});

test("同标题不同正文不隐式覆盖，补充必须显式修订", () => {
	const db = fresh();
	const f = { title: "结论 B", body: "短" };
	upsertFact(db, f, seg);
	const longer = { ...f, body: "短".padEnd(400, "补充内容") };
	assert.equal(upsertFact(db, longer, seg), "added");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fact").get().n, 2);
});

test("id 稳定：同内容同 id", () => {
	assert.equal(makeId("a", "b"), makeId("a", "b"));
	assert.equal(factHash("A  B", "x").length, 64);
});

test("中文双字词可被检索到（trigram 做不到）", () => {
	const db = fresh();
	upsertFact(db, { title: "记忆结构选型", body: "用卡账本加骨架树", path: "topic/knowledge" }, seg);
	const hits = search(db, "记忆", { k: 3 });
	assert.equal(hits.length >= 1, true);
	assert.match(hits[0].title, /记忆/);
});

test("路径前缀限定生效", () => {
	const db = fresh();
	upsertFact(db, { title: "dsh 插件注册", body: "defineTool", path: "topic/dsh" }, seg);
	upsertFact(db, { title: "blender 材质", body: "PBR 节点", path: "topic/blender" }, seg);
	const hits = search(db, "插件 材质", { k: 5, path: "topic/blender" });
	assert.equal(hits.length, 1);
	assert.equal(hits[0].path, "topic/blender");
});

test("superseded 默认不返回，--all 才返回", () => {
	const db = fresh();
	upsertFact(db, { title: "旧结论", body: "旧的", path: "topic/x" }, seg);
	db.prepare("UPDATE fact SET status='superseded'").run();
	assert.equal(search(db, "旧结论", { k: 3 }).length, 0);
	assert.equal(search(db, "旧结论", { k: 3, includeSuperseded: true }).length >= 1, true);
});

test("inferPaths 按关键词归枝，无命中落空数组", () => {
	assert.ok(inferPaths("blender 材质", "", "D:\\Code").includes("topic/blender"));
	assert.deepEqual(inferPaths("随便什么", "", ""), []);
});

test("多帧 zstd 能逐帧解出全部内容", () => {
	const a = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'));
	const b = zlib.zstdCompressSync(Buffer.from('{"type":"user/message"}\n'));
	const frames = decompressFrames(Buffer.concat([a, b]));
	assert.equal(frames.length, 2);
	assert.match(frames[0], /session/);
	assert.match(frames[1], /user\/message/);
});

test("事件流抽出 episode / 分段 / intent 三类卡", () => {
	const events = [
		{ type: "session", data: {} },
		{ type: "session/title", data: { title: "测试会话" }, time: 1 },
		{
			type: "compaction/summary",
			data: { summary: [{ type: "text", text: "## Primary Request and Intent\n要做 A\n\n## Errors and Fixes\nB 报错，用 C 修" }] },
			time: 2,
		},
		{ type: "user/message", data: { id: "u1", content: [{ type: "text", text: "我要做 A" }], source: { kind: "user" } }, time: 3 },
		{ type: "user/message", data: { id: "u2", content: [{ type: "text", text: "顺便问 B" }], source: { kind: "user" } }, time: 4 },
	];
	const facts = eventsToFacts(events, { id: "session-abc", cwd: "D:\\Code", createdAt: 1_700_000_000_000 });
	const kinds = facts.map((f) => f.kind);
	assert.ok(kinds.includes("episode"));
	assert.ok(kinds.includes("intent"));
	assert.ok(kinds.includes("fix"));
});

test("runtime-context 与 system-reminder 不算用户意图", () => {
	const events = [
		{ type: "user/message", data: { id: "1", content: [{ type: "text", text: "Current runtime context. 快照" }], source: { kind: "runtime-context" } } },
		{ type: "user/message", data: { id: "2", content: [{ type: "text", text: "<system-reminder>规则</system-reminder>" }], source: { kind: "user" } } },
		{ type: "user/message", data: { id: "3", content: [{ type: "text", text: "真正的诉求" }], source: { kind: "user" } } },
	];
	const facts = eventsToFacts(events, { id: "session-x", cwd: "", createdAt: 1 });
	const intent = facts.find((f) => f.kind === "intent");
	assert.equal(intent, undefined); // 只有 1 条有效用户消息，不够 2 条
	assert.match(facts[0].body, /真正的诉求/);
});

test("digest 给节点写摘要，treeRows 统计卡片数", () => {
	const db = fresh();
	upsertFact(db, { title: "dsh 插件", body: "x", path: "topic/dsh" }, seg);
	const n = digest(db);
	assert.ok(n >= 1);
	const rows = treeRows(db, "topic");
	assert.ok(rows.some((r) => r.path === "topic/dsh" && r.count === 1));
	assert.ok(rows.find((r) => r.path === "topic/dsh").summary.includes("1 张卡"));
});

test("reindex 换分词规则后仍可检索", () => {
	const db = fresh();
	upsertFact(db, { title: "中文检索", body: "分词方案", path: "topic/x" }, seg);
	assert.equal(reindex(db, seg), 1);
	assert.equal(search(db, "检索", { k: 2 }).length, 1);
});
