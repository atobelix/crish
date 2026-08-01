# 03 · 前端事件协议与 IPC 边界契约（Rust 核心进程内重写）

> 目标：Rust 核心直接运行在 Tauri 进程内，前端（apps/crish-desktop）改用 Tauri IPC（invoke + event emit）直连，
> 删除 WS daemon 链路。前端 UI 层保留，事件协议结构尽量对齐，让前端改动最小。
> 本文档为只读研究产出，依据均以 `文件路径:行号` 标注。证据基准：2026-07 当前代码。

## 0. 结论摘要

1. **前端可整体保留的模块**：`EventRouter.ts`（事件→回调/状态迁移）、`approvalFlowMachine.ts`（审批状态机）、
   `StreamState`/`finish` 收口逻辑（`ConnectionLifecycle.ts:111-154`）、`StreamRenderBuffer.ts`（渲染帧控制）、
   `sessionEventHydrate.ts`（会话水合，仅传输层换 invoke）、`chatApi.ts`（产品入口）。
2. **必须删除的 WS 专属层**：`daemonClient.ts`（心跳/重连/request-response 配对/广播）、
   `StreamRecovery.ts`（snapshot+read-run-events 重放/背压 pause-resume/stall 扫描）、
   `daemonEventZod.ts` + `daemonEventSchema.ts`（协议校验层）、`directFetchBridge.ts`（降级 SSE）、
   `ConnectionManager.ts` 的心跳 metrics 部分、`bootstrap-services.ts:84-89` 的流恢复钩子。
3. **事件 JSON 结构必须保持的硬依赖**：顶层 `type`、`runId`、`sequence`、`message-delta.block.text`、
   `message-end.message`（含 `clientMessageId` 稳定 id）、`tool-start.call.id/name`、`tool-end.result.id/output/isError`、
   `approval-requested.request.toolCallId/toolName/parameters`、`approval-resolved.decision`、
   `run-terminal.terminal/error`、`agent-end.reason/error`、`error` 信封、subagent-* 事件字段。
4. **IPC 事件通道**：沿用 `workbench-run-event` emit 模式（apps/agent-workbench/src-tauri/src/sidecar/connection/lifecycle.rs:287-303），
   前端把 `client.onMessage` 换成 `listen('workbench-run-event')`，回调原样进 `router.onMsg`（EventRouter.ts:535）。
5. **run 终态判定（四源合一 finish）**：`run-terminal(failed)` / `runtime-error` / `agent-end(reason=error)` /
   `error` 信封，统一收敛到 `surfaceStreamFailure` + `finish()`（详见第二章）；`runtime-error` 单独不触发 finish，
   Rust 侧在 runtime-error 后**必须**继续发 terminal 事件，否则前端靠 8s endTimer 兜底（EventRouter.ts:528-531）。

---

## 一、AgentEvent 全量清单表

类型定义唯一真源：`packages/shared-types/src/events.ts`（`AgentEvent` 联合 = 6 个域事件联合，events.ts:5-41）。

### 1.1 Agent 域

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `agent-start` | events.ts:6 | sessionId, timestamp | 无 | EventRouter 无分支，静默忽略 |
| `agent-end` | events.ts:7 | sessionId, timestamp, reason(`stop`\|`max-turns`\|`aborted`\|`error`), error? | EventRouter.ts:497-532 | `reason=error`→surfaceStreamFailure('agent-end-error')+`finish(true)`(503-511)；`stop/aborted/max-turns`→`clear_all`+`finish(false)`(515-523)；`sawRunTerminal`→`finish(false)`(524-527)；否则 8s endTimer 兜底 `finish(false)`(528-531)；有 pending 审批→`defer_terminal`(497-501) |

### 1.2 Turn 域

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `turn-start` | events.ts:10 | sessionId, turnIndex, timestamp | 无 | 未消费 |
| `turn-end` | events.ts:11 | sessionId, turnIndex, timestamp, toolCallCount | 无 | 未消费 |

### 1.3 Message 域（前端强依赖，字段必须原样）

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `message-start` | events.ts:14 | sessionId, message(AgentMessage) | 无（hydrate 投影以 message-end 为准） | 未单独消费 |
| `message-delta` | events.ts:15 | sessionId, timestamp, **messageId**, **block**(AgentMessageBlock) | EventRouter.ts:218-259；sessionEventHydrate.ts:292-311 | `block.text`→`onChunk` 增量；`block.type/kind==='thought'`→`onThought`（EventRouter.ts:230-237）；`event.message.content` 全量替换路径（EventRouter.ts:240-250）；hydrate 时按 text/thought 段追加（sessionEventHydrate.ts:298-309） |
| `message-end` | events.ts:16 | sessionId, message(AgentMessage) | EventRouter.ts:261-306；sessionEventHydrate.ts:240-290 | 读 `message.role==='assistant'`、`message.blocks[]`（text/thought 段）、`message.content` 兜底；合并正文 `mergeAssistantTextPiece`（EventRouter.ts:295-302）；hydrate 用稳定 id（`clientMessageId`/`messageId`/`id` 三选一，sessionEventHydrate.ts:93-101）做 upsert 与 rekey（sessionEventHydrate.ts:107-119） |

### 1.4 Tool 域（前端强依赖）

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `tool-start` | events.ts:19 | sessionId, batchId, **call**(ToolBatchCall), timestamp | EventRouter.ts:308-316；sessionEventHydrate.ts:313-338 | `call.id/toolName` + args（别名 `arguments/args/parameters/input`，toolUtils.ts:12-46）+ explanation → `onToolStart`；approvalFlow `tool_start`（EventRouter.ts:312） |
| `tool-update` | events.ts:20 | sessionId, batchId, toolCallId, update(ToolProgressUpdate), timestamp | 预留：partialToolArgs.ts:122-135（`update.metadata.kind==='tool-args-delta'` 增量参数流，当前仅测试引用） | 普通进度未接入；若 Rust 实现增量参数需对齐 `toolCallId + update.text + update.metadata.kind/argumentsText/toolName`（partialToolArgs.ts:115） |
| `tool-end` | events.ts:21 | sessionId, batchId, **result**(ToolBatchResult), timestamp | EventRouter.ts:321-331；sessionEventHydrate.ts:343-353 | `result.id/toolCallId` + `output`/`text` + `isError`/`error` + `path`/`filePath` + `diffs`（toolUtils.ts:48-106）→ `onToolSuccess`/`onToolError`；approvalFlow `tool_end` + `tryResumeFinish()`（EventRouter.ts:326-329）；hydrate 回写 toolCalls 状态（sessionEventHydrate.ts:343-353） |
| `tool-batch-start` | events.ts:22 | sessionId, batchId, timestamp, summary, calls[] | EventRouter.ts:317-319 | 显式 ignore |
| `tool-batch-end` | events.ts:23 | sessionId, batchId, timestamp, calls[] | EventRouter.ts:333-335 | 显式 ignore |
| `tool-input-repaired` | events.ts:24 | sessionId, timestamp, toolCallId, toolName, notes[] | 无 | 未消费 |

### 1.5 审批域（前端强依赖）

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `approval-requested` | events.ts:35 | sessionId, **request**(PermissionRequest), timestamp | EventRouter.ts:337-438；daemonEventZod.ts:164-199 | `request.toolCallId`+`request.toolName` 必填，`parameters`/`input` 参数包，`summary`/`reason`/`message` 说明（EventRouter.ts:349-380）；白名单自动放行→直接 `approve-tool`（EventRouter.ts:392-419）；否则 approvalFlow `approval_pending` + `onToolPendingApproval`（EventRouter.ts:422-436）；plan 模式→`onToolStart`（EventRouter.ts:386-390） |
| `approval-resolved` | events.ts:36 | sessionId, requestId, decision(PermissionDecision), timestamp | EventRouter.ts:440-443 → applyApprovalResolved（EventRouter.ts:162-191）；daemonEventZod.ts:207-241 | `toolCallId`（兼容 `requestId`/`id`，daemonEventZod.ts:210-212）+ `decision` 字符串 `approved\|denied\|expired` 或 `{behavior: allow\|deny\|ask}`（daemonEventZod.ts:220-231）→ approvalFlow `approval_resolved` + `onApprovalResolved`；denied 且 deferred 终态→`finish(false)`（EventRouter.ts:182-190） |

### 1.6 诊断 / 压缩 / 检查点域

| 事件名 | 定义 | 关键字段 | 前端消费点 | 消费行为 |
|---|---|---|---|---|
| `runtime-error` | events.ts:32 | sessionId, timestamp, error, retryable? | EventRouter.ts:488-491 → onRuntimeError（EventRouter.ts:193-195） | surfaceStreamFailure('runtime-error')（BridgeErrorPolicy.ts:14-41）；**不直接 finish**，等 terminal 收口 |
| `provider-diagnostic` | events.ts:31 | sessionId, timestamp, diagnostic | EventRouter.ts:492-495 | 仅 logInternalError |
| `run-terminal` | events.ts:39 | sessionId, **runId**, timestamp, terminal(`completed`\|`cancelled`\|`failed`), error? | EventRouter.ts:445-486（含 `run-completed`/`run-failed`/`run-cancelled` 别名）；daemonEventZod.ts:246-264 | terminal 判定 + 失败 surface + approvalFlow `run_terminal_seen`/`defer_terminal`/`clear_all` + `finish(failed)`（详见第二章） |
| `context-compression-start` | events.ts:27 | sessionId, timestamp, reason, tokensBefore | 无 | 未消费 |
| `context-compression-end` | events.ts:28 | sessionId, timestamp, result?, aborted, error? | 无 | 未消费 |
| `runtime-steering` | events.ts:33 | sessionId, timestamp, reason, message | 无 | 未消费 |
| `runtime-intervention-required` | events.ts:34 | sessionId, timestamp, reason, choices[], message | 无 | 未消费 |
| `checkpoint-created` | events.ts:37 | sessionId, timestamp, checkpoint | 无 | 未消费 |
| `checkpoint-restored` | events.ts:38 | sessionId, timestamp, restore | 无 | 未消费 |

### 1.7 信封级事件（WS 广播层，非 AgentEvent 类型但 EventRouter.onMsg 消费）

| 事件名 | 前端消费点 | 关键字段与行为 |
|---|---|---|
| `event`（信封，内层为 AgentEvent 或 orchestrator 事件） | EventRouter.ts:613-624 | 解包 `event.event`/`event.kind` 内层 type，转 `handleAgentEvent`（EventRouter.ts:622） |
| `error`（信封） | EventRouter.ts:601-611 | `message`/`error` → surfaceStreamFailure('daemon-error') + `clear_all` + **`finish(true)`**（EventRouter.ts:609） |
| `run-ended`/`run-failed`/`run-cancelled`/`run-completed`（信封） | EventRouter.ts:626-645 | `run-failed` → surfaceStreamFailure('run-ended-failed')；`run_terminal_seen`+`clear_all`；`finish(type==='run-failed')`（EventRouter.ts:643） |
| `subagent-started` | EventRouter.ts:559-571 | `subagentId`/`subagentRunId`/`runId`/`parentToolCallId`/`description`/`mode` → `onSubagentStarted` |
| `subagent-event` | EventRouter.ts:572-583 | `subagentId`/`subagentRunId`/`event` → `onSubagentEvent` |
| `subagent-ended` | EventRouter.ts:584-599 | `subagentId`/`subagentRunId`/`status`(completed\|failed\|stopped 由 `cancel/stop/abort/fail/error` 正则判定)/`summary` → `onSubagentEnded` |
| `approval-requested` / `approval-resolved`（信封） | EventRouter.ts:647-654 | 转 handleAgentEvent / applyApprovalResolved |
| `pong` | daemonClient.ts:514-531 | WS 心跳专用，不广播给业务监听器（daemonClient.ts:123-127 注释）——IPC 模式删除 |

### 1.8 会话水合消费（read-session-events 投影，非广播路径）

`projectEventsToMessages`（sessionEventHydrate.ts:163-379）消费 `message-end`（240-290）、`message-delta`（292-311）、
`tool-start`（313-338）、`tool-end`（343-353），并按 `sequence` 取 maxSequence（221）、按 `runId` 取 lastRunId（222-224）。
`read-session-events` 请求在 sessionEventHydrate.ts:393-401。

---
## 二、前端 run 生命周期状态机（事件驱动）

### 2.1 状态定义

UI 渲染层状态 `StreamState`（streamState.ts:10-24）：`cancelled` / `finished` / `assistantText` / `assistantThought` /
`unsub`（WS 退订句柄，IPC 模式改为 listen 退订）/ `endTimer`（8s agent-end 兜底）/ `transportAbort`（directFetch 专用，可删）。

审批流状态 `ApprovalFlowMachine`（approvalFlowMachine.ts:17-51）：`pending`（待批工具集）、`inflight`（执行中工具集）、
`deferredTerminal`（终态被审批阻塞挂起）、`sawRunTerminal`（已见 run 终态）、`flowStatus`（idle/pending/inflight/pending_inflight/deferred/disconnected/timed_out/reconnecting/recovered）。

`shouldBlockTerminal()` = pending 非空 || inflight 非空 || flowStatus ∈ {timed_out, disconnected, reconnecting}（approvalFlowMachine.ts:107-116）。

### 2.2 事件驱动流程

```
streamViaDaemon (ConnectionLifecycle.ts:413-542)
  ├─ registerStream + onRunMeta({runId})                       (443, 448)
  ├─ createStreamSession → client.send({type:'run-task',...})  (378-403)   [streaming]
  ├─ client.onMessage → router.onMsg(msg)                      (508 / 535) ← IPC 模式替换为 listen('workbench-run-event')
  │
  │ 每类事件分支（EventRouter.handleAgentEvent 201-533 / onMsg 535-655）：
  │  ├─ message-delta / text-delta  → assistantText/Thought 累积 + onChunk/onThought   (218-259)
  │  ├─ message-end                 → 正文/思考终态合并 onChunk/onThought               (261-306)
  │  ├─ tool-start                  → approvalFlow.tool_start + onToolStart            (308-316)
  │  ├─ tool-end                    → approvalFlow.tool_end + tryResumeFinish          (321-331)
  │  ├─ approval-requested          → 白名单直发 approve-tool / approval_pending + onToolPendingApproval (337-438)
  │  ├─ approval-resolved           → approvalFlow.approval_resolved + onApprovalResolved (162-191, 440-443)
  │  ├─ run-terminal(+别名)         → terminal 收口（见 2.3）                          (445-486)
  │  ├─ runtime-error               → surfaceStreamFailure（不 finish）                (488-491)
  │  ├─ agent-end                   → 终态收口（见 2.4）                               (497-532)
  │  ├─ error 信封                  → surfaceStreamFailure + finish(true)             (601-611)
  │  ├─ run-ended 信封组            → finish(run-failed)                              (626-645)
  │  └─ subagent-*                  → onSubagentStarted/Event/Ended                    (559-599)
  │
  └─ finish() / tryResumeFinish()  → cleanup() + onComplete()（ConnectionLifecycle.ts:111-154）
```

### 2.3 finish() 收口控制器（ConnectionLifecycle.ts:111-154）

`finish(force=false)`：
1. 幂等：`state.finished` 直接返回（119）。
2. 非 force 且未 cancelled：`approvalFlow.hasPending()` → `defer_terminal` 挂起，return（121-124）；
   否则 `hasInflight()` → `defer_terminal` + 120s 超时后 `finish(true)`（125-130，超时默认 120000ms，可经 `options.finishTimeoutMs` 覆盖，487）。
3. `isDeferredTerminal()` → `force_finish`（132-134）。
4. `state.finished = true` → `cleanup()`（退订 + 清 endTimer，streamState.ts:26-35）→ `callbacks.onComplete()`（135-141）。

`tryResumeFinish()`（144-151）：`deferredTerminal && sawRunTerminal && !shouldBlockTerminal()` → `finish(false)`。
触发点：tool-end（EventRouter.ts:329）、approval-resolved（EventRouter.ts:188-190）。

### 2.4 四源失败判定（全部收敛到 surfaceStreamFailure + finish）

| # | 失败源 | 判定位置 | 行为 |
|---|---|---|---|
| 1 | `run-terminal(terminal=failed)` / `run-failed` / `run-cancelled`(failed 且非 cancel) | EventRouter.ts:445-486 | terminal 归一（daemonEventZod.ts:246-264）；failed 且非 run-cancelled → surfaceStreamFailure（scope 'run-failed'/'run-terminal-failed'，470-475）；`run_terminal_seen`；有 pending 且未失败 → `defer_terminal`（478-481）；`clear_all` + `finish(failed && type!=='run-cancelled')`（482-484）。L3 run-cancelled 保留部分正文、不 toast（465-466 注释） |
| 2 | `runtime-error` | EventRouter.ts:488-491 → onRuntimeError（193-195） | 仅 surfaceStreamFailure('runtime-error')（BridgeErrorPolicy.ts:14-41 / streamState.ts:37-64）。**不直接 finish**——Rust 侧必须继续发 run-terminal/agent-end，否则 8s endTimer 兜底（528-531） |
| 3 | `agent-end` reason=error | EventRouter.ts:503-511 | surfaceStreamFailure('agent-end-error') + **`finish(true)`**（510） |
| 4 | `error` 信封 | EventRouter.ts:601-611 | surfaceStreamFailure('daemon-error') + `clear_all` + **`finish(true)`**（609） |

补充收口源（非失败四源，但同样触发 finish）：
- 信封 `run-ended/run-failed/run-cancelled/run-completed`：`finish(type==='run-failed')`（EventRouter.ts:626-645）。
- `agent-end` reason ∈ {stop, aborted, max-turns}：`clear_all` + `finish(false)`（515-523）。
- `agent-end` 且 `sawRunTerminal`：`finish(false)`（524-527）。
- `agent-end` 其他：8s endTimer → `finish(false)`（528-531）。
- `approval-resolved` denied 且 `isDeferredTerminal()` 且无 pending：`finish(false)`（182-190）。

### 2.5 Cancel 路径（ConnectionLifecycle.ts:166-220）

`createStreamCancel`：`state.cancelled=true` → `clear_all`+`force_finish` → 本地 transportAbort（directFetch，删）→ `cleanup()` →
经 `compositionRoot.runControl.dispatch` 发 L2/L3（200-207，runControlClient.ts:143-181）→ `state.finished=true` → `onComplete()`（209-218）。
L2/L3 双线发送：`run-control` + `cancel-run.mode`（runControlClient.ts:92 TRANSITIONAL_DUAL_CANCEL_RUN_WIRE=true，109-134）。

---

## 三、IPC 边界设计

### 3.1 事件 emit 通道（对齐现有 workbench-run-event 模式）

现有 Rust 转发模式（sidecar/connection/lifecycle.rs:284-305）：读 daemon WS 消息 → 按 type 分发——
`error`/`event`/其他 → `app.emit("workbench-run-event", &event)`（287-303）；`approval-requested`/`approval-resolved`
额外发 `workbench-approval-requested`/`workbench-approval-resolved`（294-299）；`pong` 丢弃（301）。
run_stream.rs:167/259 在重放/诊断时也发 `workbench-run-event`。

**IPC 模式设计**：
- **单一事件通道**：`workbench-run-event`（通道名可沿用），Rust 核心在每次事件产生时 `app.emit("workbench-run-event", event)`，
  载荷为**完整事件 JSON**（与 daemon WS 广播同构：顶层 `{ type, runId, sessionId, ...事件字段 }`），不做二次包装。
- approval 专属通道 `workbench-approval-requested`/`workbench-approval-resolved`：crish-desktop 未消费（grep 无前端 listen），可删。
- **前端替换点**：`client.onMessage((msg) => router.onMsg(msg))`（ConnectionLifecycle.ts:268、508）
  → `listen('workbench-run-event', (e) => router.onMsg(e.payload))`。EventRouter.onMsg 形状不变（EventRouter.ts:535-655），
  事件过滤 `messageBelongsToRun(msg.runId, this.runId)`（eventUtils.ts:17-26）继续生效。
- **有序性**：Tauri emit → JS listen 与 WS 同为单连接有序；`sequence` 字段保留用于幂等/潜在重放。
- run-task 的**回执**：前端本地生成 runId（ConnectionLifecycle.ts:435）并经 run-task 下发，Rust 侧以请求携带的 runId 为准回发事件
  （与现有 `workbench_run_task_stream` 返回 `{runId, sessionId}` 一致，run_commands.rs:39-43）——前端 runId 自管逻辑零改动。

### 3.2 Rust 侧需暴露的 command 清单

原 WS 请求（daemonClient.request/send）全部转为 Tauri invoke。参数名沿用现有 WS 消息字段（camelCase）。

**A. 运行生命周期（核心四类）**

| 新 command（建议名） | 替代 WS 消息 | 参数（来自前端调用点） | 返回 | 前端调用点 |
|---|---|---|---|---|
| `core_run_task` | `run-task` | runId, prompt, sessionId, permissionMode, cwd, mcpDisabledTools, budgetDifficulty, thinkingIntensity, content, hasImages, attachments, mode(goal), visibleGoal, maxRounds, maxStalledRounds, systemPrompt, clientMessageId, assistantClientMessageId | `{ runId, sessionId }` | ConnectionLifecycle.ts:378-403（现有 Tauri 版 workbench_run_task_stream 参数契约：commands.rs:5-21） |
| `core_run_control` | `run-control`（L0-L3） | level(`continue`\|`soft_inject`\|`cooperative_stop`\|`force_cancel`), runId, sessionId, reason, payload | void | runControlClient.ts:58-73, 143-181（L1 follow_up/soft_inject/steer 经 payload.kind，runControlClient.ts:215-260） |
| `core_cancel_run` | `cancel-run`（过渡双线） | runId, mode(cooperative\|force) | `{ok, runId, pid?}` | runControlClient.ts:76-85, 109-134；现有 Tauri 版 workbench_cancel_run（run_commands.rs:47-107）。IPC 模式下 L2/L3 建议只走 `core_run_control`，双线 flag 关闭（runControlClient.ts:92） |
| `core_approve_tool` | `approve-tool` | toolCallId, scope | `{ok, toolCallId, decision:'approved'}` | ApprovalHandler.ts:41-51；EventRouter.ts:401-402（白名单自动放行）；现有 Tauri 版 workbench_approve_tool（run_commands.rs:110-134） |
| `core_deny_tool` | `deny-tool` | toolCallId | `{ok, toolCallId, decision:'denied'}` | ApprovalHandler.ts:54-57；现有 Tauri 版 workbench_deny_tool（run_commands.rs:137-157） |

**B. 查询类（原 WS request，改为 invoke）**

| 新 command | 替代 WS 消息 | 参数 | 前端调用点 |
|---|---|---|---|
| `core_get_status` | `get-status` → 'status-response' | — | ConnectionLifecycle.ts:96（ensureDaemonConnected）；现有 workbench_status / workbench_connection_status（main.rs:27-29） |
| `core_get_run_snapshot` | `get-run-snapshot` → 'run-snapshot' | runId, sessionId | StreamRecovery.ts:391-395；sessionEventHydrate.ts:459-463（usage 拉取）；现有 workbench_get_run_snapshot（main.rs:38） |
| `core_read_run_events` | `read-run-events` → 'run-events' | runId, sessionId, afterSequence | StreamRecovery.ts:427-436（仅保留 reload/HMR 恢复场景）；现有 workbench_read_run_events（main.rs:37） |
| `core_read_session_events` | `read-session-events` → 'session-events' | sessionId, afterSequence, maxEvents | sessionEventHydrate.ts:393-401（会话水合必需，保留）；现有 workbench_read_session_events（main.rs:36） |

**C. 杂项 RPC（原 WS request 换 invoke，命令名沿用 WS type 即可）**

| WS type | 前端调用点 |
|---|---|
| list-workflows / create-workflow / delete-workflow | clientApi.ts:844-895 |
| list-mcp-servers / start-mcp-server / stop-mcp-server | clientApi.ts:899-959 |
| 其余（get-settings、git、engine status/config、modelCatalog、rules、skills、subagent、sessionDaemonSync、conversationRewind、schedule、SessionSyncService 等 95 处 getDesktopDaemonClient 调用点） | 见 grep 结果：clientApi.ts:846-959、engineStatus.ts:43、engineConfig.ts:498/554、gitApi.ts:454/524、mcpApi.ts:180-468、modelCatalog.ts:703/840、rulesApi.ts:35/46、skillsApi.ts:540、subagentApi.ts:26/51、sessionDaemonSync.ts:252、conversationRewindApi.ts:39/72、schedule.ts:24-62、SessionSyncService.ts:175/649、workflowRunner.ts:26 |

统一经 `tauriInvoke.ts` 的 `invokeTyped`/`invokeCmdStrict`（tauriInvoke.ts:160-216）适配，Rust 侧错误协议用 CoreError
`{kind, detail}`（tauriInvoke.ts:26-38 已对齐）。

### 3.3 前端 daemonClient.ts 职责替换表

| 职责 | 现状位置 | IPC 模式处置 |
|---|---|---|
| WS URL 解析（product/browser 分支） | daemonClient.ts:59-102 | **删**（核心进程内，无 URL） |
| 连接状态机 DaemonConnState | daemonClient.ts:13-18, 678-687 | **替换**为「核心已初始化」布尔（UI 依赖点：SettingsProfileTab.tsx:190 `isConnected()`、useDaemonState.ts:124） |
| 心跳 ping/pong（8s 间隔、3 次容错、延迟测量） | daemonClient.ts:33-39, 593-649；pong dispatch 514-531 | **删**（进程内无断连；Rust 侧 lifecycle.rs:238-250 的 30s ping 也删） |
| 重连（指数退避 + jitter + sidecar 重启） | daemonClient.ts:42-43, 357-422, 557-591 | **删** |
| request/response 配对（requestId + expected type + 超时） | daemonClient.ts:20-26, 301-337, 533-546 | **替换**为 invoke（tauriInvoke.ts:127-216） |
| fire-and-forget send | daemonClient.ts:339-348 | **替换**为 invoke 命令（run-control/approve/deny） |
| 广播 dispatch（listeners 集合） | daemonClient.ts:205-208, 548-554 | **替换**为 `listen('workbench-run-event')` |
| waitUntilConnected | daemonClient.ts:267-289 | **替换**为 `core_get_status` 轮询或初始化完成事件 |
| stream-pause / stream-resume 发送 | daemonClient.ts:735-748 | **删**（背压内移到 Rust 侧事件通道缓冲） |
| onHeartbeat metrics 镜像 | daemonClient.ts:128, 220-233；ConnectionManager.ts:128-151 | **删** |

---
## 四、可删除清单（WS 专属）

### 4.1 前端文件级

| 文件 | 删除内容 | 保留部分 |
|---|---|---|
| `apps/crish-desktop/src/api/daemonClient.ts` | 整文件（心跳/重连/配对/广播/URL/stream-pause-resume，详见 3.3） | 无（或仅留一个 `getCoreStatus()` 薄适配） |
| `apps/crish-desktop/src/api/daemonEventZod.ts` | 整文件（zod 校验层：信封/工具调用/审批/terminal 五组 parser，daemonEventZod.ts:92-300） | 无。IPC 载荷来自可信 Rust 侧，TS 类型（shared-types）即契约。**前提**：Rust 侧输出规范序列化（见第五章） |
| `apps/crish-desktop/src/api/daemonEventSchema.ts` | 整文件（轻量 parser 层：parseDaemonEnvelope/parseToolCallFields/extractApprovalCommandArgs，daemonEventSchema.ts:48-165） | 无（同上）。`extractApprovalCommandArgs` 的「parameters/input 包 → command 行」逻辑若审批卡仍需，应移到 Rust 侧归一为 `parameters.command` |
| `apps/crish-desktop/src/services/StreamRecovery.ts` | `recoverStream`/`recoverAllStreams`（snapshot + read-run-events 两步重放，378-522）、背压 `noteRenderBuffer`/pause/resume（560-594）、stall 扫描（355-364, 661-687）、registerStream/updateHeartbeat/markCompleted/markFailed（248-351）、`orchestratorEventToAgentEvent`（128-158） | 若保留 reload/HMR 恢复：仅留 `extractEventSequence`（108-115）、`ReplayPayload`（85-92）、`suffixDelta`（229-235）；否则整文件删。调用点连带删：bootstrap-services.ts:84-89（daemon ready → recoverAllStreams）、useStreamCallbacks.ts:181/428（noteRenderBuffer） |
| `apps/crish-desktop/src/api/directFetchBridge.ts` | 整文件（降级 HTTP SSE，directFetchBridge.ts:1-316） | 无。连带：`ALLOW_AUTO_DIRECT_FETCH_FALLBACK`（ConnectionLifecycle.ts:61）、createStreamSession 降级分支（ConnectionLifecycle.ts:238-266）、`state.transportAbort`（streamState.ts:23）、`recordTransportDegradedDirectFetch`（ConnectionLifecycle.ts:255） |
| `apps/crish-desktop/src/services/ConnectionManager.ts` | heartbeat/metrics 镜像部分（128-151, 220 起）、latency 平滑（123）、pong 订阅 | 连接状态投影可简化保留（`phase` 由「核心已初始化」驱动） |
| `apps/crish-desktop/src/api/daemon-chat-bridge/ConnectionLifecycle.ts` | ensureDaemonConnected 的 waitUntilConnected 分支（88-96）、directFetch 分支（238-266）、`workbench_daemon_endpoint` 依赖 | 核心保留：createFinishController（111-154）、createStreamCancel（166-220）、streamViaDaemon（413-542）、run-task 参数组装（359-403） |
| `apps/crish-desktop/src/api/daemon-chat-bridge/handlers/eventType.ts` | zod + 轻量双解析路径（eventType.ts:11-22） | 简化为「读顶层 type 字符串」（eventType.ts:23-27 兜底已够） |

### 4.2 前端模块级（函数/分支）

- `daemonClient.ts` 的 `fetchShellEndpoint`/`resolveWsUrl`（59-102）及其依赖的 Tauri 命令 `workbench_daemon_endpoint`（main.rs:28）。
- `productMode.ts` 的 isTauriShell/isProductShell 分支在 daemonClient 中的用途（daemonClient.ts:352-356, 394-422）。
- `runControlClient.ts` 的 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` 双线（92）与 `buildCancelRunWireMessage`（76-85）：IPC 模式仅走 `core_run_control`。
- `sessionEventHydrate.ts` 的 WS 传输（fetchSessionEvents 382-412 内 client.request）→ 换 invoke，函数签名与返回结构不变。
- `AppBootstrap.ts:149` / `useEngineBootstrap.ts:11` / `bootstrap-services.ts:80-89` 的 daemon 启动/恢复钩子。

### 4.3 Rust 侧连带删除（agent-workbench）

| 模块 | 内容 | 位置 |
|---|---|---|
| `sidecar/` 整层 | supervisor（sidecar 状态机）、pending（请求-响应配对表）、run_stream（重放 + daemon-diagnostic）、connection 重连/心跳 | sidecar/connection/lifecycle.rs:27-169（重连循环）、238-250（30s ping）、query.rs:62-355（send_sidecar_query/command 配对）、run_stream.rs:174-330（重放） |
| sidecar 命令转发层 | workbench_* 转发到 WS 的模式 | sidecar/commands/run_commands.rs:10-295、mod.rs:124-178 |
| 启动链路 | ensure_sidecar_connected / 进程拉起 / 握手协议版本校验 | lifecycle.rs:323-604、daemon_discovery.rs、host_paths.rs 中 daemon 部分 |
| 命令 | workbench_daemon_endpoint / workbench_restart_daemon / workbench_stop_daemon | main.rs:28-31；daemonClient.ts:59-69, 394-422 |

**保留原则**：main.rs 的 `workbench_*` 前缀注册模式（main.rs:24-154）保留，但实现从「WS 转发」改为「进程内核心直调」；
`workbench_run_task_stream` 等命令签名（commands.rs:5-21）可直接复用。

---

## 五、序列化兼容要求

### 5.1 必须原样保持的事件结构（前端强依赖，含证据）

| # | 结构/字段 | 前端依赖点（路径:行号） | 说明 |
|---|---|---|---|
| 1 | 顶层 `type` 字符串 | eventType.ts:8-28；EventRouter.ts:206-216 | 信封解析的第一键；别名 `event`/`kind` 仅 zod 兼容层用，Rust 输出标准 `type` |
| 2 | `runId`（每个事件顶层或 `event`/`payload` 嵌套） | eventUtils.ts:17-26（messageBelongsToRun 过滤）；StreamRecovery.ts:150-155（run-terminal 映射补 runId）；run_stream.rs:87-93（Rust 侧 event_run_id 三处取值）；sessionEventHydrate.ts:222-224 | **runId 缺失时前端放行不过滤**（eventUtils.ts:21），但多 run 并发时过滤失效；Rust 侧 emit 前必须统一注入 |
| 3 | `sequence`/`eventSequence`/`seq`（数字） | StreamRecovery.ts:108-115（三字段兼容）；EventRouter.ts:49, 544-557（lastAppliedSequence 游标）；sessionEventHydrate.ts:221（maxSequence） | 重放去重与游标的唯一依据 |
| 4 | `message-delta.block.text` + `block.type/kind==='thought'` | EventRouter.ts:218-258；eventUtils.ts:1-7（blockText）；sessionEventHydrate.ts:292-311 | 增量正文/思考的唯一文本来源 |
| 5 | `message-delta.messageId` | shared-types events.ts:15；store 热路径按 messageId upsert（hooks/chat-stream/helpers.ts:55-90） | 与本地乐观消息对齐 |
| 6 | `message-end.message`：`role`、`content`、`blocks[]`（text/thought 段） | EventRouter.ts:261-306；sessionEventHydrate.ts:240-290 | 终态正文；`clientMessageId` 稳定 id 用于 rekey（sessionEventHydrate.ts:93-119；pickStableMessageId 三字段兼容） |
| 7 | `tool-start.call.id/toolName` + args 别名（arguments/args/parameters/input）+ explanation | toolUtils.ts:12-46；daemonEventSchema.ts:48-89；sessionEventHydrate.ts:313-338 | id/name 缺失即协议失败（daemonEventSchema.ts:54-55） |
| 8 | `tool-end.result`：`id`/`toolCallId`、`output`/`text`、`isError`/`error`、`path`/`filePath`、`diffs` | toolUtils.ts:48-106；daemonEventZod.ts:137-156；sessionEventHydrate.ts:343-353 | 无 id 的 tool-end 被丢弃（EventRouter.ts:324） |
| 9 | `approval-requested.request`：`toolCallId`、`toolName`、`parameters`\|`input` 包、`summary`\|`reason` | daemonEventZod.ts:164-199；EventRouter.ts:337-438；daemonEventSchema.ts:115-153 | 缺 toolCallId/toolName 记协议错误（daemonEventZod.ts:171-178） |
| 10 | `approval-resolved`：`toolCallId`（兼容 requestId/id）+ `decision`（'approved'\|'denied'\|'expired' 或 `{behavior:'allow'\|'deny'\|'ask'}`） | daemonEventZod.ts:207-241；EventRouter.ts:162-191 | 前端以 toolCallId 为审批流键；未知 decision 一律视为 deny（daemonEventZod.ts:232-233） |
| 11 | `run-terminal`：`terminal`（'completed'\|'cancelled'\|'failed'）+ `error` | daemonEventZod.ts:246-264；EventRouter.ts:445-486 | terminal 归一含 'error'/'canceled' 拼写变体（daemonEventZod.ts:251-256） |
| 12 | `agent-end`：`reason`（stop/max-turns/aborted/error）+ `error` | EventRouter.ts:497-532 | reason=error 是四源失败之一（503-511） |
| 13 | `error` 信封：`message`/`error` | EventRouter.ts:601-611 | 四源失败之一，直接 finish(true) |
| 14 | `event` 信封：`{type:'event', event:{内层 AgentEvent}}` | EventRouter.ts:613-624 | 若 Rust 直发内层事件，此分支可删（见 5.2-1） |
| 15 | subagent-*：subagentId/subagentRunId/runId/parentToolCallId/description/mode/status/summary | EventRouter.ts:559-599 | status 由 cancel/stop/abort/fail/error 正则判定（585-591） |
| 16 | `run-terminal` 的 `runId` 必须存在 | StreamRecovery.ts:150-155（run-completed→run-terminal 映射会回填 runId） | 终态事件无 runId 时前端过滤失效 |

### 5.2 可改的结构（含前端改动点）

| # | 可改项 | 前端改动点 |
|---|---|---|
| 1 | **去掉 orchestrator 外层包装**（`runtime-event`/`payload`/`event` 三层嵌套） | 删 `orchestratorEventToAgentEvent` 解包（StreamRecovery.ts:128-158）、`applyReplayEvents` 投影（EventRouter.ts:75-160）、EventRouter.ts:613-624 的 `event` 信封分支；`onMsg` 直进 `handleAgentEvent` |
| 2 | **终态别名收敛**：只发 `run-terminal`，不再发 `run-completed`/`run-failed`/`run-cancelled`/`run-ended` | 删 EventRouter.ts:626-645 信封分支；保留 445-486 的 run-terminal 主路径。注意 Rust 侧终态判据随之统一（原 is_terminal_run_event 依赖别名，run_stream.rs:95-113） |
| 3 | `approval-resolved` 统一为 `toolCallId`（shared-types events.ts:36 的 `requestId` 改可选） | 前端 zod 已兼容 `toolCallId ?? requestId ?? id`（daemonEventZod.ts:210-212），零改动；改 shared-types 类型声明即可 |
| 4 | `pong`/`ping` 协议 | 删 daemonClient.ts:514-531（pong dispatch）；Rust 侧删 lifecycle.rs:238-250（30s ping） |
| 5 | `stream-pause`/`stream-resume` 控制消息 | 删 daemonClient.ts:735-748、StreamRecovery.ts:560-594；背压内移到 Rust 事件通道（按 runId 缓冲/丢弃策略由 Rust 决定，前端不再感知） |
| 6 | `daemon-diagnostic` 事件（run_stream.rs:161-166） | 前端无消费分支；可删，或保留为诊断日志通道 |
| 7 | `sequence`/`afterSequence` 重放协议（get-run-snapshot + read-run-events） | 若 Rust 保证有序且无断连：删 StreamRecovery.ts:378-503、sessionEventHydrate 的 usage 拉取改直查（sessionEventHydrate.ts:459-463 保留但换 invoke）；若保留 reload/HMR 恢复：必须保持 `ReplayPayload` 结构（StreamRecovery.ts:85-92）与 `read-run-events` 返回 `{events, nextAfterSequence, hasMore}`（StreamRecovery.ts:438-443） |
| 8 | `timestamp`（ISO8601） | 前端仅 hydrate 时 `Date.parse`（sessionEventHydrate.ts:233-238），无强依赖；建议保留（跨端日志对齐） |
| 9 | 未消费事件（agent-start/turn-*/message-start/tool-batch-*/tool-input-repaired/context-compression-*/runtime-steering/runtime-intervention-required/checkpoint-*/provider-diagnostic） | 可保留透传（未来功能预留），或 Rust 裁剪。裁剪时注意 `provider-diagnostic` 前端有 logInternalError（EventRouter.ts:492-495） |

### 5.3 建议（Rust 侧实现要点）

1. **schema 唯一真源**：Rust 侧以 `packages/shared-types/src/events.ts` 的 `AgentEvent` 为 serde tagged enum 模板，
   emit 时输出 camelCase JSON，字段名与 5.1 表逐项对齐。
2. **统一注入 runId/sessionId**：核心在事件产生点统一填充（对齐 run_stream.rs:87-93 的 event_run_id 取值习惯），
   保证 `messageBelongsToRun` 过滤与 `streamRecovery`（若保留）的 session×run 键控可用。
3. **decision/terminal 归一**：Rust 只发规范值（approval-resolved 用 'approved'|'denied'|'expired'；
   run-terminal 用 'completed'|'cancelled'|'failed'；agent-end reason 用 stop|max-turns|aborted|error），
   前端 zod 层的拼写兼容分支（daemonEventZod.ts:224-230, 251-256）即可删。
4. **稳定消息 id**：`message-end` 的 `AgentMessage` 必须携带 `clientMessageId`（前端 hydrate rekey 依赖，
   sessionEventHydrate.ts:107-119；run-task 请求已下发 user/assistant clientMessageId，ConnectionLifecycle.ts:398-401）。
5. **错误协议**：invoke 错误统一 CoreError `{kind, detail}`（tauriInvoke.ts:26-38 已对齐），
   run 运行期错误走事件通道（四源失败），不混入 invoke 返回。
6. **事件通道缓冲**：背压内移后，Rust 侧按 runId 维护事件队列（替代 WS 流控），高水位时可丢弃
   `message-delta` 旧帧（前端以 message-end 全文兜底，EventRouter.ts:240-250），但不可丢 terminal/审批/工具事件。

---

*本文档由对 apps/crish-desktop 前端桥层与 apps/agent-workbench Tauri 壳的只读研究产出；
与 docs/rrust-rewrite/00-master-plan.md 配套。*
