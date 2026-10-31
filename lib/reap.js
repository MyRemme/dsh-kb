/**
 * 动态遗忘：按"重要度 × 时间衰减"决定一张卡该不该留。
 *
 * 三档记忆，对应人脑的三套系统：
 *
 *   **情景记忆**（episode / intent / segment）—— 当时说过什么。
 *   几周内快速变模糊，这是正常的，不是缺陷。
 *
 *   **快照记忆**（state / artifact / todo）—— 当时是什么样。
 *   描述的是一个已经过去的截面，过期就该退场，但没有情景记忆那么快。
 *
 *   **语义 / 技能记忆**（fact / decision / fix / howto / concept / pref）——
 *   想明白了什么。这类**不该随时间淡**：一年前想通的道理今天照样成立，
 *   衰减它等于把学到的东西又忘掉。
 *
 * 保留分公式：\`base(kind) × 引用加成 × confidence × 0.5^(ageDays / halfLife)\`
 *
 * 三条保护线，任何一条命中就不做最狠的淘汰：
 *   1. 有入边的卡（被别的卡引用）—— 它是别人结论的依据
 *   2. \`decision\` / \`pref\` —— 人做的决定和偏好不该自己过期
 *   3. \`confidence >= 0.9\` —— 高置信度意味着反复确认过
 *
 * **不物理删除。** 衰减只改 status：active → doubtful → superseded。
 * superseded 的卡默认检索不到，但 \`--include-stale\` 还能查回来，历史也还在。
 * 真删只有 \`FORGET\` 这一条路（从检索里彻底去掉）。
 *
 * @module dsh-kb/reap
 */

/** 卡类型 → 记忆档位。 */
export const KIND_BUCKET = {
	episode: "diary",
	intent: "diary",
	segment: "diary",
	state: "snapshot",
	artifact: "snapshot",
	todo: "snapshot",
	fact: "conclusion",
	concept: "conclusion",
	decision: "conclusion",
	fix: "conclusion",
	howto: "conclusion",
	pref: "conclusion",
};

/** 各档位的半衰期（天）。0.5^(age/halfLife)。 */
export const HALF_LIFE_DAYS = { diary: 45, snapshot: 90, conclusion: 540 };

/** 各类型的初始重要度。结论型天然比流水账重。 */
export const BASE_WEIGHT = {
	episode: 0.2,
	intent: 0.2,
	segment: 0.2,
	state: 0.3,
	artifact: 0.3,
	todo: 0.4,
	fact: 0.8,
	concept: 1.0,
	decision: 1.0,
	fix: 1.1,
	howto: 1.1,
	pref: 1.2,
};

/** 永不被自动淘汰的类型：人的决定和偏好不该自己过期。 */
export const PINNED_KINDS = new Set(["decision", "pref"]);

/** 默认阈值：低于它降级为 doubtful。 */
export const DEFAULT_THRESHOLD = 0.09;

/** 低于它淘汰为 superseded（再狠一档）。 */
export const DEFAULT_PURGE_THRESHOLD = 0.04;

/**
 * 一张卡的保留分。
 * @param {object} fact - 至少含 `{kind, confidence, ts}`。
 * @param {number} inDegree - 有多少条边指向它。
 * @param {number} now - 当前时间戳。
 * @returns {number} 保留分，越大越该留。
 */
export function retentionOf(fact, inDegree, now) {
	const kind = String(fact.kind ?? "fact");
	const bucket = KIND_BUCKET[kind] ?? "snapshot";
	const base = BASE_WEIGHT[kind] ?? 0.5;
	const days = Math.max(0, (now - Number(fact.ts ?? 0)) / 86400000);
	const decay = Math.pow(0.5, days / HALF_LIFE_DAYS[bucket]);
	// 被引用越多越重要，但对数增长避免一张枢纽卡把别的全压死
	const boost = 1 + 0.25 * Math.log2(1 + Math.max(0, inDegree));
	const conf = Math.min(1, Math.max(0.05, Number(fact.confidence ?? 0.5)));
	return base * boost * conf * decay;
}

/**
 * 算出该降级 / 该淘汰的清单，不改库。
 *
 * @param {object} db - 已打开的库。
 * @param {object} [options] - `{threshold, purgeThreshold, now, includeDoubtful}`。
 * @returns {{demote: object[], supersede: object[], kept: number, total: number}} 计划。
 */
export function planReap(db, options = {}) {
	const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : DEFAULT_THRESHOLD;
	const purgeThreshold = Number(options.purgeThreshold) > 0 ? Number(options.purgeThreshold) : DEFAULT_PURGE_THRESHOLD;
	const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
	const statuses = options.includeDoubtful === true ? ["active", "doubtful"] : ["active"];

	const inDegree = new Map();
	for (const row of db.prepare("SELECT dst, COUNT(*) AS n FROM edge GROUP BY dst").all()) {
		inDegree.set(row.dst, Number(row.n));
	}

	const rows = db
		.prepare(
			`SELECT id, kind, status, confidence, ts, title, path FROM fact WHERE status IN (${statuses.map(() => "?").join(",")})`,
		)
		.all(...statuses);

	const demote = [];
	const supersede = [];
	let kept = 0;

	for (const row of rows) {
		const deg = inDegree.get(row.id) ?? 0;
		const score = retentionOf(row, deg, now);
		if (score >= threshold) {
			kept += 1;
			continue;
		}
		// 三条保护线：有引用 / 决策与偏好 / 高置信度
		const protectedByEdge = deg > 0;
		const protectedByKind = PINNED_KINDS.has(row.kind);
		const protectedByConfidence = Number(row.confidence ?? 0) >= 0.9;
		const canPurge = score < purgeThreshold && !protectedByEdge && !protectedByKind && !protectedByConfidence;

		const entry = {
			id: row.id,
			kind: row.kind,
			title: row.title,
			path: row.path,
			score: Math.round(score * 1000) / 1000,
			inDegree: deg,
			bucket: KIND_BUCKET[row.kind] ?? "snapshot",
		};
		if (canPurge) supersede.push(entry);
		else demote.push(entry);
	}

	// 分数最低的排前面，方便先看"最该忘的"
	demote.sort((a, b) => a.score - b.score);
	supersede.sort((a, b) => a.score - b.score);
	return { demote, supersede, kept, total: rows.length, threshold, purgeThreshold };
}

/**
 * 应用遗忘计划。
 *
 * @param {object} db - 已打开的库。
 * @param {object} [options] - `{threshold, purgeThreshold, now, dryRun, includeDoubtful}`。
 * @returns {{demoted: number, superseded: number, kept: number, total: number, dryRun: boolean, sample: object[]}} 结果。
 */
export function reap(db, options = {}) {
	const plan = planReap(db, options);
	const dryRun = options.dryRun === true;
	const nowIso = new Date().toISOString();

	if (!dryRun) {
		const demoteStmt = db.prepare("UPDATE fact SET status='doubtful', updated_at=? WHERE id=? AND status='active'");
		const purgeStmt = db.prepare("UPDATE fact SET status='superseded', updated_at=? WHERE id=? AND status IN ('active','doubtful')");
		db.exec("BEGIN");
		try {
			for (const item of plan.demote) demoteStmt.run(nowIso, item.id);
			for (const item of plan.supersede) purgeStmt.run(nowIso, item.id);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	return {
		demoted: plan.demote.length,
		superseded: plan.supersede.length,
		kept: plan.kept,
		total: plan.total,
		dryRun,
		threshold: plan.threshold,
		purgeThreshold: plan.purgeThreshold,
		// 只回最该忘的十条，够人核对规则对不对，不至于刷屏
		sample: [...plan.supersede, ...plan.demote].slice(0, 10),
	};
}
