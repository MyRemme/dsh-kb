/**
 * 使用反馈：记录一张卡有没有被"用过"。
 *
 * 为什么需要这个：之前判断"有用"只有四个代理指标，而它们的成色是
 *   - kind       84% 是按段落标题自动猜的
 *   - confidence 只有 4 档，按来源工具批量赋，衡量"谁写的"而不是"对不对"
 *   - 引用数     语义边只有 3 条，实际几乎全为 0
 *   - 年龄       唯一真实可测的
 *
 * 也就是"动态遗忘"其实约等于"按时长清流水账"。
 *
 * 人脑的遗忘不是按时间衰减的，是按**是否被激活**衰减 —— 没人走的通路才被修剪。
 * 所以这里记三件事：
 *
 *   hit       被检索命中（有人问到它了）
 *   adopt     命中之后真被用了（被 kb_get 读、被 kb_link 引用、或用户点了"有用"）
 *   reject    被否掉（用户点了"没用"、或者被 supersede）
 *
 * 从这三个数能读出：
 *   命中多但不采纳 -> 噪音
 *   命中少但都采纳 -> 精华
 *   从没命中过     -> 占着位置不服务任何人
 *   命中后常被否   -> 过时或错的
 *
 * @module dsh-kb/usage
 */

/** 事件类型白名单。拼进 SQL 前必须校验，别让调用方塞别的值。 */
export const USAGE_KINDS = new Set(["hit", "adopt", "reject"]);

/** 明细表最多留多少行，超了删最旧的。够回溯最近的使用史，不至于把库撑大。 */
const DETAIL_CAP = 4000;

/**
 * 记一次使用事件：更新汇总列 + 追加明细。
 *
 * @param {object} db - 已打开的库。
 * @param {string} factId - 目标卡 id。
 * @param {"hit"|"adopt"|"reject"} kind - 事件类型。
 * @param {object} [meta] - `{query, rank, source}`，都会记进明细。
 * @returns {boolean} 是否记上了（卡不存在或类型非法时返回 false）。
 */
export function recordUsage(db, factId, kind, meta = {}) {
	const id = String(factId ?? "").trim();
	if (id === "" || !USAGE_KINDS.has(kind)) return false;
	const exists = db.prepare("SELECT 1 AS x FROM fact WHERE id=?").get(id);
	if (exists === undefined) return false;

	const now = Date.now();
	const column = kind === "hit" ? "hit_count" : kind === "adopt" ? "adopt_count" : "reject_count";
	// 列名来自上面的三选一，不是外部输入 —— 但 date 字段要单独处理
	if (kind === "hit") {
		db.prepare(`UPDATE fact SET ${column}=${column}+1, last_hit_at=? WHERE id=?`).run(now, id);
	} else {
		db.prepare(`UPDATE fact SET ${column}=${column}+1 WHERE id=?`).run(id);
	}

	db.prepare("INSERT INTO usage (fact_id, kind, ts, query, rank, source) VALUES (?,?,?,?,?,?)").run(
		id,
		kind,
		now,
		meta.query === undefined ? null : String(meta.query).slice(0, 300),
		Number.isFinite(Number(meta.rank)) ? Number(meta.rank) : null,
		meta.source === undefined ? "unknown" : String(meta.source).slice(0, 40),
	);

	// 滚动裁剪：明细只是回溯用，不是账本
	const count = db.prepare("SELECT COUNT(*) AS n FROM usage").get().n;
	if (Number(count) > DETAIL_CAP) {
		db.prepare("DELETE FROM usage WHERE id IN (SELECT id FROM usage ORDER BY ts ASC LIMIT ?)").run(Number(count) - DETAIL_CAP);
	}
	return true;
}

/**
 * 批量记命中。检索返回几张就记几张，rank 从 1 开始。
 *
 * @param {object} db - 已打开的库。
 * @param {object[]} rows - `search()` 的返回值。
 * @param {string} query - 检索词。
 * @param {string} [source] - 调用方标识（tool / panel / cli）。
 * @returns {number} 实际记上的条数。
 */
export function recordHits(db, rows, query, source = "tool") {
	let n = 0;
	for (let i = 0; i < rows.length; i += 1) {
		if (recordUsage(db, rows[i].id, "hit", { query, rank: i + 1, source })) n += 1;
	}
	return n;
}

/**
 * 读一张卡的实测使用情况。
 *
 * @param {object} row - fact 行（需含 usage 三列）。
 * @returns {{hits: number, adopts: number, rejects: number, sample: number, measured: number|null}} 统计。
 *   `measured` 是"实测有用度"：样本足够时给 -1..1 的分，否则 null 表示只能用类型兜底。
 */
export function usageOf(row) {
	const hits = Number(row.hit_count ?? 0);
	const adopts = Number(row.adopt_count ?? 0);
	const rejects = Number(row.reject_count ?? 0);
	const sample = hits + adopts + rejects;
	// 少于 3 次事件不足以下结论 —— 一次误点不该把一张好卡判死
	if (sample < 3) return { hits, adopts, rejects, sample, measured: null };
	// 否决的权重高于采纳：说"不对"是更强的信号
	const score = (adopts * 1.0 - rejects * 1.5) / sample;
	return { hits, adopts, rejects, sample, measured: Math.max(-1, Math.min(1, score)) };
}

/**
 * 一张卡最近被用过的事件（面板与调试用）。
 *
 * @param {object} db - 已打开的库。
 * @param {string} factId - 卡 id。
 * @param {number} [limit] - 条数。
 * @returns {object[]} 事件列表，最新在前。
 */
export function recentUsage(db, factId, limit = 20) {
	return db
		.prepare("SELECT kind, ts, query, rank, source FROM usage WHERE fact_id=? ORDER BY ts DESC LIMIT ?")
		.all(String(factId ?? ""), Math.max(1, Math.min(200, Number(limit) || 20)))
		.map((row) => ({ kind: row.kind, ts: Number(row.ts), query: row.query, rank: row.rank, source: row.source }));
}

/**
 * 全库使用概况（面板头部用）。
 *
 * @param {object} db - 已打开的库。
 * @returns {{hits: number, adopts: number, rejects: number, usedCards: number, totalCards: number, neverUsed: number}} 概况。
 */
export function usageSummary(db) {
	const agg = db
		.prepare("SELECT COALESCE(SUM(hit_count),0) h, COALESCE(SUM(adopt_count),0) a, COALESCE(SUM(reject_count),0) r FROM fact")
		.get();
	const usedCards = db.prepare("SELECT COUNT(*) AS n FROM fact WHERE hit_count+adopt_count+reject_count > 0").get().n;
	const totalCards = db.prepare("SELECT COUNT(*) AS n FROM fact").get().n;
	return {
		hits: Number(agg.h),
		adopts: Number(agg.a),
		rejects: Number(agg.r),
		usedCards: Number(usedCards),
		totalCards: Number(totalCards),
		neverUsed: Number(totalCards) - Number(usedCards),
	};
}
