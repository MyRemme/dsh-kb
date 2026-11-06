-- Frozen schema v4 before the lifecycle repairs; no user data.
CREATE TABLE fact (
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
, hit_count INTEGER NOT NULL DEFAULT 0, adopt_count INTEGER NOT NULL DEFAULT 0, reject_count INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, scope TEXT NOT NULL DEFAULT 'global', open_count INTEGER NOT NULL DEFAULT 0, cite_count INTEGER NOT NULL DEFAULT 0, explicit_adopt_count INTEGER NOT NULL DEFAULT 0, explicit_reject_count INTEGER NOT NULL DEFAULT 0, last_confirmed_at INTEGER);
CREATE INDEX fact_path   ON fact(path);
CREATE INDEX fact_status ON fact(status);
CREATE INDEX fact_ts     ON fact(ts);
CREATE INDEX fact_kind   ON fact(kind);
CREATE TABLE edge (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  rel        TEXT NOT NULL,
  w          REAL NOT NULL DEFAULT 1.0,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX edge_dst ON edge(dst);
CREATE INDEX edge_rel ON edge(rel);
CREATE TABLE node (
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE ingest_log (
  session_key TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  err         TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL
);
CREATE TABLE fact_history (
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
  archived_at INTEGER NOT NULL, source_kind TEXT NOT NULL DEFAULT '', source_ref TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'global',
  PRIMARY KEY (id, version)
);
CREATE TABLE usage (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  query   TEXT,
  rank    INTEGER,
  source  TEXT
, session_id TEXT NOT NULL DEFAULT '');
CREATE INDEX usage_fact ON usage(fact_id, kind);
CREATE TABLE mention (
  fact_id TEXT NOT NULL,
  token   TEXT NOT NULL,
  type    TEXT NOT NULL,
  PRIMARY KEY (fact_id, token, type)
);
CREATE INDEX mention_token ON mention(token);
CREATE INDEX fact_grp ON fact(grp);
CREATE INDEX fact_usage ON fact(hit_count, adopt_count, reject_count);
CREATE INDEX fact_hash_scope ON fact(hash,scope);
CREATE TABLE fact_source(fact_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL,
		  session_id TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL,
		  PRIMARY KEY(fact_id,source_kind,source_ref,session_id,cwd));
CREATE TABLE distill_progress(source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
		  source_hash TEXT NOT NULL, offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
		  provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version INTEGER NOT NULL, ts INTEGER NOT NULL,
		  PRIMARY KEY(source_id,source_version,source_hash,offset));
CREATE TABLE usage_once(fact_id TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT NOT NULL,
		  PRIMARY KEY(fact_id,kind,session_id));
CREATE TRIGGER edge_endpoint_insert BEFORE INSERT ON edge WHEN
		  NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.src) OR NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.dst)
		  BEGIN SELECT RAISE(ABORT,'Edge endpoint does not exist'); END;
CREATE TRIGGER edge_endpoint_update BEFORE UPDATE OF src,dst ON edge WHEN
		  NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.src) OR NOT EXISTS(SELECT 1 FROM fact WHERE id=NEW.dst)
		  BEGIN SELECT RAISE(ABORT,'Edge endpoint does not exist'); END;
CREATE VIRTUAL TABLE fact_fts USING fts5(title, body, tags, path);
PRAGMA user_version=4;
