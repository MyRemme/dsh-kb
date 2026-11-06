/**
 * 存储层：`node:sqlite` + FTS5，零外部依赖。
 *
 * 一次真话三副视图：
 *   fact  —— 唯一真相，一行一条不可变事实卡
 *   node  —— 骨架树，多归属路径，摘要只是缓存
 *   edge  —— 关系图，写入时建边
 *   fts   —— 词法索引，bigram 分词
 *
 * v5 保留旧卡身份与历史；可变来源独立绑定，来源证据关联内容版本。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { seg } from './segment.js';
import { cleanPaths, scopeOf, timestampMs } from './integrity.js';

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
  version     INTEGER NOT NULL DEFAULT 1,
  -- grp 是派生的展示分组（记忆/文档/对话/项目/任务），与 kind 不同：
  -- kind 回答"这条东西是什么形态"，grp 回答"它该出现在哪个抽屉里"。
  -- 用 grp 而不是 group，因为 group 是 SQL 关键字。
  grp         TEXT NOT NULL DEFAULT 'memory',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
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

-- 修订历史：卡 id 稳定，旧版本按版本号快照在这里。
-- 为什么不新建一条 fact：id 一变，边、外部引用、面板选中全部指空。
CREATE TABLE IF NOT EXISTS fact_history (
  id          TEXT NOT NULL,
  version     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  paths       TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  kind        TEXT NOT NULL DEFAULT 'fact',
  status      TEXT NOT NULL DEFAULT 'active',
  confidence  REAL NOT NULL DEFAULT 0.6,
  hash        TEXT NOT NULL DEFAULT '',
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

-- 实体提及：正文里抽出的路径 / 符号 / 版本 / 错误码。
-- 用途是"改这个文件之前，先看历史上踩过什么"，这是纯全文检索答不出的问题。
-- 使用反馈明细：一张卡有没有被"用过"。汇总列在 fact 上（hit/adopt/reject_count），
-- 这里只留最近的事件用于回溯"谁在什么时候因为什么用了它"。
CREATE TABLE IF NOT EXISTS usage (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  query   TEXT,
  rank    INTEGER,
  source  TEXT
);
CREATE INDEX IF NOT EXISTS usage_fact ON usage(fact_id, kind);

CREATE TABLE IF NOT EXISTS mention (
  fact_id TEXT NOT NULL,
  token   TEXT NOT NULL,
  type    TEXT NOT NULL,
  PRIMARY KEY (fact_id, token, type)
);
CREATE INDEX IF NOT EXISTS mention_token ON mention(token);
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
	try {
		transaction(db, () => {
			db.exec(SCHEMA);
			migrate(db);
			const now = Date.now();
			const ins = db.prepare("INSERT OR IGNORE INTO node(path,parent,title,summary,created_at,updated_at) VALUES (?,?,?,'',?,?)");
			for (const [p, title] of ROOTS) ins.run(p, "", title, now, now);
		});
	} catch (error) { db.close(); throw error; }
	return { db, file };
}

/**
 * 给已存在的库补列。老库（0.1/0.2 建的）没有 `version`，这里补上，
 * 否则第一次 `SELECT version` 就会炸在别人的库上。
 * @param {DatabaseSync} db - 已打开的库。
 */
function migrate(db) {
	const cols = db.prepare("PRAGMA table_info(fact)").all().map((c) => c.name);
	if (!cols.includes("version")) db.exec("ALTER TABLE fact ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
	if (!cols.includes("grp")) db.exec("ALTER TABLE fact ADD COLUMN grp TEXT NOT NULL DEFAULT 'memory'");
	// 索引必须等列补上再建：SCHEMA 里的 CREATE INDEX 会在老库上先跑，
	// 而老库那时还没有 grp 列 —— 直接 "no such column: grp"。
	db.exec("CREATE INDEX IF NOT EXISTS fact_grp ON fact(grp)");

	// 使用反馈的汇总列。放在 migrate 里而不是 SCHEMA：SCHEMA 的 CREATE TABLE 对老库
	// 不生效，新列只能 ALTER 补 —— 而 ALTER 又要等表存在，所以顺序是 建表 -> 补列 -> 建索引。
	const hasUsageColumn = db
		.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('fact') WHERE name='hit_count'")
		.get().n;
	if (Number(hasUsageColumn) === 0) {
		db.exec("ALTER TABLE fact ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0");
		db.exec("ALTER TABLE fact ADD COLUMN adopt_count INTEGER NOT NULL DEFAULT 0");
		db.exec("ALTER TABLE fact ADD COLUMN reject_count INTEGER NOT NULL DEFAULT 0");
		db.exec("ALTER TABLE fact ADD COLUMN last_hit_at INTEGER");
	}
	// 索引必须在这一行之后：老库的 fact 表原本没有这三个列，
	// 先建索引会直接 no such column（这台机器上已经踩过三次）。
	db.exec("CREATE INDEX IF NOT EXISTS fact_usage ON fact(hit_count, adopt_count, reject_count)");
	// 回填只做一次：1199 张卡每次开库都重算会拖慢启动，用 user_version 记进度。
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
	if (version < 2) {
		backfillGroups(db);
		db.exec("PRAGMA user_version=2");
	}
	if (version < 3) {
		renameSessionEdges(db);
		db.exec("PRAGMA user_version=3");
	}
	if (version < 4) migrateIntegrity(db);
	if (version < 5) migrateSources(db);
}

/** SAVEPOINT 可嵌套；卡、来源、FTS、边必须一起提交或一起回滚。 */
export function transaction(db, fn) {
	db.exec('SAVEPOINT kb_write');
	try { const result = fn(); db.exec('RELEASE kb_write'); return result; }
	catch (error) { db.exec('ROLLBACK TO kb_write'); db.exec('RELEASE kb_write'); throw error; }
}

/** v4 保留所有旧 id/历史/边；派生哈希和索引重建，不猜测被覆盖的旧正文。 */
function migrateIntegrity(db) {
	transaction(db, () => {
		const hadScope = db.prepare("SELECT 1 FROM pragma_table_info('fact') WHERE name='scope'").get();
		const additions = {
			fact: {scope:"TEXT NOT NULL DEFAULT 'global'",open_count:'INTEGER NOT NULL DEFAULT 0',cite_count:'INTEGER NOT NULL DEFAULT 0',
				explicit_adopt_count:'INTEGER NOT NULL DEFAULT 0',explicit_reject_count:'INTEGER NOT NULL DEFAULT 0',last_confirmed_at:'INTEGER'},
			usage: {session_id:"TEXT NOT NULL DEFAULT ''"},
			fact_history: {source_kind:"TEXT NOT NULL DEFAULT ''",source_ref:"TEXT NOT NULL DEFAULT ''",session_id:"TEXT NOT NULL DEFAULT ''",cwd:"TEXT NOT NULL DEFAULT ''",scope:"TEXT NOT NULL DEFAULT 'global'"},
		};
		for (const [table, columns] of Object.entries(additions)) {
			const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
			for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
		}
		db.exec(`DROP INDEX IF EXISTS fact_hash;
		CREATE INDEX IF NOT EXISTS fact_hash_scope ON fact(hash,scope);
		CREATE TABLE IF NOT EXISTS fact_source(fact_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
		  session_id TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL,
		  PRIMARY KEY(fact_id,source_kind,source_ref,session_id,cwd));
		CREATE TABLE IF NOT EXISTS distill_progress(source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
		  source_hash TEXT NOT NULL, offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
		  provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version INTEGER NOT NULL, ts INTEGER NOT NULL,
		  PRIMARY KEY(source_id,source_version,source_hash,offset));
		CREATE TABLE IF NOT EXISTS usage_once(fact_id TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT NOT NULL,
		  PRIMARY KEY(fact_id,kind,session_id));
		CREATE TRIGGER IF NOT EXISTS edge_endpoint_insert BEFORE INSERT ON edge WHEN
		  NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.src) OR NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.dst)
		  BEGIN SELECT RAISE(ABORT,'Edge endpoint does not exist'); END;
		CREATE TRIGGER IF NOT EXISTS edge_endpoint_update BEFORE UPDATE OF src,dst ON edge WHEN
		  NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.src) OR NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.dst)
		  BEGIN SELECT RAISE(ABORT,'Edge endpoint does not exist'); END;`);
		// 部分旧结构必须可用；不能仅有同名表就把损坏的结构标成 v4。
		for (const [table, columns] of Object.entries({
			fact_source:'fact_id,source_kind,source_ref,session_id,cwd,created_at',
			distill_progress:'source_id,source_version,source_hash,offset,end_offset,provider,model,prompt_version,ts',
			usage_once:'fact_id,kind,session_id',
		})) db.prepare(`SELECT ${columns} FROM ${table} LIMIT 0`).all();
		for (const row of db.prepare('SELECT * FROM fact').all()) {
			db.prepare('UPDATE fact SET hash=?,scope=?,ts=?,created_at=?,updated_at=? WHERE id=?').run(
				factHash(row.title,row.body),scopeOf({...row,scope:hadScope ? row.scope : undefined}),timestampMs(row.ts),timestampMs(row.created_at),timestampMs(row.updated_at),row.id);
			db.prepare('INSERT OR IGNORE INTO fact_source(fact_id,source_kind,source_ref,session_id,cwd,created_at) VALUES (?,?,?,?,?,?)')
				.run(row.id,row.source_kind,row.source_ref,row.session_id,row.cwd,Date.now());
			recordMentions(db,row.id,extractMentions(row.title,row.body,row.cwd));
		}
		// 旧遗忘流程曾写入 ISO 文本；统一存储时间，但保留历史正文和旧哈希作原始快照。
		for (const [table, columns] of Object.entries({fact:['last_hit_at','last_confirmed_at'],fact_history:['ts','archived_at'],usage:['ts'],node:['created_at','updated_at'],edge:['created_at'],ingest_log:['mtime','ts']})) {
			for (const row of db.prepare(`SELECT rowid AS _rowid,${columns.join(',')} FROM ${table}`).all()) {
				db.prepare(`UPDATE ${table} SET ${columns.map(c=>c+'=?').join(',')} WHERE rowid=?`).run(...columns.map(c=>row[c] == null ? null : timestampMs(row[c])),row._rowid);
			}
		}
		// 旧 adopt 混合阅读/引用/确认，不能伪称用户确认；旧计数保留但不参与新质量分。
		reindex(db,seg);
		db.exec('PRAGMA user_version=4');
	});
}

/** v5 不猜测旧来源支持哪个版本；仅独占来源可继续绑定，未知基线保守冲突。 */
function migrateSources(db) {
	if (!db.prepare("SELECT 1 FROM pragma_table_info('fact_source') WHERE name='source_version'").get()) db.exec(`ALTER TABLE fact_source RENAME TO fact_source_v4;
	CREATE TABLE fact_source(fact_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
	  session_id TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL,
	  source_version INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
	  PRIMARY KEY(fact_id,source_kind,source_ref,session_id,cwd,source_version));
	INSERT INTO fact_source(fact_id,source_kind,source_ref,session_id,cwd,created_at)
	  SELECT fact_id,source_kind,source_ref,session_id,cwd,created_at FROM fact_source_v4;
	DROP TABLE fact_source_v4;`);
	db.exec(`CREATE TABLE IF NOT EXISTS source_binding(source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
	  fact_id TEXT NOT NULL, baseline TEXT, PRIMARY KEY(source_kind,source_ref,scope,kind));`);
	db.prepare('SELECT fact_id,source_version,source_hash FROM fact_source LIMIT 0').all();
	db.prepare('SELECT source_kind,source_ref,scope,kind,fact_id,baseline FROM source_binding LIMIT 0').all();
	const insert = db.prepare('INSERT OR IGNORE INTO source_binding VALUES (?,?,?,?,?,NULL)');
	for (const row of db.prepare("SELECT * FROM fact WHERE source_kind IN ('session','compaction') AND source_ref<>'' ORDER BY created_at,id").all()) {
		const origins = db.prepare('SELECT * FROM fact_source WHERE fact_id=?').all(row.id);
		if (origins.length === 1 && origins[0].source_kind === row.source_kind && origins[0].source_ref === row.source_ref)
			insert.run(row.source_kind,row.source_ref,row.scope,row.kind,row.id);
	}
	db.exec('PRAGMA user_version=5');
}

function recordSource(db,id,f) {
	const row = db.prepare('SELECT version,hash FROM fact WHERE id=?').get(id);
	db.prepare('INSERT OR IGNORE INTO fact_source VALUES (?,?,?,?,?,?,?,?)').run(id,String(f.source_kind ?? 'manual'),String(f.source_ref ?? ''),String(f.session_id ?? ''),String(f.cwd ?? ''),Date.now(),row.version,row.hash);
}

const MUTABLE_SOURCES = new Set(['session','compaction']);
const RAW_KINDS = new Set(['episode','segment','intent','state','artifact','todo']);
const SOURCE_FIELDS = ['title','body','paths','tags','kind','confidence','ts'];
const sameValue = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function sourceBaseline(f) { return Object.fromEntries(SOURCE_FIELDS.map(key=>[key,f[key]])); }

function reviseSource(db,binding,f,segFn) {
	const row = db.prepare('SELECT * FROM fact WHERE id=?').get(binding.fact_id);
	if (!row) throw new Error('Source binding points to a missing fact');
	const next = sourceBaseline(f), current = {...row,paths:JSON.parse(row.paths),tags:JSON.parse(row.tags)};
	const previous = binding.baseline ? JSON.parse(binding.baseline) : null;
	const saveBaseline = () => db.prepare('UPDATE source_binding SET baseline=? WHERE source_kind=? AND source_ref=? AND scope=? AND kind=?')
		.run(JSON.stringify(next),f.source_kind,f.source_ref,f.scope,f.kind);
	if (!previous) {
		if (row.hash !== f.hash) return {result:'conflict',id:row.id,version:row.version,reason:'source-baseline-missing'};
		saveBaseline(); recordSource(db,row.id,f);
		return {result:'dup',id:row.id,version:row.version};
	}
	const patch = {}, conflicts = [];
	for (const key of SOURCE_FIELDS) {
		if (sameValue(next[key],previous[key])) continue;
		if (sameValue(current[key],previous[key]) || sameValue(current[key],next[key])) patch[key] = next[key];
		else conflicts.push(key);
	}
	if (conflicts.length) return {result:'conflict',id:row.id,version:row.version,reason:'source-edited',fields:conflicts};
	const saved = updateFact(db,row.id,patch,segFn);
	saveBaseline();
	// 人工修订的正文不能被登记为原始来源的新版本。
	if (db.prepare('SELECT hash FROM fact WHERE id=?').get(row.id).hash === f.hash) recordSource(db,row.id,f);
	return {...saved,result:saved.result === 'unchanged' ? 'dup' : saved.result};
}

/**
 * 把"会话卡 → 卡"的 `contains` 边改名成 `produces`。
 *
 * 这两者的语义不一样：contains 是"项目包含文档"那种归属，produces 是"这段对话产生了
 * 这条记忆"。老库全存成了 contains，混在图上就分不出"归属"和"因果"。
 *
 * 幂等：改名走 INSERT OR IGNORE + DELETE，重跑没有副作用。
 * @param {DatabaseSync} db - 已打开的库。
 * @returns {number} 改名的边数。
 */
export function renameSessionEdges(db) {
	const rows = db
		.prepare(
			"SELECT e.src, e.dst, e.w, e.note, e.created_at FROM edge e " +
				"JOIN fact f ON f.id=e.src WHERE e.rel='contains' AND f.kind='episode'",
		)
		.all();
	const ins = db.prepare(
		"INSERT OR IGNORE INTO edge(src,dst,rel,w,note,created_at) VALUES (?,?,'produces',?,?,?)",
	);
	const del = db.prepare("DELETE FROM edge WHERE src=? AND dst=? AND rel='contains'");
	for (const row of rows) {
		ins.run(row.src, row.dst, Number(row.w ?? 1), String(row.note ?? ""), Number(row.created_at ?? Date.now()));
		del.run(row.src, row.dst);
	}
	return rows.length;
}

/**
 * 按 kind + path 重算每张卡的展示分组。
 *
 * 幂等：可以随时重跑（换规则、批量改 kind 之后）。
 * @param {DatabaseSync} db - 已打开的库。
 * @returns {number} 更新的行数。
 */
export function backfillGroups(db) {
	const rows = db.prepare("SELECT id, kind, path FROM fact").all();
	const stmt = db.prepare("UPDATE fact SET grp=? WHERE id=?");
	let n = 0;
	for (const row of rows) {
		stmt.run(groupOfFact(row.kind, row.path), row.id);
		n += 1;
	}
	return n;
}

/** 展示分组。顺序即优先级：先按 kind 判具体类别，再看路径前缀。 */
export const GROUPS = ["memory", "doc", "talk", "project", "task"];

/**
 * 一张卡属于哪个展示分组。
 *
 * 与前端 chips 同一套规则 —— 两侧必须一致，否则图上的计数和列表里的条数对不上。
 * 顺序有讲究：`project/*` 既可能是项目也可能是记忆卡，先按 kind 判完再落到 project。
 *
 * @param {string} kind - 卡类型。
 * @param {string} factPath - 主路径。
 * @returns {string} 分组名，落在 {@link GROUPS} 里。
 */
export function groupOfFact(kind, factPath) {
	if (["fact", "decision", "concept", "fix", "pref", "howto"].includes(kind)) return "memory";
	if (kind === "artifact") return "doc";
	if (kind === "episode" || kind === "intent") return "talk";
	if (String(factPath ?? "").startsWith("project/")) return "project";
	if (kind === "todo" || kind === "state") return "task";
	return "memory";
}

/**
 * 允许的语义关系名。
 *
 * 前四个是库里已有的；后五个对应设计稿里那几种边，留给人工建边与自动建边用。
 * 白名单的意义是**拒绝**拼错的关系名 —— 一个 `rel="supersede"` 的边在图上就是一句哑话。
 */
export const REL_KINDS = [
	"contains",
	"related",
	"supersedes",
	"derived_from",
	"produces",
	"references",
	"transforms",
	"applies_to",
	"affects",
];

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
 * 模糊相似文本：去空白与标点、小写。不能用于身份或版本判断。
 * @param {string} s - 原文。
 * @returns {string} 归一化串。
 */
export function normalize(s) {
	return String(s ?? "").trim().toLowerCase().replace(PUNCT, "");
}

/** 完整存储内容的精确指纹；模糊 normalize 仅供相似检索，不能决定修订。 */
export function factHash(title, body) {
    return createHash("sha256").update(JSON.stringify([String(title), String(body)])).digest("hex");
}

/** 仅用于新卡的初始 id；修订和迁移绝不重算已有 id。 */
export function makeId(title, body, scope = 'global') {
    return `f_${createHash('sha256').update(JSON.stringify([scope, title, body])).digest('hex').slice(0, 20)}`;
}

/** 校验与规范化发生在事务内；正文不再按前缀截断，避免未保存的尾部被误认成功。 */
function payload(f) {
    let title = String(f.title ?? '').trim();
    const body = String(f.body ?? '');
    if (!title && !body) return null;
    if (!title) title = body.split('\n')[0].slice(0,80);
    if (body.length > 1000000) throw new Error('Fact body exceeds 1000000 characters');
    const paths = cleanPaths(f);
    const confidence = Number(f.confidence ?? (SNAPSHOT_KINDS.has(f.kind) ? SNAPSHOT_CONFIDENCE : 0.6));
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
    const status = f.status ?? 'active';
    if (!['active','doubtful','superseded'].includes(status)) throw new Error('Invalid fact status');
    if (!Array.isArray(f.tags ?? [])) throw new Error('tags must be an array');
    return {...f,title,body,paths,path:paths[0],tags:(f.tags ?? []).map(String),kind:f.kind ?? 'fact',status,confidence,
        ts:timestampMs(f.ts),scope:scopeOf({...f,paths}),hash:factHash(title,body)};
}

function syncProjection(db,id,segFn) {
    const r = db.prepare('SELECT rowid,* FROM fact WHERE id=?').get(id);
    db.prepare('DELETE FROM fact_fts WHERE rowid=?').run(r.rowid);
    db.prepare('INSERT INTO fact_fts(rowid,title,body,tags,path) VALUES (?,?,?,?,?)').run(r.rowid,segFn(r.title),segFn(r.body),segFn(JSON.parse(r.tags).join(' ')),segFn(JSON.parse(r.paths).join(' ')));
    recordMentions(db,id,extractMentions(r.title,r.body,r.cwd));
}

/** 唯一事实写入口返回实际身份；来源固定的会话片段可修订，标题相同不能覆盖。 */
export function writeFact(db, input, segFn = seg, explicitId) {
    return transaction(db, () => {
        const f = payload(input);
        if (!f) return {result:'skip'};
        if (explicitId && !/^f_[0-9a-f]{8,}$/i.test(explicitId)) throw new Error('Invalid fact id');
        let prev = explicitId ? db.prepare('SELECT * FROM fact WHERE id=?').get(explicitId) : undefined;
        const mutable = MUTABLE_SOURCES.has(f.source_kind) && Boolean(f.source_ref);
        if (!prev && !explicitId && mutable) {
            const binding = db.prepare('SELECT * FROM source_binding WHERE source_kind=? AND source_ref=? AND scope=? AND kind=?').get(f.source_kind,f.source_ref,f.scope,f.kind);
            if (binding) return reviseSource(db,binding,f,segFn);
        }
        if (!prev && !explicitId && !mutable) prev = db.prepare('SELECT * FROM fact WHERE hash=? AND scope=? ORDER BY created_at,id').all(f.hash,f.scope)
            .find(row=>!MUTABLE_SOURCES.has(row.source_kind) && RAW_KINDS.has(row.kind) === RAW_KINDS.has(f.kind)
                && (f.source_kind !== 'distill' || row.source_kind === 'distill'));
        if (prev) { recordSource(db,prev.id,f); return {result:'dup',id:prev.id,version:Number(prev.version)}; }
        let id = explicitId || makeId(f.title,f.body,f.scope);
        if (db.prepare('SELECT 1 FROM fact WHERE id=?').get(id)) id = `f_${randomUUID().replaceAll('-','')}`;
        const now = Date.now();
        for (const p of f.paths) ensureNode(db,p);
        db.prepare(`INSERT INTO fact(id,ts,kind,title,body,path,paths,tags,status,confidence,source_kind,source_ref,session_id,cwd,hash,version,grp,created_at,updated_at,scope)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(id,f.ts,f.kind,f.title,f.body,f.path,JSON.stringify(f.paths),JSON.stringify(f.tags),f.status,f.confidence,
            String(f.source_kind ?? 'manual'),String(f.source_ref ?? ''),String(f.session_id ?? ''),String(f.cwd ?? ''),f.hash,groupOfFact(f.kind,f.path),now,now,f.scope);
        if (mutable) db.prepare('INSERT INTO source_binding VALUES (?,?,?,?,?,?)').run(f.source_kind,f.source_ref,f.scope,f.kind,id,JSON.stringify(sourceBaseline(f)));
        recordSource(db,id,f); syncProjection(db,id,segFn);
        return {result:'added',id,version:1};
    });
}

/** 兼容既有 CLI/调用者的计数字符串；需要建边的代码必须调用 writeFact 获取实际 id。 */
export function upsertFact(db,f,segFn) { return writeFact(db,f,segFn).result; }

/** Markdown 的外部 id 是引用锚，导入不得根据正文重新生成。 */
export function insertFactWithId(db,id,f,segFn) { return writeFact(db,f,segFn,String(id)).result; }

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
 * 建一条**语义**关系边（对外入口，带校验）。
 *
 * 与内部的 `addEdge` 分开：addEdge 是写入原语，linkFacts 是"人/模型要求建边"的唯一路径，
 * 所以要拒绝拼错的关系名、拒绝自环、拒绝指向不存在的卡。
 *
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} src - 源卡 id。
 * @param {string} dst - 目标卡 id。
 * @param {string} rel - 关系名，须在 {@link REL_KINDS} 里。
 * @param {{w?: number, note?: string}} [options] - 权重与备注。
 * @returns {{result: string, src: string, dst: string, rel: string}} 结果。
 */
export function linkFacts(db, src, dst, rel, options = {}) {
	const relName = String(rel ?? "").trim();
	const from = String(src ?? "").trim();
	const to = String(dst ?? "").trim();
	if (!REL_KINDS.includes(relName)) {
		throw new Error(`未知关系：${relName || "(空)"}；可选：${REL_KINDS.join(" / ")}`);
	}
	if (from === "" || to === "") throw new Error("源卡与目标卡都要给");
	if (from === to) throw new Error("不能把一张卡连到它自己");
	const a = db.prepare("SELECT id FROM fact WHERE id=?").get(from);
	const b = db.prepare("SELECT id FROM fact WHERE id=?").get(to);
	if (a === undefined || b === undefined) throw new Error(`卡不存在：${a === undefined ? from : to}`);
	addEdge(db, from, to, relName, Number(options.w) || 1.0, String(options.note ?? ""));
	return { result: "linked", src: from, dst: to, rel: relName };
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

/**
 * 快照型卡：写完就开始过期。todo/state/artifact 描述的是"当时"，不是"结论"。
 * 给它们低置信度 + 到期降级，检索默认就看不见了（不删，只是沉下去）。
 */
export const SNAPSHOT_KINDS = new Set(["todo", "state", "artifact", "segment", "episode"]);
const SNAPSHOT_CONFIDENCE = 0.35;
const STALE_KINDS = ["todo", "state", "artifact", "segment"];

/** 实体抽取规则：路径 / 版本 / 错误码 / 反引号符号。 */
const MENTION_RULES = [
	["path", /(?:[A-Za-z]:[\\/]|\/|(?:\.{1,2}[\\/])?[\w@.-]+[\\/])[^\s"'`<>()\[\]]{3,}/g],
	["version", /\b(?:[\w@/-]+@\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?|v\d+\.\d+(?:\.\d+)?)\b/g],
	["error", /\b(?:E[A-Z]{3,}|ERR_[A-Z_]+|HTTP\s?\d{3}|0x[0-9A-Fa-f]{6,8})\b/g],
	["symbol", /`([A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*)`/g],
];

/**
 * 从标题+正文里抽实体。只做词法，不做语义——抽错一个词只是多一条提及，不影响结论。
 * @param {string} title - 标题。
 * @param {string} body - 正文。
 * @returns {Array<{token: string, type: string}>} 去重后的实体。
 */
export function extractMentions(title, body, cwd = "") {
	const hay = `${title}\n${body}`;
	const seen = new Set();
	const out = [];
	for (const [type, re] of MENTION_RULES) {
		re.lastIndex = 0;
		let m = re.exec(hay);
		while (m !== null) {
			const raw = String(type === "symbol" ? m[1] : m[0]).trim().replace(/[.,;:，。；：]+$/, "");
			const token = (type === "path" ? raw.replace(/\\/g, "/") : raw).toLowerCase();
			const key = `${type}:${token}`;
			if (token.length >= 3 && token.length <= 200 && !seen.has(key)) {
				seen.add(key);
				out.push({ token, type });
                if (type === "path" && cwd && !/^(?:[a-z]:|\/)/i.test(token)) {
                    const absolute = path.posix.normalize(`${cwd.replaceAll("\\", "/")}/${token}`).toLowerCase();
                    if (!seen.has(`path:${absolute}`)) { seen.add(`path:${absolute}`); out.push({token:absolute,type}); }
                }
			}
			if (out.length >= 80) return out;
			m = re.exec(hay);
		}
	}
	return out;
}

/**
 * 记下一条卡提到了哪些实体（覆盖写，幂等）。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} id - 卡 id。
 * @param {Array<{token: string, type: string}>} mentions - 实体列表。
 */
export function recordMentions(db, id, mentions) {
	db.prepare("DELETE FROM mention WHERE fact_id=?").run(id);
	const ins = db.prepare("INSERT OR IGNORE INTO mention(fact_id,token,type) VALUES (?,?,?)");
	for (const m of mentions) ins.run(id, m.token, m.type);
}

/**
 * 按 id 前缀找一张卡（人肉抄 id 时只用前 8 位也能命中）。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} idOrPrefix - 完整 id 或前缀。
 * @returns {object|undefined} 卡行。
 */
export function resolveFact(db, idOrPrefix) {
	const raw = String(idOrPrefix ?? "").trim();
	if (!raw) return undefined;
	const exact = db.prepare("SELECT * FROM fact WHERE id=?").get(raw);
	if (exact !== undefined) return exact;
	const rows = db.prepare("SELECT * FROM fact WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2").all(`${raw}%`);
	return rows.length === 1 ? rows[0] : undefined;
}

/**
 * 改一张卡：**id 不变**，旧版本快照进 fact_history。
 *
 * 为什么必须稳定 id：卡 id 是边、面板选中、外部引用的锚。改正文就换 id 的话，
 * 「同一个结论的演进」在库里就变成两张互不相干的卡。
 *
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} idOrPrefix - 目标卡（id 或前缀）。
 * @param {object} patch - 要改的字段：title/body/paths/tags/kind/status/confidence。
 * @param {Function} segFn - 分词函数。
 * @returns {{result: string, id?: string, version?: number}} 结果与版本号。
 */
export function updateFact(db, idOrPrefix, patch, segFn = seg) {
    return transaction(db, () => {
        const row = resolveFact(db,idOrPrefix);
        if (!row) return {result:'not-found'};
        const f = payload({...row, paths:JSON.parse(row.paths),tags:JSON.parse(row.tags),...patch,
            path: patch.paths !== undefined ? undefined : (patch.path ?? row.path),
            scope: patch.scope ?? row.scope});
        if (!f) throw new Error('Fact cannot be empty');
        const values = {...f, paths:JSON.stringify(f.paths),tags:JSON.stringify(f.tags)};
        const keys = ['title','body','path','paths','tags','kind','status','confidence','hash','scope','source_kind','source_ref','session_id','cwd','ts'];
        if (keys.every(k => values[k] === row[k])) return {result:'unchanged',id:row.id,version:Number(row.version)};
        const now = Math.max(Date.now(),timestampMs(row.updated_at)+1);
        db.prepare(`INSERT INTO fact_history(id,version,ts,title,body,paths,tags,kind,status,confidence,hash,archived_at,source_kind,source_ref,session_id,cwd,scope)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.version,row.ts,row.title,row.body,row.paths,row.tags,row.kind,row.status,row.confidence,row.hash,now,row.source_kind,row.source_ref,row.session_id,row.cwd,row.scope);
        for (const p of f.paths) ensureNode(db,p);
        db.prepare(`UPDATE fact SET ${keys.map(k => k+'=?').join(',')},grp=?,version=version+1,updated_at=? WHERE id=?`).run(...keys.map(k=>values[k]),groupOfFact(f.kind,f.path),now,row.id);
        syncProjection(db,row.id,segFn);
        return {result:'updated',id:row.id,version:Number(row.version)+1};
    });
}

/**
 * 读一张卡：正文 + 修订历史 + 入/出边 + 提及的实体。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} idOrPrefix - id 或前缀。
 * @returns {object|undefined} 详情。
 */
export function getFact(db, idOrPrefix) {
	const row = resolveFact(db, idOrPrefix);
	if (row === undefined) return undefined;
	const outbound = db
		.prepare("SELECT e.rel,e.w,e.note,e.dst AS source_id,f.id,f.title,f.kind,f.path,f.ts FROM edge e JOIN fact f ON f.id=e.dst WHERE e.src=? LIMIT 40")
		.all(row.id).map(edge=>withEvidence(db,edge));
	const inbound = db
		.prepare("SELECT e.rel,e.w,e.note,e.dst AS source_id,f.id,f.title,f.kind,f.path,f.ts FROM edge e JOIN fact f ON f.id=e.src WHERE e.dst=? LIMIT 40")
		.all(row.id).map(edge=>withEvidence(db,edge));
	const history = db
		.prepare("SELECT version,ts,title,body,paths,tags,kind,status,confidence,hash,archived_at,source_kind,source_ref,session_id,cwd,scope FROM fact_history WHERE id=? ORDER BY version DESC LIMIT 20")
		.all(row.id);
	const mentions = db
		.prepare("SELECT token,type FROM mention WHERE fact_id=? ORDER BY type,token")
		.all(row.id);
	const sources = db.prepare("SELECT * FROM fact_source WHERE fact_id=?").all(row.id);
	return { ...row, outbound, inbound, history, mentions, sources };
}

function withEvidence(db,edge) {
	if (edge.rel !== 'derived_from') return edge;
	let note;
	try { note = JSON.parse(edge.note); } catch { return edge; }
	if (!note || !Number.isInteger(note.version) || typeof note.hash !== 'string') return edge;
	const source = db.prepare('SELECT id,version,hash,title,body FROM fact WHERE id=?').get(edge.source_id);
	const snapshot = source?.version === note.version ? source : db.prepare('SELECT id,version,hash,title,body FROM fact_history WHERE id=? AND version=?').get(edge.source_id,note.version);
	return {...edge,provenance:{sourceId:edge.source_id,version:note.version,hash:note.hash,evidence:Array.isArray(note.evidence) ? note.evidence : [],
		currentVersion:source?.version,changed:source?.version !== note.version,snapshot:snapshot?.hash === note.hash ? snapshot : null}};
}

/**
 * 快照型卡到期降级：不删，只把 status 从 active 挪走，让它们从默认检索里沉下去。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {object} [options] - 选项。
 * @param {number} [options.days] - 多少天后算过期，默认 30。
 * @param {string[]} [options.kinds] - 参与降级的类型，默认 todo/state/artifact/segment。
 * @returns {number} 降级的条数。
 */
export function sweepStale(db, options = {}) {
	const days = Number(options.days ?? 30);
	if (!Number.isFinite(days) || days < 0) throw new Error('Invalid stale days');
	const kinds = options.kinds ?? STALE_KINDS;
	if (kinds.length === 0) return 0;
	const cutoff = Date.now() - days * 86400000;
	const clause = kinds.map(() => "?").join(",");
	return transaction(db, () => {
		const rows = db.prepare(`SELECT id FROM fact WHERE status='active' AND kind IN (${clause}) AND ts < ?`).all(...kinds,cutoff);
		for (const row of rows) updateFact(db,row.id,{status:'doubtful'});
		return rows.length;
	});
}
