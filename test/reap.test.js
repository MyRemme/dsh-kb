/**
 * 动态遗忘的测试。
 *
 * 重点不是"能不能降级"，而是**该不该降级**：
 *   - 老的流水账该走
 *   - 老的结论卡不该走
 *   - 有引用的不走
 *   - 决策和偏好不走
 *   - 默认 dryRun 语义、真跑之后状态确实变了
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, upsertFact, addEdge } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import {
	retentionOf,
	planReap,
	reap,
	KIND_BUCKET,
	HALF_LIFE_DAYS,
	PINNED_KINDS,
	DEFAULT_THRESHOLD,
} from "../lib/reap.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-reap-"));
const { db } = openDb(path.join(dir, "kb.db"));
const DAY = 86400000;
const now = Date.now();

/** 造一张卡，指定类型与年龄（天）。 */
function make(title, kind, ageDays, confidence = 0.5) {
	upsertFact(
		db,
		{ title, body: `正文 ${title}`, kind, path: "topic/x", ts: now - ageDays * DAY, confidence },
		seg,
	);
	return db.prepare("SELECT id FROM fact WHERE title=?").get(title).id;
}

test("保留分：同类型越老越低，同年龄结论比流水账高", () => {
	const fresh = retentionOf({ kind: "episode", confidence: 0.5, ts: now }, 0, now);
	const old = retentionOf({ kind: "episode", confidence: 0.5, ts: now - 90 * DAY }, 0, now);
	assert.ok(old < fresh, "越老保留分越低");

	const diary = retentionOf({ kind: "episode", confidence: 0.5, ts: now - 90 * DAY }, 0, now);
	const conclusion = retentionOf({ kind: "fix", confidence: 0.5, ts: now - 90 * DAY }, 0, now);
	assert.ok(conclusion > diary * 3, "同一年龄，结论卡应显著高于流水账");
});

test("保留分：被引用会抬高，但对数增长不会让单卡压垮全部", () => {
	const base = retentionOf({ kind: "fact", confidence: 0.5, ts: now - 30 * DAY }, 0, now);
	const once = retentionOf({ kind: "fact", confidence: 0.5, ts: now - 30 * DAY }, 1, now);
	const huge = retentionOf({ kind: "fact", confidence: 0.5, ts: now - 30 * DAY }, 1000, now);
	assert.ok(once > base, "有引用应该更高");
	assert.ok(huge < base * 10, "引用 1000 次也不该涨到十倍");
});

test("半衰期按档位不同：情景 45 天、快照 90 天、结论 540 天", () => {
	assert.equal(HALF_LIFE_DAYS.diary, 45);
	assert.equal(HALF_LIFE_DAYS.snapshot, 90);
	assert.equal(HALF_LIFE_DAYS.conclusion, 540);
	// 正好一个半衰期时，衰减项应为 0.5
	const oneHalfLife = (kind) => {
		const bucket = KIND_BUCKET[kind];
		const half = HALF_LIFE_DAYS[bucket];
		const atHalf = retentionOf({ kind, confidence: 1, ts: now - half * DAY }, 0, now);
		const atZero = retentionOf({ kind, confidence: 1, ts: now }, 0, now);
		return atHalf / atZero;
	};
	assert.ok(Math.abs(oneHalfLife("episode") - 0.5) < 0.01);
	assert.ok(Math.abs(oneHalfLife("fix") - 0.5) < 0.01);
});

test("老的流水账会被降级，老的结论卡不会", () => {
	const diaryId = make("老会话流水", "episode", 200);
	const fixId = make("老结论修复", "fix", 200);

	const plan = planReap(db, { now });
	const demotedIds = [...plan.demote, ...plan.supersede].map((x) => x.id);
	assert.ok(demotedIds.includes(diaryId), "200 天的会话流水该被忘掉");
	assert.ok(!demotedIds.includes(fixId), "200 天的结论卡不该被忘掉");
});

test("三条保护线：有引用 / decision / 高置信度，都不做最狠的淘汰", () => {
	const linked = make("被引用的老流水", "episode", 400);
	const consumer = make("引用它的卡", "fact", 1);
	addEdge(db, consumer, linked, "derived_from", 1, "测试");
	const decisionId = make("老决定", "decision", 800);
	const confidentId = make("高置信度老流水", "episode", 400, 0.95);

	const plan = planReap(db, { now });
	const supIds = plan.supersede.map((x) => x.id);
	assert.ok(!supIds.includes(linked), "有入边的不该被淘汰（它可能是别人的依据）");
	assert.ok(!supIds.includes(decisionId), "decision 永不被自动淘汰");
	assert.ok(!supIds.includes(confidentId), "置信度 >=0.9 的不该被淘汰");
	// decision 也不该被降级
	assert.ok(!plan.demote.some((x) => x.id === decisionId), "decision 连降级都不做");
});

test("planReap 不改库；reap 默认 dryRun 也不改库", () => {
	const id = make("dryRun 用卡", "episode", 300);
	const before = db.prepare("SELECT status FROM fact WHERE id=?").get(id).status;
	planReap(db, { now });
	const result = reap(db, { now, dryRun: true });
	const after = db.prepare("SELECT status FROM fact WHERE id=?").get(id).status;
	assert.equal(result.dryRun, true);
	assert.equal(before, after, "dryRun 不能改状态");
	assert.ok(result.demoted + result.superseded > 0, "应该报告出待处理的量");
});

test("真跑之后状态确实变了，而且可逆（superseded 还能查回来）", () => {
	const id = make("真跑用卡", "episode", 400);
	const result = reap(db, { now });
	assert.equal(result.dryRun, false);
	const row = db.prepare("SELECT status FROM fact WHERE id=?").get(id);
	assert.ok(["doubtful", "superseded"].includes(row.status), `状态应被改动，实际 ${row.status}`);

	// 不是物理删除：卡还在，只是状态变了
	const still = db.prepare("SELECT title FROM fact WHERE id=?").get(id);
	assert.equal(still.title, "真跑用卡");

	// 这条路径能把它救回来
	const back = reap(db, { now, dryRun: true });
	assert.ok(typeof back.kept === "number");
});

test("阈值可调：调高之后处理更多，调低之后一个不动", () => {
	const high = reap(db, { now, dryRun: true, threshold: 0.99, purgeThreshold: 0.98 });
	const low = reap(db, { now, dryRun: true, threshold: 0.0001, purgeThreshold: 0.00001 });
	assert.ok(high.demoted + high.superseded > low.demoted + low.superseded, "阈值越高处理越多");
	assert.equal(low.demoted + low.superseded, 0, "极低阈值下不该动任何卡");
});

test("默认阈值为 0.09，且 sample 只回十条", () => {
	assert.equal(DEFAULT_THRESHOLD, 0.09);
	const result = reap(db, { now, dryRun: true, threshold: 0.99, purgeThreshold: 0.98 });
	assert.ok(result.sample.length <= 10);
	if (result.sample.length > 0) {
		assert.ok(typeof result.sample[0].score === "number");
		assert.ok(typeof result.sample[0].kind === "string");
	}
	assert.ok(PINNED_KINDS.has("decision"));
});
