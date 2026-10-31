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
	const disposers = [];
	const routes = [];
	const injected = [];
	const ctx = {
		tools: { register: (def) => tools.push(def) },
		systemPrompt: {
			section: (s) => sections.push(s),
			getSectionOrder: () => 100,
		},
		effect: (fn) => disposers.push(fn()),
		// 可选服务：dsh 里是 cordis 的 ctx.inject，这里同步回调，等价于"服务已在"。
		inject: (deps, callback) => {
			injected.push(deps);
			callback(ctx);
		},
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {
					const at = routes.indexOf(route);
					if (at >= 0) routes.splice(at, 1);
				};
			},
		},
		// 测试内省用的把手
		_tools: tools,
		_sections: sections,
		_routes: routes,
		_injected: injected,
		_dispose: () => disposers.forEach((d) => d?.()),
	};
	return ctx;
}

test("插件导出契约：name / inject / apply / Config", () => {
	assert.equal(plugin.name, "dsh-kb");
	assert.deepEqual([...plugin.inject].sort(), ["systemPrompt", "tools"]);
	assert.equal(typeof plugin.apply, "function");
	assert.equal(typeof plugin.Config, "function");
});

test("apply 注册五个工具并注入系统提示", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const names = ctx._tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["kb_add", "kb_get", "kb_ingest", "kb_search", "kb_stats", "kb_tree", "kb_update"]);
	assert.equal(ctx._sections.length, 2);
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

test("ui 默认开：向 webServer 注册十二个端点，卸载时全部摘掉", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	assert.deepEqual(ctx._injected, [["webServer"]]);
	assert.equal(ctx._routes.length, 12);
	assert.deepEqual(
		ctx._routes.map((r) => r.path).sort(),
		["add", "fact", "facts", "forget", "graph", "history", "ingest", "search", "stats", "sweep", "tree", "update"].map((n) => `/api/dsh-kb/${n}`).sort(),
	);
	assert.ok(ctx._routes.every((r) => r.kind === "exact" && typeof r.handler === "function"));
	ctx._dispose();
	assert.equal(ctx._routes.length, 0, "卸载后路由没有摘干净");
});

test("ui=false 不注入 webServer，工具照常可用", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db"), ui: false });
	assert.equal(ctx._injected.length, 0);
	assert.equal(ctx._routes.length, 0);
	assert.equal(ctx._tools.length, 7);
	ctx._dispose();
});

test("没有 ctx.inject 的宿主（老运行时）不影响加载", () => {
	const ctx = makeCtx();
	delete ctx.inject;
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	assert.doesNotThrow(() => plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") }));
	assert.equal(ctx._tools.length, 7);
	ctx._dispose();
});

test("客户端半：ModuleLoader 用包名注册，向两个 slot 各挂一次", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	const fakeWindow = { __ModuleLoader__: { load: (reg) => { registration = reg; } } };
	new Function("window", "document", source)(fakeWindow, undefined);

	// 模块表按"条目名 == 包名"索引，注册 id 必须与 package.json 的 name 一致。
	assert.equal(registration.id, "@myremme/dsh-kb");
	const clientExports = registration.factory((spec) => {
		if (spec === "react") {
			return {
				createElement: () => null,
				useState: () => [],
				useEffect: () => {},
				useCallback: (f) => f,
				useMemo: (f) => f(),
				useRef: () => ({ current: null }),
			};
		}
		throw new Error(`客户端 bundle 请求了未声明的模块：${spec}`);
	});
	assert.equal(clientExports.name, "dsh-kb");
	assert.deepEqual(clientExports.inject, ["slots"]);
	assert.equal(typeof clientExports.apply, "function");

	const registered = [];
	const slots = {
		inject: (_name, callback) => callback(),
		register: (options, Component) => {
			registered.push({ options, Component });
			return () => {};
		},
	};
	clientExports.apply({ slots });
	assert.equal(registered.length, 2);

	const panellist = registered.find((r) => r.options.name === "sidebar.panellist");
	assert.ok(panellist, "没注册侧边栏图标");
	assert.equal(panellist.options.id, "dsh-kb");
	assert.equal(panellist.options.order, 32);
	assert.equal(panellist.options.label(), "记忆");
	assert.equal(typeof panellist.Component, "function");

	const main = registered.find((r) => r.options.name === "main");
	assert.ok(main, "没注册主面板");
	assert.equal(main.options.key, "dsh-kb");
	assert.equal(typeof main.Component, "function");
});

test("package.json 声明了 dsh.client 且 exports 暴露 ./client", async () => {
	const { readFileSync } = await import("node:fs");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.name, "@myremme/dsh-kb");
	assert.equal(pkg.dsh.client.platform, "web");
	assert.equal(pkg.exports["./client"], "./lib/client.js");
	assert.equal(pkg.exports["./export"], "./lib/export.js");
	assert.ok(pkg.files.includes("lib/**/*.js"));
});

test("开场注入：每轮现算最近 N 张卡，写入后下一轮就能看见", async () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db"), bootFacts: 3 });

	const boot = ctx._sections.find((s) => s.name === "memory:dsh-kb:boot");
	assert.ok(boot, "没注册开场注入段");
	assert.equal(boot.order, 109);
	assert.equal(typeof boot.text, "function", "开场注入必须是函数，否则加载时就冻住了");
	assert.equal(boot.text(), "", "空库应当注入空串，而不是一句空标题");

	await ctx._tools.find((t) => t.name === "kb_add").execute({ title: "会被注入的第一条", body: "正文", path: "topic/dsh" });
	const text = boot.text();
	assert.match(text, /会被注入的第一条/);
	assert.match(text, /最近记住的事/);
	assert.match(text, /kb_get/, "注入里要给出读全文的办法");
	ctx._dispose();
});

test("bootFacts=0 关闭开场注入", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db"), bootFacts: 0 });
	assert.equal(ctx._sections.filter((s) => s.name === "memory:dsh-kb:boot").length, 0);
	assert.equal(ctx._sections.length, 1, "记忆纪律那段应保留");
	ctx._dispose();
});

test("ingestEveryMinutes>0 时挂定时器，0 时不挂", () => {
	const original = globalThis.setInterval;
	const started = [];
	globalThis.setInterval = (fn, ms) => {
		started.push(ms);
		return { unref() {}, fake: true };
	};
	try {
		const ctx = makeCtx();
		const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
		plugin.apply(ctx, { dbPath: path.join(dir, "kb.db"), ingestEveryMinutes: 15 });
		assert.deepEqual(started, [15 * 60000]);
		ctx._dispose();

		started.length = 0;
		const ctx2 = makeCtx();
		plugin.apply(ctx2, { dbPath: path.join(dir, "kb2.db"), ingestEveryMinutes: 0 });
		assert.deepEqual(started, [], "0 表示关闭");
		ctx2._dispose();
	} finally {
		globalThis.setInterval = original;
	}
});

test("kb_update 走工具改原卡，kb_get 读全文与历史", async () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const add = ctx._tools.find((t) => t.name === "kb_add");
	const upd = ctx._tools.find((t) => t.name === "kb_update");
	const get = ctx._tools.find((t) => t.name === "kb_get");

	await add.execute({ title: "工具层的修订", body: "第一版。", path: "topic/dsh" });
	const { DatabaseSync } = await import("node:sqlite");
	const ro = new DatabaseSync(path.join(dir, "kb.db"), { readOnly: true });
	const real = ro.prepare("SELECT id FROM fact WHERE title=?").get("工具层的修订");
	ro.close();

	const r1 = await upd.execute({ id: real.id, body: "第二版，补了边界。" });
	assert.match(r1.text, /v2/);
	const full = await get.execute({ id: real.id });
	assert.match(full.text, /第二版/);
	assert.match(full.text, /历史版本 1 个/);
	ctx._dispose();
});

test("kb_get 读不到时给出可执行提示", async () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const get = ctx._tools.find((t) => t.name === "kb_get");
	const res = await get.execute({ id: "f_doesnotexist" });
	assert.match(res.text, /没找到/);
	ctx._dispose();
});
