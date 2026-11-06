/**
 * HTTP 载体：路由描述符、JSON 收发、来源校验。
 *
 * 这里**不认识任何业务语义**——只做四件事：
 *   1. 把 `{kind, path, handler}` 描述符注册进宿主 webserver（并成组卸载）
 *   2. 统一的 JSON 出站 / 入站（含体积上限）
 *   3. 统一错误信封，让面板和 curl 看到同一种失败形状
 *   4. 来源校验：同源或回环，非本机浏览器页面打不进来
 *
 * 为什么不复用宿主的 `connection` 校验：它绑定会话凭证，而这个库是**本机文件级**
 * 的东西（同一台机器的任何进程本来都能读 kb.db）。真正的边界在"谁在浏览器里
 * 发了这个请求"，所以这里只认 Origin，不认 cookie。将来若经 lan-pair 暴露到内网，
 * 必须换成宿主凭证校验 —— 那时"本机"不再是可信边界。
 *
 * @module dsh-kb/http
 */

/** 所有路由的公共前缀。面板、静态导出、curl 都用它拼地址。 */
export const API_PREFIX = "/api/dsh-kb";

/** 回环主机名集合（Origin 校验用）。 */
// 只认真回环名。曾经把 0.0.0.0 也放进来，但它不是"本机"的同义词：
// 浏览器几乎不会把它当 Origin，留着只是白送一个可用的取值。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 默认请求体上限：8 MB，够放下一次手动补录的长卡，挡得住误发的巨物。 */
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;

/** 带状态码的错误。handler 里 throw 它，比 return 一个假响应更难写漏。 */
export class HttpError extends Error {
	/**
	 * @param {number} status - HTTP 状态码。
	 * @param {string} code - 机器可读的错误码。
	 * @param {string} message - 给人看的一句话。
	 */
	constructor(status, code, message) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
	}
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} value - 任意可序列化值。
 */
export function sendJson(res, status, value) {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("content-length", String(body.length));
	res.setHeader("cache-control", "no-store");
	res.setHeader("x-content-type-options", "nosniff");
	res.end(body);
}

/**
 * 写一个成功信封。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {unknown} data - 负载。
 * @param {object} [extra] - 并入顶层的额外字段，如 `{ingested:true}`。
 */
export function sendOk(res, data, extra) {
	sendJson(res, 200, { ok: true, data, ...(extra ?? {}) });
}

/**
 * 写一个错误信封。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {string} code - 机器可读的错误码。
 * @param {string} message - 给人看的一句话。
 */
export function sendError(res, status, code, message) {
	sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * 方法不允许。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {string} allow - 允许的方法名。
 */
export function sendMethodNotAllowed(res, allow) {
	res.setHeader("allow", allow);
	sendError(res, 405, "method-not-allowed", `只接受 ${allow}`);
}

/**
 * 读并解析 JSON 请求体。空体视为 `{}`。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} [limit] - 字节上限。
 * @returns {Promise<object>} 解析后的对象（非对象字面量会被包成 `{value}`）。
 */
export async function readJson(req, limit = DEFAULT_BODY_LIMIT) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, "body-too-large", `请求体超过 ${limit} 字节`);
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid-json", "请求体不是合法 JSON");
	}
	if (parsed === null || typeof parsed !== "object") return { value: parsed };
	return parsed;
}

/**
 * 解析请求 URL。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {{ pathname: string, query: URLSearchParams }} 路径与查询串。
 */
export function parseUrl(req) {
	const url = new URL(String(req.url ?? "/"), "http://localhost");
	return { pathname: url.pathname, query: url.searchParams };
}

/**
 * 取一个查询参数，缺省回落到默认值。
 * @param {URLSearchParams} query - 查询串。
 * @param {string} key - 参数名。
 * @param {string} [fallback] - 默认值。
 * @returns {string} 参数值。
 */
export function queryString(query, key, fallback = "") {
	const value = query.get(key);
	return value === null || value === "" ? fallback : value;
}

/**
 * 取一个整数查询参数。
 * @param {URLSearchParams} query - 查询串。
 * @param {string} key - 参数名。
 * @param {number} fallback - 默认值。
 * @param {number} [min] - 下限。
 * @param {number} [max] - 上限。
 * @returns {number} 夹逼后的整数。
 */
export function queryInt(query, key, fallback, min = 0, max = 1000) {
	const value = query.get(key);
	if (value === null || value.trim() === "") return fallback;
	const raw = Number(value);
	if (!Number.isFinite(raw)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/**
 * 来源校验：同源或回环放行，跨站拦截。
 *
 * 三种真实调用者：
 *   - 面板 fetch：带 `Origin`，同源
 *   - curl / CLI / 自动化：通常不带 `Origin`
 *   - 别的网站上的页面：带 `Origin`，不是本机
 *
 * `Sec-Fetch-Site: cross-site` 一票否决，即使 Origin 恰好是回环（例如被劫持的本地端口）。
 * 非 GET 额外要求 Origin 与 Host 完全一致：回环上的别的页面可以 GET 一张卡，但不能写入。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否放行。
 */
export function originAllowed(req) {
	if (String(req.headers["sec-fetch-site"] ?? "") === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined || origin === "") return true;
	let parsed;
	try {
		parsed = new URL(String(origin));
	} catch {
		return false;
	}
	const host = String(req.headers.host ?? "");
	const sameOrigin = parsed.host === host;
	if (req.method !== "GET" && req.method !== "HEAD") return sameOrigin;
	return sameOrigin || LOOPBACK.has(parsed.hostname);
}

/**
 * 造一条路由描述符（宿主 webserver 的 `register` 入参形状）。
 * @param {"exact"|"prefix"} kind - 匹配方式。
 * @param {string} path - 路径。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown} handler - 处理函数。
 * @returns {{kind: string, path: string, handler: Function}} 描述符。
 */
export function route(kind, path, handler) {
	return { kind, path, handler };
}

/**
 * 匹配一条路由：先精确表，再最长前缀。宿主 webserver 的语义与此一致；
 * 这里自己实现一份，测试里的裸 http 服务器才能和宿主走同一套规则。
 * @param {Array<{kind: string, path: string}>} routes - 路由表。
 * @param {string} pathname - 请求路径。
 * @returns {{kind: string, path: string} | undefined} 命中的路由。
 */
export function matchRoute(routes, pathname) {
	const exact = routes.find((r) => r.kind === "exact" && r.path === pathname);
	if (exact) return exact;
	let best;
	for (const r of routes) {
		if (r.kind !== "prefix") continue;
		if (pathname !== r.path && !pathname.startsWith(`${r.path}/`)) continue;
		if (best === undefined || r.path.length > best.path.length) best = r;
	}
	return best;
}

/**
 * 把一组路由注册进宿主 webserver，返回成组卸载函数。
 * @param {{register: (route: object) => () => void}} webServer - 宿主 webserver 服务。
 * @param {Array<object>} routes - 路由描述符。
 * @returns {() => void} 卸载全部路由。
 */
export function mountRoutes(webServer, routes) {
	const disposers = routes.map((r) => webServer.register(r));
	return () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose();
			} catch {
				// 卸载期失败不影响其余路由
			}
		}
	};
}

/**
 * 把 handler 包成宿主形态：来源校验 → 方法校验 → 执行 → 统一错误信封。
 * @param {string} method - 允许的方法，`*` 表示不限。
 * @param {(req: object, res: object) => unknown} handler - 业务处理。
 * @returns {(req: object, res: object) => Promise<void>} 载体处理函数。
 */
export function handle(method, handler) {
	return async (req, res) => {
		try {
			if (!originAllowed(req)) {
				sendError(res, 403, "cross-origin", "只接受同源或回环请求");
				return;
			}
			if (method !== "*" && req.method !== method) {
				sendMethodNotAllowed(res, method);
				return;
			}
			await handler(req, res);
		} catch (error) {
			if (error instanceof HttpError) {
				sendError(res, error.status, error.code, error.message);
				return;
			}
			// 内部错误的 message 里可能有 SQL 片段、绝对路径、文件句柄细节。
			// 详情进宿主日志（stderr），客户端只拿通用文案 —— 面板需要的是"失败了"，
			// 不是"哪一行 SQL 拼错了"。
			console.error(`[dsh-kb] ${req.method ?? "?"} ${req.url ?? "?"} -> ${String(error?.stack ?? error)}`);
			sendError(res, 500, "internal", "服务端错误（详情见宿主日志）");
		}
	};
}
