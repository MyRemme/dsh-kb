/**
 * 中枢聚合层与中枢星图的测试。
 *
 * 这里钉的是四件事：
 *   1. 六块都出得来，且数字与库里的一致（不是"有字段就行"）；
 *   2. 外部数据源缺失时**降级而不是抛错**（会话目录没有、front.log 没有、工具清单没有）；
 *   3. 自检结论的分级正确 —— bad 与 warn 混用等于没有告警；
 *   4. 中枢星图是确定性纯函数，且坐标全部落在画布内。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { openDb, upsertFact, addEdge } from "../lib/store.js";
import { seg } from "../lib/segment.js";
import { buildHub } from "../lib/hub.js";

const now = Date.UTC(2026, 10, 1, 12, 0, 0);

/** 造一个带三张卡、一条边、一个 ingest_log 的临时库。 */
function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-hub-"));
	const { db, file } = openDb(path.join(dir, "kb.db"));
	upsertFact(db, { title: "事实一", body: "正文一", kind: "fact", path: "topic/dsh", ts: now - 3000 }, seg);
	upsertFact(db, { title: "修复一", body: "正文二", kind: "fix", path: "topic/dsh", ts: now - 2000 }, seg);
	upsertFact(db, { title: "[会话] 一次会话", body: "用户原话：帮我看看", kind: "episode", path: "talk/x", ts: now - 1000 }, seg);
	const ids = db.prepare("SELECT id, kind FROM fact").all();
	addEdge(db, ids[0].id, ids[1].id, "related", 1, "同主题");
	db.prepare("INSERT INTO ingest_log(session_key,file,size,mtime,added,skipped,err,ts) VALUES (?,?,?,?,?,?,?,?)").run(
		"s/a",
		"/tmp/a",
		100,
		1,
		2,
		0,
		"",
		now - 5 * 60000,
	);
	return { dir, db, file };
}

test("中枢：六块都有数据，数字与库一致", () => {
	const { dir, db, file } = fixture();
	const hub = buildHub({
		db,
		file,
		mirrorDir: path.join(dir, "mirror"),
		sessionsDir: path.join(dir, "sessions"),
		frontLog: path.join(dir, "front.log"),
		tools: () => [
			{ name: "kb_search", description: "检索长期记忆" },
			{ name: "kb_add", description: "写一张卡" },
			{ name: "run_code", description: "PTC 传输层" },
		],
		version: "0.9.0",
		dshVersion: "0.2.1-rc.2",
		now,
	});

	assert.equal(hub.memory.facts, 3);
	assert.equal(hub.memory.active, 3);
	assert.equal(hub.memory.edges, 1);
	assert.equal(hub.memory.kinds.length, 3);
	assert.ok(hub.memory.branches.length >= 1, "星图需要枝");
	assert.equal(hub.memory.branches[0].cards.length <= 6, true, "每枝最多 6 张卡");
	assert.equal(hub.sessions.total, 1, "会话数按 episode 卡算");
	assert.equal(hub.sessions.ingested, 1);
	assert.equal(hub.tools.count, 2, "run_code 是传输层，不算人点得动的工具");
	assert.equal(hub.tools.groups[0].prefix, "kb");
	assert.equal(hub.status.version, "0.9.0");
	assert.equal(hub.status.node, process.version);
	assert.equal(hub.status.ts, now);
	assert.ok(hub.memory.dbBytes > 0);
});

test("中枢：外部数据源缺失时降级，不抛错", () => {
	const { dir, db, file } = fixture();
	const hub = buildHub({
		db,
		file,
		mirrorDir: path.join(dir, "mirror"), // 不存在
		sessionsDir: path.join(dir, "no-sessions"), // 不存在
		frontLog: path.join(dir, "no-front.log"), // 不存在
		tools: () => {
			throw new Error("宿主没有 tools 服务");
		},
		version: "0.9.0",
		now,
	});
	assert.equal(hub.memory.mirror.files, 0);
	assert.equal(hub.sessions.disk.files, 0);
	assert.equal(hub.tools.count, 0, "工具清单抛错 → 空清单，而不是整页崩");
	assert.ok(Array.isArray(hub.status.checks) && hub.status.checks.length > 0);
	const mirror = hub.status.checks.find((c) => c.key === "mirror");
	assert.equal(mirror.level, "warn", "投影没导出应该是 warn，不是 ok");
});

test("中枢：front.log 只认结构化行，最后几条按时间顺序", () => {
	const { dir, db, file } = fixture();
	const log = path.join(dir, "front.log");
	writeFileSync(
		log,
		[
			"2026-11-01T10:00:00.000Z [api] GET /facts -> 500",
			"    at something (stack line)",
			"2026-11-01T10:01:00.000Z [render] Cannot read properties of null",
			"2026-11-01T10:02:00.000Z [warn] 只是个警告",
		].join("\n"),
		"utf8",
	);
	const hub = buildHub({ db, file, frontLog: log, version: "0.9.0", now });
	assert.equal(hub.status.frontLog.total, 3, "结构化行都算进来了");
	assert.equal(hub.status.frontLog.count, 2, "其中两级是错误（warn 不算）");
	assert.equal(hub.status.frontLog.items[0].level, "api");
	assert.equal(hub.status.frontLog.items[1].level, "render");
	const check = hub.status.checks.find((c) => c.key === "frontlog");
	assert.equal(check.value, "2");
	assert.equal(check.level, "warn", "有前端错误就该黄灯");
});

test("中枢：吸收隔得久 → 自检从 ok 变 warn 再变 bad", () => {
	const { dir, db, file } = fixture();
	const mk = (lagMs) =>
		buildHub({
			db,
			file,
			frontLog: path.join(dir, "front.log"),
			version: "0.9.0",
			now: now + lagMs,
		}).status.checks.find((c) => c.key === "ingest");

	assert.equal(mk(10 * 60000).level, "ok");
	assert.equal(mk(2 * 86400000).level, "warn");
	assert.equal(mk(10 * 86400000).level, "bad");
});

test("中枢：从来没用过检索的库，ingest 自检是 bad 而不是 ok", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-hub-"));
	const { db, file } = openDb(path.join(dir, "kb.db"));
	const hub = buildHub({ db, file, frontLog: path.join(dir, "front.log"), version: "0.9.0", now });
	const check = hub.status.checks.find((c) => c.key === "ingest");
	assert.equal(check.value, "从未吸收");
	assert.equal(check.level, "bad");
});

test("中枢星图：确定性、坐标不越界、每枝一张卡一条辐条", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (reg) => (registration = reg) } }, undefined);
	const client = registration.factory((spec) => {
		if (spec === "react") {
			return {
				createElement: () => null,
				useState: () => [],
				useEffect: () => {},
				useCallback: (f) => f,
				useMemo: (f) => f(),
				useRef: () => ({ current: null }),
			};
		}
		throw new Error(`客户端 bundle 请求了未声明的模块：${spec}`);
	});

	const hub = {
		memory: {
			branches: [
				{ path: "topic/dsh", n: 40, cards: [{ id: "f1", title: "一", kind: "fact" }, { id: "f2", title: "二", kind: "fix" }] },
				{ path: "project/code", n: 30, cards: [{ id: "f3", title: "三", kind: "concept" }] },
			],
		},
	};
	const a = client.__hubGalaxy(hub, 360, 220);
	const b = client.__hubGalaxy(hub, 360, 220);
	assert.deepEqual(a, b, "同一份数据必须画出同一张图");

	assert.equal(a.labels.length, 2);
	assert.equal(a.stars.length, 3);
	for (const star of a.stars) {
		assert.ok(star.x >= 0 && star.x <= a.w, `星体 x 越界：${star.x}`);
		assert.ok(star.y >= 0 && star.y <= a.h, `星体 y 越界：${star.y}`);
	}
	for (const label of a.labels) {
		assert.ok(label.x >= 0 && label.x <= a.w);
		assert.ok(label.y >= 0 && label.y <= a.h);
	}
	// 两枝之间：各有 1 条结构线（中心→枝）+ 每卡 1 条辐条
	assert.equal(a.edges.filter((e) => e.faint === false).length, 2);
	assert.equal(a.edges.filter((e) => e.faint === true).length, 3);
});

test("中枢星图：空库给空图，不炸也不画鬼", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	new Function("window", "document", source)({ __ModuleLoader__: { load: (reg) => (registration = reg) } }, undefined);
	const client = registration.factory(() => ({
		createElement: () => null,
		useState: () => [],
		useEffect: () => {},
		useCallback: (f) => f,
		useMemo: (f) => f(),
		useRef: () => ({ current: null }),
	}));
	const empty = client.__hubGalaxy({ memory: { branches: [] } }, 360, 220);
	assert.equal(empty.stars.length, 0);
	assert.equal(empty.labels.length, 0);
	assert.equal(empty.edges.length, 0);
	assert.equal(empty.w, 360);
	assert.equal(empty.h, 220);
	// 载荷残缺（hub 是 undefined）也不能抛：面板在首帧拿到的是 null。
	assert.doesNotThrow(() => client.__hubGalaxy(undefined, 360, 220));
});

test("中枢：超过 200 字符的前端错误不许被整行丢弃", () => {
	const { dir, db, file } = fixture();
	// 真机上带 componentStack 的 render 崩溃就是这个形状：一条 1000+ 字符的行。
	// 旧实现用 `(.{0,200})$` 匹配，超长行不是被截断而是整行匹配失败被丢掉 ——
	// 结果越严重的错误越进不了统计。
	const message = `Cannot read properties of null (reading 'tx') | {"componentStack":"${"at GraphPane ".repeat(32)}"}`;
	assert.ok(message.length > 400, "构造的行本身得远超 200 字符");
	const log = path.join(dir, "front.log");
	writeFileSync(log, `2026-11-01T10:00:00.000Z [render] ${message}\n`, "utf8");

	const hub = buildHub({ db, file, frontLog: log, version: "0.9.0", now });
	assert.equal(hub.status.frontLog.count, 1, "长行必须被算进错误");
	assert.equal(hub.status.frontLog.items.length, 1);
	assert.ok(hub.status.frontLog.items[0].message.startsWith("Cannot read properties of null"));
	assert.equal(hub.status.checks.find((c) => c.key === "frontlog").level, "warn");
});

test("中枢：宿主 ResizeObserver 噪声不算「前端错误」，也不亮灯", () => {
	const { dir, db, file } = fixture();
	const log = path.join(dir, "front.log");
	writeFileSync(
		log,
		[
			'2026-11-01T10:00:00.000Z [error] ResizeObserver loop completed with undelivered notifications. | {"where":"dsh-app://app/:0"}',
			"2026-11-01T10:01:00.000Z [api] GET /facts -> 500",
		].join("\n"),
		"utf8",
	);

	const hub = buildHub({ db, file, frontLog: log, version: "0.9.0", now });
	assert.equal(hub.status.frontLog.total, 2, "两行都是合法结构化行");
	assert.equal(hub.status.frontLog.noise, 1, "噪声要单独计数，不能悄悄消失");
	assert.equal(hub.status.frontLog.count, 1, "错误数只算真错误");
	assert.equal(hub.status.checks.find((c) => c.key === "frontlog").value, "1");

	// 整份日志只有噪声时，前端错误是 0 —— 这一项必须能回绿。
	writeFileSync(
		log,
		'2026-11-01T10:00:00.000Z [error] ResizeObserver loop completed with undelivered notifications.\n',
		"utf8",
	);
	const clean = buildHub({ db, file, frontLog: log, version: "0.9.0", now });
	assert.equal(clean.status.frontLog.count, 0);
	assert.equal(clean.status.checks.find((c) => c.key === "frontlog").level, "ok");
});

test("中枢：枝同时给「在用」与「总量」，降级不被藏起来", () => {
	const { dir, db, file } = fixture();
	// fixture 是 2 张 topic/dsh 知识卡 + 1 张 talk/x 会话卡，把其中一张知识卡降级。
	db.prepare("UPDATE fact SET status='doubtful' WHERE kind='fix'").run();

	const hub = buildHub({ db, file, version: "0.9.0", now });
	const branch = hub.memory.branches.find((b) => b.path === "topic/dsh");
	assert.ok(branch, "topic/dsh 应该在枝里");
	assert.equal(branch.n, 1, "在用只算 active");
	assert.equal(branch.total, 2, "总量含已降级 —— 两个数都要给");

	const row = hub.memory.paths.find((p) => p.path === "topic/dsh");
	assert.equal(row.n, 1);
	assert.equal(row.total, 2, "枝体积列表与星图用的是同一份数字");
});

test("中枢：流水账成批降级不算「知识卡降级」，红灯不许常亮", () => {
	const { dir, db, file } = fixture();
	db.prepare("UPDATE fact SET status='doubtful' WHERE kind='episode'").run();

	const hub = buildHub({ db, file, version: "0.9.0", now });
	assert.equal(hub.memory.stale, 1, "全体非 active 仍是 1");
	assert.equal(hub.memory.knowledge, 2, "知识卡是 fact + fix 两张");
	assert.equal(hub.memory.knowledgeStale, 0, "知识卡一张都没降级");
	assert.equal(hub.status.checks.find((c) => c.key === "stale").level, "ok");
});

test("中枢：查询失败时「库文件」是 bad，不是「0 张卡的空库」", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-kb-hub-broken-"));
	const file = path.join(dir, "kb.db");
	const broken = new DatabaseSync(file);
	broken.exec("CREATE TABLE unrelated(x INTEGER)");

	const hub = buildHub({ db: broken, file, frontLog: path.join(dir, "front.log"), version: "0.9.0", now });
	assert.equal(hub.memory.facts, 0);
	assert.equal(typeof hub.memory.error, "string", "块失败必须留痕，否则自检只能看到空库");
	const dbCheck = hub.status.checks.find((c) => c.key === "db");
	assert.equal(dbCheck.level, "bad", "文件存在但查不出东西，不能报 ok");
	assert.equal(dbCheck.value, "查询失败");
	broken.close();
});

test("中枢：最近会话只列在用的会话卡，降级的不给假入口", () => {
	const { dir, db, file } = fixture();
	db.prepare("UPDATE fact SET status='doubtful' WHERE kind='episode'").run();

	const hub = buildHub({ db, file, version: "0.9.0", now });
	assert.equal(hub.sessions.total, 1);
	assert.equal(hub.sessions.active, 0);
	assert.equal(hub.sessions.recent.length, 0, "点开就是 superseded 的会话不该出现在「最近」");
});

test("中枢：会话清单走缓存，第二次不再重扫目录", () => {
	const { dir, db, file } = fixture();
	const sessionsDir = path.join(dir, "sessions");
	mkdirSync(path.join(sessionsDir, "tag", "s1"), { recursive: true });
	writeFileSync(path.join(sessionsDir, "tag", "s1", "session.v1.jsonl.zstd"), "x", "utf8");

	const input = { db, file, sessionsDir, frontLog: path.join(dir, "front.log"), version: "0.9.0", now };
	const first = buildHub(input);
	assert.equal(first.sessions.disk.files, 1);

	// 缓存命中时读到的是上一次的清单 —— 这正是"不重扫"的定义。
	writeFileSync(path.join(sessionsDir, "tag", "s1", "session.v2.jsonl.zstd"), "yy", "utf8");
	const cached = buildHub(input);
	assert.equal(cached.sessions.disk.files, 1, "30 秒内不重扫");
	assert.equal(cached.sessions.disk.bytes, 1, "缓存里还是只有 1 字节的 v1");
	// 显式绕过缓存时能看到新文件（同一目录取版本号最大的那个 → v2 / 2 字节）。
	const fresh = buildHub({ ...input, noCache: true });
	assert.equal(fresh.sessions.disk.files, 1);
	assert.equal(fresh.sessions.disk.bytes, 2, "绕过缓存才读到 v2");
});
