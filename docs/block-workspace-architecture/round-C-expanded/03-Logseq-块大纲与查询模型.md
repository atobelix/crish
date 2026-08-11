# 03 · Logseq — 块大纲与查询模型

> 代码根：`reference/markdown_compare/logseq`  
> 调研范围：块=权威单元、DataScript/Datalog 查询、outliner 编辑、block ref、Electron 壳 vs CLJS 核心、DB version vs file version  
> 原则：只读源码与仓库文档；**不 fork、不嵌入 AGPL 整仓**；结论服务「AI 工作栈笔记」选型。

---

## 0. 结论先行

| 维度               | 判定                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **产品模型**       | **大纲强制**：一切内容是块；页面是带 tag 的特殊块；长文不是主叙事，是「深树 + 折叠」                  |
| **真相层**         | DB version：**DataScript（内存 EAV）+ SQLite 持久** 为权威；Markdown 仅为派生镜像或旧 file graph 语法 |
| **查询**           | Datalog / Query DSL 是一等公民；对 PKM 与 Agent 结构化检索价值极高                                    |
| **可迁移机制**     | 模型思想（parent+order、uuid 引用、query 规则）可迁移；**实现栈几乎不可 fork**                        |
| **不可 fork 主因** | **AGPL-3.0** 传染 + **ClojureScript 整仓心智** + 自 fork DataScript + 长年 outliner/worker 耦合       |
| **对 AI 工作栈**   | **结构化块引用 + query 值得做一等**；应学契约，不抄实现                                               |

---

## 1. 栈与架构鸟瞰

### 1.1 语言与壳

| 层       | 技术                                               | 证据                                                                       |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| 应用逻辑 | **ClojureScript**（Rum/HSX + React）               | `CODEBASE_OVERVIEW.md:7–27`                                                |
| 图数据   | **DataScript**（Logseq fork）+ Datalog             | `deps/db/deps.edn:3–4`；`CODEBASE_OVERVIEW.md:29–31`                       |
| 持久     | **SQLite**（DB graph）                             | `deps/db/README.md:3–6`                                                    |
| 文档解析 | **mldoc**（OCaml/Angstrom）                        | `README.md:189`                                                            |
| 桌面壳   | **Electron**（CLJS main：`src/electron/`）         | `shadow-cljs.edn` 有 `:electron` target；`src/electron/electron/core.cljs` |
| Worker   | `:db-worker`（browser）+ `:db-worker-node`（Node） | `shadow-cljs.edn:52–83`                                                    |
| 构建     | shadow-cljs + gulp + pnpm                          | `CODEBASE_OVERVIEW.md:17–21`                                               |
| 许可     | **AGPL-3.0**                                       | `LICENSE.md:1–2`                                                           |

**壳 vs 心**：Electron 只做窗口、文件系统、插件路径、更新、部分原生桥（`src/electron/`）。**权威图数据与 outliner 事务在 DB worker（CLJS）**，不是 Electron 主进程。Markdown Mirror 明确：主进程不渲染 Markdown，生成与写盘在 worker（`docs/adr/0016-markdown-mirror.md:53–56`）。

### 1.2 应用状态二分

`CODEBASE_OVERVIEW.md:68–70`：

- **文档态**（pages / blocks / content）→ DataScript
- **UI 态**（当前编辑块等）→ Clojure atom
- UI 通过 reactive 组件订阅，React 重渲染

输入路径（同文档 76–82）：handler → 落盘/云 → 更新 UI atom → **transact DataScript** → 可能重建 query 缓存。

### 1.3 目录心智图

```
deps/db/          schema、entity、query-dsl 纯函数、SQLite 图 API
deps/outliner/    大纲 op：insert/move/indent/save、refs 重建、tree
deps/graph-parser/  file graph → DataScript / 导入 DB graph
deps/common/      page-ref / block-ref 语法、config
src/main/frontend/  编辑器 UI、handler、worker、query 组件
src/electron/     Electron 主进程
cli/ + OCaml CLI / CLJS CLI  图 inspect、query、upsert（Agent/脚本面）
```

---

## 2. 块 = 权威单元的产品模型

### 2.1 大纲强制，而非「可块化的长文」

灵感来源自 Roam / Workflowy / Org（`README.md:178`）。产品默认：

- 每个段落级单位是 **block**，带稳定 **`:block/uuid`**
- 树结构由 **`:block/parent` + `:block/order`**（fractional indexing）决定，不是「Markdown 标题层级碰巧映射」
- 编辑原语是 outliner 语义：`save-block` / `insert-blocks` / `delete-blocks` / `move-blocks` / `indent-outdent-blocks` / `collapse-expand-blocks`（`deps/outliner/src/logseq/outliner/core.cljs:26–54`；`src/main/frontend/modules/outliner/op.cljs:36–89`）

**与长文编辑器的对比**：

|          | Logseq                       | 典型 ProseMirror/TipTap 长文 |
| -------- | ---------------------------- | ---------------------------- |
| 权威单元 | 块（uuid + parent/order）    | 文档节点树 / Y.XmlFragment   |
| 用户心智 | 大纲 bullet 树               | 连续文档流                   |
| 引用     | `((uuid))` / `[[page]]` 一等 | 常靠链接插件                 |
| 查询     | 全图 Datalog                 | 全文/应用层过滤              |

长文能力：可通过折叠、缩放（zoom into block）、嵌入获得「类长文」阅读，但**数据形状始终是树**，不是「一篇 MD 文件里的自由段落流」。

### 2.2 Schema：块与页的统一

`deps/db/src/logseq/db/frontend/schema.cljs:56–108`（DB graph schema 核心）：

| 属性                 | 含义                                         |
| -------------------- | -------------------------------------------- |
| `:block/uuid`        | 全局唯一身份（`:db.unique/identity`）        |
| `:block/parent`      | 父块 ref，索引                               |
| `:block/order`       | 兄弟序（fractional key，索引）               |
| `:block/page`        | 所属页 ref                                   |
| `:block/title`       | 标题/正文内容（DB 版用 title，非旧 content） |
| `:block/refs`        | 出链 ref 多值                                |
| `:block/tags`        | 标签/类                                      |
| `:block/link`        | 链接/嵌入目标                                |
| `:block/name`        | 页名字（小写）                               |
| `:block/journal-day` | 日记日                                       |
| `:block/collapsed?`  | 折叠                                         |
| `:block/tx-id`       | 影响该块的最新事务（渲染增量用）             |

**Page 不是另一套实体类型**，而是带 tag 的 block：

```clojure
;; entity_util.cljs:44–50
(defn page?
  [entity]
  (or (internal-page? entity)   ; :logseq.class/Page
      (journal? entity)         ; :logseq.class/Journal
      (class? entity)           ; :logseq.class/Tag
      (property? entity)))      ; :logseq.class/Property
```

这是 **统一块宇宙**：属性定义、标签/类、日记、普通页都挂在同一 EAV 图上——查询与 Agent 用同一套 id 空间。

### 2.3 顺序：fractional indexing

`deps/db/src/logseq/db/common/order.cljs`：基于 `logseq/clj-fractional-indexing` 生成 `:block/order` 字符串键，**DB 与 file graph 共用**。兄弟插入不需重编号整链；协同/合并友好。

树还原：`logseq.outliner.tree/blocks->vec-tree` 按 parent 分组 + `sort-by-order`（`deps/outliner/src/logseq/outliner/tree.cljs:11–36`）。

### 2.4 块引用与页引用

| 语法                    | 实现                                                | 用途                   |
| ----------------------- | --------------------------------------------------- | ---------------------- |
| `((uuid))`              | `deps/common/src/logseq/common/util/block_ref.cljs` | **块引用**（精确到块） |
| `[[title]]` / uuid 形式 | `page_ref` + content 管道                           | 页/节点引用            |
| `#tag` / `#[[tag]]`     | tags + refs 管道                                    | 标签                   |

内容变更时 **重建 `:block/refs`**：`outliner.pipeline/db-rebuild-block-refs`、`block-content-refs` 从 title 抽 uuid（`deps/outliner/src/logseq/outliner/pipeline.cljs:42–51, 99+`）。

Linked references 侧：`deps/db/src/logseq/db/common/reference.cljs` 用 AVET 上 `:block/parent`、effective-refs（自身 refs ∪ 祖先传播）做引用面板，并注意「子树排除 ref 剪枝」等性能敏感路径。

### 2.5 编辑器形态：textarea 大纲，非 PM 文档

`src/main/frontend/components/editor.cljs:770–773`：块编辑核心是 **`ls-textarea` + mock-textarea**，不是 ProseMirror/BlockSuite 文档模型。CodeMirror 用于代码块等扩展模式。

含义：

- **编辑热路径** = 单块字符串 + outliner 结构 op
- 富交互（表格、多列、嵌套复杂 layout）弱于 Notion/AFFiNE 向编辑器
- **结构正确性**（indent/move/uuid 稳定）优先于「画布式块 UI」

### 2.6 Outliner 事务契约（权威路径）

`docs/agent-guide/080-outliner-performance.md`：

1. 捕获 op + 编辑器状态
2. 发最小 op + page-window 到 **DB worker**
3. 等待 worker 事务
4. 返回最小 UI refresh
5. 一次发布 UI；恢复光标/选区
6. **禁止**乐观预览块、禁止 indent 预览态、禁止为整页树重载

`docs/adr/0005-atomic-outliner-batches-via-temp-conn.md`：批量 outliner 在 **temp conn** 上跑满再一次 commit，保证原子性。

`docs/agent-guide/082-incremental-block-reactivity.md`（演进方向）：

- Worker DB 是**唯一图权威**
- 渲染侧只 `use-block` / `use-children` / `use-resource`
- 以 `:block/tx-id` 做精确订阅，去掉整页 resident tree

---

## 3. 查询语言对 PKM / Agent 的价值

### 3.1 三层查询面

| 层                      | 入口                           | 能力                                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------ |
| **原始 Datalog**        | worker `:thread-api/q` → `d/q` | 任意 DataScript 查询                                               | `worker/handler/query.cljs:18–21`               |
| **Query DSL（simple）** | `:thread-api/query-dsl-query`  | and/or/not、between、page-ref、property、task、page、sample、全文… | `worker/query_dsl.cljs:22–40`                   |
| **Custom / advanced**   | custom query + 可选 SCI view   | 高级查询块 + 自定义视图函数                                        | `components/query.cljs`；`db/query_custom.cljs` |

DSL 预变换与共享解析：`deps/db/src/logseq/db/frontend/query_dsl.cljs`（`[[page]]` 引号化、`#tag`、`between` 时间 token）。

### 3.2 规则库（性能敏感）

`deps/db/src/logseq/db/frontend/rules.cljc`：

- `parent`：递归父子（clause 方向按「查后代」优化，文件内有 Datomic 性能注释）
- `has-ref` / `page-ref`：含祖先传播的引用
- `between`：日记 day 范围
- `block-content`：title 子串
- property / class-extends / alias 等

**价值**：用户与 Agent 不写 join 式 SQL，而用 **图可达性 + 时间窗 + 属性** 组合——这正是 PKM「跨页任务、本周提及某项目的块」类问题的原语。

### 3.3 对 Agent 的具体价值

1. **稳定寻址**：每个突变目标是 uuid，不是「第 N 段」或模糊标题
2. **声明式检索**：`query` / DSL 可脚本化（CLI 有 `query` 族；`docs/agent-guide/logseq-cli/001-logseq-cli.md:70`）
3. **结构 mutate**：outliner op 表与 CLI `upsert block`（target + pos）对齐，适合批量安全编辑
4. **反链闭环**：refs 属性 + linked ref 查询让 Agent 做「影响面分析」
5. **属性一等（DB graph）**：property schema 与值分离（`libs/guides/db_properties_guide.md`），比纯 MD frontmatter 更可类型化

**局限**：

- Datalog 对非 CLJ 生态 Agent 不友好，需封装 DSL/JSON API
- 坏写的规则/全图 `not` 可极慢（规则文件自身强调 clause order）
- Query 结果与大纲实时编辑的缓存失效历史上是成本点（`CODEBASE_OVERVIEW.md:82`）

---

## 4. 性能与大库风险

### 4.1 已知瓶颈（仓库自述）

来自 `080-outliner-performance.md` 实测基线：

| 场景              | 现象                              | 量级/对策                                            |
| ----------------- | --------------------------------- | ---------------------------------------------------- |
| 短页连按 Enter    | worker 同步事务路径               | roundtrip ~27–33ms；到 next frame ~55–60ms           |
| 1 万块页 window   | 曾为**每个块分配 map** 再截 60 行 | 诊断查询曾 90–105ms；优化后边缘 <80ms 目标           |
| 开大图            | 曾在 ready 前跑 GC + VACUUM       | 曾 21.6s → 去掉后冷开 ~1.9s                          |
| DataScript `with` | 单次 apply 不贵                   | profile：0.6–0.9ms；总时在 pipeline/storage/listener |

### 4.2 结构风险

1. **内存图**：DataScript 全图在 worker 内存；超大库 = 堆压力 + 序列化/transit 成本
2. **递归规则**：`parent` / `has-ref` 写错方向会扫全库（`rules.cljc:38–56` 注释）
3. **引用面板**：effective-refs 需祖先链 + 子树；`reference.cljs` 已用 datoms 快路径，仍 O(相关子图)
4. **渲染**：若退回「整页树 resident + 多套 revision」，10k 块必炸——082 文档正是在拆这条路径
5. **Query 缓存失效**：任意 transact 可能牵动多 query（总览明确 rebuild cache）
6. **主线程**：编辑器在 renderer；若错误地把重查询放 UI 线程会卡帧（契约要求查询在 worker）

### 4.3 大库可扩展性判断

| 能力                | 评价                                                        |
| ------------------- | ----------------------------------------------------------- |
| 单页 1e4 块浏览     | 靠 **window/虚拟化 + 禁止整树传输** 可做，已有契约          |
| 全图 1e5–1e6 块     | DataScript 全内存模型 **风险陡增**；需分片/冷热或换存储引擎 |
| 复杂 Datalog 仪表盘 | 表达力强，**无优化则不可用**                                |
| RTC/多端            | 另有 db-sync 路径；大 op 需分批（agent-guide 078 等）       |

对「AI 工作栈」：Agent 批量写比人类点按更易触发 **批量事务 + 引用重建 + query 失效** 风暴——op 合并与窗口刷新必须一等设计。

---

## 5. 栈上限：ClojureScript 生态与「可超越性」

### 5.1 CLJS 抬高的上限

| 点              | 说明                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| DataScript 一体 | 不可变 EAV + Datalog 与 CLJ 数据结构无缝；用 TS 重做完整 Datalog 引擎成本极高 |
| 同构 worker/CLI | 同一 outliner/db 库跑在 browser worker 与 node（nbb-logseq）                  |
| 事务与纯函数    | temp-conn 批处理、normalize-tx、规则库与语言特性契合                          |
| REPL/热重载     | 长周期演进友好（shadow-cljs）                                                 |

### 5.2 CLJS 压低的上限 / 可超越性

| 点                   | 说明                                                               |
| -------------------- | ------------------------------------------------------------------ |
| **招聘与协作面**     | 远小于 TS/Rust；改 outliner 的人少                                 |
| **与主流编辑器生态** | 难直接接 PM/TipTap/BlockSuite；Logseq 选了 textarea 大纲而非画布块 |
| **包生态**           | npm 互操作要 shadow/require 小心（仓库甚至有 esm-cjs-risk skill）  |
| **前端人才漏斗**     | 插件 SDK 有 TS（`libs/`），但心在 CLJS，插件无法改内核模型         |
| **性能天花板**       | DataScript JS 堆 vs Rust/Go 持久化引擎；极限大库更吃亏             |
| **AGPL**             | 商业闭源产品 **不能** 把 Logseq 当库链进来                         |

**可超越性结论**：

- **产品效果上**：块大纲 + 反链 + query 的**体验与契约**可被超越或追平（思源、自研块库均可）。
- **实现捷径上**：CLJS+DataScript 组合 **抬高了「抄作业」成本**，反而 **抬高了差异化自研的必要性**——别人难 fork 你的竞争对手，你也难 fork 它。
- **对 Conex**：不存在「换 CLJS 就抬上限」；存在「**吸收其块权威与 query 契约**，用更可控栈实现」的路径。

---

## 6. 可迁移机制 vs 不可 fork 原因

### 6.1 可迁移（应学）

| 机制                          | 迁移方式                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| **块 uuid 为权威主键**        | 任何存储层统一 id                                           |
| **parent + fractional order** | 大纲兄弟序；协同友好                                        |
| **页 ⊆ 块**（tag 区分）       | 简化 schema                                                 |
| **出链物化为 refs 边**        | 保存时解析 `[[ ]]` / `(( ))` 写边表                         |
| **Outliner op 表**            | save/insert/delete/move/indent/collapse 作为唯一 mutate API |
| **Worker 为图权威**           | UI 不持有第二真相；增量 delta 订阅                          |
| **Query DSL 子集**            | 不必上完整 Datalog；先做 and/or、标签、时间窗、属性、全文   |
| **Markdown 派生镜像**         | DB 权威 + 可选 mirror（ADR 0016 思想）                      |
| **原子批处理**                | temp 快照/单 commit（ADR 0005 思想）                        |

### 6.2 不可 fork / 不应整仓嵌入

1. **AGPL-3.0**（`LICENSE.md`）——与本仓「禁 AGPL 整仓嵌入」铁律一致（`round-C-expanded/00-筛选与本波目标.md:108`）
2. **心智与模块边界**：outliner ↔ pipeline ↔ worker ↔ rum/hsx ↔ sync 多年耦合；「抽 deps/outliner 当库」仍会拖 DataScript fork、schema 版本（当前 schema `65.33`，`schema.cljs:33`）、property/class 系统
3. **DataScript 是 Logseq fork**（`deps/db/deps.edn:3`）——版本与上游分叉，长期维护债
4. **双世界历史**：file graph（MD/Org + graph-parser）与 DB graph 并存；导入路径复杂（`docs/og_import_graph_cases.md`）
5. **编辑器与数据强绑定**：textarea + 块组件假设，不是可插拔 document engine

**可迁移 ≠ 可复制粘贴**。合法路径是 **思想级迁移 + 干净室实现**。

---

## 7. DB version vs file version

|           | File graph（传统）                 | DB graph（现行主推）                           |
| --------- | ---------------------------------- | ---------------------------------------------- |
| 用户文件  | 每页 Markdown/Org 为源             | **SQLite + DataScript** 为源                   |
| 属性      | 文本语法（frontmatter / `key::`）  | **一等 property 实体** + schema                | `libs/guides/db_properties_guide.md:9–35` |
| 导入      | graph-parser 解析目录进 DataScript | 原生；file→DB 用 exporter                      | `deps/graph-parser/README.md`             |
| 同步      | 文件同步 / git 等                  | RTC / db-sync（alpha/beta 文档见 README）      |
| MD 可见性 | 直接可读可改                       | 可选 **Markdown Mirror** 派生                  | ADR 0016                                  |
| 状态      | 仍支持解析与导入                   | README 置顶：DB version beta；移动端/RTC alpha | `README.md:69–86`                         |

**线索总结**：产品正在从「文件是真相、DataScript 是缓存」迁到「**DB 是真相、文件是镜像/遗产**」。对 AI 工作栈：应站在 **DB 权威** 一侧设计，同时保留 **可导出 MD** 的逃生舱（mirror 语义），而不是把「可手改 MD 文件」当主路径。

---

## 8. 对 AI 工作栈：结构化块引用 / query 是否值得做一等

### 8.1 值得做一等（强烈建议）

| 能力                         | 理由                                                   |
| ---------------------------- | ------------------------------------------------------ |
| **块级稳定 ID**              | Agent 工具参数可幂等；避免「按行号改」                 |
| **结构化引用边**             | 影响分析、反向链接、删除级联策略                       |
| **声明式 query（DSL 即可）** | 「找所有 deadline∈本周 且 #项目X 未完成」是 Agent 刚需 |
| **Outliner mutate API**      | 与对话式「缩进/拆分/合并」对齐；比补丁 MD 文本安全     |
| **属性 schema**              | 任务状态、优先级、自定义字段可校验                     |

### 8.2 不必原样照搬

| Logseq 做法             | AI 工作栈建议                                                 |
| ----------------------- | ------------------------------------------------------------- |
| 完整 DataScript/Datalog | 可用 SQLite + 明确 SQL/自研 DSL；表达力够用即可               |
| 大纲强制 UI             | 可 **数据块权威 + 长文视图投影**（双视图），不必 UI 只 bullet |
| SCI 自定义 query 视图   | 安全模型差；Agent 侧用受限模板/固定视图                       |
| 全图内存                | 大库用分页索引 + 磁盘权威                                     |
| CLJS 实现               | 保持 Tauri/RS/TS 或 Go 心；只迁契约                           |

### 8.3 与思源 / AFFiNE 对照（选型提示）

|           | Logseq                       | 思源             | AFFiNE             |
| --------- | ---------------------------- | ---------------- | ------------------ |
| 块 ID     | uuid 强                      | 块 ID 强         | 块模型强           |
| Query     | **Datalog 最强**             | SQL/嵌入查询     | 弱于前两者         |
| 编辑器    | textarea 大纲                | Protyle 类       | BlockSuite         |
| AI 工具面 | CLI/query 强，产品 AI 非主打 | MCP/Agent 文档化 | 协作/画布主        |
| 许可      | AGPL                         | AGPL             | 相对更友好但仍需核 |

**AI 工作栈若押「可查询的块知识库」**：Logseq 的 **query + refs 契约**是标尺；若押「写作静默 + 画布」：编辑器应学 AFFiNE/思源，而不是 Logseq textarea。

---

## 9. 路径证据索引（绝对路径）

| 主题                 | 路径                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| 总览                 | `C:\Software\conex\reference\markdown_compare\logseq\CODEBASE_OVERVIEW.md` |
| README / DB version  | `...\logseq\README.md`                                                     |
| Schema               | `...\logseq\deps\db\src\logseq\db\frontend\schema.cljs`                    |
| Entity page?         | `...\logseq\deps\db\src\logseq\db\frontend\entity_util.cljs`               |
| Order                | `...\logseq\deps\db\src\logseq\db\common\order.cljs`                       |
| Rules / DSL rules    | `...\logseq\deps\db\src\logseq\db\frontend\rules.cljc`                     |
| Query DSL 纯解析     | `...\logseq\deps\db\src\logseq\db\frontend\query_dsl.cljs`                 |
| Worker 查询 API      | `...\logseq\src\main\frontend\worker\handler\query.cljs`                   |
| Worker DSL 执行      | `...\logseq\src\main\frontend\worker\query_dsl.cljs`                       |
| Outliner 核心        | `...\logseq\deps\outliner\src\logseq\outliner\core.cljs`                   |
| Tree                 | `...\logseq\deps\outliner\src\logseq\outliner\tree.cljs`                   |
| Pipeline / refs      | `...\logseq\deps\outliner\src\logseq\outliner\pipeline.cljs`               |
| Frontend outliner op | `...\logseq\src\main\frontend\modules\outliner\op.cljs`                    |
| Editor handler       | `...\logseq\src\main\frontend\handler\editor.cljs`                         |
| Editor UI            | `...\logseq\src\main\frontend\components\editor.cljs`                      |
| Block ref 语法       | `...\logseq\deps\common\src\logseq\common\util\block_ref.cljs`             |
| References           | `...\logseq\deps\db\src\logseq\db\common\reference.cljs`                   |
| DataScript fork      | `...\logseq\deps\db\deps.edn`                                              |
| Markdown Mirror ADR  | `...\logseq\docs\adr\0016-markdown-mirror.md`                              |
| Mirror 语法          | `...\logseq\docs\logseq-markdown-syntax.md`                                |
| 性能契约             | `...\logseq\docs\agent-guide\080-outliner-performance.md`                  |
| 增量响应             | `...\logseq\docs\agent-guide\082-incremental-block-reactivity.md`          |
| 原子批               | `...\logseq\docs\adr\0005-atomic-outliner-batches-via-temp-conn.md`        |
| DB properties        | `...\logseq\libs\guides\db_properties_guide.md`                            |
| Electron 入口        | `...\logseq\src\electron\electron\core.cljs`                               |
| 许可                 | `...\logseq\LICENSE.md`                                                    |
| graph-parser         | `...\logseq\deps\graph-parser\README.md`                                   |

---

## 10. 给本仓（Conex / 块工作区）的一句话建议

> **把 Logseq 当「块权威 + 引用边 + 声明式查询」的教科书，不要当可嵌入的编辑器内核。**  
> 一等做：uuid 块、parent/order、refs 物化、受限 query DSL、worker 单权威 mutate。  
> 不做：AGPL 整仓、DataScript 宗教化、强制 bullet-only UI、全图内存当唯一扩展路径。

---

_文档生成：Round C 只读调研；不改 `reference/markdown_compare/logseq` 源码。_
