# Conex 代码库综合修复方案

> **生成依据**: Round 12 全部 12 份审计报告 + 实际代码验证
> **方案定位**: 多 Agent 协同修复方案，按逻辑轮次组织，可迭代复用
> **覆盖范围**: 所有 P0/P1/P2 问题，无优先级区分
> **方案结构**: 12 个逻辑轮次，每轮 ≤ 12 个 Agent
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** 文中 `apps/crish-desktop/src/store/session-actions/**` 为**已删除目录**的历史任务路径。现行 session store actions：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts`。勿按下文「切到 session-actions/」执行。

---

> **实现说明**：Agent 1-1 需人工介入确认 `CardPanel.tsx` L865-878 中旧分支（`{activeCardId === 'chat' ? (`）与新分支（`return (...`）的正确取舍。Agent 1-2 对所有 UU 文件执行 `git checkout --ours` 或 `git checkout --theirs` 后 `git add`，完成后验证 `git status` 无 UU。Agent 1-3 在两个 Cargo.toml 的 `[package]` 段后添加 `[lints]\nworkspace = true`。Agent 1-4 的 CI 工作流至少包含：TypeScript 类型检查、ESLint、depcruise、单元/集成测试、npm audit、cargo deny、Rust 构建。Agent 1-5 需将所有 8 个 workspace package 的 `tsc --noEmit` 合并为一个 root 脚本。Agent 1-6 配置 turbo.json 的 `typecheck`/`build`/`test` pipeline 的 `outputs` 缓存。Agent 1-7 在 `SessionStoreSlice` 接口的 L14 后添加 `truncatedToolChainIds?: string[]`。

### Round 1：编译修复与构建基础设施

**目标**：消除阻断编译的合并冲突残留，补齐 Cargo lint 继承与 CI/CD 流水线，建立基础构建门禁

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R1-T1 | 修复 CardPanel.tsx L866 的 `=======` 合并冲突残留，保留正确分支代码 | `apps/crish-desktop/src/components/CardPanel.tsx` | — |
| R1-T2 | 对 37 个 UU 文件执行 `git add` 完成合并标记 | 37 个文件（列表见报告 01 §UU） | R1-T1 |
| R1-T3 | 为 `agent-workbench/src-tauri/Cargo.toml` 添加 `[lints] workspace = true` | `apps/agent-workbench/src-tauri/Cargo.toml` | — |
| R1-T4 | 为 `agent-provider-http/Cargo.toml` 添加 `[lints] workspace = true` | `packages/agent-provider-http/Cargo.toml` | — |
| R1-T5 | 创建 `.github/workflows/` 目录与 CI 工作流（含 typecheck、lint、test、depcruise、npm audit、cargo deny） | `.github/workflows/ci.yml` | — |
| R1-T6 | 在 package.json 添加 `typecheck:ci` 脚本，覆盖全部 8 个 workspace package 的 `tsc --noEmit` | `package.json` | — |
| R1-T7 | 配置 turbo 缓存 pipeline 集成到 CI | `turbo.json` | R1-T5 |
| R1-T8 | 修复 `SessionStoreSlice` 类型定义中缺失 `truncatedToolChainIds` 字段 | `apps/crish-desktop/src/store/session-actions/types.ts:4` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 1-1 | R1-T1 | `apps/crish-desktop/src/components/CardPanel.tsx` |
| Agent 1-2 | R1-T2 | 37 个 UU 文件 |
| Agent 1-3 | R1-T3 + R1-T4 | `apps/agent-workbench/src-tauri/Cargo.toml`, `packages/agent-provider-http/Cargo.toml` |
| Agent 1-4 | R1-T5 | `.github/workflows/ci.yml` |
| Agent 1-5 | R1-T6 | `package.json` |
| Agent 1-6 | R1-T7 | `turbo.json` |
| Agent 1-7 | R1-T8 | `apps/crish-desktop/src/store/session-actions/types.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R1-V1 | 无合并冲突残留 | `git grep "<<<<<<" -- "*.ts" "*.tsx" "*.rs"` | 返回空 |
| R1-V2 | 无 UU 文件 | `git status --porcelain | grep "^UU"` | 返回空 |
| R1-V3 | Cargo lints 继承 | `cargo clippy --workspace` 成功 | 无新增 clippy 报错 |
| R1-V4 | CI 工作流语法正确 | `npx action-validator .github/workflows/ci.yml` (若工具可用) 或人工审核 YAML 缩进 | 通过静态验证 |
| R1-V5 | typecheck:ci 执行无 TS1185 错误 | `npm run typecheck:ci` | 0 errors |
| R1-V6 | `SessionStoreSlice` 包含 `truncatedToolChainIds` | 读取 `session-actions/types.ts` | 字段存在且类型为 `string[]` |
| R1-V7 | 37 个 UU 文件全部 resolved | `git status --porcelain | Measure-Object -Line` 且无 UU | UU 文件数 = 0 |

---

> **实现说明**：Agent 2-1 修改 `message-actions.ts` 的 `addMessage` 方法，在 L40 `sess.messages.shift()` 前插入配对检查：若 `first.toolCalls?.length` 且 `second.toolCallResults?.some(r => first.toolCalls.some(tc => tc.id === r.id))`，则 `splice(0,2)` 移除一对。需谨慎处理边界：数组长度不足 2 时仅 shift 一个。Agent 2-2 在 `appendMessages` 中先检查容量再写入，或改为 `{ written: number, failed: number }` 返回值。Agent 2-3 在 `types.ts` 中定义 `export interface AppendResult { messageCount: number; estimatedTokens: number; }` 让 `appendMessage` 返回此类型对齐 `ISessionStore`。

### Round 2：数据存储完整性与类型安全

**目标**：修复 FIFO 截断时 tool-call/tool-result 配对丢失、appendMessages 原子性缺失、接口签名不一致问题

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R2-T1 | `addMessage` 中 `shift()` 前添加配对清理：当 msg[0] 有 toolCalls 时检查 msg[1] 是否为对应 tool-result，一并 splice 移除 | `apps/crish-desktop/src/store/session-actions/message-actions.ts:27-40` | — |
| R2-T2 | 记录配对移除的 toolCall ID 到 `truncatedToolChainIds` | `message-actions.ts` (与 R2-T1 同位置) | R2-T1 |
| R2-T3 | 将 `appendMessages` 改为「全成功或全失败」语义，或返回 `{ written: number, failed: number }` | `packages/agent-runtime/src/session-store/index.ts` | — |
| R2-T4 | 在 `session-store/types.ts` 中定义 `AppendResult` 类型，让 `SessionStore.appendMessage` 返回符合 `ISessionStore` 接口声明的类型 | `packages/agent-runtime/src/session-store/types.ts` | — |
| R2-T5 | 在 `ISessionStore` 接口中移除 `streamingRenderStates` 字段的 transient 依赖，确保接口只暴露持久化数据 | `packages/agent-runtime/src/session-store/types.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 2-1 | R2-T1 + R2-T2 | `apps/crish-desktop/src/store/session-actions/message-actions.ts` |
| Agent 2-2 | R2-T3 | `packages/agent-runtime/src/session-store/index.ts` |
| Agent 2-3 | R2-T4 + R2-T5 | `packages/agent-runtime/src/session-store/types.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R2-V1 | shift 时配对移除 | 单元测试：构造 tool-call+tool-result 相邻消息，模拟 FIFO 截断 | 配对同时移除，无悬挂 tool-result |
| R2-V2 | truncatedToolChainIds 正确记录 | 验证 shift 后 `truncatedToolChainIds` 数组 | 包含被移除的 toolCall id |
| R2-V3 | appendMessages 部分失败可感知 | 调用方可区分 ALL_OK / PARTIAL / FULL_FAIL | 返回值定义明确的联合类型 |
| R2-V4 | 接口签名一致 | `tsc --noEmit` 检查 ISessionStore/SessionStore 方法签名 | 无类型不兼容错误 |
| R2-V5 | 无 tool-result 作为 msg[0] 的退化场景 | 测试：数组长度=1 且 msg[0] 有 toolCalls 时 shift | 只 shift 一个，不访问越界索引 |

---

> **实现说明**：Agent 3-1 在 `MessageContent.tsx` L95 处导入 `import DOMPurify from 'dompurify'`，将 L98 的 `containerRef.current.innerHTML = wrappedHtml` 改为 `containerRef.current.innerHTML = DOMPurify.sanitize(wrappedHtml)`。Agent 3-2 修改 `ApprovalCache` 的 `get`/`set` 方法：将 `intentKey` 与 `sessionId` 拼接作为内部 key，签名不变但存储时组合。需要修改 `approval-pipeline.ts` 在调用时传入 sessionId。Agent 3-3 在 `process.rs` 每处 `unsafe` 块前添加注释，说明为什么该操作是安全的（如 "SAFETY: GetCurrentProcess always succeeds; handle is not owned"）。Agent 3-4 在 `mcp-stdio-adapter.ts` 白名单定义处添加 JSDoc 注释说明声明键的继承语义。

### Round 3：安全纵深防御

**目标**：修补 XSS 纵深防御缺失（DOMPurify）、审批意图跨 session 泄漏、Rust unsafe 注释缺失

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R3-T1 | 在 `MessageContent.tsx` 的 `innerHTML` 赋值前添加 `DOMPurify.sanitize()` | `apps/crish-desktop/src/components/chat/MessageContent.tsx:96-98` | — |
| R3-T2 | 在 `ApprovalCache` key 中加入 `sessionId` 前缀，防止跨 session 意图重放 | `packages/agent-runtime/src/approval/approval-cache.ts:18` | — |
| R3-T3 | 在 `process.rs` 的 11 处 `unsafe` 块前添加 `// SAFETY:` 注释 | `apps/agent-workbench/src-tauri/src/process.rs` (行: 199,204-213,217-236,287-316,701,704,716-738,746,762-766,772-778,785-792) | — |
| R3-T4 | 在 MCP env 白名单处添加注释说明声明键继承语义 | `packages/agent-runtime/src/mcp-stdio-adapter.ts:141-160` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 3-1 | R3-T1 | `apps/crish-desktop/src/components/chat/MessageContent.tsx` |
| Agent 3-2 | R3-T2 | `packages/agent-runtime/src/approval/approval-cache.ts`, `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| Agent 3-3 | R3-T3 | `apps/agent-workbench/src-tauri/src/process.rs` |
| Agent 3-4 | R3-T4 | `packages/agent-runtime/src/mcp-stdio-adapter.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R3-V1 | DOMPurify 已导入并包裹 innerHTML | 审查 `MessageContent.tsx:95-98` | 使用 `DOMPurify.sanitize(wrappedHtml)` |
| R3-V2 | 跨 session 不再共享审批缓存 | 测试：session A 批准后 session B 相同 intentKey 应重新审批 | B 调用 `handler.requestApproval()` |
| R3-V3 | 所有 unsafe 块有 SAFETY 注释 | 逐行审查 `process.rs` 的 11 处 `unsafe` | 每处 unsafe 均有注释 |
| R3-V4 | DOMPurify 不破坏现有渲染 | 集成测试：渲染含 `<script>` 的 markdown 内容 | 脚本不执行，内容正常显示 |
| R3-V5 | MCP 白名单有语义注释 | 审查 `mcp-stdio-adapter.ts:141` | 有注释说明声明键继承语义 |

---

> **实现说明**：Agent 4-1 在 `session-loop/index.ts` 的 `handleStreamError` 方法中，emit `runtime-error` 前调用 `classifyProviderErrorMessage(errMsg)` 获取分类结果，加入 event payload。需注意该字段未在 `RuntimeEvent` 类型中定义——需要扩展类型定义以包含 `retryable?: boolean`。Agent 4-2 在 `EventRouter.ts` 的 `handleAgentEvent` switch 中添加 `case 'runtime-error':` 和 `case 'provider-diagnostic':`，解析 `retryable` 字段，调用对应前端回调。需确认回调类型签名是否兼容。Agent 4-3 在 Rust 侧实现 `#[tauri::command] fn workbench_apply_update(...)` 或在 `updateStore.ts` 中移除该调用并改为本地仅标记清除。Agent 4-4 将 `TelemetryMonitor.ts:101` 的裸 `invoke()` 改为 `invokeResult('perf_jsonl_append', ...)` 以获得统一的错误处理路径。Agent 4-5 在 `protocol.ts` 头部添加四同步清单注释块，列出新增消息类型需要在哪 4 处同步修改。

### Round 4：IPC 路径与错误传播修复

**目标**：修复 EventRouter 对 `runtime-error` 和 `provider-diagnostic` 的静默丢弃、补齐缺失的 Tauri invoke 命令、统一回调类型

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R4-T1 | 在 `session-loop/index.ts:287` 的 `runtime-error` emit 中加入 `retryable` 标记，调用 `classifyProviderErrorMessage` 分类 | `packages/agent-runtime/src/session-loop/index.ts` | — |
| R4-T2 | 在 `EventRouter.ts` 的 `handleAgentEvent()` 中添加 `runtime-error` case，透传 `retryable` 标记 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | R4-T1 |
| R4-T3 | 在 `EventRouter.ts` 的 `handleAgentEvent()` 中添加 `provider-diagnostic` case，转发 `retryable` 标记 | `EventRouter.ts` | — |
| R4-T4 | 在 Rust 端实现 `workbench_apply_update` 命令并注册到 `register_handlers!()`，或从前端移除该调用 | `apps/agent-workbench/src-tauri/src/main.rs` (新增命令), `apps/crish-desktop/src/api/updateStore.ts:63` | — |
| R4-T5 | 修复 `TelemetryMonitor.ts:101` 使用 `invokeResult` 替代裸 `invoke()` | `apps/crish-desktop/src/services/TelemetryMonitor.ts` | — |
| R4-T6 | 在 `protocol.ts` 头部添加四同步清单注释 | `packages/agent-daemon/src/protocol/protocol.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 4-1 | R4-T1 | `packages/agent-runtime/src/session-loop/index.ts` |
| Agent 4-2 | R4-T2 + R4-T3 | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` |
| Agent 4-3 | R4-T4 | `apps/agent-workbench/src-tauri/src/main.rs`, `apps/crish-desktop/src/api/updateStore.ts` |
| Agent 4-4 | R4-T5 | `apps/crish-desktop/src/services/TelemetryMonitor.ts` |
| Agent 4-5 | R4-T6 | `packages/agent-daemon/src/protocol/protocol.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R4-V1 | runtime-error 事件含 retryable | 模拟 provider 错误，观察 WebSocket agent-end event | payload 含 `retryable: true|false` |
| R4-V2 | EventRouter 有 runtime-error case | `rg "case.*runtime-error" EventRouter.ts` | 存在 |
| R4-V3 | EventRouter 有 provider-diagnostic case | `rg "case.*provider-diagnostic" EventRouter.ts` | 存在 |
| R4-V4 | workbench_apply_update 命令端点 | Rust 端命令注册 + 前端调用无 404 | 接口可调用 |
| R4-V5 | TelemetryMonitor 优雅降级 | 非 Tauri 环境 flush() 不抛异常 | catch 处理 |
| R4-V6 | protocol.ts 四同步清单 | 审查 `protocol.ts` 头部注释块 | 清单列出 4 处必须同步位置 |
| R4-V7 | EventRouter 新增 case 不破坏现有路由 | 现有事件类型测试全部通过 | 回归测试通过 |

---

> **实现说明**：Agent 5-1 在 `useStreamCallbacks.ts` 的 `onFrame` 回调中将 `frame.html` 和 `frame.full` 同时写入 store，而非仅写 `frame.full`。Agent 5-2 在 `SessionMessage` 类型中添加可选 `htmlCache?: string` 和 `chunkUpdates?: ChunkUpdate[]` 字段，并在 `updateMessageText` 中填充。`MessageContent` 优先读取 `htmlCache` 渲染，仅在无缓存时回退到 `parseMarkdownToHtmlAsync`。Agent 5-3 在 `StreamRenderBuffer.ts` 的 `flushFrame()` 中，当 `lastIndexOf('\n')` 返回 -1 时，改用 `TextDecoder` 检查截断点是否为合法 UTF-8 起始字节——若不是则向前回退直到找到合法边界。Agent 5-4 提取 `StreamRenderBuffer` 实例化和 `onFrame` 配置的公共逻辑为共享 hook，主聊天流和 Agent 流调用同一工厂函数。Agent 5-5 在 Worker 线程文件中实现 `IncrementalMarkdownBridge.push()` 的异步版本，主线程通过 `postMessage` 发送增量文本、接收 HTML 结果。Agent 5-6 在 `StreamRenderBuffer` 降级时 `store.setDegraded(true)`，ChatCard 中读取该 flag 后显示非侵入式提示。Agent 5-7 清理 `useStreamingText` 中 `textBatcherRef` 相关代码，确认 `textBatcherIntervalMs`/`textBatcherMaxChars` 配置项已无效果后移除或添加警告日志。Agent 5-8 在 `useStreamCallbacks` 的 `onComplete`/`onError` 回调中添加 `generationMapRef.current.delete(sid)`。

### Round 5：流式渲染管线优化

**目标**：消除重复 markdown 解析（最大性能瓶颈），解决 UTF-8 截断乱码风险，统一渲染管线入口

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R5-T1 | 在 `updateMessageText` 中同时存储 `RenderFrame.html` 或 `chunkUpdates`；`MessageContent` 直接消费预解析 HTML | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:149-155`, `apps/crish-desktop/src/components/chat/MessageContent.tsx` | — |
| R5-T2 | 修改 store 消息类型以支持 `htmlCache` 字段，避免二次 markdown 解析 | `apps/crish-desktop/src/store/types.ts` (SessionMessage) | R5-T1 |
| R5-T3 | `flushFrame()` 中无换行截断改用 `TextDecoder` 感知字符边界，避免 UTF-8 中间截断 | `packages/shared-utils/src/StreamRenderBuffer.ts` | — |
| R5-T4 | 统一主聊天流与 Agent 流的渲染管线入口，提取 `useStreamingText` 为共享 hook | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`, `apps/crish-desktop/src/hooks/useStreamingText.ts` | — |
| R5-T5 | 将增量 markdown 解析迁移到 Worker (`markdownRenderAsync`)，释放主线程帧预算 | `packages/shared-utils/src/IncrementalMarkdownBridge.ts`, worker 文件 | — |
| R5-T6 | 积压降级时在 store 置 flag，UI 显示"加速中..."提示 | `StreamRenderBuffer.ts`, `apps/crish-desktop/src/store/types.ts`, ChatCard UI | — |
| R5-T7 | 清理 `useStreamingText` 中无效的 `textBatcherRef` 代码 | `apps/crish-desktop/src/hooks/useStreamingText.ts` | — |
| R5-T8 | `generationMapRef` 添加 session 关闭时的条目清理 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 5-1 | R5-T1 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` |
| Agent 5-2 | R5-T2 | `apps/crish-desktop/src/store/types.ts` |
| Agent 5-3 | R5-T3 | `packages/shared-utils/src/StreamRenderBuffer.ts` |
| Agent 5-4 | R5-T4 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`, `apps/crish-desktop/src/hooks/useStreamingText.ts` |
| Agent 5-5 | R5-T5 | `packages/shared-utils/src/IncrementalMarkdownBridge.ts` |
| Agent 5-6 | R5-T6 | `StreamRenderBuffer.ts`, ChatCard 组件 |
| Agent 5-7 | R5-T7 | `apps/crish-desktop/src/hooks/useStreamingText.ts` |
| Agent 5-8 | R5-T8 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R5-V1 | 预解析 HTML 被消费 | 性能面板观察 markdown 解析耗时 | `parseMarkdownToHtmlAsync` 调用减少 100% (主聊天流) |
| R5-V2 | UTF-8 安全截断 | 传入含 4 字节 UTF-8 字符的 8193+ 字节字符串 | 无乱码、无 replacement character |
| R5-V3 | 两管线参数一致 | 审查统一后的管线入口 | 共享同一参数源 |
| R5-V4 | 积压降级触发 UI 提示 | 模拟 500+ tok/s 高速流，观察浏览器渲染 | 出现"加速中..."非侵入式提示 |
| R5-V5 | 无可达死代码 | `rg 'textBatcherRef' useStreamingText.ts` | 或移除或仅用一次 |
| R5-V6 | Worker markdown 结果不乱序 | 高速流测试：100 chunks in 200ms | 渲染顺序正确 |
| R5-V7 | generationMapRef 随 session 关闭清理 | 模拟 session 关闭后检查 Map size | 对应条目已 delete |

---

> **实现说明**：Agent 6-1 用 `streamManagerRef.current!.has(sessionId)` 替换 `isAiBusy` 的消息数组遍历——`streamManagerRef` 由 `runStreamingAssistant` 在真正启动流之前立即设置，比 store 写入更早。如果 `streamManagerRef` 尚未建立（首个消息），结果同 `false`。需确保 `streamManagerRef` 在 `handleSendChat` 中可访问（通过 hook 参数或 ref 穿透）。Agent 6-2 将 `cancelFn` 改为 ref 持有：`cancelFnRef.current = actualCancel`；`streamManagerRef` 中存储 `cancel: () => cancelFnRef.current()`，确保闭包始终指向最新值。Agent 6-3 在 `updateMessageText` 调用后立即插入 `if (myGen !== generationMapRef.current.get(sid)) return`。注意这无法完全原子化（两次 JS 语句），但将窗口缩至最小。Agent 6-4 移除 `approval-bridge.ts` 中自有的 `setTimeout` 超时逻辑，改为调用 `ApprovalQueue` 的超时管理。保留 `ApprovalBridge` 作为轻量代理层，不管理超时定时器。

### Round 6：并发竞态与一致性修复

**目标**：修复 `isAiBusy` 竞态窗口、`cancelFn` 闭包竞争、`myGen` 时序窗口、`ApprovalBridge`/`ApprovalQueue` 双重超时

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R6-T1 | 将 `handleSendChat` 中 `isAiBusy` 消息遍历改为 `streamManagerRef.current!.has(sid)` 检查 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:295` | — |
| R6-T2 | 修复 `cancelFn` 闭包竞争：改用 ref 或延迟赋值模式，确保 `cancel()` 在可用前排队 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:163-169` | — |
| R6-T3 | 在 `updateMessageText` 调用后追加二次 `myGen` 校验，防止过期数据写入 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:149-155` | — |
| R6-T4 | 统一超时配置源：移除 `ApprovalBridge` 自有的超时逻辑，完全依赖 `ApprovalQueue` 的超时管理 | `packages/agent-daemon/src/server/approval-bridge.ts`, `packages/agent-daemon/src/approval-queue.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 6-1 | R6-T1 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` |
| Agent 6-2 | R6-T2 + R6-T3 | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` |
| Agent 6-3 | R6-T4 | `packages/agent-daemon/src/server/approval-bridge.ts`, `packages/agent-daemon/src/approval-queue.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R6-V1 | isAiBusy 使用 streamManagerRef | 审查 `useSlashSend.ts:295` | 使用 `streamManagerRef.current!.has(sid)` 替代消息遍历 |
| R6-V2 | cancelFn 在可用前调用不丢 | 单元测试：`streamAssistantResponseApi` 返回前调用 cancel()，验证后续真实 cancel 被调用 | cancelFnRef 模式生效 |
| R6-V3 | 二次 myGen 校验 | 审查 `useStreamCallbacks.ts:153` 后 | 追加 `if (myGen !== generationMapRef.current.get(sid)) return` |
| R6-V4 | 单一超时源 | 审查 `approval-bridge.ts` | 无自有的 `setTimeout`，超时由 `ApprovalQueue` 管理 |
| R6-V5 | 双重超时不再共存 | 审查两个文件确认无重叠超时定时器 | 仅 `ApprovalQueue` 一处定时器 |

---

> **实现说明**：Agent 7-1 从 `FallbackErrorType` 联合类型中移除 `"circuit-open"` 字符串字面量，并检查 `domainToFallbackErrorType` 映射函数确保无对应 case 引用。Agent 7-2 在 `DEFAULT_MATRIX` 中将每个条目的 `tripsBreaker` 字段移除（或设为 `false` 并添加 `@deprecated` 标记），确认该字段在 `error-classifier.ts` 和导入方均不被使用。Agent 7-3 重命名测试文件并新增测试用例：验证 `retryProviderStream` 退避延迟是否符合 min(1000*2^n, 30000)，验证退避重置（连续两次 `call()` 调用退避从 1s 重新开始），验证 3 次耗尽后原样抛出错误。Agent 7-4 在 `stream-recovery.ts` 的 `decideRecovery` 中对「无内容」情况（case C）引入 `retryCount` 状态变量和指数退避 delay，避免短时间快速重试。Agent 7-5 扩展 `onRunError` 回调签名增加 `retryable` 参数，前端在接收 `retryable: true` 时展示重试按钮而非仅文本提示，点击重试时重新调用 `providerGateway.call()`。

### Round 7：故障恢复代码清理与 ErrorClassifier 统一

**目标**：清理 CircuitBreaker 残留引用，统一 ErrorClassifier 调用，补充指数退避测试

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R7-T1 | 从 `FallbackErrorType` 联合类型中移除 `"circuit-open"` | `packages/agent-runtime/src/fallback-chain/types.ts:14` | — |
| R7-T2 | 清理 `error-classifier.ts` 中 `tripsBreaker` 字段（矩阵定义 L42-55） | `packages/agent-runtime/src/error-classifier.ts:42-55` | — |
| R7-T3 | 重命名 `circuit-breaker-e2e.test.ts` → `exponential-backoff-e2e.test.ts`，并补充退避延迟计算验证 | `packages/agent-runtime/src/` 对应测试文件 | — |
| R7-T4 | 为 `streamWithRecovery` 路径（`stream-recovery.ts`）加入指数退避机制 | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | — |
| R7-T5 | 前端 `useChatStream.ts` 的 `onRunError` 引入 `retryable` 参数，UI 显示重试按钮 | `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts`, 对应 UI 组件 | R4-T1 |
| R7-T6 | 补充前端重试按钮逻辑：当 `retryable === true` 时展示重试按钮，调用 `providerGateway.call()` 重新发起最后一次 provider 调用 | 前端 UI 组件 | R7-T5 |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 7-1 | R7-T1 | `packages/agent-runtime/src/fallback-chain/types.ts` |
| Agent 7-2 | R7-T2 | `packages/agent-runtime/src/error-classifier.ts` |
| Agent 7-3 | R7-T3 | `packages/agent-runtime/src/` (测试文件) |
| Agent 7-4 | R7-T4 | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` |
| Agent 7-5 | R7-T5 + R7-T6 | `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts`, UI 组件 |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R7-V1 | 无 `"circuit-open"` 引用 | `rg 'circuit-open' packages/agent-runtime/src/` | 空结果 |
| R7-V2 | error-classifier 无 `tripsBreaker` 字段 | 检查 `DEFAULT_MATRIX` 条目 | 字段已移除或标记废弃 |
| R7-V3 | 指数退避测试验证延迟序列 | `npx vitest run exponential-backoff` | 退避 = min(1000*2^n, 30000) 且重置正确 |
| R7-V4 | streamWithRecovery 有指数退避 | 审查 `stream-recovery.ts` | 有 `retryCount` 和退避计算逻辑 |
| R7-V5 | 重试按钮在 retryable=true 时可见 | 模拟 retryable=true 错误 | 按钮渲染并在点击时重新发起调用 |
| R7-V6 | 重试按钮在 retryable=false 时隐藏 | 模拟 retryable=false 错误 | 不显示按钮，仅显示文字提示 |
| R7-V7 | 测试覆盖率：退避耗尽后透传 | 测试重试 3 次后原样抛错 | 错误对象与原始错误一致 |

---

> **实现说明**：Agent 8-1 将 `session-loop/index.ts:255` 的 `classifyProviderErrorMessage(errMsg)` 替换为 `ErrorClassifier.classify(errMsg, { status, signal })`，注意参数适配——`classifyProviderErrorMessage` 接收单一字符串消息，`ErrorClassifier.classify` 接收 `error` 和可选 `options` 对象，需构造兼容的调用。Agent 8-2 同理处理 `session-loop/types.ts:27`。Agent 8-3 将 `classifyProviderStreamErrorKind` 函数的 if/else 链重构为委托 `ErrorClassifier.classify`，移除以 `defaultRetryableForProviderStreamError` 为代表的重复分类逻辑。Agent 8-4 将 `classifyErrorMessage` 内联字符串匹配改为 `ErrorClassifier.classify` 调用。Agent 8-5 实现 `syncRoutes()`：遍历 `this.providerClasses` 和 `this.providerFactories`，将每个 provider 的路由元数据推入 `StaticProviderRouteCatalog`，确保 `StaticProviderRouteCatalog.getRoute(id)` 返回已注册的路由。注意需要处理重复注册、销毁清理等边界。

### Round 8：Layer A/C 架构偏差修复

**目标**：完成 ErrorClassifier 统一迁移（替换残留调用点），实现 `syncRoutes()`

**前置依赖**：依赖 Round 7 的 ErrorClassifier 清理完成后启动

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R8-T1 | 将 `session-loop/index.ts:255` 的 `classifyProviderErrorMessage` 调用改为 `ErrorClassifier.classify` | `packages/agent-runtime/src/session-loop/index.ts` | R7-T2 |
| R8-T2 | 将 `session-loop/types.ts:27` 的 `classifyProviderErrorMessage` 调用改为 `ErrorClassifier.classify` | `packages/agent-runtime/src/session-loop/types.ts` | R7-T2 |
| R8-T3 | 将 `provider-stream-contract/error.ts:42-61` 的 `classifyProviderStreamErrorKind` 内联分类改为委托 `ErrorClassifier.classify` | `packages/agent-runtime/src/provider-stream-contract/error.ts` | R7-T2 |
| R8-T4 | 将 `provider-stream-contract/normalizer.ts:50-57` 的 `classifyErrorMessage` 改为使用 `ErrorClassifier` | `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` | R7-T2 |
| R8-T5 | 实现 `ProviderRegistryV2.syncRoutes()` 逻辑，将新注册的 Provider 同步到 `StaticProviderRouteCatalog` | `packages/agent-runtime/src/provider-registry-v2.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 8-1 | R8-T1 | `packages/agent-runtime/src/session-loop/index.ts` |
| Agent 8-2 | R8-T2 | `packages/agent-runtime/src/session-loop/types.ts` |
| Agent 8-3 | R8-T3 | `packages/agent-runtime/src/provider-stream-contract/error.ts` |
| Agent 8-4 | R8-T4 | `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` |
| Agent 8-5 | R8-T5 | `packages/agent-runtime/src/provider-registry-v2.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R8-V1 | session-loop 无 `classifyProviderErrorMessage` | `rg 'classifyProviderErrorMessage' session-loop/` | 0 匹配 |
| R8-V2 | provider-stream-contract 委托 ErrorClassifier | 审查 `error.ts:42` | 调用 `ErrorClassifier.classify` |
| R8-V3 | normalizer.ts 无内联 classifyErrorMessage | 审查 `normalizer.ts:50-57` | 委托 ErrorClassifier |
| R8-V4 | syncRoutes 非 no-op | 注册 provider 后查询 RouteCatalog | 路由存在 |
| R8-V5 | 重复注册 syncRoutes 不崩溃 | 同 id 注册两次后 syncRoutes | 覆盖而非报错 |
| R8-V6 | ErrorClassifier 测试覆盖率 ≥ 80% | `npx vitest run --coverage --related` | lines ≥ 80% |

---

> **实现说明**：Agent 9-1 首先确认 `sessionActions.ts` import 的 `./actions/chat`、`./actions/session`、`./actions/agent`、`./actions/composer` 四个目录是否存在——若不存在则创建 barrel 文件指向 `session-actions/` 下对应子模块，或将 `sessionActions.ts` 直接改写为 `export * from './session-actions/index'`。然后将所有 `import { createSessionActions } from './sessionActions'` 的消费者改为 `import { createSessionActions } from './session-actions'`。Agent 9-2 将 `layoutStore.ts` 中目前内联的 4 组状态/action（ui / terminal / permission / diff）分别迁移到对应 `slices/*.ts` 的工厂函数中，在 `layoutStore.ts` 中 `useStore` 调用各 `createXxxActions()`。Agent 9-3 分析 `protocol-inbound.ts` 和 `protocol-outbound.ts` 中可提取的公共类型（如 `DaemonCorrelationFields`、时间戳类型、基础消息结构），移入新建的 `types/common.ts`。Agent 9-4 将 `ui-selectors.ts` 按领域拆分为 `ui-state-selectors.ts`、`ui-settings-selectors.ts`、`ui-layout-selectors.ts` 等子文件，每文件 ≤ 300 行。

### Round 9：Layer D/E 架构偏差修复

**目标**：修复 `sessionActions.ts` 破损实现，将 `layoutStore` 接入 slices，拆分超标的 protocol 类型文件

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R9-T1 | 将 `sessionActions.ts` 转为 barrel（re-export from `session-actions/index.ts`），修复 `./actions/` 不存在目录的 import | `apps/crish-desktop/src/store/sessionActions.ts`, `apps/crish-desktop/src/store/session-actions/index.ts` | — |
| R9-T2 | 将所有 `sessionActions.ts` 的消费者改为引用 `session-actions/index.ts` | `apps/crish-desktop/src/store/layoutStore.ts`, `apps/crish-desktop/src/store/sessionStore.ts` | R9-T1 |
| R9-T3 | 将 `layoutStore.ts` 中内联的状态/action 迁移到 `slices/` 目录的工厂函数，并接入 4 个 slice | `apps/crish-desktop/src/store/layoutStore.ts`, `apps/crish-desktop/src/store/slices/ui-slice.ts`, `slices/terminal-slice.ts`, `slices/permission-slice.ts`, `slices/diff-slice.ts` | — |
| R9-T4 | 将 `protocol-inbound.ts`（537 行）和 `protocol-outbound.ts`（601 行）按领域进一步拆分，创建 `types/common.ts` 提取交叉类型 | `packages/agent-daemon/src/types/protocol-inbound.ts`, `protocol-outbound.ts` | — |
| R9-T5 | 将 `layout-helpers/ui-selectors.ts`（414 行）按规划 ≤300 行上限拆分 | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 9-1 | R9-T1 + R9-T2 | `apps/crish-desktop/src/store/sessionActions.ts`, `apps/crish-desktop/src/store/session-actions/index.ts`, `layoutStore.ts`, `sessionStore.ts` |
| Agent 9-2 | R9-T3 | `apps/crish-desktop/src/store/layoutStore.ts`, `slices/*.ts` |
| Agent 9-3 | R9-T4 | `packages/agent-daemon/src/types/protocol-inbound.ts`, `protocol-outbound.ts` |
| Agent 9-4 | R9-T5 | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R9-V1 | sessionActions.ts 是 barrel 且编译通过 | `tsc --noEmit` — 无 `./actions/` 不存在错误 | 0 错误 |
| R9-V2 | session-actions/index.ts 有消费方 | `rg "from.*session-actions" src/` | ≥ 2 个引用 |
| R9-V3 | layoutStore 行数 ≤ 400 | `wc -l layoutStore.ts` | ≤ 400 |
| R9-V4 | protocol-inbound.ts ≤ 400 行 | `wc -l` | ≤ 400 |
| R9-V5 | protocol-outbound.ts ≤ 400 行 | `wc -l` | ≤ 400 |
| R9-V6 | ui-selectors.ts ≤ 300 行 | `wc -l` | ≤ 300 |
| R9-V7 | types/common.ts 存在 | 文件存在性检查 | 存在 |
| R9-V8 | layoutStore 功能不变 | 现有 layoutStore 测试全部通过 | 全部通过 |

---

> **实现说明**：Agent 10-1 在 `ci.yml` 的 workflow 级别添加 `concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true` 和 `permissions: contents: read` 及 `paths-ignore: ['docs/**', '*.md', 'assets/**']`。Agent 10-2 将 CI 中的直接命令替换为 `turbo run typecheck build test --filter=...`，确保 `turbo.json` 已定义各任务的 output/cache 配置。Agent 10-3 新增 gitleaks/trufflehog job：`uses: gitleaks/gitleaks-action@v2` 或 `run: npx trufflehog git --since-last-commit`。Agent 10-4 在 CI 中添加 vitest `--coverage.threshold` 参数或添加独立的 vitest config 设置 `coverage.thresholds.lines: 50`（参考 Rust 侧 50% 阈值）。Agent 10-5 将 `tool-hook-observability.ts` 的 `ToolHook` 接口定义替换为 `import type { ToolHook } from '../tool-hook-types'`，移除自有的重复定义。Agent 10-6 删除 `.dependency-cruiser.js` 并确保 CI 仅使用 `.dependency-cruiser.cjs`。Agent 10-7 修改规划文档 §4.2 ToolHook 接口从 6 方法更新为 3 方法（beforeExecute / onResult / onError）。Agent 10-8 在 `middleware-pipeline.ts` 头部添加 `@removeWhen` 注释指定目标版本（如 v2.0），或直接移除（需确认无外部消费者）。

### Round 10：Layer H/I 架构偏差与 CI 门禁补齐

**目标**：补齐 CI 门禁全部缺失项（concurrency/permissions/paths/turbo/typecheck/secret-scan），修复 ToolHook 类型漂移，消除 depcruise 双配置维护风险

**前置依赖**：依赖 Round 1 CI 基础工作流创建完成后启动

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R10-T1 | CI 添加 `concurrency:` 控制（cancel-in-progress） | `.github/workflows/ci.yml` | R1-T5 |
| R10-T2 | CI 添加 `permissions: contents: read` 最小化权限 | `.github/workflows/ci.yml` | R1-T5 |
| R10-T3 | CI 添加 `paths-ignore: ['docs/**', '*.md', 'assets/**']` | `.github/workflows/ci.yml` | R1-T5 |
| R10-T4 | CI 集成 turbo 缓存（`turbo run typecheck build test`） | `.github/workflows/ci.yml` | R1-T7 |
| R10-T5 | CI 添加密钥扫描 job（gitleaks/trufflehog） | `.github/workflows/ci.yml` | R1-T5 |
| R10-T6 | CI 添加 TypeScript 覆盖率阈值验证 | `.github/workflows/ci.yml`, vitest config | — |
| R10-T7 | 修复 `tool-hook-observability.ts` 改为从 `tool-hook-types.ts` 导入 `ToolHook` 接口 | `packages/agent-runtime/src/hooks/tool-hook-observability.ts` | — |
| R10-T8 | 删除 `.dependency-cruiser.js` 或统一为 `.dependency-cruiser.cjs` | `.dependency-cruiser.js`, `.dependency-cruiser.cjs` | — |
| R10-T9 | 在规划文档中将 ToolHook 接口从 6 方法更新为 3 方法及实际签名 | `docs/crish_desktop_architectural_remediation_plan/08_tool_hook_chain.md` | — |
| R10-T10 | 制定 `middleware-pipeline.ts` 移除计划（设目标版本） | `packages/agent-runtime/src/middleware-pipeline.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 10-1 | R10-T1 + R10-T2 + R10-T3 | `.github/workflows/ci.yml` |
| Agent 10-2 | R10-T4 | `.github/workflows/ci.yml`, `turbo.json` |
| Agent 10-3 | R10-T5 | `.github/workflows/ci.yml` |
| Agent 10-4 | R10-T6 | `.github/workflows/ci.yml`, vitest config |
| Agent 10-5 | R10-T7 | `packages/agent-runtime/src/hooks/tool-hook-observability.ts` |
| Agent 10-6 | R10-T8 | `.dependency-cruiser.js`, `.dependency-cruiser.cjs` |
| Agent 10-7 | R10-T9 | `docs/.../08_tool_hook_chain.md` |
| Agent 10-8 | R10-T10 | `packages/agent-runtime/src/middleware-pipeline.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R10-V1 | CI 有 concurrency 控制 | 审查 `ci.yml` | `concurrency:` 块存在且含 `cancel-in-progress` |
| R10-V2 | CI 有 permissions 最小化 | 审查 | `permissions: contents: read` |
| R10-V3 | CI 有 paths-ignore 过滤 | 审查 | `paths-ignore` 含 docs/*.md/assets |
| R10-V4 | CI 使用 turbo 构建 | 审查 | `turbo run typecheck build test` 替换裸命令 |
| R10-V5 | CI 有密钥扫描 job | 审查 job 列表 | gitleaks/trufflehog 步骤 |
| R10-V6 | CI 有 TS 覆盖率阈值 | 审查 vitest config | `coverage.thresholds.lines >= 50` |
| R10-V7 | 单份 depcruise 配置 | `ls .dependency-cruiser.*` | 仅 1 个文件 |
| R10-V8 | observability 导入 types 而非自声明 | 审查 `tool-hook-observability.ts:17-21` | 使用 `import type { ToolHook } from '...'` |
| R10-V9 | 规划文档方法数正确 | 审查 `08_tool_hook_chain.md §4.2` | ToolHook = 3 方法 |

---

> **实现说明**：Agent 11-1 分析 `ChatCard.tsx` 中内联的 `fetchEngineStatus` / `applyResolvedModelLabel` / `hydrateTimedOut` 逻辑，将其移入 `ChatProviderGuard` 组件并在 `ChatCard` 中渲染 `<ChatProviderGuard>` 替代内联代码。若集成成本过高，则删除 `ChatProviderGuard.tsx` 文件。Agent 11-2 在 `useFileNavigation` 中添加 `isDirty` ref 和 `import { useFilePreview } from './useFilePreview'`，接收 `dirty` 状态；添加 `confirmNavigation(): Promise<boolean>` 方法，在导航前检测 dirty 并弹窗确认。`useFilePreview` 暴露 `onDirtyChange?: (dirty: boolean) => void` 回调。Agent 11-3 将 `class FauxAgentProvider implements Pick<AgentProvider, "id">` 改为 `class FauxAgentProvider implements AgentProvider`，补全缺失的必需方法（`init`、`dispose`、`healthCheck` 等），若不需要则添加 `// @ts-expect-error -- only for test scenario` 注释或 mock 实现。Agent 11-4 在 `PROVIDER_API_KEYS` 数组中追加 `'CRISH_API_KEY'`、`'FLOWBIT_API_KEY'`，并为 `CONEX_API_KEY_` prefix 添加通配逻辑：检查所有以 `CONEX_API_KEY_` 开头的环境变量并清除。Agent 11-5 若 `ChatCheckpointActions` 无实际功能则直接移除组件和引用；若有计划中的功能，在组件内加入 TODO 注释和基础骨架。Agent 11-6 重新排列 `AppBootstrap.ts` 中的 useEffect 块顺序：#4 (initLayoutStorePersistence) → #5 (bootstrapServices) → #6 (crash detection) → #7 (bootstrapStores) → #8 (rebind) → #9 (workspace layout sync) → #10 (theme/font/settings) → #2 (AUTO_FOLD_DELAY) → #3 (document.title) → #12 (WindowResizeBridge)。Agent 11-7 将 `useAppKeyboard` 按键盘快捷键领域拆分为 `useFocusShortcuts`、`useNavigationShortcuts`、`useEditingShortcuts` 等子 hook，每文件 ≤ 120 行。

### Round 11：Layer F/G/J 架构偏差修复

**目标**：修复 ChatProviderGuard 未使用、F-2g 未保存切换拦截缺失、FauxAgentProvider 接口契约不完整、globalSetup 缺密钥、ChatCheckpointActions 空桩、AppKeyboardHandler 超标、useEffect 顺序

**前置依赖**：无

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R11-T1 | 将 `ChatProviderGuard` 集成到 `ChatCard` 中（提取 `fetchEngineStatus` / `applyResolvedModelLabel` / `hydrateTimedOut` 逻辑），或删除废弃的死代码 | `apps/crish-desktop/src/components/chat/ChatCard.tsx`, `ChatProviderGuard.tsx` | — |
| R11-T2 | 补全 F-2g：`useFileNavigation` 接收 `dirty` 状态，添加 `isDirty()` / `confirmNavigation()` guard；`useFilePreview` 暴露 `onDirtyChange` | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`, `useFilePreview.ts` | — |
| R11-T3 | 将 `FauxAgentProvider` 从 `Pick<AgentProvider, "id">` 改为 `implements AgentProvider`，确保接口契约完整 | `packages/agent-runtime/src/testing/faux-provider.ts` | — |
| R11-T4 | 在 globalSetup 中追加 `CRISH_API_KEY`、`FLOWBIT_API_KEY` 以及对 `CONEX_API_KEY_` prefix 通配清除 | `vitest.globalSetup.ts` | — |
| R11-T5 | 移除或实现 `ChatCheckpointActions`（当前为空壳 stub 仅返回 null） | `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` | — |
| R11-T6 | 调整 AppBootstrap 中 useEffect 顺序使之与规划文档一致（#2/#3/#4/#5/#6/#7 按规划顺序重新排列） | `apps/crish-desktop/src/app/AppBootstrap.ts` | — |
| R11-T7 | 拆分 `useAppKeyboard`（190 行 > 120 行上限）为多个领域子 hook | `apps/crish-desktop/src/hooks/useAppKeyboard.ts` | — |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 11-1 | R11-T1 | `apps/crish-desktop/src/components/chat/ChatCard.tsx`, `ChatProviderGuard.tsx` |
| Agent 11-2 | R11-T2 | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`, `useFilePreview.ts` |
| Agent 11-3 | R11-T3 | `packages/agent-runtime/src/testing/faux-provider.ts` |
| Agent 11-4 | R11-T4 | `vitest.globalSetup.ts` |
| Agent 11-5 | R11-T5 | `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` |
| Agent 11-6 | R11-T6 | `apps/crish-desktop/src/app/AppBootstrap.ts` |
| Agent 11-7 | R11-T7 | `apps/crish-desktop/src/hooks/useAppKeyboard.ts` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R11-V1 | ChatProviderGuard 被使用或移除 | 审查 ChatCard import | 已使用或已删除 |
| R11-V2 | useFileNavigation 有 dirty guard | `rg 'isDirty|confirmNavigation' useFileNavigation.ts` | 两者实现 |
| R11-V3 | useFilePreview 暴露 onDirtyChange | `rg 'onDirtyChange' useFilePreview.ts` | 存在回调 |
| R11-V4 | FauxAgentProvider 使用 implements | 审查 `faux-provider.ts:4` | `implements AgentProvider` |
| R11-V5 | globalSetup 包含所有缺失密钥 | 审查 `PROVIDER_API_KEYS` | CRISH + FLOWBIT + CONEX_API_KEY_ prefix 通配 |
| R11-V6 | ChatCheckpointActions 非空或是已删除 | 审查 | 已实现或文件已删除 |
| R11-V7 | AppBootstrap useEffect 顺序正确 | 对照规划文档审查 | 顺序: #4→#5→#6→#7→#8→#9→#10→#2→#3→#12 |
| R11-V8 | useAppKeyboard 拆分后每文件 ≤ 120 行 | `wc -l` 各子文件 | 全部 ≤ 120 |
| R11-V9 | 全部 layoutStore 功能不受影响 | 现有测试通过 | 全部通过 |

---

> **实现说明**：所有测试按 AAA（Arrange-Act-Assert）模式编写。Agent 12-1 测试 `approveTool` / `denyTool` / `expire` 三种决议路径，模拟代际计数器变更时旧回调被丢弃。Agent 12-2 测试 `isDirty=true` 时导航触发弹窗、`isDirty=false` 时导航直接通过。Agent 12-3 测试 `setEvents` 后 `stream()` 产出事件序列、`setError` 后 `stream()` 抛出错误、`setLatency` 后 `stream()` 延迟符合预期、`setFailAfter(2)` 后第 3 次调用返回空。Agent 12-4 测试 `maxBacklogBytes` 超限时 `onFrame` 被跳过、正常状态下 `onFrame` 被调用、`flush(true)` 强制路径不受降级影响、UTF-8 截断无乱码。Agent 12-5 使用 `@testing-library/react` 渲染 `ChatCard` 和 `FilesCard`，测试基本渲染和交互（消息列表、文件树展开/收起）。Agent 12-6 测试 `FauxCallGateway` 的 `executeToolBatch` 路由、`mock-tool` 的 `execute` 方法返回预期结果。Agent 12-7 使用 `vi.advanceTimersByTime` 验证退避延迟序列、重试耗尽后原样抛出、非重试错误直接透传。Agent 12-8 构造两个 session 的相同 intentKey，验证第一个 session 的批准不导致第二个 session 自动放行。Agent 12-9 测试消息数达到上限后 `appendMessages` 的行为，验证返回值区分全成功/部分成功。Agent 12-10 测试 slice 接入后 layoutStore 所有 action 的功能正确性。Agent 12-11 用 describe.each 参数化测试全部子工厂的边界条件。

### Round 12：测试覆盖补齐

**目标**：为全部审计报告指出的缺失测试点创建单元测试/集成测试，确保各修复的稳定性与可回归性

**前置依赖**：依赖 Round 1–11 全部完成后启动，确保测试可验证修复后的代码

**任务分解**：

| 任务ID | 内容 | 涉及文件 | 前置任务 |
|--------|------|---------|---------|
| R12-T1 | 为 `useChatApproval` 创建测试（竞态守卫、代际计数器、approval resolution） | `apps/crish-desktop/src/components/chat/hooks/__tests__/useChatApproval.test.ts` | R6-T2, R6-T3 |
| R12-T2 | 为 `useFileNavigation` 创建测试（dirty guard、navigation confirm） | `apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.ts` | R11-T2 |
| R12-T3 | 为 `FauxAgentProvider` 创建测试（setEvents/setError/setLatency/setFailAfter/stream） | `packages/agent-runtime/src/testing/__tests__/faux-provider.test.ts` | R11-T3 |
| R12-T4 | 为 `StreamRenderBuffer` 创建测试（降级路径、maxBacklogBytes、UTF-8 截断） | `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts` | R5-T3 |
| R12-T5 | 为 `ChatCard` 和 `FilesCard` 创建渲染/交互测试 | `apps/crish-desktop/src/components/chat/__tests__/ChatCard.test.tsx`, `apps/crish-desktop/src/components/files/__tests__/FilesCard.test.tsx` | R11-T1 |
| R12-T6 | 为 `FauxCallGateway` 和 `mock-tool` 创建测试 | `packages/agent-runtime/src/testing/__tests__/faux-call-gateway.test.ts`, `mock-tool.test.ts` | — |
| R12-T7 | 为指数退避补充测试（退避计算、退避重置、重试耗尽后错误透传） | `packages/agent-runtime/src/__tests__/exponential-backoff.test.ts` | R7-T3 |
| R12-T8 | 为 `ApprovalCache` session 隔离测试 | `packages/agent-runtime/src/approval/__tests__/approval-cache.test.ts` | R3-T2 |
| R12-T9 | 为 `appendMessages` 原子性测试 | `packages/agent-runtime/src/session-store/__tests__/append-messages.test.ts` | R2-T3 |
| R12-T10 | 为 `layoutStore` slices 接入后功能测试 | `apps/crish-desktop/src/store/__tests__/layoutStore.test.ts` | R9-T3 |
| R12-T11 | 为 `session-actions` 全部子工厂创建合约测试 | `apps/crish-desktop/src/store/session-actions/__tests__/` 目录 | R9-T1, R9-T2 |

**Agent 分配**：

| Agent | 任务聚合 | 独占文件 |
|-------|---------|---------|
| Agent 12-1 | R12-T1 | `apps/crish-desktop/src/components/chat/hooks/__tests__/useChatApproval.test.ts` |
| Agent 12-2 | R12-T2 | `apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.ts` |
| Agent 12-3 | R12-T3 | `packages/agent-runtime/src/testing/__tests__/faux-provider.test.ts` |
| Agent 12-4 | R12-T4 | `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts` |
| Agent 12-5 | R12-T5 | `apps/crish-desktop/src/components/chat/__tests__/ChatCard.test.tsx`, `FilesCard.test.tsx` |
| Agent 12-6 | R12-T6 | `packages/agent-runtime/src/testing/__tests__/faux-call-gateway.test.ts`, `mock-tool.test.ts` |
| Agent 12-7 | R12-T7 | `packages/agent-runtime/src/__tests__/exponential-backoff.test.ts` |
| Agent 12-8 | R12-T8 | `packages/agent-runtime/src/approval/__tests__/approval-cache.test.ts` |
| Agent 12-9 | R12-T9 | `packages/agent-runtime/src/session-store/__tests__/append-messages.test.ts` |
| Agent 12-10 | R12-T10 | `apps/crish-desktop/src/store/__tests__/layoutStore.test.ts` |
| Agent 12-11 | R12-T11 | `apps/crish-desktop/src/store/session-actions/__tests__/` |

**验收标准**：

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| R12-V1 | 创建 ≥ 11 个新增测试文件 | `Get-ChildItem -Recurse -Filter "*.test.ts" | Where-Object { $_.LastWriteTime -gt (Get-Date "2026-07-24") } | Measure-Object` | ≥ 11 |
| R12-V2 | 全部新增测试通过 | `npx vitest run --reporter=verbose` 报告中新增测试 | 100% pass |
| R12-V3 | 审计报告缺失测试全部覆盖 | 对照 12 份报告中所有 "缺失测试" 条目逐条核查 | 全部覆盖 |
| R12-V4 | StreamRenderBuffer 降级路径验证 | 测试构造 > MAX_BACKLOG 场景 | onFrame 被跳过 |
| R12-V5 | ApprovalCache session 隔离验证 | 跨 session 相同 intentKey 不命中缓存 | handler.requestApproval 被调用 |
| R12-V6 | useChatApproval 竞态守卫验证 | 代际计数器递增后旧回调写入被阻止 | 旧数据不进入 store |
| R12-V7 | appendMessages 原子性验证 | 达容量上限时返回具体失败计数 | 返回值区分成功/失败 |
| R12-V8 | 无新增 flaky tests | 连续运行 3 次 `npx vitest run` | 每次结果一致 |

---

## 跨轮次风险与缓解措施

| 风险 | 影响轮次 | 触发条件 | 缓解措施 |
|------|---------|---------|---------|
| CardPanel.tsx 合并冲突人工决策错误 | R1 | Agent 1-1 选错分支 | 两个分支的 JSX 结构需对比确认；保留带完整 `return` 语句的活跃分支 |
| Agent 6-1 的 streamManagerRef 在 handleSendChat 中不可访问 | R6 | hook 作用域隔离 | 若 streamManagerRef 不在作用域内，可通过 useRef 提升或通过 store 的全局引用传递 |
| Agent 8 ErrorClassifier 迁移导致其他调用点遗漏 | R8 | 搜索不彻底 | 全局 grep `classifyProviderErrorMessage` 和 `classifyProviderStreamError` 确认 0 遗漏后提交 |
| Agent 9 layoutStore 接入 slices 破坏现有 store 状态 | R9 | 状态 key 映射错误 | pairs：逐个 slice 迁移并运行 layoutStore 测试验证状态一致性 |
| Agent 5 预解析 HTML 存储增加 store 大小 | R5 | 每条消息存储 HTML | HTML 存储在 `htmlCache` 字段中仅在流式渲染期间存在，完成后可清理；设置 TTL 或仅在 streamingRenderStates 存在时保留 |
| Agent 5 Worker 化 markdown 解析引入异步竞态 | R5 | 多个 Worker 消息乱序 | 使用序列号标记每个 Worker 消息，接收方按序重组；丢弃过期序列号的结果 |
| Agent 10-5 类型导入导致循环依赖 | R10 | tool-hook-types.ts → tool-hook-observability.ts 相互引用 | 确保 tool-hook-types.ts 不反向引用 observability 文件；如需要可提取公共接口到独立文件 |
| Agent 11-3 implements AgentProvider 时需补全大量方法 | R11 | AgentProvider 接口庞大 | 使用 `Partial<AgentProvider>` + throws "not implemented" 或使用类适配模式 |
| Agent 12 Round 12 启动时部分前序修复未到位 | R12 | 前序轮次跳过 | Round 12 应在所有前序轮次全部验收通过后启动；CI 门禁确保回归 |

---

## 附录 D：验收标准扩展矩阵

每个轮次的验收标准按以下维度全面覆盖：

| 维度 | 说明 | 验证工具 | 覆盖轮次 |
|------|------|---------|---------|
| 编译通过 | `tsc --noEmit` 或 `cargo build` 无新增错误 | tsc / cargo | R1, R2, R5, R7, R8, R9, R10, R11 |
| 测试通过 | vitest/cargo test 相关测试通过 | vitest / cargo test | R2, R3, R4, R5, R6, R7, R8, R12 |
| Lint 通过 | eslint / depcruise / clippy 无新增 warning | eslint / depcruise / clippy | R1, R7, R10 |
| 类型安全 | 无类型断言放宽或 any 引入 | tsc --strict | R2, R3, R8, R10 |
| 行数约束 | 拆分后文件 ≤ 规划上限 | wc -l | R9, R11 |
| 安全审查 | XSS / 权限 / unsafe 注释 | 人工 review | R3, R10 |
| 性能基准 | 渲染管线无退步 | 性能面板 / Lighthouse | R5 |

---

## 附录 E：渐进而行的修复路径

本方案支持两种执行模式：

### 模式 A：全量迭代（推荐首次使用）

从 Round 1 依次执行到 Round 12，每轮完成后执行验收标准并修复回归问题再进入下一轮。

```
Round 1 → 验收 → Round 2 → 验收 → ... → Round 12 → 验收 → 全量 CI 通过
```

### 模式 B：并行加速（高成熟度团队）

将四组独立轮次分配到四个 Agent 组并行执行：

```
Group 1: R1 → R10 (构建依赖)
Group 2: R2 → R6 → R7 → R8 (数据→并发→故障→A/C)
Group 3: R3 → R4 → R5 (安全→IPC→渲染)
Group 4: R9 → R11 (D/E → F/G/J)
Sync Gate: 四组合并后启动 R12 (测试覆盖)
```

### 文件变更总量预计

| 度量 | 预计值 |
|------|--------|
| 修改文件数 | 54+ 个 |
| 新增测试文件数 | 11+ 个 |
| 新增文件数 | 5-8 个（protocol common.ts, CI workflow, 测试文件等） |
| 删除文件数 | 1-3 个（ChatCheckpointActions.tsx, .dependency-cruiser.js 等） |
| 预计代码变更行数 | 1500-2500 行 |

---

## 附录 A：完整问题清单与任务映射

### 来自报告 01 (Merge Conflicts)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 01-01 | CardPanel.tsx:866 `=======` 合并冲突残留，JSX 语法错误 | 致命 | R1-T1 |
| 01-02 | 37 个 UU（both modified）文件未完成合并 | 严重 | R1-T2 |

### 来自报告 02 (Tool Call Chain)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 02-01 | isAiBusy 与 store 写入的竞争导致双流可能 | 中 | R6-T1 |
| 02-02 | cancelFn 闭包捕获空函数，提前调用无效 | 低 | R6-T2 |
| 02-03 | assertLive() 与 myGen 检查的时序窗口可导致过期数据写入 | 低 | R6-T3 |
| 02-04 | ApprovalCache 无 session 隔离，跨 session 意图重放 | 高 | R3-T2 |
| 02-05 | ApprovalBridge 与 ApprovalQueue 双重超时 | 低 | R6-T4 |

### 来自报告 03 (Fault Recovery)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 03-01 | runtime-error event 缺少 retryable 标记 | P0 | R4-T1 |
| 03-02 | EventRouter 不处理 runtime-error 事件（静默丢弃） | P0 | R4-T2 |
| 03-03 | EventRouter 不处理 provider-diagnostic 事件 | P0 | R4-T3 |
| 03-04 | 重试按钮：onRunError 无 retryable 参数 | P1 | R7-T5, R7-T6 |
| 03-05 | streamWithRecovery 路径缺指数退避 | P1 | R7-T4 |
| 03-06 | FallbackErrorType 含未使用的 "circuit-open" | P2 | R7-T1 |
| 03-07 | circuit-breaker-e2e.test.ts 命名/覆盖不匹配 | P2 | R7-T3 |
| 03-08 | error-classifier.ts 中 tripsBreaker 字段无消费方 | P2 | R7-T2 |

### 来自报告 04 (Store Integrity)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 04-01 | FIFO shift 导致 tool-result 无配对 tool-call | 高 | R2-T1, R2-T2 |
| 04-02 | appendMessages 部分成功静默返回 | 中 | R2-T3 |
| 04-03 | SessionStoreSlice 缺少 truncatedToolChainIds | 中 | R1-T8 |
| 04-04 | ISessionStore 与 SessionStore 方法签名不一致 | 低 | R2-T4, R2-T5 |

### 来自报告 05 (Render Pipeline)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 05-01 | RenderFrame.html 预解析被丢弃，重复 markdown 解析 | P0 | R5-T1, R5-T2 |
| 05-02 | 主聊天流与 Agent 流管线配置不同 | P1 | R5-T4 |
| 05-03 | 大块无换行文本 UTF-8 截断可能产生乱码 | P1 | R5-T3 |
| 05-04 | 主线程 markdown 解析占用帧预算 | P2 | R5-T5 |
| 05-05 | 积压降级时 UI 无提示 | P2 | R5-T6 |
| 05-06 | useStreamingText 中 textBatcherRef 代码无效 | P3 | R5-T7 |
| 05-07 | generationMapRef 无 session 关闭清理 | P3 | R5-T8 |

### 来自报告 06 (IPC Consistency)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 06-01 | workbench_apply_update 命令缺失 | 严重 | R4-T4 |
| 06-02 | TelemetryMonitor 使用裸 invoke() 非优雅降级 | 建议 | R4-T5 |
| 06-03 | protocol.ts 缺新增消息类型四同步清单 | 建议 | R4-T6 |

### 来自报告 07 (Build Config)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 07-01 | agent-workbench Cargo.toml 缺 [lints] workspace = true | 中 | R1-T3 |
| 07-02 | agent-provider-http Cargo.toml 缺 [lints] workspace = true | 中 | R1-T4 |
| 07-03 | 项目完全缺失 CI/CD 流水线 | 高 | R1-T5, R1-T6, R1-T7 |

### 来自报告 08 (Security)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 08-01 | MessageContent innerHTML 无 DOMPurify 纵深防御 | 中 | R3-T1 |
| 08-02 | process.rs 11 处 unsafe 无 SAFETY 注释 | 低-中 | R3-T3 |
| 08-03 | MCP env 白名单声明键继承语义缺文档 | 低 | R3-T4 |

### 来自报告 09 (Layer A/C)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 09-01 | classifyProviderErrorMessage 仍有 2 个生产调用者 | 中 | R8-T1, R8-T2 |
| 09-02 | classifyProviderStreamErrorKind 独立逻辑未合并 | 中 | R8-T3 |
| 09-03 | classifyErrorMessage 内联逻辑未合并 | 低 | R8-T4 |
| 09-04 | ProviderRegistryV2.syncRoutes() 为 no-op stub | 中 | R8-T5 |

### 来自报告 10 (Layer D/E)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 10-01 | sessionActions.ts 存在破损实现，session-actions/ 无人引用 | P0 | R9-T1, R9-T2 |
| 10-02 | layoutStore.ts 未接入 slices（514 行 > 400） | P1 | R9-T3 |
| 10-03 | protocol-inbound.ts 537 行 / outbound.ts 601 行超标 | P1 | R9-T4 |
| 10-04 | layout-helpers/ui-selectors.ts 414 行超标 | P2 | R9-T5 |

### 来自报告 11 (Layer H/I)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 11-01 | ToolHook 方法数 6→3，规划文档未同步 | ⚠️ | R10-T9 |
| 11-02 | tool-hook-observability.ts 重复声明 ToolHook 接口，类型漂移 | 🔴 | R10-T7 |
| 11-03 | CI 缺 concurrency 控制 | 🔴 | R10-T1 |
| 11-04 | CI 缺权限最小化 | 🔴 | R10-T2 |
| 11-05 | CI 缺路径过滤 | 🔴 | R10-T3 |
| 11-06 | CI 缺 turbo 缓存 | 🔴 | R10-T4 |
| 11-07 | CI 缺 typecheck 全覆盖 | 🔴 | R1-T6 |
| 11-08 | CI 缺密钥扫描 | 🔴 | R10-T5 |
| 11-09 | CI 缺 TS 覆盖率阈值 | ⚠️ | R10-T6 |
| 11-10 | 两份 depcruise 配置并存 | ⚠️ | R10-T8 |
| 11-11 | MiddlewarePipeline 已废弃但未移除 | ✅(可接受) | R10-T10 |

### 来自报告 12 (Layer F/G/J)

| # | 问题描述 | 报告评级 | 对应任务 |
|---|---------|---------|---------|
| 12-01 | ChatProviderGuard 未在 ChatCard 中使用 | 高 | R11-T1 |
| 12-02 | ChatCheckpointActions 为空壳 stub | 高 | R11-T5 |
| 12-03 | F-2g 未保存切换拦截 guard 未实现 | 中 | R11-T2 |
| 12-04 | FauxAgentProvider 使用 Pick 而非 implements | 中 | R11-T3 |
| 12-05 | globalSetup 缺失 CRISH_API_KEY / FLOWBIT_API_KEY / CONEX_API_KEY_ prefix | 中 | R11-T4 |
| 12-06 | useEffect 顺序与规划偏差 | 低 | R11-T6 |
| 12-07 | AppKeyboardHandler 190 行 > 120 上限 | 低 | R11-T7 |
| 12-08 | 多个组件缺专属测试 | 高 | R12-T1~T11 |

---

## 附录 B：文件变更总清单

| 文件路径 | 轮次 | 变更类型 | 责任 Agent |
|---------|------|---------|-----------|
| `apps/crish-desktop/src/components/CardPanel.tsx` | R1 | 修复(合并冲突) | Agent 1-1 |
| `apps/agent-workbench/src-tauri/Cargo.toml` | R1 | 添加 lints 配置 | Agent 1-3 |
| `packages/agent-provider-http/Cargo.toml` | R1 | 添加 lints 配置 | Agent 1-3 |
| `.github/workflows/ci.yml` | R1, R10 | 创建 + 增强(共 2 轮) | Agent 1-4, 10-1~6 |
| `package.json` | R1 | 添加 typecheck:ci 脚本 | Agent 1-5 |
| `turbo.json` | R1, R10 | 配置 pipeline | Agent 1-6, 10-2 |
| `apps/crish-desktop/src/store/session-actions/types.ts` | R1 | 添加缺失字段 | Agent 1-7 |
| `apps/crish-desktop/src/store/session-actions/message-actions.ts` | R2 | 修复配对保护 | Agent 2-1 |
| `packages/agent-runtime/src/session-store/index.ts` | R2 | 原子化 appendMessages | Agent 2-2 |
| `packages/agent-runtime/src/session-store/types.ts` | R2 | 对齐 ISessionStore 签名 | Agent 2-3 |
| `apps/crish-desktop/src/components/chat/MessageContent.tsx` | R3, R5 | DOMPurify + 预解析 HTML 消费 | Agent 3-1, 5-2 |
| `packages/agent-runtime/src/approval/approval-cache.ts` | R3 | sessionId key 隔离 | Agent 3-2 |
| `packages/agent-runtime/src/approval/approval-pipeline.ts` | R3 | 传入 sessionId | Agent 3-2 |
| `apps/agent-workbench/src-tauri/src/process.rs` | R3 | SAFETY 注释补全(11 处) | Agent 3-3 |
| `packages/agent-runtime/src/mcp-stdio-adapter.ts` | R3 | 添加语义注释 | Agent 3-4 |
| `packages/agent-runtime/src/session-loop/index.ts` | R4, R7, R8 | retryable + ErrorClassifier | Agent 4-1, 7-? |
| `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | R4 | runtime-error + provider-diagnostic case | Agent 4-2 |
| `apps/agent-workbench/src-tauri/src/main.rs` | R4 | 添加 workbench_apply_update 命令 | Agent 4-3 |
| `apps/crish-desktop/src/api/updateStore.ts` | R4 | 清理或修复 invoke | Agent 4-3 |
| `apps/crish-desktop/src/services/TelemetryMonitor.ts` | R4 | invokeResult 替换 | Agent 4-4 |
| `packages/agent-daemon/src/protocol/protocol.ts` | R4 | 四同步清单注释 | Agent 4-5 |
| `packages/shared-utils/src/StreamRenderBuffer.ts` | R5 | UTF-8 截断 + 降级 flag | Agent 5-3, 5-6 |
| `apps/crish-desktop/src/hooks/useStreamingText.ts` | R5 | 管线统一 + 死代码清理 | Agent 5-4, 5-7 |
| `packages/shared-utils/src/IncrementalMarkdownBridge.ts` | R5 | Worker 化 | Agent 5-5 |
| `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | R5, R6 | 预解析 HTML + cancelFn + myGen 修复 | Agent 5-1, 5-8, 6-2, 6-3 |
| `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` | R6 | isAiBusy 替换 | Agent 6-1 |
| `packages/agent-daemon/src/server/approval-bridge.ts` | R6 | 移除自有超时 | Agent 6-3 |
| `packages/agent-daemon/src/approval-queue.ts` | R6 | 统一超时管理 | Agent 6-3 |
| `packages/agent-runtime/src/fallback-chain/types.ts` | R7 | 移除 circuit-open | Agent 7-1 |
| `packages/agent-runtime/src/error-classifier.ts` | R7 | 清理 tripsBreaker | Agent 7-2 |
| `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | R7 | 指数退避 | Agent 7-4 |
| `apps/crish-desktop/src/hooks/chat-stream/useChatStream.ts` | R7 | retryable 参数 + 重试按钮 | Agent 7-5 |
| `packages/agent-runtime/src/session-loop/types.ts` | R8 | ErrorClassifier 迁移 | Agent 8-2 |
| `packages/agent-runtime/src/provider-stream-contract/error.ts` | R8 | ErrorClassifier 委托 | Agent 8-3 |
| `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` | R8 | ErrorClassifier 委托 | Agent 8-4 |
| `packages/agent-runtime/src/provider-registry-v2.ts` | R8 | 实现 syncRoutes | Agent 8-5 |
| `apps/crish-desktop/src/store/sessionActions.ts` | R9 | 转为 barrel | Agent 9-1 |
| `apps/crish-desktop/src/store/session-actions/index.ts` | R9 | 确保可消费 | Agent 9-1 |
| `apps/crish-desktop/src/store/layoutStore.ts` | R9 | 接入 slices | Agent 9-2 |
| `apps/crish-desktop/src/store/slices/*.ts` | R9 | 填充工厂函数 | Agent 9-2 |
| `packages/agent-daemon/src/types/protocol-inbound.ts` | R9 | 拆分 | Agent 9-3 |
| `packages/agent-daemon/src/types/protocol-outbound.ts` | R9 | 拆分 | Agent 9-3 |
| `packages/agent-daemon/src/types/common.ts` | R9 | 新建公共类型 | Agent 9-3 |
| `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` | R9 | 拆分 | Agent 9-4 |
| `packages/agent-runtime/src/hooks/tool-hook-observability.ts` | R10 | 导入类型替代自定义 | Agent 10-5 |
| `.dependency-cruiser.js` / `.dependency-cruiser.cjs` | R10 | 统一为单配置 | Agent 10-6 |
| `docs/.../08_tool_hook_chain.md` | R10 | 更新 ToolHook 方法数 | Agent 10-7 |
| `packages/agent-runtime/src/middleware-pipeline.ts` | R10 | 制定移除计划 | Agent 10-8 |
| `apps/crish-desktop/src/components/chat/ChatCard.tsx` | R11 | 集成 ChatProviderGuard | Agent 11-1 |
| `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` | R11 | F-2g guard | Agent 11-2 |
| `apps/crish-desktop/src/components/files/hooks/useFilePreview.ts` | R11 | onDirtyChange 回调 | Agent 11-2 |
| `packages/agent-runtime/src/testing/faux-provider.ts` | R11 | implements 修复 | Agent 11-3 |
| `vitest.globalSetup.ts` | R11 | 追加密钥清理 | Agent 11-4 |
| `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` | R11 | 实现或移除 | Agent 11-5 |
| `apps/crish-desktop/src/app/AppBootstrap.ts` | R11 | useEffect 重排序 | Agent 11-6 |
| `apps/crish-desktop/src/hooks/useAppKeyboard.ts` | R11 | 拆分 | Agent 11-7 |
| `apps/crish-desktop/src/components/chat/hooks/__tests__/useChatApproval.test.ts` | R12 | 新建测试 | Agent 12-1 |
| `apps/crish-desktop/src/components/files/hooks/__tests__/useFileNavigation.test.ts` | R12 | 新建测试 | Agent 12-2 |
| `packages/agent-runtime/src/testing/__tests__/faux-provider.test.ts` | R12 | 新建测试 | Agent 12-3 |
| `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts` | R12 | 新建测试 | Agent 12-4 |
| `apps/crish-desktop/src/components/chat/__tests__/ChatCard.test.tsx` | R12 | 新建测试 | Agent 12-5 |
| `apps/crish-desktop/src/components/files/__tests__/FilesCard.test.tsx` | R12 | 新建测试 | Agent 12-5 |
| `packages/agent-runtime/src/testing/__tests__/faux-call-gateway.test.ts` | R12 | 新建测试 | Agent 12-6 |
| `packages/agent-runtime/src/testing/__tests__/mock-tool.test.ts` | R12 | 新建测试 | Agent 12-6 |
| `packages/agent-runtime/src/__tests__/exponential-backoff.test.ts` | R12 | 新建测试 | Agent 12-7 |
| `packages/agent-runtime/src/approval/__tests__/approval-cache.test.ts` | R12 | 新建测试 | Agent 12-8 |
| `packages/agent-runtime/src/session-store/__tests__/append-messages.test.ts` | R12 | 新建测试 | Agent 12-9 |
| `apps/crish-desktop/src/store/__tests__/layoutStore.test.ts` | R12 | 新建测试 | Agent 12-10 |
| `apps/crish-desktop/src/store/session-actions/__tests__/*.test.ts` | R12 | 新建测试(多文件) | Agent 12-11 |

---

## 附录 C：Agent 任务耦合矩阵

| Agent 轮次 | 独占文件数 | 跨轮次复用 | 备注 |
|-----------|-----------|-----------|------|
| R1-A1~A7 | 9 | — | 修复构建/CI 基础 |
| R2-A1~A3 | 3 | R12-T9 测试依赖 R2-T3 | 数据完整性 |
| R3-A1~A4 | 5 | — | 安全修复独立 |
| R4-A1~A5 | 6 | R7-T5 依赖 R4-T1 | IPC/错误传播 |
| R5-A1~A8 | 8 | R12-T4 依赖 R5-T3 | 渲染管线 |
| R6-A1~A3 | 4 | R12-T1 依赖 R6-T2/T3 | 并发竞态 |
| R7-A1~A5 | 6 | R8-A1~A4 依赖 R7-T2; R12-T7 依赖 R7-T3 | 故障恢复 |
| R8-A1~A5 | 5 | 依赖 R7-T2 | Layer A/C |
| R9-A1~A4 | 9 | R12-T10/T11 依赖 R9 | Layer D/E |
| R10-A1~A8 | 7 | 依赖 R1-T5/T7 | Layer H/I/CI |
| R11-A1~A7 | 9 | R12-T2/T3 依赖 R11-T2/T3 | Layer F/G/J |
| R12-A1~A11 | 11 | 依赖全部前序轮次 | 测试覆盖 |

**强耦合路径**（一个 Agent 的输出是另一个 Agent 的输入）：
- R4-T1 → R7-T5：runtime-error retryable 标记 → 前端重试按钮
- R7-T2 → R8-T1~T4：ErrorClassifier tripsBreaker 清理 → 迁移遗留调用者
- R1-T5 → R10-T1~T6：CI 工作流创建 → CI 门禁增强
- R2-T3 → R12-T9：appendMessages 原子化 → 原子性测试

---

## 附录 F：每个轮次的修复类型分布

| 轮次 | 缺陷修复 | 安全加固 | 性能优化 | 架构合规 | 测试补齐 | 代码清理 | CI/DevOps |
|------|---------|---------|---------|---------|---------|---------|----------|
| R1 | 3 | 0 | 0 | 1 | 0 | 0 | 4 |
| R2 | 3 | 0 | 0 | 1 | 0 | 1 | 0 |
| R3 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| R4 | 4 | 0 | 0 | 0 | 0 | 0 | 2 |
| R5 | 1 | 0 | 6 | 1 | 0 | 1 | 0 |
| R6 | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| R7 | 3 | 0 | 1 | 0 | 0 | 2 | 0 |
| R8 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| R9 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| R10 | 0 | 1 | 0 | 5 | 0 | 2 | 6 |
| R11 | 0 | 1 | 0 | 7 | 0 | 1 | 0 |
| R12 | 0 | 0 | 0 | 0 | 12 | 0 | 0 |
| **合计** | **18** | **6** | **7** | **26** | **12** | **7** | **12** |

## 附录 G：关键代码位置索引

| 代码实体 | 文件路径 | 行号 | 涉及轮次 |
|---------|---------|------|---------|
| CardPanel merge conflict | `apps/crish-desktop/src/components/CardPanel.tsx` | 866 | R1 |
| Cargo.toml (workbench) | `apps/agent-workbench/src-tauri/Cargo.toml` | — | R1 |
| Cargo.toml (provider-http) | `packages/agent-provider-http/Cargo.toml` | — | R1 |
| SessionStoreSlice | `apps/crish-desktop/src/store/session-actions/types.ts` | 4 | R1 |
| message-actions addMessage | `apps/crish-desktop/src/store/session-actions/message-actions.ts` | 27-40 | R2 |
| session-store appendMessages | `packages/agent-runtime/src/session-store/index.ts` | 38-45 | R2 |
| ISessionStore interface | `packages/agent-runtime/src/session-store/types.ts` | — | R2 |
| MessageContent innerHTML | `apps/crish-desktop/src/components/chat/MessageContent.tsx` | 96-98 | R3 |
| ApprovalCache key | `packages/agent-runtime/src/approval/approval-cache.ts` | 18 | R3 |
| process.rs unsafe 11 处 | `apps/agent-workbench/src-tauri/src/process.rs` | 199-792 | R3 |
| session-loop handleStreamError | `packages/agent-runtime/src/session-loop/index.ts` | 254-295 | R4, R8 |
| EventRouter handleAgentEvent | `apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts` | 196-493 | R4 |
| updateStore invoke | `apps/crish-desktop/src/api/updateStore.ts` | 63 | R4 |
| TelemetryMonitor invoke | `apps/crish-desktop/src/services/TelemetryMonitor.ts` | 101 | R4 |
| StreamRenderBuffer | `packages/shared-utils/src/StreamRenderBuffer.ts` | 49, 244 | R5 |
| useStreamCallbacks | `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` | 141-179 | R5, R6 |
| useSlashSend isAiBusy | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` | 295 | R6 |
| approval-bridge timeout | `packages/agent-daemon/src/server/approval-bridge.ts` | 3, 23 | R6 |
| approval-queue timeout | `packages/agent-daemon/src/approval-queue.ts` | 1 | R6 |
| FallbackErrorType | `packages/agent-runtime/src/fallback-chain/types.ts` | 14 | R7 |
| error-classifier tripsBreaker | `packages/agent-runtime/src/error-classifier.ts` | 42-55 | R7 |
| stream-recovery decideRecovery | `packages/agent-runtime/src/provider-transport/stream-recovery.ts` | — | R7 |
| ErrorClassifier.classify | `packages/agent-runtime/src/error-classifier.ts` | 58 | R8 |
| classifyProviderStreamErrorKind | `packages/agent-runtime/src/provider-stream-contract/error.ts` | 42-61 | R8 |
| classifyErrorMessage | `packages/agent-runtime/src/provider-stream-contract/normalizer.ts` | 50-57 | R8 |
| ProviderRegistryV2 syncRoutes | `packages/agent-runtime/src/provider-registry-v2.ts` | 305-307 | R8 |
| sessionActions.ts | `apps/crish-desktop/src/store/sessionActions.ts` | 全文件 | R9 |
| session-actions/index.ts | `apps/crish-desktop/src/store/session-actions/index.ts` | 全文件 | R9 |
| layoutStore.ts | `apps/crish-desktop/src/store/layoutStore.ts` | 全文件(514行) | R9 |
| protocol-inbound.ts | `packages/agent-daemon/src/types/protocol-inbound.ts` | 全文件(537行) | R9 |
| protocol-outbound.ts | `packages/agent-daemon/src/types/protocol-outbound.ts` | 全文件(601行) | R9 |
| ui-selectors.ts | `apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts` | 全文件(414行) | R9 |
| tool-hook-observability.ts | `packages/agent-runtime/src/hooks/tool-hook-observability.ts` | 17-21 | R10 |
| middleware-pipeline.ts | `packages/agent-runtime/src/middleware-pipeline.ts` | 全文件 | R10 |
| ChatProviderGuard | `apps/crish-desktop/src/components/chat/ChatProviderGuard.tsx` | 全文件 | R11 |
| ChatCheckpointActions | `apps/crish-desktop/src/components/chat/ChatCheckpointActions.tsx` | 全文件 | R11 |
| useFileNavigation | `apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts` | 全文件 | R11 |
| useFilePreview | `apps/crish-desktop/src/components/files/hooks/useFilePreview.ts` | 全文件 | R11 |
| FauxAgentProvider | `packages/agent-runtime/src/testing/faux-provider.ts` | 4 | R11 |
| vitest.globalSetup.ts | `vitest.globalSetup.ts` | 9-23 | R11 |
| AppBootstrap.ts | `apps/crish-desktop/src/app/AppBootstrap.ts` | 全文件 | R11 |
| useAppKeyboard | `apps/crish-desktop/src/hooks/useAppKeyboard.ts` | 全文件(190行) | R11 |

## 附录：12 份审计报告与任务对照表

| 报告 | 涉及问题 | 对应任务 |
|------|---------|---------|
| 01_merge_conflicts.md | CardPanel merge conflict, 37 UU files | R1-T1, R1-T2 |
| 02_tool_call_chain.md | isAiBusy race, cancelFn, myGen, ApprovalCache cross-session, double timeout | R6-T1~T4, R3-T2 |
| 03_fault_recovery.md | runtime-error retryable, EventRouter, circuit-open, tripsBreaker, test rename, streamWithRecovery backoff, retry button | R4-T1~T3, R7-T1~T6 |
| 04_store_integrity.md | shift pairing, appendMessages atomicity, SessionStoreSlice type, ISessionStore mismatch | R1-T8, R2-T1~T5, R12-T9 |
| 05_render_pipeline.md | Duplicate markdown, UTF-8 truncation, pipeline unification, Worker, backlog UI, dead code, genMap cleanup | R5-T1~T8, R12-T4 |
| 06_ipc_consistency.md | workbench_apply_update missing, TelemetryMonitor invoke, four-sync comment | R4-T4~T6 |
| 07_build_config.md | Cargo lints (2 files), CI workflow missing | R1-T3~T7 |
| 08_security_residue.md | DOMPurify, process.rs SAFETY, MCP env doc | R3-T1, R3-T3, R3-T4 |
| 09_layer_ac_deviation.md | ErrorClassifier callers, classifyProviderStreamErrorKind, syncRoutes stub | R8-T1~T5 |
| 10_layer_de_deviation.md | sessionActions broken, layoutStore slices, protocol types overlimit, ui-selectors overlimit | R9-T1~T5, R12-T10, R12-T11 |
| 11_layer_hi_deviation.md | CI concurrency/permissions/paths/turbo/typecheck/secret-scan, ToolHook types, depcruise config, MiddlewarePipeline | R10-T1~T10 |
| 12_layer_fgj_deviation.md | ChatProviderGuard, F-2g guard, FauxAgentProvider implements, globalSetup keys, ChatCheckpointActions, useEffect order, AppKeyboardHandler, missing tests | R11-T1~T7, R12-T1~T6, R12-T8 |

---

## 轮次依赖关系图

```
Round 1 (编译构建) ──────────┬──────────────┬──────────┐
          │                  │              │          │
          ▼                  ▼              ▼          ▼
Round 2 (数据完整性)    Round 4 (IPC/错误)  Round 3 (安全)  Round 9 (D/E)
          │                  │              │              │
          │                  ▼              │              │
          │           Round 5 (渲染)        │              │
          │                  │              │              │
          ▼                  ▼              ▼              ▼
Round 6 (并发竞态) ─── Round 7 (故障恢复) ──┘     Round 10 (H/I)[需R1]
                                  │                    │
                                  ▼                    │
                          Round 8 (Layer A/C)[需R7]    │
                                  │                    │
                                  ├────────────────────┤
                                  │                    │
                                  ▼                    ▼
                          Round 11 (Layer F/G/J)  [需R1基础CI存在]
                                  │
                                  ▼
                          Round 12 (测试覆盖)[需全部前序]
```

### 依赖关系详解

**强顺序依赖**（必须串联执行）：

| 前置轮次 | 后置轮次 | 依赖原因 | 关键耦合点 |
|---------|---------|---------|-----------|
| R1 | R10 | CI 基础工作流存在后才能增强 | R10-T1~T6 (concurrency/permissions/turbo 等) 需要 `.github/workflows/ci.yml` 已存在 |
| R7 | R8 | ErrorClassifier 清理完成才能安全迁移 | R8-T1~T4 将遗留调用者改为 `ErrorClassifier.classify`，需要 R7-T2 的 `tripsBreaker` 清理已完成 |
| R1~R11 | R12 | 测试需验证修复后的代码 | R12-T1~T11 覆盖了 R2~R11 的所有修复行为 |

**可并行组**（无代码交叉依赖）：

| 并行组 | 包含轮次 | 说明 |
|-------|---------|------|
| 并行组 A | R2 (数据完整性), R3 (安全), R4 (IPC/错误), R9 (D/E) | 四组分别操作完全不同领域：store、安全配置、事件路由、架构拆分 |
| 并行组 B | R5 (渲染), R6 (并发竞态) | 渲染管线操作 store 类型和 StreamRenderBuffer；并发竞态操作 hook 逻辑——需注意 R5-T1 修改 store 消息类型可能影响 R6-T1 的业务逻辑，建议 R6 在 R5 之后或代码冲突合并时调整 |

### 文件冲突规避指南

当两个轮次修改同一文件时，必须串联执行：

| 文件 | 涉及轮次 | 冲突分析 | 建议顺序 |
|------|---------|---------|---------|
| `useStreamCallbacks.ts` | R5 (T1, T8), R6 (T2, T3) | 修改不同行区间但集中在一个文件 | R5 → R6 |
| `session-loop/index.ts` | R4 (T1), R7, R8 (T1) | R4 加 retryable, R8 移 ErrorClassifier——修改同一方法的不同逻辑 | R4 → R7 → R8 |
| `ci.yml` | R1, R10 | R1 创建基本骨架, R10 增强门禁 | R1 → R10 |
| `StreamRenderBuffer.ts` | R5 (T3, T6) | T3 改截断逻辑, T6 加降级 flag，不冲突 | 可由同一 Agent 完成 |
| `error-classifier.ts` | R7 (T2) | 仅移除 tripsBreaker 字段 | 独立，但 R8 需要其完成 |

---

## 方案度量的量化目标

| 度量维度 | 当前基线 | 修复后目标 | 衡量方式 |
|---------|---------|-----------|---------|
| TS 编译错误数 | 数百（exactOptionalPropertyTypes） | 0（排除现有 flag 类错误） | `npx tsc --noEmit` |
| CI 门禁数量 | 0（无 CI） | ≥ 8（typecheck/lint/depcruise/test/integration/npm audit/cargo deny/secret-scan） | `.github/workflows/ci.yml` |
| XSS 暴露面 | 1 处（MessageContent innerHTML） | 0 处 | grep innerHTML 并确认都有 DOMPurify |
| unsafe SAFETY 注释覆盖 | 0%（process.rs 11 处） | 100% | 人工审查 |
| 跨 session 审批泄漏 | 存在（无隔离） | 不存在 | 自动化测试 |
| 渲染重复解析成本 | 5-50ms/帧（60-80%管线开销） | 0ms（主聊天流） | 性能面板 |
| FIFO 数据不一致风险 | tool-result 悬挂 | 配对移除 | 单元测试 |
| 架构偏差（行数超标文件数） | 5 个文件超标 | 0 个 | wc -l |
| 缺失测试文件数 | 10+ 个 | 0 个 | 测试目录清单 |

---

## 方案执行指标

| 指标 | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 | Round 6 | Round 7 | Round 8 | Round 9 | Round 10 | Round 11 | Round 12 |
|------|---------|---------|---------|---------|---------|---------|---------|---------|---------|----------|----------|----------|
| Agent 数 | 7 | 3 | 4 | 5 | 8 | 3 | 5 | 5 | 4 | 8 | 7 | 11 |
| 任务数 | 8 | 5 | 4 | 6 | 8 | 4 | 6 | 5 | 5 | 10 | 7 | 11 |
| 修改文件数 | 43 | 3 | 4 | 6 | 8 | 4 | 6 | 5 | 9 | 7 | 9 | 11(新增) |
| 验收标准数 | 7 | 5 | 5 | 7 | 7 | 5 | 7 | 6 | 8 | 9 | 9 | 8 |
| 并行度 | 7 Agents | 3 Agents | 4 Agents | 5 Agents | 8 Agents | 3 Agents | 5 Agents | 5 Agents | 4 Agents | 8 Agents | 7 Agents | 11 Agents |
| 预估代码行变更 | +150 | +50 | +40 | +80 | +200 | +40 | +100 | +80 | +200 | +150 | +350 | +1000(新测试) |
| 预估工时(人天) | 2 | 1 | 1 | 1.5 | 3 | 1 | 2 | 1.5 | 3 | 2 | 3 | 4 |

**总预估**：24 人天 | 82 任务 | 72 Agents | 12 轮次 | 55+ 问题修复 | 11+ 新测试文件 | 2470+ 行代码变更

### 每轮次工时估算明细

| 轮次 | 核心任务工时(人天) | 测试工时(人天) | 评审工时(人天) | 合计(人天) |
|------|-----------------|--------------|--------------|-----------|
| R1 | 1.0 | 0.2 | 0.3 | 1.5 |
| R2 | 0.5 | 0.2 | 0.3 | 1.0 |
| R3 | 0.5 | 0.2 | 0.3 | 1.0 |
| R4 | 0.8 | 0.2 | 0.3 | 1.3 |
| R5 | 1.5 | 0.3 | 0.5 | 2.3 |
| R6 | 0.5 | 0.2 | 0.3 | 1.0 |
| R7 | 1.0 | 0.3 | 0.3 | 1.6 |
| R8 | 0.8 | 0.2 | 0.3 | 1.3 |
| R9 | 1.5 | 0.3 | 0.5 | 2.3 |
| R10 | 1.0 | 0.2 | 0.3 | 1.5 |
| R11 | 1.5 | 0.3 | 0.5 | 2.3 |
| R12 | 2.0 | 1.0 | 1.0 | 4.0 |
| **合计** | **12.6** | **3.6** | **4.9** | **21.1** |

## 术语表

| 术语 | 含义 |
|------|------|
| UU (Unmerged) | Git 合并过程中处于 both modified 状态的文件，需要手动或通过 `git add` 完成合并 |
| AsyncMutex | 基于 FIFO 队列的异步互斥锁实现，位于 `packages/shared-utils/src/async-mutex.ts` |
| StreamRenderBuffer | 流式渲染缓冲区，控制 rAF 帧率与背压降级，位于 `packages/shared-utils/src/StreamRenderBuffer.ts` |
| EventRouter | 前端 WebSocket 事件分发器，按 event type 路由到不同回调处理函数 |
| ErrorClassifier | 统一的 provider 错误分类器，`packages/agent-runtime/src/error-classifier.ts` |
| ApprovalCache | 审批决策缓存，支持 30s TTL 的意图级缓存复用 |
| Daemon | Agent Daemon 服务进程，管理与 orchestrator 的 WebSocket 连接 |
| Orchestrator | Agent Orchestrator，协调多 agent 的执行流程 |
| slices | Zustand store 拆分模式，将大型 store 拆分为领域子 slice 工厂函数 |
| barrel | 索引文件模式，index.ts 文件仅 re-export 子模块，不包含实现代码 |
| depcruise | Dependency Cruiser，代码依赖关系检查工具 |
| CircuitBreaker | 断路器模式，用于 provider 调用的熔断保护（已从 agent-runtime 移除，前端独立保留） |

---

*方案生成时间：2026-07-24 | 总轮次：12 | 总 Agent 数：72 | 总任务数：82 | 覆盖问题数：55+ | 方案迭代版本：v1.0*

---

**本方案覆盖全部 12 份审计报告所列问题，包含 82 个具体任务、72 个 Agent 分配、12 个逻辑轮次、11 个新增测试文件、55+ 个已识别问题。方案设计支持全量迭代（模式 A）和并行加速（模式 B）两种执行策略，适应不同团队规模和交付节奏。每轮次验收标准独立可执行，轮次间依赖关系清晰标注。建议首次执行采用模式 A 逐轮推进，确保不因并行引入额外的合并复杂度和回归风险。**
