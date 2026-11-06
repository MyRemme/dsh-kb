/**
 * 抽取流水线：会话文件 → 事实卡。
 *
 * 设计上只做"已经写在会话里的事实"。**"为什么"不从这里推** —— 那必须由模型在
 * 当场用 kb_add 写下，否则抽出来的是幻觉。这条分工是整套系统可信度的地基。
 *
 * 幂等靠 作用域内完整内容指纹 + `ingest_log` 的 size/mtime 检查：重跑只更新、不重复，
 * 所以随时可以全量重扫。
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { dshHome, writeFact, addEdge, transaction } from "./store.js";
import { listSessionFiles, readSessionResult, eventsToFacts } from "./session.js";
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
	const stats = { files: 0, attempted: 0, added: 0, dup: 0, updated: 0, skip: 0, err: 0, facts: 0, conflicts: [] };
	if (!existsSync(sessionsDir)) return stats;

	const logStmt = db.prepare("SELECT size, mtime, err, ts FROM ingest_log WHERE session_key=?");
	// 未尝试文件优先，失败重试按最近尝试时间排队，避免小批次永久卡在第一个坏文件。
	const files = listSessionFiles(sessionsDir).map(f=>({...f,previous:logStmt.get(f.key)}))
		.sort((a,b)=>(a.previous?.err ? a.previous.ts : 0)-(b.previous?.err ? b.previous.ts : 0) || a.mtime-b.mtime || a.key.localeCompare(b.key));
	const saveStmt = db.prepare(
		"INSERT OR REPLACE INTO ingest_log(session_key,file,size,mtime,added,skipped,err,ts) VALUES (?,?,?,?,?,?,?,?)",
	);

	for (const f of files) {
		if (opts.limit && stats.attempted >= opts.limit) break;
		// 小文件也可能是截断帧；完整性必须由解析结果决定，不能按字节数跳过。
		const prev = f.previous;
		if (prev && !prev.err && !opts.rescan && prev.size === f.size && prev.mtime === f.mtime) continue;
		stats.attempted++;

		let events;
		let parsed;
		let meta;
		let facts;
		try {
			parsed = readSessionResult(f.file);
			events = parsed.events;
			meta = events.find((e) => e.type === "session");
			if (!meta?.id) {
				throw new Error(parsed.errors.join("; ") || "Missing session header");
			}
			facts = eventsToFacts(events, meta);
		} catch (error) {
			stats.err += 1;
			saveStmt.run(f.key, f.file, f.size, f.mtime, 0, 0, String(error).slice(0, 300), Date.now());
			continue;
		}

        let added = 0, updated = 0, dup = 0, conflicts = [];
        try {
            transaction(db, () => {
                const written = facts.map(fact => ({ fact, saved:writeFact(db,fact,seg) }));
                for (const {saved} of written) {
                    if (saved.result === 'added') added++;
                    else if (saved.result === 'updated') updated++;
                    else if (saved.result === 'conflict') conflicts.push(saved);
                    else dup++;
                }
                const episode = written.find(w => w.fact.kind === 'episode');
                if (episode?.saved.id) for (const w of written) {
                    if (w.fact.kind !== 'episode' && w.saved.id) addEdge(db,episode.saved.id,w.saved.id,'produces',1,w.fact.kind);
                }
                const errors = [...parsed.errors,...conflicts.map(c=>`Source conflict ${c.id}: ${c.reason} ${(c.fields ?? []).join(',')}`)];
                saveStmt.run(f.key,f.file,f.size,f.mtime,added,dup,errors.join('; ').slice(0,300),Date.now());
            });
        } catch (error) {
            stats.err++;
            saveStmt.run(f.key,f.file,f.size,f.mtime,0,0,String(error).slice(0,300),Date.now());
            continue;
        }
        if (!parsed.complete || conflicts.length) stats.err++;
        stats.conflicts.push(...conflicts);
        stats.files++; stats.facts += facts.length; stats.added += added; stats.updated += updated; stats.dup += dup;

		opts.onProgress?.(`+${added}\t${meta.id.slice(0, 22)}\t${facts[0]?.title?.slice(0, 60) ?? ""}`);
	}
	return stats;
}
