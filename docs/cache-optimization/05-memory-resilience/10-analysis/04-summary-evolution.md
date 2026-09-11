# 04 摘要层演化：AI 记忆在线与摘要层可扩展（分析稿）

> 目录：`docs/cache-optimization/05-memory-resilience/10-analysis/04-summary-evolution.md`
> 性质：分析/设计文档（只读产出；本稿不落代码）
> 基线：P4-history-context-management.md §3.4.3 / §3.4.4 / §3.6（I1-I6）、04-audits/A2、A3、conex-compaction 既有实现
> 状态：草案（待裁决 → 转 20-plan）

---

## 0. 一页结论（决策清单）

| # | 议题 | 决议（建议） | 一句话理由 |
|---|------|-------------|-----------|
| D1 | 摘要存储格式 | **JSON 为唯一规范面（canonical），对话槽为 markdown 渲染投影** | 校验、合并、审计、机器消费全部走 JSON；模型可读与 token 经济留给渲染投影 |
| D2 | L1 静态占位符（AgentMessage 面） | **删除**；由"句柄 stub"取代（保留 `compacted-summary` 前缀）；旧 Message 面（UI 预览）占位符**保留不动** | L1 图文占位无信息量；句柄可追溯、可持续重试；旧面兼容面不动（lib.rs:216 迁移标记） |
| D3 | 摘要未就绪时上下文 | 插**句柄 stub**：block_id + dropped_ids + awaiting 状态（可追溯非丢弃） | 压缩失败≠会话终结；句柄指向 summary_documents 行，数据可会计 |
| D4 | 重试策略 | 会话级**后台单飞任务 + 指数退避 1s/3s/9s**（上限后保留句柄，加入下一轮压缩 existing 合并重试） | 引擎保持同步纯算子，调度与重试上浮到 session-loop；L1 删除后失败即"句柄 + 重试" |
| D5 | existing 迭代合并 | **通道保留但升级内容**：existing 传摘要文档（JSON 文本）；解析优先 summary_documents 表（block_id 解析），stub 文本兜底 | 修复既有"取第一条 / 失败吞既有摘要 / 拼接截断"三类缺陷 |
| D6 | 摘要就绪后何时入会话 | **run 内不改前缀（守 I1）**；就绪 = 写 summary_documents + 更行 stub 行（run 后由壳层写库）；下一轮压缩自然经 existing 合并 | 压缩是唯一前缀重写点（I1）；换轮水合即见到完整摘要 |
| D7 | I4 不变量 | 保持：Summarizer trait 无 session 亲和参数（existing 仍是纯文本参数） | 隔离由 trait 签名保证（invariants.rs:262-272） |
| D8 | 可选分层摘要 tier | schema 落 tier（chunk/rolling/final）与 height 字段，语义最简驱动（迭代合并自然产生 rolling），final 层列为后续 | 渐进落地不强上 |

---

## 1. 现状盘点（证据）

### 1.1 双面与链路

- **旧 Message 面**：`compaction::CompactionEngine::compact(&[Message])`（crates/conex-compaction/src/lib.rs:216-327），摘要固定：`[Compacted N earlier message(s) to fit context window]`（lib.rs:296-306），消息 id `compacted-summary-{n}`，供 UI 手动压缩预览 `core_compact_messages` 使用（IPC 兼容面，已标记"不再演进"，lib.rs:213-215）。
- **AgentMessage 面**：`estimate_context_tokens` / `find_cut_point` / `compact_agent_messages` / `should_compact`（lib.rs:347-540），session-loop 预算层与预检触发内联消费。

### 1.2 L1 静态摘要（AgentMessage 面）

- `summary_placeholder(dropped_count)`：crates/conex-compaction/src/lib.rs:749-752，返回 `[Compacted N earlier message(s) to fit context window]`。
- 使用点：
  - 无 Summarizer 注入（lib.rs:486-494）；
  - Summarizer 返回 Err 降级（lib.rs:475-485，P4 §3.4.4"失败不阻塞主对话"）。
- 语义问题（用户已指出）：图文占位无信息量；"压缩成功=摘要失败"时模型继续推进无记忆锚；无任何可追溯性（不知道丢弃了哪些消息、覆盖到第几轮）。
- 补充：**临界线（95%）硬压缩路径仍要一个"确定性、不依赖 AI"的结果**——删除 L1 后该路径产出句柄 stub，"确定性"语义迁移到 stub（确定性生成，不依赖 AI 调用），不丢失"临界线不依赖 AI"的防线语义（风险表 R6）。

### 1.3 双阈值与触发点（P4 §3.4.1）

- `CompactionThresholds`（lib.rs:77-121）：常规线 85% → `Regular`（后台预压缩走 AI 摘要通道，失败降级占位符）；临界 95% → `Critical`（同步硬压缩，走确定性占位符路径，lib.rs:60-72，对齐 jcode CRITICAL_THRESHOLD）。
- 触发点两个：preflight 预检（handlers/mod.rs:266-301 maybe_compact_preflight）＋溢出压缩阶梯（handlers/stream_error.rs:141-189 compression_ladder），共用 `compactions_this_run` 单 run 上限。

### 1.4 判断 L2 Summarizer / 五字段 / 重试护栏（crates/conex-compaction/src/ai_summary.rs）

- 五字段模板常量与生成函数：`SUMMARY_TEMPLATE_FIELDS`（ai_summary.rs:37）、`format_structured_summary`（ai_summary.rs:59-69）、`validate_structured_summary`（ai_summary.rs:81-97，行前缀匹配校验）。
- 提示词构建：`build_summarize_prompt`（ai_summary.rs:143-173），含迭代合并段（existing 以 "## 既有摘要（合并进新摘要…）" 原样前置入提示，ai_summary.rs:157-163）。
- 退化判定（对齐 grok MIN_SUMMARY_SEED_CHARS=500）：`is_degenerate_summary` / `is_acceptable_summary`（ai_summary.rs:188-199）——字符数兜底或"结构完整"兜底。
- 重试护栏：
  - `SummaryRetryPolicy`（ai_summary.rs:206-238）默认 max_attempts=3、间隔 3000ms、min 500 字符、wall-clock 300s；
  - `summarize_with_guard`（ai_summary.rs:281-326）：**同步阻塞**；失败/退化 → 等待定长间隔 → 重试至 budget；
  - `RetryGuardSummarizer`（ai_summary.rs:333-392）：把护栏折叠进 `Summarizer` trait，`last` Mutex 记最近结果供事件留痕。
- `covers_up_to_turn` / `compaction_event_details`（ai_summary.rs:400-429）：coversUpToTurn / degraded / summaryAttempts / droppedCount（02 Top 9：M11 拼接注入消费）。
- 退化语义现状：最终降级 → `Summarizer` 返回 Err → 引擎回退 L1 占位符（lib.rs:475-481）。

### 1.5 行程纪时钟结论：生产侧尚无真实 Summarizer 接线

搜索全仓库 `impl Summarizer for` 仅出现在测试（conex-compaction inline 测试、session-loop handlers/stream_error 测试等）。`SessionLoop::options.summarizer: Option<Arc<dyn Summarizer>>`（session-loop/src/loop/mod.rs:199、LoopState::new 复制 e 出 options.summarizer，handlers/mod.rs:90-105），壳层未注入 → **生产默认 L1 占位符**。P4 §3.4.4 注释："真实模型调用由调用方（壳层）实现 Summarizer 注入（经 agent-provider 通道，Q5 暂定引擎内部调用、独立小预算）"。

### 1.6 落库面（conex-db）

- `events` 表：`(session_id, sequence)` 复合主键、单连接互斥上锁（events.rs 14-27 append_event、72-99 reserve_sequence 原子取号）+ v5 schema（schema.rs:141-149）；`ContextCompressionEnd.record` 即以事件载荷落库（record 含 summary 文本、dropped_ids、kept_ids 等，handlers/mod.rs:360-382）。**事件面原子能力已具备**（摘要/句柄改写均可经此面落库）。
- `session_messages` 表：会话消息行（schema.rs:189-206），含 blocks_json/text；压缩摘要占位消息行由壳层在 run 收口水合路径写入（conversation → DB）。
- 迁移链：v1→v6 逐版本（conex-db/src/migrate.rs:98-…，user_version 驱动、逐版本独立事务幂等可重试）——摘要文档新表可挂 v7。

### 1.7 现有不变量（后续不破坏）

- I1 压缩是唯一前缀重写点（invariants.rs:98-169）。
- I4 摘要请求缓存隔离：Summarizer trait 签名只有 dropped + existing，无会话/缓存参数（invariants.rs:236-272、handlers/mod.rs:961-1039、stream_error.rs:737-…）。
- I6 估算口径 input_total 消费（invariants.rs:326-349）。
- 时间戳护栏 last_compaction_at（handlers/mod.rs:107、349-355）、单 run 压缩上限（mod.rs:107-113、273-274）。

---

## 2. 目标架构：AI 记忆在线（三面 + 生命周期）

### 2.1 三个面（本方案将摘要从"对话附文"提升为"一等文档"）

| 面 | 载体 | 内容 | 读写方 |
|---|------|------|--------|
| 占用槽（conversation slot） | 对话消息（assistant 角色） | **句柄 stub**（未就绪）或**markdown 渲染**（就绪+合并后） | session-loop 压缩时写 stub；壳层 run 后按 doc 更新行 |
| 摘要文档（document） | `summary_documents` 表（v7 新表） | **JSON 规范文档**（Schema V1 §4）＋状态（awaiting/committed/retired） | 会话级摘要调度器写；
| 事件（events） | events 表（既有原子面） | `ContextCompressionEnd`（record + details 扩展）+ 可选 `context-summary-ready` | apply_compaction（现有）、调度器完成回调 |

### 2.2 压缩生命周期（目标时序）

```
[触发：preflight 预检 Regular / overflow 溢出]
   → compact_agent_messages(...) 同步引擎（纯算法，不依赖 AI）：
       • 切割点 + 丢弃段（既有算法零改）
       • existing = 从 summary_documents（block_id 解析，session-loop 层解析传入）取旧文档文本
       • 摘要就绪？—— 就绪（缓存/上一次 committed 无未完成）→ 同步用 Summarizer 尝试合并
       • 未就绪 → 产出「句柄 stub」消息（compacted-summary-{stableId}，内容=渲染的待生成标记）
   → apply_compaction 广播 Start/End、写时间戳护栏（不变）
   → 会话级摘要调度器（新，session-loop 层）：
       • 单飞：同一 session 同时最多一个摘要任任
       • 指数退避 1s/3s/9s → 成功 → 写 summary_documents（JSON + state=committed）
                          → 成功但文档为准；失败 → 重试；退避耗尽 → state=retired，保留句柄
   → 壳层 run 收口：
       • conversation 消息落 session_messages（含 stub 行）
       • 若 doc state=committed：同时把 stub 行清理为完整 markdown 渲染（跨 run 水合可见），
         并追加 context-summary-ready 事件
   → 下一轮压缩：stub/旧文本进 existing 通道 → AI 迭代合并（文档 JSON 输入、文档 JSON 输出）
```

关键约束：**run 内不改前缀（守 I1）；stub 行内容更行只发生在收口/跨 run 时**（水合重建，不属于 run 内前缀重写）。

### 2.3 三层解耦（面向实现）

- **引擎层（conex-compaction）**：纯函数。新增"句柄/文档"数据结构与渲染/解析纯函数；Summarizer trait 与签名完整保留（I4 不动）；重试与调度全部在上层。
- **执行层（session-loop）**：压缩触发 + apply_compaction + 新「摘要调度器」（tokio 单飞任务、退避、状态机）。LoopState 增加 `summary_state` 面。
- **持久层（conex-db + 壳层）**：summary_documents 表（v7）、事件面扩展（records details 增 stub block id）、壳层收口"摘要就绪→ stub 行正文替换"与水合读取。

---

## 3. 摘要模板 Schema 草案

### 3.1 现状模板问题

- 六节骨架（lib.rs:941-963 structured_summary_template：Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）**内容恒 `(none)`**（静态），仅作为" L2 提示词 schema"存在；五字段模板（ai_summary.rs:34-42「任务目标/已完成/待办/关键决策/文件清单」）另行一套——两套模板语义分裂。
- 校验靠**行前缀字符串匹配**（ai_summary.rs:87-89 `line.trim_start().starts_with`），脆弱：条列换行、加粗、中英文冒号混排都会判非法；且 "custom 自由字段" 无表达面。

### 3.2 决议：JSON 为规范面（D1）

- **规范形态**：摘要文档为 JSON（Schema V1，见 §4），AI 输出为 JSON；校验/合并/审计/UI 渲染只认 JSON。
- **对话槽形态**：markdown 渲染投影（`summary_to_markdown`），面向模型的 token 经济与人读：
  - token 更省（JSON key 重复）；模型注入时无需解析；
  - 历史会话兼容（既有五字段 markdown 文本仍可被识别为旧摘要文档）；
  - 渲染性能为投影（非源），改写仅由渲染函数导致，不影响文档正文。
- **提示词形态**：`build_summarize_prompt` 输出要求改为"输出 JSON（满足 Schema V1）"，附带模板 JSON 示例；既有 five-field 文本函数保留兼容（读旧五字段文档时走解析兼容路径）。
- 校验函数：`validate_summary_json`（serde_json State + JSON Schema 手写校验，不用引入 crate 依赖——现状 zero deps 策略，手写 `validate` 与 `validate_structured_summary` 同风格）；**删除行前缀校验方式**（或保留仅向后兼容短格式）。

### 3.3 提案 Schema 草案（JSON Schema 形式）

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "conex-conversation-summary-v1",
  "type": "object",
  "required": ["schemaVersion", "blockId", "tier", "height",
               "droppedIds", "coversUpToTurn", "goal",
               "constraints", "progress", "decisions", "nextSteps",
               "criticalContext"],
  "additionalProperties": true,             // custom 自由字段（AI 扩展）
  "properties": {
    "schemaVersion":   { "const": 1 },
    "blockId":         { "type": "string" },            // 句柄块 id（可追溯锚点）
    "tier":            { "enum": ["chunk", "rolling", "final"] }, // 可选分层 §8
    "height":          { "type": "integer", "minimum": 1 },       // 迭代层数（每次合并 +1）
    "droppedIds":      { "type": "array", "items": { "type": "string" } },
    "coversUpToTurn":  { "type": ["integer", "null"], "minimum": 0 },
    "createdAt":       { "type": "string" },
    // ── 固定骨架（required，字段由 AI 决定内容；无内容可为空串/空数组）──
    "goal":            { "type": "string" },
    "constraints":     { "type": "array", "items": { "type": "string" } },
    "progress":        { "type": "array", "items": { "type": "string" } },
    "decisions":       { "type": "array", "items": {
        "type": "object",
        "required": ["topic", "detail", "reason"],
        "properties": {
          "topic":  { "type": "string" },
          "detail": { "type": "string" },
          "reason": { "type": "string" },
          "paths":  { "type": "array", "items": { "type": "string" } }  // 决策涉及路径
        }
    }},
    "nextSteps":       { "type": "array", "items": { "type": "string" } },
    "criticalContext": { "type": "string" },   // 关键原文（路径/符号/命令/错误串）
    // ── 结构化：路径 / 符号 / 计数（用户要求）──
    "paths":           { "type": "array", "items": {
        "type": "object",
        "required": ["path"],
        "properties": {
          "path":      { "type": "string" },
          "changed":   { "type": "boolean" },
          "note":      { "type": "string" }
        }
    }},
    "signatures":      { "type": "array", "items": {
        "type": "object",
        "required": ["name", "kind"],
        "properties": {
          "name":      { "type": "string" },   // 符号名（函数/类型/常量/工具名）
          "kind":      { "enum": ["function","type","const","tool","file","error"] },
          "file":      { "type": "string" }
        }
    }},
    "counts":          { "type": "object", "properties": {
        "messagesDropped": { "type": "integer" },
        "turnsCovered":    { "type": "integer" },
        "toolCalls":       { "type": "integer" }
    }},
    // ── 自由扩展面：AI 可增键（如 plan/risk/agentNotes）──
    "custom":          { "type": "object", "additionalProperties": true }
  }
}
```

要点：固定骨架在 `required` 里（校验机器可读）；「路径 / 决策 / 签名 / 计数」结构化字段；`custom` 为 AI 自由扩展面（键由 AI 决定——满足"字段由 AI 决定，而非写死六节"）；`height` 表达摘要迭代层（合并轮数）；`tier` 供可选分层。

### 3.4 与 L1→句柄的关系（句柄 = stub 语义）

句柄 stub 文档上取代 L1 占位的全部职责：

```
stub（未就绪时占位）：
  消息行：id=compacted-summary-<blockId>，assistant 角色
  text(渲染) = "> ⏳ 摘要生成中 (block `B-…`) — 合并 N 条消息，详见会话摘要"
  metadata（非渲染面）: { "summary": {
       "blockId": "<runId>-<seq>",       // 唯一、可追踪
       "state": "awaiting",              // awaiting | committed | retired
       "droppedIds": [...],              // 本条 stub 覆盖的消息（亦在 dropped_ids 事件）
       "height": 0                       // 尚未成功，height 不进位
  }}
就绪/失败后：
  state=committed → 壳层收口把 stub 行正文替换为 summary_to_markdown(文档)（水合后会话读到
                   完整摘要）；state=retired → 正文追加 "摘要生成失败（N 次，下轮压缩重试）"
```

可追溯非丢弃语义成立：`handleId` → `summary_documents.block_id` 行（含原始 JSON / attempts / 错误）；`droppedIds` 既在 stub 又在事件 record（`compressed_message_ids`）；消息未从水合去掉（进程还在会话里）。

---

## 4. (接收) L1 迁移流程（删除 → 改 → 回退）

### 4.1 三阶段

| 阶段 | 动作 | 范围 |
|---|---|---|
| 1（先行） | 增加 `summary_documents` 表（v7）+ 摘要调度器 + stub 生成 | 新增面，行为开关默认关闭，`compact_agent_messages` 仍走 L1 |
| 2（切换） | AgentMessage 面删除 L1：`summary_placeholder` 不再产出 L1 文本，改产出 stub；`compacted-*` id 保留前缀 | 双面并存期，改动表面积最大（测试翻拍见 §4.3） |
| 3（回退） | 单点回退开关（session_meta 键，如 `compact_l1_placeholder` 默认 false） | 保留"临界线不依赖 AI 的确定性占位"语义；出问题时一键回到 L1 文本路径 |

- L1 文本在旧 Message 面（compact().232-297）**永久保留**（IPC 预览工具，无 AI 依赖场景仍需要文本结果）。
- `summary_placeholder`（lib.rs:749-752）在阶段 2 后仅服务旧面（改名 `legacy_placeholder` 或以 Message 面私有），AgentMessage 面不再调用。

### 4.2 迁移后行为对照

| 场景 | 现状 | 迁移后 |
|------|------|--------|
| 无 Summarizer 注入（默认） | L1 占位文本 | 句柄 stub（awaiting→下轮合并；默认仍无 AI 摘要，stub 语义：可追溯 + 明确"待生成"） |
| 注入 Summarizer + 成功 | 五字段文本 | JSON 文档入库 + 渲染进槽；existing 通道带旧文档 |
| Summarizer 失败（重试耗尽） | 降级 L1 文本 | **stub（state=retired）**；下一轮压缩带 existing 重试（预算重置） |
| 临界线 | L1 文本（同步硬压缩） | stub（确定性生成，不依赖 AI；D4 语义保留） |
| 旧会话（已存在 L1 文本消息） | — | 视为旧摘要，经 existing 通道迭代合并（`compaction-*id` 前缀判定兼容） |

### 4.3 受影响测试清单（逐文件）

无 `crates/conex-compaction/tests/` 目录（实体全部为 `src` 内联 `#[cfg(test)]`）——所以"tests/ 有无受影响"的回答：目录不存在，受影响面在模块内联测试与下游集成测试：

| 文件 | 测试 | 影响 |
|------|------|------|
| conex-compaction/src/lib.rs | `compact_placeholder_uses_dropped_count`（1594-1612）、`compact_summarizer_error_falls_back_to_l1`（1741-1774）、`critical_line_hard_compression_deterministic_placeholder`（1911-1939）、`regular_line_ai_summary_five_fields_into_conversation`（1944-2002）、`structured_summary_template_sections`（1834-1851）、`compact_uses_summarizer_and_iterative_merge`（1696-1738） | 断言从"五字段/占位文本"改为 JSON 文档 ← stub；迭代合并断言从"文本 existing"改为"doc 文本 existing"；概要分层照旧 |
| 同文件 `compact_keeps_system_and_recent_with_placeholder`（1560-1591） | 结构断言（system+占位 id+保留段）**不变后退**（id 前缀保留），仅 summary 文本断言需更新 |
| 旧 Message 面测试 `compact_over_budget_compresses_oldest` 等 | **不改**（旧面保留 L1） |
| ai_summary.rs | `template_format_contains_all_five_fields`、`template_validation_rejects_missing_fields`（→校验换成 JSON schema）、`summarize_prompt_contains_template_and_dropped_context`、`acceptable_summary_accepts_valid_template`、`guard_*` 系列（重试语义保留但间隔语义改为退避列表）、`retry_guard_wrapper_*`（断言含 L1 文本 → 改 stub） | 大部分改写；护栏语义（次数/墙钟/退化）保留 |
| session-loop handlers/mod.rs | `summarizer_receives_dropped_only_and_err_falls_back_to_l1`（961-1039，断言 `[Compacted`）→ 改 stub 断言；`compaction_end_event_carries_plan_fields`（805-874）summary 文本断言更新；其余前缀/id 断言兼容 | 中 |
| session-loop invariants.rs | `i4_*`（签名无会话参数）——trait 签名保留则**不动**；`i1_*` 前缀语义断言兼容 | 不动或极小 |
| session-loop stream_error.rs | overflow 系列（`overflow_compaction_uses_summarizer_without_affinity` 等，均只断言 `compacted-summary` 前缀） | 不动 |
| session-loop tests/budget_compaction.rs | 只有前缀断言（144-148 等） | 不动 |
| orchestrator tests/multi_agent.rs | 767 行前缀断言 | 不动 |
| conex-db tests（migrate 链） | v7 迁移链新增断言 | 扩展（非破坏） |

---

## 5. 重试策略（"达到阈值持续尝试"）

### 5.1 调度模型变更（同步 → 会话级异步单飞）

日志当前 `summarize_with_guard` 是**同步阻塞**（ai_summary.rs:281-326）——生产接线后会把整个 run 阻塞最长 300s（wall-clock）。决议（D4/D5）：

1. **引擎保持同步纯函数**（1.4.1 无运行时依赖不动）；
2. **重试/等待/状态机全部上浮到 session-loop** 的会话级摘要调度器（新文件 `session-loop/src/loop/summary.rs`，或订阅到 streaming 循环安全点）；
3. 会话内**单飞**（single-flight）：同一 session 同一时刻至多一个摘要任务（`LoopState.summary_state`：`Option<SummaryTask { handleId, task, backoff_seq, attempts }>` 类比状态机 idle→awaiting→(committed|retired)）。

### 5.2 退避序列（用户定 1s/3s/9s）

```
t0     触发（preflight Regular / overflow）
        摘要任务发放：summarize(dropped, existing)
失败 → wait 1s → 重试
失败 → wait 3s → 重试
失败 → wait 9s → 重试（第 4 次尝试）
失败 → 会话级状态 retired：stub 保留（attempts=4 落 summary_documents.state=retired）
        不抛错、不阻塞主对话；下轮压缩 existing 合并时重试（预算重置）
成功 → state=committed，文档入库
```

- 退避默认生产参数 `[1s, 3s, 9s]`（可配：session_meta `compact_summary_backoff_ms` JSON 数组，默认 `[1000,3000,9000]`）；附加 ±20% jitter 防多会话同频。
- 强退兜底：单会话最长等 = 1+3+9=13s＋单次调用时间；若调用本身 wall-clock 上限（对齐现行 300s 预算理念，降至 ~60s）——`LOOP_SUMMARY_MAX_WALL_MS`。
- **超上限后的走向**（用户裁决重点）：句柄保留（valid + 可追溯），并**加入下一轮压缩的 existing 合并**——因为句柄消息 id 走 `compacted-summary` 前缀，被下一轮 dropped 后其 stub 文本进 existing → 摘要器重新尝试（预算重置）。因此" 持续尝试"是多轮语义：每轮压缩窗口内退避 3 次，跨轮持续。

### 5.3 退化判定适配

- `is_degenerate_summary` 语义保留，但对 JSON 文档判定从"字符数"改为"JSON 解析成功 + required 字段齐全 + 不计 custom"（`validate_summary_document`）。
- `retry_allowed` 从"次数+墙钟"改为"退避序列索引 ≤ len + 墙钟"（保留 session_meta 键命名空间 `compact_summary_*`，逻辑一致）。

---

## 6. 迭代合并（existing 通道）现状 good 与缺陷

### 6.1 现状 good（保留面）

- `existing` 检测：`compact_agent_messages` 在切割段内扫 `compacted-summary` 前缀消息取 `text()` 首个非空（lib.rs:459-473），**逐步正确**（前缀内不会混入其他消息）。
- 合并语义已双保险实现：`ai_summary.rs::build_summarize_prompt`（157-163）把 existing 全量前置；`lib.rs::truncate_summary`（1627-1635）摘要后会钳制预算。
- `structured_summary_template` 直接拼接 existing + 骨架（lib.rs:963-972）。
- 事件侧 `compaction_event_details` 已留 `coversUpToTurn` 供 M11 拼接注入。
- 测试 `compact_uses_summarizer_and_iterative_merge`（lib.rs:1696-1738）钉死 existing 传链。
- `summarizer_receives_dropped_only_and_err_falls_back_to_l1` 证明首次压缩 existing==None（C14 边界语义）。

### 6.2 缺陷（升级动机）

| # | 缺陷 | 证据 | 影响 |
|---|------|------|------|
| E1 | existing 只有裸文本，无元数据 | 传输面仅有 `Option<&str>`（condu 签名 constraints）——awaiting/block_id/attempts 无处传递 | 无法表达"摘要还在生成中"的合并语义 |
| E2 | 多摘要消息时只取**第一条** | lib.rs:462-464 `filter().find()`（若历史残留多条 compacted-summary 消息） | 链式合并丢失后段 |
| E3 | 合并失败吞既有摘要 | 失败路径用 L1 文本**整体覆盖**（lib.rs:475-481），旧摘要内容消失在事件里 | 内容损失（记忆断裂） |
| E4 | existing 未转 budget 截断（truncate 只作用于输出） | truncate_summary（lib.rs:758-775）作用于最终文本，existing 原样接入 prompt | 长会话链上 prompt 无界膨胀 |
| E5 | 合并 = "文本拼接" 而非结构级合并 | 前置 text 合并（ai_summary.rs:157-163）；模型被要求"合并不要重复" | JSON 时代应升为"字段级合并"（doc-level iterative merge） |
| E6 | 摘要消息 id 不稳定 | `compacted-summary-{dropped_ids.len()}`（lib.rs:503）——同实例两次同丢弃数→同 id | handle/索引定位不稳；block_id 应为全局唯一（run-init counter 或 uuid 语义） |
| E7 | apply_compaction 不广播摘要消息的 message-start/end | mod.rs:349 只是 `conversation = plan.messages`，无消息事件 | UI 不会实时展示摘要消息（现靠 ContextCompressionEnd.record.summary 载荷兜底） |

### 6.3 升级口径（D5）

- existing 从"后缀消息文本"改为"摘要文档文本"：解析优先 `summary_documents(height/state)`，未命中才用 stub 文本兜底；
- stub 文本亦为 1 行内 JSON（或 markdown 渲染），确保 existing 通道的输入统一为结构化摘要；
- 合并语义：AI 输出要求为"旧文档 + 新 dropped 增量 → 新 JSON（`height+1`）"，不再裸拼接两段 text；
- E3 修复：失败路径不覆盖既有文档——句柄 stub 保留源文档可读（`last_doc` 不丢，state=retired 仍可从 summary_documents 读到）。

---

## 7. 多 Agent（subagent）场景的并发边界

### 7.1 事实（代码证据）

- 子 Agent 各自拥有独立会话与独立 `ConverstSession`（orchestrator 调度 N 会话并行，multi_agent.rs 测试两个 run 并行执行）。
- Summarizer 注入点 per LoopState（options.summarizer，构造期一次，handlers/mod.rs:134）；若壳层/协调器**共享同一个 Arc<dyn Summarizer>** → 并发多会话会撞上 `RetryGuardSummarizer` 的内部互斥：
  - `wait` 锁（ai_summary.rs:337 锁 + 373 `lock`）→ 把并发摘要**序列化**（等待窗口吞满）；
  - `last` 锁（ai_summary.rs:357-359 读最近结果）→ 会话间串扰（A 会话的 last_outcome 被 B 读取）。
- DB 层面单连接锁互斥（events.rs:15-19）→ 同一时刻只有一个 DB 写者，天然串行（限制是调度层）。
- 摘要请求与主请求共用 provider 通道（壳层实现）——多会话同时触发时构成 provider 并发深入。

### 5.3（结构化）隔离决议

| 面 | 决议 | 实现 |
|----|------|------|
| 会话级 | 每会话独立 Summarizer 实例（`SummarizerFactory` 按 session 创建；共享 provider 客户端但无共享可变状态） | 壳层注入点改造（SessionLoopOptions.summarizer 保留，增加 per-session 构造约定）；RetryGuardSummarizer 内 Mutex 仅存在 per-session 形态 |
| 并发 | 会话级单飞（同会话同时至多 1 个摘要任务）；跨会话并行允许，受全局并发上限约束 | LoopState.summary_state 单例 + tokio JoinHandle；全局 `MAX_CONCURRENT_SUMMARY_TASKS`（默认 2）在调度器入口处计数 |
| 幂等 | 摘要写入以（session_id, block_id）幂等（INSERT OR IGNORE / ON CONFLICT） | summary_documents 表 unique(session_id, block_id)；事件追加幂等（sequence 幂等原子） |
| provider 限流 | 退避含 jitter；摘要通道失败归类（429/5xx）区分重试 vs 放弃（认 `RateLimit` 重试、`InvalidRequest` 直 retired） | 调度器把 `Summarizer` 的 Err 内容按错误码细分（对齐 stream_error 的分类理念） |
| 文件互斥 | 摘要文档落库与现有文件写互斥无需额外（doc 表进程内 DB 锁已互斥）；多 Agent 写 `reference/markdown-editor` 等文件的现有互斥不重叠 | 无新机制 |

注意：I4 约束（无参数）与 per-session 实例不冲突——签名不变，隔离靠实例化边界，不强加 session_id 到调用参数。

---

## 8. 可选：分层摘要（tier）

- **动机**：迭代合并让摘要越滚越大（max_summary_tokens 钳制的天花板是" 唯一 budget"）；对于超长会话（跨 N 轮），单摘要求在体积与信息间反复竞争。
- **Schema 面已就绪**：`tier`（chunk/rolling/final）＋`height`（每轮 +1）＝文档自带层位。
- 语义：
  - `chunk`：单轮压缩产物（height=1）；
  - `rolling`：合并过后代（height>1 即为 rolling 语义，**不新增代码路径**——迭代合并通道天然产出）；
  - `final`：会话收尾/跨会话大节点（人工触发 or 开关 `compact_summary_final_on_stop`，未来接入）。
- 落地优先级：**仅落 chunk/rolling（无状态升级）**；final 列为后续（需要 finalizer 提示词与触发点，P4 §3.5 溢出处理与 Stop 收口都可悬念）。

---

## 9. Task 清单

### 9.1 引擎层（conex-compaction）

| # | 位置 | 任务 | 验收 |
|---|------|------|------|
| T1 | 新文件 `crates/conex-compaction/src/summary_document.rs` | JSON Schema V1 常量 + `validate_summary_document`（serde_json 解析 + required 校验 + 顶置 budget 检查）+ `summary_to_markdown` 渲染函数 + `markdown_to_document` 兼容解析（旧五字段/六节文本） | 单向/回环测试：doc→md→doc 无损（业务字段）；旧五字段文档可解析 |
| T2 | lib.rs（AgentMessage 面）：`summary_placeholder`（750-752）与 4 号分支（475-494） | 改为 `stub_placeholder`（确定性生成：awaiting 渲染）+ state 元数据进 Plan；抹号后输出（stub | async ready 文档文本二者择一，通过 `Option<Summary>`) | 决定：引擎输入改为 `Option<SummaryDocumentInput>`（summary 就绪供同步合并；未就绪 → stub） |
| T3 | lib.rs：`compacted-summary-{len}`（503） | id 改为稳定句柄（`compacted-summary-{run_id}-{seq}`），新增 Handle 生成 | 生命周期唯一性测试（同一 N 两次压缩 id 不同） |
| T4 | lib.rs：existing 抽取（462-464） | 从"首个非空文本"改为"首个 `compacted-blocker`（stub 或 doc 文本）→ 序列化进 SummaryInput" | 多条时按会话顺序取最新（index_max），不丢似文 |
| T5 | ai_summary.rs：模板/提示词/校验/重试 | ① 提示词改 JSON 输出（附 Schema 示例）；② spark 判定改 JSON schema 校验；③ `SummaryRetryPolicy` 增加退避序列 `backoff_ms: &str` 数组 + jitter；④ `summarize_with_guard` 参数化延续 | 既有护栏测试语义保留（次数/时长/退化）；新 JSON 测试 |
| T6 | ai_summary.rs：`compaction_event_details`（417-428） | 扩展 `handleId` / `stubOnly` / `summaryState` 事件载荷（shape 保持 camelCase 测试回环） | 事件载荷 shape 测试扩展 |

### 9.2 执行层（session-loop）

| # | 位置 | 任务 |
|---|------|------|
| T7 | 新文件 `session-loop/src/loop/summary.rs` | 会话级摘要状态机（idle/awaiting/committed/retired）＋ `spawn_summary_task(handle)`＋退避（1s/3s/9s±jitter）＋单飞（JoinHandle 存 LoopState）＋完成回调（写库钩子，由壳层注入） |
| T8 | LoopState（handlers/mod.rs:61-119） | `summary_state: Option<SummaryTaskState>`；with_options 时 `summarizer` 语义不变（per-session 由壳层创建） |
| T9 | prepare_turn 预检（handlers/mod.rs:266-301） | Regular 触发同步引擎（stub 路径即在此产出）→ 同时干 spawning 摘要任务；临界线只 stub 不上任 |
| T10 | stream_error.rs compression_ladder（141-196） | 同上管道；溢出场景可复用 T7 单飞（若同 run 已有任务则忽略新 spawn——单飞） |
| T11 | apply_compaction（mod.rs:314-403） | stub 消息不 broadcast message-start/end（保留现状）；End record 增补 handle 字段；`compression_event_details` 集成 |

### 9.3 持久层（conex-db + v7）

| # | 位置 | 任务 |
|---|------|------|
| T12 | schema.rs v7 新增 | `summary_documents(session_id, block_id PRIMARY KEY, schema_version, height, tier, document_json, state, attempts, created_at, updated_at)` + 索引（session_id, updated_at） |
| T13 | migrate.rs | v7 迁移（幂等、备份契约沿用） |
| T14 | 新文件 `conex-db/src/summary_documents.rs` | `save_document`（upsert 幂等按 session_id+block_id）/ `get_document` / `list_documents` / `mark_state` |
| T15 | （壳层）agent-workbench run 收口 | RunOutcome 序列化后：把 conversation stub 行与 summary_documents 对齐；state=committed → stub 行正文替换为渲染 md（写 session_messages 行）；追加 summary-ready 事件 |

### 9.4 凭证/接線

| # | 位置 | 任务 |
|---|------|------|
| T16 | apps/agent-workbench | 真实 Summarizer 注入（HttpProviderCall 小预算、独立前缀域、per-session 实例）；`SummarizerFactory` |
| T17 | session-meta 键 | 新增 `compact_summary_backoff_ms` / `compact_summary_max_concurrent` / `compact_l1_placeholder`（回退开关）等与既有 `compact_summary_*` 命名空间对齐（链接现有键：max_attempts / retry_interval_ms / min_chars / wall_clock_budget） |

### 9.5 文档

| # | 任务 |
|---|------|
| T18 | P4 §3.4.3/3.4.4 升级：五字段 → JSON Schema 文档、existing 通道（LibraryName doc 语义）、重试语义（异步+退避）与 I4 释义更新；docs/cache-optimization/00-index.md 与 90-final 执行主线登记本次改动 |

---

## 10. 测试策略（不破坏既有门禁）

### 10.1 门禁边界（不动）

- `reference## markdown-editor` 的 `npm test`（vitest run tests/unit：grapheme/undo/parser-redos/chunk）——纯 Rust 改面，**不触碰**；e2e 采五个专项 spec 不触碰。
- 前端 `typecheck + unit coverage` —— 不触碰。
- Rust `cargo test --workspace` —— 新增面全数不破坏既有；**回归重点**见 §4.3 清单（改断言但保语义）。

### 10.2 新增测试（按层）

| 层 | 用例 |
|----|------|
| conex-compaction | `validate_summary_document`（合法/缺字段/自定义扩展）；`summary_to_markdown`↔`markdown_to_document` 往返；`stub_placeholder` 确定性（同输入同输出）+ 预算截断；`handle_id` 唯一性（同一 N 两次压缩）；existing：两条 compacted 取最新（E2 修复）；摘要失败不覆盖既有文档（E3 修复）——`plan.summary` 保持 stub 且既有文档可读 |
| conex-compaction ai_summary | JSON 提示词生成（模板+Schema 示例+旧文档合并）；JSON 退化判定；退避序列断言（wait 记录=[1s,3s,9s] 注入版）；jitter 上下界（注入随机）；retired 转发（失败 4 次 → retired，attempts=4） |
| session-loop | 单飞：同会话两触发只 spawn 1 任务（JoinHandle 计数）；单 run 上限与摘要任务解耦（摘要不占 compactions_this_run）；awaiting 状态会话对话含 stub 消息、不阻塞主 turn；退避期间 run 完成（stub 保留、doc 待写）；committed 后：会话收口 stub 行被替换逻辑（引擎结构读 datastructure）；existing 通道带 stub 文本进入摘要（调用捕获断言） |
| session-loop stream_error | overflow 路径 spawn uncontested（撞击→忽略——进程内） |
| conex-db | v7 迁移链（fresh v5 → v7、旧库 v6→v7 幂等重跑）；summary_documents upsert/get 幂等（同 block_id 二次写覆盖不重复行）；（可选）mock 壳层收口整合：写 session_messages stub 行 → doc committed → 行内容替换渲染 + 事件追加 |
| orchestrator | 多会话并行摘要并发约束（2 会话同时 compressed → 单飞数 ≤2；共享 Summarizer Mock 记录调用数/交错）——明确"不串扰"断言（last_outcome 各自会话） |
| 兼容 | 旧五字段/六段既有摘要（历史库/历史消息）→ `markdown_to_document` 解析成功 → 新通道合并第一步不丢内容 |

### 10.3 门禁执行（提交前必跑）

```bash
cargo test -p conex-compaction          # 引擎内联（含新 summary/schema 单测）
cargo test -p session-loop              # handlers + invariants + stream_error
cargo test -p conex-db                  # v7 迁移 + summary_documents
cargo test --workspace                  # 基线（73 套）全绿
# 前端媒（re markdown-editor / vitest）不受影响，跑一遍确认（快层口径）
```

---

## 11. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|------|------|------|
| R1 | JSON 文档 token 成本高于 markdown（同内容 ~1.2-1.5x） | 槽位预算 | 槽渲染用 markdown（D1 投影）；JSON 只在库/合并（库不占主请求前缀）；需在提示词引导 "custom 与字段精炼" |
| R2 | 摘要异步导致"第一轮压缩后立即继续（run 内）看不到全文" | 用户体验（摘要延迟可见） | 句柄 stub 渲染明确"生成中"；重试 ≤13s；run 收口后水合即全文；若 run 立即继续（连续发送）→ 摘要可能落后 → 单飞+schedule 保序 |
| R3 | stub 渲染文本进入模型 token → 训练污染/被模型误解析 | 摘要 stub 语义 | stub 文本简短（一行）+ 明确标记"（待生成）"；不进摘要提示词正文（existing 只取 doc 文本，不取 stub 文本转述）|
| R4 | 摘要失败重试多次（3+1 次）且都失败 → stub 永久占据 | 槽位单行成本 | `retired` 态 + 下轮合并重试（预算继续）；入 `compact_summary_max_attempts` 上限（改配退避次数）；retired 文本加"（N 次失败，下轮压缩重试）"，不阻塞 |
| R5 | JSON 文档过大上超 max 预算 → 合并后截断破坏文档 | 存取 | 预算钳制在文档层做（结构裁剪 custom/paths/signatures —— O(1) 按配额）；绝不 byte-截断 JSON（保解析）；渲染截断仅发生在 md 槽（truncate_summary 后置） |
| R6 | 临界线硬压缩失去"不依赖 AI"防护假设 | 无 LLM 时摘要空转 | 临界线路径：**不 spawn 摘要任务**（只 stub）；stub 文本确定性；`compact_l1_placeholder` 回退开关 |
| R7 | I1/段重写纪律扩大（摘要就绪后壳层回写 stub 行） | 前缀稳定性怀疑 | 明确定界：run 内不写（I1 只跑 run 内）；run 后落库/水合重入是会话历史更新，非前缀重写；`summary_state` 在 run 起始 reset，避免跨 run 冲突 |
| R8 | 多会话并发摘要打爆 provider（限流） | 会话卡顿/费用 | 全局并发上限（默认 2）+ jitter 退避 + 429 分类直 retired（不空转）；引擎锚定"摘要失败不阻塞主对话"第一原则 |
| R9 | 迁移链 v7 与旧库兼容 | 升级风险 | 沿用逐版本事务/幂等/备份语义；`summary_documents` as 新表（非改既有表）→ 影响面最小 |
| R10 | `validate_structured_summary` 行前缀校验移除破坏既有测试 | 回归 | 保留兼容解析函数（五字段文本→文档），不删接口面（软迁移）；测试改接新函数但保持旧断言覆写了一条兼容断言 |
| R11 | .agent-outputs / 会话删除路径与 summary_documents 引用 | 孤儿行 | FK 到 session 或会话删除时清洗（v7 表 ON DELETE CASCADE / 壳删除逻辑同步）；本稿不强制（列为 T15 检查点） |

---

## 12. 待裁决点

1. **JSON 规范面 + markdown 投影**（D1）是否接受（替代纯 markdown 方案）。
2. **重试上限**：退避至多 1s/3s/9s（4 次尝试）后 retired vs 更长期"持续每轮压缩重试"——本稿默认前者、后者经 existing 通道延续。
3. **tier（分层摘要）**：chunk/rolling 落地、final 推迟（§8）——是否接受。
4. **句柄块唯一性 id 方案**：`run_id-uuid` 生成（id= `compacted-summary-<runid>-<seq>`）vs 复用 seq 计数器（后有 E6）——建议前者。
5. **summary_documents 表 vs 全走 events**：events 已有原子面但摘要需大量查改（height/state/attempts），建议独立表（D 体系）；若嫌示意膨胀可选纯 events（summary-ready 事件携带全文）——需裁决存储面归属。

---

## 附：关键文件索引

- crates/conex-compaction/src/lib.rs（双面引擎、L1、existing、structured_summary_template 963-972）
- crates/conex-compaction/src/ai_summary.rs（模板、护栏、重试、details）
- crates/session-loop/src/loop/handlers/mod.rs（apply_compaction 314-403、preflight 266-309）
- crates/session-loop/src/loop/handlers/stream_error.rs（overflow 阶梯 141-189）
- crates/session-loop/src/loop/invariants.rs（I4 262-272）
- crates/conex-db/src/events.rs（原子事件）、schema.rs（v5）、migrate.rs（v1-v6 链）
- docs/cache-optimization/03-plans/P4-history-context-management.md（§3.4.3/3.4.4 溯源）