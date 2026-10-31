/**
 * 入口包装层：把"插件在别人进程里静默失败"变成"有一份日志"。
 *
 * 宿主只会在插件页显示一个「异常」，不给栈；而失败可能发生在**模块导入期**
 * （peer 解析不到、TLA 抛错），那时 `lib/index.js` 里的日志代码根本还没跑起来。
 * 所以这一层做三件事：
 *   1. 动态 import 真正的实现，导入失败也照样导出 apply
 *   2. 失败写 `$DSH_HOME/kb/plugin.log`，带完整栈
 *   3. 降级成一个"什么都不做但能加载"的插件，让行不再标红，其余功能不受牵连
 *
 * 代价是多一层间接，收益是下次出事不用靠猜。
 *
 * @module dsh-kb/entry
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** 日志路径与 lib/store.js 的 defaultDbPath 同域，但不 import 它（那正是可能失败的部分）。 */
function logPath() {
	const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	const kbHome = process.env.DSH_KB_HOME || path.join(home, "kb");
	return path.join(kbHome, "plugin.log");
}

/**
 * 写一行加载期日志；失败静默（日志本身不该成为故障源）。
 * @param {string} line - 内容。
 */
export function log(line) {
	try {
		const file = logPath();
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// 忽略
	}
}

/** 真实现；导入失败时为 undefined，由 apply 降级处理。 */
let impl;
try {
	impl = await import("./index.js");
	log(`entry: loaded ${process.version} name=${impl?.name ?? "?"}`);
} catch (error) {
	log(`entry: IMPORT FAILED\n${error?.stack ?? error}`);
}

export const name = "dsh-kb";
export const inject = ["tools", "systemPrompt"];

/** 配置缺省用恒等函数：真实现没加载时，任何配置都接受。 */
export const Config = impl?.Config ?? ((value) => ({ ...(value ?? {}) }));

/**
 * 转发到真实现的 apply；真实现缺失时记一笔并安静返回。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} config - 已解析的配置。
 */
export function apply(ctx, config) {
	if (impl?.apply === undefined) {
		log("entry: apply skipped (implementation missing)");
		return;
	}
	try {
		impl.apply(ctx, config);
		log("entry: apply returned");
	} catch (error) {
		log(`entry: APPLY FAILED\n${error?.stack ?? error}`);
	}
}

export default apply;
