/**
 * 中文分词：CJK 切相邻两字（bigram），拉丁词原样小写。
 *
 * 为什么不用 FTS5 的 trigram：trigram 只给 ≥3 字符建索引，「记忆」「材质」这类
 * 双字中文词直接检索不到，而中文里双字词占绝大多数。测过三档：
 *   - `trigram`              → 2 字查询零命中
 *   - 默认分词器（整词）      → 整段中文当一个 token，必须整段相同
 *   - 默认分词器 + bigram 预切 → 任意双字词可检索，索引约 2 倍
 * 代价与收益见 docs/DESIGN.md。
 */

const TOKEN = /[A-Za-z][A-Za-z0-9_.:/\-+#]*|\d+(?:\.\d+)*|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;

/**
 * 把一段文本切成 FTS 词元。
 * @param {string} text - 原始文本。
 * @returns {string} 空格连接的词元串，直接写进 FTS 列。
 */
export function seg(text) {
	if (!text) return "";
	const out = [];
	for (const m of String(text).matchAll(TOKEN)) {
		const t = m[0];
		if (/^[A-Za-z0-9]/.test(t)) {
			out.push(t.toLowerCase());
		} else if (t.length === 1) {
			out.push(t);
		} else {
			for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
		}
	}
	return out.join(" ");
}

/**
 * 查询侧词元化，返回**扁平**的词元列表 —— 由调用方决定用 AND 还是 OR 连接。
 *
 * 返回一个整体 AND 组是个陷阱：`中文分词` 会变成 `("中文" AND "文分" AND "分词")`，
 * 退化时再套 OR 也没用，因为组内还是 AND。扁平化后 AND 严格召回、OR 宽召回才成立。
 *
 * 单字 CJK 退化为前缀匹配，覆盖「树」这种一字问法。
 * @param {string} q - 用户查询。
 * @returns {string[]} 每个元素是一段 FTS 表达式。
 */
export function queryTokens(q) {
	const out = [];
	for (const m of String(q ?? "").matchAll(TOKEN)) {
		const t = m[0];
		if (/^[A-Za-z0-9]/.test(t)) {
			if (t.length >= 2) out.push(`"${t.toLowerCase().replace(/"/g, "")}"`);
		} else if (t.length === 1) {
			out.push(`${t}*`);
		} else {
			for (let i = 0; i < t.length - 1; i += 1) out.push(`"${t.slice(i, i + 2)}"`);
		}
	}
	return out;
}

const TERM = /[a-z][a-z0-9_.+#/\-]{1,}|[\u4e00-\u9fff\u3040-\u30ff]{2,}/g;

/**
 * 精排用的意图词。英文词整体算一个词，中文长串再补 2 字滑窗，
 * 让「材质节点」这种无空格的连写也能部分命中。
 * @param {string} q - 用户查询。
 * @returns {string[]} 去重后的词表。
 */
export function terms(q) {
	const out = [];
	for (const m of String(q ?? "").toLowerCase().matchAll(TERM)) {
		const t = m[0];
		out.push(t);
		if (!/^[a-z]/.test(t) && t.length > 3) {
			for (let i = 0; i < t.length - 1; i += 2) out.push(t.slice(i, i + 2));
		}
	}
	return [...new Set(out)];
}
