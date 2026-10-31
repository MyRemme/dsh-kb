/**
 * 会话 → 知识的两条路。
 *
 *   **直接提取**（`lib/ingest.js`）：照抄会话里已经写下来的段落，零模型调用。
 *   快、可复现、不会编造；代价是流水账多（episode/intent/state 这些）。
 *
 *   **模型提炼**（本文件）：把原料喂给模型，让它产出"结论 + 根因 + 边界"的卡。
 *   慢、要模型通道、可能编；但质量是数量级的差别 —— 这也是为什么要两条路并存，
 *   而不是拿一条替换另一条。
 *
 * 提炼产物一律带 `derived_from` 边指回原料，所以"这句话从哪来"永远可查；
 * 原料不删，只降权（红线 3）。
 *
 * @module dsh-kb/distill
 */

import { makeId, upsertFact, addEdge } from "./store.js";
import { seg } from "./segment.js";

/** 可以被提炼的"原料"类型：这些描述的是过程与快照，不是结论。 */
export const MATERIAL_KINDS = ["episode", "segment", "intent", "state", "artifact", "todo", "fact"];

/** 一批最多喂多少段原料，够一次提炼，也不会把上下文撑爆。 */
const DEFAULT_BATCH = 12;
const EXCERPT = 900;

/**
 * 取一批原料。
 * @param {object} db - 已打开的库。
 * @param {object} [options] - `{path, session, limit, kinds, since, includeSpent}`。
 *   `includeSpent: true` 时连已经提炼过的原料也返回（默认排除）。
 * @returns {Array<object>} 原料数组。
 */
export function collectMaterial(db, options = {}) {
	const limit = Math.max(1, Math.min(60, Number(options.limit) || DEFAULT_BATCH));
	const kinds = options.kinds ?? MATERIAL_KINDS;
	const filters = ["f.status='active'"];
	const params = [];
	if (options.path) {
		filters.push("(f.path LIKE ? OR f.paths LIKE ?)");
		params.push(`${options.path}%`, `%${options.path}%`);
	}
	if (options.session) {
		filters.push("f.session_id LIKE ?");
		params.push(`%${options.session}%`);
	}
	if (options.since) {
		filters.push("f.ts >= ?");
		params.push(Number(options.since));
	}
	filters.push(`f.kind IN (${kinds.map(() => "?").join(",")})`);
	params.push(...kinds);
	// 排除已经提炼过的原料：derived_from 的 dst 就是"被提炼的那张卡"。
	// 没有这一条，每次 distill 都从最新 N 段里重抽同一批已经写过结论的会话，
	// 产出的只能是重复或者编造 —— 实测跑一次 project/code 就是这个结果。
	if (options.includeSpent !== true) {
		filters.push("f.id NOT IN (SELECT dst FROM edge WHERE rel='derived_from')");
	}

	return db
		.prepare(`SELECT f.id, f.title, f.body, f.kind, f.path, f.session_id, f.ts FROM fact f WHERE ${filters.join(" AND ")} ORDER BY f.ts DESC LIMIT ?`)
		.all(...params, limit)
		.map((row) => ({
			id: row.id,
			title: row.title,
			kind: row.kind,
			path: row.path,
			session: row.session_id,
			ts: Number(row.ts),
			excerpt: String(row.body ?? "").replace(/\s+/g, " ").slice(0, EXCERPT),
		}));
}

/**
 * 拼提炼用的提示词。
 *
 * 约束写死在提示里：只要结论、一条一个事实、不许编造、不确定就不写。
 * 这几条是"提炼"和"编故事"的分界线，比格式要求重要得多。
 *
 * @param {Array<object>} material - `collectMaterial` 的结果。
 * @returns {{system: string, user: string}} 提示词。
 */
export function buildPrompt(material) {
	const system =
		"你是知识库的整理员。输入是一个人的历史会话片段（原料），" +
		"你要把它们压成**可长期复用的事实卡**。规则：" +
		"1) 只保留结论、决定、踩过的坑、可复用的做法；过程流水账一律丢掉。" +
		"2) 一条卡只讲一个事实，正文自包含：现象、根因、做法、边界，三个月后单看能懂。" +
		"3) 不许编造：原料里没写的东西不要补，宁可少写。" +
		"4) 同类合并：同一个结论在不同会话里重复出现，只写一条。" +
		"5) 每条卡必须能挂到某个路径枝上（path 用原料里出现过的路径之一）。" +
		'只输出 JSON 数组，元素形如 {"title":"一句话结论","body":"自包含正文","kind":"fact|decision|fix|howto|concept|pref","path":"topic/xxx"}，' +
		"不要输出其他文字；没有值得保留的内容就输出 []。";

	const lines = material.map((item, index) => {
		const head = `#${index + 1} [${item.kind}] ${item.title}（路径 ${item.path || "inbox"}）`;
		return `${head}\n${item.excerpt}`;
	});

	const user = [
		`下面是 ${material.length} 段原料，请提炼成事实卡（最多 8 条，宁少勿滥）：`,
		"",
		lines.join("\n\n"),
	].join("\n");

	return { system, user };
}

/**
 * 解析模型输出。容忍代码围栏、前后废话、单对象包成数组。
 * @param {string} text - 模型原始输出。
 * @param {object} [options] - `{limit}`。
 * @returns {Array<object>} 卡数组（字段已校验）。
 */
export function parseCards(text, options = {}) {
	const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
	const raw = String(text ?? "");
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const out = [];
	for (const item of parsed) {
		if (item === null || typeof item !== "object") continue;
		const title = String(item.title ?? "").trim();
		const body = String(item.body ?? "").trim();
		if (title === "" || body === "") continue;
		const kind = ["fact", "decision", "fix", "howto", "concept", "pref"].includes(item.kind) ? item.kind : "fact";
		out.push({
			title: title.slice(0, 200),
			body: body.slice(0, 4000),
			kind,
			path: String(item.path ?? "").trim() || undefined,
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 把提炼出的卡写进库，并给每条建 `derived_from` 边指向原料。
 * @param {object} db - 已打开的库。
 * @param {Array<object>} cards - `parseCards` 的结果。
 * @param {object} [options] - `{sourceIds, path}`。
 * @returns {{added: number, updated: number, dup: number, ids: string[]}} 落库结果。
 */
export function saveDistilled(db, cards, options = {}) {
	const stats = { added: 0, updated: 0, dup: 0, ids: [] };
	const sources = options.sourceIds ?? [];
	for (const card of cards) {
		const path0 = card.path || options.path || "inbox";
		const result = upsertFact(
			db,
			{
				title: card.title,
				body: card.body,
				kind: card.kind,
				path: path0,
				paths: [path0],
				tags: ["distilled"],
				source_kind: "distill",
				source_ref: sources[0] ?? "distill",
				confidence: 0.85,
				ts: Date.now(),
			},
			seg,
		);
		if (result === "added") stats.added += 1;
		else if (result === "updated") stats.updated += 1;
		else stats.dup += 1;

		const id = makeId(card.title, card.body);
		stats.ids.push(id);
		for (const sourceId of sources) addEdge(db, id, sourceId, "derived_from", 1, "distill");
	}
	return stats;
}

/**
 * 端到端：取原料 → 拼提示 → 调模型 → 解析 → 落库。
 * @param {object} db - 已打开的库。
 * @param {{provider: string, model: string, complete: (prompt: object) => Promise<string>}} model - 模型通道。
 * @param {object} [options] - `{path, session, limit}`。
 * @returns {Promise<object>} `{material, cards, added, updated, dup, provider, model}`。
 */
export async function distillWithModel(db, model, options = {}) {
	const material = collectMaterial(db, options);
	if (material.length === 0) return { material: 0, cards: 0, added: 0, updated: 0, dup: 0, provider: model.provider, model: model.model };
	const prompt = buildPrompt(material);
	const text = await model.complete(prompt);
	const cards = parseCards(text, { limit: options.cards ?? 8 });
	const saved = saveDistilled(db, cards, { sourceIds: material.map((m) => m.id), path: options.path });
	return {
		material: material.length,
		cards: cards.length,
		...saved,
		provider: model.provider,
		model: model.model,
	};
}

/**
 * 没有模型通道时，把原料 + 提示词打包给调用方（通常是会话里的模型自己）。
 * @param {object} db - 已打开的库。
 * @param {object} [options] - `{path, session, limit}`。
 * @returns {{material: number, prompt: {system: string, user: string}}} 出料结果。
 */
export function exportMaterial(db, options = {}) {
	const material = collectMaterial(db, options);
	return { material: material.length, prompt: buildPrompt(material) };
}
