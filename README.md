# dsh-kb

[![npm](https://img.shields.io/npm/v/dsh-kb)](https://www.npmjs.com/package/dsh-kb)
[![node](https://img.shields.io/node/v/dsh-kb)](https://nodejs.org)

**本地长期记忆库 for DeepSeek Harness.** 把每次会话里"想明白的事"沉淀成不可变的事实卡，让下一次会话不必从零开始。

零外部依赖：只用 `node:sqlite` 和 `node:zlib`。库是一个 SQLite 文件，随你备份、迁移、直接 `sqlite3` 打开看。

```
               fact 账本（唯一真相）
               一行 = 一条不可变事实卡
                          │ 投影（全部可重建）
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
    node 骨架树      edge 关系图        FTS 索引
    多归属、摘要=缓存  1跳扩展、演化链    bigram + 覆盖率精排
```

---

## 为什么

长期记忆会以三种方式失败，多数方案只防第一种：

| 失败 | 表现 | 防它的机制 |
|---|---|---|
| **遗忘** | 问"上次那个怎么弄的"，答不上 | 索引 + 检索 |
| **失真** | 记得，但记错了；摘要层层压缩后偏离原意 | 卡不可变 + 回指原文 + 摘要可重算 |
| **腐烂** | 旧结论还在，被当成现行方案 | status + supersedes 边 + 时间衰减 |

这套设计的权重是 **失真和腐烂 > 召回率**：召回差了你换个词再查一次就行，记错了你会照着错的干。

## 为什么不是纯树、也不是纯向量

**纯树的三种死法**：单父挂载在跨主题会话上必错（一个会话常常横跨四个主题）；分类成本随规模线性上涨，写到第 500 条时你花在"该归哪"的时间超过知识本身；表达不了"这条已被那条推翻"。

**纯向量/纯图的三种死法**：返回一堆语义像但没用的碎片；没有层级 = 无法做范围限定（"只看 dsh 相关的"）；没有锚点去重，无限膨胀，不知道哪些过期。

所以真问题不是选哪个，是 **谁做真相、谁做索引**。这里 `fact` 表是唯一真相，树和图都是它的投影，随时可重建。

## 安装

```bash
# 在 dsh profile 目录
cd ~/.dsh/profiles/desktop
pnpm add dsh-kb
```

插件自带 `cordis.patch.yml`，装完重启 dsh 即生效。也可以手动插入：

```yaml
- insert:
    - id: dsh-kb
      name: dsh-kb
      config:
        enabled: true
        dbPath: ""          # 留空 → $DSH_HOME/kb/kb.db
        maxResults: 6
        promptSection: true
```

## 工具

| 工具 | 作用 |
|---|---|
| `kb_search` | 检索。用户说"之前/上次/我们说过/继续"时先调 |
| `kb_add` | 写一条卡。一个可独立陈述的结论 = 一条卡 |
| `kb_tree` | 看骨架树：每枝多少卡、最近更新、代表卡 |
| `kb_stats` | 健康度：卡数、类型分布、路径分布、边数 |
| `kb_ingest` | 增量吸收本机会话（幂等，可反复跑） |

插件还会向系统提示注入一段记忆纪律，规定什么时候必须查、什么时候必须写。

## CLI

插件工具给模型用，CLI 给人和脚本用。

```bash
npx dsh-kb init
npx dsh-kb ingest [--limit N] [--rescan]     # 扫 ~/.dsh/sessions/*.jsonl.zstd
npx dsh-kb search "中文分词 方案" -k 6
npx dsh-kb search "zstd" --path topic/dsh --json
npx dsh-kb add --title "结论" --body "正文" --path topic/dsh --kind decision
npx dsh-kb tree topic --summary
npx dsh-kb stats
npx dsh-kb show f_0d06e6d4155a92
npx dsh-kb forget f_0d06e6d4155a92      # 标记失效，不删
npx dsh-kb reindex
```

环境：`DSH_HOME`（默认 `~/.dsh`）、`DSH_KB_HOME`（默认 `$DSH_HOME/kb`）。

## 素材从哪来

`kb_ingest` 读 `$DSH_HOME/sessions/<cwd-tag>/<session-id>/session.v*.jsonl.zstd`。两个非显然的事实：

1. 文件是**多帧 zstd**（一个会话几十帧）。Node 的 `zstdDecompressSync` 一次性只解第一帧，你只会拿到一个 session header —— 这是最容易被误判成"文件损坏"的坑。本插件按 magic 扫帧边界逐帧解。
2. 事件流里真正有用的是四种：`session` header、`session/title`、`compaction/summary`、`user/message`。其余（`tool/call`、`step/start`）是过程，不是知识。

抽取只做"已经写在会话里的事实"。**"为什么"不从这里推** —— 那必须由模型在当场用 `kb_add` 写下，否则抽出来的是幻觉。这条分工是整套系统可信度的地基。

实测：219 个会话 / 225 MB 压缩 / 6.9 秒 / 676 张卡 / 零错误。

## 检索怎么打分

```
召回：FTS5(bigram) AND → 不足退 OR → 子串 LIKE 兜底 → 图 1 跳扩展
精排：0.50·词覆盖率 + 0.22·标题命中 + 0.16·路径对齐 + 0.12·新颖度
      × status × confidence × kind_bonus
```

不吃 LLM，纯算。中文必须做 bigram 预分词：FTS5 的 `trigram` tokenizer 只给 ≥3 字符建索引，「记忆」「材质」这类双字词直接检索不到，而中文里双字词占绝大多数。

## 维护纪律

一条卡好不好，只有一个测试：**下次会话的我在不知道上下文的情况下读到它，能不能直接照做？** 不能就重写。

一个库好不好：问"是什么"能答（卡）、"为什么"能答（decision 卡 + 图）、"什么时候放弃的、换成什么"能答（superseded + supersedes 边）、"继续上次"能找回原话（`source_ref` 回指原会话）。

## 许可

MIT
