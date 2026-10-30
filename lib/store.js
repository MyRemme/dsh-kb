/**
 * 存储层：`node:sqlite` + FTS5，零外部依赖。
 *
 * 一次真话三副视图：
 *   fact  —— 唯一真相，一行一条不可变事实卡
 *   node  —— 骨架树，多归属路径，摘要只是缓存
 *   edge  —— 关系图，写入时建边
 *   fts   —— 词法索引，bigram 分词
 *
 * 结构与 Python 原型的 `kb.db` 完全一致，同一份库两边都能开。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** 默认 DSH 数据目录。 */
export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 默认库路径。 */
export function defaultDbPath() {
	return process.env.DSH_KB_HOME
		? path.join(process.env.DSH_KB_HOME, "kb.db")
		: path.join(dshHome(), "kb", "kb.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fact (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'fact',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  paths       TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'active',
  confidence  REAL NOT NULL DEFAULT 0.6,
  source_kind TEXT NOT NULL DEFAULT 'manual',
  source_ref  TEXT NOT NULL DEFAULT '',
  session_id  TEXT NOT NULL DEFAULT '',
  cwd         TEXT NOT NULL DEFAULT '',
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fact_hash   ON fact(hash);
CREATE INDEX        IF NOT EXISTS fact_path   ON fact(path);
CREATE INDEX        IF NOT EXISTS fact_status ON fact(status);
CREATE INDEX        IF NOT EXISTS fact_ts     ON fact(ts);
CREATE INDEX        IF NOT EXISTS fact_kind   ON fact(kind);

-- FTS5 默认分词器即可：中文靠 segment.js 预切 bigram，这里不指定 tokenize。
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(
  title, body, tags, path
);

CREATE TABLE IF NOT EXISTS edge (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,
  w          REAL NOT NULL DEFAULT 1.0,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS edge_dst ON edge(dst);
CREATE INDEX IF NOT EXISTS edge_rel ON edge(rel);

CREATE TABLE IF NOT EXISTS node (
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  session_key TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  err         TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL
);
`;

const ROOTS = [
	["inbox", "未分类"],
	["topic", "主题"],
	["project", "项目"],
	["session", "会话"],
];

/**
 * 打开（并按需建表）库。
 * @param {string} [dbPath] - 库路径，缺省走 defaultDbPath()。
 * @returns {{ db: DatabaseSync, file: string }}
 */
export function openDb(dbPath) {
	const file = dbPath || defaultDbPath();
	if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=NORMAL");
	db.exec(SCHEMA);
	const now = Date.now();
	const ins = db.prepare(
		"INSERT OR IGNORE INTO node(path,parent,title,summary,created_at,updated_at) VALUES (?,?,?,'',?,?)",
	);
	for (const [p, title] of ROOTS) ins.run(p, "", title, now, now);
	return { db, file };
}

/**
 * 确保路径及其全部祖先节点存在。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} p - 形如 `topic/dsh` 的物化路径。
 */
export function ensureNode(db, p) {
	if (!p) return;
	const parts = p.split("/").filter(Boolean);
	const now = Date.now();
	const stmt = db.prepare(
		"INSERT OR IGNORE INTO node(path,parent,title,summary,created_at,updated_at) VALUES (?,?,?,'',?,?)",
	);
	for (let i = 0; i < parts.length; i += 1) {
		stmt.run(parts.slice(0, i + 1).join("/"), parts.slice(0, i).join("/"), parts[i], now, now);
	}
}

const PUNCT = /[\s,.;:'"`~!@#$%^&*()\[\]{}<>\-_=+|\\/?，。；：·、‘’“”！…（）【】《》]+/g;

/**
 * 归一化：去空白与标点、小写。哈希与去重都基于它。
 * @param {string} s - 原文。
 * @returns {string} 归一化串。
 */
export function normalize(s) {
	return String(s ?? "").trim().toLowerCase().replace(PUNCT, "");
}

/**
 * 内容哈希：标题前 200 字 + 正文前 2000 字的归一化摘要。
 * @param {string} title - 标题。
 * @param {string} body - 正文。
 * @returns {string} 40 位 hex。
 */
export function factHash(title, body) {
	return createHash("sha1")
		.update(`${normalize(title).slice(0, 200)}\u0000${normalize(body).slice(0, 2000)}`)
		.digest("hex");
}

/**
 * 稳定 id，便于人肉抄写与检索结果引用。
 * @param {string} title - 标题。
 * @param {string} body - 正文。
 * @returns {string} 形如 `f_xxxxxxxxxxxxxx`。
 */
export function makeId(title, body) {
	return `f_${factHash(title, body).slice(0, 14)}`;
}

/**
 * 写入一条事实卡（幂等）。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {object} f - 卡片字段。
 * @param {import('./segment.js').seg} segFn - 分词函数。
 * @returns {"added"|"updated"|"dup"|"skip"} 落库结果。
 */
export function upsertFact(db, f, segFn) {
	let title = String(f.title ?? "").trim();
	let body = String(f.body ?? "").trim();
	if (!title && !body) return "skip";
	if (!title) title = body.split("\n")[0].slice(0, 80);
	if (body.length > 6000) body = `${body.slice(0, 6000)}\n…[truncated]`;

	const hash = factHash(title, body);
	const now = Date.now();
	const ts = Number(f.ts) || now;
	const paths = [...new Set((f.paths ?? (f.path ? [f.path] : ["inbox"])).filter(Boolean))];
	if (paths.length === 0) paths.push("inbox");
	const path0 = f.path || paths[0];
	const tags = f.tags ?? [];

	// 去重双键：内容哈希（同内容不同标题）+ 标题（同结论不同措辞）。
	// 前者防重复录入，后者让「同一结论的补充」合并成一张卡而不是长出第二张。
	const prev = db.prepare("SELECT id, length(body) AS n FROM fact WHERE hash=? OR title=?").get(hash, title);
	if (prev) {
		if (body.length > (prev.n ?? 0) + 80) {
			db.prepare("UPDATE fact SET body=?, updated_at=?, confidence=MAX(confidence,?) WHERE id=?")
				.run(body, now, Number(f.confidence ?? 0.6), prev.id);
			const row = db.prepare("SELECT rowid FROM fact WHERE id=?").get(prev.id);
			db.prepare("DELETE FROM fact_fts WHERE rowid=?").run(row.rowid);
			db.prepare("INSERT INTO fact_fts(rowid,title,body,tags,path) VALUES (?,?,?,?,?)")
				.run(row.rowid, segFn(title), segFn(body), segFn(tags.join(" ")), segFn(paths.join(" ")));
			return "updated";
		}
		return "dup";
	}

	const id = makeId(title, body);
	for (const p of paths) ensureNode(db, p);
	db.prepare(
		"INSERT INTO fact(id,ts,kind,title,body,path,paths,tags,status,confidence," +
			"source_kind,source_ref,session_id,cwd,hash,created_at,updated_at) " +
			"VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		ts,
		f.kind ?? "fact",
		title,
		body,
		path0,
		JSON.stringify(paths),
		JSON.stringify(tags),
		f.status ?? "active",
		Number(f.confidence ?? 0.6),
		f.source_kind ?? "manual",
		f.source_ref ?? "",
		f.session_id ?? "",
		f.cwd ?? "",
		hash,
		now,
		now,
	);
	const row = db.prepare("SELECT rowid FROM fact WHERE id=?").get(id);
	db.prepare("INSERT INTO fact_fts(rowid,title,body,tags,path) VALUES (?,?,?,?,?)")
		.run(row.rowid, segFn(title), segFn(body), segFn(tags.join(" ")), segFn(paths.join(" ")));
	return "added";
}

/**
 * 建一条关系边（幂等覆盖）。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} src - 源卡 id。
 * @param {string} dst - 目标卡 id。
 * @param {string} rel - 关系名，如 contains / supersedes / related。
 * @param {number} [w] - 权重。
 * @param {string} [note] - 备注。
 */
export function addEdge(db, src, dst, rel, w = 1.0, note = "") {
	if (!src || !dst || src === dst) return;
	db.prepare(
		"INSERT INTO edge(src,dst,rel,w,note,created_at) VALUES (?,?,?,?,?,?) " +
			"ON CONFLICT(src,dst,rel) DO UPDATE SET w=excluded.w, note=excluded.note",
	).run(src, dst, rel, w, note, Date.now());
}

/**
 * 重建全文索引。换了分词规则之后必须跑一次。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {Function} segFn - 分词函数。
 * @returns {number} 重灌的卡数。
 */
export function reindex(db, segFn) {
	db.exec("DROP TABLE IF EXISTS fact_fts");
	db.exec(
		"CREATE VIRTUAL TABLE fact_fts USING fts5(title, body, tags, path)",
	);
	const rows = db.prepare("SELECT rowid,title,body,tags,paths FROM fact").all();
	const ins = db.prepare("INSERT INTO fact_fts(rowid,title,body,tags,path) VALUES (?,?,?,?,?)");
	for (const r of rows) {
		ins.run(r.rowid, segFn(r.title), segFn(r.body), segFn(r.tags), segFn(r.paths));
	}
	return rows.length;
}
