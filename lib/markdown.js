/**
 * Markdown 镜像层：把 SQLite 里的卡投影成「可读、可 git、可手改」的目录树。
 *
 * 真身仍然是 `kb.db` —— 这个目录是投影，不是第二个真相源。围绕这条，
 * 四件事各自有明确取舍：
 *
 *   1. **按 id 匹配已有文件**：标题改了只改名（rename），不留一堆旧文件。
 *   2. **内容没变就不写盘**：`git diff` 只反映真改动，不被时间戳噪声污染。
 *   3. **库里已经没有的 id**：文件移进 `.trash/` 而不是 unlink —— 误删能捞回来。
 *   4. **导入以「谁更新」为准**：文件 mtime 比 `fact.updated_at` 新才覆盖，
 *      否则算 stale 跳过。这样「重新 clone 一份旧镜像」不会把库回滚。
 *
 * frontmatter 用双引号 JSON 形式的标量 + `[a, "b"]` 形式的数组，这样解析端
 * 不需要引入 YAML 依赖（本包的原则是零外部依赖，只有 node: 内置模块）。
 *
 * @module dsh-kb/markdown
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { seg } from "./segment.js";
import { insertFactWithId, upsertFact, updateFact } from "./store.js";

/** 镜像里放废文件、不参与导入的子目录名。 */
const TRASH_DIR = ".trash";

/** 根目录说明文件，导入时按「没有 id」跳过。 */
const README = "README.md";

/** 最近版本号：镜像结构的语义变了就 +1，导入端据此提示重建。 */
export const MIRROR_FORMAT = 1;

/**
 * 统一换行：CRLF 与单独的 CR 都折成 LF。
 *
 * 必要，不是洁癖：`parseFrontmatter` 拆行后重拼用的是 `\n`，所以带 CRLF 的正文
 * 读回来就与库里不同，一往返就判成"被改过"。库里原字节保持不动，只在**渲染与
 * 比较**两条路上规范化，这样镜像往返是幂等的，而库不被无意义改写。
 *
 * @param {unknown} text - 原文。
 * @returns {string} LF 版本。
 */
export function normalizeBody(text) {
	return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 标题转文件名片段：去掉文件系统非法字符，保留中文，限制长度。
 * @param {string} title - 卡标题。
 * @returns {string} 可做文件名的一段。
 */
export function slugify(title) {
	const cleaned = String(title ?? "")
		.replace(/[\\/:*?"<>|\[\]{}()\u0000-\u001f]/g, " ")
		.replace(/[\s\u3000]+/g, " ")
		.trim()
		.slice(0, 40)
		.trim();
	return cleaned.length > 0 ? cleaned.replace(/ /g, "-") : "untitled";
}

/**
 * id 的可读短码：`f_06f66b236d1d6b` -> `06f66b23`。
 * @param {string} id - 卡 id。
 * @returns {string} 8 位短码。
 */
export function shortId(id) {
	const raw = String(id ?? "").replace(/^f_/, "");
	return (raw.length >= 8 ? raw.slice(0, 8) : raw.padEnd(8, "0")) || "00000000";
}

/**
 * 一张卡在镜像里的相对路径（用 `/` 分隔，与骨架树路径一致）。
 * @param {{id: string, title: string, path: string}} row - 卡行。
 * @returns {string} 形如 `topic/dsh/标题--06f66b23.md`。
 */
export function relPathFor(row) {
	const dir = String(row.path ?? "").trim() || "inbox";
	const safeDir = dir
		.split("/")
		.map((part) => part.replace(/[\\:*?"<>|\u0000-\u001f]/g, "").trim() || "_")
		.join("/");
	return `${safeDir}/${slugify(row.title)}--${shortId(row.id)}.md`;
}

/**
 * 序列化一个值成 frontmatter 里的写法。
 * @param {unknown} value - 标量或数组。
 * @returns {string} 文本。
 */
function formatValue(value) {
	if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
	if (typeof value === "boolean") return String(value);
	return JSON.stringify(String(value ?? ""));
}

/**
 * 拼 frontmatter 文本。
 * @param {Record<string, unknown>} meta - 键值。
 * @returns {string} 含首尾 `---` 的块（尾部带一个空行）。
 */
export function renderFrontmatter(meta) {
	const lines = ["---"];
	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		lines.push(`${key}: ${formatValue(value)}`);
	}
	lines.push("---", "");
	return lines.join("\n");
}

/**
 * 按引号感知切数组元素（`["a, b", "c"]` 里的逗号不能切）。
 * @param {string} inner - 去掉方括号后的内容。
 * @returns {string[]} 原始片段。
 */
function splitTopLevel(inner) {
	const out = [];
	let buf = "";
	let inString = false;
	let escaped = false;
	for (const ch of inner) {
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			buf += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			buf += ch;
			continue;
		}
		if (ch === "," && !inString) {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim() !== "") out.push(buf);
	return out;
}

/**
 * 解析一个 frontmatter 值。
 * @param {string} raw - 原始片段。
 * @returns {unknown} 标量或数组。
 */
function parseValue(raw) {
	const text = String(raw).trim();
	if (text === "") return "";
	if (text.startsWith("[")) {
		const inner = text.endsWith("]") ? text.slice(1, -1) : text.slice(1);
		return splitTopLevel(inner)
			.map((part) => parseValue(part))
			.filter((item) => item !== "");
	}
	if (text.startsWith('"')) {
		try {
			return JSON.parse(text);
		} catch {
			// 手写坏引号：退回原文，别把整份文件判成无效
			return text.replace(/^"|"$/g, "");
		}
	}
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

/**
 * 拆出 frontmatter 与正文。
 *
 * 只认「文件第一行是 `---`」这一种写法；正文里出现的 `---` 分隔线不受影响。
 * @param {string} text - 文件全文。
 * @returns {{meta: Record<string, unknown>, body: string, hasFrontmatter: boolean}} 拆解结果。
 */
export function parseFrontmatter(text) {
	const source = String(text ?? "").replace(/^\uFEFF/, "");
	const lines = source.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { meta: {}, body: source, hasFrontmatter: false };
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end < 0) return { meta: {}, body: source, hasFrontmatter: false };
	/** @type {Record<string, unknown>} */
	const meta = {};
	for (const line of lines.slice(1, end)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const at = line.indexOf(":");
		if (at < 0) continue;
		const key = line.slice(0, at).trim();
		if (key === "") continue;
		meta[key] = parseValue(line.slice(at + 1));
	}
	return { meta, body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""), hasFrontmatter: true };
}

/**
 * 一张卡渲染成文件内容。
 * @param {object} row - fact 表行（paths/tags 为 JSON 字符串）。
 * @returns {string} 文件全文。
 */
export function renderFactFile(row) {
	const asList = (value) => {
		try {
			const parsed = JSON.parse(value ?? "[]");
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	};
	const meta = {
		id: row.id,
		title: row.title,
		kind: row.kind,
		status: row.status,
		path: row.path,
		paths: asList(row.paths),
		tags: asList(row.tags),
		confidence: Number(row.confidence ?? 0.6),
		version: Number(row.version ?? 1),
		ts: Number(row.ts ?? 0),
		updated: Number(row.updated_at ?? 0),
		session: row.session_id || undefined,
		cwd: row.cwd || undefined,
		source: row.source_kind || undefined,
		ref: row.source_ref || undefined,
		mirror: MIRROR_FORMAT,
	};
	const body = normalizeBody(row.body).trimEnd();
	return `${renderFrontmatter(meta)}${body}\n`;
}

/**
 * 递归收集目录下的 .md（跳过 `.trash/`）。
 * @param {string} dir - 根目录。
 * @returns {string[]} 绝对路径列表。
 */
export function walkMarkdown(dir) {
	/** @type {string[]} */
	const out = [];
	const visit = (current) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === TRASH_DIR || entry.name.startsWith(".")) continue;
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) visit(abs);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(abs);
		}
	};
	visit(dir);
	return out;
}

/**
 * 读一份镜像：返回带 id 的条目（README 之类没有 id 的自动跳过）。
 * @param {string} dir - 根目录。
 * @returns {Array<{file: string, meta: Record<string, unknown>, body: string, mtime: number}>} 条目。
 */
export function readMirror(dir) {
	const items = [];
	for (const file of walkMarkdown(dir)) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { meta, body } = parseFrontmatter(text);
		const id = typeof meta.id === "string" ? meta.id.trim() : "";
		if (id === "") continue;
		let mtime = 0;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			mtime = 0;
		}
		items.push({ file, meta, body, mtime });
	}
	return items;
}

/**
 * 全库行（按 path 排序，保证镜像里文件顺序稳定）。
 * @param {import('node:sqlite').DatabaseSync} db - 库句柄。
 * @param {{limit?: number, status?: string}} [options] - 限制。
 * @returns {object[]} 行。
 */
export function mirrorRows(db, options = {}) {
	const limit = Number.isFinite(options.limit) ? Number(options.limit) : -1;
	const sql =
		"SELECT id,ts,kind,title,body,path,paths,tags,status,confidence,source_kind,source_ref," +
		"session_id,cwd,version,updated_at FROM fact ORDER BY path, ts DESC, title" +
		(limit > 0 ? ` LIMIT ${limit}` : "");
	return db.prepare(sql).all();
}

/**
 * 计算镜像要做的事（不写盘，方便测与 dry-run）。
 * @param {import('node:sqlite').DatabaseSync} db - 库句柄。
 * @param {string} dir - 镜像根目录。
 * @param {{limit?: number}} [options] - 限制。
 * @returns {{writes: Array<{abs: string, rel: string, content: string}>, moves: Array<{from: string, to: string}>, trash: string[], unchanged: number, total: number}} 计划。
 */
export function planMirror(db, dir, options = {}) {
	const rows = mirrorRows(db, options);
	const existing = readMirror(dir);
	/** @type {Map<string, {file: string, body: string}>} */
	const byId = new Map();
	for (const item of existing) {
		const id = String(item.meta.id);
		if (!byId.has(id)) byId.set(id, { file: item.file, body: item.body });
	}
	const keep = new Set();
	const writes = [];
	const moves = [];
	let unchanged = 0;
	for (const row of rows) {
		keep.add(row.id);
		const rel = relPathFor(row);
		const abs = path.join(dir, rel.split("/").join(path.sep));
		const content = renderFactFile(row);
		const prev = byId.get(row.id);
		if (prev !== undefined && path.resolve(prev.file) !== path.resolve(abs)) {
			moves.push({ from: prev.file, to: abs });
		}
		if (existsSync(abs)) {
			let disk = "";
			try {
				disk = readFileSync(abs, "utf8");
			} catch {
				disk = "";
			}
			if (disk === content) {
				unchanged += 1;
				continue;
			}
		}
		writes.push({ abs, rel, content });
	}
	const trash = existing.filter((item) => !keep.has(String(item.meta.id))).map((item) => item.file);
	return { writes, moves, trash, unchanged, total: rows.length };
}

/**
 * 根目录说明文件的内容。
 * @param {{total: number, written: number, unchanged: number, trashed: number}} stats - 统计。
 * @returns {string} Markdown 全文。
 */
export function renderReadme(stats) {
	return `# 知识库镜像

这个目录由 \`@myremme/dsh-kb\` 从 \`kb.db\` 投影生成，**不是真身**。

- 真身：\`kb.db\`（SQLite + FTS5），写入永远先落库。
- 本目录：只读投影，用来 \`git diff\`、用编辑器翻、给人看。
- 每张卡的 frontmatter 里带 \`id\` 与 \`updated\`，是导入时的匹配键。

## 怎么改

1. 直接编辑 \`.md\` 正文或 frontmatter（\`title\` / \`path\` / \`tags\` / \`status\` / \`kind\`）。
2. 跑 \`kb import --md --dir <这个目录>\` 写回库。
3. 只有**文件比库里新**才会覆盖；想强制回灌加 \`--force\`。

> 删文件 ≠ 删卡。要废一张卡请把 \`status\` 改成 \`superseded\`，或 \`kb forget <id>\`。
> 重新导出时，库里已不存在的 id 对应的文件会被移到 \`.trash/\`。

## 统计

| 项 | 数量 |
|---|---|
| 库里卡数 | ${stats.total} |
| 本次写入 | ${stats.written} |
| 内容未变（跳过） | ${stats.unchanged} |
| 移入 .trash | ${stats.trashed} |

生成格式版本：${MIRROR_FORMAT}
`;
}

/**
 * 把库投影成目录树。
 * @param {import('node:sqlite').DatabaseSync} db - 库句柄。
 * @param {string} dir - 镜像根目录。
 * @param {{limit?: number, dryRun?: boolean, readme?: boolean}} [options] - 选项。
 * @returns {{dir: string, total: number, written: number, moved: number, trashed: number, unchanged: number, dryRun: boolean}} 统计。
 */
export function mirrorToDir(db, dir, options = {}) {
	if (typeof dir !== "string" || dir.trim() === "") throw new Error("缺少镜像目录");
	const root = path.resolve(dir);
	const plan = planMirror(db, root, options);
	if (options.dryRun === true) {
		return {
			dir: root,
			total: plan.total,
			written: plan.writes.length,
			moved: plan.moves.length,
			trashed: plan.trash.length,
			unchanged: plan.unchanged,
			dryRun: true,
		};
	}
	mkdirSync(root, { recursive: true });
	for (const move of plan.moves) {
		mkdirSync(path.dirname(move.to), { recursive: true });
		try {
			renameSync(move.from, move.to);
		} catch {
			// 目标已存在（同 id 两处）时让下面的 writes 覆盖即可
		}
	}
	for (const write of plan.writes) {
		mkdirSync(path.dirname(write.abs), { recursive: true });
		writeFileSync(write.abs, write.content, "utf8");
	}
	if (plan.trash.length > 0) {
		const trashDir = path.join(root, TRASH_DIR);
		mkdirSync(trashDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		for (const file of plan.trash) {
			const target = path.join(trashDir, `${stamp}--${path.basename(file)}`);
			try {
				renameSync(file, target);
			} catch {
				// 挪不动就留在原地：下次导出还会再试
			}
		}
	}
	if (options.readme !== false) {
		const readme = path.join(root, README);
		const text = renderReadme({
			total: plan.total,
			written: plan.writes.length,
			unchanged: plan.unchanged,
			trashed: plan.trash.length,
		});
		let current = "";
		try {
			current = readFileSync(readme, "utf8");
		} catch {
			current = "";
		}
		if (current !== text) writeFileSync(readme, text, "utf8");
	}
	return {
		dir: root,
		total: plan.total,
		written: plan.writes.length,
		moved: plan.moves.length,
		trashed: plan.trash.length,
		unchanged: plan.unchanged,
		dryRun: false,
	};
}

/**
 * 从镜像写回库。
 *
 * 冲突策略见模块头第 4 条：文件 mtime 比 `updated_at` 新才覆盖。
 * @param {import('node:sqlite').DatabaseSync} db - 库句柄。
 * @param {string} dir - 镜像根目录。
 * @param {{force?: boolean, dryRun?: boolean, segFn?: Function}} [options] - 选项。
 * @returns {{dir: string, created: number, updated: number, stale: number, unchanged: number, failed: Array<{file: string, error: string}>, dryRun: boolean}} 统计。
 */
export function importFromDir(db, dir, options = {}) {
	if (typeof dir !== "string" || dir.trim() === "") throw new Error("缺少镜像目录");
	const root = path.resolve(dir);
	if (!existsSync(root)) throw new Error(`目录不存在：${root}`);
	const segFn = options.segFn ?? seg;
	const force = options.force === true;
	const dryRun = options.dryRun === true;
	const items = readMirror(root);
	const stats = { dir: root, created: 0, updated: 0, stale: 0, unchanged: 0, failed: [], dryRun };
	for (const item of items) {
		const id = String(item.meta.id);
		const row = db.prepare("SELECT id,title,body,path,paths,tags,kind,status,updated_at FROM fact WHERE id=?").get(id);
		const title = typeof item.meta.title === "string" && item.meta.title !== "" ? item.meta.title : "(untitled)";
		const body = normalizeBody(item.body).trimEnd();
		const pathValue = typeof item.meta.path === "string" ? item.meta.path : "";
		const paths = Array.isArray(item.meta.paths) && item.meta.paths.length > 0 ? item.meta.paths.map(String) : pathValue ? [pathValue] : [];
		const tags = Array.isArray(item.meta.tags) ? item.meta.tags.map(String) : [];
		const kind = typeof item.meta.kind === "string" && item.meta.kind !== "" ? item.meta.kind : "fact";
		const status = typeof item.meta.status === "string" && item.meta.status !== "" ? item.meta.status : "active";
		try {
			if (row === undefined) {
				/** 镜像里的 id 是既成事实，能沿用就沿用；格式不合法才退回内容哈希生成。 */
				const payload = {
					title,
					body,
					kind,
					path: pathValue,
					paths,
					tags,
					status,
					source_kind: "markdown",
					source_ref: path.relative(root, item.file).split(path.sep).join("/"),
					ts: Number(item.meta.ts) || Date.now(),
				};
				const wrote = dryRun
					? "added"
					: /^f_[0-9a-f]{8,}$/i.test(id)
						? insertFactWithId(db, id, payload, segFn)
						: upsertFact(db, payload, segFn);
				if (wrote === "added") stats.created += 1;
				else if (wrote === "updated") stats.updated += 1;
				else stats.unchanged += 1;
				continue;
			}
			// 顺序要紧：先比内容，再比时间。
			// 否则「刚导出的镜像」因为文件 mtime 必然晚于 updated_at，会被判成"文件更新"。
			const same =
				row.title === title &&
				normalizeBody(row.body).trimEnd() === body &&
				row.path === pathValue &&
				row.kind === kind &&
				row.status === status &&
				String(row.paths ?? "[]") === JSON.stringify(paths) &&
				String(row.tags ?? "[]") === JSON.stringify(tags);
			if (same) {
				stats.unchanged += 1;
				continue;
			}
			const updatedAt = Number(row.updated_at) || 0;
			if (!force && item.mtime <= updatedAt) {
				stats.stale += 1;
				continue;
			}
			if (!dryRun) {
				updateFact(db, id, { title, body, paths, kind, status, tags }, segFn);
			}
			stats.updated += 1;
		} catch (error) {
			stats.failed.push({ file: item.file, error: String(error?.message ?? error) });
		}
	}
	return stats;
}
