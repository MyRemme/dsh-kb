/**
 * dsh-kb — 本机长期记忆库。
 *
 * 解决的是"每次会话从零开始"：用户问过四遍同一个问题，四遍都不知道前三次
 * 想明白了什么。本插件把会话蒸馏成事实卡，并提供四个原生工具。
 *
 * 结构一句话：**`fact` 是唯一真相，骨架树和关系图只是它的两副视图。**
 *   - 树  管"找回去"：多归属路径 + 可重算摘要，用于范围限定和浏览
 *   - 图  管"脉络"：写入时建边，1 跳扩展补上下文，`supersedes` 回答"这结论还有效吗"
 *   - FTS 管"命中"：中文 bigram 词法 + 词覆盖精排
 *
 * 为什么不是纯树：单父挂载在跨主题会话上必错，且分类成本随规模线性上涨。
 * 为什么不是纯向量：语义相似不等于有用，且无法做范围限定。
 *
 * @module dsh-kb
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { openDb, upsertFact, defaultDbPath, reindex } from "./store.js";
import { seg } from "./segment.js";
import { search, renderResults } from "./search.js";
import { ingest } from "./ingest.js";
import { digest, treeRows } from "./digest.js";

const Config = z.object({
	enabled: z.boolean().default(true).description("启用知识库工具"),
	dbPath: z.string().default("").description("库文件路径；留空用 $DSH_HOME/kb/kb.db"),
	maxResults: z.number().step(1).min(1).max(40).default(6).description("单次检索返回条数"),
	promptSection: z.boolean().default(true).description("向系统提示注入记忆纪律"),
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

/**
 * 安装工具与系统提示片段。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 已解析的配置。
 */
function apply(ctx, config) {
	const settings = { ...Config(config ?? {}) };
	if (settings.enabled === false) return;

	let handle;
	/** 懒开库：插件加载时不碰磁盘，第一次用工具才建。 */
	const db = () => {
		handle ??= openDb(settings.dbPath || undefined);
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

	ctx.tools.register(
		defineTool({
			name: "kb_search",
			description:
				"检索本机长期知识库（历次会话沉淀的事实卡）。" +
				"用户提到「之前 / 上次 / 以前 / 我们说过 / 继续」时先调用；" +
				"要在回答里陈述「我们的约定 / 之前的结论 / 之前怎么解决的」之前也必须先查。",
			parameters: {
				query: { type: "string", required: true, description: "检索词，中文或英文，可混" },
				k: { type: "number", description: `返回条数，默认 ${settings.maxResults}` },
				path: { type: "string", description: "限定骨架树前缀，如 topic/dsh" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const rows = search(db(), args.query, {
					k: Number(args.k) || settings.maxResults,
					path: args.path,
				});
				return { text: renderResults(rows) };
			},
			presentCall: (args) => PRESENT(`检索记忆：${args.query}`, "read", args.query),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "kb_add",
			description:
				"写入一条事实卡。一个可独立陈述的结论 / 决定 / 修复 / 偏好 = 一条卡。" +
				"只写判断和结论，不写过程流水账，不写能从代码里读出来的东西。正文要自包含。" +
				"内容重复会自动跳过。",
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
			async execute(args) {
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
						source_ref: "tool",
						confidence: 0.8,
						ts: Date.now(),
					},
					seg,
				);
				return { text: result === "dup" ? "已存在同样的卡，跳过。" : `已写入（${result}）。` };
			},
			presentCall: (args) => PRESENT(`记住：${args.title}`, "other", args.title),
		}),
	);

	ctx.tools.register(
		defineTool({
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
					lines.push(`${"   ".repeat(r.depth)}${r.depth > 0 ? "└─ " : ""}${r.path.split("/").pop()}${r.count ? ` (${r.count})` : ""}`);
					if (showSummary && r.summary) {
						for (const s of r.summary.split("\n")) lines.push(`${"   ".repeat(r.depth)}   ${s}`);
					}
				}
				return { text: lines.join("\n") };
			},
			presentCall: (args) => PRESENT("查看记忆树", "read", args.prefix),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "kb_stats",
			description: "知识库健康度：卡片数、类型分布、路径分布、边数、库大小。",
			parameters: {},
			output: TEXT_OUTPUT,
			async execute() {
				const conn = db();
				const one = (sql, ...p) => conn.prepare(sql).get(...p);
				const all = (sql) => conn.prepare(sql).all();
				const stats = {
					facts: one("SELECT COUNT(*) AS n FROM fact").n,
					active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'").n,
					sessions: one("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''").n,
					edges: one("SELECT COUNT(*) AS n FROM edge").n,
					nodes: one("SELECT COUNT(*) AS n FROM node").n,
					kinds: Object.fromEntries(all("SELECT kind, COUNT(*) AS n FROM fact GROUP BY kind ORDER BY n DESC").map((r) => [r.kind, r.n])),
					paths: Object.fromEntries(all("SELECT path, COUNT(*) AS n FROM fact GROUP BY path ORDER BY n DESC LIMIT 12").map((r) => [r.path, r.n])),
					db: handle?.file ?? defaultDbPath(),
				};
				return { text: JSON.stringify(stats, null, 1) };
			},
			presentCall: () => PRESENT("记忆库状态", "read"),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "kb_ingest",
			description:
				"增量吸收本机 DSH 会话文件（多帧 zstd jsonl）到知识库，并重算树枝摘要。" +
				"幂等，可反复跑；已处理且未变动的会话会跳过。首次导入或想补最近几轮记忆时用它。",
			parameters: {
				limit: { type: "number", description: "最多处理多少个会话文件" },
				rescan: { type: "boolean", description: "忽略缓存全量重扫" },
			},
			output: TEXT_OUTPUT,
			async execute(args) {
				const conn = db();
				const stats = ingest(conn, {
					limit: Number(args.limit) || undefined,
					rescan: args.rescan === true,
				});
				const nodes = digest(conn);
				return { text: JSON.stringify({ ...stats, nodes_digested: nodes }) };
			},
			presentCall: () => PRESENT("吸收会话记忆", "other"),
		}),
	);

	if (settings.promptSection !== false) {
		ctx.systemPrompt.section({
			name: "memory:dsh-kb",
			order: 108,
			text:
				"本机有长期记忆库（dsh-kb）。它不是可选的查询工具，是判断依据的来源之一。" +
				"用户提到「之前 / 上次 / 以前 / 我们说过 / 继续 / 接着那个」时，先 kb_search" +
				"再回答；要陈述「我们的约定 / 之前的结论」时同样先查。一个查询查不到就换同义词或英文再查一次，" +
				"两次空才算库里没有。" +
				"本轮产生了决定、踩坑修复、用户偏好、可复用流程时，收尾前用 kb_add 写一条卡：" +
				"一条卡一个事实，正文自包含（三个月后单看这条能懂），写明现象、根因、做法、边界。" +
				"不写过程流水账，不写能从代码或 git 读出来的东西。",
		});
	}
}

const name = "dsh-kb";
const inject = ["tools", "systemPrompt"];

export { Config, apply, inject, name };
export default apply;
