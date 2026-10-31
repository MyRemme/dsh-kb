/**
 * 路由表：把库里的三副视图（树 / 卡 / 图）摊成 JSON 给浏览器。
 *
 * 只读为主，写只有 forget（标记失效）和 ingest（增量吸收）两个动作。
 * 不在界面上做 `kb_add` —— 写卡是模型在会话里干的事，人手写卡应该走 CLI。
 */

import { route, sendJson, queryParam, readJson, MiB } from "./http.js";
import { search } from "./search.js";
import { treeRows, digest } from "./digest.js";
import { ingest } from "./ingest.js";

const BASE = "/api/dsh-kb";

/** 卡片行 → 前端用的瘦对象。 */
function toCard(row) {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		path: row.path,
		paths: safeArray(row.paths),
		tags: safeArray(row.tags),
		title: row.title,
		body: row.body,
		ts: row.ts,
		confidence: row.confidence,
		sourceKind: row.source_kind,
		sourceRef: row.source_ref,
	};
}

function safeArray(s) {
	try {
		const v = JSON.parse(s ?? "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

/**
 * 构建全部路由。
 * @param {() => import('node:sqlite').DatabaseSync} getDb - 取库句柄。
 * @returns {object[]} 路由描述符数组。
 */
export function makeRoutes(getDb) {
	return [
		route(`${BASE}/tree`, "GET", async (_req, res) => {
			sendJson(res, 200, { nodes: treeRows(getDb()) });
		}),

		route(`${BASE}/cards`, "GET", async (req, res) => {
			const db = getDb();
			const path = queryParam(req, "path");
			const limit = Math.min(Number(queryParam(req, "limit") ?? 200), 500);
			const offset = Number(queryParam(req, "offset") ?? 0);
			const status = queryParam(req, "status") ?? "active";
			const where = [];
			const params = [];
			if (path) {
				where.push("(path=? OR paths LIKE ?)");
				params.push(path, `%"${path}"%`);
			}
			if (status !== "all") {
				where.push("status=?");
				params.push(status);
			}
			const sql =
				"SELECT * FROM fact" +
				(where.length ? ` WHERE ${where.join(" AND ")}` : "") +
				" ORDER BY ts DESC LIMIT ? OFFSET ?";
			const rows = db.prepare(sql).all(...params, limit, offset);
			const total = db
				.prepare("SELECT COUNT(*) AS n FROM fact" + (where.length ? ` WHERE ${where.join(" AND ")}` : ""))
				.get(...params).n;
			sendJson(res, 200, { total, cards: rows.map(toCard) });
		}),

		route(`${BASE}/search`, "GET", async (req, res) => {
			const q = queryParam(req, "q") ?? "";
			if (!q.trim()) {
				sendJson(res, 200, { results: [] });
				return;
			}
			const k = Math.min(Number(queryParam(req, "k") ?? 20), 100);
			const path = queryParam(req, "path");
			const results = search(getDb(), q, { k, path });
			sendJson(res, 200, { results: results.map((r) => ({ ...r, paths: [r.path] })) });
		}),

		route(`${BASE}/card`, "GET", async (req, res) => {
			const id = queryParam(req, "id") ?? "";
			const db = getDb();
			const row = db.prepare("SELECT * FROM fact WHERE id=?").get(id);
			if (!row) {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			const edges = db.prepare("SELECT dst, rel, w FROM edge WHERE src=?").all(id);
			const inbound = db.prepare("SELECT src, rel, w FROM edge WHERE dst=?").all(id);
			sendJson(res, 200, { card: toCard(row), edges, inbound });
		}),

		route(`${BASE}/stats`, "GET", async (_req, res) => {
			const db = getDb();
			const one = (sql) => db.prepare(sql).get().n;
			const all = (sql) => db.prepare(sql).all();
			sendJson(res, 200, {
				facts: one("SELECT COUNT(*) AS n FROM fact"),
				active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'"),
				superseded: one("SELECT COUNT(*) AS n FROM fact WHERE status<>'active'"),
				sessions: one("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''"),
				edges: one("SELECT COUNT(*) AS n FROM edge"),
				nodes: one("SELECT COUNT(*) AS n FROM node"),
				kinds: Object.fromEntries(all("SELECT kind, COUNT(*) AS n FROM fact GROUP BY kind ORDER BY n DESC").map((r) => [r.kind, r.n])),
				paths: Object.fromEntries(all("SELECT path, COUNT(*) AS n FROM fact GROUP BY path ORDER BY n DESC LIMIT 20").map((r) => [r.path, r.n])),
			});
		}),

		route(`${BASE}/graph`, "GET", async (req, res) => {
			const db = getDb();
			const path = queryParam(req, "path");
			const limit = Math.min(Number(queryParam(req, "limit") ?? 260), 800);
			const where = path ? "WHERE (path=? OR paths LIKE ?)" : "";
			const params = path ? [path, `%"${path}"%`] : [];
			const rows = db
				.prepare(`SELECT id, title, kind, path, status FROM fact ${where} ORDER BY ts DESC LIMIT ?`)
				.all(...params, limit);
			const ids = new Set(rows.map((r) => r.id));
			const edges = db
				.prepare("SELECT src, dst, rel FROM edge")
				.all()
				.filter((e) => ids.has(e.src) && ids.has(e.dst));
			const byPath = new Map();
			for (const r of rows) {
				const key = r.path || "inbox";
				byPath.set(key, (byPath.get(key) ?? 0) + 1);
			}
			sendJson(res, 200, {
				nodes: rows.map((r) => ({
					id: r.id,
					label: String(r.title ?? "").slice(0, 48),
					kind: r.kind,
					path: r.path,
					status: r.status,
				})),
				edges,
				paths: [...byPath.entries()].map(([p, n]) => ({ path: p, count: n })),
			});
		}),

		route(`${BASE}/forget`, "POST", async (req, res) => {
			const body = await readJson(req, MiB);
			const id = String(body.id ?? "");
			if (!id) {
				sendJson(res, 400, { error: "id required" });
				return;
			}
			const r = getDb().prepare("UPDATE fact SET status='superseded', updated_at=? WHERE id=?").run(Date.now(), id);
			sendJson(res, 200, { updated: r.changes });
		}),

		route(`${BASE}/ingest`, "POST", async (_req, res) => {
			const db = getDb();
			const stats = ingest(db, {});
			const nodes = digest(db);
			sendJson(res, 200, { ...stats, nodes });
		}),
	];
}
