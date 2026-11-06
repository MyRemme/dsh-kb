/**
 * 骨架树摘要。**是可重算的缓存，不是真相。**
 *
 * 枝的边界随事实卡漂移：今天 `topic/dsh` 收 60 张，明天关键词变了就收 300 张。
 * 所以摘要必须随时能重算（实测 12 个节点 0.1 秒），把它当真相存下来 = 日后无法纠正。
 */

/**
 * 重算每个节点的摘要。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {number} [topn] - 每枝列出的代表卡数量。
 * @returns {number} 更新的节点数。
 */
export function digest(db, topn = 4) {
	const nodes = db.prepare("SELECT path FROM node ORDER BY length(path) DESC").all();
	const upd = db.prepare("UPDATE node SET summary=?, updated_at=? WHERE path=?");
	let done = 0;
	for (const { path: p } of nodes) {
		const rows = db
			.prepare(
				"SELECT title, kind, ts FROM fact f WHERE status='active' AND (path=? OR EXISTS (SELECT 1 FROM json_each(f.paths) p WHERE p.value=?)) ORDER BY ts DESC",
			)
			.all(p, p);
		if (rows.length === 0) { upd.run("", Date.now(), p); done += 1; continue; }

		const kinds = new Map();
		for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
		const top = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
		const newest = Math.max(...rows.map((r) => Number(r.ts)));
		const titles = [];
		const seen = new Set();
		for (const r of rows) {
			if (seen.has(r.title)) continue;
			seen.add(r.title);
			titles.push(r.title);
			if (titles.length >= topn) break;
		}
		const when = new Date(newest > 1e11 ? newest : newest * 1000).toISOString().slice(0, 10);
		const summary =
			`${rows.length} 张卡｜${top.map(([k, v]) => `${k}×${v}`).join(" ")}｜最近 ${when}\n` +
			titles.map((t) => `· ${t.slice(0, 90)}`).join("\n");
		upd.run(summary, Date.now(), p);
		done += 1;
	}
	return done;
}

/**
 * 读树结构（供工具与 CLI 渲染）。
 * @param {DatabaseSync} db - 已打开的库。
 * @param {string} [prefix] - 子树前缀。
 * @returns {Array<{path:string, depth:number, count:number, summary:string}>} 节点数组。
 */
export function treeRows(db, prefix = "") {
	const rows = db.prepare("SELECT path, summary FROM node ORDER BY path").all();
	const out = [];
	for (const r of rows) {
		const wanted = String(prefix).replace(/\/+$/, '');
		if (wanted && r.path !== wanted && !r.path.startsWith(`${wanted}/`)) continue;
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM fact f WHERE status='active' AND (path=? OR EXISTS (SELECT 1 FROM json_each(f.paths) p WHERE p.value=?))")
			.get(r.path, r.path).n;
		out.push({ path: r.path, depth: r.path.split("/").length - 1, count, summary: r.summary });
	}
	return out;
}
