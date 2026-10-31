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

test("apply 注册十个工具并注入系统提示", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	const names = ctx._tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["kb_add", "kb_distill", "kb_get", "kb_ingest", "kb_link", "kb_mirror", "kb_search", "kb_stats", "kb_tree", "kb_update"]);
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

test("ui 默认开：向 webServer 注册十七个端点，卸载时全部摘掉", () => {
	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") });
	assert.deepEqual(ctx._injected, [["webServer"]]);
	assert.equal(ctx._routes.length, 17);
	assert.deepEqual(
		ctx._routes.map((r) => r.path).sort(),
		["add", "distill", "fact", "facts", "forget", "graph", "history", "ingest", "link", "migrate", "mirror", "search", "stats", "sweep", "tree", "unmirror", "update"].map((n) => `/api/dsh-kb/${n}`).sort(),
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
	assert.equal(ctx._tools.length, 10);
	ctx._dispose();
});

test("没有 ctx.inject 的宿主（老运行时）不影响加载", () => {
	const ctx = makeCtx();
	delete ctx.inject;
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	assert.doesNotThrow(() => plugin.apply(ctx, { dbPath: path.join(dir, "kb.db") }));
	assert.equal(ctx._tools.length, 10);
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

test("入口包装层：转发 apply，导入失败也照样导出契约", async () => {
	const entry = await import("../lib/entry.js");
	assert.equal(entry.name, "dsh-kb");
	assert.deepEqual(entry.inject, ["tools", "systemPrompt"]);
	assert.equal(typeof entry.apply, "function");
	assert.equal(typeof entry.Config, "function");

	const ctx = makeCtx();
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-"));
	entry.apply(ctx, { dbPath: path.join(dir, "kb.db"), bootFacts: 0 });
	assert.equal(ctx._tools.length, 10, "包装层没把工具转发出来");
	ctx._dispose();
});

test("卡片画布布局：块按骨架路径分组、卡片落在块内、块不重叠、确定性", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (r) => { registration = r; } } }, undefined);
	const client = registration.factory((spec) => {
		if (spec === "react") {
			return { createElement: () => null, useState: () => [], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }), Fragment: "Fragment" };
		}
		throw new Error(`未声明模块：${spec}`);
	});
	assert.equal(typeof client.__layout, "function");

	const tree = [
		{ path: "topic", depth: 0, count: 0 },
		{ path: "topic/dsh", depth: 1, count: 2 },
		{ path: "topic/model", depth: 1, count: 1 },
	];
	const facts = [
		{ id: "f_a", title: "A", kind: "fix", path: "topic/dsh", confidence: 0.9, ts: 1, tags: ["t1"] },
		{ id: "f_b", title: "B", kind: "fact", path: "topic/dsh", confidence: 0.6, ts: 2 },
		{ id: "f_c", title: "C", kind: "decision", path: "topic/model", confidence: 0.8, ts: 3 },
	];
	const edges = [{ src: "f_a", dst: "f_b", rel: "related" }];

	const canvas = client.__layout({ tree, facts, edges });
	// 只有装了卡的路径才成块：topic 本身 0 张卡，不画空块
	assert.equal(canvas.hubs.length, 2);
	assert.equal(canvas.stars.length, 3);
	// 画布上只留卡片之间的真实关系：不再画"块 → 卡"的归属线（块的包围关系已表达归属）
	assert.equal(canvas.links.filter((l) => l.kind === "spine").length, 0);
	assert.equal(canvas.links.length, 1);
	assert.equal(canvas.links.filter((l) => l.kind === "related").length, 1);
	// 事实边带中文标签，供画布上那圈胶囊用
	const labelled = canvas.links.filter((l) => l.tagged === true);
	assert.equal(labelled.length, 1);
	assert.equal(labelled[0].label, "关联");

	// 卡片必须完整落在所属块内，否则视觉上会串枝
	for (const star of canvas.stars) {
		const hub = canvas.hubs.find((item) => item.path === star.home);
		assert.ok(hub, `卡片 ${star.id} 的 home 没有对应块`);
		assert.ok(star.x >= hub.x && star.y >= hub.y, `卡片 ${star.id} 越出块左上`);
		assert.ok(star.x + star.w <= hub.x + hub.w && star.y + star.h <= hub.y + hub.h, `卡片 ${star.id} 越出块右下`);
	}

	// 块之间不重叠
	for (let a = 0; a < canvas.hubs.length; a += 1) {
		for (let b = a + 1; b < canvas.hubs.length; b += 1) {
			const one = canvas.hubs[a];
			const two = canvas.hubs[b];
			const hit = one.x < two.x + two.w && two.x < one.x + one.w && one.y < two.y + two.h && two.y < one.y + one.h;
			assert.equal(hit, false, `${one.path} 与 ${two.path} 的块重叠了`);
		}
	}

	assert.ok(canvas.width > 0 && canvas.height > 0, "画布尺寸必须是正的");

	// 确定性：同样的输入两次布局一致（刷新不跳）
	const again = client.__layout({ tree, facts, edges });
	assert.deepEqual(again.stars.map((s) => [s.id, s.x, s.y]), canvas.stars.map((s) => [s.id, s.x, s.y]));
});
