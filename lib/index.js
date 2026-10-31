/**
 * dsh-kb — 本机长期记忆库。
 *
 * 解决的是"每次会话从零开始"：用户问过四遍同一个问题，四遍都不知道前三次
 * 想明白了什么。本插件把会话蒸馏成事实卡，对外提供七个原生工具、十一个 HTTP 端点
 * （`/api/dsh-kb/*`，面板与静态页共用）、CLI，以及一次开场注入。
 *
 * 结构一句话：**`fact` 是唯一真相，骨架树、关系图、实体提及只是它的三副视图。**
 *   - 树  管"找回去"：多归属路径 + 可重算摘要，用于范围限定和浏览
 *   - 图  管"脉络"：写入时建边，1 跳扩展补上下文
 *   - 词  管"提及"：正文里的路径/版本/错误码，回答"改这个文件先看什么"
 *
 * 为什么不是纯树：单父挂载在跨主题会话上必错，且分类成本随规模线性上涨。
 * 为什么不是纯向量：语义相似不等于有用，且无法做范围限定。
 *
 * @module dsh-kb
 */

import z from "@deepseek-ai/schemastery";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveDefineTool } from "./tool.js";
import { openDb, upsertFact, updateFact, getFact, defaultDbPath, sweepStale } from "./store.js";
import { seg } from "./segment.js";
import { search, renderResults } from "./search.js";
import { ingest } from "./ingest.js";
import { digest, treeRows } from "./digest.js";
import { mountRoutes } from "./http.js";
import { createApi, statsOf } from "./routes.js";
import { importFromDir, mirrorToDir } from "./markdown.js";
import { resolveModel } from "./model.js";
import { distillWithModel, exportMaterial } from "./distill.js";

/** 官方 defineTool 优先；在无 dsh 运行时的环境里回退到本地等价实现。 */
const defineTool = await resolveDefineTool();

const Config = z.object({
	enabled: z.boolean().default(true).description("启用知识库工具"),
	dbPath: z.string().default("").description("库文件路径；留空用 $DSH_HOME/kb/kb.db"),
	maxResults: z.number().step(1).min(1).max(40).default(6).description("单次检索返回条数"),
	promptSection: z.boolean().default(true).description("向系统提示注入记忆纪律"),
	ui: z.boolean().default(true).description("注册 /api/dsh-kb/* 路由（侧边栏「记忆」面板的数据源）"),
	bootFacts: z.number().step(1).min(0).max(40).default(6).description("开场自动注入最近 N 张卡，0 关闭"),
	ingestEveryMinutes: z.number().step(1).min(0).max(10080).default(0).description("定时吸收间隔（分钟），0 关闭"),
	staleDays: z.number().step(1).min(1).max(3650).default(30).description("快照型卡多少天后降级"),
	mirrorDir: z.string().default("").description("Markdown 镜像目录；留空用库旁边的 mirror/"),
	distillProvider: z.string().default("").description("提炼用的 provider；留空取第一个可用"),
	distillModel: z.string().default("").description("提炼用的模型；留空取该 provider 的第一个"),
});

const TEXT_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: { text: { type: "string", required: true } },
	},
	render: (_args, value) => [{ type: "text", text: value.text }],
};

const PRESENT = (title, kind, rawInput) => ({
	card: "generic",
	title,
	kind,
	...(rawInput === undefined ? {} : { rawInput }),
});

/** 时间过滤的简写：`30d` / `12h` / `2w` / `3mo`，也接 ISO 日期。 */
const SINCE_UNITS = { m: 60000, h: 3600000, d: 86400000, w: 604800000, mo: 2592000000 };

/**
 * 把 `30d` 这类简写转成毫秒时间戳下界。
 * @param {unknown} input - 简写或日期串。
 * @returns {number|undefined} 毫秒下界。
 */
function sinceToMs(input) {
	if (input === undefined || input === null || input === "") return undefined;
	const text = String(input).trim();
	const rel = /^(\d+)\s*(mo|[mhdw])$/i.exec(text);
	if (rel !== null) return Date.now() - Number(rel[1]) * SINCE_UNITS[rel[2].toLowerCase()];
	const ts = Date.parse(text);
	return Number.isFinite(ts) ? ts : undefined;
}

/**
 * 从工具执行上下文里取会话身份，落库做来源归因。
 * 单测里没有运行时，返回空串即可（工具照常工作）。
 * @param {object} [exec] - 工具执行上下文。
 * @returns {{sessionId: string, cwd: string}} 来源。
 */
function sourceOf(exec) {
	try {
		const agent = exec?.agent;
		const sessionId = String(agent?.sessionId ?? "");
		const cwd = String(agent?.session?.meta?.cwd ?? agent?.session?.cwd ?? "");
		return { sessionId, cwd };
	} catch {
		return { sessionId: "", cwd: "" };
	}
}

/**
 * 安装工具、开场注入、HTTP 路由与定时任务。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 已解析的配置。
 */
function apply(ctx, config) {
	// 加载期日志：宿主不把插件异常摊到界面上（那一行只会显示"异常"），
	// 所以自己记一份，出问题能直接读。写到库旁边，卸载库不会带走它。
	const settings = { ...Config(config ?? {}) };
	// 日志落在库旁边：跟着配置的 dbPath 走，测试里也就落到临时目录。
	const logFile = path.join(path.dirname(settings.dbPath || defaultDbPath()), "plugin.log");
	const trace = (line) => {
		try {
			mkdirSync(path.dirname(logFile), { recursive: true });
			appendFileSync(logFile, `${new Date().toISOString()} ${line}
`);
		} catch {
			// 日志失败绝不影响加载
		}
	};
	/** 可选阶段：失败只记日志，不连坐整个插件。 */
	const soft = (name, fn) => {
		try {
			fn();
			trace(`ok ${name}`);
		} catch (error) {
			trace(`FAIL ${name}: ${error?.stack ?? error}`);
		}
	};

	trace("apply:start");
	if (settings.enabled === false) {
		trace("apply:disabled");
		return;
	}
	const staleDays = Number(settings.staleDays) || 30;

	let handle;
	/** 懒开库：插件加载时不碰磁盘，第一次用（工具/面板/注入）才建。 */
	const db = () => {
		if (handle === undefined) {
			handle = openDb(settings.dbPath || undefined);
			try {
				sweepStale(handle.db, { days: staleDays });
			} catch {
				// 降级失败不影响开库
			}
		}
		return handle.db;
	};

	ctx.effect(() => () => {
		try {
			handle?.db.close();
		} catch {
			// 关库失败不影响卸载
		}
		handle = undefined;
	});


	/** 单个工具注册失败不该拖垮其余工具：逐个 try，逐个记日志。 */
	const tool = (definition) => {
		try {
			const built = defineTool(definition);
			ctx.tools.register(built);
			trace(`ok tool ${definition.name}`);
		} catch (error) {
			trace(`FAIL tool ${definition.name}: ${error?.stack ?? error}`);
		}
	};

	/** 系统提示注册失败不该连坐：记日志，继续跑。 */
	const promptSection = (label, options) => {
		try {
			ctx.systemPrompt.section(options);
			trace(`ok prompt:${label}`);
		} catch (error) {
			trace(`FAIL prompt:${label}: ${error?.stack ?? error}`);
		}
	};

	tool({
			name: "kb_search",
			description:
				"检索本机长期知识库（历次会话沉淀的事实卡）。" +
				"用户提到「之前 / 上次 / 以前 / 我们说过 / 继续」时先调用。" +
				"流水账（episode/intent）默认会被自身置信度压下去，要专门看它们用 includeStale。",
			parameters: {
				query: { type: "string", description: "检索词，中文或英文，可混；只看实体时留空并给 entity" },
				k: { type: "number", description: `返回条数，默认 ${settings.maxResults}` },
				path: { type: "string", description: "限定骨架树前缀，如 topic/dsh" },
				kinds: { type: "string", description: "只看这些类型，逗号分隔：fact,fix,decision,concept" },
				since: { type: "string", description: "时间下界：30d / 12h / 2w / ISO 日期" },
				session: { type: "string", description: "限定来源会话 id（片段即可）" },
				entity: { type: "string", description: "按实体命中：文件路径、函数名、版本号" },
				includeStale: { type: "boolean", description: "包含已降级/已取代的卡，默认 false" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const kinds = String(args.kinds ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const rows = search(db(), String(args.query ?? ""), {
					k: Number(args.k) || settings.maxResults,
					path: args.path || undefined,
					kinds: kinds.length > 0 ? kinds : undefined,
					since: sinceToMs(args.since),
					session: args.session || undefined,
					entity: args.entity || undefined,
					includeSuperseded: args.includeStale === true,
				});
				return { text: renderResults(rows) };
			},
			presentCall: (args) => PRESENT(`检索记忆：${args.query ?? args.entity}`, "read", args.query),
	});

	tool({
			name: "kb_add",
			description:
				"写入一条事实卡。一个可独立陈述的结论 / 决定 / 修复 / 偏好 = 一条卡。" +
				"只写判断和结论，不写过程流水账，不写能从代码里读出来的东西。正文要自包含。" +
				"内容重复会自动跳过；同一结论的补充用 kb_update，不要重写一张新的。",
			parameters: {
				title: { type: "string", required: true, description: "一句话结论，别写成标签" },
				body: { type: "string", required: true, description: "自包含的正文：现象、根因、做法、边界。500 字内" },
				path: { type: "string", description: "归枝路径，如 topic/dsh、project/code；默认 inbox" },
				kind: {
					type: "string",
					enum: ["fact", "decision", "fix", "pref", "howto", "concept", "intent"],
					description: "卡的类型，默认 fact",
				},
				tags: { type: "string", description: "逗号分隔" },
			},
			output: TEXT_OUTPUT,
			async execute(args, exec) {
				const source = sourceOf(exec);
				const result = upsertFact(
					db(),
					{
						title: args.title,
						body: args.body,
						kind: args.kind ?? "fact",
						path: args.path || undefined,
						paths: args.path ? [args.path] : undefined,
						tags: String(args.tags ?? "")
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean),
						source_kind: "kb_add",
						source_ref: source.sessionId || "tool",
						session_id: source.sessionId,
						cwd: source.cwd,
						confidence: 0.8,
						ts: Date.now(),
					},
					seg,
				);
				return { text: result === "dup" ? "已存在同样的卡，跳过。补充结论请用 kb_update。" : `已写入（${result}）。` };
			},
			presentCall: (args) => PRESENT(`记住：${args.title}`, "other", args.title),
	});

	tool({
			name: "kb_update",
			description:
				"修订一张已有的卡：**id 不变**，旧版本进历史，只替换内容。" +
				"结论变了、边界补了、写错了都走这里，不要新写一张（新卡会让同一结论裂成两张）。",
			parameters: {
				id: { type: "string", required: true, description: "卡 id 或前缀" },
				title: { type: "string", description: "新标题（不改就不传）" },
				body: { type: "string", description: "新正文" },
				path: { type: "string", description: "新主路径" },
				kind: { type: "string", description: "新类型" },
				tags: { type: "string", description: "新标签，逗号分隔" },
				status: { type: "string", description: "active / superseded / doubtful" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const patch = {};
				if (args.title !== undefined) patch.title = args.title;
				if (args.body !== undefined) patch.body = args.body;
				if (args.path !== undefined) patch.paths = args.path ? [args.path] : [];
				if (args.kind !== undefined) patch.kind = args.kind;
				if (args.status !== undefined) patch.status = args.status;
				if (args.tags !== undefined) {
					patch.tags = String(args.tags)
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean);
				}
				const result = updateFact(db(), args.id, patch, seg);
				if (result.result === "not-found") return { text: `没找到这张卡：${args.id}（可以用 kb_search 拿准确 id）` };
				if (result.result === "unchanged") return { text: `内容没变，仍是 v${result.version}。` };
				return { text: `已更新 ${result.id}，现在 v${result.version}（旧版本可在 kb_get 的历史里看到）。` };
			},
			presentCall: (args) => PRESENT(`修订记忆：${args.id}`, "other", args.id),
	});

	tool({
			name: "kb_get",
			description: "按 id 读一张卡的全文、修订历史、入/出关系与提及的实体。检索结果被截断时用它。",
			parameters: {
				id: { type: "string", required: true, description: "卡 id 或前缀" },
				follow: { type: "boolean", description: "顺带列出出边目标的标题，默认 true" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const detail = getFact(db(), args.id);
				if (detail === undefined) return { text: `没找到这张卡：${args.id}` };
				const lines = [
					`${detail.id} · v${detail.version} · ${detail.kind} · ${detail.path} · ${detail.status}`,
					detail.title,
					"",
					detail.body,
				];
				if (detail.mentions.length > 0) {
					lines.push("", `提及：${detail.mentions.map((m) => `${m.token}(${m.type})`).join(" · ")}`);
				}
				if (args.follow !== false && detail.outbound.length > 0) {
					lines.push("", "指向：");
					for (const e of detail.outbound) lines.push(`  → ${e.rel} ${e.title} (${e.id})`);
				}
				if (detail.inbound.length > 0) {
					lines.push("", "被引用：");
					for (const e of detail.inbound) lines.push(`  ← ${e.rel} ${e.title} (${e.id})`);
				}
				if (detail.history.length > 0) {
					lines.push("", `历史版本 ${detail.history.length} 个：`);
					for (const h of detail.history) lines.push(`  v${h.version} ${new Date(Number(h.ts)).toISOString().slice(0, 16)} ${h.title}`);
				}
				return { text: lines.join("\n") };
			},
			presentCall: (args) => PRESENT(`读取记忆：${args.id}`, "read", args.id),
	});

	tool({
			name: "kb_tree",
			description: "查看骨架树的分类现状：每个枝有多少张卡、最近更新、代表卡标题。用于发现该归并或该细分的枝。",
			parameters: {
				prefix: { type: "string", description: "子树前缀，如 topic" },
				withSummary: { type: "boolean", description: "是否展开枝摘要，默认 true" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const rows = treeRows(db(), args.prefix ?? "");
				if (rows.length === 0) return { text: "(空)" };
				const showSummary = args.withSummary !== false;
				const lines = [];
				for (const r of rows) {
					lines.push(
						`${"   ".repeat(r.depth)}${r.depth > 0 ? "└─ " : ""}${r.path.split("/").pop()}${r.count ? ` (${r.count})` : ""}`,
					);
					if (showSummary && r.summary) {
						for (const s of r.summary.split("\n")) lines.push(`${"   ".repeat(r.depth)}   ${s}`);
					}
				}
				return { text: lines.join("\n") };
			},
			presentCall: (args) => PRESENT("查看记忆树", "read", args.prefix),
	});

	tool({
			name: "kb_stats",
			description: "知识库健康度：卡片数、类型分布、路径分布、边数、实体数、已降级数、库大小。",
			parameters: {},
			output: TEXT_OUTPUT,
			async execute() {
				const stats = statsOf(db(), handle?.file ?? defaultDbPath());
				return { text: JSON.stringify(stats, null, 1) };
			},
			presentCall: () => PRESENT("记忆库状态", "read"),
	});

	tool({
			name: "kb_ingest",
			description:
				"增量吸收本机 DSH 会话文件（多帧 zstd jsonl）到知识库，重算摘要，并把过期快照卡降级。" +
				"幂等，可反复跑；已处理且未变动的会话会跳过。首次导入或想补最近几轮记忆时用它。",
			parameters: {
				limit: { type: "number", description: "最多处理多少个会话文件" },
				rescan: { type: "boolean", description: "忽略缓存全量重扫" },
				mode: { type: "string", enum: ["raw", "distill", "both"], description: "raw=直接提取（默认）；distill=只提炼；both=先提取再提炼" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const conn = db();
				const mode = String(args.mode ?? "raw");
				const stats = mode === "distill"
					? { files: 0, added: 0, dup: 0, updated: 0, skip: 0, err: 0, facts: 0 }
					: ingest(conn, { limit: Number(args.limit) || undefined, rescan: args.rescan === true });
				const nodes = digest(conn);
				const staled = sweepStale(conn, { days: staleDays });
				let distilled;
				if (mode === "distill" || mode === "both") {
					const model = await resolveModel(ctx, settings);
					distilled = model === undefined
						? { skipped: "没有可用的模型通道；用 kb_distill 出料，或让会话自己提炼" }
						: await distillWithModel(conn, model, { limit: 12 });
				}
				return { text: JSON.stringify({ ...stats, nodes_digested: nodes, staled, distilled }) };
			},
			presentCall: () => PRESENT("吸收会话记忆", "other"),
	});

	tool({
		name: "kb_distill",
		description:
			"把原料卡（会话/分段/意图/待办/进度）提炼成结论卡 —— 只留判断、根因、边界，丢掉流水账。" +
			"有宿主模型通道时直接跑并落库；没有时把原料和提示词给你，由你自己写卡（再用 kb_add 落库）。" +
			"提炼产物带 derived_from 边指回原料，可追源。",
		parameters: {
			path: { type: "string", description: "限定枝，如 topic/dsh" },
			session: { type: "string", description: "限定来源会话 id" },
			limit: { type: "number", description: "喂多少段原料，默认 12" },
			submit: { type: "boolean", description: "有模型通道时是否直接落库，默认 true" },
		},
		output: TEXT_OUTPUT,
		async execute(args) {
			const conn = db();
			const options = { path: args.path, session: args.session, limit: Number(args.limit) || undefined };
			const model = await resolveModel(ctx, settings);
			if (model !== undefined && args.submit !== false) {
				return { text: JSON.stringify(await distillWithModel(conn, model, options)) };
			}
			const pack = exportMaterial(conn, options);
			if (pack.material === 0) return { text: "没有可提炼的原料（库是空的，或这个范围里只剩结论卡了）。" };
			return {
				text:
					`${pack.prompt.system}

${pack.prompt.user}

` +
					"—— 按上面的规则把结论逐条用 kb_add 写进来（一条一个事实，path 用原料里出现过的枝）。",
			};
		},
		presentCall: (args) => PRESENT(`提炼记忆：${args.path ?? "全部"}`, "other"),
	});

	tool({
		name: "kb_mirror",
		description:
			"把知识库投影成 Markdown 目录树（可 git、可 diff、可用编辑器手改），或把目录里的改动写回库。" +
			"真身始终是 kb.db —— 目录只是投影。导出按 id 匹配已有文件（标题改了只改名），" +
			"内容没变不写盘（git diff 只反映真改动），库里已没有的 id 移进 .trash/ 而不是删掉。" +
			"导入默认只认比库里新的文件，要强行回灌加 force。",
		parameters: {
			mode: { type: "string", description: "export（默认）导出镜像 / import 把镜像改动写回库" },
			dir: { type: "string", description: "镜像目录；留空用库旁边的 mirror/" },
			dryRun: { type: "boolean", description: "只算不写，先看会动多少文件" },
			force: { type: "boolean", description: "import 时连比库里旧的文件也回灌" },
		},
		output: TEXT_OUTPUT,
		async execute(args) {
			const conn = db();
			const dir =
				String(args.dir ?? "").trim() ||
				settings.mirrorDir || path.join(path.dirname(settings.dbPath || defaultDbPath()), "mirror");
			if (String(args.mode ?? "export") === "import") {
				return {
					text: JSON.stringify(
						importFromDir(conn, dir, { force: args.force === true, dryRun: args.dryRun === true }),
					),
				};
			}
			return { text: JSON.stringify(mirrorToDir(conn, dir, { dryRun: args.dryRun === true })) };
		},
		presentCall: (args) => PRESENT(`镜像知识库：${String(args.mode ?? "export") === "import" ? "写回" : "导出"}`, "other"),
	});

	// 面板与静态页的数据源。webServer 是可选依赖：headless 组合里没有它，
	// 插件仍要能装工具；ctx.inject 的等待与卸载由 cordis 纤维接管。
soft("routes", () => {
		if (settings.ui !== false && typeof ctx.inject === "function") {
			ctx.inject(["webServer"], (webCtx) => {
				const api = createApi({
					getDb: () => db(),
					getFile: () => handle?.file ?? defaultDbPath(),
					dbPath: handle?.file ?? defaultDbPath(),
					mirrorDir: settings.mirrorDir || path.join(path.dirname(settings.dbPath || defaultDbPath()), "mirror"),
					maxResults: settings.maxResults,
					staleDays,
				});
				webCtx.effect(() => mountRoutes(webCtx.webServer, api.routes), "dsh-kb: /api/dsh-kb/*");
			});
		}

	});
	if (settings.promptSection !== false) {
		promptSection("discipline", {
			name: "memory:dsh-kb",
			order: 108,
			interpolate: false,
			text:
				"本机有长期记忆库（dsh-kb）。它不是可选的查询工具，是判断依据的来源之一。" +
				"用户提到「之前 / 上次 / 以前 / 我们说过 / 继续 / 接着那个」时，先 kb_search" +
				"再回答；要陈述「我们的约定 / 之前的结论」时同样先查。一个查询查不到就换同义词或英文再查一次，" +
				"两次空才算库里没有。" +
				"检索默认只回结论型卡；要看流水账用 includeStale，要按文件/函数找用 entity。" +
				"本轮产生了决定、踩坑修复、用户偏好、可复用流程时，收尾前用 kb_add 写一条卡：" +
				"一条卡一个事实，正文自包含（三个月后单看这条能懂），写明现象、根因、做法、边界。" +
				"结论变了用 kb_update 改原卡（id 不变），不要另写一张。" +
				"不写过程流水账，不写能从代码或 git 读出来的东西。",
		});
	}

	// 开场注入：每轮组装提示时现算，所以新写入的卡下一轮就能看见。
	const bootFacts = Number(settings.bootFacts) || 0;
	if (settings.promptSection !== false && bootFacts > 0) {
		promptSection("boot", {
			name: "memory:dsh-kb:boot",
			order: 109,
			interpolate: false,
			text: () => {
				try {
					const rows = db()
						.prepare("SELECT id,title,kind,path FROM fact WHERE status='active' ORDER BY ts DESC LIMIT ?")
						.all(bootFacts);
					if (rows.length === 0) return "";
					const lines = rows.map((r) => `- [${r.kind}|${r.path || "inbox"}] ${r.title}（${r.id}）`);
					return [
						"## 最近记住的事（自动注入，不是全部）",
						...lines,
						"细节用 kb_search 查，全文用 kb_get 读。写错或过时的卡用 kb_update 改，别另开一张。",
					].join("\n");
				} catch {
					return "";
				}
			},
		});
	}

	const everyMinutes = Number(settings.ingestEveryMinutes) || 0;
	if (everyMinutes >= 1) {
		ctx.effect(() => {
			const timer = setInterval(() => {
				try {
					const conn = db();
					ingest(conn, {});
					digest(conn);
					sweepStale(conn, { days: staleDays });
				} catch {
					// 定时任务失败不打断宿主，下一轮再试
				}
			}, everyMinutes * 60000);
			timer.unref?.();
			return () => clearInterval(timer);
		}, "dsh-kb: 定时吸收");
		trace("ok timer");
	}
	trace("apply:done");
}

const name = "dsh-kb";
const inject = ["tools", "systemPrompt"];

export { Config, apply, inject, name };
