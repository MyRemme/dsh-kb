/**
 * 真库冒烟：用只读连接跑一遍中枢聚合，确认六块都有数、没有抛错。
 *
 * 只读打开（`readOnly: true`）是刻意的 —— 这是验证脚本，不该在真库上留下任何写入痕迹。
 *
 * 用法：`node tools/smoke-hub.mjs [dbPath]`
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { buildHub } from "../lib/hub.js";

const dbFile = process.argv[2] ?? path.join(homedir(), ".dsh", "kb", "kb.db");
const sessionsDir = path.join(homedir(), ".dsh", "sessions");
const db = new DatabaseSync(dbFile, { readOnly: true });

const hub = buildHub({
	db,
	file: dbFile,
	mirrorDir: path.join(path.dirname(dbFile), "mirror"),
	sessionsDir,
	frontLog: path.join(path.dirname(dbFile), "front.log"),
	// 宿主工具清单这里拿不到（没有 ctx），用部分名单证明聚合形状正确。
	tools: () => [
		{ name: "kb_search", description: "检索长期记忆库" },
		{ name: "kb_add", description: "写入一条事实卡" },
		{ name: "run_code", description: "PTC 传输层" },
	],
	version: "0.9.0",
	dshVersion: "0.2.1-rc.2",
});

const brief = {
	memory: {
		facts: hub.memory.facts,
		active: hub.memory.active,
		stale: hub.memory.stale,
		sessions: hub.memory.sessions,
		edges: hub.memory.edges,
		groups: hub.memory.groups,
		kinds: hub.memory.kinds,
		branches: hub.memory.branches.length,
		dbMB: +(hub.memory.dbBytes / 1048576).toFixed(2),
		mirrorFiles: hub.memory.mirror.files,
	},
	sessions: {
		total: hub.sessions.total,
		ingested: hub.sessions.ingested,
		recent: hub.sessions.recent.slice(0, 3),
		disk: hub.sessions.disk,
	},
	tools: { count: hub.tools.count, groups: hub.tools.groups.map((g) => `${g.prefix}:${g.items.length}`) },
	status: { checks: hub.status.checks, frontErrors: hub.status.frontLog.items.length, uptimeSec: hub.status.uptimeSec },
};
console.log(JSON.stringify(brief, null, 1));
