# Changelog

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
