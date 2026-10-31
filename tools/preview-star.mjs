/**
 * 生成 docs/canvas-star.png：星图视图的静态基线。
 *
 * 与 preview-canvas.mjs 同一套路（真库数据 + 从 lib/client.js 提取的 CSS + headless 截图），
 * 只是布局换成 buildGalaxy（径向树 + 星体散布）。
 *
 *   node tools/preview-star.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const OUT_DIR = path.join(repo, "docs");
const OUT_HTML = path.join(OUT_DIR, "canvas-star.html");
const OUT_PNG = path.join(OUT_DIR, "canvas-star.png");
const EDGE_CANDIDATES = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

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
		return { createElement: () => null, Fragment: "F", Component: class {}, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) };
	}
	throw new Error(`未声明模块：${spec}`);
});
if (typeof client.__galaxy !== "function") {
	throw new Error("client.js 没有导出 __galaxy —— 星图布局还没挂到 exports 上");
}

const dbFile = process.env.DSH_KB_PATH || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? "", ".dsh"), "kb", "kb.db");
if (!existsSync(dbFile)) throw new Error(`没有库：${dbFile}（这个脚本只对真库出图）`);
const { openDb } = await import(pathToFileURL(path.join(repo, "lib", "store.js")).href);
const { treeRows } = await import(pathToFileURL(path.join(repo, "lib", "digest.js")).href);
const { db } = openDb(dbFile);
const tree = treeRows(db, "").map((row) => ({ path: row.path, depth: row.depth, count: row.count }));
const facts = db
	.prepare("SELECT id,title,kind,path,ts,tags FROM fact WHERE status='active' ORDER BY ts DESC LIMIT 320")
	.all()
	.map((row) => ({ id: row.id, title: row.title, kind: row.kind, path: row.path, ts: Number(row.ts), tags: JSON.parse(row.tags ?? "[]").slice(0, 3) }));
const edges = db.prepare("SELECT src,dst,rel FROM edge LIMIT 400").all();
db.close();

const SIZE = 720;
const layout = client.__galaxy({ tree, facts, edges, size: SIZE });
console.log("hubs:", layout.hubs.length, "stars:", layout.stars.length, "links:", layout.links.length);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const lines = layout.links
	.map((l) => {
		const stroke = l.kind === "tree" ? "#6a7178" : l.kind === "spine" ? "#d6dade" : "#9dbaf5";
		const w = l.kind === "tree" ? 1 : l.kind === "spine" ? 0.8 : 1.2;
		const op = l.kind === "tree" ? 0.75 : l.kind === "spine" ? 0.5 : 0.9;
		return `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}"/>`;
	})
	.join("");
const hubNodes = layout.hubs
	.map(
		(hub) =>
			`<circle cx="${hub.x.toFixed(1)}" cy="${hub.y.toFixed(1)}" r="3.2" fill="#f7f8fa" stroke="#6a7178" stroke-width="1"/>` +
			`<text class="dkb-hublabel" x="${(hub.x + (Math.cos(hub.angle) >= 0 ? 7 : -7)).toFixed(1)}" y="${(hub.y + 3).toFixed(1)}" text-anchor="${Math.cos(hub.angle) >= 0 ? "start" : "end"}">${esc(hub.label)}${hub.count ? ` ${hub.count}` : ""}</text>`,
	)
	.join("");
const starNodes = layout.stars
	.map(
		(star) =>
			`<circle cx="${star.x.toFixed(1)}" cy="${star.y.toFixed(1)}" r="${star.r.toFixed(2)}" fill="${star.color}" fill-opacity="0.85"><title>${esc(star.title)}</title></circle>`,
	)
	.join("");

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-kb 星图基线</title>
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
    <button class="dkb-btn">图谱</button><button class="dkb-btn">列表</button>
    <button class="dkb-btn">直接提取</button><button class="dkb-btn" data-active="0">模型提炼</button><button class="dkb-btn">新建</button>
    <span class="dkb-stat">${facts.length} 卡 · ${edges.length} 边</span></div>
  <div class="dkb-chipbar">
    <button class="dkb-chip" data-active="1">全部</button><button class="dkb-chip">记忆</button>
    <button class="dkb-chip">文档</button><button class="dkb-chip">对话</button>
    <button class="dkb-chip">项目</button><button class="dkb-chip">任务</button></div>
  <div class="dkb-stage">
    <div class="dkb-vp">
      <svg class="dkb-star-svg" viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="xMidYMid meet">
        <g>${lines}${hubNodes}${starNodes}</g>
      </svg>
      <div class="dkb-toolbar">
        <button class="dkb-btn" data-active="0">卡片</button><button class="dkb-btn" data-active="1">星图</button><button class="dkb-btn" data-active="0">骨架</button>
        <div class="dkb-zoombox"><button class="dkb-btn">−</button><span class="v">100%</span><button class="dkb-btn">+</button></div>
        <button class="dkb-btn">适应</button></div>
      <div class="dkb-hint">${layout.hubs.length} 个枝 · ${layout.stars.length} 颗星 · 滚轮缩放 · 拖动平移</div>
    </div>
  </div>
</div></body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_HTML, HTML, "utf8");
console.log("wrote", OUT_HTML);

const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (browser === undefined) {
	console.log("没找到 Edge/Chrome，HTML 已生成，可直接用浏览器打开");
	process.exit(0);
}
execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1400,820", `--screenshot=${OUT_PNG}`, `file:///${OUT_HTML.replace(/\\/g, "/")}`], { stdio: "ignore" });
console.log("wrote", OUT_PNG);
