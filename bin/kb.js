#!/usr/bin/env node
/**
 * dsh-kb CLI —— 和插件共用同一套库与算法。
 *
 * 用途：批量导入、维护、以及在没有界面的环境里查。插件的 kb_* 工具是给模型用的，
 * 这个 CLI 是给人和脚本用的。
 */

import { parseArgs } from "node:util";
import process from "node:process";
import path from "node:path";
import {
	openDb,
	upsertFact,
	updateFact,
	getFact,
	resolveFact,
	reindex,
	sweepStale,
	defaultDbPath,
	linkFacts,
	backfillGroups,
	renameSessionEdges,
	REL_KINDS,
} from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { search, renderResults } from "../lib/search.js";
import { ingest } from "../lib/ingest.js";
import { digest, treeRows } from "../lib/digest.js";
import { exportStatic } from "../lib/export.js";
import { exportMaterial } from "../lib/distill.js";
import { mirrorToDir, importFromDir } from "../lib/markdown.js";
import { statsOf } from "../lib/routes.js";

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
  kb distill [--path P] [--limit N] 提炼出料：原料 + 提示词（无模型通道时给会话自己写）
  kb link --src ID --dst ID --rel R [--note N]
                                   建一条语义关系边（关系名白名单见下）
  kb migrate [--scope all|groups|edges]  重算派生数据（幂等）
  kb reindex                       重建全文索引
  kb export [--out FILE] [--limit N]  导出单文件 HTML 快照（默认 $DSH_HOME/kb/preview.html）
  kb export --md --dir D [--limit N] [--dry]
                                   投影成 Markdown 目录树（可 git、可手改、可 diff）
  kb import --md --dir D [--force] [--dry]
                                   把目录树的改动写回库（默认只认比库里新的文件）

关系名白名单:
  ${REL_KINDS.join(" / ")}

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
	// 与 GET /api/dsh-kb/stats 共用 statsOf：CLI 和面板看到的必须是同一份数字
	const { db, file } = open();
	console.log(JSON.stringify(statsOf(db, file), null, 1));
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

function cmdDistill(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { path: { type: "string" }, session: { type: "string" }, limit: { type: "string" } },
	});
	const { db } = open();
	const pack = exportMaterial(db, {
		path: values.path,
		session: values.session,
		limit: values.limit ? Number(values.limit) : undefined,
	});
	console.log(JSON.stringify({ material: pack.material, prompt: pack.prompt }, null, 1));
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

function cmdLink(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { src: { type: "string" }, dst: { type: "string" }, rel: { type: "string" }, note: { type: "string" }, w: { type: "string" } },
	});
	if (!values.src || !values.dst || !values.rel) throw new Error("需要 --src / --dst / --rel");
	const { db } = open();
	const pick = (value) => {
		const hit = resolveFact(db, String(value).trim());
		if (hit === undefined) throw new Error(`没有这张卡：${value}`);
		return hit.id;
	};
	try {
		console.log(JSON.stringify(linkFacts(db, pick(values.src), pick(values.dst), values.rel, { w: values.w, note: values.note })));
	} catch (error) {
		// 校验类错误（关系名拼错、自环、卡不存在）是用法问题，一行说清就够，不摊栈
		console.error(`建边失败：${String(error?.message ?? error)}`);
		process.exitCode = 1;
	}
}

function cmdMigrate(argv) {
	const { values } = parseArgs({ args: argv, options: { scope: { type: "string", default: "all" } } });
	const { db } = open();
	const result = { scope: values.scope };
	if (values.scope === "all" || values.scope === "groups") result.groups = backfillGroups(db);
	if (values.scope === "all" || values.scope === "edges") result.edges = renameSessionEdges(db);
	console.log(JSON.stringify(result));
}

function cmdExport(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			out: { type: "string" },
			limit: { type: "string" },
			md: { type: "boolean", default: false },
			dir: { type: "string" },
			dry: { type: "boolean", default: false },
		},
	});
	const { db, file } = open();
	if (values.md) {
		const result = mirrorToDir(db, values.dir ?? path.join(path.dirname(file), "mirror"), {
			limit: values.limit ? Number(values.limit) : undefined,
			dryRun: values.dry,
		});
		console.log(JSON.stringify(result, null, 1));
		return;
	}
	const result = exportStatic(db, {
		out: values.out,
		limit: values.limit ? Number(values.limit) : undefined,
		dbPath: file,
	});
	console.log(JSON.stringify(result));
}

function cmdImport(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			md: { type: "boolean", default: false },
			dir: { type: "string" },
			force: { type: "boolean", default: false },
			dry: { type: "boolean", default: false },
		},
	});
	if (!values.md) throw new Error("目前只支持 --md 导入");
	const { db, file } = open();
	const result = importFromDir(db, values.dir ?? path.join(path.dirname(file), "mirror"), {
		force: values.force,
		dryRun: values.dry,
	});
	console.log(JSON.stringify(result, null, 1));
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
		case "distill":
			return cmdDistill(rest);
		case "reindex":
			console.log("reindexed", reindex(db, seg));
			return;
		case "link":
			return cmdLink(rest);
		case "migrate":
			return cmdMigrate(rest);
		case "export":
			return cmdExport(rest);
		case "import":
			return cmdImport(rest);
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
