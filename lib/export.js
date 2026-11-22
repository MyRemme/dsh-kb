/**
 * 静态导出：把整个库压成**一个自包含 HTML 文件**。
 *
 * 为什么还要这东西（面板已经有了）：面板要宿主重启才生效，而静态页双击就能看；
 * 它还能当快照 —— 两次导出 diff 一下，就知道这一周记忆长在哪个枝上。
 *
 * 约束：单文件、零外部请求、内联脚本不用 `import`。数据走
 * `<script type="application/json">`，靠 `JSON.parse(textContent)` 读，
 * 顺手把 `<` 转义成 `\u003c`，免得正文里的 `</script>` 提前闭合标签。
 *
 * @module dsh-kb/export
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dshHome } from "./store.js";
import { treeRows } from "./digest.js";

/** 默认导出行数上限。够覆盖本机规模，又不至于把 HTML 撑到几十 MB。 */
const DEFAULT_LIMIT = 5000;

/**
 * 默认导出路径：`$DSH_HOME/kb/preview.html`。
 * @returns {string} 绝对路径。
 */
export function defaultExportPath() {
	return path.join(dshHome(), "kb", "preview.html");
}

/**
 * 收集要嵌入的数据。
 * @param {object} db - 已打开的库。
 * @param {number} limit - 卡数上限。
 * @returns {{facts: object[], tree: object[], edges: object[]}} 快照。
 */
export function snapshot(db, limit = DEFAULT_LIMIT) {
	const facts = db
		.prepare("SELECT * FROM fact ORDER BY ts DESC LIMIT ?")
		.all(limit)
		.map((row) => ({
			id: row.id,
			title: row.title,
			body: row.body,
			kind: row.kind,
			status: row.status,
			path: row.path,
			paths: safeJson(row.paths),
			tags: safeJson(row.tags),
			confidence: Number(row.confidence),
			ts: Number(row.ts),
			sourceKind: row.source_kind,
			sessionId: row.session_id,
		}));
	const tree = treeRows(db, "").map((r) => ({ path: r.path, depth: r.depth, count: r.count, summary: r.summary }));
	const ids = new Set(facts.map((f) => f.id));
	const edges = db
		.prepare("SELECT src, dst, rel, w FROM edge")
		.all()
		.filter((e) => ids.has(e.src) && ids.has(e.dst));
	return { facts, tree, edges };
}

/** 解析 JSON 列，坏数据返回空数组而不是抛错（导出不能因为一行的脏数据整体失败）。 */
function safeJson(value) {
	try {
		const parsed = JSON.parse(value ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 把 JSON 转成可安全内联进 `<script>` 的文本。
 * @param {unknown} value - 任意可序列化值。
 * @returns {string} 转义后的 JSON。
 */
function inlineJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * 生成整页 HTML。
 * @param {{facts: object[], tree: object[], edges: object[], generatedAt?: number}} data - 快照。
 * @param {object} [meta] - 头部文案用的元信息。
 * @returns {string} HTML 文本。
 */
export function renderHtml(data, meta = {}) {
	const generated = new Date(data.generatedAt ?? Date.now());
	const kinds = {};
	for (const f of data.facts) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
	const kindLine = Object.entries(kinds)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k} × ${n}`)
		.join(" · ");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆库快照 · ${data.facts.length} 张卡</title>
<style>
:root{color-scheme:dark;--ease:cubic-bezier(0.22,1,0.36,1)}
*{box-sizing:border-box}
body{margin:0;font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#11141b;color:#dce2f0;height:100vh;display:flex;flex-direction:column}
header{padding:12px 20px;border-bottom:1px solid #232836;background:#141822;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:14px;margin:0;font-weight:700;letter-spacing:.02em}
.sub{color:#7d869c;font-size:11px;font-variant-numeric:tabular-nums}
input{flex:1 1 260px;min-width:160px;background:#191e2a;border:1px solid #2b3244;color:inherit;border-radius:8px;padding:6px 11px;font:inherit;outline:none;transition:border-color 140ms var(--ease),box-shadow 140ms var(--ease),background 140ms ease}
input:hover{border-color:#3a435a}
input:focus{border-color:#7aa2f7;box-shadow:0 0 0 3px rgba(122,162,247,.18);background:#151923}
main{flex:1 1 auto;display:flex;min-height:0}
nav{flex:0 0 226px;overflow:auto;border-right:1px solid #232836;background:#131720;padding:8px 7px;scrollbar-width:thin}
section{flex:0 0 42%;min-width:240px;overflow:auto;border-right:1px solid #232836;scrollbar-width:thin}
article{flex:1 1 auto;overflow:auto;padding:18px 22px;scrollbar-width:thin}
.node{padding:4px 8px;border-radius:6px;cursor:pointer;color:#a7b0c6;display:flex;gap:6px;align-items:center;transition:background 140ms var(--ease),color 140ms ease}
.node:hover{background:#1d2331;color:#edf1fb}
.node.on{background:rgba(122,162,247,.14);color:#dfe7ff;box-shadow:inset 3px 0 0 #7aa2f7}
.node .n{margin-left:auto;opacity:.6;font-size:11px;font-variant-numeric:tabular-nums}
.row{padding:10px 14px;border-bottom:1px solid #1e222e;cursor:pointer;transition:background 140ms var(--ease),box-shadow 140ms var(--ease)}
.row:hover{background:#181d28}
.row.on{background:rgba(122,162,247,.11);box-shadow:inset 3px 0 0 #7aa2f7}
.t{display:flex;gap:7px;align-items:center;margin-bottom:3px}
.chip{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;background:rgba(255,255,255,.04);font-weight:500}
.ttl{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.ex{color:#8a93a8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{display:flex;gap:9px;color:#6f788e;font-size:11px;margin-top:4px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.body{white-space:pre-wrap;line-height:1.72;color:#cbd2e3}
#detail>*{animation:fadeUp 180ms var(--ease) both}
h2{font-size:16px;margin:10px 0 6px}
.sec{margin:18px 0 6px;color:#737c94;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;background:#1e2330;border:1px solid #2b3244;color:#aeb7cc;margin:0 5px 5px 0}
.rel{padding:5px 8px;margin:0 -8px;border-radius:6px;color:#9aa4bb;cursor:pointer;transition:background 140ms var(--ease),color 140ms ease,transform 140ms var(--ease)}
.rel:hover{background:#1b202d;color:#dfe7ff;transform:translateX(2px)}
.empty{color:#6d7488;padding:20px 14px;line-height:1.7}
footer{padding:6px 20px;border-top:1px solid #232836;background:#141822;color:#636c82;font-size:11px}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
</style>
</head>
<body>
<header>
  <h1>记忆库快照</h1>
  <span class="sub">${data.facts.length} 张卡 · ${data.tree.length} 个节点 · ${data.edges.length} 条边 · ${kindLine}</span>
  <input id="q" placeholder="检索（中文双字词可命中）">
  <span class="sub" id="count"></span>
</header>
<main>
  <nav id="tree"></nav>
  <section id="list"></section>
  <article id="detail"><div class="empty">选一张卡看正文与关系。</div></article>
</main>
<footer>dsh-kb 静态导出 · ${generated.toISOString().slice(0, 16).replace("T", " ")} · 路径 ${meta.dbPath ?? ""}</footer>
<script type="application/json" id="kb-data">${inlineJson(data)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("kb-data").textContent);
  var KIND = { fact: "#7aa2f7", decision: "#e0af68", fix: "#9ece6a", pref: "#bb9af7", howto: "#7dcfff", concept: "#f7768e", intent: "#ff9e64", episode: "#565f89", segment: "#414868", todo: "#e0af68", state: "#73daca", artifact: "#c0caf5" };
  var LABEL = { fact: "事实", decision: "决定", fix: "修复", pref: "偏好", howto: "做法", concept: "概念", intent: "意图", episode: "会话", segment: "分段", todo: "待办", state: "进度", artifact: "产物" };
  var byId = new Map(DATA.facts.map(function (f) { return [f.id, f]; }));
  var out = new Map();
  var inn = new Map();
  DATA.edges.forEach(function (e) {
    if (!out.has(e.src)) out.set(e.src, []);
    if (!inn.has(e.dst)) inn.set(e.dst, []);
    out.get(e.src).push(e);
    inn.get(e.dst).push(e);
  });
  var state = { q: "", path: "", id: null };

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function ago(ts) {
    var ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
    var d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return "今天";
    if (d === 1) return "昨天";
    if (d < 30) return d + " 天前";
    if (d < 365) return Math.floor(d / 30) + " 个月前";
    return Math.floor(d / 365) + " 年前";
  }
  function lower(s) { return String(s === undefined || s === null ? "" : s).toLowerCase(); }

  function matchPath(candidate, prefix) {
    return candidate === prefix || String(candidate || "").indexOf(prefix + "/") === 0;
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.facts.filter(function (f) {
      if (state.path && !matchPath(f.path, state.path) && !f.paths.some(function (p) { return matchPath(p, state.path); })) return false;
      if (!q) return true;
      return lower(f.title).indexOf(q) !== -1 || lower(f.body).indexOf(q) !== -1 || lower(f.path).indexOf(q) !== -1
        || f.tags.some(function (t) { return lower(t).indexOf(q) !== -1; });
    });
    return rows;
  }

  function drawTree() {
    var nav = document.getElementById("tree");
    nav.innerHTML = DATA.tree.map(function (n) {
      return '<div class="node' + (state.path === n.path ? " on" : "") + '" data-path="' + esc(n.path) + '" style="padding-left:' + (6 + n.depth * 13) + 'px" title="' + esc(n.summary) + '">'
        + "<span>" + esc(n.path.split("/").pop()) + "</span>"
        + '<span class="n">' + (n.count || "") + "</span></div>";
    }).join("") || '<div class="empty">树是空的。</div>';
    Array.prototype.forEach.call(nav.querySelectorAll(".node"), function (el) {
      el.addEventListener("click", function () {
        var p = el.getAttribute("data-path");
        state.path = state.path === p ? "" : p;
        draw();
      });
    });
  }

  function drawList() {
    var rows = visible();
    document.getElementById("count").textContent = rows.length + " / " + DATA.facts.length;
    var box = document.getElementById("list");
    box.innerHTML = rows.slice(0, 400).map(function (f) {
      var color = KIND[f.kind] || "#7aa2f7";
      return '<div class="row' + (state.id === f.id ? " on" : "") + '" data-id="' + esc(f.id) + '">'
        + '<div class="t"><span class="chip" style="color:' + color + '">' + esc(LABEL[f.kind] || f.kind) + "</span>"
        + '<span class="ttl">' + esc(f.title) + "</span></div>"
        + '<div class="ex">' + esc(String(f.body || "").replace(/\\s+/g, " ").slice(0, 220)) + "</div>"
        + '<div class="meta"><span>' + esc(f.path || "inbox") + "</span><span>" + ago(f.ts) + "</span>"
        + (f.status === "active" ? "" : "<span>" + esc(f.status) + "</span>") + "</div></div>";
    }).join("") || '<div class="empty">没有命中。换同义词，或清空检索框。</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".row"), function (el) {
      el.addEventListener("click", function () { select(el.getAttribute("data-id")); });
    });
  }

  function select(id) {
    state.id = id;
    var f = byId.get(id);
    var box = document.getElementById("detail");
    if (!f) { box.innerHTML = '<div class="empty">这张卡不在快照里。</div>'; return; }
    var color = KIND[f.kind] || "#7aa2f7";
    var rel = function (list, arrow) {
      return list.map(function (e) {
        var other = byId.get(arrow === "in" ? e.src : e.dst);
        if (!other) return "";
        return '<div class="rel" data-id="' + esc(other.id) + '">' + esc(arrow === "in" ? "← " + e.rel : "→ " + e.rel + " ") + " " + esc(other.title) + "</div>";
      }).join("");
    };
    var inbound = (inn.get(id) || []);
    var outbound = (out.get(id) || []);
    box.innerHTML =
      '<span class="chip" style="color:' + color + '">' + esc(LABEL[f.kind] || f.kind) + "</span>"
      + "<h2>" + esc(f.title) + "</h2>"
      + '<div class="meta"><span>' + esc(f.path || "inbox") + "</span><span>" + ago(f.ts) + "</span><span>置信 " + Number(f.confidence).toFixed(2) + "</span></div>"
      + (f.tags.length ? '<div style="margin-top:8px">' + f.tags.map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>" : "")
      + '<div class="sec">正文</div><div class="body">' + esc(f.body || "(空)") + "</div>"
      + (inbound.length ? '<div class="sec">被引用 ' + inbound.length + "</div>" + rel(inbound, "in") : "")
      + (outbound.length ? '<div class="sec">指向 ' + outbound.length + "</div>" + rel(outbound, "out") : "")
      + '<div class="sec">引用</div><span class="tag">' + esc(f.id) + "</span>";
    Array.prototype.forEach.call(box.querySelectorAll(".rel"), function (el) {
      el.addEventListener("click", function () { select(el.getAttribute("data-id")); });
    });
    drawList();
  }

  function draw() { drawTree(); drawList(); }

  document.getElementById("q").addEventListener("input", function (e) { state.q = e.target.value; drawList(); });
  draw();
  if (DATA.facts.length) select(DATA.facts[0].id);
})();
</script>
</body>
</html>`;
}

/**
 * 导出并落盘。
 * @param {object} db - 已打开的库。
 * @param {object} [options] - 选项。
 * @param {string} [options.out] - 输出路径，缺省 `$DSH_HOME/kb/preview.html`。
 * @param {number} [options.limit] - 卡数上限。
 * @returns {{file: string, bytes: number, facts: number, nodes: number, edges: number}} 导出结果。
 */
export function exportStatic(db, options = {}) {
	const file = options.out || defaultExportPath();
	const data = { ...snapshot(db, options.limit ?? DEFAULT_LIMIT), generatedAt: Date.now() };
	const html = renderHtml(data, { dbPath: file === defaultExportPath() ? defaultExportPath() : options.dbPath ?? "" });
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, html, "utf8");
	return {
		file,
		bytes: Buffer.byteLength(html),
		facts: data.facts.length,
		nodes: data.tree.length,
		edges: data.edges.length,
	};
}
