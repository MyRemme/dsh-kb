/**
 * 「中枢」聚合层：把六件东西算成一次请求能返回的形状。
 *
 * 为什么不是让前端各调各的端点：面板一开局要发六次请求，任何一次慢都会让页面
 * 看起来像"六块里有两块永久在转圈"。这里一次性读库、一次扫目录、一次读日志，
 * 前端只发一个 GET。
 *
 * 六块的分工：
 *   记忆库 —— 库自己的规模（卡 / 边 / 枝 / 摘要）
 *   检索   —— 走既有 `/search` 端点，中枢只负责入口
 *   星图   —— 这里只给"枝 + 每枝前 N 张卡"，坐标由前端纯函数算（可确定性重复）
 *   会话   —— episode 卡里的会话标题 + ingest_log 的摄入进度 + 磁盘上的原始文件量
 *   工具   —— 宿主注册表里模型**能看见**的工具（ctx.tools.schemas），不是插件自己的清单
 *   状态   —— 宿主进程、库文件、front.log 的错误、几条自检结论
 *
 * 一条硬约束：**每一块都用自己的 try/catch 兜住**。中枢是给人看"哪里坏了"的页面，
 * 它自己因为在某个坏数据上抛错而白屏，是最讽刺的失败方式。
 *
 * 第二条同样重要：**兜住之后要留痕**。块失败就返回一份"看起来像 0"的数据，是最坏的
 * 一种假绿 —— 页面显示"0 张卡"，人以为库空了，实际是查询挂了。所以失败的块带
 * `error` 字段，自检据此亮红灯。
 *
 * @module dsh-kb/hub
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { listSessionFiles } from "./session.js";

/** 卡片类型的中文名。与客户端 KIND_LABEL 保持一致；这里只用于服务端聚合标签。 */
const KIND_LABEL = {
	fact: "事实",
	decision: "决定",
	fix: "修复",
	pref: "偏好",
	howto: "做法",
	concept: "概念",
	intent: "意图",
	episode: "会话",
	segment: "分段",
	todo: "待办",
	state: "进度",
	artifact: "产物",
};

/** 展示分组的中文名（fact.grp）。 */
const GROUP_LABEL = {
	memory: "记忆",
	talk: "对话",
	doc: "文档",
	project: "项目",
	task: "任务",
};

/** 单块内最多列多少条。中枢是"一眼看全局"，不是第二个列表页。 */
const TOP_KINDS = 8;
const TOP_PATHS = 8;
const TOP_BRANCHES = 8;
const CARDS_PER_BRANCH = 6;
const RECENT_SESSIONS = 10;
const RECENT_ERRORS = 5;
/** 前端错误只看最近这么多天：昨天的错修完就过去了，留着它当红灯等于永远红灯。 */
const RECENT_ERROR_DAYS = 7;

/**
 * 会被遗忘机制成批降级的"流水账"类型。
 *
 * 它们本来就不该长期 active：会话卡、分段、意图、进度、待办、产物都是过程记录。
 * 「降级占比」如果把它们算进去，这个数字永远在三成以上，红灯常亮 —— 而实测真库里
 * 知识卡（事实/决定/修复/偏好/做法/概念）的降级数是 0。所以这一项只统计知识卡。
 */
const CHURN_KINDS = ["episode", "segment", "intent", "state", "todo", "artifact"];

/**
 * 拼进 SQL 的类型字面量表。
 *
 * 直接拼字符串是因为 SQLite 的参数占位符不能用在 `IN` 的列表长度上，而这里的值
 * 全部来自本文件的常量数组（不含任何外部输入）—— 不是把用户数据拼进 SQL。
 */
const CHURN_SQL = CHURN_KINDS.map((kind) => `'${kind}'`).join(",");

/**
 * front.log 里不指向任何可修之物的宿主噪声。
 *
 * `ResizeObserver loop completed with undelivered notifications` 是 Electron 渲染层
 * 的循环告警，插件改不动它，也不会导致任何功能异常。它却会刷屏，把真正的
 * `render` / `api` 错误挤出最近 5 条 —— 噪声必须在这里被剔掉，而不是靠人眼忽略。
 */
const FRONT_LOG_NOISE = [/ResizeObserver loop/i];

/** 记成"前端错误"的级别。其余（warn / info / debug）不算坏。 */
const ERROR_LEVELS = ["error", "rejection", "render", "api"];

/** 会话目录扫描结果的缓存：真机 754 个文件 / 338 MB 全遍历一次约 47 ms。 */
const SESSION_CACHE_MS = 30_000;

/** mirror 目录最多递归这么多层 / 这么多文件，防止 mirrorDir 被配到盘根时把面板钉死。 */
const MIRROR_MAX_DEPTH = 8;
const MIRROR_MAX_FILES = 20_000;

/**
 * 会话文件清单的进程内缓存。
 *
 * `/hub` 每次刷新都会重扫会话目录，是整块耗时的一半。目录内容只会在吸收时才变，
 * 30 秒的窗口对"点刷新看数字"完全够用，而它把 47 ms 降到一次哈希查找。
 * @type {Map<string, {at:number, value:Array<object>}>}
 */
const sessionFileCache = new Map();

/**
 * 取某目录的会话文件清单（带缓存）。
 * @param {string} dir - 会话根目录。
 * @returns {Array<object>} 文件清单。
 */
function cachedSessionFiles(dir) {
	const hit = sessionFileCache.get(dir);
	if (hit !== undefined && Date.now() - hit.at < SESSION_CACHE_MS) return hit.value;
	const value = listSessionFiles(dir);
	sessionFileCache.set(dir, { at: Date.now(), value });
	return value;
}

/**
 * 跑一段可能抛错的查询，失败就退化成默认值。
 * @template T
 * @param {() => T} fn - 取值函数。
 * @param {T} fallback - 失败时的值。
 * @returns {T} 结果或默认值。
 */
function safe(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/**
 * 文件大小；不存在记 0（中枢要显示"没有"，而不是抛 ENOENT）。
 * @param {string} file - 路径。
 * @returns {number} 字节数。
 */
function sizeOf(file) {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * 数一个目录下的普通文件，有层数与总数上限。
 *
 * 之前是无上限递归，而 `mirrorDir` 是用户可配项 —— 配到 `D:\` 根就是一次"面板永久
 * 卡死"。上限的作用不是精确，是**保证这个函数一定会返回**。
 *
 * @param {string} dir - 目录。
 * @param {number} [depth] - 当前深度。
 * @param {{n:number}} [budget] - 共享计数器。
 * @returns {number} 文件数；目录不存在返回 0。
 */
function countFiles(dir, depth = 0, budget = { n: 0 }) {
	if (depth > MIRROR_MAX_DEPTH) return budget.n;
	try {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (budget.n >= MIRROR_MAX_FILES) return budget.n;
			if (ent.isFile()) budget.n += 1;
			else if (ent.isDirectory()) countFiles(path.join(dir, ent.name), depth + 1, budget);
		}
	} catch {
		// 权限、竞态、断链目录：数到哪算哪
	}
	return budget.n;
}

/**
 * 从文件尾部读一段文本。
 *
 * 日志文件可能几十 MB，"读全文再切最后几行"在面板每刷一次就执行一次，是实打实的浪费。
 * 这里只取尾部 16 KB。
 *
 * @param {string} file - 文件路径。
 * @param {number} [bytes] - 读取字节数。
 * @returns {string} 文本（可能从半行开始）。
 */
function tailText(file, bytes = 16 * 1024) {
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - bytes);
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(size - start);
			readSync(fd, buf, 0, buf.length, start);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * 解析 front.log 尾部的结构化行。
 *
 * 客户端写进来的行是 `时间 [级别] 消息`。解析不出来的行（比如 stack trace）跳过 ——
 * 中枢只回答"有没有错、最后一条是什么"，不做日志查看器。
 *
 * 两条曾经搞反的地方，都在这里：
 *   1. **不按长度截断**。以前用 `(.{0,200})$`，超过 200 字符的行不是被截断而是整行
 *      丢弃 —— 带 `componentStack` 的 `render` 崩溃（实测 1040 字符）全被扔掉，
 *      留下的全是短的噪声。越严重的错误越进不了统计，正好反了。
 *   2. **噪声在解析期就剔掉**，且只剔已知噪声，不是"只留错误级别"那种粗暴过滤。
 *
 * @param {string} text - 尾部文本。
 * @returns {{total:number, noise:number, errors:Array<{at:string,level:string,message:string}>}} 统计。
 */
function parseFrontLog(text) {
	let total = 0;
	let noise = 0;
	const errors = [];
	for (const line of text.split("\n")) {
		const row = line.trim();
		if (row === "") continue;
		const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[(\w+)\] (.*)$/.exec(row);
		if (m === null) continue;
		total += 1;
		const level = m[2].toLowerCase();
		if (!ERROR_LEVELS.includes(level)) continue;
		const message = m[3];
		if (FRONT_LOG_NOISE.some((re) => re.test(message))) {
			noise += 1;
			continue;
		}
		errors.push({ at: m[1], level, message });
	}
	return { total, noise, errors };
}

/**
 * 记忆库那一块。
 * @param {object} db - 已打开的库。
 * @param {string} file - 库文件。
 * @param {string} mirrorDir - Markdown 投影目录。
 * @returns {object} 该块的数据。
 */
function memorySection(db, file, mirrorDir) {
	const one = (sql) => Number(db.prepare(sql).get()?.n ?? 0);
	const kinds = db
		.prepare("SELECT kind, COUNT(*) AS n FROM fact GROUP BY kind ORDER BY n DESC LIMIT ?")
		.all(TOP_KINDS)
		.map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind] ?? r.kind, n: Number(r.n) }));

	// 一次 group by 同时拿到"在用"和"总数"。
	//
	// 以前是两条几乎一样的 SQL（一条筛 active、一条不筛），只喂一个用途不同的列表；
	// 而 `/stats` 用的是第三种口径（全量）。结果是同一个枝在「记忆」面板显示 429、
	// 在「中枢」显示 232 —— 两个面板并排站着，数字差一倍。现在同一次查询里两个数都有，
	// 前端能显示 `232/429`，不用再猜哪个是真的。
	const branches = db
		.prepare(
			`SELECT path, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS a, COUNT(*) AS t
			 FROM fact GROUP BY path ORDER BY a DESC LIMIT ?`,
		)
		.all(TOP_BRANCHES)
		.map((r) => ({ path: r.path || "inbox", active: Number(r.a), total: Number(r.t) }));

	// 每枝前 N 张卡，一次查完。
	//
	// 以前是"8 个枝各 prepare 一次再 all 一次"的 N+1：预编译 8 条语句、跑 8 次查询。
	// 窗口函数在 SQLite 3.25+ 就有，node:sqlite 内置版本足够新（实测可用）。
	const cardsByPath = new Map();
	const branchPaths = branches.map((b) => b.path);
	if (branchPaths.length > 0) {
		const marks = branchPaths.map(() => "?").join(",");
		const rows = db
			.prepare(
				`SELECT path, id, title, kind FROM (
					SELECT path, id, title, kind,
						ROW_NUMBER() OVER (PARTITION BY path ORDER BY ts DESC) AS rn
					FROM fact WHERE status='active' AND path IN (${marks})
				) WHERE rn <= ?`,
			)
			.all(...branchPaths, CARDS_PER_BRANCH);
		for (const row of rows) {
			const key = row.path || "inbox";
			if (!cardsByPath.has(key)) cardsByPath.set(key, []);
			cardsByPath.get(key).push({ id: row.id, title: row.title, kind: row.kind });
		}
	}

	const groups = db
		.prepare("SELECT grp, COUNT(*) AS n FROM fact GROUP BY grp ORDER BY n DESC")
		.all()
		.map((r) => ({ grp: r.grp, label: GROUP_LABEL[r.grp] ?? r.grp, n: Number(r.n) }));
	const rels = db
		.prepare("SELECT rel, COUNT(*) AS n FROM edge GROUP BY rel ORDER BY n DESC")
		.all()
		.map((r) => ({ rel: r.rel, n: Number(r.n) }));

	const lastCard = safe(() => Number(db.prepare("SELECT MAX(ts) AS t FROM fact").get()?.t ?? 0), 0);

	// 知识卡 / 流水账分开算。见 CHURN_KINDS 的注释：混在一起数出来的"降级占比"永远三成。
	const knowledge = one(`SELECT COUNT(*) AS n FROM fact WHERE kind NOT IN (${CHURN_SQL})`);
	const knowledgeStale = one(
		`SELECT COUNT(*) AS n FROM fact WHERE status!='active' AND kind NOT IN (${CHURN_SQL})`,
	);

	return {
		facts: one("SELECT COUNT(*) AS n FROM fact"),
		active: one("SELECT COUNT(*) AS n FROM fact WHERE status='active'"),
		stale: one("SELECT COUNT(*) AS n FROM fact WHERE status!='active'"),
		knowledge,
		knowledgeStale,
		// 这一项握手在 buildHub 里由 sessions 块补上（同一条 SQL 不跑两遍）。
		sessions: 0,
		edges: one("SELECT COUNT(*) AS n FROM edge"),
		nodes: one("SELECT COUNT(*) AS n FROM node"),
		mentions: one("SELECT COUNT(*) AS n FROM mention"),
		versions: one("SELECT COUNT(*) AS n FROM fact_history"),
		kinds,
		paths: branches.map((b) => ({ path: b.path, n: b.active, total: b.total })),
		groups,
		rels,
		branches: branches.map((b) => ({
			path: b.path,
			n: b.active,
			total: b.total,
			cards: cardsByPath.get(b.path) ?? [],
		})),
		lastCardTs: lastCard,
		dbBytes: sizeOf(file),
		walBytes: sizeOf(`${file}-wal`),
		mirror: { dir: mirrorDir, files: existsSync(mirrorDir) ? countFiles(mirrorDir) : 0 },
	};
}

/**
 * 会话那一块。
 *
 * 标题取 episode 卡（吸收时写下的会话摘要卡），**不去解压会话文件**：
 * 一个会话文件是几十帧 zstd，为了一个标题把 600 个文件全解开，页面会卡死。
 *
 * 只列 active 的会话卡：真机 454 张 episode 里 421 张已被遗忘机制降级，把降级卡
 * 列进"最近会话"再让人点开，读到的是"已 superseded"的抽屉，等于给假入口。
 *
 * @param {object} db - 库。
 * @param {string} sessionsDir - 原始会话目录。
 * @param {boolean} [noCache] - 跳过会话文件缓存（测试用）。
 * @returns {object} 该块的数据。
 */
function sessionSection(db, sessionsDir, noCache = false) {
	const recent = safe(
		() =>
			db
				.prepare(
					"SELECT id, title, ts, session_id FROM fact WHERE kind='episode' AND status='active' ORDER BY ts DESC LIMIT ?",
				)
				.all(RECENT_SESSIONS)
				.map((r) => ({
					id: r.id,
					title: r.title,
					ts: Number(r.ts),
					sessionId: r.session_id,
				})),
		[],
	);
	const lastIngestTs = safe(() => Number(db.prepare("SELECT MAX(ts) AS t FROM ingest_log").get()?.t ?? 0), 0);
	const ingested = safe(() => Number(db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE err=''").get()?.n ?? 0), 0);
	const failed = safe(() => Number(db.prepare("SELECT COUNT(*) AS n FROM ingest_log WHERE err!=''").get()?.n ?? 0), 0);
	const disk = safe(() => {
		const files = noCache ? listSessionFiles(sessionsDir) : cachedSessionFiles(sessionsDir);
		const bytes = files.reduce((sum, f) => sum + f.size, 0);
		const newest = files.reduce((max, f) => Math.max(max, f.mtime), 0);
		return { files: files.length, bytes, newest, dir: sessionsDir };
	}, { files: 0, bytes: 0, newest: 0, dir: sessionsDir });
	return {
		total: safe(() => Number(db.prepare("SELECT COUNT(*) AS n FROM fact WHERE kind='episode'").get()?.n ?? 0), 0),
		active: safe(
			() =>
				Number(
					db.prepare("SELECT COUNT(*) AS n FROM fact WHERE kind='episode' AND status='active'").get()?.n ?? 0,
				),
			0,
		),
		ingested,
		failed,
		lastIngestTs,
		recent,
		disk,
	};
}

/**
 * 工具那一块。
 *
 * 来源必须是宿主的工具注册表（模型真正看得见的那份），不是插件自报的名单 ——
 * 否则中枢会显示"12 个工具"而模型实际只有 5 个，这种页面比没有还坏。
 *
 * @param {Array<{name:string, description?:string}>} schemas - ctx.tools.schemas()。
 * @returns {object} 该块的数据。
 */
function toolSection(schemas) {
	const items = (Array.isArray(schemas) ? schemas : [])
		// run_code 是 PTC 模式的传输层，不是人点得动的工具。
		.filter((t) => t && typeof t.name === "string" && t.name !== "run_code")
		.map((t) => ({
			name: t.name,
			summary: String(t.description ?? "").replace(/\s+/g, " ").slice(0, 140),
			prefix: t.name.includes("_") ? t.name.slice(0, t.name.indexOf("_") + 1) : "",
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const byPrefix = new Map();
	for (const item of items) {
		const key = item.prefix === "" ? "其他" : item.prefix.replace(/_$/, "");
		if (!byPrefix.has(key)) byPrefix.set(key, []);
		byPrefix.get(key).push({ name: item.name, summary: item.summary });
	}
	// 只有一个成员的前缀（read_* / todo_* / web_*）不值得单独开一组：
	// 十二个组里夹着五个"1"，读的人只会一眼扫过去什么也没看见。并进「其他」。
	const loose = [];
	for (const [prefix, list] of [...byPrefix.entries()]) {
		if (list.length >= 2 || prefix === "其他") continue;
		loose.push(...list);
		byPrefix.delete(prefix);
	}
	if (loose.length > 0) {
		if (!byPrefix.has("其他")) byPrefix.set("其他", []);
		byPrefix.get("其他").push(...loose);
	}
	return {
		count: items.length,
		groups: [...byPrefix.entries()]
			.map(([prefix, list]) => ({ prefix, items: list }))
			.sort((a, b) => b.items.length - a.items.length || a.prefix.localeCompare(b.prefix)),
		names: items.map((t) => t.name),
	};
}

/**
 * 状态那一块：进程 + 文件 + 日志 + 自检。
 * @param {object} input - 输入。
 * @returns {object} 该块的数据。
 */
function statusSection(input) {
	const { file, mirrorDir, frontLog, version, dshVersion, sessions, memory, now } = input;
	const log = parseFrontLog(tailText(frontLog));
	const windowStart = now - RECENT_ERROR_DAYS * 86400000;
	const fresh = log.errors.filter((row) => {
		const at = Date.parse(row.at);
		// 时间解析不出来的行不许被"过期"掉：它可能是最新的一条，只是格式坏了。
		return !Number.isFinite(at) || at >= windowStart;
	});
	const items = fresh.slice(-RECENT_ERRORS);
	const ingestLagMin = sessions.lastIngestTs > 0 ? Math.round((now - sessions.lastIngestTs) / 60000) : null;
	const staleRatio = memory.knowledge > 0 ? memory.knowledgeStale / memory.knowledge : 0;
	/** 记忆库整块查询失败时，所有基于它的检查项都不许报 ok。 */
	const memoryBroken = typeof memory.error === "string";

	/** 一条自检结论。level 只有 ok / warn / bad 三种，前端只按它上色。 */
	const checks = [];
	checks.push({
		key: "db",
		label: "库文件",
		// 以前只看文件大小 > 0 就判 ok。可"文件存在"和"能查询"是两件事：实测一个 8 KB
		// 的无关库，所有 fact 查询都抛 no such table，而这一项照样是绿灯。
		value: memoryBroken ? "查询失败" : memory.dbBytes > 0 ? `${(memory.dbBytes / 1024 / 1024).toFixed(2)} MB` : "读不到",
		level: memoryBroken || memory.dbBytes === 0 ? "bad" : "ok",
	});
	checks.push({
		key: "wal",
		label: "WAL",
		value: `${(memory.walBytes / 1024 / 1024).toFixed(2)} MB`,
		level: memory.walBytes > 64 * 1024 * 1024 ? "warn" : "ok",
	});
	checks.push({
		key: "ingest",
		label: "最近吸收",
		value:
			ingestLagMin === null
				? "从未吸收"
				: ingestLagMin < 60
					? `${ingestLagMin} 分钟前`
					: ingestLagMin < 60 * 24
						? `${Math.round(ingestLagMin / 60)} 小时前`
						: `${Math.round(ingestLagMin / 1440)} 天前`,
		level: ingestLagMin === null ? "bad" : ingestLagMin > 60 * 24 * 7 ? "bad" : ingestLagMin > 60 * 24 ? "warn" : "ok",
	});
	checks.push({
		key: "stale",
		label: "知识卡降级",
		value: memory.knowledge > 0 ? `${Math.round(staleRatio * 100)}%` : "—",
		level: memory.knowledge > 0 && staleRatio > 0.35 ? "bad" : memory.knowledge > 0 && staleRatio > 0.15 ? "warn" : "ok",
		// 分母只算知识卡：流水账（会话/分段/意图…）成批降级是遗忘机制的常态，
		// 把它们算进来会让这个数字永远 30%+，红灯常亮等于没有红灯（实测 38% → 0%）。
	});
	checks.push({
		key: "frontlog",
		label: "前端错误·7天",
		value: String(fresh.length),
		level: fresh.length > 0 ? "warn" : "ok",
	});
	checks.push({
		key: "mirror",
		label: "Markdown 投影",
		value: memory.mirror.files > 0 ? `${memory.mirror.files} 个文件` : "未导出",
		level: memory.mirror.files > 0 ? "ok" : "warn",
	});
	checks.push({
		key: "ingestErr",
		label: "吸收失败",
		value: String(sessions.failed),
		level: sessions.failed > 0 ? "warn" : "ok",
	});

	const mem = process.memoryUsage();
	return {
		version,
		dshVersion: dshVersion ?? null,
		node: process.version,
		pid: process.pid,
		uptimeSec: Math.round(process.uptime()),
		rssMB: Math.round(mem.rss / 1024 / 1024),
		db: { file, bytes: memory.dbBytes, walBytes: memory.walBytes },
		mirror: memory.mirror,
		frontLog: {
			// 这里以前填的是库文件路径 —— 名字叫 frontLog 却指向 kb.db，是纯粹的笔误。
			file: frontLog,
			total: log.total,
			noise: log.noise,
			count: fresh.length,
			items,
		},
		checks,
		ts: now,
	};
}

/**
 * 组装中枢载荷。
 *
 * @param {object} input - 依赖与数据源。
 * @param {object} input.db - 已打开的库句柄。
 * @param {string} input.file - 库文件路径。
 * @param {string} [input.mirrorDir] - Markdown 投影目录。
 * @param {string} [input.sessionsDir] - 原始会话目录。
 * @param {string} [input.frontLog] - 前端日志路径。
 * @param {() => Array<object>} [input.tools] - 返回宿主工具 schema 的函数（懒取，失败退空）。
 * @param {string} [input.version] - 插件版本。
 * @param {string} [input.dshVersion] - 宿主版本。
 * @param {number} [input.now] - 当前时间（测试可注入）。
 * @param {boolean} [input.noCache] - 跳过会话文件缓存（测试用）。
 * @returns {object} 六块载荷。
 */
export function buildHub(input) {
	const now = Number(input.now) || Date.now();
	const db = input.db;

	let memoryError;
	let memory;
	try {
		memory = memorySection(db, input.file, input.mirrorDir ?? "");
	} catch (error) {
		memoryError = String(error?.message ?? error);
		memory = {
			facts: 0,
			active: 0,
			stale: 0,
			knowledge: 0,
			knowledgeStale: 0,
			sessions: 0,
			edges: 0,
			nodes: 0,
			mentions: 0,
			versions: 0,
			kinds: [],
			paths: [],
			groups: [],
			rels: [],
			branches: [],
			lastCardTs: 0,
			dbBytes: sizeOf(input.file),
			walBytes: 0,
			mirror: { dir: input.mirrorDir ?? "", files: 0 },
			// 失败的块必须留痕：没有这个字段，自检只能看到一个"空库"。
			error: memoryError,
		};
	}

	const sessions = safe(
		() => sessionSection(db, input.sessionsDir, input.noCache === true),
		{
			total: 0,
			active: 0,
			ingested: 0,
			failed: 0,
			lastIngestTs: 0,
			recent: [],
			disk: { files: 0, bytes: 0, newest: 0 },
		},
	);
	// 同一件事只查一次：记忆库那块要的"已吸收"就是 sessions.ingested。
	memory.sessions = sessions.ingested;

	const tools = safe(() => toolSection(input.tools ? input.tools() : []), { count: 0, groups: [], names: [] });
	const status = safe(
		() =>
			statusSection({
				file: input.file,
				mirrorDir: input.mirrorDir ?? "",
				frontLog: input.frontLog ?? "",
				version: input.version ?? "",
				dshVersion: input.dshVersion,
				sessions,
				memory,
				now,
			}),
		{ checks: [], ts: now, version: input.version ?? "" },
	);
	return { ts: now, memory, sessions, tools, status };
}
