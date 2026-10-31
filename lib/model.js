/**
 * 宿主模型通道的薄适配层。
 *
 * 提炼要模型，但插件不该自己管 provider/model 的细节：`ctx.llm` 已经知道当前
 * 配置了哪些厂商、每个厂商有哪些模型。这里只做三件事：
 *
 *   1. 找到可用的 provider/model（配置优先，缺省取第一个可用组合）
 *   2. 把一次「一次性问答」跑成一段文本（`stream()` 的 `text-delta` 累加）
 *   3. 拿不到通道时**明确返回 undefined**，让上层退回"出料给会话自己提炼"，
 *      而不是假装提炼成功
 *
 * 注意：这里不 import `@deepseek-ai/dsh-llm`。那是宿主内部包，第三方 profile 解析
 * 不到（同 defineTool 的老问题），所以 `ctx.llm` 是按鸭子类型用的。
 *
 * @module dsh-kb/model
 */

/**
 * 解析一个可用的模型通道。
 * @param {object} ctx - 插件上下文（可能是注入过的子上下文）。
 * @param {object} [settings] - `{distillProvider, distillModel}`。
 * @returns {Promise<{provider: string, model: string, complete: Function} | undefined>} 通道或 undefined。
 */
export async function resolveModel(ctx, settings = {}) {
	const llm = ctx?.llm ?? (typeof ctx?.get === "function" ? ctx.get("llm") : undefined);
	if (llm === undefined || llm === null || typeof llm.stream !== "function") return undefined;

	let provider = String(settings.distillProvider ?? "").trim();
	let model = String(settings.distillModel ?? "").trim();
	try {
		if (provider === "") {
			const providers = llm.listProviders?.() ?? [];
			provider = String(providers[0]?.id ?? "");
		}
		if (provider === "") return undefined;
		if (model === "") {
			const models = (await llm.listModels?.(provider)) ?? [];
			const first = models[0];
			model = String(typeof first === "string" ? first : (first?.id ?? ""));
		}
		if (model === "") return undefined;
	} catch {
		return undefined;
	}

	return {
		provider,
		model,
		/**
		 * 跑一次一次性问答，返回纯文本。
		 * @param {{system: string, user: string}} prompt - 提示词。
		 * @param {object} [options] - `{maxTokens, signal}`。
		 * @returns {Promise<string>} 模型输出文本。
		 */
		async complete(prompt, options = {}) {
			const stream = llm.stream({
				provider,
				model,
				system: prompt.system,
				messages: [{ role: "user", content: prompt.user }],
				maxTokens: options.maxTokens ?? 4096,
				temperature: 0.2,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			let text = "";
			for await (const chunk of stream) {
				if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
			}
			return text;
		},
	};
}
