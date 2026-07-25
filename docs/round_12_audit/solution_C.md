# Conex 全仓库系统性修复方案（Agent C 综合版本）

> 基于 Round 12 全部 12 份审计报告的分析，覆盖 AG-01 ~ AG-12 所有发现的问题。
> 方案按逻辑轮次组织，所有问题同等重要，不包含时间安排、人员分配、优先级排序。
> 共计 12 轮，每轮 ≤ 12 个 Agent，含验收标准。

---

## Round 1：致命阻断问题修复

**目标**：解决会导致编译失败、运行时崩溃、安全漏洞或数据永久损坏的致命问题，确保基础构建与运行可用。

**前置依赖**：无

### 详细实现指南

**R1-T1 (CardPanel.tsx 冲突修复)**：
- 检查 `CardPanel.tsx:864-867` 区域，当前结构在 JSX `return` 之前存在孤立的 `=======` 分隔符，上方是旧分支代码（三目运算符 `{activeCardId === 'chat' ? (`），下方是新的 `return` 块。这是由于 partial merge 导致的语法错误。
- 推荐方案：检查该区域上下文，确认 `=======` 上方和下方的代码片段哪个是目标保留分支，移除另一方及 `=======` 标记。需要确保 JSX 树闭合完整（`<div className="card-header">` 的闭合 `</div>` 等）。
- 修复后验证：通过 `npx tsc --noEmit --project apps/crish-desktop/tsconfig.app.json` 确认无 JSX 解析错误。

**R1-T2 (37 个 UU 文件的 git 合并)**：
- 37 个文件处于 `both modified` 状态。除 `CardPanel.tsx` 外，其他 36 个 UU 文件经逐行检查无实际冲突标记。
- 对无冲突的 UU 文件：`git add <file>` 将它们标记为已合并即可。
- 对已修复的 `CardPanel.tsx`：同样 `git add`。
- 注意：在执行 `git add` 前，对所有 UU 文件做 grep `<<<<<<<|=======|>>>>>>>` 二次确认。

**R1-T3 (workbench_apply_update Tauri command)**：
- 前端 `updateStore.ts:63` 调用 `invoke('workbench_apply_update')`，但 Rust 端未注册对应 `#[tauri::command]`。
- 实现：在 `apps/agent-workbench/src-tauri/src/` 下新增或修改现有的命令处理模块，添加 `workbench_apply_update` 函数，处理应用更新逻辑（实际下载和安装更新）。
- 注册：在 `main.rs` 的 `register_handlers!()` 宏调用中加入新命令。
- 如果当前无更新功能实现，至少注册一个返回 `Ok(())` 的 stub，或从前端移除该调用以避免误导。

**R1-T4 (MessageContent DOMPurify)**：
- 定位 `MessageContent.tsx:96-98` 的 `containerRef.current.innerHTML = wrappedHtml` 行。
- 在文件顶部添加 `import DOMPurify from 'dompurify';`。
- 将赋值改为 `containerRef.current.innerHTML = DOMPurify.sanitize(wrappedHtml);`。
- 保持 `requestIdleCallback` 包裹结构和 timeout 参数不变。
- 对于增量路径（L101-105 的 `applyDomPatches`），也考虑对 patches 中的 html 内容做 sanitize。

**R1-T5 (sessionActions 破损路径修复)**：
- `sessionActions.ts:33-36` 从 `./actions/chat` 等 4 个路径 import，但 `actions/` 目录不存在。
- 方案 A（轻量）：修复 import 路径，指向 `session-actions/` 下的对应工厂函数。
- 方案 B（推荐）：将 `sessionActions.ts` 改为 barrel，内容改为 `export * from "./session-actions"`；将所有消费者的 import 更新为引用 `session-actions/index.ts`。
- 消费者包括：`layoutStore.ts:49`, `sessionStore.ts:13-14`, `sessionActions.test.ts:4`。

**R1-T6 (appendMessages 原子化)**：
- 当前实现循环调用 `appendMessage`，遇到 `StoreCapacityError` 时仅 `console.warn` + return，调用方无法感知部分写入。
- 方案 A：改为"全成功或全失败"语义——先预检查容量，一次性写入所有消息。
- 方案 B（推荐）：返回 `{ written: number, failed: number, error?: string }`，让调用方感知部分写入。
- 同时更新 `ISessionStore` 接口中 `appendMessages` 的返回值类型。

**R1-T7 (FIFO shift 配对保护)**：
- `message-actions.ts:27-40` 中，当 `sess.messages.length >= MAX_MESSAGES_PER_SESSION` 时执行 `shift()` 移除最早消息。
- 当前逻辑：如果 `first.toolCalls?.length` 存在，记录其 ID 到 `truncatedToolChainIds`，但仍只 `shift()` 一个消息。
- 修复：在 `shift()` 前，检查 `sess.messages[1]` 是否为 `msg[0]` 的 tool-result。如果是，使用 `splice(0, 2)` 配对移除。
- 同时保留 `truncatedToolChainIds` 记录逻辑。

**R1-T8 (ApprovalCache 跨 session 隔离)**：
- `ApprovalCache.get/set` 当前仅以 `intentKey` 为 key，无 session 隔离。
- 修复：将 `get()` 和 `set()` 的 key 改为 `sessionId + ":" + intentKey` 复合结构。
- `ApprovalPipeline.decide()` 中调用 `cache.get()` 和 `cache.set()` 时传入带 sessionId 的 key。
- 注意保持 `clear()` 和自动清理逻辑不受影响。

**R1-T9/R1-T10 (EventRouter 新增事件处理)**：
- 在 `EventRouter.ts` 的 `handleAgentEvent` 方法中（或等效的 switch/dispatch 结构），添加 `case 'runtime-error'` 和 `case 'provider-diagnostic'` 分支。
- `runtime-error`：提取 `retryable` 字段（来自 payload），调用适当的回调让前端展示错误和重试选项。
- `provider-diagnostic`：提取 `retryable` 字段，转发给诊断系统，用于决定是否展示"重试按钮"。

**R1-T11 (runtime-error 添加 retryable)**：
- `session-loop/index.ts:118-121` 的 catch 分支 emit `runtime-error` event 时缺少 `retryable` 字段。
- 在 emit 前调用 `classifyProviderErrorMessage(errMsg)` 或 `ErrorClassifier.classify()` 获取分类结果，将 `retryable` 布尔值加入 event payload。
- 示例：`yield* this.emitEvent({ type: 'runtime-error', ..., error: error.message, retryable: classified.retryable })`。

**R1-T12 (SessionStoreSlice 补全字段)**：
- `session-actions/types.ts:4-14` 的 `SessionStoreSlice` 接口缺少 `truncatedToolChainIds` 字段。
- 在接口定义中添加 `truncatedToolChainIds?: string[];`。
- 该字段实际在 `store/types.ts:343` 的 `SessionState` 上已定义，只需在 slice 接口中同步。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R1-T1 | 移除 CardPanel.tsx 中 `=======` 冲突标记残留，修复 JSX 语法 | `apps/crish-desktop/src/components/CardPanel.tsx:866` | AG-01 |
| R1-T2 | 完成 37 个 UU 文件的 `git add` 合并标记，确保无实际冲突内容 | (37 files listed in AG-01) | AG-01 |
| R1-T3 | 在 Rust 端实现 `workbench_apply_update` Tauri command 并注册到 register_handlers!() | `apps/crish-desktop/src/api/updateStore.ts:63`, `apps/agent-workbench/src-tauri/src/` | AG-06 |
| R1-T4 | 修复 MessageContent.tsx 中 innerHTML 无 DOMPurify 的 XSS 风险 | `apps/crish-desktop/src/components/chat/MessageContent.tsx:96-98` | AG-08 |
| R1-T5 | 在 `sessionActions.ts` 中将 `./actions/chat` 等 4 个破碎 import 路径修复，或直接废弃旧文件、切换消费端引用到 `session-actions/index.ts` | `apps/crish-desktop/src/store/sessionActions.ts:33-36`, `sessionStore.ts:13-14`, `layoutStore.ts:49` | AG-10 |
| R1-T6 | 在 `SessionStore.appendMessages` 改为原子语义或返回 `{written,failed}` 让调用方感知部分写入 | `packages/agent-runtime/src/session-store/index.ts:175-187` | AG-04 |
| R1-T7 | 为 `message-actions.ts` FIFO shift 添加配对清理（tool-call + tool-result 一并移除） | `apps/crish-desktop/src/store/session-actions/message-actions.ts:27-40` | AG-04 |
| R1-T8 | 在 `ApprovalCache` key 中加入 `sessionId` 前缀，防止跨 session 意图重放 | `packages/agent-runtime/src/approval/approval-cache.ts:21-38`, `approval-pipeline.ts:51-55` | AG-02, AG-05 |
| R1-T9 | 在 EventRouter 中添加 `runtime-error` 事件处理 case | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts:handleAgentEvent` | AG-03 |
| R1-T10 | 在 EventRouter 中添加 `provider-diagnostic` 事件处理 case | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts:handleAgentEvent` | AG-03 |
| R1-T11 | 为 `runtime-error` event 添加 `retryable` 字段（在 session-loop/index.ts catch 分支调用 error classifier 分类） | `packages/agent-runtime/src/session-loop/index.ts:118-121` | AG-03 |
| R1-T12 | 补全 `SessionStoreSlice` 中缺失的 `truncatedToolChainIds` 字段定义 | `apps/crish-desktop/src/store/session-actions/types.ts:4` | AG-04 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R1-A | R1-T1 + R1-T2 | `CardPanel.tsx`, 37 UU files |
| Agent R1-B | R1-T3 | `updateStore.ts`, Rust `main.rs` + handlers |
| Agent R1-C | R1-T4 | `MessageContent.tsx` |
| Agent R1-D | R1-T5 | `sessionActions.ts`, `sessionStore.ts`, `layoutStore.ts`, `session-actions/index.ts` |
| Agent R1-E | R1-T6 + R1-T12 | `session-store/index.ts`, `session-actions/types.ts`, `ISessionStore.ts` |
| Agent R1-F | R1-T7 | `message-actions.ts` |
| Agent R1-G | R1-T8 | `approval-cache.ts`, `approval-pipeline.ts` |
| Agent R1-H | R1-T9 + R1-T10 | `EventRouter.ts` |
| Agent R1-I | R1-T11 | `session-loop/index.ts` |
| Agent R1-J | R1-T2（脚本文具） | bash/git 自动化脚本治理 UU files |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | 无 `=======`/`<<<<<<<`/`>>>>>>>` 冲突标记残留 | `rg '<<<<<<<|=======|>>>>>>>' --include '*.ts' --include '*.tsx'` 排除合法注释 | 0 误报 |
| AC-2 | `git status` 无 UU 文件 | `git status --porcelain | grep '^UU'` | 0 行输出 |
| AC-3 | `workbench_apply_update` invoke 成功 | `rg 'workbench_apply_update' --include '*.rs'` + `rg '#\[tauri::command\]' -A 3 -- '*.rs' | grep workbench_apply_update` | 前后端同时存在 |
| AC-4 | MessageContent 使用 DOMPurify | 读 `MessageContent.tsx` 确认 `DOMPurify.sanitize()` 包裹 | 存在 DOMPurify.sanitize |
| AC-5 | session-actions 无破损引用 | `tsc --noEmit --project apps/crish-desktop/tsconfig.app.json` | 无路径错误 |
| AC-6 | appendMessages 返回 `{written,failed}` 或全成功/全失败 | 读 `session-store/index.ts` | 符合原子语义或结果报告 |
| AC-7 | FIFO shift 移除 tool-call 时配对移除 tool-result | 读 `message-actions.ts:addMessage` | splice(0,2) 或等价配对清理 |
| AC-8 | ApprovalCache key 含 sessionId | `rg 'sessionId' approval-cache.ts | head -10` | key 构造含 sessionId |
| AC-9 | EventRouter 有 runtime-error case | `rg 'runtime-error' EventRouter.ts` | 至少 1 个匹配 |
| AC-10 | EventRouter 有 provider-diagnostic case | `rg 'provider-diagnostic' EventRouter.ts` | 至少 1 个匹配 |
| AC-11 | runtime-error 含 retryable 字段 | `rg 'retryable' session-loop/index.ts` | emit 中含 retryable |
| AC-12 | SessionStoreSlice 含 truncatedToolChainIds | `rg 'truncatedToolChainIds' session-actions/types.ts` | 字段存在 |

---

## Round 2：并发竞态与数据竞争修复

**目标**：修复 tool call 调用链中发现的 5 个竞态漏洞，增强并发安全性。

**前置依赖**：Round 1（R1-T8 是 R2-T1 的前置，因缓存 key 隔离需先完成）

### 详细实现指南

**R2-T1/R2-T5 (isAiBusy 用 streamManagerRef 替代)**：
- 当前 `useSlashSend.ts:295` 使用 `sessMsgs.some((m) => m.status === 'processing')` 判断 AI 是否繁忙。这里读取的是消息数组快照，可能在异步间隙中过时。
- 修复：改用 `streamManagerRef.current!.has(sid)` 直接查询当前活跃流的存在性。
- `streamManagerRef` 以 sessionId 为 key，新 run 覆盖旧条目，比消息数组更实时。
- 具体修改：将 `const isAiBusy = sessMsgs.some(...)` 替换为 `const isAiBusy = streamManagerRef.current?.has(sid) ?? false;`。
- 需要在 `useSlashSend.ts` 中获取或传入 `streamManagerRef`（可通过 hook 参数或直接从 useStreamCallbacks 共享 ref）。

**R2-T2 (cancelFn 闭包延迟赋值)**：
- `useStreamCallbacks.ts:163-169` 中，`streamManagerRef` 的 `cancel` 闭包捕获 `cancelFn` 变量时，`cancelFn` 还是空函数 `() => {}`。
- 真正的 `cancelFn` 在 L228 `streamAssistantResponseApi(...)` 返回后才被赋值。
- 修复方案：
  - 方案 A：使用 `ref` 模式：`const cancelRef = useRef<() => void>(() => {});`，`streamManagerRef` 中存 `cancel: () => cancelRef.current()`，L228 处 `cancelRef.current = actualCancelFn`。
  - 方案 B：使用 Promise 延迟：`const cancelReady = new Promise<void>((resolve) => { ... })`，L228 时 `resolve(actualCancelFn)`。
  - 推荐方案 A（ref 模式），因为它更轻量且与 React 惯用模式一致。

**R2-T3 (myGen 二次校验)**：
- `useStreamCallbacks.ts:149-155` 的 `buffer.onFrame` 回调中，`assertLive()` 和 `myGen` 检查通过后，`updateMessageText` 写入前存在微小窗口。
- 修复：在 `updateMessageText` 调用后立即追加二次校验：`if (myGen !== generationMapRef.current.get(sid)) { /* 回滚或忽略 */ return; }`。
- 或使用 `startTransition` 包裹写入与校验，使其在同一批中执行。

**R2-T4 (双重超时统一)**：
- `ApprovalBridge`（`approval-bridge.ts:3`）默认超时 120s，`ApprovalQueue` 默认 5min。
- 如果 `ApprovalBridge` 纯粹作为代理层使用，移除其自有超时逻辑，完全依赖 `ApprovalQueue` 的定时器管理。
- 如果两者有独立语义，则将超时配置统一为从同一配置源读取。

**R2-T6 (generationMapRef 清理)**：
- `generationMapRef` 是 `Map<string, number>`，长期运行不会清理已关闭 session 的条目。
- 在 session 关闭/删除时（如 `deleteSession`、`archiveSession`），调用 `generationMapRef.current.delete(sessionId)`。
- 或在 `runStreamingAssistant` 的 `finally` 或 `onComplete` 分支考虑清理已关闭 session 的条目。

**R2-T7 (原子性守卫)**：
- `assertLive()` 检查后到 `updateMessageText()` 写入前，如果另一个 run 启动并修改了 `generationMapRef`，当前已通过的 `myGen` 检查不会再次拦截。
- 使用 `React.startTransition` 将写入批处理：`startTransition(() => { updateMessageText(sid, assistantMsgId, frame.full); })`。
- 配合 transition 内的二次 `myGen` 校验，确保写操作与旧代际解耦。

**R2-T8 (重试按钮支持)**：
- 前端 `useChatStream.onRunError` 回调当前仅接受错误消息文本，不接收 `retryable` 标记。
- 修改 `onRunError` 签名，增加 `retryable?: boolean` 参数。
- 当 `retryable === true` 时，在 UI 错误气泡中显示"重试"按钮。
- 重试按钮调用 `providerGateway.call()` 重新发起最后一次 provider 调用。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 依赖 | 来源报告 |
|--------|------|---------|------|---------|
| R2-T1 | 用 `streamManagerRef.current!.has(sid)` 替代 `isAiBusy` 的消息遍历检查 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:295` | — | AG-02 |
| R2-T2 | 修复 `cancelFn` 闭包竞态：改用 ref 或 Promise 延迟赋值模式 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:163-169` | — | AG-02 |
| R2-T3 | 在 `updateMessageText` 后追加二次 `myGen` 校验 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:149-155` | — | AG-02 |
| R2-T4 | 统一或移除 `ApprovalBridge` 自有超时，完全依赖 `ApprovalQueue` 超时管理 | `packages/agent-daemon/src/approval-bridge.ts:3,23`, `packages/agent-daemon/src/approval-queue.ts:1` | — | AG-02 |
| R2-T5 | 在 `handleSendChat` 中增加 `streamManagerRef.current!.has(sid)` 前置检查取代 isAiBusy | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:295-328` | R2-T1 | AG-02 |
| R2-T6 | 审查 `generationMapRef` 在 session 关闭时清除条目，防微量内存泄漏 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | — | AG-05 |
| R2-T7 | 审查同步执行流中 assertLive 与 myGen 的原子性，改为用 React startTransition 绑写入与检查 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:144-155` | — | AG-02 |
| R2-T8 | 在前端 `useChatStream.onRunError` 中引入 `retryable` 参数支持重试按钮 | `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts:1044` | R1-T9/R1-T10/R1-T11 | AG-03 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R2-A | R2-T1 + R2-T5 | `useSlashSend.ts` |
| Agent R2-B | R2-T2 + R2-T3 | `useStreamCallbacks.ts` |
| Agent R2-C | R2-T4 | `approval-bridge.ts`, `approval-queue.ts` |
| Agent R2-D | R2-T6 | `useStreamCallbacks.ts` |
| Agent R2-E | R2-T7 | `useStreamCallbacks.ts` |
| Agent R2-F | R2-T8 | `useChatStream.ts`, `surfaceStreamFailure.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `isAiBusy` 不再遍历消息数组 | 读 `useSlashSend.ts:L295` | 使用 streamManagerRef 替代 |
| AC-2 | `cancelFn` 延迟赋值 | 读 `useStreamCallbacks.ts:L163-L169` | cancel 闭包使用 ref/Promise 延迟赋值模式 |
| AC-3 | `updateMessageText` 后追加 myGen 校验 | 读 `useStreamCallbacks.ts:L153` 附近 | 调用后再次 myGen 检查 |
| AC-4 | `ApprovalBridge` 超时移除或统一 | 读 `approval-bridge.ts` | 无独立超时逻辑或与 ApprovalQueue 一致 |
| AC-5 | `generationMapRef` 有 session 关闭清理 | `rg 'delete.*generationMapRef|cleanup.*generationMapRef' useStreamCallbacks.ts` | 清理逻辑存在 |
| AC-6 | 重试按钮支持 | `rg 'retryable' useChatStream.ts` | retryable 参数传递到 onRunError |
| AC-7 | 二次 myGen 校验通过 | `rg 'startTransition\|myGen.*get' useStreamCallbacks.ts` | 原子性守卫存在 |

---

## Round 3：Store 数据完整性与 IPC 一致性

**目标**：修复 Session Store 的数据不一致风险，统一 Tauri IPC 路径完整性。

**前置依赖**：Round 1（R1-T6/R1-T7 是基础）

### 详细实现指南

**R3-T1 (ISessionStore 与 SessionStore 签名对齐)**：
- 当前 `ISessionStore.appendMessage` 声明返回 `Promise<AppendResult> | AppendResult`，但 `SessionStore.appendMessage` 实际返回 `void`。
- 在 `session-store/types.ts` 中定义 `AppendResult` 类型：`export type AppendResult = { success: true } | { success: false; reason: string; }`。
- 修改 `SessionStore.appendMessage` 实现，在所有路径返回适当的 `AppendResult`（成功或失败）。
- 更新 `appendMessages` 也返回聚合结果而非 `void`。

**R3-T2 (TelemetryMonitor invokeResult)**：
- `TelemetryMonitor.ts:101` 使用裸 `invoke('perf_jsonl_append', ...)`，非 Tauri 环境会抛异常。
- 改为使用 `invokeResult` 工具函数（如存在）或自行添加 try/catch 降级。
- 修改为：`try { await invoke('perf_jsonl_append', ...); } catch { /* 静默降级 */ }`。

**R3-T3 (hello case 类型安全)**：
- `protocol.ts:412-413` 中 `case 'hello'` 返回 `as unknown as DaemonInboundMessage` 类型断言。
- 定义一个 `HelloMessage` 接口，将其作为 `DaemonInboundMessage` 联合类型的一部分。
- 在 switch case 中返回具体类型而非 `as unknown as`。

**R3-T4 (四端同步注释)**：
- 在 `protocol.ts` 文件头部添加注释块，列出所有 4 处需要在新增消息类型时同步修改的位置：
  1. `registry.ts` — `DAEMON_INBOUND_MESSAGE_TYPES` 和 `DAEMON_OUTBOUND_MESSAGE_TYPES` 列表
  2. `protocol.ts` — `validateInboundMessage` 和 `validateOutboundMessage` switch
  3. `server-handlers.ts` — `handleInboundMessage` switch
  4. 对应的 validator 实现文件
- 可以使用 checklist 格式，每次新增消息类型时逐项勾选。

**R3-T5 (queryRange 配对检查)**：
- `session-store/index.ts:191-225` 的 `queryRange` 方法忽略 tool-call 与 tool-result 的配对关系。
- 在返回的 `messages` 数组中，检查是否包含孤立的 tool-result（即 tool-result 存在但对应 tool-call 不在查询范围内）。
- 如果发现孤立 tool-result，可以选择一并包含其 tool-call 或标记为孤立状态。

**R3-T6 (前后端消息模型对齐)**：
- 对比前端 `store/types.ts` 的 `SessionState` 和后端 `session-store/index.ts` 的 `SessionBranch/MessageShard` 模型。
- 确保关键字段（如 `truncatedToolChainIds`、消息状态枚举值等）在前端消费时正确映射。
- 检查 `SessionStore.getAllMessages` 返回的消息与前端的 `SessionMessage` 类型是否兼容。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 依赖 | 来源报告 |
|--------|------|---------|------|---------|
| R3-T1 | 在 `ISessionStore` 中正确定义 `AppendResult` 并让 `SessionStore.appendMessage` 返回符合接口声明的类型 | `packages/agent-runtime/src/session-store/types.ts`, `ISessionStore.ts`, `session-store/index.ts` | R1-T6 | AG-04 |
| R3-T2 | TelemetryMonitor flush 使用 `invokeResult` 替代裸 `invoke` | `apps/crish-desktop/src/services/TelemetryMonitor.ts:101` | — | AG-06 |
| R3-T3 | 在 `validateInboundMessage` 中为 `hello` case 定义独立类型避免 `as unknown as DaemonInboundMessage` | `packages/agent-daemon/src/protocol/protocol.ts:412-413` | — | AG-06 |
| R3-T4 | 在 `protocol.ts` 头部添加注释清单，提醒新增消息类型需在 registry + protocol switch + server-handlers switch + validator 四端同步 | `packages/agent-daemon/src/protocol/protocol.ts` | — | AG-06 |
| R3-T5 | 补齐 `session-store/index.ts` 中 `queryRange` 方法的工具结果配对检查 | `packages/agent-runtime/src/session-store/index.ts:191-225` | — | AG-04 |
| R3-T6 | 验证并统一前端 `SessionState` 与后端 `ISessionStore` 的消息模型对齐 | `apps/crish-desktop/src/store/types.ts`, `packages/agent-runtime/src/session-store/index.ts` | — | AG-04 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R3-A | R3-T1 | `types.ts`, `ISessionStore.ts`, `session-store/index.ts` |
| Agent R3-B | R3-T2 | `TelemetryMonitor.ts` |
| Agent R3-C | R3-T3 + R3-T4 | `protocol.ts` |
| Agent R3-D | R3-T5 | `session-store/index.ts` |
| Agent R3-E | R3-T6 | `types.ts`, `session-store/index.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `AppendResult` 已定义 | `rg 'export.*AppendResult' session-store/types.ts` | 类型导出 |
| AC-2 | appendMessage 返回匹配接口 | `tsc --noEmit packages/agent-runtime` | 编译通过 |
| AC-3 | TelemetryMonitor 使用 invokeResult | 读 `TelemetryMonitor.ts` | 非裸 invoke() |
| AC-4 | hello case 独立类型 | `rg 'case.*hello' protocol.ts` | 有具体类型非 as unknown |
| AC-5 | protocol.ts 头部有四同步注释 | 读 `protocol.ts:1-20` | 注释清单存在 |
| AC-6 | queryRange 含配对检查 | `rg 'toolCall.*toolResult\|tool-result.*pair' session-store/index.ts` | 检查逻辑存在 |

---

## Round 4：故障恢复与错误透传修复

**目标**：完善 Provider 故障恢复全链路，修复 retryable 标记丢失、EventRouter 静默丢弃，增强 streamWithRecovery 退避。

**前置依赖**：Round 1（R1-T9/R1-T10/R1-T11）、Round 2（R2-T8）

### 详细实现指南

**R4-T1 (session-loop 迁移 ErrorClassifier)**：
- 两个调用点：
  1. `session-loop/index.ts:255`：`const classified = classifyProviderErrorMessage(errMsg);` 改为 `const classified = ErrorClassifier.classify(errMsg);`。
  2. `session-loop/types.ts:27`：`return classifyProviderErrorMessage(message).retryable;` 改为 `return ErrorClassifier.classify(message).retryable;`。
- 确保 `ErrorClassifier` 模块已正确导入。`ErrorClassifier.classify` 是静态方法，无需实例化。
- 确认 `ErrorClassifier.classify` 返回的分类结果包含前端所需的所有字段（`retryable`, `kind`, `message`）。

**R4-T2/R4-T3 (stream-contract 迁移)**：
- `error.ts:42-61` 中的 `classifyProviderStreamErrorKind` 是独立的 if/else 分类链，逻辑与 `ErrorClassifier` 重复。
- 改为在 `classifyProviderStreamError` 内部调用 `ErrorClassifier.classify` 获取分类结果，然后映射到 `ProviderStreamErrorKind`。
- `normalizer.ts:50-57` 的 `classifyErrorMessage` 类似，改为委托 `ErrorClassifier.classify`。
- 注意保持返回类型的兼容性——可能需要适配新旧分类枚举之间的映射。

**R4-T4 (streamWithRecovery 退避)**：
- `stream-recovery.ts` 的 `decideRecovery` 当前只重试一次。
- 新增 `retryCount` 累加器，在 `StreamRecovery` 实例级别维护。
- 重试退避：`setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 30000))`。
- 退避只在无内容场景（C）使用，有内容场景（B）仍直接 surface-error。
- 当重试次数达到上限（如 3 次）后，最终 surface-error 不再重试。

**R4-T5/R4-T6 (CircuitBreaker 残留清理)**：
- `fallback-chain/types.ts:14`：从 `FallbackErrorType` 联合类型中删除 `"circuit-open"`。
- 同步更新 `domainToFallbackErrorType` 映射（如果有 `circuit-open` 的 case 也一并移除）。
- `error-classifier.ts:42-55`：从 `ErrorDomain` 矩阵定义中移除 `tripsBreaker: boolean` 字段。
- 更新 `ErrorDomain` 相关类型定义，删除 `tripsBreaker` 属性的引用。
- 注意：这些清理仅在确认代码库中无任何消费者引用后进行。

**R4-T7 (测试文件重命名与补充)**：
- 将 `circuit-breaker-e2e.test.ts` 重命名为 `exponential-backoff-e2e.test.ts`。
- 更新文件内的测试描述字符串，替换所有 `"CircuitBreaker"` 引用。
- 补充以下测试用例：
  - 退避延迟计算：验证 attempt=1 → 1000ms, attempt=2 → 2000ms, attempt=3 → 4000ms。
  - 退避上限：验证 attempt=6 时仍为 30000ms。
  - 重试耗尽后错误透传：验证 3 次重试失败后原样抛出最后一个错误。
  - 非重试错误不重试：验证 401/403 等直接抛出。

**R4-T8 (syncRoutes() 实现)**：
- `provider-registry-v2.ts:305-307` 的 `syncRoutes()` 当前是空实现 + 注释。
- 实现逻辑：遍历 `providerClasses` 和 `providerFactories` Map 中的所有注册 provider，将其同步到 `StaticProviderRouteCatalog`。
- 同步内容包括：provider ID、对应的 engine class、route 元数据。
- 在 `registerProviderClass()`、`registerProviderFactory()`、`registerEngineClass()` 方法末尾自动调用 `syncRoutes()` 确保一致。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 依赖 | 来源报告 |
|--------|------|---------|------|---------|
| R4-T1 | 将 `session-loop/index.ts:255` 和 `session-loop/types.ts:27` 的 `classifyProviderErrorMessage` 调用改为 `ErrorClassifier.classify` | `packages/agent-runtime/src/session-loop/index.ts:255`, `session-loop/types.ts:27` | — | AG-09 |
| R4-T2 | 将 `provider-stream-contract/error.ts:42-61` 的 `classifyProviderStreamErrorKind` 内联分类改为委托 `ErrorClassifier.classify` | `packages/agent-runtime/src/provider-stream-contract/error.ts:42-61` | — | AG-09 |
| R4-T3 | 将 `provider-stream-contract/normalizer.ts:50-57` 的 `classifyErrorMessage` 改为使用 ErrorClassifier | `packages/agent-runtime/src/provider-stream-contract/normalizer.ts:50-57` | — | AG-09 |
| R4-T4 | 为 `streamWithRecovery` 路径加入指数退避和重试计数 | `packages/agent-runtime/src/provider-transport/stream-recovery.ts:decideRecovery` | — | AG-03 |
| R4-T5 | 移除 `fallback-chain/types.ts` 中未使用的 `"circuit-open"` 类型 | `packages/agent-runtime/src/fallback-chain/types.ts:14` | — | AG-03 |
| R4-T6 | 清理 `error-classifier.ts` 中 `tripsBreaker` 字段 | `packages/agent-runtime/src/error-classifier.ts:42-55` | — | AG-03 |
| R4-T7 | 重命名 `circuit-breaker-e2e.test.ts` 为 `exponential-backoff-e2e.test.ts`，补充退避计算验证 | `packages/agent-runtime/src/runtime-components/provider-call-gateway.test.ts`（原 circuit-breaker-e2e.test.ts） | — | AG-03 |
| R4-T8 | 实现 `ProviderRegistryV2.syncRoutes()` 逻辑，将新注册 Provider 同步到 StaticProviderRouteCatalog | `packages/agent-runtime/src/provider-registry-v2.ts:305-307` | — | AG-09 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R4-A | R4-T1 | `session-loop/index.ts`, `session-loop/types.ts` |
| Agent R4-B | R4-T2 | `provider-stream-contract/error.ts` |
| Agent R4-C | R4-T3 | `provider-stream-contract/normalizer.ts` |
| Agent R4-D | R4-T4 | `stream-recovery.ts` |
| Agent R4-E | R4-T5 + R4-T6 | `fallback-chain/types.ts`, `error-classifier.ts` |
| Agent R4-F | R4-T7 | `circuit-breaker-e2e.test.ts`（重命名 + 补充） |
| Agent R4-G | R4-T8 | `provider-registry-v2.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | session-loop 不再直接调用 classifyProviderErrorMessage | `rg 'classifyProviderErrorMessage' session-loop/` | 0 个调用 |
| AC-2 | provider-stream-contract/error.ts 委托 ErrorClassifier | 读 `error.ts:42-61` | 使用 ErrorClassifier.classify |
| AC-3 | normalizer.ts 委托 ErrorClassifier | 读 `normalizer.ts:50-57` | 使用 ErrorClassifier.classify |
| AC-4 | streamWithRecovery 有重试计数 + 退避 | 读 `stream-recovery.ts:decideRecovery` | 含 retryCount 和指数退避 |
| AC-5 | `"circuit-open"` 已从 FallbackErrorType 移除 | `rg 'circuit-open' fallback-chain/types.ts` | 0 匹配 |
| AC-6 | `tripsBreaker` 已从 error-classifier 移除 | `rg 'tripsBreaker' error-classifier.ts` | 0 匹配 |
| AC-7 | 测试文件已重命名并补充退避测试 | `rg 'exponential.*backoff\|retryProviderStream' provider-call-gateway.test.ts` | 退避延迟计算测试 |
| AC-8 | `syncRoutes()` 有实现而非 no-op | 读 `provider-registry-v2.ts:305-307` | 非空实现 |

---

## Round 5：渲染管线优化

**目标**：消除重复 markdown 解析导致的 P0 性能瓶颈，统一两套渲染管线入口，修复 UTF-8 截断问题。

**前置依赖**：无

### 详细实现指南

**R5-T1 (消除重复 markdown 解析)**：
- 核心问题：`StreamRenderBuffer` 的 `IncrementalMarkdownBridge` 已做增量解析并生成 `RenderFrame.html`，但 `onFrame` 回调（`useStreamCallbacks.ts:153`）只使用 `frame.full` 纯文本写入 store，`frame.html` 被丢弃。
- `MessageContent.tsx` 收到纯文本后用 `parseMarkdownToHtmlAsync` 重新解析全文，导致 60-80% 的渲染开销浪费。
- 修复方案：
  1. 扩展 store 中消息的文本字段，增加 `_preRenderedHtml` 可选字段，用于存储 `RenderFrame.html`。
  2. 在 `useStreamCallbacks.ts` 的 `onFrame` 中，将 `frame.html` 同时写入 store（作为一个附加字段）。
  3. 在 `MessageContent.tsx` 中，如果 `_preRenderedHtml` 存在且完整（isFinal 时），直接使用 innerHTML 赋值跳过 `parseMarkdownToHtmlAsync`。
  4. 分帧流中，也可以同时存储 `chunkUpdates`，在增量渲染中使用 `applyDomPatches` 而无需重新解析。
- 注意：最终消息（isFinal=true）时必须确保 HTML 已完成且无缺失片段。

**R5-T2 (统一渲染管线入口)**：
- 当前主聊天流在 `useStreamCallbacks.ts` 内联创建 `new StreamRenderBuffer()` 并使用硬编码参数（12ms/8192/32768）。
- Agent 流在 `useStreamingText` 中通过 `options` 参数传入自定义配置。
- 推荐方案：
  1. 创建一个共享的 `createStreamRenderBuffer(options?)` 工厂函数，统一默认参数。
  2. 主聊天流和 agent 流都使用同一工厂函数创建 buffer。
  3. 默认参数值从单一配置源读取，便于统一调整。

**R5-T3 (UTF-8 安全截断)**：
- `flushFrame()` 在超过 `maxBytesPerFrame` 时使用 `lastIndexOf('\n')` 分割，无换行时按字节截断可能切在多字节 UTF-8 字符中间。
- 修复：截断后检查最后一个字节是否为合法的 UTF-8 起始字节或延续字节。
- 如果截断点位于多字节字符中间，向前回退到该字符的起始字节。
- 使用 `TextDecoder` 的 `streaming` 模式可以更好地处理流式 UTF-8 文本。

**R5-T4 (Worker 化增量 markdown 解析)**：
- 将 `IncrementalMarkdownBridge.push()` 从主线程 `flushFrame()` 中移出。
- 创建一个 Web Worker（`incrementalMarkdownBridge.worker.ts`），在 Worker 中维护 `IncrementalMarkdownBridge` 实例。
- 主线程通过 postMessage 传递纯文本增量，Worker 返回解析后的 HTML 增量。
- 注意 Worker 通信的序列化开销——对于大量小增量，可能需要批量发送。

**R5-T5 (积压降级 UI 提示)**：
- 在 `StreamRenderBuffer` 降级时（`bufferedLength > maxBacklogBytes`），通过 `onFrame` 回调或专用回调通知 store。
- 在 store 中设置一个 `backlogDegraded` flag，关联到当前 session 和 message。
- UI 层（MessageContent 或 ChatMessageRow）检查此 flag，显示一个非侵入式提示如"内容加速生成中…"。
- 当降级解除（backlog 恢复正常）时清除 flag。

**R5-T6 (清理 textBatcherRef 代码)**：
- `useStreamingText` 中的 `textBatcherRef` 配置参数（`textBatcherIntervalMs`, `textBatcherMaxChars`）实际上永不生效。
- 原因是 `useStreamingText.startRun()` 的 `onFrame` 直接调用 `onTextRef.current?.(frame.full)`，跳过了 `textBatcherRef`。
- 移除 `textBatcherRef` 相关的配置代码和 fallback 路径，简化组件。

**R5-T7 (generationMapRef 清理)**：
- 在 `useStreamCallbacks` 中添加 session 关闭/切换时的清理逻辑。
- 当 `activeSessionId` 变化时，检查 `generationMapRef` 中旧 session 的条目并在适当时机删除。
- 也可以定期清理（每 N 次 run 或定时器），遍历 Map 删除已过期/不活跃的 session 条目。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R5-T1 | `updateMessageText` 同时存储 `RenderFrame.html` 或 `chunkUpdates`；`MessageContent` 直接消费预解析 HTML，消除重复 markdown 解析 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`, `apps/crish-desktop/src/components/chat/MessageContent.tsx`, `apps/crish-desktop/src/api/StreamRenderBuffer.ts` | AG-05 |
| R5-T2 | 统一主聊天流与 agent 流的渲染管线入口，使用同一套 StreamRenderBuffer 参数 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`, `apps/crish-desktop/src/hooks/useStreamingText.ts`, `apps/crish-desktop/src/hooks/useAgentStream.ts` | AG-05 |
| R5-T3 | 大块无换行文本 UTF-8 安全截断：在 `flushFrame` 中使用 `TextDecoder` 感知字符边界 | `apps/crish-desktop/src/api/StreamRenderBuffer.ts:flushFrame` | AG-05 |
| R5-T4 | Worker 化增量 markdown 解析到 Web Worker | `apps/crish-desktop/src/api/incrementalMarkdownBridge.ts` | AG-05 |
| R5-T5 | 积压降级时在 store 中置 flag，UI 显示"加速中..."提示 | `apps/crish-desktop/src/api/StreamRenderBuffer.ts`, `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | AG-05 |
| R5-T6 | 清理 `useStreamingText` 中无效的 `textBatcherRef` 代码 | `apps/crish-desktop/src/hooks/useStreamingText.ts` | AG-05 |
| R5-T7 | `generationMapRef` 添加 session 关闭时的条目清理 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | AG-05 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R5-A | R5-T1 | `useStreamCallbacks.ts`, `MessageContent.tsx`, `StreamRenderBuffer.ts` |
| Agent R5-B | R5-T2 | `useStreamingText.ts`, `useAgentStream.ts`, `useStreamCallbacks.ts` |
| Agent R5-C | R5-T3 | `StreamRenderBuffer.ts` |
| Agent R5-D | R5-T4 | `incrementalMarkdownBridge.ts`（拆分 Worker） |
| Agent R5-E | R5-T5 | `StreamRenderBuffer.ts`, `useStreamCallbacks.ts` |
| Agent R5-F | R5-T6 | `useStreamingText.ts` |
| Agent R5-G | R5-T7 | `useStreamCallbacks.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `frame.html` 被存入 store 而非丢弃 | `rg 'frame\.html\|\.html' useStreamCallbacks.ts` | frame.html 被消费 |
| AC-2 | `MessageContent` 消费预解析 HTML | 读 `MessageContent.tsx` | 直接使用 html 而非重新 parseMarkdown |
| AC-3 | 主聊天流与 agent 流配置统一 | 比较两处 StreamRenderBuffer 参数 | 使用同一配置源 |
| AC-4 | UTF-8 安全截断 | `rg 'TextDecoder\|charBoundary\|isUTF8Start' StreamRenderBuffer.ts` | 感知字符边界 |
| AC-5 | Worker 化 | 存在 `incrementalMarkdownBridge.worker.ts` 或等价 | 解析在主线程外 |
| AC-6 | 降级 UI 提示 | `rg 'backlog\|degraded' useStreamCallbacks.ts` | 降级时 store flag 设置 |
| AC-7 | textBatcherRef 清理 | `rg 'textBatcherRef' useStreamingText.ts` | 仅必要引用 |

---

## Round 6：Layer A/C 架构偏差修正

**目标**：完成 ErrorClassifier 统一迁移，实现 ProviderRegistryV2.syncRoutes()，消除架构落地偏差。

**前置依赖**：Round 4（R4-A~R4-C 与 R6-T1/R6-T2 内容重叠可同步进行）

### 详细实现指南

**R6-T1~R6-T4 (ErrorClassifier 统一)**：
- 这些任务与 Round 4 的 R4-T1~R4-T3 内容重叠，实际执行时可合并。
- 统一原则：所有 Provider 相关的错误分类逻辑集中到 `ErrorClassifier.classify` 静态方法。
- 迁移完成后，`classifyProviderErrorMessage`（provider-openai-base.ts）可以被标记为 deprecated 或直接移除（在确认外部消费者全部迁移后）。
- `classifyProviderStreamErrorKind`（provider-stream-contract/error.ts）的独立 if/else 链替换为对 `ErrorClassifier.classify` 的单次调用 + 结果映射。
- 测试：确保所有错误分类场景（网络错误、超时、认证失败、限流、5xx 等）在迁移后分类结果与原来一致。

**R6-T5 (syncRoutes 实现)**：
- `ProviderRegistryV2.syncRoutes()` 需要将内部 `providerClasses` 和 `providerFactories` 的注册状态同步到路由目录。
- 实现方案：维护一个 `_dirty` 标志，在 `registerProviderClass()` 等注册方法中设为 true，`syncRoutes()` 检查 dirty 后执行同步。
- 同步逻辑：创建一个快照 Map，包含所有已注册 provider 的 id 和关联 engine class id，更新到 `StaticProviderRouteCatalog` 的对应方法。

**R6-T6 (ui-projections.ts 架构确认)**：
- 检查 `ui-projections.ts` 的内容，确认其边界职责是否与 workbench-contract 的领域划分一致。
- 如果其内容适合放置在计划中的其他子模块（如 `workbench-ui.ts` 或 `task-snapshot.ts`），则迁移合并。
- 如果它是独立的有价值模块，更新架构文档将其列入计划。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 依赖 | 来源报告 |
|--------|------|---------|------|---------|
| R6-T1 | 将 `session-loop/index.ts:255` 调用迁移到 ErrorClassifier.classify | `packages/agent-runtime/src/session-loop/index.ts:255` | — | AG-09 |
| R6-T2 | 将 `session-loop/types.ts:27` 调用迁移到 ErrorClassifier.classify | `packages/agent-runtime/src/session-loop/types.ts:27` | — | AG-09 |
| R6-T3 | 将 `provider-stream-contract/error.ts:42-61` 合并到 ErrorClassifier | `packages/agent-runtime/src/provider-stream-contract/error.ts` | — | AG-09 |
| R6-T4 | 将 `provider-stream-contract/normalizer.ts:50-57` 合并到 ErrorClassifier | `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` | — | AG-09 |
| R6-T5 | 实现 `ProviderRegistryV2.syncRoutes()` | `packages/agent-runtime/src/provider-registry-v2.ts` | — | AG-09 |
| R6-T6 | 确认 `ui-projections.ts` 作为 workbench-contract 子模块的合理性并更新架构文档 | `apps/agent-workbench/src/shared/workbench-contract/ui-projections.ts`, `docs/crish_desktop_architectural_remediation_plan/` | — | AG-09 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R6-A | R6-T1 | `session-loop/index.ts` |
| Agent R6-B | R6-T2 | `session-loop/types.ts` |
| Agent R6-C | R6-T3 | `provider-stream-contract/error.ts` |
| Agent R6-D | R6-T4 | `provider-stream-contract/normalizer.ts` |
| Agent R6-E | R6-T5 | `provider-registry-v2.ts` |
| Agent R6-F | R6-T6 | `ui-projections.ts`, 架构文档 |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | session-loop/index.ts 使用 ErrorClassifier.classify | `rg 'ErrorClassifier\.classify' session-loop/index.ts` | ≥1 匹配 |
| AC-2 | session-loop/types.ts 使用 ErrorClassifier.classify | `rg 'ErrorClassifier\.classify' session-loop/types.ts` | ≥1 匹配 |
| AC-3 | provider-stream-contract/error.ts 委托 ErrorClassifier | 读 `error.ts:classifyProviderStreamErrorKind` | 内部调用 ErrorClassifier |
| AC-4 | provider-stream-contract/normalizer.ts 委托 ErrorClassifier | 读 `normalizer.ts:classifyErrorMessage` | 内部调用 ErrorClassifier |
| AC-5 | syncRoutes() 有实现 | `rg 'syncRoutes' provider-registry-v2.ts` 排除注释 | 方法体非空 |
| AC-6 | 架构文档同步 | 读文档 | ui-projections.ts 被认可或移除 |

---

## Round 7：Layer D/E 架构偏差修正

**目标**：修复 `sessionActions.ts` 破损路径问题，将 `layoutStore.ts` 接入 4 个 slice 工厂，拆分超标文件。

**前置依赖**：Round 1（R1-T5）

### 详细实现指南

**R7-T1 (sessionActions 废弃迁移)**：
- 当前状态：两个并行实现——`sessionActions.ts`（旧路径，引用了不存在的 `./actions/*`）和 `session-actions/index.ts`（新路径，功能完整但无消费者）。
- 迁移步骤：
  1. 确认 `session-actions/` 下的 6 个子工厂（session-crud, message-actions, tool-actions, agent-actions, session-ordering, session-patch）功能覆盖了 `sessionActions.ts` 中所有被消费的 action。
  2. 将 `sessionStore.ts:14` 的 import 从 `'./sessionActions'` 改为 `'./session-actions'`。
  3. 将 `layoutStore.ts:49` 的 import 从 `'./sessionActions'` 改为 `'./session-actions'`。
  4. 更新 `sessionActions.test.ts:4` 的 import。
  5. 删除 `sessionActions.ts` 或在其中保留一个 barrel re-export from `'./session-actions'` 作为过渡。
  6. 检查所有其他文件是否还引用了 `sessionActions.ts`，确保无遗漏。

**R7-T2 (layoutStore 接入 slices)**：
- 当前 `layoutStore.ts:514` 行（超标 114 行），4 个 slice 文件（ui-slice, terminal-slice, permission-slice, diff-slice）已定义工厂函数但未被 layoutStore 使用。
- 接入步骤：
  1. 在 `layoutStore.ts` 顶部 import 四个 slice 的工厂函数：`createUiActions`, `createTerminalActions`, `createPermissionActions`, `createDiffActions`。
  2. 替换 layoutStore 中的内联状态定义，改为调用 slice 的 `createInitialXxxState()`。
  3. 替换 layoutStore 中的内联 action 实现，改为调用 slice 的 `createXxxActions(set, get)`。
  4. 将 layoutStore 的类型定义改为组合 slice 的接口类型。
  5. 目标：layoutStore.ts 行数从 514 降到 ≤400。

**R7-T3/R7-T4 (协议类型文件拆分)**：
- `protocol-inbound.ts`（537 行）和 `protocol-outbound.ts`（601 行）都超过了 400 行上限。
- 提取公共类型：创建一个 `types/common.ts` 文件，存放被两个文件共同引用的交叉类型。
- 可能的候选：`DaemonCorrelationFields`, `DaemonBaseMessage`, `WithCorrelation<T>`, 时间戳类型等。
- 对于每个单独的文件，如果提取 common 后行数仍超标，考虑进一步按消息类型分组拆分（如 `types/inbound-tool.ts`, `types/inbound-session.ts` 等）。

**R7-T5 (ui-selectors 拆分)**：
- `ui-selectors.ts` 当前 414 行，超过 300 行上限。
- 分析其导出的 selector 函数，按职责分组：
  - 布局相关的 selector（workspace 拆分、面板尺寸等）
  - 通用 UI 状态 selector（侧边栏、设置面板等）
- 拆分为 2-3 个子文件，每个 ≤300 行。
- 主 `index.ts` barrel 保持对外接口不变。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R7-T1 | 废弃 `sessionActions.ts`（旧路径），将所有消费者（`layoutStore.ts`, `sessionStore.ts`, `sessionActions.test.ts`）切换到 `session-actions/index.ts` | `apps/crish-desktop/src/store/sessionActions.ts`, `layoutStore.ts:49`, `sessionStore.ts:13-14`, `sessionActions.test.ts:4` | AG-10 |
| R7-T2 | 将 `layoutStore.ts` 接入 4 个 slice 工厂（ui-slice, terminal-slice, permission-slice, diff-slice），使 layoutStore.ts 行数降到 ≤400 | `apps/crish-desktop/src/store/layoutStore.ts`, `apps/crish-desktop/src/store/slices/*.ts` | AG-10 |
| R7-T3 | 拆分 `protocol-inbound.ts`（537→≤400）：将 `DaemonCorrelationFields` 等交叉类型提取到 `types/common.ts` | `packages/agent-daemon/src/types/protocol-inbound.ts` | AG-10 |
| R7-T4 | 拆分 `protocol-outbound.ts`（601→≤400）：将公共类型提取到 `types/common.ts` | `packages/agent-daemon/src/types/protocol-outbound.ts` | AG-10 |
| R7-T5 | 拆分 `layout-helpers/ui-selectors.ts`（414→≤300） | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` | AG-10 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R7-A | R7-T1 | `sessionActions.ts`, `layoutStore.ts`, `sessionStore.ts`, `sessionActions.test.ts`, `session-actions/index.ts` |
| Agent R7-B | R7-T2 | `layoutStore.ts`, `slices/ui-slice.ts`, `slices/terminal-slice.ts`, `slices/permission-slice.ts`, `slices/diff-slice.ts` |
| Agent R7-C | R7-T3 | `protocol-inbound.ts`, `types/common.ts`（新建） |
| Agent R7-D | R7-T4 | `protocol-outbound.ts`, `types/common.ts` |
| Agent R7-E | R7-T5 | `ui-selectors.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `sessionActions.ts` 无消费者 | `rg "from.*sessionActions" --include '*.ts' apps/crish-desktop/src/store/` | 0 条（除 session-actions 外） |
| AC-2 | `session-actions/index.ts` 被消费者引用 | `rg "from.*session-actions" --include '*.ts' apps/crish-desktop/src/store/` | ≥2 条 |
| AC-3 | `layoutStore.ts` 行数 ≤ 400 | `wc -l layoutStore.ts` | ≤400 |
| AC-4 | `layoutStore.ts` import slice 工厂 | `rg "from.*slices/" layoutStore.ts` | ≥4 条 import |
| AC-5 | `protocol-inbound.ts` 行数 ≤ 400 | `wc -l protocol-inbound.ts` | ≤400 |
| AC-6 | `protocol-outbound.ts` 行数 ≤ 400 | `wc -l protocol-outbound.ts` | ≤400 |
| AC-7 | `ui-selectors.ts` 行数 ≤ 300 | `wc -l ui-selectors.ts` | ≤300 |

---

## Round 8：Layer H/I 架构偏差修正

**目标**：消除 ToolHook 接口类型漂移，同步文档，清理废弃中间件，修复 CI 配置缺失。

**前置依赖**：无

### 详细实现指南

**R8-T1 (ToolHook 类型漂移修复)**：
- `tool-hook-observability.ts:17-21` 重新声明了 `ToolHook` 接口，而非从 `tool-hook-types.ts` 导入。
- 差异点：返回类型不同（全部 `unknown` vs 具体类型）、上下文不同（`ToolHookContext` vs `ToolExecutionContext`）。
- 修复：删除 `tool-hook-observability.ts` 中的独立声明，改为 `import { ToolHook } from './tool-hook-types'`。
- 调整 `ToolHookObserver` 的方法签名，使用 `ToolExecutionContext` 替代自有的 `ToolHookContext`。

**R8-T2/R8-T5 (规划文档同步)**：
- `08_tool_hook_chain.md §4.2` 更新：将 ToolHook 接口从 6 方法（beforeRegister / beforeResolve / beforeApprove / beforeExecute / afterExecute / onError）更新为实际的 3 方法（beforeExecute / onResult / onError）。
- 新增章节说明方法精简的设计理由和合并逻辑。
- §4.3 ApprovelPipeline 文档补充：当前实际实现仅 3 阶段（policy decide → cache → handler），增加演进路径说明未来如何扩展到 5 阶段（+ auto-classifier + denial-tracker）。

**R8-T3 (middleware-pipeline 废弃计划)**：
- `middleware-pipeline.ts` 已标记 `@deprecated`，但仍有完整的功能性实现。
- 在头注释中增加目标移除版本号（如 `@removeWhen v2.0`）。
- 搜索全仓库确认无外部消费者引用后，制定具体的移除时间表。

**R8-T4 (depcruise 配置统一)**：
- 当前两份配置并存：`.dependency-cruiser.js`（旧，severity: error）和 `.dependency-cruiser.cjs`（CI 实际使用，severity: warn）。
- 方案 A：删除 `.dependency-cruiser.js`，仅保留 `.cjs`。
- 方案 B：统一为单个配置文件，更新 CI 引用路径。
- 推荐方案 A，因为 `.cjs` 是 CI 实际使用的文件。

**R8-T6 (ToolPreset 默认值对齐)**：
- 当前 `plan` mode 的 toolIds 比规划文档多 3 个工具（glob/grep/list_files），还有 `categoryFilter: ["filesystem"]`。
- 方案 A（严格对齐）：将 plan mode 缩减为仅 `["read_files", "search_codebase"]`，与规划文档一致。
- 方案 B（文档同步）：更新规划文档承认实际 toolIds，记录理由（plan 模式下需要基本的文件系统探索能力）。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R8-T1 | 将 `tool-hook-observability.ts:17-21` 的接口改为从 `tool-hook-types.ts` 导入，消除类型漂移 | `packages/agent-runtime/src/hooks/tool-hook-observability.ts`, `packages/agent-runtime/src/hooks/tool-hook-types.ts` | AG-11 |
| R8-T2 | 同步 `08_tool_hook_chain.md` 规划文档：将 §4.2 的 6 方法更新为 3 方法及实际签名 | `docs/crish_desktop_architectural_remediation_plan/08_tool_hook_chain.md` | AG-11 |
| R8-T3 | 制定 `middleware-pipeline.ts` 的移除计划（设目标版本号） | `packages/agent-runtime/src/hooks/middleware-pipeline.ts` | AG-11 |
| R8-T4 | 删除 `.dependency-cruiser.js` 或统一为 `.dependency-cruiser.cjs` | `.dependency-cruiser.js`, `.dependency-cruiser.cjs` | AG-11 |
| R8-T5 | 同步文档补充 3→5 阶段 ApprovalPipeline 的演进路径 | `docs/crish_desktop_architectural_remediation_plan/08_tool_hook_chain.md` | AG-11 |
| R8-T6 | 更新 `ToolPresetRegistry` 预设默认值与规划文档对齐（plan mode 仅保留 `read_files` + `search_codebase`） | `packages/agent-runtime/src/tool-preset-registry.ts`, 规划文档 | AG-11 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R8-A | R8-T1 | `tool-hook-observability.ts`, `tool-hook-types.ts` |
| Agent R8-B | R8-T2 + R8-T5 | `08_tool_hook_chain.md` |
| Agent R8-C | R8-T3 | `middleware-pipeline.ts` |
| Agent R8-D | R8-T4 | `.dependency-cruiser.js`, `.dependency-cruiser.cjs` |
| Agent R8-E | R8-T6 | `tool-preset-registry.ts`, 规划文档 |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `tool-hook-observability.ts` 从 types 导入 ToolHook | `rg "from.*tool-hook-types" tool-hook-observability.ts` | import 存在 |
| AC-2 | ToolHook 方法签名与 types 一致 | `rg "beforeExecute\|onResult\|onError" tool-hook-observability.ts` 返回类型 | 与 types 匹配 |
| AC-3 | 规划文档 §4.2 更新为 3 方法 | 读文档 | 方法数 = 3 |
| AC-4 | middleware-pipeline.ts 有移除目标版本 | 读头注释 | 含目标版本号 |
| AC-5 | 仅保留一个 depcruise 配置文件 | `ls .dependency-cruiser.*` | 仅 1 个 |
| AC-6 | ToolPreset 默认值与文档一致 | 比较 plan mode 的 toolIds | 对齐 |

---

## Round 9：Layer F/G/J 架构偏差修正

**目标**：清理 ChatProviderGuard/ChatCheckpointActions 死代码，补全 F-2g dirty guard，修复 FauxAgentProvider 接口契约。

**前置依赖**：无

### 详细实现指南

**R9-T1 (ChatProviderGuard 集成或清除)**：
- `ChatProviderGuard` 组件已提取了 provider 检测逻辑，但 `ChatCard` 在使用时 duplicate 了 `fetchEngineStatus` / `applyResolvedModelLabel` / `hydrateTimedOut` 等逻辑。
- 方案 A（推荐）：在 `ChatCard` 中使用 `ChatProviderGuard`，移除内联的 provider 检测逻辑。
- 方案 B：将 `ChatProviderGuard` 的内容合并回 `ChatCard`，删除独立组件文件。
- 两种方案都消除了死代码状态。

**R9-T2 (ChatCheckpointActions 集成或清除)**：
- `ChatCheckpointActions` 是空壳 stub（仅 returns null），checkpoint/rollback 逻辑未从 `ChatCard` 移入。
- 方案 A：实现 checkpoint/rollback 逻辑，在 `ChatCard` 中使用此组件。
- 方案 B：删除 `ChatCheckpointActions.tsx` 文件，确认 `ChatCard` 无引用。
- 如果 checkpoint 功能尚未实现，选择方案 B 并在 TODO 中记录。

**R9-T3/R9-T4 (F-2g dirty navigation guard)**：
- `useFileNavigation.ts` 缺少 `isDirty()` 和 `confirmNavigation(): Promise<boolean>` 方法。
- 在当前 navigation 回调之前，添加 dirty 状态检查逻辑：
  ```typescript
  if (dirty) {
    const confirmed = await confirmNavigation();
    if (!confirmed) return;
  }
  ```
- `useFilePreview.ts` 已有 `dirty` 状态，但缺少 `onDirtyChange` 回调暴露。
- 在 `useFilePreview` 的返回值中添加 `onDirtyChange?: (dirty: boolean) => void` 参数。

**R9-T5/R9-T6 (FauxAgentProvider 接口统一)**：
- 当前 `FauxAgentProvider` 使用 `Pick<AgentProvider, "id">` 而非 `implements AgentProvider`，当 `AgentProvider` 接口变更时不报类型错误。
- 修复：改为 `implements AgentProvider`，补齐 `stream(request)` 和 `id` 以外的所有必需方法。
- 统一 `testing/faux-provider.ts` 和 `provider/faux-provider.ts` 的接口契约：两者都实现 `AgentProvider` 接口，减少重复。

**R9-T7 (globalSetup 补全API Key)**：
- 在 `vitest.globalSetup.ts` 的 `PROVIDER_API_KEYS` 数组中追加 `'CRISH_API_KEY'` 和 `'FLOWBIT_API_KEY'`。
- 对 `CONEX_API_KEY_` prefix 的通配清除：使用 startsWith 检查，删除所有以 `CONEX_API_KEY_` 开头的环境变量。
- 注意 `teardown` 函数中也要对应恢复这些 key。

**R9-T8 (useEffect 顺序重排)**：
- 按规划文档的 12 个 useEffect 顺序调整 `AppBootstrap.ts` 中的 effect 排列。
- 当前偏差：AUTO_FOLD_DELAY、document.title、initLayoutStorePersistence、bootstrapServices、crash、bootstrapStores 的顺序均与规划不一致。
- 调整后所有 effect 保持 `[]` 空依赖，不影响 React Strict Mode 的 re-execution。
- 注意 `useLayoutEffect`（#8 project rebind）需要 DOM 就绪，保持在靠前位置。

**R9-T9 (useAppKeyboard 拆分)**：
- 当前 190 行，超过 120 行上限。
- 按键盘快捷键的功能域拆分为 2 个子模块：导航快捷键、编辑快捷键。
- 主文件成为 barrel，子文件各 ≤120 行。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R9-T1 | 在 `ChatCard` 中集成使用 `ChatProviderGuard`，或将重复逻辑合并后删除 `ChatProviderGuard` | `apps/crish-desktop/src/components/chat/ChatProviderGuard.tsx`, `apps/crish-desktop/src/components/chat/ChatCard.tsx` | AG-12 |
| R9-T2 | 在 `ChatCard` 中集成使用 `ChatCheckpointActions`，或实现 checkpoint/rollback 逻辑后删除 stub | `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx`, `apps/crish-desktop/src/components/chat/ChatCard.tsx` | AG-12 |
| R9-T3 | 补全 `useFileNavigation` 的 `isDirty`/`confirmNavigation` guard | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` | AG-12 |
| R9-T4 | 补全 `useFilePreview` 的 `onDirtyChange` 回调暴露 | `apps/crish-desktop/src/components/files/hooks/useFilePreview.ts` | AG-12 |
| R9-T5 | 将 `FauxAgentProvider` 从 `Pick<AgentProvider, "id">` 改为 `implements AgentProvider` | `packages/agent-runtime/src/testing/faux-provider.ts` | AG-12 |
| R9-T6 | 统一 `FauxAgentProvider`（testing/）与 `FauxProvider`（provider/）的接口契约 | `packages/agent-runtime/src/testing/faux-provider.ts`, `packages/agent-runtime/src/provider/faux-provider.ts` | AG-12 |
| R9-T7 | 补全 `vitest.globalSetup.ts` 中缺失的 `CRISH_API_KEY`, `FLOWBIT_API_KEY` 以及 `CONEX_API_KEY_` prefix 清除 | `vitest.globalSetup.ts` | AG-12 |
| R9-T8 | 将 `AppBootstrap.ts` 中的 useEffect 按规划文档顺序排列 | `apps/crish-desktop/src/app/AppBootstrap.ts` | AG-12 |
| R9-T9 | 拆分 `useAppKeyboard.ts`（190 行→≤120） | `apps/crish-desktop/src/hooks/useAppKeyboard.ts` | AG-12 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R9-A | R9-T1 | `ChatProviderGuard.tsx`, `ChatCard.tsx` |
| Agent R9-B | R9-T2 | `ChatCheckpointActions.tsx`, `ChatCard.tsx` |
| Agent R9-C | R9-T3 + R9-T4 | `useFileNavigation.ts`, `useFilePreview.ts` |
| Agent R9-D | R9-T5 + R9-T6 | `faux-provider.ts`（testing + provider） |
| Agent R9-E | R9-T7 | `vitest.globalSetup.ts` |
| Agent R9-F | R9-T8 | `AppBootstrap.ts` |
| Agent R9-G | R9-T9 | `useAppKeyboard.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `ChatProviderGuard` 被 ChatCard 导入并使用 | `rg "ChatProviderGuard" ChatCard.tsx` | 存在引用和使用 |
| AC-2 | `ChatCheckpointActions` 被使用或删除 | `rg "ChatCheckpointActions" ChatCard.tsx` | 引用且使用（或删除） |
| AC-3 | `useFileNavigation` 有 `confirmNavigation` | `rg "confirmNavigation\|isDirty" useFileNavigation.ts` | 方法存在 |
| AC-4 | `useFilePreview` 有 `onDirtyChange` | `rg "onDirtyChange" useFilePreview.ts` | 回调存在 |
| AC-5 | `FauxAgentProvider` implements AgentProvider | 读 `faux-provider.ts` 首行 | `implements AgentProvider` |
| AC-6 | `CRISH_API_KEY` 在 globalSetup 中 | `rg "CRISH_API_KEY" vitest.globalSetup.ts` | 存在 |
| AC-7 | `CONEX_API_KEY_` prefix 清除 | `rg "CONEX_API_KEY" vitest.globalSetup.ts` | 通配清除 |
| AC-8 | useEffect 顺序按文档排列 | 读 `AppBootstrap.ts` | 与规划文档一致 |
| AC-9 | `useAppKeyboard.ts` 行数 ≤ 120 | `wc -l useAppKeyboard.ts` | ≤120 |

---

## Round 10：CI/CD Pipeline 与构建配置

**目标**：创建 CI workflow，修复 Cargo.toml lints 继承缺失，补充 CI 门禁全项。

**前置依赖**：无

### 详细实现指南

**R10-T1 (创建 ci.yml)**：
- 在 `.github/workflows/ci.yml` 创建完整 CI 工作流，内容包含：
  - `name: CI`
  - `on: [push, pull_request]`（带 paths-ignore）
  - `concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true`
  - `permissions: contents: read`
  - jobs:
    - `typecheck`: `turbo run typecheck` → 覆盖所有 8 个 package
    - `lint`: `npm run lint:all`（已配置 --max-warnings 0）
    - `depcruise`: `npx depcruise --config .dependency-cruiser.cjs packages apps --ignore "dist/"`
    - `test`: `npm test`
    - `test:integration`: `npm run test:integration`
    - `audit`: `npm audit --audit-level=moderate`
    - `cargo-deny`: `cargo deny check`
    - `secret-scanning`: `gitleaks detect` 或 `trufflehog filesystem .`
- Rust 构建检查作为可选步骤。

**R10-T2/R10-T3 (Cargo.toml lints)**：
- 在两个文件的 `[package]` 段后添加：
  ```toml
  [lints]
  workspace = true
  ```
- 确认根 `Cargo.toml` 的 `[workspace.lints.clippy]` 已正确定义规则。

**R10-T4 (密钥扫描)**：
- 在 ci.yml 中新增 job：`secret-scanning`。
- 使用 `gitleaks`（推荐，更轻量）或 `trufflehog`。
- 示例步骤：
  ```yaml
  - name: Secret scanning
    uses: gitleaks/gitleaks-action@v2
  ```

**R10-T5/R10-T10 (typecheck:ci 全覆盖)**：
- 在 `package.json` 中添加脚本：
  ```json
  "typecheck:ci": "turbo run typecheck"
  ```
- 确保每个 workspace package 的 `package.json` 定义了 `typecheck` 脚本为 `tsc --noEmit`。
- CI 中运行时：`npm run typecheck:ci`。

**R10-T6 (turbo 集成)**：
- 验证 `turbo.json` 已定义 `typecheck`、`build`、`test` pipeline。
- CI 中使用 `npx turbo run typecheck build test` 替代直接调用 npm 脚本。
- 利用 turbo 的缓存和并行执行加速 CI。

**R10-T7 (paths-ignore)**：
- 在 workflow 的 `on.push.paths-ignore` 中添加：
  - `docs/**` — 文档变更不需要 CI
  - `*.md` — markdown 文件变更不需要 CI
  - `assets/**` — 静态资源变更不需要 CI
- 使用 Paths-ignore 减少不必要的 CI 触发。

**R10-T8 (concurrency 控制)**：
- 在 workflow 级别添加：
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
- 确保同一分支的多个 push 只运行最新的 CI，取消正在运行中的旧 CI。

**R10-T9 (permissions 最小化)**：
- 在 workflow 级别添加：
  ```yaml
  permissions:
    contents: read
  ```
- 遵循最小权限原则，CI 不需要写入权限。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R10-T1 | 创建 `.github/workflows/ci.yml` 包含 concurrency 控制、permissions 最小化、paths-ignore、turbo 缓存、typecheck:ci 全覆盖 | `.github/workflows/ci.yml`（新建） | AG-07, AG-11 |
| R10-T2 | 添加 `[lints] workspace = true` 到 `apps/agent-workbench/src-tauri/Cargo.toml` | `apps/agent-workbench/src-tauri/Cargo.toml` | AG-07 |
| R10-T3 | 添加 `[lints] workspace = true` 到 `packages/agent-provider-http/Cargo.toml` | `packages/agent-provider-http/Cargo.toml` | AG-07 |
| R10-T4 | CI 中添加密钥扫描 job（gitleaks/trufflehog） | `.github/workflows/ci.yml` | AG-11 |
| R10-T5 | CI 中添加 `typecheck:ci` 脚本覆盖全部 8 个 workspace package 的 `tsc --noEmit` | `package.json`, `.github/workflows/ci.yml` | AG-11 |
| R10-T6 | CI 中使用 `turbo run typecheck build test` 替代直接命令 | `.github/workflows/ci.yml` | AG-11 |
| R10-T7 | CI 中添加 `paths-ignore: ['docs/**', '*.md', 'assets/**']` | `.github/workflows/ci.yml` | AG-11 |
| R10-T8 | CI 中添加 `concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true` | `.github/workflows/ci.yml` | AG-11 |
| R10-T9 | CI 中添加 `permissions: contents: read` | `.github/workflows/ci.yml` | AG-11 |
| R10-T10 | 在 `package.json` 中补充 `typecheck:ci` 脚本 | `package.json` | AG-11 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R10-A | R10-T1 + R10-T4 + R10-T6 + R10-T7 + R10-T8 + R10-T9 | `.github/workflows/ci.yml` |
| Agent R10-B | R10-T2 + R10-T3 | `Cargo.toml` × 2 |
| Agent R10-C | R10-T5 + R10-T10 | `package.json` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | `.github/workflows/ci.yml` 存在 | `Test-Path .github/workflows/ci.yml` | 文件存在 |
| AC-2 | 两个 Cargo.toml 含 `[lints] workspace = true` | `rg '\[lints\]' -A 2 apps/agent-workbench/src-tauri/Cargo.toml packages/agent-provider-http/Cargo.toml` | 都存在 |
| AC-3 | CI 含密钥扫描 job | `rg 'gitleaks\|trufflehog' .github/workflows/ci.yml` | 匹配 |
| AC-4 | CI 含 typecheck 全覆盖 | `rg 'typecheck' .github/workflows/ci.yml` | 匹配 |
| AC-5 | CI 含 turbo run | `rg 'turbo' .github/workflows/ci.yml` | 匹配 |
| AC-6 | CI 含 concurrency 控制 | `rg 'concurrency' .github/workflows/ci.yml` | 匹配 |
| AC-7 | CI 含 permissions | `rg 'permissions' .github/workflows/ci.yml` | 匹配 |
| AC-8 | CI 含 paths-ignore | `rg 'paths-ignore' .github/workflows/ci.yml` | 匹配 |

---

## Round 11：测试基础设施强化

**目标**：为缺失关键的组件补充单元测试，补全 globalSetup 环境变量覆盖，强化 FauxAgentProvider 测试替身。

**前置依赖**：Round 4（R4-T7）、Round 9（R9-T5/R9-T6/R9-T7）

### 详细实现指南

**R11-T1 (StreamRenderBuffer 测试)**：
- 新建 `StreamRenderBuffer.test.ts`。
- 测试场景：
  1. 基本 push/flush：验证分帧行为在预期帧边界触发。
  2. 积压降级：当 bufferedLength > maxBacklogBytes 时验证 `onFrame` 被跳过，`onComplete` 强制 flush。
  3. maxBytesPerFrame 边界：在边界处正确分割。
  4. UTF-8 安全截断（与 R5-T3 配合验证）。
  5. 重置后状态清除。

**R11-T2 (useChatApproval 测试)**：
- 新建 `useChatApproval.test.ts`。
- 使用 `@testing-library/react-hooks` 或 React 测试框架渲染 hook。
- 测试场景：
  1. 竞态守卫：多个审批请求的并发处理。
  2. 审批超时是否正确触发回调。
  3. 代际计数器覆盖后的行为。

**R11-T3 (useFileNavigation 测试)**：
- 新建 `useFileNavigation.test.ts`。
- 测试场景：
  1. `isDirty` 状态正确返回。
  2. `confirmNavigation` 在 dirty 模式下弹出确认。
  3. 导航在 confirm=true 时执行，confirm=false 时取消。

**R11-T4 (FauxAgentProvider 测试)**：
- 新建 `faux-provider.test.ts`。
- 测试场景：
  1. `setEvents` → `stream()` 返回对应事件序列。
  2. `setError` → `stream()` 抛出指定错误。
  3. `setLatency` → 事件间隔有相应延迟。
  4. `setFailAfter(n)` → 第 n 次后失败。
  5. `reset()` → 清除所有状态。

**R11-T5/R11-T6 (FauxCallGateway/MockTool 测试)**：
- 新建 `faux-call-gateway.test.ts` 和 `mock-tool.test.ts`。
- 验证 FauxCallGateway 模拟的 gateway 调用链行为。
- 验证 MockTool 模拟工具执行的行为。

**R11-T7 (error-classifier 测试补充)**：
- 在 `error-classifier.test.ts` 中补充测试用例覆盖：
  - 各类网络错误消息识别。
  - 各类 HTTP 状态码映射。
  - 超时消息识别。
  - 认证错误消息识别。
  - `retryable` 字段在各种场景下的正确性。
  - 边界情况：空消息、非标准错误格式。

**R11-T8 (TypeScript 覆盖率阈值)**：
- 在 `vitest.config.ts` 中为 TypeScript 代码添加 coverage threshold 配置：
  ```typescript
  coverage: {
    thresholds: {
      statements: 50,
      branches: 40,
      functions: 50,
      lines: 50,
    }
  }
  ```
- 参考 Rust 侧的覆盖率模式，在 `package.json` 中添加 `test:coverage` 脚本。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R11-T1 | 为 `StreamRenderBuffer` 的降级路径编写单元测试 | `apps/crish-desktop/src/api/StreamRenderBuffer.test.ts`（新建） | AG-05, AG-12 |
| R11-T2 | 为 `useChatApproval` 竞态守卫编写单元测试 | `apps/crish-desktop/src/components/chat/hooks/useChatApproval.test.ts`（新建） | AG-12 |
| R11-T3 | 为 `useFileNavigation` dirty guard 编写单元测试 | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.test.ts`（新建） | AG-12 |
| R11-T4 | 为 `FauxAgentProvider` 编写单元测试（测试 setEvents/setError/setLatency/setFailAfter/stream 路径） | `packages/agent-runtime/src/testing/faux-provider.test.ts`（新建） | AG-12 |
| R11-T5 | 为 `FauxCallGateway` 编写单元测试 | `packages/agent-runtime/src/testing/faux-call-gateway.test.ts`（新建） | AG-12 |
| R11-T6 | 为 `MockTool` 编写单元测试 | `packages/agent-runtime/src/testing/mock-tool.test.ts`（新建） | AG-12 |
| R11-T7 | 为 `error-classifier.ts` 补充分类测试用例 | `packages/agent-runtime/src/error-classifier.test.ts`（新建或补充） | AG-03 |
| R11-T8 | TypeScript 侧添加覆盖率阈值验证 | `vitest.config.ts`, `package.json` | AG-11 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R11-A | R11-T1 | `StreamRenderBuffer.test.ts` |
| Agent R11-B | R11-T2 | `useChatApproval.test.ts` |
| Agent R11-C | R11-T3 | `useFileNavigation.test.ts` |
| Agent R11-D | R11-T4 | `faux-provider.test.ts` |
| Agent R11-E | R11-T5 + R11-T6 | `faux-call-gateway.test.ts`, `mock-tool.test.ts` |
| Agent R11-F | R11-T7 | `error-classifier.test.ts` |
| Agent R11-G | R11-T8 | `vitest.config.ts`, `package.json` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | StreamRenderBuffer 降级路径测试 | `vitest run StreamRenderBuffer.test.ts` | 通过 |
| AC-2 | useChatApproval 测试 | `vitest run useChatApproval.test.ts` | 通过 |
| AC-3 | useFileNavigation dirty guard 测试 | `vitest run useFileNavigation.test.ts` | 通过 |
| AC-4 | FauxAgentProvider 测试 | `vitest run faux-provider.test.ts` | 通过 |
| AC-5 | FauxCallGateway + MockTool 测试 | `vitest run faux-call-gateway.test.ts mock-tool.test.ts` | 通过 |
| AC-6 | error-classifier 测试覆盖 | `vitest run error-classifier.test.ts` | 包含各类别 |
| AC-7 | TypeScript 覆盖率阈值 | `rg 'coverage.*threshold\|thresholds' vitest.config.ts` | 配置存在 |
| AC-8 | 全部新增测试通过 | `npm run test` | 无失败 |

---

## Round 12：安全残留与代码清理

**目标**：修复 process.rs 缺少 SAFETY 注释的安全合规问题，补充 CSP 尾缀安全性确认，最终验证所有 12 份报告已闭环。

**前置依赖**：Round 1~11 全部完成

### 详细实现指南

**R12-T1 (process.rs SAFETY 注释)**：
- `process.rs` 中存在 11 处 unsafe 块全部缺少 `// SAFETY:` 注释。
- 参考已修复的 `credentials.rs`（6 处 unsafe 全部有注释）的注释风格。
- 每处 `// SAFETY:` 注释应包含：
  - 为什么这里需要 unsafe（调用了哪个 FFI 函数？）。
  - 调用满足什么安全前置条件（参数有效性检查、指针非空、生命周期保证等）。
  - 引用相关的 Rust 安全文档或 MSDN 文档链接（如适用）。
- 11 处 unsafe 位置：
  1. L199: `GetCurrentProcess()` — 始终返回有效伪句柄，无需关闭。
  2. L204-213: `OpenProcess` / `CloseHandle` — handle 有效性检查和关闭。
  3. L217-236: `GetProcessMemoryInfo` — 缓冲区大小检查和初始化。
  4. L287-316: `CreateToolhelp32Snapshot` / `Process32FirstW` / `Process32NextW` — 快照句柄的创建和关闭。
  5. L701: `unsafe impl Send for DaemonJobHandle` — 确认 DaemonJobHandle 内部句柄是 Send 的。
  6. L704: `unsafe impl Sync for DaemonJobHandle` — 确认 DaemonJobHandle 内部句柄是 Sync 的。
  7. L716-738: `CreateJobObjectW` / `SetInformationJobObject` — 作业对象创建和配置。
  8. L746: `CloseHandle(dup)` — 重复句柄的关闭。
  9. L762-766: `AssignProcessToJobObject` — 进程分配到作业对象。
  10. L772-778: `setpgid` — POSIX 进程组设置（非 Windows）。
  11. L785-792: `killpg` — POSIX 进程组终止（非 Windows）。

**R12-T2 (CSP 尾缀安全性)**：
- 当前 CSP 中 `ws://127.0.0.1:` 尾随冒号无端口号，匹配 `ws://127.0.0.1:*` 语义。
- 验证：在浏览器中测试 `ws://127.0.0.1:随机端口` 的连接是否被 CSP 允许。
- 如果意图是允许所有本地端口的 WebSocket 连接，当前配置正确，无需修改。
- 如果需要更严格的限制，补全具体端口或端口范围。

**R12-T3 (classifyProviderErrorMessage 清理)**：
- 在确认 Round 4/Round 6 的外部消费者全部迁移到 `ErrorClassifier.classify` 后：
  - 移除 `provider-openai-base.ts:468` 的 `export function classifyProviderErrorMessage`。
  - 或至少标记为 `@deprecated` 并设置移除版本号。
  - 更新 `provider-openai-compatible.ts:61` 的 re-export。

**R12-T4 (middleware-pipeline 删除)**：
- 在确认全仓库无外部消费者引用 `middleware-pipeline.ts` 后：
  - 删除该文件。
  - 检查 `hook-factory.ts` 或类似文件中的 barrel export，移除对应的 re-export。
  - 检查是否有测试文件引用，一并进行清理。

**R12-T5/R12-T6 (全量回归验证)**：
- 对照 12 份审计报告的 checklist，逐项确认修复存在性：
  - AG-01：无冲突标记残留，无 UU 文件。
  - AG-02：5 个竞态漏洞已修复。
  - AG-03：错误透传路径完整，retryable 标记已传递，重试按钮已支持。
  - AG-04：配对保护已实现，appendMessages 原子化，类型对齐。
  - AG-05：重复 markdown 解析已消除，管线统一，UTF-8 安全截断。
  - AG-06：workbench_apply_update 已实现，IPC 路径完整。
  - AG-07：Cargo.toml lints 已补充，CI workflow 已创建。
  - AG-08：DOMPurify 已添加，process.rs SAFETY 已补充。
  - AG-09：ErrorClassifier 统一，syncRoutes 已实现。
  - AG-10：sessionActions 已迁移，layoutStore 已拆分。
  - AG-11：ToolHook 类型已修复，CI 配置完备。
  - AG-12：死代码已清理，测试已补充，FauxAgentProvider 已修复。
- 运行完整验证命令链：
  1. `npx tsc --noEmit`（或等价 typecheck）— 0 错误。
  2. `npm run lint:all` — 0 错误，0 warning。
  3. `npm test` — 全部通过。
  4. `npm run test:integration`（如果存在）— 全部通过。
  5. `npx depcruise --config .dependency-cruiser.cjs packages apps --ignore "dist/"` — 通过。

**R12-T7 (TelemetryMonitor 降级确认)**：
- 确认 `TelemetryMonitor.ts` 在非 Tauri 环境中的 invoke 调用有 try/catch 保护。
- 如果已使用 `invokeResult`（R3-T2 修复后），验证其降级行为。

**R12-T8 (withdrawMessage 配对保护)**：
- `message-actions.ts:87-107` 的 `withdrawMessage` 在 slice 消息数组时也需要考虑 tool-call + tool-result 配对。
- 当用户撤回一条消息时，如果该消息是 tool-call，其后一条消息如果是对应的 tool-result，应一并撤回。`

### 任务分解

| 任务ID | 内容 | 涉及文件 | 来源报告 |
|--------|------|---------|---------|
| R12-T1 | 为 `process.rs` 中 11 处 unsafe 块添加 `// SAFETY:` 注释 | `apps/agent-workbench/src-tauri/src/process.rs:L199,204-213,217-236,287-316,701,704,716-738,746,762-766,772-778,785-792` | AG-08 |
| R12-T2 | 验证 `ws://127.0.0.1:` CSP 尾缀缺端口安全含义，确认是否需补全端口 | `apps/crish-desktop/index.html:7` | AG-08 |
| R12-T3 | 移除 `provider-openai-base.ts` 中残留的 `classifyProviderErrorMessage` 导出（已是 ErrorClassifier wrapper，确认外部消费者是否完全迁移后移除） | `packages/agent-runtime/src/provider-openai-base.ts:468` | AG-09 |
| R12-T4 | 删除 `middleware-pipeline.ts`（确认无外部消费者后执行移除） | `packages/agent-runtime/src/hooks/middleware-pipeline.ts` | AG-11 |
| R12-T5 | 全量回归验证：对照 12 份审计报告 checklist 逐项确认修复 | 所有涉及文件 | AG-01~AG-12 |
| R12-T6 | 运行全量 typecheck + lint + test 确保无回归 | — | AG-01~AG-12 |
| R12-T7 | 确保 `TelemetryMonitor.ts` 非 Tauri 环境优雅降级 | `apps/crish-desktop/src/services/TelemetryMonitor.ts` | AG-06 |
| R12-T8 | 确保 `message-actions.ts` 中 `withdrawMessage` 的配对逻辑也符合配对保护原则 | `apps/crish-desktop/src/store/session-actions/message-actions.ts:87-107` | AG-04 |

### Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|---------|
| Agent R12-A | R12-T1 | `process.rs` |
| Agent R12-B | R12-T2 | `index.html` |
| Agent R12-C | R12-T3 | `provider-openai-base.ts` |
| Agent R12-D | R12-T4 | `middleware-pipeline.ts` |
| Agent R12-E | R12-T5 | 全仓库 |
| Agent R12-F | R12-T6 | — |
| Agent R12-G | R12-T7 | `TelemetryMonitor.ts` |
| Agent R12-H | R12-T8 | `message-actions.ts` |

### 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| AC-1 | process.rs 全部 11 处 unsafe 有 SAFETY 注释 | `rg 'unsafe' process.rs | Measure-Object | % { $_.Count }` = `rg '// SAFETY:' process.rs | Measure-Object | % { $_.Count }` | 数量一致 |
| AC-2 | CSP 端口尾缀安全确认 | 手动检查 | 确认为合理配置或已修复 |
| AC-3 | classifyProviderErrorMessage 已移除导出或确认仅测试引用 | `rg 'export function classifyProviderErrorMessage' provider-openai-base.ts` | 导出已移除或仅测试引用 |
| AC-4 | middleware-pipeline.ts 已删除 | `Test-Path middleware-pipeline.ts` | 不存在 |
| AC-5 | TelemetryMonitor 非 Tauri 降级 | 读 `TelemetryMonitor.ts` | try/catch 或 invokeResult |
| AC-6 | `npx tsc --noEmit` 通过 | `npx tsc --noEmit` | 0 错误 |
| AC-7 | `npm run lint` 通过 | `npm run lint:all` | 0 错误，0 warning |
| AC-8 | `npm test` 通过 | `npm test` | 全部通过 |
| AC-9 | 12 份报告无遗留未处理项 | 逐报告交叉检查 | 每份报告每个问题有对应任务ID或已在某轮覆盖 |

---

## 附录 A：问题-任务交叉索引矩阵

| 报告 | 问题摘要 | 所在轮次 | 任务ID |
|------|---------|---------|--------|
| AG-01 | CardPanel.tsx `=======` 冲突残留 | Round 1 | R1-T1 |
| AG-01 | 37 个 UU 文件 | Round 1 | R1-T2 |
| AG-02 | isAiBusy 竞态 | Round 2 | R2-T1, R2-T5 |
| AG-02 | cancelFn 闭包竞态 | Round 2 | R2-T2 |
| AG-02 | assertLive + myGen 时序窗口 | Round 2 | R2-T3, R2-T7 |
| AG-02 | ApprovalCache 跨 session 重放 | Round 1 | R1-T8 |
| AG-02 | ApprovalBridge/ApprovalQueue 双重超时 | Round 2 | R2-T4 |
| AG-03 | runtime-error 缺 retryable 字段 | Round 1 | R1-T11 |
| AG-03 | EventRouter 不处理 runtime-error | Round 1 | R1-T9 |
| AG-03 | EventRouter 不处理 provider-diagnostic | Round 1 | R1-T10 |
| AG-03 | 重试按钮缺失 | Round 2 | R2-T8 |
| AG-03 | streamWithRecovery 无退避 | Round 4 | R4-T4 |
| AG-03 | circuit-open 类型残留 | Round 4 | R4-T5 |
| AG-03 | tripsBreaker 字段残留 | Round 4 | R4-T6 |
| AG-03 | 测试文件命名不当 | Round 4 | R4-T7 |
| AG-04 | tool-result 无配对 tool-call | Round 1 | R1-T7 |
| AG-04 | appendMessages 部分成功静默 | Round 1 | R1-T6 |
| AG-04 | SessionStoreSlice 缺 truncatedToolChainIds | Round 1 | R1-T12 |
| AG-04 | ISessionStore 与 SessionStore 不匹配 | Round 3 | R3-T1 |
| AG-05 | 重复 markdown 解析 P0 | Round 5 | R5-T1 |
| AG-05 | 两套渲染管线不统一 | Round 5 | R5-T2 |
| AG-05 | UTF-8 截断不安全 | Round 5 | R5-T3 |
| AG-05 | Worker 化 markdown 解析 | Round 5 | R5-T4 |
| AG-05 | 积压降级 UI 提示 | Round 5 | R5-T5 |
| AG-05 | textBatcherRef 无用代码 | Round 5 | R5-T6 |
| AG-05 | generationMapRef 内存泄漏 | Round 5 | R5-T7 |
| AG-06 | workbench_apply_update 命令缺失 | Round 1 | R1-T3 |
| AG-06 | TelemetryMonitor 裸 invoke | Round 3 | R3-T2 |
| AG-06 | hello case 类型安全 | Round 3 | R3-T3 |
| AG-06 | 四端同步清单 | Round 3 | R3-T4 |
| AG-07 | Cargo.toml lints 缺失 × 2 | Round 10 | R10-T2, R10-T3 |
| AG-07 | CI workflow 缺失 | Round 10 | R10-T1 |
| AG-08 | MessageContent 无 DOMPurify | Round 1 | R1-T4 |
| AG-08 | process.rs unsafe 无 SAFETY 注释 | Round 12 | R12-T1 |
| AG-08 | CSP 尾缀缺端口 | Round 12 | R12-T2 |
| AG-09 | ErrorClassifier 未统一迁移 | Round 4/6 | R4-T1~R4-T3, R6-T1~R6-T4 |
| AG-09 | ProviderRegistryV2.syncRoutes stub | Round 4 | R4-T8 |
| AG-09 | ui-projections.ts 非计划 | Round 6 | R6-T6 |
| AG-10 | sessionActions.ts 破损 | Round 1 | R1-T5 |
| AG-10 | layoutStore.ts 未接入 slices | Round 7 | R7-T2 |
| AG-10 | protocol-inbound/outbound 超标 | Round 7 | R7-T3, R7-T4 |
| AG-10 | ui-selectors.ts 超标 | Round 7 | R7-T5 |
| AG-11 | ToolHook 类型漂移 | Round 8 | R8-T1 |
| AG-11 | 规划文档未同步 | Round 8 | R8-T2 |
| AG-11 | MiddlewarePipeline 未清除 | Round 8 | R8-T3/R12-T4 |
| AG-11 | depcruise 双配置 | Round 8 | R8-T4 |
| AG-11 | ApprovalPipeline 缺阶段 | Round 8 | R8-T5 |
| AG-11 | CI 缺失多项配置 | Round 10 | R10-T4~R10-T10 |
| AG-11 | 密钥扫描缺失 | Round 10 | R10-T4 |
| AG-12 | ChatProviderGuard 死代码 | Round 9 | R9-T1 |
| AG-12 | ChatCheckpointActions 死代码 | Round 9 | R9-T2 |
| AG-12 | F-2g dirty guard 缺失 | Round 9 | R9-T3, R9-T4 |
| AG-12 | FauxAgentProvider 接口不完整 | Round 9 | R9-T5, R9-T6 |
| AG-12 | globalSetup 缺失 API Key | Round 9 | R9-T7 |
| AG-12 | useEffect 顺序偏差 | Round 9 | R9-T8 |
| AG-12 | useAppKeyboard 超行 | Round 9 | R9-T9 |
| AG-12 | 测试覆盖缺失 | Round 11 | R11-T1~R11-T7 |

---

## 附录 B：跨轮次依赖关系图

```
Round 1 (致命阻断) ──────────────────┬────────────────────────────────
  │                                  │
  ├── R1-T5 → Round 7 (sessionActions)  ├── R1-T6/R1-T7 → Round 3 (Store)
  │                                  │
  ├── R1-T8 → Round 2 (ApprovalCache)   ├── R1-T9/R1-T10/R1-T11 → Round 2 (EventRouter)
  │
Round 2 (并发竞态) ───────────────────
  │
  ├── R2-T8 → Round 4 (重试按钮)
  │
Round 3 (Store/IPC)
  │
Round 4 (故障恢复) ── Round 6 (ErrorClassifier) ── 可并行
  │
Round 5 (渲染管线) ── 独立无依赖
  │
Round 6 (Layer A/C) ── 可并行（与 R4 部分重叠）
  │
Round 7 (Layer D/E) ── 依赖 R1-T5
  │
Round 8 (Layer H/I) ── 独立无依赖
  │
Round 9 (Layer F/G/J) ── 独立无依赖
  │
Round 10 (CI/CD) ── 独立无依赖
  │
Round 11 (测试) ── 依赖 R4-T7, R9-T5/R9-T6/R9-T7
  │
Round 12 (安全+验证) ── 依赖全部前序轮次完成
```

---

---

## 附录 C：全量任务汇总清单

| 轮次 | 任务数 | Agent 数 | 主要工作域 |
|------|--------|---------|-----------|
| Round 1 | 12 | 10 | 冲突修复、Tauri 命令缺失、XSS、sessionActions 破损、Store 完整性、认证缓存隔离、EventRouter、retryable 标记 |
| Round 2 | 8 | 6 | isAiBusy 竞态、cancelFn 闭包、myGen 原子性、ApprovalBridge 超时统一、generationMapRef 清理、retryable UI |
| Round 3 | 6 | 5 | ISessionStore 签名对齐、TelemetryMonitor 降级、protocol 类型安全、四端同步注释、queryRange 配对检查、前后端模型对齐 |
| Round 4 | 8 | 7 | ErrorClassifier 迁移(×3)、streamWithRecovery 退避、CircuitBreaker 残留清理(×2)、测试文件重命名、syncRoutes 实现 |
| Round 5 | 7 | 7 | 重复 markdown 解析消除、渲染管线统一、UTF-8 截断、Worker 化、积压降级提示、textBatcherRef 清理、generationMapRef 清理 |
| Round 6 | 6 | 6 | ErrorClassifier 统一(×4)、syncRoutes 实现、ui-projections 确认 |
| Round 7 | 5 | 5 | sessionActions 废弃迁移、layoutStore 接入 slices、协议文件拆分(×2)、ui-selectors 拆分 |
| Round 8 | 6 | 5 | ToolHook 类型漂移修复、规划文档同步(×2)、middleware-pipeline 废弃计划、depcruise 配置统一、ToolPreset 对齐 |
| Round 9 | 9 | 7 | ChatProviderGuard/ChatCheckpointActions 死代码、F-2g dirty guard、FauxAgentProvider 统一、globalSetup 补充、useEffect 顺序、useAppKeyboard 拆分 |
| Round 10 | 10 | 3 | ci.yml 创建(×6)、Cargo.toml lints(×2)、typecheck:ci 脚本、密钥扫描 |
| Round 11 | 8 | 7 | StreamRenderBuffer 测试、useChatApproval 测试、useFileNavigation 测试、FauxAgentProvider 测试、FauxCallGateway/MockTool 测试、error-classifier 测试补充、覆盖率阈值 |
| Round 12 | 8 | 8 | process.rs SAFETY 注释、CSP 验证、classifyProviderErrorMessage 清理、middleware-pipeline 删除、全量回归验证(×2)、TelemetryMonitor 降级确认、withdrawMessage 配对保护 |
| **合计** | **93** | **76** | **覆盖全部 12 份审计报告的所有问题** |

---

## 附录 D：48 个 UU 文件处理总清单

| # | 文件路径 | 状态 | 预计操作 |
|---|---------|------|---------|
| 1 | `apps/crish-desktop/src/App.tsx` | UU | git add |
| 2 | `apps/crish-desktop/src/api/performanceEngine.ts` | UU | git add |
| 3 | `apps/crish-desktop/src/components/CardPanel.tsx` | UU + 冲突 | 先修复再 git add |
| 4 | `apps/crish-desktop/src/components/ChatCard.tsx` | UU | git add |
| 5 | `apps/crish-desktop/src/components/ChatEmptyState.tsx` | UU | git add |
| 6 | `apps/crish-desktop/src/components/ChatHeaderMore.tsx` | UU | git add |
| 7 | `apps/crish-desktop/src/components/ChatMessageList.tsx` | UU | git add |
| 8 | `apps/crish-desktop/src/components/ChatMessageRow.tsx` | UU | git add |
| 9 | `apps/crish-desktop/src/components/ChatToolCallBlock.tsx` | UU | git add |
| 10 | `apps/crish-desktop/src/components/ProjectPickerMenu.tsx` | UU | git add |
| 11 | `apps/crish-desktop/src/components/SettingsExtensionsTab.tsx` | UU | git add |
| 12 | `apps/crish-desktop/src/components/Sidebar.tsx` | UU | git add |
| 13 | `apps/crish-desktop/src/components/Workspace.tsx` | UU | git add |
| 14 | `apps/crish-desktop/src/components/WorkspaceChromeBars.tsx` | UU | git add |
| 15 | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.tsx` | UU | git add |
| 16 | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx` | UU | git add |
| 17 | `apps/crish-desktop/vite.config.ts` | UU | git add |
| 18 | `packages/agent-daemon/src/capabilities.ts` | UU | git add |
| 19 | `packages/agent-daemon/src/daemon-provider-gateway.test.ts` | UU | git add |
| 20 | `packages/agent-daemon/src/daemon-provider-gateway.ts` | UU | git add |
| 21 | `packages/agent-daemon/src/handlers/run-handlers.ts` | UU | git add |
| 22 | `packages/agent-daemon/src/protocol/protocol.ts` | UU | git add |
| 23 | `packages/agent-daemon/src/protocol/registry.test.ts` | UU | git add |
| 24 | `packages/agent-daemon/src/protocol/validators/common.ts` | UU | git add |
| 25 | `packages/agent-daemon/src/protocol/validators/run.ts` | UU | git add |
| 26 | `packages/agent-daemon/src/server-handlers.ts` | UU | git add |
| 27 | `packages/agent-daemon/src/server-runtime-factory.test.ts` | UU | git add |
| 28 | `packages/agent-daemon/src/server-runtime-factory.ts` | UU | git add |
| 29 | `packages/agent-daemon/src/server.ts` | UU | git add |
| 30 | `packages/agent-daemon/src/types.ts` | UU | git add |
| 31 | `packages/agent-orchestrator/src/orchestrator.ts` | UU | git add |
| 32 | `packages/agent-runtime/src/agent-session-loop.ts` | UU | git add |
| 33 | `packages/agent-runtime/src/context-projection.ts` | UU | git add |
| 34 | `packages/agent-runtime/src/plugin-fs-registry.ts` | UU | git add |
| 35 | `packages/agent-runtime/src/provider-anthropic.ts` | UU | git add |
| 36 | `packages/agent-runtime/src/provider-gemini.ts` | UU | git add |
| 37 | `packages/agent-runtime/src/runtime-helpers.ts` | UU | git add |

> 备注：仅 `CardPanel.tsx` 需要冲突修复，其余 36 个 UU 文件无实际冲突标记，可直接 `git add`。

---

## 附录 E：CI workflow 参考模板

```yaml
name: CI
on:
  push:
    paths-ignore:
      - 'docs/**'
      - '*.md'
      - 'assets/**'
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '*.md'
      - 'assets/**'

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx turbo run typecheck

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run lint:all
      - run: npm run lint:depcruise

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm test
      - run: npm run test:integration

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm audit --audit-level=moderate

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gitleaks/gitleaks-action@v2

  cargo-deny:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rs/toolchain@v1
        with: { toolchain: stable }
      - run: cargo deny check
```

---

## 附录 F：审计报告验收检查表

以下 checklist 用于 Round 12 最终验收（R12-T5/R12-T6）：

| 报告 | 检查项 | 任务参照 | 完成? |
|------|--------|---------|-------|
| AG-01 | 无 `=======`/`<<<<<<<`/`>>>>>>>` 残留 | R1-T1, R1-T2 | □ |
| AG-01 | git status 无 UU 文件 | R1-T2 | □ |
| AG-02 | isAiBusy 改用 streamManagerRef | R2-T1, R2-T5 | □ |
| AG-02 | cancelFn 改为 ref 延迟赋值 | R2-T2 | □ |
| AG-02 | myGen 二次校验 | R2-T3, R2-T7 | □ |
| AG-02 | ApprovalCache 含 sessionId | R1-T8 | □ |
| AG-02 | ApprovalBridge/ApprovalQueue 超时统一 | R2-T4 | □ |
| AG-03 | runtime-error 含 retryable | R1-T11 | □ |
| AG-03 | EventRouter 处理 runtime-error | R1-T9 | □ |
| AG-03 | EventRouter 处理 provider-diagnostic | R1-T10 | □ |
| AG-03 | 前端支持重试按钮 | R2-T8 | □ |
| AG-03 | streamWithRecovery 退避 | R4-T4 | □ |
| AG-03 | circuit-open 类型已移除 | R4-T5 | □ |
| AG-03 | tripsBreaker 已清理 | R4-T6 | □ |
| AG-03 | 测试文件已重命名 | R4-T7 | □ |
| AG-04 | FIFO shift 配对保护 | R1-T7 | □ |
| AG-04 | appendMessages 原子/全成功或全失败 | R1-T6 | □ |
| AG-04 | SessionStoreSlice 含 truncatedToolChainIds | R1-T12 | □ |
| AG-04 | ISessionStore/SessionStore 签名对齐 | R3-T1 | □ |
| AG-05 | frame.html 存入 store | R5-T1 | □ |
| AG-05 | 渲染管线统一 | R5-T2 | □ |
| AG-05 | UTF-8 安全截断 | R5-T3 | □ |
| AG-05 | Worker 化 markdown 解析 | R5-T4 | □ |
| AG-05 | 积压降级 UI 提示 | R5-T5 | □ |
| AG-05 | textBatcherRef 清理 | R5-T6 | □ |
| AG-05 | generationMapRef 清理 | R5-T7 | □ |
| AG-06 | workbench_apply_update 命令存在 | R1-T3 | □ |
| AG-06 | TelemetryMonitor 降级 | R3-T2, R12-T7 | □ |
| AG-06 | hello case 类型安全 | R3-T3 | □ |
| AG-06 | 四端同步注释 | R3-T4 | □ |
| AG-07 | Cargo.toml lints × 2 | R10-T2, R10-T3 | □ |
| AG-07 | ci.yml 存在 | R10-T1 | □ |
| AG-08 | MessageContent 有 DOMPurify | R1-T4 | □ |
| AG-08 | process.rs 11 处 SAFETY 注释 | R12-T1 | □ |
| AG-08 | CSP 尾缀已确认 | R12-T2 | □ |
| AG-09 | ErrorClassifier 统一迁移 | R4-T1~R4-T3, R6-T1~R6-T4 | □ |
| AG-09 | syncRoutes 已实现 | R4-T8, R6-T5 | □ |
| AG-09 | ui-projections 已确认 | R6-T6 | □ |
| AG-10 | sessionActions 已迁移 | R1-T5, R7-T1 | □ |
| AG-10 | layoutStore 已接入 slices | R7-T2 | □ |
| AG-10 | protocol-inbound ≤ 400 行 | R7-T3 | □ |
| AG-10 | protocol-outbound ≤ 400 行 | R7-T4 | □ |
| AG-10 | ui-selectors ≤ 300 行 | R7-T5 | □ |
| AG-11 | ToolHook 类型无漂移 | R8-T1 | □ |
| AG-11 | 规划文档已同步 | R8-T2 | □ |
| AG-11 | MiddlewarePipeline 已清理 | R8-T3, R12-T4 | □ |
| AG-11 | depcruise 配置唯一 | R8-T4 | □ |
| AG-11 | ApprovalPipeline 文档已同步 | R8-T5 | □ |
| AG-11 | CI 配置完备 | R10-T1~R10-T10 | □ |
| AG-11 | 密钥扫描存在 | R10-T4 | □ |
| AG-12 | ChatProviderGuard 已集成或删除 | R9-T1 | □ |
| AG-12 | ChatCheckpointActions 已集成或删除 | R9-T2 | □ |
| AG-12 | F-2g dirty guard 已实现 | R9-T3, R9-T4 | □ |
| AG-12 | FauxAgentProvider 接口正确 | R9-T5, R9-T6 | □ |
| AG-12 | globalSetup API Key 齐全 | R9-T7 | □ |
| AG-12 | useEffect 顺序合规 | R9-T8 | □ |
| AG-12 | useAppKeyboard ≤ 120 行 | R9-T9 | □ |
| AG-12 | 测试覆盖已补充 | R11-T1~R11-T7 | □ |
| — | tsc --noEmit 通过 | R12-T6 | □ |
| — | npm run lint:all 通过 | R12-T6 | □ |
| — | npm test 通过 | R12-T6 | □ |

---

*生成时间：2026-07-24 | Agent C — 系统性多 Agent 协同修复方案*
*覆盖：全部 12 份审计报告，共计 12 轮、93 个任务、76 个 Agent·次、每轮 ≤ 12 个 Agent*
*附录：全量任务汇总 + UU 文件清单 + CI 模板 + 验收检查表*
