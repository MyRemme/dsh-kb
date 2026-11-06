/**
 * 真库 + 真 HTTP 冒烟：把 `/api/dsh-kb/hub` 挂到一个裸 server 上，用 fetch 打一遍。
 *
 * 为什么不用 `node --test` 里的临时库：那个库只有三张卡，看不出"真库上会不会被
 * 某个边界数据打崩"（比如 episode 卡多于吸收文件、front.log 里有半截 stack）。
 * 这里用**只读连接**开真库，不写任何东西。
 *
 *   node tools/smoke-hub-http.mjs
 */

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const { createApi } = await import(pathToFileURL(path.join(repo, "lib", "routes.js")).href);
const { matchRoute } = await import(pathToFileURL(path.join(repo, "lib", "http.js")).href);

const dshHome = process.env.DSH_HOME || path.join(homedir(), ".dsh");
const dbFile = process.env.DSH_KB_PATH || path.join(dshHome, "kb", "kb.db");
const db = new DatabaseSync(dbFile, { readOnly: true });

const api = createApi({
	getDb: () => db,
	getFile: () => dbFile,
	maxResults: 6,
	hub: {
		sessionsDir: path.join(dshHome, "sessions"),
		mirrorDir: path.join(path.dirname(dbFile), "mirror"),
		frontLog: path.join(path.dirname(dbFile), "front.log"),
		version: "0.9.0",
		tools: () => [
			{ name: "kb_search", description: "检索" },
			{ name: "kb_add", description: "写入" },
		],
	},
});

const server = createServer((req, res) => {
	const { pathname } = new URL(String(req.url), "http://localhost");
	const hit = matchRoute(api.routes, pathname);
	if (hit === undefined) {
		res.statusCode = 404;
		res.end("{}");
		return;
	}
	void hit.handler(req, res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const response = await fetch(`${base}/api/dsh-kb/hub`);
const payload = await response.json();
server.close();
db.close();

if (payload.ok !== true) {
	console.error("hub 端点失败：", JSON.stringify(payload).slice(0, 400));
	process.exit(1);
}
const hub = payload.data;
console.log("status", response.status);
console.log(
	JSON.stringify(
		{
			memory: { facts: hub.memory.facts, active: hub.memory.active, sessions: hub.memory.sessions, edges: hub.memory.edges, branches: hub.memory.branches.length, paths: hub.memory.paths.length },
			sessions: { total: hub.sessions.total, ingested: hub.sessions.ingested, recent: hub.sessions.recent.length, diskFiles: hub.sessions.disk.files },
			tools: { count: hub.tools.count, groups: hub.tools.groups.map((g) => `${g.prefix}:${g.items.length}`) },
			status: { version: hub.status.version, checks: hub.status.checks.map((c) => `${c.label}=${c.value}(${c.level})`) },
			bytes: JSON.stringify(payload).length,
		},
		null,
		1,
	),
);
