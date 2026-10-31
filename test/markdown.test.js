/**
 * Markdown 镜像层的测试：投影、幂等、改名、回收、反灌。
 *
 * 这一层的风险不是"能不能写出去"，而是四种静默失真：
 *   1. 标题一改就留一堆旧文件（git 里全是增删）
 *   2. 内容没变也重写（时间戳噪声淹没真 diff）
 *   3. 手改的文件被旧镜像回灌覆盖（数据丢）
 *   4. frontmatter 里带引号/逗号/中文就解析错位
 * 下面每条都对上一个。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	existsSync,
	writeFileSync,
	utimesSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDb, upsertFact, updateFact } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import {
	importFromDir,
	mirrorToDir,
	parseFrontmatter,
	relPathFor,
	renderFactFile,
	renderFrontmatter,
	shortId,
	slugify,
	MIRROR_FORMAT,
} from "../lib/markdown.js";

/**
 * 造一个装了卡的临时库；测试结束关库、删目录。
 * Windows 上库句柄没关就 rmSync 会 EPERM，所以 close 必须在这里。
 */
function makeDb(t) {
	const tmp = mkdtempSync(path.join(tmpdir(), "dsh-kb-md-"));
	const { db } = openDb(path.join(tmp, "kb.db"));
	t.after(() => {
		try {
			db.close();
		} catch {
			// 已经关了
		}
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// 临时目录留着不影响正确性
		}
	});
	return { db, tmp, dir: path.join(tmp, "mirror") };
}

/** 标题换 id（upsertFact 返回的是字符串，不返 id）。 */
function idOf(db, title) {
	const row = db.prepare("SELECT id FROM fact WHERE title=?").get(title);
	return row?.id;
}

/** 一张卡在镜像里的绝对路径，按库里的真实 path 算。 */
function fileFor(db, dir, id) {
	const row = db.prepare("SELECT id,title,path FROM fact WHERE id=?").get(id);
	assert.ok(row, `库里应该有 ${id}`);
	return path.join(dir, relPathFor(row).split("/").join(path.sep));
}

/** 把文件 mtime 推到未来，模拟"人刚编辑过"。 */
function touchFuture(file) {
	const when = new Date(Date.now() + 5000);
	utimesSync(file, when, when);
}

test("slugify 保留中文、去掉文件系统非法字符、空标题有兜底", () => {
	assert.equal(slugify("使用 360 加固"), "使用-360-加固");
	assert.equal(slugify('a/b:c*d?e"f<g>h|i'), "a-b-c-d-e-f-g-h-i");
	assert.equal(slugify("   "), "untitled");
	assert.equal(slugify(undefined), "untitled");
	assert.ok(slugify("长".repeat(200)).length <= 40);
});

test("shortId 取 8 位，不合法 id 也能给出稳定值", () => {
	assert.equal(shortId("f_06f66b236d1d6b"), "06f66b23");
	assert.equal(shortId("abc"), "abc00000");
	assert.equal(shortId(""), "00000000");
});

test("slugify 去掉方括号等会被通配符当模式的字符", () => {
	assert.equal(slugify("[会话] 标题"), "会话-标题");
	assert.equal(slugify("(a) {b}"), "a-b");
});

test("relPathFor 用骨架路径做目录，空路径落 inbox", () => {
	assert.equal(relPathFor({ id: "f_abcdef123456", title: "标题", path: "topic/dsh" }), "topic/dsh/标题--abcdef12.md");
	assert.equal(relPathFor({ id: "f_abcdef123456", title: "标题", path: "" }), "inbox/标题--abcdef12.md");
	// 路径段里的非法字符被清掉，但不能把层级拆坏
	assert.equal(relPathFor({ id: "f_abcdef123456", title: "t", path: "topic/a:b" }), "topic/ab/t--abcdef12.md");
});

test("frontmatter 能原样往返：引号、逗号、中文、数组、数字", () => {
	const meta = {
		id: "f_1234567890ab",
		title: '带 "引号" 和, 逗号 的标题',
		tags: ["a, b", '有 "引号"'],
		confidence: 0.35,
		version: 3,
		active: true,
	};
	const text = `${renderFrontmatter(meta)}正文第一行\n\n---\n正文里的分隔线不该被当 frontmatter\n`;
	const { meta: back, body, hasFrontmatter } = parseFrontmatter(text);
	assert.equal(hasFrontmatter, true);
	assert.equal(back.id, meta.id);
	assert.equal(back.title, meta.title);
	assert.deepEqual(back.tags, meta.tags);
	assert.equal(back.confidence, 0.35);
	assert.equal(back.version, 3);
	assert.equal(back.active, true);
	assert.ok(body.includes("正文里的分隔线"));
});

test("没有 frontmatter 的文件原样返回，不会被误判", () => {
	const raw = "# 只是普通 markdown\n\n内容\n";
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.hasFrontmatter, false);
	assert.equal(parsed.body, raw);
	assert.deepEqual(parsed.meta, {});
});

test("renderFactFile 带 id / updated / 格式版本", () => {
	const file = renderFactFile({
		id: "f_abcdef123456",
		title: "t",
		kind: "fix",
		status: "active",
		path: "topic/dsh",
		paths: '["topic/dsh"]',
		tags: '["a"]',
		confidence: 0.6,
		version: 2,
		ts: 1000,
		updated_at: 2000,
		body: "现象 / 根因 / 做法",
		session_id: "session-x",
	});
	assert.ok(file.startsWith("---\n"));
	assert.ok(file.includes('id: "f_abcdef123456"'));
	assert.ok(file.includes("updated: 2000"));
	assert.ok(file.includes(`mirror: ${MIRROR_FORMAT}`));
	assert.ok(file.includes('session: "session-x"'));
	assert.ok(file.trimEnd().endsWith("现象 / 根因 / 做法"));
});

test("导出：文件落地 + README，二次导出全部 unchanged", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "第一条", body: "正文一", path: "topic/dsh", tags: ["x"], kind: "fact" }, seg);
	upsertFact(db, { title: "第二条", body: "正文二", path: "project/code", kind: "fix" }, seg);

	const first = mirrorToDir(db, dir);
	assert.equal(first.total, 2);
	assert.equal(first.written, 2);
	assert.equal(first.trashed, 0);
	assert.ok(existsSync(path.join(dir, "README.md")));
	assert.ok(existsSync(fileFor(db, dir, idOf(db, "第一条"))));

	const second = mirrorToDir(db, dir);
	assert.equal(second.written, 0, "内容没变就不该写盘");
	assert.equal(second.unchanged, 2);
	assert.equal(second.moved, 0);
});

test("改标题只改名，不留旧文件", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "旧标题", body: "正文", path: "topic/dsh", kind: "fact" }, seg);
	const id = idOf(db, "旧标题");
	mirrorToDir(db, dir);
	const oldFile = fileFor(db, dir, id);
	assert.ok(existsSync(oldFile));

	updateFact(db, id, { title: "新标题" }, seg);
	const stats = mirrorToDir(db, dir);
	const newFile = fileFor(db, dir, id);
	assert.ok(existsSync(newFile), "新文件名应该存在");
	assert.equal(existsSync(oldFile), false, "旧文件名必须消失");
	assert.equal(stats.moved, 1);
	assert.equal(stats.trashed, 0);
});

test("库里没了的 id：文件进 .trash，不直接删", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "将被删", body: "正文", path: "inbox", kind: "fact" }, seg);
	const id = idOf(db, "将被删");
	mirrorToDir(db, dir);
	db.prepare("DELETE FROM fact WHERE id=?").run(id);
	const stats = mirrorToDir(db, dir);
	assert.equal(stats.trashed, 1);
	const trashDir = path.join(dir, ".trash");
	assert.ok(existsSync(trashDir));
	const trashed = readdirSync(trashDir);
	assert.equal(trashed.length, 1);
	assert.ok(trashed[0].includes("将被删"), "文件名保留原样，便于捞回来");
});

test("dry-run 不写盘", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "干跑", body: "正文", path: "topic/dsh", kind: "fact" }, seg);
	const stats = mirrorToDir(db, dir, { dryRun: true });
	assert.equal(stats.dryRun, true);
	assert.equal(stats.written, 1);
	assert.equal(existsSync(dir), false, "dry-run 不该建目录");
});

test("反灌：文件比库里新才覆盖，否则算 stale", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "反灌", body: "库里正文", path: "topic/dsh", kind: "fact" }, seg);
	const id = idOf(db, "反灌");
	mirrorToDir(db, dir);
	const file = fileFor(db, dir, id);

	// 刚导出的镜像导回：内容一致 -> unchanged，不该被 mtime 骗成"文件更新"
	const idle = importFromDir(db, dir);
	assert.equal(idle.updated, 0);
	assert.equal(idle.unchanged, 1);

	// 库里改过而文件没动 -> stale（文件旧了，不回灌）
	// 这里必须显式把文件时间推旧：刚写完的文件 mtime 与 updated_at 可能同毫秒，
	// 靠"谁晚"判定会在毫秒边界上抖成 updated=1（实测偶发）。
	const past = new Date(Date.now() - 60000);
	utimesSync(path.join(dir, relPathFor({ id, title: "反灌", path: "topic/dsh" }).split("/").join(path.sep)), past, past);
	updateFact(db, id, { body: "库里改成了新版本" }, seg);
	const stale = importFromDir(db, dir);
	assert.equal(stale.updated, 0);
	assert.ok(stale.stale >= 1, "文件比库里旧，不能覆盖库");

	// 手改正文并把 mtime 推到未来 -> 覆盖
	writeFileSync(file, readFileSync(file, "utf8").replace("库里正文", "人手改过"), "utf8");
	touchFuture(file);
	const applied = importFromDir(db, dir);
	assert.equal(applied.updated, 1);
	const row = db.prepare("SELECT body FROM fact WHERE id=?").get(id);
	assert.equal(row.body, "人手改过");
});

test("反灌：库里没有的 id 会被新建，README 与无 id 文件跳过", (t) => {
	const { db, dir } = makeDb(t);
	mirrorToDir(db, dir);
	const inbox = path.join(dir, "inbox");
	mkdirSync(inbox, { recursive: true });
	const hand = path.join(inbox, "手写一条.md");
	writeFileSync(
		hand,
		'---\nid: "f_999988887777"\ntitle: "手写一条"\nkind: "concept"\npath: "inbox"\ntags: ["手写"]\n---\n从编辑器里写的正文\n',
		"utf8",
	);
	writeFileSync(path.join(inbox, "没有 id.md"), "# 无 frontmatter\n", "utf8");
	const stats = importFromDir(db, dir);
	assert.equal(stats.created, 1);
	assert.equal(stats.failed.length, 0);
	const row = db.prepare("SELECT title,body,kind,source_kind FROM fact WHERE id=?").get("f_999988887777");
	assert.ok(row, "手写的卡应该进库");
	assert.equal(row.title, "手写一条");
	assert.equal(row.kind, "concept");
	assert.equal(row.source_kind, "markdown");
});

test("反灌 --force 会把旧镜像也灌回去", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "强制", body: "第一版", path: "inbox", kind: "fact" }, seg);
	const id = idOf(db, "强制");
	mirrorToDir(db, dir);
	const file = fileFor(db, dir, id);
	updateFact(db, id, { body: "库里改成第二版" }, seg);
	const forced = importFromDir(db, dir, { force: true });
	assert.ok(forced.updated >= 1);
	const row = db.prepare("SELECT body FROM fact WHERE id=?").get(id);
	assert.equal(row.body, "第一版", "--force 就该让文件赢");
	assert.ok(existsSync(file));
});

test("目录不存在时导入直接报错，不静默返回 0", (t) => {
	const { db, tmp } = makeDb(t);
	assert.throws(() => importFromDir(db, path.join(tmp, "nope")), /目录不存在/);
});

test("CRLF 正文往返幂等：库里是 \\r\\n，读回不该判成被改过", (t) => {
	const { db, dir } = makeDb(t);
	upsertFact(db, { title: "CRLF 卡", body: "第一行\r\n第二行\r\n", path: "inbox", kind: "fact" }, seg);
	mirrorToDir(db, dir);
	const stats = importFromDir(db, dir);
	assert.equal(stats.updated, 0, "换行差异不构成改动");
	assert.equal(stats.stale, 0);
	assert.equal(stats.unchanged, 1);
	// 库里原字节不动
	const row = db.prepare("SELECT body FROM fact WHERE title=?").get("CRLF 卡");
	assert.ok(row.body.includes("\r\n"));
});
