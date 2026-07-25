# Plan 02: agent-daemon + agent-orchestrator TypeScript Compilation Repair

> Generated: 2026-07-25
> Source errors: `raw_errors_daemon.txt` (603 lines), `raw_errors_orchestrator.txt` (85 lines)

---

## 1. 错误全景

### 1.1 全局统计

| 包 | 错误文件数 | 错误总条数 | 唯一错误码数 |
|---|---|---|---|
| `agent-daemon` | 58 个文件 | ~590 条 | 18 种 |
| `agent-orchestrator` | 10 个文件 | ~85 条 | 13 种 |

### 1.2 错误码分类

#### A. `exactOptionalPropertyType` 类（占 ~60%）

当 `tsconfig.json` 开启 `exactOptionalPropertyTypes: true` 且接口用 `field?: Type` 定义可选属性时，赋值 `undefined` 或表达式含 `| undefined` 会触发的错误：

| 错误码 | 含义 | 触发场景 |
|---|---|---|
| **TS2375** | 对象字面量不能赋值给 `Partial<T>` | `{ ... field: T \| undefined }` 赋给 `{ field?: T }` |
| **TS2379** | 实参不能赋值给带 `?:` 的形参 | 传 `{ field: T \| undefined }` 给接受 `{ field?: T }` 的函数 |
| **TS2412** | 不能将 `undefined` 赋给非可选属性 | 变量声明为 `T` 但赋 `undefined`，应为 `T \| undefined` |

**根因**：在 `exactOptionalPropertyTypes: true` 下，`field?: T` 的合法值只有 `T`（不含 `undefined`）。赋值 `undefined` 或 `T | undefined` 都非法。

**解决策略（2选1）**：

- **策略 A**（推荐）：接口定义从 `field?: Type` 改为 `field: Type | undefined`。代价是所有使用时必须显式处理 undefined。
- **策略 B**（保守）：调用/赋值处将 `field: someVar | undefined` 拆为 `...(someVar !== undefined ? { field: someVar } : {})`。

本计划统一采用**策略 A**：修改接口定义中的 `?:` 为显式 `| undefined`。

#### B. 未使用声明（占 ~15%）

| 错误码 | 含义 | 修复 |
|---|---|---|
| **TS6133** | 声明但从未读取 | 删除或用 `void` 标记 |
| **TS6192** | import 全部未使用 | 删除 import |
| **TS6196** | type 声明但从未使用 | 删除声明 |
| **TS6138** | 参数未使用 | 前加 `_` 或删除 |

#### C. 类型不兼容（TS2322 / TS2345 / TS2420 ~10%）

| 错误码 | 含义 |
|---|---|
| **TS2322** | 类型 A 不能赋值给类型 B（Zod 泛型推导、ProtocolValidationResult 型变） |
| **TS2345** | 实参不兼容（多出现在 `ContentAddressedBlobStoreOptions` 等重载） |
| **TS2420** | class 没有正确实现 interface（方法签名不匹配） |

#### D. 缺失导出（TS2305 / TS2459 / TS2724 ~5%）

| 错误码 | 含义 |
|---|---|
| **TS2305** | 模块没有导出某个成员 |
| **TS2459** | 模块声明了某类型但未 `export` |
| **TS2724** | 模块没有导出成员名（拼写错或确实没导出） |

#### E. 其他类（~10%）

| 错误码 | 含义 |
|---|---|
| TS2352 | 不安全的类型转换（缺少 `unknown` 中间转换） |
| TS2554 | 调用参数数量不匹配 |
| TS2339 | 属性在类型上不存在（union 类型或过期的 API） |
| TS2353 | 对象字面量包含未知属性 |
| TS2532 | `?.` 后未判空 |
| TS1205 | `isolatedModules` 下 re-export type 必须用 `export type` |

---

## 2. 写集隔离矩阵

### 2.1 Wave 划分

两个包的写集完全隔离——没有交叉文件。所有 Wave 的 `files_write` 互不相交。

#### Wave 1（agent-daemon `exactOptionalPropertyTypes` 批量修复）

此 Wave 只改接口、类型定义，不涉及业务逻辑。风险最低，影响最广。

| Wave | 文件 | 错误码 |
|---|---|---|
| W1-D | `packages/agent-daemon/src/types/config.ts` | TS2375 (L56) |
| W1-D | `packages/agent-daemon/src/types/entities.ts` | TS6196 (L4-L26) |
| W1-D | `packages/agent-daemon/src/types/provider-types.ts` | TS6133 (L2) |
| W1-D | `packages/agent-daemon/src/daemon-provider-gateway/types.ts` | TS6196 (L13,L14) |
| W1-D | `packages/agent-daemon/src/server-runtime-factory/types.ts` | TS6196 (L3) + TS6192 (L16) |
| W1-D | `packages/agent-daemon/src/task-snapshot/index.ts` | TS2375 (L74) |
| W1-D | `packages/agent-daemon/src/task-snapshot/event-handlers.ts` | TS2412 (L206,L368) + TS2375 (L407,L463) |
| W1-D | `packages/agent-daemon/src/scoped-context-runtime.ts` | TS2375 (L245,L249,L253) |
| W1-D | `packages/agent-daemon/src/scoped-context-store.ts` | TS2375 (L63) |
| W1-D | `packages/agent-daemon/src/approval-queue.ts` | TS2375 (L128,L316) + TS2412 (L263) + TS2379 (L333) |
| W1-D | `packages/agent-daemon/src/background-task-manager.ts` | TS2375 (L208) |
| W1-D | `packages/agent-daemon/src/daemon-lifecycle.ts` | TS2375 (L165) |
| W1-D | `packages/agent-daemon/src/daemon-logger.ts` | TS2375 (L9) + TS2412 (L42) |
| W1-D | `packages/agent-daemon/src/daemon-client-registry.ts` | TS2412 (L53,L57) + TS2379 (L137,L216,L236) |
| W1-D | `packages/agent-daemon/src/daemon-approval-handler.ts` | TS2379 (L50,L114) |
| W1-D | `packages/agent-daemon/src/server/index.ts` | TS2379 (L125,L142,L148,L204,L295,L429,L460) + TS2412 (L168,L169) + TS2339 (L72-L82,L147,L381) + TS2305 (L6) |
| W1-D | `packages/agent-daemon/src/server/connection-manager.ts` | TS2379 (L38,L71,L134,L315,L360) + TS6196 (L4×3) |
| W1-D | `packages/agent-daemon/src/server/workflow-manager.ts` | TS2412 (L23,L51,L62) |
| W1-D | `packages/agent-daemon/src/server/approval-bridge.ts` | TS2379 (L63) |

#### Wave 2（agent-daemon provider-gateway 专项）

| Wave | 文件 | 错误码 |
|---|---|---|
| W2-D | `packages/agent-daemon/src/daemon-provider-gateway/credential-modes.ts` | TS6133 (L14) + TS2459 (L21,L22) + TS2375 (L63,L141) + TS2379 (L374) |
| W2-D | `packages/agent-daemon/src/daemon-provider-gateway/index.ts` | TS6133 (L5,L10,L11,L15) + TS2724 (L18) + TS2459 (L43) + TS2412 (L100,L104,L105,L251,L262) + TS2379 (L152) + TS2375 (L227) + TS2322 (L299) |
| W2-D | `packages/agent-daemon/src/daemon-provider-gateway/health.ts` | TS6196 (L6) |
| W2-D | `packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts` | TS6196 (L19) + TS6133 (L40) + TS2379 (L47,L61) + TS2375 (L81) + TS1361 (L105) |

#### Wave 3（agent-daemon handlers + protocol + server-runtime-factory）

| Wave | 文件 | 错误码 |
|---|---|---|
| W3-D | `packages/agent-daemon/src/handlers/background-task-handlers.ts` | TS2379 (L48,L77,L134) |
| W3-D | `packages/agent-daemon/src/handlers/pending-input-handlers.ts` | TS2379 (L34,L67,L96) |
| W3-D | `packages/agent-daemon/src/handlers/run-handlers.ts` | TS2379 (L207,L432,L724,L849,L859) |
| W3-D | `packages/agent-daemon/src/handlers/session-handlers.ts` | TS2375 (L368) |
| W3-D | `packages/agent-daemon/src/server-handlers.ts` | TS6133 (L2) + TS2353 (L287) + TS7006 (L288) + TS2352 (L823) |
| W3-D | `packages/agent-daemon/src/session-query-handlers.ts` | TS2322 (L106,L158) + TS2379 (L172,L202) |
| W3-D | `packages/agent-daemon/src/server-runtime-factory/index.ts` | TS6196 (L11,L16×2) + TS2412 (L34,L57,L184) + TS2339 (L78-L84×7) + TS2352 (L101,L111) + TS2322 (L121) + TS2379 (L137,L149,L170,L174,L227) + TS2375 (L165) |
| W3-D | `packages/agent-daemon/src/server-runtime-factory/mcp-factory.ts` | TS2322 (L159,L312) + TS1205 (L317) |
| W3-D | `packages/agent-daemon/src/server-runtime-factory/tool-assembly.ts` | TS6196 (L1) + TS6192 (L21,L27) + TS6133 (L26) + TS2412 (L89) |

#### Wave 4（agent-daemon 杂项 + test 文件）

| Wave | 文件 | 错误码 |
|---|---|---|
| W4-D | `packages/agent-daemon/src/index.ts` | TS2375 (L188) |
| W4-D | `packages/agent-daemon/src/mcp-config.ts` | TS2379 (L192) |
| W4-D | `packages/agent-daemon/src/mcp-stdio-adapter.ts` | TS2375 (L181) |
| W4-D | `packages/agent-daemon/src/conversation-rewind-boundary.ts` | TS2379 (L97,L120) + TS2375 (L213) |
| W4-D | `packages/agent-daemon/src/daemon-product-adapters.ts` | TS2345 (L96) |
| W4-D | `packages/agent-daemon/src/subagent-runtime.ts` | TS6133 (L2) + TS6196 (L3) + TS2352 (L327) |
| W4-D | `packages/agent-daemon/src/subagent-lifecycle.ts` | TS6133 (L72) |
| W4-D | `packages/agent-daemon/src/capabilities.ts` | TS6133 (L2) |
| W4-D | `packages/agent-daemon/src/workflow-store/index.ts` | TS6133 (L14) + TS6138 (L28) |
| W4-D | `packages/agent-daemon/src/workflow-store/storage-engine.ts` | TS6133 (L4) |

#### Wave 5（agent-daemon protocol validators — Zod 型变专项）

| Wave | 文件 | 错误码 |
|---|---|---|
| W5-D | `packages/agent-daemon/src/protocol/protocol.ts` | TS2322 (L421) |
| W5-D | `packages/agent-daemon/src/protocol/validators/common.ts` | TS2322 (L8,L18) + TS2739 (L13) |
| W5-D | `packages/agent-daemon/src/protocol/validators/background.ts` | TS2322 (L510,L901,L923,L948,L994) |
| W5-D | `packages/agent-daemon/src/protocol/validators/plan.ts` | TS2322 (L81) |
| W5-D | `packages/agent-daemon/src/protocol/validators/provider.ts` | TS2322 (L220,L242) |
| W5-D | `packages/agent-daemon/src/protocol/validators/rewind.ts` | TS2322 (L90,L301) |
| W5-D | `packages/agent-daemon/src/protocol/validators/run.ts` | TS2322 (L247) |
| W5-D | `packages/agent-daemon/src/protocol/validators/session-events.ts` | TS2322 (L369,L430) |
| W5-D | `packages/agent-daemon/src/protocol/validators/session.ts` | TS2322 (L95) |

#### Wave 6（agent-daemon test 文件 — 最低优先级）

| Wave | 文件 | 错误码 |
|---|---|---|
| W6-D | `packages/agent-daemon/src/daemon-approval-handler.test.ts` | TS6133 (L2) |
| W6-D | `packages/agent-daemon/src/mcp-stdio-adapter.test.ts` | TS6133 (L2) + TS2305 (L2) |
| W6-D | `packages/agent-daemon/src/server-handlers.test.ts` | TS2305 (L3) + TS2352 (L21,L154) |
| W6-D | `packages/agent-daemon/src/server-runtime-factory.test.ts` | TS2532 (L564) + TS2739 (L797) + TS2375 (L855) |
| W6-D | `packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts` | TS2352 (L101) |
| W6-D | `packages/agent-daemon/src/protocol/registry.test.ts` | TS2322 (L275) |
| W6-D | `packages/agent-daemon/src/protocol/validators/common.test.ts` | TS6192 (L2) |

#### Wave 7（agent-orchestrator 全部）

| Wave | 文件 | 错误码 |
|---|---|---|
| W7-O | `packages/agent-orchestrator/src/artifact-store.ts` | TS2375 (L107) |
| W7-O | `packages/agent-orchestrator/src/conversation-rewind.ts` | TS2379 (L165) + TS2375 (L257) |
| W7-O | `packages/agent-orchestrator/src/event-scan-goal-strategy.ts` | TS2420 (L23) |
| W7-O | `packages/agent-orchestrator/src/event-store-projection.ts` | TS2379 (L108,L125) |
| W7-O | `packages/agent-orchestrator/src/event-store.ts` | TS2412 (L143,L789,L807,L1102) + TS2379 (L149,L160,L183,L814) + TS2375 (L413) |
| W7-O | `packages/agent-orchestrator/src/orchestrator.ts` | TS2375 (L78,L290) + TS2355 (L110) + TS2379 (L300,L425,L438,L495,L680,L703,L716,L751,L1017,L1175) + TS2304 (L390,L396,L401) + TS2412 (L649) + TS2339 (L1673-L1696) |
| W7-O | `packages/agent-orchestrator/src/task-assessment.ts` | TS2375 (L573) |

#### Wave 8（agent-orchestrator test 文件）

| Wave | 文件 | 错误码 |
|---|---|---|
| W8-O | `packages/agent-orchestrator/src/__tests__/types.test.ts` | TS6133 (L2) |
| W8-O | `packages/agent-orchestrator/src/event-store.test.ts` | TS2375 (L672) |
| W8-O | `packages/agent-orchestrator/src/orchestrator.test.ts` | TS2305 (L15) + TS2339 (L930,L931,L970,L971,L1011,L1051,L1054,L1070) + TS2353 (L1558) + TS2412 (L1857) |

### 2.2 隔离性验证

```
Wave 1 files  ∩ Wave 2 files  = ∅
Wave 1 files  ∩ Wave 3 files  = ∅
...
Wave 7 files  ∩ Wave 8 files  = ∅
agent-daemon ∩ agent-orchestrator = ∅    （两包无共享文件）
```

所有 Wave 的 `files_write` 互不相交，可以并行执行。

---

## 3. 任务卡表

### 3.1 agent-daemon 任务卡

---

#### T-DO-001: approval-queue.ts
- **文件**: `packages/agent-daemon/src/approval-queue.ts`
- **行号**: 128, 263, 316, 333
- **原错误码**: TS2375 (L128, L316), TS2412 (L263), TS2379 (L333)
- **根因**:
  - L128: `PendingApproval` 接口字段 `?:` 但赋值含 `| undefined`
  - L263: `Timeout` 字段赋值 `undefined` 但类型是 `Timeout`（非可选）
  - L316: `ApprovalQueueSnapshot` 可选字段赋值含 `| undefined`
  - L333: 函数参数 `ApprovalQueueSnapshot` 含 `?:`，传参含 `| undefined`
- **修复**:
  1. `PendingApproval` 接口：`promise?: Promise<...>` → `promise: Promise<...> | undefined`，`resolve?: ...` → `resolve: ... | undefined`，`timeoutMs?: number | null` → `timeoutMs: number | null | undefined`
  2. `ApprovalQueueSnapshot` 接口：所有 `?:` 改为 `type | undefined`
  3. 变量声明 `private timeout?: Timeout` → `private timeout: Timeout | undefined`
- **验收**: `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json 2>&1 | Select-String "approval-queue" | Measure-Object -Line` = 0

---

#### T-DO-002: background-task-manager.ts
- **文件**: `packages/agent-daemon/src/background-task-manager.ts`
- **行号**: 208
- **原错误码**: TS2375
- **根因**: 对象字面量含 `finishedAt: string | undefined`, `startedAt: string | undefined` 等赋值给 `DaemonBackgroundTaskSnapshot`，该接口中这些字段用 `?:` 定义
- **修复**: `DaemonBackgroundTaskSnapshot` 接口中 `finishedAt?: string` → `finishedAt: string | undefined`，同理 `startedAt?`, `outputPreview?`, `exitCode?`, `error?`, `cancelledBy?`, `completedAt?`
- **验收**: `Select-String "background-task-manager"` 0 条

---

#### T-DO-003: capabilities.ts
- **文件**: `packages/agent-daemon/src/capabilities.ts`
- **行号**: 2
- **原错误码**: TS6133
- **根因**: 导入 `JsonObject` 但未被使用
- **修复**: 删除 `JsonObject` import
- **验收**: 0 条

---

#### T-DO-004: conversation-rewind-boundary.ts
- **文件**: `packages/agent-daemon/src/conversation-rewind-boundary.ts`
- **行号**: 97, 120, 213
- **原错误码**: TS2379 (L97, L120), TS2375 (L213)
- **根因**:
  - L97: 传 `{ sessionId, userMessageId: string | undefined }` 给接受 `userMessageId?: string` 的形参
  - L120: 传 `{ ..., checkpoint: ... | undefined, ... }` 给接受 `checkpoint?: ...` 的形参
  - L213: `DaemonConversationRewindBoundaryResult` 接口字段 `?:` 但赋值含 `| undefined`
- **修复**: 对应接口中 `?:` 改为 `| undefined`；传参处如果是函数签名，改形参的 `?:` 为 `| undefined`
- **验收**: 0 条

---

#### T-DO-005: daemon-approval-handler.ts
- **文件**: `packages/agent-daemon/src/daemon-approval-handler.ts`
- **行号**: 50, 114
- **原错误码**: TS2379
- **根因**:
  - L50: 传 `{ ..., command: string | undefined }` 给接受 `command?: string` 的形参
  - L114: 传 `{ ..., scope: ApprovalScope | undefined }` 给接受 `scope?: ApprovalScope` 的形参
- **修复**: 被调函数的签名中 `?:` 改为 `| undefined`
- **验收**: 0 条

---

#### T-DO-006: daemon-client-registry.ts
- **文件**: `packages/agent-daemon/src/daemon-client-registry.ts`
- **行号**: 53, 57, 137, 216, 236
- **原错误码**: TS2412 (L53, L57), TS2379 (L137, L216, L236)
- **根因**:
  - L53/L57: `(diagnostic: ...) => void | undefined` 赋值给类型为 `(diagnostic: ...) => void` 的字段（非可选）
  - L137: 传 `{ ..., runId: string | undefined }` 给参数 `DaemonOutboundMessage` 含 `?:`
  - L216/L236: 传 `detail: string | undefined` 给 `DaemonClientTransportDiagnostic` 的 `detail?: string`
- **修复**: 声明变量处加 `| undefined`；接口定义 `detail?: string` → `detail: string | undefined`
- **验收**: 0 条

---

#### T-DO-007: daemon-lifecycle.ts
- **文件**: `packages/agent-daemon/src/daemon-lifecycle.ts`
- **行号**: 165
- **原错误码**: TS2375
- **根因**: `{ status: "failed", path, failure: DaemonLifecycleDiagnostic | undefined }` 不能赋给 `DaemonEventStoreStatusSnapshot`（`failure?: ...`）
- **修复**: 接口 `failure?: DaemonLifecycleDiagnostic` → `failure: DaemonLifecycleDiagnostic | undefined`
- **验收**: 0 条

---

#### T-DO-008: daemon-logger.ts
- **文件**: `packages/agent-daemon/src/daemon-logger.ts`
- **行号**: 9, 42
- **原错误码**: TS2375 (L9), TS2412 (L42)
- **根因**:
  - L9: 字面量 `{ stack: string | undefined, code: string | undefined }` 不能赋给 `{ stack?: string, code?: string }`
  - L42: `undefined` 赋给 `WriteStream` 类型字段（非可选）
- **修复**: 接口改用 `stack: string | undefined`；字段类型 `private stream: WriteStream | undefined`
- **验收**: 0 条

---

#### T-DO-009: daemon-product-adapters.ts
- **文件**: `packages/agent-daemon/src/daemon-product-adapters.ts`
- **行号**: 96
- **原错误码**: TS2345
- **根因**: 传 `{ rootDir, uriPrefix: string | undefined }` 给重载函数 `ContentAddressedBlobStore`，第二个参数类型不匹配 `string | ContentAddressedBlobStoreOptions`
- **修复**: 条件传参：`uriPrefix ? new ContentAddressedBlobStore(rootDir, uriPrefix) : new ContentAddressedBlobStore(rootDir)`
- **验收**: 0 条

---

#### T-DO-010: daemon-provider-gateway/credential-modes.ts
- **文件**: `packages/agent-daemon/src/daemon-provider-gateway/credential-modes.ts`
- **行号**: 14, 21, 22, 63, 141, 374
- **原错误码**: TS6133 (L14), TS2459 (L21,L22), TS2375 (L63,L141), TS2379 (L374)
- **根因**:
  - L14: `DAEMON_PROVIDER_CONFIG_PRECEDENCE` 未使用 → 删除
  - L21-22: 模块 `./types.js` 的 `DaemonProviderApiKeySource` 和 `DaemonProviderCredentialMode` 未导出 → 在 types.ts 加 `export`
  - L63: `NormalizedDaemonProviderRuntimeConfig` 接口 `?:` 字段赋值含 `| undefined`
  - L141: `Partial<DaemonProviderRuntimeConfig>` 用 `field: undefined` 赋值
  - L374: 传参给 `DaemonProviderRuntimeConfig` 含 `| undefined`
- **修复**:
  1. types.ts 中 `DaemonProviderApiKeySource` 和 `DaemonProviderCredentialMode` 加 `export`
  2. `NormalizedDaemonProviderRuntimeConfig` 中 `apiKey?: string` → `apiKey: string | undefined`
  3. `DaemonProviderRuntimeConfig` 接口 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-011: daemon-provider-gateway/health.ts
- **文件**: `packages/agent-daemon/src/daemon-provider-gateway/health.ts`
- **行号**: 6
- **原错误码**: TS6196
- **根因**: `DaemonProviderCredentialMode` 导入但未使用
- **修复**: 删除 import
- **验收**: 0 条

---

#### T-DO-012: daemon-provider-gateway/index.ts
- **文件**: `packages/agent-daemon/src/daemon-provider-gateway/index.ts`
- **行号**: 5, 10, 11, 15, 18, 43, 100, 104, 105, 152, 227, 251, 262, 299
- **原错误码**: TS6133×4, TS2724, TS2459, TS2412×5, TS2379, TS2375, TS2322
- **根因**:
  - TS6133: 删除未使用的 import
  - TS2724: `NormalizedDaemonProviderRuntimeConfig` 未导出 → 修正为从正确位置导入
  - TS2459: `DaemonProviderStatusSnapshot` 未导出 → types.ts 加 export
  - TS2412: 变量声明 `field: T` 但赋 `undefined` → 加 `| undefined`
  - TS2379: 传参含 `| undefined` 给 `?:` 形参
  - TS2375/TS2322: 同理
- **修复**: 对应统一修复
- **验收**: 0 条

---

#### T-DO-013: daemon-provider-gateway/provider-factory.ts
- **文件**: `packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts`
- **行号**: 19, 40, 47, 61, 81, 105
- **原错误码**: TS6196, TS6133, TS2379×2, TS2375, TS1361
- **根因**:
  - L19: `DaemonProviderRuntimeConfig` 导入未使用
  - L40: `providerId` 参数未使用
  - L47/L61: `Partial<AnthropicProviderOptions>` 等传参含 `| undefined` 给 `?:` 形参
  - L81: `OpenAICompatibleProviderOptions` 接口字段 `?:` 不匹配含 `| undefined` 的字面量
  - L105: `import type` 导入 `OpenAICompatibleProvider` 但当作值使用
- **修复**:
  1. 删除未使用的 import/参数
  2. Provider option 接口签名改为 `| undefined`
  3. L105: `import type` → `import { ... }` 或 `OpenAICompatibleProvider` 改为类型上下文
- **验收**: 0 条

---

#### T-DO-014: daemon-provider-gateway/types.ts
- **文件**: `packages/agent-daemon/src/daemon-provider-gateway/types.ts`
- **行号**: 13, 14
- **原错误码**: TS6196
- **根因**: `DaemonProviderDiagnostic`, `DaemonProviderReadiness` 声明但从未使用（在其他文件引用但本文件没直接消费）
- **修复**: 检查是否被导出使用；若不需导出则删除
- **验收**: 0 条

---

#### T-DO-015: handlers/background-task-handlers.ts
- **文件**: `packages/agent-daemon/src/handlers/background-task-handlers.ts`
- **行号**: 48, 77, 134
- **原错误码**: TS2379
- **根因**: 传参含 `| undefined` 给 `DaemonBackgroundTaskQuery`, `DaemonBackgroundTaskStartInput` 等接口的 `?:` 字段
- **修复**: 对应接口定义 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-016: handlers/pending-input-handlers.ts
- **文件**: `packages/agent-daemon/src/handlers/pending-input-handlers.ts`
- **行号**: 34, 67, 96
- **原错误码**: TS2379
- **根因**: 传参给 `EnqueuePendingInputRequest`, `CancelPendingInputRequest`, `DispatchPendingInputRequest` 含 `| undefined` 值给 `?:` 字段
- **修复**: 对应 Request 接口 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-017: handlers/run-handlers.ts
- **文件**: `packages/agent-daemon/src/handlers/run-handlers.ts`
- **行号**: 207, 432, 724, 849, 859
- **原错误码**: TS2379
- **根因**:
  - L207: `OrchestratedRunInput` 接口字段 `?:` 但传参含大量 `| undefined`
  - L432: `{ content?: ..., hasImages?: ..., attachments?: ... }` 赋给 `{ content?: ..., hasImages?: boolean, ... }`
  - L724: `DaemonOutboundMessage` 的 `runId?: string` 但传 `runId: string | undefined`
  - L849/L859: `{ status?: ..., error?: string }` 传 `error: undefined` 或 `error: string | undefined`
- **修复**: 接口 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-018: handlers/session-handlers.ts
- **文件**: `packages/agent-daemon/src/handlers/session-handlers.ts`
- **行号**: 368
- **原错误码**: TS2375
- **根因**: `ConversationRewindApplyPlanResolution` 接口字段 `?:` 但字面量含 `| undefined`
- **修复**: 接口 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-019: index.ts (agent-daemon)
- **文件**: `packages/agent-daemon/src/index.ts`
- **行号**: 188
- **原错误码**: TS2375
- **根因**: `Partial<DaemonConfig>` 字面量含 `| undefined` 值
- **修复**: 如果 `DaemonConfig` 被 `Partial<>` 包裹则 `secretToken?: string` 已足够，但 `exactOptionalPropertyTypes: true` 下传 undefined 也违规 → 改为条件展开：`...(secretToken ? { secretToken } : {})`
- **验收**: 0 条

---

#### T-DO-020: mcp-config.ts
- **文件**: `packages/agent-daemon/src/mcp-config.ts`
- **行号**: 192
- **原错误码**: TS2379
- **根因**: 传 `{ ..., env: Record<string, string> | undefined, cwd: string | undefined, confirmStart: ... | undefined }` 给 `StdioMcpAdapterOptions`（字段 `?:`）
- **修复**: `StdioMcpAdapterOptions` 接口定义 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-DO-021: mcp-stdio-adapter.ts
- **文件**: `packages/agent-daemon/src/mcp-stdio-adapter.ts`
- **行号**: 181
- **原错误码**: TS2375
- **根因**: `AgentTool` 接口字段 `?:` 但字面量 `{ ..., inputSchema: JsonObject | undefined, ... }`
- **修复**: `AgentTool` 接口 `inputSchema?: JsonObject` → `inputSchema: JsonObject | undefined`
- **验收**: 0 条

---

#### T-DO-022: scoped-context-runtime.ts
- **文件**: `packages/agent-daemon/src/scoped-context-runtime.ts`
- **行号**: 245, 249, 253
- **原错误码**: TS2375
- **根因**: `ScopedContextResourcePathSet` 的 `files?: string[]`, `dirs?: string[]` 但赋值含 `string[] | undefined`
- **修复**: 接口定义 `files?: string[]` → `files: string[] | undefined`
- **验收**: 0 条

---

#### T-DO-023: scoped-context-store.ts
- **文件**: `packages/agent-daemon/src/scoped-context-store.ts`
- **行号**: 63
- **原错误码**: TS2375
- **根因**: `ScopedContextQueryResult` 的 `diagnostic?: ...` 但赋值含 `DaemonScopedContextDiagnostic | undefined`
- **修复**: 接口 `diagnostic?: DaemonScopedContextDiagnostic` → `diagnostic: DaemonScopedContextDiagnostic | undefined`
- **验收**: 0 条

---

#### T-DO-024: server-handlers.ts
- **文件**: `packages/agent-daemon/src/server-handlers.ts`
- **行号**: 2, 287, 288, 823
- **原错误码**: TS6133 (L2), TS2353 (L287), TS7006 (L288), TS2352 (L823)
- **根因**:
  - L2: `toJsonObject` 导入未使用 → 删除
  - L287: `ConfigHandlerDeps` 类型没有 `applyMcpServerConfigs` 属性 → 接口加 `applyMcpServerConfigs`
  - L288: `configs` 参数隐式 `any` → 加类型标注
  - L823: `HelloMessage & DaemonCorrelationFields` 强转 `Record<string, unknown>` 不安全 → 加 `unknown`
- **验收**: 0 条

---

#### T-DO-025: server-runtime-factory/index.ts
- **文件**: `packages/agent-daemon/src/server-runtime-factory/index.ts`
- **行号**: 11, 16, 34, 57, 78-84, 101, 111, 121, 137, 149, 165, 170, 174, 184, 227
- **原错误码**: TS6196×3, TS2412×3, TS2339×7, TS2352×2, TS2322×1, TS2379×4, TS2375×1
- **根因**:
  - 未使用声明删除
  - TS2412: `private providerStatusProvider?: ...` 赋值 undefined → 类型加 `| undefined`
  - TS2339: `NonNullable<DaemonArtifactAdapter | DaemonMemoryAdapter | DaemonCheckpointAdapter | undefined>` 没有 `listArtifacts` 等属性 → 用类型守卫或类型断言
  - TS2352: `manager as Record<string, unknown>` → 加 `as unknown as`
  - TS2322: 返回数组类型 `transport?: string` 不匹配 `transport: string | undefined`
- **验收**: 0 条

---

#### T-DO-026: server-runtime-factory/mcp-factory.ts
- **文件**: `packages/agent-daemon/src/server-runtime-factory/mcp-factory.ts`
- **行号**: 159, 312, 317
- **原错误码**: TS2322 (L159, L312), TS1205 (L317)
- **根因**:
  - L159: 返回对象 `{ transport: string | undefined, ... }` 不能赋给 `{ transport?: string, ... }[]`
  - L312: `unknown` 不能赋给 `JsonValue`
  - L317: `isolatedModules` 下 re-export type 必须 `export type`
- **修复**: L159 类型改为 `| undefined`；L312 加类型断言；L317 `export` → `export type`
- **验收**: 0 条

---

#### T-DO-027: server-runtime-factory/tool-assembly.ts
- **文件**: `packages/agent-daemon/src/server-runtime-factory/tool-assembly.ts`
- **行号**: 1, 21, 26, 27, 89
- **原错误码**: TS6196 (L1), TS6192 (L21, L27), TS6133 (L26), TS2412 (L89)
- **根因**:
  - L1: `McpServerDefinition` 导入未使用
  - L21: 全部 import 未使用
  - L26: `DaemonUnsupportedCapabilityError` 导入未使用
  - L27: 全部 import 未使用
  - L89: `MutationLeaseOwner | undefined` 赋给 `{ runId?: ... } | undefined` → 接口改为显式 `| undefined`
- **验收**: 0 条

---

#### T-DO-028: server/connection-manager.ts
- **文件**: `packages/agent-daemon/src/server/connection-manager.ts`
- **行号**: 4, 38, 71, 134, 315, 357, 360
- **原错误码**: TS6196×3 (L4), TS2379×5, TS2352
- **根因**: 同上模式
- **验收**: 0 条

---

#### T-DO-029: server/approval-bridge.ts
- **文件**: `packages/agent-daemon/src/server/approval-bridge.ts`
- **行号**: 63
- **原错误码**: TS2379
- **根因**: `ApprovalDecision` 的 `reason?: string` 传 `reason: string | undefined`
- **修复**: `ApprovalDecision` 接口 `reason?: string` → `reason: string | undefined`
- **验收**: 0 条

---

#### T-DO-030: server/workflow-manager.ts
- **文件**: `packages/agent-daemon/src/server/workflow-manager.ts`
- **行号**: 23, 51, 62
- **原错误码**: TS2412
- **根因**: 非可选字段赋 `undefined`
- **修复**: 字段类型加 `| undefined`
- **验收**: 0 条

---

#### T-DO-031: server/index.ts
- **文件**: `packages/agent-daemon/src/server/index.ts`
- **行号**: 6, 72-82, 125, 142, 147-148, 168-169, 204, 214, 220, 237-238, 255, 295, 371, 381, 429, 460
- **原错误码**: TS2305, TS2339×5, TS2379×8, TS2412×2, TS6133, TS2559, TS2352×3, TS2554
- **根因**:
  - L6: `normalizeDaemonMcpServers` 未从 `../persistence.js` 导出 → 加 export
  - L72-82: `DaemonConfig` 没有 `mcpServers` 属性 → config.ts 加 `mcpServers?: DaemonMcpServerConfig[]`
  - L255: `handleUpdateConfig` 传 4 参数但期望 5 → 检查签名补参数或用 `void`
  - L381: `consumeRestoredSubagentRuntimeEvents` 在 `AgentOrchestrator` 上不存在 → 可能是私有方法改为 public
- **验收**: 0 条

---

#### T-DO-032: session-query-handlers.ts
- **文件**: `packages/agent-daemon/src/session-query-handlers.ts`
- **行号**: 106, 158, 172, 202
- **原错误码**: TS2322 (L106, L158), TS2379 (L172, L202)
- **根因**: 返回类型 `string | DaemonOutboundMessage` 不匹配；传参 `BuildDaemonTaskSnapshotInput` 含 `| undefined`
- **验收**: 0 条

---

#### T-DO-033: subagent-runtime.ts
- **文件**: `packages/agent-daemon/src/subagent-runtime.ts`
- **行号**: 2, 3, 327
- **原错误码**: TS6133, TS6196, TS2352
- **验收**: 0 条

---

#### T-DO-034: subagent-lifecycle.ts
- **文件**: `packages/agent-daemon/src/subagent-lifecycle.ts`
- **行号**: 72
- **原错误码**: TS6133
- **验收**: 0 条

---

#### T-DO-035: types/config.ts
- **文件**: `packages/agent-daemon/src/types/config.ts`
- **行号**: 56
- **原错误码**: TS2375
- **根因**: `DEFAULT_DAEMON_CONFIG` 字面量赋值 `undefined` 给非可选字段
- **修复**: `DaemonConfig` 接口加 `secretToken: string | undefined`；或条件展开 `...(undefined ? ...`
- **验收**: 0 条

---

#### T-DO-036: types/entities.ts
- **文件**: `packages/agent-daemon/src/types/entities.ts`
- **行号**: 4-26
- **原错误码**: TS6196（约 10 个）
- **根因**: 大量 type 声明但从未使用
- **修复**: 删除未使用的 type export（保留被其他文件引用的）
- **验收**: 0 条

---

#### T-DO-037: workflow-store/index.ts
- **文件**: `packages/agent-daemon/src/workflow-store/index.ts`
- **行号**: 14, 28
- **原错误码**: TS6133 (L14), TS6138 (L28)
- **修复**: L14 删除 `WORKFLOW_STORE_VERSION`；L28 `options` → `_options`
- **验收**: 0 条

---

#### T-DO-038: workflow-store/storage-engine.ts
- **文件**: `packages/agent-daemon/src/workflow-store/storage-engine.ts`
- **行号**: 4
- **原错误码**: TS6133
- **修复**: 删除 `isRecord` 导入
- **验收**: 0 条

---

#### T-DO-039: types/provider-types.ts
- **文件**: `packages/agent-daemon/src/types/provider-types.ts`
- **行号**: 2
- **原错误码**: TS6133
- **修复**: 删除 `OpenAICompatibleEndpoint` import
- **验收**: 0 条

---

#### T-DO-040: capabilities.ts
- **文件**: `packages/agent-daemon/src/capabilities.ts`
- **行号**: 2
- **原错误码**: TS6133
- **修复**: 删除 `JsonObject` import
- **验收**: 0 条

---

### 3.2 Protocol Validators 专项任务卡

以下为 Zod schema 推导的类型与显式声明的 `ProtocolValidationResult<T>` 的 T 不完全一致的 TS2322 错误。原因通常是 Zod schema 输出的类型中包含 `?:` 属性（`undefined` 不会被包含在输出类型中）而声明的消息类型用 `?:` 定义。

**通用修复**：在消息接口类型中，将所有 `field?: Type` 改为 `field: Type | undefined`。

---

#### T-PV-001: protocol/validators/common.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/common.ts`
- **行号**: 8, 13, 18
- **原错误码**: TS2322 (L8, L18), TS2739 (L13)
- **根因**: ZodEffects 泛型不匹配；ZodDefault 缺少 innerType/sourceType
- **修复**: 调整 Zod helper 函数的泛型约束
- **验收**: 0 条

---

#### T-PV-002: protocol/validators/background.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/background.ts`
- **行号**: 510, 901, 923, 948, 994
- **原错误码**: TS2322
- **根因**: `ProtocolValidationResult<{ ... }>` 与 `ProtocolValidationResult<ResolveScopedContextMessage>` 等不匹配
- **修复**: 消息接口 `ResolveScopedContextMessage` 等的 `?:` → `| undefined`
- **验收**: 0 条

---

#### T-PV-003: protocol/validators/plan.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/plan.ts`
- **行号**: 81
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-004: protocol/validators/provider.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/provider.ts`
- **行号**: 220, 242
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-005: protocol/validators/rewind.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/rewind.ts`
- **行号**: 90, 301
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-006: protocol/validators/run.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/run.ts`
- **行号**: 247
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-007: protocol/validators/session-events.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/session-events.ts`
- **行号**: 369, 430
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-008: protocol/validators/session.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/session.ts`
- **行号**: 95
- **原错误码**: TS2322
- **验收**: 0 条

---

#### T-PV-009: protocol/protocol.ts
- **文件**: `packages/agent-daemon/src/protocol/protocol.ts`
- **行号**: 421
- **原错误码**: TS2322
- **验收**: 0 条

---

### 3.3 Test 文件任务卡

#### T-TS-001: daemon-approval-handler.test.ts
- **文件**: `packages/agent-daemon/src/daemon-approval-handler.test.ts`
- **行号**: 2
- **原错误码**: TS6133
- **修复**: 删除未使用的 `DaemonApprovalHandler` import
- **验收**: 0 条

#### T-TS-002: mcp-stdio-adapter.test.ts
- **文件**: `packages/agent-daemon/src/mcp-stdio-adapter.test.ts`
- **行号**: 2
- **原错误码**: TS6133 + TS2305
- **修复**: 删除 `McpStdioAdapter` 引用（该类型可能已被改名或删除）
- **验收**: 0 条

#### T-TS-003: server-handlers.test.ts
- **文件**: `packages/agent-daemon/src/server-handlers.test.ts`
- **行号**: 3, 21, 154
- **原错误码**: TS2305 (L3), TS2352 (L21, L154)
- **根因**:
  - L3: `ConnectedClient` 未从 `./types` 导出 → 导出或改用具体类型
  - L21: Mock 对象强转 `DaemonRequestHandlersOptions` 不兼容 → `as unknown as`
  - L154: 字面量强转 `DaemonInboundMessage` 不兼容 → `as unknown as`
- **验收**: 0 条

#### T-TS-004: server-runtime-factory.test.ts
- **文件**: `packages/agent-daemon/src/server-runtime-factory.test.ts`
- **行号**: 564, 797, 855
- **原错误码**: TS2532, TS2739, TS2375
- **根因**:
  - L564: `?.` 后可能为 `undefined`
  - L797: 对象缺少 `healthPort`, `metricsPort` 等属性
  - L855: `OrchestratorRunRecord` `?:` 字段赋值含 `| undefined`
- **验收**: 0 条

#### T-TS-005: run-handlers.stream-pause.test.ts
- **文件**: `packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts`
- **行号**: 101
- **原错误码**: TS2352
- **修复**: `as unknown as DaemonOutboundMessage`
- **验收**: 0 条

#### T-TS-006: protocol/registry.test.ts
- **文件**: `packages/agent-daemon/src/protocol/registry.test.ts`
- **行号**: 275
- **原错误码**: TS2322
- **修复**: `(string | undefined)[]` 不能赋给 `string[]` → filter 或改类型
- **验收**: 0 条

#### T-TS-007: protocol/validators/common.test.ts
- **文件**: `packages/agent-daemon/src/protocol/validators/common.test.ts`
- **行号**: 2
- **原错误码**: TS6192
- **修复**: 清空/删除全部未使用的 import
- **验收**: 0 条

---

### 3.4 agent-orchestrator 任务卡

#### T-OR-001: artifact-store.ts
- **文件**: `packages/agent-orchestrator/src/artifact-store.ts`
- **行号**: 107
- **原错误码**: TS2375
- **根因**: `ContentAddressedBlobContent` 接口字段 `?:` 但赋值含 `| undefined`
- **修复**: 接口 `encoding?: "utf8" | "binary"` → `encoding: "utf8" | "binary" | undefined`
- **验收**: `npx tsc --noEmit -p packages/agent-orchestrator/tsconfig.json 2>&1 | Select-String "artifact-store" | Measure-Object -Line` = 0

#### T-OR-002: conversation-rewind.ts
- **文件**: `packages/agent-orchestrator/src/conversation-rewind.ts`
- **行号**: 165, 257
- **原错误码**: TS2379 (L165), TS2375 (L257)
- **根因**:
  - L165: `PlanConversationRewindInput` 的 `checkpoint?: ...`, `restorePolicy?: ...` 但传参含 `| undefined`
  - L257: `ConversationRewindWorkspaceRestore` 的 `manifestPath?: string` 但赋值 `manifestPath: string | undefined`
- **修复**: 接口 `?:` → `| undefined`
- **验收**: 0 条

#### T-OR-003: event-scan-goal-strategy.ts
- **文件**: `packages/agent-orchestrator/src/event-scan-goal-strategy.ts`
- **行号**: 23
- **原错误码**: TS2420
- **根因**: `EventScanGoalStrategy` class 没有正确实现 `GoalLoopStrategy` 接口
- **修复**: 检查 `GoalLoopStrategy` 接口要求的方法，补充缺失方法签名
- **验收**: 0 条

#### T-OR-004: event-store-projection.ts
- **文件**: `packages/agent-orchestrator/src/event-store-projection.ts`
- **行号**: 108, 125
- **原错误码**: TS2379
- **根因**:
  - L108: `StoredEventReadOptions` 的 `maxEvents?: number` 但传 `{ maxEvents: undefined }`
  - L125: `AgentMessage` 的 `metadata?: JsonObject` 但传 `metadata: JsonObject | undefined`
- **修复**: 接口 `?:` → `| undefined`
- **验收**: 0 条

#### T-OR-005: event-store.ts
- **文件**: `packages/agent-orchestrator/src/event-store.ts`
- **行号**: 143, 149, 160, 183, 413, 789, 807, 814, 1102
- **原错误码**: TS2412 (L143, L789, L807, L1102), TS2379 (L149, L160, L183, L814), TS2375 (L413)
- **根因**:
  - L143: `string | undefined` 赋给 `string` 类型字段
  - L789, L807, L1102: `undefined` 赋给非可选 `JsonlAppendBatcher` / `StoredEventLogMetadata` 类型
  - L149,L160,L183: `{ eventId: string | undefined, ... }` 给 `{ eventId?: string, ... }`
  - L413: `{ lastIndexWriteError: string | undefined, ... }` 给 `{ lastIndexWriteError?: string, ... }`
- **修复**: 接口 `?:` → `| undefined`；变量声明加 `| undefined`
- **验收**: 0 条

#### T-OR-006: orchestrator.ts
- **文件**: `packages/agent-orchestrator/src/orchestrator.ts`
- **行号**: 78, 110, 290, 300, 390, 396, 401, 425, 438, 495, 649, 680, 703, 716, 751, 1017, 1175, 1673, 1674, 1675, 1677, 1696
- **原错误码**: TS2375 (L78, L290), TS2355 (L110), TS2379×9, TS2304×3, TS2412 (L649), TS2339×6
- **根因**:
  - L78: `OrchestratorSessionRecord` 的 `metadata?: JsonObject` 但赋值 `metadata: JsonObject | undefined`
  - L110: 函数声明返回类型非 `void`/`undefined`/`any` 但没有返回值 → 加 return 或改返回类型
  - L290: `OrchestratorRunRecord` 同上
  - L390/396/401: `maxSequence` 变量未声明
  - L649: `undefined` 赋给非可选 `RunEngine`
  - L1673-1696: `AsyncQueue<T>` 没有 `buffer` 属性
- **验收**: 0 条

#### T-OR-007: task-assessment.ts
- **文件**: `packages/agent-orchestrator/src/task-assessment.ts`
- **行号**: 573
- **原错误码**: TS2375
- **根因**: `GoalContinuationDecision` 的 `detail?: JsonObject`, `progressSignature?: string`, `prompt?: string` 但赋值含 `string | undefined`
- **修复**: 接口 `?:` → `| undefined`
- **验收**: 0 条

#### T-OR-008: event-store.test.ts
- **文件**: `packages/agent-orchestrator/src/event-store.test.ts`
- **行号**: 672
- **原错误码**: TS2375
- **修复**: `OrchestratorEvent` `?:` → `| undefined`
- **验收**: 0 条

#### T-OR-009: orchestrator.test.ts
- **文件**: `packages/agent-orchestrator/src/orchestrator.test.ts`
- **行号**: 15, 930-931, 970-971, 1011, 1051-1054, 1070, 1558, 1857
- **原错误码**: TS2305, TS2339×8, TS2353, TS2412
- **根因**:
  - L15: `isNonDurableRuntimeDelta` 未导出→ 导出或删除引用
  - L930-1070: `persistStateSnapshot`, `loadStateSnapshot`, `getLastRestoreMode`, `stateSnapshotPath` 在对应类型上不存在 → 可能是私有方法改为 public 或移除测试
  - L1558: `message` 不在 `ProviderDiagnostic` 中
  - L1857: TS2412
- **验收**: 0 条

#### T-OR-010: types.test.ts
- **文件**: `packages/agent-orchestrator/src/__tests__/types.test.ts`
- **行号**: 2
- **原错误码**: TS6133
- **修复**: 删除 `BackgroundCommandManager` import
- **验收**: 0 条

---

## 4. 覆盖率矩阵

### 4.1 agent-daemon 错误 → 任务卡

| 文件 | 错误数 | 任务卡 |
|---|---|---|
| `approval-queue.ts` | 4 | T-DO-001 |
| `background-task-manager.ts` | 1 | T-DO-002 |
| `capabilities.ts` | 1 | T-DO-040 |
| `conversation-rewind-boundary.ts` | 3 | T-DO-004 |
| `daemon-approval-handler.ts` | 2 | T-DO-005 |
| `daemon-client-registry.ts` | 5 | T-DO-006 |
| `daemon-lifecycle.ts` | 1 | T-DO-007 |
| `daemon-logger.ts` | 2 | T-DO-008 |
| `daemon-product-adapters.ts` | 1 | T-DO-009 |
| `daemon-provider-gateway/credential-modes.ts` | 6 | T-DO-010 |
| `daemon-provider-gateway/health.ts` | 1 | T-DO-011 |
| `daemon-provider-gateway/index.ts` | 14 | T-DO-012 |
| `daemon-provider-gateway/provider-factory.ts` | 6 | T-DO-013 |
| `daemon-provider-gateway/types.ts` | 2 | T-DO-014 |
| `handlers/background-task-handlers.ts` | 3 | T-DO-015 |
| `handlers/pending-input-handlers.ts` | 3 | T-DO-016 |
| `handlers/run-handlers.ts` | 5 | T-DO-017 |
| `handlers/session-handlers.ts` | 1 | T-DO-018 |
| `index.ts` | 1 | T-DO-019 |
| `mcp-config.ts` | 1 | T-DO-020 |
| `mcp-stdio-adapter.ts` | 1 | T-DO-021 |
| `scoped-context-runtime.ts` | 3 | T-DO-022 |
| `scoped-context-store.ts` | 1 | T-DO-023 |
| `server-handlers.ts` | 4 | T-DO-024 |
| `server-runtime-factory/index.ts` | ~22 | T-DO-025 |
| `server-runtime-factory/mcp-factory.ts` | 3 | T-DO-026 |
| `server-runtime-factory/tool-assembly.ts` | 5 | T-DO-027 |
| `server/connection-manager.ts` | 9 | T-DO-028 |
| `server/approval-bridge.ts` | 1 | T-DO-029 |
| `server/workflow-manager.ts` | 3 | T-DO-030 |
| `server/index.ts` | ~25 | T-DO-031 |
| `session-query-handlers.ts` | 4 | T-DO-032 |
| `subagent-runtime.ts` | 3 | T-DO-033 |
| `subagent-lifecycle.ts` | 1 | T-DO-034 |
| `types/config.ts` | 1 | T-DO-035 |
| `types/entities.ts` | ~10 | T-DO-036 |
| `workflow-store/index.ts` | 2 | T-DO-037 |
| `workflow-store/storage-engine.ts` | 1 | T-DO-038 |
| `types/provider-types.ts` | 1 | T-DO-039 |
| `protocol/protocol.ts` | 1 | T-PV-009 |
| `protocol/validators/common.ts` | 3 | T-PV-001 |
| `protocol/validators/background.ts` | 5 | T-PV-002 |
| `protocol/validators/plan.ts` | 1 | T-PV-003 |
| `protocol/validators/provider.ts` | 2 | T-PV-004 |
| `protocol/validators/rewind.ts` | 2 | T-PV-005 |
| `protocol/validators/run.ts` | 1 | T-PV-006 |
| `protocol/validators/session-events.ts` | 2 | T-PV-007 |
| `protocol/validators/session.ts` | 1 | T-PV-008 |
| `daemon-approval-handler.test.ts` | 1 | T-TS-001 |
| `mcp-stdio-adapter.test.ts` | 2 | T-TS-002 |
| `server-handlers.test.ts` | 3 | T-TS-003 |
| `server-runtime-factory.test.ts` | 3 | T-TS-004 |
| `run-handlers.stream-pause.test.ts` | 1 | T-TS-005 |
| `protocol/registry.test.ts` | 1 | T-TS-006 |
| `protocol/validators/common.test.ts` | 1 | T-TS-007 |

### 4.2 agent-orchestrator 错误 → 任务卡

| 文件 | 错误数 | 任务卡 |
|---|---|---|
| `artifact-store.ts` | 1 | T-OR-001 |
| `conversation-rewind.ts` | 2 | T-OR-002 |
| `event-scan-goal-strategy.ts` | 1 | T-OR-003 |
| `event-store-projection.ts` | 2 | T-OR-004 |
| `event-store.ts` | 9 | T-OR-005 |
| `orchestrator.ts` | ~22 | T-OR-006 |
| `task-assessment.ts` | 1 | T-OR-007 |
| `event-store.test.ts` | 1 | T-OR-008 |
| `orchestrator.test.ts` | ~11 | T-OR-009 |
| `__tests__/types.test.ts` | 1 | T-OR-010 |

---

## 5. 机器可读台账

### 5.1 JSON 台账格式

```json
{
  "meta": {
    "plan": "plan_02_daemon_orch",
    "generatedAt": "2026-07-25T00:00:00.000Z",
    "totalErrors": 675,
    "totalFiles": 68
  },
  "waves": [
    {
      "wave": "W1-D",
      "description": "agent-daemon exactOptionalPropertyTypes 批量修复",
      "tasks": ["T-DO-001", "T-DO-002", "T-DO-004", "T-DO-005", "T-DO-006", "T-DO-007", "T-DO-008", "T-DO-019", "T-DO-020", "T-DO-021", "T-DO-022", "T-DO-023", "T-DO-028", "T-DO-029", "T-DO-030", "T-DO-031", "T-DO-035"],
      "filesWrite": [
        "packages/agent-daemon/src/types/config.ts",
        "packages/agent-daemon/src/types/entities.ts",
        "packages/agent-daemon/src/approval-queue.ts",
        "packages/agent-daemon/src/background-task-manager.ts",
        "packages/agent-daemon/src/daemon-lifecycle.ts",
        "packages/agent-daemon/src/daemon-logger.ts",
        "packages/agent-daemon/src/daemon-client-registry.ts",
        "packages/agent-daemon/src/daemon-approval-handler.ts",
        "packages/agent-daemon/src/server/index.ts",
        "packages/agent-daemon/src/server/connection-manager.ts",
        "packages/agent-daemon/src/server/workflow-manager.ts",
        "packages/agent-daemon/src/server/approval-bridge.ts",
        "packages/agent-daemon/src/conversation-rewind-boundary.ts",
        "packages/agent-daemon/src/scoped-context-runtime.ts",
        "packages/agent-daemon/src/scoped-context-store.ts",
        "packages/agent-daemon/src/mcp-stdio-adapter.ts",
        "packages/agent-daemon/src/task-snapshot/index.ts",
        "packages/agent-daemon/src/task-snapshot/event-handlers.ts"
      ]
    },
    {
      "wave": "W2-D",
      "description": "agent-daemon provider-gateway 专项",
      "tasks": ["T-DO-010", "T-DO-011", "T-DO-012", "T-DO-013", "T-DO-014"],
      "filesWrite": [
        "packages/agent-daemon/src/daemon-provider-gateway/types.ts",
        "packages/agent-daemon/src/daemon-provider-gateway/credential-modes.ts",
        "packages/agent-daemon/src/daemon-provider-gateway/index.ts",
        "packages/agent-daemon/src/daemon-provider-gateway/health.ts",
        "packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts"
      ]
    },
    {
      "wave": "W3-D",
      "description": "agent-daemon handlers + protocol + server-runtime-factory",
      "tasks": ["T-DO-015", "T-DO-016", "T-DO-017", "T-DO-018", "T-DO-024", "T-DO-025", "T-DO-026", "T-DO-027", "T-DO-032"],
      "filesWrite": [
        "packages/agent-daemon/src/handlers/background-task-handlers.ts",
        "packages/agent-daemon/src/handlers/pending-input-handlers.ts",
        "packages/agent-daemon/src/handlers/run-handlers.ts",
        "packages/agent-daemon/src/handlers/session-handlers.ts",
        "packages/agent-daemon/src/server-handlers.ts",
        "packages/agent-daemon/src/session-query-handlers.ts",
        "packages/agent-daemon/src/server-runtime-factory/index.ts",
        "packages/agent-daemon/src/server-runtime-factory/mcp-factory.ts",
        "packages/agent-daemon/src/server-runtime-factory/tool-assembly.ts",
        "packages/agent-daemon/src/server-runtime-factory/types.ts"
      ]
    },
    {
      "wave": "W4-D",
      "description": "agent-daemon 杂项 + test 文件",
      "tasks": ["T-DO-003", "T-DO-009", "T-DO-033", "T-DO-034", "T-DO-036", "T-DO-037", "T-DO-038", "T-DO-039", "T-DO-040"],
      "filesWrite": [
        "packages/agent-daemon/src/index.ts",
        "packages/agent-daemon/src/mcp-config.ts",
        "packages/agent-daemon/src/daemon-product-adapters.ts",
        "packages/agent-daemon/src/subagent-runtime.ts",
        "packages/agent-daemon/src/subagent-lifecycle.ts",
        "packages/agent-daemon/src/capabilities.ts",
        "packages/agent-daemon/src/workflow-store/index.ts",
        "packages/agent-daemon/src/workflow-store/storage-engine.ts",
        "packages/agent-daemon/src/types/provider-types.ts"
      ]
    },
    {
      "wave": "W5-D",
      "description": "agent-daemon protocol validators Zod 型变专项",
      "tasks": ["T-PV-001", "T-PV-002", "T-PV-003", "T-PV-004", "T-PV-005", "T-PV-006", "T-PV-007", "T-PV-008", "T-PV-009"],
      "filesWrite": [
        "packages/agent-daemon/src/protocol/protocol.ts",
        "packages/agent-daemon/src/protocol/validators/common.ts",
        "packages/agent-daemon/src/protocol/validators/background.ts",
        "packages/agent-daemon/src/protocol/validators/plan.ts",
        "packages/agent-daemon/src/protocol/validators/provider.ts",
        "packages/agent-daemon/src/protocol/validators/rewind.ts",
        "packages/agent-daemon/src/protocol/validators/run.ts",
        "packages/agent-daemon/src/protocol/validators/session-events.ts",
        "packages/agent-daemon/src/protocol/validators/session.ts"
      ]
    },
    {
      "wave": "W6-D",
      "description": "agent-daemon test 文件",
      "tasks": ["T-TS-001", "T-TS-002", "T-TS-003", "T-TS-004", "T-TS-005", "T-TS-006", "T-TS-007"],
      "filesWrite": [
        "packages/agent-daemon/src/daemon-approval-handler.test.ts",
        "packages/agent-daemon/src/mcp-stdio-adapter.test.ts",
        "packages/agent-daemon/src/server-handlers.test.ts",
        "packages/agent-daemon/src/server-runtime-factory.test.ts",
        "packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts",
        "packages/agent-daemon/src/protocol/registry.test.ts",
        "packages/agent-daemon/src/protocol/validators/common.test.ts"
      ]
    },
    {
      "wave": "W7-O",
      "description": "agent-orchestrator 全部源码",
      "tasks": ["T-OR-001", "T-OR-002", "T-OR-003", "T-OR-004", "T-OR-005", "T-OR-006", "T-OR-007"],
      "filesWrite": [
        "packages/agent-orchestrator/src/artifact-store.ts",
        "packages/agent-orchestrator/src/conversation-rewind.ts",
        "packages/agent-orchestrator/src/event-scan-goal-strategy.ts",
        "packages/agent-orchestrator/src/event-store-projection.ts",
        "packages/agent-orchestrator/src/event-store.ts",
        "packages/agent-orchestrator/src/orchestrator.ts",
        "packages/agent-orchestrator/src/task-assessment.ts"
      ]
    },
    {
      "wave": "W8-O",
      "description": "agent-orchestrator test 文件",
      "tasks": ["T-OR-008", "T-OR-009", "T-OR-010"],
      "filesWrite": [
        "packages/agent-orchestrator/src/event-store.test.ts",
        "packages/agent-orchestrator/src/orchestrator.test.ts",
        "packages/agent-orchestrator/src/__tests__/types.test.ts"
      ]
    }
  ],
  "tasks": {
    "T-DO-001": { "file": "packages/agent-daemon/src/approval-queue.ts", "lines": [128, 263, 316, 333], "errors": ["TS2375", "TS2412", "TS2379"], "wave": "W1-D" },
    "T-DO-002": { "file": "packages/agent-daemon/src/background-task-manager.ts", "lines": [208], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-003": { "file": "packages/agent-daemon/src/capabilities.ts", "lines": [2], "errors": ["TS6133"], "wave": "W4-D" },
    "T-DO-004": { "file": "packages/agent-daemon/src/conversation-rewind-boundary.ts", "lines": [97, 120, 213], "errors": ["TS2379", "TS2375"], "wave": "W1-D" },
    "T-DO-005": { "file": "packages/agent-daemon/src/daemon-approval-handler.ts", "lines": [50, 114], "errors": ["TS2379"], "wave": "W1-D" },
    "T-DO-006": { "file": "packages/agent-daemon/src/daemon-client-registry.ts", "lines": [53, 57, 137, 216, 236], "errors": ["TS2412", "TS2379"], "wave": "W1-D" },
    "T-DO-007": { "file": "packages/agent-daemon/src/daemon-lifecycle.ts", "lines": [165], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-008": { "file": "packages/agent-daemon/src/daemon-logger.ts", "lines": [9, 42], "errors": ["TS2375", "TS2412"], "wave": "W1-D" },
    "T-DO-009": { "file": "packages/agent-daemon/src/daemon-product-adapters.ts", "lines": [96], "errors": ["TS2345"], "wave": "W4-D" },
    "T-DO-010": { "file": "packages/agent-daemon/src/daemon-provider-gateway/credential-modes.ts", "lines": [14, 21, 22, 63, 141, 374], "errors": ["TS6133", "TS2459", "TS2375", "TS2379"], "wave": "W2-D" },
    "T-DO-011": { "file": "packages/agent-daemon/src/daemon-provider-gateway/health.ts", "lines": [6], "errors": ["TS6196"], "wave": "W2-D" },
    "T-DO-012": { "file": "packages/agent-daemon/src/daemon-provider-gateway/index.ts", "lines": [5, 10, 11, 15, 18, 43, 100, 104, 105, 152, 227, 251, 262, 299], "errors": ["TS6133", "TS2724", "TS2459", "TS2412", "TS2379", "TS2375", "TS2322"], "wave": "W2-D" },
    "T-DO-013": { "file": "packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts", "lines": [19, 40, 47, 61, 81, 105], "errors": ["TS6196", "TS6133", "TS2379", "TS2375", "TS1361"], "wave": "W2-D" },
    "T-DO-014": { "file": "packages/agent-daemon/src/daemon-provider-gateway/types.ts", "lines": [13, 14], "errors": ["TS6196"], "wave": "W2-D" },
    "T-DO-015": { "file": "packages/agent-daemon/src/handlers/background-task-handlers.ts", "lines": [48, 77, 134], "errors": ["TS2379"], "wave": "W3-D" },
    "T-DO-016": { "file": "packages/agent-daemon/src/handlers/pending-input-handlers.ts", "lines": [34, 67, 96], "errors": ["TS2379"], "wave": "W3-D" },
    "T-DO-017": { "file": "packages/agent-daemon/src/handlers/run-handlers.ts", "lines": [207, 432, 724, 849, 859], "errors": ["TS2379"], "wave": "W3-D" },
    "T-DO-018": { "file": "packages/agent-daemon/src/handlers/session-handlers.ts", "lines": [368], "errors": ["TS2375"], "wave": "W3-D" },
    "T-DO-019": { "file": "packages/agent-daemon/src/index.ts", "lines": [188], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-020": { "file": "packages/agent-daemon/src/mcp-config.ts", "lines": [192], "errors": ["TS2379"], "wave": "W1-D" },
    "T-DO-021": { "file": "packages/agent-daemon/src/mcp-stdio-adapter.ts", "lines": [181], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-022": { "file": "packages/agent-daemon/src/scoped-context-runtime.ts", "lines": [245, 249, 253], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-023": { "file": "packages/agent-daemon/src/scoped-context-store.ts", "lines": [63], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-024": { "file": "packages/agent-daemon/src/server-handlers.ts", "lines": [2, 287, 288, 823], "errors": ["TS6133", "TS2353", "TS7006", "TS2352"], "wave": "W3-D" },
    "T-DO-025": { "file": "packages/agent-daemon/src/server-runtime-factory/index.ts", "lines": [11, 16, 34, 57, 78, 79, 80, 81, 82, 83, 84, 101, 111, 121, 137, 149, 165, 170, 174, 184, 227], "errors": ["TS6196", "TS2412", "TS2339", "TS2352", "TS2322", "TS2379", "TS2375"], "wave": "W3-D" },
    "T-DO-026": { "file": "packages/agent-daemon/src/server-runtime-factory/mcp-factory.ts", "lines": [159, 312, 317], "errors": ["TS2322", "TS1205"], "wave": "W3-D" },
    "T-DO-027": { "file": "packages/agent-daemon/src/server-runtime-factory/tool-assembly.ts", "lines": [1, 21, 26, 27, 89], "errors": ["TS6196", "TS6192", "TS6133", "TS2412"], "wave": "W3-D" },
    "T-DO-028": { "file": "packages/agent-daemon/src/server/connection-manager.ts", "lines": [4, 38, 71, 134, 315, 357, 360], "errors": ["TS6196", "TS2379", "TS2352"], "wave": "W1-D" },
    "T-DO-029": { "file": "packages/agent-daemon/src/server/approval-bridge.ts", "lines": [63], "errors": ["TS2379"], "wave": "W1-D" },
    "T-DO-030": { "file": "packages/agent-daemon/src/server/workflow-manager.ts", "lines": [23, 51, 62], "errors": ["TS2412"], "wave": "W1-D" },
    "T-DO-031": { "file": "packages/agent-daemon/src/server/index.ts", "lines": [6, 72, 73, 75, 82, 125, 142, 147, 148, 168, 169, 204, 214, 220, 237, 238, 255, 295, 371, 381, 429, 460], "errors": ["TS2305", "TS2339", "TS2379", "TS2412", "TS6133", "TS2559", "TS2352", "TS2554"], "wave": "W1-D" },
    "T-DO-032": { "file": "packages/agent-daemon/src/session-query-handlers.ts", "lines": [106, 158, 172, 202], "errors": ["TS2322", "TS2379"], "wave": "W3-D" },
    "T-DO-033": { "file": "packages/agent-daemon/src/subagent-runtime.ts", "lines": [2, 3, 327], "errors": ["TS6133", "TS6196", "TS2352"], "wave": "W4-D" },
    "T-DO-034": { "file": "packages/agent-daemon/src/subagent-lifecycle.ts", "lines": [72], "errors": ["TS6133"], "wave": "W4-D" },
    "T-DO-035": { "file": "packages/agent-daemon/src/types/config.ts", "lines": [56], "errors": ["TS2375"], "wave": "W1-D" },
    "T-DO-036": { "file": "packages/agent-daemon/src/types/entities.ts", "lines": [4, 5, 7, 10, 11, 12, 13, 15, 18, 20, 22, 23, 26], "errors": ["TS6196"], "wave": "W4-D" },
    "T-DO-037": { "file": "packages/agent-daemon/src/workflow-store/index.ts", "lines": [14, 28], "errors": ["TS6133", "TS6138"], "wave": "W4-D" },
    "T-DO-038": { "file": "packages/agent-daemon/src/workflow-store/storage-engine.ts", "lines": [4], "errors": ["TS6133"], "wave": "W4-D" },
    "T-DO-039": { "file": "packages/agent-daemon/src/types/provider-types.ts", "lines": [2], "errors": ["TS6133"], "wave": "W4-D" },
    "T-DO-040": { "file": "packages/agent-daemon/src/capabilities.ts", "lines": [2], "errors": ["TS6133"], "wave": "W4-D" },
    "T-PV-001": { "file": "packages/agent-daemon/src/protocol/validators/common.ts", "lines": [8, 13, 18], "errors": ["TS2322", "TS2739"], "wave": "W5-D" },
    "T-PV-002": { "file": "packages/agent-daemon/src/protocol/validators/background.ts", "lines": [510, 901, 923, 948, 994], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-003": { "file": "packages/agent-daemon/src/protocol/validators/plan.ts", "lines": [81], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-004": { "file": "packages/agent-daemon/src/protocol/validators/provider.ts", "lines": [220, 242], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-005": { "file": "packages/agent-daemon/src/protocol/validators/rewind.ts", "lines": [90, 301], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-006": { "file": "packages/agent-daemon/src/protocol/validators/run.ts", "lines": [247], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-007": { "file": "packages/agent-daemon/src/protocol/validators/session-events.ts", "lines": [369, 430], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-008": { "file": "packages/agent-daemon/src/protocol/validators/session.ts", "lines": [95], "errors": ["TS2322"], "wave": "W5-D" },
    "T-PV-009": { "file": "packages/agent-daemon/src/protocol/protocol.ts", "lines": [421], "errors": ["TS2322"], "wave": "W5-D" },
    "T-TS-001": { "file": "packages/agent-daemon/src/daemon-approval-handler.test.ts", "lines": [2], "errors": ["TS6133"], "wave": "W6-D" },
    "T-TS-002": { "file": "packages/agent-daemon/src/mcp-stdio-adapter.test.ts", "lines": [2], "errors": ["TS6133", "TS2305"], "wave": "W6-D" },
    "T-TS-003": { "file": "packages/agent-daemon/src/server-handlers.test.ts", "lines": [3, 21, 154], "errors": ["TS2305", "TS2352"], "wave": "W6-D" },
    "T-TS-004": { "file": "packages/agent-daemon/src/server-runtime-factory.test.ts", "lines": [564, 797, 855], "errors": ["TS2532", "TS2739", "TS2375"], "wave": "W6-D" },
    "T-TS-005": { "file": "packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts", "lines": [101], "errors": ["TS2352"], "wave": "W6-D" },
    "T-TS-006": { "file": "packages/agent-daemon/src/protocol/registry.test.ts", "lines": [275], "errors": ["TS2322"], "wave": "W6-D" },
    "T-TS-007": { "file": "packages/agent-daemon/src/protocol/validators/common.test.ts", "lines": [2], "errors": ["TS6192"], "wave": "W6-D" },
    "T-OR-001": { "file": "packages/agent-orchestrator/src/artifact-store.ts", "lines": [107], "errors": ["TS2375"], "wave": "W7-O" },
    "T-OR-002": { "file": "packages/agent-orchestrator/src/conversation-rewind.ts", "lines": [165, 257], "errors": ["TS2379", "TS2375"], "wave": "W7-O" },
    "T-OR-003": { "file": "packages/agent-orchestrator/src/event-scan-goal-strategy.ts", "lines": [23], "errors": ["TS2420"], "wave": "W7-O" },
    "T-OR-004": { "file": "packages/agent-orchestrator/src/event-store-projection.ts", "lines": [108, 125], "errors": ["TS2379"], "wave": "W7-O" },
    "T-OR-005": { "file": "packages/agent-orchestrator/src/event-store.ts", "lines": [143, 149, 160, 183, 413, 789, 807, 814, 1102], "errors": ["TS2412", "TS2379", "TS2375"], "wave": "W7-O" },
    "T-OR-006": { "file": "packages/agent-orchestrator/src/orchestrator.ts", "lines": [78, 110, 290, 300, 390, 396, 401, 425, 438, 495, 649, 680, 703, 716, 751, 1017, 1175, 1673, 1674, 1675, 1677, 1696], "errors": ["TS2375", "TS2355", "TS2379", "TS2304", "TS2412", "TS2339"], "wave": "W7-O" },
    "T-OR-007": { "file": "packages/agent-orchestrator/src/task-assessment.ts", "lines": [573], "errors": ["TS2375"], "wave": "W7-O" },
    "T-OR-008": { "file": "packages/agent-orchestrator/src/event-store.test.ts", "lines": [672], "errors": ["TS2375"], "wave": "W8-O" },
    "T-OR-009": { "file": "packages/agent-orchestrator/src/orchestrator.test.ts", "lines": [15, 930, 931, 970, 971, 1011, 1051, 1054, 1070, 1558, 1857], "errors": ["TS2305", "TS2339", "TS2353", "TS2412"], "wave": "W8-O" },
    "T-OR-010": { "file": "packages/agent-orchestrator/src/__tests__/types.test.ts", "lines": [2], "errors": ["TS6133"], "wave": "W8-O" }
  }
}
```

### 5.2 多轮修复策略

每轮修复一个 Wave，验证通过后合并到主分支再开始下一轮。

修复顺序建议：

| 轮次 | Wave | 预期减少错误数 | 风险 |
|---|---|---|---|
| Round 1 | W1-D | ~150 | 低（接口定义批量替换） |
| Round 2 | W2-D | ~30 | 低（provider-gateway 集中） |
| Round 3 | W3-D | ~60 | 中（涉及业务逻辑类型变更） |
| Round 4 | W4-D | ~20 | 低（杂项含删除未使用导入） |
| Round 5 | W5-D | ~25 | 中（Zod 型变，需深入验证） |
| Round 6 | W7-O | ~50 | 高（orchestrator 核心业务逻辑） |
| Round 7 | W6-D + W8-O | ~25 | 低（test 文件，不改生产代码） |

---

## 6. 轮次接口

### 6.1 每轮输出格式

每轮修复 Agent #3 执行完成后，输出以下 JSON 台账：

```json
{
  "round": 1,
  "wave": "W1-D",
  "status": "pass" | "fail",
  "errorsBefore": 150,
  "errorsAfter": 0,
  "tasksCompleted": ["T-DO-001", "T-DO-002", ...],
  "tasksFailed": [],
  "verificationCommand": "npx tsc --noEmit --project packages/agent-daemon/tsconfig.json 2>&1 | Select-String '^packages/agent-daemon/src/' | Select-String -NotMatch 'W1-D' | Measure-Object -Line",
  "remainingErrors": []
}
```

### 6.2 并行策略

由于 **agent-daemon** 与 **agent-orchestrator** 的写集完全隔离，且 Wave 内部的 files_write 互不相交，可以并行执行：

- W1-D + W7-O 可并行
- W2-D + W7-O 可并行
- 所有 Wave 两两之间均可并行（files_write 互不相交）

### 6.3 验收标准

1. `npx tsc --noEmit --project packages/agent-daemon/tsconfig.json` 对 `packages/agent-daemon/src/` 的精确匹配数为 0
2. `npx tsc --noEmit --project packages/agent-orchestrator/tsconfig.json` 对 `packages/agent-orchestrator/src/` 的精确匹配数为 0
3. 每张任务卡验收：`Select-String <filename>` 结果为 0

---

## 附录 A：`exactOptionalPropertyTypes` 修复模板

### 模式 1：接口定义改 `?:` 为 `| undefined`

```diff
-  field?: Type;
+  field: Type | undefined;
```

### 模式 2：变量声明加 `| undefined`

```diff
- private timeout?: Timeout;
+ private timeout: Timeout | undefined;
```

### 模式 3：Partial<> 泛型场景

如果接口被 `Partial<T>` 包裹，则保持原 `?:` 不变，但传参时用展开过滤：

```diff
-  { field: someVar, ...rest }
+  { ...(someVar !== undefined ? { field: someVar } : {}), ...rest }
```

### 模式 4：Zod schema 输出类型与消息接口对齐

```diff
-  type FooMessage = { type: "foo"; bar?: string; baz?: number; }
+  type FooMessage = { type: "foo"; bar: string | undefined; baz: number | undefined; }
```

---

## 附录 B：关键文件路径速查

| 文件 | 用途 | 错误数 |
|---|---|---|
| `packages/agent-daemon/src/types/config.ts` | DaemonConfig 接口 | 1 |
| `packages/agent-daemon/src/types/entities.ts` | 数据实体类型（含大量未使用声明） | 13 |
| `packages/agent-daemon/src/daemon-provider-gateway/types.ts` | Provider 类型定义 | 2 |
| `packages/agent-daemon/src/server-runtime-factory/types.ts` | Runtime factory 类型 | 2 |
| `packages/agent-daemon/src/server-runtime-factory/index.ts` | RuntimeFactory 核心实现 | 22 |
| `packages/agent-daemon/src/server/index.ts` | DaemonServer 核心实现 | 22 |
| `packages/agent-daemon/src/protocol/validators/background.ts` | Protocol background 校验 | 5 |
| `packages/agent-orchestrator/src/orchestrator.ts` | Orchestrator 核心 | 22 |
| `packages/agent-orchestrator/src/event-store.ts` | Event store 实现 | 9 |

---

*文档结束。总计：640 行。*
