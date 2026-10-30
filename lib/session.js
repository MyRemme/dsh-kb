/**
 * 会话文件解析：`$DSH_HOME/sessions/<cwd-tag>/<session-id>/session.v*.jsonl.zstd`
 *
 * 两个非显然的事实：
 *   1. 文件是 **多帧 zstd**（一个会话几十帧）。Node 的 `zstdDecompressSync` 一次性
 *      只解第一帧，结果只有一个 session header —— 这是最容易被当成"文件坏了"的坑。
 *      这里按 magic 扫帧边界，逐帧解。
 *   2. 事件流里真正有用的只有四种：`session` header、`session/title`、
 *      `compaction/summary`、`user/message`。其余（tool/call、step/start…）是过程，
 *      不是知识。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { inferPaths } from "./search.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 单会话解压上限，防内存爆掉（实测最大 8.8MB → 92MB）。 */
const MAX_DECODED = 256 * 1024 * 1024;

/** 注入类消息，不是用户意图。 */
const NOISE = [
	"<system-reminder>",
	"Current runtime context",
	"Tokens prefixed with @",
	"A skill is a reusable set",
	"This is a reminder that your todo",
	"[Request interrupted by user]",
];

/**
 * 逐帧解压多帧 zstd。
 * @param {Buffer} buf - 整个文件。
 * @returns {string[]} 每帧解出的 UTF-8 文本。
 */
export function decompressFrames(buf) {
	const out = [];
	let total = 0;
	let at = 0;
	while (at < buf.length) {
		const off = buf.indexOf(MAGIC, at);
		if (off === -1) break;
		at = off + 4;
		let text;
		try {
			text = zlib.zstdDecompressSync(buf.subarray(off)).toString("utf8");
		} catch {
			continue; // 压缩数据里偶然出现的 magic，跳过
		}
		total += text.length;
		if (total > MAX_DECODED) break;
		out.push(text);
	}
	return out;
}

/**
 * 读一个会话文件，返回事件数组。
 * @param {string} file - 会话文件路径。
 * @returns {object[]} 事件流。
 */
export function readSession(file) {
	const events = [];
	for (const chunk of decompressFrames(readFileSync(file))) {
		for (const line of chunk.split("\n")) {
			const s = line.trim();
			if (!s) continue;
			try {
				events.push(JSON.parse(s));
			} catch {
				// 单行坏掉不影响其他行
			}
		}
	}
	return events;
}

function textOf(msg) {
	const parts = [];
	for (const c of msg.content ?? []) {
		if (c && c.type === "text") parts.push(c.text ?? "");
	}
	return parts.join("\n").trim();
}

/** `## 标题` 分段。 */
function splitSections(md) {
	const chunks = md.split(/^##+\s+/m);
	const out = [];
	const head = chunks[0].trim();
	if (head.length > 40) out.push(["Overview", head]);
	for (const c of chunks.slice(1)) {
		const nl = c.indexOf("\n");
		if (nl === -1) continue;
		const name = c.slice(0, nl).trim();
		const body = c.slice(nl + 1).trim();
		if (body) out.push([name, body]);
	}
	return out;
}

const KIND_MAP = [
	[/intent|request|goal/i, "intent"],
	[/concept|technical|approach|architect/i, "concept"],
	[/file|code|artifact|asset/i, "artifact"],
	[/error|fix|bug|issue/i, "fix"],
	[/problem|decision|solution|solving/i, "decision"],
	[/pending|next|todo|remaining/i, "todo"],
	[/current|state|status/i, "state"],
	[/user|preference|feedback/i, "pref"],
];

/**
 * 事件流 → 事实卡候选。幂等：同一内容重复跑只会命中 dup。
 * @param {object[]} events - 事件流。
 * @param {object} meta - session header。
 * @returns {object[]} 卡片数组。
 */
export function eventsToFacts(events, meta) {
	const sid = meta.id;
	const cwd = meta.cwd ?? "";
	const facts = [];

	let title = "";
	const summaries = [];
	const users = [];
	const seenUid = new Set();
	let lastAssistant = "";

	for (const ev of events) {
		const d = ev.data ?? {};
		const t = ev.type;
		const tms = Number(ev.time) || Number(meta.createdAt) || 0;
		if (t === "session/title") {
			title = String(d.title ?? "").trim() || title;
		} else if (t === "compaction/summary") {
			const txt = (d.summary ?? [])
				.map((c) => (c && typeof c === "object" ? c.text ?? "" : ""))
				.join("\n")
				.trim();
			if (txt) summaries.push(txt);
		} else if (t === "user/message") {
			const src = d.source ?? {};
			if (src.kind !== undefined && src.kind !== "user") continue;
			if (seenUid.has(d.id)) continue;
			seenUid.add(d.id);
			const txt = textOf(d);
			if (!txt || NOISE.some((n) => txt.includes(n))) continue;
			users.push([tms, txt.slice(0, 800)]);
		} else if (t === "assistant/message") {
			const txt = textOf(d);
			if (txt && !txt.startsWith("[tool")) lastAssistant = txt;
		}
	}

	const ts0 = Math.floor(Number(meta.createdAt) / 1000) * 1000 || Date.now();
	const short = String(sid).replace("session-", "").slice(0, 8);
	const label = title || users[0]?.[1].slice(0, 60) || "untitled";
	const best = summaries.length > 0 ? summaries.reduce((a, b) => (b.length > a.length ? b : a)) : "";

	let episodeBody = best || lastAssistant.slice(0, 2000);
	if (users.length > 0) {
		episodeBody += `\n\n### 用户原话（节选）\n${users.slice(0, 5).map(([, u]) => `- ${u.slice(0, 200)}`).join("\n")}`;
	}
	if (episodeBody.trim()) {
		facts.push({
			title: `[会话] ${label}`,
			body: episodeBody.trim(),
			kind: "episode",
			ts: ts0,
			source_kind: "session",
			source_ref: sid,
			session_id: sid,
			cwd,
			confidence: 0.55,
			paths: inferPaths(label, episodeBody, cwd),
			tags: [short, "session"],
		});
	}

	if (best) {
		for (const [name, sec] of splitSections(best)) {
			const kind = KIND_MAP.find(([re]) => re.test(name))?.[1] ?? "fact";
			facts.push({
				title: `${label} · ${name}`,
				body: sec,
				kind,
				ts: ts0,
				source_kind: "compaction",
				source_ref: `${sid}#${name}`,
				session_id: sid,
				cwd,
				confidence: ["decision", "fix", "concept"].includes(kind) ? 0.7 : 0.55,
				paths: inferPaths(`${name} ${sec}`, sec, cwd),
				tags: [short, kind],
			});
		}
	}

	if (users.length >= 2) {
		const picked = users.slice(0, 3).concat(users.length > 5 ? users.slice(-2) : []);
		const body = picked.map(([, u]) => `- ${u.slice(0, 300)}`).join("\n");
		facts.push({
			title: `[意图] ${label}`,
			body,
			kind: "intent",
			ts: ts0,
			source_kind: "session",
			source_ref: `${sid}#intent`,
			session_id: sid,
			cwd,
			confidence: 0.65,
			paths: inferPaths(label, body, cwd),
			tags: [short, "intent"],
		});
	}

	return facts;
}

/**
 * 列出会话文件，同一会话只保留版本号最高的那个。
 * @param {string} sessionsDir - sessions 根目录。
 * @returns {Array<{file: string, key: string, size: number, mtime: number}>} 文件清单。
 */
export function listSessionFiles(sessionsDir) {
	const best = new Map();
	const walk = (dir) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (/^session\.v\d+\.jsonl\.zstd$/.test(ent.name)) {
				const prev = best.get(dir);
				if (!prev || ent.name > prev.name) best.set(dir, { name: ent.name, file: p });
			}
		}
	};
	walk(sessionsDir);
	return [...best.values()].map(({ file }) => {
		const st = statSync(file);
		return {
			file,
			key: path.relative(sessionsDir, file),
			size: st.size,
			mtime: Math.floor(st.mtimeMs),
		};
	});
}
