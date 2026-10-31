/**
 * 侧边栏「记忆」面板（浏览器端）。
 *
 * 为什么手写 `window.__ModuleLoader__.load` 而不是走 tsc/tsdown：插件自己的 client
 * 半不参与 apps/web 的构建，改了刷新页面就生效。代价是不能写 JSX，也不能 `import`——
 * react 只能从 factory 的 `require` 参数拿（平台种子模块，见 web/src/seed.ts）。
 *
 * 四块视图按"找回去"的顺序摆：
 *   树   —— 左栏，点枝限定范围（多归属路径，一个枝不是文件夹而是一个视角）
 *   列表 —— 中栏，检索或时间线
 *   详情 —— 右栏，正文 + 一跳关系（谁引用了它、它包含了谁）
 *   图谱 —— 顶栏切换，枝内卡与边的力导向近似（圆环布局，不引第三方）
 *
 * 所有数据来自 `/api/dsh-kb/*`，与模型工具、CLI、静态导出是同一份库。
 */

window.__ModuleLoader__.load({
	id: "@myremme/dsh-kb",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		/** 路由前缀，与 lib/http.js 的 API_PREFIX 必须一致。 */
		const API = "/api/dsh-kb";
		/** 主面板 id：侧边栏图标与 main 页共用同一个字符串。 */
		const PANEL_ID = "dsh-kb";
		/** 注入的样式表 id，重复加载时按它去重。 */
		const STYLE_ID = "dsh-kb-panel-style";

		/** 卡类型的中文名。缺省回落原文。 */
		const KIND_LABEL = {
			fact: "事实",
			decision: "决定",
			fix: "修复",
			pref: "偏好",
			howto: "做法",
			concept: "概念",
			intent: "意图",
			episode: "会话",
			segment: "分段",
		};

		/** 类型色调，图谱与卡片标签共用。 */
		const KIND_COLOR = {
			fact: "#7aa2f7",
			decision: "#e0af68",
			fix: "#9ece6a",
			pref: "#bb9af7",
			howto: "#7dcfff",
			concept: "#f7768e",
			intent: "#ff9e64",
			episode: "#565f89",
			segment: "#414868",
		};

		/**
		 * 一次 GET/POST，统一解信封。
		 * @param {string} path - 相对 API 的路径。
		 * @param {object} [options] - `{query, body}`。
		 * @returns {Promise<any>} `data` 字段。
		 */
		async function call(path, options = {}) {
			const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
			const init = { method: options.body === undefined ? "GET" : "POST", headers: {} };
			if (options.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(options.body);
			}
			const response = await fetch(`${API}${path}${query}`, init);
			const payload = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }));
			if (!response.ok || payload.ok === false) {
				throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			}
			return payload.data;
		}

		/** 毫秒或秒时间戳 → `MM-DD HH:mm`。 */
		function when(ts) {
			const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/** 相对天数，用于列表右侧的"多久以前"。 */
		function ago(ts) {
			const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
			const days = Math.floor((Date.now() - ms) / 86400000);
			if (days <= 0) return "今天";
			if (days === 1) return "昨天";
			if (days < 30) return `${days} 天前`;
			if (days < 365) return `${Math.floor(days / 30)} 个月前`;
			return `${Math.floor(days / 365)} 年前`;
		}

		/** 注入面板样式（幂等）。 */
		function injectStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
.dkb-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-color-text,#ddd);}
.dkb-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsh-color-border,#2a2e3a);flex:0 0 auto;}
.dkb-bar input{flex:1 1 auto;min-width:80px;background:var(--dsh-color-bg-input,#1b1e26);border:1px solid var(--dsh-color-border,#2a2e3a);color:inherit;border-radius:6px;padding:5px 9px;font:inherit;outline:none;}
.dkb-bar input:focus{border-color:#7aa2f7;}
.dkb-btn{background:var(--dsh-color-bg-raised,#232733);border:1px solid var(--dsh-color-border,#2a2e3a);color:inherit;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;white-space:nowrap;}
.dkb-btn:hover{border-color:#7aa2f7;}
.dkb-btn[data-active="1"]{background:#2b3a5c;border-color:#7aa2f7;color:#cdd9ff;}
.dkb-btn[disabled]{opacity:.5;cursor:default;}
.dkb-cols{display:flex;flex:1 1 auto;min-height:0;}
.dkb-col{border-right:1px solid var(--dsh-color-border,#2a2e3a);overflow:auto;min-height:0;}
.dkb-tree{flex:0 0 208px;padding:8px 6px;}
.dkb-list{flex:0 0 44%;min-width:220px;}
.dkb-detail{flex:1 1 auto;border-right:none;padding:12px 14px;}
.dkb-node{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;cursor:pointer;color:#aab2c8;}
.dkb-node:hover{background:#222632;color:#e6ebf7;}
.dkb-node[data-active="1"]{background:#2b3a5c;color:#dbe4ff;}
.dkb-node .n{opacity:.55;font-variant-numeric:tabular-nums;margin-left:auto;font-size:11px;}
.dkb-row{padding:8px 12px;border-bottom:1px solid var(--dsh-color-border,#22252f);cursor:pointer;}
.dkb-row:hover{background:#1e222c;}
.dkb-row[data-active="1"]{background:#243049;}
.dkb-row .t{display:flex;align-items:center;gap:6px;margin-bottom:3px;}
.dkb-kind{font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid currentColor;opacity:.9;}
.dkb-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.dkb-ex{color:#8b93a7;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
.dkb-meta{display:flex;gap:8px;color:#6f7789;font-size:11px;margin-top:4px;}
.dkb-body{white-space:pre-wrap;line-height:1.6;color:#c7cede;}
.dkb-title-lg{font-size:15px;font-weight:700;margin:0 0 6px;}
.dkb-tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;background:#2a2e3a;color:#aab2c8;margin:0 4px 4px 0;}
.dkb-rel{display:flex;gap:6px;padding:3px 0;cursor:pointer;color:#9aa4bb;}
.dkb-rel:hover{color:#dbe4ff;}
.dkb-sec{margin:14px 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6f7789;}
.dkb-empty{color:#6f7789;padding:18px 12px;line-height:1.6;}
.dkb-err{background:#3a1f26;border:1px solid #f7768e;color:#ffc9d1;padding:8px 12px;margin:10px 14px;border-radius:6px;white-space:pre-wrap;}
.dkb-graph{flex:1 1 auto;min-height:0;position:relative;}
.dkb-graph svg{width:100%;height:100%;display:block;}
.dkb-hint{position:absolute;left:12px;bottom:10px;font-size:11px;color:#6f7789;}
.dkb-composer{position:absolute;inset:54px auto auto 12px;width:min(420px,calc(100% - 24px));background:var(--dsh-color-bg-raised,#1d212b);border:1px solid #3a4055;border-radius:10px;padding:12px;z-index:5;box-shadow:0 12px 32px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px;}
.dkb-composer label{font-size:11px;color:#6f7789;letter-spacing:.06em;text-transform:uppercase;}
.dkb-composer input,.dkb-composer textarea,.dkb-composer select{background:#11141b;border:1px solid #2a3040;color:inherit;border-radius:6px;padding:6px 8px;font:inherit;outline:none;width:100%;}
.dkb-composer textarea{min-height:110px;resize:vertical;line-height:1.5;}
.dkb-composer .row{display:flex;gap:8px;}
.dkb-composer .row>*{flex:1 1 0;}
.dkb-composer .actions{display:flex;gap:8px;justify-content:flex-end;}
`;
			document.head.append(style);
		}

		/** 侧边栏图标：一本书的轮廓，尺寸由侧边栏给。 */
		function MemoryIcon({ size }) {
			const s = size ?? 18;
			return h(
				"svg",
				{ width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M3 2.5h7.5A2.5 2.5 0 0 1 13 5v9H5.5A2.5 2.5 0 0 1 3 11.5v-9Z",
					stroke: "currentColor",
					"stroke-width": 1.3,
					"stroke-linejoin": "round",
				}),
				h("path", { d: "M5.5 5.5h5M5.5 8h5", stroke: "currentColor", "stroke-width": 1.1, "stroke-linecap": "round" }),
			);
		}

		/** 卡类型标签。 */
		function KindChip({ kind }) {
			return h(
				"span",
				{ className: "dkb-kind", style: { color: KIND_COLOR[kind] ?? "#7aa2f7" } },
				KIND_LABEL[kind] ?? kind,
			);
		}

		/** 骨架树：缩进 + 计数，点击限定范围。 */
		function TreePane({ nodes, active, onPick }) {
			if (nodes.length === 0) return h("div", { className: "dkb-empty" }, "树还是空的。先吸收会话或写一张卡。");
			return h(
				"div",
				null,
				nodes.map((node) =>
					h(
						"div",
						{
							key: node.path,
							className: "dkb-node",
							"data-active": active === node.path ? "1" : "0",
							style: { paddingLeft: `${6 + node.depth * 14}px` },
							onClick: () => onPick(active === node.path ? "" : node.path),
							title: node.summary || node.path,
						},
						h("span", null, node.path.split("/").pop()),
						h("span", { className: "n" }, node.count > 0 ? node.count : ""),
					),
				),
			);
		}

		/** 卡列表一行。 */
		function FactRow({ item, active, onPick }) {
			return h(
				"div",
				{ className: "dkb-row", "data-active": active === item.id ? "1" : "0", onClick: () => onPick(item.id) },
				h(
					"div",
					{ className: "t" },
					h(KindChip, { kind: item.kind }),
					h("span", { className: "dkb-title", title: item.title }, item.title),
				),
				h("div", { className: "dkb-ex" }, item.excerpt ?? item.body ?? ""),
				h(
					"div",
					{ className: "dkb-meta" },
					h("span", null, item.path || "inbox"),
					item.score === undefined ? null : h("span", null, `${item.score.toFixed(2)} · ${item.why}`),
					h("span", null, ago(item.ts)),
				),
			);
		}

		/** 详情：正文 + 入/出关系。 */
		function DetailPane({ detail, loading, onPick, onForget }) {
			if (loading) return h("div", { className: "dkb-empty" }, "载入中…");
			if (detail === null) return h("div", { className: "dkb-empty" }, "选一张卡看细节。");
			const f = detail.fact;
			return h(
				"div",
				null,
				h(KindChip, { kind: f.kind }),
				h("h2", { className: "dkb-title-lg" }, f.title),
				h(
					"div",
					{ className: "dkb-meta" },
					h("span", null, f.path || "inbox"),
					h("span", null, when(f.ts)),
					h("span", null, `置信 ${f.confidence.toFixed(2)}`),
					f.status === "active" ? null : h("span", null, f.status),
				),
				f.tags.length > 0
					? h("div", { style: { marginTop: 8 } }, f.tags.map((t) => h("span", { key: t, className: "dkb-tag" }, t)))
					: null,
				h("div", { className: "dkb-sec" }, "正文"),
				h("div", { className: "dkb-body" }, f.body || "(空)"),
				f.paths.length > 1
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, "多归属"),
							f.paths.map((p) => h("span", { key: p, className: "dkb-tag" }, p)),
						)
					: null,
				detail.inbound.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `被引用 ${detail.inbound.length}`),
							detail.inbound.map((r) =>
								h(
									"div",
									{ key: `${r.rel}-${r.id}`, className: "dkb-rel", onClick: () => onPick(r.id) },
									h("span", null, `← ${r.rel}`),
									h("span", { className: "dkb-title" }, r.title),
								),
							),
						)
					: null,
				detail.outbound.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `指向 ${detail.outbound.length}`),
							detail.outbound.map((r) =>
								h(
									"div",
									{ key: `${r.rel}-${r.id}`, className: "dkb-rel", onClick: () => onPick(r.id) },
									h("span", null, `→ ${r.rel}`),
									h("span", { className: "dkb-title" }, r.title),
								),
							),
						)
					: null,
				detail.mentions !== undefined && detail.mentions.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `提及 ${detail.mentions.length}`),
							detail.mentions.map((m) =>
								h("span", { key: `${m.type}:${m.token}`, className: "dkb-tag", title: m.type }, m.token),
							),
						)
					: null,
				detail.history !== undefined && detail.history.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `历史版本 ${detail.history.length}`),
							detail.history.map((v) =>
								h(
									"div",
									{ key: v.version, className: "dkb-rel", title: v.body },
									h("span", null, `v${v.version}`),
									h("span", { className: "dkb-title" }, v.title),
								),
							),
						)
					: null,
				h("div", { className: "dkb-sec" }, "操作"),
				h(
					"div",
					{ style: { display: "flex", gap: 8 } },
					h(
						"button",
						{
							className: "dkb-btn",
							onClick: () => onForget(f.id),
							disabled: f.status !== "active",
							title: f.status === "active" ? "标为失效（保留可查，不删）" : "已经是失效状态",
						},
						f.status === "active" ? "标失效" : `已 ${f.status}`,
					),
				),
				h("div", { className: "dkb-sec" }, "引用"),
				h("div", { className: "dkb-tag" }, f.id),
			);
		}

		/**
		 * 图谱：同枝卡按路径分环排布，边连直线。
		 * 不做真力导向——节点上百个时手算稳定性差，而这里的用途是"看脉络"不是"看美学"。
		 */
		function GraphPane({ graph, onPick }) {
			if (graph === null) return h("div", { className: "dkb-empty" }, "载入中…");
			const { nodes, edges } = graph;
			if (nodes.length === 0) return h("div", { className: "dkb-empty" }, "这个范围里没有卡。");
			const W = 900;
			const H = 620;
			const cx = W / 2;
			const cy = H / 2;
			// 单环 + 按路径排序：同一个枝的卡在环上连成一段弧，比多环互叠好读，
			// 也不用担心节点多了溢出视口。
			const ordered = [...nodes].sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.id.localeCompare(b.id));
			const radius = Math.min(270, 96 + ordered.length * 1.4);
			const placed = new Map();
			ordered.forEach((n, i) => {
				const angle = (i / Math.max(1, ordered.length)) * Math.PI * 2 - Math.PI / 2;
				placed.set(n.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, n });
			});
			return h(
				"div",
				{ className: "dkb-graph" },
				h(
					"svg",
					{ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" },
					edges.map((e, i) => {
						const a = placed.get(e.src);
						const b = placed.get(e.dst);
						if (a === undefined || b === undefined) return null;
						return h("line", {
							key: `e${i}`,
							x1: a.x,
							y1: a.y,
							x2: b.x,
							y2: b.y,
							stroke: "#2f3547",
							"stroke-width": Math.min(2.2, 0.6 + Number(e.w ?? 1) * 0.7),
						});
					}),
					[...placed.values()].map((p) =>
						h(
							"g",
							{ key: p.n.id, style: { cursor: "pointer" }, onClick: () => onPick(p.n.id) },
							h("circle", { cx: p.x, cy: p.y, r: 5, fill: KIND_COLOR[p.n.kind] ?? "#7aa2f7" }),
							h(
								"text",
								{
									x: p.x + 9,
									y: p.y + 4,
									fill: "#9aa4bb",
									"font-size": 10,
									"font-family": "inherit",
								},
								String(p.n.title).slice(0, 26),
							),
						),
					),
				),
				h("div", { className: "dkb-hint" }, `${nodes.length} 张卡 · ${edges.length} 条边 · 点节点看详情`),
			);
		}

		/** 主页面：状态都在这里，子面板只负责画。 */
		function MemoryPage() {
			const [mode, setMode] = useState("list");
			const [query, setQuery] = useState("");
			const [pathFilter, setPathFilter] = useState("");
			const [list, setList] = useState({ items: [], total: 0 });
			const [tree, setTree] = useState([]);
			const [stats, setStats] = useState(null);
			const [graph, setGraph] = useState(null);
			const [detail, setDetail] = useState(null);
			const [selected, setSelected] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);
			const [draft, setDraft] = useState(null);
			const timer = useRef(null);

			const loadShell = useCallback(async () => {
				try {
					const [treeRows, stats] = await Promise.all([call("/tree"), call("/stats")]);
					setTree(treeRows);
					setStats(stats);
					setError(null);
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, []);

			const loadList = useCallback(
				async (q, pathValue) => {
					try {
						if (q.trim() !== "") {
							const rows = await call("/search", { query: { q: q.trim(), k: 40, path: pathValue || undefined } });
							setList({ items: rows, total: rows.length });
						} else {
							const page = await call("/facts", { query: { limit: 60, status: "active", path: pathValue || undefined } });
							setList(page);
						}
						setError(null);
					} catch (e) {
						setError(String(e.message ?? e));
					}
				},
				[],
			);

			useEffect(() => {
				injectStyle();
				loadShell();
			}, [loadShell]);

			useEffect(() => {
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					loadList(query, pathFilter);
				}, 260);
				return () => {
					if (timer.current !== null) clearTimeout(timer.current);
				};
			}, [query, pathFilter, loadList]);

			const openFact = useCallback(async (id) => {
				setSelected(id);
				try {
					const data = await call("/fact", { query: { id } });
					setDetail(data);
				} catch (e) {
					setDetail(null);
					setError(String(e.message ?? e));
				}
			}, []);

			const openGraph = useCallback(async () => {
				setGraph(null);
				try {
					setGraph(await call("/graph", { query: { path: pathFilter || undefined, limit: 140 } }));
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, [pathFilter]);

			useEffect(() => {
				if (mode === "graph") openGraph();
			}, [mode, openGraph]);

			const runIngest = useCallback(async () => {
				setBusy(true);
				try {
					const result = await call("/ingest", { body: {} });
					await loadShell();
					await loadList(query, pathFilter);
					setError(`吸收完成：${result.added ?? 0} 张新卡 / ${result.files ?? 0} 个会话 / ${result.ms ?? 0} ms`);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [loadShell, loadList, query, pathFilter]);

			const head = useMemo(() => {
				if (stats === null) return "记忆库";
				return `记忆库 · ${stats.facts} 卡 / ${stats.sessions} 会话 / ${stats.edges} 边`;
			}, [stats]);

			// 面板也能写：写走 /add（与 kb_add 同一条 upsertFact），删走 /forget（只降级）。
			const saveDraft = useCallback(async () => {
				if (draft === null) return;
				if (draft.title.trim() === "" || draft.body.trim() === "") {
					setError("标题和正文都要填。");
					return;
				}
				try {
					const result = await call("/add", {
						body: {
							title: draft.title,
							body: draft.body,
							path: draft.path || undefined,
							kind: draft.kind,
							tags: draft.tags,
						},
					});
					setDraft(null);
					await loadShell();
					await loadList(query, pathFilter);
					setError(result.result === "dup" ? "同样的卡已存在，已跳过。" : null);
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, [draft, loadShell, loadList, query, pathFilter]);

			const removeFact = useCallback(
				async (id) => {
					try {
						await call("/forget", { body: { id } });
						await openFact(id);
						await loadShell();
						await loadList(query, pathFilter);
					} catch (e) {
						setError(String(e.message ?? e));
					}
				},
				[openFact, loadShell, loadList, query, pathFilter],
			);

			return h(
				"div",
				{ className: "dkb-root" },
				h(
					"div",
					{ className: "dkb-bar" },
					h("input", {
						value: query,
						placeholder: "检索记忆（中文双字词可命中）",
						onChange: (e) => setQuery(e.target.value),
					}),
					h(
						"button",
						{
							className: "dkb-btn",
							"data-active": mode === "list" ? "1" : "0",
							onClick: () => setMode("list"),
						},
						"列表",
					),
					h(
						"button",
						{
							className: "dkb-btn",
							"data-active": mode === "graph" ? "1" : "0",
							onClick: () => setMode("graph"),
						},
						"图谱",
					),
					h(
					"button",
					{
						className: "dkb-btn",
						"data-active": draft === null ? "0" : "1",
						onClick: () =>
							setDraft(
								draft === null
									? { title: "", body: "", path: pathFilter || "", kind: "fact", tags: "" }
									: null,
							),
					},
					"新建",
				),
				h("button", { className: "dkb-btn", onClick: runIngest, disabled: busy }, busy ? "吸收中…" : "吸收会话"),
					h("span", { style: { color: "#6f7789", fontSize: 11, whiteSpace: "nowrap" } }, head),
				),
				error === null ? null : h("div", { className: "dkb-err" }, error),
				draft === null
					? null
					: h(
							"div",
							{ className: "dkb-composer" },
							h("label", null, "标题"),
							h("input", {
								value: draft.title,
								placeholder: "一句话结论，别写成标签",
								onChange: (e) => setDraft({ ...draft, title: e.target.value }),
							}),
							h("label", null, "正文"),
							h("textarea", {
								value: draft.body,
								placeholder: "现象、根因、做法、边界（三个月后单看能懂）",
								onChange: (e) => setDraft({ ...draft, body: e.target.value }),
							}),
							h(
								"div",
								{ className: "row" },
								h("input", {
									value: draft.path,
									placeholder: "归枝路径，如 topic/dsh",
									onChange: (e) => setDraft({ ...draft, path: e.target.value }),
								}),
								h(
									"select",
									{ value: draft.kind, onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
									Object.keys(KIND_LABEL).map((k) => h("option", { key: k, value: k }, KIND_LABEL[k])),
								),
							),
							h("input", {
								value: draft.tags,
								placeholder: "标签，逗号分隔",
								onChange: (e) => setDraft({ ...draft, tags: e.target.value }),
							}),
							h(
								"div",
								{ className: "actions" },
								h("button", { className: "dkb-btn", onClick: () => setDraft(null) }, "取消"),
								h("button", { className: "dkb-btn", "data-active": "1", onClick: saveDraft }, "写入"),
							),
						),
				mode === "graph"
					? h(GraphPane, { graph, onPick: openFact })
					: h(
							"div",
							{ className: "dkb-cols" },
							h("div", { className: "dkb-col dkb-tree" }, h(TreePane, { nodes: tree, active: pathFilter, onPick: setPathFilter })),
							h(
								"div",
								{ className: "dkb-col dkb-list" },
								list.items.length === 0
									? h("div", { className: "dkb-empty" }, query ? "没有命中。换同义词或英文再查。" : "这个范围里没有卡。")
									: list.items.map((item) => h(FactRow, { key: item.id, item, active: selected, onPick: openFact })),
							),
							h("div", { className: "dkb-col dkb-detail" }, h(DetailPane, { detail, loading: false, onPick: openFact, onForget: removeFact })),
						),
			);
		}

		/**
		 * 浏览器端插件入口。
		 * @param {object} ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 32, label: () => "记忆" }, MemoryIcon),
			);
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, MemoryPage));
		}

		exports.name = PANEL_ID;
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
