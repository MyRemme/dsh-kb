# Changelog

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
