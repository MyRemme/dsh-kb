/**
 * 生成 docs/hub.png：把「中枢」页渲染成静态页再截图，作为界面基线。
 *
 * 与 preview-canvas.mjs 同一套做法：**CSS 从 lib/client.js 正则提取**，星图坐标用
 * client 导出的 `__hubGalaxy` 纯函数算 —— 预览不是"照着实现重画一遍"，而是同一份
 * 样式与同一份布局函数在静态页里的结果。否则截图和真机漂移，截了也白截。
 *
 * 数据用真库（只读打开）；没有库就退化成样例。运行时依赖本机 Edge/Chrome（headless）。
 *
 *   node tools/preview-hub.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OUT_DIR = path.join(repo, "docs");
const DARK = process.argv.includes("--dark");
const OUT_HTML = path.join(OUT_DIR, DARK ? "hub-dark.html" : "hub.html");
const OUT_PNG = path.join(OUT_DIR, DARK ? "hub-dark.png" : "hub.png");

const EDGE_CANDIDATES = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

// ---- 从源码取 CSS 与中枢星图布局 ----
const source = readFileSync(path.join(repo, "lib", "client.js"), "utf8");
const cssMatch = source.match(/style\.textContent = `([\s\S]*?)`;/);
if (cssMatch === null) throw new Error("client.js 里找不到样式模板");
const CSS = cssMatch[1];

let registration;
new Function("window", "document", source)({ __ModuleLoader__: { load: (r) => { registration = r; } } }, undefined);
const client = registration.factory((spec) => {
	if (spec === "react") {
		return {
			createElement: () => null,
			Fragment: "F",
			useState: (v) => [v, () => {}],
			useEffect: () => {},
			useCallback: (f) => f,
			useMemo: (f) => f(),
			useRef: () => ({ current: null }),
		};
	}
	throw new Error(`未声明模块：${spec}`);
});

// ---- 数据：真库只读 + 样例工具清单 ----
const { buildHub } = await import(pathToFileURL(path.join(repo, "lib", "hub.js")).href);
const dshHome = process.env.DSH_HOME || path.join(homedir(), ".dsh");
const dbFile = process.env.DSH_KB_PATH || path.join(dshHome, "kb", "kb.db");
const SAMPLE_TOOLS = [
	{ name: "kb_search", description: "检索长期记忆" },
	{ name: "kb_add", description: "写入事实卡" },
	{ name: "kb_get", description: "读卡全文" },
	{ name: "kb_update", description: "修订原卡" },
	{ name: "kb_tree", description: "骨架树" },
	{ name: "kb_stats", description: "健康度" },
	{ name: "kb_ingest", description: "吸收会话" },
	{ name: "kb_distill", description: "提炼" },
	{ name: "kb_link", description: "建关系边" },
	{ name: "kb_reap", description: "动态遗忘" },
	{ name: "kb_mirror", description: "Markdown 投影" },
	{ name: "kb_usage", description: "使用反馈" },
	{ name: "web_fetch", description: "抓网页" },
	{ name: "read_image", description: "读图" },
	{ name: "ops_bash", description: "执行命令" },
	{ name: "ops_grep", description: "搜索内容" },
	{ name: "ops_glob", description: "找文件" },
	{ name: "subagent", description: "子代理" },
	{ name: "todo_write", description: "任务清单" },
	{ name: "present", description: "交付物" },
];

let hub;
if (existsSync(dbFile)) {
	const db = new DatabaseSync(dbFile, { readOnly: true });
	hub = buildHub({
		db,
		file: dbFile,
		mirrorDir: path.join(path.dirname(dbFile), "mirror"),
		sessionsDir: path.join(dshHome, "sessions"),
		frontLog: path.join(path.dirname(dbFile), "front.log"),
		tools: () => SAMPLE_TOOLS,
		version: JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version,
		dshVersion: "0.2.1-rc.2",
	});
	db.close();
	console.log("real db:", dbFile);
} else {
	console.log("no db, using sample data");
	hub = {
		ts: Date.now(),
		memory: {
			facts: 1239, active: 1231, stale: 8, sessions: 593, edges: 710, nodes: 21, mentions: 360, versions: 2,
			kinds: [
				{ kind: "episode", label: "会话", n: 428 },
				{ kind: "intent", label: "意图", n: 308 },
				{ kind: "todo", label: "待办", n: 132 },
				{ kind: "fact", label: "事实", n: 80 },
				{ kind: "fix", label: "修复", n: 76 },
				{ kind: "artifact", label: "产物", n: 69 },
			],
			paths: [
				{ path: "project/code", n: 416 },
				{ path: "topic/dsh", n: 312 },
				{ path: "topic/model", n: 158 },
				{ path: "topic/game-re", n: 87 },
				{ path: "topic/windows", n: 79 },
			],
			groups: [], rels: [],
			branches: [
				{ path: "project/code", n: 416, cards: [{ id: "f1", title: "示例卡片一", kind: "fact" }, { id: "f2", title: "示例卡片二", kind: "fix" }] },
				{ path: "topic/dsh", n: 312, cards: [{ id: "f3", title: "示例卡片三", kind: "decision" }] },
			],
			lastCardTs: Date.now(), dbBytes: 7159808, walBytes: 4120000, mirror: { dir: "mirror", files: 1205 },
		},
		sessions: {
			total: 593, ingested: 593, failed: 0, lastIngestTs: Date.now() - 21 * 3600000,
			recent: [
				{ id: "e1", title: "[会话] dsh-kb 插件安装进度查询", ts: Date.now() - 3600000, cwd: "D:\\Code" },
				{ id: "e2", title: "[会话] 本地记忆知识仓库框架", ts: Date.now() - 7200000, cwd: "D:\\Code" },
			],
			disk: { files: 612, bytes: 333535043, newest: Date.now() },
		},
		tools: { count: SAMPLE_TOOLS.length, groups: [{ prefix: "kb", items: SAMPLE_TOOLS.slice(0, 12) }, { prefix: "其他", items: SAMPLE_TOOLS.slice(12) }] },
		status: {
			version: "0.9.0", dshVersion: "0.2.1-rc.2", node: process.version, pid: 12345, uptimeSec: 5400, rssMB: 312,
			db: { file: dbFile, bytes: 7159808, walBytes: 4120000 },
			mirror: { files: 1205 },
			frontLog: { file: "front.log", total: 6, count: 0, items: [] },
			checks: [
				{ key: "db", label: "库文件", value: "6.83 MB", level: "ok" },
				{ key: "wal", label: "WAL", value: "3.93 MB", level: "ok" },
				{ key: "ingest", label: "最近吸收", value: "21 小时前", level: "ok" },
				{ key: "stale", label: "降级占比", value: "1%", level: "ok" },
				{ key: "frontlog", label: "前端错误", value: "0", level: "ok" },
				{ key: "mirror", label: "Markdown 投影", value: "1205 个文件", level: "ok" },
				{ key: "ingestErr", label: "吸收失败", value: "0", level: "ok" },
			],
			ts: Date.now(),
		},
	};
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const when = (ts) => {
	const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
	const d = new Date(ms);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const kindColor = { fact: "#3b82f6", decision: "#8b5cf6", fix: "#f59e0b", pref: "#10b981", howto: "#06b6d4", concept: "#6366f1", intent: "#94a3b8", episode: "#64748b", segment: "#a3a3a3", todo: "#ef4444", state: "#eab308", artifact: "#ec4899" };
const kindLabel = { fact: "事实", decision: "决定", fix: "修复", pref: "偏好", howto: "做法", concept: "概念", intent: "意图", episode: "会话", segment: "分段", todo: "待办", state: "进度", artifact: "产物" };
const levelColor = { ok: "#12a150", warn: "#d4a017", bad: "#e5484d" };

const memory = hub.memory;
const sessions = hub.sessions;
const tools = hub.tools;
const status = hub.status;
const galaxy = client.__hubGalaxy(hub, 360, 220);
const maxKind = Math.max(1, memory.kinds[0]?.n ?? 1);

const kpi = (n, label) => `<div class="dhub-kpi"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
const bar = (label, n) =>
	`<div class="dhub-bar-item"><span class="k" title="${esc(label)}">${esc(label)}</span><span class="track"><span class="fill" style="width:${Math.max(2, Math.round((n / maxKind) * 100))}%"></span></span><span class="n">${esc(n)}</span></div>`;

const hits = memory.paths.slice(0, 4).map((row, i) => {
	const kind = ["fact", "fix", "concept", "decision"][i % 4];
	return `<div class="dhub-row"><span class="g" style="background:${kindColor[kind]}">${kindLabel[kind].slice(0, 1)}</span><span class="t">${esc(["检索：中文双字可命中", "修复：CRLF 往返失真", "概念：骨架树与多归属", "决定：不拆插件，两条能力线"][i])}</span><span class="m">${esc(row.path)}</span></div>`;
});

const starSvg = `<svg class="dhub-star" viewBox="0 0 ${galaxy.w} ${galaxy.h}" preserveAspectRatio="xMidYMid meet">
${galaxy.edges.map((e) => `<line class="${e.faint ? "lnk faint" : "lnk"}" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}"/>`).join("")}
<circle class="core" cx="${galaxy.cx}" cy="${galaxy.cy}" r="4.2"/>
${galaxy.labels.map((l) => `<text x="${l.x}" y="${l.y}" text-anchor="${l.anchor}">${esc(l.text)} ${l.total !== undefined && l.total !== l.n ? `${l.n}/${l.total}` : l.n}</text>`).join("")}
${galaxy.stars.map((s) => `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${kindColor[s.kind] ?? "#3b82f6"}"><title>${esc(s.title)}</title></circle>`).join("")}
</svg>`;

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-kb 中枢基线</title>
<style>
${DARK ? `:root{
  --dsw-alias-bg-base:#141619; --dsw-alias-bg-layer-1:#1b1e22; --dsw-alias-bg-layer-2:#24282d;
  --dsw-alias-label-primary:#e9ecef; --dsw-alias-label-secondary:#b6bcc3; --dsw-alias-label-tertiary:#8b93a1;
  --dsw-alias-label-caption:#727a84; --dsw-alias-label-primary-foreground:#14171a;
  --dsw-alias-border-l1:#22262b; --dsw-alias-border-l2:#2b3037; --dsw-alias-border-l3:#3a4048; --dsw-alias-border-l4:#59616b;
  --dsw-alias-interactive-bg-hover:#24282d; --dsw-alias-state-business-primary:#5b9cf8;
  --dsw-alias-state-success-primary:#3fbf74; --dsw-alias-state-warn-primary:#e0b23c;
  --dsw-alias-state-error-primary:#f2686c; --dsw-alias-state-idle-primary:#737c88;
  --dsw-radius-sm:6px; --dsw-radius-md:8px; --dsw-radius-lg:12px;
}` : `:root{
  --dsw-alias-bg-base:#f7f8fa; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f1f3f5;
  --dsw-alias-label-primary:#14171a; --dsw-alias-label-secondary:#454b52; --dsw-alias-label-tertiary:#6a7178;
  --dsw-alias-label-caption:#9aa1a8; --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-border-l1:#eef0f2; --dsw-alias-border-l2:#e5e8eb; --dsw-alias-border-l3:#d6dade; --dsw-alias-border-l4:#b6bcc3;
  --dsw-alias-interactive-bg-hover:#f0f2f4; --dsw-alias-state-business-primary:#3b82f6;
  --dsw-alias-state-success-primary:#12a150; --dsw-alias-state-warn-primary:#d4a017;
  --dsw-alias-state-error-primary:#e5484d; --dsw-alias-state-idle-primary:#8b93a1;
  --dsw-radius-sm:6px; --dsw-radius-md:8px; --dsw-radius-lg:12px;
}`}
body{background:var(--dsw-alias-bg-base);}
html,body{margin:0;height:100%;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
</style><style>${CSS}</style></head><body>
<div class="dhub-root">
  <div class="dhub-bar">
    <div class="dhub-brand"><span class="dot"></span>中枢</div>
    <span class="dhub-sub">${memory.facts} 卡 · ${memory.edges} 边 · ${sessions.ingested} 条摄入 · ${tools.count} 工具</span>
    <button class="dkb-btn" style="margin-left:auto">刷新</button>
    <span class="dhub-clock">更新于 ${when(hub.ts)}</span>
  </div>
  <div class="dhub-grid">
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">◈</span><span class="t">记忆库</span><span class="x">${(memory.dbBytes / 1048576).toFixed(1)} MB · ${memory.mirror.files} 文件投影</span></header>
      <div class="dhub-card-b">
        <div class="dhub-kpis">${kpi(memory.facts, "张卡")}${kpi(memory.active, "在用")}${kpi(memory.sessions, "已吸收")}${kpi(memory.nodes, "个枝")}</div>
        <div class="dhub-bars">${memory.kinds.slice(0, 6).map((row) => bar(row.label, row.n)).join("")}</div>
        <div class="dhub-empty" style="margin:2px 0 4px">关系 ${memory.rels.map((r) => `${r.rel} ${r.n}`).join(" · ")}</div>
        <div class="dhub-rows">${memory.paths.slice(0, 5).map((row) => `<div class="dhub-row" style="cursor:default"><span class="t" title="${esc(row.path)}">${esc(row.path)}</span><span class="m">${row.total !== undefined && row.total !== row.n ? `${row.n}/${row.total}` : `${row.n} 卡`}</span></div>`).join("")}</div>
      </div>
    </section>
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">⌕</span><span class="t">检索</span><span class="x">${hits.length} 条</span></header>
      <div class="dhub-card-b">
        <input class="dhub-input" value="记忆" placeholder="查记忆：中文双字可命中，如「上下文」「zstd」">
        <div class="dhub-rows">${hits.join("")}</div>
      </div>
    </section>
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">✦</span><span class="t">星图</span><span class="x">${galaxy.labels.length} 枝 · ${galaxy.stars.length} 卡</span></header>
      <div class="dhub-card-b">${starSvg}</div>
    </section>
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">◫</span><span class="t">会话</span><span class="x">${sessions.ingested} 条摄入 · ${sessions.active ?? 0}/${sessions.total} 会话卡在用</span></header>
      <div class="dhub-card-b">
        <div class="dhub-empty" style="margin-bottom:6px">磁盘 ${sessions.disk.files} 个原始文件 · ${(sessions.disk.bytes / 1048576).toFixed(0)} MB · 最近吸收 ${sessions.lastIngestTs > 0 ? `${Math.round((hub.ts - sessions.lastIngestTs) / 3600000)} 小时前` : "从未"}</div>
        <div class="dhub-rows">${sessions.recent.slice(0, 8).map((row) => `<div class="dhub-row"><span class="g" style="background:${kindColor.episode}">话</span><span class="t">${esc(row.title)}</span><span class="m">${when(row.ts)}</span></div>`).join("")}</div>
      </div>
    </section>
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">⌘</span><span class="t">工具</span><span class="x">${tools.count} 个 · 模型可见</span></header>
      <div class="dhub-card-b">
        ${tools.groups.map((g) => `<div class="dhub-grp"><div class="gl">${esc(g.prefix)} · ${g.items.length}</div><div class="dhub-chips">${g.items.map((it) => `<span class="dhub-chip" title="${esc(it.summary)}">${esc(it.name)}</span>`).join("")}</div></div>`).join("")}
      </div>
    </section>
    <section class="dhub-card">
      <header class="dhub-card-h"><span class="ico">◉</span><span class="t">状态</span><span class="x">kb ${status.version} · dsh ${status.dshVersion}</span></header>
      <div class="dhub-card-b">
        ${status.checks.map((c) => `<div class="dhub-check"><span class="d" style="background:${levelColor[c.level]}"></span><span class="l">${esc(c.label)}</span><span class="v" title="${esc(c.value)}">${esc(c.value)}</span></div>`).join("")}
        <div class="dhub-empty" style="margin-top:8px">${status.node} · pid ${status.pid} · 已运行 ${Math.floor(status.uptimeSec / 60)} 分钟 · RSS ${status.rssMB} MB</div>
        <div class="dhub-mono" style="margin-top:6px">${esc(status.db.file)}</div>
      </div>
    </section>
  </div>
</div></body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_HTML, HTML, "utf8");
console.log("wrote", OUT_HTML);

const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (browser === undefined) {
	console.log("没找到 Edge/Chrome，跳过截图（HTML 已生成，可直接用浏览器打开）");
	process.exit(0);
}
execFileSync(
	browser,
	["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1600,940", `--screenshot=${OUT_PNG}`, `file:///${OUT_HTML.replace(/\\/g, "/")}`],
	{ stdio: "ignore" },
);
console.log("wrote", OUT_PNG);
