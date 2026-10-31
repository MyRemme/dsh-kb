/**
 * 提炼链路测试：原料采集 → 提示词 → 解析 → 落库 → 有/无模型通道两条分支。
 *
 * 重点是"提炼不编造"这条边界：解析层要挡住缺字段、超量、非法 kind；
 * 无模型通道时必须**明确退回出料**，不能假装提炼成功。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, upsertFact, addEdge } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import {
	MATERIAL_KINDS,
	collectMaterial,
	buildPrompt,
	parseCards,
	saveDistilled,
	distillWithModel,
	exportMaterial,
} from "../lib/distill.js";
import { resolveModel } from "../lib/model.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-distill-"));
const { db } = openDb(path.join(dir, "kb.db"));

/** 造一批原料。 */
function seed() {
	upsertFact(db, { title: "[会话] 装插件踩坑", body: "用户原话：装这个插件。npm 上的 dsh-kb 是别人的包。", kind: "episode", path: "topic/dsh", ts: Date.now() - 5000 }, seg);
	upsertFact(db, { title: "[意图] 修面板", body: "用户原话：面板没出来，再试试。", kind: "intent", path: "topic/dsh", ts: Date.now() - 4000 }, seg);
	upsertFact(db, { title: "当时的待办", body: "Pending: 重新打包。", kind: "todo", path: "topic/dsh", ts: Date.now() - 3000 }, seg);
	upsertFact(db, { title: "已经有结论的卡", body: "link: 会导致 peer 解析失败。", kind: "fix", path: "topic/dsh", ts: Date.now() - 2000 }, seg);
}

test("collectMaterial 只取原料类型，按时间倒序，可限枝", () => {
	seed();
	const all = collectMaterial(db, { limit: 20 });
	assert.ok(all.length >= 3);
	assert.ok(all.every((m) => MATERIAL_KINDS.includes(m.kind)));
	// 结论型卡不是原料：fix/decision 已经是提炼结果，再提炼只会自我循环。
	assert.ok(all.every((m) => !["fix", "decision"].includes(m.kind)));
	assert.ok(all.every((m) => typeof m.excerpt === "string" && m.excerpt.length <= 900));
	const ordered = [...all].sort((a, b) => b.ts - a.ts);
	assert.deepEqual(all.map((m) => m.id), ordered.map((m) => m.id));

	const scoped = collectMaterial(db, { path: "topic/none", limit: 20 });
	assert.equal(scoped.length, 0);
});

test("collectMaterial 尊重 limit", () => {
	const rows = collectMaterial(db, { limit: 2 });
	assert.equal(rows.length, 2);
});

test("buildPrompt 把原料与规则都写进去", () => {
	const material = collectMaterial(db, { limit: 3 });
	const prompt = buildPrompt(material);
	assert.match(prompt.system, /不许编造/);
	assert.match(prompt.system, /一条卡只讲一个事实/);
	assert.match(prompt.system, /JSON 数组/);
	assert.match(prompt.user, /#1 \[/);
	assert.match(prompt.user, /最多 8 条/);
});

test("parseCards 容忍围栏与前后废话，挡住脏数据", () => {
	const raw = [
		"好的，下面是提炼结果：",
		"```json",
		JSON.stringify([
			{ title: "结论一", body: "正文一", kind: "fix", path: "topic/dsh" },
			{ title: "", body: "缺标题" },
			{ title: "结论二", body: "正文二", kind: "nonsense" },
		]),
		"```",
		"以上。",
	].join("\n");
	const cards = parseCards(raw);
	assert.equal(cards.length, 2, "缺标题的那条应被丢掉");
	assert.equal(cards[0].kind, "fix");
	assert.equal(cards[1].kind, "fact", "非法 kind 应回落 fact");
});

test("parseCards 对非 JSON 返回空数组，不抛", () => {
	assert.deepEqual(parseCards("模型今天不想输出"), []);
	assert.deepEqual(parseCards(""), []);
	assert.deepEqual(parseCards("[not json"), []);
});

test("saveDistilled 落库并建 derived_from 边指回原料", () => {
	const sources = collectMaterial(db, { limit: 2 }).map((m) => m.id);
	const cards = [{ title: "提炼出的结论 A", body: "根因与边界都写清楚。", kind: "decision", path: "topic/dsh" }];
	const result = saveDistilled(db, cards, { sourceIds: sources, path: "topic/dsh" });
	assert.equal(result.added, 1);
	const row = db.prepare("SELECT id, source_kind, confidence FROM fact WHERE title=?").get("提炼出的结论 A");
	assert.equal(row.source_kind, "distill");
	assert.ok(Number(row.confidence) >= 0.8);
	const edges = db.prepare("SELECT dst, rel FROM edge WHERE src=?").all(row.id);
	assert.equal(edges.length, sources.length);
	assert.ok(edges.every((e) => e.rel === "derived_from"));
});

test("distillWithModel 走通：假模型吐 JSON，落库计数正确", async () => {
	const fake = {
		provider: "fake",
		model: "fake-1",
		async complete() {
			return JSON.stringify([{ title: "假模型提炼出的结论", body: "正文自包含。", kind: "howto", path: "topic/dsh" }]);
		},
	};
	const result = await distillWithModel(db, fake, { limit: 3 });
	assert.equal(result.provider, "fake");
	assert.equal(result.cards, 1);
	assert.equal(result.added, 1);
	assert.ok(result.material >= 1);
});

test("distillWithModel 原料为空时不调模型", async () => {
	let called = false;
	const fake = { provider: "fake", model: "fake-1", async complete() { called = true; return "[]"; } };
	const result = await distillWithModel(db, fake, { path: "topic/empty" });
	assert.equal(called, false);
	assert.equal(result.material, 0);
	assert.equal(result.added, 0);
});

test("exportMaterial：无模型通道时的出料包", () => {
	// 前面的用例已经给 seed() 那批建过 derived_from，这里补一段"没被提炼过"的原料
	upsertFact(db, { title: "[会话] 出料专用原料", body: "用户原话：这段还没被提炼过。", kind: "episode", path: "topic/dsh", ts: Date.now() }, seg);
	const pack = exportMaterial(db, { limit: 2 });
	assert.ok(pack.material >= 1);
	assert.match(pack.prompt.user, /原料/);
});

test("collectMaterial 默认排除已提炼过的原料（derived_from 的 dst）", () => {
	seed();
	const target = db.prepare("SELECT id FROM fact WHERE title=?").get("[意图] 修面板");
	assert.ok(target, "seed 应该建出这张原料卡");
	const consumer = db.prepare("SELECT id FROM fact WHERE title=?").get("已经有结论的卡");
	addEdge(db, consumer.id, target.id, "derived_from", 1, "测试用");

	const fresh = collectMaterial(db, { limit: 50 }).map((m) => m.title);
	assert.ok(!fresh.includes("[意图] 修面板"), "被 derived_from 指向的原料不该再出");

	const all = collectMaterial(db, { limit: 50, includeSpent: true }).map((m) => m.title);
	assert.ok(all.includes("[意图] 修面板"), "includeSpent 时才回来");
});

test("resolveModel：没有 llm 服务或没有模型时返回 undefined", async () => {
	assert.equal(await resolveModel({}, {}), undefined);
	assert.equal(await resolveModel({ llm: {} }, {}), undefined);
	assert.equal(await resolveModel({ llm: { stream() {}, listProviders: () => [] } }, {}), undefined);
});

test("resolveModel：拿到通道后按 text-delta 累加文本", async () => {
	const llm = {
		stream(options) {
			assert.equal(options.provider, "p1");
			assert.equal(options.model, "m1");
			return (async function* () {
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text: "你" };
				yield { type: "text-delta", index: 0, text: "好" };
				yield { type: "finish", reason: "stop" };
			})();
		},
		listProviders: () => [{ id: "p1" }],
		async listModels() {
			return [{ id: "m1" }];
		},
	};
	const model = await resolveModel({ llm }, {});
	assert.equal(model.provider, "p1");
	assert.equal(model.model, "m1");
	assert.equal(await model.complete({ system: "s", user: "u" }), "你好");
});
