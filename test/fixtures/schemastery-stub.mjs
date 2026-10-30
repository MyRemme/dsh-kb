/**
 * 测试替身：`@deepseek-ai/schemastery` 的最小子集。
 * 只实现 dsh-kb 用到的那几个 fluent 方法。
 */

class Field {
	constructor(type) {
		this.type = type;
		this.meta = {};
	}
	default(v) {
		this.meta.default = v;
		return this;
	}
	description(v) {
		this.meta.description = v;
		return this;
	}
	step(v) {
		this.meta.step = v;
		return this;
	}
	min(v) {
		this.meta.min = v;
		return this;
	}
	max(v) {
		this.meta.max = v;
		return this;
	}
	required() {
		this.meta.required = true;
		return this;
	}
}

/**
 * 造一个既可当 schema、又可当解析函数用的对象。
 * @param {object} shape - 字段表。
 */
function object(shape) {
	const fields = shape ?? {};
	const fn = (input) => {
		const out = {};
		for (const [k, f] of Object.entries(fields)) {
			const v = input?.[k];
			out[k] = v === undefined ? f?.meta?.default : v;
		}
		return out;
	};
	fn.type = "object";
	fn.fields = fields;
	return fn;
}

const z = {
	object,
	string: () => new Field("string"),
	number: () => new Field("number"),
	boolean: () => new Field("boolean"),
	natural: () => new Field("number"),
};

export default z;
export { z, Field };
