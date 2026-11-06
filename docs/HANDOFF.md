# dsh-kb 交接文档

> 状态时间：**2026-11-06**（0.9.1 完成复审 R01–R10 修复，229 项隔离测试通过，未安装）
> 仓库：https://github.com/MyRemme/dsh-kb ｜ 本地：`D:\Code\dsh-kb` ｜ 安装位置：`~/.dsh/profiles/desktop/node_modules/dsh-kb`
> 上一版交接是 2026-10-31（0.6.1 时代），那一版里的架构决策与老坑仍然有效，本文在它基础上更新并重写状态。

**本次交接优先读 [FIXES-20261106.md](FIXES-20261106.md)**：229 项隔离测试通过，schema v5 / Markdown 格式 2；保留工作区已有中枢改动。用户已授权将修复提交并推送到 `MyRemme/dsh-kb`，实际提交与同步状态以 Git 为准。实际库、profile 与宿主未变更。下文真库数量、安装路径状态和旧版验证描述是 11-04 的历史观测，不代表今天重新验证。

---

## 0. 三十秒速览

| 问题 | 答案 |
|---|---|
| 这是什么 | DeepSeek Harness 的本地长期记忆库。把会话里想明白的事沉淀成不可变事实卡，下次会话不用从零开始 |
| 现在能用吗 | **0.9.1 源码通过隔离验证，实际宿主未安装。** 不能仅重启就假定已加载修复 |
| 库在哪 | `~/.dsh/kb/kb.db`（SQLite 单文件，随时可备份/迁移）+ `mirror/` Markdown 只读投影 |
| 这一版装了什么 | 12 个模型工具 + **两个**侧边栏面板（中枢 / 记忆）+ 22 个 HTTP 端点 + CLI + 静态导出 |
| 当前数据量 | 1313 张卡 / 811 在用 / 731 条边 / 27 个枝 / 637 条摄入记录 / 454 张会话卡（33 张在用） |
| 会话语料 | `~/.dsh/sessions` 754 个文件 / 338 MB |
| 依赖 | 零外部依赖。只用 `node:sqlite` + `node:zlib`（Node ≥ 22.19） |
| 测试 | **229 项，全绿。** `npm test`（自动隔离 DSH 数据目录）；本地输出见 `test-results/fixes-20261106/final-test.tap` |

---

## 1. 本轮提交前的历史状态

以下记录本轮开始时的版本差异，供解释本次推送包含的已有开发内容；不是实时远端状态：

| 层次 | 版本 | 内容 | 状态 |
|---|---|---|---|
| **工作区** | 0.9.0 | 中枢页 + A01–A19 完整性与语义修复 | **未提交**；本次增量与基线快照在 `test-results/fixes-20261105/` |
| **本地 HEAD** | 0.8.1 | 使用反馈（`3184965`，11-01 02:08） | 已提交，**未推送**（ahead 1） |
| **远端 origin/main** | 0.8.0 | 动态遗忘（`465b544`，11-01 01:38） | GitHub 上最新的就是这个 |

本轮授权推送包含此前未发布的中枢、完整性修复，以及 0.9.1 的连续流程修复。安装 profile 与迁移真实库是独立步骤，本轮未执行。

11-04 的未提交基线清单（当前以 `git status` 和修复记录为准）：

```
M CHANGELOG.md  README.md  docs/HANDOFF.md  lib/client.js  lib/index.js  lib/routes.js
M package.json  test/http.test.js  test/plugin.test.js
?? lib/hub.js  test/hub.test.js
?? docs/hub.html  docs/hub.png  docs/hub-dark.html  docs/hub-dark.png
?? tools/preview-hub.mjs  tools/smoke-hub.mjs  tools/smoke-hub-http.mjs
```

其中 `docs/HANDOFF.md`（本文）也是这次改动的一部分。

### 已经在跑 / 已验证

- 插件在 `~/.dsh/profiles/desktop/cordis.patch.yml` 有一条 `insert`，`enabled: true`。
- 宿主路由已注册（`GET /api/dsh-kb/stats`、`/hub` 都在端点表里，22 个全注册）。
- 系统提示注入生效：模型在「之前/上次/我们说过」时先 `kb_search`，产出结论时 `kb_add`。
- 侧边栏有「记忆」入口（`sidebar.panellist`，order 32）；0.9.0 起多一个「中枢」（order 31）。

### 没有验证的（唯一一条）

**真机 GUI 里的中枢页没截过图。** `docs/hub.png` 是静态预览（CSS 从 `client.js` 正则提取、星图坐标调客户端导出的 `__hubGalaxy` 算，与实现同源），但"宿主把两个 panel 都挂上、点「中枢」能切过去"这件事只能靠重启后手点确认。

排查顺序见 §8.8。

---

## 2. 本次交接的核心：2026-11-04 的审查与修复

上一版是"功能做完就交付"。这一轮拿真库（1312 卡 / 754 会话文件 / 13 行 front.log）跑了一遍 `/hub`，发现三个**页面看起来正常、其实在撒谎**的问题，已全部修掉。

### 2.1 必修三项

| # | 问题 | 根因 | 修法 | 实测证据 |
|---|---|---|---|---|
| 1 | 「前端错误·7天」把真错丢掉，只留噪声 | `parseFrontLog` 用 `(.{0,200})$` 匹配，**超长行不是截断而是整行匹配失败** | 整行收下 + 噪声白名单（`FRONT_LOG_NOISE`）+ 噪声单独计数 | 真库 13 行：8 条 `ResizeObserver` 噪声被剔，剩下 5 条真错误；其中 1040 字符的 `[render] Cannot read properties of null (reading 'tx')` 原先被整行丢弃 |
| 2 | 同一根枝，两个面板两个数字 | 中枢按 `status='active'` 统计，`/stats` 不筛 | 一次 `SUM(CASE WHEN status='active' …)` 同时给两数，页面写 `232/429` | `project/code`：记忆面板 429 / 中枢 232，差近一倍 |
| 3 | 自检「库文件 ok」只证明文件存在 | `level: dbBytes > 0` | 块失败留 `memory.error`，`db` 项据此报「查询失败」bad | 造一个 8 KB 无 `fact` 表库：所有查询抛 `no such table`，旧代码照样绿灯 |

对应代码：`lib/hub.js` 的 `parseFrontLog`（§3 地图）、`memorySection`、`statusSection`。

### 2.2 顺手修的

| 项 | 改动 |
|---|---|
| 性能 | 会话清单缓存 30 s（`SESSION_CACHE_MS`）；每枝前 6 张卡由 8 次 N+1 预编译改成一次窗口函数查询。真库：**冷 86.2 → 70.7 ms，热 86.2 → 18.0 ms** |
| 告警疲劳 | 「知识卡降级」只算知识卡（fact/decision/fix/pref/howto/concept），流水账成批降级不算。真库 **38% → 0%**，该项回绿 |
| 假入口 | 「最近会话」只列 active 的 episode 卡（454 张里 421 张已降级，点开是 superseded 抽屉） |
| 前端 | 请求失败不再同时显示"正在汇总六块…"；页头圆点由自检结论汇总（bad > warn > ok）而不是只看请求成不成功；星图标签 React key 改用 `path`（末两段同名会丢节点） |
| 健壮性 | `countFiles` 加 8 层 / 20000 文件上限（`mirrorDir` 是用户可配项，配到盘根就是一次卡死）；`status.frontLog.file` 之前填的是 `kb.db` 路径，改回日志路径；`sessions.recent[].cwd` 前端从未使用，不再返回 |

测试从 **154 → 163**，新增 9 条全部钉本次的具体缺陷（不是"有字段就算过"）：

```
超长错误行不被丢 · 噪声剔除后能回绿 · 枝双口径 · 查询失败不假绿 ·
流水账降级不计入 · 最近会话只列 active · 会话清单缓存命中与 bypass ·
GET /hub 真请求（六块形状）· POST /hub → 405
```

---

## 3. 代码地图

```
lib/                                                                       当前行数
  store.js         SQLite v4、作用域内精确去重、稳定 id、事务化版本/来源/FTS/提及
  segment.js   78  中文 bigram 分词、查询词元、精排用意图词
  search.js   269  召回（FTS/LIKE/图扩展）→ 精排（覆盖率加权）→ 渲染
  session.js  249  多帧 zstd 解压、事件流解析、事件 → 卡
  ingest.js    98  增量流水线：扫文件 → 抽卡 → 建边 → 记 ingest_log
  digest.js    65  树节点摘要（可重算的缓存）
  reap.js     212  动态遗忘：重要度 × 时间衰减 → active/doubtful/superseded
  usage.js    146  使用反馈：命中/采纳/否决记账，反哺保留分
  distill.js  218  会话 → 结论卡（走模型通道，可选）
  model.js    224  模型探测与 LLM 通道
  markdown.js 563  mirror/ 投影：导出、导入、CRLF 归一
  export.js   290  静态 HTML 导出（自包含，数据内嵌）
  tool.js     101  defineTool 官方优先 + 本地等价回退
  http.js     263  路由描述符、JSON 收发、Origin 校验、统一错误信封
  routes.js   757  /api/dsh-kb/* 22 个端点 + statsOf
  hub.js      621  【0.9.0】中枢聚合：六块一次算完，含自检与噪声过滤
  index.js    782  插件入口：Config、12 个工具、路由挂载、提示注入、hub 数据源
  entry.js     82  profile 加载入口（只做 re-export，不能有 default）
  client.js  2505  浏览器端两个面板（中枢 + 记忆），module-loader 格式，零构建
bin/kb.js     425  CLI
test/              202 项（含冻结 v3 schema 的迁移与 A01–A19 回归）
tools/             preview-canvas / preview-star / preview-hub（生成 docs 截图）
                   smoke-hub / smoke-hub-http（真库只读冒烟）
```

**改之前先看**：

- `store.js` 的 `upsertFact` 是唯一写入口。所有写入路径都过它，幂等与去重只需在这里保证一次。
- `search.js` 的 `queryTokens` 返回**扁平**词元列表（见 §8.3），别退回"整串包一组"。
- `client.js` 不是普通模块，是 `window.__ModuleLoader__.load({ id, factory })`；里面不能用 `import`，`react` 靠 factory 参数拿。
- `hub.js` 的每一块都自己 `try/catch`，**兜住之后必须留痕**（`error` 字段 / `checks` 里的 bad）—— 这是本轮修出来的纪律，别退回去。
- `lib/*.js` 一律不许 `export default`（cordis 会把裸函数当插件，`inject` 丢失）。`test/exports.test.js` 在守这条。

---

## 4. 数据流

```
~/.dsh/sessions/<cwd-tag>/<session-id>/session.v4.jsonl.zstd
       │  session.js：按 magic 扫帧边界，逐帧 zstdDecompressSync
       │              （一次性解压只能拿到第一帧，会误判成"文件坏了"）
       ▼
   事件流 [{type:"session/title"|"compaction/summary"|"user/message"|...}]
       │  session.js：eventsToFacts
       │  · episode 卡 = 整会话摘要 + 用户原话节选
       │  · 分段卡   = compaction/summary 按 ## 标题拆
       │  · intent 卡 = 用户原话前 3 + 后 2
       ▼
   fact 表（唯一真相）  ──writeFact──> 作用域 + 完整内容精确去重，返回真实 id
       │
       ├── node 树：paths 数组（多归属），digest 重算摘要
       ├── edge 图：contains / related / supersedes / derived_from / applies_to …
       ├── fact_fts：中文 bigram 索引，查询侧同样 bigram 化
       ├── ingest_log：哪个文件吸收过、加了几张、错在哪（中枢的"吸收到哪"）
       └── fact_history：修订历史（update 不丢旧版本）
       ▼
   五条出口
       ├── 模型工具  12 个 kb_*
       ├── HTTP      /api/dsh-kb/*（22 个，含 /hub）
       ├── 面板      lib/client.js（中枢 / 记忆）
       ├── 静态页    kb export → 单文件 HTML
       └── Markdown  kb mirror → mirror/（人读 + 可 git）
```

---

## 5. 中枢这一页怎么工作（0.9.0 主功能）

`GET /api/dsh-kb/hub` 一次返回六块，前端只发一个请求 —— 六块各发一个的话，任何一路慢都会让页面停在"两块永久转圈"，而中枢存在的意义恰恰是"一眼看到哪里不对"。

| 块 | 回答什么 | 服务端来源 | 前端要点 |
|---|---|---|---|
| 记忆库 | 库多大、长什么形状 | `fact` / `edge` / `node` 计数 + `kind`、`path`、`grp`、`rel` 分布 + `db`/`wal`/`mirror` 体积 | 四 KPI + 类型条 + 枝体积（`在用/总量`） |
| 检索 | 顺手查一下 | 既有 `/search`（FTS5 + bigram），中枢只做入口 | 240 ms 防抖，点结果开抽屉 |
| 星图 | 八个枝各有什么 | 每枝前 6 张 active 卡 | 坐标**纯函数**（`__hubGalaxy`，可测、刷新不跳），不做物理散布 |
| 会话 | 吸收到哪了 | episode 卡标题（**不解压会话文件**）+ `ingest_log` + 磁盘文件数与体积 | 只列 active 卡 |
| 工具 | 模型真能看见什么 | `ctx.tools.schemas()`（宿主注册表，不是插件自报） | 过滤 `run_code`（PTC 传输层），单例前缀并入「其他」 |
| 状态 | 哪里不对 | 进程信息 + `front.log` 尾部 + 7 项自检 | 圆点由自检汇总上色（bad > warn > ok） |

**7 项自检**：库文件（查询失败→bad）、WAL（>64 MB→warn）、最近吸收（>1 天 warn / >7 天 bad / 从未 bad）、知识卡降级（>15% warn / >35% bad，分母只算知识卡）、前端错误·7天（>0 warn）、Markdown 投影（未导出 warn）、吸收失败（>0 warn）。

**载荷形状**（写前端或写测试都按这个）：

```
{ ts, memory{facts,active,stale,knowledge,knowledgeStale,sessions,edges,nodes,mentions,
              versions,kinds[],paths[]{path,n,total},groups[],rels[],branches[]{path,n,total,cards[]},
              lastCardTs,dbBytes,walBytes,mirror{dir,files},error?},
  sessions{total,active,ingested,failed,lastIngestTs,recent[],disk{files,bytes,newest,dir}},
  tools{count,groups[],names[]},
  status{version,dshVersion,node,pid,uptimeSec,rssMB,db,mirror,frontLog{file,total,noise,count,items[]},
         checks[]{key,label,value,level},ts} }
```

---

## 6. 关键决策（含失败路径）

### 6.1 不做纯树、不做纯向量，`fact` 才是唯一真相

**决策**：fact 表存不可变事实卡；树、图、摘要、索引全是它的投影，随时可重建。

**为什么**：纯树死在单父挂载（一个会话经常横跨四个主题，挂哪都错）和分类成本；纯向量死在无法做范围限定、无锚点去重、不知道哪些过期。

**如果反过来**：把分类写进卡的字段（单值），三个月后你会因为"不想决定归哪"而不再写卡，库就死了。实测证据：`project/code` 一个枝 429 张、`topic/dsh` 322 张，两个枝吃掉七成卡 —— 这就是纯树的成本现场。

### 6.2 自动抽取只提取事实，"为什么"必须当场写

**决策**：`ingest` 只从会话里拿"已经写下来的东西"；判断、取舍、"为什么不用 B"由模型用 `kb_add` 写。

**为什么**：从事件流反推理由，得到的是幻觉。幻觉进了记忆库比没有记忆更糟 —— 你会照着错的干。

### 6.3 不删，只降权

**决策**：结论被推翻时 `status='superseded'`，检索权重 ×0.15，需显式 `includeSuperseded` 才可见。`kb forget` / `POST /forget` 也是标 superseded，不是删。

**为什么**：删了就不知道"当初为什么放弃"，那通常比结论本身值钱。

### 6.4 中文必须 bigram 预分词

**决策**：写入前把 CJK 切成相邻两字、空格连接，FTS 用默认分词器。

**为什么**：FTS5 的 `trigram` 只给 ≥3 字符建索引，「记忆」「材质」这类双字词直接零命中；默认分词器把整段中文当一个 token。bigram 预切让任意双字词可检索，代价是索引约 2 倍。

### 6.5 `defineTool` 留解析回退

**决策**：`await resolveDefineTool()` —— 先 try 官方 `@deepseek-ai/dsh-tools`，失败回退 `lib/tool.js` 的等价实现。

**为什么**：该包只存在于 dsh 运行时的 asar 内，第三方插件在 profile 的 `node_modules` 下向上解析找不到它。但 `defineTool` 不能不用：它把参数方言转成标准 JSON Schema，并在 execute 前做参数校验。

### 6.6 界面给两套

**决策**：dsh 内嵌面板 + 静态 HTML 导出。

**为什么**：面板要重启才生效；静态页不用，还能当快照对比、还能发给别人看。面板加载失败时，静态页是唯一能确认"数据本身是对的"的通道。

### 6.7 中枢一次聚合，不拆成六个请求

**决策**：`/hub` 在服务端把库、会话目录、`front.log`、工具注册表合一次。

**为什么**：六块并发请求时，任何一路慢都会让两格永久转圈；而"哪块坏了"这件事本身就是要被看见的。

**代价**：单次 70 ms 同步阻塞（缓存命中 18 ms）。如果将来会话目录涨到十万文件，得把 `sessionSection` 挪进 worker 或加更强的缓存策略。

### 6.8 自检分级只有 ok / warn / bad

**决策**：不给"仪表盘总体色"这种东西加第四级；页头圆点取最差一级。

**为什么**：三档够人做"要不要现在动手"的判断。加点数会让人讨论颜色而不是修东西。

---

## 7. 怎么跑

### 7.1 测试与冒烟

```bash
cd D:/Code/dsh-kb
npm test                            # 202 项，自动使用隔离数据目录
node tools/smoke-hub.mjs            # 真库只读跑一遍中枢（只读连接，不留写入痕迹）
node tools/smoke-hub-http.mjs       # 起裸 http 打 /hub（不依赖宿主）
```

### 7.2 生成中枢预览截图

```bash
node tools/preview-hub.mjs          # → docs/hub.html + docs/hub.png
node tools/preview-hub.mjs --dark   # → docs/hub-dark.*
```

依赖本机 Edge/Chrome（headless）。预览与实现同源：CSS 从 `client.js` 正则提取，星图坐标调 `__hubGalaxy`。

### 7.3 同步到 profile（当前是手工，不走 pnpm）

```bash
cp D:/Code/dsh-kb/package.json ~/.dsh/profiles/desktop/node_modules/dsh-kb/package.json
cp -r D:/Code/dsh-kb/lib/. ~/.dsh/profiles/desktop/node_modules/dsh-kb/lib/
```

然后**重启 dsh**。宿主端改动（`index.js` / `routes.js` / `hub.js`）必须重启；`client.js` 改动刷新页面即可。

### 7.4 验证插件真的加载了

```bash
curl -s http://127.0.0.1:<PORT>/api/dsh-kb/stats | head -c 300
curl -s http://127.0.0.1:<PORT>/api/dsh-kb/hub   | head -c 600
```

`<PORT>` 取当前 GUI 地址里的端口（本轮运行时是 **10562**；历史文档里的 8317 已过期）。404 说明插件没加载或被 `enabled: false` 关掉。

### 7.5 CLI

```bash
node bin/kb.js ingest                    # 增量吸收（幂等，可反复跑）
node bin/kb.js ingest --rescan           # 忽略 size/mtime 全量重扫
node bin/kb.js search "检索 分词" -k 6
node bin/kb.js search "zstd" --path topic/dsh --json
node bin/kb.js add --title "结论" --body "正文" --path topic/x --kind decision
node bin/kb.js tree topic --summary
node bin/kb.js stats
node bin/kb.js show f_0d06e6d4155a92
node bin/kb.js forget f_0d06e6d4155a92  # 标记失效，不删
node bin/kb.js reindex                   # 换了分词规则后必须跑
node bin/kb.js export [--out FILE]       # 静态 HTML
```

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_KB_HOME`（默认 `$DSH_HOME/kb`）。
**注意**：`DSH_HOME` 一旦被设成临时目录（测试里就这么干），`/hub` 的会话块和 `/ingest` 都会指过去 —— 这是有意为之的隔离。

---

## 8. 踩过的坑

按"下次再遇到会浪费多少时间"排序。

### 8.1 会话文件是多帧 zstd

**症状**：解析 `session.v4.jsonl.zstd` 只得到 1 行 `{"type":"session",...}`，像文件损坏。
**根因**：一个会话文件里有几十个连续 zstd 帧，`zstdDecompressSync(buf)` 只解第一帧就返回。
**修法**：扫 `28 B5 2F FD` magic 定位帧起点，逐帧解。实测单文件 55 帧、8.8 MB → 92 MB。

### 8.2 FTS5 三档分词器对中文的表现

**症状**：`MATCH '记忆'` 零命中，`MATCH '知识库'` 能命中。
**根因**：`trigram` 只给 ≥3 字符建索引，中文双字词直接堵死。
**修法**：默认分词器 + 写入前 bigram 预切，见 §6.4。

### 8.3 查询词元必须扁平化

**症状**：库里有这张卡，查「中文分词」查不到。
**根因**：`queryTokens` 曾把长 CJK 串包成一个 AND 组，召回降级时 `join(' OR ')` 只连了一个元素，组内仍是 AND。
**修法**：返回扁平列表，由调用方按 mode 连接；单字 CJK 用前缀 `字*`。

### 8.4 asar 里的包第三方插件 import 不到

**症状**：`Cannot find module '@deepseek-ai/dsh-tools'`。
**根因**：dsh 的包全在 `resources/app.asar` 内，profile 的 `node_modules` 里只有 `cosmokit` 和 `schemastery`。
**修法**：§6.5 的解析回退。`@deepseek-ai/schemastery` 例外，可直接静态 import。

### 8.5 同标题自动合并会覆盖不同项目的记忆（已修复）

**旧做法**：`WHERE hash=? OR title=?` 会因标题相同覆盖其他项目正文，也会使调用者算出的 id 指空。
**当前做法**：作用域内完整内容精确去重，返回真实 id；补充走显式修订，保留 id 与历史。固定来源的会话片段允许同源修订。详见修复记录 A01/A02/A06。

### 8.6 `node --test test/` 在 Node 24 报 MODULE_NOT_FOUND

**当前入口**：`npm test` 使用独立运行器枚举测试文件，并给所有 worker 设置临时 DSH 数据目录。

### 8.7 `pnpm add file:` 可能失败并牵连其他插件

**症状**：`I/O error while walking directory .../Xsdsh-purge/lib/wallpapers/*.mp4: 拒绝访问`，随后 `ops_bash` 报 bash.exe ENOENT。
**根因**：pnpm 重新 resolve 整个 profile 依赖树，扫到被占用的媒体文件就中断，`@dsh-ops` 的原生 payload 在重建中短暂消失。
**现状**：重试往往就好；`package.json` 不会同步，需手动 `cp`。装之前备份 `cordis.patch.yml` 和 `package.json`。
**本轮做法**：只 `cp lib/`，不走 pnpm。

### 8.8 面板没出现时怎么排查

1. `curl /api/dsh-kb/hub` —— 404 说明宿主端没加载，查 patch 条目和 `enabled`。
2. 浏览器控制台搜 `[dsh-kb]` —— `panel registration failed` 说明 slot 名不对。
3. 检查 `package.json` 的 `dsh.client`（`platform: web`）与 `exports["./client"]`。
4. 两个 panel 必须**不同 id**（`dsh-hub` / `dsh-kb`）：宿主按 `sidebar.panellist` 的 `id` 记住当前页，共用 id 时点谁都是同一页。
5. 兜底：`node bin/kb.js export`，双击 `~/.dsh/kb/preview.html`。

### 8.9 【本轮新】正则里的 `{0,200}` 会把最长最真的错误整行吃掉

**症状**：`front.log` 里明明有 `[render] Cannot read properties of null`，中枢「前端错误」显示 0 / 或者只显示一串 `ResizeObserver`。
**根因**：`/…\[(\w+)\] (.{0,200})$/` 的行长上界会让超长行**匹配失败**，不是截断。而带 `componentStack` 的崩溃行恰恰最长（实测 1040 字符）。
**修法**：整行收（`(.*)$`），超长内容在展示层截断；噪声按名单剔除并计数。
**教训**：任何"限制长度"的正则，先问一句"超了会怎样" —— 这里超了等于丢数据。

### 8.10 【本轮新】同一指标在两处各写一套 SQL，迟早对不上

**症状**：`project/code` 在「记忆」面板 429 张、在「中枢」232 张。
**根因**：`statsOf`（routes.js）与 `memorySection`（hub.js）各写了一份几乎一样的 group by，只差一个 `status='active'`。
**修法**：中枢一次查询同时出 `n` 与 `total`，页面显示 `232/429`；`/stats` 保留全量口径（它是"库里有啥"，不是"现在能用啥"）。
**教训**：数字类端点，要么复用同一个函数，要么在同一处把两个口径都算出来。

### 8.11 【本轮新】`try/catch` 兜住异常但什么都没留，就是"假绿"

**症状**：坏库（有文件、没表）下页面显示 "0 张卡 / 0 边"，而自检「库文件」是绿灯。
**根因**：`safe()` 返回 fallback，fallback 里的 `dbBytes` 仍然 > 0，检查项只看这个数。
**修法**：失败的块带 `error` 字段，`db` 项据此报 bad；测试用 8 KB 无表库钉住。
**教训**：兜底函数的返回值必须能和"真的没有"区分开。

### 8.12 【本轮新】会话清单缓存 30 秒，刚吸收完可能看不到

**症状**：跑完 `kb ingest` 立刻点刷新，「磁盘 754 个文件」没变。
**根因**：`cachedSessionFiles` 有 30 s TTL（真库全扫一次 47 ms，不缓存是浪费）。
**现状**：可接受 —— `ingested` 来自 `ingest_log`，是准的；只有磁盘文件数是滞后的。要立刻准，用 `buildHub({..., noCache:true})` 或等 30 秒。

### 8.13 【本轮新】插件层改动不重启不算改了

见 `docs/DESIGN.md` 与记忆库里的旧坑：包已装好但宿主加载的是旧模块，真机实测会把人引向"修一段本来就对的代码"。验证修复前先确认跑的是新代码：看 `plugin.log` 里 `entry: loaded` 的时间戳，或用"新代码独有"的探针（比如 `POST /hub` 现在返回 405，旧代码是 404）。

---

## 9. 已知缺口

按对"能不能放心用"的影响排序，每条给完成判据。

### 9.1 实体层（影响最大）

**现状**：`edge` 表里主要是 `contains`（会话卡 → 段卡），`mention` 600 多条只是实体提及，没有关系类型。
**缺什么**：从卡里抽实体（项目、文件路径、报错码、版本号、函数名）与 `uses / depends_on / contradicts`。
**判据**：给定一张 fix 卡，能沿 `depends_on` 走到它修的模块，再走到所有引用该模块的其他卡。

### 9.2 定时吸收

**现状**：手动 `kb ingest` 或面板点「吸收」。真库最近一次吸收在 2 天前 —— 中枢的「最近吸收」一直黄灯就是这件事。
**判据**：接 dsh 的 `schedule`，每天自动增量；失败有可见提示。

### 9.3 向量检索

**现状**：纯词法。中英异构查询会排错（`blender 材质` 命不中写着 `material` 的卡）。
**判据**：本机 Ollama 起 `nomic-embed-text`，fact 加 embedding 列，召回并进 RRF 融合。词法精排必须保留。

### 9.4 分类收敛

**现状**：`project/code` 429（232 在用）、`topic/dsh` 322（214 在用），两个枝吃掉七成卡。关键词规则的极限。
**判据**：能按实体（`dsh/plugin`、`dsh/ui`、`naraka/unpack`）二次细分，且不需人工逐张改。

### 9.5 面板渲染未在真机截图验证

**现状**：静态预览有两套主题（`docs/hub.png`、`hub-dark.png`），真机 GUI 从未截过。
**判据**：重启后打开「中枢」，六格都渲染、点星体开抽屉、搜索出结果；「记忆」面板四块（树/列表/详情/图谱）也都在。

### 9.6 HTTP 端点只做了 Origin 检查

**现状**：校验 `Origin`（同源 / 回环），无会话认证。`curl` 直接打能拿全部数据（含 `kb.db` 绝对路径、`front.log` 错误原文）。
**为什么这样**：GUI 本身 loopback，本机进程本来就读得到 `kb.db`，加认证挡不住本机用户。
**什么时候必须补**：接 `dsh-lan-pair` 之类把界面暴露到内网之前。判据：非回环来源 401，且与 harness 凭证校验一致。

### 9.7 【本轮新】中枢载荷里带本机路径

`status.db.file`、`sessions.disk.dir`、`status.frontLog.file` 都是绝对路径，`docs/hub.png` 里也能看到 `C:\Users\Remme\…`。单人仓库无所谓，公开分发前要么脱敏，要么由前端只在"展开详情"时才显示。

### 9.8 【本轮新】类型分布条被流水账淹没

记忆库块的类型条前六名是 `episode 454 / intent 328 / todo 132 / fact 86 / fix 84 / artifact 69` —— 人写的知识（fact/fix/decision）被自动抽取的流水账挤到看不见。
**建议**：加一个「只看知识卡」的切换，或在 `kinds` 里同时给 `knowledge` 计数。

### 9.9 【本轮新】7 天窗口会一直挂着旧错

`front.log` 里 2026-10-31 的 `POST /distill -> 503`、`GET /models -> 500` 会在窗口内持续点亮「前端错误」。这是 0.8.x 已修的问题留下的历史记录。
**建议**：给 `checks` 加一条"错误是否在最近 24 h 内"，或允许手动 dismiss。

---

## 10. 下一步（按顺序）

1. 阅读修复记录与本次增量。发布前在实际库的一致性副本上检查旧路径、悬空边与混合时间；本次尚未对实际库操作。
2. 安排安装时保留旧代码和迁移前数据库备份，再同步完整源码、验证宿主的真实工具与两个面板。v4 数据库不可交给旧 Python/Node 写入器继续写。
3. 提交/推送仅在发布流程中安排，避免将本地报告快照和原有未提交内容无差别一起提交；这次没有提交或推送。
4. 后续效果评估：建立脱敏问答集，验证命中、证据支持和跨项目误召回；界面候选仍见 §9.7–9.9。

---

## 11. 回滚

```bash
# 1. 从 profile 配置里删掉 dsh-kb 那段 insert，或用备份覆盖
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-dsh-kb-20261031-021926 \
   ~/.dsh/profiles/desktop/cordis.patch.yml

# 2. 卸载包
cd ~/.dsh/profiles/desktop && pnpm remove dsh-kb

# 3. 重启 dsh
```

**数据不受影响**：`~/.dsh/kb/kb.db` 是独立文件，卸载插件不删数据。想彻底清掉再删它（连带 `kb.db-wal` / `-shm`）。

---

## 12. 目录里那些不是插件的东西

`~/.dsh/kb/` 里除了数据库还有原型期产物，**当前建议保留**：

| 文件 | 是什么 | 状态 |
|---|---|---|
| `kb.db` | 数据库 | **活的**，插件和 CLI 都在用（7.33 MB + 1.6 MB WAL） |
| `mirror/` | Markdown 投影 | 1205 个文件，由 `kb mirror` 生成，可 git |
| `front.log` | 前端错误日志 | 客户端上报，服务端截尾 200 行 |
| `plugin.log` | 插件运行日志 | 排障第一现场 |
| `preview.html` | 静态导出 | 可随时重生成 |
| `kb.py` / `kb_mcp.py` / `seed.py` | Python 原型（同 schema、同算法） | 已被 Node 插件取代，仅作参考 |
| `kb.db.bak-l2-20261031-192301` | 老备份 | 保留 |

这段互操作描述只适用于历史 schema。**v4 之后旧 Python 原型与旧版 Node 写入器不能继续共写迁移后的库**；需要回滚时，应配套恢复迁移前的一致性数据库备份和旧代码。
