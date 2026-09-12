# 方案 06 - 端到端真实链路连通与五重物证闭环

## 一、全景物理架构与真实调用拓扑

### 1.1 端到端物理调用拓扑全景图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户 (User)
    participant UI as 前端视图 (crish-desktop / UI Hooks)
    participant Client as 控制客户端 (runControlClient / streamStop)
    participant IPC as 通信通道 (Tauri IPC Transport)
    participant Host as 桌面内核命令网关 (agent-workbench / run_launch)
    participant Engine as 循环驱动器 (drive_run_loop / orchestrator)
    participant Bus as 控制总线与安全点 (ControlBus / SafePoint)
    participant Loop as 会话循环内核 (executing_tools / exec_batch)
    participant DB as 介质持久层 (conex-db / GroupCommit Actor)
    participant Hydrate as 水合再入层 (session-loop / hydrate)
    participant Provider as 上游模型适配 (agent-provider / build_anthropic)

    Note over User,UI: 【阶段一：触发端信号发生与网关分发】
    User->>UI: 点击 Stop 按钮 (默认 L2 cooperative / 强停 L3 force)
    UI->>Client: finalizeStopGeneration(force)
    Client->>Client: dispatchStreamStopCancel() 清理本地流缓冲并调用 runControl.dispatch
    Client->>IPC: sendTerminateDualWire: 成对发送 core_run_control + core_cancel_run
    IPC->>Host: Tauri Invoke 命令分发

    Note over Host,Bus: 【阶段二：传输总线排队与安全点打断调度】
    Host->>Host: run_control_impl: 标记会话级 user_stopped 状态
    alt L3 强制取消 (force_cancel)
        Host->>Bus: active.abort_signal.abort() 触发原子标志与广播
        Host->>Bus: bus.request_force_cancel(reason, "ui")
    else L2 协作停止 (cooperative_stop)
        Host->>Bus: bus.request_cooperative_stop(reason, "ui")
    end
    Host->>Host: cancel_run_impl: active.handle.cancel_run()

    Note over Engine,Loop: 【阶段三：工具执行打断与合成 ToolResult 闭环】
    loop Tool 批量执行 (execute_batch)
        Loop->>Loop: 竞速检查: abort_signal.is_aborted() 或 approval_wait 收到取消
        Loop->>Loop: 命中中断: 正在运行项中止，未运行项由 mark_rest_cancelled 标记 Cancelled
        Loop->>Loop: 生成全量 ClassifiedToolResult (无孤儿遗漏)
    end
    Loop->>Loop: executing_tools 步骤 3: record_message 为每项调用合成 ToolResult 消息
    Loop->>Bus: executing_tools 步骤 6: 安全点 check_control(state) 检查
    Bus-->>Loop: 命中 ForceCancel 或 CooperativeStop 动作
    Loop->>Loop: emit_missing_turn_end 兜底闭合孤儿 turn-start，状态机推进至终态收敛

    Note over Engine,DB: 【阶段四：介质端组提交与表物理落盘】
    Engine->>Engine: drive_run_loop 收口: 提取 outcome 并更新 SessionHistoryCache
    Engine->>Engine: drive_outcome: 驱动全部 SequencedEvent 入队，计算终态 RunTerminal
    Engine->>DB: DbWriteHandle.write(): 提交写操作至 Single Writer Actor
    DB->>DB: 5ms / 50-item 组提交窗口聚合 (BEGIN IMMEDIATE ... COMMIT)
    DB->>DB: INSERT INTO events 表 (包含 ControlIntent, ToolResult, TurnEnd, RunTerminal)
    DB->>DB: save_session_body_versioned: session_messages 表 CAS 物化更新

    Note over User,Provider: 【阶段五：下一轮对话水合再入与上游序列化】
    User->>UI: 发送新消息 (下一轮发问)
    UI->>Host: core_run_task 携带历史消息 (或触发冷启动回放)
    Host->>Hydrate: hydrate_history: 执行五大水合规则 (过滤未完成态、块保真重构)
    Hydrate->>Hydrate: synthesize_blocks: 解析 tool_calls 与 tool_call_results 合成完整成对块
    Hydrate->>Hydrate: truncate_to_last_user: 尾部约束截断
    Host->>Provider: build_anthropic_request_body (或 build_chat_completions)
    Provider->>Provider: to_anthropic_messages: 扫描 assistant 与 tool 消息
    Provider->>Provider: tool_use 必须且恒有对应的 tool_result 紧随其后 (无孤儿悬挂)
    Provider->>Provider: push_alternating: 严格维持 role 角色交替
    Provider-->>User: 上游 Provider 校验通过 (HTTP 200)，开始首字流式输出
```

---

### 1.2 阶段一：触发端信号发生与 Host 网关分发机制

#### 1.2.1 UI 交互发起点
前端界面通过统一的输入框或代理卡片组件暴露停止生成入口：
- 源码定位：`apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx:225`、`apps/crish-desktop/src/components/agent-card/AgentCard.tsx:172,289`。
- 触发动作：用户点击停止按钮，分发至流式回调控制器 `useStreamCallbacks.ts` 中的 `handleStopGeneration()`（对应 L2 协作停止，`force=false`）或 `handleForceCancelGeneration()`（对应 L3 强停，`force=true`，通过二次确认或快捷键触发）。

#### 1.2.2 客户端流终止与规整门面
在 `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:71-154` 中执行 `finalizeStopGeneration`：
1. **本地缓冲预算式收口**：调用 `renderBufferRef.current.flushFinal()` 与 `flushStreamBatchers()`，将未落盘的高频增量文字强制刷出，避免大残余截断；
2. **状态更新**：调用 `commitStreamToSession` 固化正文，并将当前 assistant 消息状态标记为 `completed`；
3. **调用统一停止调度器**：调用 `apps/crish-desktop/src/api/streamStop.ts:71-96` 的 `dispatchStreamStopCancel({ force, cancel: cur.cancel })`；
4. **触发活跃流取消闭包**：在 `apps/crish-desktop/src/api/chat-bridge/streamFinishControl.ts:70-98` 的 `createStreamCancel` 闭包中，将本地 `state.cancelled` 设为 `true`，清空审批流机，并通过 `getCompositionRoot().runControl.dispatch` 向核心发送控制命令。

#### 1.2.3 双线 IPC 发送与网关调用
在 `apps/crish-desktop/src/api/runControlClient.ts:122-157` 与 `:166-209` 中，控制请求经 `sendTerminateDualWire` 经 Tauri IPC Transport 发出：
1. **第一条命令（Canonical）**：`core_run_control`，载荷包含 `{ level: 'cooperative_stop' | 'force_cancel', runId, sessionId, reason }`；
2. **第二条命令（双线兼容）**：`core_cancel_run`，载荷包含 `{ runId, mode: 'cooperative' | 'force' }`；
3. **Transport 发送**：`apps/crish-desktop/src/api/transport/tauriTransport.ts:103-120` 将 WS 协议对象转化为标准 Tauri 命令名并由 `invokeTyped` 提交。

#### 1.2.4 桌面 Host 侧命令接收与会话标记
桌面宿主入口在 `apps/agent-workbench/src-tauri/src/main.rs:297-308` 注册，进入 `apps/agent-workbench/src-tauri/src/run/run_launch.rs`：
1. **`core_run_control` 实现 (`run_launch.rs:942-1049`)**：
   - 提取 `active_run(state, run_id)`；
   - 无论是 L2 还是 L3，统一调用 `state.set_user_stopped(&active.session_id)` 写入会话级停止标记，杜绝残留定时器或 watcher 自动拉起新 run；
   - **L3 强停分支 (`run_launch.rs:1022-1049`)**：
     - `active.user_touched.store(true, Ordering::SeqCst)`；
     - 调用 `active.abort_signal.abort()`，原子翻转中止布尔值并唤醒 `Notify` 等待者；
     - 获取总线锁 `active.control_bus.lock()`，调用 `bus.request_force_cancel(Some(reason), Some("ui"))` 压入控制队列；
     - 若环境变量 `CONEX_RUN_CONTROL_L3_TASK_CANCEL` 开启，调用 `state.background.graceful_stop_tasks_for_run` 优雅终止挂载在当前 run 上的普通后台任务（`run_commands.rs:145-186`）；
   - **L2 协作停止分支 (`run_launch.rs:1008-1020`)**：
     - 获取总线锁，调用 `bus.request_cooperative_stop(Some(reason), Some("ui"))`，不置 `abort_signal`，等待下一个安全点优雅终结。
2. **`core_cancel_run` 实现 (`run_launch.rs:1359-1405`)**：
   - 调用 `handle.cancel_run(cancel_mode, ...)` 标记取消，为后续终态映射提供 `cancel_requested` 依据。

---

### 1.3 阶段二：传输总线与安全点打断调度机制

#### 1.3.1 控制总线排队与追踪
源码位于 `crates/session-loop/src/control.rs`：
- `ControlBus` 持有 `queue: VecDeque<ControlIntent>` 与 `trace: VecDeque<ControlIntent>`（`control.rs:230-237`）；
- `request_force_cancel` 与 `request_cooperative_stop` 分别生成唯一 `id`（如 `ctrl-{timestamp}-{seq}`），将意图写入队列，并在 `trace` 记录入队轨迹供后续可观测性事件发射（`control.rs:255-275`）；
- `drain_as_action()` 执行严格优先级聚合：`ForceCancel > CooperativeStop > SoftInject`（`control.rs:415-430`）。

#### 1.3.2 四大物理安全点拦截矩阵
安全点判定由 `crates/session-loop/src/safe_point.rs:119-152` 中的 `apply_safe_point_control` 与 `crates/session-loop/src/loop/handlers/mod.rs:478-560` 中的 `check_control` 协同执行：
1. **优先级第一顺位**：`state.abort_signal.is_aborted()`。只要原子标志被置位，无论总线内有何意图，立即抢占返回 `ControlAction::ForceCancel`；
2. **总线聚合动作映射**：
   - `ControlDrainAction::ForceCancel` $\to$ `ControlAction::ForceCancel`；
   - `ControlDrainAction::CooperativeStop` $\to$ `ControlAction::CooperativeStop`；
3. **两态事件物理发射**：
   - 从 `bus.take_trace()` 取出轨迹，先发射 `AgentEvent::ControlIntent { state: "enqueued", ... }`，紧接着发射 `AgentEvent::ControlIntent { state: "consumed", ... }`，确保两态严格配对（`handlers/mod.rs:504-525`）；
4. **孤儿 Turn-Start 自动闭合**：调用 `emit_missing_turn_end(state)`，若当前轮次存在打开的 `turn-start` 但未正常到达 `turn-end`，立即补发 `turn-end`，彻底杜绝孤儿轮次（`handlers/mod.rs:529`）；
5. **四大安全拦截点分布**：
   - **SP-1（工具批前置安全点）**：`executing_tools.rs:49-52`，在开始解析工具前调用 `check_control`，若已中止直接退出；
   - **SP-2（并发审批等待竞速点）**：`exec_batch.rs:368-402`，审批等待与 `abort_signal.wait_aborted()` 竞速，一旦 abort 触发立刻中断剩余审批等待；
   - **SP-3（工具批后置安全点）**：`executing_tools.rs:137-140`，在记录完全部工具结果消息后立即拦截，防止进入下一轮 LLM 生成；
   - **SP-4（模型流式结束与轮次收敛点）**：`loop/mod.rs` 与 `turn_complete.rs` 轮次闭合点。

#### 1.3.3 工具批执行中的并发打断与取消合成（无孤儿保证核心）
源码位于 `crates/session-loop/src/exec_batch.rs` 与 `crates/session-loop/src/loop/handlers/executing_tools.rs`：
1. **批分组与逐组执行**：`BatchPlanner::plan` 将工具分为并行组与顺序项（`exec_batch.rs:205-227`）；
2. **并发打断捕获**：
   - 若 `abort` 信号已置位，未开始执行的工具项直接在 `collect_approvals` 中跳过后续等待（`exec_batch.rs:369-373`）；
   - 在 `execute_group` 中，未批准或被中断项统一归入取消分支，生成 `ClassifiedToolResult::error(&call.id, &call.tool_name, ToolErrorKind::Cancelled, "aborted", 0)`（`exec_batch.rs:493-501`）；
   - 剩余未执行的兄弟工具由 `mark_rest_cancelled` 全部批量标记为 `ToolErrorKind::Cancelled`（`exec_batch.rs:550-558`）；
   - **全量无遗漏断言**：`debug_assert!(results.iter().all(Option::is_some))`，生产环境即便出现 None 也降级补齐 `ToolErrorKind::Cancelled`，**保证每一个 `ToolBatchCall` 都有一个严格对应的 `ClassifiedToolResult`**（`exec_batch.rs:184-192`）；
3. **ToolResult 消息物理合成与落盘登记**：
   - 进入 `executing_tools.rs:103-105`：
     ```rust
     for result in &outcome.results {
         record_message(state, tool_result_message(result));
     }
     ```
   - `tool_result_message`（`executing_tools.rs:153-168`）构造：
     ```rust
     AgentMessage {
         id: format!("tool-result-{}", result.id),
         role: AgentMessageRole::Tool,
         created_at: conex_shared::time::now_iso_utc(),
         blocks: vec![AgentMessageBlock::ToolResult {
             tool_call_id: result.id.clone(),
             tool_name: result.tool_name.clone(),
             output: tool_output_from_result(result), // cancelled / aborted 错误输出
             is_error: true,
         }],
         ...
     }
     ```
   - `record_message` 将其追加至 `state.messages`，并向事件流发射 `AgentEvent::Message`。
4. **状态机终态收敛**：
   - 随后在步骤 6 命中 SP-3（`executing_tools.rs:137-140`），`check_control` 返回 `Some(EndDecision::aborted_with_diagnostic(...))` 或 `Some(EndDecision::stopped(...))`，循环立即停止。

---

### 1.4 阶段三：介质端组提交与落盘物化机制

#### 1.4.1 驱动收口与事件入队
源码位于 `apps/agent-workbench/src-tauri/src/run/run_idle.rs:1277-1420` 与 `crates/orchestrator/src/events.rs:447-586`：
1. `producer.produce().await` 返回 `outcome`；
2. `state.session_history.store(&session_id, to_history_messages(&outcome))` 原子刷新内存会话历史缓存（`run_idle.rs:1338-1340`）；
3. 调用 `drive_outcome`（`crates/orchestrator/src/events.rs:447`）：
   - 遍历 `outcome.events`，调用 `queue.push(&run.session_id, event).await`；
   - 经 `map_outcome_to_terminal(run.cancel_requested(), outcome.reason)` 计算终态：若 `outcome.reason` 为 `Aborted` 或 `cancel_requested=true`，映射为 `RunTerminalStatus::Cancelled`，`end_reason="aborted"`；若为 `Stopped`，映射为 `RunTerminalStatus::Completed`，`end_reason="stop"`（`crates/orchestrator/src/run.rs:660-675`）；
   - 构造唯一的终态事件 `AgentEvent::RunTerminal`，入队持久化并调用 `run.finalize` 固化游标（`events.rs:573-585`）。

#### 1.4.2 SQLite Single Writer Actor 与组提交管道
源码位于 `crates/conex-db/src/group_commit.rs`：
1. **Actor 架构**：`DbWriteHandle` 通过 `mpsc::channel(1024)` 将写闭包发送至后台独占的 SQLite 写连接线程循环 `run_actor_loop`（`group_commit.rs:101-160`）；
2. **组提交窗口**：收到第一个写任务后，在 5ms 窗口内至多聚合 50 个写入请求（`DEFAULT_GROUP_COMMIT_TIMEOUT_MS = 5`, `DEFAULT_GROUP_COMMIT_MAX_BATCH = 50`）；
3. **事务隔离**：整个批次使用单一 `BEGIN IMMEDIATE ... COMMIT` 事务包裹，单项操作通过 SQLite `SAVEPOINT` 隔离，确保单条写失败不破坏整批提交原子性，写吞吐提升一个数量级并消除锁争用。

#### 1.4.3 SQLite 物理表落盘快照
持久化操作最终物化在 SQLite 的核心表结构中：
1. **`events` 表（事件底账，`crates/conex-db/src/events.rs:13-37` 与 `schema.rs:147-156`）**：
   - 写入 SQL：`INSERT INTO events (session_id, sequence, event_type, payload, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%d %H:%M:%f','now'))`；
   - 严格记录包含打断全过程的所有关键事件：`control-intent(enqueued)`、`control-intent(consumed)`、`tool-start`、`tool-end`（带错误码与 `is_error=1`）、`message`（携带 ToolResult 块）、`turn-end`、`run-terminal`（终态标记）；
   - 主键 `(session_id, sequence)` 由 `session_sequence` 表保证严格单调自增、连续无空洞。
2. **`session_messages` 表（消息视图，`crates/conex-db/src/messages.rs:70-176`）**：
   - 由前端流式结束或会话维护通过 `save_session_body_versioned` 触发：
     - CAS 校验 `body_version`；
     - 写入 `INSERT INTO session_messages (session_id, seq, id, sender, text, status, tool_calls_json, blocks_json, tool_call_results_json, ...)`；
     - 此时 assistant 消息的 `status` 处于 `completed`，且 `tool_calls_json` 与 `tool_call_results_json`（或 `blocks_json`）均已物理落盘，包含 cancelled 的工具结果，**不存在悬空调用**。

---

### 1.5 阶段四：消费端水合再入与上游交互机制

#### 1.5.1 下一轮发问触发与水合加载
当用户输入新问题并点击发送时：
1. 宿主收到 `core_run_task`，若 `SessionHistoryCache` 存在则直接零拷贝取用；冷启动时从 SQLite 读取 `session_messages` 并调用 `crates/session-loop/src/hydrate.rs:39-49` 的 `hydrate_history`。
2. **五大水合规则执行 (`hydrate.rs:58-90, 314-322`)**：
   - **规则 1（状态过滤）**：已完成的 assistant 消息（`status="completed"`）正常放行；未完成的被 `status_kind` 过滤；
   - **规则 2（角色映射）**：映射为 `AgentMessageRole::User` 与 `AgentMessageRole::Assistant`；
   - **规则 3（块保真与合成）**：
     - 若 `blocks_json` 存在且格式匹配，直接反序列化为 `AgentMessageBlock` 序列；
     - 否则走 `synthesize_blocks`（`hydrate.rs:136-183`）：从 `tool_calls_json` 解析出 `AgentMessageBlock::ToolCall`，同时从 `tool_call_results_json` 解析出对应的 `AgentMessageBlock::ToolResult`；
   - **规则 5（尾部约束）**：调用 `truncate_to_last_user`，截断至最后一条 user 消息，保证协议合法性。

#### 1.5.2 上游 Provider 请求序列化与交替投影
源码位于 `crates/agent-provider/src/request/build_anthropic.rs`（以对工具成对性与角色交替要求最为苛刻的 Anthropic Messages API 为基准）与 `crates/agent-provider/src/request/messages.rs`：
1. **消息序列化遍历 (`build_anthropic.rs:342-381`)**：
   - 遇到 `AgentMessageRole::Assistant`：
     - 提取正文、思考与工具调用块：`assistant_anthropic_content`（`build_anthropic.rs:505-526`），产出 `{"type": "tool_use", "id": call.id, "name": call.tool_name, "input": call.input}`；
     - 提取历史同体 ToolResult 块：`tool_result_anthropic_content`（`build_anthropic.rs:466-502`），产出 `{"type": "tool_result", "tool_use_id": result.id, "content": "cancelled", "is_error": true}`；
     - 经 `push_alternating` 注入，`tool_use` 归入 assistant 角色，紧随其后的 `tool_result` 归入 user 角色；
   - 遇到 `AgentMessageRole::Tool` 消息：
     - 提取 `tool_result` 块，经 `push_alternating` 归入 user 角色；
2. **角色交替投影保护 (`build_anthropic.rs:388-407`)**：
   - 遇到连续两条 user 消息（例如工具响应后紧跟下一轮用户提问）：`push_alternating` 自动将其 `content` 数组合并，杜绝连续同角色；
   - 遇到连续 assistant 消息：瞬态前置 `WIRE_CONTINUATION_NOTE` 占位，确保严格交替。
3. **孤儿 tool_use 绝对消除断言**：
   - 因为在阶段二中，所有的被打断工具调用均已通过 `ClassifiedToolResult::error` 记录，并在阶段三持久化、阶段四水合，**每一个输出到上游的 `tool_use` 块，紧随其后的 user 消息中都有且仅有一个匹配该 `id` 的 `tool_result` 块**；
   - 上游 Anthropic / OpenAI 接口验证通过，返回 HTTP 200 OK，正常进入流式生成，无 HTTP 400 `invalid_request_error: each tool_use block must have a corresponding tool_result block`。

---

## 二、五重客观物理证据验收标准与自洽闭环

本方案确立五重客观物理证据标准，所有验收必须在真实运行环境（非脱水纯 Mock）下抓取实际产生的数据物证，形成完整的闭环验证链。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   五重客观物理证据链闭环架构                            │
├────────────────────────────────────────────────────────────────────────┤
│ [物证一: 触发端物证] ─── IPC 抓包 / 前端 EventBus 镜像                │
│     ├── core_run_control (level: force_cancel / cooperative_stop)      │
│     └── core_cancel_run (mode: force / cooperative)                   │
│                                │                                       │
│                                ▼                                       │
│ [物证二: 传输端物证] ─── session-loop 状态流与 Tracing Span             │
│     ├── ControlIntent (state="enqueued" & state="consumed")            │
│     ├── ToolEnd (is_error=true, error_code="cancelled")                │
│     └── missing turn-end 自动补发闭合                                  │
│                                │                                       │
│                                ▼                                       │
│ [物证三: 介质端物证] ─── SQLite 本地数据库物理表快照                    │
│     ├── events 表: (session_id, sequence) 严格单调连续无空洞           │
│     ├── session_messages 表: tool_calls 与 tool_call_results 成对落盘   │
│     └── runs 表: 状态收敛为 cancelled / completed                      │
│                                │                                       │
│                                ▼                                       │
│ [物证四: 消费端物证] ─── 上游 HTTP 请求体 JSON 抓包与响应               │
│     ├── anthropic.messages: 每个 tool_use 紧随对应 tool_result         │
│     ├── wire: user/assistant 严格交替                                 │
│     └── HTTP 状态码: 200 OK，零 400 invalid_request_error              │
│                                │                                       │
│                                ▼                                       │
│ [物证五: 负向断言物证] ── 极端故障注入 (SIGKILL / 掉电截断) 自愈        │
│     ├── 孤儿 tool_call 在水合层或序列化层自动合成 cancelled 垫片       │
│     └── 重启后会话永不卡死，下轮发问自愈成功响应                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 物证一：触发端物证（UI 状态与 IPC 事件发送）

#### 2.1.1 验收标准与物理特征
- **UI 状态特征**：
  1. 点击 Stop 按钮后，Composer 输入框的停止按钮立即置灰/变为发送态，解除交互锁定；
  2. 聊天气泡内显示带有截断/停止提示横幅（如「已停止本轮生成」），但**严禁将系统提示句作为正文混入 assistant 消息内容**（`useStreamCallbacks.ts:127`）；
  3. 前端状态机中当前会话的 `isGenerating` 状态翻转为 `false`，`markStreamingActive(false)`。
- **IPC 发送载荷证据**：
  在 WebView2 与 Rust 桥接处捕获 IPC 发送日志，必须观测到成对调用的物理参数：
  ```json
  // 命令 1：core_run_control
  {
    "cmd": "core_run_control",
    "runId": "run-xxxx",
    "sessionId": "sess-yyyy",
    "level": "force_cancel", // 或 "cooperative_stop"
    "reason": "ui-force-cancel" // 或 "ui-stop"
  }
  // 命令 2：core_cancel_run
  {
    "cmd": "core_cancel_run",
    "runId": "run-xxxx",
    "mode": "force" // 或 "cooperative"
  }
  ```

#### 2.1.2 采样与提取方法
- 前端测试钩子：挂载 `tauriTransport.test.ts` 中的 `mockTauriCommand` 或在 `apps/crish-desktop/src/services/EventBus.ts` 监听 `run:control` 事件；
- 宿主日志：查看 `apps/agent-workbench/src-tauri/src/run/run_launch.rs:1396` 发射的 tracing 日志：`"cancel_run_impl: run_id=..., path=..."`。

---

### 2.2 物证二：传输端物证（ControlBus 拦截与安全点事件）

#### 2.2.1 验收标准与物理特征
- **ControlBus 内部状态**：
  1. 调度队列中成功提取到对应的 `ControlIntent`，且必须观测到 `enqueued` 与 `consumed` 状态先后成对发射；
  2. `AbortSignal.is_aborted()` 返回 `true`。
- **事件序列特征（AgentEvent 流）**：
  在 `LoopState` 的事件流中必须依序出现以下事件且字段完整：
  1. `AgentEvent::ControlIntent { kind: "force-cancel", state: "enqueued", intent_id: "ctrl-...", ... }`；
  2. `AgentEvent::ControlIntent { kind: "force-cancel", state: "consumed", intent_id: "ctrl-...", ... }`；
  3. 对于当前被取消的工具调用，必须发射：
     ```json
     AgentEvent::ToolEnd {
       "call_id": "call_123",
       "tool_name": "bash",
       "is_error": true,
       "error_code": "tool.cancelled",
       "error_message": "aborted",
       ...
     }
     ```
  4. 紧接着发射工具结果消息事件：
     ```json
     AgentEvent::Message {
       "role": "tool",
       "blocks": [{
         "type": "tool_result",
         "tool_call_id": "call_123",
         "is_error": true,
         "output": { "text": "aborted" }
       }]
     }
     ```
  5. 孤儿 Turn 闭合证据：若被打断时处于 turn 内部，必须紧随出现补发的 `AgentEvent::TurnEnd { turn_index: N, ... }`；
  6. 终态收口证据：`AgentEvent::RunTerminal { status: "cancelled", end_reason: "aborted", ... }`。

#### 2.2.2 采样与提取方法
- 使用 `session_loop::run_loop` 集成测试用例驱动运行，拦截提取 `LoopOutcome.events`；
- 断言：`events.iter().filter(|e| matches!(e, AgentEvent::ControlIntent { .. })).count() == 2`；
- 断言：`events.iter().any(|e| matches!(e, AgentEvent::ToolEnd { is_error: true, .. })) == true`。

---

### 2.3 物证三：介质端物证（SQLite events 表与 session_messages 表数据落盘快照）

#### 2.3.1 验收标准与物理特征
- **`events` 表 SQL 查询断言**：
  执行 SQL：`SELECT sequence, event_type, payload, run_id FROM events WHERE session_id = ?1 ORDER BY sequence ASC`：
  1. **序列号连续性断言**：`sequence` 数组严格单调递增，无断号，无跳号（如 `[1, 2, 3, 4, 5]`）；
  2. **事件类型覆盖断言**：表中必须存在 `event_type = 'tool-end'`（payload 中 `is_error = 1`）以及 `event_type = 'message'`（携带 `ToolResult`）；
  3. **终态行断言**：最后一条事件必须为 `event_type = 'run-terminal'`，其 payload 内包含 `"status":"cancelled"` 与 `"endReason":"aborted"`；
  4. **外键与 run_id 断言**：所有行的 `run_id` 列必须精确等于当前 run 的 ID。
- **`session_messages` 表 SQL 查询断言**：
  执行 SQL：`SELECT seq, id, sender, status, tool_calls_json, tool_call_results_json, blocks_json FROM session_messages WHERE session_id = ?1 ORDER BY seq ASC`：
  1. 最后一轮的 assistant 消息 `status` 为 `'completed'`；
  2. `tool_calls_json` 中声明了 `call_id`；
  3. `tool_call_results_json` 中**必定包含相同 `id` 的结果项**，内容为 `{"id":"call_id","output":"aborted","isError":true}`，绝不允许为空数组或 NULL！

#### 2.3.2 采样与提取方法
- 直接使用 `rusqlite` 或 `sqlite3` CLI 在 SQLite DB 文件上执行结构化断言脚本；
- 在测试套件中通过 `LocalDb::load_session_body` 与 `LocalDb::query_events` 进行物理读取比对。

---

### 2.4 物证四：消费端物证（下一轮请求上游 Provider 序列化无 400 正常出词）

#### 2.4.1 验收标准与物理特征
- **Anthropic Messages 请求体物理快照断言**：
  通过抓包代理或测试 Mock 捕获向 `https://api.anthropic.com/v1/messages` 发送的 JSON 请求体：
  ```json
  {
    "model": "claude-3-7-sonnet-20250219",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "第一轮提问：请列出文件并统计" }] },
      {
        "role": "assistant",
        "content": [
          { "type": "text", "text": "好的，我开始执行命令：" },
          {
            "type": "tool_use",
            "id": "call_abc123",
            "name": "bash",
            "input": { "command": "ls -la" }
          }
        ]
      },
      {
        "role": "user",
        "content": [
          {
            "type": "tool_result",
            "tool_use_id": "call_abc123",
            "content": "aborted",
            "is_error": true
          },
          {
            "type": "text",
            "text": "第二轮提问：刚才停止了，现在帮我写一段 Rust 代码"
          }
        ]
      }
    ]
  }
  ```
  **严格满足两大不变量**：
  1. **配对性**：`tool_use.id = "call_abc123"` 在下一个 user 消息中**必然且立即**存在 `tool_result.tool_use_id = "call_abc123"`；
  2. **交替性**：`messages` 数组的角色序列严格为 `["user", "assistant", "user"]`，连续的 tool_result 与新 user 提问已被合并进同一个 user 消息块数组中（`push_alternating` 契约，`build_anthropic.rs:388-400`）。
- **上游真实响应物理断言**：
  - HTTP 状态码为 `200 OK`；
  - 响应流第一帧到达时间（TTFT）处于正常区间（≤ 1.5s）；
  - 零出现 `400 Bad Request`（如 `invalid_request_error: each tool_use block must have a corresponding tool_result block`）。

#### 2.4.2 采样与提取方法
- 在集成测试中使用 WireMock / Mockito 监听端口，校验传入的 HTTP 请求 Body 并断言无孤儿字段；
- 在生产环境打开调试日志，断言 `crates/agent-provider/src/request/build_anthropic.rs` 的序列化产物。

---

### 2.5 物证五：负向断言物证（中途断电/崩溃重启时无孤儿悬挂自愈）

#### 2.5.1 极端故障场景设计
在工具执行的中途瞬间注入致命故障：
1. **故障场景 A（硬性断电模拟）**：在 `execute_group` 正在等待外部进程时，直接调用 `std::process::exit(1)` 或触发操作系统 `SIGKILL`，导致内存中正在生成的 `ToolResult` 尚未写入 `session_messages`；
2. **故障场景 B（脏数据回写模拟）**：向 SQLite 的 `session_messages` 表手工注入一条残缺的历史行——assistant 消息的 `tool_calls_json` 包含 `["call_corrupt_999"]`，但 `tool_call_results_json` 为 `[]` 且 `blocks_json` 为空。

#### 2.5.2 自愈机制与验收断言
系统重新启动后，用户直接在当前会话发送下一轮问题，系统必须自愈并通过验收：
1. **水合层自愈断言 (`hydrate.rs:161-183`)**：
   - 当 `synthesize_blocks` 发现 `tool_calls` 中存在某个 `call.id` 在 `tool_call_results` 中缺失时，**绝不允许单向产出只有 `ToolCall` 而无 `ToolResult` 的半截消息**；
   - 自动在同一 assistant 消息的 blocks 中合成一个中性错误块：
     ```rust
     AgentMessageBlock::ToolResult {
         tool_call_id: call.id.clone(),
         tool_name: call.name.clone(),
         output: ToolOutput::text("execution interrupted unexpectedly before result recorded".to_string()),
         is_error: true,
     }
     ```
2. **序列化层守门断言 (`build_anthropic.rs` & `messages.rs`)**：
   - 遍历 `messages` 时维护待匹配的 `pending_tool_use_ids: HashSet<String>`；
   - 若进入下一轮 user 提问前仍有未配对的 `tool_use_id`，序列化层自动向请求体追加占位的 `tool_result` 块，确保传向上游模型的 payload 100% 合法；
3. **物证结果**：在经历了场景 A 或场景 B 的严重破坏后，下一轮发问**依然返回 HTTP 200 OK**，模型能意识到上一轮工具因异常中断，并在回复中继续响应新问题，会话永久可用，零孤儿坏死。

---

## 三、本方案要删掉什么 / 收敛什么（架构净收敛专节）

为了彻底杜绝架构漂移与多套协议并存带来的死锁与逻辑断层，本方案推行以下硬性收敛与代码清退措施：

### 3.1 废除过渡期双线发送（清退 `core_cancel_run` 与冗余 Wire）
- **现状包袱**：
  在 `apps/crish-desktop/src/api/runControlClient.ts:87-91` 中，长期保留常量 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE = true`，导致前端每次停止都成对发出 `core_run_control` 与 `core_cancel_run`（`sendTerminateDualWire`，:132-157）。这不仅浪费 IPC 开销，而且在 Rust 端同时触碰两条取消状态路径，埋下竞态隐患。
- **收敛方案**：
  1. 废除前端 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE`，将终止逻辑统一收敛为 **单一 Canonical `core_run_control` 命令**；
  2. 删除 `apps/crish-desktop/src/api/runControlClient.ts` 中的 `buildCancelRunWireMessage` 与 `sendTerminateDualWire` 辅助函数；
  3. 废除 `core_cancel_run` 在前端 `commandManifest.ts` 与 Rust `command_manifest.rs` 中的核心注册地位，仅在 Rust 侧保留为底层兼容性别名（或彻底重构为 `run_control_impl` 的包装）；
  4. 消除前端 `streamStop.ts` 中多余的路径分叉，所有停止统一经由 `compositionRoot.runControl.dispatch` 出站。

### 3.2 收敛控制意图协议与冗余别名
- **现状包袱**：
  在 `crates/session-loop/src/control.rs` 中，历史遗留了 `soft_inject`、`steer`、`follow_up` 等多种语义重叠的 L1 变体，甚至在历史注释中遗留了 `request_soft_inject` 等废弃别名；在前端 `runControlClient.ts` 中也存在多处字符串字面量拼装。
- **收敛方案**：
  1. 彻底清退未使用的旧式别名；
  2. 严格按三级收口控制总线：
     - `L1 (Steer / FollowUp)`：只写队列不打断流；
     - `L2 (CooperativeStop)`：等安全点优雅结束；
     - `L3 (ForceCancel)`：AbortSignal 强打断 + 安全点快速收场；
  3. 控制总线内的 `drain_as_action` 作为单一真理路径（SSOT），禁止任何旁路机制直接操作状态机收场。

### 3.3 消除脱水 Mock 冒充验收的隐患
- **现状包袱**：
  历史部分测试仅在内存中构造一个 `LoopState`，塞入 mock 的 `ToolResult`，直接调用 `to_anthropic_messages` 断言通过，跳过了真正的物理打断、组提交排队和磁盘文件落盘，掩盖了真实并发场景下的时序断层。
- **收敛方案**：
  1. 废止纯内存假通过断言作为交付依据；
  2. 验收必须以包含真实 Tokio 任务调度、真实 SQLite 写入和真实序列化输出的集成测试套件为准。

---

## 四、核心算法与数据结构设计

### 4.1 安全点拦截器与 ToolResult 合成状态机

在执行工具打断时，状态机状态流转必须满足原子性与幂等性：

```
       [ExecutingTools 状态]
               │
               ▼
     [SP-1: 前置检查 check_control] ──(已中断)──► [推进到 Abort 终态]
               │
           (未中断)
               ▼
     [执行批次 BatchRunner::run]
               │
        ┌──────┴─────────────────────────────────┐
        ▼                                        ▼
  [工具正常完成]                          [捕获 AbortSignal 中断]
        │                                        │
        │                                 [mark_rest_cancelled]
        │                                        │
        ▼                                        ▼
  [ClassifiedToolResult::ok]            [ClassifiedToolResult::cancelled]
        │                                        │
        └──────────────────┬─────────────────────┘
                           │ (确保 calls.len() == results.len())
                           ▼
          [record_message: 合成 ToolResult 消息]
                           │
                           ▼
          [SP-3: 后置检查 check_control]
                           │
                           ▼
          [返回 HandlerOutcome::end(aborted/stopped)]
                           │
                           ▼
               [emit_missing_turn_end 兜底闭合]
```

### 4.2 孤儿 ToolCall 识别与自愈垫片算法

为确保即便遭遇外部进程硬崩溃，下一轮水合与上游序列化依然 100% 免疫 400 错误，在 `crates/session-loop/src/hydrate.rs` 与 `crates/agent-provider/src/request/build_anthropic.rs` 注入双层防御算法：

#### 算法 1：水合层成对闭合自愈 (`hydrate.rs:synthesize_blocks`)
```rust
// 伪代码实现逻辑：
fn synthesize_blocks_with_healing(entry: &HistoryMessage) -> Vec<AgentMessageBlock> {
    let mut blocks = Vec::new();
    let tool_calls = parse_tool_calls(entry);
    let mut tool_results = parse_tool_call_results(entry);

    // 1. 注入所有 ToolCall 块
    for call in &tool_calls {
        blocks.push(AgentMessageBlock::ToolCall(ToolCallBlock {
            id: call.id.clone(),
            tool_name: call.name.clone(),
            input: parse_arguments(&call.arguments),
        }));
    }

    // 2. 检查是否有缺失 ToolResult 的孤儿调用
    for call in &tool_calls {
        if !tool_results.iter().any(|r| r.id == call.id) {
            // 孤儿发现！自愈合成一个带 is_error: true 的 cancelled 结果
            tool_results.push(LegacyToolCallResult {
                id: call.id.clone(),
                output: Some("execution interrupted (self-healed on hydration)".to_string()),
                is_error: Some(true),
            });
        }
    }

    // 3. 注入成对的 ToolResult 块
    for result in tool_results {
        let tool_name = tool_calls
            .iter()
            .find(|c| c.id == result.id)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        blocks.push(AgentMessageBlock::ToolResult {
            tool_call_id: result.id,
            tool_name,
            output: ToolOutput::text(result.output.unwrap_or_default()),
            is_error: result.is_error.unwrap_or(true),
        });
    }

    blocks
}
```

#### 算法 2：序列化层 Invariant Guardian (`build_anthropic.rs:to_anthropic_messages`)
在将 `AgentMessage` 映射为 `messages` 数组时：
1. 记录已输出给模型的 `active_tool_use_ids: HashSet<String>`；
2. 当 assistant 消息产出 `tool_use` 时，将其全部 `id` 放入 `active_tool_use_ids`；
3. 当随后的 user 消息或 tool 消息产出 `tool_result` 时，从集合中移除对应的 `id`；
4. 在追加下一个非 tool 消息或结束序列化前，若 `!active_tool_use_ids.is_empty()`：
   - 自动就地构造一个 user 消息，并填入缺失的 `tool_result` 块，标记 `content: "(interrupted)"`, `is_error: true`；
   - 彻底在物理层面剥夺上游 API 报 400 的任何可能性。

---

## 五、立体物理验证方案

遵循通用协作纪律 §7 与 §7.1，本方案拒绝单一检查冒充验收，实行多层次物理现场验证。

### 5.1 模块级白盒物理验证
- **测试命令**：`cargo test -p session-loop --lib safe_point` 与 `cargo test -p session-loop --lib exec_batch`；
- **验证断言**：
  1. `apply_safe_point_control` 在 `abort_signal` 触发时能 100% 抢占；
  2. `execute_batch` 在外部中止时，返回的 `outcome.results` 长度严格等于 `calls.len()`，且被取消项错误码恒为 `ToolErrorKind::Cancelled`；
  3. `check_control` 闭合孤儿 turn-start，发射成对 `ControlIntent` 事件。

### 5.2 介质组提交与落盘物理验证
- **测试命令**：`cargo test -p conex-db --test stress_write` 与 `cargo test -p conex-db --test migrations`；
- **验证断言**：
  1. 在高并发连续写情境下，`DbWriteHandle` 的 Single Writer Actor 维持 5ms 批次聚合，零数据库锁定错误（`SQLITE_BUSY` 消除）；
  2. `events` 表中 `(session_id, sequence)` 组合主键无冲突，`sequence` 连续单调；
  3. `session_messages` 表经 `save_session_body_versioned` 写入后，读取回放的 JSON 字段能够完美无损还原。

### 5.3 端到端物理真实链路验收测试（真实 Host + SQLite + Provider 网关）
- **测试载体**：新建全链路集成测试 `crates/session-loop/tests/e2e_stop_and_reenter_test.rs`；
- **真实链路执行步骤**：
  1. 启动真实的 `AgentSessionLoop`，配置模拟的长耗时工具（`mock_long_running_tool`，耗时 5000ms）；
  2. 用户发起发问，循环进入 `executing_tools` 状态并正在执行批次；
  3. 异步后台任务向 `ControlBus` 发送 `request_force_cancel` 并触发 `abort_signal.abort()`；
  4. 断言：工具批次在 50ms 内快速退出，未执行项被标记为 cancelled；
  5. 断言：数据库 `events` 表写入了全量事件，包含 `RunTerminal(Cancelled)`；
  6. 断言：数据库 `session_messages` 表物化落盘；
  7. **再入测试**：调用 `hydrate_history` 重构上下文，再注入新用户问题，调用 `build_anthropic_request_body`；
  8. **严苛校验**：序列化产物直接送入 Anthropic Messages API Schema 校验器，断言无孤儿 `tool_use`、角色严格交替、无任何格式错误。

### 5.4 混沌工程与异常断电注入测试
- **测试载体**：`crates/session-loop/tests/orphan_self_heal_test.rs`；
- **执行步骤**：
  1. 手工构造破损的 SQLite 数据库，故意置入只有 `ToolCall` 没有 `ToolResult` 的半截 assistant 消息；
  2. 模拟应用崩溃后冷启动，执行读取与发问；
  3. 断言水合与序列化守门机制生效，自愈补齐 `tool_result`；
  4. 断言上游 Provider 序列化成功且请求成功返回，系统自愈率达成 100%。
