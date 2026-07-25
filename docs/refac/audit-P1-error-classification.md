# 审计报告：第一部分 错误分类基础设施重建（1.1-1.4）

> 审计日期：2026-07-23
> 审计范围：refactor_plan.md 第 7-183 行
> 审计层级：架构级

---

## 1.1 统一错误领域分类模型（ErrorDomain Taxonomy）

### 1.1.1 四处错误判定逻辑验证

原方案声称存在"至少四处"独立判定路径。经 grep 确认，实际存在 **7 处**：

| # | 文件位置 | 判定方式 | 输出类型 |
|---|----------|----------|----------|
| 1 | `apps/crish-desktop/src/services/FailoverReason.ts:17-25` | 字符串正则 | 8 种 `FailoverReason` 字面量 |
| 2 | `packages/agent-runtime/src/runtime-components/provider-call-gateway.ts:131` | 行内 `/network\|timeout\|5\d{2}\|econnrefused\|econnreset\|socket/i` | boolean（shouldRetry） |
| 3 | `packages/agent-runtime/src/recovery/stream-recovery.ts:202-226` | `isNetworkError` + `isStreamInterruption` 正则 | boolean + retry decision |
| 4 | `packages/agent-runtime/src/provider-transport/stream-recovery.ts:352-427` | `instanceof ConnectionError` / `instanceof StreamInterruptedError` | `RecoveryDecision` 枚举 |
| **5** | `packages/agent-runtime/src/provider/engines/base-engine.ts:61-97` | `classifyError()` 方法 | `ErrorClassification`（9 kinds） |
| **6** | `packages/agent-runtime/src/provider-openai-compatible.ts:2305-2377` | `classifyProviderErrorMessage` + `classifyHttpProviderError` + `classifyTransportProviderError` + `classifyStreamProviderError` | `ProviderErrorClassification` |
| **7** | `packages/agent-runtime/src/fallback-chain/engine.ts:4-21` | `classifyFallbackError` | `FallbackErrorType`（9 types） |

此外，`packages/agent-runtime/src/provider-openai-base.ts:470-489` 存在与 `provider-openai-compatible.ts` 几乎完全重复的 `classifyProviderErrorMessage`（带 `payload-too-large`，缺 `gateway-challenge`），进一步加剧分裂。

**结论**：原方案大幅低估了实际情况。合并范围应从 4 处扩展到 7 处。

### 1.1.2 ErrorDomain 枚举覆盖度评估

原方案 8 个分类与现有代码中实际出现的错误类型对比如下：

#### 原方案已覆盖的 Domain

| ErrorDomain | 现有代码证据 | 对应关系 |
|-------------|-------------|----------|
| `TRANSIENT_NETWORK` | `base-engine.ts:92-93`, `classifyProviderErrorMessage`, `classifyFallbackError` | 一致 |
| `TRANSIENT_SERVER` | `base-engine.ts:84-86`, `classifyProviderErrorMessage` | 一致 |
| `RATE_LIMIT` | `base-engine.ts:76-78`, `classifyProviderErrorMessage`, `classifyFallbackError` | 一致 |
| `CLIENT_AUTH` | `base-engine.ts:68-70`, `classifyProviderErrorMessage`, `classifyFallbackError` | 一致 |
| `CLIENT_INVALID_INPUT` | `base-engine.ts:80-81`（仅 context-overflow），`classifyProviderErrorMessage`（schema/422） | 部分一致 |
| `STREAM_INTERRUPT` | modern `stream-recovery.ts:358`（`instanceof StreamInterruptedError`） | 一致 |
| `CIRCUIT_OPEN` | `CircuitBreakerOpenError`（`shared-utils/src/backpressure.ts:1-6`） | 一致 |
| `USER_ABORT` | `base-engine.ts:64-66`, `classifyProviderErrorMessage` 的 `cancelled` | 一致 |

#### 原方案遗漏的 Domain

**① `QUOTA_EXHAUSTED`（配额耗尽）**

- 位置：`base-engine.ts:72-73`、`classifyProviderErrorMessage`（`402`/`insufficient_quota`）、`classifyFallbackError`
- 理由：HTTP 402 和配额类错误具有与 `CLIENT_AUTH` 完全不同的语义（可随时间自动恢复，但不可通过重试解决）。合并到 `RATE_LIMIT` 会误判恢复策略，合并到 `CLIENT_AUTH` 会误导 UI 提示。**建议新增 `QUOTA_EXHAUSTED`**。

**② `GATEWAY_CHALLENGE`（网关质询）**

- 位置：`provider-openai-compatible.ts:2363`、`looksLikeGatewayChallenge`（2456-2463 行）
- 理由：Cloudflare 等网关质询需要用户浏览器交互，既不是网络错误也不是认证错误。当前被映射为 `retryable: false`（正确），但 `ErrorDomain` 中无对应枚举会使 `retryable` 默认矩阵误匹配到 `TRANSIENT_SERVER`（retryable: true）。

**③ `ENDPOINT_UNAVAILABLE`（端点不可用）**

- 位置：`provider-openai-compatible.ts:2373`、`isResponsesEndpointUnavailable`（2383-2388 行）
- 理由：HTTP 404/405/415 表示请求的端点在 provider 上不存在，与 `CLIENT_INVALID_INPUT`（400/422）语义不同，与 `TRANSIENT_SERVER`（5xx）策略不同。应独立分类以便 UI 提示"模型端点不可用，可能需要更新 Provider 配置"。

**④ `PAYLOAD_TOO_LARGE`（请求体过大）—— 保留或细分**

- 位置：`classifyProviderErrorMessage`（行 2313-2319）、`payload-image-recovery.test.ts` 全文
- 当前映射：HTTP 413 / `request_too_large` → `retryable: false`
- 问题：原方案将其归入 `CLIENT_INVALID_INPUT` 的"context_length_exceeded"子类型，但实际上 `PAYLOAD_TOO_LARGE` 有独立的图像 scrub 恢复流程（`agent-session-loop.ts:753-769`）。如果不保留独立分类，Tier 3 的上下文压缩触发器会遗漏 413 的自动恢复。
- **建议**：在 `CLIENT_INVALID_INPUT` 中设 `subType` 字段区分，或设独立枚举。

#### 修正后的 ErrorDomain 枚举（建议 11 个）

```typescript
enum ErrorDomain {
  TRANSIENT_NETWORK,
  TRANSIENT_SERVER,
  RATE_LIMIT,
  QUOTA_EXHAUSTED,       // ← 新增
  CLIENT_AUTH,
  CLIENT_INVALID_INPUT,  // 含 subType: 'schema' | 'context_overflow' | 'payload_too_large' | 'content_policy'
  STREAM_INTERRUPT,
  CIRCUIT_OPEN,
  USER_ABORT,
  GATEWAY_CHALLENGE,     // ← 新增
  ENDPOINT_UNAVAILABLE,  // ← 新增
}
```

---

## 1.2 ClassifiedError 结构体字段评估

### 原方案字段：

```typescript
interface ClassifiedError {
  domain: ErrorDomain;
  retryable: boolean;
  tripsBreaker: boolean;
  uiSeverity: 'silent' | 'info' | 'warning' | 'error' | 'critical';
  recoveryHint: string;
  retryAfterMs?: number;
  originalError: unknown;
}
```

### 评估

**足够字段**：`domain`、`retryable`、`tripsBreaker`、`uiSeverity`、`recoveryHint`、`retryAfterMs`、`originalError`

**`tripsBreaker` 和 `uiSeverity` 是否足够？** → **不够**。缺少以下关键字段：

#### 缺失字段 ①：`subType`（子类型标识符）

- **动机**：`CLIENT_INVALID_INPUT` 需要区分 `schema` / `context_overflow` / `payload_too_large` / `content_policy`，因为 Tier 3 仅对 `context_overflow` 触发上下文压缩，而 `payload_too_large` 触发图像 scrub。
- **provider-openai-compatible.ts** 中 `classifyProviderErrorMessage` 已区分 `schema`、`payload-too-large` 等，但这个信息在映射到新结构时会丢失。

```typescript
subType?: 'schema' | 'context_overflow' | 'payload_too_large' | 'content_policy';
```

#### 缺失字段 ②：`httpStatus`（HTTP 状态码）

- **动机**：`classify` 函数基于状态码判断，保留原始状态码便于 UI 显示和调试。
- **参考**：`classifyFallbackError`（`fallback-chain/engine.ts:4`）要求传入 status。

#### 缺失字段 ③：`providerId`（来源 Provider）

- **动机**：熔断器计数和 DynamicModelRouter 的 failover 决策需要知道哪个 provider 触发了错误。原方案中 `provider-call-gateway.ts:206-210` 的 `breaker.onFailure()` 绑定了 provider id。

#### 缺失字段 ④：`errorKind`（原始分类类型）

- **动机**：现有代码中的 `ProviderErrorKind`（`shared-types/src/tool.ts:61-74`）有 13 种细分类型，映射到 `ErrorDomain` 后部分信息丢失。保留原始 `errorKind` 方便下游做精细化策略判断。

### 修正后的 ClassifiedError（建议）

```typescript
interface ClassifiedError {
  domain: ErrorDomain;
  subType?: 'schema' | 'context_overflow' | 'payload_too_large' | 'content_policy';
  retryable: boolean;
  tripsBreaker: boolean;
  uiSeverity: 'silent' | 'info' | 'warning' | 'error' | 'critical';
  recoveryHint: string;
  retryAfterMs?: number;
  httpStatus?: number;
  providerId?: string;
  originalError: unknown;
  // 可选：保留原始分类供兼容层使用
  legacyKind?: ProviderErrorKind;
}
```

---

## 1.3 classify 函数分类优先级评估

### 原方案优先级顺序

```
1. AbortError / signal.aborted → USER_ABORT
2. HTTP 状态码：
   401/403 → CLIENT_AUTH
   400/422 → CLIENT_INVALID_INPUT (所有)
   429 → RATE_LIMIT
   500/502/503/504 → TRANSIENT_SERVER
3. 错误消息字符串匹配：
   econnreset/econnrefused/socket hang up → TRANSIENT_NETWORK
   stream interrupted/orphan tool call → STREAM_INTERRUPT
4. instanceof → CIRCUIT_OPEN
5. 兜底 → TRANSIENT_SERVER（保守策略，可重试）
```

### 问题 1：400/422 的判定过于粗糙（丢失 payload-too-large 特异性）

`provider-openai-compatible.ts:2364-2367` 的 `classifyHttpProviderError` 中：
```typescript
if (response.status === 413) return { kind: "payload-too-large", retryable: false };
// Body heuristics before schema: 400 + "request_too_large" must not become schema
const fromBody = classifyProviderErrorMessage(error);
if (fromBody.kind === "payload-too-large") return fromBody;
```

HTTP 413 和 HTTP 400+body("request_too_large") 均不应进入 `CLIENT_INVALID_INPUT`。原方案的优先级顺序中，400 和 422 直接映射到 `CLIENT_INVALID_INPUT`，会覆盖 413 的特例。**应改为**：在检查 400/422 之前先检查 413 或 body 中的 `payload-too-large` 模式。

### 问题 2：兜底策略 `TRANSIENT_SERVER` 有风险

**`base-engine.ts:96-97`** 的兜底是 `{ kind: "unknown", retryable: false }`，即`不可重试`。
**`classifyFallbackError`**（`fallback-chain/engine.ts:20`）的兜底是 `{ type: "unknown", retryable: false }`，也是`不可重试`。
**`classifyProviderErrorMessage`**（行 2335）的兜底是 `{ kind: "unknown", retryable: false }`，也是`不可重试`。

原方案将兜底设为 `TRANSIENT_SERVER`（retryable: true）**与现有所有分类器矛盾**。建议改为 `UNKNOWN` 枚举值，retryable: false，让上层策略显式决定。

### 问题 3：缺少 `StreamInterruptedError` 和 `ConnectionError` 的 instanceof 检查

Modern `stream-recovery.ts` 使用 `instanceof` 判断 `StreamInterruptedError` 和 `ConnectionError`（第 358 行、389 行），但原方案的 instanceof 检查只列出了 `CircuitBreakerOpenError`。应补充：

```
6. instanceof StreamInterruptedError → STREAM_INTERRUPT
7. instanceof ConnectionError → TRANSIENT_NETWORK (所有通道已耗尽)
```

### 问题 4：缺少 QUOTA（402）的 HTTP 状态码分支

原方案的第 2 步只列了 401/403、400/422、429、5xx，遗漏了 402。应插入：

```typescript
402 → QUOTA_EXHAUSTED
```

### 修正后的分类优先级顺序

```
1. signal?.aborted / error.name === 'AbortError' → USER_ABORT
2. HTTP 状态码（如果存在）：
   413 → 检查 body: "request_too_large" → CLIENT_INVALID_INPUT (payload_too_large)
         否则继续
   401/403 → CLIENT_AUTH
   402 / quota 模式匹配 → QUOTA_EXHAUSTED
   400/422 → 先检查 body: "request_too_large"/"context_length_exceeded"
             → CLIENT_INVALID_INPUT (对应 subType)
             其他 → CLIENT_INVALID_INPUT (schema)
   429 → RATE_LIMIT（解析 Retry-After）
   404/405/415 → ENDPOINT_UNAVAILABLE
   500/502/503/504/520/522/523/524 → TRANSIENT_SERVER
3. instanceof 检查：
   CircuitBreakerOpenError → CIRCUIT_OPEN
   StreamInterruptedError → STREAM_INTERRUPT
   ConnectionError → TRANSIENT_NETWORK
4. 错误消息字符串匹配（不区分大小写）：
   gateway-challenge/cloudflare/just a moment → GATEWAY_CHALLENGE
   econnreset/econnrefused/socket hang up/fetch failed → TRANSIENT_NETWORK
   stream interrupted/orphan tool call → STREAM_INTERRUPT
   timeout/timed out → TRANSIENT_NETWORK（可重试）
   context_length_exceeded/too long → CLIENT_INVALID_INPUT (context_overflow)
5. 兜底 → UNKNOWN（retryable: false，不触发熔断器）
```

### 关键修复：排除"没有场景会进入错误分支"

原方案的问题是：
- 400/422 **会错误吞噬** body 中的 `payload-too-large` 特征
- `network` 关键字太宽泛，会误匹配到 `TRANSIENT_NETWORK` 而不是 `TRANSIENT_SERVER`
- 例如 `server network timeout` 这类的消息，不同的 `includes/network` 实现会给出不同结果

**具体边界情况**（现有代码中的不一致示例）：

| 错误场景 | base-engine.ts | classifyProviderErrorMessage | classifyFallbackError |
|----------|----------------|---------------------------|----------------------|
| 401 + "network error" body | AUTH | auth | auth-error ✅ |
| timeout + "fetch failed" | timeout | timeout | timeout ✅ |
| "502 bad gateway" + body "rate_limit" | 对照 body 和 status 顺序不确定 | 502 优先 → server | 502 优先 ✅ |
| 429 + body "unauthorized" | RATE_LIMIT | 429 优先 → rate-limit | 429 优先 ✅ |
| 413 + body "request_too_large" | 无 413 分支 → CLIENT_INVALID_INPUT | payload-too-large ✅ | 无 413 分支 → unknown ❌ |

---

## 1.4 4 层分级降级架构评估

### 1.4.1 各层职责确认

| 层级 | 负责组件 | 代码位置 |
|------|----------|----------|
| Tier 1 | ConnectionManager + Modern StreamRecovery | `provider-transport/connection-manager.ts:84-327`, `provider-transport/stream-recovery.ts:115-237` |
| Tier 2 | DynamicModelRouter + FallbackChain | `model-routing-dynamic/index.ts:95-155`, `fallback-chain/engine.ts:43-121` |
| Tier 3 | Context Self-Healing | 不存在（需新建） |
| Tier 4 | ErrorStore + ToastBus | `apps/crish-desktop/src/services/ErrorStore.ts:71-270` |

### 1.4.2 Tier 1（传输层静默重试）评估

**现有能力**：
- `ConnectionManager` 已实现通道切换（`connection-manager.ts:128-314`），每个通道最多尝试一次
- Modern `StreamRecovery` 实现了 Case A/B/C 的判断（`stream-recovery.ts:352-427`）

**差距**：
- `ProviderCallGateway.ts:129-134` 的向后兼容路径使用了 `retryWithBackoff` 和硬编码正则。这个路径在 `ConnectionManager` 存在时不会走，但这是可选功能（`stream:114-121`）。如果创建 ProviderCallGateway 时不传 `ConnectionManager`，Tier 1 根本没有覆盖。
- 没有指数退避的静默重试计数器。现有的 `decideRetry`（legacy `stream-recovery.ts:80-131`）有 `maxRetries` 控制，但 Legacy 版不在 `ProviderCallGateway` 调用链中。Modern 版依赖 `ConnectionManager` 的通道切换，没有单独的"同一通道重试"逻辑。
- **`ProviderErrorKind` 中缺少对 `ConnectionError` 和 `StreamRecoveryError` 的分类**——Tier 1 检测到这些错误后，需要判断是否冒泡到 Tier 2。

**改进方案**：
- 在 `ProviderCallGateway` 中，当 `ConnectionManager` 不存在时，也应使用统一的 `ErrorClassifier` 而非硬编码正则（`provider-call-gateway.ts:131`）。
- `ConnectionManager.stream()` 已实现自动切换所有通道（`connection-manager.ts:291-314`），所以"所有通道耗尽"的检测点已在 `ConnectionManager` 内部。Tier 1 失败标志应转换为 `ConnectionError` 或 `StreamRecoveryError` 传递给上层。

### 1.4.3 Tier 2（Provider 级别故障切换）评估

**现有能力**：
- `fallback-chain/engine.ts:43-121` 的 `callWithFallbackChain` 已实现基于 `FallbackConfig` 的降级
- `DynamicModelRouter` 提供基于健康状态 + EMA 的排序（`model-routing-dynamic/index.ts:129-155`）

**差距**：
- Tier 2 的触发条件定义不清晰。原方案说"当 Tier 1 重试耗尽，或 `CIRCUIT_OPEN` 触发时"，但 `ProviderCallGateway` 中当 `breaker.allowRequest()` 返回 false 时（第 96 行）是直接抛 `CircuitBreakerOpenError`——**这个异常当前没有被任何 catch 块捕获**，直接跳出 `call()` 方法到上层 `agent-session-loop.ts`。这意味着 `CircuitBreakerOpenError` 永远不会进入 Tier 2 的 FallbackChain。
- `DynamicModelRouter` 和 `FallbackChain` 是两套独立的降级机制，互不感知。原方案没有说明如何协调它们。
- Tier 2 切换的 Provider 来自哪里？原方案说"按 `DynamicModelRouter` EMA 成功率排序"，但 `DynamicModelRouter` 的 `route()` 方法返回 `selectedEndpoint` + `alternatives`（第 146-150 行），与 `FallbackConfig.fallbackList` 的关系未定义。

**改进方案**：
- `ProviderCallGateway` 的 `call()` 方法中，`CircuitBreakerOpenError` 不应直接 `throw`，而应由调用方（`agent-session-loop`）捕获后触发 Tier 2。
- 需要定义 `DynamicModelRouter` 与 `FallbackChain` 的集成契约：`DynamicModelRouter` 负责选择主 Provider，`FallbackChain` 在 `ProviderCallGateway` 层级负责在故障时切换到候选 Provider。
- 候选 Provider 来源：`DynamicModelRouter.route().alternatives` → `FallbackConfig.fallbackList`。

### 1.4.4 Tier 3（Context Self-Healing）评估

**前置依赖问题**：
- `sliceContextAtValidBoundary` 在 `docs/refac/refactor_plan.md` 的 1.4 中被引用，但在 2.2 中才定义
- grep 确认：**代码库中不存在 `sliceContextAtValidBoundary`**
- 这是一个纯 forward reference，当前不可实现

**可行性分析**：
- 当前 `agent-session-loop.ts:753-769` 已经有 payload-too-large 的图像 scrub 递归重试逻辑，这是 Tier 3 的雏形范例
- 但没有通用化的上下文压缩入口函数
- `CLIENT_INVALID_INPUT` 的 `context_overflow` subType 需要被 Tier 2 识别并触发 Tier 3

**架构问题：Tier 2 → Tier 3 的冒泡路径不清晰**
- `callWithFallbackChain`（`fallback-chain/engine.ts:43`）在 `selectFallbackList` 找不到更多候选时，会 `throw err`（第 104 行、第 118 行）。这个异常需要被 `agent-session-loop` 的 try/catch 块捕获。
- 如果错误是 `context-overflow`，捕获点应触发 Tier 3（上下文压缩后重试），而非直接跳到 Tier 4（UI 通知）。

**改进方案**：
- 在 `agent-session-loop.ts` 中添加一个显式的恢复管线（Recovery Pipeline）：
  ```
  ProviderCallGateway.call() 失败
    → AgentSessionLoop 捕获异常
    → ErrorClassifier.classify(err)
    → if (domain === CLIENT_INVALID_INPUT && subType === 'context_overflow'):
        → sliceContextAtValidBoundary()  // 2.2 实现后
        → 重新调用 ProviderCallGateway.call()
        → 仍失败 → Tier 4
    → else if (retryable && !tripsBreaker):
        → 指数退重重试（当前 isTransientProviderError 路径）
        → 仍失败 → Tier 4
    → else:
        → Tier 4
  ```

### 1.4.5 层间冒泡协议

原方案未定义"本层已失败，需向上冒泡"的检测机制。这是整个 4 层架构最关键的设计缺口。

#### 各层冒泡条件

| 层级 | 冒泡条件 | 退出信号 | 接收方 |
|------|----------|----------|--------|
| Tier 1 | `ConnectionManager` 所有通道耗尽 → `ConnectionError` | `StreamRecoveryError` / `ConnectionError` | Tier 2 触发点 |
| Tier 2 | `FallbackChain` 所有候选 Provider 都失败 | 最后一个 `throw err` | Tier 3 触发点 |
| Tier 3 | 上下文压缩后重新发起仍失败 | `throw new SelfHealingFailedError()` | Tier 4 |
| Tier 4 | — | 展示 Toast + 写入 ErrorStore | 用户 |

#### 推荐实现：`RecoveryPipeline`（新组件）

```typescript
interface RecoveryPipeline {
  tier1(): Promise<ProviderCallResult>;    // 传输层
  tier2(err: ClassifiedError): Promise<ProviderCallResult>;  // Provider 切换
  tier3(err: ClassifiedError): Promise<ProviderCallResult>;  // 上下文自愈
  tier4(err: ClassifiedError): UiError;                       // UI 通知
}

// 管线编排
async function executeWithFallback(
  pipeline: RecoveryPipeline,
  request: AgentProviderRequest
): Promise<ProviderCallResult | UiError> {
  try {
    return await pipeline.tier1();
  } catch (t1Err) {
    const classified1 = ErrorClassifier.classify(t1Err);
    if (classified1.domain === CIRCUIT_OPEN || classified1.domain === TRANSIENT_SERVER) {
      try {
        return await pipeline.tier2(classified1);
      } catch (t2Err) {
        const classified2 = ErrorClassifier.classify(t2Err);
        if (classified2.domain === CLIENT_INVALID_INPUT && classified2.subType === 'context_overflow') {
          try {
            return await pipeline.tier3(classified2);
          } catch (t3Err) {
            return pipeline.tier4(ErrorClassifier.classify(t3Err));
          }
        }
        return pipeline.tier4(classified2);
      }
    }
    if (classified1.retryable) {
      // 指数退避后重试（当前 isTransientProviderError 逻辑）
      return await retryWithBackoff(() => pipeline.tier1(), { ... });
    }
    return pipeline.tier4(classified1);
  }
}
```

---

## 1.5 ErrorClassifier 与现有 classifyError 的共存策略

`base-engine.ts:61` 的 `classifyError` 是 `AbstractBaseEngine` 的实例方法，所有 Engine 实现继承它。

**原方案**：在 `packages/agent-runtime/src/` 下新建 `error-classifier.ts`。

**分析**：
- `ErrorClassifier.classify()` 是**全局纯函数**，适合作为统一的分类引擎
- `AbstractBaseEngine.classifyError()` 是**引擎实例方法**，引擎子类可能覆写它（目前未发现覆写）
- 如果直接替换 `classifyError` 为 `ErrorClassifier.classify`，所有继承 `AbstractBaseEngine` 的引擎会立即获得新分类逻辑
- 但 `classifyError` 是 `protected` 方法（第 61 行），只在引擎内部使用（`fetchWithRetry` 中未调用它——它是一个"可覆写"辅助方法）

**推荐方案**：**替代而非共存**。
1. 将 `ErrorClassifier.classify()` 作为核心纯函数实现
2. 修改 `AbstractBaseEngine.classifyError()` 为委托：
   ```typescript
   classifyError(error: unknown, status?: number, signal?: AbortSignal): ErrorClassification {
     const classified = ErrorClassifier.classify(error);
     // 兼容旧接口
     return {
       kind: mapDomainToLegacyKind(classified.domain),
       retryable: classified.retryable,
       message: classified.recoveryHint,
     };
   }
   ```
3. 清理所有调用点：
   - `base-engine.ts:61-97` → 委托至 `ErrorClassifier`
   - `failover-chain/engine.ts:4-21` → 移除 `classifyFallbackError`，改用 `ErrorClassifier`
   - `provider-openai-compatible.ts:2305-2377` → 移除四个 `classify*` 函数，改用 `ErrorClassifier`
   - `provider-openai-base.ts:470-489` → 移除重复的 `classifyProviderErrorMessage`
   - `apps/crish-desktop/src/services/FailoverReason.ts:17-25` → 移除 `classifyError`，改用 `ErrorClassifier`

---

## 1.6 总结：必须修复的关键缺陷

| 优先级 | 缺陷 | 影响范围 | 建议修复 |
|--------|------|----------|---------|
| P0 | 兜底默认 `TRANSIENT_SERVER`（retryable:true）与现有 3 套分类器矛盾 | `classify()` 函数的默认分支会误将未知错误标记为可重试，可能引发无限重试 | 改为 `UNKNOWN`（retryable:false） |
| P0 | Tier 2 的 `CircuitBreakerOpenError` 冒泡路径不存在 | `ProviderCallGateway.call()` 直接 throw，不会被 `FallbackChain` 捕获 | 在 `agent-session-loop` 中添加 RecoveryPipeline |
| P0 | `sliceContextAtValidBoundary` 不存在 | Tier 3 依赖的函数尚未实现，且在 Plan 2.2 之前被引用 | 标记为前置依赖；在 2.2 实现前 Tier 3 不可用 |
| P1 | 400/422 分支覆盖 `payload-too-large` 特例 | HTTP 413 和 body "request_too_large" 被误分类，图像 scrub 恢复被打断 | 在 400/422 检查前先检查 413 和 body 特征 |
| P1 | 缺少 `QUOTA_EXHAUSTED`、`GATEWAY_CHALLENGE`、`ENDPOINT_UNAVAILABLE` 三个 Domain | 现有这些类型的错误会被映射到错误的 Domain，UI 提示和熔断器策略错误 | 接受 11 个枚举的建议 |
| P1 | `ClassifiedError` 缺少 `subType` 字段 | Tier 3 无法区分 `context_overflow` 和 `payload_too_large` | 添加 `subType` 字段 |
| P2 | 7 处而非 4 处独立判定路径 | 原方案低估了合并范围 | 将迁移范围扩展到全部 7 处 |
| P2 | 无层间冒泡协议 | 4 层体系缺乏结构化退出条件 | 按 1.4.5 节实现 `RecoveryPipeline` |
| P2 | `DynamicModelRouter` 与 `FallbackChain` 无集成契约 | 两套降级机制互不感知 | 定义候选 Provider 来源为 `route().alternatives` |
