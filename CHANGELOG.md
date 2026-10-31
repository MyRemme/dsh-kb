# Changelog

## 0.7.2

时间线的交互重做。原来的横向滚动条在 Windows 上又细又难拖，滚轮竖着滚完全不动 ——
40 条卡只能靠拖那根 8px 的条子翻。

**改了什么**

| 之前的蠢处 | 现在 |
|---|---|
| 滚轮竖着滚不动 | 竖向滚轮转横向滚动（到头就放行，让外层页面自己滚，不吃滚轮） |
| 只能拖滚动条 | 按住任意位置拖拽滑动，鼠标变 `grab`/`grabbing` |
| 拖动时会选中卡片文字 | `user-select: none` |
| 拖一下反而跳进详情 | 位移超过 4px 才判为拖拽，并吞掉这次 click |
| 看不出还有多少 | 头部显示 `显示数/总数`，两端渐隐 + `‹ ›` 翻页按钮（到头置灰） |
| 最多 14 条 | 40 条 |
| 滚动条难看 | 8px 细条，悬停加深 |

**一个实现上的坑**：React 的 `onWheel` 是 passive 的，`preventDefault()` 会被浏览器
忽略并在控制台警告。滚轮要转横向必须自己 `addEventListener("wheel", fn, { passive: false })`，
在 `useEffect` 里挂、卸载时摘。

测试仍 127 全绿。

## 0.7.1

三条用户报的问题，两条是真 bug，一条是体验欠账。

**1. 模型还是不能选 —— 根因是 cordis 的访问规则**

`/models` 和 `/distill` 双双 500。原因不是列不出来，是 `ctx.llm` 在 cordis 里
**没声明 inject 就访问服务会直接抛**（`cannot get property "llm" without inject`）。
本插件的 inject 只有 `tools`/`systemPrompt` —— 声明 `llm` 会让它在没有模型的宿主里
干脆不激活，所以不能那么写。

修法：
- `readLlm(ctx)`：先 `ctx.get("llm")`（不抛），再退回属性访问并用 try 兜住。
- `probeModels(llm)`：**形状自适应**。宿主没有稳定契约，不同版本可能是方法
  `listProviders()`、属性 `llm.providers`、或者包了一层 `{providers}`；模型同理
  （`listModels(id)` / `getModels(id)` / `entry.models` / `llm.models[id]`）。
  全试一遍，**任何异常都不外抛**。
- `/models` 兜底：列表失败也回 200 `{available:false}`，附 `debug` 探测轨迹，
  绝不让面板整页报红。

**2. 星图太简陋：没动画、点不动**

- 每颗星加**透明命中区**（半径 max(8, r+6)）：星体本身只有 2–5px，直接点一多半点空。
- 选中态画**脉冲光环**（`dkb-pulse`），一眼看出当前选的是谁。
- 进入时逐颗淡入（`dkb-fade`），悬停放大并提亮。
- 点星体 → 打开右侧详情抽屉（既有链路）。

**3. 骨架树状图根本渲染不出来**

`mode === "skeleton"` 时传的是 `facts: []`，而 `buildCanvas` 会**跳过没有卡的枝** ——
于是零个块，整个视图空白。修法：布局永远按完整 facts 算，渲染时再按 mode 决定
画卡片还是只画块框。

**顺手修的 flaky 测试**

`反灌：文件比库里新才覆盖` 偶发失败：刚写完的文件 `mtime` 与 `updated_at` 可能同毫秒，
靠"谁晚"判定会在边界上抖成 `updated=1`。测试改成显式把文件时间推旧 60 秒。

测试 125 → 127（`readLlm` 与 `probeModels` 两组，覆盖 cordis 抛错、五种宿主形状、全抛错）。

## 0.7.0

三个用户直接报上来的问题，全部落实。前两个是真 bug，第三个是我把需求做丢了。

**1. 图谱一点就崩**

`onMove` 在 `setView` 的 updater 里读 `drag.current`。updater 是延后执行的，
那时 `onUp` 可能已经把它置成 null —— 报的就是
`Cannot read properties of null (reading 'tx')`，整个图谱板块渲染失败。

修法：先在事件回调里把起始状态取成局部变量，updater 只碰局部值。两个视图（卡片 / 星图）都改了。

**2. 星图 + 树状混合图没了**

0.5.0 按设计稿把图谱换成卡片画布时，把**星图整个删了**。注释还写着"星图+树状混合"，
实现已经换成块网格 —— 需求被我自己做丢了。

现在三种视图并存，默认星图：

| 视图 | 看法 |
|---|---|
| **星图** | 径向树骨架 + 星体散布（0.4.x 的实现取回来，并补上父子枝连线） |
| 卡片 | 一个骨架路径一块，块内两列卡片 —— 看"每个枝里有什么" |
| 骨架 | 只留块的轮廓，看分类结构 |

星图这次真补了**骨架连线**：之前只有孤立的枝圆点和星体，看不出层级。现在从中心
`topic` 放射到各子枝有实线，径向树那一半才成立。

**3. 模型提炼没有模型选择，而且永远 503**

两个问题叠在一起：

- `createApi` 的 deps 里**根本没传 `distill`**，所以 `/distill` 永远回
  `503 没有可用的提炼通道` —— 跟宿主有没有模型无关，是端点自己没接线。
- 面板只有一个"模型提炼"按钮，直接 POST，没有任何 provider/model 选择。

修法：
- 后端把 `distill` 与 `listModels` 真正接进 `createApi`；`/distill` 透传
  `provider` / `model`；新增 `GET /api/dsh-kb/models`（第 19 个端点）列出宿主的
  provider 与各自模型。
- 面板点"模型提炼"先开一个浮层：provider 下拉 + model 下拉 + 限定枝 + 条数。
  宿主没有通道时明说"会退回出料，不假装成功"。

**基线图**

- `docs/canvas.png` —— 卡片视图
- `docs/canvas-star.png` —— 星图视图（`node tools/preview-star.mjs` 重新生成）

测试 124 → 125（星图布局：树骨架 2 条 + 归属线 3 条 + 事实边 1 条 + 深枝半径更大 + 确定性）。

## 0.6.6

把第二轮审查里"看了但没动"的风险全部修掉，并补一组 `test/hardening.test.js` 钉住。

**1. 500 不再外泄内部细节**

`handle` 的兜底分支原来把 `error.message` 直出（截 300 字），里面可能有 SQL 片段、
绝对路径、文件句柄信息。现在客户端只拿 `服务端错误（详情见宿主日志）`，
详情走 `console.error` 进宿主日志。4xx 的 `HttpError` 不受影响 —— 那些 message
是我们自己写的给人看的文案。

**2. `0.0.0.0` 从 LOOPBACK 集合移除**

它不是"本机"的同义词。浏览器几乎不会拿它当 Origin，留着只是白送一个可用的取值。

**3. 镜像目录必须落在 `$DSH_HOME` 的子目录**

之前 `rel === ""`（root 本身）是放行的，意味着一次请求就能把上千个 md 直接铺到
`$DSH_HOME` 根目录，跟 `profiles/` `sessions/` 混在一起。现在要求子目录。

**4. `/frontlog` 加去重节流**

前端一个渲染死循环可以每帧发一次上报。按 `level|message 前 200 字` 做 key，
5 秒窗口内重复只回 `{logged:false, throttled:true}`，不落盘；map 超 300 条时清过期项。

**5. 重操作互斥**

`ingest` / `distill` / `migrate` / `mirror` / `unmirror` / `sweep` 共用一把互斥，
第二次并发请求直接 409 `busy`。这些会扫全库或整个会话目录，并发跑起来既拖慢彼此，
也可能撞上同一个库写。fail-fast 比排队诚实。

**6. `/link` 的 note 限 500 字**

边上的备注没人读长文；8 MB 的 body 上限不该变成单条边的容量。

**审查里确认不用改的**

- `updateFact` 的正文截断**已经存在**（6000 字 + `…[truncated]`），和 `upsertFact` 一致。
- SQL 全部走 `?` 占位符；唯一的 `LIMIT ${n}` 由 `Number.isFinite` 把关，无注入面。
- 18 个路由都是 `exact`，`matchRoute` 的 prefix 分支目前是死代码 —— 保留它有测试覆盖，
  将来真要加前缀路由时不用重写。

测试 119 → 124。

## 0.6.5

第二轮审查：把"提炼"这条链路补成闭环。

**发现 1：distill 会反复抽同一批原料**

`collectMaterial` 按时间倒序取最新 N 段，**不排除已经提炼过的**。实测跑
`kb distill --path project/code` 抽到的 6 段全是刚写过卡的会话 —— 产出的只能是重复。

修法：`f.id NOT IN (SELECT dst FROM edge WHERE rel='derived_from')`，
留 `includeSpent: true` 作逃生口。

**发现 2：`kb_add` 根本不记录来源**

排除逻辑上了也没用 —— 结论卡写进库时没有 `derived_from` 边，distill 无从判断
"这段原料被提炼过"。真库上重跑一次 distill，原料一模一样。

修法：`kb_add` 加 `from` 参数（逗号分隔的来源卡 id），写入后自动建 `derived_from`。
`kb_distill` 的出料提示里也写明"每条都要带 from"，否则下一次还会喂同一批。

**发现 3：`safeDir` 装了但没生效**

用真机实测（`POST /mirror` 传 `C:/Windows/Temp/evil`、`.dsh/../.ssh`、`.dshx` 前缀）
**全部返回 200** —— 因为宿主跑的还是 0.6.2。对着源码单独验，越界全部 403。
教训：验证安全修复时，先确认被验的是新代码。

**审查里看了但没动的（都记录在案）**

- `handle` 的 500 分支把 `error.message` 直出给客户端，可能泄漏 SQL 片段或绝对路径。
  本机工具，风险低。
- `LOOPBACK` 集合含 `0.0.0.0`，作为 Origin 极少见。
- 所有 18 个路由都是 `exact`，`matchRoute` 的 prefix 分支实际是死代码（测试在用）。
- SQL 全部走 `?` 占位符，唯一的 `LIMIT ${n}` 由 `Number.isFinite` 把关；无注入面。

测试 118 → 119（`collectMaterial 默认排除已提炼过的原料`）。

## 0.6.4

检索排序改两段式：**结论卡先占位，原话不足时补充。**

**问题**

库里 82% 是流水账（episode / intent / todo / state / artifact）。实测查「配置」返回 3 条
全是 `[意图]`，结论卡一条没有。已有的置信度压制不够 —— `conf * kindBonus` 的差距只有
`0.85 / 1.1 ≈ 0.77`，压不住 bm25 的相关度优势。

**做法**

`DIARY_KINDS = {episode, intent, segment}`，排序后把候选分成两段：结论卡先占满 k 个名额，
不够时再用原话补；**每段内部仍按分数排**，相关性没丢。

不用加权的原因：加权要调一个说不清的系数，还会把极相关的原话彻底埋掉；分段的行为可解释
（"先给结论，不够再给原话"）。

**效果**（同一真库）

| 查询 | 改前 | 改后 |
|---|---|---|
| `配置` | 3 条全 `[意图]` | concept 打头 + 4 条原话补充 |
| `渲染` | 混排 | 5 条全结论卡 |
| `重启` | 原话 | 1 条 todo + 4 条原话（库里确实没有这条结论卡，不硬凑） |

结果对象加 `diary: true`，`why` 写成 `原话 · match N%`，调用方一眼分得清结论与原话。

**同时跑了另外两条线**

- **提炼通道**（`kb distill --path project/code --limit 6`）：出料 6 段，**全是用户原话节选**，
  相关结论卡早已存在 —— 提炼不出新东西。这是 `kb_distill` 设计红线（"为什么"必须当场写，
  从事件流倒推只能得到重复或幻觉）的实证，也说明原料选择该排除"已提炼过"的卡。
- **语义边**：用 `kb link` 在真库上建了第一批手工关系 —— `derived_from` ×2、
  `references` ×1。关系分布从"只有 produces 699"变成三种并存。

测试仍 118 全绿。

## 0.6.3

对一个已经"能用"的版本做审查，找出三处同源缺口。

**1. `cleanParam` 只堵了一半**

0.6.2 给 `/facts` 与 `/graph` 加了 `cleanParam`，但 `/search` 的 `path` 和 `/tree` 的 `prefix`
还在裸读。同一个静默空表会从另一个入口复发 —— 前端不再发了，历史缓存、第三方脚本、
手敲的 curl 还会发。

**2. 镜像端点可以往任意路径写**

`POST /mirror` 的 `dir` 直接来自 body，`mkdirSync` + `writeFileSync` 全套。本机进程当然能
写任何地方，但"能写任何地方"不该由一次 HTTP 请求决定。新增 `safeDir()`：API 侧只允许落在
`$DSH_HOME` 下面，越界返回 403 `dir-not-allowed`。CLI 不设这个限制 —— 那是用户本人敲的命令。

**3. 切类型 chips 可能得到空表**

列表只在 query / pathFilter 变化时重新请求，`/facts?limit=80` 永远取最新 80 张；
chips 只在**前端**过滤。于是"文档 68"这类分组只要它的卡不在最新 80 条里，切过去就是空表 ——
又一个静默空表，只是触发条件更隐蔽。

修法：`loadList` 与 `loadGraph` 都接受并上送 `group`，chips 变化触发重新请求；
前端过滤保留作兜底。

**审查时的实测数据**（真库 1215 张卡、端口 5712）

| 端点 | 耗时 |
|---|---|
| `/stats` | 13 ms |
| `/tree` | 71 ms |
| `/facts?limit=80` | 11 ms |
| `/graph?limit=400` | 9 ms |
| `/search?q=dsh&k=6` | 20 ms |

测试 116 → 118（`/search` 与 `/tree` 的 undefined 回归、`/mirror` 越界 403）。

## 0.6.2

真因找到：**面板一直在正常工作，只是它把所有查询都发成了 `path=undefined`。**

`new URLSearchParams({ path: undefined })` 会产出**字符串 "undefined"**，后端把它当成路径前缀去
`LIKE 'undefined%'`，于是匹配 0 条。表现恰好是"树有数据、chips 有数字、列表和画布全空"——
因为 `/tree` 和 `/stats` 不带这个参数，而 `/facts` 与 `/graph` 带。

实测对照（真库 1206 张卡）：

```
/facts?limit=3&status=active                → total=1206  ✓
/facts?limit=3&status=active&path=undefined → total=0     ✗  ← 面板实际发的
/graph?limit=5                              → nodes=5     ✓
/graph?limit=5&path=undefined               → nodes=0     ✗
```

**修法（两边都堵）**

- 前端：新增 `buildQuery()`，过滤 `undefined` / `null` / 空白串；`call()` 一律走它。
  导出成 `__query` 供测试钉住。
- 后端：新增 `cleanParam()`，把 `"undefined"` / `"null"` / 空串当成"没给"，
  `/facts` 与 `/graph` 的四个筛选参数全过一遍。前端万一再发垃圾，也不至于整页空表。

测试 115 → 116（`GET /facts 把 path=undefined 当成没给`）。

**这也解释了 0.6.1 的 front.log 为什么没有 render/api 错误**：请求全部成功（200），
只是返回了空结果集。真正该被记下来的是"带 undefined 的查询串"，而不是"请求失败"。

## 0.6.1

0.6.0 装好后用户反馈"面板只有框架、没有实际内容"。这一版把**看不见的失败**变成看得见的：

- **前端错误上报**：`POST /api/dsh-kb/frontlog`（第 18 个端点）写 `$DSH_HOME/kb/front.log`。
  client 里加了 `window.onerror` / `unhandledrejection` / 所有 API 失败 / React 渲染兜底
  四处上报 —— 面板白屏时最麻烦的不是报错，是没人看得见报错，浏览器控制台不会有人去翻。
- **渲染兜底 `Boundary`**：组件树里任何一层抛错都显示成一行红条 + "详情已写入 front.log"，
  而不是整页空白。`React.Component` 不可用时降级成透明包装，至少不连坐。
- **高度兜底**：`.dkb-stage` 给 `min-height:280px`、`.dkb-root` 加 `overflow:hidden`。
  之前整条高度链依赖父容器给出确定高度，父容器不给就会塌成"只有工具栏和 chips"。
- **去掉 `React.Fragment`**：改用 `.dkb-drawer-inner` 这一层真实 div，少一个对 React
  完整度的假设。
- **顶栏数字兼作连通性指示器**：拿不到 stats 时显示"连不上后端"，拿到时显示
  `1206 卡 · 696 边` —— 一眼区分"前端没连上"和"连上了但画不出来"。
- `injectStyle()` 提前到 `apply()`，避免首帧无样式导致的尺寸误判。

测试 114 → 115（新增 frontlog 端点落盘断言）。

## 0.6.0

语义模型（L2）：把"一堆事实卡"变成"有类型、有关系"的知识图谱。

**1. 展示分组落库（`fact.grp`）**

kind 回答"这条东西是什么形态"（fix / episode / artifact…），grp 回答"它该出现在哪个抽屉里"
（记忆 / 文档 / 对话 / 项目 / 任务）。派生规则在 `groupOfFact(kind, path)`，落库是为了让
`/facts?group=` 与 `/graph?group=` 能走索引，而不是取 400 张卡再在前端筛。

顺序有讲究：先按 kind 判具体类别，再看 `project/` 前缀 —— 否则 `project/code` 下的
一条 fix 会被塞进"项目"抽屉。前端 `groupOf` 与后端 `groupOfFact` 的一致性由测试穷举钉住。

真库迁移结果：`talk=728 / memory=213 / task=105 / project=90 / doc=68`。

**2. 九种语义关系**

`REL_KINDS` 白名单：包含 / 关联 / 取代 / 来源于 / 产生 / 引用 / 转化 / 应用于 / 影响。
对外建边走新函数 `linkFacts(db, src, dst, rel)`，它**拒绝**拼错的关系名、自环、指向不存在的卡。
理由：一条 `rel="supersede"` 的哑边在图上和真边长得一样，比没有边更糟。

- 工具 `kb_link`（第 10 个）+ `POST /link` + `kb link --src --dst --rel`
- 端点 `POST /migrate`（重算分组 / 改名老边，幂等）+ `kb migrate`

**3. `contains` → `produces`**

老库里 696 条边全是"会话卡 → 抽出的卡"，语义是**产生**不是**包含**。迁移一次性改名
（`user_version` 3）。现在 `rels: produces=696` —— 库里没有任何"归属"类边，因为一条都
没造过；那类边要靠 `kb_link` 显式建，不自动编。

**4. `/graph` 的两个真 bug**

- `SELECT` 里没有 `tags` / `confidence`，但 map 里在用 —— 卡片上的标签 chips 一直是空的；
- 不认 `group` 参数。

**5. 踩到的升级路径坑**

`CREATE INDEX ... ON fact(grp)` 一开始和其他索引一起写在 `SCHEMA` 里。新库没事（建表时就有列），
老库直接 `no such column: grp` —— 因为 `SCHEMA` 先执行，而 `ALTER TABLE` 在后面的 `migrate` 里。
索引挪进 `migrate`，等列补上再建。

**验证**

- 114 项测试全绿（新增 `test/semantics.test.js` 6 项：分组映射矩阵、写入/改名跟随、
  backfill 幂等、九种关系、老库边改名、**前后端分组规则穷举比对**）。
- 真库迁移 178 ms；迁移后镜像往返仍幂等（`updated 0 / unchanged 1204`）。
- `kb stats` 改用 `statsOf`，与 `GET /stats` 同一份数字（之前 CLI 自己拼了一份，少了 groups/rels）。

## 0.5.0

界面重排（L1）：把"树 / 列表 / 星图"三栏换成「卡片画布 + 右侧抽屉 + 底部时间线」。

**重写的东西**

- `buildGalaxy`（径向树 + 圆点星体）→ `buildCanvas`（卡片布局）。
  一个骨架路径一块，块内两列卡片网格，块按行排、每行三块。
  块的包围关系直接表达分类，不再需要"块心 → 卡"的归属线。
- `GraphPane` 重写：卡片节点（图标 + 类型·日期 + 标题 + 标签 chips）、
  卡片之间的贝塞尔连线 + 中文关系胶囊、滚轮缩放、拖动平移、以视口中心为锚点的
  加减缩放、适应画布、全屏。首次渲染自动 fit 一次（否则 1550×1294 的画布只能看到一角）。
- `DetailPane` → `DetailDrawer`：右侧 400px 抽屉，信息架构照设计稿排
  （身份 → 标签 → 摘要 → 相关节点 → 来源对话 → 属性 → 历史 → 动作条）。
- 新增 `Timeline`：底部时间线，四个 tab（时间线 / 相关对话 / 相关文档 / 相关任务），
  卡片按 ts 倒排。图谱看"关系长什么样"，时间线看"最近发生了什么"，两者排序互相矛盾，
  塞一个视图里谁都看不清。
- 顶部类型 chips：把十种 kind 收成设计稿那五类（记忆 / 文档 / 对话 / 项目 / 任务），
  带数量，过滤在图与列表上同时生效。

**每块只铺前 6 张卡**

一个枝装几百张卡，不限量就把画布拉成 14758px 高（实测），完全没法看脉络。
块标题显示 `显示/总数`（如 `project/code · 162`），要看全量走列表或点枝筛。

**后端小改**

`/graph` 的节点补了 `tags` 与 `confidence` —— 卡片要画标签 chips，不能只给标题。

**删掉的死代码**

旧的 `.dkb-graph` / `.dkb-gbar` / `.dkb-legend` / `.dkb-hublabel` / `.dkb-star` 样式，
以及只为三点散布服务的 `hash32`。

**外壳改不了**

设计稿的顶部四 tab（对话 / 记忆 / 知识库 / 工作流）与左侧八项侧栏属于 App 外壳，
插件只占 `sidebar.panellist`（图标）+ `main`（页面）。所以本次只做"页面内部长得像"。

**验证**

- 108 项测试全绿；布局测试改为断言"卡片落在所属块内、块不重叠、确定性、
  空归属线为 0、事实边带中文标签"。
- 用 headless Edge 对真库数据（11 枝 / 400 卡）渲染截图核对视觉，截图过程脚本化可复现。

## 0.4.0

Markdown 镜像层（L3 剩下那半）：`kb.db` 仍是唯一真身，`mirror/` 是给人和 `git` 看的投影。

**为什么加**

「长期记忆」和「本地知识库」是一个包里的两条能力线（不拆插件），但只有 SQLite 时，
知识库那半是隐形的：6 MB 二进制，人读不了、进不了 git、换机器得整包搬。
图3 那种「Markdown 记忆文件 + SQLite 知识数据库」的双层，缺的就是上面那层。

**新增**

- `lib/markdown.js`：`mirrorToDir` / `importFromDir` / `planMirror` / `readMirror` /
  `renderFactFile` / `parseFrontmatter`（自写，零 YAML 依赖）/ `normalizeBody`。
- `kb_mirror` 工具（第 9 个）+ `/api/dsh-kb/mirror` `/unmirror`（第 14、15 个端点）。
- CLI：`kb export --md [--dir] [--dry]`、`kb import --md [--dir] [--force] [--dry]`。
- 配置项 `mirrorDir`（默认留空 = 库旁边的 `mirror/`）。

**四条刻意的行为**

| 行为 | 原因 |
|---|---|
| 按 `id` 匹配已有文件，标题改了只改名 | 否则 git 里全是删一个加一个 |
| 内容没变不写盘 | 时间戳噪声会淹没真 diff |
| 库里已没有的 id 移进 `.trash/` | 删除不该在一次导出里发生 |
| 导入只认比库里新的文件，`--force` 才全灌 | 重新 clone 旧镜像不该把库回滚 |

**两个踩到的坑（都在测试里钉住了）**

- **CRLF**：`parseFrontmatter` 拆行后用 `\n` 重拼，带 `\r\n` 的正文一往返就被判成
  「被改过」——真库上 1199 张里有 30 张中招。修法是渲染与比较两条路都折成 LF，
  库里原字节不动。
- **`upsertFact` 不认外部 id**：它按内容哈希生成 id，而镜像里的 id 是既成事实
  （别的卡可能已有 `edge` 指向它）。新增 `insertFactWithId`，`f_` + 8 位以上十六进制
  才沿用，格式不合法退回内容哈希。

**实测**（真库 1199 张）

- 首刷 674 个改名 + 525 未变，708 ms；二刷全 `unchanged`。
- 导回零改动：`created 0 / updated 0 / stale 0 / unchanged 1199`。
- 镜像共 1200 个文件（1199 卡 + README），2.1 MB。

**测试** 90 → 108（新增 `test/markdown.test.js` 15 项 + 端点 2 项）。

## 0.3.3

修 0.3.2 的一处致命疏漏：**`lib/entry.js` 还留着 `export default apply`**。

`package.json` 的 `main` 指向 entry.js，而 cordis 加载器用 `unwrapExports()`
（`exports = exports.default ?? exports`）取插件 —— 一旦有 default，它拿到的就是
裸函数，挂在命名导出上的 `inject` / `name` / `Config` 全部丢失。后果：

- `inject = ["tools", "systemPrompt"]` 丢 → 宿主里每次 `ctx.tools.register()` 抛
  `cannot get property "tools" without inject`，**8 个工具一个都挂不上**，两段系统
  提示也不注入；
- 但 HTTP 路由不依赖 inject，照常注册 —— 所以 `/api/dsh-kb/stats` 返 200 且带真
  数据，看起来像"装好了"，实际只剩三分之一；
- 客户端半同理：`exports.inject = ["slots"]` 丢会让入口停在 loading。

0.3.2 已经删掉了 `lib/index.js` 与 `lib/client.js` 的 default，唯独漏了真正被
`main` 指向的那一个。

**修复**

- `lib/entry.js`：删掉 `export default apply`；`name` / `inject` 改为优先取真实现
  （`impl?.inject ?? 兜底`），避免两份声明漂移。
- `test/exports.test.js`：新增两项 —— entry 包装层的 default/inject 断言，
  以及**扫描 `lib/` 全部模块**禁止 `export default` / `exports.default =`。
  这样以后新增文件也不可能再漏。

## 0.3.0

改名 `@myremme/dsh-kb`（npm 上 `dsh-kb` 是别人的包），补上"可改、可查全、会过期"三件事。

**改名**

- 包名 `dsh-kb` → `@myremme/dsh-kb`；客户端 bundle 的注册 id 同步为包名（模块表按"条目名 == 包名"索引）。
- 行 id / 面板 id / API 前缀仍是 `dsh-kb`，老库、老面板、老 curl 不受影响。

**可改**

- `kb_update` / `POST /api/dsh-kb/update`：**id 不变**，旧正文按版本快照进 `fact_history`。
- 只改状态/标签/路径不算新版本（版本记的是内容）。
- `kb_get` / `GET /history` 能读回历史。

**可查全**

- `kb_get`：全文 + 历史 + 入/出边 + 实体提及。
- `kb_search` 增加 `kinds` / `since` / `session` / `entity` / `includeStale` 过滤。
- `kb_add` 自动落 `session_id` 与 `cwd`（来源可追溯，`kb_search session:` 能按会话找）。

**会过期**

- 快照型卡（todo/state/artifact/segment/episode）写入即低置信（0.35）。
- `sweepStale`：超过 `staleDays`（默认 30）的快照卡降级为 `doubtful`，默认检索不再返回。
- 开库、`kb_ingest`、`POST /sweep` 三处都会触发降级。

**体验**

- 开场注入：每轮现算最近 `bootFacts` 张卡（默认 6）进系统提示。
- 定时吸收：`ingestEveryMinutes`（默认 0 关闭）。
- 面板可新建卡、可标失效，详情里有历史版本与实体提及。

**数据**

- 新增 `fact_history` / `mention` 两张表；`fact.version` 列，老库自动 `ALTER TABLE` 补列。
- 测试 49 → 72 项。

## 0.2.0

补上"看得见"的一半：面板、HTTP、静态导出。数据层一行没动，`kb.db` 向后兼容。

**界面**

- 侧边栏「记忆」面板（`lib/client.js`，手写 `window.__ModuleLoader__.load`，无构建步骤）：树 / 列表 / 详情 / 图谱四块。
- 图标走 `sidebar.panellist`（order 32），页面走 `main`（key 与面板 id 同名）。
- 图谱用单环 + 按路径排序，不引第三方力导向库。

**HTTP**

- 八个端点 `/api/dsh-kb/*`：stats / search / tree / facts / fact / graph / add / ingest。
- 来源校验：同源或回环放行；非 GET 要求严格同源；`Sec-Fetch-Site: cross-site` 一票否决。
- 统一信封 `{ok,data}` / `{ok:false,error:{code,message}}`，面板与 curl 看到同一种失败形状。
- `webServer` 是可选依赖（`ctx.inject`）：headless 组合里没有它，工具照常装载。

**导出**

- `lib/export.js`：单文件 HTML，数据内嵌为 `<script type="application/json">`，`<` 转义成 `\u003c`。
- CLI 新增 `kb export [--out FILE] [--limit N]`。

**测试**

- 22 → 49 项。新增 `test/http.test.js`（裸 http 服务器 + 真 fetch）与 `test/export.test.js`。
- `test/plugin.test.js` 覆盖路由注册/卸载、`ui:false`、无 `ctx.inject` 的老运行时、客户端 bundle 的 slot 注册。

## 0.1.0

首个版本。从 Python 原型移植为纯 Node 插件，零外部依赖。

**结构**

- `fact` 账本为唯一真相，`node` 骨架树与 `edge` 关系图为可重建的投影。
- 路径多归属（`paths` 数组），`path` 仅作主展现，避免"一条卡只能挂一个枝"的强迫分类。
- `status` 三态（active / superseded / doubtful），旧结论降权而非删除。
- 写入时建边（`contains`），不做事后批处理。

**检索**

- 中文 bigram 预分词 + FTS5，解决 trigram 对双字中文词失效的问题。
- 精排为纯计算：词覆盖率 / 标题命中 / 路径对齐 / 新颖度，加权 status、confidence、kind。
- 图 1 跳扩展补上下文。

**抽取**

- 多帧 zstd 逐帧解压（单次 `zstdDecompressSync` 只解第一帧，只能拿到 session header）。
- 从 `compaction/summary` 的分段结构直接得到知识原子，不额外调用 LLM。
- 过滤 `runtime-context` 与 `system-reminder`，它们每次都一样，不是知识。
- 幂等：`ingest_log` 的 size/mtime + 内容哈希，重跑只更新不重复。

**工具**

`kb_search` / `kb_add` / `kb_tree` / `kb_stats` / `kb_ingest`，并注入记忆纪律系统提示。
