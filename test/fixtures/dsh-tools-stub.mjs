/**
 * 测试替身：`@deepseek-ai/dsh-tools` 的最小子集。
 * 只提供 defineTool（原样返回）和导出名对齐。
 */

export function defineTool(def) {
	return def;
}

export default { defineTool };
