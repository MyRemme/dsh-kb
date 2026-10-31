# Changelog

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
