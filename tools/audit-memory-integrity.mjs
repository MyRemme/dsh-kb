/**
 * 2026-11-04 审查探针：直接调用正式实现，只用内存库和独立临时目录。
 * reproduced 表示观察到了缺陷，不表示正确性测试通过；修复后应变为 false。
 * 不加载已安装插件，不连接真实模型，不读取用户会话，不写真实记忆库。
 * 用法：node tools/audit-memory-integrity.mjs [新的报告目录]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { addEdge, extractMentions, factHash, openDb, updateFact, upsertFact } from '../lib/store.js';
import { seg } from '../lib/segment.js';
import { search } from '../lib/search.js';
import { collectMaterial, distillWithModel, saveDistilled } from '../lib/distill.js';
import { importFromDir, mirrorToDir, planMirror } from '../lib/markdown.js';
import { ingest } from '../lib/ingest.js';
import { digest, treeRows } from '../lib/digest.js';
import { reap, retentionOf } from '../lib/reap.js';
import { usageOf } from '../lib/usage.js';
import { queryInt, matchRoute } from '../lib/http.js';
import { createApi } from '../lib/routes.js';
import { probeModels, resolveModel } from '../lib/model.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sandbox = mkdtempSync(path.join(tmpdir(), 'dsh-kb-audit-'));
// 即使既有测试走缺省配置，日志和懒加载库也只能落到本次沙箱。
process.env.DSH_HOME = path.join(sandbox, 'home');
process.env.DSH_KB_HOME = path.join(sandbox, 'home', 'kb');
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(sandbox, 'report');
assert.ok(!existsSync(output), `报告目录必须是新目录，避免覆盖证据：${output}`);
mkdirSync(output, { recursive: true });
const DAY = 86400000;
const results = [];

function sourceHashes() {
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(path.join(repo, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else files.push(next);
    }
  }
  for (const dir of ['lib', 'bin', 'test']) walk(dir);
  files.push('package.json');
  return Object.fromEntries(files.sort().map(file => [file.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex')]));
}
const hashesBefore = sourceHashes();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const baseline = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/**/*.test.js'], {
  cwd: repo, encoding: 'utf8', env: process.env, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
});
writeFileSync(path.join(output, 'baseline.tap'), (baseline.stdout ?? '') + (baseline.stderr ?? ''));
const baselineCounts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(baseline.stdout ?? '')?.[1] ?? NaN)]));

async function probe(id, priority, title, fn, classification = 'defect') {
  const { db } = openDb(':memory:');
  try {
    const { reproduced, ...observed } = await fn(db);
    assert.equal(typeof reproduced, 'boolean');
    results.push({ id, priority, classification, title, reproduced, observed });
  } catch (error) {
    results.push({ id, priority, classification, title, probeError: String(error.stack ?? error) });
  } finally { db.close(); }
}

// 查数据库中实际保存的 id；探针自身不重复生产实现中的重算 id 错误。
function add(db, fields) {
  assert.equal(upsertFact(db, fields, seg), 'added');
  return db.prepare('SELECT * FROM fact WHERE title=?').get(fields.title);
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function apiFor(db) {
  return createApi({ getDb: () => db, dbPath: path.join(process.env.DSH_KB_HOME, 'fixture.db') });
}
async function request(api, url, method = 'GET', body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: 'localhost' } });
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body += String(s ?? ''); } };
  const route = matchRoute(api.routes, new URL(url, 'http://localhost').pathname);
  assert.ok(route);
  await route.handler(req, res);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body).data;
}

await probe('A01', 'P1', '同标题跨项目覆盖，来源与版本失真', db => {
  const first = add(db, { title: '部署方式', body: '项目 A 使用服务 A。', path: 'project/alpha', source_ref: 'source-a', session_id: 'session-a' });
  const bodyB = '项目 B 使用服务 B。' + '仅适用于项目 B 的部署约束。'.repeat(12);
  const result = upsertFact(db, { title: first.title, body: bodyB, path: 'project/beta', source_ref: 'source-b', session_id: 'session-b' }, seg);
  const row = db.prepare('SELECT * FROM fact WHERE id=?').get(first.id);
  const observed = { result, count: db.prepare('SELECT COUNT(*) AS n FROM fact').get().n, bodyIsB: row.body === bodyB, path: row.path, source: row.source_ref, version: row.version, history: db.prepare('SELECT COUNT(*) AS n FROM fact_history').get().n, hashMatchesBody: row.hash === factHash(row.title, row.body), ftsPath: db.prepare('SELECT path FROM fact_fts').get().path };
  return { reproduced: observed.count === 1 && observed.bodyIsB && observed.source === 'source-a' && observed.history === 0, ...observed };
});

await probe('A02', 'P1', '语义修改被模糊哈希判为 unchanged', db => {
  const cases = [
    ['operator', 'if (count > 0) allow();', 'if (count < 0) allow();'],
    ['case', 'Use API_KEY for lookup.', 'Use api_key for lookup.'],
    ['tail', 'x'.repeat(2100) + '禁止生产操作', 'x'.repeat(2100) + '允许生产操作'],
  ].map(([title, before, after]) => {
    const row = add(db, { title, body: before });
    const result = updateFact(db, row.id, { body: after }, seg);
    return { variant: title, result: result.result, oldBodyRetained: db.prepare('SELECT body FROM fact WHERE id=?').get(row.id).body === before };
  });
  return { reproduced: cases.every(c => c.result === 'unchanged' && c.oldBodyRetained), cases };
});

await probe('A03', 'P1', '镜像写入逃出指定目录', db => {
  add(db, { title: 'escape proof', body: 'Sandbox-only diagnostic.', path: '../../escaped' });
  const root = path.join(sandbox, 'mirror-case', 'allowed', 'mirror');
  const plan = planMirror(db, root);
  // 有意逃出 mirror，但绝不允许探针越出本次独立 sandbox。
  for (const write of plan.writes) assert.ok(inside(sandbox, write.abs), write.abs);
  const stats = mirrorToDir(db, root, { readme: false });
  const target = plan.writes[0].abs;
  return { reproduced: existsSync(target) && !inside(root, target), written: stats.written, relativeToMirror: path.relative(root, target), insideSandbox: inside(sandbox, target) };
});

await probe('A04', 'P1', '图扩展绕过筛选并混入矛盾关系', db => {
  const now = Date.now();
  const seed = add(db, { title: 'scopeprobe seed', body: 'scopeprobe D:/alpha/module.js', path: 'project/alpha', kind: 'fix', ts: now, session_id: 'sess-alpha' });
  const other = add(db, { title: 'foreign material', body: 'Unrelated historical episode.', path: 'project/beta', kind: 'episode', ts: now - 300 * DAY, session_id: 'sess-beta' });
  addEdge(db, seed.id, other.id, 'contradicts');
  const options = { path: 'project/alpha', kinds: ['fix'], since: now - DAY, session: 'sess-alpha', entity: 'd:/alpha/module.js' };
  assert.equal(search(db, 'scopeprobe', { ...options, expand: false }).length, 1);
  const rows = search(db, 'scopeprobe', options);
  db.prepare("UPDATE fact SET status='doubtful' WHERE id=?").run(seed.id);
  const statuses = search(db, 'scopeprobe', { status: 'doubtful' }).map(r => r.status);
  return { reproduced: rows.some(r => r.id === other.id && r.why === 'graph') && statuses.includes('active'), combinedFilters: options, result: rows.map(r => ({ kind: r.kind, path: r.path, why: r.why })), doubtfulQueryStatuses: statuses };
});

await probe('A05', 'P1', '单条结论消耗整批来源，遗漏原料不再入队', async db => {
  const a = add(db, { title: 'source alpha', body: 'Alpha: repair A with option A.', kind: 'episode' });
  const b = add(db, { title: 'source beta', body: 'Beta: repair B with option B.', kind: 'episode' });
  const model = { provider: 'fake', model: 'fake', complete: async () => JSON.stringify([{ title: 'Alpha repair', body: a.body, kind: 'fix' }]) };
  const saved = await distillWithModel(db, model);
  const edges = db.prepare("SELECT dst FROM edge WHERE rel='derived_from'").all();
  const pending = collectMaterial(db).map(r => r.id);
  return { reproduced: edges.some(e => e.dst === b.id) && !pending.includes(b.id), material: saved.material, cards: saved.cards, sourceEdges: edges.length, omittedSourceMarkedSpent: edges.some(e => e.dst === b.id), pending: pending.length };
});

await probe('A06', 'P1', '提炼同标题去重后返回不存在的 id 和悬空边', db => {
  const source = add(db, { title: 'source episode', body: 'Input source.', kind: 'episode' });
  const existing = add(db, { title: 'same title', body: 'Original conclusion.', kind: 'fix' });
  const saved = saveDistilled(db, [{ title: existing.title, body: 'Different conclusion.', kind: 'fix' }], { sourceIds: [source.id] });
  const returnedIdExists = !!db.prepare('SELECT 1 FROM fact WHERE id=?').get(saved.ids[0]);
  const danglingEdges = db.prepare('SELECT COUNT(*) AS n FROM edge e LEFT JOIN fact f ON f.id=e.src WHERE f.id IS NULL').get().n;
  return { reproduced: !returnedIdExists && danglingEdges > 0, result: saved, returnedIdExists, danglingEdges, sourceStillPending: collectMaterial(db).some(r => r.id === source.id) };
});

await probe('A07', 'P1', '吸收端点把 purgeThreshold=0 还原默认值并淘汰老卡', async db => {
  const row = add(db, { title: 'year old episode', body: 'Old source.', kind: 'episode', ts: Date.now() - 365 * DAY });
  const data = await request(apiFor(db), '/api/dsh-kb/ingest', 'POST', {});
  const status = db.prepare('SELECT status FROM fact WHERE id=?').get(row.id).status;
  return { reproduced: data.reaped.superseded === 1 && status === 'superseded', reaped: data.reaped, status };
});

await probe('A08', 'P2', '旧镜像的新 mtime 覆盖数据库新版本', db => {
  const row = add(db, { title: 'mirror conflict', body: 'Revision one.' });
  const root = path.join(sandbox, 'stale-mirror');
  const file = planMirror(db, root).writes[0].abs;
  mirrorToDir(db, root, { readme: false });
  assert.equal(updateFact(db, row.id, { body: 'Revision two with a new conclusion.' }, seg).result, 'updated');
  const later = new Date(Date.now() + DAY);
  utimesSync(file, later, later);
  const imported = importFromDir(db, root);
  const restoredOldBody = db.prepare('SELECT body FROM fact WHERE id=?').get(row.id).body === row.body;
  return { reproduced: imported.updated === 1 && restoredOldBody, updated: imported.updated, stale: imported.stale, failed: imported.failed, restoredOldBody };
});

await probe('A09', 'P2', '截断会话被记成功，后续增量扫描跳过', db => {
  const root = path.join(sandbox, 'partial-sessions');
  const dir = path.join(root, 'project', 'session-partial');
  mkdirSync(dir, { recursive: true });
  // 可复现的高熵填充让压缩文件超过正式摄入器的 400 字节过滤线。
  const payload = Array.from({ length: 100 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join(' ');
  const events = [
    { type: 'session', id: 'session-partial', createdAt: Date.now(), cwd: 'D:/fixture' },
    { type: 'session/title', data: { title: 'Partial source' } },
    { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '## Errors and Fixes\n' + payload }] } },
  ];
  const valid = zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'));
  const truncated = zstdCompressSync(Buffer.from('{"type":"user/message","data":{}}\n')).subarray(0, 9);
  const bytes = Buffer.concat([valid, truncated]);
  assert.ok(bytes.length > 400);
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), bytes);
  const first = ingest(db, { sessionsDir: root });
  const log = db.prepare('SELECT err, added FROM ingest_log').get();
  const second = ingest(db, { sessionsDir: root });
  return { reproduced: first.files === 1 && first.err === 0 && log?.err === '' && second.files === 0, first, log, second };
});

await probe('A10', 'P2', '提炼出的 fact 重新入队，重复调用模型', async db => {
  add(db, { title: 'raw episode', body: 'Concrete input for a conclusion.', kind: 'episode' });
  let calls = 0;
  const model = { provider: 'fake', model: 'fake', complete: async () => { calls++; return JSON.stringify([{ title: 'result fact', body: 'Concrete reusable conclusion.', kind: 'fact' }]); } };
  await distillWithModel(db, model);
  const pending = collectMaterial(db).map(r => r.title);
  await distillWithModel(db, model);
  await distillWithModel(db, model);
  return { reproduced: calls === 3 && pending.includes('result fact'), calls, pendingAfterFirst: pending, pendingAfterThird: collectMaterial(db).map(r => r.title) };
});

await probe('A11', 'P2', 'HTTP 整数缺省参数缩为 1', async db => {
  for (let i = 0; i < 8; i++) add(db, { title: `defaultsprobe ${i}`, body: `Entry ${i}` });
  const api = apiFor(db);
  const facts = await request(api, '/api/dsh-kb/facts');
  const hits = await request(api, '/api/dsh-kb/search?q=defaultsprobe&graph=0');
  const graph = await request(api, '/api/dsh-kb/graph');
  const actualDefaults = [40, 6, 120].map(value => queryInt(new URLSearchParams(), 'limit', value, 1, 500));
  return { reproduced: actualDefaults.every(v => v === 1), expectedDefaults: [40, 6, 120], actualDefaults, facts, searchCount: hits.length, graphCount: graph.nodes.length };
});

await probe('A12', 'P2', '新颖度秒毫秒混算，相同相关度新旧卡同分', db => {
  add(db, { title: 'age old', body: 'timeprobe', ts: Date.now() - 720 * DAY });
  add(db, { title: 'age fresh', body: 'timeprobe', ts: Date.now() });
  const rows = search(db, 'timeprobe', { expand: false });
  assert.equal(rows.length, 2);
  return { reproduced: rows[0].score === rows[1].score, scores: rows.map(r => ({ title: r.title, score: r.score })) };
});

await probe('A13', 'P2', '异步模型列表可探测，但自动选择失效', async () => {
  const llm = { listProviders: async () => [{ id: 'provider' }], listModels: async () => [{ id: 'model' }], async *stream() { yield { type: 'text-delta', text: '[]' }; } };
  const listed = await probeModels(llm);
  const selected = await resolveModel({ llm });
  return { reproduced: listed.providers.length === 1 && selected === undefined, providers: listed.providers, selection: selected === undefined ? null : { provider: selected.provider, model: selected.model } };
});

await probe('A14', 'P2', '空枝重算仍保留失效卡摘要', db => {
  const row = add(db, { title: 'obsolete tree fact', body: 'Old conclusion.', path: 'topic/stale-summary' });
  digest(db);
  db.prepare("UPDATE fact SET status='superseded' WHERE id=?").run(row.id);
  digest(db);
  const branch = treeRows(db, 'topic/stale-summary')[0];
  return { reproduced: branch.count === 0 && branch.summary.includes(row.title), branch };
});

await probe('A15', 'P2', '相对文件路径提及丢失目录前缀', db => {
  add(db, { title: 'relative path', body: 'Fix lib/alpha.js before release.' });
  const mentions = extractMentions('', 'Fix lib/alpha.js before release.');
  const hits = search(db, '', { entity: 'lib/alpha.js', expand: false });
  return { reproduced: mentions.some(m => m.token === '/alpha.js') && hits.length === 0, mentions, searchCount: hits.length };
});

await probe('A16', 'P2', '树路径按子串匹配，兄弟项目混入', db => {
  for (const [index, p] of ['project/foo', 'project/foobar', 'topic/xproject/foosuffix'].entries()) add(db, { title: `pathprobe ${index}`, body: 'pathprobe', path: p });
  const paths = search(db, 'pathprobe', { path: 'project/foo', expand: false }).map(r => r.path);
  return { reproduced: paths.length === 3, expectedPaths: ['project/foo'], paths };
});

await probe('A17', 'P2', '遗忘把 updated_at 改成 ISO 文本，旧镜像可恢复失效卡', db => {
  const row = add(db, { title: 'timestamp mirror', body: 'Old episode.', kind: 'episode', ts: Date.now() - 365 * DAY });
  const root = path.join(sandbox, 'timestamp-mirror');
  const file = planMirror(db, root).writes[0].abs;
  mirrorToDir(db, root, { readme: false });
  const earlier = new Date(Date.now() - DAY);
  utimesSync(file, earlier, earlier);
  reap(db, { dryRun: false });
  const afterReap = db.prepare('SELECT status, updated_at, typeof(updated_at) AS storageType FROM fact WHERE id=?').get(row.id);
  const imported = importFromDir(db, root);
  const afterImport = db.prepare('SELECT status FROM fact WHERE id=?').get(row.id).status;
  return { reproduced: afterReap.storageType === 'text' && afterReap.status === 'superseded' && afterImport === 'active', afterReap, imported: { updated: imported.updated, stale: imported.stale }, afterImport };
});

registerHooks({ resolve(specifier, context, next) {
  const name = specifier === '@deepseek-ai/schemastery' ? 'schemastery-stub' : specifier === '@deepseek-ai/dsh-tools' ? 'dsh-tools-stub' : null;
  return name ? { url: new URL(`../test/fixtures/${name}.mjs`, import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { apply } = await import('../lib/index.js');

await probe('A18', 'P2', '打开被计为采纳，曝光冲淡明确否决', async () => {
  const tools = [], sections = [], disposers = [];
  const ctx = { tools: { register: value => tools.push(value) }, systemPrompt: { section: value => sections.push(value) }, effect: fn => disposers.push(fn()) };
  const file = path.join(sandbox, 'plugin', 'kb.db');
  apply(ctx, { dbPath: file, ui: false });
  try {
    await tools.find(t => t.name === 'kb_add').execute({ title: 'Project A note\nAUDIT_TITLE_SENTINEL', body: 'Isolated source evidence.', path: 'project/alpha' }, { agent: { sessionId: 'a', session: { meta: { cwd: 'D:/alpha' } } } });
    const ro = new DatabaseSync(file, { readOnly: true });
    try {
      const id = ro.prepare('SELECT id FROM fact').get().id;
      for (let i = 0; i < 3; i++) await tools.find(t => t.name === 'kb_get').execute({ id });
      const counts = ro.prepare('SELECT hit_count, adopt_count, reject_count FROM fact').get();
      const rejected = usageOf({ reject_count: 3 });
      const exposed = usageOf({ reject_count: 3, hit_count: 1000 });
      const base = { kind: 'fact', confidence: 0.8, ts: Date.now(), reject_count: 3 };
      const retention = [retentionOf(base, 0, base.ts), retentionOf({ ...base, hit_count: 1000 }, 0, base.ts)];
      const boot = sections.find(s => s.name === 'memory:dsh-kb:boot').text({ agent: { sessionId: 'b', session: { meta: { cwd: 'D:/beta' } } } });
      results.push({ id: 'A19', priority: 'P2', classification: 'design-risk', title: '开场提示不分项目，标题换行原样进入提示段', reproduced: boot.includes('Project A note') && boot.includes('\nAUDIT_TITLE_SENTINEL'), observed: { projectBContainsProjectA: boot.includes('Project A note'), rawTitleNewline: boot.includes('\nAUDIT_TITLE_SENTINEL'), modelInstructionOverrideTested: false } });
      return { reproduced: counts.adopt_count === 3 && exposed.measured > rejected.measured, counts, threeRejects: rejected.measured, threeRejectsPlus1000Hits: exposed.measured, retention };
    } finally { ro.close(); }
  } finally { for (const dispose of disposers) dispose?.(); }
}, 'design-risk');

const hashesAfter = sourceHashes();
const sourceUnchanged = JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter);
results.sort((a, b) => a.id.localeCompare(b.id));
const report = {
  executedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  repository: repo, head, version: JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version,
  scope: 'Local working tree; baseline tests and production modules with isolated fixtures. No installed host GUI, external model, or real database validation.',
  sandbox, baseline: { command: 'node --test --test-reporter=tap test/**/*.test.js', exitCode: baseline.status, ...baselineCounts, error: baseline.error?.message },
  summary: { probes: results.length, reproduced: results.filter(r => r.reproduced).length, probeErrors: results.filter(r => r.probeError).length, sourceUnchanged },
  sourceHashes: hashesBefore, results,
};
writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, baseline: report.baseline, summary: report.summary, cases: results.map(({ id, priority, reproduced, probeError }) => ({ id, priority, reproduced, probeError })) }, null, 2));
// 缺陷复现不是测试成功；进程退出码仅表示审查脚本执行完整且没有修改源码。
if (baseline.status !== 0 || report.summary.probeErrors > 0 || !sourceUnchanged) process.exitCode = 1;
