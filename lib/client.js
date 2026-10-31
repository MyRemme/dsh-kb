/**
 * dsh-kb — 浏览器端（可视化界面）。
 *
 * 手写在 harness 的 module-loader 格式里：shell 求值本文件后调用 `factory`，
 * 传入一个 CommonJS 风格的 `require`，`react` 由宿主运行时解析。没有构建步骤。
 *
 * 三个视图共用一块面板：
 *   浏览 —— 骨架树 + 卡片列表 + 详情
 *   搜索 —— 同一份卡片列表，换个数据源
 *   图谱 —— canvas 力导向，边来自 edge 表
 *
 * 所有请求走 same-origin 相对路径 `api/dsh-kb/...`：GUI 用 `<base href="./">`
 * 部署，写死 `/api/...` 会在子路径部署下逃出应用根。
 */
window.__ModuleLoader__.load({
	id: "dsh-kb",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		const NS = "dsh-kb";
		const PANEL_ID = "kb";
		const PANEL_ORDER = 32;
		const STYLE_ID = "dsh-kb-styles";
		const API = {
			tree: "api/dsh-kb/tree",
			cards: "api/dsh-kb/cards",
			search: "api/dsh-kb/search",
			card: "api/dsh-kb/card",
			stats: "api/dsh-kb/stats",
			graph: "api/dsh-kb/graph",
			forget: "api/dsh-kb/forget",
			ingest: "api/dsh-kb/ingest",
		};

		const CSS = `
.kb-root { display:flex; flex-direction:column; height:100%; min-height:0; font-size:13px; color:inherit; }
.kb-head { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid color-mix(in srgb, currentColor 14%, transparent); flex:0 0 auto; }
.kb-input { flex:1 1 auto; min-width:120px; padding:6px 10px; border-radius:7px; border:1px solid color-mix(in srgb, currentColor 20%, transparent); background:color-mix(in srgb, currentColor 5%, transparent); color:inherit; font:inherit; outline:none; }
.kb-input:focus { border-color:#4a9eff; }
.kb-tabs { display:flex; gap:2px; padding:2px; border-radius:8px; background:color-mix(in srgb, currentColor 7%, transparent); }
.kb-tab { padding:4px 12px; border-radius:6px; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; opacity:.65; }
.kb-tab:hover { opacity:.9; }
.kb-tab[data-on="1"] { background:color-mix(in srgb, currentColor 14%, transparent); opacity:1; }
.kb-btn { padding:5px 10px; border-radius:7px; border:1px solid color-mix(in srgb, currentColor 20%, transparent); background:transparent; color:inherit; font:inherit; cursor:pointer; opacity:.8; }
.kb-btn:hover { opacity:1; background:color-mix(in srgb, currentColor 7%, transparent); }
.kb-btn[disabled] { opacity:.4; cursor:default; }
.kb-body { flex:1 1 auto; display:flex; min-height:0; }
.kb-side { width:230px; flex:0 0 auto; overflow:auto; padding:8px 0; border-right:1px solid color-mix(in srgb, currentColor 14%, transparent); }
.kb-tree-row { display:flex; align-items:center; gap:6px; padding:3px 10px; cursor:pointer; border-radius:6px; margin:0 6px; white-space:nowrap; }
.kb-tree-row:hover { background:color-mix(in srgb, currentColor 7%, transparent); }
.kb-tree-row[data-on="1"] { background:color-mix(in srgb, #4a9eff 20%, transparent); }
.kb-count { margin-left:auto; font-size:11px; opacity:.5; font-variant-numeric:tabular-nums; }
.kb-list { flex:1 1 auto; overflow:auto; min-width:0; }
.kb-item { padding:9px 14px; border-bottom:1px solid color-mix(in srgb, currentColor 8%, transparent); cursor:pointer; }
.kb-item:hover { background:color-mix(in srgb, currentColor 5%, transparent); }
.kb-item[data-on="1"] { background:color-mix(in srgb, #4a9eff 14%, transparent); }
.kb-item-title { font-weight:600; line-height:1.35; }
.kb-item-sub { margin-top:3px; font-size:11.5px; opacity:.55; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.kb-chip { padding:1px 6px; border-radius:4px; background:color-mix(in srgb, currentColor 12%, transparent); font-size:10.5px; letter-spacing:.02em; }
.kb-chip[data-k="decision"] { background:color-mix(in srgb, #b06bff 26%, transparent); }
.kb-chip[data-k="fix"] { background:color-mix(in srgb, #ff8c42 26%, transparent); }
.kb-chip[data-k="intent"] { background:color-mix(in srgb, #4a9eff 26%, transparent); }
.kb-chip[data-k="episode"] { background:color-mix(in srgb, #2ecc71 22%, transparent); }
.kb-chip[data-k="concept"] { background:color-mix(in srgb, #00c2c7 22%, transparent); }
.kb-detail { width:400px; flex:0 0 auto; overflow:auto; padding:14px; border-left:1px solid color-mix(in srgb, currentColor 14%, transparent); }
.kb-detail h3 { margin:0 0 8px; font-size:14px; line-height:1.4; }
.kb-meta { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; font-size:11px; opacity:.65; }
.kb-body-text { white-space:pre-wrap; word-break:break-word; line-height:1.65; font-size:12.5px; }
.kb-empty { padding:28px 16px; text-align:center; opacity:.45; font-size:12.5px; }
.kb-graph { flex:1 1 auto; position:relative; min-width:0; }
.kb-canvas { display:block; width:100%; height:100%; }
.kb-hint { position:absolute; left:12px; bottom:10px; font-size:11px; opacity:.45; pointer-events:none; }
.kb-status { padding:4px 14px; font-size:11px; opacity:.5; border-bottom:1px solid color-mix(in srgb, currentColor 10%, transparent); }
`;

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const node = document.createElement("style");
			node.id = STYLE_ID;
			node.textContent = CSS;
			document.head.appendChild(node);
		}

		// ------------------------------------------------------------- data

		async function getJson(url) {
			const res = await fetch(url, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return res.json();
		}

		const qs = (params) => {
			const sp = new URLSearchParams();
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
			}
			const s = sp.toString();
			return s ? `?${s}` : "";
		};

		// ------------------------------------------------------- components

		const PanelIcon = () =>
			h(
				"svg",
				{
					width: "18",
					height: "18",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.7",
					strokeLinecap: "round",
					strokeLinejoin: "round",
				},
				h("circle", { cx: "12", cy: "12", r: "2.4" }),
				h("circle", { cx: "5", cy: "6", r: "1.7" }),
				h("circle", { cx: "19", cy: "6", r: "1.7" }),
				h("circle", { cx: "5", cy: "18", r: "1.7" }),
				h("circle", { cx: "19", cy: "18", r: "1.7" }),
				h("path", { d: "M6.4 7.2 10 10.6M17.6 7.2 14 10.6M6.4 16.8 10 13.4M17.6 16.8 14 13.4" }),
			);

		function TreeView({ nodes, selected, onSelect }) {
			const rows = nodes.filter((n) => n.count > 0 || n.depth > 0);
			return h(
				"div",
				{ className: "kb-side" },
				h(
					"div",
					{ className: "kb-tree-row", "data-on": selected === "" ? "1" : "0", onClick: () => onSelect("") },
					h("span", null, "全部"),
				),
				...rows.map((n) =>
					h(
						"div",
						{
							key: n.path,
							className: "kb-tree-row",
							"data-on": selected === n.path ? "1" : "0",
							style: { paddingLeft: `${10 + n.depth * 13}px` },
							title: n.summary || n.path,
							onClick: () => onSelect(n.path),
						},
						h("span", { style: { opacity: n.depth === 0 ? 0.55 : 1 } }, n.path.split("/").pop()),
						n.count > 0 ? h("span", { className: "kb-count" }, String(n.count)) : null,
					),
				),
			);
		}

		function CardItem({ card, active, onSelect }) {
			return h(
				"div",
				{ className: "kb-item", "data-on": active ? "1" : "0", onClick: () => onSelect(card) },
				h("div", { className: "kb-item-title" }, card.title || "(无标题)"),
				h(
					"div",
					{ className: "kb-item-sub" },
					h("span", { className: "kb-chip", "data-k": card.kind }, card.kind),
					h("span", null, card.path || "inbox"),
					card.status !== "active" ? h("span", { className: "kb-chip" }, card.status) : null,
					card.score !== undefined ? h("span", null, `匹配 ${Math.round((card.score ?? 0) * 100)}%`) : null,
				),
			);
		}

		function Detail({ card, onForget }) {
			if (!card) return h("div", { className: "kb-detail" }, h("div", { className: "kb-empty" }, "选一张卡看详情"));
			const when = new Date(Number(card.ts) > 1e11 ? Number(card.ts) : Number(card.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
			return h(
				"div",
				{ className: "kb-detail" },
				h("h3", null, card.title),
				h(
					"div",
					{ className: "kb-meta" },
					h("span", { className: "kb-chip", "data-k": card.kind }, card.kind),
					h("span", null, card.path || "inbox"),
					h("span", null, when),
					h("span", null, `置信 ${Number(card.confidence ?? 0).toFixed(2)}`),
					(card.tags ?? []).slice(0, 6).map((t) => h("span", { key: t, className: "kb-chip" }, t)),
				),
				h("div", { className: "kb-body-text" }, card.body || "(空)"),
				h(
					"div",
					{ style: { marginTop: 14, display: "flex", gap: 8 } },
					h(
						"button",
						{
							type: "button",
							className: "kb-btn",
							onClick: () => navigator.clipboard?.writeText(card.id),
							title: card.id,
						},
						"复制 id",
					),
					card.status === "active"
						? h(
								"button",
								{
									type: "button",
									className: "kb-btn",
									onClick: () => onForget(card),
									title: "标记为 superseded：不删，检索降权",
								},
								"标记失效",
							)
						: null,
					card.sourceRef ? h("span", { style: { fontSize: 11, opacity: 0.45, alignSelf: "center" } }, card.sourceRef) : null,
				),
			);
		}

		/**
		 * 力导向图：不引第三方库，够看清"哪堆卡连在一起"就行。
		 * 边只画 edge 表里真实存在的，不臆造关联。
		 */
		function GraphView({ path }) {
			const ref = useRef(null);
			const [info, setInfo] = useState({ nodes: 0, edges: 0 });

			useEffect(() => {
				let raf = 0;
				let disposed = false;
				const canvas = ref.current;
				if (!canvas) return undefined;

				getJson(API.graph + qs({ path, limit: 260 }))
					.then((data) => {
						if (disposed) return;
						setInfo({ nodes: data.nodes.length, edges: data.edges.length });
						const ctx = canvas.getContext("2d");
						const dpr = window.devicePixelRatio || 1;
						const box = canvas.getBoundingClientRect();
						canvas.width = Math.max(1, box.width * dpr);
						canvas.height = Math.max(1, box.height * dpr);
						ctx.scale(dpr, dpr);

						const W = box.width;
						const H = box.height;
						const byId = new Map(data.nodes.map((n) => [n.id, n]));
						const nodes = data.nodes.map((n, i) => ({
							...n,
							x: W / 2 + Math.cos((i / Math.max(1, data.nodes.length)) * Math.PI * 2) * W * 0.28,
							y: H / 2 + Math.sin((i / Math.max(1, data.nodes.length)) * Math.PI * 2) * H * 0.28,
							vx: 0,
							vy: 0,
						}));
						const index = new Map(nodes.map((n) => [n.id, n]));
						const links = data.edges
							.map((e) => ({ a: index.get(e.src), b: index.get(e.dst), rel: e.rel }))
							.filter((l) => l.a && l.b);

						const step = () => {
							// 斥力
							for (let i = 0; i < nodes.length; i += 1) {
								const a = nodes[i];
								for (let j = i + 1; j < nodes.length; j += 1) {
									const b = nodes[j];
									let dx = a.x - b.x;
									let dy = a.y - b.y;
									let d2 = dx * dx + dy * dy;
									if (d2 < 1) {
										dx = (Math.random() - 0.5) * 0.6;
										dy = (Math.random() - 0.5) * 0.6;
										d2 = 1;
									}
									const f = 900 / d2;
									const d = Math.sqrt(d2);
									a.vx += (dx / d) * f;
									a.vy += (dy / d) * f;
									b.vx -= (dx / d) * f;
									b.vy -= (dy / d) * f;
								}
							}
							// 引力
							for (const l of links) {
								const dx = l.b.x - l.a.x;
								const dy = l.b.y - l.a.y;
								const d = Math.sqrt(dx * dx + dy * dy) || 1;
								const f = (d - 54) * 0.0016;
								l.a.vx += (dx / d) * f;
								l.a.vy += (dy / d) * f;
								l.b.vx -= (dx / d) * f;
								l.b.vy -= (dy / d) * f;
							}
							// 向心 + 阻尼
							for (const n of nodes) {
								n.vx += (W / 2 - n.x) * 0.0009;
								n.vy += (H / 2 - n.y) * 0.0009;
								n.vx *= 0.72;
								n.vy *= 0.72;
								n.x = Math.max(14, Math.min(W - 14, n.x + n.vx));
								n.y = Math.max(14, Math.min(H - 14, n.y + n.vy));
							}
							draw();
							raf = requestAnimationFrame(step);
						};

						const colorOf = (kind) => {
							switch (kind) {
								case "decision": return "#b06bff";
								case "fix": return "#ff8c42";
								case "intent": return "#4a9eff";
								case "episode": return "#2ecc71";
								case "concept": return "#00c2c7";
								default: return "#8b93a7";
							}
						};

						const draw = () => {
							ctx.clearRect(0, 0, W, H);
							ctx.strokeStyle = "rgba(140,150,170,0.22)";
							ctx.lineWidth = 1;
							for (const l of links) {
								ctx.beginPath();
								ctx.moveTo(l.a.x, l.a.y);
								ctx.lineTo(l.b.x, l.b.y);
								ctx.stroke();
							}
							for (const n of nodes) {
								ctx.beginPath();
								ctx.arc(n.x, n.y, 3.6, 0, Math.PI * 2);
								ctx.fillStyle = colorOf(n.kind);
								ctx.globalAlpha = n.status === "active" ? 0.95 : 0.3;
								ctx.fill();
							}
							ctx.globalAlpha = 1;
						};

						step();
					})
					.catch((error) => setInfo({ nodes: -1, edges: -1, error: String(error) }));

				return () => {
					disposed = true;
					cancelAnimationFrame(raf);
				};
			}, [path]);

			return h(
				"div",
				{ className: "kb-graph" },
				h("canvas", { ref, className: "kb-canvas" }),
				h(
					"div",
					{ className: "kb-hint" },
					info.nodes < 0
						? "加载失败"
						: `${info.nodes} 个节点 · ${info.edges} 条边 · 配色=卡类型 · 边=包含/取代关系`,
				),
			);
		}

		function KbPanel() {
			const [view, setView] = useState("browse");
			const [query, setQuery] = useState("");
			const [path, setPath] = useState("");
			const [tree, setTree] = useState([]);
			const [cards, setCards] = useState([]);
			const [total, setTotal] = useState(0);
			const [selected, setSelected] = useState(null);
			const [stats, setStats] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const loadTree = useCallback(async () => {
				try {
					const data = await getJson(API.tree);
					setTree(data.nodes ?? []);
				} catch (e) {
					setError(String(e));
				}
			}, []);

			const loadStats = useCallback(async () => {
				try {
					setStats(await getJson(API.stats));
				} catch {
					/* 统计失败不影响主流程 */
				}
			}, []);

			const loadCards = useCallback(async (q, p) => {
				setError("");
				try {
					if (q.trim()) {
						const data = await getJson(API.search + qs({ q, k: 40, path: p }));
						setCards(data.results ?? []);
						setTotal((data.results ?? []).length);
					} else {
						const data = await getJson(API.cards + qs({ path: p, limit: 120 }));
						setCards(data.cards ?? []);
						setTotal(data.total ?? 0);
					}
				} catch (e) {
					setError(String(e));
					setCards([]);
				}
			}, []);

			useEffect(() => {
				loadTree();
				loadStats();
			}, [loadTree, loadStats]);

			useEffect(() => {
				const timer = setTimeout(() => loadCards(query, path), 220);
				return () => clearTimeout(timer);
			}, [query, path, loadCards]);

			const onForget = useCallback(
				async (card) => {
					setBusy(true);
					try {
						await fetch(API.forget, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: card.id }),
						});
						setSelected(null);
						await loadCards(query, path);
						await loadStats();
					} catch (e) {
						setError(String(e));
					} finally {
						setBusy(false);
					}
				},
				[query, path, loadCards, loadStats],
			);

			const onIngest = useCallback(async () => {
				setBusy(true);
				setError("");
				try {
					const r = await fetch(API.ingest, { method: "POST" });
					const data = await r.json();
					await loadTree();
					await loadStats();
					await loadCards(query, path);
					setError(`吸收完成：+${data.added ?? 0} 张卡，${data.files ?? 0} 个会话`);
				} catch (e) {
					setError(String(e));
				} finally {
					setBusy(false);
				}
			}, [query, path, loadTree, loadStats, loadCards]);

			const status = error
				? error
				: stats
					? `${stats.facts} 张卡 · ${stats.active} 有效 · ${stats.sessions} 个已吸收会话 · ${stats.edges} 条边`
					: "加载中…";

			return h(
				"div",
				{ className: "kb-root" },
				h(
					"div",
					{ className: "kb-head" },
					h("input", {
						className: "kb-input",
						placeholder: "搜记忆…（中文或英文，可混合）",
						value: query,
						onChange: (e) => setQuery(e.target.value),
						spellCheck: false,
					}),
					h(
						"div",
						{ className: "kb-tabs" },
						["browse", "graph"].map((v) =>
							h(
								"button",
								{
									key: v,
									type: "button",
									className: "kb-tab",
									"data-on": view === v ? "1" : "0",
									onClick: () => setView(v),
								},
								v === "browse" ? "浏览" : "图谱",
							),
						),
					),
					h("button", { type: "button", className: "kb-btn", disabled: busy, onClick: onIngest, title: "增量吸收本机会话" }, "吸收"),
				),
				h("div", { className: "kb-status" }, status),
				view === "graph"
					? h(GraphView, { path })
					: h(
							"div",
							{ className: "kb-body" },
							h(TreeView, { nodes: tree, selected: path, onSelect: (p) => { setPath(p); setSelected(null); } }),
							h(
								"div",
								{ className: "kb-list" },
								cards.length === 0
									? h("div", { className: "kb-empty" }, query.trim() ? "没有命中。换同义词或英文再试。" : "这个枝下还没有卡。")
									: cards.map((c) => h(CardItem, { key: c.id, card: c, active: selected?.id === c.id, onSelect: setSelected })),
							),
							h(Detail, { card: selected, onForget }),
						),
			);
		}

		// ---------------------------------------------------------------- mount

		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			const disposers = [];
			try {
				const slots = ctx.slots;
				disposers.push(
					slots.inject("sidebar.panellist", () =>
						slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => "记忆" }, PanelIcon),
					),
				);
				disposers.push(
					slots.inject("main", () => slots.register({ name: "main", key: PANEL_ID }, KbPanel)),
				);
			} catch (error) {
				console.warn("[dsh-kb] panel registration failed:", error);
			}
			ctx.effect?.(() => () => {
				for (const dispose of disposers.splice(0)) {
					try {
						dispose?.();
					} catch {
						/* ignore */
					}
				}
			}, "dsh-kb: ui mounts");
		}

		ensureStyles();
		return { apply, inject, name: NS };
	},
});
