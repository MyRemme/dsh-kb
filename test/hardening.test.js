/**
 * 加固测试：把这一轮"有风险的全部修复"钉住。
 *
 * 五条都是**不修也不会立刻炸、但一旦被利用就说不清**的问题：
 * 内部错误外泄、来源校验放宽、镜像写到 $DSH_HOME 根、错误上报被刷、重操作并发。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import { originAllowed, handle, matchRoute } from "../lib/http.js";
import { openDb } from "../lib/store.js";
import { createApi } from "../lib/routes.js";

/** 最小 res 桩：够 handle 用。 */
function makeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(key, value) {
			this.headers[key.toLowerCase()] = value;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
		},
	};
	return res;
}

test("来源校验：0.0.0.0 不再被当成本机回环", () => {
	const base = { method: "GET", headers: {} };
	assert.equal(originAllowed({ ...base, headers: { origin: "http://127.0.0.1:5712" } }), true);
	assert.equal(originAllowed({ ...base, headers: { origin: "http://localhost:5712" } }), true);
	assert.equal(originAllowed({ ...base, headers: { origin: "http://0.0.0.0:5712" } }), false, "0.0.0.0 不是本机");
	assert.equal(originAllowed({ ...base, headers: { origin: "http://evil.example.com" } }), false);
	// 跨站一票否决
	assert.equal(
		originAllowed({ method: "GET", headers: { origin: "http://127.0.0.1:5712", "sec-fetch-site": "cross-site" } }),
		false,
	);
	// 无 Origin（curl / CLI）放行
	assert.equal(originAllowed({ method: "POST", headers: {} }), true);
	// 非 GET 要求 Origin 与 Host 完全一致
	assert.equal(originAllowed({ method: "POST", headers: { origin: "http://127.0.0.1:9999", host: "127.0.0.1:5712" } }), false);
	assert.equal(originAllowed({ method: "POST", headers: { origin: "http://127.0.0.1:5712", host: "127.0.0.1:5712" } }), true);
});

test("500 不回内部消息，只回一句通用文案", async () => {
	const res = makeRes();
	const leaky = handle("POST", () => {
		throw new Error("SQLITE_ERROR: no such column: secret_column in SELECT * FROM fact");
	});
	await leaky({ method: "POST", headers: {}, url: "/api/dsh-kb/x" }, res);
	assert.equal(res.statusCode, 500);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, false);
	assert.equal(body.error.code, "internal");
	assert.ok(!res.body.includes("secret_column"), "内部 SQL 片段不能外泄");
	assert.ok(!res.body.includes("SQLITE"), "内部错误码不能外泄");
	assert.ok(body.error.message.length > 0, "要给人一句能看懂的话");
});

test("4xx 的 HttpError 仍然把 message 给客户端（那是我们自己写的文案）", async () => {
	const { HttpError } = await import("../lib/http.js");
	const res = makeRes();
	const handler = handle("GET", () => {
		throw new HttpError(400, "missing-id", "缺少 id");
	});
	await handler({ method: "GET", headers: {}, url: "/x" }, res);
	assert.equal(res.statusCode, 400);
	assert.equal(JSON.parse(res.body).error.code, "missing-id");
	assert.equal(JSON.parse(res.body).error.message, "缺少 id");
});

test("镜像目录不允许落在 $DSH_HOME 根（否则上千个 md 铺平混进 profile）", async () => {
	const home = mkdtempSync(path.join(tmpdir(), "hard-home-"));
	process.env.DSH_HOME = home;
	const { db, file } = openDb(path.join(home, "kb", "kb.db"));
	const api = createApi({ getDb: () => db, getFile: () => file, maxResults: 6 });
	const server = createServer((req, res) => {
		const { pathname } = new URL(String(req.url), "http://x");
		const hit = matchRoute(api.routes, pathname);
		if (hit === undefined) {
			res.statusCode = 404;
			res.end();
			return;
		}
		void hit.handler(req, res);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const call = async (dir) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/dsh-kb/mirror`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dir, dryRun: true }),
		});
		return { status: res.status, body: await res.json() };
	};

	assert.equal((await call(home)).status, 403, "root 本身要拒");
	assert.equal((await call(path.join(home, "kb", "mirror"))).status, 200, "子目录放行");
	assert.equal((await call("C:/Windows/Temp/x")).status, 403, "越界要拒");

	server.close();
	db.close();
});

test("frontlog 5 秒内同一条消息只落一次盘", async () => {
	const home = mkdtempSync(path.join(tmpdir(), "hard-log-"));
	process.env.DSH_HOME = home;
	const { db, file } = openDb(path.join(home, "kb", "kb.db"));
	const api = createApi({ getDb: () => db, getFile: () => file, maxResults: 6 });
	const server = createServer((req, res) => {
		const { pathname } = new URL(String(req.url), "http://x");
		const hit = matchRoute(api.routes, pathname);
		if (hit === undefined) {
			res.statusCode = 404;
			res.end();
			return;
		}
		void hit.handler(req, res);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const send = async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/dsh-kb/frontlog`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ level: "error", message: "同一个渲染错误" }),
		});
		return res.json();
	};

	const first = await send();
	const second = await send();
	assert.equal(first.data.logged, true);
	assert.equal(second.data.logged, false, "重复消息应被节流");
	assert.equal(second.data.throttled, true);

	const logFile = path.join(path.dirname(file), "front.log");
	const lines = readFileSync(logFile, "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "5 秒窗口内只该有一行");

	server.close();
	db.close();
});
