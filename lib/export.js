/**
 * 静态导出：把库摊成一个自包含的 HTML，双击就能看。
 *
 * 为什么除了面板还要这个：
 *   1. 面板要重启 dsh 才生效，这个不用；
 *   2. 想发给别人看、或者留个快照对比"一个月前库里是什么样"，静态页面更合适；
 *   3. 面板加载失败时它是唯一能确认"数据本身是对的"的通道。
 *
 * 数据全量内嵌（683 张卡约 350 KB），搜索在前端做，不依赖任何服务。
 */

import { writeFileSync } from "node:fs";
import { treeRows } from "./digest.js";

/**
 * 从库里取一份完整快照。
 * @param {import('node:sqlite').DatabaseSync} db - 已打开的库。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.bodyLimit] - 单卡正文截断长度。
 * @returns {object} 快照对象。
 */
export function snapshot(db, opts = {}) {
	const bodyLimit = opts.bodyLimit ?? 4000;
	const rows = db
		.prepare(
			"SELECT id,kind,status,path,paths,tags,title,body,ts,confidence,source_kind,source_ref FROM fact ORDER BY ts DESC",
		)
		.all();
	const cards = rows.map((r) => ({
		id: r.id,
		kind: r.kind,
		status: r.status,
		path: r.path,
		paths: safeArray(r.paths),
		tags: safeArray(r.tags),
		title: r.title,
		body: String(r.body ?? "").length > bodyLimit ? `${String(r.body).slice(0, bodyLimit)}…` : r.body,
		ts: r.ts,
		confidence: r.confidence,
		sourceKind: r.source_kind,
		sourceRef: r.source_ref,
	}));
	const ids = new Set(cards.map((c) => c.id));
	const edges = db
		.prepare("SELECT src,dst,rel FROM edge")
		.all()
		.filter((e) => ids.has(e.src) && ids.has(e.dst));

	const one = (sql) => db.prepare(sql).get().n;
	return {
		generatedAt: new Date().toISOString(),
		stats: {
			facts: one("SELECT COUNT(*) AS n FROM fact"),
			active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'"),
			sessions: one("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''"),
			edges: one("SELECT COUNT(*) AS n FROM edge"),
			nodes: one("SELECT COUNT(*) AS n FROM node"),
		},
		nodes: treeRows(db, ""),
		cards,
		edges,
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

const PAGE = (data) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-kb · ${data.stats.facts} 张卡</title>
<style>
:root { color-scheme: light dark; --fg:#1b1f26; --bg:#fbfbfd; --line:#e3e6ec; --hi:#2f6fed; --soft:#f2f4f8; --mute:#6b7280; }
@media (prefers-color-scheme: dark) { :root { --fg:#d7dbe3; --bg:#14161a; --line:#2a2f38; --hi:#6ea8ff; --soft:#1c1f26; --mute:#8b93a3; } }
* { box-sizing:border-box; }
body { margin:0; font:13px/1.55 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); height:100vh; display:flex; flex-direction:column; }
header { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); flex:0 0 auto; }
input { flex:1 1 auto; padding:6px 10px; border-radius:7px; border:1px solid var(--line); background:var(--soft); color:inherit; font:inherit; outline:none; }
input:focus { border-color:var(--hi); }
.tabs { display:flex; gap:2px; padding:2px; border-radius:8px; background:var(--soft); }
.tab { padding:4px 12px; border-radius:6px; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; opacity:.62; }
.tab[data-on="1"] { background:var(--line); opacity:1; }
.status { padding:4px 14px; font-size:11px; color:var(--mute); border-bottom:1px solid var(--line); }
main { flex:1 1 auto; display:flex; min-height:0; }
aside { width:236px; overflow:auto; border-right:1px solid var(--line); padding:8px 0; flex:0 0 auto; }
.row { display:flex; gap:6px; align-items:center; padding:3px 10px; margin:0 6px; border-radius:6px; cursor:pointer; white-space:nowrap; overflow:hidden; }
.row:hover { background:var(--soft); }
.row[data-on="1"] { background:color-mix(in srgb, var(--hi) 18%, transparent); }
.cnt { margin-left:auto; font-size:11px; color:var(--mute); font-variant-numeric:tabular-nums; }
#list { flex:1 1 auto; overflow:auto; min-width:0; }
.item { padding:9px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
.item:hover { background:var(--soft); }
.item[data-on="1"] { background:color-mix(in srgb, var(--hi) 12%, transparent); }
.t { font-weight:600; }
.s { margin-top:3px; font-size:11.5px; color:var(--mute); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.chip { padding:1px 6px; border-radius:4px; background:var(--soft); border:1px solid var(--line); font-size:10.5px; }
.chip[data-k="decision"] { border-color:#b06bff; color:#b06bff; }
.chip[data-k="fix"] { border-color:#e07b2e; color:#e07b2e; }
.chip[data-k="intent"] { border-color:#2f6fed; color:#2f6fed; }
.chip[data-k="episode"] { border-color:#2e9e5b; color:#2e9e5b; }
#detail { width:410px; flex:0 0 auto; overflow:auto; padding:14px; border-left:1px solid var(--line); }
#detail h3 { margin:0 0 8px; font-size:14px; }
.meta { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; font-size:11px; color:var(--mute); align-items:center; }
pre { white-space:pre-wrap; word-break:break-word; font:inherit; font-size:12.5px; line-height:1.65; margin:0; }
.empty { padding:30px 16px; text-align:center; color:var(--mute); }
#graph { flex:1 1 auto; position:relative; min-width:0; }
canvas { display:block; width:100%; height:100%; }
.hint { position:absolute; left:12px; bottom:10px; font-size:11px; color:var(--mute); pointer-events:none; }
</style>
</head>
<body>
<header>
  <input id="q" placeholder="搜记忆…（中文或英文，可混合）" spellcheck="false" autofocus>
  <div class="tabs">
    <button class="tab" data-v="browse" data-on="1" id="tabBrowse">浏览</button>
    <button class="tab" data-v="graph" id="tabGraph">图谱</button>
  </div>
</header>
<div class="status" id="status"></div>
<main id="main">
  <aside id="tree"></aside>
  <div id="list"></div>
  <div id="detail"><div class="empty">选一张卡看详情</div></div>
</main>
<div id="graph" hidden><canvas id="cv"></canvas><div class="hint" id="ghint"></div></div>
<script id="kb-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById("kb-data").textContent);
  const q = document.getElementById("q");
  const treeEl = document.getElementById("tree");
  const listEl = document.getElementById("list");
  const detailEl = document.getElementById("detail");
  const statusEl = document.getElementById("status");
  const mainEl = document.getElementById("main");
  const graphEl = document.getElementById("graph");
  const cv = document.getElementById("cv");
  const ghint = document.getElementById("ghint");
  let path = "";
  let selected = null;
  let view = "browse";
  let raf = 0;

  statusEl.textContent = D.stats.facts + " 张卡 · " + D.stats.active + " 有效 · " + D.stats.sessions + " 个已吸收会话 · " + D.stats.edges + " 条边 · 生成于 " + D.generatedAt.slice(0, 16).replace("T", " ");

  // 前端检索：bigram 近似 —— 中文按 2 字窗口做包含匹配，英文小写整体匹配
  function terms(s) {
    const out = [];
    const re = /[a-z][a-z0-9_.+#/\\-]{1,}|[\\u4e00-\\u9fff\\u3040-\\u30ff]{2,}/g;
    let m;
    while ((m = re.exec(s.toLowerCase()))) {
      const t = m[0];
      out.push(t);
      if (!/^[a-z]/.test(t) && t.length > 3) for (let i = 0; i < t.length - 1; i += 2) out.push(t.slice(i, i + 2));
    }
    return [...new Set(out)];
  }

  function score(card, list) {
    if (!list.length) return 1;
    const hay = (card.title + " " + card.body).toLowerCase();
    let hit = 0;
    for (const t of list) if (hay.includes(t)) hit++;
    return hit / list.length;
  }

  function current() {
    const list = terms(q.value);
    let items = D.cards.filter((c) => !path || c.path === path || (c.paths || []).includes(path));
    if (list.length) {
      items = items
        .map((c) => ({ c, s: score(c, list) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => Object.assign({}, x.c, { _s: x.s }));
    }
    return items;
  }

  function renderTree() {
    treeEl.innerHTML = "";
    const all = document.createElement("div");
    all.className = "row"; all.dataset.on = path === "" ? "1" : "0";
    all.innerHTML = "<span>全部</span><span class='cnt'>" + D.cards.length + "</span>";
    all.onclick = () => { path = ""; selected = null; render(); };
    treeEl.appendChild(all);
    for (const n of D.nodes) {
      if (!n.count && n.depth > 0) continue;
      const d = document.createElement("div");
      d.className = "row"; d.dataset.on = path === n.path ? "1" : "0";
      d.style.paddingLeft = (10 + n.depth * 13) + "px";
      d.title = n.summary || n.path;
      d.innerHTML = "<span>" + n.path.split("/").pop() + "</span>" + (n.count ? "<span class='cnt'>" + n.count + "</span>" : "");
      d.onclick = () => { path = n.path; selected = null; render(); };
      treeEl.appendChild(d);
    }
  }

  function renderList() {
    const items = current();
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = "<div class='empty'>" + (q.value.trim() ? "没有命中。换同义词或英文再试。" : "这个枝下还没有卡。") + "</div>";
      return;
    }
    for (const c of items) {
      const d = document.createElement("div");
      d.className = "item"; d.dataset.on = selected && selected.id === c.id ? "1" : "0";
      const when = new Date(c.ts > 1e11 ? c.ts : c.ts * 1000).toISOString().slice(0, 10);
      d.innerHTML = "<div class='t'></div><div class='s'><span class='chip' data-k='" + c.kind + "'>" + c.kind + "</span><span>" + (c.path || "inbox") + "</span><span>" + when + "</span>" + (c.status !== "active" ? "<span class='chip'>" + c.status + "</span>" : "") + (c._s !== undefined ? "<span>匹配 " + Math.round(c._s * 100) + "%</span>" : "") + "</div>";
      d.querySelector(".t").textContent = c.title;
      d.onclick = () => { selected = c; renderList(); renderDetail(); };
      listEl.appendChild(d);
    }
  }

  function renderDetail() {
    if (!selected) { detailEl.innerHTML = "<div class='empty'>选一张卡看详情</div>"; return; }
    const c = selected;
    const when = new Date(c.ts > 1e11 ? c.ts : c.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    detailEl.innerHTML = "";
    const h3 = document.createElement("h3"); h3.textContent = c.title; detailEl.appendChild(h3);
    const meta = document.createElement("div"); meta.className = "meta";
    meta.innerHTML = "<span class='chip' data-k='" + c.kind + "'>" + c.kind + "</span><span>" + (c.path || "inbox") + "</span><span>" + when + "</span><span>置信 " + Number(c.confidence).toFixed(2) + "</span>" + (c.tags || []).slice(0, 6).map((t) => "<span class='chip'>" + t + "</span>").join("");
    detailEl.appendChild(meta);
    const pre = document.createElement("pre"); pre.textContent = c.body || "(空)"; detailEl.appendChild(pre);
    const foot = document.createElement("div"); foot.className = "meta"; foot.style.marginTop = "12px";
    foot.innerHTML = "<span class='chip'>" + c.id + "</span>" + (c.sourceRef ? "<span>" + c.sourceRef + "</span>" : "");
    detailEl.appendChild(foot);
  }

  function render() {
    renderTree();
    renderList();
    renderDetail();
    if (view === "graph") drawGraph();
  }

  q.oninput = () => { renderList(); };

  document.getElementById("tabBrowse").onclick = () => switchView("browse");
  document.getElementById("tabGraph").onclick = () => switchView("graph");

  function switchView(v) {
    view = v;
    document.getElementById("tabBrowse").dataset.on = v === "browse" ? "1" : "0";
    document.getElementById("tabGraph").dataset.on = v === "graph" ? "1" : "0";
    mainEl.hidden = v !== "browse";
    graphEl.hidden = v !== "graph";
    if (v === "graph") drawGraph();
  }

  // ---------------------------------------------------------------- 图谱

  function drawGraph() {
    cancelAnimationFrame(raf);
    const dpr = window.devicePixelRatio || 1;
    const box = graphEl.getBoundingClientRect();
    cv.width = Math.max(1, box.width * dpr);
    cv.height = Math.max(1, box.height * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = box.width, H = box.height;

    const pool = D.cards.filter((c) => !path || c.path === path || (c.paths || []).includes(path)).slice(0, 240);
    const idx = new Map(pool.map((c, i) => [c.id, i]));
    const nodes = pool.map((c, i) => ({
      id: c.id, kind: c.kind, status: c.status,
      x: W / 2 + Math.cos((i / Math.max(1, pool.length)) * Math.PI * 2) * W * 0.3,
      y: H / 2 + Math.sin((i / Math.max(1, pool.length)) * Math.PI * 2) * H * 0.3,
      vx: 0, vy: 0,
    }));
    const links = D.edges.filter((e) => idx.has(e.src) && idx.has(e.dst))
      .map((e) => ({ a: nodes[idx.get(e.src)], b: nodes[idx.get(e.dst)] }));

    const color = (k) => ({ decision: "#b06bff", fix: "#e07b2e", intent: "#2f6fed", episode: "#2e9e5b", concept: "#00a0a6" })[k] || "#8b93a3";
    ghint.textContent = nodes.length + " 个节点 · " + links.length + " 条边 · 配色=卡类型 · 边=包含/取代关系";

    function tick() {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2), f = 900 / d2;
          a.vx += dx / d * f; a.vy += dy / d * f;
          b.vx -= dx / d * f; b.vy -= dy / d * f;
        }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 54) * 0.0016;
        l.a.vx += dx / d * f; l.a.vy += dy / d * f;
        l.b.vx -= dx / d * f; l.b.vy -= dy / d * f;
      }
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0009; n.vy += (H / 2 - n.y) * 0.0009;
        n.vx *= 0.72; n.vy *= 0.72;
        n.x = Math.max(12, Math.min(W - 12, n.x + n.vx));
        n.y = Math.max(12, Math.min(H - 12, n.y + n.vy));
      }
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(140,150,170,0.22)"; ctx.lineWidth = 1;
      for (const l of links) { ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke(); }
      for (const n of nodes) {
        ctx.beginPath(); ctx.arc(n.x, n.y, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = color(n.kind); ctx.globalAlpha = n.status === "active" ? 0.95 : 0.28; ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    }
    tick();
  }

  window.addEventListener("resize", () => { if (view === "graph") drawGraph(); });
  render();
})();
</script>
</body>
</html>
`;

/**
 * 生成静态页面并写盘。
 * @param {import('node:sqlite').DatabaseSync} db - 已打开的库。
 * @param {string} file - 输出路径。
 * @param {object} [opts] - 透传给 snapshot。
 * @returns {{file: string, bytes: number, cards: number}} 写盘结果。
 */
export function exportHtml(db, file, opts) {
	const data = snapshot(db, opts);
	const html = PAGE(data);
	writeFileSync(file, html, "utf8");
	return { file, bytes: Buffer.byteLength(html), cards: data.cards.length };
}
