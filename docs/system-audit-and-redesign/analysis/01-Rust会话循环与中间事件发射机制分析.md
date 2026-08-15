# Rust 会话循环与中间事件发射机制深度分析报告

**分析师角色**：Rust 会话循环与事件分析师  
**被分析模块**：`crates/session-loop/`、`crates/agent-provider/`、`apps/agent-workbench/src-tauri/`  
**核心问题**：

1. 思考内容只看到首个 Token（"TheTheThe..."）；
2. 多轮执行过程中的思考内容与工具调用在界面上无法实时看到，直到全任务完成才一次性爆发。

---

## 核心结论先行（Executive Summary）

| 关注维度                                | 表现与机制                                    | 根因与代码证据                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LLM 吐字（Thought/TextDelta）**       | **实时无缓冲（Immediate Flush）**             | `crates/session-loop/src/loop/handlers/streaming.rs:117-123` 收到 chunk 立即调用 `delta_sink.push()`；`apps/agent-workbench/src-tauri/src/engine_channels.rs:715-721` 的 `BridgeDeltaSink::push` 每次 push 均立即执行 `self.bridge.emit()` + `self.bridge.flush()` 推送到 Tauri IPC。**Rust 侧没有任何批处理或延迟缓冲**。                                                                                                                       |
| **"TheTheThe..." 首字现象**             | **前端 EventRouter 去重 Bug**                 | Rust 侧每次 delta 均实时发出，但信封 `sequence=None`。前端旧版 `EventRouter.ts` 在处理无 sequence 的 `message-delta` 时误触发了 dedupe 逻辑，导致每轮思考仅首个 token 被放行，后续 token 全被丢弃（前端现已修复）。                                                                                                                                                                                                                              |
| **工具调用（ToolStart/ToolEnd）**       | **全 Run 结束时一次性批处理发射（0 实时性）** | `crates/session-loop/src/loop/handlers/executing_tools.rs:91, 271-307`：工具事件仅 push 到内存中的 `state.events: Vec<AgentEvent>`；`apps/agent-workbench/src-tauri/src/run/run_idle.rs:1252-1398`：`drive_run_loop` 在 `producer.produce().await`（整个多轮循环 19 次工具执行全部跑完）返回后，才统一分配 sequence 并通过 `bridge.emit()` + `flush()` 一次性广播给前端！**多轮循环进行中，前端完全收不到任何 `tool-start` / `tool-end` 事件**。 |
| **消息/轮次闭合（MessageEnd/TurnEnd）** | **全 Run 结束时一次性批处理发射**             | `prepare_turn.rs`（`TurnStart`）、`streaming.rs`（`MessageStart`/`MessageEnd`）、`turn_complete.rs`（`TurnEnd`）全部仅写入 `state.events`，同样要在整个 Run 结束后才批量发射给前端。                                                                                                                                                                                                                                                             |
| **多轮思考未分段展示**                  | **双轨断裂导致前端无法感知轮次演进**          | 虽然每轮思考 delta 实时发出了，但由于对应的 `message-start`、`message-end`、`turn-start`、`turn-end`、`tool-start` 均被滞留在 Rust 内存中，前端流式管理器始终拿不到中间轮次的边界信标与工具卡片，导致 UI 无法按轮次展开，直到最后收口时 19 轮数据一次性冲入前端。                                                                                                                                                                                |

---

## 一、Rust 双轨事件架构与发射时序分析

Rust 引擎对事件采用了**双轨分流架构（Dual-Track Event System）**：

```
                              ┌────────────────────────────────────────────────────────┐
                              │                 LLM Stream (SSE/Chunk)                 │
                              └───────────────────────────┬────────────────────────────┘
                                                          │
                                                          ▼
                                    crates/session-loop/src/loop/handlers/streaming.rs
                                                          │
                                ┌─────────────────────────┴─────────────────────────┐
                                │                                                   │
                  (ProviderStreamEvent::Thought/TextDelta)             (ToolCall / MessageEnd / Stop)
                                │                                                   │
                                ▼ 【实时轨 Real-time Track】                         ▼ 【收口轨 Terminal Track】
                  BridgeDeltaSink::push(delta)                          state.events.push(AgentEvent::...)
                                │                                                   │
               AgentEventEnvelope { sequence: None }                                │ (仅存留在 LoopState.events 内存 Vec 中)
                                │                                                   │
               BufferedRunEventBridge::emit() + flush()                             │ ⚠️ 执行 19 轮工具循环期间完全不向外发射！
                                │                                                   │
                                ▼ (Immediate Tauri IPC)                             ▼
                        前端 EventRouter                                      AgentSessionLoop::run() 终态收敛
                                │                                                   │
                        前端流式消费 (onThought/onChunk)                              ▼
                                                                        apps/.../run_idle.rs: drive_outcome()
                                                                                    │
                                                                        分配全局递增原子 sequence 序号
                                                                                    │
                                                                        active.bridge.emit() + active.bridge.flush()
                                                                                    │
                                                                                    ▼ (Run 结束时一次性爆发)
                                                                            前端 EventRouter
```

### 1. 实时轨（Real-time Track）

- **挂载位置**：`apps/agent-workbench/src-tauri/src/engine_channels.rs:714-722`
  ```rust
  impl DeltaSink for BridgeDeltaSink {
      fn push(&self, delta: AgentEvent) {
          let envelope = AgentEventEnvelope::new(delta, Some(self.run_id.clone()), None);
          self.bridge.emit(&envelope);
          self.bridge.flush();
      }
  }
  ```
- **发射内容**：在 `crates/session-loop/src/loop/handlers/streaming.rs:577-589` 的 `delta_to_message_event` 中，**只有 `TextDelta` 和 `ThoughtDelta` 能够进入实时轨**：
  ```rust
  fn delta_to_message_event(
      state: &LoopState,
      message_id: &str,
      event: &ProviderStreamEvent,
  ) -> Option<AgentEvent> {
      let block = match event {
          ProviderStreamEvent::TextDelta { text } => AgentMessageBlock::Text { text: text.clone() },
          ProviderStreamEvent::ThoughtDelta { text, redacted } => AgentMessageBlock::Thought {
              text: text.clone(),
              redacted: *redacted,
          },
          _ => return None, // ToolCall / ProviderDiagnostic / Stop 全被过滤！
      };
      ...
  }
  ```

### 2. 收口批量轨（Terminal Track）

- **问题核心点**：除了流式文字与思考增量外，以下**所有关键交互事件**均只进入 `LoopState.events: Vec<AgentEvent>` 内存数组中：
  - `prepare_turn.rs:71` -> `AgentEvent::TurnStart`
  - `streaming.rs:558` -> `AgentEvent::MessageStart`
  - `streaming.rs:564` -> `AgentEvent::MessageEnd`（带 `turn_index`）
  - `executing_tools.rs:271` -> `AgentEvent::ToolBatchStart`
  - `executing_tools.rs:288` -> `AgentEvent::ToolStart`（带 `turn_index`）
  - `executing_tools.rs:244` -> `AgentEvent::ToolEnd`（带 `turn_index`）
  - `executing_tools.rs:251` -> `AgentEvent::ToolBatchEnd`
  - `executing_tools.rs:97` -> `AgentMessageRole::Tool` 结果消息的 `MessageStart`/`MessageEnd`
  - `turn_complete.rs:41` -> `AgentEvent::TurnEnd`
- **发射时机**：见 `apps/agent-workbench/src-tauri/src/run/run_idle.rs:1250-1398`，只有当 `producer.produce().await` 结束时才统一编号并发射。

---

## 二、关键代码位置清单

| 模块/功能                  | 核心文件                                                   | 关键行号     | 职责说明                                                               |
| -------------------------- | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| **流式消费与实时分流**     | `crates/session-loop/src/loop/handlers/streaming.rs`       | `L117-123`   | `sink.push(delta)` 实时发射 Thought/TextDelta                          |
|                            |                                                            | `L577-589`   | `delta_to_message_event` 过滤非 Text/Thought 事件                      |
|                            |                                                            | `L555-571`   | `commit_message_with_deltas` 仅把 MessageStart/End 推入 `state.events` |
| **实时桥发射与即时冲刷**   | `apps/agent-workbench/src-tauri/src/engine_channels.rs`    | `L714-722`   | `BridgeDeltaSink::push` 实现立即 `emit` + `flush`                      |
|                            |                                                            | `L659-670`   | `BufferedRunEventBridge::flush` 冲刷至 Tauri IPC                       |
| **工具执行与事件滞留**     | `crates/session-loop/src/loop/handlers/executing_tools.rs` | `L84-92`     | 批执行工具并在完成后调用 `emit_tool_events`                            |
|                            |                                                            | `L263-330`   | `emit_tool_events` 仅 push 到 `state.events`（内存中滞留）             |
| **工具事件批收口契约**     | `crates/session-loop/src/tool_events.rs`                   | `L15-29`     | 架构定义：工具事件属于批收口广播，非实时轨                             |
| **轮次生命周期与事件滞留** | `crates/session-loop/src/loop/handlers/prepare_turn.rs`    | `L66-75`     | `TurnStart` 仅 push 到 `state.events`                                  |
|                            | `crates/session-loop/src/loop/handlers/turn_complete.rs`   | `L41-51`     | `TurnEnd` 仅 push 到 `state.events`，判断多轮继续                      |
| **壳层收口与集中推送**     | `apps/agent-workbench/src-tauri/src/run/run_idle.rs`       | `L1252-1398` | `producer.produce().await` 阻塞等待全部轮次结束，统一发射所有积压事件  |
