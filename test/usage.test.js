/**
 * 使用反馈的测试。
 *
 * 这层的意义是让"有没有用"从猜变成测，所以测试要盯住两件事：
 *   1. 记账本身准不准（计数、明细、边界输入）
 *   2. 它真的能改变遗忘判断吗（实测有用 vs 实测没用，保留分要拉开）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, upsertFact } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { recordUsage, recordHits, usageOf, usageSummary, recentUsage, USAGE_KINDS } from "../lib/usage.js";
import { retentionOf } from "../lib/reap.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-usage-test-"));
const { db } = openDb(path.join(dir, "kb.db"));
const DAY = 86400000;
const now = Date.now();

function make(title, kind = "fact", ageDays = 0) {
	upsertFact(db, { title, body: `正文 ${title}`, kind, path: "topic/x", ts: now - ageDays * DAY }, seg);
	return db.prepare("SELECT id FROM fact WHERE title=?").get(title).id;
}
const rowOf = (id) => db.prepare("SELECT * FROM fact WHERE id=?").get(id);

test("记一次 hit：汇总列加一，明细落一行", () => {
	const id = make("记 hit 的卡");
	assert.equal(recordUsage(db, id, "hit", { query: "某个查询", rank: 2, source: "tool" }), true);
	const row = rowOf(id);
	assert.equal(Number(row.hit_count), 1);
	assert.ok(Number(row.last_hit_at) > 0, "last_hit_at 要记上");
	const recent = recentUsage(db, id, 5);
	assert.equal(recent.length, 1);
	assert.equal(recent[0].kind, "hit");
	assert.equal(recent[0].query, "某个查询");
	assert.equal(recent[0].rank, 2);
});

test("adopt 与 reject 各自计数，不互相污染", () => {
	const id = make("记采纳否决的卡");
	recordUsage(db, id, "adopt");
	recordUsage(db, id, "adopt");
	recordUsage(db, id, "reject");
	const row = rowOf(id);
	assert.equal(Number(row.adopt_count), 2);
	assert.equal(Number(row.reject_count), 1);
	assert.equal(Number(row.hit_count), 0, "不该动到 hit");
});

test("样本不足三次时不下结论：measured 为 null", () => {
	const id = make("样本不足的卡");
	recordUsage(db, id, "adopt");
	recordUsage(db, id, "adopt");
	const u = usageOf(rowOf(id));
	assert.equal(u.sample, 2);
	assert.equal(u.measured, null, "两次采纳还不够，不能凭它加权");
});

test("样本够了：全采纳为正，全否决为负，否决权重更高", () => {
	const good = make("全采纳的卡");
	for (let i = 0; i < 3; i += 1) recordUsage(db, good, "adopt");
	const goodScore = usageOf(rowOf(good)).measured;
	assert.ok(goodScore > 0.9, `全采纳应接近 1，实际 ${goodScore}`);

	const bad = make("全否决的卡");
	for (let i = 0; i < 3; i += 1) recordUsage(db, bad, "reject");
	assert.equal(usageOf(rowOf(bad)).measured, -1, "全否决应压到 -1");

	// 各两次：否决的负向幅度要大于采纳的正向
	const mixed = make("既有采纳也有否决的卡");
	recordUsage(db, mixed, "adopt");
	recordUsage(db, mixed, "adopt");
	recordUsage(db, mixed, "reject");
	recordUsage(db, mixed, "hit");
	const m = usageOf(rowOf(mixed)).measured;
	assert.ok(m < 0.2, `2 采纳 1 否决 1 命中应偏中性偏负，实际 ${m}`);
});

test("recordHits 批量记账，rank 从 1 递增", () => {
	const a = make("批量命中 A");
	const b = make("批量命中 B");
	const n = recordHits(db, [{ id: a }, { id: b }], "批量查询", "tool");
	assert.equal(n, 2);
	assert.equal(Number(rowOf(a).hit_count), 1);
	assert.equal(Number(rowOf(b).hit_count), 1);
	const events = recentUsage(db, b, 5);
	assert.equal(events[0].rank, 2, "第二张卡的 rank 应为 2");
});

test("边界输入：不存在的卡、非法 kind，都不记也不抛", () => {
	const id = make("边界测试卡");
	assert.equal(recordUsage(db, "f_不存在", "hit"), false);
	assert.equal(recordUsage(db, id, "DROP TABLE"), false);
	assert.equal(recordUsage(db, id, ""), false);
	assert.equal(recordUsage(db, null, "hit"), false);
	// 阅读与引用独立于明确反馈
	assert.deepEqual([...USAGE_KINDS].sort(), ["adopt", "cite", "hit", "open", "reject"]);
	assert.equal(Number(rowOf(id).hit_count), 0, "非法调用不该留下痕迹");
});

test("实测数据真的能改变保留分：同年龄同类型，被采纳的留得更久", () => {
	const liked = make("被采纳的老卡", "fix", 120);
	const ignored = make("没人用的老卡", "fix", 120);
	const disliked = make("被否决的老卡", "fix", 120);

	for (let i = 0; i < 4; i += 1) recordUsage(db, liked, "adopt");
	for (let i = 0; i < 4; i += 1) recordUsage(db, disliked, "reject");

	const rLiked = retentionOf(rowOf(liked), 0, now);
	const rIgnored = retentionOf(rowOf(ignored), 0, now);
	const rDisliked = retentionOf(rowOf(disliked), 0, now);

	assert.ok(rLiked > rIgnored, `被采纳的应高于没人用的：${rLiked} vs ${rIgnored}`);
	assert.ok(rDisliked < rIgnored, `被否决的应低于没人用的：${rDisliked} vs ${rIgnored}`);
});

test("从没被命中过的流水账额外降一档，但结论卡不受影响", () => {
	const diaryTouched = make("被命中过的流水", "episode", 30);
	const diaryIdle = make("没人碰的流水", "episode", 30);
	const conclIdle = make("没人碰的结论", "fix", 30);
	recordUsage(db, diaryTouched, "hit");

	const a = retentionOf(rowOf(diaryTouched), 0, now);
	const b = retentionOf(rowOf(diaryIdle), 0, now);
	assert.ok(b < a, `没人碰的流水该更低：${b} vs ${a}`);

	// 结论卡本来 base 高，idlePenalty 只作用于 diary 档
	const c = retentionOf(rowOf(conclIdle), 0, now);
	assert.ok(c > b * 3, "结论卡不该被 idle 惩罚到流水账水平");
});

test("全库概况：未被使用的卡数算得对", () => {
	const used = make("概况用卡-已用");
	recordUsage(db, used, "hit");
	const summary = usageSummary(db);
	assert.ok(summary.totalCards > 0);
	assert.ok(summary.usedCards > 0);
	assert.equal(summary.neverUsed, summary.totalCards - summary.usedCards, "neverUsed 应该等于总数减已用");
	assert.ok(summary.hits > 0);
});
