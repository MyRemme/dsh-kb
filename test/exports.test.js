/**
 * 导出契约测试：cordis 加载器用 `unwrapExports()` 取插件，实现是
 * `exports = exports.default ?? exports`，所以一旦模块里出现 `export default apply`
 * （或 client 端的 `exports.default = apply`），加载器拿到的就是裸函数，
 * 挂在命名导出上的 `inject` / `name` / `Config` 全部丢失：
 *
 *   - host 侧：`apply` 里第一次 `ctx.tools.register(...)` 直接抛
 *     `cannot get property "tools" without inject`，整条 fiber 失败；
 *   - client 侧：`inject: ["slots"]` 丢失，入口停在 `loading`，
 *     前端 boot 检查报 `web boot: 1 entry did not activate` 并中止启动。
 *
 * 官方插件（dsh-tool-fs / dsh-skill-filesystem）都只做命名导出，没有 default。
 * 这个测试把该约定钉住，避免下次重写插件时又把它带回来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// entry.js 顶层会写加载日志；指到临时目录，别污染真实的 ~/.dsh/kb/plugin.log。
process.env.DSH_KB_HOME = mkdtempSync(path.join(os.tmpdir(), "dsh-kb-entry-"));

const stub = (name) => new URL(`./fixtures/${name}.mjs`, import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@deepseek-ai/dsh-tools") return { url: stub("dsh-tools-stub"), shortCircuit: true };
		if (specifier === "@deepseek-ai/schemastery") return { url: stub("schemastery-stub"), shortCircuit: true };
		return next(specifier, context);
	},
});

const plugin = await import("../lib/index.js");
const entry = await import("../lib/entry.js");

test("host 模块不提供 default 导出（否则 cordis 会丢掉 inject）", () => {
	assert.equal(plugin.default, undefined);
});

test("host 模块的命名导出齐全且 apply 是函数", () => {
	assert.equal(typeof plugin.apply, "function");
	assert.equal(typeof plugin.Config, "function");
	assert.equal(plugin.name, "dsh-kb");
	assert.ok(Array.isArray(plugin.inject));
	assert.ok(plugin.inject.includes("tools"), "inject 必须声明 tools，否则 ctx.tools 访问会抛错");
	assert.ok(plugin.inject.includes("systemPrompt"), "inject 必须声明 systemPrompt");
});

test("client 模块把元数据挂在 module.exports 上，且不设 default", () => {
	const source = readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");
	assert.ok(source.includes("exports.inject = ["), "client 必须声明 exports.inject");
	assert.ok(source.includes("exports.apply = "), "client 必须声明 exports.apply");
	assert.ok(!/^\s*exports\.default\s*=/m.test(source), "client 不能导出 default，否则 inject 会丢");
});

test("entry 包装层也不带 default，且 inject 与真实现一致", () => {
	// 这条就是 0.3.2 漏掉的那处：main 指向 entry.js，它有 default，
	// 于是宿主只拿到裸 apply，tools 与 systemPrompt 全挂、路由照活。
	assert.equal(entry.default, undefined, "entry.js 不能有 export default —— 它才是 package.json 的 main");
	assert.equal(typeof entry.apply, "function");
	assert.equal(typeof entry.Config, "function");
	assert.equal(entry.name, plugin.name, "entry 与实现的 name 必须一致");
	assert.deepEqual(entry.inject, plugin.inject, "entry 的 inject 不能与实现漂移");
	assert.ok(entry.inject.includes("tools"));
	assert.ok(entry.inject.includes("systemPrompt"));
});

test("lib 下所有模块都不带 default 导出（整包扫描，防新增文件再踩）", () => {
	const dir = path.join(here, "..", "lib");
	const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
	assert.ok(files.length > 0, "lib 目录不该是空的");
	for (const file of files) {
		const source = readFileSync(path.join(dir, file), "utf8");
		assert.ok(!/^\s*export\s+default\b/m.test(source), `${file} 不能有 export default`);
		assert.ok(!/^\s*exports\.default\s*=/m.test(source), `${file} 不能设 exports.default`);
	}
});
