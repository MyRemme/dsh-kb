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
 * 安全读取宿主模型服务。
 *
 * 先试 `ctx.get("llm")`（不抛），再退回直接属性访问（用 try 兜住）。
 * @param {object} ctx - 插件上下文。
 * @returns {object|undefined} 模型服务或 undefined。
 */
export function readLlm(ctx) {
	if (ctx === null || ctx === undefined) return undefined;
	try {
		if (typeof ctx.get === "function") {
			const got = ctx.get("llm");
			if (got !== undefined && got !== null) return got;
		}
	} catch {
		// 服务不存在，继续往下试
	}
	try {
		return ctx.llm ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 解析一个可用的模型通道。
 * @param {object} ctx - 插件上下文（可能是注入过的子上下文）。
 * @param {object} [settings] - `{distillProvider, distillModel}`。
 * @returns {Promise<{provider: string, model: string, complete: Function} | undefined>} 通道或 undefined。
 */
export async function resolveModel(ctx, settings = {}) {
	// 注意：**不能直接读 ctx.llm**。cordis 的上下文代理在没声明 inject 的情况下访问服务会抛
	// "cannot get property \"llm\" without inject"，而本插件的 inject 只有 tools/systemPrompt
	// （声明 llm 会让它在没有模型的宿主里直接不激活）。ctx.get 是安全读取，拿不到就是 undefined。
	const llm = readLlm(ctx);
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

/** 把各种可能的"列表形状"归一到数组：数组 / {providers} / {models} / 可迭代。 */
function toList(value) {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value;
	if (typeof value === "object") {
		if (Array.isArray(value.providers)) return value.providers;
		if (Array.isArray(value.models)) return value.models;
		if (Array.isArray(value.items)) return value.items;
		if (typeof value[Symbol.iterator] === "function") {
			try {
				return [...value];
			} catch {
				return [];
			}
		}
	}
	return [];
}

/** 从 provider / model 对象或字符串里取 id。 */
function idOf(entry) {
	if (typeof entry === "string") return entry;
	return String(entry?.id ?? entry?.name ?? entry?.model ?? "");
}

/**
 * 探测宿主有哪些 provider / model。
 *
 * 宿主没有公开的稳定契约，不同版本的 `ctx.llm` 可能是方法、属性、或者包了一层
 * `{providers}`。这里把常见形状都试一遍，**任何异常都不外抛** —— 列不出来就当没有，
 * 让上层退回出料，绝不让 /models 变成 500。
 *
 * @param {object|undefined} llm - 模型服务。
 * @returns {Promise<{providers: object[], debug: string[]}>} 归一后的清单与探测轨迹。
 */
export async function probeModels(llm) {
	const debug = [];
	if (llm === undefined || llm === null) return { providers: [], debug: ["没有模型服务（ctx.get('llm') 为空）"] };

	let raw = [];
	try {
		if (typeof llm.listProviders === "function") {
			raw = toList(await llm.listProviders());
			debug.push(`listProviders() -> ${raw.length}`);
		} else {
			debug.push("没有 listProviders 方法");
		}
	} catch (error) {
		debug.push(`listProviders 抛错：${String(error?.message ?? error)}`);
	}
	if (raw.length === 0) {
		try {
			const viaProp = toList(llm.providers);
			if (viaProp.length > 0) {
				raw = viaProp;
				debug.push(`llm.providers -> ${raw.length}`);
			}
		} catch (error) {
			debug.push(`llm.providers 抛错：${String(error?.message ?? error)}`);
		}
	}
	if (raw.length === 0) {
		// 有些版本把 provider 列表放在别的地方
		for (const key of ["availableProviders", "providerList", "listAllProviders"]) {
			try {
				const value = typeof llm[key] === "function" ? await llm[key]() : llm[key];
				const list = toList(value);
				if (list.length > 0) {
					raw = list;
					debug.push(`${key} -> ${raw.length}`);
					break;
				}
			} catch {
				// 换下一个
			}
		}
	}

	const providers = [];
	for (const entry of raw) {
		const id = idOf(entry);
		if (id === "") continue;
		let models = [];
		// 1) 方法：listModels(id) / listModels(entry)
		for (const arg of [id, entry]) {
			if (models.length > 0) break;
			try {
				if (typeof llm.listModels === "function") models = toList(await llm.listModels(arg));
			} catch {
				// 换一种参数
			}
		}
		// 2) 方法：getModels / models(provider)
		if (models.length === 0) {
			for (const key of ["getModels", "modelsFor", "models"]) {
				try {
					const fn = llm[key];
					if (typeof fn === "function") models = toList(await fn.call(llm, id));
					if (models.length > 0) break;
				} catch {
					// 换下一个
				}
			}
		}
		// 3) 属性：entry.models / llm.models[id]
		if (models.length === 0) {
			models = toList(entry?.models);
			if (models.length === 0) {
				try {
					models = toList(llm.models?.[id]);
				} catch {
					// 忽略
				}
			}
		}
		providers.push({
			id,
			name: String(entry?.name ?? entry?.label ?? id),
			models: models.map((m) => ({ id: idOf(m), name: String(m?.name ?? m?.label ?? idOf(m)) })).filter((m) => m.id !== ""),
		});
	}
	debug.push(`归一后 ${providers.length} 个 provider`);
	return { providers, debug };
}
