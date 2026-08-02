# Tool Call 调用链追踪分析

## 1. 关键路径逐步骤映射

### Path A: 用户输入 → `handleSendChat` → Slash 解析 → 会话创建

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 1.1 用户触发发送 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` | L68 | `handleSendChat` 入口 |
| 1.2 Slash 命令解析 | 同上 | L89 | `resolveSlashCommand(rawInput)` |
| 1.3 导航 slash 短路 | 同上 | L91-111 | `/settings`, `/browser`, `/schedule` 等不进入 AI 流 |
| 1.4 会议草稿提交 | 同上 | L218-231 | `commitDraftIfNeeded()` 将草稿转为正式 session |
| 1.5 用户消息入队 | 同上 | L313-328 | 向 store 写入 `status: 'queued' | 'processing'` 的 user message |
| 1.6 启动流式请求 | 同上 | L346 | `runStreamingAssistant(input, userMsgId, sessionId, finalStreamOptions)` |

**保障机制**：无。`handleSendChat` 在调用 `runStreamingAssistant` 前检查 `isAiBusy`（L295），若 busy 则设 status=queued 后直接返回。

### Path B: `runStreamingAssistant` → WebSocket `run-task` → Daemon → Orchestrator

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 2.1 代际计数器递增 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | L141-L142 | `myGen = (generationMapRef.current.get(sid) ?? 0) + 1` |
| 2.2 旧流清理 | 同上 | L101-117 | 若 session 已有活跃流，取消旧流、刷新 batcher |
| 2.3 占位消息插入 | 同上 | L171-179 | 向 store 插入 assistant 占位 message |
| 2.4 WebSocket 流发起 | 同上 | L228 | `streamAssistantResponseApi(...)` |
| 2.5 路由至 daemon | `apps/crish-desktop/src/api/daemon-chat-bridge/streamViaDaemon.ts` | L235-355 | `streamViaDaemon()` 创建 `EventRouter`, 通过 WebSocket 发送 `run-task` |
| 2.6 daemon 接收 | `packages/agent-daemon/src/handlers/run-handlers.ts` | L192 | `handleRunTaskWithOrchestrator()` |
| 2.7 准入控制 | 同上 | L634-664 | `assertCanStartRun()` 检查 `maxConcurrentRuns` |
| 2.8 orchestrator 启动 | 同上 | L494-505 | `orchestrator.startRun()` / `startGoalRun()` |
| 2.9 Runtime 创建 | `packages/agent-daemon/src/server-runtime-factory/index.ts` | L165-176 | `createRuntimeOptions()` 组装 `AgentRuntimeOptions` |
| 2.10 Approval 注入 | 同上 | L172 | `approvalHandler: new DaemonApprovalHandler(approvalQueue, runId)` |
| 2.11 `run()` 调用 | `packages/agent-runtime/src/runtime.ts` | L108-176 | `AgentRuntime.run()` 创建 `AgentSessionLoop` 并委托 |

**保障机制**：
- **代际计数器**（`myGen` + `generationMapRef`）：`useStreamCallbacks.ts:L141-142` 保证同一个 session 的新一次 run 覆盖旧 run 的 `assertLive` 检查
- **`assertLive()` 双重检查**（L144-147）：检查 `runClosed` 标志 + 确认 `streamManagerRef` 中的条目仍是自己
- **准入控制**：`run-handlers.ts:L634-649` 限制全局最大并发 runs
- **Admission Lease**（L652-664）：run 级去重，同一 `runId` 不可二次进入

### Path C: `AgentSessionLoop.run()` → Session-loop → `ProviderCallCoordinator.callProvider()`

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 3.1 获取 session mutex | `packages/agent-runtime/src/session-loop/index.ts` | L93 | `this.sessionMutex.acquire()` |
| 3.2 用户消息入队 | 同上 | L96 | `this.inputQueue.enqueue(userMessage)` |
| 3.3 状态机主循环 | 同上 | L103-133 | `while (!this.machine.is('done'))` |
| 3.4 `awaiting-input` | 同上 | L146-153 | 从 `inputQueue` 出队消息 |
| 3.5 `streaming`(调用 provider) | 同上 | L194-252 | `this.providerCall.buildProviderCall(...)` |
| 3.6 Provider 流消费 | 同上 | L202-209 | `this.providerCall.providerConsumer.consume(...)` |
| 3.7 Delta 事件回显 | 同上 | L215-L225 | 通过 `deltaQueue` 逐步 yield AgentEvent |
| 3.8 工具调用提取 | 同上 | L246-247 | 提取 `ToolCallBlock[]` |
| 3.9 状态转移 | 同上 | L250 | `this.dispatch('HAS_TOOL_CALLS', { count })` → `executing-tools` |

**保障机制**：
- **`sessionMutex` (AsyncMutex)**：`session-loop/index.ts:L57` 保护整个 `run()` 方法，确保每个 session 同一时间只有一个 `run()` 在执行。这是**三个极端场景分析的核心防护**。
- **`deltaQueue` (RingBuffer)**：`L197` 防止 consumer 侧事件溢出
- **`abortController.signal`** 在各 handler 入口检查（L147, L156, L335 等）

AsyncMutex 实现位于 `packages/shared-utils/src/async-mutex.ts:L28-105`，FIFO 公平排队，支持 `AbortSignal` 取消排队中的 waiter。

### Path D: Provider 返回 `tool_calls` → `tool-execution.ts` → `ToolHook[] beforeExecute`

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 4.1 `executing-tools` 入口 | `session-loop/index.ts` | L334-356 | `handleExecutingTools()` |
| 4.2 提取 tool_calls | 同上 | L337-338 | 从最后一条 assistant message 提取 |
| 4.3 委托批量执行 | 同上 | L340 | `this.toolExec.executeToolBatch(toolCalls, ctx)` |
| 4.4 批量执行调度 | `session-loop/tool-execution.ts` | L54-68 | `executeToolBatch()` 对每个 tool call 调用 `executeSingleTool()` |
| 4.5 单工具执行 | 同上 | L70-153 | `executeSingleTool()` |
| 4.6 `ToolHook.beforeExecute` 链 | 同上 | L91-111 | 遍历 `ctx.hooks[]`，每个 hook 可阻断/修改/标记 pending_approval |
| 4.7 兼容层 `handleBeforeHook` | 同上 | L166-178 | 处理废弃的 `composedHooks.beforeToolCall` |
| 4.8 输入校验 | 同上 | L180-186 | `validateToolInput()` |
| 4.9 权限决议 | 同上 | L122-127 | `resolvePermission()` → 若 deny 则返回软拒绝 |
| 4.10 实际执行 | 同上 | L188-210 | `runToolExecution()` → `SingleToolExecutor` |

**保障机制**：
- **`ToolHook[]` 顺序执行**（L91-111）：每个 `beforeExecute` 串行等待结果
- **`modifiedInput` 传播**（L108-110、L117）：前一个 hook 的修改透传给后续 hook 和实际执行
- **`signal.aborted` 检查**（L129-134）：在权限决议之后、工具执行之前再次检查
- **`pending_approval` 分支**（L100-107）：走 `resolvePermission` 路径，不直接执行
- **`ToolExecutor` 批量调度**（`runtime-components/tool-executor.ts`）：按 concurrency 策略（`parallel`/`serial`）调度

### Path E: 审批流程 → `resolvePermission()` → `ApprovalPipeline.decide()`

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 5.1 `resolvePermission` | `session-loop/tool-execution.ts` | L245-254 | 构造 `PermissionRequest` 并委托 `approvalPipeline.decide()` |
| 5.2 `ApprovalPipeline.decide` | `packages/agent-runtime/src/approval/approval-pipeline.ts` | L29-77 | 策略决议 → 缓存检查 → handler 转发 |
| 5.3 `permissionPolicy.decide` | 同上 | L40 | `TrustZonePermissionPolicy.decide()` → T0/T2 allow, T1/T3 ask, T4 deny 等 |
| 5.4 意图级缓存检查 | 同上 | L51-55 | `ApprovalCache.get(intentKey)` → 30s TTL 缓存（`approval-cache.ts:L18`） |
| 5.5 委托 `approvalHandler` | 同上 | L57-63 | `DaemonApprovalHandler.requestApproval()` |
| 5.6 daemon 审批 handler | `packages/agent-daemon/src/daemon-approval-handler.ts` | L27-117 | 意图级 `runIntentAllowlist` + `alwaysIntentAllowlist` 缓存 |
| 5.7 审批队列排队 | `packages/agent-daemon/src/approval-queue.ts` | L107-142 | `waitForApproval()` → 设置定时器 + 返回 Promise |
| 5.8 超时自动 expire | 同上 | L275-286 | `expire()` → decision="expired" |
| 5.9 审批决议回传 | `daemon-approval-handler.ts` | L164-230 | `decisionFromResult()` → allow/deny + 写入 runIntentAllowlist(最多5min间隔内复用) |
| 5.10 用户在前端审批 | `apps/crish-desktop/src/api/chatApprovalUi.ts` | L85 | 查找 `pending_approval` tool calls |
| 5.11 审批 WebSocket 发送 | `apps/crish-desktop/src/api/daemon-chat-bridge/streamViaDaemon.ts` | L389-401 | `daemonApproveTool()` / `daemonDenyTool()` |

**保障机制**：
- **意图级缓存**：`daemon-approval-handler.ts:L18-20` 的 `runIntentAllowlist`（run 内复用）+ `alwaysIntentAllowlist`（进程级跨 run 复用）
- **ApprovalCache**（`approval-cache.ts:L12-80`）：30s TTL Map，`decide()` 环节 L51-55 使用
- **审批超时自动 deny**：`approval-queue.ts:L275-286` → setTimeout 自触发 `expire()` → `decision: "expired"`
- **`clearRun` 清理**：`approval-queue.ts:L244-254`：run 取消/失败/完成时清理 pending
- **`resolveApprovalTimeoutMs`**（`daemon-permission-policy.ts:L118-146`）：T3/T4 自动延长至 10min+
- **软拒绝文案**（`daemon-approval-handler.ts:L219-220`）：`"Approval timed out; operation skipped — retry later"` 不阻塞模型继续

**定时器防御**（`approval-queue.ts`）：
- `MIN_APPROVAL_TIMEOUT_MS = 100`（L4）：避免亚 100ms 定时器竞态
- `MAX_APPROVAL_TIMEOUT_MS = 1h`（L6）：避免配置错误永久挂起
- `normalizeTimeoutMs`（L368-376）：undefined → fallback; 0/Infinity → infinite (null); 否则 clamp

### Path F: 工具执行结果 → `onResult()` → Store 写回 → React Re-render

| 步骤 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 6.1 `runToolExecution` 结果 | `session-loop/tool-execution.ts` | L188-210 | `SingleToolExecutor.execute()` 完成 |
| 6.2 `handleExecResult` | 同上 | L212-231 | 调用 `contextManager.materializeOutput()` |
| 6.3 `ToolHook.onResult` 链 | 同上 | L138-150 | 遍历 `ctx.hooks` 的 `onResult` 回调 |
| 6.4 AgentEvent yield | 同上 | L226 | `tool-end` event → recorder → yield |
| 6.5 Daemon 事件循环 | `run-handlers.ts` | L522-590 | `for await (orchestratorEvent of handle.events)` |
| 6.6 WebSocket 推送 | 同上 | L589 | `this.sendRunEvent(eventSink, runId, orchestratorEvent, event)` |
| 6.7 EventRouter 接收 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | 全局 `onMsg` | 按 event type 分发 |
| 6.8 Tool result 回调 | 同上(handlers) | 见 `onToolSuccess`/`onToolError` | 由 EventRouter 解析后回调 |
| 6.9 Store 更新 | `useStreamCallbacks.ts` | L338-366 | `queueToolCallPatch()` → `toolBatcherRef.push()` → batcher flush → React 批更新 |
| 6.10 React re-render | - | - | `useLayoutStore.setState()` 触发订阅组件重渲染 |

**保障机制**：
- **代际计数器 + `assertLive()` 双重守卫**（`useStreamCallbacks.ts:L144-152`）：每个回调入口检查 `assertLive()` + `myGen !== generationMapRef.current.get(sid)`
- **Stream Batcher 合并**（`api/streamTextBatcher.ts:L333-338`）：`pending_approval` 和终态 status 立即 `flushNow()`；`running` 可合并
- **`runClosed` 标志**（L126）：`onComplete` 设置 runClosed=true 禁止后续回调写入
- **`finish` 控制器**（`streamViaDaemon.ts:L18-61`）：等待所有 inflight 审批完成后再 `onComplete`

---

## 2. 极端场景测试分析

### 场景 1: 连续 3 条消息发往同一 session（间隔 100ms）

**竞态窗口**：
```
t=0ms:  客户端 msg1 → handleSendChat → isAiBusy=false → runStreamingAssistant → WebSocket run-task
t=100ms: 客户端 msg2 → handleSendChat → isAiBusy=true → status=queued → 返回（不调用 runStreamingAssistant）
t=200ms: 客户端 msg3 → handleSendChat → isAiBusy=true → status=queued → 返回
```

**防护路径**：
1. `useSlashSend.ts:L295` → `isAiBusy = sessMsgs.some(m => m.status === 'processing')` → msg2/msg3 走 `queued` 分支
2. `session-loop/index.ts:L93` → `sessionMutex.acquire()` → 当 msg1 的 `run()` 已持有锁时，msg2 触发的 `AgentInputQueue.enqueue()` 仅入队但不进入 `run()`
3. `AgentSessionLoop.run()` 状态机 `awaiting-input` → `inputQueue.dequeue()`（L148）→ msg2 会在下次 turn 被消费

**如果 `isAiBusy` 检查存在 race**（eg. msg2 恰好在 msg1 消息占位写入前触发）：
- 两个 `runStreamingAssistant` 可能同时执行
- `useStreamCallbacks.ts:L101-117` → 第二个 run 会取消第一个流（`safeCancelStream(prevStream.cancel)`）
- `generationMapRef` 计数器递增（L141），旧流回调全部被 `assertLive()` + `myGen` 检查阻止写入
- 最终效果：第二个 run 存活，第一个 run 的 WebSocket 连接依然在远端运行但结果被丢弃

**竞态窗口**：`useSlashSend.ts:L313-328`（store 写入 user message）与 `L346`（调用 `runStreamingAssistant`）之间存在约几 ms 的异步缝隙。若 msg2 在 msg1 的 store 写入完成前通过 `isAiBusy` 检查，可能导致双流。**但**第二个流的 `runStreamingAssistant` 的旧流清理（L101-117）会立即取消第一个流，因此实际风险很低。

**结论**: ✅ 有充分防护。AsyncMutex 确保 server 端 session-loop 单线程；客户端代际计数器确保旧流回调被丢弃。

### 场景 2: 工具执行中用户切换 session（新会话）

**竞态窗口分析**：
- 工具执行在 daemon 侧（`session-loop/tool-execution.ts`），"切换 session" 在客户端 store
- 切换 session 不中断后端工具执行

**代际计数器防护链**：

| 层面 | 机制 |
|------|------|
| **`myGen` 代际计数器**（`useStreamCallbacks.ts:L141-142`） | 每次 `runStreamingAssistant` 递增，回调中校验 `myGen !== generationMapRef.current.get(sid)`（L152） |
| **`assertLive()` 检查**（L144-147） | `runClosed` + `isLiveStreamRun()` 检查 `streamManagerRef` 中的条目是否仍然指向自己 |
| **`streamManagerRef` 键值**（L164-169） | 以 sessionId 为 key，新 run 覆盖旧条目 |
| **旧流取消**（L101-117） | 新 run 启动时 `safeCancelStream(prevStream.cancel)` → daemon 收到 `cancel-run` → `abortController.abort()` |

**后端的代际等效**：
- `session-loop/index.ts:L93` → `sessionMutex.acquire()`：保证同一 session 只有一个 `run()` 在执行
- `runtime.ts:L59-61` → `abort(reason)`：新 run 启动前旧 run 的 `AbortController` 被 abort
- `tool-execution.ts:L129-134` → 每个工具执行前检查 `signal.aborted`

**发现的问题**：`useStreamCallbacks.ts` 的 `assertLive()` 在 L144-147 实现：
```typescript
const assertLive = (): boolean => {
  if (runClosed) return false;
  return isLiveStreamRun(streamManagerRef.current!.get(sid), assistantMsgId);
};
```
它检查 `streamManagerRef` 中的条目是否仍是自己的 `assistantMsgId`。但如果新 run 和旧 run 的 `assistantMsgId` 恰好相同（概率极低，`Date.now()+Math.random()`），会错误认为旧回调仍存活。同理，`myGen` 检查（L152）依赖 `generationMapRef`，如果 `generationMapRef.current.get(sid)` 被**多个 tab 或进程共享**（当前代码是 `useRef`，每个 hook 实例独立），则不会相互覆盖。

**结论**: ✅ 前端代际计数器 + 后端 `AbortController` + `sessionMutex` 形成多层防护。单进程内无竞态。

### 场景 3: `pending_approval` 状态下等待用户审批时，120s 超时自动 deny

**完整超时路径**：

1. `session-loop/tool-execution.ts:L100-107` → `beforeResult.status === "pending_approval"` → 调用 `resolvePermission()`
2. `resolvePermission`（L245-254）→ `ApprovalPipeline.decide()`
3. `approval-pipeline.ts:L40` → `permissionPolicy.decide()` → 返回 `behavior: "ask"`
4. `approval-pipeline.ts:L57-63` → `approvalHandler.requestApproval(permissionRequest)` → 进入 `DaemonApprovalHandler`
5. `daemon-approval-handler.ts:L74-102` → 计算 `timeoutMs`：
   - `baseTimeout` = 默认 `60*1000`(approval-queue) 或 `120_000`(approval-bridge)
   - `resolveApprovalTimeoutMs()` 对 T3/T4 提升至 `max(base, 10min * 1.5)`
   - **默认场景（T1）**：`baseTimeout` 约 5min（`DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000`）
6. `approval-queue.ts:L107-142` → `waitForApproval()`：
   - 创建 `setTimeout`（L269-271）：`pending.expiresAt - now` 后触发 `this.expire()`
   - `expire()`（L275-286）→ `decision: "expired"` → resolve Promise
7. `daemon-approval-handler.ts:L106-116` → `decisionFromResult()` → `behavior: "deny"` + `softDeny: true` + `expiredReason: "timeout"`
8. `approval-pipeline.ts:L63` → return `userDecision`
9. `tool-execution.ts:L122-126` → permission denied → `buildPermissionDenyToolOutput(decision)` → tool end event

**Daemon 侧额外超时路径**（`approval-bridge.ts`）：
- `approval-bridge.ts:L35-43` → 当 daemon 通过 `ApprovalBridge` 创建 pending 时，定时器触发 `resolve({ approved: false, reason: "Timed out" })`
- 此路径用 `DEFAULT_APPROVAL_TIMEOUT_MS = 120_000`（L3）

**可靠性分析**：

| 维度 | 结论 |
|------|------|
| 定时器始终触发 | ✅ `setTimeout` + `.unref()` 不阻止进程退出 |
| 双重超时风险 | ⚠️ `ApprovalQueue`（5min 默认）+ `ApprovalBridge`（120s 默认）**共存**：`approval-bridge` 先到期（120s），但 daemon 主路径 `ApprovalQueue` 控制超时（5min）。两者是两种不同的 Workflow 路径 |
| 超时后前端 UI | ✅ `approval-resolved` 事件通过 WebSocket 推送 → `EventRouter` → `onApprovalResolved` → tool call 标记 `status: 'error'` |
| 超时期间取消 run | ✅ `approval-queue.ts:L244-254` → `clearRun()` settle 所有 pending |
| 死锁（超时 + 未决工具阻塞状态机） | ✅ `daemon-approval-handler.ts:L219-220` soft deny 文案让模型继续其他步骤 |

**结论**: ✅ 自动 deny 路径完整。`ApprovalQueue.expire()` → `pending.resolve({ decision: "expired" })` → tool result 标记错误 → 状态机继续。

---

## 3. 保障机制总表

| 机制 | 位置 | 用途 |
|------|------|------|
| **AsyncMutex (sessionMutex)** | `session-loop/index.ts:57` | 保证每个 session 同一时刻只有一个 `run()` 在执行 |
| **代际计数器 (myGen)** | `useStreamCallbacks.ts:141-142` | 覆盖旧 flow 的所有回调写入 |
| **assertLive() 双重检查** | `useStreamCallbacks.ts:144-147` | runClosed + streamManager 条目一致性 |
| **AbortController** | `runtime.ts:32` | 后端取消正在执行的 run |
| **AbortSignal 检查** | `tool-execution.ts:129-134` | 工具执行前检查 |
| **ToolHook.beforeExecute** | `tool-execution.ts:91-111` | 0/n 权限/物化/Checkpoint 中间件 |
| **意图级审批缓存** | `daemon-approval-handler.ts:18-20` | run 内/跨 run 的审批放行缓存 |
| **ApprovalCache TTL** | `approval-cache.ts:18` | pipeline 级 30s 缓存 |
| **审批超时自动 expire** | `approval-queue.ts:275-286` | setTimeout 自动 deny |
| **超时边界 clamp** | `approval-queue.ts:368-383` | [100ms, 1h] clamp |
| **run 清理** | `approval-queue.ts:244-254` | run 结束时清理所有 pending 审批 |
| **Stream Batcher 合并** | `api/streamTextBatcher.ts:333-338` | pending_approval 终态即时 flush |
| **finish 控制器** | `streamViaDaemon.ts:18-61` | 等待 inflight 审批完成后再触发 onComplete |
| **maxConcurrentRuns 准入** | `run-handlers.ts:634-649` | 全局并发上限 |
| **Backpressure 背压** | `run-handlers.ts:249-277` | 客户端流暂停时 daemon 缓冲事件 |

---

## 4. 发现的竞态窗口及防护漏洞

### ⚠️ 漏洞 1: `isAiBusy` 与 store 写入的竞争

**位置**：`useSlashSend.ts:L295`
```typescript
const isAiBusy = sessMsgs.some((m) => m.status === 'processing');
```
**问题**：在第 2 条消息的 `handleSendChat` 中，`isAiBusy` 读取的是消息数组的快照。第 1 条消息的 `store.addMessage()`（通过 `useStreamCallbacks.ts:L171-179` 触发）与 `isAiBusy` 检查之间存在异步 gap。如果 msg1 尚未完成 store 写入（React batch 延迟），msg2 看到的 `processing` 消息可能尚未出现，导致双流。

**缓解**：即使双流发生，第二个流的 `runStreamingAssistant` 会立即取消第一个流（L101-117）。但 WebSocket 请求已经发出，daemon 资源已浪费。

**建议修复**：在 `handleSendChat` 中增加 `streamManagerRef.current!.has(sid)` 检查，取代 `isAiBusy` 的消息遍历。或者将 `isAiBusy` 改为读取 `streamManagerRef` 而非消息 store。

### ⚠️ 漏洞 2: `useStreamCallbacks` 中 `cancelFn` 的闭包竞争

**位置**：`useStreamCallbacks.ts:L163-169`
```typescript
let cancelFn: () => void = () => {};
streamManagerRef.current!.set(sid, {
  cancel: () => cancelFn(),
  ...
});
```
**问题**：`streamManagerRef` 中的 `cancel` 闭包捕获的是 `cancelFn` 变量，此时 `cancelFn` 仍是空函数 `() => {}`。真正的 `cancelFn` 在 L228 `streamAssistantResponseApi(...)` 返回后才被赋值（L228）。在 L228 执行完成前调用 `cancel()` 是空操作。

**建议修复**：改用 `ref` 或延迟赋值的模式，确保 `cancel()` 在可用前排队。类似 `promise.then(() => actualCancel())`。

### ⚠️ 漏洞 3: `assertLive()` 与 `myGen` 检查的时序窗口

**位置**：`useStreamCallbacks.ts:L149-155`
```typescript
buffer.onFrame = (frame) => {
  if (runClosed && !frame.isFinal) return;
  if (!assertLive() && !frame.isFinal) return;
  if (myGen !== generationMapRef.current.get(sid)) return;
  updateMessageText(sid, assistantMsgId, frame.full);
};
```
**问题**：在 `assertLive()` 检查通过后、`updateMessageText()` 写入前，如果另一个 run 启动并修改了 `generationMapRef`，`myGen` 检查在 L152 已经通过，不会被再次拦截。虽然概率极低（React 同步执行流），但不具备原子性。

**影响**：`updateMessageText` 可能写入过期数据到新 run 的消息中。

**建议修复**：在 `updateMessageText` 调用后立即再次检查 `myGen`，或使用 React 的 `startTransition` 将写入与检查绑定在同一批中。

### ⚠️ 漏洞 4: `ApprovalCache` 跨 session 意图重放

**位置**：`approval-cache.ts:L18` 默认 TTL 30s
```typescript
this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
```
**问题**：`ApprovalPipeline` 的 `ApprovalCache`（`approval-pipeline.ts:L51-55`）是**无 session 隔离**的。intentKey 相同的工具调用在 30s 内不同 session 共享同一审批结果。若用户在一个 session 批准了 `edit` 工具，30s 内另一个 session 的 edit 工具将自动放行。

**影响**：可能违反用户意图隔离的安全预期。

**建议修复**：在 `ApprovalCache` 的 key 中加入 `sessionId` 前缀，或只在同一个 run 内部共享缓存。

### ⚠️ 漏洞 5: `ApprovalBridge` 与 `ApprovalQueue` 的双重超时

**位置**：`approval-bridge.ts:L23`（120s 默认） vs `approval-queue.ts:L1`（5min 默认）

**问题**：当 `ApprovalBridge` 被用作审批代理时，它的 120s 超时与 `ApprovalQueue` 的 5min 超时不一致。`ApprovalBridge` 先到期并 resolve `{approved: false}`，但 `ApprovalQueue` 的定时器仍会触发 `expire()`。虽然 `settle()` 在 `resolve()` 之后调用会因 `pending.delete()` 而变为 no-op（L277 `if (!pending) return`），但双重超时逻辑增加了维护复杂性。

**建议修复**：统一超时配置源，或移除 `ApprovalBridge` 自有的超时，完全依赖 `ApprovalQueue` 的超时管理。

---

## 5. 改进建议汇总

| # | 严重性 | 文件 | 行号 | 建议 |
|---|--------|------|------|------|
| 1 | 中 | `useSlashSend.ts` | L295 | 用 `streamManagerRef.current!.has(sid)` 替代 `isAiBusy` 消息遍历 |
| 2 | 低 | `useStreamCallbacks.ts` | L163-169 | `cancel` 闭包改用延迟赋值的 ref 模式 |
| 3 | 低 | `useStreamCallbacks.ts` | L149-155 | `updateMessageText` 后追加二次 `myGen` 校验 |
| 4 | **高** | `approval-cache.ts` | L18 | 缓存 key 加入 `sessionId` 前缀，防止跨 session 意图重放 |
| 5 | 低 | `approval-bridge.ts` | L3, L23 | 移除或统一双重超时配置，仅依赖 `ApprovalQueue` 超时管理 |
