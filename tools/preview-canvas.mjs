/**
 * 生成 docs/canvas.png：把画布渲染成静态页再截图，作为界面基线。
 *
 * 用途是"看得见的回归"—— 改 client.js 之后跑一遍，图变了就是视觉变了。
 * CSS 从 lib/client.js 里正则提取，不复制一份，避免预览与实现漂移。
 * 运行时依赖本机 Edge（headless）。
 *
 *   node tools/preview-canvas.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OUT_DIR = path.join(repo, "docs");
const OUT_HTML = path.join(OUT_DIR, "canvas.html");
const OUT_PNG = path.join(OUT_DIR, "canvas.png");

const EDGE_CANDIDATES = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

// ---- 从源码取 CSS 与布局函数 ----
const source = readFileSync(path.join(repo, "lib", "client.js"), "utf8");
const cssMatch = source.match(/style\.textContent = `([\s\S]*?)`;/);
if (cssMatch === null) throw new Error("client.js 里找不到样式模板");
const CSS = cssMatch[1];

let registration;
new Function("window", "document", source)(
	{ __ModuleLoader__: { load: (r) => { registration = r; } } },
	undefined,
);
const client = registration.factory((spec) => {
	if (spec === "react") {
		return { createElement: () => null, Fragment: "F", useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) };
	}
	throw new Error(`未声明模块：${spec}`);
});

// ---- 真库数据；没有库就用一份样例，保证脚本离线可跑 ----
let tree = [];
let groupCounts = {};
let facts = [];
let edges = [];
const dbFile = process.env.DSH_KB_PATH || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? "", ".dsh"), "kb", "kb.db");
if (existsSync(dbFile)) {
	const { openDb } = await import(pathToFileURL(path.join(repo, "lib", "store.js")).href);
	const { treeRows } = await import(pathToFileURL(path.join(repo, "lib", "digest.js")).href);
	const { db } = openDb(dbFile);
	tree = treeRows(db, "").map((row) => ({ path: row.path, depth: row.depth, count: row.count }));
	facts = db
		.prepare("SELECT id,title,kind,path,ts,tags,confidence FROM fact WHERE status='active' ORDER BY ts DESC LIMIT 400")
		.all()
		.map((row) => ({ id: row.id, title: row.title, kind: row.kind, path: row.path, ts: Number(row.ts), tags: JSON.parse(row.tags ?? "[]").slice(0, 3), confidence: Number(row.confidence ?? 0.6) }));
	edges = db.prepare("SELECT src,dst,rel FROM edge LIMIT 400").all();
	groupCounts = Object.fromEntries(db.prepare("SELECT grp, COUNT(*) AS n FROM fact GROUP BY grp").all().map((r) => [r.grp, r.n]));
	db.close();
	console.log("real db:", dbFile);
} else {
	console.log("no db, using sample data");
	tree = [
		{ path: "topic", depth: 0, count: 0 },
		{ path: "topic/dsh", depth: 1, count: 4 },
		{ path: "topic/model", depth: 1, count: 2 },
		{ path: "project/code", depth: 1, count: 2 },
	];
	facts = Array.from({ length: 8 }, (_, i) => ({
		id: `f_${String(i).padStart(14, "0")}`,
		title: ["卡片标题示例：一条结论", "现象 / 根因 / 做法 / 边界", "决策：不拆插件", "修复：CRLF 往返失真", "概念：骨架树", "流程：发布三步", "成果：镜像目录", "会话沉淀"][i],
		kind: ["fact", "fix", "decision", "fix", "concept", "howto", "artifact", "episode"][i],
		path: i < 4 ? "topic/dsh" : i < 6 ? "topic/model" : "project/code",
		ts: Date.now() - i * 86400000,
		tags: [["dsh-kb"], ["sqlite"], ["架构"], ["markdown"], [], [], ["mirror"], ["session"]][i],
		confidence: 0.6,
	}));
	edges = [{ src: "f_00000000000000", dst: "f_00000000000002", rel: "related" }];
}

const layout = client.__layout({ tree, facts, edges });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const when = (ts) => {
	const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const KIND_COLOR = { fact: "#3b82f6", decision: "#8b5cf6", fix: "#f59e0b", pref: "#10b981", howto: "#06b6d4", concept: "#6366f1", intent: "#94a3b8", episode: "#64748b", segment: "#a3a3a3", todo: "#ef4444", state: "#eab308", artifact: "#ec4899" };
const KIND_LABEL = { fact: "事实", decision: "决策", fix: "修复", pref: "偏好", howto: "流程", concept: "概念", intent: "意图", episode: "会话", segment: "分段", todo: "待办", state: "进度", artifact: "产物" };
const GLYPH = { memory: "记", doc: "文", talk: "话", project: "项", task: "务" };
const GROUPS = [
	{ id: "all", label: "全部", test: () => true },
	{ id: "memory", label: "记忆", test: (k) => ["fact", "decision", "concept", "fix", "pref", "howto"].includes(k) },
	{ id: "doc", label: "文档", test: (k) => k === "artifact" },
	{ id: "talk", label: "对话", test: (k) => k === "episode" || k === "intent" },
	{ id: "project", label: "项目", test: (k, p) => String(p ?? "").startsWith("project/") },
	{ id: "task", label: "任务", test: (k) => k === "todo" || k === "state" },
];
const groupOf = (fact) => GROUPS.find((g) => g.id !== "all" && g.test(fact.kind, fact.path))?.id ?? "memory";

// 优先用库里的全量分布；没有库（样例数据）时才按画布上的卡数算
const counts = Object.keys(groupCounts).length > 0 ? groupCounts : {};
if (Object.keys(counts).length === 0) for (const fact of facts) counts[groupOf(fact)] = (counts[groupOf(fact)] ?? 0) + 1;

const edgeSvg = layout.links
	.map((link) => {
		const out = link.x2 >= link.x1 ? 1 : -1;
		const bend = Math.max(36, Math.abs(link.x2 - link.x1) / 2.4);
		return `<path class="dkb-edge" data-rel="related" d="M${link.x1},${link.y1} C${link.x1 + out * bend},${link.y1} ${link.x2 - out * bend},${link.y2} ${link.x2},${link.y2}"/>`;
	})
	.join("");
const tagSvg = layout.links
	.filter((link) => link.tagged === true && link.label !== undefined)
	.map((link) => {
		const w = String(link.label).length * 11 + 14;
		return `<g><rect class="dkb-ecap" x="${link.mx - w / 2}" y="${link.my - 8}" width="${w}" height="16" rx="8"/><text class="dkb-elabel" x="${link.mx}" y="${link.my + 3.5}" text-anchor="middle">${esc(link.label)}</text></g>`;
	})
	.join("");
const blocks = layout.hubs
	.map(
		(hub) =>
			`<div class="dkb-block" style="left:${hub.x}px;top:${hub.y}px;width:${hub.w}px;height:${hub.h}px"></div>
<div class="dkb-blocklabel" style="left:${hub.x + 14}px;top:${hub.y + 4}px">${esc(hub.path === "" ? "inbox" : hub.path)} · ${hub.shown < hub.count ? `${hub.shown}/${hub.count}` : hub.count}</div>`,
	)
	.join("");
const cards = layout.stars
	.map((star) => {
		const tags = star.tags.length === 0 ? "" : `<div class="chips">${star.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;
		return `<div class="dkb-card" data-active="${star.id === layout.stars[0]?.id ? "1" : "0"}" style="left:${star.x}px;top:${star.y}px;width:${star.w}px;height:${star.h}px">
<div class="ico" style="background:${star.color}">${GLYPH[star.group] ?? "·"}</div>
<div class="main"><div class="k">${esc(KIND_LABEL[star.kind] ?? star.kind)} · ${when(star.ts)}</div><div class="t">${esc(star.title)}</div>${tags}</div></div>`;
	})
	.join("");
const first = layout.stars[0];
const firstFact = first === undefined ? null : facts.find((f) => f.id === first.id);
const chipbar = GROUPS.map((g) => `<button class="dkb-chip" data-active="${g.id === "all" ? "1" : "0"}">${g.label}${g.id === "all" ? "" : ` ${counts[g.id] ?? 0}`}</button>`).join("");
const tl = [...facts]
	.sort((a, b) => b.ts - a.ts)
	.slice(0, 12)
	.map((item) => `<div class="dkb-tlcard"><div class="h"><span>${when(item.ts)}</span><span>·</span><span>${esc(KIND_LABEL[item.kind] ?? item.kind)}</span></div><div class="b"><div class="ri" style="background:${KIND_COLOR[item.kind] ?? "#3b82f6"}">${GLYPH[groupOf(item)]}</div><div class="t">${esc(item.title)}</div></div></div>`)
	.join("");

const VW = 1600 - 400 - 2;
const VH = 940 - 56 - 40 - 150;
const FIT = Math.min(VW / layout.width, VH / layout.height, 1.4);
const TX = Math.max(8, (VW - layout.width * FIT) / 2);
const TY = Math.max(8, (VH - layout.height * FIT) / 2);

const drawer =
	first === undefined
		? `<div class="dkb-drawer" data-open="0"></div>`
		: `<div class="dkb-drawer" data-open="1">
  <div class="dkb-dhead"><div class="ico" style="background:${first.color}">${GLYPH[first.group]}</div>
    <div class="ht"><div class="h1">${esc(first.title)}</div><div class="h2">${esc(KIND_LABEL[first.kind] ?? first.kind)} · ${esc(first.path || "inbox")}</div></div>
    <button class="dkb-btn">✕</button></div>
  <div class="dkb-dbody">
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${(firstFact?.tags ?? []).map((t) => `<span class="dkb-tag">${esc(t)}</span>`).join("")}<span class="dkb-tag" style="opacity:.55">+ 标签</span></div>
    <div class="dkb-sec">内容摘要</div><div class="dkb-body">${esc(String(first.title).slice(0, 60))}……（正文略）</div>
    <div class="dkb-sec">相关节点 ${layout.links.length}</div>
    ${layout.links.slice(0, 4).map((l) => `<div class="dkb-relrow"><div class="ri" style="background:${first.color}">${GLYPH[first.group]}</div><div class="rt">${esc(l.label ?? "关联")}</div><div class="rk">${esc(l.label ?? "关联")} ›</div></div>`).join("")}
    <div class="dkb-sec">属性</div>
    <div class="dkb-kv"><span class="k">最后更新</span><span class="v">${when(first.ts)}</span></div>
    <div class="dkb-kv"><span class="k">置信 / 版本</span><span class="v">${Number(firstFact?.confidence ?? 0.6).toFixed(2)} · v1</span></div>
  </div>
  <div class="dkb-dfoot"><button class="dkb-btn dkb-primary" style="flex:1 1 auto">标为失效</button><button class="dkb-btn">刷新</button></div>
</div>`;

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-kb 画布基线</title>
<style>
:root{
  --dsw-alias-bg-base:#f7f8fa; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f1f3f5;
  --dsw-alias-label-primary:#14171a; --dsw-alias-label-secondary:#454b52; --dsw-alias-label-tertiary:#6a7178;
  --dsw-alias-label-caption:#9aa1a8; --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-border-l1:#eef0f2; --dsw-alias-border-l2:#e5e8eb; --dsw-alias-border-l3:#d6dade; --dsw-alias-border-l4:#b6bcc3;
  --dsw-alias-interactive-bg-hover:#f0f2f4; --dsw-alias-state-business-primary:#3b82f6;
  --dsw-alias-state-business-tertiary:#9dbaf5; --dsw-alias-state-error-primary:#e5484d; --dsw-alias-button-primary-fill:#3b82f6;
  --dsw-radius-sm:6px; --dsw-radius-md:8px; --dsw-radius-lg:12px;
}
html,body{margin:0;height:100%;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
</style><style>${CSS}</style></head><body>
<div class="dkb-root">
  <div class="dkb-bar"><input class="dkb-search" placeholder="搜索记忆节点、对话、文档或标签…" value="">
    <button class="dkb-btn" data-active="1">图谱</button><button class="dkb-btn">列表</button>
    <button class="dkb-btn">直接提取</button><button class="dkb-btn">模型提炼</button><button class="dkb-btn">新建</button>
    <span class="dkb-stat">${facts.length} 卡 · ${edges.length} 边</span></div>
  <div class="dkb-chipbar">${chipbar}</div>
  <div class="dkb-stage">
    <div class="dkb-vp">
      <div class="dkb-world" style="transform:translate(${TX}px,${TY}px) scale(${FIT});width:${layout.width}px;height:${layout.height}px">
        ${blocks}
        <svg class="dkb-edges" width="${layout.width}" height="${layout.height}">${edgeSvg}${tagSvg}</svg>
        ${cards}
      </div>
      <div class="dkb-toolbar"><button class="dkb-btn" data-active="1">卡片</button><button class="dkb-btn">骨架</button>
        <div class="dkb-zoombox"><button class="dkb-btn">−</button><span class="v">${Math.round(FIT * 100)}%</span><button class="dkb-btn">+</button></div>
        <button class="dkb-btn">适应</button><button class="dkb-btn">全屏</button></div>
      <div class="dkb-hint">${layout.hubs.length} 个枝 · ${layout.stars.length} 张卡 · 滚轮缩放 · 拖动平移</div>
    </div>
    ${drawer}
  </div>
  <div class="dkb-timeline"><div class="dkb-tlhead"><button class="dkb-chip" data-active="1">时间线</button><button class="dkb-chip">相关对话</button><button class="dkb-chip">相关文档</button><button class="dkb-chip">相关任务</button></div>
    <div class="dkb-tlbody">${tl}</div></div>
</div></body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_HTML, HTML, "utf8");
console.log("wrote", OUT_HTML);

const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (browser === undefined) {
	console.log("没找到 Edge/Chrome，跳过截图（HTML 已生成，可直接用浏览器打开）");
	process.exit(0);
}
execFileSync(browser, [
	"--headless=new",
	"--disable-gpu",
	"--hide-scrollbars",
	"--force-device-scale-factor=1",
	"--window-size=1600,940",
	`--screenshot=${OUT_PNG}`,
	`file:///${OUT_HTML.replace(/\\/g, "/")}`,
], { stdio: "ignore" });
console.log("wrote", OUT_PNG);
