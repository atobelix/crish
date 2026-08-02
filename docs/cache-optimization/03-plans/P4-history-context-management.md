# P4：会话历史回流 LLM 与上下文管理（含 compaction 接线与超限恢复）

- 撰写日期：2026-08-03
- 文档性质：优化方案（只读 + 本文档；未修改任何源代码）
- 输入材料：
  - `docs/cache-optimization/02-comparison/comparison.md`（差距 ①历史消息不回传 LLM = 最大差距，本方案解决）
  - `docs/cache-optimization/01-reference-research/` 的 pi / opencode / jcode / codex-cli 四份分析
  - crish 实际代码（全部经本代理实读核实，行号以实读为准，见 §2 清单）
- 方案定位：缓存优化计划 P 系列中的 **P4**。依赖 P1（请求前缀稳定：tools 排序 + system prompt 透传）与 P2（usage 归一化）；与 P5 边界：**P5 负责测量展示，P4 负责提供压缩/上下文事件**。

---

## 结论先行

**P4 解决 crish 最大的缓存差距：跨 run 历史不回传 LLM（comparison.md:16、:28 差距 ①/13）。** 三个核心设计决策：

1. **历史回流采用「前端水合兜底 + 引擎侧 per-session 历史缓存」混合路线**：`core_run_task` 增加可选 `history` 参数（前端从 store 取已完成消息，仅引擎缓存为空时使用），引擎侧（壳层 CoreRunState）维护 `session_id → 历史消息` 缓存，run 之间以 `RunOutcome::messages` 零拷贝续接，经已存在的 `with_initial_conversation_arc`（mod.rs:300-303）水合进 loop。**持久化权威仍在 UI，引擎缓存只作请求构造上下文，不落库、不改写现有会话语义**。
2. **请求前预算估算 + max_tokens 钳制**：`usage 优先（时间戳护栏）+ count_tokens 启发式兜底` 双源估算（对齐 pi estimate.ts），`clamp = contextWindow - estimate - 4096`（对齐 pi simple-options.ts:12-19），压缩阈值 `estimate ≥ window - reserve(16384)`（对齐 pi compaction.ts:235-237）。
3. **compaction 接线进真实触发链**：`prepare_turn::handle` 步骤 5 的既有预留点（prepare_turn.rs:71-73）恢复阈值触发；`stream_error.rs` 的 `ContextLengthExceeded`/`PayloadTooLarge` 在 length_ladder 用尽后进入「压缩阶梯」（压缩 + 重试一次，上限 1 防死循环）；保留策略 = 合法切割点（tool use/result 不拆散）+ `keepRecentTokens(20000)` + 结构化摘要；摘要请求缓存隔离（独立前缀域）；压缩后时间戳护栏 + 单 run 压缩上限防重触发。压缩事件（`ContextCompressionStart/End`，events.rs:236-252）已存在，P4 负责填写并广播，P5 消费展示。

---

## ① 目标与范围

### 1.1 目标

1. **让模型获得多轮记忆，让服务端自动前缀缓存获得跨消息的物理前提**。当前每次 run 只发一条新用户消息（engine.rs:755-773），模型是"独立对话"形态，缓存命中率恒为零（comparison.md:373-375）。
2. **请求前知道上下文多大**：发请求前用「usage 实测 + 本地启发式」估算输入 token，钳制 `max_tokens`，从源头防止一次请求把上下文打爆（对齐 pi clampMaxTokensToContext）。
3. **把已实现但未接线的 CompactionEngine 接进真实触发链**：阈值预检触发 + 溢出恢复触发，并把 `PayloadTooLarge` 从"直接 fatal"（stream_error.rs:50-53）改为"真实压缩 + 重试一次"。
4. **建立缓存交互不变量**：compaction 是唯一的前缀重写点；动态注入内容一律放 user 尾部；压缩前后维护时间戳护栏与防重触发护栏，保证压缩不会引发"每轮压缩"震荡。

### 1.2 范围

**做**：

- session-loop：历史水合路径（复用 `with_initial_conversation_arc`）、预算估算与钳制、compaction 触发链（prepare_turn 预检 + stream_error 压缩阶梯）、护栏状态、压缩事件广播。
- conex-compaction：新增 AgentMessage 面（适配层 + 合法切割点 + tool 配对保护 + 结构化摘要占位 + 可选 LLM 摘要接口）；`count_tokens` 增强（块级估算 + 图片固定计价）；保留原 `Message` 面兼容 `core_compact_messages`。
- conex-types：新增/补齐预算与压缩配置类型（`ContextBudget`、`CompactionPolicy` 等，尽量复用既有 `ContextCompressionRecord`/`ContextCompressionCacheBoundaryMetadata`，tool.rs:381-489）。
- orchestrator：会话上下文元数据协调（压缩边界 / usage 基线随会话记录持久化，restore 时恢复，保证护栏状态跨重启不丢）。

**不做**：

- 不做 tools 排序 / system prompt 透传 / 前缀哈希（P1 范围，本方案在 §6.1 列为前置依赖并在设计上留好接口位）。
- 不做 usage 字段补齐与恒等式（P2 范围；本方案只消费 P2 归一化后的 `ProviderUsage`）。
- 不做命中率 / miss 审计 / UI 统计面板（P5 范围；P4 只负责产出压缩事件与透传数据）。
- 不做后台（异步）压缩、proactive/semantic 压缩、WebSocket 增量传输（列为本方案后的演进项，见 §6.5）。
- 不做 Anthropic 断点 / prompt_cache_key / 会话亲和头（属 P1/P3 或后续厂商适配面，本方案只保证"前缀稳定 + 压缩是唯一重写点"这两条不变量）。

### 1.3 验收红线

- 不破坏现有会话语义：UI 水合 / 持久化方向（UI → DB → UI）不变；`core_run_task` 新参数全部可选，不传时行为与现状完全一致（单消息 run）。
- 不引入双写：引擎侧历史缓存是内存态，**不落库**；conex-db 的 session_messages 仍由前端全量写（conex-db/src/messages.rs:51-99）。
- 压缩不得丢用户可见语义：切割点合法、tool use/result 不拆散、摘要可读；压缩后 run 收口 `RunOutcome::messages` 携带压缩后序列（跨 run 续接语义自然成立）。

---

## ② 现状证据

以下全部为本次实读核实（代码路径以仓库根 `C:\Software\conex` 为基准）。

### 2.1 历史不回传（最大差距）

| 证据 | 位置 | 说明 |
|---|---|---|
| 主路径每次 run 只发新用户消息 | `apps/agent-workbench/src-tauri/src/engine.rs:755-773` | `SessionLoopProducer::produce` 构造全新 `AgentSessionLoop` 后直接 `run(self.user_message.clone())`，对话为空，无 `with_initial_conversation_arc` 调用 |
| 注释与实现不符 | engine.rs:753-754 注释"对话由 store 水合承担" | produce 内无任何水合代码；store 水合从未接线 |
| 消息映射链已存在 | `crates/agent-provider/src/request/messages.rs:318-395` | `to_chat_messages` 已完整映射 AgentMessage（user/assistant/tool/system 四角色 + tool-call + tool-result + reasoning_content），历史回流的 wire 映射可直接复用 |
| `ProviderRequest` 只带当前 run 对话 | `crates/session-loop/src/provider.rs:74-81` | `messages: &'a [Arc<AgentMessage>]` 直接借用 `state.conversation`（streaming.rs:253-259 `build_request`），loop 内对话跨 run 不可见 |
| 对话收口 mem::take | `crates/session-loop/src/loop/mod.rs:509-530` | `converge` 把 `state.conversation` 移交 `RunOutcome::messages` 后清空；loop 实例跨 run 也不持有历史 |
| run 命令无历史参数 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:919-929` | `core_run_task` 签名（run_id/session_id/prompt/mode/cwd/permission_mode/client_message_id/assistant_client_message_id）**无 history、无 system_prompt** |
| 前端传了 systemPrompt 但被静默丢弃 | `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:307` | `startRunTask` 参数含 `systemPrompt`，但 serde 无对应字段 → 静默忽略（comparison.md:18、:97） |
| 会话持久化单向 | `crates/conex-db/src/messages.rs:9-47` | `load_session_body` 返回 UI 扁平模型 `Vec<SessionMessage>`（id/sender/text/thinking/timestamp/status/…/blocks_json/tool_calls_json/tool_call_results_json，conex-types/src/lib.rs:136-158）；存储方向 UI→DB→UI，从不回流 run-loop |

### 2.2 预算面现状

| 证据 | 位置 | 说明 |
|---|---|---|
| `DEFAULT_MAX_TOKENS = 8192` | `crates/session-loop/src/loop/mod.rs:47` | length 阶梯起点；无窗口概念 |
| 发请求无估算/无钳制 | `crates/session-loop/src/loop/handlers/streaming.rs:253-259` | `build_request` 直接透传 `state.max_tokens` |
| 启发式 token 计数已有 | `crates/conex-compaction/src/lib.rs:134-173` | `count_tokens`：ASCII 单词 4 字符/token + 分隔符 1 token + 非 ASCII（CJK）1 token/字符；可复用但只接受 `&str`，无块级/图片处理 |
| usage 已解析但无消费 | `crates/agent-provider/src/events.rs:33-52`（ProviderUsage 六字段）；`streaming.rs:291-332` `build_assistant_message` 把 usage 写进消息 metadata | 数据到了消息里，未参与预算决策；P2 补齐 DeepSeek 顶层 hit/miss 后才有可靠命中测量 |

### 2.3 超限恢复现状

| 证据 | 位置 | 说明 |
|---|---|---|
| ContextLengthExceeded → max_tokens 翻倍 | `crates/session-loop/src/loop/handlers/stream_error.rs:77-93` | 8192→16384→32768，上限 2 次；**只放大输出预算，对输入超限无效**（comparison.md:24、:231） |
| stopReason=length 同款阶梯 | `crates/session-loop/src/loop/handlers/no_tool_calls.rs:27-45` | length 截断 = 输出预算问题，压缩输入对它无效（本方案维持现状） |
| PayloadTooLarge → 直接 fatal | stream_error.rs:50-53、:95-99 | 注释明言"真实压缩（scrubImagesOldestFirst）落地时恢复本阶梯" |

### 2.4 compaction 现状

| 证据 | 位置 | 说明 |
|---|---|---|
| CompactionEngine 已实现未接线 | `crates/conex-compaction/src/lib.rs:4-128` | 预算内不动；超预算保留 system + 最近 2 条非 system + 中间消息反序挑选 + 静态摘要占位符；`cache_hit_rate_optimized` 标记 |
| 引擎模型与 AgentMessage 不兼容 | conex-types/src/lib.rs:84-92 | `Message` 只有 id/role/content/images 三字段；AgentMessage 是 blocks 结构（conex-types/src/message.rs:34-50、:100-126），需要适配层（comparison.md:212） |
| 压缩是纯 IPC 工具命令 | `apps/agent-workbench/src-tauri/src/core_commands.rs:191-207` | `core_compact_messages(messages, max_tokens)` 已注册（main.rs:108、command_manifest.rs:104），无循环内消费者 |
| 循环内触发点被删除 | `crates/session-loop/src/loop/handlers/prepare_turn.rs:71-73` | 步骤 5"上下文压缩（已删除，T06.2.3 Q04：CompressionHook 死配置无消费者）"——本方案在此恢复真实触发 |
| 压缩事件类型已存在 | `crates/conex-types/src/events.rs:236-252` | `ContextCompressionStart` / `ContextCompressionEnd`（含 `ContextCompressionRecord`，tool.rs:465-489，含 tokens_before/after、first_kept_message_id、cache_boundary 等）——契约就绪，只差接线 |
| 引擎没有窗口元数据 | `apps/agent-workbench/src-tauri/src/engine.rs:218-233` | `RequestBuildContext { system_prompt: None, … }`；无 context_window / reserve 概念（依赖 **P3** 模型目录提供窗口元数据，`context_window_for`，P3 §3.1.5；见 §6.1）【A1 审计修正：原稿"依赖 P1/00 目录"归属错误，模型目录属 P3】 |

### 2.5 恢复/持久化现状

| 证据 | 位置 | 说明 |
|---|---|---|
| orchestrator 恢复不涉及消息正文 | `crates/orchestrator/src/restore.rs:515-638` | `restore` 恢复 runs（in-flight → interrupted）/会话记录/pending 输入/事件锚点；**无会话消息正文**（正文在 UI 侧 store / conex-db session_messages） |
| 会话记录可扩展 | `crates/orchestrator/src/restore.rs:271-292` | `StateSnapshot`（sessions/runs/pending/checksum）schema_version=1；扩展会话级元数据需 bump schema 或加可选字段 |

---

## ③ 设计

### 3.1 总体管线

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 水合层（历史回流）：保证 build_request 携带"完整可缓存前缀"                 │
│   前端 store（首 run / 重启后，可选 history 参数）                         │
│       ↓ 映射为 AgentMessage（完成态过滤）                                  │
│   壳层 SessionHistoryCache（per-session 内存缓存，CoreRunState 持有）     │
│       ↓ RunOutcome::messages 零拷贝续接（权威增量源）                      │
│   AgentSessionLoop.with_initial_conversation_arc（mod.rs:300-303）       │
├─────────────────────────────────────────────────────────────────────────┤
│ 预算层（估算 + 钳制 + 预检压缩）：每次 build_request 之前                   │
│   EstimateState（usage 优先 + 时间戳护栏 + count_tokens 兜底）            │
│       ↓ clamp_max_tokens = window - estimate - 4096                      │
│       ↓ 阈值触发：estimate ≥ window - reserve(16384) → prepare_turn 压缩  │
├─────────────────────────────────────────────────────────────────────────┤
│ 压缩层（唯一前缀重写点）：conex-compaction AgentMessage 面                 │
│   触发：preflight 阈值 / ContextLengthExceeded / PayloadTooLarge / 手动    │
│   保留：keepRecentTokens(20000) + 合法切割点（tool 配对）+ 结构化摘要        │
│   护栏：last_compaction_at 时间戳 + 单 run 压缩上限 + 溢出只重试一次         │
│   事件：ContextCompressionStart/End（events.rs:236-252）广播 → P5 消费     │
└─────────────────────────────────────────────────────────────────────────┘
```

**分层归属**：水合层与预算层在 session-loop（请求构造事实层）；压缩层在 conex-compaction（纯算法）+ session-loop（触发决策）；会话级元数据持久化协调在 orchestrator；壳层（agent-workbench）是 `history` 参数与 `SessionHistoryCache` 的接线点（core_run_commands.rs / engine.rs）。

### 3.2 历史回流路线设计

#### 3.2.1 路线 A：session-loop 内维护 per-session 历史缓存并拼进 build_request（最小改动）

- 机制：loop 之外（壳层 CoreRunState）持有 `HashMap<session_id, Vec<Arc<AgentMessage>>>`；`core_run_task` 发起时取出（若存在）→ `AgentSessionLoop::with_initial_conversation_arc`（mod.rs:300-303，零拷贝）→ `build_request` 自然携带全历史；run 收口时 `RunOutcome::messages`（已含本轮新增）**原子替换**缓存。
- 为什么缓存不能真的放"loop 内"：crish 每 run 重建 `AgentSessionLoop`（engine.rs:755-773），且 `converge` mem::take 清空 conversation（mod.rs:509-530）。跨 run 状态只能放在 loop 之外——这正是"最小改动"的落点：**loop 的 `with_initial_conversation_arc` 已存在（为测试续接准备的），把生产接线补上即可**。
- 改动量：`core_run_commands.rs` 增缓存读写（约 20 行）+ `engine.rs` produce 加一个 `with_initial_conversation_arc` 分支（约 5 行）。session-loop 本身零改动（除 §3.3/§3.4）。
- 缓存收益：**跨消息前缀命中**。第二 run 起，请求前缀 = system + tools + 全部历史消息，仅新用户消息尾部 miss。DeepSeek 自动前缀缓存命中折扣 2%（flash）/ 0.83%（pro）（comparison.md:382 引用 vendor-cache-gaps）；pi/opencode 的成本模型证明"写 1.25x、读 0.1x，单次复用即回本"（opencode-cache-analysis.md:87）。
- 局限：**首 run / 重启后缓存为空**——引擎从未持久化历史（orchestrator 恢复不含消息正文，§2.5），纯路线 A 无法覆盖冷启动场景；冷启动若不做任何水合就退化为现状单消息。

#### 3.2.2 路线 B：前端传 messages + 引擎接管（完整）

- 机制：`core_run_task` 增加 `history: Option<Vec<HistoryMessage>>`；前端从 store 取当前会话已完成消息（`loadSessionBody` 路径已有数据，sessionRustDb.ts:499-504 语义），在 `startRunTask`（ConnectionLifecycle.ts:290-313）时随参数下发；引擎侧负责映射 + 水合 + 压缩 + 持久化的完整闭环。
- 收益：冷启动可水合（前端 store 是持久化权威，天然有全部消息含 tool 结果与思考块）；UI↔DB↔run-loop 三向打通，是 comparison.md:388 描述的长期形态。
- 代价与风险：
  - **载荷**：每 run 全量历史经 IPC 传输（N 条消息全量序列化），长会话成为常态成本；
  - **职责上移**：前端要判定"哪些消息进 LLM 上下文"（完成态过滤、system 排除、尾部 user 约束），LLM 上下文策略泄漏进 UI 层；
  - **转换面**：UI 扁平模型（SessionMessage）→ AgentMessage 有信息损失面（steering 的 System 角色消息、Tool 角色消息不在 UI 模型；tool_call_results_json 需重映射）；
  - **一致性**：前端 store 与引擎在压缩后会产生两份"正文真源"，若 UI 不感知引擎侧压缩，下一条消息回传的是未压缩历史，前缀漂移。

#### 3.2.3 推荐：A 为主体 + B 的冷启动兜底（混合路线）

**推荐方案：路线 A 为主体，路线 B 降级为"仅引擎缓存为空时的水合源"。**

```
core_run_task(run_id, session_id, prompt, …, history: Option<Vec<HistoryMessage>>, …)
    → 若 SessionHistoryCache[session_id] 非空：with_initial_conversation_arc(缓存)
    → 否则若 history 非空：映射 + 过滤后 with_initial_conversation_arc(映射结果)
    → 否则：现状（单消息 run，向后兼容）
run 收口：SessionHistoryCache[session_id] = RunOutcome.messages（原子替换）
```

理由：

1. **互补而非互斥**：引擎缓存覆盖"运行期连续 run"（零 IPC、零转换、`RunOutcome::messages` 是引擎产出的权威增量）；前端 history 只覆盖"冷启动/重启后的第一个 run"（引擎内存态失忆时唯一可靠的历史源）。两条路线的各自强项正好补齐对方弱点。
2. **不破坏现有会话语义**：UI 水合/持久化方向（UI→DB→UI）完全不动；`history` 可选，不传 = 现状；引擎缓存不落库（避免与前端全量写 session_messages 双写冲突，§1.3）。
3. **职责边界清晰**：前端 = 持久化权威（它本来就全量存）；引擎 = 请求构造权威（它本来就构造 wire）。LLM 上下文判定（哪些消息进请求）收敛到引擎侧，前端只负责"把 store 里已完成的消息原样搬过来"。
4. **压缩语义自然成立**：压缩发生在引擎侧 conversation 上（§3.4），run 收口后缓存自动携带压缩后序列；下一条 run 水合的是压缩后的历史——**压缩前与压缩后的前缀在引擎缓存里天然连贯，UI 无需感知**（UI 展示用自己 store 的原文，两者解耦）。

**store 水合判定规则**（`history` → `Vec<AgentMessage>` 映射，引擎侧实现 `hydrate_history`）：

| 规则 | 依据 | 说明 |
|---|---|---|
| 仅完成态消息进 LLM | `SessionMessage.status`（conex-types/src/lib.rs:146-148） | `completed` 或历史无 status 字段（兼容旧数据）才进；`streaming`/`pending`/空 status 跳过（半成品不进上下文） |
| 角色映射 | sender ∈ {user, assistant} | UI 模型只有两种 sender；`System`（steering 瞬态）与 `Tool` 角色天然不出现在水合输入——steering 注入消息是 run 内瞬态，**跨 run 不应回传**（有意为之） |
| 块保真优先 | `blocks_json` | 有 `blocks_json` 时反序列化为完整 `AgentMessageBlock` 序列（含 text/thought/tool-call/tool-result，message.rs:100-126）；无 `blocks_json` 时用 `text`/`thinking`/`tool_calls_json` 合成（老数据兜底） |
| metadata 裁剪 | — | 水合消息 `metadata = None`（usage 等不进 LLM 上下文；`to_chat_messages` 不读 metadata，双保险） |
| 尾部约束 | OpenAI 系协议 | 对话必须以 user 消息收尾：水合序列最后一条非 user 时向前截断到最后一个 user 消息（协议合法性，避免以 assistant 收尾被拒） |
| 排序 | `load_session_body` 已按 seq 升序 | 保持原序，回传顺序 = 会话顺序 |
| 长度上限 | 预算层兜底 | 水合后统一过 §3.3 的估算与预检压缩，不需要在前端做 N 轮截断（compaction 接管窗口管理） |

**缓存收益量化口径**：第 N+1 条用户消息的请求，`prompt_cache_hit_tokens ≈ 前 N 轮全部输入`（历史未变时）；P5 按 `cacheRead / inputTotal` 展示命中率（对齐 kimi-code-cache-analysis.md:262-264 的 `cache read N (xx%)`）。**前提是 P1 的 tools 排序与 system prompt 透传先落地**（§6.1）——否则历史回流后前缀仍有漂移风险。

### 3.3 上下文预算估算

#### 3.3.1 估算器：`estimate_context_tokens`

**双源策略**（对齐 pi estimate.ts 的"usage 实测为主、本地估算兜底"，pi-cache-analysis.md:13-14）：

- **源 1：usage 优先**。从 `conversation` 末尾向前找最近一条**仍描述当前前缀**的 assistant 消息的 `metadata.usage`（`ProviderUsage`，events.rs:31-52）：
  - **时间戳护栏**：若该消息时间戳早于 `last_compaction_at`（压缩边界），则其 usage 不再描述当前前缀（压缩插入了新的前缀消息），作废，回退本地估算（对齐 pi `usageAppliesToPrefix`，pi-cache-analysis.md:76）；
  - 排除 aborted/error 回合与零 usage 消息（对齐 pi estimate.ts:76-78）；
  - 上下文占用 = **P2 归一化后的 `CacheBreakdown.input_total`**（= miss + read + write，P2 §3.3 D 统一不变量）：Included 系（OpenAI/chat-completions 主路径）直接取 `prompt`（**prompt 已含缓存，不得再叠加 read + write**）；Excluded 系（Anthropic/Gemini）取 `prompt + read + write`。对齐 pi overflow.ts 的 `input + cacheRead` 真实预算（pi-cache-analysis.md:18、:116；opencode 溢出判定含缓存 token，opencode-cache-analysis.md:47）。P2 归一化后的 `ProviderUsage`/`CacheBreakdown` 直接可用，估算器只消费标量（与 P5 §3.1.1 `CacheUsageScalars` 同源口径）。【A1 审计修正】原稿"上下文占用 = prompt + cache_read + cache_write"在 Included 主路径下重复计缓存（prompt 已含两者），与 P2 归一化口径冲突；按 P2 的 accounting 感知口径修正。
- **源 2：本地启发式兜底**（无 usage / usage 作废 / 冷启动）：
  - 逐块估算，与 `to_chat_messages`（messages.rs:318-395）的**实际序列化形态**对齐：
    - `Text`/`Thought` → `count_tokens(text)`（复用 conex-compaction/src/lib.rs:134-173）；
    - `ToolCall` → `count_tokens(tool_name) + count_tokens(JSON.stringify(input))`（对齐 pi estimateMessageTokens 的 name + arguments 折算，pi-cache-analysis.md:82）；
    - `ToolResult` → `count_tokens(stringify_tool_output(output))`（与 wire 序列化一致，agent-provider request 侧 `stringify_tool_output`）；
    - 图片：**固定 1600 token/图**（对齐 jcode `IMAGE_TOKEN_COST`，jcode-cache-analysis.md:264、:395）——base64 按 len/4 计数会高估真实上下文约 100 倍，导致"triple compaction"连环压缩，必须固定计价；
  - system prompt / tools 前缀：按 P1 透传后的实际字节估算（`estimate_tools_tokens` = 工具 schema 整体 JSON 体积折算，对齐 pi estimateToolsTokens，pi-cache-analysis.md:88）。

**签名**（放 conex-compaction，session-loop 复用）：

```rust
/// 上下文占用估算结果（双源统一输出）
#[derive(Debug, Clone, PartialEq)]
pub struct EstimateContext {
    /// 估算的上下文占用（含缓存读/写）
    pub tokens: u64,
    /// 估算来源（usage 实测 / 本地启发式）
    pub source: EstimateSource,
    /// usage 来源消息 id（本地兜底时为 None；用于时间戳护栏判定）
    pub usage_message_id: Option<String>,
}

pub enum EstimateSource {
    Usage,
    Heuristic,
}

impl CompactionEngine {
    /// 对话级估算（AgentMessage 面；内部复用 count_tokens）
    pub fn estimate_agent_context(
        &self,
        messages: &[Arc<AgentMessage>],
        usage_message_id: Option<&str>, // 最近可用 usage 所在消息 id（None = 无）
    ) -> EstimateContext;
}
```

#### 3.3.2 max_tokens 钳制：`clamp_max_tokens`

```rust
/// 预算护栏（对齐 pi simple-options.ts:12-19：window - estimate - 4096）
pub const CONTEXT_SAFETY_TOKENS: u32 = 4096;

fn clamp_max_tokens(
    requested: u32,          // 现状：state.max_tokens（length 阶梯值）
    estimate: u64,
    budget: &ContextBudget,  // window / reserve / safety
) -> u32 {
    let available = budget.context_window
        .saturating_sub(estimate as u32)
        .saturating_sub(budget.safety_tokens);
    requested.min(available).max(1) // MIN_MAX_TOKENS = 1：最小输出不为 0
}
```

- 挂载点：`streaming::build_request`（streaming.rs:253-259）内，`max_tokens` 字段产出前经过钳制。
- `ContextBudget` 缺省时（引擎没有窗口元数据，P3 模型目录未接线前）**不钳制**（`Option::None`，向后兼容现状）；有窗口元数据后由 **P3** 的模型目录提供 `context_window`（`context_window_for`，P3 §3.1.5）。【A1 审计修正：原稿"由 P1 的模型目录提供 context_window"归属错误，模型目录属 P3】

```rust
/// 预算配置（引擎/会话级注入；缺省 None = 不启用钳制与预检压缩）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextBudget {
    /// 模型上下文窗口（token）
    pub context_window: u32,
    /// 压缩保留余量（阈值 = window - reserve，对齐 pi 默认 16384）
    pub reserve_tokens: u32,
    /// 输出预算安全垫（默认 4096）
    pub safety_tokens: u32,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self { context_window: 64_000, reserve_tokens: 16_384, safety_tokens: CONTEXT_SAFETY_TOKENS }
    }
}
```

### 3.4 compaction 接线

#### 3.4.1 触发链（真实消费者 = session-loop，直接内联调用引擎）

**核心决策：run 循环内直接依赖 `conex-compaction` crate 内联调用 `CompactionEngine`，不走 `core_compact_messages` IPC 绕行**（IPC 往返有类型转换与序列化成本，且循环内无法 await Tauri 命令）。`core_compact_messages` 保留为 UI 手动压缩的独立工具面（§3.4.5）。

触发点（按优先级）：

| # | 触发 | 位置 | 条件 | 动作 |
|---|---|---|---|---|
| 1 | 阈值预检（Preflight/Threshold） | `prepare_turn::handle` 步骤 5 预留点（prepare_turn.rs:71-73） | `estimate ≥ window - reserve`（对齐 pi threshold=window-reserve，pi-cache-analysis.md:224） | 同步压缩（非 LLM 摘要时）；发出 `ContextCompressionStart/End` |
| 2 | 溢出恢复（Overflow） | `stream_error::handle` 的 `ContextLengthExceeded` 分支（stream_error.rs:49） | length_ladder 用尽后（§3.5） | 压缩 + 重试一次（`compression_retries` 上限 1） |
| 3 | 载荷过大恢复 | `stream_error::handle` 的 `PayloadTooLarge` 分支（stream_error.rs:53） | 恒触发（压缩是真实恢复，代替 fatal） | 压缩 + 重试一次；仍失败才 fatal |
| 4 | 手动 | UI 手动压缩入口 | 用户意图 | 经 `core_compact_messages`（纯工具）或控制总线新意图（§3.4.5） |

#### 3.4.2 保留策略与合法切割点

**策略**（对齐 jcode `RECENT_TURNS_TO_KEEP` / keepRecentTokens 与 opencode tail_turns/preserve budget 的合流，jcode-cache-analysis.md:260、pi-cache-analysis.md:234、opencode-cache-analysis.md:137-139）：

```rust
/// 压缩策略（session-loop 注入 CompactionEngine）
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPolicy {
    /// 保留最近 N token 原文（默认 20000，对齐 pi keepRecentTokens）
    pub keep_recent_tokens: usize,
    /// 保留最近完整回合数下限（默认 2，对齐 opencode tail_turns）
    pub min_recent_turns: u32,
    /// 摘要占位符 token 上限（默认 1024）
    pub max_summary_tokens: usize,
    /// 合法切割点保护（tool use/result 不拆散，默认 true）
    pub tool_pair_protection: bool,
}

impl Default for CompactionPolicy {
    fn default() -> Self {
        Self {
            keep_recent_tokens: 20_000,
            min_recent_turns: 2,
            max_summary_tokens: 1_024,
            tool_pair_protection: true,
        }
    }
}
```

**切割点算法**（在 `AgentMessage` 面上重写 `compact` 的核心，保留原 `Message` 面）：

1. **预算内不动**：`estimate < max_tokens` → 原样返回（对齐现有 `cache_hit_rate_optimized = true` 语义，conex-compaction/src/lib.rs:34-40）。
2. **保留尾部**：从末尾向前累计 token 至 `keep_recent_tokens`，**且不得少于 `min_recent_turns` 个完整回合**（回合 = 一个 user 消息及其后的 assistant/tool 消息组）。
3. **合法切割点（tool 配对保护）**：对齐 jcode `safe_compaction_cutoff`（jcode-cache-analysis.md:272-289）——从切割点向前扫描保留段内的 `ToolCall` id：若存在"有 `ToolResult` 无对应 `ToolCall`"的孤儿 id（即切割点把 assistant(tool_calls) 与其 tool result 拆开），**向前扩展保留段**直到每个 result 都有对应 use；仍无法配对（数据异常）则**放弃本次压缩**，宁可暂不压缩也不破坏语义。
4. **中间段处理**：保留段之前的消息按"user 消息作为摘单位"反序挑选（对齐 codex `build_compacted_history_with_limit` 倒序挑选 + 超预算截断，codex-cli-cache-analysis.md:84）——被丢弃的用户回合进入摘要输入。
5. **摘要占位**：摘要消息以 `assistant` 角色插入序列头部（保持"assistant 摘要 → 保留尾部"的对话形态，对齐 opencode 重排"compaction 用户消息、摘要、保留尾部、继续消息"顺序，opencode-cache-analysis.md:157；pi 结构化摘要，pi-cache-analysis.md:236）。

#### 3.4.3 摘要格式与迭代更新

- **L1 静态占位符（默认，无 LLM 调用）**：结构化 Markdown，对齐 pi 摘要模板（Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context，pi-cache-analysis.md:236）：

```markdown
## Goal
<会话目标>
## Constraints
<约束与偏好>
## Progress
<已完成事项 / 进行中 / 受阻，逐条>
## Key Decisions
<关键决策>
## Next Steps
<下一步>
## Critical Context
<关键路径、符号、命令、错误串（必须保留原文）>
```

- **L2 LLM 摘要（可选，配置注入）**：`Summarizer` trait 注入（见 §3.4.4），prompt 要求严格按模板分节、空节写 `(none)`、保留精确路径/符号/命令/错误串、**不提及"上下文被压缩"**（对齐 opencode SUMMARY_TEMPLATE 纪律，opencode-cache-analysis.md:155）。
- **迭代更新**：已有摘要时，下一次压缩把旧摘要 + 新丢弃回合作为输入，要求"增量合并而非推倒重写"（对齐 pi `UPDATE_SUMMARIZATION_PROMPT`，pi-cache-analysis.md:237；codex 复用上次摘要，codex-cli-cache-analysis.md:86）。实现：摘要占位消息 id 固定为 `compacted-summary` 前缀（现有 `compacted-summary-{n}`，conex-compaction/src/lib.rs:102），压缩时检测到已存在摘要消息 → 走合并路径。
- 摘要长度受 `max_summary_tokens` 钳制。

#### 3.4.4 摘要请求的缓存隔离（L2 路径）

**设计（对齐 pi `cacheRetention: "none"` + 每次新 sessionId，pi-cache-analysis.md:239-254）**：

- 摘要请求是**独立前缀域**请求：messages = `[摘要系统提示 + 待摘要文本]`（单条 user 载荷），**不带工具定义、不带历史**。其前缀与主会话前缀天然不同域——DeepSeek 自动前缀缓存按前缀匹配，摘要请求既不会命中主会话缓存，也不会写入主会话缓存域（这是"none"语义在自动缓存厂商上的天然实现）。
- 若未来接入 Anthropic 显式断点（P1/P3 面）：摘要请求**不发任何 cache_control**、不附会话亲和键；摘要返回的 usage 单独记账（不进会话命中率统计基线）。
- 摘要请求失败降级：**回退 L1 静态占位符**，不阻塞主对话（压缩仍然完成，只是摘要质量降级）。

```rust
/// LLM 摘要器（可选注入；None = L1 静态占位符）
#[async_trait]
pub trait Summarizer: Send + Sync {
    /// 对丢弃消息生成结构化摘要（模板约束由实现方保证）
    async fn summarize(&self, dropped: &[AgentMessage], existing: Option<&str>) -> Result<String, String>;
}
```

#### 3.4.5 手动压缩面

- **保留** `core_compact_messages`（core_commands.rs:191-207）为纯工具命令（UI 预览压缩结果用）。
- **引擎内手动压缩**（推荐后续接）：`core_run_control` 新增 `compact` 意图 → ControlBus → 安全点 → 循环内执行压缩 + 事件广播（压缩结果写回 conversation 并经事件流透传 UI）。列为实施阶段 4 的可选项，不阻塞主线。

#### 3.4.6 压缩后基线重置与防重触发护栏

对齐 pi 三重护栏（pi-cache-analysis.md:229-230）+ Reasonix compactStuck（comparison.md:218）：

| 护栏 | 实现 | 依据 |
|---|---|---|
| **时间戳护栏** | `LoopState.last_compaction_at: Option<i64>`（压缩完成时写入）；usage 源消息时间戳早于它 → usage 作废（§3.3.1 已定义） | pi `usageAppliesToPrefix`（pi-cache-analysis.md:76）、`getLatestCompactionEntry` 时间戳跳过（pi-cache-analysis.md:229） |
| **单 run 压缩上限** | `LoopState.compactions_this_run: u32`，上限默认 1（`max_auto_compactions_per_run`）；预检触发与溢出触发共用计数 | 对齐 Reasonix compactStuck 防每轮重写前缀（comparison.md:218、deepseek-reasonix-cache-analysis.md:173） |
| **溢出只重试一次** | `LoopState.compression_retries: u32` 上限 1（§3.5） | pi `_overflowRecoveryAttempted`（pi-cache-analysis.md:225） |
| **模型切换不触发** | 预检触发前比对 model id（引擎生效配置不变才触发） | pi `sameModel` 校验（pi-cache-analysis.md:228） |
| **压缩后缓存基线重建** | 压缩完成后：`last_compaction_at = now`；usage 基线清空（下次估算走启发式直到出现新 usage）；**缓存侧**：run 收口时 `RunOutcome::messages` 携带压缩后序列 → `SessionHistoryCache` 原子替换 = 基线重建（对齐 codex"压缩后重建上下文基线"，codex-cli-cache-analysis.md:235） | — |

**事件广播**：压缩触发发出 `ContextCompressionStart { session_id, timestamp, reason, tokens_before }`；完成发出 `ContextCompressionEnd { result: Some(ContextCompressionRecord) }`（events.rs:236-252）。`ContextCompressionRecord` 填充：trigger/reason/policy/tokens_before/tokens_after/first_kept_message_id/compressed_message_ids/kept_message_ids/cache_boundary（tool.rs:465-489）。**这是 P4 提供给 P5 的事件面**（P5 消费展示压缩历史与缓存边界重置点）。

### 3.5 超限恢复改进

**保留 length_ladder，新增压缩阶梯（对齐 pi"溢出 → 压缩 → 重试一次"与 jcode 95% 同步硬压缩，pi-cache-analysis.md:225、jcode-cache-analysis.md:257）**：

```
ContextLengthExceeded（输入超限）：
  └─ length_ladder（max_tokens 翻倍，上限 2 次）[保留]
       └─ 用尽 → 压缩阶梯：compress(conversation) → 重试一次
            └─ 仍超限 → fatal（带压缩后诊断：压缩后仍超 = 单条消息过大或窗口过小）

PayloadTooLarge（物理载荷超限）：
  └─ 压缩阶梯：compress(conversation) → 重试一次     [代替直接 fatal]
       └─ 仍 PayloadTooLarge → fatal（诊断含压缩后 token 数）

stopReason=length（输出截断）：
  └─ length_ladder + continue nudge [现状不变]
       └─ 不压缩输入（输出预算问题压缩输入无效；§2.3 区分）
```

- **防死循环**：压缩阶梯重试上限 1（`compression_retries`），压缩 + 重试之后若再次 ContextLengthExceeded/PayloadTooLarge → fatal（对齐 pi 只重试一次）。
- **压缩阶梯与 length_ladder 的次序**：length_ladder 先行（输出预算问题最便宜）；用尽后再压缩输入（输入预算问题）。两个维度正交，都做了才覆盖两类超限（comparison.md:24 指出现状"只放大输出预算，对输入超限无效"）。
- **新增状态**：`LoopState.compression_retries: u32`（每 run 归零，mod.rs:349-352 处一并重置）。
- `stream_error.rs:95-99` 的注释（"真实压缩落地时恢复本阶梯"）随本方案落地闭环：PayloadTooLarge 恢复路径恢复，但**以真实压缩为前提**（不恢复旧的"假恢复"计数重试）。

### 3.6 缓存交互不变量

| # | 不变量 | 实现约束 | 依据 |
|---|---|---|---|
| I1 | **compaction 是唯一前缀重写点** | 除压缩外，任何路径不得改写 `conversation` 中的历史消息（loop 内 append-only 已天然成立，streaming.rs:344-353 `commit_message_with_deltas` 只追加）；压缩是唯一删除/合并历史消息的动作 | Reasonix"compaction 是唯一低频 cache-reset 点"（comparison.md:59） |
| I2 | **动态注入内容放 user 尾部** | steering 注入消息（System 角色）只追加到 conversation 尾部（prepare_turn.rs:57 `state.steering.apply` 已如此）；未来 context/记忆注入 = 追加在**最后一条 fresh user 消息之后**（对齐 jcode `messages_with_dynamic_system_context`，jcode-cache-analysis.md:241-243）——永不插进历史前缀内部 | jcode 前缀不变性测试（jcode-cache-analysis.md:72-79） |
| I3 | **水合不改写** | `with_initial_conversation_arc` 只做初始填充，之后 loop 只追加（§3.2.3） | — |
| I4 | **摘要请求独立缓存域** | 摘要请求不带 tools/历史/断点（§3.4.4） | pi cacheRetention none（pi-cache-analysis.md:247-252） |
| I5 | **压缩后基线重置** | 时间戳护栏 + usage 基线清空 + SessionHistoryCache 原子替换（§3.4.6） | codex 压缩后重建基线（codex-cli-cache-analysis.md:235）、pi cache-stats 压缩重置（pi-cache-analysis.md:297-299） |
| I6 | **溢出判定口径 = P2 归一化 `input_total`**（Included：prompt；Excluded：prompt + read + write） | 预算估算、钳制、压缩阈值三处共用同一口径（§3.3.1） | pi overflow.ts:142-158、opencode overflow.ts:31-32、P2 §3.3 D【A1 审计修正：原稿"input + cacheRead"未区分 accounting，Included 主路径下与 P2 归一化口径不一致】 |

### 3.7 Rust 类型/签名汇总

```rust
// ── conex-types（新增；与既有压缩类型并存）──
/// 预算配置（§3.3.2）
pub struct ContextBudget {
    pub context_window: u32,
    pub reserve_tokens: u32,
    pub safety_tokens: u32,
}

/// 水合输入（前端 store 消息的 LLM 上下文候选；与 SessionMessage 1:1）
pub struct HistoryMessage {
    pub id: String,
    pub sender: String, // "user" | "assistant"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_results_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// epoch ms（顺序判定用）
    pub timestamp: i64,
}

// ── conex-compaction（AgentMessage 面新增；原 Message 面保留兼容）──
pub struct CompactionPolicy { /* §3.4.2 */ }
pub enum EstimateSource { Usage, Heuristic }
pub struct EstimateContext {
    pub tokens: u64,
    pub source: EstimateSource,
    pub usage_message_id: Option<String>,
}

/// 压缩计划（引擎侧决策产出；替代直接返回消息数组——事件字段需要）
pub struct CompactionPlan {
    pub messages: Vec<Arc<AgentMessage>>,
    pub dropped_ids: Vec<String>,
    pub kept_ids: Vec<String>,
    pub first_kept_message_id: Option<String>,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub summary: String,
    pub summary_is_llm: bool,
}

impl CompactionEngine {
    /// 对话级估算（AgentMessage 面；内部复用 count_tokens）
    pub fn estimate_agent_context(
        &self,
        messages: &[Arc<AgentMessage>],
        usage_message_id: Option<&str>,
    ) -> EstimateContext;
    /// 压缩对话（AgentMessage 面；保留 strategy 见 §3.4.2）
    pub fn compact_agent_messages(
        &self,
        messages: &[Arc<AgentMessage>],
        budget_tokens: usize,            // 目标预算（window - reserve）
        policy: &CompactionPolicy,
        summarizer: Option<&dyn Summarizer>,
    ) -> CompactionPlan;
    /// 阈值判定单点：estimate ≥ budget_tokens
    pub fn should_compact(&self, estimate: u64, budget_tokens: u64) -> bool;
}

// ── session-loop（LoopState 新增字段，loop/handlers/mod.rs:55-85）──
pub(crate) struct LoopState {
    // …既有字段…
    pub(crate) budget: Option<ContextBudget>,            // 经 SessionLoopOptions 注入
    pub(crate) compaction_policy: Option<CompactionPolicy>, // None = 无自动压缩（现状）
    pub(crate) summarizer: Option<Arc<dyn Summarizer>>,  // L2 LLM 摘要（可选）
    pub(crate) last_compaction_at: Option<i64>,          // 时间戳护栏（epoch ms）
    pub(crate) compactions_this_run: u32,                // 单 run 压缩上限计数
    pub(crate) compression_retries: u32,                 // 溢出压缩重试（上限 1）
}

// SessionLoopOptions 新增（mod.rs:126-156；Default 全部保持向后兼容）：
pub struct SessionLoopOptions {
    // …既有字段…
    pub context_budget: Option<ContextBudget>,           // None = 不钳制不预检（现状）
    pub compaction_policy: Option<CompactionPolicy>,     // None = 无自动压缩（现状）
    pub summarizer: Option<Arc<dyn Summarizer>>,         // L2 摘要（None = L1 静态）
    pub max_auto_compactions_per_run: u32,               // 默认 1
}

// ── agent-workbench 壳层（接线点）──
// core_run_commands.rs：
pub(crate) async fn core_run_task(
    …,
    history: Option<Vec<HistoryMessage>>,   // 本方案新增（水合源，仅缓存为空时用）
    context_window: Option<u32>,            // 生效模型窗口（P3 目录接线前可由前端下发）【A1 审计修正：原稿"P1 目录"归属错误，模型目录属 P3】
    …,
) -> Result<RunTaskResponse, CoreError>;

// CoreRunState 新增：
pub struct SessionHistoryCache(Mutex<HashMap<String, Vec<Arc<AgentMessage>>>>);
// 读写点：core_run_task 读取 → produce 前 with_initial_conversation_arc；
// drive_run_loop 收口后写入（RunOutcome::messages 原子替换）。

// ── orchestrator（会话上下文元数据协调）──
// session 记录 / StateSnapshot 增加可选字段（schema 兼容，Default 缺省）：
pub struct SessionContextMeta {
    pub last_compaction_at: Option<i64>,  // 压缩边界（epoch ms）
    pub last_compaction_sequence: Option<u64>, // 对应事件序列（审计锚点）
}
// 读写点：压缩事件落库时更新；restore.rs 恢复时随 SessionRecord 返回，
// 供壳层重建 SessionHistoryCache 的护栏状态（缓存正文仍需前端 history 水合）。
```

**签名决策说明**：

- `hydrate_history`（`Vec<HistoryMessage>` → `Vec<AgentMessage>`）放壳层（agent-workbench）还是 session-loop？**放 session-loop**（`crates/session-loop/src/hydrate.rs`）——"哪些消息进 LLM 上下文"是请求构造域的职责（§3.2.3 理由 3），且 session-loop 已有 `AgentMessage`/`AgentMessageBlock` 的完整类型；壳层只做参数透传。
- `SessionHistoryCache` 放壳层（CoreRunState）而非 orchestrator：它是运行期内存态、与 `active_runs` 生命周期一致；orchestrator 只负责跨重启的元数据协调（§3.7 orchestrator 段），不持有消息正文。
- `Summarizer` 的实现方：agent-workbench 壳层注入（用 `HttpProviderCall` 发独立摘要请求，§3.4.4 的前缀域约束）；session-loop 只定义 trait 与降级逻辑。
- 任务书文件域为 session-loop / conex-compaction / conex-types / orchestrator：壳层（core_run_commands.rs / engine.rs / main.rs）与前端（ConnectionLifecycle.ts）列为**必要接线触点**（不改实现语义，只加可选参数与缓存读写）。

---

## ④ 实施步骤

按依赖序分五个阶段；每阶段可独立合入（`SessionLoopOptions` 新字段全部缺省向后兼容，未配置即现状行为）。

### 阶段 1：历史回流最小接线（水合层）

1. conex-types：新增 `HistoryMessage`（§3.7）。
2. session-loop：新增 `hydrate.rs`——`hydrate_history(&[HistoryMessage]) -> Vec<AgentMessage>`（完成态过滤 / 块保真 / metadata 裁剪 / 尾部 user 截断，§3.2.3 规则表）；新增单测覆盖每条规则。
3. 壳层：`SessionHistoryCache`（CoreRunState）+ `core_run_task` 增加 `history` 参数 + `SessionLoopProducer` 增加 `initial_conversation: Vec<Arc<AgentMessage>>` 字段；`produce` 中 `with_initial_conversation_arc`（engine.rs:755-773 处，缓存优先、history 兜底）。
4. `drive_run_loop` 收口处：`SessionHistoryCache[session_id] = outcome.messages.clone()`（Arc 克隆便宜，PE-09 语义）。
5. 前端：`ConnectionLifecycle.ts` `startRunTask` 参数增加 `history`（取 store 已完成消息，`loadSessionBody` 数据源）；**可选**：不传则走现状。
6. 手工验证：第二轮 run 请求体包含首轮历史（日志/抓包）。

### 阶段 2：预算估算与钳制（预算层）

1. conex-compaction：`estimate_agent_context`（块级估算 + 图片固定 1600 + tool-call JSON 折算，§3.3.1）+ `EstimateContext/EstimateSource`。
2. conex-types：`ContextBudget`；session-loop `SessionLoopOptions.context_budget`。
3. session-loop：`clamp_max_tokens`（§3.3.2）挂进 `streaming::build_request`（streaming.rs:253-259）；usage 定位逻辑（`metadata.usage` 回扫 + 时间戳护栏）放 `LoopState` 辅助函数。
4. 单测：估算对齐 `to_chat_messages` 序列化；钳制数学（window 边缘、MIN 1）。

### 阶段 3：compaction 接线（压缩层核心）

1. conex-compaction：`compact_agent_messages` + `CompactionPlan` + `CompactionPolicy` + 切割点算法（tool 配对保护，§3.4.2）+ L1 结构化摘要（§3.4.3）+ 迭代合并路径。
2. session-loop：`prepare_turn::handle` 步骤 5 恢复（prepare_turn.rs:71-73）——阈值预检（`estimate ≥ window - reserve` 且护栏通过）→ 同步压缩 → conversation 替换 + 事件广播；`LoopState` 新增护栏字段。
3. 事件：`ContextCompressionStart/End` 广播，`ContextCompressionRecord` 填充（§3.4.6）。
4. L2 摘要（可选项）：`Summarizer` trait + 壳层实现（独立前缀域请求 + 失败降级 L1，§3.4.4）。

### 阶段 4：超限恢复改进

1. `stream_error.rs`：`ContextLengthExceeded` 在 length_ladder 用尽后接压缩阶梯；`PayloadTooLarge` 改压缩阶梯（§3.5）；`LoopState.compression_retries`（上限 1，mod.rs:349-352 一并归零）。
2. 手动压缩（可选项）：`core_run_control` 新增 `compact` 意图 → 循环内压缩 + 事件广播（§3.4.5）。

### 阶段 5：护栏与不变量固化

1. orchestrator：`SessionContextMeta`（last_compaction_at / 事件序列锚点）随会话记录持久化；restore.rs 恢复返回；壳层重建护栏状态。
2. 不变量测试：I1-I6 各一条回归测试（§3.6）——重点：append-only 不被破坏（压缩外无改写路径）、摘要请求无工具无历史、压缩后 usage 作废、双 run 压缩只发生一次。
3. 与 P5 对齐：确认 `ContextCompressionEnd` 事件字段满足 P5 展示需求（不足时补 `details`）。

---

## ⑤ 验收标准

### 测试命令（全部在仓库根执行）

```powershell
# Rust 侧（新增测试见各阶段单测清单）
cargo test -p conex-compaction        # AgentMessage 面：估算/切割点/tool 配对/摘要/迭代合并
cargo test -p session-loop            # 水合规则/钳制/预检触发/压缩阶梯/护栏/不变量 I1-I6
cargo test -p conex-types             # HistoryMessage/ContextBudget 序列化 roundtrip
cargo test -p orchestrator            # SessionContextMeta 持久化与恢复（不回归 73 套件基线）
cargo test --workspace                # 全量回归（基线 73 套件不减）
```

```powershell
# 前端（若改动 ConnectionLifecycle.ts / 类型定义）
npm run typecheck
npx vitest run src/api/chat-bridge   # startRunTask 参数透传（history 字段）测试
```

### 关键验收用例（对应测试名示例）

| 用例 | 断言 |
|---|---|
| 历史水合：缓存命中 | 第二次 `core_run_task` 带缓存 → `build_request.messages` 含首轮全部消息（含 tool 消息与 tool-call 顺序） |
| 水合规则：完成态过滤 | 半成品（streaming status）消息不进上下文；尾部非 user 截断到最后一个 user |
| 钳制：窗口边缘 | `estimate = window - 1000` 时 `clamp_max_tokens = max(1, 请求值)`；`estimate ≥ window - 4096` 时输出被压缩到小值 |
| 预检压缩：阈值触发 | 估算超 `window - reserve` → prepare_turn 内发生一次压缩（`compactions_this_run == 1`）→ `ContextCompressionEnd` 事件带正确 tokens_before/after |
| 切割点：tool 配对 | 切割点落在 tool_result 之前时向前扩展保留；孤儿 result 场景放弃压缩 |
| 溢出压缩：只重试一次 | ContextLengthExceeded 两次（length_ladder 用尽 + 压缩后重试）→ 第三次直接 fatal，`compression_retries ≤ 1` |
| PayloadTooLarge 恢复 | 压缩后重试成功 → run 正常收敛（不再 fatal）；压缩后仍超 → fatal 带压缩后 token 诊断 |
| 护栏：压缩不重触发 | 同 run 内第二次超阈值不压缩；压缩后 usage 源早于 `last_compaction_at` 作废 |
| 不变量 I4 | L2 摘要请求载荷 = 单条 user、无 tools（由 Summarizer 实现方测试保证） |
| 手工验收（真机） | DeepSeek 连续两轮对话，第二轮日志/前端统计 `cacheRead > 0`（依赖 P2 字段补齐） |

---

## ⑥ 风险与依赖

### 6.1 前置依赖（阻塞项）

| 依赖 | 内容 | 阻塞面 |
|---|---|---|
| **P1：请求前缀稳定** | tools 确定性排序 + schema 规范化（registry.rs:63-70 注册序隐患）+ system prompt 透传（core_run_commands.rs:919-929 加参数 → engine.rs:218-233 `system_prompt: None` 透传） | 无稳定前缀，历史回流后命中率上不来（comparison.md:393 明示） |
| **P3：模型目录（窗口元数据）** | `context_window_for`（P3 §3.1.5，models/catalog.rs） | `ContextBudget.context_window` 无源可依（阶段 2 前需 P3 目录或前端 `context_window` 参数兜底，§3.7 已留口）【A1 审计修正：原稿把"窗口元数据"列入 P1 依赖，实为 P3 交付】 |
| **P2：usage 归一化** | DeepSeek Chat 顶层 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`、Kimi 顶层 `cached_tokens` 补齐（chat.rs:251-267） | 估算的 usage 优先源、命中率验证（§⑤ 手工验收）、P5 展示的前置 |

### 6.2 文件域与冲突注意

- **主域**：`crates/session-loop`、`crates/conex-compaction`、`crates/conex-types`、`crates/orchestrator`。
- **必要接线触点**（改动小、语义不变）：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（core_run_task 参数）、`engine.rs`（produce 水合分支）、`main.rs`（无新命令，不涉及）、`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`（history 参数透传）。
- **串行冲突**：`stream_error.rs` / `no_tool_calls.rs` / `prepare_turn.rs` 与 P3（若 P3 也动溢出检测面）串行；`streaming.rs:253-259` 的 build_request 与 P1 的 tools_schema 改动同文件，需串行或明确分片；`core_run_commands.rs` 的 `core_run_task` 签名（本方案加 `history`/`context_window`，P1 步骤 2.4 加 `system_prompt`）同函数串行，P1 先行（【A3 审计修正】A3-executability.md P2-8）。

### 6.3 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 历史回流后 ContextLengthExceeded 频率上升（长会话） | 中 | 阶段 2/3 先于或同批上线：钳制 + 预检压缩 + 溢出压缩阶梯，构成完整窗口管理闭环（comparison.md:383 风险 ④ 的对策） |
| 载荷翻倍（每轮重传历史） | 低 | 参考软件全行业如此（comparison.md:307）；DeepSeek 自动缓存下命中即回本；压缩后历史自然收缩 |
| 模型多轮行为变化（上下文变长、可能回看） | 中 | 产品行为变更：UI 侧保持原文展示，不做额外提示（本方案不改 UI 语义）；如需提示由 P5 展示面承接 |
| 前端 store 与引擎缓存不一致（压缩/删除/分支） | 中 | 压缩后的序列只影响引擎请求构造；UI 展示用自己 store；分支（branch）会话以 session_id 隔离缓存键，天然分域 |
| 单条消息过大（压缩无效） | 低 | 压缩后仍超 → fatal 带诊断（§3.5）；未来可由工具输出截断面（scrubImagesOldestFirst）补刀，本方案不承接 |
| 摘要 L2 请求额外成本/延迟 | 低 | L1 静态占位为默认（零 LLM 调用）；L2 失败降级 L1；摘要请求独立前缀域不污染主会话缓存（§3.4.4） |

### 6.4 与 P5 的边界

- **P4 提供**：`ContextCompressionStart/End` 事件（events.rs:236-252，含 `ContextCompressionRecord` 全部字段：tokens_before/after、first_kept_message_id、cache_boundary.stable_prefix_hash 等）；会话历史回流后的 `ProviderUsage` 透传数据（沿既有 metadata.usage 链路）。
- **P5 负责**：命中率展示（`cacheRead / inputTotal`）、miss 审计、压缩历史的 UI 呈现。P4 不在 UI 侧做任何展示。
- **交接点**：阶段 5 确认事件字段满足 P5；`cache_boundary`（tool.rs:430-450）作为 P5 归因"缓存边界重置"的锚点（对齐 jcode cache_invalidation 台账思想，jcode-cache-analysis.md:170-179）。

### 6.5 演进项（本方案之外，登记备忘）

- 后台（异步）压缩：预检触发改为 jcode 式"80% 后台 + 95% 同步硬压缩"双级（jcode-cache-analysis.md:256-258）；当前 P4 全部同步，简化护栏。
- proactive/semantic 压缩（jcode-cache-analysis.md:288-290）。
- 压缩后"从开头删保缓存"（codex `remove_first_item`，codex-cli-cache-analysis.md:85）——本方案切割点从"中间段 + 摘要"起步，保留段之前全部进摘要，未做"物理删头"优化；观测到命中率问题时再引入。
- prompt_cache_key / 会话亲和（P1/P3 或厂商适配面）与摘要请求的"独立键"配合（opencode promptCacheKey = sessionID，opencode-cache-analysis.md:115）。

