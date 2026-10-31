# dsh-kb

**DeepSeek Harness 的本地长期记忆库。** 把每次会话里"想明白的事"沉淀成不可变的事实卡，让下一次会话不必从零开始。

零外部依赖：只用 `node:sqlite` 和 `node:zlib`。整个库是一个 SQLite 文件，随你备份、迁移、用 `sqlite3` 直接打开看。

```
               fact 账本（唯一真相）
               一行 = 一条不可变事实卡
                          │ 投影（全部可重建）
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
    node 骨架树      edge 关系图        FTS 索引
    多归属、摘要=缓存  1跳扩展、演化链    bigram + 覆盖率精排
```

详细取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 装

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-kb
```

插件自带 `cordis.patch.yml`，装完重启 dsh 生效。

## 用

界面两套：侧边栏「记忆」面板（树 / 搜索 / 图谱），以及 `npx dsh-kb export` 产出的单文件 HTML —— 后者双击就开，不依赖服务。

给模型的五个工具：

| 工具 | 作用 |
|---|---|
| `kb_search` | 检索。用户说"之前 / 上次 / 我们说过 / 继续"时先调 |
| `kb_add` | 写一条卡。一个可独立陈述的结论 = 一条卡 |
| `kb_tree` | 看骨架树：每枝多少卡、最近更新、代表卡标题 |
| `kb_stats` | 健康度：卡数、类型分布、路径分布、边数 |
| `kb_ingest` | 增量吸收本机会话（幂等，可反复跑） |

给人用的 CLI：

```bash
npx dsh-kb ingest                       # 扫 ~/.dsh/sessions/
npx dsh-kb search "中文分词 方案" -k 6
npx dsh-kb add --title "结论" --body "正文" --path topic/dsh --kind decision
npx dsh-kb tree topic --summary
npx dsh-kb stats
npx dsh-kb forget f_0d06e6d4155a92      # 标记失效，不删
```

## 三条设计红线

1. **`fact` 是唯一真相**，树、图、摘要全是投影，随时可重建。所以改分类不动内容，换分词跑一次 `reindex`。
2. **自动抽取只提取事实，"为什么"必须当场写**。从事件流推理由，得到的是幻觉。
3. **不删，只降权**。旧结论删了就不知道"当初为什么放弃"，而那通常比结论本身值钱。

## 实测

219 个会话 / 225 MB 压缩 / 6.9 秒 → 676 张卡 / 469 条边 / 零错误。

## 许可

MIT
