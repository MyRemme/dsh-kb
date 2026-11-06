import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, writeFact, updateFact, getFact, addEdge, factHash } from '../lib/store.js';
import { search } from '../lib/search.js';
import { planMirror } from '../lib/markdown.js';
import { usageOf, recordUsage } from '../lib/usage.js';

const id='f_12345678', other='f_87654321', stamp=1793743200000;
function legacy() {
  const dir=mkdtempSync(path.join(tmpdir(),'dsh-kb-v3-')), file=path.join(dir,'kb.db');
  const db=new DatabaseSync(file);
  db.exec(readFileSync(new URL('./fixtures/schema-v3.sql',import.meta.url),'utf8'));
  const insert=db.prepare(`INSERT INTO fact(id,ts,title,body,path,paths,source_kind,source_ref,session_id,cwd,hash,version,created_at,updated_at,adopt_count,reject_count,last_hit_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(id,stamp/1000,'Legacy memory','migrationprobe lib/alpha.js','project/alpha','["project/alpha"]','session','s:chunk','s','D:/Alpha','old-fuzzy-hash',2,stamp/1000,new Date(stamp).toISOString(),25,4,new Date(stamp).toISOString());
  insert.run(other,stamp,'Other memory','old body','project/beta','["project/beta"]','manual','ref-b','','','other-fuzzy-hash',1,stamp,stamp,0,0,null);
  db.prepare('INSERT INTO fact_history(id,version,ts,title,body,hash,archived_at) VALUES (?,1,?,?,?,?,?)').run(id,stamp/1000,'Before','Original historical text','original-hash',new Date(stamp).toISOString());
  db.prepare('INSERT INTO edge VALUES (?,?,?,1,?,?)').run(id,other,'references','preserve valid',stamp);
  db.prepare('INSERT INTO edge VALUES (?,?,?,1,?,?)').run(id,'f_deadbeef','derived_from','legacy dangling',stamp);
  db.prepare('INSERT INTO usage(fact_id,kind,ts,source) VALUES (?,?,?,?)').run(id,'adopt',new Date(stamp).toISOString(),'tool');
  db.prepare('INSERT INTO fact_fts(rowid,title,body) VALUES (1,?,?)').run('stale','obsoleteindex');
  db.close();
  return {file,dir};
}

test('v3 迁移保留身份、历史和来源，重建精确指纹/索引并规范化时间',t=>{
  const {file}=legacy(), {db}=openDb(file);t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
  const row=getFact(db,id);
  assert.equal(row.id,id);assert.equal(row.version,2);assert.equal(row.source_ref,'s:chunk');
  assert.equal(row.scope,'cwd:d:/alpha');assert.equal(getFact(db,other).scope,'project:project/beta');
  assert.equal(row.hash,factHash(row.title,row.body));assert.equal(row.ts,stamp);assert.equal(row.updated_at,stamp);assert.equal(row.created_at,stamp);assert.equal(row.last_hit_at,stamp);
  assert.equal(row.history[0].body,'Original historical text');assert.equal(row.history[0].hash,'original-hash');assert.equal(row.history[0].archived_at,stamp);
  assert.equal(row.sources[0].source_ref,'s:chunk');assert.equal(row.history[0].source_ref,'');
  assert.equal(search(db,'migrationprobe',{expand:false})[0].id,id);assert.equal(search(db,'obsoleteindex',{expand:false}).length,0);
  assert.ok(row.mentions.some(m=>m.token==='lib/alpha.js'));
  assert.equal(row.adopt_count,25);assert.equal(row.reject_count,4);assert.equal(row.explicit_adopt_count,0);assert.equal(usageOf(row).measured,null);
  assert.equal(db.prepare('SELECT ts FROM usage').get().ts,stamp);
  const duplicate=writeFact(db,{title:row.title,body:row.body,cwd:'D:/alpha',source_ref:'new provenance'});
  assert.notEqual(duplicate.id,id);assert.equal(duplicate.result,'added'); // 手动结论不再复用可变会话原料身份。
  const cross=writeFact(db,{title:row.title,body:row.body,cwd:'D:/beta'});
  assert.notEqual(cross.id,id);assert.equal(cross.result,'added');
  updateFact(db,id,{body:'Revised > condition'});
  assert.equal(getFact(db,id).version,3);assert.equal(getFact(db,id).history.length,2);
  assert.equal(getFact(db,id).history[0].source_ref,'s:chunk');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('迁移保留可诊断的历史悬空边，但拒绝新增/改成不存在的端点',t=>{
  const {file}=legacy(), {db}=openDb(file);t.after(()=>db.close());
  const dangling=()=>db.prepare('SELECT e.* FROM edge e LEFT JOIN fact s ON s.id=e.src LEFT JOIN fact d ON d.id=e.dst WHERE s.id IS NULL OR d.id IS NULL').all();
  assert.equal(dangling().length,1);assert.equal(dangling()[0].note,'legacy dangling');
  assert.throws(()=>addEdge(db,other,'f_deadbeef','references'),/endpoint/);
  assert.throws(()=>db.prepare('UPDATE edge SET dst=? WHERE dst=?').run('f_00000000',other),/endpoint/);
  assert.equal(dangling().length,1);assert.equal(getFact(db,id).outbound[0].id,other);
});

test('非法旧时间使整个迁移回滚，版本/原数据/唯一索引完整保留',()=>{
  const {file}=legacy();let db=new DatabaseSync(file);
  db.prepare('UPDATE fact SET updated_at=? WHERE id=?').run('not-a-timestamp',id);db.close();
  assert.throws(()=>openDb(file),/timestamp/);
  db=new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
    assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('fact') WHERE name='scope'").get(),undefined);
    assert.equal(db.prepare('SELECT hash FROM fact WHERE id=?').get(id).hash,'old-fuzzy-hash');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='fact_hash'").get().name,'fact_hash');
    assert.equal(db.prepare('SELECT body FROM fact_fts').get().body,'obsoleteindex');
  } finally { db.close(); }
});

test('已有 scope 列不表示迁移完成，补齐结构后重复开库不清空新反馈',()=>{
  const {file}=legacy();let db=new DatabaseSync(file);
  db.exec("ALTER TABLE fact ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");db.close();
  ({db}=openDb(file));
  recordUsage(db,id,'adopt',{sessionId:'new-session'});
  const first=getFact(db,id);db.close();
  ({db}=openDb(file));
  try {
    assert.deepEqual(getFact(db,id),first);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM distill_progress').get().n,0);
    assert.equal(getFact(db,id).explicit_adopt_count,1);
    assert.equal(recordUsage(db,id,'adopt',{sessionId:'new-session'}),false);
  } finally { db.close(); }
});

test('旧非法分类不自动改写，迁移后导出明确拒绝路径穿越',t=>{
  const {file,dir}=legacy();const legacyDb=new DatabaseSync(file);
  legacyDb.prepare('UPDATE fact SET path=?,paths=? WHERE id=?').run('../../outside','["../../outside"]',id);legacyDb.close();
  const {db}=openDb(file);t.after(()=>db.close());
  assert.equal(getFact(db,id).path,'../../outside');
  assert.throws(()=>planMirror(db,path.join(dir,'mirror')),/path/);
});

test('同名但损坏的进度表不能伪报迁移成功',()=>{
  const {file}=legacy();let db=new DatabaseSync(file);
  db.exec("ALTER TABLE fact ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'; CREATE TABLE distill_progress(dummy TEXT)");db.close();
  assert.throws(()=>openDb(file),/source_id/);
  db=new DatabaseSync(file);
  try {assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);}
  finally {db.close();}
});
