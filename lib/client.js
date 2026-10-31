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

		/**
		 * 把前端错误送到后端日志。
		 *
		 * 面板空壳时最麻烦的不是报错，是**没人看得见报错** —— 用户在界面上只能看到空白，
		 * 浏览器控制台不会有人去翻。所以凡是 catch 到的东西都往 front.log 写一行。
		 * 上报本身失败也静默：日志不该成为新的故障源。
		 */
		function report(level, message, detail = {}) {
			try {
				const body = JSON.stringify({
					level,
					message: String(message ?? "").slice(0, 800),
					stack: detail.stack === undefined ? undefined : String(detail.stack),
					extra: detail.extra,
				});
				void fetch(`${API}/frontlog`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					keepalive: true,
				}).catch(() => {});
			} catch {
				// 忽略
			}
		}
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
		/**
		 * 拼查询串，顺手清掉 undefined / null / 空串。
		 *
		 * 这一步不是洁癖：`new URLSearchParams({ path: undefined })` 会产出
		 * **字符串 "undefined"**，后端把它当成路径前缀去 LIKE，于是查 0 条 ——
		 * 界面表现就是"树有数据、列表和画布全空"。这个坑踩过一次，别再踩。
		 *
		 * @param {Record<string, unknown>} params - 原始参数。
		 * @returns {string} 形如 `?a=1&b=2` 的串；全空时返回空串。
		 */
		function buildQuery(params) {
			const entries = Object.entries(params ?? {}).filter(
				([, value]) => value !== undefined && value !== null && String(value).trim() !== "",
			);
			return entries.length === 0 ? "" : `?${new URLSearchParams(entries).toString()}`;
		}

		async function call(path, options = {}) {
			const query = buildQuery(options.query);
			const init = { method: options.body === undefined ? "GET" : "POST", headers: {} };
			if (options.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(options.body);
			}
			const response = await fetch(`${API}${path}${query}`, init);
			const payload = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }));
			if (payload.ok === false) report("api", `${options.body === undefined ? "GET" : "POST"} ${path} -> ${response.status}`, { extra: { error: payload.error } });
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

		/**
		 * 渲染兜底：面板里任何一层抛错都不该变成"白屏且没有任何线索"。
		 * React.Component 万一不可用（精简版 React）就降级成透明包装，至少不连坐。
		 */
		const Boundary =
			typeof React.Component === "function"
				? class PanelBoundary extends React.Component {
						constructor(props) {
							super(props);
							this.state = { error: null };
						}
						static getDerivedStateFromError(error) {
							return { error };
						}
						componentDidCatch(error, info) {
							report("render", error?.message ?? error, { stack: error?.stack, extra: { componentStack: info?.componentStack } });
						}
						render() {
							if (this.state.error !== null) {
								return h(
									"div",
									{ className: "dkb-err", style: { margin: 20 } },
									`面板渲染失败：${String(this.state.error?.message ?? this.state.error)}（详情已写入 front.log）`,
								);
							}
							return this.props.children;
						}
					}
				: (props) => props.children;

		/**
		 * 32 位字符串哈希：星体散布要确定性，刷新前后不能跳。
		 * @param {string} text - 任意串。
		 * @returns {number} 32 位无符号整数。
		 */
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
							parentPath: node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "",
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
		
					// 骨架连线：没有它，"径向树"只是散落的圆点，看不出层级。
		
					// 这是"树状"那一半真正的形状 —— 父枝到子枝的实线。
		
					for (const hub of hubs) {
		
						if (!hub.parentPath) continue;
		
						const parent = hubOf.get(hub.parentPath);
		
						if (parent !== undefined) links.push({ kind: "tree", x1: parent.x, y1: parent.y, x2: hub.x, y2: hub.y });
		
					}
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

		/** 类型筛选的选项（值, 显示名）。值直接对应 kind 字段。 */
		const KIND_FILTER = [
			["", "全部类型"],
			["fact", "事实"],
			["decision", "决定"],
			["fix", "修复"],
			["howto", "做法"],
			["concept", "概念"],
			["pref", "偏好"],
			["episode", "会话"],
			["intent", "意图"],
		];

		/** 时间筛选：单位天，空串表示不限。 */
		const SINCE_FILTER = [
			["", "不限时间"],
			["7", "近 7 天"],
			["30", "近 30 天"],
			["90", "近 90 天"],
			["365", "近一年"],
		];

		/** 状态筛选。 */
		const STATUS_FILTER = [
			["active", "在用"],
			["doubtful", "存疑"],
			["superseded", "已取代"],
			["", "全部状态"],
		];

		/** 排序。值对应后端 /facts 的 sort 白名单。 */
		const SORT_FILTER = [
			["ts", "最新在前"],
			["oldest", "最早在前"],
			["title", "按标题"],
		];

		/** 卡片图标里的字。没有图标库，用汉字最省事也最有辨识度。 */
		const GROUP_GLYPH = { memory: "记", doc: "文", talk: "话", project: "项", task: "务" };

		/** 卡片节点尺寸与间距。布局与渲染共用这一份，避免两边漂移。 */
		const CARD = { w: 226, h: 74, gapX: 14, gapY: 14, pad: 14, head: 20, blockGap: 34, cols: 2, perRowBlocks: 3, perBlock: 6 };

		/** 边关系的显示名。设计稿是九种语义，库里目前有前四种，其余为 L2 预留。 */
		const REL_LABEL = {
			contains: "包含",
			related: "关联",
			supersedes: "取代",
			derived_from: "来源于",
			mention: "提及",
			produces: "产生了",
			references: "引用了",
			transforms: "转化为",
			applies_to: "应用于",
			affects: "影响",
		};

		/** 顶部类型 chips：把十种 kind 收成设计稿那五类。 */
		const GROUPS = [
			{ id: "all", label: "全部", test: () => true },
			{ id: "memory", label: "记忆", test: (kind) => ["fact", "decision", "concept", "fix", "pref", "howto"].includes(kind) },
			{ id: "doc", label: "文档", test: (kind) => kind === "artifact" },
			{ id: "talk", label: "对话", test: (kind) => kind === "episode" || kind === "intent" },
			{ id: "project", label: "项目", test: (kind, factPath) => String(factPath ?? "").startsWith("project/") },
			{ id: "task", label: "任务", test: (kind) => kind === "todo" || kind === "state" },
		];

		/**
		 * 卡片属于哪个组（顶部 chips 过滤 + 卡片图标色）。
		 * @param {{kind: string, path: string}} fact - 卡。
		 * @returns {string} 组 id。
		 */
		function groupOf(fact) {
			for (const group of GROUPS) {
				if (group.id === "all") continue;
				if (group.test(fact.kind, fact.path)) return group.id;
			}
			return "memory";
		}

		/**
		 * 卡片画布布局（纯函数，无 DOM）。
		 *
		 * 骨架路径决定"块"：一个 path 一块，块内卡片按两列网格排；块按行排，每行三块。
		 * 好处是分类结构一眼可见，且卡片有足够宽度显示标题与标签 —— 圆点星图做不到这件事。
		 * 坐标是确定性的（顺序只取决于 tree 与 facts 的输入顺序），刷新不跳。
		 *
		 * @param {object} input - `{tree, facts, edges, maxStars}`。
		 * @returns {{hubs: object[], stars: object[], links: object[], width: number, height: number}} 布局。
		 */
		function buildCanvas({ tree = [], facts = [], edges = [], maxStars = 400, perBlock = CARD.perBlock } = {}) {
			const known = new Set(tree.map((node) => node.path));
			const depthOf = new Map(tree.map((node) => [node.path, node.depth ?? 0]));
			const picked = facts.slice(0, Math.max(0, maxStars));

			/** 保持 tree 的路径顺序，未登记的路径归到空串（显示为 inbox）。 */
			const buckets = new Map();
			for (const node of tree) buckets.set(node.path, []);
			for (const fact of picked) {
				const key = known.has(fact.path) ? fact.path : "";
				if (!buckets.has(key)) buckets.set(key, []);
				buckets.get(key).push(fact);
			}

			const hubs = [];
			const stars = [];
			let cursorX = 0;
			let cursorY = 0;
			let rowH = 0;
			let inRow = 0;
			for (const [path, items] of buckets) {
				if (items.length === 0) continue;
				const shown = items.slice(0, Math.max(1, perBlock));
				const rows = Math.ceil(shown.length / CARD.cols);
				const w = CARD.pad * 2 + CARD.cols * CARD.w + (CARD.cols - 1) * CARD.gapX;
				const h = CARD.pad * 2 + CARD.head + rows * CARD.h + (rows - 1) * CARD.gapY;
				if (inRow >= CARD.perRowBlocks) {
					cursorX = 0;
					cursorY += rowH + CARD.blockGap;
					rowH = 0;
					inRow = 0;
				}
				const hub = {
					path,
					label: path === "" ? "inbox" : path.split("/").pop() || path,
					full: path === "" ? "inbox" : path,
					depth: depthOf.get(path) ?? (path === "" ? 0 : path.split("/").length - 1),
					count: items.length,
					shown: shown.length,
					x: cursorX,
					y: cursorY,
					w,
					h,
				};
				hubs.push(hub);
				cursorX += w + CARD.blockGap;
				rowH = Math.max(rowH, h);
				inRow += 1;

				shown.forEach((fact, index) => {
					const col = index % CARD.cols;
					const row = Math.floor(index / CARD.cols);
					stars.push({
						id: fact.id,
						title: fact.title,
						kind: fact.kind,
						path: fact.path,
						ts: Number(fact.ts ?? 0),
						tags: Array.isArray(fact.tags) ? fact.tags.slice(0, 3) : [],
						group: fact.grp ?? groupOf(fact),
						x: hub.x + CARD.pad + col * (CARD.w + CARD.gapX),
						y: hub.y + CARD.pad + CARD.head + row * (CARD.h + CARD.gapY),
						w: CARD.w,
						h: CARD.h,
						home: path,
						color: KIND_COLOR[fact.kind] ?? KIND_COLOR.fact,
					});
				});
			}

			const width = hubs.reduce((max, hub) => Math.max(max, hub.x + hub.w), 0);
			const height = hubs.reduce((max, hub) => Math.max(max, hub.y + hub.h), 0);

			const starAt = new Map(stars.map((star) => [star.id, star]));
			const mid = (item) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
			// 不画"块 → 卡"的归属线：块的包围关系已经表达了归属，再从块心发散一堆短线
			// 只是噪声。画布上只留**卡片之间**的真实关系，那才是图要看的东西。
			const links = [];
			// 事实边的标签只画前 40 条：再多就成噪声，看图的人只会看到一片糊。
			let tagged = 0;
			for (const edge of edges) {
				const a = starAt.get(edge.src);
				const b = starAt.get(edge.dst);
				if (a === undefined || b === undefined) continue;
				const pa = mid(a);
				const pb = mid(b);
				const rel = String(edge.rel ?? "related");
				links.push({
					kind: rel,
					rel,
					label: REL_LABEL[rel] ?? rel,
					x1: pa.x,
					y1: pa.y,
					x2: pb.x,
					y2: pb.y,
					mx: (pa.x + pb.x) / 2,
					my: (pa.y + pb.y) / 2,
					tagged: tagged < 40,
				});
				tagged += 1;
			}

			return { hubs, stars, links, width, height, card: CARD, total: facts.length, truncated: picked.length < facts.length };
		}

		/** 注入面板样式（幂等）。全部走 DSH 令牌，缺省值只在令牌缺失时兜底。 */
		function injectStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
.dkb-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;position:relative;}
/* 所有控件共用一套高度与间距 —— 之前搜索框 32px、按钮 28px、chip 26px，
   三种高度混在一行里，怎么调都像"对不上位置"。 */
.dkb-root{--dkb-h:30px;--dkb-gap:8px;}
.dkb-bar{display:flex;align-items:center;gap:var(--dkb-gap);padding:0 20px;height:56px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l2);}
.dkb-search{flex:1 1 auto;min-width:140px;max-width:560px;height:var(--dkb-h);padding:0 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;box-sizing:border-box;}
.dkb-search:focus{border-color:var(--dsw-alias-state-business-primary);}
.dkb-search::placeholder{color:var(--dsw-alias-label-caption);}
.dkb-search:focus{border-color:var(--dsw-alias-state-business-primary);}
.dkb-btn{display:inline-flex;align-items:center;justify-content:center;height:var(--dkb-h);padding:0 12px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;box-sizing:border-box;transition:background 120ms ease,border-color 120ms ease,color 120ms ease;}
.dkb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dkb-btn[data-active="1"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary);font-weight:600;}
.dkb-btn:disabled{opacity:.4;cursor:not-allowed;}
.dkb-stat{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums;}
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
.dkb-hint{position:absolute;left:12px;bottom:10px;padding:2px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-caption);pointer-events:none;}
.dkb-composer{position:absolute;top:64px;left:20px;width:min(440px,calc(100% - 40px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:16px;z-index:5;box-shadow:0 12px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:10px;}
.dkb-composer label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);letter-spacing:.04em;}
.dkb-composer input,.dkb-composer textarea,.dkb-composer select{height:32px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);padding:0 10px;font:inherit;font-size:13px;outline:none;width:100%;}
.dkb-composer textarea{height:auto;min-height:120px;padding:8px 10px;line-height:1.6;resize:vertical;}
.dkb-composer .row{display:flex;gap:10px;}
.dkb-composer .row>*{flex:1 1 0;}
.dkb-composer .actions{display:flex;gap:8px;justify-content:flex-end;}
.dkb-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}
.dkb-primary:hover{background:var(--dsw-alias-button-primary-fill);opacity:.9;color:var(--dsw-alias-label-primary-foreground);}

/* ---- 画布：卡片节点 + 边标签（对齐设计稿的图谱形态） ---- */
.dkb-stage{flex:1 1 auto;min-height:280px;display:flex;position:relative;overflow:hidden;}
.dkb-vp{flex:1 1 auto;min-width:0;position:relative;overflow:hidden;cursor:grab;}
.dkb-vp[data-drag="1"]{cursor:grabbing;}
.dkb-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;}
.dkb-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;}
.dkb-edge{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.2;}
.dkb-edge[data-rel="related"]{stroke:var(--dsw-alias-state-business-primary);stroke-width:1.6;stroke-opacity:.55;}
.dkb-edge[data-rel="spine"]{stroke-dasharray:3 4;stroke-opacity:.45;}
.dkb-elabel{fill:var(--dsw-alias-label-caption);font-size:9.5px;pointer-events:none;user-select:none;}
.dkb-ecap{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1;}
.dkb-card{position:absolute;box-sizing:border-box;display:flex;gap:9px;padding:10px 11px;border-radius:var(--dsw-radius-lg,12px);
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;
  box-shadow:0 1px 2px rgba(0,0,0,.06);transition:border-color 120ms ease,box-shadow 120ms ease,transform 120ms ease;}
.dkb-card:hover{border-color:var(--dsw-alias-border-l4);box-shadow:0 4px 14px rgba(0,0,0,.12);}
.dkb-card[data-active="1"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary),0 6px 18px rgba(0,0,0,.16);}
.dkb-card .ico{flex:0 0 auto;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600;}
.dkb-card .main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}
.dkb-card .k{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-caption);letter-spacing:.02em;}
.dkb-card .t{font-size:12.5px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dkb-card .chips{display:flex;gap:4px;flex-wrap:nowrap;overflow:hidden;}
.dkb-card .chips span{flex:0 0 auto;font-size:9.5px;line-height:14px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);}
.dkb-card .d{font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}
.dkb-block{position:absolute;border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);opacity:.5;}
/* ---- 星图：径向骨架 + 星体 ---- */
.dkb-star-svg{display:block;width:100%;height:100%;cursor:grab;}
.dkb-vp[data-drag="1"] .dkb-star-svg{cursor:grabbing;}
.dkb-star{cursor:pointer;transition:fill-opacity 140ms ease,r 140ms ease;}
.dkb-starg:hover .dkb-star{fill-opacity:1;r:calc(var(--r, 3px) + 1px);}
.dkb-star-hit{cursor:pointer;}
.dkb-star-hit:hover + .dkb-star{fill-opacity:1;}
.dkb-star-ring{animation:dkb-pulse 1.4s ease-in-out infinite;}
@keyframes dkb-pulse{0%,100%{stroke-opacity:.35;}50%{stroke-opacity:1;}}
.dkb-star-svg .dkb-starg{animation:dkb-fade .35s ease-out both;}
@keyframes dkb-fade{from{opacity:0;}to{opacity:1;}}
.dkb-star:hover{fill-opacity:1;}
.dkb-hublabel{fill:var(--dsw-alias-label-tertiary);font-size:11px;pointer-events:none;user-select:none;}
.dkb-blocklabel{position:absolute;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption);pointer-events:none;user-select:none;}

/* ---- 工具条：视图下拉 / 缩放 / 全屏 ---- */
.dkb-toolbar{position:absolute;top:10px;right:12px;display:flex;align-items:center;gap:6px;z-index:3;}
.dkb-zoombox{display:flex;align-items:center;gap:2px;height:28px;padding:0 4px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}
.dkb-zoombox .v{min-width:42px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dkb-chipbar{display:flex;align-items:center;gap:6px;padding:0 20px;height:44px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:none;}
.dkb-chipbar>.dkb-chipspacer{flex:1 1 auto;min-width:8px;}
.dkb-filters{display:flex;align-items:center;gap:var(--dkb-gap);flex:0 0 auto;}
.dkb-select{height:var(--dkb-h);padding:0 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;box-sizing:border-box;}
.dkb-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);}
.dkb-chip{display:inline-flex;align-items:center;height:var(--dkb-h);padding:0 12px;border-radius:15px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;box-sizing:border-box;transition:background 120ms ease,border-color 120ms ease,color 120ms ease;}
.dkb-chip:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dkb-chip[data-active="1"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);}

/* ---- 右侧详情抽屉 ---- */
.dkb-drawer{flex:0 0 400px;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dkb-drawer[data-open="0"]{display:none;}
.dkb-drawer-inner{display:flex;flex-direction:column;height:100%;min-height:0;flex:1 1 auto;}
.dkb-dhead{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:16px 16px 10px;}
.dkb-dhead .ico{flex:0 0 auto;width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:600;}
.dkb-dhead .ht{flex:1 1 auto;min-width:0;}
.dkb-dhead .h1{font-size:17px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dkb-dhead .h2{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-caption);margin-top:2px;}
.dkb-dbody{flex:1 1 auto;min-height:0;overflow:auto;padding:0 16px 16px;scrollbar-width:thin;}
.dkb-dfoot{flex:0 0 auto;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;gap:8px;}
.dkb-relrow{display:flex;align-items:center;gap:8px;padding:7px 0;cursor:pointer;border-radius:var(--dsw-radius-sm);}
.dkb-relrow:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dkb-relrow .ri{flex:0 0 auto;width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;}
.dkb-relrow .rt{flex:1 1 auto;min-width:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dkb-relrow .rk{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-caption);}
.dkb-kv{display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);padding:3px 0;}
.dkb-kv .k{flex:0 0 88px;color:var(--dsw-alias-label-caption);}
.dkb-kv .v{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ---- 底部时间线 ---- */
.dkb-timeline{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);}
.dkb-tlhead{display:flex;align-items:center;gap:4px;height:38px;padding:0 16px;}
.dkb-tlhead .dkb-tlcount{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;}
.dkb-tlnav{display:flex;gap:4px;margin-left:8px;}
.dkb-tlnav .dkb-btn{width:24px;height:24px;padding:0;font-size:14px;line-height:1;}
.dkb-tlnav .dkb-btn:disabled{opacity:.35;cursor:default;}
.dkb-tlwrap{position:relative;}
.dkb-tlfade{position:absolute;top:0;bottom:12px;width:36px;pointer-events:none;z-index:1;}
.dkb-tlfade.l{left:0;background:linear-gradient(to right,var(--dsw-alias-bg-base),transparent);}
.dkb-tlfade.r{right:0;background:linear-gradient(to left,var(--dsw-alias-bg-base),transparent);}
.dkb-tlbody{display:flex;gap:10px;padding:0 16px 12px;overflow-x:auto;scrollbar-width:thin;cursor:grab;user-select:none;-webkit-user-select:none;}
.dkb-tlbody[data-drag="1"]{cursor:grabbing;scroll-behavior:auto;}
.dkb-tlbody::-webkit-scrollbar{height:8px;}
.dkb-tlbody::-webkit-scrollbar-track{background:transparent;}
.dkb-tlbody::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:4px;}
.dkb-tlbody::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l4);}
.dkb-tlcard{flex:0 0 240px;padding:9px 11px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;overflow:hidden;}
.dkb-tlcard:hover{border-color:var(--dsw-alias-border-l4);}
.dkb-tlcard .h{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-caption);}
.dkb-tlcard .b{display:flex;align-items:center;gap:7px;margin-top:5px;min-width:0;}
.dkb-tlcard .b .ri{flex:0 0 auto;width:18px;height:18px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;}
.dkb-tlcard .b .t{flex:1 1 auto;min-width:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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

		/**
		 * 右侧详情抽屉：对齐设计稿的信息架构。
		 *
		 * 顺序刻意固定：身份（图标 / 标题 / 类型）→ 标签 → 摘要 → 相关节点 → 来源 → 更新。
		 * 前三样回答"这是什么"，后三样回答"从哪来、还能怎么用"。历史版本与实体提及
		 * 放在最后 —— 它们只在追问时才看。
		 */
		function DetailDrawer({ detail, onPick, onForget, onClose }) {
			const open = detail !== null && detail !== undefined;
			const f = open ? detail.fact : null;
			const group = open ? groupOf(f) : "memory";
			const related = open ? [...(detail.outbound ?? []), ...(detail.inbound ?? [])].slice(0, 6) : [];
			return h(
				"div",
				{ className: "dkb-drawer", "data-open": open ? "1" : "0" },
				open
					? h(
							"div",
							{ className: "dkb-drawer-inner" },
							h(
								"div",
								{ className: "dkb-dhead" },
								h("div", { className: "ico", style: { background: KIND_COLOR[f.kind] ?? KIND_COLOR.fact } }, GROUP_GLYPH[group] ?? "·"),
								h(
									"div",
									{ className: "ht" },
									h("div", { className: "h1", title: f.title }, f.title),
									h(
										"div",
										{ className: "h2" },
										`${KIND_LABEL[f.kind] ?? f.kind} · ${f.path || "inbox"}${f.status === "active" ? "" : ` · ${f.status}`}`,
									),
								),
								h("button", { className: "dkb-btn", onClick: onClose, title: "关闭" }, "✕"),
							),
							h(
								"div",
								{ className: "dkb-dbody" },
								h(
									"div",
									{ style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 } },
									f.tags.map((tag) => h("span", { key: tag, className: "dkb-tag" }, tag)),
									h("span", { className: "dkb-tag", style: { opacity: 0.55 } }, "+ 标签"),
								),
								h("div", { className: "dkb-sec" }, "内容摘要"),
								h("div", { className: "dkb-body" }, f.body || "(空)"),
								related.length === 0
									? null
									: h(
											"div",
											null,
											h("div", { className: "dkb-sec" }, `相关节点 ${related.length}`),
											related.map((row) =>
												h(
													"div",
													{ key: `${row.rel}-${row.id}`, className: "dkb-relrow", onClick: () => onPick(row.id), title: row.title },
													h("div", { className: "ri", style: { background: KIND_COLOR[row.kind] ?? KIND_COLOR.fact } }, GROUP_GLYPH[groupOf(row)] ?? "·"),
													h("div", { className: "rt" }, row.title),
													h("div", { className: "rk" }, `${REL_LABEL[row.rel] ?? row.rel} ›`),
												),
											),
										),
								f.sessionId
									? h(
											"div",
											null,
											h("div", { className: "dkb-sec" }, "来源对话"),
											h(
												"div",
												{ className: "dkb-relrow", title: f.sessionId },
												h("div", { className: "ri", style: { background: KIND_COLOR.episode } }, "话"),
												h("div", { className: "rt" }, f.sessionId),
												h("div", { className: "rk" }, "›"),
											),
										)
									: null,
								h("div", { className: "dkb-sec" }, "属性"),
								h("div", { className: "dkb-kv" }, h("span", { className: "k" }, "最后更新"), h("span", { className: "v" }, when(f.updatedAt ?? f.ts))),
								h("div", { className: "dkb-kv" }, h("span", { className: "k" }, "置信 / 版本"), h("span", { className: "v" }, `${Number(f.confidence).toFixed(2)} · v${f.version ?? 1}`)),
								f.paths.length > 1
									? h("div", { className: "dkb-kv" }, h("span", { className: "k" }, "多归属"), h("span", { className: "v" }, f.paths.join(" · ")))
									: null,
								detail.mentions !== undefined && detail.mentions.length > 0
									? h(
											"div",
											null,
											h("div", { className: "dkb-sec" }, `提及实体 ${detail.mentions.length}`),
											h(
												"div",
												null,
												detail.mentions.map((m) => h("span", { key: `${m.type}:${m.token}`, className: "dkb-tag", title: m.type }, m.token)),
											),
										)
									: null,
								detail.history !== undefined && detail.history.length > 0
									? h(
											"div",
											null,
											h("div", { className: "dkb-sec" }, `历史版本 ${detail.history.length}`),
											detail.history.map((v) =>
												h("div", { key: v.version, className: "dkb-relrow", title: v.body }, h("div", { className: "rt" }, `v${v.version} · ${v.title}`)),
											),
										)
									: null,
								h("div", { className: "dkb-sec" }, "卡 id"),
								h("div", { className: "dkb-tag" }, f.id),
							),
							h(
								"div",
								{ className: "dkb-dfoot" },
								h(
									"button",
									{
										className: "dkb-btn dkb-primary",
										style: { flex: "1 1 auto" },
										onClick: () => onForget(f.id),
										disabled: f.status !== "active",
										title: "标为失效（保留可查，不删）",
									},
									f.status === "active" ? "标为失效" : `已 ${f.status}`,
								),
								h("button", { className: "dkb-btn", onClick: () => onPick(f.id), title: "重新载入" }, "刷新"),
							),
						)
					: null,
			);
		}

		/**
		 * 底部时间线：把当前范围的卡按时间倒排，并可按分组切开。
		 *
		 * 存在的理由：图谱看的是"关系长什么样"，时间线看的是"最近发生了什么"。
		 * 两者的排序方式互相矛盾，塞在一个视图里谁都看不清。
		 */
		function Timeline({ items, onPick }) {
			const [tab, setTab] = useState("time");
			const [flows, setFlows] = useState({ left: false, right: false });
			const bodyRef = useRef(null);
			const dragRef = useRef(null);
			const movedRef = useRef(false);
			const TABS = [
				["time", "时间线"],
				["talk", "相关对话"],
				["doc", "相关文档"],
				["task", "相关任务"],
			];
			const CAP = 40;
			const rows = useMemo(() => {
				const sorted = [...items].sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
				const picked = tab === "time" ? sorted : sorted.filter((item) => groupOf(item) === tab);
				return picked.slice(0, CAP);
			}, [items, tab]);

			/** 有没有被裁掉的左右两段，决定箭头显不显示。 */
			const syncFlows = useCallback(() => {
				const node = bodyRef.current;
				if (node === null) return;
				const max = node.scrollWidth - node.clientWidth;
				setFlows({ left: node.scrollLeft > 4, right: max > 4 && node.scrollLeft < max - 4 });
			}, []);

			useEffect(() => {
				syncFlows();
				const node = bodyRef.current;
				if (node === null) return;
				// React 的 onWheel 是 passive 的，preventDefault 会被忽略，
				// 所以滚轮这里必须自己挂原生监听（passive: false）。
				const onWheel = (event) => {
					const max = node.scrollWidth - node.clientWidth;
					if (max <= 0) return;
					const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
					if (delta === 0) return;
					const next = node.scrollLeft + delta;
					// 到头了就放行，让外层页面自己滚，别把滚轮吃掉
					if ((next <= 0 && delta < 0) || (next >= max && delta > 0)) return;
					event.preventDefault();
					node.scrollLeft = next;
				};
				node.addEventListener("wheel", onWheel, { passive: false });
				node.addEventListener("scroll", syncFlows, { passive: true });
				const ro = typeof ResizeObserver === "function" ? new ResizeObserver(syncFlows) : null;
				ro?.observe(node);
				return () => {
					node.removeEventListener("wheel", onWheel);
					node.removeEventListener("scroll", syncFlows);
					ro?.disconnect();
				};
			}, [syncFlows, rows.length, tab]);

			const page = useCallback((dir) => {
				const node = bodyRef.current;
				if (node === null) return;
				node.scrollTo({ left: node.scrollLeft + dir * Math.max(240, node.clientWidth * 0.8), behavior: "smooth" });
			}, []);

			const onDown = useCallback((event) => {
				if (event.button !== undefined && event.button !== 0) return;
				const node = bodyRef.current;
				if (node === null) return;
				dragRef.current = { x: event.clientX, left: node.scrollLeft };
				movedRef.current = false;
			}, []);
			const onMove = useCallback((event) => {
				const origin = dragRef.current;
				const node = bodyRef.current;
				if (origin === null || node === null) return;
				const dx = event.clientX - origin.x;
				// 位移超过阈值才算拖拽，否则会把"点卡片打开详情"当拖拽吞掉
				if (Math.abs(dx) > 4) movedRef.current = true;
				if (movedRef.current) node.scrollLeft = origin.left - dx;
			}, []);
			const onUp = useCallback(() => {
				dragRef.current = null;
			}, []);

			const total = items.length;

			return h(
				"div",
				{ className: "dkb-timeline" },
				h(
					"div",
					{ className: "dkb-tlhead" },
					TABS.map(([id, label]) =>
						h(
							"button",
							{ key: id, className: "dkb-chip", "data-active": tab === id ? "1" : "0", onClick: () => setTab(id) },
							label,
						),
					),
					h("span", { className: "dkb-tlcount" }, `${rows.length}/${total}`),
					h(
						"div",
						{ className: "dkb-tlnav" },
						h(
							"button",
							{ className: "dkb-btn", disabled: !flows.left, onClick: () => page(-1), title: "向左" },
							"‹",
						),
						h(
							"button",
							{ className: "dkb-btn", disabled: !flows.right, onClick: () => page(1), title: "向右" },
							"›",
						),
					),
				),
				h(
					"div",
					{ className: "dkb-tlwrap" },
					flows.left ? h("div", { className: "dkb-tlfade l" }) : null,
					flows.right ? h("div", { className: "dkb-tlfade r" }) : null,
					h(
						"div",
						{
							className: "dkb-tlbody",
							ref: bodyRef,
							"data-drag": dragRef.current === null ? "0" : "1",
							onPointerDown: onDown,
							onPointerMove: onMove,
							onPointerUp: onUp,
							onPointerLeave: onUp,
						},
						rows.length === 0
							? h("div", { className: "dkb-empty", style: { padding: "2px 0" } }, "这个分组里没有条目。")
							: rows.map((item) =>
									h(
										"div",
										{
											key: item.id,
											className: "dkb-tlcard",
											// 拖拽刚结束时别把 click 也触发掉，否则拖一下就跳详情
											onClick: () => {
												if (movedRef.current) {
													movedRef.current = false;
													return;
												}
												onPick(item.id);
											},
											title: item.title,
										},
										h(
											"div",
											{ className: "h" },
											h("span", null, when(item.ts)),
											h("span", null, "·"),
											h("span", null, KIND_LABEL[item.kind] ?? item.kind),
										),
										h(
											"div",
											{ className: "b" },
											h(
												"div",
												{ className: "ri", style: { background: KIND_COLOR[item.kind] ?? KIND_COLOR.fact } },
												GROUP_GLYPH[groupOf(item)] ?? "·",
											),
											h("div", { className: "t" }, item.title),
										),
									),
								),
					),
				),
			);
		}


		/**
		 * 星图视图：径向树骨架 + 星体散布 + 事实边。
		 *
		 * 与卡片画布并列的第三种看法 —— 卡片看"每个枝里有什么"，星图看"整张网长什么样"。
		 * 骨架按路径物化成径向树（角度按叶子数切分，深度决定半径），星体挂在所属枝上，
		 * 用 id 哈希做确定性散布，所以刷新不跳。
		 */
		function StarView({ tree, facts, edges, selected, onPick, onMode }) {
			const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
			const [hover, setHover] = useState(null);
			const drag = useRef(null);
			const vpRef = useRef(null);
			const SIZE = 720;

			const layout = useMemo(() => buildGalaxy({ tree, facts, edges, size: SIZE }), [tree, facts, edges]);

			const fit = useCallback(() => {
				const box = vpRef.current === null ? null : vpRef.current.getBoundingClientRect?.();
				if (!box) return;
				const k = Math.min(box.width / SIZE, box.height / SIZE, 1.6);
				setView({ k, tx: (box.width - SIZE * k) / 2, ty: (box.height - SIZE * k) / 2 });
			}, []);

			const onWheel = useCallback((event) => {
				event.preventDefault();
				setView((prev) => ({ ...prev, k: Math.min(3, Math.max(0.3, prev.k * Math.exp(-event.deltaY * 0.0012))) }));
			}, []);
			const onDown = useCallback(
				(event) => {
					if (event.button !== undefined && event.button !== 0) return;
					drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
				},
				[view.tx, view.ty],
			);
			const onMove = useCallback((event) => {
				const origin = drag.current;
				if (origin === null) return;
				const dx = event.clientX - origin.x;
				const dy = event.clientY - origin.y;
				setView((prev) => ({ ...prev, tx: origin.tx + dx, ty: origin.ty + dy }));
			}, []);
			const onUp = useCallback(() => {
				drag.current = null;
			}, []);

			return h(
				"div",
				{ className: "dkb-stage" },
				h(
					"div",
					{
						className: "dkb-vp",
						ref: vpRef,
						"data-drag": drag.current === null ? "0" : "1",
						onWheel,
						onPointerDown: onDown,
						onPointerMove: onMove,
						onPointerUp: onUp,
						onPointerLeave: onUp,
					},
					h(
						"svg",
						{ viewBox: `0 0 ${SIZE} ${SIZE}`, preserveAspectRatio: "xMidYMid meet", className: "dkb-star-svg" },
						h(
							"g",
							{
								transform: `translate(${SIZE / 2 + view.tx} ${SIZE / 2 + view.ty}) scale(${view.k}) translate(${-SIZE / 2} ${-SIZE / 2})`,
							},
							layout.links.map((link, index) =>
								h("line", {
									key: `l${index}`,
									x1: link.x1,
									y1: link.y1,
									x2: link.x2,
									y2: link.y2,
									stroke:
										link.kind === "tree"
											? "var(--dsw-alias-label-tertiary)"
											: link.kind === "spine"
												? "var(--dsw-alias-border-l3)"
												: "var(--dsw-alias-state-business-tertiary)",
									"stroke-width": link.kind === "tree" ? 1 : link.kind === "spine" ? 0.8 : 1.2,
									"stroke-opacity": link.kind === "tree" ? 0.75 : link.kind === "spine" ? 0.5 : 0.9,
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
								h(
									"g",
									{ key: star.id, className: "dkb-starg" },
									// 点选中的光环：星体本身只有 2–5px，没有这个看不出选中了谁
									selected === star.id
										? h("circle", {
												className: "dkb-star-ring",
												cx: star.x,
												cy: star.y,
												r: star.r + 5,
												fill: "none",
												stroke: "var(--dsw-alias-state-business-primary)",
												"stroke-width": 1.4,
											})
										: null,
									h("circle", {
										className: "dkb-star",
										cx: star.x,
										cy: star.y,
										r: star.r,
										fill: star.color,
										"fill-opacity": selected === star.id ? 1 : 0.85,
									}),
									// 透明的大命中区：星体太小，直接点它一多半会点空
									h("circle", {
										className: "dkb-star-hit",
										cx: star.x,
										cy: star.y,
										r: Math.max(8, star.r + 6),
										fill: "transparent",
										onClick: () => onPick(star.id),
										onPointerEnter: () => setHover(star.title),
										onPointerLeave: () => setHover(null),
									}),
								),
							),
						),
					),
					h(
						"div",
						{ className: "dkb-toolbar" },
						h("button", { className: "dkb-btn", "data-active": "0", onClick: () => onMode("card") }, "卡片"),
						h("button", { className: "dkb-btn", "data-active": "1", onClick: () => onMode("star") }, "星图"),
						h("button", { className: "dkb-btn", "data-active": "0", onClick: () => onMode("skeleton") }, "骨架"),
						h(
							"div",
							{ className: "dkb-zoombox" },
							h("button", { className: "dkb-btn", onClick: () => setView((prev) => ({ ...prev, k: Math.max(0.3, prev.k / 1.2) })) }, "−"),
							h("span", { className: "v" }, `${Math.round(view.k * 100)}%`),
							h("button", { className: "dkb-btn", onClick: () => setView((prev) => ({ ...prev, k: Math.min(3, prev.k * 1.2) })) }, "+"),
						),
						h("button", { className: "dkb-btn", onClick: fit }, "适应"),
					),
					hover === null
						? null
						: h(
								"div",
								{ className: "dkb-hint", style: { left: 16, top: 14, bottom: "auto", maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								hover,
							),
					h(
						"div",
						{ className: "dkb-hint" },
						`${layout.hubs.length} 个枝 · ${layout.stars.length} 颗星${facts.length > layout.stars.length ? `（前 ${layout.stars.length}/${facts.length}）` : ""} · 滚轮缩放 · 拖动平移`,
					),
				),
			);
		}

		/**
		 * 卡片画布：块骨架 + 卡片节点 + 带标签的事实边。
		 *
		 * 滚轮缩放、拖动平移、点卡选卡、适应画布、全屏。
		 * 不做力导向：块位置由骨架路径决定，天然可解释，也不用每帧算 O(n²)。
		 */
		function GraphPane({ tree, facts, edges, onPick, mode, onMode, selected }) {
			const [view, setView] = useState({ k: 1, tx: 16, ty: 16 });
			const [hover, setHover] = useState(null);
			const drag = useRef(null);
			const vpRef = useRef(null);

			// 骨架模式**不能**传空 facts：buildCanvas 会跳过"没有卡的枝"，
			// 结果一个块都画不出来（这就是"骨架树状图根本渲染不出来"）。
			// 布局照常按 facts 算，渲染时再按 mode 决定画卡片还是只画块框。
			const layout = useMemo(() => buildCanvas({ tree, facts, edges }), [tree, facts, edges]);

			/** 把整张画布塞进可视区：块多时自动缩，块少时不放大过头。 */
			const fit = useCallback(() => {
				const box = vpRef.current === null ? null : vpRef.current.getBoundingClientRect?.();
				if (!box || layout.width <= 0 || layout.height <= 0) return;
				const k = Math.min(box.width / layout.width, box.height / layout.height, 1.4);
				setView({
					k,
					tx: Math.max(8, (box.width - layout.width * k) / 2),
					ty: Math.max(8, (box.height - layout.height * k) / 2),
				});
			}, [layout.width, layout.height]);

			// 首次进来把整张画布塞进视口：1550x1294 的画布放在 1200 宽的区域里，不 fit 就只能看到一角。
			// 只在画布尺寸变化时 fit，避免用户拖过之后又被弹回去。
			const fittedRef = useRef("");
			useEffect(() => {
				const stamp = `${layout.width}x${layout.height}`;
				if (fittedRef.current === stamp) return;
				fittedRef.current = stamp;
				fit();
			}, [layout.width, layout.height, fit]);

			/** 以视口中心为锚点缩放：否则放大后目标会跑出画外。 */
			const zoomAt = useCallback((factor) => {
				setView((prev) => {
					const box = vpRef.current === null ? null : vpRef.current.getBoundingClientRect?.();
					const cx = box ? box.width / 2 : 0;
					const cy = box ? box.height / 2 : 0;
					const k = Math.min(2.4, Math.max(0.2, prev.k * factor));
					const rx = (cx - prev.tx) / prev.k;
					const ry = (cy - prev.ty) / prev.k;
					return { k, tx: cx - rx * k, ty: cy - ry * k };
				});
			}, []);

			const onWheel = useCallback((event) => {
				event.preventDefault();
				setView((prev) => ({ ...prev, k: Math.min(2.4, Math.max(0.2, prev.k * Math.exp(-event.deltaY * 0.0012))) }));
			}, []);
			const onDown = useCallback(
				(event) => {
					if (event.button !== undefined && event.button !== 0) return;
					drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
				},
				[view.tx, view.ty],
			);
			// 注意：不能在上面的 setView updater 里读 drag.current。
			// updater 是延后执行的，那时 onUp 可能已经把它置成 null ——
			// 报的就是 "Cannot read properties of null (reading 'tx')"，图谱一点就崩。
			// 先在事件回调里把起始状态取成局部变量，updater 只碰局部值。
			const onMove = useCallback((event) => {
				const origin = drag.current;
				if (origin === null) return;
				const dx = event.clientX - origin.x;
				const dy = event.clientY - origin.y;
				setView((prev) => ({ ...prev, tx: origin.tx + dx, ty: origin.ty + dy }));
			}, []);
			const onUp = useCallback(() => {
				drag.current = null;
			}, []);

			const toggleFull = useCallback(() => {
				const node = vpRef.current;
				if (node === null || node === undefined) return;
				if (document.fullscreenElement) void document.exitFullscreen?.();
				else void node.requestFullscreen?.();
			}, []);

			const labelOf = (value) => (value === "" ? "inbox" : value);
			const pct = `${Math.round(view.k * 100)}%`;

			// 星图是另一套渲染（SVG 星体），hooks 已经在上面全部调用过，这里提前返回是安全的。
			if (mode === "star") return h(StarView, { tree, facts, edges, selected, onPick, onMode });

			return h(
				"div",
				{ className: "dkb-stage" },
				h(
					"div",
					{
						className: "dkb-vp",
						ref: vpRef,
						"data-drag": drag.current === null ? "0" : "1",
						onWheel,
						onPointerDown: onDown,
						onPointerMove: onMove,
						onPointerUp: onUp,
						onPointerLeave: onUp,
					},
					h(
						"div",
						{
							className: "dkb-world",
							style: {
								transform: `translate(${view.tx}px,${view.ty}px) scale(${view.k})`,
								width: layout.width,
								height: layout.height,
							},
						},
						layout.hubs.map((hub) =>
							h("div", {
								key: `bg:${hub.path}`,
								className: "dkb-block",
								style: { left: hub.x, top: hub.y, width: hub.w, height: hub.h },
							}),
						),
						h(
							"svg",
							{ className: "dkb-edges", width: layout.width, height: layout.height },
							layout.links.map((link, index) =>
								h("path", {
									key: `e${index}`,
									className: "dkb-edge",
									"data-rel": link.kind === "spine" ? "spine" : "related",
									d: (() => {
										// 三次贝塞尔：横向出入，避免直线穿透中间那块卡片
										const out = link.x2 >= link.x1 ? 1 : -1;
										const bend = Math.max(36, Math.abs(link.x2 - link.x1) / 2.4);
										return `M${link.x1},${link.y1} C${link.x1 + out * bend},${link.y1} ${link.x2 - out * bend},${link.y2} ${link.x2},${link.y2}`;
									})(),
								}),
							),
							layout.links
								.filter((link) => link.tagged === true && link.label !== undefined)
								.map((link, index) => {
									const w = String(link.label).length * 11 + 14;
									return h(
										"g",
										{ key: `t${index}` },
										h("rect", { className: "dkb-ecap", x: link.mx - w / 2, y: link.my - 8, width: w, height: 16, rx: 8 }),
										h("text", { className: "dkb-elabel", x: link.mx, y: link.my + 3.5, "text-anchor": "middle" }, link.label),
									);
								}),
						),
						layout.hubs.map((hub) =>
							h(
								"div",
								{ key: `b:${hub.path}`, className: "dkb-blocklabel", style: { left: hub.x + CARD.pad, top: hub.y + 4 } },
								`${labelOf(hub.path)} · ${hub.shown < hub.count ? `${hub.shown}/${hub.count}` : hub.count}`,
							),
						),
						mode === "skeleton"
							? layout.hubs.map((hub) =>
									h("div", {
										key: `s:${hub.path}`,
										style: {
											position: "absolute",
											left: hub.x,
											top: hub.y,
											width: hub.w,
											height: hub.h,
											borderRadius: "var(--dsw-radius-lg,12px)",
											border: "1px dashed var(--dsw-alias-border-l3)",
											background: "var(--dsw-alias-bg-layer-1)",
											opacity: 0.55,
										},
									}),
								)
							: layout.stars.map((star) =>
									h(
										"div",
										{
											key: star.id,
											className: "dkb-card",
											"data-active": selected === star.id ? "1" : "0",
											style: { left: star.x, top: star.y, width: star.w, height: star.h },
											onClick: () => onPick(star.id),
											onPointerEnter: () => setHover(star.title),
											onPointerLeave: () => setHover(null),
											title: star.title,
										},
										h("div", { className: "ico", style: { background: star.color } }, GROUP_GLYPH[star.group] ?? "·"),
										h(
											"div",
											{ className: "main" },
											h("div", { className: "k" }, `${KIND_LABEL[star.kind] ?? star.kind} · ${when(star.ts)}`),
											h("div", { className: "t" }, star.title),
											star.tags.length === 0 ? null : h("div", { className: "chips" }, star.tags.map((tag) => h("span", { key: tag }, tag))),
										),
									),
								),
					),
					h(
						"div",
						{ className: "dkb-toolbar" },
						h("button", { className: "dkb-btn", "data-active": mode === "card" ? "1" : "0", onClick: () => onMode("card") }, "卡片"),
						h("button", { className: "dkb-btn", "data-active": "0", onClick: () => onMode("star") }, "星图"),
						h("button", { className: "dkb-btn", "data-active": mode === "skeleton" ? "1" : "0", onClick: () => onMode("skeleton") }, "骨架"),
						h(
							"div",
							{ className: "dkb-zoombox" },
							h("button", { className: "dkb-btn", onClick: () => zoomAt(1 / 1.2), title: "缩小" }, "−"),
							h("span", { className: "v" }, pct),
							h("button", { className: "dkb-btn", onClick: () => zoomAt(1.2), title: "放大" }, "+"),
						),
						h("button", { className: "dkb-btn", onClick: fit, title: "适应画布" }, "适应"),
						h("button", { className: "dkb-btn", onClick: toggleFull, title: "全屏" }, "全屏"),
					),
					hover === null
						? null
						: h(
								"div",
								{
									className: "dkb-hint",
									style: { left: 16, top: 14, bottom: "auto", right: "auto", maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								},
								hover,
							),
					h(
						"div",
						{ className: "dkb-hint" },
						`${layout.hubs.length} 个枝 · ${layout.stars.length} 张卡${layout.truncated ? `（共 ${layout.total}，每枝只铺前几张）` : ""} · 滚轮缩放 · 拖动平移`,
					),
				),
			);
		}

		/** 主页面：状态都在这里，子面板只负责画。 */
		function MemoryPage() {
			const [mode, setMode] = useState("list");
			const [graphMode, setGraphMode] = useState("star");
			const [groupFilter, setGroupFilter] = useState("all");
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
			const [models, setModels] = useState(null);
			// 筛选：类型 / 时间 / 状态 / 排序。分组 chips 管的是"哪一类卡"，
			// 这四个管的是"什么条件下的卡"，两回事，所以分开。
			const [filters, setFilters] = useState({ kind: "", since: "", status: "active", sort: "ts" });
			const [distillDraft, setDistillDraft] = useState(null);
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

			/**
			 * 取列表。
			 *
			 * `groupValue` 必须传给后端：只在前端过滤的话，「文档 68」这类分组
			 * 只要它的卡不在最新 80 条里，切过去就是一张空表 —— 又一个静默空表。
			 */
			const loadList = useCallback(async (q, pathValue, groupValue, f) => {
				const group = groupValue === "all" ? undefined : groupValue;
				const active = f ?? { kind: "", since: "", status: "active", sort: "ts" };
				try {
					if (q.trim() !== "") {
						const rows = await call("/search", { query: { q: q.trim(), k: 40, path: pathValue || undefined } });
						setList({ items: rows, total: rows.length });
					} else {
						setList(
							await call("/facts", {
								query: {
									limit: 80,
									status: active.status || undefined,
									kind: active.kind || undefined,
									since: active.since || undefined,
									sort: active.sort || undefined,
									path: pathValue || undefined,
									group,
								},
							}),
						);
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
				timer.current = setTimeout(() => loadList(query, pathFilter, groupFilter, filters), 260);
				return () => {
					if (timer.current !== null) clearTimeout(timer.current);
				};
			}, [query, pathFilter, groupFilter, filters, loadList]);

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
				const group = groupFilter === "all" ? undefined : groupFilter;
				try {
					setGraph(await call("/graph", { query: { path: pathFilter || undefined, group, limit: 400 } }));
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, [pathFilter, groupFilter]);

			useEffect(() => {
				if (mode === "graph") loadGraph();
			}, [mode, loadGraph]);

			const runIngest = useCallback(async () => {
				setBusy(true);
				try {
					const result = await call("/ingest", { body: {} });
					await loadShell();
					await loadList(query, pathFilter, groupFilter, filters);
					setError(`直接提取完成：${result.added ?? 0} 张新卡 / ${result.files ?? 0} 个会话 / ${result.staled ?? 0} 张降级`);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [loadShell, loadList, query, pathFilter, groupFilter, filters]);

			/** 打开提炼面板：先把宿主有哪些 provider/model 拉回来，再让人选。 */
			const openDistill = useCallback(async () => {
				let picked = models;
				if (picked === null) {
					try {
						picked = await call("/models");
						setModels(picked);
					} catch {
						picked = { providers: [], current: {}, available: false };
					}
				}
				const first = picked.providers?.[0];
				setDistillDraft({
					provider: picked.current?.provider || first?.id || "",
					model: picked.current?.model || first?.models?.[0]?.id || "",
					path: pathFilter || "",
					limit: 12,
				});
			}, [models, pathFilter]);

			const runDistill = useCallback(async () => {
				if (distillDraft === null) return;
				setBusy(true);
				try {
					const result = await call("/distill", {
						body: {
							path: distillDraft.path || undefined,
							limit: Number(distillDraft.limit) || 12,
							provider: distillDraft.provider || undefined,
							model: distillDraft.model || undefined,
						},
					});
					await loadShell();
					await loadList(query, pathFilter, groupFilter, filters);
					setDistillDraft(null);
					setError(
						result.distilled === undefined
							? `提炼出料：${result.material} 段原料（宿主没有可用的模型通道，原料与提示词已交给会话）`
							: `模型提炼完成：${result.distilled} 张卡（用了 ${result.provider}/${result.model}）`,
					);
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [distillDraft, loadShell, loadList, query, pathFilter, groupFilter, filters]);

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
					await loadList(query, pathFilter, groupFilter, filters);
					setError(result.result === "dup" ? "同样的卡已存在，已跳过。" : null);
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, [draft, loadShell, loadList, query, pathFilter, groupFilter, filters]);

			const removeFact = useCallback(
				async (id) => {
					try {
						await call("/forget", { body: { id } });
						await openFact(id);
						await loadShell();
						await loadList(query, pathFilter, groupFilter, filters);
					} catch (e) {
						setError(String(e.message ?? e));
					}
				},
				[openFact, loadShell, loadList, query, pathFilter, groupFilter, filters],
			);

			// 顶栏这行数字同时是**连通性指示器**：拿得到 stats 就说明前端与后端通了。
			// 显示"连不上后端"时别再猜界面，直接看 $DSH_HOME/kb/front.log 与 plugin.log。
			const head = useMemo(() => {
				if (stats === null) return "连不上后端";
				return `${stats.facts} 卡 · ${stats.edges} 边 · ${stats.mentions ?? 0} 实体`;
			}, [stats]);

			// 计数读全库（stats.groups）：chips 上的数字是"这一类一共多少"，不是"画布上画了几张"。
			// 老库没有 grp 列时回退到前端推算，规则与后端 groupOfFact 一致。
			const chipCounts = stats?.groups ?? {};
			const passGroup = useCallback(
				(item) => groupFilter === "all" || (item.grp ?? groupOf(item)) === groupFilter,
				[groupFilter],
			);

			/** 类型 chips 的过滤在图与列表上同时生效，两边看到的必须是同一批卡。 */
			const visible = useMemo(() => {
				const nodes = graph.nodes.filter(passGroup);
				const ids = new Set(nodes.map((node) => node.id));
				return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.src) && ids.has(edge.dst)) };
			}, [graph, passGroup]);

			const listItems = useMemo(() => list.items.filter(passGroup), [list.items, passGroup]);

			return h(
				"div",
				{ className: "dkb-root" },
				h(
					"div",
					{ className: "dkb-bar" },
					h("input", {
						className: "dkb-search",
						value: query,
						placeholder: "搜索记忆节点、对话、文档或标签…",
						onChange: (e) => setQuery(e.target.value),
					}),
					h("button", { className: "dkb-btn", "data-active": mode === "graph" ? "1" : "0", onClick: () => setMode("graph") }, "图谱"),
					h("button", { className: "dkb-btn", "data-active": mode === "list" ? "1" : "0", onClick: () => setMode("list") }, "列表"),
					h("button", { className: "dkb-btn", onClick: runIngest, disabled: busy }, busy ? "处理中…" : "直接提取"),
					h("button", { className: "dkb-btn", "data-active": distillDraft === null ? "0" : "1", onClick: openDistill, disabled: busy }, "模型提炼"),
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
				h(
					"div",
					{ className: "dkb-chipbar" },
					GROUPS.map((group) =>
						h(
							"button",
							{
								key: group.id,
								className: "dkb-chip",
								"data-active": groupFilter === group.id ? "1" : "0",
								onClick: () => setGroupFilter(group.id),
							},
							group.id === "all" ? group.label : `${group.label} ${chipCounts[group.id] ?? 0}`,
						),
					),
					h("div", { className: "dkb-chipspacer" }),
					h(
						"div",
						{ className: "dkb-filters" },
						h(
							"select",
							{
								className: "dkb-select",
								value: filters.kind,
								title: "按类型筛选",
								onChange: (e) => setFilters({ ...filters, kind: e.target.value }),
							},
							KIND_FILTER.map(([value, label]) => h("option", { key: value, value }, label)),
						),
						h(
							"select",
							{
								className: "dkb-select",
								value: filters.since,
								title: "按时间筛选",
								onChange: (e) => setFilters({ ...filters, since: e.target.value }),
							},
							SINCE_FILTER.map(([value, label]) => h("option", { key: value, value }, label)),
						),
						h(
							"select",
							{
								className: "dkb-select",
								value: filters.status,
								title: "按状态筛选",
								onChange: (e) => setFilters({ ...filters, status: e.target.value }),
							},
							STATUS_FILTER.map(([value, label]) => h("option", { key: value, value }, label)),
						),
						h(
							"select",
							{
								className: "dkb-select",
								value: filters.sort,
								title: "排序",
								onChange: (e) => setFilters({ ...filters, sort: e.target.value }),
							},
							SORT_FILTER.map(([value, label]) => h("option", { key: value, value }, label)),
						),
					),
				),
				distillDraft === null
					? null
					: h(
							"div",
							{ className: "dkb-composer", style: { width: "min(520px, calc(100% - 40px))" } },
							h("label", null, "用哪个模型提炼"),
							models === null || models.available === false
								? h(
										"div",
										{ style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } },
										"宿主没有暴露模型通道。点“开始”会退回**出料**：把原料和提示词交回会话，由我这个模型来写卡 —— 不会假装提炼成功。",
									)
								: h(
										"div",
										{ className: "row" },
										h(
											"select",
											{
												value: distillDraft.provider,
												onChange: (e) => {
													const provider = e.target.value;
													const found = models.providers.find((p) => p.id === provider);
													setDistillDraft({ ...distillDraft, provider, model: found?.models?.[0]?.id ?? "" });
												},
											},
											(models.providers ?? []).map((p) => h("option", { key: p.id, value: p.id }, p.name)),
										),
										h(
											"select",
											{
												value: distillDraft.model,
												onChange: (e) => setDistillDraft({ ...distillDraft, model: e.target.value }),
											},
											((models.providers.find((p) => p.id === distillDraft.provider) ?? { models: [] }).models ?? []).map((m) =>
												h("option", { key: m.id, value: m.id }, m.name),
											),
										),
									),
							h("label", null, "限定枝（留空 = 全库）"),
							h("input", {
								value: distillDraft.path,
								placeholder: "如 topic/dsh",
								onChange: (e) => setDistillDraft({ ...distillDraft, path: e.target.value }),
							}),
							h("label", null, "一次喂多少段原料"),
							h("input", {
								type: "number",
								min: 1,
								max: 60,
								value: distillDraft.limit,
								onChange: (e) => setDistillDraft({ ...distillDraft, limit: e.target.value }),
							}),
							h(
								"div",
								{ className: "actions" },
								h("button", { className: "dkb-btn", onClick: () => setDistillDraft(null) }, "取消"),
								h("button", { className: "dkb-btn dkb-primary", onClick: runDistill, disabled: busy }, busy ? "处理中…" : "开始提炼"),
							),
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
				h(
					"div",
					{ className: "dkb-stage" },
					mode === "graph"
						? h(GraphPane, {
								tree,
								facts: visible.nodes,
								edges: visible.edges,
								onPick: openFact,
								mode: graphMode,
								onMode: setGraphMode,
								selected,
							})
						: h(
								"div",
								{ className: "dkb-cols" },
								h("div", { className: "dkb-col dkb-tree" }, h(TreePane, { nodes: tree, active: pathFilter, onPick: setPathFilter })),
								h(
									"div",
									{ className: "dkb-col dkb-list" },
									listItems.length === 0
										? h("div", { className: "dkb-empty" }, query ? "没有命中。换同义词或英文再查。" : "这个范围里没有卡。")
										: listItems.map((item) => h(FactRow, { key: item.id, item, active: selected, onPick: openFact })),
								),
							),
					h(DetailDrawer, {
						detail,
						onPick: openFact,
						onForget: removeFact,
						onClose: () => {
							setDetail(null);
							setSelected(null);
						},
					}),
				),
				h(Timeline, { items: listItems, onPick: openFact }),
			);
		}

		/**
		 * 浏览器端插件入口。
		 * @param {object} ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// 样式在挂载前就注入，避免首帧无样式导致的尺寸误判
			try {
				injectStyle();
			} catch {
				// 样式失败不该拦住面板
			}
			if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
				window.addEventListener("error", (event) => {
					report("error", event?.message ?? "window.onerror", {
						stack: event?.error?.stack,
						extra: { where: `${event?.filename ?? "?"}:${event?.lineno ?? 0}` },
					});
				});
				window.addEventListener("unhandledrejection", (event) => {
					const reason = event?.reason;
					report("rejection", reason?.message ?? reason ?? "unhandledrejection", { stack: reason?.stack });
				});
			}
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 32, label: () => "记忆" }, MemoryIcon),
			);
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID }, () => h(Boundary, null, h(MemoryPage))),
			);
		}

		exports.name = PANEL_ID;
		exports.inject = ["slots"];
		exports.apply = apply;
		/** 布局是纯函数，导出给测试用（不参与面板逻辑）。 */
		exports.__layout = buildCanvas;
		/** 查询串构造器，导出给测试用（它决定面板能不能查到数据）。 */
		exports.__query = buildQuery;
		/** 星图布局，导出给预览脚本与测试用。 */
		exports.__galaxy = buildGalaxy;
		return module.exports;
	},
});
