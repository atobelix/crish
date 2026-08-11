# 中文 FTS 召回基准（Round7 · A-FTS-ZH-01）

## 范围

- 实现：`crates/conex-workspace-store`（`blocks_fts` + `search_fulltext` / `query_blocks`）
- 不做：引入 tantivy 运行时（后置逃生）；不改 snapshot/updates 权威模型

## 基线行为（unicode61 · known gap）

| 项         | 事实                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| Tokenizer  | FTS5 `tokenize = 'unicode61'`（`ensure_blocks_fts`）                    |
| 连续汉字   | 无空格 CJK 整段通常 **一个 token**（Letter 类字符连续）                 |
| 子串 MATCH | `"工作区"` / `"块笔记"` 对「…工作区…」「…块笔记…」整段 token **0 命中** |
| 诊断 API   | `WorkspaceStore::search_fulltext_fts_only` — 纯 MATCH，无回退           |
| 英文       | 空格分词 + 短语转义仍走 FTS + bm25（既有测保留）                        |

测试锁定 known gap：`tests/fts_chinese.rs` → `a_fts_zh_01_unicode61_known_gap_substring`。

## 改进路径（已落地 · SQLite 内）

**含 CJK 查询 → `blocks.plain_text` 上 `instr(plain_text, token) > 0` 子串 AND**（空白分词多 token）。

| 入口                           | 行为                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `search_fulltext`              | `contains_cjk(q)` → instr 路径；否则 FTS                                            |
| `query_blocks`（`text_match`） | 同源：CJK → `query_with_cjk_instr`；否则 FTS                                        |
| 选用 `instr` 而非 `LIKE %q%`   | 避免 `%`/`_` 转义；字面子串语义清晰                                                 |
| 未选                           | 主表改 trigram（英文 bm25/短语语义变）；并行 `blocks_fts_ngram`（双写成本，可后续） |

验收测：`a_fts_zh_01_search_fulltext_cjk_hits`、`a_fts_zh_01_query_blocks_cjk_text_match`。

## 验收 ID

| ID              | 断言                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A-FTS-ZH-01** | 索引无空格中文段落后，产品 `search` 对「工作区」「块笔记」命中对应块；纯 FTS 子串记为 known gap 并有测锁定；英文 FTS 测全绿 |

门禁：`cargo test -p conex-workspace-store`。

## tantivy 逃生条件（触发才升主搜，不换权威）

对齐 `round-D-stack/07-技术栈矩阵裁决.md`（D4 / A-PERF-10 / A-SWAP-01）：

1. **规模 / 延迟**：固定语料（中文笔记为主）下，instr 全表路径 P95 连续失败产品契约（例如交互搜索 > 预算 ms），且 profiling 指向「无倒排子串扫」而非缺索引投影。
2. **相关性**：多字段/短语/前缀中文需求超出 `instr`+unicode61 组合，且 trigram/ngram 侧车仍无法满足命名魔鬼用例。
3. **锁竞争**：BLOB 权威与 FTS 同库写放大有基准证据，需要进程内独立倒排引擎。

触发后：tantivy（或等价）作 **Indexer 侧车**，`blocks`/权威仍 rusqlite；可重建；不把向量 RAG 设为默认块搜索。

## 后续可选（未做）

- FTS5 `trigram` 辅表 `blocks_fts_ngram` 与 unicode61 并存，缩短长 doc 子串扫
- 自定义 tokenizer / 简易二元分词写入 FTS
- ICU 分词（重依赖，默认不引入）

## 相关代码

- `src/lib.rs`：`ensure_blocks_fts`、`contains_cjk`、`search_fulltext`、`search_fulltext_fts_only`、`search_fulltext_cjk_instr`
- `src/query_blocks.rs`：`query_with_cjk_instr`
- `tests/fts_chinese.rs`
