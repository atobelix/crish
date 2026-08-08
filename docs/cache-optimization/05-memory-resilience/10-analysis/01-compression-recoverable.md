# 01 上下文压缩可追溯 / 可恢复（Compression Recoverability）技术方案

> 目录：`docs/cache-optimization/05-memory-resilience/10-analysis/`
> 状态：分析稿（草案，待评审）
> 日期：2026-08-08
> 范围：只读分析 + 设计建议；不修改任何源码
> 对照基准：`reference/billion-context-pi`（ACP compress / decompress / search_context 三工具语义）

---

## 0. 摘要（TL;DR）

| 项 | 结论 |
|---|---|
| 丢记忆现状 | 压缩时被丢弃消息的原文仅存在于内存，无落库引用；唯一残留是 `context-compression-end` 事件的 id 清单与摘要文本（`crates/session-loop/src/loop/handlers/mod.rs:360-382`） |
| 关键既有事实 | `message-end` 事件已持久化**每条消息全文**（`crates/orchestrator/src/events.rs:47-57,188-194`），事件流为 append-only 追加、压缩不删除事件 → **原文其实可恢复，只是不可检索、无索引、无块语义** |
| 目标形态 | 引入「压缩块（compaction block）」：唯一 `block_id`、摘要槽位文本格式、原文指针（事件流回放）、单调切割下界（防同一区域反复压缩）、压缩代数（generation）落库 |
| 数据模型 | `compression_blocks` 新表（v7 迁移）+ 复用 `events` 表存原文（不重复落原文）；`ContextCompressionRecord` 扩展 `block_id/generation/prev_block_id`（进 `details` JSON，向后兼容） |
| 工具面 | `decompress_context` / `search_context` 两个只读新工具（agent-tools），核心检索/回放算法放 conex-compaction 纯算法层 |
| 护栏协同 | 时间戳护栏（usage 作废）+ 单 run 压缩上限 + **压缩代数（会话级单调）** + 摘要块恒保留（切割下界）四层协同 |

---

## 1. 现状证据：现有压缩路径如何丢记忆

以下按「压缩决策 → 替换 → 事件 → 落库」的链路逐点给出证据（全部精确到文件:行号）。

### 1.1 压缩引擎丢弃原文且不记录存储位置

`crates/conex-compaction/src/lib.rs`（AgentMessage 面主路径 `compact_agent_messages`，:420-534）：

- **收集丢弃消息后直接克隆给摘要器，原文无任何引用于产物**：
  - `:447-457`——`dropped_arcs = messages[..cut]` 中非 system 消息克隆成 `Vec<Arc<AgentMessage>>`，仅取 `id` 生成 `dropped_ids`；克隆体只存活到下一行摘要调用，之后就随函数返回被丢弃；
  - `:469`：`dropped_slice` 一次性克隆传给 `Summarizer::summarize`，是原文在压缩路径中**最后一次完整存在**。
- **组装结果不含任何「原文位置」引用**：`:497-516` 输出 = 保留的 system 消息 + 一条摘要占位（assistant）+ 保留段。`CompactionPlan` 字段（`:147-165`）只有 `dropped_ids` / `kept_ids` / `first_kept_message_id` / `tokens_*` / `summary`——**没有 block_id、没有原文落点、没有压缩代数**。
- **L1 静态占位符只含数量**：`:749-752` `summary_placeholder(dropped_count)` 生成 `[Compacted N earlier message(s) to fit context window]`，不含任何可定位信息。
- **迭代合并覆盖旧摘要**：`:459-464` 把对话中既有摘要（`compacted-summary` 前缀 id）的文本取出作为 `existing` 传给摘要器——旧摘要文本被「合并进新摘要」，**旧摘要本身（以及它携带的可追溯信息）不再独立存在**；若走 L1 静态路径，旧占位符文本被直接替换。
- **占位消息 id 可重复**：`:503` 摘要消息 id 为 `format!("compacted-summary-{}", dropped_ids.len())`——**仅携带丢弃数量**；两次压缩若丢弃数量相同（如各丢 8 条），会生成相同 id `compacted-summary-8`，跨压缩轮无唯一标识。`created_at`（`:506-509`）沿用对话末条消息时间戳，也无法区分轮次。

### 1.2 对话替换点：原文从运行态内存消失

`crates/session-loop/src/loop/handlers/mod.rs`：

- `:349` `state.conversation = plan.messages.clone()`：压缩是唯一前缀重写点（`:305-307` 注释），被丢弃消息从 `LoopState::conversation` 移除，后续 run 只能看到摘要占位符；
- `:470-482` `record_message` 的 **append-only 不变量**（`:475-477`）——压缩是唯一允许改写的路径，即「丢记忆」的唯一点。

### 1.3 事件广播：record 只带 id 清单与摘要，无原文存储位置

`apply_compaction`（mod.rs:314-403）构造 `ContextCompressionRecord`（`:360-382`）：

- 字段（`crates/conex-types/src/tool.rs:465-489`）：`id`（`new_message_id("compaction")`，`:361`，**当前天然唯一，本方案将其复用为 block_id**）、`compressed_message_ids`（= `dropped_ids`）、`kept_message_ids`、`summary`、`tokens_before/after`、`threshold_tokens`、`details`（当前恒为 `None`，`:381`）；
- **没有**：原文存储位置、块序（代数）、上一块引用（迭代合并溯源）、切割下界引用。

`crates/conex-types/src/events.rs:418-437`：`ContextCompressionEnd.result` 携带该 record 落事件流——即**模块的全部可追溯信息止步于「id 列表 + 摘要文本」**。

### 1.4 落库现状：事件流有全文原文，但不可检索

关键既有事实（本方案的最大杠杆）：

- `crates/orchestrator/src/events.rs:47-57`：`event_class`——除 `message-delta` 与 subagent progress 外全部**同步落库**，含 `message-end`（携带完整 `AgentMessage`，`:570-585` 测试载荷可见全文形态）；
- `crates/orchestrator/src/events.rs:160-200`（`EventQueue::push`）：持久化事件序列化为**完整事件 JSON** 写入 `events.payload`（`:188-194`），`append_event` 为行追加（`crates/conex-db/src/events.rs:8-27`）；
- **事件流为 append-only**：历史上所有 `message-end` 事件在压缩后依然在库中——**被压缩消息的原文实际没丢，只是「没索引、没块归属、没检索入口」**；
- 恢复路径已有先例：`crates/orchestrator/src/restore.rs:734-735` 在重放时消费 `context-compression-end` 事件恢复 `last_compaction_at` 护栏（`crates/orchestrator/src/session.rs:162-165`）——说明「事件流重放 = 状态恢复」是本仓库已确立的模式。

### 1.5 前端水合表不可承载引擎原文

`crates/conex-db/src/schema.rs:189-206`（`session_messages`）：

- `sender CHECK (sender IN ('user','assistant'))`（`schema.rs:193`）——**不接受 system/tool 角色**，AgentMessage 全集无法直接落库；
- `crates/conex-db/src/messages.rs:52-104`（`save_session_body`）语义是**全量替换**（先 `DELETE` 会话全部行再插入，`:66-98`）——若壳层在压缩后以压缩后会话全量重写，**被压缩消息会从该表物理消失**；该表由 TS 壳层水合维护（`blocks_json`/`usage_json` 为前端兼容字段），引擎侧无写入路径。

> **结论**：现压缩路径「丢记忆」的本质是**信息熵收缩到两个不可检索的索引**——id 列表（record）与摘要文本（占位符）；原文残留在事件流中但无块语义、无检索入口。因此方案的正确定位是：**给压缩建立「块」结构与检索/恢复工具，把事件流中的原文重新变成可寻址资源**，而不是重复落库。

---

## 2. 目标设计：压缩块 + decompress / search

### 2.1 核心概念：压缩块（Compaction Block）

一次压缩动作形成一个**压缩块**，具有全局唯一标识与全部恢复所需指针：

```
CompactionBlock {
    block_id: "cb-" + session 内单调序号（或复用 record.id），
    generation: 会话级压缩代数（单调 +1），
    prev_block_id: Option<String>   // 摘要迭代合并链上的上游块（lib.rs:459-464 的 existing 语义落成边）
    dropped_message_ids: Vec<String>,
    first_kept_message_id: Option<String>,
    summary: String, summary_is_llm: bool,
    tokens_before/after, dropped_at_ms,
    origin: "events"                // 原文恢复源：events 表 message-end 事件
}
```

**原文不重复落库**：dropped 消息的全文恢复统一走 `message-end` 事件回放（§1.4 证据）。块的职责是**索引 + 归属**，让检索与恢复变成 O(块数/事件数) 的定向查询而非全表扫描。

### 2.2 摘要槽位（对话内占位）文本格式

占位消息依旧保留在对话中（压缩不得破坏「system → 摘要 → 保留尾部」形态，`lib.rs:496-516`），但三处升级：

1. **消息 id 唯一化**：`compacted-summary-{N}`（`lib.rs:503`）改为 `compacted-summary-{block_id}`（保留前缀，兼容既有 `starts_with("compacted-summary")` 断言：`handlers/mod.rs:740`、`ai_summary.rs:865/741`、`app.rs` 等），并消除同数量重名；
2. **正文模板增补**：L1 静态占位符尾部追加一行机器可读引用（分量小、人读友好）：

   ```
   [Compacted 12 earlier message(s)  ·  block {block_id}  ·  generation {g}  ·  恢复: decompress_context(blockId="{block_id}")]
   ```

   L2 五字段摘要（`ai_summary.rs:376 SUMMARY_TEMPLATE_FIELDS` 五字段：任务目标/已完成/待办/关键决策/文件清单）保留原文，另在其后追加同一引用行；模板常量与 `validate_structured_summary` 向后兼容（标题与五字段仍在场，新增行仅作为附加尾部，校验逻辑不改）。
3. **结构化元数据**：占位消息 `metadata` 写入 JSON：`{"compactionBlockId": ..., "compactionGeneration": ..., "prevBlockId": ...}`——机器可读优先，正文只放人读线索（对齐项目「data-* 属性无损映射、不写魔法数字」的架构纪律：双通道——正文给模型看、metadata 给工具/断点用）。

### 2.3 decompress / search 语义设计（对照 billion-context-pi）

业界对照（`reference/billion-context-pi/`）：

| 维度 | billion-context-pi | 本方案 |
|---|---|---|
| 压缩入参 | `startId/endId/summary/topic`（compress-tool.ts:15-25） | 引擎自动切割（既有 `find_cut_point`，不对模型暴露切割权） |
| 搜索 | `search_context(query, limit)` —— 只索引**被压缩进块**的消息（search-index.ts:76-90），消息命中给出「所属块 + 恢复指令」（search-tool.ts:63-67） | 同语义：只搜「已压缩消息 + 块摘要」，不搜在上下文里仍可见的消息（模型看得见就不浪费工具调用） |
| 恢复 | `decompress(blockId \| msgRef, full, inline, toFile)` —— **块保持压缩**、上下文不被污染，默认落文件（decompress-tool.ts:36-37,186-199），小内容才 inline（:173-176） | 同语义：恢复只读回放，**不替换对话、不动上下文前缀**（缓存前缀稳定，对齐 P1 不变量，`handlers/mod.rs:477-481`） |

**语义分界（重要）**：本系统的「恢复」是**读操作**（拿回事实、精确细节），**不是**「撤销压缩」（把块原文重新放回上下文）。撤销/回滚压缩（替换摘要占位为原文）列为未来选项，默认不做——它会破坏缓存前缀稳定性（P1/I1）且压缩是唯一前缀重写点。

### 2.4 各层贡献（分层接线）

| 层 | 贡献 | 说明 |
|---|---|---|
| **conex-compaction（纯算法）** | 新增 `recovery` 模块：块元数据结构、摘要槽位文本格式化（含块引用行）、**单调切割下界**（§3）、generation 递增；`CompactionPlan` 增字段（`block_id/prev_block_id/generation`） | 保持 crate 无运行时依赖定位；只产决策与元数据，不落地 |
| **session-loop**（`handlers/mod.rs`） | `apply_compaction` 织入：块 id（复用 `new_message_id("compaction")` 但不落入 `record.id` 与槽位 id）、`compactions_this_run` 与代数计数并存、`last_compaction_at` 既有；事件 record 填 `details` 扩展；read 侧暴露「会话压缩上下文」（块索引 + 原文提取）内部 API | 单一广播点不动（cache_tracker 基线作废等既有接线零改动） |
| **orchestrator** | 落库：新增 `compression_blocks` 写入接口（由 db trait 扩展）与恢复回放（generation 随 `SessionContextMeta` 持久化，对齐 restore.rs:734-735 既有的 `last_compaction_at` 恢复模式；新增事件类型不引事件，事件号不膨胀） | `persist.rs` 的 `append_event` 通道复用；新表写入走 `blocking_db_call` |
| **conex-db** | 新增表 + 查询 API：`put_compression_block` / `list_blocks` / `get_block` / `extract_dropped_messages`（回放 message-end 事件按 id 提取） | §4 模型 |
| **agent-tools** | 新工具 `search_compressed` 与 `decompress_block`（只读，注册入 read-only 集）；经注入的 `LocalDb` 访问（既有先例：`revert_guard.rs:21-23`、`output_dir.rs`、`wait_subagents.rs:1506`） | 让模型在长会话中被压缩的历史细节可「主动发现 + 精确取回」 |

> 注：工具命名与权限面（只读、approval 分类、tool_metadata.is_read_only）统一定在实现阶段对齐 `agent-tools/src/tools/mod.rs:104` 的内置注册入口；壳层命令面（手动 /compact-recover 等)列为后续增强，不与本次事件面耦合。

---

## 3. 切割边界与单调压缩（防止同一区域反复压缩）

### 3.1 现状护栏盘点

| 护栏 | 现状实现 | 弱点 |
|---|---|---|
| 时间戳护栏 | `LoopState.last_compaction_at`（handlers/mod.rs:107-108）：usage 源消息早于边界即作废（`lib.rs:678-685`） | 只防**估算失真**，不防区域重复压缩 |
| 单 run 上限 | `compactions_this_run`（handlers/mod.rs:110-111、`maybe_compact_preflight` :274、`apply` :351-352） | 只防单 run 内来回震荡；**跨 run（run 重启/长会话多 run）无防护**——新一轮 run 可能再次把上一轮「已压缩区」再压缩一遍 |
| 迭代合并 | `existing` 摘要合并（lib.rs:459-464） | 合并 = 旧摘要被新摘要**覆盖**；若 L1 占位符反复被压，信息熵每轮缩水 |

### 3.2 单调压缩边界（本轮新增）

**不变式 M1（摘要块恒保留）**：任何一轮压缩，`cut`（保留段起始）不得小于**最近一个摘要块消息的位置 + 1**——即摘要块消息永远留在保留段里，永不被二次丢弃。实现上：

- 保留段扫描时把「`compacted-summary` 前缀 + 块元数据消息」计入 `kept` 名单（`find_cut_point_inner` 的合法切割点限制天然保证 tool 配对，:594-636）——只要将「摘要块为不可切消息」加入 `find_conditions` 之一；
- 引擎入口 `cut_result` 处：`cut 下界 = (最近摘要块索引 + 1)`，若倒推算出的 cut 小于下界则把 cut 钳到 `(最近摘要块索引+1)`（若 `< 下界即无可丢内容 → noop_plan`，复用 `lib.rs:453-456` 语义）。

**不变式 M2（每轮压缩相对前进）**：在 M1 下，每次新块的 `dropped` 区间必然是「上次压缩后新产生的消息」的子集，drop 区间在时间轴上严格前进——不存在「同一区域被压两次」的路径。轮转推动由 budget 水位天然驱动（只压缩超出 `keep_recent_tokens` 的头部）。

### 3.3 压缩代数（generation）与时间戳护栏的协同

- **代数定义**：会话级单调计数器（`LoopState.compact_generation: u32`，初始 0，每次 `apply_compaction` +1；**跨 run 持久化**——随 `SessionContextMeta` / `session_meta` 键 `compact_generation` 落库，restore 恢复，对齐 `last_compaction_at` 的既有持久化路径：`restore.rs:734-735`）；
- **协同**：时间戳护栏回答「usage 还描述当前前缀吗」（毫秒粒度）；代数回答「这是第几次压缩、块之间顺序/链条」（整数粒度）。两者互补，前者防估算失真、后者构成块 ID 序与归因（对齐 P5 缓存代数：`P5-cache-telemetry.md:186/528`，`handlers/cache_tracker.on_compaction()` 已视为代数 +1——两处代数统一为同一计数源，避免漂移）；
- **幂等**：`apply_compaction` 以 `dropped_ids` 集合为键做 `INSERT OR IGNORE`（块表）——重放/重复同轮压缩（恢复重放路径）不产生重复块（对齐事件流序列幂等语义）。

---

## 4. 数据模型建议

### 4.1 结论：新表 `compression_blocks` + 复用 `events` 存储原文

- **原文**：不另落列；`message-end` 事件已带全文（`orchestrator/events.rs:47-57,188-194`），事件流 append-only 意味着原文存在且稳定；
- **索引**：新表 `compression_blocks` 记录块元数据，让 search/decompress 不做全事件扫描（事件行只存序列升序、event_type，未按消息 id 索引——按块检索需要索引表）；
- **否决项**：session_messages（`sender` CHECK 只允许 user/assistant；`save` 全量重写语义会随壳层重写删除压缩消息；TS 水合侧差异）——不可复用。

### 4.2 DDL（v7 迁移新增，向后兼容不需要改动既有列）

```sql
CREATE TABLE IF NOT EXISTS compression_blocks (
    block_id            TEXT PRIMARY KEY,          -- 唯一块 id（复用 record.id 形态）
    session_id          TEXT NOT NULL,
    sequence            INTEGER NOT NULL,          -- context-compression-end 事件序列（定位事件行）
    generation          INTEGER NOT NULL,          -- 会话内压缩代数（单调，M3）
    prev_block_id       TEXT,                      -- 迭代合并上游块（null=首块）
    summary             TEXT NOT NULL,             -- 摘要槽位文本（L1/L2 均可）
    summary_is_llm      INTEGER NOT NULL DEFAULT 0,
    dropped_message_ids TEXT NOT NULL,             -- JSON 数组（消息原文从 events 回放）
    first_kept_message_id TEXT,                    -- 切割下界引用（M2 断言用）
    tokens_before       INTEGER NOT NULL,
    tokens_after        INTEGER NOT NULL,
    dropped_at_ms       INTEGER NOT NULL,          -- epoch ms（压缩时刻）
    created_at          TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_compression_blocks_session
    ON compression_blocks(session_id, generation);
CREATE INDEX idx_compression_blocks_first_kept
    ON compression_blocks(session_id, first_kept_message_id);
```

### 4.3 事件载荷扩展（`ContextCompressionRecord`）

全 Option + serde 缺省，向后兼容（旧 payload 缺省可读、缺省不序列化——先例 `PermissionRequest` 传递层字段，`events.rs:207-217`；`details` 已是自由 JSON，`tool.rs:489`）：

- `details` JSON 追加（给 **camelCase**，与既有 `coversUpToTurn` / `degraded` / `summaryAttempts` 对齐，`ai_summary.rs:417-428`）：
  - `"blockId"`、`"prevBlockId"`、`"generation"`、`"droppedAtMs"`；
- `record.id`（`new_message_id("compaction")`）与 `block_id` 合一（不再生成两套 id）；槽位消息 id = `compacted-summary-{block_id}`（§2.2）。

> 事件领域不起新事件（新增字段进既有 `context-compression-end`）：`registry_drift.rs` 锁定的是事件变体与注册表，字段级扩展不动注册表（`tests/registry` 无字段校验）。**不加新事件**是本期的边界。

### 4.4 迁移策略

- 走既有 `PRAGMA user_version` 版本链：`migrate.rs:12 迁移链 v1→v6 已建立，v7 为新增迁移（`migrate.rs:98-119` 为入口形态）；迁移间事务独立、幂等可重试（既有约定）；
- **只建新表、零列改动**：不动既有表任何列 → 无全表重写风险（规避 `save_session_body` 全量替换类问题）；
- 历史会话回填：可选 `backfill`（扫描旧 `context-compression-end` 事件行 → 插入块索引）**列为 V2**；V1 只保证新压缩写块索引；
- 删除/清理：会话删除走 `DELETE CASCADE`（块表 FK）——其余路径不触碰。

---

## 5. 测试建议

### 5.1 单元测试（纯算法层，`crates/conex-compaction`）

1. `recovery::format_block_line`：槽位附录块引用行与 L1/L2 模板兼容（五字段校验 `validate_structured_summary` 仍通过）；
2. `recovery::monotonic_cut`：M1/M2 断言——已有压缩块的对话再次超预算时，计算 `cut` 必 ≥ 最近块+1；无新内容（块后无消息）时 noop；
3. `recovery::generation`：代数递增；同 dropped ids 幂等；
4. block 序列化回环：`dropped_message_ids` JSON 往返。

### 5.2 集成测试（session-loop + orchestrator + db）

- `handlers/mod.rs` 现有 `apply_compaction` 测试集**扩展**：断言 `record.details.blockId/generation` 已填、槽位 id 唯一、`first_kept_message_id` 与 `cut` 一致；
- `orchestrator` 事件链：驱动一次含压缩的 run → `events` 表中 `context-compression-end` payload 含块元数据、`compression_blocks` 有新行（含 sequence）；
- `restore.rs` 重放：恢复后 `generation / last_compaction_at` 与事件流一致性（对齐既有 CONTEXT_COMPRESSSION 重放测试，`:1565-1730`）；
- **decompress 端到端**：压缩一组消息 → 经事件流提取原文 → 断言与压缩前逐字节一致（golden 对比）；
- **search 端到端**：搜索命中压缩区内关键词 → 只返回块索引条目（不返回仍在上下文的可见消息）。

### 5.3 保留既有门禁（AGENTS.md 铁律）

- `reference/markdown-editor`：`npm test`（vitest run tests/unit，grapheme/undo/parser-reDOS/chunk）——本方案不触碰该目录任何文件，**回归时不清除、不动**；
- 主仓库 `tests/e2e` 5 个 markdown-editor 专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）**禁止删除**；
- Rust 门禁 `cargo test --workspace`（既有 73 套件为基线）+ 前端 `npm run typecheck` + `npm run test:coverage -- --project=unit`（45/70/65/45 快层）不得回归；新表新增 SQL 用 `crates/conex-db` 既有 tE2E/unit 模式覆盖（`tests/upgrade_e2e.rs` 迁移链黄金字节测试追加 v6→v7 断言）。

---

## 6. 风险与待决问题

| # | 风险/待决 | 处置建议 |
|---|---|---|
| R1 | `events` 表原文是「隐含资产」：若未来引入事件裁剪/滚动删除，被压缩消息全文会从库中消失 | 块表只存「指针」；裁剪策略立项时把 `compression_blocks` 的原文依赖列入约束；可作为 V2 把原文快照落块表（体积换安全） |
| R2 | 事件回放提取性能：`decompress` 按 id 提取需要扫描事件表（无消息 id 索引） | V1 接受（块级恢复低频）；V2 加 `message_seq_index(session_id, message_id → sequence)` 辅助表 |
| R3 | 摘要迭代合并信息熵：旧摘要被合并进新摘要后不可逆 | 摘要文本非唯一事实源（`压缩`块原文可恢复）；doc 明确「摘要合并只影响摘要槽位，不影响可恢复性」 |
| R4 | 双代数源漂移：本方案 `generation` 与 cache_tracker 内部保存的代数（`handlers/mod.rs:118`、P5 归因）需统一 | 单一计数源：`LoopState.compact_generation` 为权威，cache_tracker 消费该值（重构接线一处） |
| R5 | 工具面权限：`decompress` 读到原始消息内容可能包含敏感信息 | 只读注册 + 复用既有审计/权限中间件（agent-tools `middleware.rs` / `permission.rs`）；块恢复内容属于会话自身数据，无需求新批准面 |
| R6 | 摘要槽位模板变更影响既有测试断言与前端文案硬核对 | 追加行放「尾部可选引用行」，既有断言（starts_with 前缀、五字段校验）继续成立；改导致前端 diff 检查一次 |
| R7 | 槽位 id 变更（`compacted-summary-N` → `compacted-summary-{block_id}`）影响历史会话水合 | 仅新压缩产生新形态；历史消息不受影响；前端按 `starts_with("compacted-summary")` 识别保持兼容 |
| R8 | 待决：`decompress` 输出面（inline vs 文件 vs 新会话块）与 token 门槛参数化 | 对齐 pi 语义：默认落文件（读工具再读），`inline: true` 显式接受上下文开销；具体值实现时定 |
| R9 | 待决：是否把 `search_context/decompress_context` 注册进子 agent 只读工具集 | 建议：是（子 agent 恢复记忆的需求更大）；工具注册走 `agent_tools::registry` 只读面 |
| R10 | 待决：压缩块是否跟随会话「分支/归档」移动 | 新建表 FK ON DELETE CASCADE 已覆盖删除；分支场景随会话复制策略（既有 `branch_parent_id` 链路）复用不新做 |

---

## 附：证据索引（文件:行号速查）

| 证据点 | 位置 |
|---|---|
| 丢弃消息不落库 | conex-compaction/src/lib.rs:448-457 |
| 摘要占位符只带数量 | conex-compaction/src/lib.rs:749-756 |
| 摘要迭代合并覆盖旧摘要 | conex-compaction/src/lib.rs:459-464 |
| 占位消息 id 仅带数量（可重名） | conex-compaction/src/lib.rs:502-503 |
| 对话替换 = 唯一前缀重写点 | session-loop/src/loop/handlers/mod.rs:349、:470-482 |
| record 无块 id / 原文位置 | session-loop/src/loop/handlers/mod.rs:360-382；conex-types/tool.rs:465-489 |
| context.compact 钩子广播点 | session-loop/handlers/mod.rs:323-331 与 moment 393-402 |
| 时间戳护栏 / 单 run 计数 | session-loop/handlers/mod.rs:107-110、352-353、273 |
| usage 时间戳护栏判定 | conex-compaction/src/lib.rs:678-685 |
| message-end 持久化（原文在事件流） | orchestrator/src/events.rs:47-57、188-194 |
| 事件表 append（payload TEXT） | conex-db/src/events.rs:8-27 |
| 会话正文表不可用（CHECK/全量替换） | conex-db/src/schema.rs:189-206；messages.rs:66-98 |
| 压缩事件恢复重放先例 | orchestrator/src/restore.rs:730-736、session.rs:160-165 |
| 代数先例（cache generation） | docs/cache-optimization/03-plans/P5-cache-telemetry.md:186、528 |
| ACP 三工具对照 | reference/billion-context-pi/src/compress-tool.ts:15-26、decompress-tool.ts:23-27、search-tool.ts:7-27、search-index.ts:76-92 |