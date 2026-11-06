/**
 * L2 语义模型测试：展示分组（grp）+ 关系边白名单。
 *
 * 这一层有两个容易烂掉的地方：
 *   1. 前后端各算一遍分组 —— 规则一漂，图上的计数和列表里的条数就对不上；
 *   2. 关系名靠约定 —— 一个 `rel="supersede"` 的哑边在图上看起来和真边一样。
 * 下面把两件事都钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	openDb,
	upsertFact,
	updateFact,
	addEdge,
	linkFacts,
	backfillGroups,
	groupOfFact,
	GROUPS,
	REL_KINDS,
	getFact,
} from "../lib/store.js";
import { seg } from "../lib/segment.js";

function makeDb(t) {
	const tmp = mkdtempSync(path.join(tmpdir(), "dsh-kb-sem-"));
	const { db } = openDb(path.join(tmp, "kb.db"));
	t.after(() => {
		try {
			db.close();
		} catch {
			// 已关闭
		}
	});
	return { db, tmp };
}

const idOf = (db, title) => db.prepare("SELECT id FROM fact WHERE title=?").get(title)?.id;

test("groupOfFact：kind 决定归类，project/ 前缀只对剩余类型生效", () => {
	assert.equal(groupOfFact("fix", "topic/dsh"), "memory");
	assert.equal(groupOfFact("decision", "project/code"), "memory", "kind 先判，路径不抢");
	assert.equal(groupOfFact("artifact", "topic/dsh"), "doc");
	assert.equal(groupOfFact("episode", "topic/dsh"), "talk");
	assert.equal(groupOfFact("intent", "project/code"), "talk");
	assert.equal(groupOfFact("todo", "project/code"), "project");
	assert.equal(groupOfFact("state", "project/code"), "project");
	assert.equal(groupOfFact("todo", "topic/dsh"), "task");
	assert.equal(groupOfFact("segment", "topic/dsh"), "memory");
	for (const kind of ["fact", "artifact", "episode", "todo", "segment"]) {
		assert.ok(GROUPS.includes(groupOfFact(kind, "topic/x")), `${kind} 归到了未声明的分组`);
	}
});

test("写入时就带上 grp，改 kind/path 会跟着变", (t) => {
	const { db } = makeDb(t);
	upsertFact(db, { title: "卡一", body: "正文", kind: "episode", path: "topic/dsh" }, seg);
	const id = idOf(db, "卡一");
	assert.equal(db.prepare("SELECT grp FROM fact WHERE id=?").get(id).grp, "talk");

	updateFact(db, id, { kind: "artifact" }, seg);
	assert.equal(db.prepare("SELECT grp FROM fact WHERE id=?").get(id).grp, "doc");

	updateFact(db, id, { paths: ["project/code"], kind: "todo" }, seg);
	assert.equal(db.prepare("SELECT grp FROM fact WHERE id=?").get(id).grp, "project");

	// 详情也要带出来，面板与工具都读它
	assert.equal(getFact(db, id).grp, "project");
});

test("backfillGroups 幂等，且能修好手改坏的分组", (t) => {
	const { db } = makeDb(t);
	upsertFact(db, { title: "甲", body: "b", kind: "fix", path: "topic/x" }, seg);
	upsertFact(db, { title: "乙", body: "b", kind: "episode", path: "topic/x" }, seg);
	upsertFact(db, { title: "丙", body: "b", kind: "artifact", path: "topic/x" }, seg);
	db.prepare("UPDATE fact SET grp='memory'").run();
	assert.equal(backfillGroups(db), 3);
	const got = db.prepare("SELECT title,grp FROM fact ORDER BY title").all().map((r) => `${r.title}=${r.grp}`);
	assert.deepEqual(got, ["丙=doc", "乙=talk", "甲=memory"]);
	// 再跑一次结果不变
	assert.equal(backfillGroups(db), 3);
	assert.deepEqual(db.prepare("SELECT title,grp FROM fact ORDER BY title").all().map((r) => `${r.title}=${r.grp}`), got);
});

test("linkFacts：九种关系都能建，自环与未知关系被拒", (t) => {
	const { db } = makeDb(t);
	upsertFact(db, { title: "源", body: "b", kind: "fact", path: "topic/x" }, seg);
	upsertFact(db, { title: "靶", body: "b2", kind: "fact", path: "topic/x" }, seg);
	const a = idOf(db, "源");
	const b = idOf(db, "靶");

	for (const rel of REL_KINDS) {
		assert.deepEqual(linkFacts(db, a, b, rel), { result: "linked", src: a, dst: b, rel });
	}
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edge").get().n, REL_KINDS.length);

	assert.throws(() => linkFacts(db, a, b, "supersede"), /未知关系/);
	assert.throws(() => linkFacts(db, a, a, "related"), /自己/);
	assert.throws(() => linkFacts(db, a, "f_00000000000000", "related"), /卡不存在/);
	// 重复建边是覆盖不是叠加（edge 主键 src+dst+rel）
	linkFacts(db, a, b, "related", { note: "改备注" });
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE rel='related'").get().n, 1);
	assert.equal(db.prepare("SELECT note FROM edge WHERE rel='related'").get().note, "改备注");
});

test("迁移：老库里'会话卡 → 卡'的 contains 边改名成 produces", (t) => {
	const { db, tmp } = makeDb(t);
	upsertFact(db, { title: "会话", body: "b1", kind: "episode", session_id: "s1" }, seg);
	upsertFact(db, { title: "记忆", body: "b2", kind: "fact", path: "topic/x" }, seg);
	upsertFact(db, { title: "项目", body: "b3", kind: "artifact", path: "topic/x" }, seg);
	const session = idOf(db, "会话");
	addEdge(db, session, idOf(db, "记忆"), "contains", 1, "fact");
	// 非会话发出的 contains 是真正的"归属"，不该被改名
	addEdge(db, idOf(db, "项目"), idOf(db, "记忆"), "contains", 1, "");
	db.exec("PRAGMA user_version=2");
	db.close();

	const reopened = openDb(path.join(tmp, "kb.db"));
	t.after(() => {
		try {
			reopened.db.close();
		} catch {
			// 已关闭
		}
	});
	const rels = reopened.db.prepare("SELECT src,dst,rel FROM edge ORDER BY rel").all();
	const fromSession = rels.filter((r) => r.src === session);
	assert.equal(fromSession.length, 1);
	assert.equal(fromSession[0].rel, "produces", "会话发出的边应改名为 produces");
	assert.ok(rels.some((r) => r.rel === "contains"), "真正的归属边要保留");
	assert.equal(Number(reopened.db.prepare("PRAGMA user_version").get().user_version), 5);
});

test("前端分组规则与后端 groupOfFact 完全一致（防两侧漂移）", async () => {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (r) => { registration = r; } } }, undefined);
	const client = registration.factory((spec) => {
		if (spec === "react") {
			return { createElement: () => null, Fragment: "F", useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) };
		}
		throw new Error(`未声明模块：${spec}`);
	});

	const kinds = ["fact", "decision", "concept", "fix", "pref", "howto", "intent", "episode", "segment", "todo", "state", "artifact", "unknown-kind"];
	const paths = ["topic/dsh", "project/code", "project", "", "inbox"];
	const tree = [
		{ path: "topic", depth: 0, count: 0 },
		{ path: "topic/dsh", depth: 1, count: 0 },
		{ path: "project", depth: 0, count: 0 },
		{ path: "project/code", depth: 1, count: 0 },
		{ path: "", depth: 0, count: 0 },
		{ path: "inbox", depth: 0, count: 0 },
	];
	const facts = [];
	for (const kind of kinds) {
		for (const factPath of paths) {
			facts.push({ id: `f_${kind}_${factPath || "empty"}`.slice(0, 40), title: `${kind}@${factPath}`, kind, path: factPath, ts: 1, tags: [] });
		}
	}
	const layout = client.__layout({ tree, facts, edges: [], perBlock: kinds.length * paths.length });
	for (const star of layout.stars) {
		const fact = facts.find((f) => f.id === star.id);
		assert.equal(star.group, groupOfFact(fact.kind, fact.path), `${fact.kind}@${fact.path || "(空)"} 两侧分组不一致`);
	}
});
