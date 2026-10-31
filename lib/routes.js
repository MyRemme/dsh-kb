/**
 * `/api/dsh-kb/*` 的十八个端点。
 *
 * 分工：`http.js` 只懂载体（JSON、来源、错误信封），这里只懂查询形状，
 * 两者都不碰面板 DOM。面板、静态导出、curl 因此看到的是同一份数据契约。
 *
 * 返回值统一是 `{ok:true, data}`；失败是 `{ok:false, error:{code,message}}`。
 * 所有 handler 都是**只读或幂等**的：`add` 走 upsertFact 的双键去重，
 * `ingest` 走 ingest_log 的 size/mtime 缓存，重复调用不会长出重复卡。
 *
 * @module dsh-kb/routes
 */

import path from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { API_PREFIX, HttpError, handle, parseUrl, queryInt, queryString, readJson, route, sendOk } from "./http.js";
import {
	upsertFact,
	updateFact,
	getFact,
	sweepStale,
	defaultDbPath,
	linkFacts,
	backfillGroups,
	renameSessionEdges,
	GROUPS,
	REL_KINDS,
} from "./store.js";
import { search } from "./search.js";
import { digest, treeRows } from "./digest.js";
import { ingest } from "./ingest.js";
import { importFromDir, mirrorToDir } from "./markdown.js";
import { seg } from "./segment.js";

/** 卡类型白名单，与工具参数保持同一份。 */
const KINDS = ["fact", "decision", "fix", "pref", "howto", "concept", "intent", "episode", "segment"];

/** 卡状态白名单。 */
const STATUSES = ["active", "superseded", "doubtful"];

/**
 * 把一行 fact 转成面板能直接吃的形状（JSON 列解开、时间保留毫秒）。
 * @param {object} row - `SELECT * FROM fact` 的一行。
 * @param {boolean} [withBody] - 列表视图不需要正文，详情才要。
 * @returns {object} 卡对象。
 */
export function toFact(row, withBody = false) {
	const fact = {
		id: row.id,
		title: row.title,
		kind: row.kind,
		status: row.status,
		path: row.path,
		paths: safeJson(row.paths),
		tags: safeJson(row.tags),
		confidence: Number(row.confidence),
		version: Number(row.version ?? 1),
		ts: Number(row.ts),
		sourceKind: row.source_kind,
		sourceRef: row.source_ref,
		sessionId: row.session_id,
		cwd: row.cwd,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
	if (withBody) {
		fact.body = row.body;
		return fact;
	}
	fact.excerpt = String(row.body ?? "").replace(/\s+/g, " ").slice(0, 200);
	return fact;
}

/**
 * 安全解析 JSON 列。
 * @param {string} value - 列原文。
 * @returns {any[]} 数组（解析失败返回空数组）。
 */
function safeJson(value) {
	try {
		const parsed = JSON.parse(value ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 健康度快照（工具、面板、CLI 共用一份计算）。
 * @param {object} db - 已打开的库。
 * @param {string} file - 库文件路径。
 * @returns {object} 统计对象。
 */
export function statsOf(db, file) {
	const one = (sql) => db.prepare(sql).get().n;
	const all = (sql) => db.prepare(sql).all();
	return {
		facts: one("SELECT COUNT(*) AS n FROM fact"),
		active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'"),
		sessions: one("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''"),
		edges: one("SELECT COUNT(*) AS n FROM edge"),
		nodes: one("SELECT COUNT(*) AS n FROM node"),
		mentions: one("SELECT COUNT(*) AS n FROM mention"),
		stale: one("SELECT COUNT(*) AS n FROM fact WHERE status!='active'"),
		versions: one("SELECT COUNT(*) AS n FROM fact_history"),
		kinds: Object.fromEntries(
			all("SELECT kind, COUNT(*) AS n FROM fact GROUP BY kind ORDER BY n DESC").map((r) => [r.kind, r.n]),
		),
		paths: Object.fromEntries(
			all("SELECT path, COUNT(*) AS n FROM fact GROUP BY path ORDER BY n DESC LIMIT 12").map((r) => [r.path, r.n]),
		),
		groups: Object.fromEntries(
			all("SELECT grp, COUNT(*) AS n FROM fact GROUP BY grp").map((r) => [r.grp, r.n]),
		),
		rels: Object.fromEntries(all("SELECT rel, COUNT(*) AS n FROM edge GROUP BY rel ORDER BY n DESC").map((r) => [r.rel, r.n])),
		db: file,
	};
}

/**
 * 建一组路由。
 * @param {object} deps - 依赖。
 * @param {() => object} deps.getDb - 懒取库句柄。
 * @param {() => string} deps.getFile - 库文件路径（可能尚未打开）。
 * @param {number} [deps.maxResults] - 检索默认条数。
 * @param {number} [deps.staleDays] - 快照型卡降级天数，/sweep 缺省用它。
 * @returns {{routes: Array<object>}} 路由表。
 */
export function createApi(deps) {
	const defaultK = deps.maxResults ?? 6;
	const db = () => deps.getDb();
	/** 默认镜像目录放在库旁边，跟库一起备份、一起迁移。 */
	const mirrorDir = () => deps.mirrorDir || path.join(path.dirname(deps.dbPath ?? defaultDbPath()), "mirror");

	/** 列表查询：状态/类型/路径筛选 + 分页。 */
	const listFacts = (query) => {
		const limit = queryInt(query, "limit", 40, 1, 500);
		const offset = queryInt(query, "offset", 0, 0, 1e6);
		const kind = queryString(query, "kind");
		const status = queryString(query, "status");
		const pathFilter = queryString(query, "path");
		const group = queryString(query, "group");
		const where = [];
		const params = [];
		if (group && GROUPS.includes(group)) {
			where.push("grp=?");
			params.push(group);
		}
		if (kind) {
			where.push("kind=?");
			params.push(kind);
		}
		if (status) {
			where.push("status=?");
			params.push(status);
		}
		if (pathFilter) {
			where.push("(path LIKE ? OR paths LIKE ?)");
			params.push(`${pathFilter}%`, `%${pathFilter}%`);
		}
		const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const rows = db()
			.prepare(`SELECT * FROM fact ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
			.all(...params, limit, offset);
		const total = db().prepare(`SELECT COUNT(*) AS n FROM fact ${clause}`).get(...params).n;
		return { total, limit, offset, items: rows.map((r) => toFact(r)) };
	};

	const routes = [
		// 1. 健康度
		route(
			"exact",
			`${API_PREFIX}/stats`,
			handle("GET", (_req, res) => {
				sendOk(res, statsOf(db(), deps.getFile()));
			}),
		),

		// 2. 检索
		route(
			"exact",
			`${API_PREFIX}/search`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				const q = queryString(query, "q");
				if (!q) throw new HttpError(400, "missing-q", "缺少 q 参数");
				const rows = search(db(), q, {
					k: queryInt(query, "k", defaultK, 1, 40),
					path: queryString(query, "path") || undefined,
					includeSuperseded: query.get("all") === "1",
					expand: query.get("graph") !== "0",
				});
				sendOk(res, rows);
			}),
		),

		// 3. 骨架树
		route(
			"exact",
			`${API_PREFIX}/tree`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				sendOk(res, treeRows(db(), queryString(query, "prefix")));
			}),
		),

		// 4. 卡列表（时间线 / 某枝 / 某类型）
		route(
			"exact",
			`${API_PREFIX}/facts`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				sendOk(res, listFacts(query));
			}),
		),

		// 5. 单卡详情 + 一跳关系
		route(
			"exact",
			`${API_PREFIX}/fact`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				const id = queryString(query, "id");
				if (!id) throw new HttpError(400, "missing-id", "缺少 id 参数");
				const detail = getFact(db(), id);
				if (detail === undefined) throw new HttpError(404, "not-found", `没有这张卡：${id}`);
				sendOk(res, {
					fact: toFact(detail, true),
					outbound: detail.outbound.map((r) => ({ ...r, ts: Number(r.ts) })),
					inbound: detail.inbound.map((r) => ({ ...r, ts: Number(r.ts) })),
					history: detail.history,
					mentions: detail.mentions,
				});
			}),
		),

		// 6. 关系图（限定枝内的卡 + 它们之间的边）
		route(
			"exact",
			`${API_PREFIX}/graph`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				const limit = queryInt(query, "limit", 120, 1, 400);
				const pathFilter = queryString(query, "path");
				const group = queryString(query, "group");
				const where = ["status='active'"];
				const params = [];
				if (pathFilter) {
					where.push("(path LIKE ? OR paths LIKE ?)");
					params.push(`${pathFilter}%`, `%${pathFilter}%`);
				}
				if (group && GROUPS.includes(group)) {
					where.push("grp=?");
					params.push(group);
				}
				const rows = db()
					.prepare(`SELECT id, title, kind, path, ts, tags, confidence, grp FROM fact WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`)
					.all(...params, limit);
				const ids = new Set(rows.map((r) => r.id));
				const edges = db()
					.prepare("SELECT src, dst, rel, w FROM edge")
					.all()
					.filter((e) => ids.has(e.src) && ids.has(e.dst));
				sendOk(res, {
					nodes: rows.map((r) => ({
						id: r.id,
						title: r.title,
						kind: r.kind,
						path: r.path,
						ts: Number(r.ts),
						tags: safeJson(r.tags).slice(0, 3),
						confidence: Number(r.confidence ?? 0.6),
						grp: r.grp,
					})),
					edges,
					truncated: rows.length >= limit,
				});
			}),
		),

		// 7. 写卡
		route(
			"exact",
			`${API_PREFIX}/add`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const title = String(body.title ?? "").trim();
				const text = String(body.body ?? "").trim();
				if (!title) throw new HttpError(400, "missing-title", "缺少 title");
				if (!text) throw new HttpError(400, "missing-body", "缺少 body");
				const kind = String(body.kind ?? "fact");
				if (!KINDS.includes(kind)) throw new HttpError(400, "bad-kind", `kind 必须是 ${KINDS.join("/")}`);
				const pathInput = String(body.path ?? "").trim();
				const tags = String(body.tags ?? "")
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				const result = upsertFact(
					db(),
					{
						title,
						body: text,
						kind,
						path: pathInput || undefined,
						paths: pathInput ? [pathInput] : undefined,
						tags,
						source_kind: "http",
						source_ref: "panel",
						confidence: Number(body.confidence) || 0.8,
						ts: Date.now(),
					},
					seg,
				);
				sendOk(res, { result });
			}),
		),

		// 8. 吸收会话
		route(
			"exact",
			`${API_PREFIX}/ingest`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const started = Date.now();
				const result = ingest(db(), {
					limit: Number(body.limit) || undefined,
					rescan: body.rescan === true,
				});
				const nodes = digest(db());
				sendOk(res, { ...result, nodes_digested: nodes, ms: Date.now() - started });
			}),
		),

		// 9. 修订（id 不变，旧版本进历史）
		route(
			"exact",
			`${API_PREFIX}/update`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const id = String(body.id ?? "").trim();
				if (!id) throw new HttpError(400, "missing-id", "缺少 id");
				const patch = {};
				if (body.title !== undefined) patch.title = String(body.title);
				if (body.body !== undefined) patch.body = String(body.body);
				if (body.path !== undefined) patch.paths = body.path ? [String(body.path)] : [];
				if (body.kind !== undefined) {
					if (!KINDS.includes(String(body.kind))) throw new HttpError(400, "bad-kind", `kind 必须是 ${KINDS.join("/")}`);
					patch.kind = String(body.kind);
				}
				if (body.status !== undefined) {
					if (!STATUSES.includes(String(body.status))) {
						throw new HttpError(400, "bad-status", `status 必须是 ${STATUSES.join("/")}`);
					}
					patch.status = String(body.status);
				}
				if (body.tags !== undefined) {
					patch.tags = String(body.tags)
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean);
				}
				const result = updateFact(db(), id, patch, seg);
				if (result.result === "not-found") throw new HttpError(404, "not-found", `没有这张卡：${id}`);
				sendOk(res, result);
			}),
		),

		// 10. 标失效（不删，只降级）
		route(
			"exact",
			`${API_PREFIX}/forget`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const id = String(body.id ?? "").trim();
				if (!id) throw new HttpError(400, "missing-id", "缺少 id");
				const result = updateFact(db(), id, { status: "superseded" }, seg);
				if (result.result === "not-found") throw new HttpError(404, "not-found", `没有这张卡：${id}`);
				sendOk(res, { ...result, applied: "superseded" });
			}),
		),

		// 11. 历史版本 + 实体提及
		route(
			"exact",
			`${API_PREFIX}/history`,
			handle("GET", (req, res) => {
				const { query } = parseUrl(req);
				const id = queryString(query, "id");
				if (!id) throw new HttpError(400, "missing-id", "缺少 id");
				const detail = getFact(db(), id);
				if (detail === undefined) throw new HttpError(404, "not-found", `没有这张卡：${id}`);
				sendOk(res, { id: detail.id, version: detail.version, history: detail.history, mentions: detail.mentions });
			}),
		),

		// 12. 模型提炼（有通道就提炼，没有就出料）
		route(
			"exact",
			`${API_PREFIX}/distill`,
			handle("POST", async (req, res) => {
				if (typeof deps.distill !== "function") throw new HttpError(503, "no-distill", "没有可用的提炼通道");
				const body = await readJson(req);
				sendOk(res, await deps.distill({ path: body.path || undefined, limit: Number(body.limit) || undefined }));
			}),
		),

		// 13. 手动降级过期快照卡
		route(
			"exact",
			`${API_PREFIX}/sweep`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const staled = sweepStale(db(), {
					days: Number(body.days) || Number(deps.staleDays) || 30,
				});
				sendOk(res, { staled });
			}),
		),

		// 14. 投影成 Markdown 目录树（真身仍是 kb.db）
		route(
			"exact",
			`${API_PREFIX}/mirror`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const dir = String(body.dir ?? "").trim() || mirrorDir();
				const result = mirrorToDir(db(), dir, {
					limit: Number(body.limit) || undefined,
					dryRun: body.dryRun === true,
					readme: body.readme !== false,
				});
				sendOk(res, result);
			}),
		),

		// 18. 前端错误上报
		// 面板在浏览器里白屏/空壳时，控制台没人看得到；把错误落成一行日志，
		// 下次"只有框架没有内容"就能直接查 front.log 定位。
		route(
			"exact",
			`${API_PREFIX}/frontlog`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const level = String(body.level ?? "error").slice(0, 20);
				const message = String(body.message ?? "").slice(0, 800);
				const extra = body.extra === undefined ? "" : ` | ${JSON.stringify(body.extra).slice(0, 600)}`;
				const stack = body.stack === undefined ? "" : `\n${String(body.stack).slice(0, 1200)}`;
				try {
					const file = path.join(path.dirname(deps.getFile()), "front.log");
					appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}${extra}${stack}\n`);
					// 只留最近 200 行：一个渲染死循环不该把盘写满
					const lines = readFileSync(file, "utf8").split("\n");
					if (lines.length > 400) writeFileSync(file, lines.slice(-200).join("\n"));
				} catch {
					// 日志失败不影响上报本身
				}
				sendOk(res, { logged: true });
			}),
		),

		// 16. 建一条语义关系边（人工或模型指定）
		route(
			"exact",
			`${API_PREFIX}/link`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				try {
					sendOk(res, linkFacts(db(), body.src, body.dst, body.rel, { w: body.w, note: body.note }));
				} catch (error) {
					throw new HttpError(400, "bad-link", String(error?.message ?? error));
				}
			}),
		),

		// 17. 重算派生数据（分组 / 老边改名），幂等
		route(
			"exact",
			`${API_PREFIX}/migrate`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const scope = String(body.scope ?? "all");
				const result = { scope };
				if (scope === "all" || scope === "groups") result.groups = backfillGroups(db());
				if (scope === "all" || scope === "edges") result.edges = renameSessionEdges(db());
				sendOk(res, result);
			}),
		),

		// 15. 把镜像里的改动写回库
		route(
			"exact",
			`${API_PREFIX}/unmirror`,
			handle("POST", async (req, res) => {
				const body = await readJson(req);
				const dir = String(body.dir ?? "").trim() || mirrorDir();
				const result = importFromDir(db(), dir, {
					force: body.force === true,
					dryRun: body.dryRun === true,
				});
				sendOk(res, result);
			}),
		),
	];

	return { routes };
}

/** 端点清单，供 README / 测试断言用。 */
export const ENDPOINTS = [
	["GET", `${API_PREFIX}/stats`],
	["GET", `${API_PREFIX}/search`],
	["GET", `${API_PREFIX}/tree`],
	["GET", `${API_PREFIX}/facts`],
	["GET", `${API_PREFIX}/fact`],
	["GET", `${API_PREFIX}/graph`],
	["POST", `${API_PREFIX}/add`],
	["POST", `${API_PREFIX}/ingest`],
	["POST", `${API_PREFIX}/update`],
	["POST", `${API_PREFIX}/forget`],
	["GET", `${API_PREFIX}/history`],
	["POST", `${API_PREFIX}/sweep`],
	["POST", `${API_PREFIX}/distill`],
	["POST", `${API_PREFIX}/mirror`],
	["POST", `${API_PREFIX}/unmirror`],
	["POST", `${API_PREFIX}/link`],
	["POST", `${API_PREFIX}/migrate`],
	["POST", `${API_PREFIX}/frontlog`],
];

export { KINDS, STATUSES, REL_KINDS };
