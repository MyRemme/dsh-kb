/**
 * 侧边栏「记忆」面板（浏览器端）。
 *
 * 手写 `window.__ModuleLoader__.load` 而不是走构建：插件自己的 client 半不参与
 * apps/web 的打包，改了刷新页面就生效。代价是不能写 JSX、不能 `import`——
 * react 只能从 factory 的 `require` 拿（平台种子模块，见 web/src/seed.ts）。
 *
 * 视觉一律走 DSH 的设计令牌（`--dsw-alias-*` / `--dsw-radius-*`），不自定义配色：
 * 面板要和设置页、任务页看起来是同一个产品，而不是嵌进来的第三方控件。
 *
 * 图谱是**星图 + 树状图的混合**：
 *   骨架 —— 按路径物化成径向树（root → topic/project → 子枝），这是"树状"那一半
 *   星体 —— 每张卡挂在自己的枝上，用 id 的哈希做确定性散布，这是"星图"那一半
 *   连线 —— 结构线（星→所属枝）恒在；事实间的关系线（edge 表）更亮
 * 两种模式共用同一套骨架，"树状"只是把星体收起、只留结构。
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
		const STYLE_ID = "dsh-kb-panel-style";

		/** 卡类型的中文名。 */
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
			todo: "待办",
			state: "进度",
			artifact: "产物",
		};

		/** 星体与标签的色相：全部取自 DSH 既有状态色，不引入新色板。 */
		const KIND_COLOR = {
			fact: "var(--dsw-alias-brand-primary)",
			decision: "var(--dsw-alias-state-warn-primary)",
			fix: "var(--dsw-alias-state-success-primary)",
			pref: "var(--dsw-static-violet-500, #8b76f6)",
			howto: "var(--dsw-alias-state-business-primary)",
			concept: "var(--dsw-alias-state-error-primary)",
			intent: "var(--dsw-alias-state-warn-secondary)",
			episode: "var(--dsw-alias-label-caption)",
			segment: "var(--dsw-alias-border-l4)",
			todo: "var(--dsw-alias-label-tertiary)",
			state: "var(--dsw-alias-label-secondary)",
			artifact: "var(--dsw-alias-state-idle-primary)",
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
			if (!response.ok || payload.ok === false) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			return payload.data;
		}

		/** 时间戳 → `MM-DD HH:mm`。 */
		function when(ts) {
			const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/** 相对时间。 */
		function ago(ts) {
			const ms = Number(ts) > 1e11 ? Number(ts) : Number(ts) * 1000;
			const days = Math.floor((Date.now() - ms) / 86400000);
			if (days <= 0) return "今天";
			if (days === 1) return "昨天";
			if (days < 30) return `${days} 天前`;
			if (days < 365) return `${Math.floor(days / 30)} 个月前`;
			return `${Math.floor(days / 365)} 年前`;
		}

		/** 32 位字符串哈希：星体散布要确定性，刷新前后不能跳。 */
		function hash32(text) {
			let h1 = 0x811c9dc5;
			for (let i = 0; i < text.length; i += 1) {
				h1 ^= text.charCodeAt(i);
				h1 = Math.imul(h1, 0x01000193) >>> 0;
			}
			return h1 >>> 0;
		}

		/**
		 * 星图 + 径向树的混合布局（纯函数，无 DOM）。
		 *
		 * 父枝的角度范围按子枝叶子数切分，深度决定半径；星体挂在自己的主路径枝上，
		 * 用 id 哈希做确定性散布 —— 同一份数据每次渲染一致，刷新不会跳。
		 *
		 * @param {object} input - `{tree, facts, edges, size, maxStars}`。
		 * @returns {{hubs: object[], stars: object[], links: object[]}} 布局结果。
		 */
		function buildGalaxy({ tree = [], facts = [], edges = [], size = 720, maxStars = 500 } = {}) {
			const cx = size / 2;
			const cy = size / 2;
			const maxDepth = tree.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
			const usable = size * 0.46;
			const ringFor = (depth) => (maxDepth <= 0 ? usable * 0.5 : (usable * (depth + 1)) / (maxDepth + 1));

			const byPath = new Map();
			for (const node of tree) byPath.set(node.path, { ...node, children: [] });
			const roots = [];
			for (const node of byPath.values()) {
				const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
				const parent = byPath.get(parentPath);
				if (parent === undefined) roots.push(node);
				else parent.children.push(node);
			}

			const leafCount = (node) => {
				if (node.children.length === 0) return 1;
				let total = 0;
				for (const child of node.children) total += leafCount(child);
				return total;
			};

			const hubs = [];
			const place = (node, startAngle, endAngle, depth) => {
				const mid = (startAngle + endAngle) / 2;
				const radius = ringFor(depth);
				const x = cx + Math.cos(mid) * radius;
				const y = cy + Math.sin(mid) * radius;
				hubs.push({
					path: node.path,
					label: node.path.split("/").pop() || node.path,
					depth,
					count: node.count ?? 0,
					x,
					y,
					radius,
					angle: mid,
				});
				let cursor = startAngle;
				const span = endAngle - startAngle;
				const totalLeaves = node.children.reduce((sum, child) => sum + leafCount(child), 0) || 1;
				for (const child of node.children) {
					const childSpan = (span * leafCount(child)) / totalLeaves;
					place(child, cursor, cursor + childSpan, depth + 1);
					cursor += childSpan;
				}
			};

			const rootTotal = roots.reduce((sum, node) => sum + leafCount(node), 0) || 1;
			let cursor = -Math.PI / 2;
			for (const root of roots) {
				const span = (Math.PI * 2 * leafCount(root)) / rootTotal;
				place(root, cursor, cursor + span, 0);
				cursor += span;
			}

			const hubOf = new Map(hubs.map((hub) => [hub.path, hub]));
			const stars = [];
			for (const fact of facts.slice(0, maxStars)) {
				const home = hubOf.get(fact.path) ?? hubs[0];
				if (home === undefined) continue;
				const seed = hash32(fact.id);
				const angle = ((seed % 360) / 360) * Math.PI * 2;
				const spread = 14 + ((seed >>> 9) % 26);
				const confidence = Number(fact.confidence ?? 0.6);
				stars.push({
					id: fact.id,
					title: fact.title,
					kind: fact.kind,
					path: fact.path,
					ts: Number(fact.ts ?? 0),
					x: home.x + Math.cos(angle) * spread,
					y: home.y + Math.sin(angle) * spread,
					r: 2 + confidence * 2.2 + (((seed >>> 17) % 12) / 12) * 1.2,
					home: home.path,
					color: KIND_COLOR[fact.kind] ?? KIND_COLOR.fact,
				});
			}

			const starById = new Map(stars.map((s) => [s.id, s]));
			const links = [];
			for (const star of stars) {
				const home = hubOf.get(star.home);
				if (home !== undefined) links.push({ x1: home.x, y1: home.y, x2: star.x, y2: star.y, kind: "spine" });
			}
			for (const edge of edges) {
				const a = starById.get(edge.src);
				const b = starById.get(edge.dst);
				if (a !== undefined && b !== undefined) {
					links.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: edge.rel ?? "related" });
				}
			}

			return { hubs, stars, links, radius: usable, center: { x: cx, y: cy } };
		}

		/** 注入面板样式（幂等）。全部走 DSH 令牌，缺省值只在令牌缺失时兜底。 */
		function injectStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
.dkb-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;position:relative;}
.dkb-bar{display:flex;align-items:center;gap:6px;padding:0 20px;height:56px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l2);}
.dkb-search{flex:1 1 auto;min-width:120px;height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;}
.dkb-search::placeholder{color:var(--dsw-alias-label-caption);}
.dkb-search:focus{border-color:var(--dsw-alias-state-business-primary);}
.dkb-btn{height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;}
.dkb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dkb-btn[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dkb-btn:disabled{opacity:.4;cursor:not-allowed;}
.dkb-stat{font-size:12px;color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums;}
.dkb-cols{display:flex;flex:1 1 auto;min-height:0;}
.dkb-col{border-right:1px solid var(--dsw-alias-border-l2);overflow:auto;min-height:0;scrollbar-width:thin;}
.dkb-tree{flex:0 0 216px;padding:8px;}
.dkb-list{flex:0 0 42%;min-width:240px;}
.dkb-detail{flex:1 1 auto;border-right:none;padding:20px 24px;}
.dkb-node{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;}
.dkb-node:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dkb-node[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dkb-node .n{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}
.dkb-row{padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer;}
.dkb-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dkb-row[data-active="1"]{background:var(--dsw-alias-bg-layer-2);}
.dkb-row .t{display:flex;align-items:center;gap:8px;min-width:0;}
.dkb-kind{flex:0 0 auto;font-size:11px;line-height:16px;padding:0 6px;border-radius:var(--dsw-radius-sm);border:1px solid currentColor;opacity:.9;}
.dkb-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;}
.dkb-ex{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
.dkb-meta{display:flex;gap:10px;color:var(--dsw-alias-label-caption);font-size:11px;margin-top:6px;flex-wrap:wrap;}
.dkb-body{white-space:pre-wrap;line-height:1.75;color:var(--dsw-alias-label-secondary);font-size:13px;}
.dkb-title-lg{font-size:16px;font-weight:600;margin:8px 0 6px;}
.dkb-tag{display:inline-block;font-size:11px;line-height:18px;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin:0 6px 6px 0;}
.dkb-rel{display:flex;gap:8px;padding:4px 0;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;}
.dkb-rel:hover{color:var(--dsw-alias-link);}
.dkb-sec{margin:20px 0 8px;font-size:11px;line-height:16px;letter-spacing:.04em;color:var(--dsw-alias-label-caption);text-transform:uppercase;}
.dkb-empty{color:var(--dsw-alias-label-caption);padding:20px;font-size:13px;line-height:1.7;}
.dkb-err{margin:12px 20px 0;padding:8px 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-label-primary);font-size:12px;white-space:pre-wrap;}
.dkb-graph{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;}
.dkb-graph svg{display:block;width:100%;height:100%;cursor:grab;}
.dkb-graph[data-drag="1"] svg{cursor:grabbing;}
.dkb-gbar{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:6px;padding:0 16px;pointer-events:none;}
.dkb-gbar>*{pointer-events:auto;}
.dkb-legend{position:absolute;top:12px;right:16px;display:flex;gap:12px;flex-wrap:wrap;max-width:60%;justify-content:flex-end;font-size:11px;color:var(--dsw-alias-label-caption);pointer-events:none;}
.dkb-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle;}
.dkb-hint{position:absolute;left:16px;bottom:12px;font-size:11px;color:var(--dsw-alias-label-caption);pointer-events:none;}
.dkb-hublabel{fill:var(--dsw-alias-label-tertiary);font-size:11px;pointer-events:none;user-select:none;}
.dkb-star{transition:r 120ms ease;cursor:pointer;}
.dkb-composer{position:absolute;top:64px;left:20px;width:min(440px,calc(100% - 40px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:16px;z-index:5;box-shadow:0 12px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:10px;}
.dkb-composer label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);letter-spacing:.04em;}
.dkb-composer input,.dkb-composer textarea,.dkb-composer select{height:32px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);padding:0 10px;font:inherit;font-size:13px;outline:none;width:100%;}
.dkb-composer textarea{height:auto;min-height:120px;padding:8px 10px;line-height:1.6;resize:vertical;}
.dkb-composer .row{display:flex;gap:10px;}
.dkb-composer .row>*{flex:1 1 0;}
.dkb-composer .actions{display:flex;gap:8px;justify-content:flex-end;}
.dkb-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}
.dkb-primary:hover{background:var(--dsw-alias-button-primary-fill);opacity:.9;color:var(--dsw-alias-label-primary-foreground);}
`;
			document.head.append(style);
		}

		/** 侧边栏图标：一点星核 + 一圈轨道。 */
		function MemoryIcon({ size }) {
			const s = size ?? 18;
			return h(
				"svg",
				{ width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("circle", { cx: 8, cy: 8, r: 2.2, fill: "currentColor" }),
				h("ellipse", {
					cx: 8,
					cy: 8,
					rx: 6.2,
					ry: 3.1,
					stroke: "currentColor",
					"stroke-width": 1,
					"stroke-opacity": 0.5,
					transform: "rotate(-28 8 8)",
				}),
				h("circle", { cx: 13.1, cy: 5.4, r: 1.05, fill: "currentColor" }),
			);
		}

		/** 卡类型标签。 */
		function KindChip({ kind }) {
			return h("span", { className: "dkb-kind", style: { color: KIND_COLOR[kind] ?? KIND_COLOR.fact } }, KIND_LABEL[kind] ?? kind);
		}

		/** 骨架树。 */
		function TreePane({ nodes, active, onPick }) {
			if (nodes.length === 0) return h("div", { className: "dkb-empty" }, "树是空的。先吸收会话或写一张卡。");
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
							style: { paddingLeft: `${8 + node.depth * 12}px` },
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
				h("div", { className: "t" }, h(KindChip, { kind: item.kind }), h("span", { className: "dkb-title", title: item.title }, item.title)),
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

		/** 详情：正文 + 实体 + 关系 + 历史 + 操作。 */
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
					h("span", null, `v${f.version ?? 1}`),
					f.status === "active" ? null : h("span", null, f.status),
				),
				f.tags.length > 0 ? h("div", { style: { marginTop: 10 } }, f.tags.map((t) => h("span", { key: t, className: "dkb-tag" }, t))) : null,
				h("div", { className: "dkb-sec" }, "正文"),
				h("div", { className: "dkb-body" }, f.body || "(空)"),
				f.paths.length > 1
					? h("div", null, h("div", { className: "dkb-sec" }, "多归属"), f.paths.map((p) => h("span", { key: p, className: "dkb-tag" }, p)))
					: null,
				detail.mentions !== undefined && detail.mentions.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `提及 ${detail.mentions.length}`),
							detail.mentions.map((m) => h("span", { key: `${m.type}:${m.token}`, className: "dkb-tag", title: m.type }, m.token)),
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
				detail.history !== undefined && detail.history.length > 0
					? h(
							"div",
							null,
							h("div", { className: "dkb-sec" }, `历史版本 ${detail.history.length}`),
							detail.history.map((v) => h("div", { key: v.version, className: "dkb-rel", title: v.body }, h("span", null, `v${v.version}`), h("span", { className: "dkb-title" }, v.title))),
						)
					: null,
				h("div", { className: "dkb-sec" }, "操作"),
				h(
					"div",
					{ style: { display: "flex", gap: 8 } },
					h(
						"button",
						{ className: "dkb-btn", onClick: () => onForget(f.id), disabled: f.status !== "active", title: "标为失效（保留可查，不删）" },
						f.status === "active" ? "标失效" : `已 ${f.status}`,
					),
				),
				h("div", { className: "dkb-sec" }, "引用"),
				h("div", { className: "dkb-tag" }, f.id),
			);
		}

		/**
		 * 星图 + 径向树。滚轮缩放、拖拽平移、点星选卡。
		 *
		 * 不做力导向：几百颗星上重力迭代是每帧 O(n²)，而这块面板的用途是"看脉络"，
		 * 不是"看动画"。径向树的角度分配天然表达"这个枝下有多少卡"。
		 */
		function GraphPane({ tree, facts, edges, onPick, mode, onMode }) {
			const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
			const [hover, setHover] = useState(null);
			const drag = useRef(null);
			const SIZE = 720;

			const layout = useMemo(
				() => buildGalaxy({ tree, facts: mode === "tree" ? [] : facts, edges: mode === "tree" ? [] : edges, size: SIZE }),
				[tree, facts, edges, mode],
			);

			const onWheel = useCallback((event) => {
				event.preventDefault();
				setView((prev) => ({ ...prev, k: Math.min(3, Math.max(0.4, prev.k * Math.exp(-event.deltaY * 0.0012))) }));
			}, []);
			const onDown = useCallback((event) => {
				drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
			}, [view.tx, view.ty]);
			const onMove = useCallback((event) => {
				if (drag.current === null) return;
				setView((prev) => ({ ...prev, tx: drag.current.tx + (event.clientX - drag.current.x), ty: drag.current.ty + (event.clientY - drag.current.y) }));
			}, []);
			const onUp = useCallback(() => {
				drag.current = null;
			}, []);

			const kinds = [...new Set(layout.stars.map((s) => s.kind))];
			return h(
				"div",
				{
					className: "dkb-graph",
					"data-drag": drag.current === null ? "0" : "1",
					onWheel,
					onPointerDown: onDown,
					onPointerMove: onMove,
					onPointerUp: onUp,
					onPointerLeave: onUp,
				},
				h(
					"div",
					{ className: "dkb-gbar" },
					h("button", { className: "dkb-btn", "data-active": mode === "star" ? "1" : "0", onClick: () => onMode("star") }, "星图"),
					h("button", { className: "dkb-btn", "data-active": mode === "tree" ? "1" : "0", onClick: () => onMode("tree") }, "树状"),
					h("button", { className: "dkb-btn", onClick: () => setView({ k: 1, tx: 0, ty: 0 }) }, "复位"),
					hover === null ? null : h("span", { className: "dkb-stat", style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 } }, hover),
				),
				h(
					"svg",
					{ viewBox: `0 0 ${SIZE} ${SIZE}`, preserveAspectRatio: "xMidYMid meet" },
					h(
						"g",
						{ transform: `translate(${SIZE / 2 + view.tx} ${SIZE / 2 + view.ty}) scale(${view.k}) translate(${-SIZE / 2} ${-SIZE / 2})` },
						layout.links.map((link, index) =>
							h("line", {
								key: `l${index}`,
								x1: link.x1,
								y1: link.y1,
								x2: link.x2,
								y2: link.y2,
								stroke: link.kind === "spine" ? "var(--dsw-alias-border-l3)" : "var(--dsw-alias-state-business-tertiary)",
								"stroke-width": link.kind === "spine" ? 0.8 : 1.1,
								"stroke-opacity": link.kind === "spine" ? 0.5 : 0.9,
							}),
						),
						layout.hubs.map((hub) =>
							h(
								"g",
								{ key: `h:${hub.path}` },
								h("circle", {
									cx: hub.x,
									cy: hub.y,
									r: 3.2,
									fill: "var(--dsw-alias-bg-base)",
									stroke: "var(--dsw-alias-label-tertiary)",
									"stroke-width": 1,
								}),
								h(
									"text",
									{
										className: "dkb-hublabel",
										x: hub.x + (Math.cos(hub.angle) >= 0 ? 7 : -7),
										y: hub.y + 3,
										"text-anchor": Math.cos(hub.angle) >= 0 ? "start" : "end",
									},
									`${hub.label}${hub.count ? ` ${hub.count}` : ""}`,
								),
							),
						),
						layout.stars.map((star) =>
							h("circle", {
								key: star.id,
								className: "dkb-star",
								cx: star.x,
								cy: star.y,
								r: star.r,
								fill: star.color,
								"fill-opacity": 0.9,
								onClick: () => onPick(star.id),
								onPointerEnter: () => setHover(star.title),
								onPointerLeave: () => setHover(null),
							}),
						),
					),
				),
				kinds.length === 0
					? null
					: h(
							"div",
							{ className: "dkb-legend" },
							kinds.map((kind) =>
								h("span", { key: kind }, h("i", { style: { background: KIND_COLOR[kind] ?? KIND_COLOR.fact } }), KIND_LABEL[kind] ?? kind),
							),
						),
				h(
					"div",
					{ className: "dkb-hint" },
					`${layout.hubs.length} 个枝 · ${layout.stars.length} 颗星${facts.length > layout.stars.length ? `（前 ${layout.stars.length}/${facts.length}）` : ""} · 滚轮缩放 · 拖动平移`,
				),
			);
		}

		/** 主页面：状态都在这里，子面板只负责画。 */
		function MemoryPage() {
			const [mode, setMode] = useState("list");
			const [graphMode, setGraphMode] = useState("star");
			const [query, setQuery] = useState("");
			const [pathFilter, setPathFilter] = useState("");
			const [list, setList] = useState({ items: [], total: 0 });
			const [tree, setTree] = useState([]);
			const [stats, setStats] = useState(null);
			const [graph, setGraph] = useState({ nodes: [], edges: [] });
			const [detail, setDetail] = useState(null);
			const [selected, setSelected] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);
			const [draft, setDraft] = useState(null);
			const timer = useRef(null);

			const loadShell = useCallback(async () => {
				try {
					const [treeRows, statsData] = await Promise.all([call("/tree"), call("/stats")]);
					setTree(treeRows);
					setStats(statsData);
					setError(null);
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, []);

			const loadList = useCallback(async (q, pathValue) => {
				try {
					if (q.trim() !== "") {
						const rows = await call("/search", { query: { q: q.trim(), k: 40, path: pathValue || undefined } });
						setList({ items: rows, total: rows.length });
					} else {
						setList(await call("/facts", { query: { limit: 80, status: "active", path: pathValue || undefined } }));
					}
					setError(null);
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, []);

			useEffect(() => {
				injectStyle();
				loadShell();
			}, [loadShell]);

			useEffect(() => {
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => loadList(query, pathFilter), 260);
				return () => {
					if (timer.current !== null) clearTimeout(timer.current);
				};
			}, [query, pathFilter, loadList]);

			const openFact = useCallback(async (id) => {
				setSelected(id);
				try {
					setDetail(await call("/fact", { query: { id } }));
				} catch (e) {
					setDetail(null);
					setError(String(e.message ?? e));
				}
			}, []);

			const loadGraph = useCallback(async () => {
				try {
					setGraph(await call("/graph", { query: { path: pathFilter || undefined, limit: 400 } }));
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, [pathFilter]);

			useEffect(() => {
				if (mode === "graph") loadGraph();
			}, [mode, loadGraph]);

			const runIngest = useCallback(async () => {
				setBusy(true);
				try {
					const result = await call("/ingest", { body: {} });
					await loadShell();
					await loadList(query, pathFilter);
					setError(`直接提取完成：${result.added ?? 0} 张新卡 / ${result.files ?? 0} 个会话 / ${result.staled ?? 0} 张降级`);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [loadShell, loadList, query, pathFilter]);

			const runDistill = useCallback(async () => {
				setBusy(true);
				try {
					const result = await call("/distill", { body: { path: pathFilter || undefined, limit: 12 } });
					await loadShell();
					await loadList(query, pathFilter);
					setError(
						result.distilled === undefined
							? `提炼出料：${result.material} 段原料（当前没有可用的模型通道，交给会话来提炼）`
							: `模型提炼完成：${result.distilled} 张卡（用了 ${result.provider}/${result.model}）`,
					);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [loadShell, loadList, query, pathFilter]);

			const saveDraft = useCallback(async () => {
				if (draft === null) return;
				if (draft.title.trim() === "" || draft.body.trim() === "") {
					setError("标题和正文都要填。");
					return;
				}
				try {
					const result = await call("/add", {
						body: { title: draft.title, body: draft.body, path: draft.path || undefined, kind: draft.kind, tags: draft.tags },
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

			const head = useMemo(() => {
				if (stats === null) return "记忆库";
				return `${stats.facts} 卡 · ${stats.edges} 边 · ${stats.mentions ?? 0} 实体`;
			}, [stats]);

			return h(
				"div",
				{ className: "dkb-root" },
				h(
					"div",
					{ className: "dkb-bar" },
					h("input", {
						className: "dkb-search",
						value: query,
						placeholder: "检索记忆（中文双字词可命中）",
						onChange: (e) => setQuery(e.target.value),
					}),
					h("button", { className: "dkb-btn", "data-active": mode === "list" ? "1" : "0", onClick: () => setMode("list") }, "列表"),
					h("button", { className: "dkb-btn", "data-active": mode === "graph" ? "1" : "0", onClick: () => setMode("graph") }, "图谱"),
					h("button", { className: "dkb-btn", onClick: runIngest, disabled: busy }, busy ? "处理中…" : "直接提取"),
					h("button", { className: "dkb-btn", onClick: runDistill, disabled: busy }, "模型提炼"),
					h(
						"button",
						{
							className: "dkb-btn",
							"data-active": draft === null ? "0" : "1",
							onClick: () => setDraft(draft === null ? { title: "", body: "", path: pathFilter || "", kind: "fact", tags: "" } : null),
						},
						"新建",
					),
					h("span", { className: "dkb-stat" }, head),
				),
				draft === null
					? null
					: h(
							"div",
							{ className: "dkb-composer" },
							h("label", null, "标题"),
							h("input", { value: draft.title, placeholder: "一句话结论", onChange: (e) => setDraft({ ...draft, title: e.target.value }) }),
							h("label", null, "正文"),
							h("textarea", {
								value: draft.body,
								placeholder: "现象、根因、做法、边界（三个月后单看能懂）",
								onChange: (e) => setDraft({ ...draft, body: e.target.value }),
							}),
							h(
								"div",
								{ className: "row" },
								h("input", { value: draft.path, placeholder: "归枝路径，如 topic/dsh", onChange: (e) => setDraft({ ...draft, path: e.target.value }) }),
								h(
									"select",
									{ value: draft.kind, onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
									Object.keys(KIND_LABEL).map((k) => h("option", { key: k, value: k }, KIND_LABEL[k])),
								),
							),
							h("input", { value: draft.tags, placeholder: "标签，逗号分隔", onChange: (e) => setDraft({ ...draft, tags: e.target.value }) }),
							h(
								"div",
								{ className: "actions" },
								h("button", { className: "dkb-btn", onClick: () => setDraft(null) }, "取消"),
								h("button", { className: "dkb-btn dkb-primary", onClick: saveDraft }, "写入"),
							),
						),
				error === null ? null : h("div", { className: "dkb-err" }, error),
				mode === "graph"
					? h(GraphPane, { tree, facts: graph.nodes, edges: graph.edges, onPick: openFact, mode: graphMode, onMode: setGraphMode })
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
		/** 布局是纯函数，导出给测试用（不参与面板逻辑）。 */
		exports.__layout = buildGalaxy;
		exports.default = apply;
		return module.exports;
	},
});
