# dsh-kb 交接文档

> 状态时间：2026-10-31
> 仓库：https://github.com/MyRemme/dsh-kb ｜ 本地：`D:\Code\dsh-kb` ｜ 安装位置：`~/.dsh/profiles/desktop/node_modules/dsh-kb`

---

## 0. 三十秒速览

| 问题 | 答案 |
|---|---|
| 这是什么 | DeepSeek Harness 的本地长期记忆库。把会话里想明白的事沉淀成不可变事实卡，下次会话不用从零开始 |
| 现在能用吗 | **能。** 已装在本机 profile 并加载成功，`GET /api/dsh-kb/stats` 返回真实数据 |
| 库在哪 | `~/.dsh/kb/kb.db`（SQLite，单文件，随时可备份/迁移） |
| 装了什么 | 5 个模型工具 + 1 个侧边栏面板 + 8 个 HTTP 端点 + 1 个 CLI + 静态导出 |
| 当前数据量 | 695 张卡 / 219 个已吸收会话 / 469 条边 / 20 个树节点 |
| 依赖 | 零外部依赖。只用 `node:sqlite` + `node:zlib`（Node ≥ 22.19） |
| 测试 | 33 项，全绿。`node --test "test/**/*.test.js"` |

---

## 1. 当前状态

### 已经在跑

- 插件在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里有一条 `insert` 条目，`enabled: true`。
- 宿主端路由已注册（实测 `curl http://127.0.0.1:8317/api/dsh-kb/stats` 返回 200 + 真实 JSON）。
- 系统提示注入生效：模型会被要求在"之前/上次/我们说过"时先 `kb_search`，在产出结论时 `kb_add`。
- 侧边栏存在「记忆」入口（`sidebar.panellist`，order 32）。

### 已验证到什么程度

| 项 | 验证方式 | 结果 |
|---|---|---|
| 全量吸收会话 | `kb ingest` | 219 会话 / 225 MB 压缩 / 6.9 秒 / 676 卡 / 0 错误 |
| 中文检索 | 单测 + 实机 | 「记忆」「材质」等双字词可命中（trigram 做不到） |
| HTTP 全部端点 | `test/http.test.js`，真 server + 真 fetch | 10/10 |
| 插件装配 | `test/plugin.test.js`，resolve hook 替身 dsh 内部包 | 工具注册 / 路由注册 / 卸载清理全部断言 |
| 原生工具执行 | 同上 | `kb_add` → `kb_search` 端到端打通 |
| 静态导出 | 解析产物 HTML | 690 卡 / 19 节点 / 469 边，内联脚本可编译 |

### 没验证

**面板在浏览器里的实际渲染没有截过图。** 数据通道和模块格式都按 `dsh-skill-manager` 的既有范式写的，但 UI 是否真的挂上侧边栏，需要在 GUI 里点一下确认。这是唯一没有被自动化覆盖的环节。

如果面板没出现，排查顺序见第 6 节最后一条。

---

## 2. 代码地图

```
lib/
  store.js    275 行  SQLite schema、去重双键、FTS 同步、edge/node 写入
  segment.js   78 行  中文 bigram 分词、查询词元、精排用意图词
  search.js   207 行  召回（FTS/LIKE/图扩展）→ 精排（覆盖率加权）→ 渲染
  session.js  249 行  多帧 zstd 解压、事件流解析、事件 → 卡
  ingest.js    96 行  增量流水线：扫文件 → 抽卡 → 建边 → 记日志
  digest.js    65 行  树节点摘要（可重算的缓存）
  tool.js     101 行  defineTool 官方优先 + 本地等价回退
  http.js      88 行  路由描述符、JSON 收发、来源校验
  routes.js   171 行  /api/dsh-kb/* 八个端点
  export.js   345 行  静态 HTML 导出（自包含，数据内嵌）
  client.js   545 行  浏览器端面板（module-loader 格式，零构建）
  index.js    258 行  插件入口：Config、5 个工具、路由挂载、提示注入
bin/kb.js     242 行  CLI（11 个子命令）
test/         446 行  33 项
```

**改之前先看**：

- `store.js` 的 `upsertFact` 是唯一写入口。任何写入路径（抽取、工具、CLI、HTTP）都过它，所以幂等和去重只需要在这里保证一次。
- `search.js` 的 `queryTokens` 返回**扁平**词元列表（见 6.3），改动时别退回"整串包一组"。
- `client.js` 不是普通模块，是 `window.__ModuleLoader__.load({ id, factory })`。里面不能用 `import`，`react` 靠 factory 参数拿到。

---

## 3. 数据流

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
   fact 表（唯一真相）  ──upsertFact──> 去重双键（内容哈希 OR 标题）
       │
       ├── node 树：paths 数组（多归属），digest 重算摘要
       ├── edge 图：contains（会话→段卡），可手加 supersedes/related
       └── fact_fts：中文 bigram 索引，查询侧同样 bigram 化
       ▼
   四条出口
       ├── 模型工具  kb_search / kb_add / kb_tree / kb_stats / kb_ingest
       ├── HTTP      /api/dsh-kb/*
       ├── 面板      lib/client.js
       └── 静态页    kb export → 单文件 HTML
```

---

## 4. 关键决策（含失败路径）

### 4.1 不做纯树、不做纯向量，`fact` 才是唯一真相

**决策**：fact 表存不可变事实卡；树、图、摘要、索引全是它的投影，随时可重建。

**为什么**：纯树死在单父挂载（一个会话经常横跨四个主题，挂哪都错）和分类成本（写到第 500 条时纠结"归哪"的时间超过知识本身）；纯向量死在无法做范围限定、无锚点去重、不知道哪些过期。

**如果反过来**：把分类写进卡的字段（单值），三个月后你会因为"不想决定归哪"而不再写卡，库就死了。实测证据：`topic/dsh` 一个枝吃了 283 张卡，因为它关键词太泛 —— 这就是纯树的成本现场。

### 4.2 自动抽取只提取事实，"为什么"必须当场写

**决策**：`ingest` 只从会话里拿"已经写下来的东西"；判断、取舍、"为什么不用 B"由模型用 `kb_add` 写。

**为什么**：从事件流反推理由，得到的是幻觉。而幻觉进了记忆库，比没有记忆更糟 —— 你会照着错的干。

**如果反过来**：让 LLM 对每个会话生成"决策摘要"，成本高且不可验证，还会污染已有真卡。

### 4.3 不删，只降权

**决策**：结论被推翻时 `status='superseded'`，检索权重 ×0.15，需显式 `includeSuperseded` 才可见。

**为什么**：删了就不知道"当初为什么放弃"，那通常比结论本身值钱。

### 4.4 中文必须 bigram 预分词

**决策**：写入前把 CJK 切成相邻两字、空格连接，FTS 用默认分词器。

**为什么**：FTS5 的 `trigram` 只给 ≥3 字符建索引，「记忆」「材质」这类双字词直接零命中；默认分词器把整段中文当一个 token。只有 bigram 预切能让任意双字词可检索，代价是索引约 2 倍。

### 4.5 `defineTool` 留解析回退

**决策**：`await resolveDefineTool()` —— 先 try 官方 `@deepseek-ai/dsh-tools`，失败回退 `lib/tool.js` 的等价实现。

**为什么**：该包只存在于 dsh 运行时的 asar 内，第三方插件在 profile 的 `node_modules` 下向上解析找不到它。但 `defineTool` 不能不用：它把参数方言 `{f:{type,required,description,enum}}` 转成标准 JSON Schema，并在 execute 前做参数校验。

### 4.6 界面给两套

**决策**：dsh 内嵌面板 + 静态 HTML 导出。

**为什么**：面板要重启才生效；静态页不用，还能当快照对比、还能发给别人看。面板加载失败时，静态页是唯一能确认"数据本身是对的"的通道。

---

## 5. 怎么跑

### 5.1 在 dsh 里

已经装好。改配置：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: dsh-kb
      name: dsh-kb
      config:
        enabled: true
        dbPath: ""            # 留空 → $DSH_HOME/kb/kb.db
        maxResults: 6
        promptSection: true   # 向系统提示注入记忆纪律
        ui: true              # 注册 /api/dsh-kb/* 路由
```

改完重启 dsh。

### 5.2 验证插件真的加载了

```bash
curl -s http://127.0.0.1:8317/api/dsh-kb/stats | head -c 300
```

返回 JSON 就是活的。404 说明插件没加载或被 `enabled: false` 关掉了。

### 5.3 CLI

```bash
cd D:/Code/dsh-kb

node bin/kb.js ingest                    # 增量吸收（幂等，可反复跑）
node bin/kb.js ingest --rescan           # 忽略 size/mtime 全量重扫
node bin/kb.js search "检索 分词" -k 6
node bin/kb.js search "zstd" --path topic/dsh --json
node bin/kb.js add --title "结论" --body "正文" --path topic/x --kind decision
node bin/kb.js tree topic --summary
node bin/kb.js stats
node bin/kb.js show f_0d06e6d4155a92
node bin/kb.js forget f_0d06e6d4155a92   # 标记失效，不删
node bin/kb.js reindex                   # 换了分词规则后必须跑
node bin/kb.js export [--out FILE]       # 静态 HTML，默认 $DSH_HOME/kb/preview.html
```

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_KB_HOME`（默认 `$DSH_HOME/kb`）。

### 5.4 开发

```bash
cd D:/Code/dsh-kb
node --test "test/**/*.test.js"     # 33 项，约 0.3 秒
```

没有构建步骤。`lib/client.js` 是浏览器端手写模块，改完直接同步到 profile：

```bash
cp D:/Code/dsh-kb/package.json ~/.dsh/profiles/desktop/node_modules/dsh-kb/package.json
cp -r D:/Code/dsh-kb/lib/. ~/.dsh/profiles/desktop/node_modules/dsh-kb/lib/
```

宿主端改动需重启 dsh；`client.js` 改动刷新页面即可（插件自己的 client 半不经过 apps/web 构建）。

---

## 6. 踩过的坑

按"下次再遇到会浪费多少时间"排序。

### 6.1 会话文件是多帧 zstd

**症状**：解析 `session.v4.jsonl.zstd` 只得到 1 行 `{"type":"session",...}`，看起来像文件损坏或会话是空的。

**根因**：一个会话文件里是几十个**连续 zstd 帧**。`zlib.zstdDecompressSync(buf)`（以及 `createZstdDecompress()` 的 pipe）只解第一帧就返回。

**修法**：扫 `28 B5 2F FD` magic 定位每个帧起点，对每个起点 `zstdDecompressSync(buf.subarray(off))` 逐帧解。实测单文件 55 个帧、8.8 MB → 92 MB。

### 6.2 FTS5 三档分词器对中文的表现

**症状**：`MATCH '记忆'` 零命中，`MATCH '知识库'` 能命中。

**根因**：`trigram` 只给 ≥3 字符建索引。中文里双字词占绝大多数，这条路直接堵死。

**修法**：默认分词器 + 写入前 bigram 预切。见 4.4。

### 6.3 查询词元必须扁平化

**症状**：明明库里有这张卡，查「中文分词」查不到。

**根因**：`queryTokens` 曾把长 CJK 串包成一个 `("中文" AND "文分" AND "分词")` 组返回。召回逻辑"先 AND 严召回、不足退 OR"，`join(' OR ')` 只连了一个元素，组内仍是 AND —— OR 降级完全失效。

**修法**：返回扁平列表 `['"中文"','"文分"','"分词"']`，由调用方按 mode 连接。单字 CJK 用前缀 `字*`。

### 6.4 asar 里的包第三方插件 import 不到

**症状**：插件加载报 `Cannot find module '@deepseek-ai/dsh-tools'`。

**根因**：dsh 的包全在 `resources/app.asar` 内（`asar/dsh/node_modules/@deepseek-ai/*` 是完整依赖树），profile 的 `node_modules` 里只有 `cosmokit` 和 `schemastery`。

**修法**：见 4.5 的解析回退。`@deepseek-ai/schemastery` 例外 —— pnpm 会装到 profile，可以直接静态 import。

### 6.5 去重只用内容哈希会漏合并

**症状**：同一结论补充了细节，库里长出第二张卡。

**根因**：`factHash(title, body)` 包含正文，正文一变哈希就变。

**修法**：去重查询改成 `WHERE hash=? OR title=?` —— 双键，内容重复和标题重复都拦。

### 6.6 `node --test test/` 在 Node 24 报 MODULE_NOT_FOUND

**修法**：用 glob：`node --test "test/**/*.test.js"`。

### 6.7 `pnpm add file:` 可能失败并牵连其他插件

**症状**：`I/O error while walking directory .../Xsdsh-purge/lib/wallpapers/*.mp4: 拒绝访问`。随后 `ops_bash` 一度报 bash.exe ENOENT。

**根因**：pnpm 重新 resolve 整个 profile 依赖树，扫到某个被占用的媒体文件就中断，`@dsh-ops` 的原生 payload 在重建过程中短暂消失。

**现状**：重试往往就好了（bash 自动恢复）。但 `package.json` 不会同步 —— 需要手动 `cp`。

**下次装之前**：备份 `~/.dsh/profiles/desktop/cordis.patch.yml` 和 `package.json`。已备份文件名 `*.bak-dsh-kb-20261031-021926`。

### 6.8 面板没出现时怎么排查

按这个顺序：

1. `curl http://127.0.0.1:8317/api/dsh-kb/stats` —— 404 说明宿主端没加载，检查 patch 条目和 `enabled`。
2. 浏览器控制台搜 `[dsh-kb]` —— 有 `panel registration failed` 说明 slot 名不对。
3. 检查 `package.json` 的 `dsh.client.inject` 是否包含 `dsh-client-ui-renderer` 和 `dsh-client-ui-layout`。
4. 检查 `lib/client.js` 是否在 `exports` 里暴露为 `./client`。
5. 仍然不行就用静态导出兜底：`node bin/kb.js export`，双击 `~/.dsh/kb/preview.html`。

---

## 7. 已知缺口

按对"记忆质量"的影响排序，每条写清完成判据。

### 7.1 实体层（影响最大）

**现状**：`edge` 表里只有 `contains`（会话卡 → 段卡）。没有实体抽取。

**缺什么**：从卡里抽实体（项目、文件路径、报错码、版本号、函数名）和 `uses / depends_on / contradicts` 关系。

**为什么重要**：现在回答"这个决策链为什么这么定"是断的 —— 只能说"某会话里出现过 X"，说不出 X 和 Y 的关系。

**完成判据**：给定一张 fix 卡，能沿 `depends_on` 走到它修的模块，再走到所有引用该模块的其他卡。

### 7.2 定时吸收

**现状**：手动 `kb ingest`，或者点面板上的「吸收」。

**完成判据**：接 dsh 的 `schedule`，每天自动跑一次增量；失败时有可见提示。

### 7.3 向量检索

**现状**：纯词法。中英异构查询会排错（`blender 材质` 命不中写着 `material` 的卡）。

**完成判据**：本机 Ollama 起 `nomic-embed-text`，给 fact 加 embedding 列，召回并进 RRF 融合。**注意**：这是补丁不是主干，词法精排要保留。

### 7.4 分类收敛

**现状**：`topic/dsh` 283 张、`project/code` 185 张，两个枝吃掉七成卡。这是关键词规则的极限。

**完成判据**：能按实体（如 `dsh/plugin`、`dsh/ui`、`naraka/unpack`）二次细分，且不需要人工逐张改。

### 7.5 面板渲染未截图验证

见第 1 节。完成判据：在 GUI 里打开「记忆」面板，树、列表、详情、图谱四块都能渲染，搜索能出结果。

### 7.6 HTTP 端点只做了 Origin 检查

**现状**：`/api/dsh-kb/*` 校验 `Origin` 头（同源 / 回环），没有会话认证。实测：首页要认证，但 `curl` 直接打 API 能拿到数据。

**为什么这样**：dsh 的 GUI 本身是 loopback 的，本机进程本来就能读 `~/.dsh/kb/kb.db`，加一层认证挡不住本机用户。

**什么时候要补**：如果将来接 `dsh-lan-pair` 之类把界面暴露到内网，这条必须先收紧 —— 那时候"本机"不再是可信边界。完成判据：非回环来源返回 401，且与 harness 的会话凭证校验一致。

---

## 8. 回滚

```bash
# 1. 从 profile 配置里删掉 dsh-kb 那段 insert，或用备份覆盖
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-dsh-kb-20261031-021926 \
   ~/.dsh/profiles/desktop/cordis.patch.yml

# 2. 卸载包
cd ~/.dsh/profiles/desktop && pnpm remove dsh-kb

# 3. 重启 dsh
```

**数据不受影响**：`~/.dsh/kb/kb.db` 是独立文件，卸载插件不删数据。想彻底清掉再删这个文件。

---

## 9. 目录里那些不是插件的东西

`~/.dsh/kb/` 里除了数据库还有原型期的产物，**当前建议保留、不要改**：

| 文件 | 是什么 | 状态 |
|---|---|---|
| `kb.db` | 数据库 | **活的**，插件和 CLI 都在用 |
| `preview.html` | 静态导出 | 可随时重生成 |
| `kb.py` / `kb_mcp.py` / `seed.py` | Python 原型（同 schema，同算法） | 已被 Node 插件取代，仅作参考 |
| `DESIGN.md` | 原型期的设计说明 | 内容已并入仓库 `docs/DESIGN.md` |

两份实现共用同一个 `kb.db`，schema 完全一致。这意味着 **`kb.py` 和 `bin/kb.js` 可以互操作** —— 迁移期做过实测，CLI 直接读原型建的库，695 张卡正常。
