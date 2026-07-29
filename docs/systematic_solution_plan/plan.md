# Conex 代码库系统性改进方案

> 基于综合问题分析文档的解决方案
> 仅包含逻辑顺序和系统化改进路径，不包含时间安排或人员分配
> 所有问题无优先级区分——只要存在即同等重要
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** 文中 `session-actions/`（`apps/crish-desktop/src/store/session-actions/`）为**已删除目录**的历史路径。现行 session store actions：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts`。验证命令请改 grep 这些 live 文件，而非已删目录。

---

## 第一部分：方案设计原则

### 原则 0：精简优先于抽象

每次引入新的抽象层（接口、中间件、路由）之前，先问：是否可以直接调用？一层抽象多一层 JSON 序列化、多一层闭包捕获、多一层调试断层。如果直接函数调用就能满足需求，就绝不引入中间层。Monitor 中已经存在的间接层（IpcRouter、6 阶段 Tool Hook 链、双轨 ProviderRegistry）必须精简。

### 原则 1：执行纪律先行于所有功能改进

Conex 代码库的根本问题不是缺少基础设施或设计方案，而是"写了但没用"。因此所有改进的出发点必须是：
- 已有基础设施必须接入执行路径，否则删除
- 已有文档必须与代码事实对齐，否则修正
- 已有规则必须被 CI/hooks 强制，否则不产生效果

### 原则 2：先解决阻塞性问题，再推进系统化重构

21 个 UU（unmerged）文件是当前编译阻塞项。在此解决之前，所有其他改进无法被 CI 验证。因此第一阶段必须强制合并冲突解决。

### 原则 3：同一能力归并到单一实现

每次发现"同一能力多套实现"，必须关闭旧的并统一到新的，而不是新增第三套。归并条件：
- 运行时核心已统一（如 ErrorClassifier），前端/传输层未跟随的：回填合并
- 两套方案各有优劣的（如 useChatStream vs useAgentStream）：评估后选择优势方案，统一所有用户
- 两套方案都未被使用的：删除两者中更旧的，保留更新的

### 原则 4：分层依赖方向不可逆

包间依赖方向是架构的骨架，每次修改必须遵守。JS/TS 包层：
- `shared-types` → 叶节点，不应反向依赖任何包
- `shared-utils` → 工具层，只被消费，不消费业务包
- `agent-runtime` → 运行时核心，可消费 shared-types、shared-utils
- `agent-daemon` → 服务层，可消费 agent-runtime、shared-types、shared-utils
- `apps/crish-desktop` → 前端，只能通过 `@crish/*` 消费 packages，禁止深路径引用

Rust crate 层：
- `conex-stream` → 叶节点，不依赖其他 conex crate
- `conex-types` → 叶节点，不依赖其他 conex crate
- `conex-ipc` → 可消费 stream、types
- `conex-net` → 可消费 ipc、types
- `conex-sandbox` → 可消费 ipc、types，不可反向依赖 app 层
- `apps/agent-workbench` → 可消费全部 crates，禁止 crates 反向依赖它

### 原则 5：安全防线分层叠加

安全不能依赖单一防线，必须分层。每一层必须有明确的降级策略，不允许"单一新层替换旧层"：
- 文件系统层：master key 与 vault 强制分离目录
- 内存层：API key 只在必要时存在于内存，不在 localStorage 持久化
- 进程执行层：指令级防爆网（gatekeeper 黑名单）+ 进程树生命周期绑定 + 用户审批与信任区
- CSP 层：生产构建移除 `unsafe-eval`，connect-src 白名单化
- CI 层：npm audit + cargo deny check 硬阻断

### 原则 6：基础设施"用了才算存在"

以下标准用于判定基础设施是否真正"存在"：
- 代码定义了 + 有消费者调用 = 存在
- 代码定义了 + 无消费者调用 = 虚假保障，要么接入要么删除
- 代码定义了 + CI 执行验证 = 存在
- 代码定义了 + CI 未执行 = 虚假保障

---

## 第二部分：执行顺序

### 第 0 轮：解决编译阻塞（依赖：无）

**目标**：消除 21 个 UU 文件，恢复干净编译状态。

**任务清单**：

| 任务 | 内容 | 涉及文件 |
|------|------|---------|
| M-0 | 解决 protocol.ts、registry.test.ts、common.ts、run.ts 的合并冲突 | agent-daemon/protocol/ 全部 4 个冲突文件 |
| M-1 | 解决 server.ts、server-handlers.ts、server-runtime-factory.ts 及测试的冲突 | agent-daemon 5 个服务层文件 |
| M-2 | 解决 run-handlers.ts、types.ts 的冲突 | agent-daemon 2 个 handler/type 文件 |
| M-3 | 解决 agent-session-loop.ts、context-projection.ts、runtime-helpers.ts、plugin-fs-registry.ts 的冲突 | agent-runtime 4 个核心文件 |
| M-4 | 解决 provider-anthropic.ts、provider-gemini.ts 的冲突 | agent-runtime 2 个 provider 文件 |
| M-5 | 解决 orchestrator.ts 的冲突 | agent-orchestrator 1 个编排文件 |
| M-6 | 解决 useChatStream.ts 的冲突并统一到 updateMessageText 路径（剔除 batchUpdateMessageText） | apps/crish-desktop 流式核心 |
| M-7 | 解决 sessionActions.ts、sessionStore.ts、layoutStore.ts 的冲突 | apps/crish-desktop 3 个 store 文件 |
| M-8 | 全局编译验证 + test:core 基线快照（记录当前通过/失败数，不做为通过要求） | 全部 |

**验收标准**：
- `npx tsc --noEmit` 零 TS1185 错误
- `cargo check` 零错误
- 所有模块的 barrel 导出兼容性确认

---

### 第 1 轮：基础设施接入与去死代码（依赖：第 0 轮）

**目标**：消除"写了没用"的虚假保障，所有已有基础设施要么接入要么删除。

**任务清单**：

**1-A：CI 门禁基础设施接入**

| 任务 | 内容 | 前置依赖 |
|------|------|---------|
| CI-1 | `npm audit --audit-level=moderate` 加入 ci.yml test job | 无 |
| CI-2 | `cargo deny check` 加入 ci.yml rust-check job（已配置 deny.toml） | 无 |
| CI-3 | `depcruise --config .dependency-cruiser.js packages apps --ignore "dist/"` 加入 ci.yml | depcruise 配置修正（见下文 CA-2） |
| CI-4 | `scripts/check-no-as-any.mjs`（扩展版，见下文 QC-1）加入 CI | 扩展脚本完成 |
| CI-5 | `git diff --check` 加入 pre-commit hook，拦截 `<<<<<<<` 标记 | 无 |

**1-B：depcruise 配置修正**

| 任务 | 内容 | 依赖 |
|------|------|------|
| CA-1 | `package.json` 添加 `dependency-cruiser` 到 devDependencies | 无 |
| CA-2 | 修正 `no-runtime-to-shared` 规则：移除或降级为 warn（agent-runtime 合理依赖 shared-utils），补全 `on-crish-desktop-to-daemon` 规则 | CI-3 |
| CA-3 | `dependency-cruiser.cjs` 的 `doNotFollow` 添加 `dist/` 排除 | CI-3 |
| CA-4 | `package.json` 添加 `lint:depcruise` 和 `check:deps` 脚本 | CA-1 |

**1-C：死代码处理（要么接入要么删除）**

| 任务 | 决策 | 理由 |
|------|------|------|
| DC-1 | `frameScheduler.ts` 接入 useAgentStream（替换直写 store），或将此文件删除 | 帧调度能力在 agent 流式中需要 |
| DC-2 | `useFpsMonitor.ts` 接入 App.tsx 或 `TelemetryMonitor.ts`，或将此文件删除 | 性能监控能力需要存在 |
| DC-3 | `backpressure.ts` 的 `Semaphore` 加入 `connection-manager.ts` 速率限制中，或将此导出从 barrel 移除 | Semaphore 能力已实现但无消费方 |
| DC-4 | `bootstrap-services.ts` 确认是否仍需要。如需要则在 main.tsx 中调用；如不需要则删除 | 串行服务可能已被 bootstrap-full 替代 |

**1-D：lint-staged 配置**

| 任务 | 内容 | 依赖 |
|------|------|------|
| LS-1 | `package.json` 添加 `lint-staged` 配置，包含 eslint、prettier、git diff --check | 无 |

---

### 第 2 轮：TECH_DEBT 校准与度量基线建立（依赖：第 0 轮）

**目标**：让 TECH_DEBT.md 反映代码库的真实状态，作为后续改进的度量基线。

**2-A：TECH_DEBT 校准**

| 任务 | 内容 | 验证方式 |
|------|------|---------|
| TD-01 | 更新 TD-009：27 处 @deprecated（不是 21） | grep 计数 |
| TD-02 | 更新 TD-030/031：标记为"已修复"（noUncheckedIndexedAccess 和 exactOptionalPropertyTypes 已开启） | tsconfig.base.json 确认 |
| TD-03 | 更正 TD-042：clientApi.ts 4 个桩函数标记为"仍存在，待清理"，非"已删除" | 文件存在性确认 |
| TD-04 | 更正 TD-043：layoutAnimationStore.ts 两个属性标记为"已清理，文件仍存在" | 文件确认 |
| TD-05 | 更正 TD-044：provider-factory.ts 标记为"仍存在且有 8 处外部引用，待清理"。列出全部 8 处引用并追踪其迁移到 `ProviderRegistryV2.createProvider()` 的进度 | grep 引用计数，逐处审读 |
| TD-06 | 新增 TD-058：21 个 UU 文件（第 0 轮解决后关闭） | git status |
| TD-07 | 新增 TD-059：useChatStream useAgentStream 渲染策略分裂 | 代码对比审读 |
| TD-08 | 新增 TD-060：CSP unsafe-eval/unsafe-inline | index.html 确认 |
| TD-09 | 新增 TD-061：frontend localStorage 明文 API keys | providerProfiles.ts 确认 |
| TD-10 | 新增 TD-062：CI/CD 缺 5 项安全门禁 | ci.yml 确认 |
| TD-11 | 新增 TD-063：session 无 per-session 并发控制 | session-loop 确认 |

**2-B：@deprecated 统一治理**

| 任务 | 内容 | 条件 |
|------|------|------|
| DP-1 | `SidebarContextMenus.tsx:71/73/75/77` 补充替代路径（`<Tooltip>` 或其他组件），否则删除裸标记 | 裸 @deprecated 无任何信息，属于最坏形态 |
| DP-2 | `provider-factory.ts:2/20/35/56` 的模糊"勿用于生产"替换为具体替代路径（如"Use `ProviderRegistryV2.createProvider()`"） | 模糊描述无帮助 |
| DP-3 | 所有 @deprecated 添加 `@removeWhen <条件>`（如 `@removeWhen > v2.0` 或 `@removeWhen all callers migrated`） | 无条件的 deprecation 永不到期 |
| DP-4 | 添加 eslint rule：`@deprecated` 注释必须包含 `@see` 或 `@removeWhen` | 无此规则则继续恶化 |

---

### 第 3 轮：错误处理与可恢复性统一（依赖：第 0 轮）

**目标**：消除分裂的 error classification，补齐 CircuitBreaker 冒泡路径，消除静默拒绝。

**3-A：ErrorClassifier 全量覆盖**

| 任务 | 文件 | 操作 |
|------|------|------|
| EC-1 | `provider-openai-compatible.ts:464-467` `classifyTransportProviderError` | 替换为 `ErrorClassifier.classify()` 调用 |
| EC-2 | `provider-openai-compatible.ts:469-475` `classifyStreamProviderError` | 替换为 `ErrorClassifier.classify()` 调用 |
| EC-3 | `provider-openai-compatible.ts:477-486` `classifyHttpProviderError` | 替换为 `ErrorClassifier.classify()` 调用 |
| EC-4 | 验证 ErrorClassifier 的 `httpStatus` 分支覆盖 provider-openai-compatible 之前处理的全部状态码 | 对比两个文件的状态码处理清单 |

**3-B：移除 CircuitBreaker，改用指数退避重试 + 用户显式重试**

CircuitBreaker 在用户网络闪断时即使 5 秒后网络恢复，仍会在冷却窗口期强制拦截请求，造成"明明通了却不能发"的糟糕体验。移除 CircuitBreaker，改用指数退避重试，重试仍失败则将错误明确展示给用户，由用户点击重试。

| 任务 | 文件 | 操作 |
|------|------|---------|
| CB-1 | `provider-call-gateway.ts` | 移除 CircuitBreaker 逻辑（`breaker.allowRequest()`、`recordSuccess()`、`recordFailure()`）。重试路径仅使用指数退避（初始 1s，每次翻倍，上限 30s） |
| CB-2 | `session-loop/index.ts` catch 分支 | 移除 `CircuitBreakerOpenError` 特殊处理。所有 provider 调用失败统一走指数退避重试。重试次数耗尽后的错误通过 stream 的 `error` 事件类型（新增 `retryable: true` 标记）透传到前端，由用户点击"重试"按钮重新触发最后一次 provider 调用（不重建整个 run loop） |
| CB-3 | `provider-call-gateway.ts` + `provider-call-gateway.test.ts` | 删除 `CircuitBreakerOpenError` 类的定义和引用。相关测试用例改为测试指数退避行为。`circuit-breaker-e2e.test.ts` 删除或重写为指数退避 e2e 测试 |
| CB-4 | `packages/shared-utils/src/backpressure.ts` + 全库 | 确认 `CircuitBreaker` 全库零引用（含测试文件）。从 barrel 导出移除。搜索 `new CircuitBreaker\(`、`import.*CircuitBreaker`、`CircuitBreaker\b` 确认清零 |

**3-C：Session Store 静默拒绝消除**

| 任务 | 文件 | 操作 |
|------|------|---------|
| SS-1 | `session-store/index.ts:143` | 将 `return;` 改为 `throw new StoreCapacityError('branch shard limit reached')` |
| SS-2 | `session-store/index.ts:158` | 将 `return;` 改为 `throw new StoreCapacityError('shard message limit reached')` |
| SS-3 | 定义 `StoreCapacityError` | 在 session-store/types.ts 中定义结构性错误类型 |
| SS-4 | 更新 `appendMessage` 的 JSDoc，声明 `@throws StoreCapacityError` | 调用方契约化 |
| SS-5 | 更新 `appendMessages`（`:172-176`）处理 `StoreCapacityError` | 决定降级策略（继续新 shard / drop / log） |

**3-D：空 catch 块治理**

| 任务 | 范围 | 策略 |
|------|------|------|
| EC-5 | `session-loop/index.ts:121/126/284` | 此类 dispatch 失败可能影响状态机完整性，必须 `console.error` + `tracing::warn`（已接入 tracing） |
| EC-6 | `wal.ts:96/101` | 添加 `console.warn('[WAL] flush failed:', err)`，不改变降级行为但消除静默 |
| EC-7 | `jsonl-append-batcher.ts:175/180/190` | 添加 `console.warn` 日志 |
| EC-8 | `SessionSyncService.ts:350/409/445` | 添加 `console.warn` 日志 |
| EC-9 | `encrypted-file-store.ts:47` | 移除 catch {}，Windows chmod 失败应至少 warning 日志 |
| EC-10 | 全库 `catch {}` 和 `.catch(() => {})` | 逐个审读，每处根据上下文决定：添加日志/移除 catch/改为特定错误处理。本任务应在全部其他错误处理工作完成后执行 |

**3-E：指数退避重试**

不为用户主动切换模型（不同模型能力差异大）。只对用户已选择的模型做指数退避重试。

| 任务 | 内容 | 依赖 |
|------|------|------|
| FG-1 | 在 `provider-call-gateway.ts` 的 retry 路径中，确认退避策略为指数退避（初始 1s，每次翻倍，上限 30s），而非线性重试。无需切换 provider/model | 无 |
| FG-2 | `session-loop/recovery.ts` 的 `shouldRetryWithEscalation()` 当前是 nudge 计数管理，确认该路径不与 provider 切换逻辑耦合 | 无 |

---

### 第 4 轮：性能统一与资源优化（依赖：第 0 轮）

**目标**：消除流式渲染策略分裂，建立 session 级并发控制，处理死代码、零拷贝不足和 sab_ring_buffer 空实现。

**4-A：流式渲染统一**

| 任务 | 内容 | 依赖 |
|------|------|------|
| SR-1 | 从 useChatStream 提取公共的 `useStreamingText` hook（StreamRenderBuffer + StreamTextBatcher 封装） | 无 |
| SR-2 | useAgentStream 集成 `useStreamingText`，替换 `onChunk` 直写 store | SR-1 |
| SR-3 | useChatStream 自身也使用 `useStreamingText`（消除两份 StreamRenderBuffer 创建逻辑） | SR-1 |
| SR-4 | 验证 useAgentStream 的 `pa`（buildPatchAsst）是否还保留：如果 useStreamingText 接管了文本写入，则 pa 降级为只处理非文本字段 | SR-2 |

**4-B：Session 级并发控制**

| 任务 | 内容 | 依赖 |
|------|------|------|
| SC-1 | `session-loop/` 注入 per-session `AsyncMutex`，`run()` 入口 `acquire`，退出 `release` | 无 |
| SC-2 | daemon `server/index.ts` 的 `handleRunTask` 检查 `activeRuns.has(sessionId)`，拒绝并发 | 无 |
| SC-3 | 前端 `SessionStreamManager` 的 `streams` Map 替换为 `BoundedMap`（共享有界容量 + LRU 淘汰） | 无 |

**4-C：死代码清除**

| 任务 | 内容 | 决策依据 |
|------|------|---------|
| DK-1 | 如果 `frameScheduler.ts` 在第 1 轮 DC-1 中已接入，保留使用；否则标记为待删除 | DC-1 决策后执行 |
| DK-2 | 如果 `useFpsMonitor.ts` 在第 1 轮 DC-2 中已接入，保留使用；否则标记为待删除 | DC-2 决策后执行 |
| DK-3 | `backpressure.ts` 中 `Semaphore` 类：在第 1 轮 DC-3 后仍无消费者则从 barrel 导出移除 | 保留实现但禁止公共导出 |

**4-D：前端 Markdown 增量渲染与帧率对齐**

瓶颈在前端渲染帧率（数百 token/s 时 React re-render），不在 Rust IPC 数据传输层。不做 sab_ring_buffer。

| 任务 | 文件 | 操作 |
|------|------|------|
| MR-1 | `apps/crish-desktop/src/hooks/chat-stream/` | 在现有 `StreamRenderBuffer` (12ms 帧预算)基础上，增加对高 token 速率（>200 token/s）的自动帧率降级：当单帧 buffer 积压超过阈值时主动跳过中间帧，只渲染最终态文本 |
| MR-2 | `apps/crish-desktop/src/components/chat/MessageContent.tsx` | 增量 Markdown 渲染管道增加 `requestIdleCallback` 降级：浏览器空闲时才执行 DOM patch，避免高频 token 写入阻塞主线程布局 |

**4-E：SSE 解析器零拷贝**

| 任务 | 文件 | 操作 |
|------|------|------|
| ZC-1 | `sse.rs:73` | `to_vec()` 替换为 `Bytes::from(&self.buffer[..end])`（引用计数共享） |
| ZC-2 | `sse.rs:80` | `drain()` 替换为 `copy_within` 或基于 cursor 的位置追踪 |
| ZC-3 | `sse.rs:97` | `String::from_utf8(bytes.to_vec())` 替换为 `String::from_utf8_lossy(&bytes)`，避免拷贝 |
| ZC-4 | 验证 `seahash` 或 `ahash` 在计算密集型路径中是否可用替代 `drain` 的 O(n) | 评估后决定 |

---

### 第 5 轮：状态管理与数据流修复（依赖：第 0 轮）

**目标**：消除 Immer 内 Object.assign 反模式，隔离 streamTextOffset，消除 messages.shift() 破坏。

**5-A：Immer 内 Object.assign 替换**

| 任务 | 文件 | 行 | 替换策略 |
|------|------|-----|---------|
| OA-1 | `tool-actions.ts` | 27 | `Object.assign(target, toolCall)` → 字段级赋值：`target.arguments = toolCall.arguments; target.output = toolCall.output; target.status = toolCall.status; target.progress = toolCall.progress; target.error = toolCall.error; target.shouldContinue = toolCall.shouldContinue; target.swept = toolCall.swept;` |
| OA-2 | `tool-actions.ts` | 62 | `Object.assign(tc, effective)` → 同上字段级拆分 |
| OA-3 | `tool-actions.ts` | 93, 95 | 两个分支的 Object.assign 分别替换 |
| OA-4 | `agent-actions.ts` | 49 | `Object.assign(ag, patch)` → `Object.entries(patch).forEach(([k, v]) => { ag[k] = v })` 或类型安全的字段级赋值 |
| OA-5 | `agent-actions.ts` | 61 | `Object.assign(existing, message)` → 字段级拆分 |
| OA-6 | 添加 eslint rule：`no-restricted-syntax` 禁止 `Object.assign(` 在 session action 模块（**live:** `session*Actions.ts`；**historical:** `session-actions/` deleted W4-2）和 `slices/` 中使用 | CI 阻止新 Object.assign 引入 |

**5-B：streamTextOffset 隔离**

| 任务 | 内容 | 依赖 |
|------|------|------|
| ST-1 | 定义 `StreamingMessageRenderState` 接口，包含 `streamTextOffset: number` | 无 |
| ST-2 | 从 `SessionMessage` 移除 `streamTextOffset` 字段 | ST-1 |
| ST-3 | 将 sessionPersistence.ts:291-295 的 `streamTextOffset` 读入重定向到 `StreamingMessageRenderState` | ST-1 |
| ST-4 | 将 sessionActions.ts/sessionEventHydrate.ts/subagentTimeline.ts 的写入路径重定向到 `StreamingMessageRenderState` | ST-1 |
| ST-5 | 验证：`updateMessageText` 从 `StreamingMessageRenderState` 读取 offset，不再依赖 `SessionMessage.streamTextOffset` | ST-2/3/4 |

**5-C：messages.shift() 有感知截断**

| 任务 | 文件 | 行 | 操作 |
|------|------|-----|------|
| MS-1 | `message-actions.ts` | 27 | `messages.shift()` 前检查 `messages[0]` 是否包含 `toolCalls`，如果包含则标记为"truncated-toolchain"而非直接删除 |
| MS-2 | `agent-actions.ts` | 63 | 同上，对 agent messages 做同样检查 |
| MS-3 | 定义 `truncatedToolChainIds: string[]` 在 store state 中，让 UI 层可以展示"有工具调用被截断"的提示 | MS-1 |
| MS-4 | 或者在截断时检查 tool-call/tool-result 配对，只截断已完成的配对块 | 选择 MS-1 或 MS-4（推荐 MS-4） |

**5-D：useShallow Selector 补全**

| 任务 | 文件 | 操作 |
|------|------|------|
| SH-1 | `useChatCardSelectors.ts:18-29` | 对 `appSettings`、`diffFiles`、`composerDrafts` 的 selector 添加 `useShallow` 包装 |

---

### 第 6 轮：安全防线构建（依赖：第 0 轮）

**目标**：API key 存储安全、进程执行保护（防爆网 + 进程树生命周期 + 用户审批）、MCP 权限校验、CSP 收紧。

**6-A：API Key 存储安全**

密钥存储采用双层策略：优先 OS Keychain，不可用时通过设置界面让用户填写或存入本地加密文件。

| 任务 | 文件 | 操作 | 依赖 |
|------|------|------|------|
| KS-1 | `secret-store.ts:15-30` | OSKeychainStore 接入 `@napi-rs/keychain`（macOS）、Windows `CredWriteW/CredReadW` 或 `tauri-plugin-credential`。stub 必须替换为真实调用。不引入已归档的 `keytar` | 无 |
| KS-2 | `encrypted-file-store.ts:28-29` | master key 路径强制分离到 OS keychain（KS-1 完成后），或至少分离到不同 BASE 目录（如 `~/.config/crish/keys/` 与 `~/.local/share/crish/vault/` 分离） | KS-1 |
| KS-3 | `encrypted-file-store.ts:47` | Windows 上 `chmod 0o600` catch {} 改为实际调用 `icacls` 或 `fs.chmodSync` 后检查文件权限 | 无 |
| KS-4 | `providerProfiles.ts:641-649` | `saveProfiles()` 保存前清除 `apiKey` 字段（apiKey 只通过后端 `secret-store` 管理，前端不持久化）。OS Keychain 不可用时，通过设置界面让用户填写 key，或存入本地加密文件 | KS-1 |
| KS-5 | `providerProfiles.ts` | 前端读取 API key 时改为调用 `window.__TAURI_INTERNALS__.invoke('get_api_key', { profileId })` 走后端加密获取 | KS-1 |

**6-B：进程执行保护（防爆网 + 进程树生命周期 + 用户审批）**

不做完整的操作系统级沙盒。重点放在三层保护：

| 任务 | 文件 | 操作 |
|------|------|------|
| PP-1 | `crates/conex-sandbox/src/gatekeeper.rs:73-78` | `args.join(" ")` 改为逐参数正则匹配，避免 shell 注入绕过现有 11 条红线模式。补全常见绕过路径（`-rf "/"`、`-r -f /`、环境变量拼接等） |
| PP-2 | `apps/agent-workbench/src-tauri/src/process.rs` | 已有 `create_daemon_job_object` + `assign_child_to_daemon_job_object`（Windows）和 `set_child_process_group`（Unix），确认在 `connection/lifecycle.rs` 的子进程 spawn 后已全部调用。确保 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 在 Tauri 进程退出时自动终止子进程树 |
| PP-3 | `packages/decision-engine/src/trust-zone.ts` + `permissions.ts` | 已有 T0-T4 信任区 + 5 种模式矩阵。确认 `TrustZoneDecision` 在进程执行前被调用（gatekeeper 之后、spawn 之前），而不是仅做查询用 |
| PP-4 | MCP 命令启动前增加用户确认：首次运行时前端弹对话框展示 `Server {name} will execute: {command}` 并获得用户显式确认（写入 `permission-store.ts`，后续同命令不再重复确认） | 无 |

**6-C：MCP 启动安全**

| 任务 | 文件 | 操作 |
|------|------|------|
| MC-1 | `mcp-stdio-adapter.ts:123-132` | `mergeProcessEnv()` 改为白名单模式：只合并 `process.env.PATH` + `process.env.HOME` + config 中显式声明的 env 键，不合并全部 `process.env` | 无 |
| MC-2 | 新增 MCP 启动确认对话框（前端）：首次运行时展示 `Server {name} will execute: {command}` 并获得用户显式确认（与 PP-4 复用同一流程） | 无 |

**6-D：CSP 收紧**

| 任务 | 文件 | 操作 |
|------|------|------|
| CP-1 | `index.html:7` | 移除 `script-src` 中的 `'unsafe-eval'`。生产构建测试 `eval()` 依赖——react-refresh 和 Tauri 的 invoke 不需要 eval |
| CP-2 | `index.html:7` | `connect-src` 中的 `http:` 和 `ws:` 替换为具体白名单：`connect-src 'self' ipc: http://localhost:* ws://127.0.0.1:* https://api.anthropic.com https://generativelanguage.googleapis.com` |
| CP-3 | 如果移除 `unsafe-inline` 不可行（CSS-in-JS 依赖），则至少移除 `unsafe-eval` | CP-1 |

---

### 第 7 轮：Tool Hook 链精简 + IpcRouter 删除 + 双轨 ProviderRegistry 统一（依赖：第 0 轮）

**目标**：删除三层冗余抽象，降低 JSON 序列化次数和调试难度。

**7-A：Tool Hook 链精简**

当前 6 阶段洋葱模型（beforeRegister → beforeResolve → beforeApprove → beforeExecute → afterExecute → onError）过于复杂。99% 的工具调用本质上只需要 2 个节点：执行前（安全防爆网/用户审批）+ 执行后（捕获结果或 Error）。废弃 6 阶段中间件流，精简为 3 个方法。

**精简前必须先盘点**：当前 `ToolHook` 接口的全部实现和消费者。删除 `beforeRegister`/`beforeResolve`/`beforeApprove`/`afterExecute` 前，必须逐个确认这些方法在当前实现中是否有实际的功能逻辑（不仅仅是空实现或透传），如果没有功能逻辑则安全删除，如果有则迁移到 `beforeExecute`/`onResult` 中。

| 任务 | 文件 | 操作 |
|------|------|------|
| TH-0 | 全库搜索 `implements ToolHook` 和 `ToolHook` 类型引用 | 列出所有实现者和消费者。确认 `beforeRegister`、`beforeResolve`、`beforeApprove`、`afterExecute` 在当前实现中是否有实质性逻辑，确保删除后功能不丢失 |
| TH-1 | `packages/agent-runtime/src/hooks/tool-hook-types.ts` | 将 `ToolHook` 接口从 6 个方法精简为 3 个：`beforeExecute(input, ctx): BeforeExecuteResult`、`onResult(output, ctx): ToolResult`、`onError(error, ctx): void`。删除 `beforeRegister`、`beforeResolve`、`beforeApprove`、`afterExecute`。**同步更新 `tool-hook-observability.ts` 中相同的 6 方法接口定义，确保两处一致** |
| TH-2 | `packages/agent-runtime/src/hooks/middleware-pipeline.ts` | 废弃 `MiddlewarePipeline` 类。删除文件或在顶部添加 `@deprecated` 标记。`session-loop/tool-execution.ts` 中改用直接调用 `ToolHook.beforeExecute()` + `ToolHook.onResult()`/`ToolHook.onError()` |
| TH-3 | `packages/agent-runtime/src/hooks/agent-hooks.ts` | 将 `AgentHooks` 的 deprecation 标记从"迁移到 ToolHook"改为"迁移到精简后的 `ToolHook.beforeExecute/onResult/onError`"，更新迁移指南 |
| TH-4 | `packages/agent-runtime/src/session-loop/tool-execution.ts` | 移除 `MiddlewarePipeline` 的创建和调用。直接检查 `ToolHook[]` 数组，依次调用 `beforeExecute`（防爆网+审批通过才执行）、`onResult`（执行成功后记录结果）、`onError`（执行失败后记录日志并透传错误）。**注意：TH-4 重写后 `tool-execution.ts` 中原有的 `as any` 不会被自动清理，A-17（any 消减）的 scope 不覆盖此文件——由 TH-4 的执行者一并在重写时清理** |
| TH-5 | `packages/agent-runtime/src/approval/` | `ApprovalPipeline` 保留，在 `beforeExecute` 内部选择性调用。`BeforeExecuteResult` 必须定义三种状态：`{ status: 'approved'; input: ToolInput }`（审批通过，可执行）、`{ status: 'blocked_by_gatekeeper'; reason: string }`（防爆网拦截，跳过执行）、`{ status: 'pending_approval'; request: ApprovalRequest }`（等待用户审批，编排层应等待而非跳过）。编排层在收到 `pending_approval` 时必须等待用户响应而非判定为阻断。`beforeExecute` 内部的执行顺序：先防爆网检查（gatekeeper），再审批（ApprovalPipeline），确保高危命令不会出现在审批对话框中 |

**7-B：Rust Tauri IpcRouter 删除**

`apps/agent-workbench/src-tauri/src/core_commands.rs` 内部用 HashMap 实现了一套 IpcRouter，将 Tauri 原生 `#[tauri::command]` 的函数又包了一层 `IpcRequest`/`IpcResponse`，导致：Tauri 序列化一次 → IpcRouter 序列化第二次 → Handler 反序列化第三次。直接删除内层路由，在 `#[tauri::command]` 中直接调用底层 Rust 函数。

**改造前必须先审计前端 `invoke()` 调用模式**：如果前端通过 `invoke('ipc_route', { command: 'xxx', payload })` 统一网关调用，删除 IpcRouter 后需同步修改前端代码。如果前端直接 `invoke('search_handler', ...)` 按命令名直调，则前端零改动。

| 任务 | 文件 | 操作 |
|------|------|------|
| IR-0 | 前端 `apps/crish-desktop/src/` + `apps/agent-workbench/src/` | 审计所有 `invoke(` 调用，确认前端调用模式：是(A)直接按命令名调用 `invoke('handler_name', payload)`，还是(B)通过统一网关 `invoke('ipc_route', { command, payload })`。如果是模式(B)，IR 需同步修改前端代码 |
| IR-1 | `apps/agent-workbench/src-tauri/src/core_commands.rs` | 删除 `IpcRouter` 结构体、`register_handler()`/`route()` 方法、`IpcRequest`/`IpcResponse` 类型。将 7 个 handler（SearchHandler、RebuildSearchIndexHandler、CompactMessagesHandler、TokenCountHandler、CheckCommandHandler、DiffHandler、StatusHandler）的逻辑直接写入 `#[tauri::command]` 函数体中。**共享状态迁移**：`Arc<RwLock<Vec<String>>>` 当前在 `register_core_handlers` 中创建并在 3 个 handler 间共享，删除 IpcRouter 后改为通过 `tauri::State<>` 注入或提取为独立模块的 `once_cell::sync::Lazy` 全局变量持有 |
| IR-2 | `apps/agent-workbench/src-tauri/src/sidecar/commands/` | 检查所有 `#[tauri::command]` 函数，确认它们直接调用 Rust 底层函数。`sidecar/commands/` 下的命令已经是直接的 `#[tauri::command]`，不经过 IpcRouter。真正需要修改的是 `core_commands.rs` 的 7 个 command 函数内的 `state.dispatch(IpcRequest{...})` 调用，将其替换为对应 handler 的 `handle()` 直接调用 |
| IR-3 | 删除 core_commands.rs 中的 `BackendFallbackGate` 及其 `dispatch_fallback`/`degraded_mode`/`register_fallback` 机制 | 删除前确认是否有真实消费者需要此降级能力。如果有，将其提取为独立组件而非内嵌在 IpcRouter 中 |
| IR-4 | `tests/` 下 6 个集成测试（search_integration.rs、sandbox_integration.rs、integration_test.rs、compaction_integration.rs、fs_integration.rs、diff_integration.rs）+ `benches/ipc_bench.rs` | 这些测试直接构造 `IpcRequest` 并调用 `IpcRouter::dispatch()`。删除 IpcRouter 后全部重写为直接调用底层函数或通过 `#[cfg(test)]` 辅助函数 |
| IR-5 | 验证：`cargo build` 零错误；前端所有 `invoke(` 命令名列表在 IR 前后一致；`cargo test --workspace` 通过的测试数量不减少 | IR-1~IR-4 |

**7-C：双轨 ProviderRegistry 统一**

废弃并删除旧的 `provider-factory.ts` 和 `ProviderRegistry` V1，全库统一使用 `ProviderRegistryV2`。

**拆除 V1 前必须先解耦 V2 对 V1 的内部依赖**：`registry-v2.ts:41` 持有 `declarativeRegistry: ProviderRegistry`（V1），V2 的所有 `loadFromConfig`、`listProviders`、`createProvider` 方法都依赖内部的 V1 实例。必须先为 V2 实现独立的声明式 provider 存储（JSON 文件解析 + 条目管理），或者将声明式存储抽取为独立的 `DeclarativeProviderStore`，再删除 V1。

**已知的 8 处 V1/废弃引用**：
1. `provider-gateway-v2.ts` — 字段类型 `registry: ProviderRegistry`
2. `provider/loader.ts` — 持有 `ProviderRegistry` 字段
3. `provider/factory.ts` — 持有 `ProviderRegistry` 字段，`EngineProvider` 实现依赖 V1
4. `provider/builtin/index.ts` — `registerBuiltinProviders(registry: ProviderRegistry)` 参数签名
5. `cli/main.ts` — `new ProviderRegistry()` 调用
6. `provider-dev.ts`（CLI）— 参数签名 + `new ProviderRegistry()`
7. `provider-factory.test.ts` — `new ProviderRegistry()` 测试
8. `declarative-loader.test.ts` — `new ProviderRegistry()` 测试

| 任务 | 文件 | 操作 |
|------|------|------|
| PR-0 | `packages/agent-runtime/src/provider/registry-v2.ts` | 从 `ProviderRegistryV2Impl` 中移除对 V1 `ProviderRegistry` 的依赖。具体做法：将 `loadFromConfig` 中的 `this.declarativeRegistry.registerFromFile(path)` 改为 V2 自有的 JSON 文件解析和条目存储逻辑，或提取独立的 `DeclarativeProviderStore` 组件。V2 必须独立于 V1 存在 |
| PR-1 | 上述 8 处引用 + 全库其他 V1 引用（当前共 ~51 处，包括测试文件） | 将全部 V1 消费者迁移到 `ProviderRegistryV2`。`new ProviderRegistry()` → `new ProviderRegistryV2Impl()`。`register(file)` → `loadFromConfig(file)`。`get(id)` → `createProvider(id)`。参数签名中的 `ProviderRegistry` → `ProviderRegistryV2` |
| PR-2 | `packages/agent-runtime/src/provider/registry.ts`（V1）+ `packages/agent-runtime/src/provider-factory.ts` | PR-1 迁移全部完成后：删除这两个文件，更新 `provider/index.ts` barrel。向后兼容策略：`provider/index.ts` 中添加 `export { ProviderRegistryV2Impl as ProviderRegistry }` 类型别名，避免外部消费者编译失败；但 `ProviderRegistryV2` 的 API 与 V1 不同（V1: `register/get/list`，V2: `createProvider/loadFromConfig/registerProviderClass`），别名只解决类型名，不解决 API 签名——所以外部消费者仍需修改 import 和调用代码 |
| PR-3 | 全库搜索 `ProviderRegistry`（不含 V2）引用，确认清零 | `grep -r "ProviderRegistry\b" --include="*.ts" --include="*.tsx" \| grep -v "RegistryV2" \| grep -v "V2"` 返回 0 匹配 |

---

### 第 8 轮：类型系统加固（依赖：第 0 轮）

**目标**：系统性降低 any 使用率，统一 @deprecated 治理，修复 tsconfig 配置链。第 8 轮与第 7 轮并行执行，不等待——`provider-openai-compatible.ts`（any 消减主目标）不引用任何 ToolHook 类型，类型系统加固与 Hook 精简单无文件冲突。

**8-A：any 消减**

| 任务 | 文件 | 策略 |
|------|------|------|
| AN-1 | `provider-openai-compatible.ts` 25 处 `: any` | 逐个替换为正确类型。`httpRequest`、`response`、`body` 在已有 Provider 类型定义下应可完全类型化（参考 `OpenAICompatibleEngine` 的类型） |
| AN-2 | `session-loop/index.ts` 12 处 `as any` | 评估每个 `as any`：如果是在 `dispatch` 时的类型擦除（Event type enum → generic），则替换为类型守卫或 discriminated union；其他替换为具体类型 |
| AN-3 | `layoutStore.ts` 6 处 `as any` | 这些主要出现在 `persist` 和 `subscribe` 的中间件配置中。zustand 已有 `StateStorage` 类型，替换为具体类型 |
| AN-4 | `scripts/check-no-as-any-store.mjs` | 扩展为 `scripts/check-no-as-any.mjs`，覆盖 `packages/*/src/`、`apps/crish-desktop/src/`、`apps/agent-workbench/src/`，排除测试文件 |
| AN-5 | 将 `check-no-as-any.mjs` 接入 CI（第 1 轮 CI-4） | 设定初始阈值（允许现有 any 数量但阻止新增） |

**8-B：tsconfig 配置链修复**

| 任务 | 文件 | 操作 |
|------|------|------|
| TC-1 | `apps/crish-desktop/tsconfig.node.json` | 继承 `../../tsconfig.base.json` |
| TC-2 | 检查所有 `tsconfig.json` 是否都继承 base | glob `**/tsconfig.json` 并逐一验证 |

---

### 第 9 轮：测试覆盖补齐（依赖：第 0 轮）

**目标**：补齐测试缺口，修复集成测试配置错位，恢复 test:core 通过率。

**9-A：测试失败修复**

| 任务 | 根因 | 修复策略 |
|------|------|---------|
| TF-1 | SSRF 拦截 localhost（`provider-factory.test.ts`、`circuit-breaker-e2e.test.ts`） | `validateBaseUrl` 增加 `ALLOW_TEST_LOCALHOST` 环境变量/env flag，CI 中设置此标志 |
| TF-2 | E2E 超时（`steering-injection.test.ts`、`stream-parser.test.ts`） | 增加 mock server 流式响应的即时性（减少人为 delay），或增加 `testTimeout` 到 30s |
| TF-3 | 类型断言错误（`provider-call-gateway.test.ts`） | 对照 C2-4 后 `ProviderStreamContractEvent` 的实际结构更新测试断言 |
| TF-4 | 全部修复后运行 `test:core` 确认 0 failed | CI 基线 |

**9-B：引擎测试补齐**

| 任务 | 文件 | 策略 |
|------|------|------|
| ET-1 | `ollama-engine.test.ts` 新建 | 至少覆盖：`createRequest`、`parseStream`（mock http response）、`classifyError` |
| ET-2 | `openai-compatible-engine.test.ts` 新建 | 继承 `base-engine.test.ts` 的模式 |
| ET-3 | `anthropic-messages-engine.test.ts` 新建 | 至少覆盖 `buildRequest` 的工具格式和 `parseStream` 的事件序列 |

**9-C：集成测试路径修复**

| 任务 | 文件 | 操作 |
|------|------|------|
| IT-1 | 根目录 | 创建 `vitest.integration.config.ts`，或修改 `package.json:62` 为 `vitest run --config apps/crish-desktop/vitest.integration.config.ts` |
| IT-2 | `apps/crish-desktop/tests/integration/` | 确认 `store-persistence.test.ts` 和 `daemon-ipc.test.ts` 实际运行通过 |

---

### 第 10 轮：God Class 遗留问题拆分（依赖：第 0 轮）

**目标**：拆分最后四个大文件，消除 300 行以上组件的行数超标。

| 任务 | 文件 | 当前行数 | 目标结构 |
|------|------|---------|---------|
| GC-1 | `apps/crish-desktop/src/api/daemonChatBridge.ts` | 1214 | 拆分为 `daemon-chat-bridge/EventRouter.ts`、`daemon-chat-bridge/streamViaDaemon.ts`、`daemon-chat-bridge/handlers/` 子目录 |
| GC-2 | `apps/crish-desktop/src/api/clientApi.ts` | 887 | 拆分为 `client-api/settings.ts`、`client-api/providers.ts`、`client-api/schedule.ts` |
| GC-3 | `apps/crish-desktop/src/components/Workspace.tsx` | 994 | 拆分为 `workspace/WorkspaceCanvas.tsx`、`workspace/WorkspaceSplitChrome.tsx`、`workspace/WorkspaceResizer.tsx` |
| GC-4 | `apps/crish-desktop/src/components/ChatComposer.tsx` | 671 | 拆分为 `composer/ComposerSlashMenu.tsx`、`composer/ComposerAttachmentsBar.tsx`、`composer/ComposerActions.tsx` |

---

### 第 11 轮：关键组件 memo 优化与 Tooltip 规范化（依赖：第 10 轮）

React.memo 只加给高频更新的叶子组件（消息行 MessageRow、虚拟列表项、卡片面板等）。不给只有 2 行 JSX 的简单组件加——额外的 shallow compare 开销反而降低性能。不做硬性覆盖率指标。

| 任务 | 范围 | 操作 |
|------|------|------|
| RM-1 | 高频叶子组件（MessageRow、虚拟列表项、卡片面板等） | 审读这些组件是否已包裹 `React.memo`，缺失的补上。纯展示性简单组件跳过 |
| RM-2 | 约 50 处原生 `title="..."` | 替换为 `<Tooltip>` 组件 |

---

## 第三部分：轮次依赖关系图

```
第0轮：解决编译阻塞（21个UU文件合并冲突）
  │
  ├──→ 第1轮：基础设施接入与去死代码（CI门禁、depcruise、死代码处理）
  ├──→ 第2轮：TECH_DEBT校准与度量基线（TD-009/030/031校准、@deprecated治理）
  ├──→ 第3轮：错误处理与可恢复性统一（ErrorClassifier全覆盖、CircuitBreaker冒泡、空catch）
  ├──→ 第4轮：性能统一与资源优化（useAgentStream批合并、session并发控制、死代码清除）
  ├──→ 第5轮：状态管理与数据流修复（Object.assign替换、streamTextOffset隔离、messages.shift修复）
  ├──→ 第6轮：安全防线构建（API key存储、进程保护、MCP权限、CSP收紧）
  ├──→ 第7轮：冗余抽象删除（ToolHook精简、IpcRouter删除、双轨Provider统一）
  ├──→ 第8轮：类型系统加固（any消减、tsconfig，与第7轮并行，无文件冲突）
  ├──→ 第9轮：测试覆盖补齐（test:core修复、引擎测试、配置修复）
  │
  ├──→ 第10轮：God Class遗留拆分（daemonChatBridge、clientApi、Workspace、ChatComposer）
  │         │
  │         └──→ 第11轮：UI规范与收尾（关键memo、Tooltip替换）
  │
  └── 第7、8、9、10轮间无强制依赖，四轮可并行；第11轮依赖第10轮。
```

所有轮次均依赖 Round 0（编译阻塞解除）。第 1-6 轮之间无跨轮依赖，可完全并行。第 7、8、9、10 轮间无文件冲突，四轮可并行。第 11 轮依赖第 10 轮。

**注意**：同轮内的不同 Agent 如果涉及同一文件的不同任务，按 4.3 节的串行化说明执行。不同轮次如果修改同一文件，靠执行顺序保证（后一轮在前一轮全部完成后启动），不存在冲突。

---

## 第四部分：Agent 分配方案

### 4.1 子 Agent 划分原则（修正版）

每个 Agent 的独占文件不可重叠。以下互斥边界必须遵守——_4.2 节的 Agent 分配与此表精确对应，无矛盾_：

| 冲突文件 | 涉及任务 | 必须归入同一 Agent | 理由 |
|---------|---------|------------------|------|
| `provider-openai-compatible.ts` | EC-1/2/3（分类器统一）+ AN-1（any消减） | 是 | 文件级互斥 |
| `session-loop/index.ts` | CB-1/2（移除CircuitBreaker）+ SC-1（并发控制）+ AN-2（any消减） | 是 | 文件级互斥（三个任务分配在同一Agent内顺序执行，不并行） |
| `agent-actions.ts` | OA-4/5（Object.assign）+ MS-2（messages.shift） | 是 | 文件级互斥 |
| `session-store/index.ts` | SS-1/2（silent return 消除） | 独占 | 不与其他任务共享 |

### 4.2 推荐 Agent 聚合（修正版）

AN-4/5（check-no-as-any 脚本扩展）从第 7 轮移至第 1 轮，消除跨轮依赖。A-01 拆为 3 个子 Agent。A-19 拆为 2 个。A-07/A-13/A-16 合并到其他 Agent。

| Agent | 轮次 | 任务聚合 | 独占文件 |
|-------|------|---------|---------|
| A-01a | 0 | M-0, M-1, M-2（daemon 协议+服务层冲突） | agent-daemon/protocol/、server.ts、types.ts 等 |
| A-01b | 0 | M-3, M-4, M-5（runtime+orchestrator 冲突） | agent-runtime/、agent-orchestrator/ 共 7 个 UU 文件 |
| A-01c | 0 | M-6, M-7（前端 store + hook 冲突） | apps/crish-desktop/ 共 4 个 UU 文件 |
| A-01v | 0 | M-8（全局编译验证 + test:core 基线快照） | 不修改文件，仅运行验证 |
| A-02 | 1 | CI-1~CI-5 + AN-4~AN-5 + CA-1~CA-4 + LS-1（CI门禁 + check-no-as-any扩展） | .github/workflows/、package.json、.dependency-cruiser.cjs、scripts/check-no-as-any.mjs |
| A-03 | 1+4 | DC-1~DC-4 + DK-1~DK-3（死代码清理决策与执行） | frameScheduler.ts、useFpsMonitor.ts、backpressure.ts、bootstrap-services.ts |
| A-04 | 2 | TD-01~TD-11 + DP-1~DP-4（TECH_DEBT 校准 + @deprecated 治理） | TECH_DEBT.md、全 @deprecated 标记文件 |
| A-05 | 3 | EC-1~EC-10 + CB-1~CB-4 + SS-1~SS-5 + FG-1~FG-2（错误处理统一，含移除CircuitBreaker、空catch、Store静默拒绝、指数退避） | provider-openai-compatible.ts、session-loop/index.ts、session-store/index.ts、provider-call-gateway.ts、fallback-chain/ |
| A-08 | 4 | SR-1~SR-4（流式渲染统一） | useStreamCallbacks.ts、useAgentStream.ts |
| A-09 | 4 | SC-1~SC-3（session 并发控制）+ MR-1~MR-2（前端帧率降级） | session-loop/index.ts（与A-05顺序执行）、server/index.ts、SessionStreamManager.ts、chat-stream/、MessageContent.tsx |
| A-10 | 4 | ZC-1~ZC-4（SSE 零拷贝） | sse.rs |
| A-11 | 5 | OA-1~OA-6 + MS-1~MS-4（Object.assign 替换 + messages.shift 修复） | tool-actions.ts、agent-actions.ts、message-actions.ts |
| A-12 | 5 | ST-1~ST-5 + SH-1（streamTextOffset 隔离 + useShallow） | types.ts、sessionPersistence.ts、sessionActions.ts、useChatCardSelectors.ts |
| A-14 | 6 | KS-1~KS-5 + CP-1~CP-3（API密钥 + CSP） | secret-store.ts、encrypted-file-store.ts、providerProfiles.ts、index.html |
| A-15 | 6 | PP-1~PP-4 + MC-1~MC-2（进程保护 + MCP） | gatekeeper.rs、process.rs、trust-zone.ts、permissions.ts、mcp-stdio-adapter.ts、mcp-config.ts |
| A-07 | 7 | TH-0~TH-5（ToolHook 链精简：盘点→6阶段→3阶段，废弃 MiddlewarePipeline） | tool-hook-types.ts、middleware-pipeline.ts、agent-hooks.ts、tool-execution.ts、tool-hook-observability.ts、approval/ |
| A-13 | 7 | IR-0~IR-5（前端 invoke 审计→IpcRouter 删除→测试迁移→验证） | core_commands.rs、sidecar/commands/、lib.rs、tests/*.rs、benches/ipc_bench.rs |
| A-16 | 7 | PR-0~PR-3（V2→V1 解耦→迁移 51 处引用→删除 V1+factory→验证清零） | provider-factory.ts、provider/registry.ts、provider/registry-v2.ts、provider/index.ts |
| A-17 | 8 | AN-1~AN-3 + TC-1~TC-2（any 消减 + tsconfig） | provider-openai-compatible.ts（与A-05顺序执行）、tsconfig.node.json |
| A-18 | 9 | TF-1~TF-4 + ET-1~ET-3 + IT-1~IT-2（测试修复） | 各 *.test.ts、vitest.integration.config.ts、package.json |
| A-19a | 10 | GC-1 + GC-2（daemonChatBridge + clientApi 拆分） | daemonChatBridge.ts、clientApi.ts |
| A-19b | 10 | GC-3 + GC-4（Workspace + ChatComposer 拆分） | Workspace.tsx、ChatComposer.tsx |
| A-20 | 11 | RM-1~RM-2（关键 leaf 组件 memo + Tooltip 替换） | 高频叶子组件、Tooltip 替换文件 |

### 4.3 关键冲突串行化说明

以下文件被多个 Agent 修改，通过"顺序执行"而非"并行互斥"解决：

| 文件 | 修改顺序 | 理由 |
|------|---------|------|
| `provider-openai-compatible.ts` | A-05（错误分类统一）→ 后续 A-17（any 消减） | 分类器替换后类型更清晰，any 消减更容易 |
| `session-loop/index.ts` | A-05（CircuitBreaker 冒泡）→ A-09（并发控制）→ A-17（any 消减） | 功能增加后再做类型清理 |
| `agent-actions.ts` | A-11 单独处理，无并行冲突 | 已将 OA-4/5 和 MS-2 合并到同一 Agent |
| `provider-factory.ts` | 不单独分配 Agent，并入第 2 轮 TD-05（标记状态）和 A-11/A-17（消费方迁移）| 8 处引用由各自的改造 Agent 在修改调用时同期迁移 |
| `daemonChatBridge.test.ts` | GC-1 拆分时同步更新测试文件 | 测试文件引用被拆分的 `daemonChatBridge.ts`，拆分后 import 路径会变 |

---

## 第五部分：验收标准总表

| 轮次 | 编号 | 检查项 | 验证方法 | 通过条件 |
|------|------|--------|---------|---------|
| 0 | V-00 | 合并冲突清零 | `git diff --check` 跨所有源文件 | 0 个冲突标记 |
| 0 | V-01 | 全局编译 | `npx tsc --noEmit` + `cargo check` | 0 error |
| 1 | V-10 | CI npm audit | 运行 `npm audit --audit-level=moderate` | 阻断 moderate 以上漏洞 |
| 1 | V-11 | CI cargo deny | 运行 `cargo deny check` | 0 deny 违规 |
| 1 | V-12 | CI depcruise | 运行 `npx depcruise -c .dependency-cruiser.js packages apps --ignore "dist/"` | 预配置规则 0 违规 |
| 1 | V-13 | CI any-check | 运行 `node scripts/check-no-as-any.mjs` | packages + apps 全覆盖 |
| 1 | V-14 | pre-commit 合并冲突拦截 | `git diff --check` 在 pre-commit 中 | 冲突标记阻断 commit |
| 1 | V-15 | 死代码清零 | `grep -r "import.*frameScheduler\|import.*useFpsMonitor" apps/ packages/` 且无 deprecation | 0 个死代码引用 |
| 2 | V-20 | TECH_DEBT 校准 | 全部 57+ 项逐个对比代码 | 每项状态与代码一致 |
| 2 | V-21 | @deprecated 规范 | `grep "/\*\* @deprecated" --include="*.ts" --include="*.tsx"` | 每处都含 `@see` 和 `@removeWhen` |
| 3 | V-30 | ErrorClassifier 覆盖 | `grep "classify(Transport\|Stream\|Http)ProviderError" provider-openai-compatible.ts` | 0 个独立分类函数残留 |
| 3 | V-31 | CircuitBreaker 已移除 | 全库 `grep -r "CircuitBreaker\b\|CircuitBreakerOpenError\|\.allowRequest\(\)\|\.recordSuccess\|\.recordFailure" --include="*.ts" --include="*.tsx" --include="*.rs"` | 0 处 CircuitBreaker 代码残留（测试和生产均清零）；`backpressure.ts` barrel 中无 `CircuitBreaker` 导出；`circuit-breaker-e2e.test.ts` 已删除或重写 |
| 3 | V-32 | Session Store 异常 | `grep "return;" session-store/index.ts` | 无 silent return |
| 3 | V-33 | 空 catch 日志 | `grep "catch {}" --include="*.ts" --include="*.tsx" packages/ apps/` | 系统化审读后 0 个未添加日志的 catch |
| 3 | V-34 | 指数退避 + 错误透传 | 集成测试验证：provider 调用失败后按指数退避重试；重试耗尽后前端收到含 `retryable: true` 标记的 error event；用户点击"重试"按钮后重新发起 provider 调用 | 退避策略为 1s→2s→4s→...→30s cap；retryable error event 结构已定义；重试按钮对应后端 API 已实现 |
| 4 | V-40 | useAgentStream 使用 StreamRenderBuffer | 确认 `useAgentStream.ts` 中调用 `useStreamingText` | 无 `pa((m) => { m.text` 直写模式 |
| 4 | V-41 | Session 并发控制 | `session-loop/index.ts` 包含 `asyncMutex.acquire()` | per-session 互斥 |
| 4 | V-42 | SessionStreamManager 有界 | `SessionStreamManager.ts` 使用 `BoundedMap` | 无 `new Map<string, ...>` |
| 5 | V-50 | Object.assign 清零 | `grep "Object.assign(" session*Actions.ts slices/`（**not** deleted `session-actions/`） | 0 处 |
| 5 | V-51 | streamTextOffset 不在 SessionMessage 上 | `grep "streamTextOffset" types.ts` | 0 匹配 |
| 5 | V-52 | messages.shift 有配对感知 | `grep "messages.shift()" sessionMessageActions.ts`（**historical path was** `session-actions/`） | 0 处无条件 shift |
| 5 | V-53 | useChatCardSelectors useShallow | 代码审读确认 | 所有引用类型 selector 含 useShallow |
| 6 | V-60 | OSKeychain 非 stub | `secret-store.ts` 无 "not available" throw | 真正调用系统 keychain |
| 6 | V-61 | Master key 分离 | `encrypted-file-store.ts` 路径含不同 base | master key 与 vault 不同目录 |
| 6 | V-62 | localStorage 无 apiKey | `providerProfiles.ts` saveProfiles 不包含 apiKey | 0 条明文 key 写入 |
| 6 | V-63 | gatekeeper 防绕过 | `gatekeeper.rs` 逐参数正则而非 `args.join(" ")` | shell 注入绕过路径已覆盖 |
| 6 | V-64 | 进程树绑定 | `process.rs` Job Object 在 daemon spawn 后已调用 | 子进程在父进程退出时自动终止 |
| 6 | V-65 | TrustZone 执行前调用 | 代码审读确认 `TrustZoneDecision` 在 spawn 前被实际调用 | 进程保护逻辑完整 |
| 6 | V-66 | MCP env 白名单 | `mcp-stdio-adapter.ts` mergeProcessEnv 不合并全部 process.env | 仅限定的 env keys |
| 6 | V-67 | CSP 无 unsafe-eval | `index.html` 不含 "unsafe-eval" | 移除 eval |
| 7 | V-70 | ToolHook 已精简 | 全库 `grep "beforeRegister\|beforeResolve\|beforeApprove\|afterExecute" --include="*.ts"` | 0 匹配（6 阶段方法在全库清零）；`tool-hook-observability.ts` 的接口定义与 `tool-hook-types.ts` 一致（3 方法）；`BeforeExecuteResult` 类型已定义三种状态 |
| 7 | V-71 | IpcRouter 已删除 | `grep "IpcRouter\|IpcRequest\|IpcResponse" --include="*.rs"` | 0 匹配（core_commands.rs、tests/、benches/ 均清零）；`BackendFallbackGate` 已处理（删除或提取） |
| 7 | V-72 | ProviderRegistry V1 已删除 | 全库 `grep "ProviderRegistry\b" --include="*.ts" --include="*.tsx" \| grep -v "RegistryV2\|V2"` | 0 匹配；`provider/registry.ts` 和 `provider-factory.ts` 文件已不存在；`provider/index.ts` barrel 已更新；provider-factory.test.ts 和 declarative-loader.test.ts 已迁移 |
| 7 | V-73 | 全量编译 + 测试不退化 | `cargo build` + `npx tsc --noEmit` + `npm run test:core`（与第 0 轮基线快照对比） | 编译零错误；test:core 失败数不增加 |
| 8 | V-80 | any 消减 | `scripts/check-no-as-any.mjs` 报告 | 现有 any 不增长（初始阈值） |
| 8 | V-81 | tsconfig.node.json 继承 base | `grep "extends" tsconfig.node.json` | 含 `../../tsconfig.base.json` |
| 9 | V-90 | test:core 全绿 | `npm run test:core` | 0 failed |
| 9 | V-91 | engine 测试 | `ls provider/engines/*.test.ts` | 3 engine 各有测试文件 |
| 9 | V-92 | 集成测试可运行 | `npm run test:integration` | 正确找到配置文件并执行 |
| 10 | V-100 | daemonChatBridge 拆分 | `wc -l daemon-chat-bridge/*.ts` | 每个 ≤ 500 行 |
| 10 | V-101 | clientApi 拆分 | `wc -l client-api/*.ts` | 每个 ≤ 500 行 |
| 10 | V-102 | Workspace 拆分 | `wc -l workspace/*.tsx` | 每个 ≤ 300 行 |
| 10 | V-103 | ChatComposer 拆分 | `wc -l composer/*.tsx` | 每个 ≤ 300 行 |
| 11 | V-110 | 关键叶子组件 memo | 代码审读 MessageRow、虚拟列表、卡片面板 | 高频更新组件已包裹 memo |
| 11 | V-111 | Tooltip 替换 | `grep 'title="' components/*.tsx` | ≤ 10 处（白名单） |

---

*本方案为系统性改进方案，仅包含逻辑顺序和任务依赖关系。不包含时间安排或人员分配。所有问题无优先级区分——只要存在即同等重要。*
