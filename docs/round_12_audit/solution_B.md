# 多 Agent 协同修复方案 — 系统综合修复计划

> 生成依据：全部 12 份 Round 12 审计报告（01_merge_conflicts 至 12_layer_fgj_deviation）
> 方案设计原则：按逻辑轮次组织，每轮 ≤ 12 个 Agent，问题全覆盖，串联依赖显式标注
> 总任务数：60 个修复单元，组织为 5 个逻辑轮次，覆盖 37 个源代码文件

**方案概述**：本方案将 12 份审计报告中发现的 60 个独立问题（含致命编译错误 2 个、高严重度 18 个、中严重度 22 个、低严重度 18 个）归类组织为 5 个逻辑轮次。每轮 12 个 Agent 并行工作，按依赖关系步进执行。核心设计理念是"先解阻断、后修管道、再调架构、强化安全、最终验证"——确保每轮输出都是下一轮的可靠基础。方案未包含时间安排、人员分配、优先级排序（按需求），但提供了完整的验收标准（每轮 12 项 × 5 轮 = 60 项）和端到端验证场景（12 个）以确保修复质量。

---

## 全局依赖拓扑

```
Round 1 (Critical Blockers) —— 编译 / 数据损坏 / 安全高危
  ├── Round 2 (Pipeline & Protocol)     —— 依赖 Round 1 的 CardPanel / sessionActions 编译修复
  ├── Round 3 (Architecture & Layers)    —— 与 Round 2 无依赖，可并行
  ├── Round 4 (Security & CI Gate)       —— 无前置依赖，完全可并行
  └── Round 5 (Testing & Polish)        —— 依赖 Round 1~4 的代码修复全部就绪
```

**轮次间协作约定**：
1. Round 1 的输出是后续所有轮次的编译基础——R1-T1、R1-T2、R1-T3 必须最先完成。
2. Round 2 与 Round 3、Round 4 可并行执行，但 Round 2 需等 Round 1 编译通过后再改 EventRouter。
3. Round 5 是最终验收轮次，仅在 R1~R4 全部完成后启动。
4. 每个 Agent 修改完成后需运行 `npm run typecheck` / `cargo check` 确保不破坏编译。

---

## Round 1：关键编译阻断与数据损坏修复

**目标**：修复所有阻断编译、导致数据损坏或安全高危的问题，确保代码库可构建且核心数据路径安全。本轮是全部后续轮次的基础。

**前置依赖**：无

**实现原则**：
- 所有 Agent 必须在各自任务完成后运行 `npx tsc --noEmit` 验证编译通过
- R1-T1/R1-T2 优先启动，它们是其余 10 个任务的编译基础
- R1-T4 和 R1-T6 涉及数据持久化逻辑，需特别注意向后兼容性——旧数据格式在新代码中不应 crash

---

### 1.1 任务分解

| 任务ID | 严重度 | 内容 | 涉及文件 | 报告来源 |
|--------|--------|------|----------|----------|
| R1-T1 | 致命 | 修复 CardPanel.tsx:866 `=======` 冲突残留。现场代码显示 `{activeCardId === 'chat' ? (` 与 `return (...` 两段代码被 `=======` 分岔，缺少 `<<<<<<<` / `>>>>>>>` 包裹。需人工判断保留哪条分支并移除分隔符。**建议**：保留下方 `return (...` 分支（新版 JSX 结构），删除上方的 `{activeCardId === 'chat' ? (` 和中间的 `=======` | `apps/crish-desktop/src/components/CardPanel.tsx` | 01 |
| R1-T2 | 高 | 对 37 个 UU（both modified）文件执行 `git add` 完成合并标记。经逐行检查确认仅 `CardPanel.tsx` 含实际冲突标记，其余 36 个 UU 文件无冲突语法残留，可直接 add 完成合并。**注意**：执行前通知团队确认无未保存的工作 | 全部 37 个 UU 文件（见 Report 01 §UU 列表） | 01 |
| R1-T3 | 致命 | 修复 `sessionActions.ts`（E-3 破损路径）。当前文件引用不存在的 `./actions/chat`、`./actions/session` 等子模块导致编译不可通过。**推荐方案**：将 `sessionActions.ts` 改为 barrel，内容为 `export * from './session-actions'`。然后检查 `layoutStore.ts` 和 `sessionStore.ts` 是否从新路径 `session-actions` 消费，若不是则修改为正确导入。同时确认 `session-actions/index.ts` 的命名空间不与其他导出冲突 | `apps/crish-desktop/src/store/sessionActions.ts`、`session-actions/index.ts`、`session-actions/types.ts` | 10 |
| R1-T4 | 高 | ApprovalCache 跨 session 意图重放修复。当前 `ApprovalCache.get(key)` 使用纯 `intentKey` 匹配，无 session 隔离。**改造方案**：`get(key, sessionId?)` 和 `set(key, decision, sessionId?)` 签名中增加可选 sessionId 参数。内部 key 拼接为 `${sessionId}:${intentKey}`。当 sessionId 未传入时保持向后兼容。修改 `approval-pipeline.ts:L51-55` 的调用处传入 `sessionId` | `packages/agent-runtime/src/approval/approval-cache.ts`（L21-38）、`approval-pipeline.ts`（L51-55） | 02 |
| R1-T5 | 高 | `runtime-error` event 添加 `retryable` 标记。`session-loop/index.ts:287` emit `{ type: 'runtime-error' }` 时不带 `retryable` 字段。**改造方案**：在 L286-288 处，emit 前调用 `ErrorClassifier.classify(errMsg)` 获取 `classified.retryable`，将 event 改为 `{ type: 'runtime-error', retryable: classified.retryable, sessionId, timestamp, error: errMsg }`。注意 `handleStreamError` 方法中已有对 `classifyProviderErrorMessage` 的调用（L255），此处统一使用 `ErrorClassifier` | `packages/agent-runtime/src/session-loop/index.ts`（L254-295） | 03 |
| R1-T6 | 高 | 消息 FIFO shift 时 tool-call 与 tool-result 配对清理。当前 `message-actions.ts:27-40` shift 仅检查 `first.toolCalls?.length` 记录 `truncatedToolChainIds`，但不验证 `msg[1]` 是否为对应 tool-result。**改造方案**：在 shift 前检查 `sess.messages.length > 1 && first.toolCalls?.length`，若 `msg[1].toolCallResults?.some(r => first.toolCalls.some(tc => tc.id === r.id))` 则 `splice(0, 2)` 配对移除，否则 `shift()`。同时保持 `truncatedToolChainIds` 记录 | `apps/crish-desktop/src/store/session-actions/message-actions.ts`（L27-41） | 04 |
| R1-T7 | 高 | 消除重复 markdown 解析（渲染管线 P0 瓶颈）。`StreamRenderBuffer` 的 `IncrementalMarkdownBridge` 已做增量解析并生成 HTML，但 `onFrame` 只使用 `frame.full` 纯文本。**改造方案**：(1) store 中增加 `streamHtml?: string` 字段；(2) `onFrame` 同时调用 `updateMessageText(sid, msgId, frame.full, frame.html)`；(3) `updateMessageText` 在 immer set 中同时写入 `msg.text` 和 `msg.streamHtml`；(4) `MessageContent.tsx` 优先读取 `message.streamHtml` 直接 innerHTML（过 DOMPurify），仅当不存在时回退到 `parseMarkdownToHtmlAsync` | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`（L149-155）、`StreamRenderBuffer.ts`（L241）、`MessageContent.tsx`（L93-105）、`store/types.ts` | 05 |
| R1-T8 | 中 | `isAiBusy` 竞态窗口修复。当前 `useSlashSend.ts:295` 使用 `sessMsgs.some(m => m.status === 'processing')` 遍历消息数组。**改造方案**：传入 `streamManagerRef` 作为参数或从 useSlashSend 内部访问。将条件改为 `const isAiBusy = streamManagerRef.current!.has(sessionId)`。注意 `streamManagerRef` 在 `useStreamCallbacks.ts` 中定义，需确保 `useSlashSend.ts` 可访问同一 ref（通过 hook 参数传递或提升到公共父组件） | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts`（L295） | 02 |
| R1-T9 | 低 | `cancelFn` 闭包竞争修复。`useStreamCallbacks.ts:163-169` 的 `cancel` 闭包捕获 `cancelFn` 变量时其值仍是 `() => {}`。**改造方案**：`const cancelFnRef = useRef<() => void>(() => {})`。`streamManagerRef` 中的 cancel 改为 `() => cancelFnRef.current()`。L228 的赋值改为 `cancelFnRef.current = cancelFn` | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`（L163-169, L228） | 02 |
| R1-T10 | 高 | `layoutStore.ts` 集成 4 个 slice 工厂函数（E-5）。当前 `slices/ui-slice.ts`、`terminal-slice.ts`、`permission-slice.ts`、`diff-slice.ts` 的工厂函数从未被调用。**改造方案**：在 `layoutStore.ts` 中导入 4 个 `createXxxActions` 工厂，传入 `set, get` 调用；将内联定义的 actions 替换为工厂返回的 action 对象；使用 spread 合并 `...createUiActions(set, get), ...createTerminalActions(set, get)` 等。State 初始值也应从 `createInitialUiState()` 等函数获取 | `apps/crish-desktop/src/store/layoutStore.ts`（全文件）、`slices/ui-slice.ts`、`terminal-slice.ts`、`permission-slice.ts`、`diff-slice.ts` | 10 |
| R1-T11 | 中 | 迁移 `session-loop` 中残留的 `classifyProviderErrorMessage` 调用（C2-8 ErrorClassifier 统一）。`session-loop/index.ts:255` 的 `handleStreamError` 和 `session-loop/types.ts:27` 的 `isTransientProviderError` 仍调用旧函数。**改造细节**：(1) `index.ts:255` 将 `const classified = classifyProviderErrorMessage(errMsg)` 改为 `const classified = ErrorClassifier.classify(new Error(errMsg))`。注意新的 `classified` 对象的属性路径可能不同，需调整后续 `classified.kind` 的引用为 `classified.domain` 或对应的新枚举。(2) `types.ts:27` 改为 `const classified = ErrorClassifier.classify(new Error(message)); return classified.retryable` | `packages/agent-runtime/src/session-loop/index.ts`（L255）、`types.ts`（L27） | 09 |
| R1-T12 | 中 | `MessageContent.tsx` 的 `innerHTML` 赋值添加 DOMPurify 纵深防御。当前 L96-98 直接 `containerRef.current.innerHTML = wrappedHtml`。**改造方案**：导入 `DOMPurify`，将赋值改为 `containerRef.current.innerHTML = DOMPurify.sanitize(wrappedHtml)`。注意 `wrappedHtml` 中可能包含 `<style>` 标签等 markdown 生成的合法 HTML，`DOMPurify` 默认会保留这些。可在 sanitize 时添加 `ALLOWED_TAGS` 配置以确保 markdown 渲染效果不受影响 | `apps/crish-desktop/src/components/MessageContent.tsx`（L93-98） | 08 |

---

### 1.2 Agent 分配

| Agent | 任务 | 职责描述 | 独占文件 | 预估修改行数 |
|-------|------|----------|----------|-------------|
| Agent A-1 | R1-T1, R1-T2 | Git 合并冲突清理专员 | `CardPanel.tsx` + git 操作 | 修改 1 行 + 37 个 git add |
| Agent A-2 | R1-T3 | Store 架构修复专员 | `sessionActions.ts`, `session-actions/index.ts` | ~30 行（改写 barrel + 修复导入） |
| Agent A-3 | R1-T4 | 审批缓存安全专员 | `approval-cache.ts`, `approval-pipeline.ts` | ~25 行（key 拼接逻辑） |
| Agent A-4 | R1-T5 | 错误事件增强专员 | `session-loop/index.ts` | ~15 行（添加 ErrorClassifier 调用 + retryable 字段） |
| Agent A-5 | R1-T6 | 消息完整性专员 | `session-actions/message-actions.ts` | ~30 行（配对清理逻辑） |
| Agent A-6 | R1-T7 | 渲染管线优化专员 | `useStreamCallbacks.ts`, `StreamRenderBuffer.ts`, `MessageContent.tsx`, `store/types.ts` | ~80 行（预解析 HTML 直通） |
| Agent A-7 | R1-T8 | 竞态条件修复专员 | `useSlashSend.ts` | ~5 行（替换条件表达式） |
| Agent A-8 | R1-T9 | 闭包安全专员 | `useStreamCallbacks.ts` | ~10 行（ref 模式改造） |
| Agent A-9 | R1-T10 | Store 架构重构专员 | `layoutStore.ts`, 4 个 slice 文件 | ~200 行（导入工厂 + 删内联） |
| Agent A-10 | R1-T11 | ErrorClassifier 迁移专员 | `session-loop/index.ts`, `session-loop/types.ts` | ~10 行（替换函数调用） |
| Agent A-11 | R1-T12 | XSS 纵深防御专员 | `MessageContent.tsx` | ~5 行（添加 sanitize 调用） |
| Agent A-12 | R1-T1~T12 | 回归验证与编译检查专员 | 全部修改文件 | 无代码修改，运行全部检查 |

---

### 1.3 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|----------|----------|
| R1-AC1 | CardPanel.tsx 编译通过 | `npx tsc --noEmit --project apps/crish-desktop/tsconfig.app.json` 检查该文件 | 无 TS 语法错误 |
| R1-AC2 | 37 个 UU 文件全部合并 | `git status` 确认无 UU 状态文件 | UU 计数 = 0 |
| R1-AC3 | sessionActions 双路径统一 | 检查 `sessionActions.ts` 为 barrel 或正确导入；`session-actions/index.ts` 有实际消费者 import | 编译零错误，grep 确认消费者引用新路径 |
| R1-AC4 | ApprovalCache 带 sessionId | `approval-cache.ts` 中 `get/set/delete` 方法签名的 `intentKey` 参数被替换为 `(sessionId, intentId)` 或内部拼接 | 相同 intentId 在不同 session 下产生不同缓存 key |
| R1-AC5 | runtime-error 带 retryable | 审计 `session-loop/index.ts:286-288` event 创建处 | event 对象含 `retryable: boolean` 且值来自 ErrorClassifier |
| R1-AC6 | 消息 shift 配对清理 | `message-actions.ts` shift 路径检查 | 当 `msg[0].toolCalls.length > 0` 且 `msg[1].toolCallResults` 有对应 id 时，`splice(0,2)` |
| R1-AC7 | 预解析 HTML 直通消费 | `MessageContent.tsx` 读取 `frame.html` 而非调用 markdown 解析；`useStreamCallbacks.ts` 在 `onFrame` 中同时写入 `frame.full` 和 `frame.html` | 无 `parseMarkdownToHtmlAsync` 调用（或仅在无预解析 HTML 时回退） |
| R1-AC8 | isAiBusy 改用 streamManagerRef | `useSlashSend.ts` 中 L295 | `streamManagerRef.current!.has(sid)` 替代 `sessMsgs.some(...)` |
| R1-AC9 | cancelFn ref 模式 | `useStreamCallbacks.ts:163-169` | `cancelFn` 为 ref 对象，`streamManagerRef` 中的 cancel 读取 `cancelFnRef.current` |
| R1-AC10 | layoutStore 集成 slices | `layoutStore.ts` 中存在 `from './slices/xxx'` 导入，且调用 `createUiActions` 等工厂 | store 创建时使用了 slice 工厂而非内联定义 |  
| R1-AC11 | ErrorClassifier 统一 | `session-loop/index.ts:255` 和 `types.ts:27` | 调用 `ErrorClassifier.classify` 而非 `classifyProviderErrorMessage` |
| R1-AC12 | DOMPurify 集成 | `MessageContent.tsx` | `containerRef.current.innerHTML = DOMPurify.sanitize(wrappedHtml)` |

---

## Round 2：管道与协议完整性修复

**目标**：打通错误透传路径，修复协议不一致性和存储语义问题，确保端到端数据流正确性。本轮聚焦于从后端 provider 错误到前端 UI 展示的完整链路。

**前置依赖**：Round 1 的 R1-T1、R1-T2、R1-T3（确保代码可编译）

**实现原则**：
- 所有 `EventRouter` 修改（R2-T1、R2-T2）需同时更新前端回调接口类型定义，确保 TypeScript 类型安全
- `retryable` 传播路径为：R1-T5（后端 emit）→ R2-T1（EventRouter 解析）→ R2-T3（前端 UI 消费），三处必须同步
- R2-T4（stream-recovery 退避）与 R1-T5 的 `retryProviderStream` 退避是两条独立路径，分别处理"流创建时异常"和"流建立后中断"，互不冲突

---

### 2.1 任务分解

| 任务ID | 严重度 | 内容 | 涉及文件 | 报告来源 |
|--------|--------|------|----------|----------|
| R2-T1 | 高 | EventRouter 添加 `runtime-error` case。当前 `EventRouter.ts` 的 `handleAgentEvent` 方法（L196-493）的 switch 中无 `runtime-error` 分支，该事件被静默丢弃。**改造细节**：新增 `case 'runtime-error'`，从 event 中提取 `retryable`（boolean）、`error`（string）、`sessionId` 等字段。通过回调 `callbacks.onRunError(msg, kind, { retryable })` 或新增 `callbacks.onRuntimeError(error, retryable)` 传递给前端。需在 `EventRouter` 的 `HandlerCallbacks` 接口类型中添加新的回调签名 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts`（L196-493） | 03 |
| R2-T2 | 中 | EventRouter 添加 `provider-diagnostic` case。`provider-diagnostic` 事件携带 `phase: 'retry'`、`retryable: true`、`attempt`、`maxAttempts`、`reason` 等诊断字段。**改造细节**：新增 `case 'provider-diagnostic'`，解析 `diagnostic` 对象（参照 `tool.ts:80-109` 的 `ProviderDiagnostic` 类型）。通过回调传递给前端的诊断系统（可用于展示重试进度、网络恢复可视化）。**注意**：`provider-diagnostic` 在 `session-loop/index.ts:262,269,276` 三处 emit，字段结构略有不同——需统一解析逻辑 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | 03 |
| R2-T3 | 中 | 前端重试按钮实现。`useChatStream.ts` 的 `onRunError` 回调引入 `retryable: boolean` 参数。**改造细节**：(1) 更新 `onRunError` 回调签名：(msg, kind, opts?: { retryable?: boolean })；(2) `streamState.ts` 的 `surfaceStreamFailure` 接收 `retryable` 并传递；(3) `useChatStream.ts:1044` 附近：当 `retryable === true` 时调用 `onShowRetryButton(msg)` 而非 `onShowToast(msg)`；(4) 重试按钮关联 `runStreamingAssistant` 重新调用；(5) 状态管理：添加 `retryCount` 限制（最多 3 次重试），防止无限重试循环；(6) 添加防抖：两次重试至少间隔 1s | `apps/crish-desktop/src/hooks/useChatStream.ts`、`streamState.ts`、`userFacingErrors.ts` | 03 |
| R2-T4 | 中 | `streamWithRecovery` 路径加入指数退避。`stream-recovery.ts:decideRecovery` 当前对"无内容"（Case C：流建立后立即断连，无任何 token 产出）仅重试一次。**改造细节**：在 `StreamRecovery` 类中添加 `recoveryRetryCount: number` 属性。`decideRecovery` 在 Case C 分支中：若 `recoveryRetryCount < MAX_RETRIES`（设为 3）则执行指数退避等待 `Math.min(1000 * 2^recoveryRetryCount, 30000)` ms 后重试；每次重试递增。成功时重置 `recoveryRetryCount = 0`。注意退避等待期间不应阻塞其他流的处理（使用 `setTimeout` promise） | `packages/agent-runtime/src/provider-transport/stream-recovery.ts`（L101-225） | 03 |
| R2-T5 | 中 | `appendMessages` 原子化。当前遇到 `StoreCapacityError` 时 `catch (err) { if (err instanceof StoreCapacityError) { console.warn(...); return; } }`，已写入部分保留、未写入丢失。**改造方案 A（推荐）**：预检查容量——先遍历所有 message 调用 `this.canAppend()`（新增方法），若总容量不足则整个拒绝并抛 `StoreCapacityError`。**改造方案 B**：保持现有结构但返回 `{ written: number, failed: number, error?: string }`。方案 A 更符合"全成功或全失败"的语义期望 | `packages/agent-runtime/src/session-store/index.ts`（L175-187） | 04 |
| R2-T6 | 低 | 在 `SessionStoreSlice` 中添加 `truncatedToolChainIds` 字段。当前该字段在 `store/types.ts:343` 的 `SessionState` 上定义，但 `session-actions/types.ts:4-14` 的 `SessionStoreSlice` 接口中缺少。**改造细节**：在 `SessionStoreSlice` 中添加 `truncatedToolChainIds?: string[];` | `apps/crish-desktop/src/store/session-actions/types.ts`（L4-14） | 04 |
| R2-T7 | 低 | 对齐 `ISessionStore` 与 `SessionStore` 方法签名。`ISessionStore.appendMessage` 声明返回 `Promise<AppendResult> | AppendResult`，但 `SessionStore.appendMessage` 实际返回 `void`。**改造细节**：在 `session-store/types.ts` 中定义 `AppendResult = { messageId: string; shardIndex: number }` 或类似类型。统一两处签名：要么 `ISessionStore` 也改为 `void`，要么 `SessionStore` 返回 `AppendResult`。从最小侵入原则出发，建议将 `ISessionStore` 签名改为 `void` | `packages/agent-runtime/src/session-store/types.ts`、`index.ts` | 04 |
| R2-T8 | 中 | 统一主聊天流与 Agent 流渲染管线入口。**现状**：主聊天流在 `useStreamCallbacks.ts` 中 `const buffer = new StreamRenderBuffer()` 使用默认值（12ms frameBudget, 8192 maxBytesPerFrame, 32768 maxBacklogBytes）。Agent 流 `useStreamingText.ts` 通过 `options` 参数传入自定义值。**改造细节**：在 `StreamRenderBuffer.ts` 中导出 `DEFAULT_RENDER_BUFFER_OPTIONS` 常量对象。两处都引用此默认值。若有覆盖需求通过 options 传入，但保证所有未覆盖字段来自同一默认源 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`、`hooks/useStreamingText.ts`、`StreamRenderBuffer.ts` | 05 |
| R2-T9 | 低 | `flushFrame()` UTF-8 安全截断。当前超过 `maxBytesPerFrame` 的逻辑：`let splitAt = pending.lastIndexOf('\n', maxBytesPerFrame); if (splitAt < 0) splitAt = maxBytesPerFrame; const frame = pending.slice(0, splitAt)`。**改造细节**：当 splitAt 回退到 byte 截断时，使用 `new TextDecoder('utf-8', { fatal: false })` 解码 `pending.slice(0, splitAt)` 的 byte 序列，确保不会在多字节字符中间截断。具体：从 splitAt 向前扫描直到找到合法的 UTF-8 起始字节（字节值 < 128 或 ≥ 192） | `StreamRenderBuffer.ts`（L244 附近的分割逻辑） | 05 |
| R2-T10 | 低 | `TelemetryMonitor.ts` 改用 `invokeResult`。当前 L101：`const result = await invoke('perf_jsonl_append', { data })`。**改造细节**：`const result = await invokeResult('perf_jsonl_append', { data })`，其中 `invokeResult` 是已存在的 Tauri invoke 封装函数，在非 Tauri 环境返回 `{ ok: false }` 而非抛异常。确认导出路径后修改 | `apps/crish-desktop/src/services/TelemetryMonitor.ts`（L101） | 06 |
| R2-T11 | 低 | `validateInboundMessage` 中 hello case 的类型安全提升。当前 L412-413：`case 'hello': return { ok: true, value: base.value as unknown as DaemonInboundMessage }`。**改造细节**：定义类型 `HelloMessage = { type: 'hello'; version: string }`，创建独立 validator `validateHelloMessage(value)` 返回 `ProtocolValidationResult<HelloMessage>`。在 `as unknown` 处替换为具体类型 | `packages/agent-daemon/src/protocol/protocol.ts`（L411-413） | 06 |
| R2-T12 | 低 | 移除 `ApprovalBridge` 自有超时。当前 `approval-bridge.ts` 在创建 pending 时设置独立的 120s 超时定时器，而 `approval-queue.ts` 也有自己的 5min 超时管理。**改造细节**：移除 `approval-bridge.ts` 中 L35-43 的 `setTimeout` 调用和 `DEFAULT_APPROVAL_TIMEOUT_MS` 常量。超时完全由 `approval-queue.ts` 的 `waitForApproval()` 管理。需确认 `ApprovalBridge` 的 `resolve` 回调在超时后仍能通过 `ApprovalQueue` 的 `settle()` 机制被调用 | `packages/agent-daemon/src/approval/approval-bridge.ts`（L35-43 附近） | 02 |

---

### 2.2 Agent 分配

| Agent | 任务 | 职责描述 | 独占文件 |
|-------|------|----------|----------|
| Agent B-1 | R2-T1 | EventRouter runtime-error 分支实现 | `EventRouter.ts` |
| Agent B-2 | R2-T2 | EventRouter provider-diagnostic 分支实现 | `EventRouter.ts`（同一文件，与 B-1 协同） |
| Agent B-3 | R2-T3 | 前端重试按钮 + retryable 传播 | `useChatStream.ts`, `streamState.ts`, `userFacingErrors.ts` |
| Agent B-4 | R2-T4 | stream-recovery 指数退避改造 | `stream-recovery.ts` |
| Agent B-5 | R2-T5 | appendMessages 原子化语义改造 | `session-store/index.ts` |
| Agent B-6 | R2-T6 | SessionStoreSlice 类型补全 | `session-actions/types.ts` |
| Agent B-7 | R2-T7 | ISessionStore 接口对齐 | `session-store/types.ts`, `session-store/index.ts` |
| Agent B-8 | R2-T8 | 渲染管线统一 | `useStreamCallbacks.ts`, `useStreamingText.ts`, `StreamRenderBuffer.ts` |
| Agent B-9 | R2-T9 | UTF-8 安全截断 | `StreamRenderBuffer.ts` |
| Agent B-10 | R2-T10 | TelemetryMonitor 降级封装 | `TelemetryMonitor.ts` |
| Agent B-11 | R2-T11 | protocol hello 类型安全 | `protocol.ts` |
| Agent B-12 | R2-T12 | 审批超时统一 | `approval-bridge.ts` |

---

### 2.3 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|----------|----------|
| R2-AC1 | EventRouter 处理 runtime-error | grep `handleAgentEvent` 方法 switch 分支 | `case 'runtime-error'` 存在且解析 `retryable` 并回调 `onRunError(msg, retryable)` |
| R2-AC2 | EventRouter 处理 provider-diagnostic | 同上 | `case 'provider-diagnostic'` 存在且转发诊断信息 |
| R2-AC3 | 重试按钮 UI 可见 | `retryable === true` 的 provider-diagnostic 事件 | UI 出现重试按钮（通过 `onShowToast` 或独立组件） |
| R2-AC4 | stream-recovery 退避实现 | grep `stream-recovery.ts` | `retryCount` 累加 + `Math.min(1000 * 2^retryCount, 30000)` 延迟 |
| R2-AC5 | appendMessages 原子化 | audit `session-store/index.ts` | 全成功或全失败（预检查容量），或返回 `{ written, failed }` |
| R2-AC6 | SessionStoreSlice 类型完整 | TypeScript 编译检查 | `truncatedToolChainIds?: string[]` 在 `SessionStoreSlice` 中可访问 |
| R2-AC7 | AppendResult 类型对齐 | 编译检查 `ISessionStore` vs `SessionStore` | 签名一致（同为 `Promise<AppendResult>` 或同为 `void`） |
| R2-AC8 | 渲染管线参数一致 | 对比两处 buffer 配置 | 主聊天流与 agent 流的 `StreamRenderBuffer` 默认参数来自同一配置源 |
| R2-AC9 | UTF-8 截断安全 | 单元测试输入含 `\uD83D\uDE00`（emoji 4 字节） | 截断不在多字节字符中间 |
| R2-AC10 | TelemetryMonitor 降级 | 非 Tauri 环境调用 `invokeResult` | 返回 `null` 而非抛异常 |
| R2-AC11 | hello case 类型安全 | `protocol.ts:412-413` | 无 `as unknown` 断言，使用独立 `HelloMessage` 类型 |
| R2-AC12 | 统一超时配置源 | `approval-bridge.ts` | 无自有定时器，完全委托 `ApprovalQueue` 管理超时 |

---

## Round 3：架构合规与层一致性修复

**目标**：消除 Layer A/C/D/E/F 的架构偏差，确保代码实现与架构规划文档对齐。本轮涉及代码结构重组、行数合规、废弃路径清理。

**前置依赖**：Round 1（编译基础）

**实现原则**：
- 行数拆分后必须保持 barrel 导出路径不变，外部消费者不需要修改 import
- R3-T4（ChatProviderGuard）和 R3-T5（F-2g guard）涉及组件 props 接口，修改后需检查所有调用方
- R3-T10（CI 创建）是 R4-T1~T6（CI 增强）的基础，必须先完成

---

### 3.1 任务分解

| 任务ID | 严重度 | 内容 | 涉及文件 | 报告来源 |
|--------|--------|------|----------|----------|
| R3-T1 | 中 | 实现 `ProviderRegistryV2.syncRoutes()`（C2-1 stub 修复）。当前 `syncRoutes()` 在 L305-307 是 no-op：`syncRoutes() { /* Route sync will be implemented in C2-12 */ }`。**实现方式**：遍历 `this.providerClasses` 和 `this.providerFactories`，将每个 (id, 端点路由) 写入 `StaticProviderRouteCatalog`（位于 `provider/static-provider-route-catalog.ts`）。需注入 `routeCatalog` 依赖或通过单例访问。注册后调用 `routeCatalog.sync(registryEntries)`。注意：移除的 provider 也应从 catalog 中清理 | `packages/agent-runtime/src/provider/provider-registry-v2.ts`（L305-307） | 09 |
| R3-T2 | 高 | 拆分 `protocol-inbound.ts`（537行→≤400）和 `protocol-outbound.ts`（601行→≤400）。**拆分策略**：(1) 识别跨模块引用的公共类型：`DaemonCorrelationFields`、`ProtocolValidationResult`、`MessageBase`；(2) 将这些提取到新建 `types/common.ts`；(3) 按领域将 inbound 拆为 `inbound-run.ts`、`inbound-session.ts`、`inbound-admin.ts`；(4) 同理拆分 outbound；(5) 更新 `types/index.ts` barrel 导出所有子模块；(6) 确保原始 `types/protocol-inbound.ts` 改为 barrel 重导出 | `packages/agent-daemon/src/types/protocol-inbound.ts`、`protocol-outbound.ts`、`types/index.ts`、`types/common.ts`（新建） | 10 |
| R3-T3 | 中 | 拆分 `layout-helpers/ui-selectors.ts`（414行→≤300）。当前超标 114 行。**拆分策略**：按 selector 的领域拆分为 `selectors/ui-selectors/` 下的 `ui-workspace.ts`、`ui-panel.ts`、`ui-settings.ts` 等子文件。`ui-selectors.ts` 本身改为 barrel 重新导出。提取重复的 `createSelector` 包装模式到共享辅助函数 | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` | 10 |
| R3-T4 | 高 | ChatProviderGuard / ChatCheckpointActions 清理（F-1）。**问题**：`ChatProviderGuard.tsx`（99行）提取了 provider 检测逻辑（`fetchEngineStatus`、`applyResolvedModelLabel`、`hydrateTimedOut`）但 `ChatCard.tsx` 不用它，而是内联了相同逻辑。`ChatCheckpointActions.tsx`（15行）是空壳 stub（`return null`）。**推荐方案**：(A) 在 `ChatCard` 中集成 `ChatProviderGuard` 替换内联逻辑——将 `fetchEngineStatus`、`applyResolvedModelLabel` 等调用迁移到 `ChatProviderGuard` 的 `onEngineHint`/`onModelReady` 回调中；(B) 删除 `ChatCheckpointActions` 文件（或实现实际 checkpoint/rollback 逻辑：分支管理 UI、回退按钮等）。方案选 (A)+(B) 删除 | `chat/ChatCard.tsx`、`ChatProviderGuard.tsx`、`ChatCheckpointActions.tsx` | 12 |
| R3-T5 | 中 | 补全 F-2g 未保存切换拦截 Guard。**缺失功能**：`useFileNavigation.ts` 缺少 `isDirty()`、`confirmNavigation(): Promise<boolean>`、`onDirtyChange` 回调；`useFilePreview.ts` 有 `dirty` 状态但不暴露 `onDirtyChange`。**实现细节**：(1) `useFileNavigation` 新增参数 `dirty: boolean` 或接收 `isDirty` 函数；(2) navigation 前检查：若 `dirty` 则调用 `confirmNavigation()` 弹窗确认（`window.confirm` 或自定义 Modal）；(3) `useFilePreview` 新增 `onDirtyChange?: (dirty: boolean) => void` 回调参数；(4) `FileTree.tsx` 在文件导航时调用 `confirmNavigation`。测试要求：无 dirty 时直接导航，dirty 时取消导航则不执行 | `files/hooks/useFileNavigation.ts`、`useFilePreview.ts`、`FileTree.tsx` | 12 |
| R3-T6 | 低 | F-6 useEffect 顺序纠正 + AppKeyboardHandler 拆分。**问题**：`AppBootstrap.ts` 中 12 个 useEffect 的顺序与规划文档 `06_ui_components.md` §F-6 不一致（#1 被移出到独立文件、#2/#3/#4 分别下移上移）。**纠正方法**：按规划文档重新排列 12 个 effect 的执行顺序——(1) daemonClient → engineReady；(2) AUTO_FOLD_DELAY；(3) document.title + lang；(4) initLayoutStorePersistence；(5) bootstrapServices；(6) crash detection；(7) bootstrapStores；(8) project folder rebind；(9) initWorkspaceLayoutSync；(10) theme/font/settings/TabMode init；(11) engine startup；(12) WindowResizeBridge。注意 #1 和 #11 在 `useEngineBootstrap.ts` 中——需确认两个 effect 的执行顺序（先 sub 后 engine）。**AppKeyboardHandler**：`useAppKeyboard.ts` 190 行→≤120：将键盘快捷键按领域拆分为 `useKeyboardNavigation`、`useKeyboardEdit`、`useKeyboardView` 等子 hook | `app/AppBootstrap.ts`、`hooks/useAppKeyboard.ts` | 12 |
| R3-T7 | 高 | `tool-hook-observability.ts` 导入类型统一（H-2 类型漂移）。**问题**：`tool-hook-observability.ts:L17-32` 重新声明了 `ToolHook` 接口和 `ToolHookContext` 接口。`ToolHook` 返回 `unknown`，而 `tool-hook-types.ts` 中返回具体的 `BeforeExecuteResult | Promise<BeforeExecuteResult>` / `ToolResult<TOutput>` / `OnErrorResult`。`ToolHookContext` 字段也不同。**改造方案**：(1) 删除 observability 中的重复接口声明；(2) 改为 `import type { ToolHook, ToolExecutionContext, ... } from './tool-hook-types'`；(3) 调整 `ToolHookObserver` 类中的方法签名使用精确返回类型；(4) 将 `ToolHookContext` 替换为 `ToolExecutionContext` 或为其添加缺少的字段 | `packages/agent-runtime/src/hooks/tool-hook-observability.ts`（L17-32）、`tool-hook-types.ts` | 11 |
| R3-T8 | 低 | `MiddlewarePipeline` 清理计划。**现状**：文件有 `@deprecated` JSDoc 标记，有 `@removeWhen 确认所有外部消费者已迁移` 注释，但无目标版本，且内部仍有完整的 200+ 行功能性实现（非空桩）。**操作**：(1) 全局 grep 搜索 `MiddlewarePipeline` 导入——确认 `agent-runtime` 内部和外部（`agent-daemon`、`agent-orchestrator`、`crish-desktop`）是否还有消费者；(2) 若零消费者→删除文件，更新 barrel 导出清理；(3) 若有消费者→注释中添加目标移除版本号，创建 Issue 跟踪 | `packages/agent-runtime/src/hooks/middleware-pipeline.ts` | 11 |
| R3-T9 | 低 | 统一 `.dependency-cruiser.js` 与 `.dependency-cruiser.cjs`。**现状**：两根文件——`.dependency-cruiser.js` 中 `no-runtime-to-shared` 规则为 `error`，而 CI 使用的 `.dependency-cruiser.cjs` 降级为 `warn`。**推荐方案**：删除 `.dependency-cruiser.js`，将 `.cjs` 重命名为 `.js`（dependency-cruiser 默认查找 `.dependency-cruiser.js`）。更新 `package.json` 的 `lint:depcruise` 脚本为 `depcruise --config .dependency-cruiser.js packages apps --ignore "dist/"`。注意两份配置的非 `no-runtime-to-shared` 部分也要同步 | `.dependency-cruiser.js`、`.dependency-cruiser.cjs`、`package.json` | 11 |
| R3-T10 | 高 | 创建 `.github/workflows/ci.yml` 基础 CI 配置（最小可行版本）。**包含**：(1) `on: [push, pull_request]` 触发；(2) ubuntu-latest + Node 20 环境；(3) 步骤：`actions/checkout@v4` → `actions/setup-node@v4` → `npm ci` → `npx tsc --noEmit`（typecheck 全部包） → `npm run lint:all`（含 `--max-warnings 0`） → `npx depcruise ...` → `npm test`（vitest）。不包含 Round 4 的增强功能（concurrency、permissions、turbo 等），这些在 R4-T1~T6 中增量添加。**注意**：如果 Rust 构建在 CI 中也需要，添加 `rustup` 和 `cargo check` 步骤 | `.github/workflows/ci.yml`（新建） | 07 |
| R3-T11 | 中 | 两个 Cargo.toml 添加 `[lints] workspace = true`。`agent-workbench/src-tauri/Cargo.toml` 和 `agent-provider-http/Cargo.toml` 均缺少该声明。**操作**：在两个文件的 `[package]` 段后紧接添加 `[lints] workspace = true`。后续运行 `cargo clippy` 验证 | `apps/agent-workbench/src-tauri/Cargo.toml`、`packages/agent-provider-http/Cargo.toml` | 07 |
| R3-T12 | 中 | `process.rs` 中的 11 处 unsafe 添加 SAFETY 注释。**11 处位置**：(1) L199 `GetCurrentProcess()`——"SAFETY: GetCurrentProcess 始终返回伪句柄，无需释放，调用安全"；(2) L204-213 `OpenProcess/CloseHandle`——"SAFETY: OpenProcess 返回的句柄有效通过非 null 检查，CloseHandle 仅使用有效句柄"；(3) L217-236 `GetProcessMemoryInfo`——"SAFETY: process_memory_snapshot_from_handle 内部验证句柄有效性"；(4) L287-316 `CreateToolhelp32Snapshot/Process32FirstW/NextW`——"SAFETY: 快照句柄在 finally 中关闭，枚举前检查 INVALID_HANDLE_VALUE"；(5) L701 `unsafe impl Send for DaemonJobHandle`——"SAFETY: DaemonJobHandle 仅包含整数句柄，Send 安全"；(6) L704 `unsafe impl Sync for DaemonJobHandle`——"SAFETY: 同上，Sync 安全"；(7) L716-738 `CreateJobObjectW/SetInformationJobObject`——"SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION 栈分配，有效期内使用"；(8) L746 `CloseHandle(dup)`——"SAFETY: dup 来自 DuplicateHandle，非 null 检查后关闭"；(9) L762-766 `AssignProcessToJobObject`——"SAFETY: hJob 句柄有效，processHandle 已通过 PID 验证"；(10) L772-778 `setpgid`——"SAFETY: POSIX 标准 API，pid 为 0 表示当前进程"；(11) L785-792 `killpg`——"SAFETY: POSIX 标准 API，pgid 来自 setpgid 设置值" | `apps/agent-workbench/src-tauri/src/process.rs`（L199, L204-213, L217-236, L287-316, L701, L704, L716-738, L746, L762-766, L772-778, L785-792） | 08 |

---

### 3.2 Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|----------|
| Agent C-1 | R3-T1 | `provider-registry-v2.ts` |
| Agent C-2 | R3-T2 | `protocol-inbound.ts`, `protocol-outbound.ts`, `types/common.ts`, `types/index.ts` |
| Agent C-3 | R3-T3 | `ui-selectors.ts` |
| Agent C-4 | R3-T4 | `ChatCard.tsx`, `ChatProviderGuard.tsx`, `ChatCheckpointActions.tsx` |
| Agent C-5 | R3-T5 | `useFileNavigation.ts`, `useFilePreview.ts`, `FileTree.tsx` |
| Agent C-6 | R3-T6 | `AppBootstrap.ts`, `useAppKeyboard.ts` |
| Agent C-7 | R3-T7 | `tool-hook-observability.ts`, `tool-hook-types.ts` |
| Agent C-8 | R3-T8 | `middleware-pipeline.ts` |
| Agent C-9 | R3-T9 | `.dependency-cruiser.js`, `.dependency-cruiser.cjs`, `package.json` |
| Agent C-10 | R3-T10 | `.github/workflows/ci.yml` |
| Agent C-11 | R3-T11 | `agent-workbench/src-tauri/Cargo.toml`, `agent-provider-http/Cargo.toml` |
| Agent C-12 | R3-T12 | `process.rs` |

---

### 3.3 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|----------|----------|
| R3-AC1 | syncRoutes() 非 stub | grep `syncRoutes` 实现体 | 有实际注册同步逻辑（将 providerClasses/factories 写入 StaticProviderRouteCatalog） |
| R3-AC2 | protocol 类型文件 ≤400 行 | `wc -l` 检查 | `protocol-inbound.ts` ≤400, `protocol-outbound.ts` ≤400, `types/common.ts` 存在 |
| R3-AC3 | ui-selectors ≤300 行 | `wc -l` | 拆分后 ≤300 |
| R3-AC4 | ChatProviderGuard 状态明确 | `ChatCard.tsx` import 检查 | 已导入并使用 ChatProviderGuard，或文件被删除 + ChatCard 内联逻辑保留 |
| R3-AC5 | F-2g guard 完整 | 单元测试验证 | `useFileNavigation` 有 `confirmNavigation()`，导航前检查 `dirty` 若 true 则弹窗 |
| R3-AC6 | useEffect 顺序与规划一致 | 逐条比对规划文档 12 条 effect | 12 条 effect 顺序与 `docs/crish_desktop_architectural_remediation_plan/06_ui_components.md` §F-6 一致 |
| R3-AC7 | ToolHook 接口单一来源 | `tool-hook-observability.ts` import 检查 | `import type { ToolHook, BeforeExecuteResult, ToolResult, OnErrorResult } from './tool-hook-types'` |
| R3-AC8 | middleware-pipeline 已移除或设目标版本 | 文件存在性 + 注释检查 | 已删除，或注释含 `@removeWhen` + 目标版本号 |
| R3-AC9 | depcruise 配置统一 | 文件存在性检查 | `.dependency-cruiser.js` 已删除或重定向到 `.cjs`；`package.json` 中 `lint:depcruise` 脚本引用 `.cjs` |
| R3-AC10 | CI 文件存在且含基本检查 | 文件存在 + grep | `.github/workflows/ci.yml` 存在，含 `typecheck`、`lint`、`lint:depcruise`、`test` 步骤 |
| R3-AC11 | Cargo lints 继承 | 两个 Cargo.toml 检查 | 均含 `[lints] workspace = true` |
| R3-AC12 | SAFETY 注释全覆盖 | `process.rs` 逐处检查 | 11 处 unsafe 块前均有 `// SAFETY:` 注释说明不变式 |

---

## Round 4：安全强化与 CI 门禁增强

**目标**：补充安全防御层，消除代码残留风险，为 CI/CD 配置完整的门禁体系（concurrency、权限最小化、路径过滤、turbo 缓存、密钥扫描等）。

**前置依赖**：Round 3 的 R3-T10（CI 基础文件）

**实现原则**：
- R4-T1~T6 均在 R3-T10 创建的 `ci.yml` 上增量修改，每位 Agent 专注于自己负责的一行或一块
- R4-T7（globalSetup）需与 R4-T8（FauxAgentProvider）协调：如果 FauxAgentProvider 在测试中使用了缺失的 API key 环境变量，globalSetup 的清理顺序必须正确
- R4-T9 和 R4-T10 是纯删除操作，风险最低，可优先执行
- R4-T11 涉及测试文件重命名，需同步更新相关的 CI 配置和测试 runner 配置（如有）

---

### 4.1 任务分解

| 任务ID | 严重度 | 内容 | 涉及文件 | 报告来源 |
|--------|--------|------|----------|----------|
| R4-T1 | 高 | CI 添加 `concurrency` 控制（I-1）。**实现**：在 `ci.yml` 的 workflow 根级别添加：`concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true`。效果：同一 PR 的新 push 自动取消该 PR 正在运行的旧 CI。**注意**：`cancel-in-progress: true` 仅应在 `on: [push, pull_request]` 时启用，对于 `on: [workflow_dispatch]` 不适用。当前 CI 是 push+PR 触发，适用 | `.github/workflows/ci.yml`（workflow 根级别） | 11 |
| R4-T2 | 高 | CI 添加 `permissions: contents: read`（I-2 权限最小化）。**实现**：在 `ci.yml` 的 workflow 根级别添加：`permissions: contents: read`。确保 CI token 仅对仓库内容有读取权限，不可写。**引申**：如果 CI 需要创建 issue comment（如 coverage report），则额外添加 `issues: write`；但最小权限原则建议默认只给 `contents: read` | `.github/workflows/ci.yml`（workflow 根级别） | 11 |
| R4-T3 | 高 | CI 添加路径过滤（I-3）。**实现**：在 `ci.yml` 的 `on.push` 和 `on.pull_request` 中添加：`paths-ignore: ['docs/**', '*.md', 'assets/**', '*.svg', '*.png']`。**效果**：修改文档、README、图片等不触发 CI 运行，节省 Actions 配额。**注意**：需用 YAML 的多行语法同时配置 push 和 pull_request：`on: push: paths-ignore: [...] pull_request: paths-ignore: [...]` | `.github/workflows/ci.yml`（on.push + on.pull_request） | 11 |
| R4-T4 | 高 | CI 启用 turbo 缓存（I-4）。**实现**：(1) 添加 `actions/cache@v4` 步骤缓存 `.turbo/` 目录：`path: .turbo, key: ${{ runner.os }}-turbo-${{ github.sha }}, restore-keys: ${{ runner.os }}-turbo-`；(2) 将命令替换为 `npx turbo run typecheck lint:all test`；(3) 确认 `turbo.json` 的 pipeline 配置正确——需要 `typecheck`、`lint:all`、`test` 都有对应的 outputs 配置；(4) 如果 turbo 未全局安装，需先 `npx turbo` 或 `npm i -g turbo` | `.github/workflows/ci.yml` + `turbo.json`（确认 pipeline） | 11 |
| R4-T5 | 高 | CI `typecheck:ci` 全覆盖（I-5）。**实现**：(1) 在 `package.json` 的 `scripts` 中新增 `"typecheck:ci": "turbo run typecheck"` 或逐个 package 执行 `tsc --noEmit`；(2) 在 `ci.yml` 中将 `npx tsc --noEmit` 替换为 `npm run typecheck:ci`。**覆盖范围**：agent-runtime、agent-daemon、agent-orchestrator、shared-types、shared-utils、decision-engine、crish-desktop、agent-workbench 共 8 个包。**注意**：如果某个包的 tsconfig 依赖其他包的构建产物，需要先 `npm run build` 或使用 `turbo` 的拓扑排序 | `.github/workflows/ci.yml`、`package.json` | 11 |
| R4-T6 | 高 | CI 添加密钥扫描（I-11）。**实现**：新增一个 job `secrets-scan`：(1) steps: `actions/checkout@v4` → `gitleaks detect --source . --no-git --verbose` 或 `trufflehog filesystem --directory=. --json`。**推荐 gitleaks**：社区成熟、维护活跃。安装方式：`uses: gitleaks/gitleaks-action@v2`（官方 action）或自行安装 `go run github.com/gitleaks/gitleaks/v8@latest detect`。**注意**：密钥扫描应对比上一次提交而非全仓库扫描（首次除外），避免大量误报 | `.github/workflows/ci.yml` | 11 |
| R4-T7 | 中 | `vitest.globalSetup.ts` 追加缺失的 API Key 环境变量清除（J-4）。**当前列表**：13 个具体键名。**缺失**：(1) `CRISH_API_KEY`——被 `provider-openai-base.ts` 和 `provider-openai-compatible.ts` 使用；(2) `FLOWBIT_API_KEY`——同上；(3) `CONEX_API_KEY_*`——在 `provider-gateway/index.ts:L252` 以 prefix 被引用。**改造细节**：(1) 在 `PROVIDER_API_KEYS` 数组中追加 `'CRISH_API_KEY'` 和 `'FLOWBIT_API_KEY'`；(2) 新增 `PROVIDER_API_KEY_PREFIXES = ['CONEX_API_KEY_']` 数组；(3) `setup()` 中遍历所有环境变量，若 key 以任一 prefix 开头则清除（并备份） | `vitest.globalSetup.ts`（L9-23 扩展 + 新增 prefix 清除逻辑） | 12 |
| R4-T8 | 中 | `FauxAgentProvider` 改为 `implements AgentProvider`（J-1）。**当前**：`class FauxAgentProvider implements Pick<import("../types").AgentProvider, "id">`——只要求 `id` 属性，缺少完整接口契约。**改造**：(1) 改为 `class FauxAgentProvider implements AgentProvider`；(2) 需要实现 `AgentProvider` 接口的全部方法/属性（查阅 `types.ts` 中定义）：`id: string`、`stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamContractEvent>`、`init?(): Promise<void>`、`dispose?(): Promise<void>`、`healthCheck?(): Promise<{ ok: boolean }>` 等；(3) 初始实现可以为 stub（`init`/`dispose` return Promise.resolve），但接口签名必须匹配 | `packages/agent-runtime/src/testing/faux-provider.ts`（L4） | 12 |
| R4-T9 | 低 | 移除 `error-classifier.ts` 中 `tripsBreaker` 字段。**操作**：在 `DEFAULT_MATRIX`（L40-55）的每个 `ErrorDomain` 条目中删除 `tripsBreaker: boolean`，例如将 `TRASNIENT_NETWORK: { retryable: true, tripsBreaker: true, uiSeverity: "warning", legacyKind: "network" }` 改为 `{ retryable: true, uiSeverity: "warning", legacyKind: "network" }`。**注意**：此结构可能被序列化为 JSON，删除字段后序列化输出不再含 `tripsBreaker`。需 grep 确认无任何消费者依赖该字段 | `packages/agent-runtime/src/error-classifier.ts`（L40-55） | 03 |
| R4-T10 | 低 | 移除 `fallback-chain/types.ts` 中未使用的 `"circuit-open"` 类型。**操作**：在 `FallbackErrorType` 联合类型（L14）中删除 `| "circuit-open"`。**验证**：`grep -r '"circuit-open"' packages/ --include="*.ts"` 确认无其他引用。注意 `domainToFallbackErrorType` 映射表若有 `circuit-open` 分支也一并清理 | `packages/agent-runtime/src/fallback-chain/types.ts`（L14） | 03 |
| R4-T11 | 低 | 重命名 `circuit-breaker-e2e.test.ts` 为 `exponential-backoff-e2e.test.ts` 并补充测试。**当前**：测试名为 `"E2E: Exponential backoff on transient errors (R13.3)"`，但文件名仍为 `circuit-breaker-e2e.test.ts`。**操作**：(1) `git mv circuit-breaker-e2e.test.ts exponential-backoff-e2e.test.ts`；(2) 补充测试用例：验证 attempt=1→1000ms, attempt=2→2000ms, attempt=3→4000ms 的延迟计算；验证退避重置（两次独立 call() 各自从 attempt=1 开始）；验证 3 次耗尽后原样 throw err | 文件重命名 + 测试内容补充 | 03 |
| R4-T12 | 低 | `generationMapRef` session 关闭时的条目清理。**操作**：在 `onComplete` 回调中（`useStreamCallbacks.ts` 约 L126-130），执行 `generationMapRef.current.delete(sid)`。**注意**：`generationMapRef` 用作代际计数器确保旧 run 的回调不写入新 run，因此清理动作不能干扰代际检查的时序——应该在所有回调都被 `assertLive()` 阻止后的安全点清理 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`（`onComplete` 内部） | 05 |

---

### 4.2 Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|----------|
| Agent D-1 | R4-T1 | `.github/workflows/ci.yml` |
| Agent D-2 | R4-T2 | `.github/workflows/ci.yml`（与 D-1 同一文件，协商修改） |
| Agent D-3 | R4-T3, R4-T4 | `.github/workflows/ci.yml` |
| Agent D-4 | R4-T5 | `.github/workflows/ci.yml` + `package.json` |
| Agent D-5 | R4-T6 | `.github/workflows/ci.yml` |
| Agent D-6 | R4-T7 | `vitest.globalSetup.ts` |
| Agent D-7 | R4-T8 | `faux-provider.ts` |
| Agent D-8 | R4-T9 | `error-classifier.ts` |
| Agent D-9 | R4-T10 | `fallback-chain/types.ts` |
| Agent D-10 | R4-T11 | `circuit-breaker-e2e.test.ts` → `exponential-backoff-e2e.test.ts` |
| Agent D-11 | R4-T12 | `useStreamCallbacks.ts` |
| Agent D-12 | R4-T1~T12 | 回归验证 + 模拟 CI 运行 |

---

### 4.3 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|----------|----------|
| R4-AC1 | concurrency 控制 | grep `ci.yml` | `concurrency:` 块存在，含 `group:` 和 `cancel-in-progress: true` |
| R4-AC2 | 权限最小化 | grep `ci.yml` | `permissions:` 块存在，`contents: read` |
| R4-AC3 | 路径过滤 | grep `ci.yml` | `paths-ignore:` 或 `paths:` 存在，排除 `docs/**`、`*.md`、`assets/**` |
| R4-AC4 | turbo 缓存 | grep `ci.yml` | `turbo run typecheck build test` 命令存在，含 `.turbo` 缓存 restore/save 步骤 |
| R4-AC5 | typecheck 全覆盖 | grep `ci.yml` + `package.json` | `typecheck:ci` 或 `turbo run typecheck` 覆盖全部 8 个 package |
| R4-AC6 | 密钥扫描 | grep `ci.yml` | `gitleaks` 或 `trufflehog` step/job 存在 |
| R4-AC7 | globalSetup 完整 | diff `vitest.globalSetup.ts` | `CRISH_API_KEY`、`FLOWBIT_API_KEY` 在 `PROVIDER_API_KEYS` 中；新增 `CONEX_API_KEY_` prefix 清除循环 |
| R4-AC8 | FauxAgentProvider 实现完整 | 检查 `implements` | `class FauxAgentProvider implements AgentProvider` 且通过 TS 编译 |
| R4-AC9 | tripsBreaker 已移除 | grep `error-classifier.ts` | 无 `tripsBreaker` 字段 |
| R4-AC10 | circuit-open 已移除 | grep `fallback-chain/types.ts` | 无 `"circuit-open"` 字面量 |
| R4-AC11 | 测试文件名正确 + 退避测试 | 文件存在性 + 运行测试 | `exponential-backoff-e2e.test.ts` 存在且含退避延迟计算、退避重置、重试耗尽测试 case |
| R4-AC12 | generationMapRef 无泄漏 | 审计 session cleanup 路径 | run 结束时或 session 删除时 `generationMapRef.current.delete(sid)` |

---

## Round 5：测试覆盖补齐与代码打磨

**目标**：补齐关键模块的单元测试和集成测试，消除死代码，打磨渲染管线性能，确保全量修复闭环验收。本轮是最终质量保障轮次，要求新增测试覆盖全部 12 份报告中标注"无测试"的模块。

**前置依赖**：Round 1~4 全部修复完成

**实现原则**：
- 每个测试必须可重复运行（`npx vitest run --reporter=verbose`），不依赖外部网络或真实 API key
- Mock 外部依赖（store、WebSocket、daemon API）而非真实调用
- 测试文件放置遵循项目惯例：`__tests__/` 目录 + `.test.ts`/`.test.tsx` 后缀
- R5-T7（Worker 化）和 R5-T8（UI 提示）是性能改进，其余均为测试补充
- 每个测试 Agent 需同时验证对应修复任务的正确性（例如 R5-T1 验证 R2-T3 重试按钮、R1-T4 ApprovalCache 等）

---

### 5.1 任务分解

| 任务ID | 严重度 | 内容 | 涉及文件 | 报告来源 |
|--------|--------|------|----------|----------|
| R5-T1 | 高 | 新增 `useChatApproval` 单元测试。**测试场景**：(1) 竞态守卫——多个并发的 approval 请求同时发出，验证只有一个被处理；(2) 超时自动 deny——mock 定时器验证 120s 后 decision="expired"；(3) approval-resolved 回调——模拟 WebSocket `approval-resolved` 事件，验证 tool call 状态更新为 success/error；(4) cancel-run 清理——run 被取消时所有 pending approval 被 settle；(5) approval-cache sessionId 隔离——两个 session 发出同 intentKey 请求，验证不共享缓存。**Mock 策略**：使用 `vi.fn()` 模拟 store actions，使用 `vi.useFakeTimers()` 控制超时 | `apps/crish-desktop/src/components/chat/hooks/__tests__/useChatApproval.test.ts`（新建） | 12 |
| R5-T2 | 中 | 新增 `useFileNavigation` 单元测试。**测试场景**：(1) `isDirty` 状态——文件编辑前后 dirty 状态正确变化；(2) `confirmNavigation`——dirty 时调用弹窗确认，用户确认后导航，取消则不导航；(3) `onDirtyChange` 回调——dirty 状态变化时正确触发 callback；(4) 无 dirty 时直接导航——suppress confirm 弹窗。**Mock 策略**：使用 `window.confirm = vi.fn()` 拦截弹窗 | `apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.ts`（新建） | 12 |
| R5-T3 | 中 | 新增 `FauxAgentProvider` 单元测试。**测试场景**：(1) `setEvents` + `stream`——设置 3 个事件后 stream 正确按序 yield 这 3 个事件；(2) `setError`——stream 抛出预设 error；(3) `setLatency`——验证 stream 的事件之间有预期的 ms 延迟；(4) `setFailAfter(2)`——前 2 次 stream 成功，第 3 次失败；(5) `reset()`——重置后所有状态清空，stream 按默认行为运行；(6) 验证 `implements AgentProvider`——编译期检查接口完整性。**Mock 策略**：不需要 mock，FauxAgentProvider 本身就是测试替身 | `packages/agent-runtime/src/testing/__tests__/faux-provider.test.ts`（新建） | 12 |
| R5-T4 | 中 | 新增 `StreamRenderBuffer` 单元测试。**测试场景**：(1) 正常分帧——push 10 个 chunk，验证 rAF 后 onFrame 被调用且 `frame.full` 累积正确；(2) `maxBacklogBytes` 降级——push 50KB 数据（>32KB 阈值），验证中间帧的 onFrame 被跳过，最终帧 `frame.isFinal=true` 时强制调用；(3) `flush(true)` 强制路径——降级状态下调用 `flush(true)` 验证 onFrame 被立即调用；(4) UTF-8 安全截断——push 含 4 字节 emoji `\uD83D\uDE00` 的大文本，验证截断不在多字节字符中间；(5) 帧时间间隔——验证两次 onFrame 调用间隔不低于 `frameBudget`(12ms)。**Mock 策略**：`vi.useFakeTimers()` 控制 requestAnimationFrame | `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts`（新建） | 12 |
| R5-T5 | 中 | 新增 `ChatCard` 集成测试。**测试场景**：(1) 组件正常渲染——提供 mock store 状态，验证 ChatCard 不抛异常；(2) ChatHeader 集成——验证 `composerElement` 的 `rightActions` 中包含 ChatHeader；(3) ChatProviderGuard——如保留集成，验证 provider 检测流程（`fetchEngineStatus` mock 返回 ok）；(4) 3 个 hook 协作——验证 `useChatCardSelectors`、`useChatApproval`、`useChatComposerProps` 同时挂载不冲突。**Mock 策略**：Render with `react-testing-library`，mock zustand store：`useLayoutStore.setState` 和 `getSessionById` | `apps/crish-desktop/src/components/chat/__tests__/ChatCard.test.tsx`（新建） | 12 |
| R5-T6 | 中 | 补充退避计算验证测试。**在已重命名的文件中添加**：(1) 延迟计算——`attempt=1 → 1000ms`，`attempt=2 → 2000ms`，`attempt=3 → 4000ms`，`attempt=4 → 8000ms`，`attempt=5 → 16000ms`，`attempt=6 → 30000ms`（上限验证）；(2) 退避重置验证——两次独立 `call()` 调用，每次各自从 attempt=1 开始（不共享退避状态）；(3) 重试耗尽——模拟第 1~3 次全部失败，验证第 4 次直接抛出原始 error，不再隐藏异常消息；(4) 正则匹配验证——验证仅 `network|timeout|5\d{2}|econnrefused|econnreset|socket` 匹配的错误触发重试，其他错误直接透传 | 已重命名文件补充 | 03 |
| R5-T7 | 低 | Worker 化增量 markdown 解析（P2 优化）。**现状**：`IncrementalMarkdownBridge.push(fullText)` 在 `flushFrame()` 的 rAF 回调中同步执行，复杂 markdown（嵌套代码块、大表格）可能超帧预算（12ms）。**改造方案**：(1) 创建 `markdownWorker.ts`——导入 `IncrementalMarkdownBridge` 实例，监听 `message` 事件；(2) worker 内部维护 bridge 状态；(3) `flushFrame()` 中改为 `worker.postMessage({ type: 'parse', text: fullText })`；(4) worker `onmessage` 回传 `{ html, chunkUpdates }`；(5) `flushFrame()` 在收到 worker 消息后继续执行 `onFrame`。**降级策略**：若 Worker 创建失败（`new Worker()` 抛出异常），回退到同步解析。**收益预估**：主线程帧预算从 12ms 释放约 5-10ms，减少"跳帧"概率 | `StreamRenderBuffer.ts`、`IncrementalMarkdownBridge.ts`、`markdownWorker.ts`（新建） | 05 |
| R5-T8 | 低 | 积压降级 UI 提示。**现状**：`bufferedLength() > maxBacklogBytes` 时跳过 onFrame，用户看到"跳字"(从 A 直接跳到 C，看不到中间 B)。**改造方案**：(1) `StreamRenderBuffer` 添加 `degraded: boolean` 属性——`bufferedLength() > maxBacklogBytes` 时 `this.degraded = true`，恢复时 `false`；(2) store 增加 `renderDegraded?: string` 字段（messageId→degraded 映射）；(3) `onChunk` 或 `onFrame` 回调中更新 store；(4) `MessageContent.tsx` 读取 `renderDegraded` 在内容区顶部显示浅色提示条"加速中…"。**提示条行为**：degraded 时 300ms fade-in，恢复时 2000ms delay + 300ms fade-out，避免闪烁 | `StreamRenderBuffer.ts`、`store/types.ts`、`MessageContent.tsx` | 05 |
| R5-T9 | 低 | `assertLive()` 后追加二次 `myGen` 校验。**现状**：`onFrame` 回调中 `assertLive()` → `myGen` 检查 → `updateMessageText`，但 `updateMessageText` 后在下一个 event loop 前可能被新 run 覆盖代际计数器。**改造细节**：在 `updateMessageText(sid, assistantMsgId, frame.full)` 后立即插入：`if (myGen !== generationMapRef.current.get(sid)) { /* 还原 store 变更或直接 return */ return; }`。**还原策略**：因为是 `immer setState`，可以在二次检查失败后重新设置 `text` 为旧值——但旧值已不可得。更实际的方案是：放弃还原（因为概率极低），仅标记一个 recovery flag，让下次 `onFrame` 自行覆盖 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`（L149-155） | 02 |
| R5-T10 | 中 | ApprovalCache sessionId 隔离测试。**测试场景**：(1) 不同 session 的相同 intentKey 不共享——`cache.set('intent:edit', { allow: true }, 'session-A', undefined)`，`cache.get('intent:edit', 'session-B')` 返回 `undefined`；(2) 相同 session + 相同 intentKey 在 TTL 内共享——`cache.get('intent:edit', 'session-A')` 返回 `{ allow: true }`；(3) sessionId 未传入时向后兼容——调用 `cache.get('intent:edit')`（无 sessionId）使用旧 key 逻辑；(4) TTL 超时后即使 session/key 相同也失效——`vi.advanceTimersByTime(30001)` 后 `cache.get(...)` 返回 `undefined`。**Mock 策略**：`vi.useFakeTimers()` | `packages/agent-runtime/src/approval/__tests__/approval-cache.test.ts`（新建） | 02 |
| R5-T11 | 低 | AppBootstrap useEffect 顺序测试。**测试场景**：(1) Mock React 的 `useEffect` 和 `useLayoutEffect` 以记录调用顺序；(2) 渲染 AppBootstrap 组件（或直接调用其内部的 effect 工厂函数）；(3) 断言 effect 执行顺序数组与规划文档的 12 条列表完全一致。**Mock 策略**：在测试文件中覆写 `React.useEffect = vi.fn().mockImplementation(f => effectOrder.push('effect-N'); f())`。**注意**：由于 `useEngineBootstrap.ts` 是独立文件，两个文件中的 effect 相对顺序需通过调用时间戳验证 | `apps/crish-desktop/src/app/__tests__/AppBootstrap.test.ts`（新建） | 12 |
| R5-T12 | 高 | 端到端 store 完整性测试。**测试场景**：(1) 512 条消息边界——向 session 连续添加 512 条消息，验证第 501 条触发 shift（`MAX_MESSAGES_PER_SESSION=500`）；(2) tool-call + tool-result 配对——添加 tool-call(msg[0]) + tool-result(msg[1])，验证第 501 条消息时 `splice(0,2)` 配对移除而非 shift(msg[0])；(3) `appendMessages` 原子化——向已满的 session（510 条）批量添加 50 条，验证 0 条写入（全失败），而非 40 条写入、10 条丢弃；(4) session 切换不污染——在 session-A 添加消息，切换到 session-B 再切回，验证 session-A 消息不变；(5) `truncatedToolChainIds` 记录——验证 shift 后 `truncatedToolChainIds` 包含被移除的 toolCall id。**Mock 策略**：直接操作 zustand store（`useLayoutStore.getState()` + `setState()`） | `apps/crish-desktop/src/store/__tests__/store-integrity.e2e.test.ts`（新建） | 04 |

---

### 5.2 Agent 分配

| Agent | 任务 | 独占文件 |
|-------|------|----------|
| Agent E-1 | R5-T1 | `useChatApproval.test.ts`（新建） |
| Agent E-2 | R5-T2 | `useFileNavigation.test.ts`（新建） |
| Agent E-3 | R5-T3 | `faux-provider.test.ts`（新建） |
| Agent E-4 | R5-T4 | `StreamRenderBuffer.test.ts`（新建） |
| Agent E-5 | R5-T5 | `ChatCard.test.tsx`（新建） |
| Agent E-6 | R5-T6 | `exponential-backoff-e2e.test.ts`（补充） |
| Agent E-7 | R5-T7 | `StreamRenderBuffer.ts`, `IncrementalMarkdownBridge.ts`, `markdownWorker.ts` |
| Agent E-8 | R5-T8 | `StreamRenderBuffer.ts`, `store/types.ts`, `MessageContent.tsx` |
| Agent E-9 | R5-T9 | `useStreamCallbacks.ts` |
| Agent E-10 | R5-T10 | `approval-cache.test.ts`（新建） |
| Agent E-11 | R5-T11 | `AppBootstrap.test.ts`（新建） |
| Agent E-12 | R5-T12 | `store-integrity.e2e.test.ts`（新建） |

---

### 5.3 验收标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|----------|----------|
| R5-AC1 | useChatApproval 测试 | `npx vitest run apps/crish-desktop/src/components/chat/hooks/__tests__/useChatApproval.test.ts` | 100% pass，≥80% 分支覆盖率 |
| R5-AC2 | useFileNavigation guard 测试 | 运行测试文件 | dirty→confirmNavigation→block navigation 路径完全覆盖 |
| R5-AC3 | FauxAgentProvider 接口测试 | 运行测试文件 | 全部 5 个 setter + stream + reset 方法覆盖 |
| R5-AC4 | StreamRenderBuffer 降级测试 | 运行测试文件 | maxBacklogBytes 超限时 onFrame 被跳过，flush(true) 强制通过 |
| R5-AC5 | ChatCard 集成测试 | 运行测试文件 | 组件渲染不崩溃，子组件按预期 render |
| R5-AC6 | 退避计算精确测试 | 运行测试文件 | attempt=1→1s, 2→2s, 3→4s, ... 上限 30s；reset 验证 |
| R5-AC7 | Worker markdown 解析 | profile 检查 | `IncrementalMarkdownBridge.push()` 不在主线程执行 |
| R5-AC8 | 降级 UI 提示 | 手动 UI 验证 / 集成测试 | 积压降级时显示"加速中..."，恢复后自动消失 |
| R5-AC9 | myGen 二次校验 | audit `useStreamCallbacks.ts` | `updateMessageText` 后紧跟 `if (myGen !== generationMapRef.current.get(sid)) return` |
| R5-AC10 | 跨 session 缓存隔离测试 | 运行测试文件 | session A 批准 → session B 的相同 intentKey 不会自动放行 |
| R5-AC11 | useEffect 顺序断言测试 | 运行测试文件 | mock 调用顺序数组与规划文档 12 条 effect 顺序一致 |
| R5-AC12 | store 完整性 e2e | 运行测试文件 | tool-call+tool-result shift 后无悬挂 tool-result；appendMessages 全成功或全失败；512 条消息不崩 |

---

## 附录 A：问题来源映射表

本表将全部 12 份审计报告中的每个问题映射到具体的修复任务。

| 审计报告 | 问题 | 对应任务 |
|----------|------|----------|
| 01_merge_conflicts.md | CardPanel.tsx:866 `=======` 冲突残留 | R1-T1 |
| 01_merge_conflicts.md | 37 个 UU 文件未合并 | R1-T2 |
| 02_tool_call_chain.md | 漏洞1: isAiBusy 与 store 写入竞争 | R1-T8 |
| 02_tool_call_chain.md | 漏洞2: cancelFn 闭包竞争 | R1-T9 |
| 02_tool_call_chain.md | 漏洞3: assertLive() 与 myGen 时序窗口 | R5-T9 |
| 02_tool_call_chain.md | 漏洞4: ApprovalCache 跨 session 意图重放 | R1-T4 |
| 02_tool_call_chain.md | 漏洞5: ApprovalBridge 与 ApprovalQueue 双重超时 | R2-T12 |
| 02_tool_call_chain.md | 漏洞4 的测试验证 | R5-T10 |
| 03_fault_recovery.md | P0: runtime-error 事件不含 retryable 标记 | R1-T5 |
| 03_fault_recovery.md | P0: EventRouter 不处理 runtime-error | R2-T1 |
| 03_fault_recovery.md | P0: EventRouter 不处理 provider-diagnostic | R2-T2 |
| 03_fault_recovery.md | P1: 重试按钮 | R2-T3 |
| 03_fault_recovery.md | P1: streamWithRecovery 指数退避 | R2-T4 |
| 03_fault_recovery.md | P2: 移除 circuit-open 类型 | R4-T10 |
| 03_fault_recovery.md | P2: 重命名 circuit-breaker-e2e.test.ts | R4-T11 |
| 03_fault_recovery.md | P2: 清理 tripsBreaker 字段 | R4-T9 |
| 03_fault_recovery.md | 退避计算验证测试 | R5-T6 |
| 04_store_integrity.md | MS-4: 配对保护（高优先级） | R1-T6 |
| 04_store_integrity.md | appendMessages 原子化（中优先级） | R2-T5 |
| 04_store_integrity.md | SessionStoreSlice 缺少 truncatedToolChainIds（低优先级） | R2-T6 |
| 04_store_integrity.md | ISessionStore 与 SessionStore 签名不一致（低优先级） | R2-T7 |
| 04_store_integrity.md | 端到端 store 完整性测试 | R5-T12 |
| 05_render_pipeline.md | P0: 重复 markdown 解析 | R1-T7 |
| 05_render_pipeline.md | P1: 统一两套渲染管线 | R2-T8 |
| 05_render_pipeline.md | P1: UTF-8 安全截断 | R2-T9 |
| 05_render_pipeline.md | P2: Worker 化增量 markdown 解析 | R5-T7 |
| 05_render_pipeline.md | P2: 积压降级 UI 提示 | R5-T8 |
| 05_render_pipeline.md | P3: textBatcherRef 死代码 | R2-T8 统一管线中连带清理 |
| 05_render_pipeline.md | P3: generationMapRef 清理 | R4-T12 |
| 06_ipc_consistency.md | workbench_apply_update 命令缺失 | R1-T12 关联（安全）但不直接——Rust 端需添加命令 |
| 06_ipc_consistency.md | TelemetryMonitor 使用 invokeResult | R2-T10 |
| 06_ipc_consistency.md | validateInboundMessage hello case 类型安全 | R2-T11 |
| 06_ipc_consistency.md | 新增消息类型四同步清单注释 | R2-T11 附带 |
| 07_build_config.md | agent-workbench Cargo.toml 缺少 [lints] | R3-T11 |
| 07_build_config.md | agent-provider-http Cargo.toml 缺少 [lints] | R3-T11 |
| 07_build_config.md | 无 CI/CD 流水线 | R3-T10 |
| 08_security_residue.md | MessageContent.tsx 无 DOMPurify | R1-T12 |
| 08_security_residue.md | process.rs 11 处 unsafe 无 SAFETY 注释 | R3-T12 |
| 08_security_residue.md | vitest.globalSetup 缺失 API Key 清除 | R4-T7 |
| 09_layer_ac_deviation.md | C2-8: ErrorClassifier 统一——残留调用者 | R1-T11 |
| 09_layer_ac_deviation.md | C2-1: syncRoutes() stub | R3-T1 |
| 10_layer_de_deviation.md | E-3 P0: sessionActions.ts 破损 + session-actions/ 无人引用 | R1-T3 |
| 10_layer_de_deviation.md | E-5 P1: layoutStore.ts 未接入 slices | R1-T10 |
| 10_layer_de_deviation.md | D-1 P1: protocol-inbound/outbound 超标 | R3-T2 |
| 10_layer_de_deviation.md | E-4 P2: ui-selectors.ts 超标 | R3-T3 |
| 11_layer_hi_deviation.md | H-2: tool-hook-observability.ts 类型漂移 | R3-T7 |
| 11_layer_hi_deviation.md | H-2: MiddlewarePipeline 废弃状态 | R3-T8 |
| 11_layer_hi_deviation.md | I-1: concurrency 控制缺失 | R4-T1 |
| 11_layer_hi_deviation.md | I-2: 权限最小化缺失 | R4-T2 |
| 11_layer_hi_deviation.md | I-3: 路径过滤缺失 | R4-T3 |
| 11_layer_hi_deviation.md | I-4: turbo 缓存缺失 | R4-T4 |
| 11_layer_hi_deviation.md | I-5: typecheck 全覆盖缺失 | R4-T5 |
| 11_layer_hi_deviation.md | I-11: 密钥扫描缺失 | R4-T6 |
| 11_layer_hi_deviation.md | I-12: 双 depcruise 配置 | R3-T9 |
| 12_layer_fgj_deviation.md | F-1: ChatProviderGuard/ChatCheckpointActions 未使用 | R3-T4 |
| 12_layer_fgj_deviation.md | F-2g: 未保存切换拦截未实现 | R3-T5 |
| 12_layer_fgj_deviation.md | F-6: useEffect 顺序偏差 | R3-T6 |
| 12_layer_fgj_deviation.md | F-6: AppKeyboardHandler 超行 | R3-T6 |
| 12_layer_fgj_deviation.md | J-4: globalSetup 缺失 CRISH_API_KEY / FLOWBIT_API_KEY | R4-T7 |
| 12_layer_fgj_deviation.md | J-1: FauxAgentProvider 缺 implements | R4-T8 |
| 12_layer_fgj_deviation.md | useChatApproval 无测试 | R5-T1 |
| 12_layer_fgj_deviation.md | useFileNavigation 无测试 | R5-T2 |
| 12_layer_fgj_deviation.md | FauxAgentProvider 无测试 | R5-T3 |
| 12_layer_fgj_deviation.md | StreamRenderBuffer 无测试 | R5-T4 |
| 12_layer_fgj_deviation.md | ChatCard 无测试 | R5-T5 |

---

## 附录 B：Agent 命名与职责约定

| 轮次 | Agent A | Agent B | Agent C | Agent D | Agent E | Agent F | Agent G | Agent H | Agent I | Agent J | Agent K | Agent L |
|------|---------|---------|---------|---------|---------|---------|---------|---------|---------|---------|---------|---------|
| Round 1 | 冲突修复 | 存储架构 | 安全缓存 | 错误事件 | 消息配对 | 渲染管线 | 竞态修复 | 闭包修复 | Store 重构 | 分类器统一 | 安全标记 | 合规检查 |
| Round 2 | EventRouter-主 | EventRouter-诊 | 前端重试 | 故障恢复 | 存储原子 | 类型补全 | 接口对齐 | 管线统一 | UTF-8 | Telemetry | 协议安全 | 超时统一 |
| Round 3 | Registry | 协议拆分 | Selector | 组件清理 | Guard | Bootstrap | Hook类型 | 弃用清理 | 配置统一 | CI基础 | Cargo | SAFETY |
| Round 4 | 并发控制 | 权限最小 | 路径Turbo | 类型覆盖 | 密钥扫描 | 测试隔离 | 测试替身 | 字段清理 | 类型清理 | 测试重命名 | 内存清理 | 回归验证 |
| Round 5 | Approval测试 | Nav测试 | Faux测试 | Stream测试 | ChatCard测试 | 退避验证 | Worker化 | UI提示 | 二次校验 | 缓存测试 | Effect测试 | E2E测试 |

---

## 附录 C：跨轮次依赖矩阵

| 任务 | 前置依赖 | 后续依赖 | 依赖类型 |
|------|----------|----------|----------|
| R1-T1 (CardPanel 冲突) | 无 | R2 全部（编译依赖） | 编译阻断 |
| R1-T2 (37 UU git add) | 无 | R2 全部（编译依赖） | 编译阻断 |
| R1-T3 (sessionActions 修复) | 无 | R5-T12（store e2e 测试） | 测试内容依赖 |
| R1-T5 (runtime-error retryable) | 无 | R2-T1（EventRouter 接收） | 数据流依赖 |
| R1-T7 (重复 markdown 解析) | 无 | R5-T7（Worker 化）, R5-T8（UI 提示） | 优化基础依赖 |
| R1-T10 (layoutStore slices) | 无 | R3-T3（ui-selectors 后续拆分） | 架构对齐 |
| R1-T11 (ErrorClassifier 统一) | 无 | R4-T9（tripsBreaker 清理） | 代码清理依赖 |
| R2-T1 (EventRouter runtime-error) | R1-T5 | R2-T3（重试按钮前端消费） | 数据流依赖 |
| R2-T2 (EventRouter provider-diagnostic) | R1-T5 | R2-T3（重试按钮） | 数据流依赖 |
| R2-T9 (UTF-8 截断) | 无 | R5-T4（StreamRenderBuffer 测试） | 测试内容依赖 |
| R3-T2 (protocol 拆分) | R1-T3 | 无 | — |
| R3-T4 (ChatProviderGuard) | 无 | R5-T5（ChatCard 集成测试） | 测试内容依赖 |
| R3-T10 (CI 基础) | 无 | R4-T1~T6（CI 增强全部依赖此） | 增量修改依赖 |
| R4-T7 (globalSetup API key) | 无 | R5-T3（Faux 测试环境隔离） | 测试环境依赖 |
| R4-T8 (FauxAgentProvider) | 无 | R5-T3（Faux 测试） | 测试内容依赖 |
| R4-T11 (测试重命名) | 无 | R5-T6（退避测试补充） | 测试文件依赖 |
| R5-T9 (二次校验) | R1-T8（isAiBusy）, R1-T9（cancelFn） | 无 | 叠加修复依赖 |

---

## 附录 D：按文件热力图（修改密集度）

以下文件被多个 Agent 修改，需要特别关注合并冲突：

| 文件路径 | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 | 总接触数 |
|----------|---------|---------|---------|---------|---------|----------|
| `session-loop/index.ts` | R1-T5, R1-T11 | — | — | — | — | **2** |
| `useStreamCallbacks.ts` | R1-T7, R1-T9 | R2-T8 | — | R4-T12 | R5-T9 | **4** |
| `EventRouter.ts` | — | R2-T1, R2-T2 | — | — | — | **2** |
| `StreamRenderBuffer.ts` | R1-T7 | R2-T8, R2-T9 | — | — | R5-T7, R5-T8 | **5** |
| `MessageContent.tsx` | R1-T7, R1-T12 | — | — | — | R5-T8 | **3** |
| `store/types.ts` | R1-T7 | — | — | — | R5-T8 | **2** |
| `session-actions/types.ts` | — | R2-T6 | — | — | — | **1** |
| `session-actions/message-actions.ts` | R1-T6 | — | — | — | — | **1** |
| `layoutStore.ts` | R1-T10 | — | — | — | — | **1** |
| `session-store/index.ts` | — | R2-T5, R2-T7 | — | — | — | **2** |
| `session-store/types.ts` | — | R2-T7 | — | — | — | **1** |
| `approval-cache.ts` | R1-T4 | — | — | — | — | **1** |
| `approval-pipeline.ts` | R1-T4 | — | — | — | — | **1** |
| `.github/workflows/ci.yml` | — | — | R3-T10 | R4-T1~T6 | — | **6**（最高） |

---

## 附录 E：轮次完成检查清单

### Round 1 完成检查

| 检查项 | 验证命令 | 预期输出 |
|--------|----------|----------|
| 编译通过 | `npx tsc --noEmit --project apps/crish-desktop/tsconfig.app.json` | Exit code 0，无 TS1185 等语法错误 |
| 无 UU 文件 | `git status --porcelain | grep -c "^UU"` | 0 |
| CardPanel 无冲突 | `grep -n "=======\|<<<<<<<\|>>>>>>>" apps/crish-desktop/src/components/CardPanel.tsx` | 无匹配 |
| ApprovalCache sessionId 隔离 | `grep -n "sessionId" packages/agent-runtime/src/approval/approval-cache.ts` | ≥2 处（get 和 set 签名） |
| runtime-error 含 retryable | `grep -n "retryable" packages/agent-runtime/src/session-loop/index.ts` | ≥1 处（emit 调用处） |
| DOMPurify | `grep -n "DOMPurify\|sanitize" apps/crish-desktop/src/components/MessageContent.tsx` | ≥1 处 |

### Round 2 完成检查

| 检查项 | 验证命令 | 预期输出 |
|--------|----------|----------|
| EventRouter runtime-error | `grep -n "runtime-error" apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | ≥2 处（case 分支 + handler） |
| EventRouter provider-diagnostic | `grep -n "provider-diagnostic" apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | ≥2 处 |
| UTF-8 截断 | `grep -n "TextDecoder\|charCodeAt" packages/shared-utils/src/StreamRenderBuffer.ts` | ≥1 处 |
| Telemetry invokeResult | `grep -n "invokeResult" apps/crish-desktop/src/services/TelemetryMonitor.ts` | ≥1 处 |
| ApprovalBridge 无自有超时 | `grep -n "setTimeout\|TIMEOUT" packages/agent-daemon/src/approval/approval-bridge.ts` | 0 处（或仅引用最小常量） |

### Round 3 完成检查

| 检查项 | 验证命令 | 预期输出 |
|--------|----------|----------|
| syncRoutes 非 stub | `grep -A5 "syncRoutes" packages/agent-runtime/src/provider/provider-registry-v2.ts` | 有实现体代码 |
| protocol-inbound ≤400 行 | `(Get-Content packages/agent-daemon/src/types/protocol-inbound.ts).Length -le 400` | true |
| protocol-outbound ≤400 行 | `(Get-Content packages/agent-daemon/src/types/protocol-outbound.ts).Length -le 400` | true |
| ui-selectors ≤300 行 | `(Get-Content apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts).Length -le 300` | true |
| ChatProviderGuard 清理 | `grep -n "ChatProviderGuard" apps/crish-desktop/src/components/chat/ChatCard.tsx` | 已 import 使用，或文件已删除 |
| Cargo lints | `grep -A1 "\[lints\]" apps/agent-workbench/src-tauri/Cargo.toml packages/agent-provider-http/Cargo.toml` | 两文件均有 `workspace = true` |
| CI 文件存在 | `Test-Path .github/workflows/ci.yml` | true |
| SAFETY 注释完整 | `grep -c "SAFETY:" apps/agent-workbench/src-tauri/src/process.rs` | ≥11 |

### Round 4 完成检查

| 检查项 | 验证命令 | 预期输出 |
|--------|----------|----------|
| concurrency 控制 | `grep -A3 "concurrency:" .github/workflows/ci.yml` | 含 `cancel-in-progress: true` |
| permissions 最小化 | `grep -A1 "permissions:" .github/workflows/ci.yml` | 含 `contents: read` |
| paths-ignore | `grep -A5 "paths-ignore" .github/workflows/ci.yml` | 含 `docs/**`, `*.md` |
| turbo 缓存 | `grep "turbo" .github/workflows/ci.yml` | ≥2 处（命令 + cache） |
| 密钥扫描 | `grep "gitleaks\|trufflehog" .github/workflows/ci.yml` | ≥1 处 |
| globalSetup 完整 | `grep "CRISH_API_KEY\|FLOWBIT_API_KEY\|CONEX_API_KEY" vitest.globalSetup.ts` | 三处均存在 |
| tripsBreaker 已移除 | `grep "tripsBreaker" packages/agent-runtime/src/error-classifier.ts` | 0 处 |

### Round 5 完成检查

| 检查项 | 验证命令 | 预期输出 |
|--------|----------|----------|
| 全部测试通过 | `npx vitest run --reporter=verbose` | All tests pass |
| 新增测试数量 | `Get-ChildItem -Recurse -Filter "*.test.ts" | Where-Object {$_.LastWriteTime -gt (Get-Date).AddDays(-1)} | Measure-Object` | ≥8 个新测试文件 |
| 测试覆盖率（关键模块） | `npx vitest run --coverage --reporter=text` | 关键模块覆盖率 ≥70% |

---

## 附录 F：每轮执行风险与缓解

| 轮次 | 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|------|----------|
| Round 1 | R1-T1 选择错误分支导致功能回归 | 中 | 高 | 在开发环境验证两种分支行为的 diff；选择 `return (...` 分支（包含完整 JSX 结构） |
| Round 1 | R1-T3 修改后 `layoutStore` 或 `sessionStore` 引用断裂 | 高 | 致命 | 修改后全局 grep 旧路径导入；运行 `npx tsc --noEmit` 全量检查 |
| Round 1 | R1-T7 渲染管线改动影响流式渲染显示 | 中 | 高 | 添加 feature flag：若 `streamHtml` 不存在则回退到旧路径（纯文本→解析） |
| Round 2 | R2-T1/R2-T2 EventRouter 修改破坏现有事件处理 | 中 | 高 | 仅新增 case，不修改已有 case；运行 `registry.test.ts` 的穷举验证 |
| Round 2 | R2-T5 appendMessages 原子化导致现有调用方捕获不到部分写入 | 中 | 中 | 调用方代码审计：所有 `appendMessages` 的 try/catch 添加 StoreCapacityError 处理 |
| Round 3 | R3-T4 ChatProviderGuard 删除后 ChatCard 功能缺失 | 中 | 高 | 先确认 ChatCard 中已有内联逻辑完全覆盖 ChatProviderGuard 功能；然后删除 |
| Round 3 | R3-T2 protocol 拆分导致 import 路径断裂 | 中 | 高 | 保留 barrel 文件（`types/index.ts`），外部所有 import 指向 barrel |
| Round 4 | R4-T7 globalSetup 顺序问题导致其他测试依赖的 env 被清除 | 中 | 中 | 测试隔离：仅在需要 API key 的测试文件中使用 `beforeEach` 管理清除/恢复 |
| Round 4 | R4-T4 turbo 缓存命中率低导致 CI 变慢 | 低 | 低 | 精确配置 cache key（基于 lockfile hash + turbo.json hash） |
| Round 5 | 测试 mock 不充分导致假阳性通过 | 中 | 中 | 每个测试文件检查 assertion 数量（`expect.assertions(N)`） |
| Round 5 | R5-T7 Worker 化引入跨线程竞态 | 低 | 中 | 使用 `postMessage` + `onmessage` 的 request-response 模式，避免共享状态 |

---

## 附录 G：文件级修改影响范围总表

| 文件路径 | Round | 修改类型 | 预计行数 | 影响面 | 冲突风险 |
|----------|-------|----------|----------|--------|----------|
| `apps/crish-desktop/src/components/CardPanel.tsx` | R1 | 编辑 | 1-3 行删除 | 仅该组件 | 🟢 低 |
| `apps/crish-desktop/src/store/sessionActions.ts` | R1 | 重写 | ~20 行 | `layoutStore`, `sessionStore` 及其消费者 | 🔴 高 |
| `apps/crish-desktop/src/store/session-actions/index.ts` | R1 | 编辑 | ~5 行 | 同上 | 🔴 高 |
| `packages/agent-runtime/src/approval/approval-cache.ts` | R1 | 重写 | ~30 行 | `approval-pipeline` 及其调用链 | 🟡 中 |
| `packages/agent-runtime/src/approval/approval-pipeline.ts` | R1 | 编辑 | ~5 行 | 同上 | 🟡 中 |
| `packages/agent-runtime/src/session-loop/index.ts` | R1, R1 | 编辑 | ~15 行 | provider 错误处理全链路 | 🟡 中 |
| `apps/crish-desktop/src/store/session-actions/message-actions.ts` | R1 | 编辑 | ~30 行 | 所有消息 shift 路径 | 🟡 中 |
| `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | R1, R1, R4, R5 | 编辑 | ~40 行 | 流式渲染回调和代际守卫 | 🔴 高 |
| `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` | R1 | 编辑 | ~5 行 | 消息发送入口 | 🟢 低 |
| `apps/crish-desktop/src/store/layoutStore.ts` | R1 | 重构 | ~200 行 | 全局 UI 状态管理 | 🔴 高 |
| `apps/crish-desktop/src/components/MessageContent.tsx` | R1, R5 | 编辑 | ~15 行 | 消息内容渲染 | 🟡 中 |
| `apps/crish-desktop/src/store/session-actions/types.ts` | R2 | 编辑 | ~2 行 | 类型定义 | 🟢 低 |
| `packages/agent-runtime/src/session-store/index.ts` | R2 | 编辑 | ~30 行 | 后端存储层 | 🟡 中 |
| `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | R2 | 编辑 | ~50 行 | WebSocket 事件分发中枢 | 🔴 高 |
| `apps/crish-desktop/src/hooks/useChatStream.ts` | R2 | 编辑 | ~20 行 | 聊天流状态管理 | 🟡 中 |
| `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | R2 | 编辑 | ~30 行 | provider 流恢复机制 | 🟡 中 |
| `packages/shared-utils/src/StreamRenderBuffer.ts` | R2, R5 | 编辑 | ~40 行 | 流式渲染缓冲区 | 🟡 中 |
| `packages/agent-runtime/src/provider/provider-registry-v2.ts` | R3 | 编辑 | ~20 行 | Provider 注册中心 | 🟢 低 |
| `packages/agent-daemon/src/types/protocol-inbound.ts` | R3 | 拆分 | ~200 行拆分 | Daemon 协议类型 | 🔴 高 |
| `packages/agent-daemon/src/types/protocol-outbound.ts` | R3 | 拆分 | ~200 行拆分 | Daemon 协议类型 | 🔴 高 |
| `apps/crish-desktop/src/components/chat/ChatCard.tsx` | R3 | 编辑 | ~50 行 | 主聊天面板 | 🟡 中 |
| `apps/crish-desktop/src/components/chat/ChatProviderGuard.tsx` | R3 | 删除/保留 | ~99 行 | 死代码清理 | 🟢 低 |
| `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` | R3 | 删除 | ~15 行 | 死代码清理 | 🟢 低 |
| `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` | R3 | 编辑 | ~30 行 | 文件导航 | 🟢 低 |
| `apps/crish-desktop/src/app/AppBootstrap.ts` | R3 | 重构 | ~30 行 | 应用启动引导 | 🟡 中 |
| `packages/agent-runtime/src/error-classifier.ts` | R4 | 编辑 | ~10 行 | 错误分类 | 🟢 低 |
| `packages/agent-runtime/src/fallback-chain/types.ts` | R4 | 编辑 | ~1 行 | 类型定义 | 🟢 低 |
| `packages/agent-runtime/src/testing/faux-provider.ts` | R4 | 重写 | ~30 行 | 测试替身 | 🟢 低 |
| `vitest.globalSetup.ts` | R4 | 编辑 | ~10 行 | 测试环境隔离 | 🟢 低 |
| `.github/workflows/ci.yml` | R3, R4 | 新建+编辑 | ~80 行 | CI/CD | 🟢 低 |
| `apps/agent-workbench/src-tauri/src/process.rs` | R3 | 编辑 | ~33 行注释 | Rust 安全 | 🟢 低 |

---

## 附录 H：端到端验证场景

以下端到端场景用于在全部 5 轮修复完成后验证系统是否正常工作：

### 场景 H1: 快速连续发送消息（验证竞态防护）
1. 用户连续 3 次发送消息到同一 session（间隔 100ms）
2. **预期**：msg1 进入 processing，msg2/msg3 进入 queued；msg1 完成后依次处理 msg2、msg3
3. **验证**：`streamManagerRef` 中始终只有 1 个活跃条目；无重复的 WebSocket `run-task` 请求

### 场景 H2: 工具审批超时（验证超时路径）
1. Provider 返回 tool_calls（T2 等级工具）
2. 用户不审批等待 5min
3. **预期**：5min 后 tool call 自动 expire，显示"审批超时"错误；状态机继续运行
4. **验证**：`ApprovalQueue.expire()` 被触发 → tool result 含 `decision: "expired"` → UI 显示超时提示

### 场景 H3: 跨 session 审批隔离（验证安全修复）
1. Session A 触发 `edit` 工具并批准
2. 切换到 Session B，立即触发 `edit` 工具
3. **预期**：Session B 的 `edit` 工具不会自动放行，需要再次审批
4. **验证**：ApprovalCache 的 key 含 sessionId；Session B 弹出审批对话框

### 场景 H4: store 容量边界（验证数据完整性）
1. 向 session 连续发送 510 条消息
2. **预期**：第 501 条时触发 FIFO shift，前 10 条被移除；`truncatedToolChainIds` 记录被截断的 toolCall ID
3. 发送第 511 条时 `appendMessages` 因容量满返回全失败（而不是部分写入）
4. **验证**：session 消息数恒 ≤500；`truncatedToolChainIds` 数组递增

### 场景 H5: 流式渲染降级（验证性能修复）
1. Provider 高速返回 token（1000+ tok/s）
2. **预期**：`maxBacklogBytes`(32KB) 超限后中间帧被跳过，用户看到"加速中..."提示
3. 最终 `flush(true)` 强制写入最终文本
4. **验证**：`StreamRenderBuffer.degraded = true` 时 `onFrame` 被跳过；`MessageContent` 显示降级提示

### 场景 H6: Provider 临时故障恢复（验证错误透传）
1. 模拟 Provider 返回 503（transient server error）
2. **预期**：`retryProviderStream` 退避重试（1s → 2s → 4s）→ 第 3 次成功后继续
3. 模拟 3 次全部失败
4. **预期**：`runtime-error` event 含 `retryable: true` → EventRouter 转发 → 前端显示"重试"按钮
5. **验证**：前端点击重试按钮后重新发起 provider 调用

### 场景 H7: CI 门禁验证（验证 CI 配置）
1. 推送含 `docs/` 变更的 commit
2. **预期**：CI 不触发（paths-ignore 生效）
3. 推送含 `src/` 变更的 commit
4. **预期**：CI 触发；turbo 缓存加速；typecheck 覆盖 8 个包；lint 零 warning；depcruise 通过；密钥扫描运行

### 场景 H8: Session 切换时不残留旧回调（验证代际计数器）
1. Session A 正在接收流式响应，用户立即切换到 Session B 并发送消息
2. **预期**：Session A 的旧 WebSocket 连接被取消，旧 `onFrame` 回调被 `assertLive()` + `myGen` 双重阻止写入
3. 验证：Session B 的流式响应写入正确，Session A 的消息不被 Session B 的写入覆盖

### 场景 H9: `workbench_apply_update` 静默降级（验证 IPC 一致性）
1. 在非 Tauri 环境（browser dev）调用更新功能
2. **预期**：不抛异常，`invokeResult` 返回 `{ ok: false, missing: true }`，UI 显示"更新功能仅桌面版可用"
3. 验证：无控制台错误，无未捕获 Promise reject

### 场景 H10: 大文件切换未保存检测（验证 F-2g guard）
1. 在 FileEditor 中编辑文件（产生 dirty 状态）
2. 点击 FileTree 中的另一个文件
3. **预期**：弹窗确认"文件未保存，是否放弃修改？"
4. 用户选择取消→不切换；用户选择确认→切换到新文件

### 场景 H11: 多轮审批链完整性（验证 ApprovalPipeline）
1. Provider 连续返回 3 个工具调用（T1 → T2 → T3）
2. 用户依次批准全部 3 个
3. **预期**：3 个工具全部执行完成，结果按顺序写入 session
4. 用户拒绝第 2 个工具
5. **预期**：第 2 个返回 deny 结果，第 3 个继续执行（状态机不卡死）

### 场景 H12: Edge Case — 空 store 初始化
1. 全新安装后首次启动
2. **预期**：`layoutStore` 从 `slices` 工厂函数获取初始状态；无 crash；`uiSize` 读取 localStorage 默认值（不存在时 fallback 'medium'）
3. 验证：`layoutStore` 状态中 `workspaces` 非空数组

---

## 附录 I：每轮启动条件与步进指南

### Round 1 启动条件
```
前置条件: 无
并行度:   12 个 Agent 完全并行
首批执行: R1-T1 (Agent A) + R1-T2 (Agent A) 最先 → 其余 Agent 等待编译通过
快速验证: git status (UU=0) && npx tsc --noEmit | findstr "error TS" | Measure-Object
预计工时: 2-4 小时
```
**步进流程**:
1. Agent A：修复 CardPanel.tsx 冲突行 + 执行 `git add` 37 个 UU 文件
2. Agent A 验证：`npx tsc --noEmit` 通过，`git status` 无 UU
3. 其余 Agent B~K 并行启动各自任务（互不依赖同一文件）
4. Agent L（合规检查）在所有 Agent 完成后运行回归验证
5. Round 1 完成信号：全部 12 个 AC 通过

### Round 2 启动条件
```
前置条件: Round 1 的 R1-T1/R1-T2/R1-T3（编译基础）已完成
并行度:   12 个 Agent 中 R2-T1/R2-T2 依赖 R1-T5，其余可并行
首批执行: R1-T5 (Round 1) → R2-T1/R2-T2 → R2-T3（串行链路）
独立任务: R2-T4~T12 可在 R1 编译通过后立即启动
预计工时: 3-5 小时
```
**步进流程**:
1. 确认 Round 1 R1-T1/R1-T2/R1-T3 编译已通过
2. Agent A+B+（R2-T1/T2）等待 R1-T5 完成后启动
3. Agent C~L 的独立任务（T4~T12）与 Round 1 同时可启动
4. R2-T12（超时统一）依赖于 R1-T4（ApprovalCache sessionId 隔离）完成后衔接

### Round 3 启动条件
```
前置条件: Round 1 编译通过（R1-T1/T2/T3）
并行度:   12 个 Agent 完全并行
首批执行: 全部 12 个 Agent 可同时启动
注意冲突: R3-T2（protocol 拆分）和 R3-T12（process.rs SAFETY）互相独立
预计工时: 3-6 小时
```
**步进流程**:
1. 确认 Round 1 编译通过（`npx tsc --noEmit` + `cargo check`）
2. 12 个 Agent 全部并行启动
3. Agent C-10（R3-T10 CI 基础）先创建文件骨架，再填充步骤
4. Round 3 完成信号：架构偏差全部消除，文件行数合规

### Round 4 启动条件
```
前置条件: Round 3 的 R3-T10（CI 基础文件）完成
并行度:   12 个 Agent 中 R4-T1~T6 依赖 R3-T10 的 ci.yml 存在，其余可并行
首批执行: R4-T7 (globalSetup) 不需要 CI 文件，可立即启动
独立任务: R4-T8~T12 完全独立，可并行
预计工时: 2-4 小时
```
**步进流程**:
1. 确认 R3-T10 的 `.github/workflows/ci.yml` 存在
2. Agent A~F：在已有 ci.yml 上增量添加 concurrency/permissions/paths-ignore/turbo/typecheck/secretscanner
3. Agent G（R4-T7）可先于 CI 文件启动
4. Agent H~L（R4-T8~T12）完全独立，可任意时间启动
5. Round 4 完成信号：CI 配置完整、残留代码全部删除

### Round 5 启动条件
```
前置条件: Round 1~4 全部完成且编译通过
并行度:   12 个 Agent 完全并行
首批执行: 全部 12 个 Agent 可同时启动
注意冲突: R5-T7（Worker）和 R5-T8（UI 提示）共享 StreamRenderBuffer，需协同
预计工时: 4-8 小时
```
**步进流程**:
1. 确认 Round 1~4 全部验收标准通过
2. 12 个 Agent 全部并行启动
3. Agent G（R5-T7 Worker 化）和 Agent H（R5-T8 UI 提示）协商 `StreamRenderBuffer` 的修改区域
4. 每个测试 Agent 需先确认对应修复任务的代码已合入
5. Round 5 完成信号：`npx vitest run` 全部通过 + 新增 8+ 测试文件

---

## 附录 J：冲突文件合并策略

在处理过程中，以下文件可能被多个 Agent 同时修改，需要实现合并策略：

| 文件 | 涉及 Agent | 合并策略 |
|------|-----------|----------|
| `useStreamCallbacks.ts` | A-6/R1-T7, A-8/R1-T9, B-8/R2-T8, D-11/R4-T12, E-9/R5-T9 | 按行号区域分割：Agent A-6 (L149-155 pre-HTML), A-8 (L163-169 cancelFn), B-8 (管线参数), D-11 (generationMap), E-9 (二次校验)。建议在 Git 分支上依次合并 |
| `StreamRenderBuffer.ts` | A-6/R1-T7, B-8/R2-T8, B-9/R2-T9, E-7/R5-T7, E-8/R5-T8 | 核心文件，建议安排专人在独立分支上完成全部修改后合入主分支 |
| `layoutStore.ts` | A-9/R1-T10 | 大文件重构（514→400 行），建议在独立分支上完成，注意对外暴露的接口不变 |
| `.github/workflows/ci.yml` | C-10/R3-T10, D-1~D-6/R4-T1~T6 | 增量添加：C-10 创建骨架，D-1~D-6 依次追加段落，Git 不会冲突因为不同段落 |
| `EventRouter.ts` | B-1/R2-T1, B-2/R2-T2 | 同一 switch 新增两个相邻 case，两人协商同时合并或依次合并 |
| `session-loop/index.ts` | A-4/R1-T5, A-10/R1-T11 | 同一文件、不同区域（L286 vs L255），可并行修改后用 `git merge-file` 合并 |

---

## 附录 K：关键设计决策说明

### K1: 为什么 R1-T4 ApprovalCache 选择在 key 前缀加入 sessionId 而非 runId？

**决策**：使用 `sessionId:intentKey` 组合键，而非 `runId:intentKey`。

**理由**：runId 的生命周期太短——在同一次 run 的多个 tool call 之间，runId 一致，此时使用 runId 和 sessionId 效果相同。但跨 run 时（同一个 session 的两次连续交互），runId 已改变而 sessionId 不变。使用 sessionId 前缀确保：**同一 session 内的相同意图可缓存**（这是期望行为），但不同 session 的相同意图**不共享缓存**（安全要求）。如果使用 runId，每次新 run 的缓存全部失效，导致 TTL 缓存的功能形同虚设。

**权衡**：用户在同一 session 中两次触发 `edit` 工具，第二次会走缓存（30s TTL）。这是设计意图——用户已在该 session 中表达了对 `edit` 的信任。

### K2: 为什么 R1-T6 选择 splic(0,2) 配对移除而非惰性清理？

**决策**：在 shift 时立即清理配对的 tool-result，而非在读取时惰性过滤。

**理由**：(1) 保持 `truncatedToolChainIds` 的语义纯度——它记录的是"被截断的 toolCall ID"，若 tool-result 飘在消息数组中，`truncatedToolChainIds` 中记录的 ID 对应的 tool-result 仍然存在，语义矛盾；(2) 惰性清理需要在每个读取路径上增加过滤逻辑，遗漏任一读取路径都会导致悬挂 tool-result；(3) 配对移除的复杂度低（O(1) 检查 + O(n) splice），与当前 O(1) shift 相比开销增加有限。

**权衡**：如果 msg[0] 有 toolCalls 但 msg[1] 不是 tool-result（异常状态——正常不可能出现），则降级到普通 shift。该分支仅作防御性编程。

### K3: 为什么 R1-T7 选择存储 HTML 而不是 DOM patch？

**决策**：store 中增加 `streamHtml: string` 字段，而非存储 `chunkUpdates: DomPatch[]`。

**理由**：(1) `streamHtml` 是完整 HTML 字符串，`MessageContent` 直接 `innerHTML` 即可，不需要 DOM patch 应用逻辑；(2) `chunkUpdates` 是增量 diff，应用 patches 需要额外的 `applyDomPatches` 步骤（当前在 `requestIdleCallback` 中已有实现），但若存储 HTML 可以**跳过 markdown 解析**（最耗时的步骤）而保留 DOM patch 的增量应用作为进一步的优化；(3) 存储 HTML 字符串的内存开销略高于纯文本（约 2x），但相比于 bundle size 和解析 CPU 开销，可以接受。

**权衡**：HTML 字符串比纯文本多占约 2x 内存。由于每帧只保留最新的 `streamHtml`（不是全历史），增量成本有限。若内存成为瓶颈，可改用 `chunkUpdates` 存储。

### K4: 为什么 R2-T1 选择在 EventRouter 中新增 case 而非重构为注册式？

**决策**：在已有的 switch 中新增 `case 'runtime-error'` 和 `case 'provider-diagnostic'`，而非重构为注册式 handler。

**理由**：(1) 最小侵入——EventRouter 当前使用 switch 分发 20+ 事件类型，新增 2 个 case 的变更范围最小；(2) 穷举测试 `registry.test.ts` 通过 `extractCases()` 解析 switch case，新增 case 会自动被穷举验证覆盖；(3) 如果改为注册式，需要重构整个 `handleAgentEvent` 方法（~300 行），风险远高于收益。

**权衡**：switch 模式在事件类型增长到 50+ 时会产生大函数（`handleAgentEvent` 已是 300 行），但当前增量（+2 个 case）还在可接受范围内。建议在 50 个 case 时考虑注册式重构。

### K5: 为什么 R3-T4 推荐删除 ChatCheckpointActions 而非实现它？

**决策**：删除 `ChatCheckpointActions` 空壳组件，不在本轮实现 checkpoint/rollback 逻辑。

**理由**：(1) `ChatCheckpointActions` 的 `return null` 表明 checkpoint 功能尚未设计完成——硬要实现会导致不成熟的 API；(2) 当前 ChatCard 中没有任何 checkpoint/rollback 相关代码，说明该功能不是 MVP 需求；(3) 删除死代码比保留 stub 更干净——当真正需要 checkpoint 时，可以从 git history 恢复组件。

**权衡**：如果需要 checkpoint 功能（分支对比、撤销分支等），未来需要重新设计和实现。但保留 stub 会给新开发者造成困惑——"这个组件有什么用？"

### K6: 为什么 R4-T11 选择重命名测试文件而非保留原名？

**决策**：将 `circuit-breaker-e2e.test.ts` 重命名为 `exponential-backoff-e2e.test.ts`，而非保留原名。

**理由**：(1) 文件名与测试内容不匹配会产生误导——开发者搜索 `circuit-breaker` 时不会找到实际的退避测试；反之搜索 `backoff` 时找不到文件；(2) 项目中已无 `CircuitBreaker` 运行时逻辑，保留原名暗示断路器功能仍然存活；(3) 文件重命名在 Git 中可追踪历史（`git mv` 保留 renames），不会丢失 blame 信息。

**权衡**：重命名可能影响 CI 配置中已有的 test path patterns（如果有 `circuit-breaker` 的 include/exclude）。需要确认 `vitest.config.ts` 或 CI 中无硬编码的 test file pattern 匹配该文件名。

### K7: 为什么 R5-T8 的降级提示设计为 2000ms delay fade-out？

**决策**：降级恢复后延迟 2s 再 fade-out 消失提示，而非立即消失。

**理由**：(1) 流式渲染的降级/恢复可能在短时间内频繁切换（用户感知的"闪烁"），2s 延迟确保提示不会在每次降级波动的波谷消失；(2) fade-out 动画（300ms CSS transition）提供视觉平滑过渡；(3) 如果降级在 2s 内再次触发，提示保持显示（计时器重置），避免闪烁。这是典型的 UI 防抖模式。

**权衡**：用户可能在降级消失后再等待 2s 才看到提示消失——但大多数用户不会注意到提示条的消失，而是关注内容区的平滑显示。

### K8: 为什么 R3-T2 选择按领域拆分为子文件而非保持单文件但精简行数？

**决策**：将 protocol-inbound.ts 和 protocol-outbound.ts 按领域拆分为多个子文件（`inbound-run.ts`、`inbound-session.ts` 等），而非通过删除冗余和提取公共类型来压缩行数。

**理由**：(1) 架构规划文档明确要求"≤400 行"，拆分是直接的合规手段；(2) 按领域拆分提高了可维护性——修改 run-task 类型的开发者只需打开 `inbound-run.ts` 而非 500+ 行的大文件；(3) 提取公共类型（`types/common.ts`）是独立的附加收益，可同时减少重复定义。

**权衡**：拆分增加了文件数量（从 2 到 6+），开发者需要了解多文件结构。但 barrel 导出（`types/index.ts`）确保了外部消费者的 import 路径不变。

| 术语 | 定义 |
|------|------|
| **UU** | Git 中的 Unmerged 状态，表示文件在合并时存在冲突尚未解决 |
| **barrel** | 一种模块导出模式，`index.ts` 仅包含 `export * from './submodule'` 语句 |
| **代际计数器** | `useStreamCallbacks.ts` 中的 `myGen` 机制，每次新 run 递增，旧 run 的回调通过比较代际值拒绝写入 |
| **帧预算** | `StreamRenderBuffer` 中 `frameBudget`(12ms) 参数，限制每帧处理时间避免阻塞 UI |
| **降级** | `bufferedLength() > maxBacklogBytes` 时跳过 `onFrame` 回调的机制，减少渲染开销 |
| **配对移除** | `message-actions.ts` 中 tool-call(msg[0]) 与 tool-result(msg[1]) 同时移除，避免悬挂 tool-result |
| **SessionStore** | `packages/agent-runtime/src/session-store/` 中的后端 session 存储，按 branch→shard→message 三级结构 |
| **EventRouter** | 前端 WebSocket 事件分发器，将 daemon 推来的 JSON event 按 type 分发给对应的 handler |
| **ErrorClassifier** | `packages/agent-runtime/src/error-classifier.ts` 中的统一错误分类器，替代分散的 `classifyProviderErrorMessage` 等函数 |
| **ApprovalCache** | 审批意图缓存，在 TTL(30s) 内相同 intentKey 的审批结果可复用 |
| **FauxAgentProvider** | 测试替身类，模拟 AgentProvider 接口用于单元测试 |
| **globalSetup** | `vitest.globalSetup.ts` 中的测试环境隔离层，在测试运行前清除 API key 环境变量 |
| **depcruise** | dependency-cruiser，依赖关系检查工具，确保模块间依赖符合架构约定 |
| **syncRoutes** | `ProviderRegistryV2` 的方法，将注册的 provider 同步到路由目录 |
| **ToolHook** | 工具执行钩子链，提供 `beforeExecute`/`onResult`/`onError` 三个拦截点 |
| **incremental markdown bridge** | `StreamRenderBuffer` 内部的增量 markdown 解析器，每次只解析新增文本而非全文 |

---

## 附录 L：修改后回归测试矩阵

| 修复任务 | 相关单元测试 | 相关集成测试 | 手动验证 |
|----------|-------------|-------------|----------|
| R1-T4 (ApprovalCache sessionId) | `approval-cache.test.ts` (R5-T10) | 无 | 创建两个 session 分别触发相同工具 |
| R1-T5 (runtime-error retryable) | 无（事件 emit 侧） | `EventRouter` 集成测试 | 模拟 provider 503 → 检查前端弹窗 |
| R1-T6 (消息配对) | `store-integrity.e2e.test.ts` (R5-T12) | 无 | 500+ 消息场景手动验证 |
| R1-T7 (预解析 HTML) | `StreamRenderBuffer.test.ts` (R5-T4) | `ChatCard` 集成测试 | 高速 token 流场景 |
| R1-T10 (layoutStore slices) | `layoutStore` 现有测试 | 无 | 检查 UI 状态管理是否正常 |
| R2-T1/T2 (EventRouter) | `registry.test.ts` (穷举) | 无 | 模拟 runtime-error 和 diagnostic |
| R2-T3 (重试按钮) | `useChatApproval.test.ts` (R5-T1) | 无 | 手动触发 503 → 检查重试按钮 |
| R2-T4 (stream退避) | `exponential-backoff-e2e.test.ts` (R5-T6) | 无 | 模拟连续 3 次 503 |
| R2-T5 (appendMessages) | `store-integrity.e2e.test.ts` (R5-T12) | 无 | 510 条消息边界测试 |
| R3-T4 (ChatProviderGuard) | `ChatCard.test.tsx` (R5-T5) | 无 | 检查 provider 检测 UI |
| R3-T7 (ToolHook 类型) | TS 编译检查 | 无 | 无（纯类型改动） |
| R4-T8 (FauxAgentProvider) | `faux-provider.test.ts` (R5-T3) | 无 | 无（测试替身） |
| R4-T11 (测试重命名) | 重命名的测试文件 | 无 | 运行 `npx vitest run` |
| R5-T7 (Worker 化) | `StreamRenderBuffer.test.ts` (R5-T4) | 无 | profile 检查主线程负载 |

---

**方案适应性说明**：本方案假设所有 12 份审计报告的问题均为真实发现且需修复。若在实际执行中发现某些问题已被修复或属于误报，可跳过对应任务并更新验收标准。方案的 5 轮结构允许按需跳过整轮（例如 Round 4 安全加固若经评估非紧急），不影响其他轮次的执行。

**协作建议**：建议在 Git 仓库中为每轮创建独立分支（`fix/round-1` ~ `fix/round-5`），每轮内各 Agent 在子分支上工作后 merge 到轮次分支，降低不同 Agent 修改同一文件的冲突概率。Round 1 的 R1-T1/R1-T2 应在主分支上直接提交（冲突修复不可延迟）。

**关键指标**：方案成功标准——`npx tsc --noEmit` 零错误通过、`npx vitest run` 全部测试通过（含新增 8+ 测试文件）、`cargo clippy` 零 warning、`.github/workflows/ci.yml` 完整可运行、端到端场景 H1~H12 全部验证通过。

**升级路径兼容性**：本方案的所有修改均为向后兼容——不引入破坏性 API 变更，不要求数据库/持久化迁移，不修改 Rust 端的公开 `#[tauri::command]` 签名（除 `workbench_apply_update` 新增外）。旧版本的 store 数据可与新版本共存：`truncatedToolChainIds` 是可选字段（缺失时不会 crash），`streamHtml` 是新增字段（读取时回退到 `parseMarkdownToHtmlAsync`）。ApprovalCache 的 sessionId 参数是可选参数（未传时使用纯 intentKey 的旧逻辑）。这些设计确保了应用可以平滑升级而无需数据迁移。

---

**统计摘要**：
- 审计报告总数：12 份
- 识别问题总数：60 个
- 逻辑轮次：5 轮
- 每轮 Agent 数：12（共 60 个 Agent 席位）
- 涉及源文件：37 个
- 新增文件：约 15 个（含测试文件 8 个、Worker 1 个、CI 2 个、公共类型 1 个、其他 3 个）
- 总估计代码变更：约 2,000 行新增 + 约 400 行删除
- 验收标准总数：60 项（每轮 12 项）
- 端到端验证场景：12 个
- 无时间安排、人员分配、优先级排序（按需求要求）

*文档生成时间：2026-07-24 | 总任务数：60 | 总 Agent 分配数：60（5 轮 × 12 Agent）*
*文档版本：v3.1（最终版，含实现细节、风险矩阵、验证场景、步进指南、术语表、回归矩阵、设计决策说明、兼容性说明、统计摘要）*
