/**
 * 抽取流水线：会话文件 → 事实卡。
 *
 * 设计上只做"已经写在会话里的事实"。**"为什么"不从这里推** —— 那必须由模型在
 * 当场用 kb_add 写下，否则抽出来的是幻觉。这条分工是整套系统可信度的地基。
 *
 * 幂等靠 `factHash` 唯一索引 + `ingest_log` 的 size/mtime 检查：重跑只更新、不重复，
 * 所以随时可以全量重扫。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { dshHome, makeId, upsertFact, addEdge } from "./store.js";
import { listSessionFiles, readSession, eventsToFacts } from "./session.js";
import { seg } from "./segment.js";

/**
 * 增量吸收会话。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {object} [opts] - 选项。
 * @param {string} [opts.sessionsDir] - 会话根目录，缺省 $DSH_HOME/sessions。
 * @param {boolean} [opts.rescan] - 忽略 size/mtime 缓存，全量重扫。
 * @param {number} [opts.limit] - 最多处理多少个文件。
 * @param {(msg: string) => void} [opts.onProgress] - 进度回调。
 * @returns {{files:number, added:number, dup:number, updated:number, skip:number, err:number, facts:number}}
 */
export function ingest(db, opts = {}) {
	const sessionsDir = opts.sessionsDir ?? path.join(dshHome(), "sessions");
	const stats = { files: 0, added: 0, dup: 0, updated: 0, skip: 0, err: 0, facts: 0 };
	if (!existsSync(sessionsDir)) return stats;

	const files = listSessionFiles(sessionsDir).sort((a, b) => a.mtime - b.mtime);
	const logStmt = db.prepare("SELECT size, mtime FROM ingest_log WHERE session_key=?");
	const saveStmt = db.prepare(
		"INSERT OR REPLACE INTO ingest_log(session_key,file,size,mtime,added,skipped,err,ts) VALUES (?,?,?,?,?,?,?,?)",
	);

	for (const f of files) {
		if (opts.limit && stats.files >= opts.limit) break;
		if (f.size < 400) {
			stats.skip += 1;
			continue;
		}
		const prev = logStmt.get(f.key);
		if (prev && !opts.rescan && prev.size === f.size && prev.mtime === f.mtime) continue;

		let events;
		let meta;
		let facts;
		try {
			events = readSession(f.file);
			meta = events.find((e) => e.type === "session");
			if (!meta?.id) {
				stats.skip += 1;
				continue;
			}
			facts = eventsToFacts(events, meta);
		} catch (error) {
			stats.err += 1;
			saveStmt.run(f.key, f.file, f.size, f.mtime, 0, 0, String(error).slice(0, 300), Date.now());
			continue;
		}

		let added = 0;
		let updated = 0;
		let dup = 0;
		for (const fact of facts) {
			const r = upsertFact(db, fact, seg);
			if (r === "added") added += 1;
			else if (r === "updated") updated += 1;
			else dup += 1;
		}

		// 会话卡 → 抽出的卡：语义是"这段对话**产生**了这条记忆"（produces），
		// 不是"包含"。老库里的 contains 由 migrate 一次性改名（user_version 3）。
		const sessionCard = db
			.prepare("SELECT id FROM fact WHERE session_id=? AND kind='episode' LIMIT 1")
			.get(meta.id);
		if (sessionCard) {
			for (const fact of facts) {
				if (fact.kind === "episode") continue;
				const cid = makeId(fact.title, fact.body.slice(0, 6000));
				if (db.prepare("SELECT 1 AS x FROM fact WHERE id=?").get(cid)) {
					addEdge(db, sessionCard.id, cid, "produces", 1.0, fact.kind ?? "");
				}
			}
		}

		saveStmt.run(f.key, f.file, f.size, f.mtime, added, dup, "", Date.now());
		stats.files += 1;
		stats.facts += facts.length;
		stats.added += added;
		stats.updated += updated;
		stats.dup += dup;
		opts.onProgress?.(`+${added}\t${meta.id.slice(0, 22)}\t${facts[0]?.title?.slice(0, 60) ?? ""}`);
	}
	return stats;
}
