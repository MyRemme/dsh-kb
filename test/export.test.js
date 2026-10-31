/**
 * 静态导出测试：产物是单文件 HTML，所以断言点全在"字节里有没有正确的数据"。
 *
 * 最要紧的两条：
 *   1. 正文里的 `</script>` 必须被转义，否则整页在浏览器里提前闭合，数据全丢
 *   2. 嵌进去的 JSON 必须能被 `JSON.parse` 原样还原（不是"看起来像"）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, upsertFact } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { exportStatic, renderHtml, snapshot, defaultExportPath } from "../lib/export.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-export-"));

/** 造一个带脏数据的库：正文里有能提前闭合 script 的字符串。 */
function seedDb() {
	const { db, file } = openDb(path.join(dir, "kb.db"));
	upsertFact(
		db,
		{
			title: "导出必须转义 script 结束标签",
			body: "正文里写了 </script> 与 <b>标签</b>，导出后仍然要能整段显示。",
			kind: "fix",
			path: "topic/export",
			paths: ["topic/export", "topic/dsh-kb"],
			tags: ["导出", "转义"],
			source_kind: "test",
			confidence: 0.9,
			ts: Date.now(),
		},
		seg,
	);
	upsertFact(
		db,
		{ title: "第二张卡", body: "普通正文。", kind: "fact", path: "inbox", ts: Date.now() },
		seg,
	);
	return { db, file };
}

/** 从产物里取出内嵌 JSON。 */
function embedded(html) {
	const match = html.match(/<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/);
	assert.ok(match, "产物里没有 kb-data 数据块");
	return JSON.parse(match[1]);
}

test("snapshot 收集卡、树与边", () => {
	const { db } = seedDb();
	const data = snapshot(db, 100);
	assert.equal(data.facts.length, 2);
	assert.ok(data.tree.length >= 2);
	assert.ok(data.tree.every((n) => typeof n.path === "string" && typeof n.count === "number"));
	const fact = data.facts.find((f) => f.title.includes("script"));
	assert.deepEqual(fact.tags, ["导出", "转义"]);
	assert.deepEqual(fact.paths, ["topic/export", "topic/dsh-kb"]);
	db.close();
});

test("renderHtml 转义 script 结束标签，且数据可被 JSON.parse 还原", () => {
	const { db } = seedDb();
	const html = renderHtml(snapshot(db, 100), { dbPath: "X:/kb.db" });
	// 原始正文里含 `</script>`，产物里不得出现（除真实的数据块结束）+ 一份内联脚本的结束标签。
	assert.equal(html.split("</script>").length, 3, "script 结束标签数量不对（数据块 + 内联脚本各一个）");
	assert.ok(html.includes("\\u003c/script"), "没有把 < 转义成 \\u003c");
	const data = embedded(html);
	assert.equal(data.facts.length, 2);
	const fact = data.facts.find((f) => f.title.includes("script"));
	assert.match(fact.body, /<\/script>/);
	assert.ok(html.includes("记忆库快照"));
	db.close();
});

test("exportStatic 落盘并回填计数", () => {
	const { db } = seedDb();
	const out = path.join(dir, "preview.html");
	const result = exportStatic(db, { out });
	assert.equal(result.file, out);
	assert.ok(result.bytes > 2000);
	assert.equal(result.facts, 2);
	assert.ok(result.nodes >= 2);
	assert.equal(existsSync(out), true);
	const html = readFileSync(out, "utf8");
	assert.ok(html.startsWith("<!doctype html>"));
	const data = embedded(html);
	assert.equal(data.facts.length, 2);
	db.close();
});

test("空库也能导出，不抛", () => {
	const { db } = openDb(path.join(dir, "empty.db"));
	const html = renderHtml(snapshot(db, 10), {});
	const data = embedded(html);
	assert.equal(data.facts.length, 0);
	assert.equal(data.edges.length, 0);
	assert.ok(html.includes("树是空的"));
	db.close();
});

test("默认导出路径落在 $DSH_HOME/kb/preview.html", () => {
	const saved = process.env.DSH_HOME;
	process.env.DSH_HOME = path.join(dir, "home");
	try {
		assert.equal(defaultExportPath(), path.join(dir, "home", "kb", "preview.html"));
		const { db } = seedDb();
		const result = exportStatic(db, {});
		assert.equal(result.file, path.join(dir, "home", "kb", "preview.html"));
		assert.equal(existsSync(result.file), true);
		db.close();
	} finally {
		if (saved === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved;
	}
});
