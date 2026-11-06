/** R01–R10: sequential user workflows, using production entry points and isolated data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { openDb, writeFact, updateFact, getFact, factHash } from '../lib/store.js';
import { ingest } from '../lib/ingest.js';
import { planMirror, mirrorToDir, importFromDir, parseFrontmatter, mirrorBaseline } from '../lib/markdown.js';
import { collectMaterial, distillWithModel, exportMaterial } from '../lib/distill.js';
import { createApi } from '../lib/routes.js';
import { API_PREFIX, matchRoute } from '../lib/http.js';
import { digest, treeRows } from '../lib/digest.js';

const temp = mkdtempSync(path.join(tmpdir(), 'dsh-lifecycle-'));
process.env.DSH_HOME = path.join(temp, 'home');
process.env.DSH_KB_HOME = path.join(temp, 'home', 'kb');
mkdirSync(path.join(process.env.DSH_HOME, 'sessions'), {recursive:true});
const DAY = 86400000, stamp = Date.parse('2026-11-05T00:00:00Z');
function fresh(t) { const {db}=openDb(':memory:'); t.after(()=>db.close()); return db; }
function source(overrides={}) { return {title:'Source',body:'Original content',kind:'episode',source_kind:'session',source_ref:'s1',session_id:'s1',cwd:'D:/alpha',ts:stamp,...overrides}; }
function session(dir,id,text) {
  const folder=path.join(dir,id); mkdirSync(folder,{recursive:true});
  const events=[{type:'session',id,cwd:'D:/alpha',createdAt:stamp},{type:'assistant/message',data:{content:[{type:'text',text}]}}];
  writeFileSync(path.join(folder,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(events.map(JSON.stringify).join('\n')+'\n')));
}
function mirror(db) {
  const root=mkdtempSync(path.join(temp,'mirror-')), file=planMirror(db,root).writes[0].abs;
  mirrorToDir(db,root); return {root,file};
}
function model(fn) { return {provider:'fake',model:'fake',complete:async p=>JSON.stringify(fn(JSON.parse(p.user.slice(p.user.indexOf('\n')+1))))}; }
function card(m,overrides={}) { return {title:'Conclusion',body:'Use Node 22.',kind:'fact',path:m.path,sourceIds:[m.id],evidence:[{id:m.id,quote:m.excerpt}],...overrides}; }
async function invoke(db,endpoint,method='GET',body,deps={}) {
  const api=createApi({getDb:()=>db,...deps}), url=API_PREFIX+endpoint;
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url,headers:{host:'localhost'}});
  const res={statusCode:0,body:'',setHeader(){},end(v){this.body+=String(v??'')}};
  await matchRoute(api.routes,new URL(url,'http://localhost').pathname).handler(req,res);
  assert.equal(res.statusCode,200,res.body);return JSON.parse(res.body).data;
}

test('R01 未变重扫保留人工正文、标签、目录及失效状态，不制造版本',t=>{
  const db=fresh(t), dir=mkdtempSync(path.join(temp,'sessions-'));session(dir,'s1','Original');
  assert.equal(ingest(db,{sessionsDir:dir}).added,1);
  const id=db.prepare('SELECT id FROM fact').get().id;
  updateFact(db,id,{body:'Corrected',tags:['reviewed'],paths:['topic/reviewed'],status:'superseded'});
  const before=getFact(db,id),result=ingest(db,{sessionsDir:dir,rescan:true});
  assert.equal(result.dup,1);assert.equal(result.err,0);assert.deepEqual(getFact(db,id),before);
});

test('R01 来源与人工同时改正文时报告冲突，缓存仍允许后续重试',t=>{
  const db=fresh(t),dir=mkdtempSync(path.join(temp,'sessions-'));session(dir,'s1','Original');ingest(db,{sessionsDir:dir});
  const id=db.prepare('SELECT id FROM fact').get().id;updateFact(db,id,{body:'Human correction',status:'superseded'});
  session(dir,'s1','Source appended a different answer');
  const first=ingest(db,{sessionsDir:dir}),second=ingest(db,{sessionsDir:dir});
  assert.equal(first.conflicts.length,1);assert.equal(second.conflicts.length,1);assert.equal(first.err,1);
  assert.equal(getFact(db,id).body,'Human correction');assert.equal(getFact(db,id).status,'superseded');assert.equal(getFact(db,id).version,2);
  assert.match(db.prepare('SELECT err FROM ingest_log').get().err,/Source conflict/);
});

test('R01 来源新正文正常更新，保留人工元数据和降级状态',t=>{
  const db=fresh(t),f=source(),saved=writeFact(db,f);
  updateFact(db,saved.id,{tags:['manual'],paths:['topic/custom'],status:'doubtful',confidence:0.9});
  const next=writeFact(db,{...f,body:'New source content'}),row=getFact(db,saved.id);
  assert.equal(next.result,'updated');assert.equal(row.body,'New source content');assert.equal(row.status,'doubtful');
  assert.equal(row.path,'topic/custom');assert.deepEqual(JSON.parse(row.tags),['manual']);assert.equal(row.confidence,0.9);
  assert.equal(writeFact(db,{...f,body:'New source content'}).result,'dup');
});

test('R02 同内容会话身份独立，两份来源分别更新不串改',t=>{
  const db=fresh(t),a=source(),b=source({source_ref:'s2',session_id:'s2'});
  const one=writeFact(db,a),two=writeFact(db,b);assert.notEqual(one.id,two.id);
  assert.equal(writeFact(db,{...a,body:'Only s1 changed'}).id,one.id);assert.equal(getFact(db,two.id).body,b.body);
  assert.equal(writeFact(db,{...b,body:'Only s2 changed'}).id,two.id);assert.equal(getFact(db,one.id).body,'Only s1 changed');
  for (const [id,ref] of [[one.id,'s1'],[two.id,'s2']]) {
    const row=getFact(db,id);assert.ok(row.sources.every(s=>s.source_ref===ref));
    assert.deepEqual(row.sources.map(s=>s.source_version).sort(),[1,2]);
  }
});

test('R02 人工修订不会伪造原始来源支持新版本',t=>{
  const db=fresh(t),f=source(),{id}=writeFact(db,f);updateFact(db,id,{body:'Human text'});
  writeFact(db,f);const row=getFact(db,id);
  assert.equal(row.sources.length,1);assert.equal(row.sources[0].source_version,1);
  assert.equal(row.sources[0].source_hash,factHash(f.title,f.body));assert.notEqual(row.sources[0].source_hash,row.hash);
});

test('来源修订投影失败回滚正文、基线、来源证据及历史',t=>{
  const db=fresh(t),f=source(),{id}=writeFact(db,f),before=getFact(db,id);
  const baseline=db.prepare('SELECT baseline FROM source_binding').get().baseline;
  assert.throws(()=>writeFact(db,{...f,body:'Next'},()=>{throw Error('projection failed')}),/projection failed/);
  assert.deepEqual(getFact(db,id),before);assert.equal(db.prepare('SELECT baseline FROM source_binding').get().baseline,baseline);
  assert.equal(writeFact(db,{...f,body:'Next'}).result,'updated');
});

test('R03 连续导入确认新基线，但拒绝旧文件回放和独立数据库修改',t=>{
  const db=fresh(t),{id}=writeFact(db,{title:'Mirror',body:'body-v1'}),{root,file}=mirror(db),old=readFileSync(file,'utf8');
  writeFileSync(file,old.replace('body-v1','body-v2'));assert.equal(importFromDir(db,root).updated,1);
  assert.equal(parseFrontmatter(readFileSync(file,'utf8')).meta.base,mirrorBaseline(getFact(db,id)));
  writeFileSync(file,readFileSync(file,'utf8').replace('body-v2','body-v3'));assert.equal(importFromDir(db,root).updated,1);
  assert.equal(getFact(db,id).body,'body-v3');const latest=readFileSync(file,'utf8');
  writeFileSync(file,old);assert.equal(importFromDir(db,root).conflicts.length,1);assert.equal(getFact(db,id).body,'body-v3');
  writeFileSync(file,latest.replace('body-v3','body-v4'));updateFact(db,id,{status:'superseded'});
  assert.equal(importFromDir(db,root).conflicts.length,1);assert.equal(getFact(db,id).body,'body-v3');
});

test('R03 dry-run 不确认基线；导入期间文件再次编辑时保留编辑并报告',t=>{
  const db=fresh(t),{id}=writeFact(db,{title:'Mirror race',body:'body-v1'}),{root,file}=mirror(db);
  const edit=readFileSync(file,'utf8').replace('body-v1','body-v2');writeFileSync(file,edit);
  assert.equal(importFromDir(db,root,{dryRun:true}).updated,1);assert.equal(readFileSync(file,'utf8'),edit);assert.equal(getFact(db,id).version,1);
  const raced=edit.replace('body-v2','body-v3');
  const result=importFromDir(db,root,{segFn:text=>{writeFileSync(file,raced);return text;}});
  assert.equal(result.updated,1);assert.match(result.failed[0].error,/Database committed; Mirror changed/);
  assert.equal(readFileSync(file,'utf8'),raced);assert.equal(getFact(db,id).body,'body-v2');
});

test('R03 更新失败不能推进镜像基线或留部分数据库写入',t=>{
  const db=fresh(t),{id}=writeFact(db,{title:'Failed import',body:'body-v1'}),{root,file}=mirror(db);
  const edited=readFileSync(file,'utf8').replace('body-v1','body-v2');writeFileSync(file,edited);
  const result=importFromDir(db,root,{segFn:()=>{throw Error('FTS failure')}});
  assert.equal(result.failed.length,1);assert.equal(result.updated,0);assert.equal(readFileSync(file,'utf8'),edited);assert.equal(getFact(db,id).version,1);
});

test('R04 原样结论与原料独立，来源边和处理进度同时落库',async t=>{
  const db=fresh(t),f={title:'Standalone',body:'The dependency requires Node 22.',kind:'episode'},raw=writeFact(db,f);
  const result=await distillWithModel(db,model(ms=>({cards:[card(ms[0],{title:f.title,body:f.body})],processed:[ms[0].chunkId]})));
  assert.equal(result.added,1);assert.notEqual(result.ids[0],raw.id);assert.equal(getFact(db,result.ids[0]).kind,'fact');
  assert.equal(getFact(db,result.ids[0]).outbound[0].id,raw.id);assert.equal(collectMaterial(db).length,0);
  assert.equal(getFact(db,raw.id).kind,'episode');
});

test('R04 fact 类型的原料也不会被当成自己的提炼产物',async t=>{
  const db=fresh(t),f={title:'Existing fact',body:'A short existing fact.',kind:'fact'},raw=writeFact(db,f);
  const fake=model(ms=>({cards:[card(ms[0],{title:f.title,body:f.body})],processed:[ms[0].chunkId]}));
  const result=await distillWithModel(db,fake);assert.equal(result.added,1);assert.notEqual(result.ids[0],raw.id);
  assert.equal(getFact(db,result.ids[0]).outbound[0].id,raw.id);assert.equal(collectMaterial(db).length,0);
  const repeat=await distillWithModel(db,fake,{includeSpent:true});assert.equal(repeat.dup,1);assert.equal(repeat.ids[0],result.ids[0]);
});

test('R05 API 返回引用版本与准确历史快照，来源更新后仍能核验',async t=>{
  const db=fresh(t),raw=writeFact(db,source({body:'The dependency requires Node 22.'}));
  const result=await distillWithModel(db,model(ms=>({cards:[card(ms[0])],processed:[ms[0].chunkId]})));
  updateFact(db,raw.id,{body:'Now requires Node 24.'});
  const detail=await invoke(db,'/fact?id='+result.ids[0]),p=detail.outbound[0].provenance;
  assert.equal(p.sourceId,raw.id);assert.equal(p.version,1);assert.equal(p.currentVersion,2);assert.equal(p.changed,true);
  assert.equal(p.evidence[0].quote,'The dependency requires Node 22.');assert.equal(p.snapshot.body,p.evidence[0].quote);
  assert.equal(p.snapshot.hash,p.hash);
});

test('R06 未编辑镜像对开头空行、CRLF、缩进和尾空白均无损往返',t=>{
  for(const body of ['plain','\nline','\n\n  line\n','\r\n\r\n  code()\r\n\r\n','line  \n\n']) {
    const db=fresh(t),{id}=writeFact(db,{title:'Whitespace',body}),before=getFact(db,id),{root}=mirror(db);
    assert.equal(importFromDir(db,root).unchanged,1);assert.deepEqual(getFact(db,id),before);
  }
});

test('R06 只改元数据也保留数据库原始换行与尾空白',t=>{
  const db=fresh(t),body='\r\n  code()  \r\n', {id}=writeFact(db,{title:'Before',body}),{root,file}=mirror(db);
  writeFileSync(file,readFileSync(file,'utf8').replace('title: "Before"','title: "After"'));
  assert.equal(importFromDir(db,root).updated,1);assert.equal(getFact(db,id).body,body);
});

test('R07 只改主路径和只改多路径都生效，矛盾字段明确失败',t=>{
  const db=fresh(t),{id}=writeFact(db,{title:'Move',body:'content',paths:['topic/one','topic/other']}),{root,file}=mirror(db);
  writeFileSync(file,readFileSync(file,'utf8').replace('path: "topic/one"','path: "topic/two"'));
  assert.equal(importFromDir(db,root).updated,1);assert.equal(getFact(db,id).path,'topic/two');
  assert.deepEqual(JSON.parse(getFact(db,id).paths),['topic/two','topic/other']);
  let text=readFileSync(file,'utf8');const meta=parseFrontmatter(text).meta;
  const pathsLine=text.split('\n').find(s=>s.startsWith('paths:'));
  writeFileSync(file,text.replace(pathsLine,'paths: ["topic/three", "topic/other"]'));
  assert.equal(importFromDir(db,root).updated,1);assert.equal(getFact(db,id).path,'topic/three');
  text=readFileSync(file,'utf8').replace('path: "topic/three"','path: "topic/four"').replace('paths: ["topic/three", "topic/other"]','paths: ["topic/five"]');
  writeFileSync(file,text);const result=importFromDir(db,root);
  assert.equal(result.updated,0);assert.match(result.failed[0].error,/Conflicting path/);assert.equal(getFact(db,id).path,'topic/three');
  assert.equal(meta.path,'topic/two');
});

test('R08 失败计入批次上限并公平重试，不阻塞后续文件',t=>{
  const db=fresh(t),dir=mkdtempSync(path.join(temp,'bad-'));
  for(let i=0;i<4;i++){const folder=path.join(dir,'s'+i);mkdirSync(folder);writeFileSync(path.join(folder,'session.v4.jsonl.zstd'),Buffer.from('bad'));}
  for(let i=0;i<4;i++){const r=ingest(db,{sessionsDir:dir,limit:1});assert.equal(r.attempted,1);assert.equal(r.err,1);assert.equal(r.files,0);}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ingest_log').get().n,4);
  session(dir,'good','Valid answer');const result=ingest(db,{sessionsDir:dir,limit:1});assert.equal(result.added,1);assert.equal(result.attempted,1);
});

test('R09 正式吸收降级后清空空枝摘要',async t=>{
  const db=fresh(t);writeFact(db,{title:'Old episode',body:'old',kind:'episode',path:'topic/stale',ts:Date.now()-365*DAY});
  const result=await invoke(db,'/ingest','POST',{}),branch=treeRows(db,'topic/stale')[0];
  assert.equal(result.reaped.demoted,1);assert.equal(branch.count,0);assert.equal(branch.summary,'');
});

test('R09 提炼落库后立即更新摘要',async t=>{
  const db=fresh(t);writeFact(db,source({path:'topic/derive'}));digest(db);
  await distillWithModel(db,model(ms=>({cards:[card(ms[0])],processed:[ms[0].chunkId]})));
  const branch=treeRows(db,'topic/derive')[0];assert.equal(branch.count,2);assert.match(branch.summary,/Conclusion/);
});

function client() {
  let registration;new Function('window','document',readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'))({__ModuleLoader__:{load:r=>{registration=r;}}},undefined);
  return registration.factory(()=>({createElement:(type,props,...children)=>({type,props,children}),Fragment:'F',Component:class{},useState:v=>[v,()=>{}],useEffect(){},useCallback:f=>f,useMemo:f=>f(),useRef:()=>({current:null})}));
}

test('R05 面板证据展示包含引用版本、引文与历史全文',async t=>{
  const db=fresh(t),raw=writeFact(db,source());const result=await distillWithModel(db,model(ms=>({cards:[card(ms[0])],processed:[ms[0].chunkId]})));
  updateFact(db,raw.id,{body:'Now changed'});
  const detail=await invoke(db,'/fact?id='+result.ids[0]);
  const rendered=JSON.stringify(client().__sourceEvidence({edges:detail.outbound}));
  assert.match(rendered,/引用 v1（当前 v2）/);assert.match(rendered,/Original content/);assert.match(rendered,/查看当时的来源全文/);
});
test('R10 正式提炼响应与生产客户端消息一致：成功、空原料、仅出料',async t=>{
  const db=fresh(t),format=client().__distillMessage;writeFact(db,source());
  const fake=model(ms=>({cards:[card(ms[0])],processed:[ms[0].chunkId]}));
  const result=await invoke(db,'/distill','POST',{}, {distill:opts=>distillWithModel(db,fake,opts)});
  assert.equal(result.status,'completed');assert.match(format(result),/模型提炼完成：1 张卡/);assert.doesNotMatch(format(result),/没有模型/);
  const empty=await distillWithModel(db,fake);assert.equal(empty.status,'empty');assert.equal(format(empty),'没有待提炼的原料。');
  writeFact(db,source({source_ref:'s2',body:'Different content'}));
  const pack=await invoke(db,'/distill','POST',{}, {distill:opts=>exportMaterial(db,opts)});
  assert.equal(pack.status,'material');assert.match(format(pack),/没有模型通道/);assert.equal(pack.material,1);
});

function oldV4(shared=false) {
  const dir=mkdtempSync(path.join(temp,'v4-')),file=path.join(dir,'kb.db'),db=new DatabaseSync(file),f=source();
  db.exec(readFileSync(new URL('./fixtures/schema-v4.sql',import.meta.url),'utf8'));
  db.prepare(`INSERT INTO fact(id,ts,kind,title,body,path,paths,source_kind,source_ref,session_id,cwd,hash,created_at,updated_at,scope)
    VALUES ('f_12345678',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.ts,f.kind,f.title,f.body,'inbox','["inbox"]',f.source_kind,f.source_ref,f.session_id,f.cwd,factHash(f.title,f.body),stamp,stamp,'cwd:d:/alpha');
  db.prepare('INSERT INTO fact_source VALUES (?,?,?,?,?,?)').run('f_12345678','session','s1','s1','D:/alpha',stamp);
  if(shared)db.prepare('INSERT INTO fact_source VALUES (?,?,?,?,?,?)').run('f_12345678','session','s2','s2','D:/alpha',stamp);
  db.close();return file;
}

test('v4迁移不猜旧来源版本；独占卡建立基线后才能安全同源修订',t=>{
  const file=oldV4(),{db}=openDb(file);t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);assert.equal(getFact(db,'f_12345678').sources[0].source_version,0);
  assert.equal(writeFact(db,source({body:'Changed before baseline'})).result,'conflict');assert.equal(getFact(db,'f_12345678').body,'Original content');
  assert.equal(writeFact(db,source()).result,'dup');assert.equal(writeFact(db,source({body:'After baseline'})).result,'updated');
  assert.equal(getFact(db,'f_12345678').body,'After baseline');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('v4共享旧卡保留原身份，新吸收为每个来源分配独立身份',t=>{
  const file=oldV4(true),{db}=openDb(file);t.after(()=>db.close());
  const one=writeFact(db,source({body:'s1 now changed'})),two=writeFact(db,source({source_ref:'s2',session_id:'s2'}));
  assert.notEqual(one.id,'f_12345678');assert.notEqual(two.id,'f_12345678');assert.notEqual(one.id,two.id);
  assert.equal(getFact(db,'f_12345678').body,'Original content');assert.equal(getFact(db,'f_12345678').sources.length,2);
  assert.equal(getFact(db,two.id).body,'Original content');
});

test('v5重新开库保持基线/版本证据和人工修改',()=>{
  const file=oldV4();let {db}=openDb(file);writeFact(db,source());updateFact(db,'f_12345678',{body:'manual'});
  const before=getFact(db,'f_12345678'),binding=db.prepare('SELECT * FROM source_binding').get();db.close();({db}=openDb(file));
  try{assert.deepEqual(getFact(db,'f_12345678'),before);assert.deepEqual(db.prepare('SELECT * FROM source_binding').get(),binding);assert.equal(writeFact(db,source()).result,'dup');}
  finally{db.close();}
});

test('v4迁移结构冲突时原子回滚，不丢旧来源记录',()=>{
  const file=oldV4();let db=new DatabaseSync(file);db.exec('CREATE TABLE source_binding(dummy TEXT)');db.close();
  assert.throws(()=>openDb(file),/source_kind/);db=new DatabaseSync(file);
  try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM fact_source').get().n,1);
    assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('fact_source') WHERE name='source_version'").get(),undefined);}
  finally{db.close();}
});

registerHooks({resolve(specifier,context,next){const name=specifier==='@deepseek-ai/schemastery'?'schemastery-stub':specifier==='@deepseek-ai/dsh-tools'?'dsh-tools-stub':null;
  return name?{url:new URL(`./fixtures/${name}.mjs`,import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
const {apply}=await import('../lib/index.js');
function plugin(t,opts={}) {
  const file=path.join(mkdtempSync(path.join(temp,'plugin-')),'kb.db'),tools=[],disposers=[];
  apply({tools:{register:d=>tools.push(d)},systemPrompt:{section(){}},effect:f=>disposers.push(f())},{dbPath:file,ui:false,...opts});
  t.after(()=>disposers.forEach(f=>f?.()));return {file,tool:name=>tools.find(d=>d.name===name)};
}
test('R05 kb_get 显示引用版本和原文，不把当前来源当原证据',async t=>{
  const {file,tool}=plugin(t),{db}=openDb(file);t.after(()=>db.close());writeFact(db,source());
  const result=await distillWithModel(db,model(ms=>({cards:[card(ms[0])],processed:[ms[0].chunkId]})));
  const origin=getFact(db,result.ids[0]).outbound[0].id;updateFact(db,origin,{body:'Changed'});
  const answer=await tool('kb_get').execute({id:result.ids[0]});assert.match(answer.text,/来源版本 v1/);assert.match(answer.text,/当前已为 v2/);assert.match(answer.text,/原文引用：Original content/);
});

test('R09 kb_ingest 在实际降级之后刷新摘要',async t=>{
  const {file,tool}=plugin(t),{db}=openDb(file);t.after(()=>db.close());await tool('kb_tree').execute({});
  writeFact(db,{title:'Old task',body:'expired',kind:'todo',ts:Date.now()-365*DAY,path:'topic/tool'});digest(db);
  const answer=JSON.parse((await tool('kb_ingest').execute({})).text);assert.equal(answer.staled,1);
  assert.equal(treeRows(db,'topic/tool')[0].summary,'');
});

test('R09 定时吸收也在降级后刷新摘要',async t=>{
  let callback;const original=globalThis.setInterval;
  globalThis.setInterval=fn=>{callback=fn;return {unref(){}};};
  let installed;try{installed=plugin(t,{ingestEveryMinutes:1});}finally{globalThis.setInterval=original;}
  const {db}=openDb(installed.file);t.after(()=>db.close());await installed.tool('kb_tree').execute({});
  writeFact(db,{title:'Timer task',body:'expired',kind:'todo',ts:Date.now()-365*DAY,path:'topic/timer'});digest(db);
  assert.equal(typeof callback,'function');callback();assert.equal(treeRows(db,'topic/timer')[0].summary,'');
});
