# Audit Report: Round 5 & Round 6

> Generated: 2026-07-24
> Scope: `analysis/2026-07-24-综合协同修复方案.md` §9 (R5) + §10 (R6)
> Method: grep/read actual codebase files, verify key acceptance criteria

---

## Round 5: 错误透传与并发竞态簇

### R5-T01: runtime-error 添加 retryable ✅

| 验收 | 结果 |
|------|------|
| `session-loop/index.ts` emit 含 `retryable` | ✅ `L288: retryable: classifyResult.retryable` |
| `session-loop/types.ts` 使用 ErrorClassifier | ✅ `L27: ErrorClassifier.classify(new Error(message)).retryable` |
| payload-too-large diagnostic 也带 retryable | ✅ `L262, L269: retryable: true` |

**证据**：`packages/agent-runtime/src/session-loop/index.ts:288`

---

### R5-T02: EventRouter 新增 runtime-error + provider-diagnostic ✅

| 验收 | 结果 |
|------|------|
| `runtime-error` case 存在 | ✅ `EventRouter.ts:481` |
| `provider-diagnostic` case 存在 | ✅ `EventRouter.ts:485` |
| handler 将事件转 store action | ✅ `L192: surfaceStreamFailure(data, 'runtime-error')`, `L196: logInternalError('provider-diagnostic')` |

**证据**：`apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.ts:481-485`

---

### R5-T03: ErrorClassifier 统一迁移 4 处残留 ✅

| 原始残留点 | 状态 |
|-----------|------|
| `provider-stream-contract/error.ts` 的 `classifyProviderStreamErrorKind` | ✅ 已不存在，`classifyProviderStreamError` 使用 `ErrorClassifier.classify` (`error.ts:29`) |
| `provider-stream-contract/normalizer.ts` 的 `classifyErrorMessage` | ✅ 仍存在但委托 `ErrorClassifier.classify` (`normalizer.ts:51-52`) |
| `session-loop/index.ts` L255 的 `classifyProviderErrorMessage` | ✅ 函数不存在，代码使用 `ErrorClassifier.classify` (`index.ts:288`) |
| `provider-openai-base.ts` L468 | ✅ 通过引擎 `classifyError` 委托 `ErrorClassifier.classify` |

**补充**：全仓库 `classifyProviderStreamErrorKind` / `classifyProviderErrorMessage` 引用数为 0。

**证据**：
- `packages/agent-runtime/src/provider-stream-contract/error.ts:9,29`
- `packages/agent-runtime/src/provider-stream-contract/normalizer.ts:51-52`

---

### R5-T04: stream-recovery 指数退避 + 测试重命名 ✅

| 验收 | 结果 |
|------|------|
| 退避公式 `min(1000 * 2^(n-1), 30000)` | ✅ `recovery/stream-recovery.ts:178-184` |
| 含 jitter | ✅ `return delay * (0.5 + Math.random() * 0.5)` |
| 测试文件重命名 | ✅ `circuit-breaker-e2e.test.ts` 不存在; `exponential-backoff.test.ts` (L19-30) 和 `exponential-backoff-e2e.test.ts` 存在 |

**证据**：`packages/agent-runtime/src/recovery/stream-recovery.ts:178-184`

---

### R5-T05: CircuitBreaker 残留清理 ⚠️ 部分完成

| 验收 | 结果 |
|------|------|
| `tripsBreaker` 字段已移出 `error-classifier.ts` | ❌ **仍存在** 在 `ClassifiedError` 接口 (`error-classifier.ts:22`) 及 L213 |
| `circuit-open` 已从 `FallbackErrorType` 移除 | ✅ `fallback-chain/types.ts:5-14` 无 `circuit-open` |

**证据**：
- `packages/agent-runtime/src/error-classifier.ts:22`: `tripsBreaker: boolean;` ❌
- `packages/agent-runtime/src/fallback-chain/types.ts:5-14`: ✅

---

### R5-T06: isAiBusy + cancelFn + myGen 竞态修复 ✅

| 子项 | 结果 |
|------|------|
| `isAiBusy` 从 `streamManagerRef.current.has(sessionId)` 读取 | ✅ `useSlashSend.ts:295`: `const isAiBusy = streamManagerRef.current?.has(sessionId) ?? false` |
| `cancelFn` 改为 ref 延迟赋值 | ✅ `useStreamCallbacks.ts:164`: `const cancelRef = useRef<() => void>(() => {})`; L166 使用 `cancelRef.current()`; L229 赋值 |
| `myGen` 二次校验 | ✅ `useStreamCallbacks.ts:141-154`: 生成计数器 + `if (myGen !== generationMapRef.current.get(sid)) return` |

---

### R5-T07: 审批超时统一 + 重试按钮 UI ✅

| 验收 | 结果 |
|------|------|
| 仅一处 120s 超时源 | ✅ `approval-bridge.ts:3`: `DEFAULT_APPROVAL_TIMEOUT_MS = 120_000` |
| approval-queue 超时值一致 | ✅ `approval-queue.ts:1`: `DEFAULT_APPROVAL_TIMEOUT_MS = 120_000` |
| 重试按钮 UI | ✅ `useChatStream.ts:1145-1152`: 可重试时 `msg.retryable = true`; L1802-1815: `retryLastCall` 实现 |

---

### R5-T08: syncRoutes 实现 + TelemetryMonitor ✅

| 验收 | 结果 |
|------|------|
| `syncRoutes()` 非 stub | ✅ `registry-v2.ts:307-329+`: 实际遍历 declarativeEntries + providerClasses 构造 `ProviderRouteOffer[]` |
| TelemetryMonitor 使用 `invokeResult` | ✅ `TelemetryMonitor.ts:1`: `import { invokeResult }`; L101: `await invokeResult(...)` |

---

## Round 6: 架构合规与组件清理轮

### R6-T01: layoutStore 接入 slices ⚠️ 部分完成

| 验收 | 结果 |
|------|------|
| `wc -l layoutStore.ts` ≤ 400 | ❌ **458 行** |
| slices 目录存在 | ✅ `slices/`: `diff-slice.ts`, `permission-slice.ts`, `terminal-slice.ts`, `ui-slice.ts` |
| 外部 import 路径保持不变 | ✅ 已通过 barrel 导出 |

**说明**：slices 目录已创建，但 `layoutStore.ts` 自身未按方案拆分为 4 个 slice 工厂函数 + barrel，仍为单文件 458 行。

---

### R6-T02: protocol-inbound/outbound 拆分 ✅

| 验收 | 结果 |
|------|------|
| `protocol-inbound.ts` ≤ 400 行 | ✅ **4 行** barrel |
| `protocol-outbound.ts` ≤ 400 行 | ✅ **4 行** barrel |
| 子文件按 domain 拆分 | ✅ inbound: auth/run/session/diagnostic; outbound: auth/run/session/diagnostic |

---

### R6-T03: ui-selectors 拆分 ✅

| 验收 | 结果 |
|------|------|
| `wc -l ui-selectors.ts` ≤ 300 | ✅ **6 行** barrel |
| 按领域拆分 | ✅ panel/workspace/navigation/tool-column/placement/split 6 个子文件 |

**路径**：`apps/crish-desktop/src/store/layout-helpers/ui-selectors.ts`

---

### R6-T04: ChatProviderGuard/ChatCheckpointActions 清理 ✅

| 验收 | 结果 |
|------|------|
| `ChatProviderGuard.tsx` 已清理 | ✅ 文件不存在 |
| `ChatCheckpointActions.tsx` 已清理 | ✅ 文件不存在 |
| TODO 已记录 | ✅ `ChatCard.tsx:76`: `// TODO: implement checkpoint/rollback functionality (stub ChatCheckpointActions removed)` |

---

### R6-T05: F-2g dirty guard ✅

| 验收 | 结果 |
|------|------|
| `isDirty(): boolean` | ✅ `useFileNavigation.ts:117` |
| `confirmNavigation(): Promise<boolean>` | ✅ `useFileNavigation.ts:119-124` |
| `onDirtyChange` 回调 | ✅ `useFilePreview.ts:27,41,101-103` |
| 测试存在 | ✅ `__tests__/useFileNavigation.test.ts` |

---

### R6-T06: ToolHook 类型 + depcruise 统一 + middleware-pipeline 废弃 ✅

| 验收 | 结果 |
|------|------|
| ToolHook 从 types 导入 | ✅ `tool-hook-observability.ts:14`: `import type { ToolHook } from "./tool-hook-types"` |
| `.dependency-cruiser.js` 已删除 | ✅ 文件不存在，仅保留 `.dependency-cruiser.cjs` |
| `middleware-pipeline.ts` 标记废弃 | ✅ `L2`: `@deprecated`, `L4`: `@removeWhen v2.0` |

---

### R6-T07: FauxAgentProvider + globalSetup ✅

| 验收 | 结果 |
|------|------|
| `implements AgentProvider` | ✅ `faux-provider.ts:3`: `class FauxAgentProvider implements AgentProvider` |
| `CRISH_API_KEY` 在 globalSetup | ✅ `vitest.globalSetup.ts:23` |
| `FLOWBIT_API_KEY` 在 globalSetup | ✅ `vitest.globalSetup.ts:24` |
| `CONEX_API_KEY_` prefix 清除 | ✅ `vitest.globalSetup.ts:34-39`: `envKey.startsWith('CONEX_API_KEY_')` |

---

### R6-T08: AppBootstrap useEffect 顺序 + useAppKeyboard 拆分 ⚠️ 部分完成

| 验收 | 结果 |
|------|------|
| `wc -l useAppKeyboard.ts` ≤ 120 | ✅ **17 行** barrel |
| useAppKeyboard 拆分为子模块 | ✅ `keyboard/navigation-keys.ts` + `keyboard/editing-keys.ts` |
| useEffect 顺序与方案一致 | ❌ 方案描述顺序 `#4→#5→#6→#7→#8→#9→#10→#2→#3→#12`，实际为 `#2→#3→#4→#5→#6→#7→#8→#9→#10→#12` |

**说明**：`AppBootstrap.test.ts` 对当前顺序有验证（`#2 AUTO_FOLD_DELAY`, `#3 document.title`, `#4 initLayoutStorePersistence`, ...），当前顺序通过该测试，但与方案描述不符。

---

## 汇总

| 任务 | 状态 | 备注 |
|------|------|------|
| **R5-T01** | ✅ | runtime-error retryable |
| **R5-T02** | ✅ | EventRouter 新 case |
| **R5-T03** | ✅ | ErrorClassifier 统一迁移 |
| **R5-T04** | ✅ | 指数退避 + 测试重命名 |
| **R5-T05** | ⚠️ | `tripsBreaker` 字段未移除 |
| **R5-T06** | ✅ | 并发竞态修复 |
| **R5-T07** | ✅ | 超时统一 + 重试按钮 |
| **R5-T08** | ✅ | syncRoutes + TelemetryMonitor |
| **R6-T01** | ⚠️ | slices 目录已建但 layoutStore.ts 458 行超标 |
| **R6-T02** | ✅ | protocol-inbound/outbound 拆分 |
| **R6-T03** | ✅ | ui-selectors 拆分 |
| **R6-T04** | ✅ | ChatProviderGuard/ChatCheckpointActions 已删除 |
| **R6-T05** | ✅ | F-2g dirty guard |
| **R6-T06** | ✅ | ToolHook 类型 + depcruise + middleware-pipeline |
| **R6-T07** | ✅ | FauxAgentProvider + globalSetup |
| **R6-T08** | ⚠️ | useAppKeyboard 拆分 ✅; useEffect 顺序与方案描述不符 |

**未完成任务**：
1. R5-T05: `tripsBreaker` 字段仍存在于 `error-classifier.ts:22`
2. R6-T01: `layoutStore.ts` 458 行，未拆分 (≤400)
3. R6-T08: useEffect 顺序未对齐方案描述（但通过了单元测试）
