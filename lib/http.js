/**
 * HTTP 路由：给浏览器端提供只读（+少量写入）的 JSON API。
 *
 * 客户端是同源的，且 GUI 用 `<base href="./">` 部署在子路径上，所以页面侧请用
 * **相对路径** `api/dsh-kb/...`，不要写死 `/api/...`。这里注册的仍然是根绝对路径，
 * 与 `dsh-skill-manager` 等插件保持一致。
 */

const MiB = 1024 * 1024;

/** 允许的来源：同源页面 + 本机回环。 */
function isAllowed(request) {
	const origin = request.headers?.origin;
	if (origin === undefined) return true; // 同源导航 / curl
	try {
		const u = new URL(origin);
		return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
	} catch {
		return false;
	}
}

function sendJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function queryParam(request, key) {
	try {
		return new URL(request.url ?? "/", "http://local").searchParams.get(key) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 读请求体并解析 JSON。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<object>} 解析结果。
 */
async function readJson(request, limit = MiB) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw new Error("body too large");
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	return raw ? JSON.parse(raw) : {};
}

/**
 * 造一条路由描述符。
 * @param {string} path - 根绝对路径。
 * @param {string} method - HTTP 方法。
 * @param {(req: object, res: object) => Promise<void>} handler - 处理函数。
 * @returns {object} `ctx.webServer.register` 接受的描述符。
 */
function route(path, method, handler) {
	return {
		kind: "exact",
		path,
		handler: async (request, response) => {
			if (!isAllowed(request)) {
				sendJson(response, 403, { error: "forbidden" });
				return;
			}
			if (request.method !== method) {
				sendJson(response, 405, { error: `method not allowed: ${request.method}` });
				return;
			}
			try {
				await handler(request, response);
			} catch (error) {
				sendJson(response, 500, { error: String(error?.message ?? error) });
			}
		},
	};
}

export { route, sendJson, queryParam, readJson, MiB };
