#!/usr/bin/env node
/**
 * dsh-kb CLI —— 和插件共用同一套库与算法。
 *
 * 用途：批量导入、维护、以及在没有界面的环境里查。插件的 kb_* 工具是给模型用的，
 * 这个 CLI 是给人和脚本用的。
 */

import { parseArgs } from "node:util";
import process from "node:process";
import { openDb, upsertFact, updateFact, getFact, reindex, sweepStale, defaultDbPath } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { search, renderResults } from "../lib/search.js";
import { ingest } from "../lib/ingest.js";
import { digest, treeRows } from "../lib/digest.js";
import { exportStatic } from "../lib/export.js";

const C = {
	dim: "\u001b[2m",
	bold: "\u001b[1m",
	cy: "\u001b[36m",
	rs: "\u001b[0m",
};

const HELP = `dsh-kb — 本机长期记忆库

用法:
  kb init                          建库
  kb ingest [--limit N] [--rescan] 增量吸收 DSH 会话
  kb search <query> [-k N] [--path P] [--json] [--all] [--no-graph]
  kb add --title T --body B [--path P] [--kind K] [--tags a,b]
  kb tree [prefix] [--summary]     看骨架树
  kb digest                        重算枝摘要
  kb stats                         健康度
  kb show <id>                     看一条卡全文
  kb forget <id>                   标记失效（不删）
  kb update <id> [--body B] [--title T] [--path P] [--status S]  改原卡（id 不变，旧版进历史）
  kb sweep [--days N]              把过期快照卡降级（默认 30 天）
  kb reindex                       重建全文索引
  kb export [--out FILE] [--limit N]  导出单文件 HTML 快照（默认 $DSH_HOME/kb/preview.html）

环境:
  DSH_HOME     默认 ~/.dsh
  DSH_KB_HOME  默认 $DSH_HOME/kb
`;

function open() {
	return openDb(process.env.DSH_KB_PATH || undefined);
}

function cmdSearch(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			k: { type: "string", default: "6" },
			path: { type: "string" },
			json: { type: "boolean", default: false },
			all: { type: "boolean", default: false },
			"no-graph": { type: "boolean", default: false },
		},
	});
	const query = positionals.join(" ");
	if (!query) throw new Error("缺少查询词");
	const { db } = open();
	const rows = search(db, query, {
		k: Number(values.k),
		path: values.path,
		includeSuperseded: values.all,
		expand: !values["no-graph"],
	});
	if (values.json) {
		console.log(JSON.stringify(rows, null, 1));
		return;
	}
	if (rows.length === 0) {
		console.log(`${C.dim}(no hit)${C.rs}`);
		return;
	}
	rows.forEach((r, i) => {
		console.log(`${C.bold}${String(i + 1).padStart(2)}.${C.rs} ${C.cy}${r.path}${C.rs} ${C.dim}[${r.kind} ${r.score.toFixed(2)} ${r.why}]${C.rs}`);
		console.log(`    ${C.bold}${r.title}${C.rs}`);
		console.log(`    ${String(r.body ?? "").replace(/\s+/g, " ").slice(0, 320)}`);
	});
}

function cmdAdd(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			title: { type: "string" },
			body: { type: "string", default: "" },
			path: { type: "string" },
			kind: { type: "string", default: "fact" },
			tags: { type: "string", default: "" },
			confidence: { type: "string", default: "0.8" },
		},
	});
	if (!values.title) throw new Error("缺少 --title");
	const { db } = open();
	const r = upsertFact(
		db,
		{
			title: values.title,
			body: values.body,
			kind: values.kind,
			path: values.path,
			paths: values.path ? [values.path] : undefined,
			tags: values.tags.split(",").map((t) => t.trim()).filter(Boolean),
			source_kind: "cli",
			source_ref: "cli",
			confidence: Number(values.confidence),
			ts: Date.now(),
		},
		seg,
	);
	console.log(JSON.stringify({ result: r }));
}

function cmdTree(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { summary: { type: "boolean", default: false } },
	});
	const { db } = open();
	const rows = treeRows(db, positionals[0] ?? "");
	for (const r of rows) {
		const line = `${"   ".repeat(r.depth)}${r.depth > 0 ? "└─ " : ""}${r.path.split("/").pop()}${r.count ? ` ${C.dim}(${r.count})${C.rs}` : ""}`;
		console.log(line);
		if (values.summary && r.summary) {
			for (const s of r.summary.split("\n")) console.log(`${"   ".repeat(r.depth)}   ${C.dim}${s}${C.rs}`);
		}
	}
}

function cmdStats() {
	const { db, file } = open();
	const one = (sql) => db.prepare(sql).get().n;
	const all = (sql) => db.prepare(sql).all();
	console.log(
		JSON.stringify(
			{
				facts: one("SELECT COUNT(*) AS n FROM fact"),
				active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'"),
				sessions: one("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''"),
				edges: one("SELECT COUNT(*) AS n FROM edge"),
				nodes: one("SELECT COUNT(*) AS n FROM node"),
				kinds: Object.fromEntries(all("SELECT kind, COUNT(*) AS n FROM fact GROUP BY kind ORDER BY n DESC").map((r) => [r.kind, r.n])),
				paths: Object.fromEntries(all("SELECT path, COUNT(*) AS n FROM fact GROUP BY path ORDER BY n DESC LIMIT 12").map((r) => [r.path, r.n])),
				db: file,
			},
			null,
			1,
		),
	);
}

function cmdShow(argv) {
	const id = argv[0];
	if (!id) throw new Error("缺少 id");
	const { db } = open();
	const detail = getFact(db, id);
	if (detail === undefined) {
		console.log("not found");
		return;
	}
	console.log(JSON.stringify(detail, null, 1));
}

function cmdUpdate(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			id: { type: "string" },
			title: { type: "string" },
			body: { type: "string" },
			path: { type: "string" },
			kind: { type: "string" },
			tags: { type: "string" },
			status: { type: "string" },
		},
	});
	const id = values.id ?? positionals[0];
	if (!id) throw new Error("缺少 id");
	const patch = {};
	if (values.title !== undefined) patch.title = values.title;
	if (values.body !== undefined) patch.body = values.body;
	if (values.path !== undefined) patch.paths = values.path ? [values.path] : [];
	if (values.kind !== undefined) patch.kind = values.kind;
	if (values.status !== undefined) patch.status = values.status;
	if (values.tags !== undefined) patch.tags = values.tags.split(",").map((t) => t.trim()).filter(Boolean);
	const { db } = open();
	console.log(JSON.stringify(updateFact(db, id, patch, seg)));
}

function cmdSweep(argv) {
	const { values } = parseArgs({ args: argv, options: { days: { type: "string" } } });
	const { db } = open();
	console.log(JSON.stringify({ staled: sweepStale(db, { days: values.days ? Number(values.days) : undefined }) }));
}

function cmdForget(argv) {
	const id = argv[0];
	if (!id) throw new Error("缺少 id");
	const { db } = open();
	const r = db.prepare("UPDATE fact SET status='superseded', updated_at=? WHERE id=? OR id LIKE ?").run(Date.now(), id, `${id}%`);
	console.log(JSON.stringify({ updated: r.changes }));
}

function cmdExport(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { out: { type: "string" }, limit: { type: "string" } },
	});
	const { db, file } = open();
	const result = exportStatic(db, {
		out: values.out,
		limit: values.limit ? Number(values.limit) : undefined,
		dbPath: file,
	});
	console.log(JSON.stringify(result));
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const { db } = open();
	switch (cmd) {
		case undefined:
		case "-h":
		case "--help":
		case "help":
			console.log(HELP);
			return;
		case "init":
			console.log("ok", defaultDbPath());
			return;
		case "ingest": {
			const { values } = parseArgs({
				args: rest,
				options: { limit: { type: "string" }, rescan: { type: "boolean", default: false }, quiet: { type: "boolean", default: false } },
			});
			const t0 = Date.now();
			const stats = ingest(db, {
				limit: values.limit ? Number(values.limit) : undefined,
				rescan: values.rescan,
				onProgress: values.quiet ? undefined : (m) => console.log(" ", m),
			});
			const nodes = digest(db);
			console.log(JSON.stringify({ ...stats, nodes, ms: Date.now() - t0 }));
			return;
		}
		case "search":
			return cmdSearch(rest);
		case "add":
			return cmdAdd(rest);
		case "tree":
			return cmdTree(rest);
		case "digest":
			console.log("digested", digest(db));
			return;
		case "stats":
			return cmdStats();
		case "show":
			return cmdShow(rest);
		case "forget":
			return cmdForget(rest);
		case "update":
			return cmdUpdate(rest);
		case "sweep":
			return cmdSweep(rest);
		case "reindex":
			console.log("reindexed", reindex(db, seg));
			return;
		case "export":
			return cmdExport(rest);
		default:
			console.error(`unknown command: ${cmd}\n`);
			console.log(HELP);
			process.exitCode = 1;
	}
}

try {
	main();
} catch (error) {
	console.error(String(error?.stack ?? error));
	process.exitCode = 1;
}
