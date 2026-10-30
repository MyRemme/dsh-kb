/**
 * `defineTool` 的等价实现与解析回退。
 *
 * 为什么不直接 import 官方：`@deepseek-ai/dsh-tools` 只存在于 dsh 运行时内部
 * （asar 里），第三方插件的 `node_modules` 里未必解析得到。而插件脱离 defineTool
 * 又不行 —— 它负责把参数方言转成标准 JSON Schema，并做执行前的参数校验。
 *
 * 因此这里做两件事：
 *   1. 优先用官方 `defineTool`（行为权威）
 *   2. 解析失败时回退到本文件的等价实现（schema 转换 + required/type/enum 校验）
 *
 * 两边的产物形状一致：`{ name, description, parameters(JSON Schema), output, execute, presentCall }`。
 */

/**
 * 把 dsh 的参数方言 `{ f: { type, required, description, enum } }`
 * 转成标准 JSON Schema 对象。
 * @param {Record<string, object>} spec - 参数字典。
 * @returns {{type:string, properties:object, required?:string[]}} JSON Schema。
 */
export function toJsonSchema(spec = {}) {
	const properties = {};
	const required = [];
	for (const [key, field] of Object.entries(spec)) {
		const { required: isRequired, ...rest } = field ?? {};
		properties[key] = rest;
		if (isRequired) required.push(key);
	}
	return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

/**
 * 极简参数校验：required / 基本类型 / enum。返回 path 限定的违规列表。
 * @param {object} schema - toJsonSchema() 的产物。
 * @param {object} args - 模型给出的参数。
 * @returns {string[]} 违例描述，空数组代表合法。
 */
export function validateArgs(schema, args) {
	const violations = [];
	const input = args ?? {};
	for (const key of schema.required ?? []) {
		if (input[key] === undefined || input[key] === null) violations.push(`${key}: required`);
	}
	for (const [key, field] of Object.entries(schema.properties ?? {})) {
		const v = input[key];
		if (v === undefined) continue;
		const t = field.type;
		if (t === "string" && typeof v !== "string") violations.push(`${key}: expected string`);
		if (t === "number" && typeof v !== "number") violations.push(`${key}: expected number`);
		if (t === "boolean" && typeof v !== "boolean") violations.push(`${key}: expected boolean`);
		if (Array.isArray(field.enum) && !field.enum.includes(v)) {
			violations.push(`${key}: expected one of ${field.enum.join(", ")}`);
		}
	}
	return violations;
}

/**
 * 回退版 defineTool，形状与官方一致。
 * @param {object} options - 工具定义。
 * @returns {object} 可交给 ctx.tools.register 的工具对象。
 */
export function localDefineTool(options) {
	const parameters = toJsonSchema(options.parameters);
	const execute = options.execute;
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: options.output.schema,
			render: (args, value) => options.output.render(args, value),
		},
		async execute(args, exec) {
			const violations = validateArgs(parameters, args);
			if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join("; ")}`);
			return execute(args, exec);
		},
	};
	if (options.presentCall) {
		tool.presentCall = (args) => (validateArgs(parameters, args).length > 0 ? undefined : options.presentCall(args));
	}
	if (options.presentResult) {
		tool.presentResult = (args, result) => options.presentResult(args, result);
	}
	return tool;
}

/**
 * 挑一个可用的 defineTool：官方优先，解析不到就用本地等价实现。
 * @returns {Promise<Function>} defineTool 实现。
 */
export async function resolveDefineTool() {
	try {
		const mod = await import("@deepseek-ai/dsh-tools");
		if (typeof mod.defineTool === "function") return mod.defineTool;
	} catch {
		// 插件在没有 dsh 运行时的环境（测试、CLI）里跑时走到这里
	}
	return localDefineTool;
}
