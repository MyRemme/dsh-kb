/**
 * 检索：宽召回 + 精排 + 图扩展。
 *
 * 分工固定，别混：
 *   通道 A 词法 FTS5(bigram)  —— 精确词，主力
 *   通道 B 子串 LIKE          —— 短查询、拼写异常兜底
 *   通道 C 图 1 跳 contains   —— 补上下文
 * 精排不吃 LLM，只算词覆盖率 / 标题命中 / 路径对齐 / 新颖度。
 */

import { queryTokens, terms } from "./segment.js";

/** 主题关键词表。命中即给对应路径的卡加权，同时用于写入时的自动归枝。 */
export const TOPIC_RULES = [
	["topic/dsh", ["dsh", "deepseek harness", "cordis", "harness", "插件", "profile"]],
	["topic/blender", ["blender", "几何节点", "geometry node", "eevee", "cycles"]],
	["topic/game-re", ["解包", "unity", "assetstudio", "naraka", "永劫", "ab包", "il2cpp", "ue4", "ue5"]],
	["topic/office", ["docx", "pptx", "xlsx", "excel", "word", "ppt", "文档处理"]],
	["topic/security", ["ctf", "exploit", "提权", "渗透", "pwn", "shellcode", "免杀", "逆向"]],
	["topic/media", ["视频", "字幕", "whisper", "音频", "tts", "语音"]],
	["topic/windows", ["powershell", "pwsh", "注册表", "acl", "sandbox", "沙箱"]],
	["topic/model", ["模型", "llm", "prompt", "token", "推理", "上下文"]],
	["topic/knowledge", ["知识库", "记忆", "memory", "rag", "检索", "embedding"]],
];

const KIND_BONUS = new Set(["decision", "fix", "concept", "intent"]);

/**
 * 按关键词推断归属路径；找不到就落 inbox，不强迫分类。
 * @param {string} title - 标题。
 * @param {string} body - 正文。
 * @param {string} cwd - 会话工作目录。
 * @returns {string[]} 路径数组（可能为空 → 调用方补 inbox）。
 */
export function inferPaths(title, body, cwd) {
	const hay = `${title}\n${body}`.toLowerCase();
	const scored = [];
	for (const [p, kws] of TOPIC_RULES) {
		let hits = 0;
		for (const k of kws) {
			const needle = k.toLowerCase();
			let at = hay.indexOf(needle);
			while (at !== -1) {
				hits += 1;
				at = hay.indexOf(needle, at + needle.length);
			}
		}
		if (hits > 0) scored.push([hits, p]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	const out = scored.slice(0, 2).map(([, p]) => p);
	if (cwd) {
		const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "root";
		out.push(`project/${base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`);
	}
	return [...new Set(out.filter(Boolean))];
}

/** 词覆盖率。 */
function coverage(hay, list) {
	if (list.length === 0) return [0, 1];
	let hit = 0;
	for (const t of list) if (hay.includes(t)) hit += 1;
	return [hit, list.length];
}

/**
 * 检索。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} query - 查询串。
 * @param {object} [opts] - 选项。
 * @param {number} [opts.k] - 返回条数，默认 6。
 * @param {string} [opts.path] - 限定骨架树前缀。
 * @param {boolean} [opts.expand] - 是否走图扩展，默认 true。
 * @param {boolean} [opts.includeSuperseded] - 是否含已取代的卡，默认 false。
 * @returns {object[]} 结果数组，按分数降序。
 */
export function search(db, query, opts = {}) {
	const k = opts.k ?? 6;
	const pathFilter = opts.path;
	const expand = opts.expand !== false;
	const includeSuperseded = opts.includeSuperseded === true;
	const now = Date.now();

	const cands = new Map();
	const statusClause = includeSuperseded ? "" : " AND f.status='active'";
	const pathClause = pathFilter ? " AND (f.path LIKE ? OR f.paths LIKE ?)" : "";
	const pathParams = pathFilter ? [`${pathFilter}%`, `%${pathFilter}%`] : [];

	for (const mode of ["AND", "OR"]) {
		const toks = queryTokens(query);
		if (toks.length === 0) break;
		const expr = toks.join(` ${mode} `);
		try {
			const rows = db
				.prepare(
					"SELECT f.* FROM fact_fts JOIN fact f ON f.rowid=fact_fts.rowid " +
						`WHERE fact_fts MATCH ?${statusClause}${pathClause} ` +
						"ORDER BY bm25(fact_fts,6.0,1.0,1.5,2.0) LIMIT ?",
				)
				.all(expr, ...pathParams, mode === "AND" ? 120 : 160);
			for (const r of rows) if (!cands.has(r.id)) cands.set(r.id, r);
		} catch {
			// FTS 语法异常不致命，交给下一档
		}
		if (cands.size >= 40) break;
	}

	if (cands.size < 8) {
		const like = `%${String(query).trim().replace(/[%_]/g, "")}%`;
		const rows = db
			.prepare(
				"SELECT f.* FROM fact f WHERE (f.title LIKE ? OR f.body LIKE ?)" +
					`${statusClause}${pathClause} ORDER BY f.ts DESC LIMIT 60`,
			)
			.all(like, like, ...pathParams);
		for (const r of rows) if (!cands.has(r.id)) cands.set(r.id, r);
	}

	const list = terms(query);
	const wantedPaths = new Set(
		TOPIC_RULES.filter(([, kws]) => kws.some((kw) => String(query).toLowerCase().includes(kw.toLowerCase())))
			.map(([p]) => p),
	);

	const scored = [];
	for (const row of cands.values()) {
		const title = String(row.title ?? "").toLowerCase();
		const body = String(row.body ?? "").toLowerCase();
		const [hit, tot] = coverage(`${title} ${body}`, list);
		const [thit] = coverage(title, list);
		const cov = hit / tot;
		const tscore = thit / Math.max(1, tot);
		let pscore = 0;
		if (wantedPaths.has(row.path)) pscore = 1;
		else if (pathFilter && String(row.path ?? "").startsWith(pathFilter)) pscore = 0.6;
		const ts = Number(row.ts) > 1e11 ? Number(row.ts) / 1000 : Number(row.ts);
		const ageDays = Math.max(0, (now - ts) / 86400000);
		const recency = Math.pow(0.5, ageDays / 240);
		const status = row.status === "active" ? 1 : 0.15;
		const conf = 0.5 + Number(row.confidence);
		const kindBonus = KIND_BONUS.has(row.kind) ? 1.08 : 1;
		let s = (0.5 * cov + 0.22 * tscore + 0.16 * pscore + 0.12 * recency) * status * conf * kindBonus;
		if (cov === 0) s *= 0.25;
		scored.push({ s, row, cov });
	}
	scored.sort((a, b) => b.s - a.s);

	const out = [];
	const seen = new Set();
	const push = (row, score, why) => {
		if (seen.has(row.id)) return;
		seen.add(row.id);
		out.push({
			id: row.id,
			score: Math.round(score * 1000) / 1000,
			why,
			kind: row.kind,
			status: row.status,
			path: row.path,
			title: row.title,
			body: row.body,
			tags: safeJson(row.tags),
			ts: row.ts,
			sourceRef: row.source_ref,
		});
	};

	for (const { s, row, cov } of scored.slice(0, k)) push(row, s, `match ${Math.round(cov * 100)}%`);

	if (expand) {
		for (const { s, row } of scored.slice(0, 3)) {
			const rel = db
				.prepare("SELECT f.* FROM edge e JOIN fact f ON f.id=e.dst WHERE e.src=? AND f.status='active' LIMIT 4")
				.all(row.id);
			for (const r of rel) {
				if (out.length >= k + 3) break;
				push(r, s * 0.45, "graph");
			}
		}
	}
	return out.slice(0, k + 3);
}

function safeJson(s) {
	try {
		return JSON.parse(s ?? "[]");
	} catch {
		return [];
	}
}

/**
 * 把检索结果渲染成给模型看的紧凑文本。
 * @param {object[]} results - search() 的返回值。
 * @returns {string} 空结果时返回一句明确的无命中提示。
 */
export function renderResults(results) {
	if (results.length === 0) return "(知识库无命中。换同义词或英文再试，或确认该主题尚未入库。)";
	return results
		.map(
			(r, i) =>
				`${i + 1}. [${r.kind}|${r.path}|${r.score.toFixed(2)}|${r.why}] ${r.title}\n` +
				`${String(r.body ?? "").slice(0, 900)}\n(ref: ${r.id})`,
		)
		.join("\n\n");
}
