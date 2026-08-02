# Agent 3: Provider 故障恢复全链路审计报告

审计时间: 2026-07-24
审计范围: 指数退避重试实现、CircuitBreaker 移除确认、错误透传路径

---

## 1. 逐文件验证结果

### 1.1 `provider-call-gateway.ts` — ✅ 已清理

- `CircuitBreaker` 代码（`breaker.allowRequest`、`breaker.onSuccess/onFailure`等）**已全部移除**
- `retryProviderStream` 方法 (L169-191) 实现了正确的指数退避：

```typescript
await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 30000)));
```

- 退避序列：attempt=1 → 1000ms, attempt=2 → 2000ms, attempt=3 → 4000ms, … 上限 30000ms
- 重试门控：仅 `network|timeout|5\d{2}|econnrefused|econnreset|socket` 匹配时重试（L183），非重试错误直接透传
- 3 次耗尽后原样 `throw err`（L181）

### 1.2 `session-loop/index.ts` catch 分支 — ✅ 无残留

- `grep` 搜索 `CircuitBreakerOpenError`、`CIRCUIT_*`、`breaker` 均无匹配
- catch 分支 (L118-132) 仅通过 `RecoveryCoordinator` 处理，无断路器相关逻辑

### 1.3 `error-classifier.ts` — ⚠️ 语义残留

- ✅ `CIRCUIT_OPEN` domain 已移除
- ⚠️ `tripsBreaker: boolean` 字段仍然存在于 `ErrorDomain` 矩阵定义中（L42-55）：
  - `TRANSIENT_NETWORK`: `tripsBreaker: true`
  - `TRANSIENT_SERVER`: `tripsBreaker: true`
- 该字段在 agent-runtime 路径中**不再被消费**，属于无害的语义残留

### 1.4 `fallback-chain/types.ts` — ⚠️ 类型残留

- `FallbackErrorType` 联合类型 (L14) 仍包含 `"circuit-open"`
- `engine.ts` 中的 `domainToFallbackErrorType` 无对应 case 分支，因此 `"circuit-open"` 实际上永远不会被产出
- 建议移除

### 1.5 `fallback-chain/engine.ts` — ✅ 无 `onCircuitOpen` / `circuit-open` 引用

- 无 `onCircuitOpen` 字段
- `grep` 确认在 `engine.ts`、`index.ts` 中均无 `circuit-open` 处理逻辑

### 1.6 `doctor-report.ts` — ✅ `circuitBreakers` 已移除

- `DoctorReport` 接口 (L8-15) 无 `circuitBreakers` 字段
- 报告仅包含 `providers`、`cachePerformance`、`streamRecovery`、`subagents`、`tokenBudget`

### 1.7 `circuit-breaker-e2e.test.ts` — ⚠️ 文件名与测试名不匹配

- 文件名仍为 `circuit-breaker-e2e.test.ts`，但测试描述改为 `"E2E: Exponential backoff on transient errors (R13.3)"`
- 测试逻辑：用错误 API key 重复 5 次调用验证 401 错误（非重试），第 6 次用正确 key 验证成功
- ⚠️ 该测试**并未真正测试指数退避的延迟计算**（退避只对 `network|timeout|5xx` 生效，401 不匹配正则直接抛出）
- 测试覆盖率不足：未覆盖退避延迟计算、退避重置、重试耗尽后错误透传

---

## 2. CircuitBreaker 残留引用清单

| # | 文件 | 残留内容 | 风险 | 说明 |
|---|------|----------|------|------|
| 1 | `packages/shared-utils/src/backpressure.ts` | `CircuitBreaker` 类、`CircuitBreakerOpenError` 类 | 🟢 低 | 作为通用工具类保留，agent-runtime 不再依赖 |
| 2 | `packages/shared-utils/src/browser-index.ts` (L67-68) | `export { TokenBucket, CircuitBreaker }` | 🟢 低 | 公共 API 导出，desktop 仍使用 |
| 3 | `packages/shared-utils/src/index.ts` (L82-83) | `export { CircuitBreaker, CircuitBreakerOpenError }` | 🟢 低 | 同上 |
| 4 | `apps/crish-desktop/src/api/providerBreaker.ts` | 完整 `CircuitBreaker` 前端实例（Map + persist） | 🟡 中 | **前端独立使用**，不依赖 agent-runtime 端。用于前端侧 provider 熔断，与 server-side 解耦 |
| 5 | `apps/crish-desktop/tests/recovery/error-recovery.test.ts` (L10) | `'survives AppErrorBoundary circuit breaker trip'` | 🟢 低 | 测试描述文本 |
| 6 | `packages/agent-runtime/src/error-classifier.ts` (L42-55) | `tripsBreaker` 字段 | 🟢 低 | 语义残留，agent-runtime 内部不再消费 |
| 7 | `packages/agent-runtime/src/fallback-chain/types.ts` (L14) | `\| "circuit-open"` | 🟢 低 | 类型定义残留，永远不会产出该值 |

**结论**：以上残留均为**无害的历史遗留**。关键路径（`session-loop`、`provider-call-gateway`、`fallback-chain/engine.ts`）已完全移除 CircuitBreaker。

---

## 3. 错误透传路径完整追踪

### 3.1 后端路径

```
provider.stream() 抛网络错误
  │
  ▼
retryProviderStream() [provider-call-gateway.ts:169]
  │  最大重试 3 次，指数退避
  │  重试耗尽 → throw err
  │  非重试错误 → throw err
  ▼
catch (err) in call() [provider-call-gateway.ts:133]
  │  → handleStreamError(err, ...)
  │  → setState("error", err.message)
  │  → finishReason = "error", error = err.message
  ▼
return { response, streamEvents } [provider-call-gateway.ts:156]
  │  response = { finishReason: "error", error: msg, ... }
  ▼
providerCall.buildProviderCall() → consume() → ConsumeResult
  │  → ar.type === 'error'
  ▼
handleStreamError(errMsg) [session-loop/index.ts:254]
  │  1. 检查 payload-too-large → 重试（emit diagnostic with retryable: true）
  │  2. 检查 transient → 重试（emit diagnostic without retryable field）
  │  3. 工具已执行 → injectSynthesisNudge
  │  4. 兜底 → emit runtime-error (LINE 287)
  │     → dispatch('PROVIDER_ERROR')
  │     → return { endReason: 'error', endError: errMsg }
  ▼
run() catch (L118):
  │  → emitEvent({ type: 'runtime-error', error: error.message })
  │    ⚠️ 注意：此处 event 不含 retryable 字段
  │  → endReason = 'error', endError = error.message
  ▼
agent-end event:
  │  { type: 'agent-end', reason: 'error', error: endError }
  ▼
WebSocket → 前端
```

### 3.2 前端路径

```
WebSocket onMsg() [EventRouter.ts:495]
  │  → resolveEventType → 'agent-end'
  │  → reason === 'error'
  ▼
surfaceStreamFailure(errPayload, 'agent-end-error', ...) [streamState.ts:28]
  │  → classifySoftFailure(raw) → 'network' | 'no_key' | 'no_project' | 'blocked' | 'ended' | null
  │  → softFailureMessage(kind) → 中文提示
  │  → callbacks.onRunError(msg, kind)
  ▼
useChatStream.onRunError [useChatStream.ts:1044]
  │  → store.setSessionMessageStatus(sid, assistantMsgId, 'error')
  │  → store.updateMessageText(sid, assistantMsgId, message)
  │  → onShowToast(message)
  ▼
UI 展示错误气泡 + toast
```

### 3.3 关键发现：`retryable` 标记丢失

| 问题 | 详情 |
|------|------|
| **runtime-error event 缺少 retryable** | `session-loop/index.ts:287` 的 `emitEvent({ type: 'runtime-error', ...error: errMsg })` 没有 `retryable` 字段 |
| **EventRouter 不处理 runtime-error** | `EventRouter.ts` `handleAgentEvent` 方法中无 `runtime-error` case（L197-493）。该事件**静默丢弃** |
| **EventRouter 不处理 provider-diagnostic** | `provider-diagnostic` 事件（携带 `retryable` 标记）也不被 EventRouter 处理 |
| **前端不使用 retryable** | 前端通过 `classifySoftFailure` 对错误文本做模式匹配来分类（L46-56），不依赖 `retryable` 布尔字段 |

**结论**：后端 index.ts 中 `retryable` 标记（通过 `provider-diagnostic` 事件发出）的传播路径在前端 EventRouter 中断。前端最终展示"重试提示文本"（"请稍后重试"）而非"重试按钮"，且该提示不基于 `retryable` 标记，而是基于错误文本正则匹配。

---

## 4. 极端场景验证

### 场景 1：重试第 3 次时网络恢复，第 4 次时又断 — 退避是否重置？

**结论：退避在 `retryProviderStream` 路径上会重置，`streamWithRecovery` 路径上不会完全重置。**

- **`retryProviderStream` 路径**（`provider-call-gateway.ts:169`-191）：
  - 每次 `call()` 调用都会**创建新的 `retryProviderStream` 执行上下文**
  - 每次调用从 `attempt = 1` 开始，退避重置为 1s → ✅ **正确重置**
  - 但是，`retryProviderStream` 只重试**流创建时的同步异常**（`provider.stream()` 抛出的错误）
  - 流建立后的事件级错误（如中途断流）由 `selectStreamSource` / `streamWithRecovery` 处理

- **`streamWithRecovery` 路径**（`provider-transport/stream-recovery.ts`）：
  - 流开始后的中途断流，由 `StreamRecovery.decideRecovery()` 处理
  - `decideRecovery` 根据累积状态判断：有内容→surface-error（不重试）、无内容→`connectionManager.selectNext()` 换通道重试一次
  - 该路径**只重试一次**（没有指数退避循环）
  - 第 4 次断流时，若第 3 次已恢复过，新的 `StreamRecovery` 实例会被创建（`ProviderCallGateway` constructor 每次创建新实例），退避重置 → ✅

### 场景 2：`retryable: true` 字段通过 WebSocket 序列化是否丢失？

**结论：不存在 Serde rename 问题。**

- 代码库中**没有 Rust Serde**（无 `serde` / `rename_all` 属性），WebSocket 消息使用原生 TypeScript JSON 序列化
- `provider-diagnostic` 事件中的 `retryable` 字段（`tool.ts:100`）使用标准 camelCase
- JSON 序列化后字段名保持 `retryable` → ✅ **不会丢失**
- **但是**：该字段目前**不被前端消费**（EventRouter 不处理 `provider-diagnostic` 事件）

---

## 5. 改进建议

### P0 — 关键问题

1. **修复 `runtime-error` 事件不含 `retryable` 标记**
   - 文件：`session-loop/index.ts:287`
   - 建议：在 emit `runtime-error` 前，调用 `classifyProviderErrorMessage(errMsg)` 分类，将 `retryable` 字段加入 event

2. **EventRouter 应处理 `runtime-error` 事件**
   - 文件：`EventRouter.ts` `handleAgentEvent()` 方法
   - 建议：添加 `runtime-error` case，将 `retryable` 标记传递给前端回调
   - 当前 `runtime-error` 被静默丢弃，导致前端无法区分"可重试错误"与"致命错误"

3. **EventRouter 应处理 `provider-diagnostic` 事件**
   - 建议：将 `retryable` 标记转发给前端诊断系统，用于决定是否展示"重试按钮"

### P1 — 重要改进

4. **重试按钮**：前端 `useChatStream.ts` 的 `onRunError` 回调应引入 `retryable` 参数
   - 当 `retryable === true` 时，在 UI 显示"重试"按钮（而非仅文字提示）
   - 重试按钮应重新调用 `providerGateway.call()` 重新发起最后一次 provider 调用

5. **`streamWithRecovery` 路径应加入指数退避**
   - 文件：`stream-recovery.ts:decideRecovery`
   - 当前情况 C（无内容）仅重试一次
   - 建议：引入 `retryCount` 和指数退避机制，避免短时间快速重试

### P2 — 清理

6. 移除 `fallback-chain/types.ts` 中未使用的 `"circuit-open"` 类型 (L14)
7. 重命名 `circuit-breaker-e2e.test.ts` 为 `exponential-backoff-e2e.test.ts`，并补充退避计算验证
8. 清理 `error-classifier.ts` 中 `tripsBreaker` 字段（当前无消费方）

---

## 附录：关键代码位置

| 组件 | 文件 | 行号 |
|------|------|------|
| 指数退避实现 | `provider-call-gateway.ts` | L169-191 |
| `streamWithRecovery` | `stream-recovery.ts` | L101-225 |
| 错误透传（后端） | `session-loop/index.ts` | L254-295 |
| EventRouter（前端） | `EventRouter.ts` | L196-493 |
| `surfaceStreamFailure` | `streamState.ts` | L28-55 |
| `classifySoftFailure` | `userFacingErrors.ts` | L46-56 |
| `ProviderDiagnostic` 类型 | `shared-types/src/tool.ts` | L80-109 |
