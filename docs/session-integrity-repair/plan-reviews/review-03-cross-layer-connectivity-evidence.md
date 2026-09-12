# 方案交叉评审 03：端到端真实连通性与五重物证审查报告

> **评审对象**：全量 7 份独立方案（`docs/session-integrity-repair/independent-plans/plan-01` 至 `plan-07`），重点穿透审视 `plan-06-end-to-end-integration.md` 及其与其余详案的跨层调用拓扑。  
> **一手源码比对基线**：
> - **触发端**：`apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx`、`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`、`apps/crish-desktop/src/api/runControlClient.ts`
> - **传输端**：`apps/agent-workbench/src-tauri/src/run/run_launch.rs`、`crates/session-loop/src/control.rs`、`crates/session-loop/src/safe_point.rs`、`crates/session-loop/src/loop/handlers/executing_tools.rs`、`crates/session-loop/src/loop/handlers/streaming.rs`、`crates/session-loop/src/exec_batch.rs`
> - **介质端**：`crates/conex-db/src/group_commit.rs`、`crates/conex-db/src/events.rs`、`crates/conex-db/src/messages.rs`、`apps/agent-workbench/src-tauri/src/run/run_history.rs`
> - **消费端**：`apps/agent-workbench/src-tauri/src/run/run_launch.rs`（`resolve_history_source`）、`crates/session-loop/src/hydrate.rs`、`crates/agent-provider/src/request/build_anthropic.rs`、`crates/agent-provider/src/request/messages.rs`
> - **自愈端**：`crates/orchestrator/src/restore_manager.rs`
>
> **评审核心维度**：
> 1. **穿透功能伪连通**：方案是否真正打通了物理全链路？是否存在“在状态机里合成了 ToolResult，但未进入 SessionHistoryCache”、“写入了 events 表但未同步至 session_messages 物化视图”、“前端依然双发 cancel 命令”等半连通或测缝问题？
> 2. **五重客观物理证据严谨性**：触发端、传输端、介质端、消费端、负向断言五重物证是否具备确定性、可提取性与强闭环？
> 3. **脱水 Mock 冒充真实连通审查**：是否存在用纯内存局部单元测试代替跨进程/跨 Crate 真实 I/O 调度的作弊行为？
>
> **纪律铁律**：纯逻辑执行拓扑，严禁工期、人天、人员排期或 P0/P1 等级划分；所有发现问题逻辑同权。

---

## 一、评审结论总纲（Executive Summary）

经过对 `plan-01` 至 `plan-07` 全量 7 份独立方案（重点深入剖析 `plan-06`）的全文逐行交叉审查，并与上述 13 处一手源码核心模块进行全景时序比对，出具本次端到端真实连通性与五重物证审查的总体结论：

### 1. 总体评级：【有条件通过（存在 7 处致命伪连通断层与 1 处 Cargo 依赖拓扑错位，必须在总方案定稿前完成缝合）】

- **全链路视野与证据意识（优秀）**：`plan-06` 首次从宏观上建立了贯穿「UI 触发 -> IPC 网关 -> 引擎总线 -> 介质落盘 -> 水合再入 -> 上游出词」的完整物理时序图，明确提出了「五重客观物理证据链」框架，对于打破各子模块“各人自扫门前雪”的孤岛状态具有决定性价值。
- **真实代码穿透力（良好，但存在纸面伪连通）**：`plan-06` 对代码细节有较深涉猎，但在关键的“物理执行主体归属”上出现了致命的纸面臆造——**误将前端异步防抖写入的 `session_messages` 表当成了引擎驱动器（`drive_run_loop`）的同步操作**；同时在 SP-1 前置取消拦截点上，出现了“文字声称无孤儿，流程图与正文却写明直接退出”的自相矛盾。
- **跨方案接口对齐度（中等，存在多处调用测缝）**：
  - `plan-06` 与 `plan-01` 在取消错误码命名与前置拦截处理上存在断裂；
  - `plan-06` 与 `plan-02` 在物化视图更新触发机制上存在未接线真空；
  - `plan-06` 与 `plan-03` 在冷启动自愈权威（磁盘物理修正 vs 水合内存合成）上存在双轨漂移；
  - `plan-06` 与 `plan-05` 在清退 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` / `core_cancel_run` 上出现清单脱节；
  - `plan-06` 的端到端测试用例直接违反了 Cargo 工作区 Crate 单向依赖拓扑规则。

---

## 二、第一维度：穿透功能伪连通与调用拓扑审查

通过对全链路 13 处源码节点的现场比对，揭露出方案中存在的 **7 大物理伪连通断层（Pseudo-Connectivity Seams）**：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        端到端真实连通性 7 大物理断层全景透视                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [UI 触发端]                                                                            │
│      │                                                                                 │
│      ├── (断层 4) TRANSITIONAL_DUAL_CANCEL_RUN_WIRE 双发未彻底切除，并发争抢          │
│      ▼                                                                                 │
│ [IPC 网关与控制总线]                                                                   │
│      │                                                                                 │
│      ├── (断层 1) executing_tools.rs:49 SP-1 前置拦截直接裸退，execute_batch 根本未执行 │
│      ├── (断层 2) streaming.rs:270 流末尾 Abort 导致 E::HasToolCalls 未触发直接截断    │
│      ▼                                                                                 │
│ [引擎收口与持久化介质]                                                                 │
│      │                                                                                 │
│      ├── (断层 3) 虚构 Engine 同步写入 session_messages；该表实由前端 IPC 异步防抖写  │
│      ▼                                                                                 │
│ [冷启动恢复与水合再入]                                                                 │
│      │                                                                                 │
│      ├── (断层 5) run_launch:813 历史装配源 Frontend 倒挂抢占 Cache，hydrate 规则2杀tool │
│      ├── (断层 6) RestoreManager 磁盘物理自愈 与 hydrate.rs 内存动态垫片权威冲突      │
│      ▼                                                                                 │
│ [上游模型消费端]                                                                       │
│      │                                                                                 │
│      └── (断层 7) 仅顾 Anthropic messages，对 OpenAI/DeepSeek (messages.rs) 成对零防护 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1. 断层 1：SP-1 前置取消拦截直接裸退（`executing_tools.rs:49-53` 与 `plan-06:128`）

- **源码硬事实**：
  在 [`crates/session-loop/src/loop/handlers/executing_tools.rs:49-53`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L49-L53)：
  ```rust
  // 1. abort / 控制意图检查（L3 强停可立即中断）
  if let Some(end) = check_control(state)? {
      return Ok(HandlerOutcome::end(end));
  }
  ```
- **伪连通审查**：
  - `plan-06` 第 1.3.2 节第 5 点（line 128）明确写道：“*SP-1（工具批前置安全点）：`executing_tools.rs:49-52`，在开始解析工具前调用 `check_control`，若已中止直接退出*”；在第 4.1 节状态机流程图（line 488）中再次画出：`[SP-1: 前置检查 check_control] ──(已中断)──► [推进到 Abort 终态]`。
  - **严重物理漏洞**：在进入 `handle` 之前，前序 `Streaming` 阶段已经将模型产出包含 `ToolCall` 的 Assistant 消息提交到了 `state.conversation`。如果用户在工具分发前触发了停止，执行流在第 51 行直接以 `HandlerOutcome::end(end)` 退出！
  - **后果**：后续的 `last_assistant_with_tool_calls` 从未被解析，`executor.execute_batch` 从未被调用，`record_message` 从未执行！这一批 `ToolCall` 彻底沦为未闭合孤儿。
  - **与 `plan-01` 冲突**：`plan-01` 正确指出必须在此处就地拦截并强制合成 `ToolResult` 消息落盘；`plan-06` 却接受了现状的“直接退出”，并在后续章节声称“100% 闭环无孤儿”，属于典型的**设计自相矛盾与纸面伪闭环**。

---

### 2. 断层 2：流式输出末尾中断导致工具调度全面踩空（`streaming.rs:269-280`）

- **源码硬事实**：
  在 [`crates/session-loop/src/loop/handlers/streaming.rs:269-280`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L269-L280)：
  ```rust
  commit_message_with_deltas(state, message);

  if aborted || consumed.stop_reason() == Some(ConsumeStopReason::Aborted) {
      return streaming_aborted(state);
  }

  // 6. 安全点（stream 结束且消息已落盘）
  if let Some(end) = check_control(state)? {
      return Ok(HandlerOutcome::end(end));
  }
  ```
- **伪连通审查**：
  - 当模型输出包含工具调用，但流式在最后一个 chunk 触发用户取消或网络中止时，`commit_message_with_deltas` 已将携带 `AgentMessageBlock::ToolCall` 的 Assistant 消息写入 `state.conversation`。
  - 随后直接执行 `return streaming_aborted(state)` 或返回 `HandlerOutcome::end(end)`。状态机在此直接走向终态（`TurnComplete` -> `Done`），**永远不会触发 `E::HasToolCalls`，根本不可能进入 `ExecutingTools` 状态机！**
  - **后果**：`plan-06` 将所有的取消与合成逻辑全部寄托在 `executing_tools.rs` 与 `exec_batch.rs` 中，对 `streaming.rs` 的截断断面视而不见。这批已经进入对话历史的 `ToolCall` 将没有任何机会被合成。

---

### 3. 断层 3：介质端物化视图的“虚假引擎同步写入”（`Engine -> DB` vs `Frontend -> IPC`）

- **源码硬事实**：
  全量检索 `crates/` 源码可知，`crates/session-loop` 与 `crates/orchestrator` **从未直接调用过任何向 `session_messages` 表写入数据的逻辑**！
  `session_messages` 的真实物理写入路径为：
  `crish-desktop` 收到流式更新/结束事件 -> 更新前端 Store -> 触发 350ms 防抖 -> 前端通过 Tauri IPC 调用 `save_session_body`（[`sessionRustDbSql.ts:142`](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDbSql.ts#L142)）-> 进入 [`session_commands.rs:115`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/session_commands.rs#L115) -> 调用 `LocalDb::save_session_body_versioned`。
- **伪连通审查**：
  - `plan-06` 第 1.1 节时序图（lines 53-56）赫然写道：
    ```text
    Engine->>DB: DbWriteHandle.write(): 提交写操作至 Single Writer Actor
    DB->>DB: INSERT INTO events 表
    DB->>DB: save_session_body_versioned: session_messages 表 CAS 物化更新
    ```
  - **严重物理脱节**：`drive_run_loop` 仅向 `events` 表写入事件，并更新进程内存中的 `SessionHistoryCache`。它根本不会、也无法替前端调用 `save_session_body_versioned`！
  - **后果**：如果进程在工具执行被取消后发生硬退出（崩溃/用户杀进程），前端尚未完成 350ms 防抖提交，`session_messages` 表中根本没有刚刚被取消的工具结果！`plan-06` 宣称“介质端两表均已落盘成对结果”，完全是脱水设想，在真实物理世界中并不成立。

---

### 4. 断层 4：前端双发取消命令与过渡 Wire 状态冲突（`TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`）

- **源码硬事实**：
  在 [`apps/crish-desktop/src/api/runControlClient.ts:91, 147-155`](file:///c:/Software/conex/apps/crish-desktop/src/api/runControlClient.ts#L91)：
  ```typescript
  export const TRANSITIONAL_DUAL_CANCEL_RUN_WIRE = true as const;
  // sendTerminateDualWire 发送两个并发命令：
  // 1. client.send(buildRunControlWireMessage(req)) -> core_run_control
  // 2. client.send(buildCancelRunWireMessage(runId, mode)) -> core_cancel_run
  ```
- **伪连通审查**：
  - `plan-06` 在第 3.1 节（lines 449-456）提出清退 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`，收敛为单一 Canonical `core_run_control`。
  - **协同断裂**：
    1. 查阅专司清理死层的 `plan-05-dead-layers-removal.md`，其表 4（前端删除清册）中**完全遗漏了 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` 与 `sendTerminateDualWire`**！
    2. 在 `plan-06` 第 1.1 节时序图（line 26）中，依然将“成对发送 `core_run_control` + `core_cancel_run`”作为标准流程展示。
    3. 若前端关闭双发仅发 `core_run_control`，而此时 Rust 端 `run_launch.rs:1038` 依赖 `core_cancel_run` 来设置 `active.handle.cancel_run()` 改变 run 的终态映射依据，将导致部分依赖 `cancel_requested()` 判定的终态逻辑无法正确收敛为 `Cancelled`！方案未对 Rust 端终态判定依赖进行同步解耦。

---

### 5. 断层 5：历史装配源优先级倒挂漏洞（`run_launch.rs:813-820`）

- **源码硬事实**：
  在 [`apps/agent-workbench/src-tauri/src/run/run_launch.rs:813-820`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_launch.rs#L813-L820) 与 [`run_history.rs:416-424`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_history.rs#L416-L424)：
  ```rust
  pub(crate) fn resolve_history_source(
      history: &Option<Vec<HistoryMessage>>,
      cached: Option<Vec<HistoryMessage>>,
  ) -> Option<(HistorySource, Vec<HistoryMessage>)> {
      match history {
          Some(h) if !h.is_empty() => Some((HistorySource::Frontend, h.clone())),
          _ => cached.map(|messages| (HistorySource::Cache, messages)),
      }
  }
  ```
  在 [`crates/session-loop/src/hydrate.rs:13-14, 62-66`](file:///c:/Software/conex/crates/session-loop/src/hydrate.rs#L13-L14)：
  ```rust
  // 规则 2：角色映射：sender ∈ {user, assistant} 一一对应，其余角色跳过
  // （System/Tool 是 run 内瞬态角色，跨 run 不应回传，有意为之）
  let role = match entry.sender.as_str() {
      "user" => AgentMessageRole::User,
      "assistant" => AgentMessageRole::Assistant,
      _ => return None, // Tool 角色直接被物理抛弃！
  };
  ```
- **伪连通审查**：
  - `plan-06` 第 1.5.1 节（line 204）声称：“*若 SessionHistoryCache 存在则直接零拷贝取用；冷启动时从 SQLite 读取 session_messages 并调用 hydrate.rs*”。
  - **严重时序倒挂**：真实源码逻辑恰恰相反！桌面 UI 每次发问（`createStreamSession`）必定携带前端已有的全部 `history`。因此 `resolve_history_source` **永远命中 `HistorySource::Frontend`**，引擎精心维护的 `SessionHistoryCache` 被无情抛弃！
  - **成对性被主动切断**：命中 `HistorySource::Frontend` 时，执行 `hydrate_history`。而 `hydrate_history` 的规则 2 **明文规定丢弃所有 `sender == "tool"` 的消息**！
  - 在 `executing_tools.rs:166` 中，工具执行结果正是以 `role: AgentMessageRole::Tool` 独立记录的。当下一轮对话启动，前端将上一轮消息送入时，`hydrate_history` 把独立的 Tool 结果消息全部 `return None` 物理切除，只留下了包含 `ToolCall` 的 Assistant 消息！
  - 随后 `hydrate_history` 执行 `truncate_to_last_user`，直接把这批 Assistant 消息一并干掉，或在带有新 user 提问时产生**百分之百的孤儿 `tool_use`**！
  - `plan-06` 竟然未发现 `hydrate.rs` 规则 2 与独立 Tool 消息模型之间的这一致命冲突。

---

### 6. 断层 6：冷启动自愈权威与双轨冲突（`RestoreManager` 物理修复 vs `hydrate.rs` 内存垫片）

- **源码与方案冲突**：
  - `plan-03` 规划在 `crates/orchestrator/src/restore_manager.rs` 中实现 `heal_orphan_tool_calls`，在冷启动时扫描数据库，向 `events` 表追加 `ToolOutcomeUnknown` 事件，并重写 `session_messages` 表（完成持久化物理自愈）。
  - `plan-06` 第 4.2 节（lines 525-568）却又提出了在 `crates/session-loop/src/hydrate.rs:synthesize_blocks` 中注入 `synthesize_blocks_with_healing` 内存自愈算法。
- **伪连通审查**：
  - 架构中出现了**物理写库修复与只读内存动态垫片并存的双轨模型**。
  - 更严重的是：如果会话走 `SessionHistoryCache` 水合（`cached_history_to_conversation`），该函数直接调用 `parse_blocks`，根本不调用 `synthesize_blocks`！`plan-06` 设计的水合层自愈垫片在缓存路径上完全失效。
  - 必须确立统一权威：持久化自愈以 `RestoreManager` 权威落盘为主，`hydrate.rs` 与 `build_anthropic.rs` 仅作只读不变量防爆兜底，且兜底逻辑必须覆盖所有读取分支。

---

### 7. 断层 7：OpenAI / DeepSeek Wire 序列化校验盲区（`messages.rs`）

- **源码硬事实**：
  在 [`crates/agent-provider/src/request/messages.rs:296-398`](file:///c:/Software/conex/crates/agent-provider/src/request/messages.rs#L296-L398) 中，`to_chat_messages_with_compat` 负责通用 Chat Completions API（OpenAI / DeepSeek / 本地 Ollama 等）的消息装配。
- **伪连通审查**：
  - `plan-06` 在第 1.5.2 节、第 2.4 节与第 4.2 节中，**全篇只字不提 `messages.rs`，所有序列化校验与不变量算法全部针对 `build_anthropic.rs` 单一协议设计**。
  - 在 OpenAI 协议规范中，要求更加严苛：若 assistant 输出携带 `tool_calls`，后续必须紧跟 `role: "tool"` 且携带对应 `tool_call_id` 的消息。若存在未闭合调用，OpenAI API 同样返回 HTTP 400（`Invalid parameter: messages with role 'tool' must follow messages with role 'assistant'`）。
  - `plan-06` 的端到端闭环在该协议轨上存在巨大空洞，未实现跨模型协议的普适性防护。

---

## 三、第二维度：五重客观物理证据严谨性审查

`plan-06` 提出的五重物理证据构架是本战役验收的核心抓手。对其每一重证据的物理完备性进行全面加固与再定义：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   五重客观物理证据链加固验收规范                        │
├────────────────────────────────────────────────────────────────────────┤
│ [物证 1: 触发端物证] ── UI 状态复位与 IPC 单线 Canonical 校验          │
│     ├── UI 交互即时解除锁定，禁止系统提示正文污染                      │
│     └── IPC 发送捕获且仅捕获 core_run_control (level: force_cancel)    │
│                                │                                       │
│                                ▼                                       │
│ [物证 2: 传输端物证] ── ControlBus 聚合与四安全点刚性拦截              │
│     ├── ControlIntent (enqueued 与 consumed 两态成对发射)              │
│     ├── SP-1/SP-2/SP-3 全场景下 ToolEnd(cancelled) 100% 产生          │
│     └── AgentMessageRole::Tool 结果消息 100% 进入 state.conversation   │
│                                │                                       │
│                                ▼                                       │
│ [物证 3: 介质端物证] ── SQLite events 表 SSOT 与增量 Upsert 物化       │
│     ├── events 表: (session_id, sequence) 严格单调递增，无孤儿 ID      │
│     ├── runs 表: 状态原子收敛为 cancelled/completed，脑裂零残留        │
│     └── session_messages 表: 基于 ON CONFLICT 原生 Upsert，零全量清空  │
│                                │                                       │
│                                ▼                                       │
│ [物证 4: 消费端物证] ── 双协议 (Anthropic & OpenAI) 序列化 200 出词    │
│     ├── Anthropic: tool_use 紧随 tool_result，user/assistant 严格交替   │
│     ├── OpenAI: assistant.tool_calls 紧随 role=tool，成对闭环          │
│     └── 上游网关 HTTP 200 OK，TTFT ≤ 1.5s，零 400 Bad Request          │
│                                │                                       │
│                                ▼                                       │
│ [物证 5: 负向断言物证] ─ 极端故障 (SIGKILL/掉电) 注入零抹白与 100% 自愈 │
│     ├── 静态门禁: DELETE FROM session_messages 零调用拦截              │
│     └── 故障自愈: 孤儿调用在 RestoreManager 与水合层 100% 自动补齐     │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. 物证一：触发端物证（UI 状态复位与 IPC 命令流）
- **现状缺陷**：`plan-06` 既记录了单线 `core_run_control`，又要求支持双线 `core_cancel_run`，未明确断言标准以何为准。
- **强化验收标准**：
  1. **UI 状态**：用户触发 Stop（L2）或 Force Cancel（L3）后，`ChatComposerWrapper` 发送按钮状态在 ≤50ms 内复位为可编辑态；气泡内提示横幅独立展示，**严格断言 `session.messages` 正文字符串不包含任何硬编码系统提示（如「已停止」）**。
  2. **IPC 命令流**：在废除双发后，IPC 传输层监听器必须捕获且仅捕获一条规范的 `core_run_control` 命令，载荷必须严格包含 `level`、`runId`、`sessionId`、`reason` 四要素；过渡期结束后，`core_cancel_run` 的调用计数必须恒为 0。

### 2. 物证二：传输端物证（ControlBus 优先级聚合与安全点拦截）
- **现状缺陷**：遗漏了 SP-1 与 streaming 末尾的拦截物证断言。
- **强化验收标准**：
  1. **意图两态配对断言**：在 `LoopOutcome.events` 中，必须且恒能观察到针对同一 `intent_id` 的 `ControlIntent(enqueued)` 与 `ControlIntent(consumed)` 事件成对出现。
  2. **全生命期成对覆盖断言**：无论中断发生在 SP-1（分派前）、SP-2（审批中）、SP-3（执行中）还是 `streaming` 末尾，`LoopOutcome.messages` 中针对原 Assistant 声明的每一个 `call.id`，必须存在且仅存在一个对应的 `AgentMessageRole::Tool` 消息，其 `tool_call_id == call.id`，`is_error == true`，错误码统一对齐 `codes::TOOL_ABORTED_BEFORE_DISPATCH` 或 `codes::TOOL_CANCELLED`。

### 3. 物证三：介质端物证（SQLite events 表单调自增与增量 Upsert）
- **现状缺陷**：混淆了引擎事件落盘与前端物化落盘的物理时序。
- **强化验收标准**：
  1. **SSOT 事件流物理审计**：通过直接读取 SQLite 磁盘文件执行 SQL：
     `SELECT sequence, event_type, payload FROM events WHERE session_id = ? ORDER BY sequence ASC`。
     断言 `sequence` 数组严格连续（$S_{i+1} = S_i + 1$），且最后一项必须是 `run-terminal`（状态为 `cancelled` 或 `completed`）。
  2. **物化视图增量 Upsert 审计**：执行 SQL `SELECT count(*) FROM session_messages WHERE session_id = ?`，断言在单条消息追加或取消时，未发生过整表行数的瞬间归零重置；断言 `tool_call_results_json` 包含该被打断工具的合法 JSON 记录。

### 4. 物证四：消费端物证（双协议请求体成对闭合与上游 200 出词）
- **现状缺陷**：仅验证了 Anthropic API，缺失 OpenAI API 校验。
- **强化验收标准**：
  1. **Anthropic Messages 抓包断言**：序列化产物中，每个 `tool_use` 必须紧随对应的 `tool_result`，并且经过 `push_alternating` 投影为严格的角色交替结构 `[user, assistant, user]`。
  2. **OpenAI Chat Completions 抓包断言**：序列化产物中，`assistant.tool_calls` 后面必须立即紧跟相同数量的 `{"role": "tool", "tool_call_id": "..."}` 消息，严禁直接跳到新 user 消息。
  3. **网关物理连通物证**：抓包证实向上游大模型服务发起 HTTP POST 请求，上游返回 `HTTP 200 OK`，并在指定时间内流式吐出至少 1 个 token，零触发 HTTP 400。

### 5. 物证五：负向断言物证（故障注入下零数据抹白与 100% 自愈）
- **强化验收标准**：
  1. **破坏性 SQL 物理灭活断言**：静态防腐探针与动态 SQL 拦截器联合断言：生产代码中 `DELETE FROM session_messages WHERE session_id = ?` 执行计数严格为 0。
  2. **冷启动孤儿注入 100% 自愈断言**：构造破坏性 SQLite 数据库（人工制造只有 call 无 result 的残缺消息），启动应用并向该会话发起新一轮对话，系统 100% 自动触发自愈，上游请求体 100% 恢复合法，会话永不损坏。

---

## 四、第三维度：脱水 Mock 冒充真实连通作弊审查

依据仓库通用纪律 §7 与 §7.1，严厉审查并剔除方案中任何“脱水 Mock 冒充真实连通”的作弊企图：

### 1. 跨 Crate 依赖与测试宿主错位（Cargo 拓扑硬作弊）
- **审查发现**：
  `plan-06` 第 5.3 节（line 600）规划将端到端集成测试放置在：
  `crates/session-loop/tests/e2e_stop_and_reenter_test.rs`。
  在该测试步骤中，`plan-06` 要求直接断言 `session_messages` 表物化落盘以及 Tauri IPC 命令交互。
- **作弊判定**：
  在 Conex 架构体系中，`crates/session-loop` 是纯粹的内核状态机，只依赖 `conex-types` 与基础工具抽象，**严禁反向依赖外层的 `conex-db` 视图操作与 `agent-workbench` 壳层**！
  如果在 `crates/session-loop` 内测试 `session_messages` 表与 Tauri 命令，只能通过引入脱水 Mock 连接或伪造伪数据库连接，这不仅违反了 Cargo 依赖拓扑（禁止循环/逆向依赖），而且所谓的“端到端测试”在物理上根本没有经过真实的系统边界，属于**用假环境假连通冒充真连通**！
- **刚性纠正**：
  全链路端到端集成测试必须正确定位在集成宿主层：
  - **宿主层测试**：`apps/agent-workbench/src-tauri/tests/e2e_interrupt_integrity_test.rs`；
  - **顶层集成测试**：`tests/e2e/engine/session_integrity_e2e.test.ts`。
  只有在包含完整 Tauri Runtime、真实 SQLite WAL 数据库实例、真实 Single Writer Actor 与真实网络序列化器的宿主层，执行打断与水合再入，所获得的物理证据才是合法有效的！

### 2. 纯内存 `LoopState` 假连通拦截
- **审查发现**：历史存量测试中，存在大量在内存构造一个 `LoopState`，手工 push 一个 `ToolResult`，然后直接调用 `build_anthropic_request_body` 断言成功的用例。
- **刚性纠正**：本战役验收严禁以此类测试作为交付物证。必须使用真实的多线程 Tokio 调度器，真实启动 `tokio::spawn(drive_run_loop(...))`，真实由另一个线程下发 Abort 信号并竞速，验证真实并发下的物理收敛。

### 3. 序列化层静默吞错伪通过
- **审查发现**：`plan-06` 第 4.2 节的“算法 2”试图在 `build_anthropic.rs` 中发现孤儿 `tool_use` 时，**静默就地捏造**一个假的 `tool_result` 填入请求体发往外网。
- **作弊判定**：这是典型的“掩盖上游缺陷的下游兼容补丁”。如果内核循环没有正确合成结果，序列化层应当在 debug 模式下坚决 panic，在 release 模式下记录 error 审计事件并自愈，绝不允许静默掩盖问题。

---

## 四、第四维度：方案 06 与方案 01~05、07 接口调用衔接对齐表

为了消除各独立方案在并网实施时的“测缝漂移”，建立权威的跨方案接口对齐契约：

| 交互方案 | 既有衔接断层与矛盾点 | 权威裁决与物理对齐契约 |
| :--- | :--- | :--- |
| **Plan 06 $\leftrightarrow$ Plan 01**<br/>(中断合成) | 1. `plan-06:128` 允许 SP-1 裸退，`plan-01` 要求就地合成。<br/>2. 错误码定义脱节（`tool.cancelled` vs `TOOL_ABORTED_BEFORE_DISPATCH`）。 | **裁决以 Plan 01 为准**：<br/>1. 彻底切除 `executing_tools.rs:51` 的直接退出逻辑，统一改道 `synthesize_interrupted_call_results`；<br/>2. 错误码严格统一为 `crates/conex-types/src/error.rs` 中的常量，区分 `tool.aborted_before_dispatch` 与 `tool.cancelled_sibling`。 |
| **Plan 06 $\leftrightarrow$ Plan 02**<br/>(持久化 SSOT) | `plan-06` 虚构了 Engine 同步写 `session_messages`，与 `plan-02` 的写入 Actor 职责脱节。 | **裁决以 Plan 02 为准**：<br/>1. 确立 `events` 表为唯一 SSOT，`drive_run_loop` 仅写入 `events` 表与 `SessionHistoryCache`；<br/>2. `session_messages` 维持物化视图定位，通过 `plan-02` 提供的 `append_session_messages` 由前端或恢复管理器进行 CAS/增量 Upsert，禁止 Engine 越俎代庖。 |
| **Plan 06 $\leftrightarrow$ Plan 03**<br/>(冷启动自愈) | 磁盘物理自愈（`plan-03` 的 `RestoreManager`）与内存动态垫片（`plan-06` 的 `hydrate.rs`）权威冲突。 | **裁决为主从分层契约**：<br/>1. **第一权威**：`RestoreManager` 在冷启动时扫描并物理修复 SQLite `events` 与 `session_messages`；<br/>2. **防御兜底**：`hydrate.rs` 与 `build_anthropic.rs` 仅作为防爆兜底；若发生内存兜底，必须发射 `Tracing::warn` 告警审计，证明前置恢复存在遗漏。 |
| **Plan 06 $\leftrightarrow$ Plan 04**<br/>(防御测试网) | `plan-06` 测试用例位置错位（违规放入 `session-loop`）；`plan-04` 测试局限于单模块。 | **裁决为立体分层测试**：<br/>1. 单状态机逻辑测试（`plan-04`）归入 `session-loop/tests/`；<br/>2. 全链路集成与五重物证端到端测试（`plan-06`）归入 `agent-workbench/src-tauri/tests/`。 |
| **Plan 06 $\leftrightarrow$ Plan 05**<br/>(删除面清理) | `plan-06` 要求废除双发与 `core_cancel_run`，但 `plan-05` 删除清册遗漏。 | **裁决扩充 Plan 05 清册**：<br/>1. 在 `plan-05` 中追加删除项：清退前端 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` 与 `sendTerminateDualWire`；<br/>2. Rust 侧 `core_cancel_run` 降级为底层别名，统一由 `run_control_impl` 接管。 |
| **Plan 06 $\leftrightarrow$ Plan 07**<br/>(防腐门禁) | `plan-07` 探针未覆盖取消双发检测与跨 Crate 逆向依赖检查。 | **裁决强化 Plan 07 门禁**：<br/>1. `check-guard-system.mjs` 纳入对废弃取消命令的静态调用扫描；<br/>2. 强化成对性静态扫描，防止新增裸退出分支。 |

---

## 五、第五维度：最终合流决议与实施拓扑

### 1. 物理全链路端到端真实调用收敛拓扑（纠偏后）

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant UI as 前端视图 (ChatComposerWrapper)
    participant Client as 控制客户端 (runControlClient)
    participant IPC as Tauri IPC (core_run_control)
    participant Host as 桌面宿主 (run_launch / CoreRunState)
    participant Bus as 控制总线 (ControlBus / SafePoint)
    participant Loop as 会话循环内核 (executing_tools / streaming)
    participant DB as SQLite 持久层 (DbWriteHandle Actor)
    participant Cache as 内存缓存 (SessionHistoryCache)
    participant Hydrate as 水合与恢复 (RestoreManager / hydrate)
    participant Provider as 上游模型适配 (build_anthropic / messages)

    Note over User,IPC: 【阶段一：触发端单线 Canonical 发送】
    User->>UI: 点击停止按钮
    UI->>Client: finalizeStopGeneration()
    Client->>IPC: 仅单线发送 core_run_control (level: force_cancel/cooperative_stop)
    
    Note over IPC,Host: 【阶段二：宿主接收与总线排队】
    IPC->>Host: run_control_impl: state.set_user_stopped()
    Host->>Bus: active.abort_signal.abort() + bus.request_force_cancel()
    
    Note over Host,Loop: 【阶段三：会话循环内核刚性成对拦截与合成】
    alt 命中断面 1 (SP-1 前置检查)
        Loop->>Loop: executing_tools:49 捕获 abort 信号
        Loop->>Loop: 提取 tool_calls, 就地调用 synthesize_interrupted_call_results
        Loop->>Loop: record_message(state, tool_result_message) 落入 conversation
        Loop->>Loop: HandlerOutcome::end(aborted) 退出
    else 命中断面 2 (批并发执行打断)
        Loop->>Loop: execute_batch: mark_rest_cancelled 补全未执行项
        Loop->>Loop: record_message 落盘全量成对 ToolResult 消息
    end
    Loop->>Loop: emit_missing_turn_end() 闭合轮次
    
    Note over Loop,Cache: 【阶段四：介质端权威落盘与缓存回流】
    Loop->>Host: RunOutcome (携带 100% 成对的 messages 与 events)
    Host->>Cache: SessionHistoryCache::store (保真保存 tool 角色消息)
    Host->>DB: drive_outcome: 异步写入 events 表 (单调 sequence, 终态 run-terminal)
    Host-->>UI: run 终态事件通知
    UI->>DB: save_session_body_versioned (原生 Upsert 物化更新 session_messages)
    
    Note over User,Provider: 【阶段五：下一轮发问水合再入与双协议序列化】
    User->>UI: 发送新一轮问题
    UI->>Host: core_run_task
    alt 冷启动场景
        Host->>Hydrate: RestoreManager::restore: 物理扫描 events 修复孤儿并校准 runs 终态
        Host->>Hydrate: hydrate_history: 修复规则 2 (保真处理 ToolResult 块)
    else 热态连续场景
        Host->>Cache: 优先取用 SessionHistoryCache (全角色保真续接)
    end
    Host->>Provider: to_anthropic_messages 或 to_chat_messages
    Provider->>Provider: 成对性不变量校验通过 (零孤儿)
    Provider-->>User: 上游网关返回 HTTP 200 OK，流式首字吐出
```

### 2. 审结结论与准出判定

本评审报告认定：全量方案在总体方向上契合反退避与架构净收敛铁律，但 `plan-06` 及相关方案必须在**详案定稿阶段**彻底解决上述 **7 大物理断层**。严禁将带有伪连通与 Cargo 依赖错位的草案直接推进至代码实施期。所有涉及的代码行修正必须纳入分维详案并严格执行。
