/**
 * 插件装载集成测试：用 resolve hook 把两个 dsh 内部包映射到本地替身，
 * 然后真的走一遍 apply(ctx, config)，验证工具注册、提示注入和工具执行。
 *
 * 这样在没有 dsh 运行时的机器上也能验证插件契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (name) => new URL(`./fixtures/${name}.mjs`, import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@deepseek-ai/dsh-tools") return { url: stub("dsh-tools-stub"), shortCircuit: true };
		if (specifier === "@deepseek-ai/schemastery") return { url: stub("schemastery-stub"), shortCircuit: true };
		return next(specifier, context);
	},
});

const plugin = await import("../lib/index.js");

/** 造一个最小的 cordis ctx 替身。 */
function makeCtx() {
	const tools = [];
	const sections = [];
	const routes = [];
	const disposers = [];
	return {
		tools: { register: (def) => tools.push(def) },
		webServer: {
			register: (entry) => {
				routes.push(entry);
				return () => {
					const at = routes.indexOf(entry);
					if (at >= 0) routes.splice(at, 1);
				};
			},
		},
		systemPrompt: {
			section: (s) => sections.push(s),
			getSectionOrder: () => 100,
		},
		effect: (fn) => disposers.push(fn()),
		// 测试内省用的把手
		_tools: tools,
		_sections: sections,
		_routes: routes,
		_dispose: () => disposers.forEach((d) => d?.()),
	};
}

test("插件导出契约：name / inject / apply / Config", () => {
	assert.equal(plugin.name, "dsh-kb");
	assert.deepEqual([...plugin.inject].sort(), ["systemPrompt", "tools", "webServer"]);
	assert.equal(typeof plugin.apply, "function");
	assert.equal(typeof plugin.Config, "function");
});

test("apply 注册 /api/dsh-kb/* 路由，卸载时全部清理", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const paths = ctx._routes.map((r) => r.path).sort();
	assert.deepEqual(paths, [
		"/api/dsh-kb/card",
		"/api/dsh-kb/cards",
		"/api/dsh-kb/forget",
		"/api/dsh-kb/graph",
		"/api/dsh-kb/ingest",
		"/api/dsh-kb/search",
		"/api/dsh-kb/stats",
		"/api/dsh-kb/tree",
	]);
	for (const r of ctx._routes) {
		assert.equal(r.kind, "exact");
		assert.equal(typeof r.handler, "function");
	}
	ctx._dispose();
	assert.equal(ctx._routes.length, 0);
});

test("apply 注册五个工具并注入系统提示", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const names = ctx._tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["kb_add", "kb_ingest", "kb_search", "kb_stats", "kb_tree"]);
	assert.equal(ctx._sections.length, 1);
	assert.match(ctx._sections[0].text, /kb_search/);
	ctx._dispose();
});

test("enabled=false 时什么都不注册", () => {
	const ctx = makeCtx();
	plugin.apply(ctx, { enabled: false });
	assert.equal(ctx._tools.length, 0);
	assert.equal(ctx._sections.length, 0);
});

test("工具参数与输出契约完整", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	for (const t of ctx._tools) {
		assert.equal(typeof t.description, "string", `${t.name} 缺 description`);
		assert.equal(typeof t.execute, "function", `${t.name} 缺 execute`);
		assert.equal(t.output.schema.type, "object", `${t.name} 缺 output.schema`);
		assert.equal(typeof t.output.render, "function", `${t.name} 缺 output.render`);
		assert.equal(typeof t.presentCall, "function", `${t.name} 缺 presentCall`);
	}
	ctx._dispose();
});

test("kb_add 与 kb_search 端到端打通", async () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const add = ctx._tools.find((t) => t.name === "kb_add");
	const search = ctx._tools.find((t) => t.name === "kb_search");

	const w = await add.execute({
		title: "中文检索必须做 bigram 预分词",
		body: "FTS5 的 trigram 对双字中文词失效，改用默认分词器 + bigram 预切。",
		path: "topic/knowledge",
		kind: "fix",
		tags: "sqlite,检索",
	});
	assert.match(w.text, /已写入/);

	const r = await search.execute({ query: "中文分词", k: 3 });
	assert.match(r.text, /bigram/);
	assert.match(r.text, /ref: f_/);

	// 幂等
	const again = await add.execute({ title: "中文检索必须做 bigram 预分词", body: "FTS5 的 trigram 对双字中文词失效，改用默认分词器 + bigram 预切。", path: "topic/knowledge" });
	assert.match(again.text, /已存在/);
	ctx._dispose();
});

test("kb_tree 与 kb_stats 能读到刚写的数据", async () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	await ctx._tools.find((t) => t.name === "kb_add").execute({ title: "测试卡", body: "正文", path: "topic/dsh" });
	const tree = await ctx._tools.find((t) => t.name === "kb_tree").execute({ prefix: "topic" });
	assert.match(tree.text, /topic\/dsh|dsh/);
	const stats = JSON.parse((await ctx._tools.find((t) => t.name === "kb_stats").execute({})).text);
	assert.equal(stats.facts, 1);
	assert.equal(stats.paths["topic/dsh"], 1);
	ctx._dispose();
});
