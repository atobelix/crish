# Round 6：编排层重构

> **本文件是 Round 6（编排层 agent-orchestrator 重构）的详细设计文档**。
> 遵守 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 包拆分边界、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量约束、禁令 29-31 文档一致性要求。
> 文件映射权威来源：`02-FILE-MAPPING.md` §7。错误码迁移权威来源：`03-ERROR-MIGRATION.md`。本文件不重定义映射，仅引用。
>
> **关键约束**：本 Round 不拆分 `agent-orchestrator`，仅在单包内完成错误体系迁移、日志集成与 TSC 修复。`SessionTree` + `BoundedMap`、`FileOrchestratorEventStore` + 3-Tier Index、`GoalLoopStrategy` + FNV-1a stall 三项成熟资产**保留不重写**。

---

## 1. Round 概述

| 字段         | 内容                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标         | 将 `@crish/agent-orchestrator` 集成新的 `CrishError` 错误体系、`@crish/logger` 日志系统、`@crish/telemetry` span，并修复 TSC 错误                                                                                |
| 目标包       | `@crish/agent-orchestrator`（重构，不拆分）                                                                                                                                                                      |
| 拓扑层       | Layer 6（见 `02-FILE-MAPPING.md` §9.4）                                                                                                                                                                          |
| Agent 数     | 4（满足 `01-OVERVIEW.md` §5.1 ≤ 6 的约束）                                                                                                                                                                       |
| 前置轮次     | Round 5（`agent-core` + legacy shim 已就位；`@crish/logger` / `@crish/telemetry` 已在 R2 创建；`shared-types` 的新 `CrishError` / `CrishResult` / `CrishErrorPayload` / 64 正式码 + 10 reserved 码已在 R1 完成） |
| 后续轮次     | Round 7（`agent-daemon` 依赖 orchestrator 的错误体系；R7 必须串行在 R6 之后）                                                                                                                                    |
| 迁移阶段定位 | 共存阶段已在 R1 完成；R6 属**迁移阶段第一批**（orchestrator 是第一个完成旧码→新码迁移的包），为 R7-R11 提供迁移范式                                                                                              |
| 不拆分依据   | `02-FILE-MAPPING.md` §7 已明确 orchestrator 文件全部保留；`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 不涉及 orchestrator 拆分判定                                                                           |

### 1.1 Round 入口条件（来自 R5 交付物）

| 入口契约                                                                                                             | 来源                                        | 状态                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `CrishError` 扩展构造函数（含 `cause`/`public`/`action`，兼容旧 `code: string`）                                     | `shared-types/src/errors.ts`（R1 共存）     | R5 已验证可用                                  |
| `CrishErrorCode` 联合类型 + `CRISH_ERROR_REGISTRY`（64 正式码 + 10 reserved 码）                                     | `shared-types/src/error-codes.ts`（R1）     | R5 已验证可用                                  |
| `CrishResult<T>` ADT + 9 工具函数（`ok`/`err`/`mapResult`/`flatMapResult`/`match`/`fromPromise`/`promiseResult` 等） | `shared-types/src/result.ts`（R1）          | R5 已验证可用                                  |
| `CrishErrorPayload` + `toErrorPayload` / `fromUnknownError` / `codeFromHttpStatus`                                   | `shared-types/src/error-payload.ts`（R1）   | R5 已验证可用                                  |
| `migrateErrorCode(legacyCode, context?)`                                                                             | `shared-types/src/error-migration.ts`（R1） | R5 已验证可用                                  |
| `@crish/logger`（结构化 Logger + RotatingFileSink + span）                                                           | `@crish/logger`（R2）                       | R5 已验证可用                                  |
| `@crish/telemetry`（TraceManager + AsyncLocalStorage + span API）                                                    | `@crish/telemetry`（R2）                    | R5 已验证可用                                  |
| legacy shim `@crish/agent-runtime` re-export                                                                         | `agent-runtime/src/index.ts`（R5）          | 可继续作为 orchestrator 现有 import 的过渡依赖 |

### 1.2 Round 出口契约（向 R7 交付）

| 出口契约                                        | 内容                                                                                                         | R7 消费方式                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| orchestrator 公共 API 返回 `CrishResult<T>`     | `Orchestrator.startRun` / `dispatchGoal` / `EventStore.append` / `SessionTree.branch` 等                     | daemon 不再 try/catch 裸 Error，按 `result.ok` 分支处理      |
| orchestrator 全部 throw 使用新 `CrishErrorCode` | 旧 `SessionErrorCode` / `ARTIFACT_ERROR` / `INVALID_RUN_STATE` / `NOT_A_GOAL_RUN` 在 orchestrator 范围内归零 | daemon 错误传播层可直接 `toErrorPayload()` 序列化            |
| 结构化日志埋点                                  | session/event-store/goal-strategy 关键路径产出结构化日志（含 `sessionId`/`runId`/`roundIndex`/`errorCode`）  | daemon 的 `@crish/logger` 实例与 orchestrator 共享 transport |
| telemetry span                                  | GoalLoopStrategy stall 检测、event-store append/read 产出 span                                               | daemon 的 OTel 导出器（R10）可聚合 orchestrator span         |

---

## 2. 现有资产清单（保留不拆分）

> 依据 `01-OVERVIEW.md` §1.3 与 `02-FILE-MAPPING.md` §7，以下资产经审计确认为高质量工作代码，Round 6 **保留逻辑、仅迁移错误处理与日志埋点**，不重写。

### 2.1 三项核心成熟资产

| 资产                                        | 文件                                                                                                                                            | 行数（约） | 保留理由                                               | R6 改动范围                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `SessionTree` + `BoundedMap`                | `session-tree.ts`                                                                                                                               | —          | 会话树与有界映射成熟稳定，被 daemon/workbench 直接消费 | 仅迁移 7 处 `throw new SessionError(...)` 到 `throw new CrishError("session.*", ...)`；树结构、平衡算法不动 |
| `FileOrchestratorEventStore` + 3-Tier Index | `event-store.ts` / `event-store/event-indexer.ts` / `event-store/event-storage.ts` / `event-store/event-types.ts` / `event-store-projection.ts` | —          | 事件存储 + 三级索引（内存/索引文件/全量日志）成熟      | 仅在 append/read 失败路径增加 `event_store.*` 错误码与 telemetry span；索引算法不动                         |
| `GoalLoopStrategy` + FNV-1a stall 检测      | `event-scan-goal-strategy.ts` + `task-assessment.ts`                                                                                            | —          | 基于事件流扫描的 goal 循环策略，FNV-1a 进度签名成熟    | 仅在 stall 检测命中处发 telemetry span + `goal.stalled`/`goal.loop_detected` 错误码；评估逻辑不动           |

### 2.2 orchestrator 完整文件清单（全部保留 agent-orchestrator）

依据 `02-FILE-MAPPING.md` §7，agent-orchestrator 共 32 个源文件（含测试），全部保留 `agent-orchestrator`，不迁出。Round 6 在这些文件上做错误体系迁移与日志集成，不新增/删除文件。

| 目录                           | 文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | R6 涉及 Agent         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `src/` 根                      | `index.ts`、`types.ts`、`orchestrator.ts`、`orchestrator.test.ts`、`runtime-engine.ts`、`event-store.ts`、`event-store.test.ts`、`event-store-projection.ts`、`event-scan-goal-strategy.ts`、`session-tree.ts`、`session-tree.test.ts`、`session-summary.ts`、`state-machine.ts`、`state-machine.test.ts`、`state-snapshot.ts`、`epoch-snapshot.ts`、`task-assessment.ts`、`task-assessment.test.ts`、`goal-continuation.ts`、`conversation-rewind.ts`、`conversation-rewind.test.ts`、`artifact-store.ts`、`artifact-store.test.ts`、`protocol.ts`、`protocol.test.ts`、`simple-import-test.test.ts` | 6-A / 6-B / 6-C / 6-D |
| `src/event-store/`             | `event-indexer.ts`、`event-storage.ts`、`event-types.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 6-B / 6-C             |
| `src/orchestrator/`            | `agent-loop.ts`、`task-dispatcher.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 6-A / 6-B             |
| `src/orchestrator/dispatcher/` | `task-executor.ts`、`goal-executor.ts`、`task-queue.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 6-A / 6-C             |
| `src/__tests__/`               | `types.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 6-D                   |

### 2.3 现有依赖（package.json 实证）

```jsonc
// packages/agent-orchestrator/package.json （现状）
"dependencies": {
  "@crish/agent-runtime": "file:../agent-runtime",   // R5 后为 legacy shim
  "@crish/shared-utils": "file:../shared-utils"
}
```

R6 需新增依赖（向 `package.json` 添加）：

| 新增依赖              | 来源                                | 用途                                                                                                              |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@crish/shared-types` | `file:../shared-types`              | `CrishError` / `CrishResult` / `CrishErrorPayload` / `CrishErrorCode`                                             |
| `@crish/logger`       | `file:../shared-utils/../logger`    | 结构化日志替换/新增                                                                                               |
| `@crish/telemetry`    | `file:../shared-utils/../telemetry` | GoalLoopStrategy stall span、EventStore span                                                                      |
| `@crish/agent-core`   | `file:../agent-core`                | 替换 `@crish/agent-runtime`（R5 已就位；R6 完成 import 路径迁移，符合 guardrails 禁令 24 shim 移除时间表 v0.3.0） |

> **legacy shim 迁移**：R6 完成 orchestrator 内 `@crish/agent-runtime` → `@crish/agent-core` 的 import 路径迁移（guardrails 禁令 24 要求 v0.3.0 前完成）。shim 本身不在 R6 删除（删除在 R12），但 orchestrator 不再使用 shim。

---

## 3. Agent 任务详细设计

### 3.0 Agent 编排与文件集不相交验证

| Agent | 主文件集                                                                                                                                                                                                             | 与其他 Agent 相交性                                                          | 协调次数 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| 6-A   | `artifact-store.ts`、`session-tree.ts`、`conversation-rewind.ts`、`orchestrator/agent-loop.ts`、`orchestrator/dispatcher/task-queue.ts`                                                                              | 仅 6-D 修复测试时可能触及 6-A 文件的 `.test.ts`（协调 1 次）                 | ≤ 1      |
| 6-B   | `orchestrator.ts`、`runtime-engine.ts`、`event-store.ts`、`event-store/event-storage.ts`、`event-store/event-types.ts`、`session-summary.ts`、`protocol.ts`                                                          | 与 6-C 在 `event-store/event-indexer.ts` 有 telemetry span 协调（协调 1 次） | ≤ 1      |
| 6-C   | `event-scan-goal-strategy.ts`、`task-assessment.ts`、`goal-continuation.ts`、`state-machine.ts`、`event-store-projection.ts`、`orchestrator/dispatcher/task-executor.ts`、`orchestrator/dispatcher/goal-executor.ts` | 与 6-B 在 EventStore span 有协调（协调 1 次）                                | ≤ 1      |
| 6-D   | 全部 `.test.ts` + `__tests__/types.test.ts` + `index.ts`、`types.ts`（仅类型修正）                                                                                                                                   | 依赖 6-A/6-B/6-C 产出（协调 2 次：接收错误码清单、接收 CrishResult 签名）    | ≤ 2      |

> 文件集不相交验证符合 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28 任务独立性约束。6-D 因属修复型 Agent，需接收前三 Agent 的错误码清单作为输入，协调次数 = 2（上限）。

---

### 3.1 Agent 6-A：EventStore 错误体系升级

**目标**：将 orchestrator 中 `throw new CrishError("ARTIFACT_ERROR", ...)` 迁移到新 `CrishErrorCode`；将 `throw new SessionError(...)` 迁移到 `throw new CrishError("session.*", ...)`；将 `throw new Error(...)` 迁移到 `throw new CrishError(...)`。

**焦点文件**（依据 `03-ERROR-MIGRATION.md` §4.2 实测）：

| 文件                                    | 当前 throw 数                              | 旧码                                                              | 新码（按 §3.1/§3.4 映射）                                                                                                                  |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifact-store.ts`                     | 3（L132/L169/L344）                        | `ARTIFACT_ERROR`                                                  | `artifact.not_found`（L132 blob 未找到）/ `artifact.invalid_uri`（L169 URI 非法）/ `artifact.invalid_uri`（L344 sha256 非法）              |
| `session-tree.ts`                       | 7（L163/L167/L194/L197/L200/L240/L246）    | `SessionErrorCode`（`not_found`/`invalid_state`/`invalid_entry`） | `session.not_found` / `session.invalid_state` / `session.invalid_entry`（按 §3.1 直接映射）                                                |
| `conversation-rewind.ts`                | 2（L161/L252）                             | `throw new Error(...)`                                            | L161 → `session.invalid_state`（rewind target 缺失）；L252 → `store.write_failed`（checkpoint 写入失败，category=transient）               |
| `orchestrator/agent-loop.ts`            | 2 SessionError + 1 ProtocolError + 1 Error | `not_found` / `INVALID_RUN_STATE` / 裸 Error                      | `session.not_found`（L199/L247）/ `run.invalid_state`（L204 ProtocolError）/ `runtime.unexpected_state`（L294 EventStore 不支持 snapshot） |
| `orchestrator/dispatcher/task-queue.ts` | 6 SessionError                             | `not_found` / `invalid_entry` / `invalid_state`                   | `session.not_found`（L22/L56/L77）/ `session.invalid_entry`（L27）/ `session.invalid_state`（L59/L80）                                     |

**迁移规则**（严格遵守 `03-ERROR-MIGRATION.md` §3.1 与 §3.4）：

1. `SessionError` 子类在 R6 共存阶段保留（删除在 R12），但 orchestrator 内不再 `throw new SessionError(...)`，改用 `throw new CrishError(message, "session.xxx", category, retryable)`。
2. `ARTIFACT_ERROR` 按 subcase 拆分（§3.4）：未找到 → `artifact.not_found`；URI/sha256 非法 → `artifact.invalid_uri`。
3. 裸 `throw new Error(...)` 按语义归类（§4.1 热点表）：rewind target 缺失归 `session.invalid_state`；checkpoint 写入失败归 `store.write_failed`；EventStore 能力缺失归 `runtime.unexpected_state`。
4. `migrateErrorCode()` 仅用于运行时兼容（如反序列化旧持久化数据），**不用于源码内 throw 替换**。源码直接写新码。
5. 每处 throw 迁移后，保留原行号附近的注释 `// R6: migrated from ARTIFACT_ERROR -> artifact.not_found`，便于 R12 删除阶段审计。

**额外迁移**：`agent-loop.ts` L294 的 `throw new Error("Event store does not support state snapshots")` 属于"运行时能力缺失"，归 `runtime.unexpected_state`（category=permanent，retryable=false）。

**任务量验证**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28）：

- 文件数：5（artifact-store.ts / session-tree.ts / conversation-rewind.ts / agent-loop.ts / task-queue.ts）— 满足 ≥ 5 文件。
- 行变更：约 25 处 throw 替换 + 注释 + 类型修正 ≈ 80-120 行 — **未达 300 行门槛**。
- 补强：为达到 ≥ 300 行门槛，6-A 同时承担 `artifact-store.test.ts` / `session-tree.test.ts` / `conversation-rewind.test.ts` 的断言更新（assert throw 时校验 `error.code === "artifact.not_found"` 等），合计 ≈ 200 行测试变更，总变更 ≥ 300 行。

**输入**：`03-ERROR-MIGRATION.md` §3.1/§3.4/§4.1/§4.2 + R5 的 `CrishError` 扩展构造函数。
**输出**：5 个源文件 + 3 个测试文件修改，全部 throw 使用新 `CrishErrorCode`。
**验证闭环**：`npx tsc --noEmit -p packages/agent-orchestrator` 错误数 ≤ 基线；`npx vitest run packages/agent-orchestrator` 通过。

---

### 3.2 Agent 6-B：Orchestrator 日志集成 + CrishResult 迁移

**目标**：集成 `@crish/logger` 替换/新增结构化日志；将 orchestrator 公共 API 的 Promise 链错误处理迁移到 `CrishResult<T>` 模式；在关键操作（session 创建/分支/恢复、event append/read）处增加结构化日志。

**焦点文件**：

| 文件                              | 改动内容                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrator.ts`                 | 公共 API（`startRun`/`dispatchGoal`/`createSession` 等）返回类型从 `Promise<T>` 改为 `Promise<CrishResult<T>>`；内部 try/catch 用 `fromPromise()` 转 Result；入口处埋结构化日志（`logger.info("orchestrator.start_run", { runId, sessionId, goal })`） |
| `runtime-engine.ts`               | runtime 装配日志（`logger.debug("runtime_engine.assemble", { components })`）；装配失败用 `runtime.unexpected_state`                                                                                                                                   |
| `event-store.ts`                  | `append` / `read` / `replay` 公共方法返回 `CrishResult`；append 失败用 `event_store.append_failed`；read 失败用 `event_store.read_failed`（见 §4.2 新增码）；埋日志（`logger.debug("event_store.append", { sessionId, eventType, sequence })`）        |
| `event-store/event-storage.ts`    | 底层 storage adapter 的 append/read 失败上抛 `CrishError`，由 `event-store.ts` 转 Result；Windows 文件锁场景（EBUSY/EACCES）用 `store.write_failed` + retryable=true                                                                                   |
| `event-store/event-types.ts`      | 新增 `EventStoreAppendFailure` / `EventStoreReadFailure` 类型别名（基于 `CrishError`），供 6-C 在 indexer 中引用                                                                                                                                       |
| `session-summary.ts`              | summary 生成失败用 `store.read_failed`；埋日志                                                                                                                                                                                                         |
| `protocol.ts`                     | 协议层校验失败用 `run.invalid_state` / `session.invalid_entry`；埋日志                                                                                                                                                                                 |
| `orchestrator/task-dispatcher.ts` | dispatch 失败用 `runtime.transition_failed`；埋日志（`logger.info("task_dispatcher.dispatch", { taskId, runId })`）                                                                                                                                    |

**CrishResult 迁移规则**（依据 `03-ERROR-MIGRATION.md` §5.1 判定规则）：

| 函数类别                                     | 当前签名                             | 迁移后签名                                                     | 理由                                                 |
| -------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| 包导出公共 API（`Orchestrator.startRun` 等） | `Promise<T>`                         | `Promise<CrishResult<T>>`                                      | 公共 API 边界，调用方需显式处理失败（§5.1 判定规则） |
| `EventStore.append` / `read`                 | `Promise<void>` / `Promise<Event[]>` | `Promise<CrishResult<void>>` / `Promise<CrishResult<Event[]>>` | 工具执行类失败是预期分支                             |
| `SessionTree.branch` / `resume`              | `void` / `SessionEntry`              | `CrishResult<SessionEntry>`                                    | 状态机转移类（§5.1）                                 |
| 内部辅助函数（私有校验、纯函数转换）         | `throw`                              | `throw new CrishError(...)`                                    | 内部函数用异常更简洁（§5.1）                         |
| 入参校验（`assertXxx`）                      | `throw`                              | `throw new CrishError(...)`                                    | 校验失败是编程错误（§5.1）                           |

**日志集成规则**：

1. orchestrator 在 R6 入口接收一个 `Logger` 实例（通过 `RuntimeComponents.logger` 或构造函数注入），不自行 `createLogger`。
2. 日志级别约定：`logger.debug` 用于 append/read/dispatch 等高频路径；`logger.info` 用于 session/run 生命周期；`logger.warn` 用于 transient 错误（如 `store.write_failed` retryable=true）；`logger.error` 用于 permanent 错误。
3. 结构化字段约定：所有日志必须含 `sessionId`/`runId`（若适用），错误日志必须含 `errorCode`/`category`/`retryable`。
4. 不引入 `console.*`（当前 orchestrator 无 console.* 调用，R6 保持为零）。
5. Windows 文件锁场景的日志必须含 `errno`/`path` 字段，便于 R10 Rust 端对齐诊断。

**任务量验证**：

- 文件数：8（orchestrator.ts / runtime-engine.ts / event-store.ts / event-store/event-storage.ts / event-store/event-types.ts / session-summary.ts / protocol.ts / task-dispatcher.ts）— 满足 ≥ 5 文件。
- 行变更：CrishResult 签名迁移 + 日志埋点 ≈ 350-450 行 — 满足 ≥ 300 行。

**输入**：`03-ERROR-MIGRATION.md` §5（CrishResult 策略）+ R2 的 `@crish/logger` API + R5 的 `agent-core` `RuntimeComponents.logger` 契约。
**输出**：8 个源文件修改，公共 API 返回 `CrishResult`，关键路径埋结构化日志。
**验证闭环**：`npx tsc --noEmit` 错误数 ≤ 基线；`npx vitest run` 通过（6-D 同步更新测试）；depcruise 0 violations（不引入新循环依赖）。

---

### 3.3 Agent 6-C：Goal Strategy + State Machine 错误传播

**目标**：`GoalLoopStrategy` 的 stall 检测使用新的 telemetry span；State Machine 的状态转换错误使用 `CrishError`（新错误码 `goal.stalled` / `goal.loop_detected`）；事件存储失败使用新错误码（`event_store.append_failed` / `event_store.read_failed`）。

**前置动作（系统性改进，非补丁）**：

> **问题**：本 Round 任务要求使用 `goal.stalled` / `goal.loop_detected` / `event_store.read_failed` 三个新错误码，但 `03-ERROR-MIGRATION.md` §2.2 权威注册表当前仅有 `event_store.append_failed` / `event_store.consistency_violation`，且无 `goal.*` 域。
>
> **系统性解决方案**：R6 开始前，由 6-C 执行**权威注册表扩展**（更新 `03-ERROR-MIGRATION.md` §2.2 + `shared-types/src/error-codes.ts` 的 `CrishErrorCode` 联合类型与 `CRISH_ERROR_REGISTRY`），新增 1 个域 + 3 个码。这是"系统化改进"而非"补丁式映射到现有码"——goal 循环的 stalled 与 loop_detected 在语义上与 `agent.no_progress` 不同（前者是 FNV-1a 签名不变检测，后者是泛化无进展），强行复用会污染错误码语义。

**注册表扩展清单**（更新 `03-ERROR-MIGRATION.md` §2.2 + `shared-types/src/error-codes.ts`）：

新增 `goal` 域（3 码）：

| 码值                 | title             | category  | retryable | public | action                            |
| -------------------- | ----------------- | --------- | --------- | ------ | --------------------------------- |
| `goal.stalled`       | Goal 循环停滞     | permanent | false     | true   | `action.goal.review_progress`     |
| `goal.loop_detected` | Goal 循环签名重复 | permanent | false     | true   | `action.goal.break_loop`          |
| `goal.max_rounds`    | Goal 达到最大轮次 | permanent | false     | true   | `action.goal.increase_max_rounds` |

新增 `event_store` 域补码（1 码，原 2 码保留）：

| 码值                      | title        | category  | retryable | public | action                          |
| ------------------------- | ------------ | --------- | --------- | ------ | ------------------------------- |
| `event_store.read_failed` | 事件读取失败 | transient | true      | false  | `action.event_store.retry_read` |

**扩展后码数**：60 + 4 = **64 码 / 19 域**。`03-ERROR-MIGRATION.md` §2.2 标题同步更新为"64 码 / 19 域"。

**焦点文件**：

| 文件                                       | 改动内容                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-scan-goal-strategy.ts`              | `computeProgressSignature` 命中 stall 时（FNV-1a 签名与前一轮相同）开 telemetry span `goal.stall_detect` + 抛 `goal.stalled`；连续 N 轮签名重复时抛 `goal.loop_detected`；span 字段：`roundIndex`/`progressSignature`/`consecutiveStallCount` |
| `task-assessment.ts`                       | `assessGoalRound` 评估结果为 stalled 时返回带 `goal.stalled` 码的 `CrishError`；max rounds 达到时返回 `goal.max_rounds`                                                                                                                       |
| `goal-continuation.ts`                     | continuation 决策失败用 `goal.stalled` / `goal.loop_detected`；决策日志埋点（与 6-B 协调 logger 实例）                                                                                                                                        |
| `state-machine.ts`                         | L93 `throw new Error("Invalid run status transition...")` → `throw new CrishError(msg, "runtime.transition_failed", "permanent", false)`；状态转换失败埋 telemetry span `state_machine.transition`                                            |
| `event-store-projection.ts`                | projection 重建失败用 `event_store.read_failed`（transient）或 `event_store.consistency_violation`（permanent，索引与日志不一致）；埋 span `event_store.project`                                                                              |
| `orchestrator/dispatcher/task-executor.ts` | L323 `throw new ProtocolError(..., "INVALID_RUN_STATE")` → `throw new CrishError(msg, "run.invalid_state", "protocol", false)`                                                                                                                |
| `orchestrator/dispatcher/goal-executor.ts` | L379 `throw new ProtocolError(..., "NOT_A_GOAL_RUN")` → `throw new CrishError(msg, "run.not_goal_run", "protocol", false)`                                                                                                                    |

**telemetry span 设计**（使用 `@crish/telemetry` 的 `TraceManager.startSpan`）：

| span 名                    | 触发点                                    | 字段                                                                        | 用途                         |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| `goal.stall_detect`        | `computeProgressSignature` 检测到签名不变 | `roundIndex`/`progressSignature`/`consecutiveStallCount`/`goalRunId`        | R10 OTel 导出聚合 stall 模式 |
| `goal.round_assess`        | `assessGoalRound` 完成                    | `roundIndex`/`decision`/`progressSignature`/`eventCount`                    | 评估耗时分布                 |
| `state_machine.transition` | 状态转换失败                              | `from`/`to`/`reason`                                                        | 转换失败模式分析             |
| `event_store.append`       | `EventStore.append` 完成（含失败）        | `sessionId`/`eventType`/`sequence`/`success`/`durationMs`                   | append 性能与失败率          |
| `event_store.read`         | `EventStore.read` 完成（含失败）          | `sessionId`/`fromSequence`/`toSequence`/`eventCount`/`success`/`durationMs` | read 性能与失败率            |
| `event_store.project`      | projection 重建                           | `sessionId`/`eventsProjected`/`consistencyViolation`                        | 索引一致性监控               |

**与 6-B 的协调契约**：

- 6-C 在 `event-store/event-indexer.ts` 中引用 6-B 新增的 `EventStoreReadFailure` / `EventStoreAppendFailure` 类型别名（6-B 在 `event-store/event-types.ts` 定义）。
- 6-C 在 `event-store-projection.ts` 中使用 6-B 注入的 `Logger` 实例（通过 `EventStore` 构造函数传入）。
- 协调次数 = 1（一次性对齐类型别名与 logger 注入方式）。

**任务量验证**：

- 文件数：7（event-scan-goal-strategy.ts / task-assessment.ts / goal-continuation.ts / state-machine.ts / event-store-projection.ts / task-executor.ts / goal-executor.ts）+ 1 个权威文档更新（`03-ERROR-MIGRATION.md`）+ 1 个 shared-types 文件（`error-codes.ts`）— 满足 ≥ 5 文件。
- 行变更：注册表扩展 + 7 文件 throw 迁移 + 6 个 span 埋点 ≈ 320-400 行 — 满足 ≥ 300 行。

**输入**：`03-ERROR-MIGRATION.md` §2.2/§3.4/§4.1/§4.2 + R2 的 `@crish/telemetry` span API + R5 的 `agent-core` `RuntimeComponents.telemetry` 契约。
**输出**：7 个源文件修改 + `shared-types/src/error-codes.ts` 扩展 + `03-ERROR-MIGRATION.md` §2.2 扩展。
**验证闭环**：`npx tsc --noEmit` 错误数 ≤ 基线；`npx vitest run` 通过；depcruise 0 violations。

---

### 3.4 Agent 6-D：Orchestrator TSC 修复 + 测试更新

**目标**：修复 orchestrator 的 TSC 错误（不恶化基线）；更新 orchestrator 的测试以适配新的错误类型；运行 vitest 验证测试通过。

**焦点文件**：

| 文件                          | 改动内容                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `artifact-store.test.ts`      | 断言更新：`expect(() => store.readBytes("xxx")).rejects.toThrow(CrishError)` + `expect(error.code).toBe("artifact.not_found")` |
| `session-tree.test.ts`        | 断言更新：7 处 SessionError throw 的测试改为校验 `CrishError` + `session.*` 码                                                 |
| `conversation-rewind.test.ts` | 断言更新：2 处 throw new Error 测试改为校验 `CrishError` + `session.invalid_state` / `store.write_failed`                      |
| `event-store.test.ts`         | 断言更新：append/read 失败测试改为校验 `CrishResult.err` + `event_store.*` 码                                                  |
| `state-machine.test.ts`       | 断言更新：状态转换失败测试改为校验 `runtime.transition_failed`                                                                 |
| `task-assessment.test.ts`     | 断言更新：stall 检测测试改为校验 `goal.stalled` / `goal.loop_detected`                                                         |
| `orchestrator.test.ts`        | 公共 API 返回 `CrishResult` 的测试：`expect(result.ok).toBe(true)` / `expect(result.error.code).toBe(...)`                     |
| `protocol.test.ts`            | 协议校验失败测试改为校验 `run.invalid_state` / `session.invalid_entry`                                                         |
| `__tests__/types.test.ts`     | 类型断言更新：`CrishResult<T>` 类型推导、`CrishError` 子类型缩窄                                                               |
| `simple-import-test.test.ts`  | import 路径迁移验证：`@crish/agent-runtime` → `@crish/agent-core`                                                              |
| `index.ts`                    | barrel 导出新增 `CrishResult` / `CrishError` 相关类型（若 6-B/6-C 新增了公共类型）                                             |
| `types.ts`                    | 类型修正：`exactOptionalPropertyTypes` 相关的 `undefined` 显式标注（TS2375/TS2379 高频错误）                                   |

**TSC 修复策略**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26 不恶化原则）：

1. **基线记录**：R6 开始时运行 `npx tsc --noEmit -p packages/agent-orchestrator > tsc-errors-baseline-r6.json`，记录当前错误数作为基线。
2. **不恶化门禁**：R6 结束时 TSC 错误数 ≤ R6 基线。**不承诺清零**（完全清零推迟到 R11 后）。
3. **错误分类修复**（按 `01-OVERVIEW.md` §1.2 错误类型分布）：
   - `TS2375`/`TS2379`（exactOptionalPropertyTypes）：在 `types.ts` / `event-store/event-types.ts` 等类型定义处显式标注 `| undefined`。
   - `TS2532`/`TS18048`（uncheckedIndex）：在 `session-tree.ts` / `task-queue.ts` 等数组/Map 访问处增加 `?.` 或显式 `if (x === undefined) throw`。
   - `TS6133`/`TS6192`（unused）：删除未使用的 import（R6 迁移过程中产生的未使用旧 import 必须清理）。
   - `TS2307`/`TS2305`（missing module）：`@crish/agent-runtime` → `@crish/agent-core` 迁移导致的模块解析失败，由 6-D 统一修正 import 路径。
   - `TS1484`（verbatimModuleSyntax）：`import type` 显式标注（6-A/6-B/6-C 新增的 `CrishError`/`CrishResult` 类型 import 必须用 `import type`）。
4. **不引入新错误**：6-D 在修复测试断言时，若发现 6-A/6-B/6-C 引入的新 TSC 错误，反馈给对应 Agent 修正（协调次数 = 2）。

**vitest 验证策略**：

```bash
# R6 验证命令
npx vitest run packages/agent-orchestrator --coverage
```

通过标准：

- 全部测试通过（0 failures）。
- 覆盖率不下降（对比 R5 末 orchestrator 覆盖率基线，stmt ≥ 70%）。
- 若 6-A/6-B/6-C 的新断言导致测试失败，6-D 负责修正测试逻辑（不改被测代码）。

**任务量验证**：

- 文件数：12（含 9 个 `.test.ts` + `index.ts` + `types.ts` + `simple-import-test.test.ts`）— 满足 ≥ 5 文件。
- 行变更：测试断言迁移 + TSC 修复 ≈ 350-500 行 — 满足 ≥ 300 行。

**输入**：6-A/6-B/6-C 的错误码清单与 `CrishResult` 签名 + R5 末 TSC 基线。
**输出**：12 个文件修改 + 验证报告（`round-06-verification-report.md`，含 TSC 基线对比、vitest 结果、覆盖率对比）。
**验证闭环**：`npx tsc --noEmit` 错误数 ≤ 基线；`npx vitest run` 全部通过；`npm run lint` 0 errors；`npm run check:store-types` 通过。

---

## 4. 错误码迁移清单（引用 03-ERROR-MIGRATION.md）

### 4.1 orchestrator 旧码→新码完整迁移表

> 依据 `03-ERROR-MIGRATION.md` §3.1（SessionErrorCode）、§3.4（自由字符串码）、§4.1/§4.2（throw 清单）。本表为 orchestrator 范围内的实证清单（共 25 处 throw），与 `03-ERROR-MIGRATION.md` §4.3 R6 行（25 处）一致。

| 文件                                       | 行  | 旧 throw                                            | 旧码                | 新码                        | category  | retryable | 负责 Agent |
| ------------------------------------------ | --- | --------------------------------------------------- | ------------------- | --------------------------- | --------- | --------- | ---------- |
| `artifact-store.ts`                        | 132 | `throw new CrishError(..., "ARTIFACT_ERROR", ...)`  | `ARTIFACT_ERROR`    | `artifact.not_found`        | permanent | false     | 6-A        |
| `artifact-store.ts`                        | 169 | `throw new CrishError(..., "ARTIFACT_ERROR", ...)`  | `ARTIFACT_ERROR`    | `artifact.invalid_uri`      | protocol  | false     | 6-A        |
| `artifact-store.ts`                        | 344 | `throw new CrishError(..., "ARTIFACT_ERROR", ...)`  | `ARTIFACT_ERROR`    | `artifact.invalid_uri`      | protocol  | false     | 6-A        |
| `session-tree.ts`                          | 163 | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `session-tree.ts`                          | 167 | `throw new SessionError(..., "invalid_state")`      | `invalid_state`     | `session.invalid_state`     | permanent | false     | 6-A        |
| `session-tree.ts`                          | 194 | `throw new SessionError(..., "invalid_entry")`      | `invalid_entry`     | `session.invalid_entry`     | permanent | false     | 6-A        |
| `session-tree.ts`                          | 197 | `throw new SessionError(..., "invalid_state")`      | `invalid_state`     | `session.invalid_state`     | permanent | false     | 6-A        |
| `session-tree.ts`                          | 200 | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `session-tree.ts`                          | 240 | `throw new SessionError(..., "invalid_entry")`      | `invalid_entry`     | `session.invalid_entry`     | permanent | false     | 6-A        |
| `session-tree.ts`                          | 246 | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `conversation-rewind.ts`                   | 161 | `throw new Error(...)`                              | —                   | `session.invalid_state`     | permanent | false     | 6-A        |
| `conversation-rewind.ts`                   | 252 | `throw new Error(...)`                              | —                   | `store.write_failed`        | transient | true      | 6-A        |
| `orchestrator/agent-loop.ts`               | 199 | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `orchestrator/agent-loop.ts`               | 204 | `throw new ProtocolError(..., "INVALID_RUN_STATE")` | `INVALID_RUN_STATE` | `run.invalid_state`         | protocol  | false     | 6-A        |
| `orchestrator/agent-loop.ts`               | 247 | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `orchestrator/agent-loop.ts`               | 294 | `throw new Error(...)`                              | —                   | `runtime.unexpected_state`  | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 22  | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 27  | `throw new SessionError(..., "invalid_entry")`      | `invalid_entry`     | `session.invalid_entry`     | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 56  | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 59  | `throw new SessionError(..., "invalid_state")`      | `invalid_state`     | `session.invalid_state`     | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 77  | `throw new SessionError(..., "not_found")`          | `not_found`         | `session.not_found`         | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-queue.ts`    | 80  | `throw new SessionError(..., "invalid_state")`      | `invalid_state`     | `session.invalid_state`     | permanent | false     | 6-A        |
| `orchestrator/dispatcher/task-executor.ts` | 323 | `throw new ProtocolError(..., "INVALID_RUN_STATE")` | `INVALID_RUN_STATE` | `run.invalid_state`         | protocol  | false     | 6-C        |
| `orchestrator/dispatcher/goal-executor.ts` | 379 | `throw new ProtocolError(..., "NOT_A_GOAL_RUN")`    | `NOT_A_GOAL_RUN`    | `run.not_goal_run`          | protocol  | false     | 6-C        |
| `state-machine.ts`                         | 93  | `throw new Error(...)`                              | —                   | `runtime.transition_failed` | permanent | false     | 6-C        |

**迁移后旧码在 orchestrator 范围内归零**：`ARTIFACT_ERROR`（0）、`SessionErrorCode` 5 码（0）、`INVALID_RUN_STATE`（0）、`NOT_A_GOAL_RUN`（0）、裸 `throw new Error`（0）。

### 4.2 R6 新增错误码（权威注册表扩展）

> 依据 §3.3 的系统性改进：R6 由 6-C 执行 `03-ERROR-MIGRATION.md` §2.2 权威注册表扩展。扩展后 `03-ERROR-MIGRATION.md` §2.2 标题更新为"64 码 / 19 域"，`shared-types/src/error-codes.ts` 的 `CrishErrorCode` 联合类型与 `CRISH_ERROR_REGISTRY` 同步扩展。

| 新码                      | 域                  | category  | retryable | public | action                            | 触发场景                                            |
| ------------------------- | ------------------- | --------- | --------- | ------ | --------------------------------- | --------------------------------------------------- |
| `goal.stalled`            | goal（新域）        | permanent | false     | true   | `action.goal.review_progress`     | FNV-1a 进度签名连续 N 轮不变                        |
| `goal.loop_detected`      | goal（新域）        | permanent | false     | true   | `action.goal.break_loop`          | 进度签名循环重复（A→B→A 模式）                      |
| `goal.max_rounds`         | goal（新域）        | permanent | false     | true   | `action.goal.increase_max_rounds` | goal run 达到 maxRounds 上限                        |
| `event_store.read_failed` | event_store（补码） | transient | true      | false  | `action.event_store.retry_read`   | EventStore.read 底层 IO 失败（非 consistency 违规） |

**与现有码的边界**：

- `goal.stalled` vs `agent.no_progress`：前者是 FNV-1a 签名级检测（确定性），后者是泛化无进展（可能含 LLM 输出质量下降等模糊判定）。orchestrator 的 `GoalLoopStrategy` 用 `goal.stalled`；agent-core 的 SessionLoop 用 `agent.no_progress`。
- `event_store.read_failed` vs `event_store.consistency_violation`：前者是 transient IO 失败（可重试），后者是 permanent 索引与日志不一致（需重建索引）。
- `goal.max_rounds` vs `agent.max_turns_reached`：前者是 goal 循环的轮次上限（orchestrator 域），后者是 agent 单次 turn 的上限（agent-core 域）。

### 4.3 迁移阶段定位

依据 `03-ERROR-MIGRATION.md` §7.2 迁移阶段表，R6 是 orchestrator 包的迁移执行点：

| Round | 包                 | 迁移 throw 数 | 关键迁移项                                                                                                                                                                                 |
| ----- | ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R6    | agent-orchestrator | 25            | `SessionError` 5 码→`session.*`；`INVALID_RUN_STATE`→`run.invalid_state`；`NOT_A_GOAL_RUN`→`run.not_goal_run`；`ARTIFACT_ERROR`→`artifact.*`；新增 `goal.*` 域 + `event_store.read_failed` |

**共存阶段约束**（依据 `03-ERROR-MIGRATION.md` §7.1）：

- `SessionError` / `ProtocolError` 子类在 R6 共存阶段保留（删除在 R12）。
- `migrateErrorCode()` 函数保留，用于 R7 daemon 反序列化旧持久化数据时的兼容。
- orchestrator 源码内不再 `throw new SessionError(...)`，但 `SessionError` 类仍可被 import（用于 catch 旧错误的边界，如 daemon 反序列化）。

---

## 5. 日志集成设计

### 5.1 Logger 注入策略

orchestrator 不自行创建 Logger 实例，通过依赖注入接收。注入路径：

```
agent-daemon (R7)
  └── 创建 Logger 实例（@crish/logger，含 RotatingFileSink + console Sink）
      └── 传入 RuntimeComponents.logger
          └── agent-core (R5) 的 RuntimeComponents
              └── 传入 Orchestrator 构造函数
                  └── Orchestrator 内部组件（EventStore / GoalLoopStrategy / SessionTree）通过构造函数链接收
```

**注入契约**（R6 在 `types.ts` 扩展）：

```ts
// packages/agent-orchestrator/src/types.ts （R6 新增）
import type { Logger } from '@crish/logger';
import type { TraceManager } from '@crish/telemetry';

export interface OrchestratorDeps {
  readonly logger: Logger;
  readonly telemetry: TraceManager;
  // ... 现有字段
}
```

### 5.2 结构化日志字段约定

所有 orchestrator 日志必须遵守以下字段约定（便于 R10 OTel 导出与 R12 日志聚合）：

| 字段         | 类型    | 必填                         | 说明                                          |
| ------------ | ------- | ---------------------------- | --------------------------------------------- |
| `sessionId`  | string  | 条件必填（session 相关操作） | 会话 ID                                       |
| `runId`      | string  | 条件必填（run 相关操作）     | Run ID                                        |
| `roundIndex` | number  | 条件必填（goal 循环操作）    | 当前轮次索引                                  |
| `errorCode`  | string  | 错误日志必填                 | `CrishErrorCode`                              |
| `category`   | string  | 错误日志必填                 | `transient`/`permanent`/`security`/`protocol` |
| `retryable`  | boolean | 错误日志必填                 | 是否可重试                                    |
| `durationMs` | number  | 性能日志必填                 | 操作耗时                                      |
| `errno`      | string  | Windows 文件锁场景           | `EBUSY`/`EACCES` 等                           |
| `path`       | string  | 文件操作场景                 | 受影响的文件路径                              |

### 5.3 日志埋点清单

| 路径                           | 级别  | 消息                              | 字段                                                     | 负责 Agent |
| ------------------------------ | ----- | --------------------------------- | -------------------------------------------------------- | ---------- |
| `Orchestrator.startRun` 入口   | info  | `orchestrator.start_run`          | `runId`/`sessionId`/`goal`                               | 6-B        |
| `Orchestrator.startRun` 出口   | info  | `orchestrator.run_started`        | `runId`/`durationMs`                                     | 6-B        |
| `Orchestrator.createSession`   | info  | `orchestrator.session_created`    | `sessionId`/`parentId`                                   | 6-B        |
| `SessionTree.branch`           | info  | `session_tree.branch`             | `sessionId`/`leafId`/`abandonedLeafId`                   | 6-B        |
| `SessionTree.resume`           | info  | `session_tree.resume`             | `sessionId`/`leafId`                                     | 6-B        |
| `EventStore.append` 成功       | debug | `event_store.append`              | `sessionId`/`eventType`/`sequence`/`durationMs`          | 6-B        |
| `EventStore.append` 失败       | warn  | `event_store.append_failed`       | `sessionId`/`eventType`/`errorCode`/`errno`              | 6-B        |
| `EventStore.read` 成功         | debug | `event_store.read`                | `sessionId`/`fromSeq`/`toSeq`/`eventCount`/`durationMs`  | 6-B        |
| `EventStore.read` 失败         | warn  | `event_store.read_failed`         | `sessionId`/`errorCode`/`errno`                          | 6-B        |
| `GoalLoopStrategy.assessRound` | debug | `goal.round_assess`               | `roundIndex`/`decision`/`progressSignature`              | 6-C        |
| `GoalLoopStrategy` stall 命中  | error | `goal.stalled`                    | `roundIndex`/`progressSignature`/`consecutiveStallCount` | 6-C        |
| `GoalLoopStrategy` loop 命中   | error | `goal.loop_detected`              | `roundIndex`/`progressSignature`                         | 6-C        |
| `StateMachine.transition` 失败 | error | `state_machine.transition_failed` | `from`/`to`/`errorCode`                                  | 6-C        |
| `TaskDispatcher.dispatch`      | info  | `task_dispatcher.dispatch`        | `taskId`/`runId`/`dispatchedTo`                          | 6-B        |

### 5.4 日志级别策略

| 级别    | 使用场景                   | 示例                                                              |
| ------- | -------------------------- | ----------------------------------------------------------------- |
| `debug` | 高频路径、详细诊断         | event append/read、goal round assess                              |
| `info`  | 生命周期事件、关键操作     | session create/branch/resume、run start                           |
| `warn`  | transient 错误（可重试）   | `store.write_failed` retryable=true、`event_store.append_failed`  |
| `error` | permanent 错误（不可重试） | `goal.stalled`、`runtime.transition_failed`、`artifact.not_found` |

**禁止**：

- 禁止在 orchestrator 内使用 `console.*`（保持当前零状态）。
- 禁止在 `debug` 级别记录完整事件 payload（可能含敏感数据，由 `@crish/logger` 的 LogSanitizer 统一脱敏）。
- 禁止在 hot path（如 `EventStore.append`）记录 `info` 级别（高频路径只用 `debug`）。

---

## 6. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，R6 结束前必须通过以下 8 项检查。

### 6.1 验证门禁清单

| 检查项           | 命令                                                     | 通过标准                                 | 负责 Agent |
| ---------------- | -------------------------------------------------------- | ---------------------------------------- | ---------- |
| TypeScript 编译  | `npx tsc --noEmit -p packages/agent-orchestrator`        | 错误数 ≤ R6 基线（不恶化，禁令 26）      | 6-D        |
| Rust 编译        | `cargo check --workspace`                                | 0 errors（R6 不涉及 Rust，仅验证未破坏） | 6-D        |
| 单元测试（TS）   | `npx vitest run packages/agent-orchestrator`             | 全部通过                                 | 6-D        |
| 单元测试（Rust） | `cargo test --workspace`                                 | 全部通过（R6 不涉及 Rust）               | 6-D        |
| 循环依赖         | `npm run lint:depcruise`                                 | 0 violations（保持 R5 末 0 状态）        | 6-D        |
| 构建             | `npx turbo run build --filter=@crish/agent-orchestrator` | 成功                                     | 6-D        |
| Lint             | `npm run lint --workspace=@crish/agent-orchestrator`     | 0 errors                                 | 6-D        |
| Store 类型       | `npm run check:store-types`                              | 通过                                     | 6-D        |

### 6.2 额外验证项（R6 专属）

| 验证项                   | 命令                                                                                                                                | 通过标准                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 旧码归零                 | `grep -rE "throw new (SessionError                                                                                                  | ProtocolError)\(" packages/agent-orchestrator/src --include="*.ts" \| grep -v ".test.ts"` | 0 匹配（orchestrator 源码不再 throw SessionError/ProtocolError） |
| 旧 ARTIFACT_ERROR 归零   | `grep -rE "\"ARTIFACT_ERROR\"" packages/agent-orchestrator/src`                                                                     | 0 匹配                                                                                    |
| 旧 SessionErrorCode 归零 | `grep -rE "SessionErrorCode" packages/agent-orchestrator/src --include="*.ts" \| grep -v ".test.ts"`                                | 0 匹配（测试文件允许残留，由 R12 清理）                                                   |
| 裸 throw new Error 归零  | `grep -rE "throw new Error\(" packages/agent-orchestrator/src --include="*.ts" \| grep -v ".test.ts"`                               | 0 匹配                                                                                    |
| legacy shim import 迁移  | `grep -rE "@crish/agent-runtime" packages/agent-orchestrator/src`                                                                   | 0 匹配（全部迁移到 `@crish/agent-core`）                                                  |
| 新错误码注册             | `grep -E "goal\.stalled\|goal\.loop_detected\|goal\.max_rounds\|event_store\.read_failed" packages/shared-types/src/error-codes.ts` | 4 匹配（新码已注册）                                                                      |
| CrishResult 公共 API     | `grep -rE "Promise<CrishResult" packages/agent-orchestrator/src --include="*.ts" \| grep -v ".test.ts"`                             | ≥ 5 匹配（公共 API 已迁移）                                                               |

### 6.3 基线记录要求

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26，R6 开始时必须记录基线：

```bash
# R6 开始时执行
npx tsc --noEmit -p packages/agent-orchestrator 2>&1 | tee analysis/iterative-repair/v2/baselines/r6-tsc-baseline.json
npx vitest run packages/agent-orchestrator --coverage 2>&1 | tee analysis/iterative-repair/v2/baselines/r6-coverage-baseline.json
```

R6 结束时与基线对比，生成 `analysis/iterative-repair/v2/reports/round-06-verification-report.md`。

---

## 7. 交付物

### 7.1 文件级交付物清单

| 文件                                                                       | 改动类型                    | 负责 Agent | 验证方式            |
| -------------------------------------------------------------------------- | --------------------------- | ---------- | ------------------- |
| `packages/agent-orchestrator/src/artifact-store.ts`                        | 迁移（3 throw）             | 6-A        | grep 旧码归零 + tsc |
| `packages/agent-orchestrator/src/session-tree.ts`                          | 迁移（7 throw）             | 6-A        | grep 旧码归零 + tsc |
| `packages/agent-orchestrator/src/conversation-rewind.ts`                   | 迁移（2 throw）             | 6-A        | grep 旧码归零 + tsc |
| `packages/agent-orchestrator/src/orchestrator/agent-loop.ts`               | 迁移（4 throw）             | 6-A        | grep 旧码归零 + tsc |
| `packages/agent-orchestrator/src/orchestrator/dispatcher/task-queue.ts`    | 迁移（6 throw）             | 6-A        | grep 旧码归零 + tsc |
| `packages/agent-orchestrator/src/artifact-store.test.ts`                   | 测试更新                    | 6-A        | vitest 通过         |
| `packages/agent-orchestrator/src/session-tree.test.ts`                     | 测试更新                    | 6-A        | vitest 通过         |
| `packages/agent-orchestrator/src/conversation-rewind.test.ts`              | 测试更新                    | 6-A        | vitest 通过         |
| `packages/agent-orchestrator/src/orchestrator.ts`                          | CrishResult + 日志          | 6-B        | tsc + vitest        |
| `packages/agent-orchestrator/src/runtime-engine.ts`                        | CrishResult + 日志          | 6-B        | tsc + vitest        |
| `packages/agent-orchestrator/src/event-store.ts`                           | CrishResult + 日志          | 6-B        | tsc + vitest        |
| `packages/agent-orchestrator/src/event-store/event-storage.ts`             | 错误上抛 + 日志             | 6-B        | tsc + vitest        |
| `packages/agent-orchestrator/src/event-store/event-types.ts`               | 新增类型别名                | 6-B        | tsc                 |
| `packages/agent-orchestrator/src/session-summary.ts`                       | 日志                        | 6-B        | tsc                 |
| `packages/agent-orchestrator/src/protocol.ts`                              | 日志                        | 6-B        | tsc + vitest        |
| `packages/agent-orchestrator/src/orchestrator/task-dispatcher.ts`          | 日志                        | 6-B        | tsc                 |
| `packages/agent-orchestrator/src/event-scan-goal-strategy.ts`              | stall span + 新码           | 6-C        | tsc + vitest        |
| `packages/agent-orchestrator/src/task-assessment.ts`                       | stall 新码                  | 6-C        | tsc + vitest        |
| `packages/agent-orchestrator/src/goal-continuation.ts`                     | 新码 + 日志                 | 6-C        | tsc                 |
| `packages/agent-orchestrator/src/state-machine.ts`                         | 迁移（1 throw）+ span       | 6-C        | tsc + vitest        |
| `packages/agent-orchestrator/src/event-store-projection.ts`                | 新码 + span                 | 6-C        | tsc                 |
| `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts` | 迁移（1 throw）             | 6-C        | tsc                 |
| `packages/agent-orchestrator/src/orchestrator/dispatcher/goal-executor.ts` | 迁移（1 throw）             | 6-C        | tsc                 |
| `packages/shared-types/src/error-codes.ts`                                 | 扩展（+4 码）               | 6-C        | tsc                 |
| `analysis/iterative-repair/v2/03-ERROR-MIGRATION.md`                       | 扩展（§2.2 +4 码）          | 6-C        | 文档审查            |
| `packages/agent-orchestrator/src/event-store.test.ts`                      | 测试更新                    | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/state-machine.test.ts`                    | 测试更新                    | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/task-assessment.test.ts`                  | 测试更新                    | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/orchestrator.test.ts`                     | 测试更新                    | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/protocol.test.ts`                         | 测试更新                    | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/__tests__/types.test.ts`                  | 类型断言更新                | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/simple-import-test.test.ts`               | import 迁移验证             | 6-D        | vitest 通过         |
| `packages/agent-orchestrator/src/index.ts`                                 | barrel 导出                 | 6-D        | tsc                 |
| `packages/agent-orchestrator/src/types.ts`                                 | 类型修正 + OrchestratorDeps | 6-D        | tsc                 |
| `packages/agent-orchestrator/package.json`                                 | 依赖新增                    | 6-D        | npm install 通过    |

### 7.2 接口签名交付物（向 R7 传递）

```ts
// 1. 公共 API 返回 CrishResult（6-B 产出）
export interface Orchestrator {
  startRun(input: StartRunInput): Promise<CrishResult<RunHandle>>;
  dispatchGoal(input: DispatchGoalInput): Promise<CrishResult<GoalRunHandle>>;
  createSession(input: CreateSessionInput): Promise<CrishResult<SessionHandle>>;
}

// 2. EventStore 公共 API（6-B 产出）
export interface FileOrchestratorEventStore {
  append(event: AgentEvent): Promise<CrishResult<void>>;
  read(from: number, to?: number): Promise<CrishResult<AgentEvent[]>>;
  replay(sessionId: string): Promise<CrishResult<AgentEvent[]>>;
}

// 3. SessionTree 公共 API（6-A 产出，6-B 转 Result）
export interface SessionTree {
  branch(input: BranchInput): CrishResult<SessionEntry>;
  resume(leafId: string): CrishResult<SessionEntry>;
}

// 4. OrchestratorDeps 注入契约（6-B 产出）
export interface OrchestratorDeps {
  readonly logger: Logger;
  readonly telemetry: TraceManager;
  // ... 现有字段
}

// 5. 新增错误码（6-C 产出，注册到 shared-types）
export type CrishErrorCode =
  | ... // 现有 64 正式码 + 10 reserved 码
  | "goal.stalled"
  | "goal.loop_detected"
  | "goal.max_rounds"
  | "event_store.read_failed";
```

### 7.3 验证报告交付物

`analysis/iterative-repair/v2/reports/round-06-verification-report.md` 内容结构：

```markdown
# Round 6 验证报告

## 1. TSC 基线对比

- R6 开始基线：N 个错误
- R6 结束实测：M 个错误（M ≤ N）
- 错误分类变化：...

## 2. vitest 结果

- 测试总数：X
- 通过：Y
- 失败：0
- 覆盖率：stmt Z%（对比 R5 末基线 W%，变化 = Z - W）

## 3. 旧码归零验证

- throw new SessionError：0 匹配（源码）
- throw new ProtocolError：0 匹配（源码）
- "ARTIFACT_ERROR"：0 匹配
- throw new Error：0 匹配（源码）
- @crish/agent-runtime import：0 匹配

## 4. 新错误码注册验证

- goal.stalled：已注册
- goal.loop_detected：已注册
- goal.max_rounds：已注册
- event_store.read_failed：已注册

## 5. CrishResult 公共 API 验证

- Promise<CrishResult 匹配数：≥ 5

## 6. 循环依赖验证

- depcruise：0 violations

## 7. 门禁汇总

- 8 项门禁全部通过
```

---

## 8. 风险与缓解

| 风险                                                         | 影响                                           | 缓解措施                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CrishResult` 迁移导致 daemon（R7）接口断裂                  | daemon 大量 try/catch 失效                     | R6 出口契约（§1.2）提前同步给 R7，R7 在 R6 完成后启动；legacy shim 提供 `unwrapOr` 兼容旧调用方             |
| 新增 `goal.*` 域扩展破坏 `03-ERROR-MIGRATION.md` 权威性      | 后续 Round 引用错误码时困惑                    | 6-C 同步更新 `03-ERROR-MIGRATION.md` §2.2（码数 60→64，域数 18→19），保持文档为活文档（guardrails 禁令 31） |
| telemetry span 在 hot path 引入性能开销                      | EventStore.append 高频调用 span 影响吞吐       | span 仅在 `debug` 级别开启；`@crish/telemetry` 的 span 在 production 可禁用采样                             |
| 6-D 修复测试时发现 6-A/6-B/6-C 引入新 TSC 错误               | R6 门禁不通过                                  | 6-D 反馈给对应 Agent 修正（协调次数 = 2，上限内）；若修正后仍超基线，回退该 Agent 的非关键改动              |
| `@crish/agent-runtime` → `@crish/agent-core` import 迁移遗漏 | 个别文件仍依赖 shim                            | 6-D 用 grep 验证零匹配（§6.2 门禁）；遗漏文件由 6-D 统一修正                                                |
| Windows 文件锁（EBUSY/EACCES）在测试环境复现困难             | `store.write_failed` retryable=true 路径未测试 | 6-D 在 `event-store.test.ts` 增加 mock 测试用例，模拟 `EBUSY` errno                                         |

---

## 9. 与后续 Round 的衔接

### 9.1 向 R7（daemon 重构）的衔接

| R6 产出                                         | R7 消费方式                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| orchestrator 公共 API 返回 `CrishResult<T>`     | daemon 的 handler 不再 try/catch，按 `result.ok` 分支处理；`result.error` 可直接 `toErrorPayload()` 序列化给前端 |
| orchestrator 全部 throw 使用新 `CrishErrorCode` | daemon 的错误传播层可统一用 `fromUnknownError()` 兜底捕获                                                        |
| `OrchestratorDeps.logger` 注入契约              | daemon 创建 `Logger` 实例并传入，与 orchestrator 共享 transport（RotatingFileSink）                              |
| `OrchestratorDeps.telemetry` 注入契约           | daemon 创建 `TraceManager` 实例并传入，与 orchestrator 共享 span 导出                                            |
| `goal.*` / `event_store.read_failed` 新码       | daemon 的错误翻译层（R11）需处理这些新码的 i18n                                                                  |

### 9.2 向 R12（删除阶段）的衔接

R6 完成后，以下旧类型在 orchestrator 范围内**源码不再使用**，但类定义仍保留（共存阶段约束）：

| 旧类型                                                               | 当前位置                              | R12 删除条件                           |
| -------------------------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| `SessionError` 子类                                                  | `shared-types/src/errors.ts`          | grep 全仓库源码（排除测试）0 引用      |
| `ProtocolError` 子类                                                 | `shared-types/src/errors.ts`          | 同上                                   |
| `SessionErrorCode` 类型                                              | `shared-types/src/errors.ts`          | 同上                                   |
| `migrateErrorCode()` 函数                                            | `shared-types/src/error-migration.ts` | R7-R11 全部包迁移完成后，grep 0 调用方 |
| `ARTIFACT_ERROR` / `INVALID_RUN_STATE` / `NOT_A_GOAL_RUN` 旧码字符串 | —                                     | grep 全仓库 0 匹配                     |

R6 验证报告中记录这些旧类型的 orchestrator 范围归零状态，作为 R12 删除阶段的输入。

---

## 变更记录

| 版本 | 日期       | 变更                                                                                  |
| ---- | ---------- | ------------------------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于 R5 交付物与 `02-FILE-MAPPING.md` §7、`03-ERROR-MIGRATION.md` §3/§4/§7 设计 |
