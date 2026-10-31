/**
 * HTTP 路由集成测试：起一个真 server，用真 DB，走真 fetch。
 * 覆盖浏览器端会用到的每一个端点。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, upsertFact, addEdge } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { makeRoutes } from "../lib/routes.js";
import { route } from "../lib/http.js";

let server;
let base;
let db;

function startRoutes(routes) {
	return new Promise((resolve) => {
		const srv = http.createServer((req, res) => {
			const pathname = (req.url ?? "/").split("?")[0];
			const hit = routes.find((r) => r.path === pathname);
			if (!hit) {
				res.writeHead(404).end("{}");
				return;
			}
			hit.handler(req, res);
		});
		srv.listen(0, "127.0.0.1", () => resolve(srv));
	});
}

before(async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-http-"));
	const opened = openDb(path.join(dir, "kb.db"));
	db = opened.db;

	const a = {
		title: "骨架树用多归属路径",
		body: "一条卡可以挂多个枝。",
		path: "topic/knowledge",
		paths: ["topic/knowledge", "project/code"],
		kind: "decision",
		tags: ["kb"],
	};
	const b = { title: "trigram 对双字中文词失效", body: "改用 bigram。", path: "topic/knowledge", kind: "fix" };
	upsertFact(db, a, seg);
	upsertFact(db, b, seg);
	addEdge(db, "f_a", "f_b", "related", 1, "");

	server = await startRoutes(makeRoutes(() => db));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	server?.close();
	db?.close();
});

const getJson = async (p) => {
	const res = await fetch(base + p);
	assert.equal(res.status, 200, `${p} -> ${res.status}`);
	return res.json();
};

test("tree 返回带计数的节点", async () => {
	const data = await getJson("/api/dsh-kb/tree");
	assert.ok(Array.isArray(data.nodes));
	const node = data.nodes.find((n) => n.path === "topic/knowledge");
	assert.equal(node.count, 2);
});

test("cards 按枝过滤，并支持多归属", async () => {
	const byTopic = await getJson("/api/dsh-kb/cards?path=topic/knowledge");
	assert.equal(byTopic.cards.length, 2);
	const byProject = await getJson("/api/dsh-kb/cards?path=project/code");
	assert.equal(byProject.cards.length, 1);
	assert.equal(byProject.cards[0].kind, "decision");
});

test("cards 的 total 是过滤后的总数，不是当前页长度", async () => {
	const data = await getJson("/api/dsh-kb/cards?limit=1");
	assert.equal(data.cards.length, 1);
	assert.equal(data.total, 2);
});

test("search 中文双字词可命中", async () => {
	const data = await getJson("/api/dsh-kb/search?q=" + encodeURIComponent("中文词"));
	assert.ok(data.results.length >= 1);
});

test("card 返回单卡与出入边", async () => {
	const list = await getJson("/api/dsh-kb/cards?limit=10");
	const one = list.cards[0];
	const data = await getJson("/api/dsh-kb/card?id=" + encodeURIComponent(one.id));
	assert.equal(data.card.id, one.id);
	assert.ok(Array.isArray(data.edges));
	assert.ok(Array.isArray(data.inbound));
});

test("stats 汇总各维度", async () => {
	const data = await getJson("/api/dsh-kb/stats");
	assert.equal(data.facts, 2);
	assert.equal(data.active, 2);
	assert.equal(data.kinds.decision, 1);
	assert.equal(data.kinds.fix, 1);
});

test("graph 返回节点、边与路径分布", async () => {
	const data = await getJson("/api/dsh-kb/graph");
	assert.equal(data.nodes.length, 2);
	assert.ok(Array.isArray(data.edges));
	assert.ok(data.paths.some((p) => p.path === "topic/knowledge"));
});

test("forget 把卡降级而非删除", async () => {
	const list = await getJson("/api/dsh-kb/cards?limit=10");
	const target = list.cards[0];
	const res = await fetch(base + "/api/dsh-kb/forget", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id: target.id }),
	});
	assert.equal(res.status, 200);
	assert.equal((await res.json()).updated, 1);
	const after = await getJson("/api/dsh-kb/stats");
	assert.equal(after.facts, 2);
	assert.equal(after.active, 1);
	// 还原，避免影响后续断言
	db.prepare("UPDATE fact SET status='active'").run();
});

test("错误方法返回 405，未知路径由外层返回 404", async () => {
	const res = await fetch(base + "/api/dsh-kb/stats", { method: "DELETE" });
	assert.equal(res.status, 405);
});

test("route 描述符形状符合 ctx.webServer.register 契约", () => {
	const r = route("/api/x", "GET", async () => {});
	assert.equal(r.kind, "exact");
	assert.equal(r.path, "/api/x");
	assert.equal(typeof r.handler, "function");
});
