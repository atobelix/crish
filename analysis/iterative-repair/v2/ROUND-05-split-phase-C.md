# Round 5：拆分 Phase-C（top 层 + 集成验证）

> **本文件是 Round 5 的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Agent 任务、文件迁移、依赖接线引用本文件时，必须以本文件的 Agent 分配与验证门禁为准。
>
> **前置文档**：
>
> - `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 包拆分边界、禁令 13-19 插件 SDK 约束、禁令 20-22 子代理调度约束、禁令 23-26 迁移策略与 Legacy Shim、禁令 27-28 Agent 任务量
> - `v2/01-OVERVIEW.md` §3 依赖图、§3.2 拓扑层级、§4.1 轮次总览
> - `v2/02-FILE-MAPPING.md` §2 文件映射表、§3 冲突解决、§9 依赖方向验证
> - `v2/03-ERROR-MIGRATION.md` §3.2 ErrorDomain 映射、§5.2 PipelineResult 统一、§7 迁移三阶段
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 14：LifecycleHookRegistry 必须保留 observe/on 双模式，禁止退化为单一 register
> - ROUND-09 §3.2：递归守卫默认值 maxDepth=3, maxSiblings=5, maxConcurrent=6（唯一权威值）
> - 禁令 20：禁止新建 SubagentCommunicationBus，子代理通信复用 ControlBus
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为迁移阶段
> - 禁令 24：Legacy shim 使用显式命名导出 + deprecation warning + v0.3.0 移除时间表
> - 禁令 26：TSC 错误数 ≤ 该轮基线（不恶化），不承诺清零
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 5 处于拓扑 Layer 4（top 层）与 Layer 5（子代理层），在 Round 4（middle 层）完成后执行。top 层包依赖 Round 1-4 创建的全部 leaf/middle 层包，是运行时执行内核。

```
Layer 0: shared-types, shared-utils, decision-engine          （已存在 / R1 增强）
Layer 1: @crish/logger, @crish/telemetry                       （R2 创建）
Layer 2: agent-context, agent-permissions, agent-mcp            （R3 创建 — leaf 层）
Layer 3: agent-tools, agent-model, agent-mcp[完整]             （R4 创建 — middle 层）
Layer 4: agent-core                                            （R5 创建 — top 层）← 本 Round
Layer 5: agent-subagent[骨架]                                  （R5 创建，R9 完整）
Layer 6: agent-orchestrator                                    （R6 重构）
Layer 8: plugin-sdk                                            （R8 重建）
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2）：

- Round 4 必须先于 Round 5：`agent-core` 依赖 `agent-tools` / `agent-model` / `agent-context` / `agent-permissions` / `agent-mcp`
- Round 5 完成后，Round 6（orchestrator）与 Round 8（plugin-sdk）可并行启动
- 循环依赖必须保持为 0（dependency-cruiser 强制）

### 1.2 目标包

| 目标包                          | 拓扑层  | 职责                                                                                                                                                                                                                                                                             | 创建 Agent | 文件数（约） |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| `@crish/agent-core`             | Layer 4 | 运行时执行内核：AgentRuntime / SessionLoop / StateMachine / ControlBus L1-L3 / SteeringCoordinator / RecoveryPipeline / ErrorClassifier / FallbackChain / Hooks 派发器 / RuntimeComponents / RuntimeMetrics / Config / Rendering / ProcessLifecycle / EventProtocol / EventQueue | 5-A, 5-B   | ~95          |
| `@crish/agent-subagent`（骨架） | Layer 5 | 子代理调度骨架：SubagentDepthGuard / AsyncSemaphore / SubagentScheduler 接口 / RecursionGuard 增强接口                                                                                                                                                                           | 5-C        | ~7           |

**包间依赖关系**（本 Round 建立的新边以 `[NEW]` 标注）：

| 包               | 依赖（→ 指向被依赖方）                                                                                                                               | 拓扑层  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `agent-core`     | `shared-types`, `shared-utils`, `agent-context`, `agent-tools`, `agent-model`, `agent-permissions`, `agent-mcp`, `@crish/logger`, `@crish/telemetry` | Layer 4 |
| `agent-subagent` | `agent-core` `[NEW]`, `agent-tools`, `agent-mcp`, `agent-context`, `shared-types`, `shared-utils`                                                    | Layer 5 |

> 依据 `02-FILE-MAPPING.md` §9.2 与 `01-OVERVIEW.md` §3 mermaid。`agent-subagent` 依赖 `agent-core`（非反向），由 `subagents.ts` import `AgentRuntime` from `./runtime` 实证（见 `02-FILE-MAPPING.md` 禁令 23）。

### 1.3 交付物清单

| 交付物                         | 路径                                              | 说明                                                    |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------- |
| `@crish/agent-core` 包         | `packages/agent-core/`                            | package.json + tsconfig.json + src/ 目录结构            |
| `@crish/agent-subagent` 骨架包 | `packages/agent-subagent/`                        | package.json + tsconfig.json + src/ 目录结构 + 接口骨架 |
| `agent-runtime` legacy shim    | `packages/agent-runtime/src/index.ts`             | 显式命名导出 + deprecation warning（禁令 24）           |
| 消费者 import 路径迁移         | agent-orchestrator / agent-daemon / crish-desktop | 指向新包                                                |
| 验证报告                       | 本文件 §7                                         | depcruise + turbo build + TSC 基线对比                  |

---

## 2. Agent 任务详细设计

### 2.1 Agent 5-A：agent-core 包创建 + 核心运行时文件迁移

| 维度     | 说明                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| **类型** | 创建型 + 迁移型                                                                                                        |
| **目标** | 创建 `@crish/agent-core` 包骨架，迁移核心运行时文件（core / session-loop / state-machine / control / steering）        |
| **前置** | Round 4 已创建 `agent-tools` / `agent-model` / `agent-mcp[完整]`；Round 3 已创建 `agent-context` / `agent-permissions` |
| **后续** | Agent 5-B 迁移 Recovery / Hooks / Components 等到本包；Agent 5-E 做集成验证                                            |

**输入**：

- `packages/agent-runtime/src/runtime.ts` + `.test.ts`
- `packages/agent-runtime/src/IAgentRuntime.ts`
- `packages/agent-runtime/src/runtime-defaults.ts`
- `packages/agent-runtime/src/runtime-helpers.ts` + `.test.ts`
- `packages/agent-runtime/src/session-loop/` 目录（8 文件 + 3 test）
- `packages/agent-runtime/src/state-machine/` 目录（6 文件 + 2 test）
- `packages/agent-runtime/src/control/` 目录（3 文件 + 1 test）
- `packages/agent-runtime/src/steering/` 目录（7 文件 + 1 test）

**输出**：

- `packages/agent-core/package.json`
- `packages/agent-core/tsconfig.json`
- `packages/agent-core/tsconfig.build.json`
- `packages/agent-core/src/index.ts`（barrel）
- `packages/agent-core/src/core/` 目录
- `packages/agent-core/src/session-loop/` 目录
- `packages/agent-core/src/state-machine/` 目录
- `packages/agent-core/src/control/` 目录
- `packages/agent-core/src/steering/` 目录

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.1、§2.7、§2.32、§2.34、§2.35）：

| 源文件                                                        | 目标路径                                                   | 说明                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `agent-runtime/src/runtime.ts`                                | `agent-core/src/core/runtime.ts`                           | AgentRuntime 核心                                                              |
| `agent-runtime/src/runtime.test.ts`                           | `agent-core/src/core/runtime.test.ts`                      |                                                                                |
| `agent-runtime/src/IAgentRuntime.ts`                          | `agent-core/src/core/IAgentRuntime.ts`                     | 运行时核心接口                                                                 |
| `agent-runtime/src/runtime-defaults.ts`                       | `agent-core/src/core/runtime-defaults.ts`                  | runtime 默认值                                                                 |
| `agent-runtime/src/runtime-helpers.ts`                        | `agent-core/src/core/runtime-helpers.ts`                   | runtime 辅助                                                                   |
| `agent-runtime/src/runtime-helpers.test.ts`                   | `agent-core/src/core/runtime-helpers.test.ts`              |                                                                                |
| `agent-runtime/src/types.ts`（运行时选项片段）                | `agent-core/src/core/runtime-options.ts`                   | types.ts 按域拆分，运行时配置选项归 agent-core（见 `02-FILE-MAPPING.md` §2.2） |
| `agent-runtime/src/session-loop/index.ts`                     | `agent-core/src/session-loop/index.ts`                     | SessionLoop 主体（38K）                                                        |
| `agent-runtime/src/session-loop/index.test.ts`                | `agent-core/src/session-loop/index.test.ts`                |                                                                                |
| `agent-runtime/src/session-loop/provider-call.ts`             | `agent-core/src/session-loop/provider-call.ts`             |                                                                                |
| `agent-runtime/src/session-loop/provider-call.test.ts`        | `agent-core/src/session-loop/provider-call.test.ts`        |                                                                                |
| `agent-runtime/src/session-loop/tool-execution.ts`            | `agent-core/src/session-loop/tool-execution.ts`            | 22K                                                                            |
| `agent-runtime/src/session-loop/steering-delegate.ts`         | `agent-core/src/session-loop/steering-delegate.ts`         |                                                                                |
| `agent-runtime/src/session-loop/recovery.ts`                  | `agent-core/src/session-loop/recovery.ts`                  |                                                                                |
| `agent-runtime/src/session-loop/control-check.ts`             | `agent-core/src/session-loop/control-check.ts`             |                                                                                |
| `agent-runtime/src/session-loop/control-check.test.ts`        | `agent-core/src/session-loop/control-check.test.ts`        |                                                                                |
| `agent-runtime/src/session-loop/types.ts`                     | `agent-core/src/session-loop/types.ts`                     |                                                                                |
| `agent-runtime/src/state-machine/core.ts`                     | `agent-core/src/state-machine/core.ts`                     | StateMachine 核心                                                              |
| `agent-runtime/src/state-machine/core.test.ts`                | `agent-core/src/state-machine/core.test.ts`                |                                                                                |
| `agent-runtime/src/state-machine/agent-session.ts`            | `agent-core/src/state-machine/agent-session.ts`            |                                                                                |
| `agent-runtime/src/state-machine/run-lifecycle.ts`            | `agent-core/src/state-machine/run-lifecycle.ts`            |                                                                                |
| `agent-runtime/src/state-machine/run-lifecycle.test.ts`       | `agent-core/src/state-machine/run-lifecycle.test.ts`       |                                                                                |
| `agent-runtime/src/state-machine/session-branch.ts`           | `agent-core/src/state-machine/session-branch.ts`           |                                                                                |
| `agent-runtime/src/state-machine/turn-types.ts`               | `agent-core/src/state-machine/turn-types.ts`               |                                                                                |
| `agent-runtime/src/state-machine/index.ts`                    | `agent-core/src/state-machine/index.ts`                    |                                                                                |
| `agent-runtime/src/control/control-bus.ts`                    | `agent-core/src/control/control-bus.ts`                    | ControlBus L1/L2/L3（成熟资产）                                                |
| `agent-runtime/src/control/control-bus.test.ts`               | `agent-core/src/control/control-bus.test.ts`               |                                                                                |
| `agent-runtime/src/control/types.ts`                          | `agent-core/src/control/types.ts`                          |                                                                                |
| `agent-runtime/src/control/index.ts`                          | `agent-core/src/control/index.ts`                          |                                                                                |
| `agent-runtime/src/steering/steering-coordinator.ts`          | `agent-core/src/steering/steering-coordinator.ts`          | SteeringCoordinator（成熟资产）                                                |
| `agent-runtime/src/steering/steering-input-queue.ts`          | `agent-core/src/steering/steering-input-queue.ts`          |                                                                                |
| `agent-runtime/src/steering/steering-input-queue.test.ts`     | `agent-core/src/steering/steering-input-queue.test.ts`     |                                                                                |
| `agent-runtime/src/steering/steering-types.ts`                | `agent-core/src/steering/steering-types.ts`                |                                                                                |
| `agent-runtime/src/steering/compression-recovery-strategy.ts` | `agent-core/src/steering/compression-recovery-strategy.ts` | 3 策略之一                                                                     |
| `agent-runtime/src/steering/goal-audit-strategy.ts`           | `agent-core/src/steering/goal-audit-strategy.ts`           | 3 策略之二                                                                     |
| `agent-runtime/src/steering/recovery-steering-strategy.ts`    | `agent-core/src/steering/recovery-steering-strategy.ts`    | 3 策略之三                                                                     |
| `agent-runtime/src/steering/index.ts`                         | `agent-core/src/steering/index.ts`                         |                                                                                |

**任务量**：34 文件迁移 + 4 配置文件创建 = 38 文件操作，远超 禁令 28 的 5 文件门槛。

**import 路径更新规则**：

- `from './types'` → `from '@crish/shared-types'`（AgentRuntimeOptions / AgentTool / ToolSource 已下沉 shared-types，见 `02-FILE-MAPPING.md` §2.2）
- `from './session'` → `from '@crish/agent-context'`（createId / nowIso）
- `from './tools'` → `from '@crish/agent-tools'`（ToolDefinition / RegisteredTool / ToolMiddleware）
- `from './provider'` → `from '@crish/agent-model'`（AgentProvider / ProviderStreamEvent）
- `from './mcp-lifecycle'` → `from '@crish/agent-mcp'`（McpLifecycleManager）
- `from './context-state'` → `from '@crish/agent-context'`（InMemoryContextState）
- `from './checkpoint'` → `from '@crish/agent-context'`（CheckpointManager）
- `from '../path-handling/conex-path'` → `from '@crish/shared-utils'`（path-handling 已在 R2 迁入 shared-utils）
- `from '@crish/shared-types'` → 保持不变
- `from '@crish/shared-utils'` → 保持不变
- 包内相对路径（`./core/runtime`、`./session-loop/index` 等）→ 保持不变

**关键设计约束**：

1. **保留 ControlBus L1/L2/L3**（成熟资产，`01-OVERVIEW.md` §1.3 确认）：ControlBus 的三层消息基础设施（L1 点对点 send / L2 AgentEvent 流订阅 / L3 correlationId request-response）逻辑完整迁移，不拆分、不重写。依据 禁令 20，子代理通信复用 ControlBus，禁止新建 SubagentCommunicationBus。
2. **保留 SteeringCoordinator + 3 策略**（成熟资产）：`steering-coordinator.ts` + `compression-recovery-strategy.ts` + `goal-audit-strategy.ts` + `recovery-steering-strategy.ts` 整体迁移，保留现有调度逻辑。
3. **types.ts 按域拆分**：`types.ts` 中的运行时配置选项类型迁入 `agent-core/src/core/runtime-options.ts`；provider 接口迁入 agent-model（R4 已完成）；session store 纯类型入 shared-types（R1 已完成）；AgentTool / ToolSource 入 shared-types（R1 已完成）。见 `02-FILE-MAPPING.md` §2.2。
4. **agent-core 是 top 层**：依赖 Round 3-4 创建的所有 leaf/middle 包，不反向依赖任何上层包。

**验证标准**：

- `packages/agent-core/` 目录结构完整
- `package.json` 的 `dependencies` 声明正确（见 §3.1）
- 迁移文件数 = 34（含测试文件）
- `agent-runtime` 中被迁移文件保留（共存阶段，guardrails 禁令 23）
- ControlBus L1/L2/L3 逻辑完整（对照原文件行数）
- SteeringCoordinator + 3 策略文件完整

**协调点**：0 次（独立完成，不依赖其他 Agent）

---

### 2.2 Agent 5-B：agent-core — Recovery/Hooks/Components/Metrics/Config/Rendering 迁移

| 维度     | 说明                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型** | 迁移型 + 实现型（错误码桥接）                                                                                                                                                                     |
| **目标** | 迁移 Recovery / Hooks / RuntimeComponents / RuntimeMetrics / Config / Rendering / ProcessLifecycle / EventProtocol / EventQueue 等到 agent-core，完成 error-classifier 桥接与 PipelineResult 统一 |
| **前置** | Agent 5-A 已创建 `agent-core` 包骨架与 core/session-loop/state-machine/control/steering 目录                                                                                                      |
| **后续** | Agent 5-E 做依赖接线与验证                                                                                                                                                                        |

**输入**：

- `packages/agent-runtime/src/error-classifier.ts`（261 行，成熟资产）
- `packages/agent-runtime/src/recovery-pipeline.ts`（184 行，成熟资产）+ `.test.ts`
- `packages/agent-runtime/src/recovery/` 目录（stream-recovery.ts）
- `packages/agent-runtime/src/fallback-chain/` 目录（4 文件）
- `packages/agent-runtime/src/hooks/` 目录（12 文件）
- `packages/agent-runtime/src/runtime-components/` 目录（17 文件）
- `packages/agent-runtime/src/runtime-metrics/` 目录（4 文件）+ `runtime-metrics.ts`（根文件）+ `.test.ts`
- `packages/agent-runtime/src/config/` 目录（2 文件）
- `packages/agent-runtime/src/rendering/` 目录（2 文件）
- `packages/agent-runtime/src/process-lifecycle/` 目录（4 文件）
- `packages/agent-runtime/src/agent-input-queue.ts` + `.test.ts`
- `packages/agent-runtime/src/agent-session-loop.ts` + `.test.ts`
- `packages/agent-runtime/src/event-protocol/` 目录（4 文件）
- `packages/agent-runtime/src/event-queue/` 目录（2 文件）
- `packages/agent-runtime/src/testing/` 目录（6 文件）+ `testing.ts`（根文件）+ `.test.ts`
- `packages/agent-runtime/src/tool-stream/` 目录（2 文件）
- `packages/agent-runtime/src/plan-document/` 目录（5 文件）+ `plan-document.ts`（根文件）+ `.test.ts`
- `packages/agent-runtime/src/stream/thinking-config.ts` + `.test.ts`
- `packages/agent-runtime/src/__tests__/error-classifier.test.ts`
- `packages/agent-runtime/src/__tests__/steering-input-queue.test.ts`
- `packages/agent-runtime/src/__tests__/integrations/state-machine.test.ts`
- `packages/agent-runtime/src/__tests__/integrations/tool-stream.test.ts`

**边界澄清**（依据 `02-FILE-MAPPING.md` §2.8 与 §3 冲突解决第 6 项）：

- **`event-architecture/` 目录不归 agent-core**：`canonical-event.ts` / `index.ts` / `canonical-event.test.ts` 已在 Round 3 迁入 `agent-context`（leaf 层必需，若归 agent-core 会导致 agent-context 反向依赖 top 层）。agent-core 的"EventArchitecture"指代 `event-protocol/` + `event-queue/`（运行时事件基础设施），见 `02-FILE-MAPPING.md` §2.9、§2.10。
- **`goal-disk-oracle.ts` 不归 agent-core**：依据 `02-FILE-MAPPING.md` §2.1，`goal-disk-oracle.ts` → `agent-context`，已在 Round 3 迁移。本 Round 不处理此文件。

**输出**：

- `packages/agent-core/src/recovery/` 目录
- `packages/agent-core/src/error-classifier.ts`（含 toCrishErrorCode 桥接）
- `packages/agent-core/src/recovery-pipeline.ts`（PipelineResult 增加 CrishError 字段）
- `packages/agent-core/src/fallback-chain/` 目录
- `packages/agent-core/src/hooks/` 目录
- `packages/agent-core/src/runtime-components/` 目录
- `packages/agent-core/src/runtime-metrics/` 目录
- `packages/agent-core/src/config/` 目录
- `packages/agent-core/src/rendering/` 目录
- `packages/agent-core/src/process-lifecycle/` 目录
- `packages/agent-core/src/event-protocol/` 目录
- `packages/agent-core/src/event-queue/` 目录
- `packages/agent-core/src/testing/` 目录
- `packages/agent-core/src/tool-stream/` 目录
- `packages/agent-core/src/plan-document/` 目录
- `packages/agent-core/src/stream/thinking-config.ts`

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.1、§2.5、§2.9、§2.10、§2.11、§2.13、§2.21、§2.22、§2.27、§2.28、§2.29、§2.30、§2.36、§2.37、§2.38、§2.41）：

**Recovery 域（error-classifier + recovery-pipeline + recovery/ + fallback-chain/）**：

| 源文件                                                 | 目标路径                                            | 说明                                      |
| ------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------- |
| `agent-runtime/src/error-classifier.ts`                | `agent-core/src/error-classifier.ts`                | 261 行，成熟资产（需桥接 CrishError）     |
| `agent-runtime/src/recovery-pipeline.ts`               | `agent-core/src/recovery-pipeline.ts`               | 184 行，PipelineResult 统一为 CrishResult |
| `agent-runtime/src/recovery-pipeline.test.ts`          | `agent-core/src/recovery-pipeline.test.ts`          |                                           |
| `agent-runtime/src/recovery/stream-recovery.ts`        | `agent-core/src/recovery/stream-recovery.ts`        |                                           |
| `agent-runtime/src/recovery/stream-recovery.test.ts`   | `agent-core/src/recovery/stream-recovery.test.ts`   |                                           |
| `agent-runtime/src/fallback-chain/engine.ts`           | `agent-core/src/fallback-chain/engine.ts`           | FallbackChain 引擎                        |
| `agent-runtime/src/fallback-chain/engine.test.ts`      | `agent-core/src/fallback-chain/engine.test.ts`      |                                           |
| `agent-runtime/src/fallback-chain/types.ts`            | `agent-core/src/fallback-chain/types.ts`            |                                           |
| `agent-runtime/src/fallback-chain/index.ts`            | `agent-core/src/fallback-chain/index.ts`            |                                           |
| `agent-runtime/src/__tests__/error-classifier.test.ts` | `agent-core/src/__tests__/error-classifier.test.ts` | 集成测试                                  |

**Hooks 域（hooks/）**：

| 源文件                                               | 目标路径                                          | 说明                                          |
| ---------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `agent-runtime/src/hooks/agent-hooks.ts`             | `agent-core/src/hooks/agent-hooks.ts`             | deprecated 适配器                             |
| `agent-runtime/src/hooks/lifecycle-hooks.ts`         | `agent-core/src/hooks/lifecycle-hooks.ts`         | 348 行，必须保留 observe/on 双模式（禁令 14） |
| `agent-runtime/src/hooks/lifecycle-hooks.test.ts`    | `agent-core/src/hooks/lifecycle-hooks.test.ts`    |                                               |
| `agent-runtime/src/hooks/extension-registry.ts`      | `agent-core/src/hooks/extension-registry.ts`      |                                               |
| `agent-runtime/src/hooks/health-hook-pack.ts`        | `agent-core/src/hooks/health-hook-pack.ts`        |                                               |
| `agent-runtime/src/hooks/health-hook-pack.test.ts`   | `agent-core/src/hooks/health-hook-pack.test.ts`   |                                               |
| `agent-runtime/src/hooks/hook-types.ts`              | `agent-core/src/hooks/hook-types.ts`              | R8 纯类型下沉 shared-types                    |
| `agent-runtime/src/hooks/compact-lifecycle.ts`       | `agent-core/src/hooks/compact-lifecycle.ts`       |                                               |
| `agent-runtime/src/hooks/compact-lifecycle.test.ts`  | `agent-core/src/hooks/compact-lifecycle.test.ts`  |                                               |
| `agent-runtime/src/hooks/tool-hook-observability.ts` | `agent-core/src/hooks/tool-hook-observability.ts` |                                               |
| `agent-runtime/src/hooks/tool-hook-types.ts`         | `agent-core/src/hooks/tool-hook-types.ts`         | R8 纯类型下沉 shared-types                    |
| `agent-runtime/src/hooks/index.ts`                   | `agent-core/src/hooks/index.ts`                   |                                               |

**RuntimeComponents 域（runtime-components/）**：

| 源文件                                                                    | 目标路径                                                               | 说明                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| `agent-runtime/src/runtime-components/conversation-engine.ts`             | `agent-core/src/runtime-components/conversation-engine.ts`             |                           |
| `agent-runtime/src/runtime-components/conversation-engine.test.ts`        | `agent-core/src/runtime-components/conversation-engine.test.ts`        |                           |
| `agent-runtime/src/runtime-components/context-manager.ts`                 | `agent-core/src/runtime-components/context-manager.ts`                 | 运行时与 context 集成胶水 |
| `agent-runtime/src/runtime-components/context-manager.test.ts`            | `agent-core/src/runtime-components/context-manager.test.ts`            |                           |
| `agent-runtime/src/runtime-components/provider-call-gateway.ts`           | `agent-core/src/runtime-components/provider-call-gateway.ts`           |                           |
| `agent-runtime/src/runtime-components/provider-call-gateway.test.ts`      | `agent-core/src/runtime-components/provider-call-gateway.test.ts`      |                           |
| `agent-runtime/src/runtime-components/tool-executor.ts`                   | `agent-core/src/runtime-components/tool-executor.ts`                   |                           |
| `agent-runtime/src/runtime-components/tool-executor.test.ts`              | `agent-core/src/runtime-components/tool-executor.test.ts`              |                           |
| `agent-runtime/src/runtime-components/tool-executor-timeout.test.ts`      | `agent-core/src/runtime-components/tool-executor-timeout.test.ts`      |                           |
| `agent-runtime/src/runtime-components/provider-response-consumer.ts`      | `agent-core/src/runtime-components/provider-response-consumer.ts`      |                           |
| `agent-runtime/src/runtime-components/provider-response-consumer.test.ts` | `agent-core/src/runtime-components/provider-response-consumer.test.ts` |                           |
| `agent-runtime/src/runtime-components/single-tool-executor.ts`            | `agent-core/src/runtime-components/single-tool-executor.ts`            |                           |
| `agent-runtime/src/runtime-components/context-compression-gate.ts`        | `agent-core/src/runtime-components/context-compression-gate.ts`        |                           |
| `agent-runtime/src/runtime-components/context-compression-gate.test.ts`   | `agent-core/src/runtime-components/context-compression-gate.test.ts`   |                           |
| `agent-runtime/src/runtime-components/execution-strategy.ts`              | `agent-core/src/runtime-components/execution-strategy.ts`              |                           |
| `agent-runtime/src/runtime-components/token-estimator.ts`                 | `agent-core/src/runtime-components/token-estimator.ts`                 |                           |
| `agent-runtime/src/runtime-components/tool-executor-options.ts`           | `agent-core/src/runtime-components/tool-executor-options.ts`           |                           |
| `agent-runtime/src/runtime-components/index.ts`                           | `agent-core/src/runtime-components/index.ts`                           |                           |

**Metrics / Config / Rendering / ProcessLifecycle 域**：

| 源文件                                                         | 目标路径                                                    | 说明          |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| `agent-runtime/src/runtime-metrics.ts`                         | `agent-core/src/runtime-metrics.ts`                         | 根文件 barrel |
| `agent-runtime/src/runtime-metrics.test.ts`                    | `agent-core/src/runtime-metrics.test.ts`                    |               |
| `agent-runtime/src/runtime-metrics/collectors.ts`              | `agent-core/src/runtime-metrics/collectors.ts`              |               |
| `agent-runtime/src/runtime-metrics/index.ts`                   | `agent-core/src/runtime-metrics/index.ts`                   |               |
| `agent-runtime/src/runtime-metrics/snapshot.ts`                | `agent-core/src/runtime-metrics/snapshot.ts`                |               |
| `agent-runtime/src/runtime-metrics/types.ts`                   | `agent-core/src/runtime-metrics/types.ts`                   |               |
| `agent-runtime/src/config/config-merger.ts`                    | `agent-core/src/config/config-merger.ts`                    |               |
| `agent-runtime/src/config/index.ts`                            | `agent-core/src/config/index.ts`                            |               |
| `agent-runtime/src/rendering/index.ts`                         | `agent-core/src/rendering/index.ts`                         |               |
| `agent-runtime/src/rendering/rendering-pipeline.ts`            | `agent-core/src/rendering/rendering-pipeline.ts`            |               |
| `agent-runtime/src/process-lifecycle/index.ts`                 | `agent-core/src/process-lifecycle/index.ts`                 |               |
| `agent-runtime/src/process-lifecycle/process-executor.ts`      | `agent-core/src/process-lifecycle/process-executor.ts`      |               |
| `agent-runtime/src/process-lifecycle/process-executor.test.ts` | `agent-core/src/process-lifecycle/process-executor.test.ts` |               |
| `agent-runtime/src/process-lifecycle/process-manager.ts`       | `agent-core/src/process-lifecycle/process-manager.ts`       |               |

**根文件 + EventProtocol + EventQueue 域**：

| 源文件                                                          | 目标路径                                                     | 说明             |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `agent-runtime/src/agent-input-queue.ts`                        | `agent-core/src/agent-input-queue.ts`                        | Agent 输入队列   |
| `agent-runtime/src/agent-input-queue.test.ts`                   | `agent-core/src/agent-input-queue.test.ts`                   |                  |
| `agent-runtime/src/agent-session-loop.ts`                       | `agent-core/src/agent-session-loop.ts`                       | SessionLoop 主体 |
| `agent-runtime/src/agent-session-loop.test.ts`                  | `agent-core/src/agent-session-loop.test.ts`                  |                  |
| `agent-runtime/src/event-protocol/core-event-projector.ts`      | `agent-core/src/event-protocol/core-event-projector.ts`      |                  |
| `agent-runtime/src/event-protocol/core-event-projector.test.ts` | `agent-core/src/event-protocol/core-event-projector.test.ts` |                  |
| `agent-runtime/src/event-protocol/core-event-types.ts`          | `agent-core/src/event-protocol/core-event-types.ts`          |                  |
| `agent-runtime/src/event-protocol/index.ts`                     | `agent-core/src/event-protocol/index.ts`                     |                  |
| `agent-runtime/src/event-queue/index.ts`                        | `agent-core/src/event-queue/index.ts`                        |                  |
| `agent-runtime/src/event-queue/index.test.ts`                   | `agent-core/src/event-queue/index.test.ts`                   |                  |

**Testing / ToolStream / PlanDocument / ThinkingConfig 域**：

| 源文件                                                           | 目标路径                                                      | 说明                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `agent-runtime/src/testing.ts`                                   | `agent-core/src/testing.ts`                                   | 测试工具 barrel                      |
| `agent-runtime/src/testing.test.ts`                              | `agent-core/src/testing.test.ts`                              |                                      |
| `agent-runtime/src/testing/index.ts`                             | `agent-core/src/testing/index.ts`                             |                                      |
| `agent-runtime/src/testing/faux-provider.ts`                     | `agent-core/src/testing/faux-provider.ts`                     |                                      |
| `agent-runtime/src/testing/faux-call-gateway.ts`                 | `agent-core/src/testing/faux-call-gateway.ts`                 |                                      |
| `agent-runtime/src/testing/mock-tool.ts`                         | `agent-core/src/testing/mock-tool.ts`                         |                                      |
| `agent-runtime/src/testing/fixture-loader.ts`                    | `agent-core/src/testing/fixture-loader.ts`                    |                                      |
| `agent-runtime/src/testing/__tests__/faux-provider.test.ts`      | `agent-core/src/testing/__tests__/faux-provider.test.ts`      |                                      |
| `agent-runtime/src/tool-stream/tool-stream.ts`                   | `agent-core/src/tool-stream/tool-stream.ts`                   | 运行时工具流                         |
| `agent-runtime/src/tool-stream/tool-stream.test.ts`              | `agent-core/src/tool-stream/tool-stream.test.ts`              |                                      |
| `agent-runtime/src/plan-document.ts`                             | `agent-core/src/plan-document.ts`                             | 根文件                               |
| `agent-runtime/src/plan-document.test.ts`                        | `agent-core/src/plan-document.test.ts`                        |                                      |
| `agent-runtime/src/plan-document/index.ts`                       | `agent-core/src/plan-document/index.ts`                       |                                      |
| `agent-runtime/src/plan-document/markdown.ts`                    | `agent-core/src/plan-document/markdown.ts`                    |                                      |
| `agent-runtime/src/plan-document/operations.ts`                  | `agent-core/src/plan-document/operations.ts`                  |                                      |
| `agent-runtime/src/plan-document/types.ts`                       | `agent-core/src/plan-document/types.ts`                       |                                      |
| `agent-runtime/src/plan-document/validation.ts`                  | `agent-core/src/plan-document/validation.ts`                  |                                      |
| `agent-runtime/src/stream/thinking-config.ts`                    | `agent-core/src/stream/thinking-config.ts`                    | thinking 配置（运行时关注点，§2.36） |
| `agent-runtime/src/stream/thinking-config.test.ts`               | `agent-core/src/stream/thinking-config.test.ts`               |                                      |
| `agent-runtime/src/__tests__/steering-input-queue.test.ts`       | `agent-core/src/__tests__/steering-input-queue.test.ts`       | 集成测试                             |
| `agent-runtime/src/__tests__/integrations/state-machine.test.ts` | `agent-core/src/__tests__/integrations/state-machine.test.ts` | 集成测试                             |
| `agent-runtime/src/__tests__/integrations/tool-stream.test.ts`   | `agent-core/src/__tests__/integrations/tool-stream.test.ts`   | 集成测试                             |

**任务量**：73 文件迁移 + 2 桥接实现 = 75 文件操作，远超 禁令 28 门槛。

**error-classifier 桥接实现**（引用 `03-ERROR-MIGRATION.md` §3.2）：

在 `agent-core/src/error-classifier.ts` 中新增 `ClassifiedError.toCrishErrorCode()` 方法，保留现有 `ErrorClassifier.classify()` 签名不变（共存阶段）：

```ts
import type { CrishErrorCode } from '@crish/shared-types';

/**
 * ErrorDomain → CrishErrorCode 映射（引用 03-ERROR-MIGRATION.md §3.2）
 *
 * 共存阶段：ClassifiedError 保留 domain/legacyKind 字段，新增 toCrishErrorCode()。
 * 删除阶段（R12）：ErrorDomain 枚举移除，ErrorClassifier 直接输出 CrishErrorCode。
 */
export function domainToCrishErrorCode(
  domain: ErrorDomain,
  context?: { subType?: string; providerId?: string }
): CrishErrorCode {
  switch (domain) {
    case ErrorDomain.USER_ABORT:
      return context?.providerId ? 'provider.cancelled' : 'runtime.aborted';
    case ErrorDomain.TRANSIENT_NETWORK:
      return context?.providerId ? 'provider.network' : 'network.unreachable';
    case ErrorDomain.TRANSIENT_SERVER:
      return 'provider.server';
    case ErrorDomain.RATE_LIMIT:
      return 'provider.rate_limit';
    case ErrorDomain.CLIENT_AUTH:
      return 'provider.auth';
    case ErrorDomain.CLIENT_INVALID_INPUT:
      return context?.subType === 'context_length_exceeded'
        ? 'context.length_exceeded'
        : 'provider.schema';
    case ErrorDomain.QUOTA_EXHAUSTED:
      return 'provider.quota';
    case ErrorDomain.STREAM_INTERRUPT:
      return 'provider.stream_interrupted';
    case ErrorDomain.ENDPOINT_UNAVAILABLE:
      return 'provider.endpoint_unavailable';
    case ErrorDomain.GATEWAY_CHALLENGE:
      return 'provider.gateway_challenge';
    case ErrorDomain.UNKNOWN:
      return context?.providerId ? 'provider.unknown' : 'common.unknown';
  }
}
```

**PipelineResult 统一为 CrishResult**（引用 `03-ERROR-MIGRATION.md` §5.2）：

在 `agent-core/src/recovery-pipeline.ts` 中，`PipelineResult` 在迁移阶段增加 `error: CrishError` 字段与原 `error: ClassifiedError` 并存：

```ts
import type { CrishResult, CrishError } from '@crish/shared-types';

/**
 * 迁移阶段：PipelineResult 增加 error: CrishError 字段，与原 error: ClassifiedError 并存。
 * 删除阶段（R12）：移除 error: ClassifiedError，统一为 CrishResult。
 *
 * tierUsed 作为扩展字段保留，不破坏 Result ADT 主结构。
 */
export type PipelineResult =
  | {
      ok: true;
      events: AsyncIterable<ProviderStreamEvent>;
      tierUsed: 1 | 2 | 3;
    }
  | { ok: false; error: ClassifiedError; crishError?: CrishError };
```

**关键设计约束**：

1. **LifecycleHookRegistry 双模式保留**（禁令 14）：
   - `observe(event, handler)`：容错并行，失败吞掉，不影响主路径。用于日志、监控、审计。
   - `on(event, handler)`：串行语义合并，可返回控制信号（`stop` / `block` / `modifiedInput` / `modifiedOutput`）。用于权限拦截、内容修改。
   - 现有 `shouldStopAfterTurn` / `prepareNextTurn` / `ToolHook.onError`（返回 retry/skip/abort）等控制型钩子能力必须保留。
   - 事件名保留现有命名（`turn.start` / `turn.end` / `tool.pre` / `tool.post` / `context.compact.start` / `context.compact.end`）。
   - `ContextCompactEndPayload` 的 `aborted` / `trigger` / `compactionId` / `keptMessageCount` 等诊断字段必须保留。
2. **error-classifier 桥接**（引用 `03-ERROR-MIGRATION.md` §3.2）：新增 `toCrishErrorCode()` 方法，保留 `classify()` 签名不变。
3. **PipelineResult 统一**：增加 `crishError?: CrishError` 字段与原 `error: ClassifiedError` 并存，删除阶段（R12）移除旧字段。
4. **不迁移 event-architecture/**：该目录归 agent-context（R3 已迁移），agent-core 的 EventArchitecture = event-protocol/ + event-queue/。
5. **不迁移 goal-disk-oracle.ts**：该文件归 agent-context（R3 已迁移）。

**验证标准**：

- 73 文件成功迁移
- `error-classifier.ts` 含 `domainToCrishErrorCode()` 函数
- `recovery-pipeline.ts` 的 `PipelineResult` 含 `crishError?: CrishError` 字段
- `lifecycle-hooks.ts` 保留 observe/on 双模式（对照原 348 行）
- agent-core/src/ 目录结构完整

**协调点**：1 次（依赖 Agent 5-A 已创建包骨架）

---

### 2.3 Agent 5-C：agent-subagent 骨架创建 + 文件迁移

| 维度     | 说明                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **类型** | 创建型 + 迁移型 + 实现型（接口骨架）                                                                                           |
| **目标** | 创建 `@crish/agent-subagent` 骨架包，迁移子代理文件（保留 ~60%，重写 ~40%），定义 SubagentScheduler 与 RecursionGuard 增强接口 |
| **前置** | Agent 5-A 已创建 `agent-core` 包（agent-subagent 依赖 agent-core）                                                             |
| **后续** | Round 9 完整实现 SubagentScheduler / DeadlockDetector / ConcurrencyController                                                  |

**输入**：

- `packages/agent-runtime/src/subagents.ts`（560 行，SubagentDepthGuard + AsyncSemaphore）
- `packages/agent-runtime/src/subagents.test.ts`
- `packages/agent-runtime/src/subagent-loop.ts`
- `packages/agent-runtime/src/subagent-skill-runner.ts`
- `packages/agent-runtime/src/subagent-types.ts`
- `packages/agent-runtime/src/subagent-context-pack.ts` + `.test.ts`

**输出**：

- `packages/agent-subagent/package.json`
- `packages/agent-subagent/tsconfig.json`
- `packages/agent-subagent/tsconfig.build.json`
- `packages/agent-subagent/src/index.ts`（barrel）
- `packages/agent-subagent/src/subagents.ts`（保留 ~60%，重写 ~40%）
- `packages/agent-subagent/src/subagent-loop.ts`
- `packages/agent-subagent/src/subagent-skill-runner.ts`
- `packages/agent-subagent/src/subagent-types.ts`
- `packages/agent-subagent/src/subagent-context-pack.ts`
- `packages/agent-subagent/src/scheduler.ts`（SubagentScheduler 接口骨架）
- `packages/agent-subagent/src/recursion-guard.ts`（RecursionGuard 增强接口）

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.1）：

| 源文件                                            | 目标路径                                           | 说明                        |
| ------------------------------------------------- | -------------------------------------------------- | --------------------------- |
| `agent-runtime/src/subagents.ts`                  | `agent-subagent/src/subagents.ts`                  | 560 行，保留 ~60% 重写 ~40% |
| `agent-runtime/src/subagents.test.ts`             | `agent-subagent/src/subagents.test.ts`             |                             |
| `agent-runtime/src/subagent-loop.ts`              | `agent-subagent/src/subagent-loop.ts`              |                             |
| `agent-runtime/src/subagent-skill-runner.ts`      | `agent-subagent/src/subagent-skill-runner.ts`      |                             |
| `agent-runtime/src/subagent-types.ts`             | `agent-subagent/src/subagent-types.ts`             |                             |
| `agent-runtime/src/subagent-context-pack.ts`      | `agent-subagent/src/subagent-context-pack.ts`      |                             |
| `agent-runtime/src/subagent-context-pack.test.ts` | `agent-subagent/src/subagent-context-pack.test.ts` |                             |

**subagents.ts 保留/重写策略**：

| 内容片段                               | 处理     | 理由                                                  |
| -------------------------------------- | -------- | ----------------------------------------------------- |
| `SubagentDepthGuard` 接口定义          | 保留     | 成熟类型定义，Round 9 增强                            |
| `AsyncSemaphore` 实例（并发 6）        | 保留     | 现有并发控制可用                                      |
| `SubagentMode` / `SubagentStatus` 类型 | 保留     | 标签类型                                              |
| 进度事件类型与渲染函数                 | 保留     | 成熟 UI 辅助                                          |
| `buildSubagentContextPack` 调用        | 保留     | context pack 逻辑成熟                                 |
| provider 解析逻辑                      | 保留     | 从 agent-model 获取 provider                          |
| **递归守卫默认值**                     | **重写** | maxDepth 2→3, maxSiblings 4→5（ROUND-09 §3.2 权威值） |
| **并发控制逻辑**                       | **重写** | 扩展为多维度（全局/每父/队列上限），Round 9 完整      |
| **递归守卫执行**                       | **重写** | 增加 maxSiblings 检查 + ancestorSessionIds 追踪       |
| **执行循环**                           | **重写** | 简化为骨架，Round 9 实现 SubagentInstance 状态机      |

**import 路径更新规则**：

- `from './runtime'` → `from '@crish/agent-core'`（AgentRuntime，见 `02-FILE-MAPPING.md` 禁令 23 实证）
- `from './session'` → `from '@crish/agent-context'`（createId / nowIso）
- `from './project-progress-ledger'` → `from '@crish/agent-context'`
- `from './subagent-context-pack'` → 包内相对路径（已在 agent-subagent 内）
- `from './tools'` → `from '@crish/agent-tools'`（defineTool）
- `from './types'` → `from '@crish/shared-types'`（AgentRuntimeOptions / AgentTool / ToolSource 已下沉）
- `from './context-state'` → `from '@crish/agent-context'`（InMemoryContextState）
- `from '@crish/shared-utils'` → 保持不变（AsyncSemaphore）
- `from '@crish/shared-types'` → 保持不变

**任务量**：7 文件迁移 + 2 接口骨架创建 + 4 配置文件 = 13 文件操作，加上 subagents.ts 的 ~40% 重写（~224 行变更），超过 禁令 28 门槛。

**关键设计约束**：

1. **agent-subagent 仅骨架**（禁令 20）：SubagentScheduler 仅定义接口签名，Round 9 实现。DeadlockDetector / ConcurrencyController / SubagentInstance 的完整实现推迟到 Round 9。
2. **递归守卫默认值**（ROUND-09 §3.2 权威值）：maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0。
3. **禁止新建 SubagentCommunicationBus**（禁令 20）：子代理通信复用 ControlBus（L1 send / L2 subscribe / L3 request-response）。
4. **SubagentRole 为标签**（禁令 21）：`role` 仅用于展示和过滤，`capabilityMode` 控制实际权限。
5. **子代理发现推迟**（禁令 22）：子代理发现统一到插件系统（Round 8 PluginRegistry），本 Round 不实现发现机制。

**验证标准**：

- `packages/agent-subagent/` 目录结构完整
- `subagents.ts` 保留 ~60% 原 logic（SubagentDepthGuard / AsyncSemaphore / 类型定义 / 进度事件 / context pack / provider 解析）
- `subagents.ts` 重写 ~40%（递归守卫默认值更新 + 并发控制骨架 + 执行循环简化）
- `scheduler.ts` 含 `SubagentScheduler` 接口定义
- `recursion-guard.ts` 含 `RecursionGuard` 增强接口
- `package.json` 的 `dependencies` 声明正确（见 §4.1）

**协调点**：1 次（依赖 Agent 5-A 已创建 agent-core 包）

---

### 2.4 Agent 5-D：agent-runtime legacy shim + 剩余文件迁移

| 维度     | 说明                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型 + 迁移型                                                                                                 |
| **目标** | 将 agent-runtime 转为 legacy shim（显式命名导出 + deprecation warning + v0.3.0 移除时间表），迁移剩余未分配文件 |
| **前置** | Agent 5-A ~ 5-C 已完成 agent-core / agent-subagent 文件迁移                                                     |
| **后续** | Agent 5-E 做全系统集成验证                                                                                      |

**输入**：

- `packages/agent-runtime/src/index.ts`（当前 barrel）
- `packages/agent-runtime/package.json`
- 剩余未分配文件（根据 `02-FILE-MAPPING.md` §4 遗漏文件补录核对）

**输出**：

- `packages/agent-runtime/src/index.ts`（legacy shim，显式命名导出 + deprecation warning）
- `packages/agent-runtime/package.json`（增加全部 8 个子包依赖）

**任务 1：agent-runtime legacy shim**

依据 禁令 24，`agent-runtime` 作为 re-export 8 个子包的 barrel shim 是允许的过渡措施，但必须遵守：

- 使用显式命名导出，禁止 `export * from '@crish/agent-core'`（会导致符号冲突）
- 设置 deprecation warning：shim 被导入时输出 `console.warn('[deprecated] @crish/agent-runtime is deprecated, import from @crish/agent-core directly')`
- 移除时间表：shim 在 v0.3.0 版本必须删除。所有消费者必须在 v0.3.0 前完成 import 路径迁移

**任务 2：剩余未分配文件核对与迁移**

根据 `02-FILE-MAPPING.md` §4 遗漏文件补录，核对以下文件是否已在 Round 2-4 迁移，若有遗漏则补迁移：

| 文件/目录                                      | 应归属包                  | 迁移状态核对                              |
| ---------------------------------------------- | ------------------------- | ----------------------------------------- |
| `path-handling/`                               | shared-utils              | R2 应已迁移                               |
| `trace/`                                       | @crish/telemetry          | R2 应已迁移                               |
| `plugin-registry.ts` / `plugin-fs-registry.ts` | plugin-sdk/src/registry/  | R8 迁移，本 Round 不处理（保留共存）      |
| `types.ts` 残余片段                            | shared-types / agent-core | 核对运行时选项片段是否已由 Agent 5-A 迁移 |
| `permissions.test.ts`                          | agent-permissions         | R3 应已迁移                               |

**任务 3：移除 v0.3.0 时间表标注**

在 shim 中明确标注 v0.3.0 为移除版本（禁令 24），并确保消费者在 v0.3.0 前完成迁移。shim 文件头注明：

```ts
/**
 * @deprecated @crish/agent-runtime is deprecated.
 * This shim will be removed in v0.3.0.
 * Import from @crish/agent-core / @crish/agent-subagent /
 * @crish/agent-tools / @crish/agent-model / @crish/agent-mcp /
 * @crish/agent-context / @crish/agent-permissions directly.
 */
```

**任务量**：shim 重写（~80 行显式导出）+ package.json 更新 + 遗漏文件核对 = 超过 禁令 28 门槛。

**验证标准**：

- `agent-runtime/src/index.ts` 为 shim（无业务逻辑，仅 re-export）
- 禁止 `export *`（禁令 24）
- 导入 shim 时输出 deprecation warning
- `package.json` 含全部 8 个子包依赖
- 遗漏文件核对完成（无未分配文件残留，plugin-registry 除外留待 R8）

**协调点**：1 次（依赖 Agent 5-A ~ 5-C 的产出）

---

### 2.5 Agent 5-E：全系统集成验证

| 维度     | 说明                                                                 |
| -------- | -------------------------------------------------------------------- |
| **类型** | 修复型 + 验证型                                                      |
| **目标** | 更新消费者 import 路径，运行全部 8 项验证门禁，生成 Round 5 验证报告 |
| **前置** | Agent 5-A ~ 5-D 已完成全部文件迁移与 shim 创建                       |
| **后续** | Round 6（orchestrator）与 Round 8（plugin-sdk）可并行启动            |

**输入**：

- `packages/agent-orchestrator/src/`（需更新 import 路径）
- `packages/agent-daemon/src/`（需更新 import 路径）
- `apps/crish-desktop/src/`（需更新 import 路径）
- Round 4 结束时的 TSC 基线

**输出**：

- 更新后的 agent-orchestrator / agent-daemon / crish-desktop import 路径
- 验证报告（8 项标准检查 + 专项检查）

**任务 1：更新 agent-orchestrator import 路径**

| 旧 import 路径                                 | 新 import 路径                | 说明                                       |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------ |
| `from '@crish/agent-runtime'`（runtime 相关）  | `from '@crish/agent-core'`    | AgentRuntime / SessionLoop / ControlBus 等 |
| `from '@crish/agent-runtime'`（工具相关）      | `from '@crish/agent-tools'`   | 已在 R4 迁移，本 Round 核对                |
| `from '@crish/agent-runtime'`（provider 相关） | `from '@crish/agent-model'`   | 已在 R4 迁移，本 Round 核对                |
| `from '@crish/agent-runtime'`（context 相关）  | `from '@crish/agent-context'` | 已在 R3 迁移，本 Round 核对                |

**任务 2：更新 agent-daemon import 路径**

同上规则，agent-daemon 中引用 `@crish/agent-runtime` 的位置更新为对应的子包。

**任务 3：更新 crish-desktop import 路径**

crish-desktop 中引用 `@crish/agent-runtime` 的位置更新为对应的子包。

**任务 4：运行验证门禁**

执行 §7 验证门禁的全部 8 项检查 + 专项检查，生成验证报告。

**任务量**：3 个消费者包的 import 路径更新（~20+ 文件）+ 验证报告 = 超过 禁令 28 门槛。

**验证标准**：

- agent-orchestrator / agent-daemon / crish-desktop 中无 `from '@crish/agent-runtime'`（除测试用途）
- depcruise 0 violations
- turbo build 全部成功
- TSC 错误数 ≤ 基线

**协调点**：2 次（依赖 Agent 5-A~5-D 的产出 + Round 4 基线）

---

## 3. @crish/agent-core 包设计详细

### 3.1 package.json

```json
{
  "name": "@crish/agent-core",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "development": {
        "types": "./src/index.ts",
        "import": "./src/index.ts",
        "default": "./src/index.ts"
      },
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    "build:types": "tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false && tsc-alias -p tsconfig.build.json --resolve-full-paths",
    "build:js": "esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap",
    "build": "npm run clean && npm run build:types && npm run build:js"
  },
  "dependencies": {
    "@crish/shared-types": "*",
    "@crish/shared-utils": "*",
    "@crish/agent-context": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-model": "*",
    "@crish/agent-permissions": "*",
    "@crish/agent-mcp": "*",
    "@crish/logger": "*",
    "@crish/telemetry": "*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.9.2"
  }
}
```

> **依赖说明**（依据 `02-FILE-MAPPING.md` §9.2）：
>
> - `@crish/shared-types`：CrishError / CrishResult / CrishErrorCode / AgentTool / ToolSource / AgentProvider / AgentMessage 等核心类型
> - `@crish/shared-utils`：AsyncSemaphore / retry / cache / abort-utils 等工具函数
> - `@crish/agent-context`：ContextManager / CheckpointManager / SessionStore / context-compression / InMemoryContextState / createId / nowIso
> - `@crish/agent-tools`：ToolDefinition / RegisteredTool / ToolMiddleware / ToolRegistry / local-tools
> - `@crish/agent-model`：AgentProvider / ProviderStreamEvent / ProviderFactory / provider-gateway
> - `@crish/agent-permissions`：ApprovalPipeline / TrustZonePolicy / SecretsObfuscation
> - `@crish/agent-mcp`：McpLifecycleManager / McpServerController
> - `@crish/logger`：Logger / LogTransport / RotatingFileSink
> - `@crish/telemetry`：TraceManager / Span / AsyncLocalStorage

### 3.2 目录结构

```
packages/agent-core/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                              # barrel
    ├── core/                                 # 运行时核心（§2.1）
    │   ├── runtime.ts                        # AgentRuntime 核心
    │   ├── runtime.test.ts
    │   ├── IAgentRuntime.ts                  # 运行时核心接口
    │   ├── runtime-defaults.ts               # runtime 默认值
    │   ├── runtime-helpers.ts                # runtime 辅助
    │   ├── runtime-helpers.test.ts
    │   └── runtime-options.ts                # types.ts 运行时选项片段
    ├── session-loop/                         # SessionLoop 子模块（§2.32）
    │   ├── index.ts                          # SessionLoop 主体（38K）
    │   ├── index.test.ts
    │   ├── provider-call.ts
    │   ├── provider-call.test.ts
    │   ├── tool-execution.ts                 # 22K
    │   ├── steering-delegate.ts
    │   ├── recovery.ts
    │   ├── control-check.ts
    │   ├── control-check.test.ts
    │   └── types.ts
    ├── state-machine/                        # StateMachine（§2.34）
    │   ├── core.ts                           # StateMachine 核心
    │   ├── core.test.ts
    │   ├── agent-session.ts
    │   ├── run-lifecycle.ts
    │   ├── run-lifecycle.test.ts
    │   ├── session-branch.ts
    │   ├── turn-types.ts
    │   └── index.ts
    ├── control/                              # ControlBus L1/L2/L3（§2.7，成熟资产）
    │   ├── control-bus.ts
    │   ├── control-bus.test.ts
    │   ├── types.ts
    │   └── index.ts
    ├── steering/                             # SteeringCoordinator + 3 策略（§2.35，成熟资产）
    │   ├── steering-coordinator.ts
    │   ├── steering-input-queue.ts
    │   ├── steering-input-queue.test.ts
    │   ├── steering-types.ts
    │   ├── compression-recovery-strategy.ts
    │   ├── goal-audit-strategy.ts
    │   ├── recovery-steering-strategy.ts
    │   └── index.ts
    ├── error-classifier.ts                   # ErrorClassifier（261 行，桥接 CrishError）
    ├── recovery-pipeline.ts                  # RecoveryPipeline 3-Tier（184 行，PipelineResult→CrishResult）
    ├── recovery-pipeline.test.ts
    ├── recovery/                             # stream-recovery（§2.27）
    │   ├── stream-recovery.ts
    │   └── stream-recovery.test.ts
    ├── fallback-chain/                       # FallbackChain 引擎（§2.11）
    │   ├── engine.ts
    │   ├── engine.test.ts
    │   ├── types.ts
    │   └── index.ts
    ├── hooks/                                # Hooks 派发器（§2.13）
    │   ├── lifecycle-hooks.ts                # 348 行，observe/on 双模式（禁令 14）
    │   ├── lifecycle-hooks.test.ts
    │   ├── agent-hooks.ts                    # deprecated 适配器
    │   ├── extension-registry.ts
    │   ├── health-hook-pack.ts
    │   ├── health-hook-pack.test.ts
    │   ├── hook-types.ts                     # R8 纯类型下沉 shared-types
    │   ├── compact-lifecycle.ts
    │   ├── compact-lifecycle.test.ts
    │   ├── tool-hook-observability.ts
    │   ├── tool-hook-types.ts                # R8 纯类型下沉 shared-types
    │   └── index.ts
    ├── runtime-components/                   # 运行时集成层（§2.29）
    │   ├── conversation-engine.ts
    │   ├── conversation-engine.test.ts
    │   ├── context-manager.ts
    │   ├── context-manager.test.ts
    │   ├── provider-call-gateway.ts
    │   ├── provider-call-gateway.test.ts
    │   ├── tool-executor.ts
    │   ├── tool-executor.test.ts
    │   ├── tool-executor-timeout.test.ts
    │   ├── provider-response-consumer.ts
    │   ├── provider-response-consumer.test.ts
    │   ├── single-tool-executor.ts
    │   ├── context-compression-gate.ts
    │   ├── context-compression-gate.test.ts
    │   ├── execution-strategy.ts
    │   ├── token-estimator.ts
    │   ├── tool-executor-options.ts
    │   └── index.ts
    ├── runtime-metrics/                      # RuntimeMetrics（§2.30）
    │   ├── collectors.ts
    │   ├── index.ts
    │   ├── snapshot.ts
    │   └── types.ts
    ├── runtime-metrics.ts                    # 根文件 barrel
    ├── runtime-metrics.test.ts
    ├── config/                               # Config（§2.5）
    │   ├── config-merger.ts
    │   └── index.ts
    ├── rendering/                            # Rendering（§2.28）
    │   ├── rendering-pipeline.ts
    │   └── index.ts
    ├── process-lifecycle/                    # ProcessLifecycle（§2.22）
    │   ├── process-executor.ts
    │   ├── process-executor.test.ts
    │   ├── process-manager.ts
    │   └── index.ts
    ├── event-protocol/                       # EventProtocol（§2.9）
    │   ├── core-event-projector.ts
    │   ├── core-event-projector.test.ts
    │   ├── core-event-types.ts
    │   └── index.ts
    ├── event-queue/                          # EventQueue（§2.10）
    │   ├── index.ts
    │   └── index.test.ts
    ├── agent-input-queue.ts                  # Agent 输入队列
    ├── agent-input-queue.test.ts
    ├── agent-session-loop.ts                 # SessionLoop 主体
    ├── agent-session-loop.test.ts
    ├── testing/                              # 测试基础设施（§2.37）
    │   ├── faux-provider.ts
    │   ├── faux-call-gateway.ts
    │   ├── mock-tool.ts
    │   ├── fixture-loader.ts
    │   ├── index.ts
    │   └── __tests__/
    │       └── faux-provider.test.ts
    ├── testing.ts                            # 测试工具 barrel
    ├── testing.test.ts
    ├── tool-stream/                          # 运行时工具流（§2.38）
    │   ├── tool-stream.ts
    │   └── tool-stream.test.ts
    ├── plan-document/                        # 计划文档运行时（§2.21）
    │   ├── index.ts
    │   ├── markdown.ts
    │   ├── operations.ts
    │   ├── types.ts
    │   └── validation.ts
    ├── plan-document.ts                      # 根文件
    ├── plan-document.test.ts
    ├── stream/                               # thinking 配置（§2.36）
    │   ├── thinking-config.ts
    │   └── thinking-config.test.ts
    └── __tests__/
        ├── error-classifier.test.ts
        ├── steering-input-queue.test.ts
        └── integrations/
            ├── state-machine.test.ts
            └── tool-stream.test.ts
```

### 3.3 核心接口

#### 3.3.1 AgentRuntime

> 保留现有 `IAgentRuntime` 接口与 `runtime.ts` 实现，迁移到 `agent-core/src/core/`。

```ts
// agent-core/src/core/IAgentRuntime.ts（迁移自 agent-runtime，保留现有签名）

export interface IAgentRuntime {
  /** 运行时配置选项 */
  readonly options: AgentRuntimeOptions;
  /** 会话循环（SessionLoop） */
  readonly sessionLoop: SessionLoop;
  /** ControlBus（L1/L2/L3 三层消息基础设施） */
  readonly controlBus: ControlBus;
  /** SteeringCoordinator（转向协调器 + 3 策略） */
  readonly steering: SteeringCoordinator;
  /** HookBus（LifecycleHookRegistry，observe/on 双模式） */
  readonly hooks: LifecycleHookRegistry;
  /** RecoveryPipeline（3-Tier 恢复管线） */
  readonly recovery: RecoveryPipeline;
  /** ErrorClassifier（错误分类器） */
  readonly classifier: typeof ErrorClassifier;
  /** 启动运行时 */
  start(): Promise<void>;
  /** 停止运行时 */
  stop(): Promise<void>;
}
```

#### 3.3.2 SessionLoop

```ts
// agent-core/src/session-loop/index.ts（迁移自 agent-runtime，保留现有结构）

export interface SessionLoop {
  /** 执行一轮对话 */
  runTurn(input: AgentInput): Promise<CrishResult<TurnResult, CrishError>>;
  /** 中止当前轮 */
  abort(): void;
  /** 获取当前轮次索引 */
  readonly turnIndex: number;
  /** 获取最大轮次 */
  readonly maxTurns: number;
}
```

> SessionLoop 内部组合 provider-call / tool-execution / steering-delegate / recovery / control-check 子模块，这些子模块随 SessionLoop 一同迁移到 `agent-core/src/session-loop/`。

#### 3.3.3 ControlBus（L1/L2/L3，成熟资产）

```ts
// agent-core/src/control/control-bus.ts（迁移自 agent-runtime，保留 L1/L2/L3 三层）

export class ControlBus {
  // L1：点对点 send（steer input 就是父→子消息）
  send(target: string, message: SteerInput): void;
  // L2：AgentEvent 流订阅
  subscribe(filter: AgentEventFilter): AsyncIterable<AgentEvent>;
  // L3：request-response（correlationId 语义）
  request(
    target: string,
    message: SteerInput,
    timeoutMs?: number
  ): Promise<AgentEvent>;
}
```

> 依据 禁令 20，子代理通信复用 ControlBus，禁止新建 SubagentCommunicationBus。L1 覆盖 send，L2 覆盖 subscribe，L3 覆盖 request-response。

#### 3.3.4 SteeringCoordinator（成熟资产）

```ts
// agent-core/src/steering/steering-coordinator.ts（迁移自 agent-runtime，保留 + 3 策略）

export class SteeringCoordinator {
  /** 注册转向策略 */
  registerStrategy(strategy: SteeringStrategy): void;
  /** 处理转向输入 */
  process(input: SteeringInput): Promise<SteeringAction>;
  /** 获取转向输入队列 */
  readonly inputQueue: SteeringInputQueue;
}

// 3 策略保留
export interface SteeringStrategy {
  readonly name: string;
  evaluate(context: SteeringContext): SteeringAction;
}
```

> 3 策略：`CompressionRecoveryStrategy` / `GoalAuditStrategy` / `RecoverySteeringStrategy`，随 SteeringCoordinator 一同迁移。

#### 3.3.5 ErrorClassifier（桥接 CrishError）

```ts
// agent-core/src/error-classifier.ts（迁移自 agent-runtime，261 行，增加 toCrishErrorCode 桥接）

export class ErrorClassifier {
  /** 纯函数分类器（签名不变，共存阶段） */
  static classify(
    error: unknown,
    options?: ErrorClassifierOptions
  ): ClassifiedError;
}

export interface ClassifiedError {
  domain: ErrorDomain;
  retryable: boolean;
  uiSeverity: UiSeverity;
  subType?: string;
  httpStatus?: number;
  providerId?: string;
  legacyKind: string;
  recoveryHint?: string;
  retryAfterMs?: number;
  originalError?: unknown;
  /** [NEW] 桥接方法：转换为 CrishErrorCode（引用 03-ERROR-MIGRATION.md §3.2） */
  toCrishErrorCode(): CrishErrorCode;
}
```

#### 3.3.6 RecoveryPipeline（PipelineResult 统一为 CrishResult）

```ts
// agent-core/src/recovery-pipeline.ts（迁移自 agent-runtime，184 行，PipelineResult 增加 CrishError）

export interface RecoveryPipelineConfig {
  maxTransportRetries: number;
  transportBackoffMs: number;
  fallbackProviders: string[];
  fallbackConfig: FallbackConfig;
  providerResolver: (id: string) => AgentProvider;
  contextHealer?: () => Promise<boolean>;
  onActionableError?: (classified: ClassifiedError) => void;
}

/**
 * 迁移阶段：PipelineResult 增加 crishError 字段，与原 error: ClassifiedError 并存。
 * 删除阶段（R12）：移除 error: ClassifiedError，统一为 CrishResult。
 */
export type PipelineResult =
  | {
      ok: true;
      events: AsyncIterable<ProviderStreamEvent>;
      tierUsed: 1 | 2 | 3;
    }
  | { ok: false; error: ClassifiedError; crishError?: CrishError };
```

> 依据 `03-ERROR-MIGRATION.md` §5.2，最终统一形态为 `CrishResult<AsyncIterable<ProviderStreamEvent>, CrishError> & { tierUsed?: 1 | 2 | 3 }`，`tierUsed` 作为扩展字段保留。

#### 3.3.7 HookBus（LifecycleHookRegistry，observe/on 双模式）

```ts
// agent-core/src/hooks/lifecycle-hooks.ts（迁移自 agent-runtime，348 行，保留 observe/on 双模式）

export class LifecycleHookRegistry {
  /**
   * observe：容错并行，失败吞掉，不影响主路径。
   * 用于日志、监控、审计。
   */
  observe(event: LifecycleEventType, handler: ObserveHandler): DisposeFunction;

  /**
   * on：串行语义合并，可返回控制信号。
   * 用于权限拦截、内容修改。
   * 控制信号：stop / block / modifiedInput / modifiedOutput
   */
  on(event: LifecycleEventType, handler: InterceptHandler): DisposeFunction;

  /** emit：仅 loop / runtime 调用 */
  emit(event: LifecycleEventType, payload: LifecyclePayload): Promise<void>;
}

// 事件名保留现有命名（禁令 14）
export type LifecycleEventType =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'context.compact.start'
  | 'context.compact.end';

// ContextCompactEndPayload 诊断字段必须保留（禁令 14）
export interface ContextCompactEndPayload {
  aborted: boolean;
  trigger: string;
  compactionId: string;
  keptMessageCount: number;
}
```

> 依据 禁令 14，禁止退化为单一 register 模式。`shouldStopAfterTurn` / `prepareNextTurn` / `ToolHook.onError`（返回 retry/skip/abort）等控制型钩子能力必须保留。

### 3.4 关键设计约束

1. **agent-core 是 top 层**：依赖 Round 3-4 创建的所有 leaf/middle 包，不反向依赖任何上层包。
2. **ControlBus L1/L2/L3 保留**（成熟资产）：三层消息基础设施完整迁移，不拆分、不重写。子代理通信复用 ControlBus（禁令 20）。
3. **SteeringCoordinator + 3 策略保留**（成熟资产）：整体迁移，保留现有调度逻辑。
4. **LifecycleHookRegistry 双模式保留**（禁令 14）：observe（容错并行）+ on（串行语义合并），禁止退化。
5. **error-classifier 桥接**（§3.2 of 03-ERROR-MIGRATION）：新增 `toCrishErrorCode()`，保留 `classify()` 签名。
6. **PipelineResult 统一**（§5.2 of 03-ERROR-MIGRATION）：增加 `crishError?: CrishError`，删除阶段（R12）移除旧字段。
7. **FallbackChain 保留**（成熟资产）：3-Tier 恢复管线逻辑完整迁移。
8. **不引入 CircuitBreaker**（禁令 6）：recovery/stream-recovery 保留现有流恢复逻辑，禁止滑动窗口断路器。
9. **不引入 DynamicModelRouter**（禁令 3）：agent-core 不做后台模型切换。

---

## 4. @crish/agent-subagent 骨架设计

### 4.1 package.json

```json
{
  "name": "@crish/agent-subagent",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "development": {
        "types": "./src/index.ts",
        "import": "./src/index.ts",
        "default": "./src/index.ts"
      },
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    "build:types": "tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false && tsc-alias -p tsconfig.build.json --resolve-full-paths",
    "build:js": "esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap",
    "build": "npm run clean && npm run build:types && npm run build:js"
  },
  "dependencies": {
    "@crish/shared-types": "*",
    "@crish/shared-utils": "*",
    "@crish/agent-core": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-mcp": "*",
    "@crish/agent-context": "*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.9.2"
  }
}
```

> **依赖说明**（依据 `02-FILE-MAPPING.md` 禁令 23 实证）：
>
> - `@crish/agent-core`：AgentRuntime（`subagents.ts` import `AgentRuntime` from `./runtime`）
> - `@crish/agent-tools`：defineTool / ToolDefinition
> - `@crish/agent-mcp`：MCP 工具源（子代理可使用 MCP 工具）
> - `@crish/agent-context`：createId / nowIso / InMemoryContextState / ProjectProgressLedger
> - `@crish/shared-types`：AgentMessage / AgentEvent / JsonObject / ToolExecutionContext
> - `@crish/shared-utils`：AsyncSemaphore

### 4.2 目录结构

```
packages/agent-subagent/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                          # barrel
    ├── subagents.ts                      # SubagentDepthGuard + AsyncSemaphore（560 行，保留 ~60% 重写 ~40%）
    ├── subagents.test.ts
    ├── subagent-loop.ts                  # 子代理执行循环
    ├── subagent-skill-runner.ts          # 子代理技能运行器
    ├── subagent-types.ts                 # 子代理类型定义
    ├── subagent-context-pack.ts          # 子代理上下文打包
    ├── subagent-context-pack.test.ts
    ├── scheduler.ts                      # [NEW] SubagentScheduler 接口骨架（R9 实现）
    └── recursion-guard.ts                 # [NEW] RecursionGuard 增强接口
```

### 4.3 SubagentScheduler 接口骨架

```ts
// agent-subagent/src/scheduler.ts（[NEW] 接口骨架，Round 9 实现）

import type { AgentRuntime } from '@crish/agent-core';
import type {
  SubagentTaskCard,
  SubagentMode,
  SubagentStatus,
} from './subagent-types';

/**
 * SubagentScheduler — 子代理调度器（FIFO 调度队列）
 *
 * 依据 禁令 20：SubagentScheduler 是第一版必须实现的组件。
 * 依据 禁令 20：priority / affinity 调度策略推迟，仅实现 FIFO。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SubagentScheduler {
  /**
   * 提交子代理任务到调度队列
   *
   * @returns 任务 ID（用于后续查询/取消）
   */
  submit(task: SubagentTaskCard): Promise<string>;

  /**
   * 取消尚未完成的子代理任务
   */
  cancel(taskId: string): Promise<boolean>;

  /**
   * 查询子代理实例状态
   */
  getStatus(taskId: string): SubagentStatus | undefined;

  /**
   * 等待子代理任务完成（带超时）
   */
  await(taskId: string, timeoutMs?: number): Promise<SubagentResult>;

  /**
   * 获取当前调度队列快照
   */
  snapshot(): SchedulerSnapshot;
}

export interface SubagentResult {
  taskId: string;
  status: SubagentStatus;
  output?: unknown;
  error?: CrishError;
}

export interface SchedulerSnapshot {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * SubagentInstance — 子代理生命周期管理
 *
 * 依据 禁令 20：SubagentInstance 是第一版必须实现的组件。
 * 依据 禁令 20：SubagentState 简化为 4 状态（pending / running / completed / failed）。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface SubagentInstance {
  readonly taskId: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly timeoutMs: number;

  /** 启动子代理 */
  start(): Promise<void>;
  /** 取消子代理 */
  cancel(): Promise<void>;
  /** 等待完成 */
  join(): Promise<SubagentResult>;
}
```

### 4.4 RecursionGuard 增强接口

```ts
// agent-subagent/src/recursion-guard.ts（[NEW] 增强接口，保留现有 SubagentDepthGuard）

/**
 * RecursionGuard — 递归守卫增强接口
 *
 * 保留现有 SubagentDepthGuard，增加 totalTokenBudget / totalTimeoutMs 字段。
 * 依据 ROUND-09 §3.2：递归守卫默认值（唯一权威值）。
 *
 * @alpha Round 5 仅定义接口与默认值，Round 9 完整实现执行逻辑。
 */

/**
 * 现有 SubagentDepthGuard（保留，来自 subagents.ts）
 */
export interface SubagentDepthGuard {
  maxDepth: number;
  maxSiblings: number;
  maxConcurrent?: number;
}

/**
 * RecursionGuard 增强接口（在 SubagentDepthGuard 基础上扩展）
 *
 * 依据 禁令 20：
 * - totalTokenBudget：预留字段，默认 0（不限制），Round 9 实现全局 token 预算
 * - totalTimeoutMs：预留字段，默认 0（不限制），第一版依赖每个子代理的 timeoutMs
 */
export interface RecursionGuard extends SubagentDepthGuard {
  /** 全局 token 预算上限（0 = 不限制，Round 9 实现） */
  readonly totalTokenBudget: number;
  /** 全局超时上限（0 = 不限制，Round 9 实现） */
  readonly totalTimeoutMs: number;
}

/**
 * 递归守卫默认值（ROUND-09 §3.2 唯一权威值）
 *
 * 注意：现有 subagents.ts 中 DEFAULT_SUBAGENT_DEPTH_GUARD 的值为
 *   maxDepth: 2, maxSiblings: 4, maxConcurrent: 6
 * Round 5 必须更新为以下权威值：
 *   maxDepth: 3, maxSiblings: 5, maxConcurrent: 6
 */
export const DEFAULT_RECURSION_GUARD: RecursionGuard = {
  maxDepth: 3,
  maxSiblings: 5,
  maxConcurrent: 6,
  totalTokenBudget: 0,
  totalTimeoutMs: 0,
};

/**
 * DeadlockDetector — DFS 环检测（接口骨架）
 *
 * 依据 禁令 20：DeadlockDetector 是第一版必须实现的组件。
 * 实现为轻量级：在 spawn 时检查 ancestorSessionIds 是否包含目标 session，O(depth) 复杂度。
 * 禁止运行时后台线程扫描。
 *
 * @alpha Round 5 仅定义接口骨架，Round 9 完整实现。
 */
export interface DeadlockDetector {
  /**
   * 检测 spawn 是否会造成环
   *
   * @param ancestorSessionIds 从根到当前 session 的祖先链
   * @param targetSessionId 要 spawn 的目标 session
   * @returns true 表示检测到环（将造成死锁）
   */
  detectCycle(ancestorSessionIds: string[], targetSessionId: string): boolean;
}
```

### 4.5 关键设计约束

1. **agent-subagent 仅骨架**（禁令 20）：SubagentScheduler / SubagentInstance / DeadlockDetector 仅定义接口签名，Round 9 完整实现。SubagentWatchdog.stuckDetection / TokenBudgetTracker / priority/affinity / isolationMode / SubagentState.paused 均推迟。
2. **递归守卫默认值更新**（ROUND-09 §3.2）：maxDepth 2→3, maxSiblings 4→5, maxConcurrent 6 保持, totalTokenBudget=0, totalTimeoutMs=0。
3. **禁止新建 SubagentCommunicationBus**（禁令 20）：子代理通信复用 ControlBus。
4. **SubagentRole 为标签**（禁令 21）：role 仅用于展示，capabilityMode 控制权限。
5. **子代理发现推迟**（禁令 22）：Round 8 PluginRegistry 完成后发现机制，本 Round 不实现。
6. **SubagentState 简化为 4 状态**（禁令 20）：pending / running / completed / failed，不实现 paused / resuming。

---

## 5. Legacy Shim 设计

### 5.1 显式导出清单

依据 禁令 24，`agent-runtime` shim 使用显式命名导出，禁止 `export *`。shim re-export 全部 8 个子包的核心符号：

```ts
// packages/agent-runtime/src/index.ts（legacy shim）

/**
 * @deprecated @crish/agent-runtime is deprecated.
 * This shim will be removed in v0.3.0.
 * Import from @crish/agent-core / @crish/agent-subagent /
 * @crish/agent-tools / @crish/agent-model / @crish/agent-mcp /
 * @crish/agent-context / @crish/agent-permissions directly.
 *
 * 依据 禁令 24：
 * - 使用显式命名导出，禁止 export *
 * - 设置 deprecation warning
 * - 移除时间表：v0.3.0
 */

if (typeof console !== 'undefined') {
  console.warn(
    '[deprecated] @crish/agent-runtime is deprecated, import from @crish/agent-core / @crish/agent-subagent / @crish/agent-tools / @crish/agent-model / @crish/agent-mcp / @crish/agent-context / @crish/agent-permissions directly. This shim will be removed in v0.3.0.'
  );
}

// ─── agent-core ──────────────────────────────────────────
export { type IAgentRuntime, AgentRuntime } from '@crish/agent-core';

export { type SessionLoop } from '@crish/agent-core';

export { ControlBus } from '@crish/agent-core';

export { SteeringCoordinator, type SteeringStrategy } from '@crish/agent-core';

export {
  ErrorClassifier,
  type ClassifiedError,
  type ErrorDomain,
} from '@crish/agent-core';

export { type RecoveryPipeline, type PipelineResult } from '@crish/agent-core';

export {
  LifecycleHookRegistry,
  type LifecycleEventType,
} from '@crish/agent-core';

// ─── agent-subagent ──────────────────────────────────────
export {
  type SubagentDepthGuard,
  type SubagentMode,
  type SubagentStatus,
} from '@crish/agent-subagent';

// ─── agent-tools（R4 已迁移） ────────────────────────────
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  RegisteredTool,
  type ToolMiddleware,
  ToolRegistry,
} from '@crish/agent-tools';

// ─── agent-model（R4 已迁移） ────────────────────────────
export {
  type Engine,
  type ProviderDef,
  ProviderFactory,
  ProviderRegistry,
} from '@crish/agent-model';

// ─── agent-mcp（R3/R4 已迁移） ───────────────────────────
export {
  McpLifecycleManager,
  type McpServerDefinition,
} from '@crish/agent-mcp';

// ─── agent-context（R3 已迁移） ──────────────────────────
export {
  ContextManager,
  CheckpointManager,
  type SessionStore,
} from '@crish/agent-context';

// ─── agent-permissions（R3 已迁移） ──────────────────────
export {
  ApprovalPipeline,
  TrustZonePolicy,
  SecretsObfuscation,
} from '@crish/agent-permissions';
```

> **导出清单说明**：
>
> - 仅导出消费者（agent-orchestrator / agent-daemon / crish-desktop）实际使用的公共 API 符号。
> - 每个符号使用显式命名导出（`export { Symbol } from "@crish/xxx"`），禁止 `export *`。
> - 导出清单在 v0.3.0 删除时随 shim 一并移除。

### 5.2 deprecation warning

shim 被导入时输出 `console.warn`，包含：

- `[deprecated]` 前缀
- 指向正确的子包
- v0.3.0 移除时间表

> **实现约束**：warning 在模块加载时执行一次（`if (typeof console !== "undefined")` 防止 SSR/非 Node 环境报错）。禁止在每次函数调用时重复输出（性能影响）。

### 5.3 v0.3.0 移除计划

| 阶段                | 版本       | 动作                                                                 |
| ------------------- | ---------- | -------------------------------------------------------------------- |
| 共存阶段（R3-R5）   | v0.1.x     | shim 存在，消费者可继续使用 `@crish/agent-runtime`                   |
| 迁移阶段（R6-R11）  | v0.2.x     | 消费者逐步迁移 import 路径到子包，shim 保留                          |
| **删除阶段（R12）** | **v0.3.0** | **shim 删除，CI 门禁增加"检查无 `@crish/agent-runtime` import"规则** |

**消费者迁移清单**（必须在 v0.3.0 前完成）：

| 消费者               | 当前 import            | 迁移目标                                                                | 迁移 Round           |
| -------------------- | ---------------------- | ----------------------------------------------------------------------- | -------------------- |
| `agent-orchestrator` | `@crish/agent-runtime` | `@crish/agent-core` + `@crish/agent-tools`                              | R5（Agent 5-E）+ R6  |
| `agent-daemon`       | `@crish/agent-runtime` | `@crish/agent-core` + `@crish/agent-model` + `@crish/agent-permissions` | R5（Agent 5-E）+ R7  |
| `crish-desktop`      | `@crish/agent-runtime` | `@crish/agent-core`（间接，通过 daemon）                                | R5（Agent 5-E）+ R11 |

**CI 门禁**（Round 12 新增）：

- grep 检查：源码中无 `from '@crish/agent-runtime'` import
- depcruise 规则：禁止 import `@crish/agent-runtime`

---

## 6. 文件迁移清单

> 本节汇总 Round 5 全部文件迁移，引用 `02-FILE-MAPPING.md` 的权威映射表。本节不重新定义映射，仅汇总并标注 Agent 归属。

### 6.1 迁移到 @crish/agent-core（Agent 5-A + 5-B）

| 源（agent-runtime/src/）                                         | 目标（agent-core/src/）   | Agent | 映射依据     |
| ---------------------------------------------------------------- | ------------------------- | ----- | ------------ |
| `runtime.ts` + `.test.ts`                                        | `core/`                   | 5-A   | §2.1         |
| `IAgentRuntime.ts`                                               | `core/`                   | 5-A   | §2.1         |
| `runtime-defaults.ts`                                            | `core/`                   | 5-A   | §2.1         |
| `runtime-helpers.ts` + `.test.ts`                                | `core/`                   | 5-A   | §2.1         |
| `types.ts`（运行时选项片段）                                     | `core/runtime-options.ts` | 5-A   | §2.2         |
| `session-loop/`（8 文件 + 3 test）                               | `session-loop/`           | 5-A   | §2.32        |
| `state-machine/`（6 文件 + 2 test）                              | `state-machine/`          | 5-A   | §2.34        |
| `control/`（3 文件 + 1 test）                                    | `control/`                | 5-A   | §2.7         |
| `steering/`（7 文件 + 1 test）                                   | `steering/`               | 5-A   | §2.35        |
| `error-classifier.ts`                                            | 根目录                    | 5-B   | §2.1         |
| `recovery-pipeline.ts` + `.test.ts`                              | 根目录                    | 5-B   | §2.1         |
| `recovery/`（2 文件）                                            | `recovery/`               | 5-B   | §2.27        |
| `fallback-chain/`（4 文件）                                      | `fallback-chain/`         | 5-B   | §2.11        |
| `hooks/`（12 文件）                                              | `hooks/`                  | 5-B   | §2.13        |
| `runtime-components/`（18 文件）                                 | `runtime-components/`     | 5-B   | §2.29        |
| `runtime-metrics.ts` + `.test.ts` + `runtime-metrics/`（4 文件） | 根 + `runtime-metrics/`   | 5-B   | §2.1 + §2.30 |
| `config/`（2 文件）                                              | `config/`                 | 5-B   | §2.5         |
| `rendering/`（2 文件）                                           | `rendering/`              | 5-B   | §2.28        |
| `process-lifecycle/`（4 文件）                                   | `process-lifecycle/`      | 5-B   | §2.22        |
| `agent-input-queue.ts` + `.test.ts`                              | 根目录                    | 5-B   | §2.1         |
| `agent-session-loop.ts` + `.test.ts`                             | 根目录                    | 5-B   | §2.1         |
| `event-protocol/`（4 文件）                                      | `event-protocol/`         | 5-B   | §2.9         |
| `event-queue/`（2 文件）                                         | `event-queue/`            | 5-B   | §2.10        |
| `testing.ts` + `.test.ts` + `testing/`（6 文件）                 | 根 + `testing/`           | 5-B   | §2.1 + §2.37 |
| `tool-stream/`（2 文件）                                         | `tool-stream/`            | 5-B   | §2.38        |
| `plan-document.ts` + `.test.ts` + `plan-document/`（5 文件）     | 根 + `plan-document/`     | 5-B   | §2.1 + §2.21 |
| `stream/thinking-config.ts` + `.test.ts`                         | `stream/`                 | 5-B   | §2.36        |
| `__tests__/error-classifier.test.ts`                             | `__tests__/`              | 5-B   | §2.41        |
| `__tests__/steering-input-queue.test.ts`                         | `__tests__/`              | 5-B   | §2.41        |
| `__tests__/integrations/state-machine.test.ts`                   | `__tests__/integrations/` | 5-B   | §2.41        |
| `__tests__/integrations/tool-stream.test.ts`                     | `__tests__/integrations/` | 5-B   | §2.41        |

**agent-core 小计**：~95 文件

### 6.2 迁移到 @crish/agent-subagent（Agent 5-C）

| 源（agent-runtime/src/）        | 目标（agent-subagent/src/）     | Agent | 映射依据 |
| ------------------------------- | ------------------------------- | ----- | -------- |
| `subagents.ts`                  | `subagents.ts`                  | 5-C   | §2.1     |
| `subagents.test.ts`             | `subagents.test.ts`             | 5-C   | §2.1     |
| `subagent-loop.ts`              | `subagent-loop.ts`              | 5-C   | §2.1     |
| `subagent-skill-runner.ts`      | `subagent-skill-runner.ts`      | 5-C   | §2.1     |
| `subagent-types.ts`             | `subagent-types.ts`             | 5-C   | §2.1     |
| `subagent-context-pack.ts`      | `subagent-context-pack.ts`      | 5-C   | §2.1     |
| `subagent-context-pack.test.ts` | `subagent-context-pack.test.ts` | 5-C   | §2.1     |

**agent-subagent 小计**：7 文件迁移 + 2 接口骨架新建

### 6.3 不迁移的文件（明确排除）

| 文件                                           | 实际归属                            | 排除理由                                                                      |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `event-architecture/`                          | agent-context（R3 已迁移）          | §2.8 + §3 冲突解决第 6 项：canonical-event.ts 是上下文域规范事件，leaf 层必需 |
| `goal-disk-oracle.ts` + `.test.ts`             | agent-context（R3 已迁移）          | §2.1 明确归属 agent-context                                                   |
| `plugin-registry.ts` + `plugin-fs-registry.ts` | plugin-sdk/src/registry/（R8 迁移） | §2.1 + §4：禁令 10 并入 plugin-sdk                                            |
| `trace/`                                       | @crish/telemetry（R2 已迁移）       | §2.40                                                                         |
| `path-handling/`                               | shared-utils（R2 已迁移）           | §2.19                                                                         |

### 6.4 agent-runtime shim（Agent 5-D）

| 操作 | 文件                                  | 说明                                                   |
| ---- | ------------------------------------- | ------------------------------------------------------ |
| 重写 | `packages/agent-runtime/src/index.ts` | 转为 legacy shim（显式命名导出 + deprecation warning） |
| 修改 | `packages/agent-runtime/package.json` | 增加全部 8 个子包依赖                                  |

---

## 7. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，每轮结束前必须通过以下 8 项检查。

### 7.1 基线建立

Round 5 开始时，Agent 5-E 执行以下命令记录基线：

```bash
# 记录 TSC 错误基线
npx tsc --noEmit 2>&1 | tee round-05-tsc-baseline.json

# 记录依赖图基线
npm run lint:depcruise 2>&1 | tee round-05-depcruise-baseline.json
```

### 7.2 验证检查项

| 序号 | 检查项           | 命令                        | 通过标准                                                                          | 责任 Agent |
| ---- | ---------------- | --------------------------- | --------------------------------------------------------------------------------- | ---------- |
| 1    | TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ `round-05-tsc-baseline.json`（不恶化，禁令 26）                          | 5-E        |
| 2    | Rust 编译        | `cargo check --workspace`   | 0 errors                                                                          | 5-E        |
| 3    | 单元测试（TS）   | `npx vitest run`            | 全部通过                                                                          | 5-E        |
| 4    | 单元测试（Rust） | `cargo test --workspace`    | 全部通过                                                                          | 5-E        |
| 5    | 循环依赖         | `npm run lint:depcruise`    | 0 violations（特别验证 `agent-core` / `agent-subagent` 依赖边方向正确，无反向边） | 5-E        |
| 6    | 构建             | `npx turbo run build`       | `agent-core` / `agent-subagent` / `agent-runtime` 全部成功                        | 5-E        |
| 7    | Lint             | `npm run lint`              | 0 errors                                                                          | 5-E        |
| 8    | Store 类型       | `npm run check:store-types` | 通过                                                                              | 5-E        |

### 7.3 Round 5 专项验证

除上述 8 项标准检查外，Round 5 须额外验证：

| 序号 | 专项检查                     | 验证方法                                                                                | 通过标准                                                                                          |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S1   | agent-core 包独立性          | `packages/agent-core/` 目录存在 + `package.json` 含 9 个 `dependencies`                 | agent-core 依赖全部 leaf/middle 包                                                                |
| S2   | agent-subagent 骨架          | `packages/agent-subagent/src/scheduler.ts` 存在 + `recursion-guard.ts` 存在             | SubagentScheduler 接口 + RecursionGuard 增强接口定义完整                                          |
| S3   | 递归守卫默认值               | 检查 `recursion-guard.ts` 的 `DEFAULT_RECURSION_GUARD`                                  | maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0（ROUND-09 §3.2） |
| S4   | LifecycleHookRegistry 双模式 | 检查 `agent-core/src/hooks/lifecycle-hooks.ts`                                          | 含 `observe()` + `on()` 方法，非单一 register（禁令 14）                                          |
| S5   | error-classifier 桥接        | 检查 `agent-core/src/error-classifier.ts`                                               | 含 `domainToCrishErrorCode()` 函数 + `ClassifiedError.toCrishErrorCode()`                         |
| S6   | PipelineResult 统一          | 检查 `agent-core/src/recovery-pipeline.ts`                                              | `PipelineResult` 含 `crishError?: CrishError` 字段                                                |
| S7   | Legacy shim                  | 检查 `agent-runtime/src/index.ts`                                                       | 显式命名导出（无 `export *`）+ deprecation warning + v0.3.0 标注（禁令 24）                       |
| S8   | 消费者 import 迁移           | grep `from '@crish/agent-runtime'` in agent-orchestrator / agent-daemon / crish-desktop | 无残留（除测试用途）                                                                              |
| S9   | ControlBus L1/L2/L3 保留     | 检查 `agent-core/src/control/control-bus.ts`                                            | 三层消息基础设施完整（send / subscribe / request）                                                |
| S10  | SteeringCoordinator + 3 策略 | 检查 `agent-core/src/steering/`                                                         | 含 steering-coordinator.ts + 3 策略文件                                                           |
| S11  | 共存策略                     | `agent-runtime/src/` 中被迁移文件保留                                                   | 共存阶段不删除源文件（guardrails 禁令 23）                                                        |
| S12  | 拓扑层一致                   | depcruise 验证依赖边方向                                                                | 所有依赖边从高层指向低层，无反向边，无循环                                                        |

### 7.4 TSC 错误管理

依据 禁令 26：

- **禁止承诺"每轮 TSC 清零"**。拆分过程会引入临时错误（import 路径变更、类型解析延迟等），这是正常的。
- **本 Round 验证标准**：Round 5 结束时 TSC 错误数 ≤ `round-05-tsc-baseline.json` 记录的基线。
- **不恶化判定**：如果基线为 N，Round 5 结束时错误数 ≤ N 即通过。
- **最终清零目标**：仅在 Round 11 要求 TSC 错误 < 50。完全清零作为后续独立任务。

---

## 8. 交付物

### 8.1 包交付物

| 交付物                         | 路径                                              | 文件数                       | 责任 Agent |
| ------------------------------ | ------------------------------------------------- | ---------------------------- | ---------- |
| `@crish/agent-core` 包         | `packages/agent-core/`                            | ~95 源文件 + 4 配置文件      | 5-A, 5-B   |
| `@crish/agent-subagent` 骨架包 | `packages/agent-subagent/`                        | 7 迁移 + 2 新建 + 4 配置文件 | 5-C        |
| `agent-runtime` legacy shim    | `packages/agent-runtime/src/index.ts`             | 1 重写 + 1 package.json 修改 | 5-D        |
| 消费者 import 迁移             | agent-orchestrator / agent-daemon / crish-desktop | ~20+ 文件                    | 5-E        |

### 8.2 接口签名交付物

| 接口                                  | 包             | 签名                                                                                                                   | 状态                                                            |
| ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `IAgentRuntime`                       | agent-core     | `interface IAgentRuntime { options, sessionLoop, controlBus, steering, hooks, recovery, classifier, start(), stop() }` | 迁移保留                                                        |
| `SessionLoop`                         | agent-core     | `interface SessionLoop { runTurn(input), abort(), turnIndex, maxTurns }`                                               | 迁移保留                                                        |
| `ControlBus`                          | agent-core     | `class ControlBus { send(), subscribe(), request() }` — L1/L2/L3                                                       | 迁移保留（成熟资产）                                            |
| `SteeringCoordinator`                 | agent-core     | `class SteeringCoordinator { registerStrategy(), process(), inputQueue }` + 3 策略                                     | 迁移保留（成熟资产）                                            |
| `ErrorClassifier`                     | agent-core     | `class ErrorClassifier { static classify() }` + `ClassifiedError.toCrishErrorCode()`                                   | 迁移 + 桥接 [NEW]                                               |
| `RecoveryPipeline` / `PipelineResult` | agent-core     | `type PipelineResult = { ok: true, events, tierUsed }                                                                  | { ok: false, error: ClassifiedError, crishError?: CrishError }` | 迁移 + 统一 [NEW] |
| `LifecycleHookRegistry` / `HookBus`   | agent-core     | `class LifecycleHookRegistry { observe(), on(), emit() }` — observe/on 双模式                                          | 迁移保留（禁令 14）                                             |
| `SubagentScheduler`                   | agent-subagent | `interface SubagentScheduler { submit(), cancel(), getStatus(), await(), snapshot() }`                                 | [NEW] 骨架（R9 实现）                                           |
| `SubagentInstance`                    | agent-subagent | `interface SubagentInstance { taskId, status, start(), cancel(), join() }`                                             | [NEW] 骨架（R9 实现）                                           |
| `RecursionGuard`                      | agent-subagent | `interface RecursionGuard extends SubagentDepthGuard { totalTokenBudget, totalTimeoutMs }` + DEFAULT_RECURSION_GUARD   | [NEW] 增强接口                                                  |
| `DeadlockDetector`                    | agent-subagent | `interface DeadlockDetector { detectCycle(ancestorSessionIds, targetSessionId) }`                                      | [NEW] 骨架（R9 实现）                                           |

### 8.3 验证报告交付物

| 报告                               | 内容                                     | 责任 Agent |
| ---------------------------------- | ---------------------------------------- | ---------- |
| `round-05-tsc-baseline.json`       | Round 5 开始时的 TSC 错误基线            | 5-E        |
| `round-05-tsc-final.json`          | Round 5 结束时的 TSC 错误                | 5-E        |
| `round-05-depcruise-report.json`   | 循环依赖检查结果                         | 5-E        |
| `round-05-turbo-build-report.json` | 构建结果                                 | 5-E        |
| `round-05-verification-report.md`  | 验证报告（8 项标准检查 + 12 项专项检查） | 5-E        |

### 8.4 文档更新交付物

| 文档                      | 更新内容                                                      | 依据          |
| ------------------------- | ------------------------------------------------------------- | ------------- |
| `02-FILE-MAPPING.md` §9.2 | 确认 `agent-core` / `agent-subagent` 依赖关系（如有实际偏差） | 禁令 31       |
| `01-OVERVIEW.md` §3.2     | 确认 Layer 4 / Layer 5 创建完成                               | 本 Round 设计 |

---

## 9. 风险与缓解

| 风险                             | 影响                                                                                 | 缓解措施                                                                                             | 责任人   |
| -------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------- |
| import 路径断裂                  | agent-orchestrator / agent-daemon 引用 agent-runtime 时编译失败                      | 共存阶段保留 agent-runtime 源文件 + legacy shim（guardrails 禁令 23）                                | 5-D, 5-E |
| 循环依赖引入                     | agent-core 依赖 agent-subagent（反向）                                               | 依赖方向以 `02-FILE-MAPPING.md` 禁令 23 实证为准：agent-subagent 依赖 agent-core。depcruise 门禁验证 | 5-E      |
| TSC 错误恶化                     | 迁移过程中类型解析失败导致错误数增加                                                 | 每步迁移后运行 `tsc --noEmit` 对比基线；不恶化门禁（禁令 26）                                        | 5-E      |
| LifecycleHookRegistry 双模式退化 | observe/on 被误改为单一 register                                                     | 专项检查 S4 验证双模式保留；对照原 348 行（禁令 14）                                                 | 5-B      |
| 递归守卫默认值未更新             | subagents.ts 仍使用旧值 maxDepth=2, maxSiblings=4                                    | 专项检查 S3 验证 DEFAULT_RECURSION_GUARD 值为 ROUND-09 §3.2 权威值                                   | 5-C      |
| PipelineResult 桥接不完整        | crishError 字段未添加或类型错误                                                      | 专项检查 S6 验证（§5.2 of 03-ERROR-MIGRATION）                                                       | 5-B      |
| SubagentScheduler 过度实现       | Round 5 过早实现完整调度逻辑                                                         | 仅定义接口骨架，完整实现推迟到 Round 9（禁令 20）                                                    | 5-C      |
| event-architecture 误迁移        | 误将 event-architecture/ 迁入 agent-core                                             | 文档明确排除（禁令 10），agent-core 的 EventArchitecture = event-protocol/ + event-queue/            | 5-B      |
| 消费者 import 残留               | agent-orchestrator / agent-daemon / crish-desktop 仍有 `@crish/agent-runtime` import | 专项检查 S8 grep 验证                                                                                | 5-E      |

---

## 10. Round 5 与后续 Round 的衔接

### 10.1 Round 5 完成后可并行启动的 Round

依据 `01-OVERVIEW.md` §4.2：

```
R5 ──┬──→ R6（orchestrator）──→ R7（daemon）──┐
     │                                         │
     ├──→ R8（plugin-sdk）──→ R9（subagent 完整）──→ R10 ──→ R11 ──→ R12
     │
     └──→ R5 完成后 R6 和 R8 可并行启动
```

**Round 6（agent-orchestrator 重构）**：

- 依赖 Round 5 的 `agent-core`（AgentRuntime / SessionLoop / ControlBus）
- 将 agent-orchestrator 中 `from '@crish/agent-runtime'` 全部迁移到 `from '@crish/agent-core'`
- CrishError 集成 + 日志集成 + TSC 修复

**Round 8（plugin-sdk 重建）**：

- 依赖 Round 5 的 `agent-core`（hooks/ 派发器类型）
- 14 钩子 + observe/on 双模式 + 工具注册 + 信任模型
- `registerPluginServer` 完整实现（R4 骨架 → R8 完整）

### 10.2 Round 5 → Round 9（agent-subagent 完整）

Round 9 完整实现 agent-subagent，依赖 Round 8 的 PluginRegistry：

```
Round 5（骨架）→ Round 8（plugin-sdk）→ Round 9（完整）
```

Round 9 将：

1. 实现 `SubagentScheduler`（FIFO 调度队列）
2. 实现 `SubagentInstance`（状态机 + 超时 + 取消）
3. 实现 `DeadlockDetector`（DFS 环检测，O(depth) 复杂度）
4. 实现 `ConcurrencyController`（全局/每父/队列上限）
5. 增强 `RecursionGuard` 执行逻辑（maxDepth / maxSiblings / maxConcurrent 检查）
6. 子代理发现机制（通过 PluginRegistry）

### 10.3 不迁移到本 Round 的文件

| 文件                                           | 目标包                   | 迁移 Round | 理由                      |
| ---------------------------------------------- | ------------------------ | ---------- | ------------------------- |
| `plugin-registry.ts` + `plugin-fs-registry.ts` | plugin-sdk/src/registry/ | R8         | 禁令 10 并入 plugin-sdk   |
| `event-architecture/`                          | agent-context            | R3 已迁移  | §2.8 + §3 冲突解决第 6 项 |
| `goal-disk-oracle.ts`                          | agent-context            | R3 已迁移  | §2.1                      |
| `trace/`                                       | @crish/telemetry         | R2 已迁移  | §2.40                     |
| `path-handling/`                               | shared-utils             | R2 已迁移  | §2.19                     |

---

## 11. 附录：Agent 编排时序

```
Round 5 开始
  │
  ├── Agent 5-E：记录 TSC 基线（round-05-tsc-baseline.json）
  │
  ├── [并行] Agent 5-A：创建 agent-core 包骨架 + 迁移核心运行时（34 文件）
  │
  ├── [串行·依赖 5-A] Agent 5-B：迁移 Recovery/Hooks/Components/Metrics 等（73 文件 + 桥接）
  │
  ├── [串行·依赖 5-A] Agent 5-C：创建 agent-subagent 骨架 + 迁移子代理文件（7 文件 + 2 骨架）
  │
  ├── [串行·依赖 5-A~5-C] Agent 5-D：agent-runtime legacy shim + 剩余文件核对
  │
  ├── [串行·依赖 5-A~5-D] Agent 5-E：
  │   ├── 更新 agent-orchestrator import 路径
  │   ├── 更新 agent-daemon import 路径
  │   ├── 更新 crish-desktop import 路径
  │   └── 验证门禁（8 项标准 + 12 项专项）
  │
  └── Round 5 结束 → 生成交付物清单 → Round 6 / Round 8 可并行启动
```

**并行性说明**（依据 禁令 28）：

- Agent 5-A 独立执行（创建包骨架 + 迁移核心运行时）
- Agent 5-B 依赖 5-A（需要 agent-core 包骨架），必须串行
- Agent 5-C 依赖 5-A（需要 agent-core 包，agent-subagent 依赖 agent-core），必须串行
- Agent 5-B 与 5-C 可并行：操作的文件集完全不相交（agent-core 的 Recovery/Hooks/Components vs agent-subagent 的 subagents），但 5-C 依赖 5-A 的产出，5-B 也依赖 5-A 的产出。若 5-A 完成后，5-B 与 5-C 可并行启动。
- Agent 5-D 依赖 5-A~5-C 全部完成，必须串行
- Agent 5-E 依赖 5-A~5-D 全部完成，必须串行

**协调次数**：

- 5-A：0 次
- 5-B：1 次（依赖 5-A 的包骨架）
- 5-C：1 次（依赖 5-A 的包骨架）
- 5-D：1 次（依赖 5-A~5-C 的产出）
- 5-E：2 次（依赖 5-A~5-D 的产出 + Round 4 基线）

全部满足 禁令 28"协调次数 ≤ 2 次"约束。
