# Round 7：Daemon 重构与协议升级

> **本文件是 Round 7（`@crish/agent-daemon` 重构与 IPC 协议错误传播升级）的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Round 7 的执行 Agent 必须严格遵守本文件的接口契约与任务边界。
> 后续 Round（R10 Rust 侧对齐 / R11 前端韧性）引用 daemon 的 IPC 错误传播格式时必须指向本文件第 5 节。
>
> **前置文档**：
>
> - `../../ANTI_OVERENGINEERING_GUARDRAILS.md` — 架构治理约束（禁令 10-12 包拆分边界、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量）
> - `./01-OVERVIEW.md` — 总览（§3 依赖图、§3.2 拓扑层级、§4.1 轮次总览）
> - `./02-FILE-MAPPING.md` — 文件映射表（§8 agent-daemon 文件映射、§9 依赖方向验证）
> - `./03-ERROR-MIGRATION.md` — 错误码迁移（§3.4 自由字符串码→新码、§4.1 throw 热点清单、§6 CrishErrorPayload、§7 三阶段策略）
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 10：`agent-daemon` 不拆分，保留为单包，仅做错误处理与日志集成重构
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为迁移阶段（旧码仍保留 deprecated 别名直至 R12）
> - 禁令 25：禁止一次性全局替换 throw，按文件逐个迁移并通过测试验证
> - 禁令 26：TSC 错误数 ≤ 该轮基线（不恶化），不承诺清零
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更
> - 禁令 31：文档与代码同步，本 Round 完成后更新 `02-FILE-MAPPING.md` §8 与 `03-ERROR-MIGRATION.md` §4 迁移追踪表

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 7 处于拓扑 Layer 7（Daemon 层），在 Round 6（agent-orchestrator 重构）完成后执行。daemon 是编排层之上的进程级入口，承载 WebSocket IPC、Provider Gateway、审批队列、子代理桥接、各类 Store 等运行时职责。

```
Layer 0: shared-types, shared-utils, decision-engine           （已存在 / R1 增强）
Layer 1: @crish/logger, @crish/telemetry                        （R2 创建）
Layer 2: agent-context, agent-permissions, agent-mcp            （R3 创建 — leaf 层）
Layer 3: agent-tools, agent-model                                （R4 创建 — middle 层）
Layer 4: agent-core                                              （R5 创建 — top 层）
Layer 5: agent-subagent                                          （R5 创建骨架，R9 完整化 — 始终为 Layer 5）
Layer 6: agent-orchestrator                                      （R6 重构 — 编排层）
Layer 7: agent-daemon                                            （R7 重构 — Daemon 层）← 本 Round
Layer 8: plugin-sdk                                              （R8 重建）
Layer 9: Rust crates                                            （R10 对齐）
Layer 10: crish-desktop                                          （R11 韧性加固）
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2 与 `02-FILE-MAPPING.md` §9.2）：

- Round 6 必须先于 Round 7：daemon 依赖 orchestrator 的 CrishError 集成成果
- Round 7 必须先于 Round 10：Rust 侧 CrishErrorPayload 对齐依赖 daemon 的 IPC 错误传播格式
- Round 7 必须先于 Round 9 完整化：`subagent-runtime.ts` 在本轮仅做接口适配，完整调度系统在 R9 实现
- 循环依赖必须保持为 0（dependency-cruiser 强制）

### 1.2 目标

| 维度         | 说明                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标包**   | `@crish/agent-daemon`（重构，不拆分）                                                                                                                                                                                                                                                                                                                                                                         |
| **总文件数** | 97（65 src + 32 test，见 `02-FILE-MAPPING.md` §8.2）                                                                                                                                                                                                                                                                                                                                                          |
| **核心任务** | ① `@crish/logger` 集成（替换 `@crish/shared-utils` 日志导入）；② `throw new Error` → `throw new CrishError`（按 `03-ERROR-MIGRATION.md` §4.1 P3/P4 daemon 行）；③ `ADAPTER_ERROR` / `SCOPED_CONTEXT_ERROR` 等旧码迁移到 `domain.reason` 格式；④ IPC `ErrorMessage` 类型扩展为承载 `CrishErrorPayload`；⑤ Handler 层错误处理统一使用 `CrishResult`；⑥ `subagent-runtime.ts` 接口适配；⑦ TSC 修复（不恶化基线） |
| **不改动项** | ApprovalQueue、Server 核心、Handler 层的业务逻辑——仅做错误处理与日志集成重构                                                                                                                                                                                                                                                                                                                                  |
| **前置轮次** | Round 6（orchestrator 错误体系已升级）                                                                                                                                                                                                                                                                                                                                                                        |
| **后续轮次** | Round 10（Rust 侧 IPC 对齐依赖 daemon 的错误传播格式）                                                                                                                                                                                                                                                                                                                                                        |
| **Agent 数** | 4（7-A / 7-B / 7-C / 7-D）                                                                                                                                                                                                                                                                                                                                                                                    |
| **并行性**   | 7-A 与 7-B 可并行（操作文件集不相交）；7-C 依赖 7-A/7-B 完成；7-D 依赖前三个 Agent 完成                                                                                                                                                                                                                                                                                                                       |

### 1.3 关键设计约束

以下约束源自 `ANTI_OVERENGINEERING_GUARDRAILS.md` 与本 Round 任务描述，执行 Agent 必须逐条遵守：

1. **不拆分 daemon**（`01-OVERVIEW.md` §2.1 S-01 / 任务描述）：`agent-daemon` 保留为单包，仅做错误处理、日志集成与 IPC 协议升级的内部重构。禁止借机拆分为 `agent-daemon-core` / `agent-daemon-ipc` 等子包。
2. **保留现有资产**（任务描述）：ApprovalQueue + timeout/extend、daemon 的 Server 核心、daemon 的 Handler 层为成熟资产，禁止重写。本轮仅在它们的错误处理与日志调用点做替换。
3. **subagent-runtime 适配**（任务描述）：`subagent-runtime.ts` 仅做接口适配（错误类型迁移、日志迁移），完整调度系统（RecursionGuard、SubagentScheduler、DeadlockDetector）推迟到 Round 9。本轮禁止在 daemon 内引入任何新的调度组件。
4. **IPC 协议准备**（`01-OVERVIEW.md` §2.2 F-07 / 任务描述）：daemon 的 `ErrorMessage` 出站协议必须为 Round 10 Rust 侧 `CrishErrorPayload` 对齐做准备。扩展字段使用 `CrishErrorPayload` 的超集，向后兼容现有 `{ type: "error"; code; message; runId? }` 三字段消费者。
5. **共存阶段策略**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）：旧 throw 调用点迁移到新 `CrishError` 时，旧自由字符串码（如 `ADAPTER_ERROR`）通过 `migrateErrorCode()` 函数（R1 交付）映射到新 `domain.reason` 码。旧码字符串在 R12 删除阶段才彻底移除。
6. **Agent 任务量**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28）：每个 Agent ≥ 5 文件或 ≥ 300 行变更。
7. **TSC 不恶化**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26）：Round 7 结束时 TSC 错误数 ≤ Round 7 开始基线（`tsc-errors-baseline.json`）。
8. **依赖方向**（`02-FILE-MAPPING.md` §9.2）：daemon 依赖 `agent-orchestrator` + `agent-model` + `agent-permissions` + `@crish/logger`。本轮新增 `@crish/logger` 依赖（替换 `@crish/shared-utils` 中的 Logger 来源），不引入其他新包依赖。

### 1.4 依赖关系

```
Round 6 交付物（agent-orchestrator CrishError 集成 + @crish/logger）
    │
    ▼
@crish/agent-orchestrator ──→ @crish/agent-daemon    （Layer 7）
@crish/agent-model        ──→ @crish/agent-daemon    （Provider Gateway 依赖）
@crish/agent-permissions  ──→ @crish/agent-daemon    （审批策略依赖）
@crish/logger             ──→ @crish/agent-daemon    [NEW] 替换 shared-utils/logger 来源
@crish/shared-types       ──→ @crish/agent-daemon    （CrishErrorPayload / CrishResult）
@crish/shared-utils       ──→ @crish/agent-daemon    （BoundedMap / AsyncSemaphore 等工具）
```

> daemon 现有 `@crish/agent-runtime` import（如 `subagent-runtime.ts` L4-L10）通过 agent-runtime 的 legacy shim（R5 建立）继续工作。本轮不强制迁移到 `@crish/agent-core`/`@crish/agent-model`/`@crish/agent-subagent` 的直接 import——shim 在 v0.3.0 才删除（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24），daemon 的 import 路径迁移由 R11/R12 统一处理。

---

## 2. 现有资产清单（保留不拆分）

> 以下资产经审计确认为**高质量工作代码**（见 `01-OVERVIEW.md` §1.3 与 `02-FILE-MAPPING.md` §8.2），Round 7 仅做错误处理与日志集成的最小侵入式重构，不重写、不拆分。

### 2.1 核心运行时资产

| 资产                           | 文件                                           | 行数（约） | 状态 | 本轮处理                                             |
| ------------------------------ | ---------------------------------------------- | ---------- | ---- | ---------------------------------------------------- |
| ApprovalQueue + timeout/extend | `approval-queue.ts` + `.test.ts`               | ~400       | 成熟 | 仅迁移 `getDaemonLogger` 调用点与 `throw` 点（如有） |
| Server 核心                    | `server.ts` + `server.test.ts`                 | ~3500      | 成熟 | 仅迁移 `throw` 与日志调用点                          |
| Handler 层                     | `handlers/*.ts`（15 文件）                     | ~3000      | 成熟 | 仅迁移 `sendError` 调用点的错误码与 `throw`          |
| Server-runtime-factory         | `server-runtime-factory.ts` + 子目录（5 文件） | ~800       | 成熟 | 仅迁移 `throw` 与日志调用点                          |
| DaemonClientRegistry           | `daemon-client-registry.ts`                    | ~250       | 成熟 | 仅扩展 `sendError` 签名以承载 `CrishErrorPayload`    |
| BinaryFrame 协议               | `binary-frame.ts` + 3 个测试                   | ~300       | 成熟 | 仅迁移 `throw new Error` 到 `CrishError`             |
| StreamBackpressure             | `stream-backpressure.ts` + `.test.ts`          | ~200       | 成熟 | 不改动（无 throw）                                   |

### 2.2 Store 资产

| 资产                   | 文件                                                | 行数（约） | 状态 | 本轮处理                                                    |
| ---------------------- | --------------------------------------------------- | ---------- | ---- | ----------------------------------------------------------- |
| PermissionStore        | `permission-store.ts` + `.adversarial.test.ts`      | ~250       | 成熟 | 仅迁移 `throw`                                              |
| PlanDocumentStore      | `plan-document-store.ts` + `.test.ts`               | ~200       | 成熟 | 仅迁移 `throw`                                              |
| ScopedContextStore     | `scoped-context-store.ts` + `.test.ts`              | ~500       | 成熟 | 迁移 `SCOPED_CONTEXT_ERROR` 4 处 throw 到 `store.corrupted` |
| SessionMetadataStore   | `session-metadata-store.ts` + `.test.ts`            | ~200       | 成熟 | 仅迁移 `throw`                                              |
| WorkflowStore + 子目录 | `workflow-store.ts` + 子目录（4 文件）+ `.test.ts`  | ~600       | 成熟 | 仅迁移 `throw`                                              |
| ServerEventStore       | `server-event-store.ts` + `.test.ts`                | ~400       | 成熟 | 仅迁移 `throw`                                              |
| TaskSnapshotProjection | `task-snapshot-projection.ts` + `.test.ts` + 子目录 | ~300       | 成熟 | 不改动                                                      |

### 2.3 Provider Gateway 资产

| 资产                  | 文件                                                                 | 行数（约） | 状态 | 本轮处理                                                                             |
| --------------------- | -------------------------------------------------------------------- | ---------- | ---- | ------------------------------------------------------------------------------------ |
| DaemonProviderGateway | `daemon-provider-gateway.ts`（barrel）+ 子目录（5 文件）+ `.test.ts` | ~700       | 成熟 | 迁移 `throw new Error` 到 `provider.*` / `config.*`；接口适配 agent-model 新错误类型 |
| DaemonProductAdapters | `daemon-product-adapters.ts`                                         | ~280       | 成熟 | 迁移 `ADAPTER_ERROR` 4 处 throw 到 `artifact.not_found` / `store.corrupted`          |

### 2.4 Daemon 生命周期与桥接资产

| 资产                  | 文件                               | 行数（约） | 状态   | 本轮处理                                         |
| --------------------- | ---------------------------------- | ---------- | ------ | ------------------------------------------------ |
| DaemonLifecycle       | `daemon-lifecycle.ts`              | ~150       | 成熟   | 仅迁移 `throw` 与日志调用点                      |
| DaemonSubagentBridge  | `daemon-subagent-bridge.ts`        | ~200       | 成熟   | 仅迁移 `throw`                                   |
| SubagentRuntime       | `subagent-runtime.ts` + `.test.ts` | ~550       | 半成熟 | 仅接口适配（错误类型 + 日志），完整调度推迟到 R9 |
| SubagentLifecycle     | `subagent-lifecycle.ts`            | ~150       | 成熟   | 仅迁移 `throw`                                   |
| BackgroundTaskManager | `background-task-manager.ts`       | ~250       | 成熟   | 仅迁移 `throw`                                   |

### 2.5 协议资产

| 资产                | 文件                                                               | 行数（约） | 状态 | 本轮处理                                               |
| ------------------- | ------------------------------------------------------------------ | ---------- | ---- | ------------------------------------------------------ |
| Protocol core       | `protocol/protocol.ts` + `protocol-codec.ts` + `protocol-types.ts` | ~200       | 成熟 | 不改动 facade，仅扩展 `ErrorMessage` 类型              |
| Protocol registry   | `protocol/registry.ts` + `.test.ts` + `schema-groups.ts`           | ~250       | 成熟 | 仅扩展 error 消息的注册项                              |
| Protocol codec      | `protocol/codec/decode.ts` + `encode.ts` + `shared.ts`             | ~400       | 成熟 | 仅扩展 encode/decode 以支持 `CrishErrorPayload` 字段   |
| Protocol validators | `protocol/validators/*.ts`（25 文件）                              | ~2000      | 成熟 | 仅更新 `validateErrorMessage` 以校验新字段（向后兼容） |
| Protocol types      | `types/protocol-*.ts`（10 文件）                                   | ~400       | 成熟 | 扩展 `ErrorMessage` 类型定义                           |

### 2.6 不改动清单

以下文件本轮**完全不改动**（无 throw、无日志调用、无错误码迁移需求）：

`capabilities.ts`、`env-whitelist.ts`（仅 1 处 throw，归 Agent 7-A）、`test-temp-cleanup.ts`、`observability/prometheus-exporter.ts`、`scoped-context-runtime.ts`、`scoped-context-query-handlers.ts`、`session-query-handlers.ts`、`task-snapshot/*`、`protocol/validators/*`（除 `validateErrorMessage` 外的 24 个文件）、`types/*`（除 `types/protocol-outbound-run.ts` 外的 9 个文件）。

---

## 3. Agent 任务详细设计

### 3.1 Agent 7-A：Daemon 日志系统升级 + CrishError 集成（P4 文件批次）

| 维度       | 说明                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 迁移型 + 修复型                                                                                                                                |
| **目标**   | ① 集成 `@crish/logger` 替换 `@crish/shared-utils` 中的 Logger 来源；② 迁移 P4 优先级 daemon 文件的 `throw new Error` 到 `throw new CrishError` |
| **前置**   | Round 6 已完成（`@crish/logger` 包已就绪，orchestrator 已完成日志迁移作为参考）                                                                |
| **后续**   | Agent 7-B 处理 IPC 协议错误传播；Agent 7-C 处理 Server/Handler/Provider Gateway                                                                |
| **并行性** | 与 Agent 7-B 操作文件集不相交，可并行                                                                                                          |

#### 输入

| 输入                        | 路径                                                      | 说明                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@crish/logger` 包          | `packages/logger/src/index.ts`（R2 交付）                 | 提供 `DaemonFileLogger`、`toLogErr`、`getDaemonLogger`、`Logger`、`LogEntry`、`LogLevel`                                                                                                                                             |
| `daemon-logger.ts` 当前状态 | `packages/agent-daemon/src/daemon-logger.ts`（52 行）     | 已在 R2 改为 `@crish/logger` 的 re-export shim；本轮验证并补齐迁移                                                                                                                                                                   |
| `CrishError` 类             | `packages/shared-types/src/errors.ts`（R1 交付）          | 接受 `CrishErrorCode                                                                                                                                                                                                                 | string`，向后兼容旧码 |
| `migrateErrorCode()`        | `packages/shared-types/src/error-migration.ts`（R1 交付） | 旧码→新码映射                                                                                                                                                                                                                        |
| P4 daemon 文件清单          | 见 `03-ERROR-MIGRATION.md` §4.1 daemon 行                 | `binary-frame.ts`、`capabilities.ts`、`env-whitelist.ts`、`mcp-config.ts`、`handlers/session-handlers.ts`、`server-runtime-factory/index.ts`、`subagent-runtime.ts`、`daemon-provider-gateway/types.ts`、`daemon-client-registry.ts` |

#### 步骤

1. **验证并补齐 `daemon-logger.ts` 的 `@crish/logger` 迁移**
   - 当前文件已是 `@crish/logger` 的 re-export shim（R2 完成）。验证所有 daemon 文件的 `import { getDaemonLogger, toLogErr } from "./daemon-logger.js"` 与 `import { ... } from "@crish/shared-utils"` 调用点。
   - 对于直接从 `@crish/shared-utils` 导入 `Logger`、`LogLevel`、`LogEntry` 类型的文件（如 `daemon-client-registry.ts` L7 的 `import { ... } from "@crish/shared-utils"` 中包含 `Logger`），改为从 `@crish/logger` 导入这些类型。`BoundedMap`、`MAX_CLIENTS` 等工具类仍从 `@crish/shared-utils` 导入。
   - 在 `packages/agent-daemon/package.json` 的 `dependencies` 中显式声明 `"@crish/logger": "workspace:*"`（如尚未声明）。
   - 在 `packages/agent-daemon/src/daemon-logger.ts` 顶部添加 deprecation 注释块（如尚未添加）：
     ```ts
     /**
      * @deprecated 此文件为兼容性 re-export，直接从 @crish/logger 导入。
      *将在 v0.3.0 删除（见 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 24）。
      */
     ```

2. **迁移 P4 文件 `throw new Error` → `throw new CrishError`**

   按 `03-ERROR-MIGRATION.md` §3.4 与 §4.1 的迁移映射，逐文件替换：

   | 文件                               | 行号          | 旧 throw                                                                   | 新 throw                                                                                                                                                     | 新码                                  |
   | ---------------------------------- | ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
   | `binary-frame.ts`                  | L72           | `throw new Error("Unknown binary frame type: 0x...")`                      | `throw new CrishError(\`Unknown binary frame type: 0x${type.toString(16)}\`, "common.unsupported", "permanent", false)`                                      | `common.unsupported`                  |
   | `capabilities.ts`                  | —             | 测试文件中的 throw（不迁移，由 Agent 7-D 处理）                            | —                                                                                                                                                            | —                                     |
   | `env-whitelist.ts`                 | L30           | `throw new Error(\`Access to process.env.${name} denied: ...\`)`           | `throw new CrishError(\`Access to process.env.${name} denied: not in whitelist\`, "plugin.permission_denied", "security", false, { env: name })`             | `plugin.permission_denied`            |
   | `mcp-config.ts`                    | L214          | `throw new Error(reason)`                                                  | `throw new CrishError(reason, "config.parse_failed", "permanent", false)`                                                                                    | `config.parse_failed`                 |
   | `handlers/session-handlers.ts`     | L622          | `throw new Error(\`Session not found after leaf move: ...\`)`              | `throw new CrishError(\`Session not found after leaf move: ${step.sessionId}\`, "session.not_found", "permanent", false)`                                    | `session.not_found`                   |
   | `server-runtime-factory/index.ts`  | L159          | `throw new Error("Provider factory not configured...")`                    | `throw new CrishError("Provider factory not configured. Call setProviderFactory() first.", "config.missing", "permanent", false)`                            | `config.missing`                      |
   | `subagent-runtime.ts`              | L123          | `throw new Error(\`Maximum sub-agent depth (${maxDepth}) reached\`)`       | `throw new CrishError(\`Maximum sub-agent depth (${maxDepth}) reached\`, "subagent.depth_exceeded", "permanent", false, { maxDepth })`                       | `subagent.depth_exceeded`             |
   | `subagent-runtime.ts`              | L529          | `throw new Error(\`${key} must be a non-empty string\`)`                   | `throw new CrishError(\`${key} must be a non-empty string\`, "tool.invalid_input", "protocol", false, { field: key })`                                       | `tool.invalid_input`                  |
   | `daemon-provider-gateway/types.ts` | L142          | `throw new Error(\`Daemon provider ${field} is required.\`)`               | `throw new CrishError(\`Daemon provider ${field} is required.\`, "config.missing", "permanent", false, { field })`                                           | `config.missing`                      |
   | `daemon-client-registry.ts`        | L132 区域     | 仅 `sendError` 方法的内部实现，无 throw（但需扩展签名，由 Agent 7-B 处理） | —                                                                                                                                                            | —                                     |
   | `daemon-provider-gateway/index.ts` | L124, L133    | `throw new Error(...)` 2 处                                                | `throw new CrishError(formatProviderGatewayError(cause.plan), "provider.unknown", "permanent", false)` 与 `throw new CrishError(..., "config.invalid", ...)` | `provider.unknown` / `config.invalid` |
   | `mcp-stdio-adapter.ts`             | L54, L68, L96 | `throw new Error(...)` 3 处                                                | 分别迁移到 `mcp.connection_failed` / `mcp.protocol_violation` / `mcp.server_not_found`                                                                       | `mcp.*`                               |

3. **更新日志调用点**
   - 在所有被迁移文件中，将 `console.error` / `console.warn` 调用替换为 `getDaemonLogger().error(...)` / `getDaemonLogger().warn(...)`（仅当文件已有 logger 导入时；否则新增 `import { getDaemonLogger } from "../daemon-logger.js"` 导入）。
   - `toLogErr` 函数从 `@crish/logger` 导入（已是 re-export shim 的 `./daemon-logger.js`）。
   - 日志 entry 的 `module` 字段保持现有命名（如 `"DaemonClientRegistry"`、`"McpStdioAdapter"` 等），不重命名。

4. **验证**
   - `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
   - 现有 daemon 测试中涉及上述 throw 点的用例（如 `mcp-stdio-adapter.test.ts`、`subagent-runtime.test.ts`）仍能通过——`CrishError` 继承自 `Error`，`instanceof Error` 与 `error.message` 断言不变。
   - 新增的 `error.code` 字段在测试中可选断言（不强求，避免引入测试改动）。

#### 输出

| 文件                                                         | 类型 | 行数变化（估）         | 说明                                            |
| ------------------------------------------------------------ | ---- | ---------------------- | ----------------------------------------------- |
| `packages/agent-daemon/src/daemon-logger.ts`                 | 修改 | +5（deprecation 注释） | 验证并补齐 re-export shim                       |
| `packages/agent-daemon/src/binary-frame.ts`                  | 修改 | +2                     | 1 处 throw 迁移                                 |
| `packages/agent-daemon/src/env-whitelist.ts`                 | 修改 | +3                     | 1 处 throw 迁移 + CrishError 导入               |
| `packages/agent-daemon/src/mcp-config.ts`                    | 修改 | +3                     | 1 处 throw 迁移                                 |
| `packages/agent-daemon/src/mcp-stdio-adapter.ts`             | 修改 | +8                     | 3 处 throw 迁移 + CrishError 导入               |
| `packages/agent-daemon/src/handlers/session-handlers.ts`     | 修改 | +3                     | 1 处 throw 迁移                                 |
| `packages/agent-daemon/src/server-runtime-factory/index.ts`  | 修改 | +3                     | 1 处 throw 迁移                                 |
| `packages/agent-daemon/src/subagent-runtime.ts`              | 修改 | +8                     | 2 处 throw 迁移 + CrishError 导入               |
| `packages/agent-daemon/src/daemon-provider-gateway/types.ts` | 修改 | +3                     | 1 处 throw 迁移                                 |
| `packages/agent-daemon/src/daemon-provider-gateway/index.ts` | 修改 | +6                     | 2 处 throw 迁移                                 |
| `packages/agent-daemon/src/daemon-client-registry.ts`        | 修改 | +5                     | 日志导入迁移（`Logger` 类型从 `@crish/logger`） |
| `packages/agent-daemon/package.json`                         | 修改 | +1                     | 显式声明 `@crish/logger` 依赖                   |

文件数：12（≥5 ✓）。代码变更量：~50 行净增 + 大量 throw 调用点替换（~30 处）≈ 320 行总变更（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
- `npx vitest run packages/agent-daemon/src/mcp-stdio-adapter.test.ts packages/agent-daemon/src/subagent-runtime.test.ts` 全部通过。
- `npm run lint:depcruise` 0 violations（无新循环依赖引入）。

---

### 3.2 Agent 7-B：Daemon 错误传播升级 + IPC 协议（为 Round 10 准备）

| 维度       | 说明                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 实现型 + 迁移型                                                                                                                                                                                                                                    |
| **目标**   | ① 扩展 IPC `ErrorMessage` 类型以承载 `CrishErrorPayload`；② `DaemonClientRegistry.sendError` 扩展签名支持 `CrishErrorPayload`；③ Protocol 验证器更新以校验新字段（向后兼容）；④ Handler 层的 `sendError` 调用点迁移到使用 `CrishErrorPayload` 构造 |
| **前置**   | Round 1 已交付 `CrishErrorPayload` 接口与 `toErrorPayload()` 函数                                                                                                                                                                                  |
| **后续**   | Agent 7-C 处理 Server/Handler/Provider Gateway 业务逻辑；Agent 7-D 修复 TSC 与测试                                                                                                                                                                 |
| **并行性** | 与 Agent 7-A 操作文件集不相交，可并行                                                                                                                                                                                                              |

#### 输入

| 输入                                      | 路径                                                                                | 说明                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CrishErrorPayload` 接口                  | `packages/shared-types/src/error-payload.ts`（R1 交付）                             | 跨进程序列化的错误负载                                                                                         |
| `toErrorPayload()` / `fromUnknownError()` | `packages/shared-types/src/error-payload.ts`（R1 交付）                             | 从 `CrishError` 或未知错误构造 Payload                                                                         |
| `ErrorMessage` 当前定义                   | `packages/agent-daemon/src/types/protocol-outbound-run.ts` L38-43                   | `{ type: "error"; code: string; message: string; runId?: string }`                                             |
| `DaemonClientRegistry.sendError` 当前签名 | `packages/agent-daemon/src/daemon-client-registry.ts` L132-146                      | `sendError(ws, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean` |
| `validateErrorMessage`                    | `packages/agent-daemon/src/protocol/validators/run.ts`                              | 当前校验 `code` 为非空字符串                                                                                   |
| Handler 层 `sendError` 调用点             | `packages/agent-daemon/src/handlers/*.ts`（15 文件，30+ 调用点，见 §3.2 grep 结果） | 使用自由字符串码如 `"SUBAGENT_SEND_ERROR"`、`"GIT_ERROR"`、`"WORKFLOW_ERROR"` 等                               |

#### 步骤

1. **扩展 `ErrorMessage` 类型** → `packages/agent-daemon/src/types/protocol-outbound-run.ts`

   将 `ErrorMessage` 从裸 `{ type; code; message; runId? }` 扩展为承载 `CrishErrorPayload` 的超集，向后兼容现有消费者：

   ```ts
   import type { CrishErrorPayload } from '@crish/shared-types';

   /**
    * Daemon 出站错误消息。
    *
    * 兼容性策略（共存阶段，R7-R12）：
    * - 旧消费者仅读取 `code` / `message` / `runId` 三字段，继续工作。
    * - 新消费者（R10 Rust 侧、R11 前端）读取 `payload` 字段获取完整 CrishErrorPayload。
    * - `code` 与 `payload.code` 在迁移阶段保持一致；删除阶段（R12）移除顶层 `code`/`message`，仅保留 `payload`。
    */
   export interface ErrorMessage {
     type: 'error';
     /** 旧式错误码（自由字符串），迁移阶段保留，R12 删除 */
     code: string;
     /** 旧式错误消息，迁移阶段保留，R12 删除 */
     message: string;
     runId?: string;
     /** 新式结构化错误负载，R7 新增。可选以保证向后兼容 */
     payload?: CrishErrorPayload;
   }
   ```

2. **扩展 `DaemonClientRegistry.sendError` 签名** → `packages/agent-daemon/src/daemon-client-registry.ts`

   增加重载以接受 `CrishErrorPayload`，同时保留旧签名：

   ```ts
   import type { CrishErrorPayload } from '@crish/shared-types';
   import { toErrorPayload, fromUnknownError } from '@crish/shared-types';

   export class DaemonClientRegistry {
     // 旧签名（保留，deprecated）
     sendError(
       ws: WebSocket,
       code: string,
       message: string,
       runId?: string,
       correlation?: DaemonCorrelationFields
     ): boolean;

     // 新签名（接受 CrishErrorPayload）
     sendError(
       ws: WebSocket,
       payload: CrishErrorPayload,
       runId?: string,
       correlation?: DaemonCorrelationFields
     ): boolean;

     // 实现
     sendError(
       ws: WebSocket,
       codeOrPayload: string | CrishErrorPayload,
       messageOrRunId?: string | (DaemonCorrelationFields | undefined),
       runIdOrCorrelation?: string | (DaemonCorrelationFields | undefined),
       correlationOrUndefined?: DaemonCorrelationFields
     ): boolean {
       const { payload, runId, correlation } = normalizeSendErrorArgs(
         codeOrPayload,
         messageOrRunId,
         runIdOrCorrelation,
         correlationOrUndefined
       );
       return this.send(ws, {
         type: 'error',
         code: payload.code,
         message: payload.message,
         ...(runId !== undefined ? { runId } : {}),
         ...(correlation ? correlationFields(correlation) : {}),
         payload,
       });
     }
     // ...
   }
   ```

   `normalizeSendErrorArgs` 为私有辅助函数，根据 `codeOrPayload` 类型分流：若为字符串走旧路径（构造 `fromUnknownError` 兜底 payload），若为 `CrishErrorPayload` 走新路径。

3. **新增 `sendCrishError` 便捷方法** → `packages/agent-daemon/src/daemon-client-registry.ts`

   为 Handler 层提供从 `CrishError` 直接发送的便捷入口：

   ```ts
   /**
    * 从 CrishError 构造并发送 ErrorMessage。
    * 自动调用 toErrorPayload() 序列化 cause 链。
    */
   sendCrishError(
     ws: WebSocket,
     error: CrishError,
     runId?: string,
     correlation?: DaemonCorrelationFields
   ): boolean {
     return this.sendError(ws, toErrorPayload(error), runId, correlation);
   }

   /**
    * 从未知错误构造并发送 ErrorMessage（兜底）。
    * 用于 catch (error: unknown) 路径。
    */
   sendUnknownError(
     ws: WebSocket,
     error: unknown,
     runId?: string,
     correlation?: DaemonCorrelationFields
   ): boolean {
     return this.sendError(ws, fromUnknownError(error), runId, correlation);
   }
   ```

4. **更新 `SubagentTransport` 等局部接口** → `packages/agent-daemon/src/handlers/*.ts`

   各 Handler 文件中定义的局部 `SubagentTransport`、`GitHandlerDeps`、`ConfigHandlerDeps` 等接口的 `sendError` 签名扩展为接受 `string | CrishErrorPayload`：

   ```ts
   // handlers/subagent-handlers.ts L19-L22
   interface SubagentTransport {
     send(ws: WebSocket, message: unknown): boolean;
     sendError(
       ws: WebSocket,
       code: string | CrishErrorPayload,
       message?: string,
       runId?: string,
       correlation?: DaemonCorrelationFields
     ): boolean;
   }
   ```

   同理更新 `handlers/mcp-handlers.ts`、`handlers/git-handlers.ts`、`handlers/config-handlers.ts`、`handlers/workflow-handlers.ts`、`handlers/background-task-handlers.ts`、`handlers/artifact-handlers.ts`、`handlers/session-handlers.ts`、`handlers/approval-handlers.ts` 中的局部 transport 接口。

5. **更新 `validateErrorMessage`** → `packages/agent-daemon/src/protocol/validators/run.ts`

   扩展校验规则：`payload` 字段可选，若存在则校验其为符合 `CrishErrorPayload` 结构的对象（`code` 为非空字符串、`message` 为字符串、`category` 为枚举值、`retryable` 为布尔、`timestamp` 为数字）。

   ```ts
   export function validateErrorMessage(
     msg: unknown
   ): ProtocolValidationResult<ErrorMessage> {
     const base = validateMessageBase(msg, 'error');
     if (!base.ok) return base;
     const m = msg as Record<string, unknown>;
     // 旧字段（迁移阶段保留）
     if (typeof m.code !== 'string' || m.code.length === 0) {
       return invalid(
         'INVALID_MESSAGE',
         'error.code must be non-empty string',
         ['code']
       );
     }
     if (typeof m.message !== 'string') {
       return invalid('INVALID_MESSAGE', 'error.message must be string', [
         'message',
       ]);
     }
     // 新字段（R7 新增，可选）
     if (m.payload !== undefined) {
       const payloadResult = validateCrishErrorPayload(
         m.payload,
         'error.payload'
       );
       if (!payloadResult.ok) return payloadResult;
     }
     return ok(m as ErrorMessage);
   }
   ```

   `validateCrishErrorPayload` 为新增的共享校验函数，放在 `protocol/validators/common.ts`，供 inbound/outbound error 校验复用。

6. **更新 `encodeOutboundMessage`** → `packages/agent-daemon/src/protocol/codec/encode.ts`

   确保编码路径能正确序列化扩展后的 `ErrorMessage`（包含 `payload` 字段）。由于编码使用 `JSON.stringify`，`CrishErrorPayload` 已是纯数据对象，无需特殊处理。仅需在 `validateOutboundMessage` 的 switch 中确认 `case "error"` 调用 `validateErrorMessage`（已存在）。

7. **迁移 Handler 层 `sendError` 调用点的错误码**

   将现有自由字符串码映射到 `CrishErrorCode`，并通过 `CrishError` 构造后调用 `sendCrishError`：

   | 文件                                                          | 旧码                                                          | 新码                                                                | 迁移方式                                                                                     |
   | ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
   | `handlers/subagent-handlers.ts` L41                           | `"SUBAGENT_SEND_ERROR"`                                       | `subagent.timeout` 或 `common.unknown`（兜底）                      | `transport.sendCrishError(ws, new CrishError(..., "subagent.timeout", ...), undefined, msg)` |
   | `handlers/subagent-handlers.ts` L62                           | `"SUBAGENT_STATUS_ERROR"`                                     | `subagent.timeout` / `common.unknown`                               | 同上                                                                                         |
   | `handlers/mcp-handlers.ts` L55/L89/L116                       | `"MCP_START_ERROR"` / `"MCP_STOP_ERROR"` / `"MCP_LIST_ERROR"` | `mcp.connection_failed` / `mcp.server_not_found` / `common.unknown` | 同上                                                                                         |
   | `handlers/git-handlers.ts` L86                                | `"GIT_ERROR"`                                                 | `tool.execution_failed`                                             | 同上                                                                                         |
   | `handlers/config-handlers.ts` L177                            | `"CONFIG_UPDATE_ERROR"` / `"PROBE_ERROR"`                     | `config.invalid` / `provider.unknown`                               | 同上                                                                                         |
   | `handlers/workflow-handlers.ts` L66/L70/L74/L79/L83/L151/L175 | `"WORKFLOW_CONFLICT"` / `"WORKFLOW_ERROR"` 等                 | `run.invalid_state` / `common.unknown`                              | 同上                                                                                         |
   | `handlers/background-task-handlers.ts` L34/L37                | `"BACKGROUND_TASK_ERROR"`                                     | `tool.execution_failed` / `common.unknown`                          | 同上                                                                                         |
   | `handlers/artifact-handlers.ts` L38/L41                       | `"ARTIFACT_ERROR"` 等                                         | `artifact.not_found` / `common.unknown`                             | 同上                                                                                         |
   | `handlers/session-handlers.ts` L143/L159/L175                 | `result.code`（动态）                                         | 沿用 `result.code` 但通过 `CrishError` 包装                         | 改造 `result` 构造点使用 `CrishError`                                                        |

   **迁移策略**：不要求一次性迁移所有 30+ 调用点。优先迁移有明确语义映射的（如 `GIT_ERROR` → `tool.execution_failed`），兜底码（如 `WORKFLOW_ERROR`）使用 `fromUnknownError(error)` 走 `sendUnknownError` 路径。每个 Handler 文件至少迁移 2 个调用点以满足任务量。

8. **验证**
   - `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
   - `npx vitest run packages/agent-daemon/src/protocol/registry.test.ts packages/agent-daemon/src/protocol/validators/common.test.ts` 全部通过（验证扩展后的校验器）。
   - 现有 e2e 测试 `__tests__/agent-protocol.e2e.test.ts` 仍能通过——旧消费者仅读取 `code`/`message` 字段，新 `payload` 字段可选不破坏解析。

#### 输出

| 文件                                                             | 类型 | 行数变化（估） | 说明                                                                                |
| ---------------------------------------------------------------- | ---- | -------------- | ----------------------------------------------------------------------------------- |
| `packages/agent-daemon/src/types/protocol-outbound-run.ts`       | 修改 | +20            | 扩展 `ErrorMessage` 类型 + 注释                                                     |
| `packages/agent-daemon/src/daemon-client-registry.ts`            | 修改 | +60            | `sendError` 重载 + `sendCrishError` + `sendUnknownError` + `normalizeSendErrorArgs` |
| `packages/agent-daemon/src/protocol/validators/run.ts`           | 修改 | +15            | `validateErrorMessage` 扩展 payload 校验                                            |
| `packages/agent-daemon/src/protocol/validators/common.ts`        | 修改 | +30            | 新增 `validateCrishErrorPayload` 共享校验函数                                       |
| `packages/agent-daemon/src/protocol/codec/encode.ts`             | 修改 | +5             | 确认 error case 走新校验                                                            |
| `packages/agent-daemon/src/handlers/subagent-handlers.ts`        | 修改 | +10            | 2 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/mcp-handlers.ts`             | 修改 | +15            | 3 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/git-handlers.ts`             | 修改 | +8             | 1 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/config-handlers.ts`          | 修改 | +10            | 1 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/workflow-handlers.ts`        | 修改 | +20            | 4 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/background-task-handlers.ts` | 修改 | +8             | 2 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/artifact-handlers.ts`        | 修改 | +8             | 2 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/session-handlers.ts`         | 修改 | +10            | 3 处 sendError 迁移 + transport 接口扩展                                            |
| `packages/agent-daemon/src/handlers/approval-handlers.ts`        | 修改 | +5             | transport 接口扩展                                                                  |

文件数：14（≥5 ✓）。代码变更量：~220 行新增 + ~30 处调用点替换 ≈ 350 行总变更（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
- `npx vitest run packages/agent-daemon/src/protocol/` 全部通过。
- `npx vitest run packages/agent-daemon/src/__tests__/agent-protocol.e2e.test.ts` 通过（向后兼容验证）。
- `npm run lint:depcruise` 0 violations。

---

### 3.3 Agent 7-C：Server 核心 + Handler 层 + Provider Gateway 更新

| 维度       | 说明                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 迁移型 + 修复型                                                                                                                                                                                                              |
| **目标**   | ① Server 核心集成新的错误体系（`server.ts` 的 throw 与日志）；② Handler 层的 `CrishResult` 化（公共 API 边界返回 `CrishResult`）；③ Provider Gateway 更新（使用 agent-model 的新错误类型）；④ `subagent-runtime.ts` 接口适配 |
| **前置**   | Agent 7-A 完成（日志迁移就绪）；Agent 7-B 完成（`sendError` 新签名就绪）                                                                                                                                                     |
| **后续**   | Agent 7-D 修复 TSC 与测试                                                                                                                                                                                                    |
| **并行性** | 串行（依赖 7-A/7-B）                                                                                                                                                                                                         |

#### 输入

| 输入              | 路径                                                                                                      | 说明                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `CrishResult` ADT | `packages/shared-types/src/result.ts`（R1 交付）                                                          | `ok`/`err`/`mapResult`/`flatMapResult`/`match`           |
| Server 核心       | `packages/agent-daemon/src/server.ts`（~3500 行）                                                         | 现有 throw 与日志调用点                                  |
| Handler 层        | `packages/agent-daemon/src/handlers/run-handlers/`（含子目录 7 文件）+ `handlers/approval-handlers.ts` 等 | 公共 API 边界函数                                        |
| Provider Gateway  | `packages/agent-daemon/src/daemon-provider-gateway/`（5 文件）                                            | 使用 `@crish/agent-runtime` 的 `ProviderGatewayError` 等 |
| SubagentRuntime   | `packages/agent-daemon/src/subagent-runtime.ts`（~550 行）                                                | 接口适配（错误类型 + 日志）                              |

#### 步骤

1. **Server 核心 `throw` 迁移** → `packages/agent-daemon/src/server.ts`

   扫描 `server.ts` 中的 `throw new Error(...)` 调用点（预估 5-10 处，集中在连接管理、状态校验、配置加载路径），按 `03-ERROR-MIGRATION.md` §3.4 映射迁移：

   - 连接/状态相关 → `runtime.unexpected_state` / `runtime.transition_failed`
   - 配置加载相关 → `config.missing` / `config.parse_failed`
   - 资源未找到 → `session.not_found` / `run.not_found`
   - 兜底 → `common.unknown`

   保留 `server.ts` 的整体结构不变，仅替换 throw 调用点。对于 `catch (error)` 块中的日志调用，将 `console.error` 替换为 `getDaemonLogger().error(...)` 并使用 `toLogErr(error)` 提取结构化错误信息。

2. **Handler 层 `CrishResult` 化** → `packages/agent-daemon/src/handlers/run-handlers/` 等

   依据 `03-ERROR-MIGRATION.md` §5.1 "公共 API 边界返回 `CrishResult`"规则，将以下 Handler 的公共导出函数改为返回 `CrishResult`：

   | 函数                                   | 文件                            | 当前返回             | 迁移后返回                                                           |
   | -------------------------------------- | ------------------------------- | -------------------- | -------------------------------------------------------------------- |
   | `handleRunTask` 系列                   | `handlers/run-handlers.ts`      | `void`（throw 错误） | `CrishResult<void>` 或保持 `void` 但内部 catch 转为 `sendCrishError` |
   | `handleApproveTool` / `handleDenyTool` | `handlers/approval-handlers.ts` | `void`               | `CrishResult<void>`                                                  |
   | `handleStartMcpServer` 等              | `handlers/mcp-handlers.ts`      | `void`               | `CrishResult<void>`                                                  |
   | `handleListWorkflows` 等               | `handlers/workflow-handlers.ts` | `void` 或 `throw`    | `CrishResult<void>`                                                  |

   **迁移策略**：Handler 函数本身是 WebSocket 消息处理入口，其"返回值"实际通过 `transport.send` / `transport.sendError` 体现。本轮不强制改签名返回 `CrishResult`（会破坏调用方 `server-handlers.ts` 的 dispatch），而是：
   - 在 Handler 内部使用 `CrishResult` 包装业务逻辑的结果（如 `try { ... } catch { return err(...) }`）。
   - 在 Handler 的 `catch` 块中，使用 `sendCrishError` 或 `sendUnknownError`（Agent 7-B 已提供）替代 `sendError(ws, "CODE", message)`。
   - 对于返回值给 `server-handlers.ts` dispatch 使用的辅助函数（如 `RunHandler` 类的方法），改为返回 `CrishResult<T>`，由 dispatch 层 match 处理。

3. **`RunHandler` 类的 `CrishResult` 化** → `packages/agent-daemon/src/handlers/run-handlers.ts`

   `RunHandler` 是处理 run 生命周期的核心类，其公共方法如 `startRun`、`cancelRun`、`streamPause` 等当前可能 throw。改为：

   ```ts
   import { ok, err, type CrishResult } from '@crish/shared-types';

   class RunHandler {
     startRun(
       request: StartRunRequest
     ): CrishResult<OrchestratorRunHandle, CrishError> {
       try {
         const handle = this.orchestrator.startRun(request);
         return ok(handle);
       } catch (error) {
         if (error instanceof CrishError) return err(error);
         return err(
           new CrishError(
             errorMessage(error),
             'runtime.unexpected_state',
             'permanent',
             false
           )
         );
       }
     }
     // ...
   }
   ```

   `server-handlers.ts` 的 dispatch 处改为 `match` 处理：

   ```ts
   const result = runHandler.startRun(request);
   match(result, {
     ok: (handle) => transport.send(ws, { type: "run-started", runId: handle.runId, ... }),
     err: (error) => transport.sendCrishError(ws, error, undefined, correlation),
   });
   ```

4. **Provider Gateway 接口适配** → `packages/agent-daemon/src/daemon-provider-gateway/`

   `daemon-provider-gateway/index.ts` 当前从 `@crish/agent-runtime` 导入 `ProviderGatewayError`、`ProviderGateway`、`ProviderGatewayPlan` 等。本轮：
   - 保持从 `@crish/agent-runtime` 导入（shim 在 v0.3.0 才删除，见 §1.4 说明）。
   - 将 `ProviderGatewayError` 的 catch 处理改为构造 `CrishError`（`provider.*` 域）：
     ```ts
     catch (error) {
       if (error instanceof ProviderGatewayError) {
         throw new CrishError(
           error.message,
           "provider.unknown",
           "transient",
           true,
           { plan: redactProviderGatewayPlan(error.plan) }
         );
       }
       throw error;
     }
     ```
   - `daemon-provider-gateway/health.ts` 中的 `formatProviderGatewayError` 函数扩展为返回 `CrishErrorCode` 而非裸字符串。
   - `daemon-provider-gateway/provider-factory.ts` 中的 `createProviderFromPlan` catch 块迁移 throw 到 `CrishError`。

5. **`subagent-runtime.ts` 接口适配** → `packages/agent-daemon/src/subagent-runtime.ts`

   仅做接口适配，**不实现完整调度系统**（推迟到 R9）：
   - Agent 7-A 已迁移 L123/L529 两处 throw 到 `subagent.depth_exceeded` / `tool.invalid_input`。
   - 将 `import { ... } from "@crish/agent-runtime"` 中的 `defineTool`、`AgentTool`、`SubagentForkPolicy` 等保持通过 shim 导入（不强制迁移到 `@crish/agent-tools`/`@crish/agent-subagent`，由 R11/R12 统一处理）。
   - 在 `DAEMON_SUBAGENT_BRIDGE_KIND` 常量附近添加注释标注：
     ```ts
     /**
      * NOTE (R7): 本文件仅做错误类型与日志接口适配。
      * 完整调度系统（RecursionGuard / SubagentScheduler / DeadlockDetector）
      * 在 Round 9 实现（见 ROUND-09-subagent.md）。
      */
     ```
   - `subagent-runtime.ts` 中对 `startRun` / `cancelRun` 的调用包装为 `CrishResult` 返回（同 §3.3 步骤 3 模式）。
   - `daemon-subagent-bridge.ts` 与 `subagent-lifecycle.ts` 同步做 throw 迁移（如有）。

6. **验证**
   - `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
   - `npx vitest run packages/agent-daemon/src/server.test.ts packages/agent-daemon/src/handlers/` 全部通过。
   - `npx vitest run packages/agent-daemon/src/daemon-provider-gateway.test.ts packages/agent-daemon/src/subagent-runtime.test.ts` 全部通过。

#### 输出

| 文件                                                                     | 类型 | 行数变化（估） | 说明                                           |
| ------------------------------------------------------------------------ | ---- | -------------- | ---------------------------------------------- |
| `packages/agent-daemon/src/server.ts`                                    | 修改 | +30            | throw 迁移 + 日志调用点迁移                    |
| `packages/agent-daemon/src/handlers/run-handlers.ts`                     | 修改 | +40            | `RunHandler` 类 `CrishResult` 化               |
| `packages/agent-daemon/src/handlers/run-handlers/run-lifecycle.ts`       | 修改 | +15            | 辅助函数 `CrishResult` 化                      |
| `packages/agent-daemon/src/handlers/run-handlers/run-tool-executor.ts`   | 修改 | +15            | 辅助函数 `CrishResult` 化                      |
| `packages/agent-daemon/src/handlers/run-handlers/lifecycle/run-start.ts` | 修改 | +10            | throw 迁移                                     |
| `packages/agent-daemon/src/handlers/run-handlers/lifecycle/run-end.ts`   | 修改 | +8             | throw 迁移                                     |
| `packages/agent-daemon/src/handlers/approval-handlers.ts`                | 修改 | +15            | catch 块 `sendCrishError` 迁移                 |
| `packages/agent-daemon/src/handlers/pending-input-handlers.ts`           | 修改 | +8             | catch 块迁移                                   |
| `packages/agent-daemon/src/handlers/scoped-context-handlers.ts`          | 修改 | +8             | catch 块迁移                                   |
| `packages/agent-daemon/src/handlers/plan-document-handlers.ts`           | 修改 | +8             | catch 块迁移                                   |
| `packages/agent-daemon/src/daemon-provider-gateway/index.ts`             | 修改 | +15            | ProviderGatewayError → CrishError              |
| `packages/agent-daemon/src/daemon-provider-gateway/health.ts`            | 修改 | +10            | formatProviderGatewayError 返回 CrishErrorCode |
| `packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts`  | 修改 | +10            | throw 迁移                                     |
| `packages/agent-daemon/src/subagent-runtime.ts`                          | 修改 | +15            | 接口适配 + 注释                                |
| `packages/agent-daemon/src/daemon-subagent-bridge.ts`                    | 修改 | +5             | throw 迁移                                     |
| `packages/agent-daemon/src/subagent-lifecycle.ts`                        | 修改 | +5             | throw 迁移                                     |
| `packages/agent-daemon/src/server-handlers.ts`                           | 修改 | +20            | dispatch 层 match 处理 CrishResult             |
| `packages/agent-daemon/src/daemon-lifecycle.ts`                          | 修改 | +5             | throw 迁移                                     |
| `packages/agent-daemon/src/background-task-manager.ts`                   | 修改 | +8             | throw 迁移                                     |
| `packages/agent-daemon/src/daemon-permission-policy.ts`                  | 修改 | +8             | throw 迁移                                     |
| `packages/agent-daemon/src/daemon-approval-handler.ts`                   | 修改 | +8             | throw 迁移                                     |

文件数：21（≥5 ✓）。代码变更量：~250 行新增 + 大量 throw/catch 改造 ≈ 400 行总变更（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线）。
- `npx vitest run packages/agent-daemon/` 全部通过（除 Agent 7-D 负责修复的失败测试）。
- `npm run lint:depcruise` 0 violations。

---

### 3.4 Agent 7-D：Daemon TSC 修复 + 测试更新

| 维度       | 说明                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **类型**   | 修复型 + 验证型                                                                                                                           |
| **目标**   | ① 修复 daemon 的 TSC 错误（不恶化基线，争取改善）；② 更新 daemon 的测试以适配新错误类型与 IPC 协议；③ 运行 vitest + cargo test 验证全链路 |
| **前置**   | Agent 7-A/7-B/7-C 全部完成                                                                                                                |
| **后续**   | Round 8 启动                                                                                                                              |
| **并行性** | 串行（依赖前三个 Agent）                                                                                                                  |

#### 输入

| 输入                   | 路径                                                                            | 说明                                |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| TSC 基线               | `tsc-errors-baseline.json`（R1 建立，每轮更新）                                 | daemon 相关的 TSC 错误清单          |
| 测试文件               | `packages/agent-daemon/src/**/*.test.ts` + `__tests__/*.e2e.test.ts`（32 文件） | 需适配新错误类型与 IPC payload 字段 |
| `vitest` 配置          | `packages/agent-daemon/vitest.config.ts`                                        | 覆盖率阈值                          |
| Agent 7-A/7-B/7-C 产出 | 上述各 Agent 的修改文件                                                         | 验证集成正确性                      |

#### 步骤

1. **记录 TSC 基线** — 在 Agent 开始时运行 `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 并保存输出作为本 Agent 的对比基线。

2. **修复 TSC 错误**

   针对前三个 Agent 引入的 TSC 错误（如有）以及 daemon 既有的 TSC 错误进行修复。重点修复方向：
   - `TS2375`/`TS2379`（exactOptionalPropertyTypes）：`ErrorMessage.payload?` 字段的 `undefined` 处理。使用 `...(payload !== undefined ? { payload } : {})` 模式而非直接赋值 `payload: undefined`。
   - `TS2532`/`TS18048`（uncheckedIndex）：`normalizeSendErrorArgs` 中的类型收窄。
   - `TS6133`/`TS6192`（unused）：迁移过程中遗留的未使用导入。
   - `TS1484`（verbatimModuleSyntax）：确保 `import type { CrishErrorPayload }` 使用 `type` 关键字。
   - `TS7006`（implicitAny）：`normalizeSendErrorArgs` 的参数类型显式标注。

   **修复原则**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26）：仅修复阻碍编译或测试通过的 error，不追求清零。warn 级别的 lint 不在本轮处理范围。

3. **更新测试文件**

   32 个测试文件中，需要更新的重点文件：

   | 测试文件                               | 更新内容                                                                                               |
   | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
   | `protocol/registry.test.ts`            | 扩展 error 消息的注册测试，覆盖 `payload` 字段                                                         |
   | `protocol/validators/common.test.ts`   | 新增 `validateCrishErrorPayload` 的测试用例                                                            |
   | `binary-frame.test.ts`                 | 适配 `throw new CrishError("common.unsupported", ...)` 的断言（`error.code === "common.unsupported"`） |
   | `mcp-stdio-adapter.test.ts`            | 适配 3 处 throw 迁移的断言                                                                             |
   | `subagent-runtime.test.ts`             | 适配 L123/L529 throw 迁移的断言（`error.code === "subagent.depth_exceeded"` 等）                       |
   | `daemon-approval-handler.test.ts`      | 适配 throw 迁移                                                                                        |
   | `daemon-permission-policy.test.ts`     | 适配 throw 迁移                                                                                        |
   | `daemon-provider-gateway.test.ts`      | 适配 ProviderGatewayError → CrishError 转换                                                            |
   | `scoped-context-store.test.ts`         | 适配 `SCOPED_CONTEXT_ERROR` → `store.corrupted` 迁移（4 处断言）                                       |
   | `server-handlers.test.ts`              | 适配 `sendError` 调用点迁移，验证 `payload` 字段存在                                                   |
   | `server.test.ts`                       | 适配 throw 迁移 + 验证 `ErrorMessage` 向后兼容                                                         |
   | `__tests__/agent-protocol.e2e.test.ts` | 验证旧消费者（仅读 `code`/`message`）与新消费者（读 `payload`）的兼容性                                |

   **测试更新策略**：
   - 对于 `error.message` 断言：保持不变（`CrishError` 继承 `Error`，`message` 字段不变）。
   - 对于 `error.code` 断言：旧码字符串（如 `"SCOPED_CONTEXT_ERROR"`）改为新码（如 `"store.corrupted"`）。
   - 对于 `instanceof Error` 断言：保持不变（`CrishError extends Error`）。
   - 新增 `error instanceof CrishError` 断言：在关键 throw 点的测试中新增。
   - 新增 `payload` 字段存在性断言：在 `sendError` 调用点的测试中验证 `payload` 字段存在且 `payload.code` 与顶层 `code` 一致。

4. **新增集成测试** → `packages/agent-daemon/src/__tests__/error-propagation.e2e.test.ts`

   新增一个端到端测试，验证错误从 daemon 内部 throw 到 IPC 出站的完整传播链：

   ```ts
   describe('error propagation end-to-end', () => {
     it('propagates CrishError throw to ErrorMessage.payload', async () => {
       // 模拟一个会 throw CrishError 的 Handler 调用
       // 验证客户端收到的 ErrorMessage 包含正确的 payload
       // payload.code === "subagent.depth_exceeded"
       // payload.category === "permanent"
       // payload.retryable === false
     });

     it('propagates unknown Error to ErrorMessage.payload via fromUnknownError', async () => {
       // 模拟一个会 throw 普通错误的 Handler 调用
       // 验证 payload.code === "common.unknown"
     });

     it('preserves cause chain in payload (up to 8 levels)', async () => {
       // 模拟嵌套 cause 的 CrishError
       // 验证 payload.cause.cause... 链直到截断
     });

     it('backward compatible: old consumers read code/message without payload', async () => {
       // 验证旧消费者仅读 code/message 仍工作
     });
   });
   ```

5. **运行验证门禁**

   按 §6 验证门禁执行全部 8 项检查，记录结果到验证报告。

#### 输出

| 文件                                                                   | 类型 | 行数变化（估） | 说明                                |
| ---------------------------------------------------------------------- | ---- | -------------- | ----------------------------------- |
| `packages/agent-daemon/src/protocol/registry.test.ts`                  | 修改 | +15            | error 消息注册测试扩展              |
| `packages/agent-daemon/src/protocol/validators/common.test.ts`         | 修改 | +30            | validateCrishErrorPayload 测试      |
| `packages/agent-daemon/src/binary-frame.test.ts`                       | 修改 | +5             | 断言适配                            |
| `packages/agent-daemon/src/mcp-stdio-adapter.test.ts`                  | 修改 | +10            | 3 处断言适配                        |
| `packages/agent-daemon/src/subagent-runtime.test.ts`                   | 修改 | +10            | 2 处断言适配                        |
| `packages/agent-daemon/src/daemon-approval-handler.test.ts`            | 修改 | +5             | 断言适配                            |
| `packages/agent-daemon/src/daemon-permission-policy.test.ts`           | 修改 | +5             | 断言适配                            |
| `packages/agent-daemon/src/daemon-provider-gateway.test.ts`            | 修改 | +10            | 断言适配                            |
| `packages/agent-daemon/src/scoped-context-store.test.ts`               | 修改 | +15            | 4 处断言适配                        |
| `packages/agent-daemon/src/server-handlers.test.ts`                    | 修改 | +20            | sendError 调用点测试 + payload 验证 |
| `packages/agent-daemon/src/server.test.ts`                             | 修改 | +15            | 断言适配 + 向后兼容验证             |
| `packages/agent-daemon/src/__tests__/agent-protocol.e2e.test.ts`       | 修改 | +15            | 新旧消费者兼容性验证                |
| `packages/agent-daemon/src/__tests__/error-propagation.e2e.test.ts`    | 新建 | +120           | 端到端错误传播测试                  |
| `packages/agent-daemon/src/handlers/approval-handlers.test.ts`         | 修改 | +5             | 断言适配                            |
| `packages/agent-daemon/src/handlers/run-control.test.ts`               | 修改 | +5             | 断言适配                            |
| `packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts` | 修改 | +5             | 断言适配                            |
| TSC 修复涉及的源码文件                                                 | 修改 | ±50            | 视实际 TSC 错误而定                 |
| `round-07-verification-report.md`                                      | 新建 | +80            | 验证报告                            |

文件数：17+（≥5 ✓）。代码变更量：~350 行新增 + TSC 修复 ≈ 400 行总变更（≥300 ✓）。

#### 验证

- `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` 通过（错误数 ≤ 基线，争取改善）。
- `npx vitest run packages/agent-daemon/` 全部通过（32 测试文件 + 1 新增）。
- `cargo test --workspace` 全部通过（验证 Rust 侧未受影响）。
- `npm run lint:depcruise` 0 violations。
- `npx turbo run build --filter=@crish/agent-daemon` 成功。
- `npm run lint` 0 errors。
- `npm run check:store-types` 通过。

---

## 4. 错误码迁移清单

> 本节为 Round 7 涉及的 daemon 错误码迁移汇总，依据 `03-ERROR-MIGRATION.md` §3.4 与 §4.1。完整错误码映射见 `03-ERROR-MIGRATION.md` §2.2 与 §3。

### 4.1 自由字符串码 → CrishErrorCode 迁移

| 旧码                                                    | 新码                 | 出现文件                                      | throw 数 | 迁移 Agent         |
| ------------------------------------------------------- | -------------------- | --------------------------------------------- | -------- | ------------------ |
| `ADAPTER_ERROR`（artifact/checkpoint/memory not found） | `artifact.not_found` | `daemon-product-adapters.ts` L128/L175/L226   | 3        | 7-C（或 7-A 兜底） |
| `ADAPTER_ERROR`（invalid memory scope）                 | `store.corrupted`    | `daemon-product-adapters.ts` L275             | 1        | 7-C（或 7-A 兜底） |
| `SCOPED_CONTEXT_ERROR`                                  | `store.corrupted`    | `scoped-context-store.ts` L199/L204/L344/L500 | 4        | 7-C（或 7-A 兜底） |

### 4.2 `throw new Error` → `throw new CrishError` 迁移

| 文件                               | 行号 | 旧 throw 内容                        | 新码                                      | 迁移 Agent      |
| ---------------------------------- | ---- | ------------------------------------ | ----------------------------------------- | --------------- |
| `binary-frame.ts`                  | L72  | `Unknown binary frame type`          | `common.unsupported`                      | 7-A             |
| `env-whitelist.ts`                 | L30  | `Access to process.env denied`       | `plugin.permission_denied`                | 7-A             |
| `mcp-config.ts`                    | L214 | `reason`（动态）                     | `config.parse_failed`                     | 7-A             |
| `mcp-stdio-adapter.ts`             | L54  | `MCP server has empty stdio command` | `mcp.connection_failed`                   | 7-A             |
| `mcp-stdio-adapter.ts`             | L68  | `MCP server spawn failed`            | `mcp.connection_failed`                   | 7-A             |
| `mcp-stdio-adapter.ts`             | L96  | `MCP server protocol error`          | `mcp.protocol_violation`                  | 7-A             |
| `handlers/session-handlers.ts`     | L622 | `Session not found after leaf move`  | `session.not_found`                       | 7-A             |
| `server-runtime-factory/index.ts`  | L159 | `Provider factory not configured`    | `config.missing`                          | 7-A             |
| `subagent-runtime.ts`              | L123 | `Maximum sub-agent depth reached`    | `subagent.depth_exceeded`                 | 7-A             |
| `subagent-runtime.ts`              | L529 | `key must be non-empty string`       | `tool.invalid_input`                      | 7-A             |
| `daemon-provider-gateway/types.ts` | L142 | `Daemon provider field is required`  | `config.missing`                          | 7-A             |
| `daemon-provider-gateway/index.ts` | L124 | Provider gateway 错误                | `provider.unknown`                        | 7-A             |
| `daemon-provider-gateway/index.ts` | L133 | `formatProviderGatewayError`         | `provider.unknown`                        | 7-A             |
| `daemon-client-registry.ts`        | —    | 仅 sendError 实现，无 throw          | —                                         | 7-B（扩展签名） |
| `server.ts`                        | 多处 | 连接/状态/配置错误                   | `runtime.*` / `config.*` / `session.*`    | 7-C             |
| `handlers/run-handlers/*.ts`       | 多处 | run 生命周期错误                     | `run.*` / `runtime.*`                     | 7-C             |
| `daemon-subagent-bridge.ts`        | —    | 子代理桥接错误                       | `subagent.*`                              | 7-C             |
| `subagent-lifecycle.ts`            | —    | 子代理生命周期错误                   | `subagent.*`                              | 7-C             |
| `daemon-lifecycle.ts`              | —    | daemon 生命周期错误                  | `runtime.*`                               | 7-C             |
| `background-task-manager.ts`       | —    | 后台任务错误                         | `tool.execution_failed`                   | 7-C             |
| `daemon-permission-policy.ts`      | —    | 权限策略错误                         | `plugin.permission_denied` / `approval.*` | 7-C             |
| `daemon-approval-handler.ts`       | —    | 审批处理错误                         | `approval.*`                              | 7-C             |

### 4.3 IPC `sendError` 自由字符串码 → CrishErrorCode 迁移

| 旧 IPC 错误码                          | 新 CrishErrorCode                           | 出现文件                                       | 迁移 Agent |
| -------------------------------------- | ------------------------------------------- | ---------------------------------------------- | ---------- |
| `SUBAGENT_SEND_ERROR`                  | `subagent.timeout` / `common.unknown`       | `handlers/subagent-handlers.ts` L41            | 7-B        |
| `SUBAGENT_STATUS_ERROR`                | `subagent.timeout` / `common.unknown`       | `handlers/subagent-handlers.ts` L62            | 7-B        |
| `MCP_START_ERROR`                      | `mcp.connection_failed`                     | `handlers/mcp-handlers.ts` L55                 | 7-B        |
| `MCP_STOP_ERROR`                       | `mcp.server_not_found`                      | `handlers/mcp-handlers.ts` L89                 | 7-B        |
| `MCP_LIST_ERROR`                       | `common.unknown`                            | `handlers/mcp-handlers.ts` L116                | 7-B        |
| `GIT_ERROR`                            | `tool.execution_failed`                     | `handlers/git-handlers.ts` L86                 | 7-B        |
| `CONFIG_UPDATE_ERROR`                  | `config.invalid`                            | `handlers/config-handlers.ts` L177             | 7-B        |
| `PROBE_ERROR`                          | `provider.unknown`                          | `handlers/config-handlers.ts` L177             | 7-B        |
| `WORKFLOW_CONFLICT`                    | `run.invalid_state`                         | `handlers/workflow-handlers.ts` L74            | 7-B        |
| `WORKFLOW_ERROR`                       | `common.unknown`                            | `handlers/workflow-handlers.ts` L83            | 7-B        |
| `BACKGROUND_TASK_ERROR`                | `tool.execution_failed` / `common.unknown`  | `handlers/background-task-handlers.ts` L34/L37 | 7-B        |
| `ARTIFACT_ERROR`                       | `artifact.not_found` / `common.unknown`     | `handlers/artifact-handlers.ts` L38/L41        | 7-B        |
| 动态 `result.code`（session-handlers） | 沿用 `result.code` 但通过 `CrishError` 包装 | `handlers/session-handlers.ts` L143/L159/L175  | 7-B        |

### 4.4 迁移三阶段对齐

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23 与 `03-ERROR-MIGRATION.md` §7：

| 阶段         | Round          | daemon 状态                                                                                                                                    |
| ------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **共存阶段** | R1（已完成）   | `CrishError` 接受新旧码；`migrateErrorCode()` 可用                                                                                             |
| **迁移阶段** | R7（本 Round） | daemon 的 throw 与 sendError 调用点迁移到新码；旧码字符串通过 `migrateErrorCode()` 仍可被旧消费者识别；`ErrorMessage.payload` 字段新增（可选） |
| **删除阶段** | R12            | 移除 daemon 中所有旧码字符串引用；`ErrorMessage` 顶层 `code`/`message` 移除，仅保留 `payload`；`daemon-logger.ts` shim 删除                    |

---

## 5. IPC 协议错误传播设计（为 Round 10 准备）

> 本节为 daemon IPC 错误传播的详细设计，是 Round 10 Rust 侧 `CrishErrorPayload` 对齐的输入契约。

### 5.1 现状

当前 daemon 的 IPC 错误传播存在以下问题（`01-OVERVIEW.md` §2.2 F-07）：

1. **`ErrorMessage` 字段单薄**：仅 `{ type; code; message; runId? }`，丢失 `category`/`retryable`/`action`/`cause` 等结构化信息。
2. **`code` 为自由字符串**：如 `"SUBAGENT_SEND_ERROR"`、`"GIT_ERROR"` 等，无域前缀，无法在序列化层做域路由。
3. **`DaemonClientRegistry.sendError` 签名裸字符串**：`sendError(ws, code: string, message: string, runId?, correlation?)`，无法接受结构化错误负载。
4. **Handler 层 `catch (error)` 兜底丢失信息**：`transport.sendError(ws, "CODE", errorMessage(error))` 仅传递 message 字符串，丢失 `error.code`/`error.cause` 等。
5. **Rust 侧 `IpcResponse.error: Option<String>`**（`03-ERROR-MIGRATION.md` §6.3）：当前是裸字符串，无法承载结构化错误。R10 需要对齐到 `Option<CrishErrorPayload>`。

### 5.2 目标设计（共存阶段，R7-R12）

#### 5.2.1 `ErrorMessage` 类型扩展

```ts
// packages/agent-daemon/src/types/protocol-outbound-run.ts
import type { CrishErrorPayload } from '@crish/shared-types';

export interface ErrorMessage {
  type: 'error';
  /** 旧式错误码（自由字符串），迁移阶段保留，R12 删除 */
  code: string;
  /** 旧式错误消息，迁移阶段保留，R12 删除 */
  message: string;
  runId?: string;
  /** 新式结构化错误负载，R7 新增。可选以保证向后兼容 */
  payload?: CrishErrorPayload;
  /** 协议相关性字段（correlationId / replyToId 等），由 withMessageCorrelation 注入 */
  correlationId?: string;
  replyToId?: string;
}
```

#### 5.2.2 `DaemonClientRegistry.sendError` 签名扩展

```ts
// packages/agent-daemon/src/daemon-client-registry.ts
sendError(
  ws: WebSocket,
  code: string | CrishErrorPayload,
  message?: string,
  runId?: string,
  correlation?: DaemonCorrelationFields
): boolean;

sendCrishError(
  ws: WebSocket,
  error: CrishError,
  runId?: string,
  correlation?: DaemonCorrelationFields
): boolean;

sendUnknownError(
  ws: WebSocket,
  error: unknown,
  runId?: string,
  correlation?: DaemonCorrelationFields
): boolean;
```

#### 5.2.3 出站消息编码流程

```
Handler catch (error: unknown)
    │
    ▼
transport.sendUnknownError(ws, error, runId, correlation)
    │
    ▼
DaemonClientRegistry.sendUnknownError
    │ 调用 fromUnknownError(error) 构造 CrishErrorPayload
    │   - 若 error instanceof CrishError: toErrorPayload(error)（保留 cause 链）
    │   - 否则: { code: "common.unknown", message: error.message, ... }
    ▼
DaemonClientRegistry.sendError(ws, payload, runId, correlation)
    │ 构造 ErrorMessage:
    │   { type: "error", code: payload.code, message: payload.message, runId?, payload, correlationId?, replyToId? }
    ▼
DaemonClientRegistry.send(ws, message)
    │ 调用 encodeOutboundMessage(message)
    │   → validateOutboundMessage → validateErrorMessage
    │     - 校验 code/message 为非空字符串
    │     - 校验 payload（若存在）符合 CrishErrorPayload 结构
    ▼
JSON.stringify(message) → WebSocket.send(payload)
```

#### 5.2.4 入站消息解码流程（R10 Rust 侧对齐准备）

Rust 侧（R10）的 `IpcResponse.error` 将从 `Option<String>` 迁移为 `Option<serde_json::Value>`（共存阶段）→ `Option<CrishErrorPayload>`（删除阶段）。daemon 侧的入站解码无需改动（daemon 不接收 error 消息，仅发送）。但 daemon 的出站 `ErrorMessage` 必须保证字段命名与 Rust 端 `CrishErrorPayload` 一致（camelCase）：

| TS 字段             | Rust 字段                                    | 类型                                                      |
| ------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `payload.code`      | `code`                                       | `String`                                                  |
| `payload.message`   | `message`                                    | `String`                                                  |
| `payload.category`  | `category`                                   | `String`（"transient"/"permanent"/"security"/"protocol"） |
| `payload.retryable` | `retryable`                                  | `bool`                                                    |
| `payload.public`    | `is_public`（`#[serde(rename = "public")]`） | `bool`                                                    |
| `payload.action`    | `action`                                     | `String`                                                  |
| `payload.metadata`  | `metadata`                                   | `Option<serde_json::Value>`                               |
| `payload.cause`     | `cause`                                      | `Option<Box<CrishErrorPayload>>`                          |
| `payload.stack`     | `stack`                                      | `Option<String>`                                          |
| `payload.timestamp` | `timestamp`                                  | `i64`                                                     |

### 5.3 验证策略

1. **向后兼容验证**（R7）：
   - 旧消费者（仅读 `code`/`message`）仍能工作：`ErrorMessage.payload` 可选，旧解析器忽略该字段。
   - `code` 与 `payload.code` 在迁移阶段保持一致（`sendError` 实现保证）。

2. **向前兼容验证**（R10 准备）：
   - 新消费者（Rust 侧）读取 `payload` 字段获取完整 `CrishErrorPayload`。
   - `payload.cause` 递归链最多 8 层（`CRISH_ERROR_CAUSE_MAX_DEPTH`），超出则截断为 `{ code: "common.unknown", message: "cause chain truncated" }`。
   - `payload.stack` 仅在非 production 环境序列化（`process.env.NODE_ENV !== "production"`）。

3. **端到端测试**（Agent 7-D 新增）：
   - `__tests__/error-propagation.e2e.test.ts` 验证完整传播链。
   - `__tests__/agent-protocol.e2e.test.ts` 验证新旧消费者兼容性。

### 5.4 Round 10 输入契约

本 Round 完成后，daemon 的 IPC `ErrorMessage` 满足以下 Round 10 输入契约：

| 契约项                                     | 说明                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `ErrorMessage.payload: CrishErrorPayload?` | 可选字段，承载结构化错误负载                                           |
| `payload.code` 为 `CrishErrorCode`         | `domain.reason` 格式，与 Rust 端 `CrishErrorPayload.code: String` 一致 |
| `payload.cause` 递归最多 8 层              | 与 Rust 端 `CRISH_ERROR_CAUSE_MAX_DEPTH = 8` 一致                      |
| `payload.timestamp` 为 epoch ms            | 与 Rust 端 `chrono::Utc::now().timestamp_millis()` 一致                |
| `payload.public` 控制用户可见性            | Rust 端 `is_public` 字段，前端据此决定是否展示                         |
| `payload.action` 为 i18n 键                | 前端按键查翻译，未命中回退英文原文                                     |

Round 10 Rust 侧将：

1. 在 `crates/conex-types/src/lib.rs` 实现 `CrishErrorPayload` struct（`03-ERROR-MIGRATION.md` §6.2）。
2. 将 `IpcResponse.error` 从 `Option<String>` 迁移为 `Option<serde_json::Value>`（共存阶段）。
3. Tauri command 返回 `Result<T, CrishErrorPayload>`，Tauri 自动序列化为 `IpcResponse.error`。
4. 前端（R11）`invoke()` catch 后用 `fromErrorPayload()` 还原为 `CrishError` 实例。

---

## 6. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，Round 7 结束前必须通过以下 8 项检查。

### 6.1 验证门禁清单

| 检查项           | 命令                                                      | 通过标准                                                | 负责 Agent |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------- | ---------- |
| TypeScript 编译  | `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json` | 错误数 ≤ Round 7 开始基线（`tsc-errors-baseline.json`） | 7-D        |
| Rust 编译        | `cargo check --workspace`                                 | 0 errors（daemon 不影响 Rust）                          | 7-D        |
| 单元测试（TS）   | `npx vitest run packages/agent-daemon/`                   | 全部通过（32 + 1 新增 = 33 测试文件）                   | 7-D        |
| 单元测试（Rust） | `cargo test --workspace`                                  | 全部通过（daemon 不影响 Rust）                          | 7-D        |
| 循环依赖         | `npm run lint:depcruise`                                  | 0 violations                                            | 7-D        |
| 构建             | `npx turbo run build --filter=@crish/agent-daemon`        | 成功                                                    | 7-D        |
| Lint             | `npm run lint`                                            | 0 errors（warn 不阻塞）                                 | 7-D        |
| Store 类型       | `npm run check:store-types`                               | 通过                                                    | 7-D        |

### 6.2 基线对比

| 指标                                    | Round 7 开始基线 | Round 7 结束目标                         | 实际值（待填） |
| --------------------------------------- | ---------------- | ---------------------------------------- | -------------- |
| TSC 错误数（daemon 范围）               | 待 7-D 记录      | ≤ 基线                                   | 待填           |
| `throw new Error` 数（daemon src）      | ~18              | ≤ 18（不恶化），争取 < 10                | 待填           |
| `throw new CrishError` 数（daemon src） | ~8               | ≥ 30（迁移后增加）                       | 待填           |
| 旧自由字符串码数（daemon IPC）          | ~13              | ≤ 13（不恶化），争取 0                   | 待填           |
| 测试文件数                              | 32               | 33（新增 error-propagation.e2e.test.ts） | 待填           |
| `@crish/logger` 依赖声明                | 未声明           | 已声明                                   | 待填           |

### 6.3 验证报告

Agent 7-D 完成后产出 `round-07-verification-report.md`，包含：

1. **8 项门禁检查结果**（命令输出摘要 + 通过/失败状态）。
2. **TSC 基线对比**（开始基线 vs 结束实际，按错误码分类）。
3. **throw 迁移追踪**（迁移前后的 throw 计数对比）。
4. **测试结果摘要**（通过数 / 失败数 / 跳过数）。
5. **已知遗留问题**（如某些 TSC 错误未修复，说明原因）。
6. **Round 10 输入契约达成情况**（§5.4 各契约项的验证结果）。

---

## 7. 交付物

### 7.1 代码交付物

| 交付物                          | 路径                                                                                                                                                                                                                                                                                   | 类型 | 负责 Agent |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| daemon-logger.ts re-export 验证 | `packages/agent-daemon/src/daemon-logger.ts`                                                                                                                                                                                                                                           | 修改 | 7-A        |
| P4 文件 throw 迁移              | `binary-frame.ts` / `env-whitelist.ts` / `mcp-config.ts` / `mcp-stdio-adapter.ts` / `handlers/session-handlers.ts` / `server-runtime-factory/index.ts` / `subagent-runtime.ts` / `daemon-provider-gateway/types.ts` / `daemon-provider-gateway/index.ts` / `daemon-client-registry.ts` | 修改 | 7-A        |
| ErrorMessage 类型扩展           | `packages/agent-daemon/src/types/protocol-outbound-run.ts`                                                                                                                                                                                                                             | 修改 | 7-B        |
| DaemonClientRegistry 扩展       | `packages/agent-daemon/src/daemon-client-registry.ts`                                                                                                                                                                                                                                  | 修改 | 7-B        |
| Protocol 验证器更新             | `packages/agent-daemon/src/protocol/validators/run.ts` + `common.ts`                                                                                                                                                                                                                   | 修改 | 7-B        |
| Handler 层 sendError 迁移       | `packages/agent-daemon/src/handlers/*.ts`（8 文件）                                                                                                                                                                                                                                    | 修改 | 7-B        |
| Server 核心 throw 迁移          | `packages/agent-daemon/src/server.ts`                                                                                                                                                                                                                                                  | 修改 | 7-C        |
| RunHandler CrishResult 化       | `packages/agent-daemon/src/handlers/run-handlers.ts` + 子目录                                                                                                                                                                                                                          | 修改 | 7-C        |
| Provider Gateway 接口适配       | `packages/agent-daemon/src/daemon-provider-gateway/*.ts`                                                                                                                                                                                                                               | 修改 | 7-C        |
| subagent-runtime 接口适配       | `packages/agent-daemon/src/subagent-runtime.ts`                                                                                                                                                                                                                                        | 修改 | 7-C        |
| daemon 生命周期 throw 迁移      | `daemon-lifecycle.ts` / `daemon-subagent-bridge.ts` / `subagent-lifecycle.ts` / `background-task-manager.ts` / `daemon-permission-policy.ts` / `daemon-approval-handler.ts`                                                                                                            | 修改 | 7-C        |
| 测试更新                        | `packages/agent-daemon/src/**/*.test.ts`（12+ 文件）                                                                                                                                                                                                                                   | 修改 | 7-D        |
| 端到端错误传播测试              | `packages/agent-daemon/src/__tests__/error-propagation.e2e.test.ts`                                                                                                                                                                                                                    | 新建 | 7-D        |
| TSC 修复                        | 视实际错误而定                                                                                                                                                                                                                                                                         | 修改 | 7-D        |
| package.json 依赖声明           | `packages/agent-daemon/package.json`                                                                                                                                                                                                                                                   | 修改 | 7-A        |

### 7.2 文档交付物

| 交付物                          | 路径                                                           | 类型                                                              | 负责 Agent |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- |
| Round 7 设计文档                | `analysis/iterative-repair/v2/ROUND-07-daemon.md`              | 新建（本文档）                                                    | 主 Agent   |
| 验证报告                        | `analysis/iterative-repair/v2/round-07-verification-report.md` | 新建                                                              | 7-D        |
| `02-FILE-MAPPING.md` §8 更新    | `analysis/iterative-repair/v2/02-FILE-MAPPING.md`              | 修改（标注 daemon-logger.ts 已迁移完成、ErrorMessage 类型已扩展） | 7-D        |
| `03-ERROR-MIGRATION.md` §4 更新 | `analysis/iterative-repair/v2/03-ERROR-MIGRATION.md`           | 修改（标注 daemon throw 迁移完成状态）                            | 7-D        |

### 7.3 接口契约交付物

以下接口契约为 Round 10 / Round 11 的输入：

| 契约                                       | 路径                                                       | 消费方                       |
| ------------------------------------------ | ---------------------------------------------------------- | ---------------------------- |
| `ErrorMessage.payload: CrishErrorPayload?` | `packages/agent-daemon/src/types/protocol-outbound-run.ts` | R10 Rust 侧 / R11 前端       |
| `DaemonClientRegistry.sendError` 重载签名  | `packages/agent-daemon/src/daemon-client-registry.ts`      | R11 前端（通过 daemon 进程） |
| `sendCrishError` / `sendUnknownError` 方法 | `packages/agent-daemon/src/daemon-client-registry.ts`      | daemon 内部 Handler 层       |
| `validateCrishErrorPayload` 共享校验函数   | `packages/agent-daemon/src/protocol/validators/common.ts`  | R10 Rust 侧校验对齐参考      |
| daemon 已迁移的错误码清单                  | 本文 §4                                                    | R12 删除阶段清理参考         |

---

## 附录 A：Agent 任务量自检表

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28，每个 Agent 必须满足 ≥ 5 文件或 ≥ 300 行变更。

| Agent | 文件数 | 行变更量（估） | 满足 |
| ----- | ------ | -------------- | ---- |
| 7-A   | 12     | ~320           | ✓    |
| 7-B   | 14     | ~350           | ✓    |
| 7-C   | 21     | ~400           | ✓    |
| 7-D   | 17+    | ~400           | ✓    |

## 附录 B：与其他 Round 的依赖关系

```
R1（类型基础）─→ R2（@crish/logger）─→ R6（orchestrator）─→ R7（daemon）─→ R10（Rust 对齐）
                                                                       │
                                                                       └─→ R11（前端韧性）
```

- **R6 → R7**：orchestrator 完成 CrishError 集成与日志迁移，为 daemon 提供参考实现与 `@crish/logger` 包。
- **R7 → R10**：daemon 的 `ErrorMessage.payload` 字段为 Rust 侧 `CrishErrorPayload` 对齐提供输入契约。
- **R7 → R11**：daemon 的 IPC 错误传播格式为前端错误翻译层提供数据源。
- **R7 不依赖 R8/R9**：daemon 的 `subagent-runtime.ts` 仅做接口适配，不依赖 R8 的 PluginRegistry 或 R9 的完整调度系统。

## 附录 C：subagent-runtime 接口适配边界

> 依据任务描述："subagent-runtime.ts 在本轮仅做接口适配，完整调度系统在 Round 9 实现"。

| 本轮做                                                        | 本轮不做（推迟到 R9）                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| throw 迁移到 `subagent.depth_exceeded` / `tool.invalid_input` | RecursionGuard 完整实现（maxDepth/maxSiblings/maxConcurrent 多维度） |
| 日志调用点迁移到 `@crish/logger`                              | ConcurrencyController（全局/每父/队列上限）                          |
| `startRun`/`cancelRun` 调用包装为 `CrishResult`               | SubagentScheduler（FIFO 调度队列）                                   |
| `DAEMON_SUBAGENT_BRIDGE_KIND` 常量附近添加 R9 待办注释        | SubagentInstance（状态机 + 超时 + 取消）                             |
|                                                               | DeadlockDetector（DFS 环检测）                                       |
|                                                               | ControlBus `correlationId` 语义扩展                                  |

**边界约束**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 20-22 与本 Round 推迟项）：

- 本轮不引入 `SubagentWatchdog.stuckDetection`（本 Round 推迟）。
- 本轮不引入 `TokenBudgetTracker`（本 Round 推迟，`RecursionGuard.totalTokenBudget` 字段预留为 0）。
- 本轮不引入 `priority`/`affinity` 调度策略（本 Round 推迟，FIFO 即可）。
- 本轮不引入 `isolationMode: worktree/process`（本 Round 推迟，仅支持 `none`）。
- 本轮不引入 `SubagentState.paused/resuming`（本 Round 推迟，4 状态机：pending/running/completed/failed）。
- 本轮不新建 `SubagentCommunicationBus`（禁令 20 禁止，复用 ControlBus）。

## 变更记录

| 版本 | 日期       | 变更                                                                                                |
| ---- | ---------- | --------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于 `01-OVERVIEW.md` / `02-FILE-MAPPING.md` / `03-ERROR-MIGRATION.md` 与 daemon 代码扫描生成 |
