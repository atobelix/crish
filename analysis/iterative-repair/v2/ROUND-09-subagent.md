# Round 9：子代理调度系统

> **本文件是 Round 9 的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Agent 任务、组件实现、ControlBus 扩展引用本文件时，必须以本文件的 Agent 分配与验证门禁为准。
>
> **前置文档**：
>
> - `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 20-22 子代理调度系统设计约束（全部子节）、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量、禁令 29-31 文档一致性
> - `v2/01-OVERVIEW.md` §3 依赖图、§3.2 拓扑层级、§4.1 轮次总览
> - `v2/ROUND-05-split-phase-C.md` §4 agent-subagent 骨架设计（RecursionGuard / SubagentScheduler / SubagentInstance / DeadlockDetector 接口骨架）
> - `v2/ROUND-08-plugin-sdk.md` PluginManifest.agents 字段定义、PluginRegistry 接口
>
> **本 Round 遵守的硬性红线**：
>
> - 本 Round：5 个必要组件第一版必须实现（RecursionGuard / ConcurrencyController / SubagentScheduler / SubagentInstance / DeadlockDetector）
> - 本 Round：5 类推迟组件仅预留接口（Watchdog.stuckDetection / TokenBudgetTracker / priority/affinity / isolationMode / SubagentState.paused）
> - 禁令 20：禁止新建 SubagentCommunicationBus，子代理通信通过 ControlBus 扩展实现
> - ROUND-09 §3.2 DEFAULT_RECURSION_GUARD：递归守卫默认值唯一权威值（maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0）
> - 禁令 21：role 为标签，capabilityMode 控制实际权限，禁止双重维度
> - 禁令 22：子代理发现统一到插件系统，保留 BuiltinDiscoverySource
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为迁移阶段
> - 禁令 26：TSC 错误数 ≤ 该轮基线（不恶化），不承诺清零
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 9 处于拓扑 Layer 5（子代理完整层），在 Round 8（plugin-sdk 重建完成）之后执行。本 Round 完成 `agent-subagent` 包从 Round 5 骨架到完整调度系统的跃迁，是依赖链最后一环（R10 Rust 对齐依赖 R9 的 CrishError 体系与调度语义）。

```
Layer 0-4: shared-types / shared-utils / logger / telemetry / agent-context / agent-permissions / agent-mcp / agent-tools / agent-model / agent-core  （R1-R5 已就位）
Layer 5:   agent-subagent[骨架]                （R5 已创建骨架，本 Round 完整化）
Layer 6-7: agent-orchestrator / agent-daemon   （R6/R7 已重构）
Layer 8:   plugin-sdk[完整]                    （R8 已重建 — PluginRegistry + PluginManifest.agents 就位）
Layer 9:  Rust crates                         （R10 对齐）
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2 与 §4.2 伪并行警告）：

- Round 8 必须先于 Round 9：子代理发现机制硬依赖插件系统的 PluginRegistry 与 PluginManifest.agents 字段
- Round 9 必须先于 Round 10：Rust 侧 CrishErrorPayload 对齐需要 TS 侧 subagent 错误码已稳定
- 循环依赖必须保持为 0（dependency-cruiser 强制）

### 1.2 目标包

| 目标包                        | 拓扑层  | 职责                                                                                                                   | 主责 Agent    | 文件数（约） |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| `@crish/agent-subagent`       | Layer 5 | 子代理调度系统完整化：RecursionGuard + ConcurrencyController + DeadlockDetector + SubagentScheduler + SubagentInstance | 9-A, 9-B, 9-C | ~14          |
| `@crish/agent-core`（扩展）   | Layer 4 | ControlBus 扩展 L3 request-response 语义（correlationId）                                                              | 9-D           | ~3           |
| `@crish/agent-daemon`（更新） | Layer 7 | subagent-runtime / subagent-lifecycle / subagent-handlers 切换到新调度系统                                             | 9-D           | ~4           |
| 测试套件                      | —       | RecursionGuard / DeadlockDetector / SubagentScheduler / 端到端测试                                                     | 9-E           | ~6           |

**包间依赖关系**（本 Round 新建/增强的边以 `[NEW]` / `[EXT]` 标注）：

| 包               | 依赖（→ 指向被依赖方）                                                                                                          | 拓扑层  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `agent-subagent` | `agent-core`, `agent-tools`, `agent-mcp`, `agent-context`, `shared-types`, `shared-utils`, `plugin-sdk` `[NEW]`                 | Layer 5 |
| `agent-daemon`   | `agent-subagent` `[EXT — 由 legacy 路径切换为直接依赖]`, `agent-orchestrator`, `agent-core`, `agent-model`, `agent-permissions` | Layer 7 |

> 依据 `02-FILE-MAPPING.md` §9.1 与 `01-OVERVIEW.md` §3 mermaid：`agent-subagent` 依赖 `agent-core`（非反向）。新增对 `plugin-sdk` 的依赖用于发现机制，符合 禁令 22"子代理发现统一到插件系统"。

### 1.3 交付物清单

| 交付物                             | 路径                                                                              | 说明                                    |
| ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| `agent-subagent` 完整包            | `packages/agent-subagent/src/`                                                    | 5 个核心组件 + index barrel 更新        |
| `agent-core` ControlBus 扩展       | `packages/agent-core/src/control/`                                                | L3 request-response 语义                |
| `agent-daemon` subagent 三件套更新 | `packages/agent-daemon/src/`                                                      | subagent-runtime / lifecycle / handlers |
| 测试套件                           | `packages/agent-subagent/src/__tests__/` + `packages/agent-daemon/src/__tests__/` | 4 类测试                                |
| 验证报告                           | 本文件 §6                                                                         | 8 项标准检查 + 专项检查                 |

### 1.4 关键设计决策（依据 禁令 20-22 全部子节）

| 决策            | 依据                                             | 选择                                                                             |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| 调度策略        | 本 Round 推迟 priority/affinity                  | 仅 FIFO，SchedulingStrategy 接口预留                                             |
| 状态机          | 本 Round 简化为 4 状态                           | pending → running → completed/failed（无 paused/resuming）                       |
| 死锁检测        | 本 Round 轻量级实现                              | spawn 时 O(depth) 检查 ancestorSessionIds，禁止后台线程扫描                      |
| 通信总线        | 禁令 20 禁止新建 SubagentCommunicationBus        | 复用 ControlBus（L1 send / L2 subscribe / L3 request-response）                  |
| 递归守卫默认值  | ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 唯一权威值 | maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0 |
| 权限模型        | 禁令 21 role 为标签                              | capabilityMode 控制权限，调度器不看 role                                         |
| 发现机制        | 禁令 22 统一到插件系统                           | PluginManifest.agents + BuiltinDiscoverySource                                   |
| 隔离模式        | 本 Round 仅支持 none                             | 同进程隔离通过 capabilityMode 控制                                               |
| 全局 token 预算 | 本 Round 预留字段默认 0                          | RecursionGuard.totalTokenBudget = 0（不限制）                                    |
| 全局超时        | 本 Round 预留字段默认 0                          | RecursionGuard.totalTimeoutMs = 0（不限制），仅每实例 timeoutMs                  |

---

## 2. Agent 任务详细设计

### 2.1 Agent 9-A：RecursionGuard + ConcurrencyController

| 维度     | 说明                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型 + 迁移型（封装现有全局变量）                                                                                                                                                                                                   |
| **目标** | 实现 RecursionGuard（maxDepth/maxSiblings/maxConcurrent 三维度检查）+ ConcurrencyController（全局/每父/队列三维度并发上限），封装现有 `AsyncSemaphore` + `SubagentDepthGuard` + 全局变量 `currentActiveSubagents`/`subagentSemaphore` |
| **前置** | Round 5 已创建 `agent-subagent` 骨架（`recursion-guard.ts` 接口骨架 + `subagents.ts` 现有实现）                                                                                                                                       |
| **后续** | Agent 9-C 的 SubagentScheduler 依赖本组件；Agent 9-D 的 daemon 集成依赖本组件                                                                                                                                                         |

**输入**：

- `packages/agent-subagent/src/recursion-guard.ts`（R5 接口骨架，含 DEFAULT_RECURSION_GUARD）
- `packages/agent-subagent/src/subagents.ts`（R5 迁移版，560 行；含 `SubagentDepthGuard` / `AsyncSemaphore` 实例 / `currentActiveSubagents` 全局变量 / `extractDepthContext`）
- `packages/shared-utils/src/` 的 `AsyncSemaphore` 实现

**输出**：

- `packages/agent-subagent/src/recursion-guard.ts`（完整实现，替换 R5 接口骨架）
- `packages/agent-subagent/src/concurrency-controller.ts`（[NEW] 完整实现）
- `packages/agent-subagent/src/subagents.ts`（移除被封装的全局变量与递归守卫执行逻辑，改为调用 RecursionGuard/ConcurrencyController）

**任务量**：2 文件新建/重写 + 1 文件改造（移除 ~80 行全局变量与内联守卫逻辑，改为委托调用），约 350+ 行新增代码，超过 禁令 28 门槛。

**关键设计约束**：

1. **唯一权威默认值**（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD）：maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0
2. **三维度递归检查**：maxDepth（祖先链深度）、maxSiblings（同一父下兄弟数）、maxConcurrent（全局并发数），任一超过即拒绝
3. **封装而非删除现有 AsyncSemaphore**：现有 `subagentSemaphore` 是成熟并发原语，封装到 ConcurrencyController 内部继续使用，不重写
4. **消除模块级全局变量**：现有 `let currentActiveSubagents = 0` 是反模式（多实例污染），必须封装为 ConcurrencyController 实例字段
5. **早退不占配额**：递归守卫检查失败时不占用并发配额（保留现有早退语义）

**协调点**：1 次（与 Agent 9-C 约定 RecursionGuard.check() 与 ConcurrencyController.acquire() 的调用契约）

---

### 2.2 Agent 9-B：DeadlockDetector（轻量级）

| 维度     | 说明                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型                                                                                                                  |
| **目标** | 实现 DeadlockDetector：在 spawn 时检查 ancestorSessionIds 是否包含目标 session，O(depth) 复杂度，禁止运行时后台线程扫描 |
| **前置** | Round 5 已定义 DeadlockDetector 接口骨架（`recursion-guard.ts` 内）                                                     |
| **后续** | Agent 9-C 的 SubagentScheduler 在 submit 时调用 detectCycle                                                             |

**输入**：

- `packages/agent-subagent/src/recursion-guard.ts`（R5 的 DeadlockDetector 接口骨架）
- 现有 `subagents.ts` 的 `extractDepthContext` 思路（通过 metadata 传递深度上下文）

**输出**：

- `packages/agent-subagent/src/deadlock-detector.ts`（[NEW] 完整实现）
- `packages/agent-subagent/src/recursion-guard.ts`（移除 DeadlockDetector 接口骨架，改为 re-export 自 deadlock-detector.ts）

**任务量**：1 文件新建 + 1 文件改造，约 200 行新增代码。

**关键设计约束**：

1. **轻量级实现**（本 Round）：spawn 时一次性检查，O(depth) 复杂度，depth 通常 ≤ 3
2. **禁止后台线程扫描**（本 Round）：不得引入 setInterval / setTimeout 周期性扫描
3. **检测到环时抛 CrishError**：错误码 `subagent.deadlock`，category=permanent，retryable=false
4. **正常场景不误报**：线性祖先链（A→B→C，无环）必须返回 false
5. **空祖先链或自引用**：空数组返回 false（无祖先不会成环）；targetSessionId 等于祖先链中任一 session 即返回 true

**协调点**：1 次（与 Agent 9-C 约定 detectCycle 调用时机：在 SubagentScheduler.submit 入口处、RecursionGuard.check 之后调用）

---

### 2.3 Agent 9-C：SubagentScheduler + SubagentInstance

| 维度     | 说明                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型                                                                                                  |
| **目标** | 实现 SubagentScheduler（FIFO 调度队列）+ SubagentInstance（4 状态机 + timeout + cancel + 进度事件收集） |
| **前置** | Agent 9-A 完成 RecursionGuard + ConcurrencyController；Agent 9-B 完成 DeadlockDetector                  |
| **后续** | Agent 9-D 的 daemon 集成使用 SubagentScheduler                                                          |

**输入**：

- `packages/agent-subagent/src/scheduler.ts`（R5 接口骨架，含 SubagentScheduler / SubagentInstance / SubagentResult / SchedulerSnapshot 接口）
- `packages/agent-subagent/src/subagents.ts`（现有执行循环逻辑：emitProgress / observeSubagentEvent / stats 收集）
- `packages/agent-core/src/control/control-bus.ts`（ControlBus L1/L2，本 Round 由 9-D 扩展 L3）
- `packages/shared-utils/src/` 的 abort-utils

**输出**：

- `packages/agent-subagent/src/scheduler.ts`（完整实现，替换 R5 接口骨架）
- `packages/agent-subagent/src/instance.ts`（[NEW] SubagentInstance 完整实现，从 scheduler.ts 拆分以保持单文件单职责）

**任务量**：2 文件新建/重写，约 450+ 行新增代码。

**关键设计约束**：

1. **仅 FIFO 调度**（本 Round）：禁止 priority/affinity 策略实现，SchedulingStrategy 接口预留但无实现
2. **4 状态机**（本 Round）：pending → running → completed/failed，禁止 paused/resuming
3. **timeout 检测**（本 Round）：通过 AbortController + timeoutMs 实现，stuck detection 留空接口
4. **取消机制**：AbortController.abort() 触发，子代理 run loop 在安全点检查 signal.aborted
5. **进度事件收集**：保留现有 `SubagentProgressEvent` 设计与 `emitProgress` 机制
6. **capabilityMode 控制权限**（禁令 21）：调度器只看 capabilityMode，不看 role

**协调点**：2 次（依赖 9-A 的 RecursionGuard/ConcurrencyController + 9-B 的 DeadlockDetector；与 9-D 约定 SubagentScheduler 的实例化与调用方式）

---

### 2.4 Agent 9-D：ControlBus 扩展 + Daemon SubagentBridge 更新

| 维度     | 说明                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型 + 迁移型                                                                                                                                                           |
| **目标** | 在 ControlBus 上增加 request-response 语义（correlationId）；更新 agent-daemon 的 subagent-runtime / subagent-lifecycle / subagent-handlers 使用新的调度系统与 CrishError |
| **前置** | Agent 9-A/9-B/9-C 完成调度系统组件                                                                                                                                        |
| **后续** | Agent 9-E 端到端验证                                                                                                                                                      |

**输入**：

- `packages/agent-core/src/control/control-bus.ts`（现有 ControlBus，L1 send + L2 drainAsAction）
- `packages/agent-core/src/control/types.ts`（RunControlIntent / RunControlIntentInput）
- `packages/agent-daemon/src/subagent-runtime.ts`（现有 daemon 子代理 runtime，使用 `AsyncSemaphore(32)` — 与 ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 的 maxConcurrent=6 不一致，需统一）
- `packages/agent-daemon/src/subagent-lifecycle.ts`（现有 6 状态机：starting/running/completed/failed/cancelled/orphaned）
- `packages/agent-daemon/src/handlers/subagent-handlers.ts`（使用字符串错误码 "SUBAGENT_SEND_ERROR"）
- `packages/agent-daemon/src/daemon-subagent-bridge.ts`（现有 bridge）

**输出**：

- `packages/agent-core/src/control/control-bus.ts`（增加 L3 request-response 方法）
- `packages/agent-core/src/control/types.ts`（增加 CorrelationId / RequestResponseEnvelope 类型）
- `packages/agent-daemon/src/subagent-runtime.ts`（切换到 SubagentScheduler + RecursionGuard）
- `packages/agent-daemon/src/subagent-lifecycle.ts`（委托给 SubagentInstance 4 状态机，保留 cancelled/orphaned 作为 daemon 特有扩展状态）
- `packages/agent-daemon/src/handlers/subagent-handlers.ts`（错误码迁移到 CrishError）

**任务量**：5 文件改造，约 300+ 行变更。

**关键设计约束**：

1. **不新建 SubagentCommunicationBus**（禁令 20）：L3 在现有 ControlBus 上扩展，不新建类
2. **L1/L2 不破坏**（禁令 20）：现有 `request()` / `drainAsAction()` / `requestSteer()` 等签名不变
3. **correlationId 语义**：request 返回 Promise，response 通过 correlationId 关联；超时通过 AbortController 实现
4. **daemon 子代理并发统一为 6**（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD）：现有 `AsyncSemaphore(32)` 改为通过 ConcurrencyController 注入，默认 maxConcurrent=6
5. **错误码迁移遵循三阶段**（禁令 23）：现有字符串错误码与新 CrishError 共存，本 Round 为迁移阶段
6. **SubagentLifecycleState 保留 daemon 特有状态**：cancelled/orphaned 是 daemon 特有（进程级清理需要），不违反 本 Round（本 Round 约束的是 agent-subagent 包的 SubagentInstance 状态机）

**协调点**：2 次（依赖 9-A/9-B/9-C 的组件；与 9-E 约定端到端测试用例）

---

### 2.5 Agent 9-E：测试套件 + 端到端验证

| 维度     | 说明                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| **类型** | 验证型 + 实现型（测试代码）                                                                       |
| **目标** | 编写 4 类测试（RecursionGuard / DeadlockDetector / SubagentScheduler / 端到端），运行全部验证门禁 |
| **前置** | Agent 9-A~9-D 全部完成                                                                            |
| **后续** | Round 10（Rust 侧对齐）                                                                           |

**输入**：

- Agent 9-A~9-D 的全部产出
- `packages/agent-subagent/src/testing/`（测试基础设施）
- `packages/agent-runtime/src/testing/`（faux-provider / mock-tool，可复用）

**输出**：

- `packages/agent-subagent/src/__tests__/recursion-guard.test.ts`
- `packages/agent-subagent/src/__tests__/deadlock-detector.test.ts`
- `packages/agent-subagent/src/__tests__/scheduler.test.ts`
- `packages/agent-subagent/src/__tests__/e2e-subagent.test.ts`
- `round-09-tsc-baseline.json` + `round-09-tsc-final.json`
- `round-09-verification-report.md`

**任务量**：4 测试文件 + 1 验证报告，约 500+ 行测试代码。

**关键设计约束**：

1. **测试覆盖必要场景**：maxDepth/maxSiblings/maxConcurrent 三维度边界、环检测正反例、FIFO 顺序、timeout 触发、cancel 触发、端到端 spawn→execute→return
2. **不测试推迟组件**：不写 stuck detection / token budget / priority 调度的测试（这些未实现）
3. **正常场景不误报**：DeadlockDetector 线性祖先链测试必须通过
4. **运行 8 项验证门禁**：TSC / cargo check / vitest / cargo test / depcruise / turbo build / lint / store-types

**协调点**：2 次（依赖 9-A~9-D 全部产出 + Round 8 基线）

---

## 3. agent-subagent 包完整设计

### 3.1 目录结构

```
packages/agent-subagent/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                              # barrel（更新导出清单）
    ├── subagents.ts                          # 现有执行入口（保留，改造为调用新组件）
    ├── subagents.test.ts                     # 现有测试
    ├── subagent-loop.ts                      # 子代理执行循环
    ├── subagent-skill-runner.ts              # 子代理技能运行器
    ├── subagent-types.ts                     # 子代理类型定义（扩展 SubagentRole/capabilityMode）
    ├── subagent-context-pack.ts              # 子代理上下文打包
    ├── subagent-context-pack.test.ts
    ├── recursion-guard.ts                    # [R5 骨架→R9 完整] RecursionGuard 实现
    ├── concurrency-controller.ts              # [NEW] ConcurrencyController 实现
    ├── deadlock-detector.ts                  # [NEW] DeadlockDetector 实现
    ├── scheduler.ts                          # [R5 骨架→R9 完整] SubagentScheduler 实现
    ├── instance.ts                           # [NEW] SubagentInstance 实现（4 状态机）
    ├── discovery.ts                         # [NEW] 子代理发现（BuiltinDiscoverySource + PluginDiscoverySource）
    └── __tests__/
        ├── recursion-guard.test.ts           # [NEW]
        ├── deadlock-detector.test.ts         # [NEW]
        ├── scheduler.test.ts                 # [NEW]
        └── e2e-subagent.test.ts             # [NEW]
```

**package.json dependencies 更新**（相对 R5 骨架增加 plugin-sdk 依赖）：

```json
{
  "dependencies": {
    "@crish/shared-types": "*",
    "@crish/shared-utils": "*",
    "@crish/agent-core": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-mcp": "*",
    "@crish/agent-context": "*",
    "@crish/plugin-sdk": "*"
  }
}
```

> 新增 `@crish/plugin-sdk` 依赖依据 禁令 22"子代理发现统一到插件系统"。

### 3.2 RecursionGuard 完整接口 + 实现

> 依据 本 Round（必须实现）、本 Round（totalTokenBudget/totalTimeoutMs 预留）、ROUND-09 §3.2 DEFAULT_RECURSION_GUARD（唯一权威默认值）、禁令 21（role 为标签，capabilityMode 控制权限）。

#### 3.2.1 接口签名

```ts
// packages/agent-subagent/src/recursion-guard.ts

import type { JsonObject, ToolExecutionContext } from '@crish/shared-types';
import type { CrishError } from '@crish/shared-types';

/**
 * SubagentRole — 子代理角色标签（禁令 21：仅用于展示和过滤，不影响调度）。
 */
export type SubagentRole =
  'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner';

/**
 * CapabilityMode — 实际权限控制维度（禁令 21：调度器只看此字段）。
 *
 * 注意：禁止 role 与 capabilityMode 并存的双重维度。
 * role 是元数据（展示），capabilityMode 是权限（执行）。
 */
export type CapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all';

/**
 * 递归守卫配置（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 唯一权威默认值）。
 *
 * 三维度检查（任一超过即拒绝 spawn）：
 * - maxDepth：祖先链最大深度
 * - maxSiblings：同一父 session 下最大兄弟子代理数
 * - maxConcurrent：全局同时运行子代理上限
 *
 * 预留字段（本 Round，第一版不实现，默认 0 = 不限制）：
 * - totalTokenBudget：全局 token 预算上限
 * - totalTimeoutMs：全局超时上限
 */
export interface RecursionGuard {
  /** 祖先链最大深度（默认 3，ROUND-09 §3.2 DEFAULT_RECURSION_GUARD） */
  readonly maxDepth: number;
  /** 同一父 session 下最大兄弟子代理数（默认 5，ROUND-09 §3.2 DEFAULT_RECURSION_GUARD） */
  readonly maxSiblings: number;
  /** 全局同时运行子代理上限（默认 6，ROUND-09 §3.2 DEFAULT_RECURSION_GUARD） */
  readonly maxConcurrent: number;
  /** 全局 token 预算上限（预留，默认 0 = 不限制，本 Round） */
  readonly totalTokenBudget: number;
  /** 全局超时上限（预留，默认 0 = 不限制，本 Round） */
  readonly totalTimeoutMs: number;
}

/**
 * 唯一权威默认值（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD）。
 *
 * 注意：R5 已将原 subagents.ts 的 DEFAULT_SUBAGENT_DEPTH_GUARD
 *   { maxDepth: 2, maxSiblings: 4, maxConcurrent: 6 }
 * 更新为以下值。
 */
export const DEFAULT_RECURSION_GUARD: RecursionGuard = {
  maxDepth: 3,
  maxSiblings: 5,
  maxConcurrent: 6,
  totalTokenBudget: 0,
  totalTimeoutMs: 0,
};

/**
 * 递归守卫检查上下文（通过 ToolExecutionContext.metadata 在父子间传递）。
 *
 * ancestorSessionIds：从根 session 到当前 session 的祖先链（不含当前）。
 * 用于：
 *  - 深度计算（ancestorSessionIds.length + 1 = 当前深度）
 *  - 死锁检测（DeadlockDetector 复用此字段）
 *  - 兄弟计数（同一 parentSessionId 下的兄弟数）
 */
export interface RecursionCheckContext {
  /** 祖先 session 链（从根到当前父 session，不含当前要 spawn 的目标） */
  ancestorSessionIds: string[];
  /** 当前父 session ID（用于兄弟计数） */
  parentSessionId: string;
  /** 兄弟计数器（外部注入，避免守卫内部维护全局状态） */
  siblingCounter: SiblingCounter;
  /** 并发计数器（外部注入，封装原 currentActiveSubagents 全局变量） */
  concurrentCounter: ConcurrentCounter;
}

export interface SiblingCounter {
  /** 获取指定 parentSessionId 下的兄弟数 */
  get(parentSessionId: string): number;
  /** 增加兄弟计数（spawn 成功时调用） */
  increment(parentSessionId: string): void;
  /** 减少兄弟计数（spawn 完成时调用） */
  decrement(parentSessionId: string): void;
}

export interface ConcurrentCounter {
  /** 当前并发数 */
  readonly current: number;
  /** 增加并发计数 */
  increment(): void;
  /** 减少并发计数 */
  decrement(): void;
}

/**
 * 递归守卫检查结果。
 *
 * ok=true：通过，可以 spawn。
 * ok=false：拒绝，附带原因码（不抛异常，由调用方决定如何处理）。
 */
export type RecursionCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'max-depth-exceeded'
        | 'max-siblings-exceeded'
        | 'max-concurrent-exceeded';
      limit: number;
      actual: number;
    };

/**
 * 执行递归守卫检查（纯函数，不修改状态）。
 *
 * 检查顺序（早退，不占用配额）：
 *  1. maxDepth：ancestorSessionIds.length + 1 > maxDepth → 拒绝
 *  2. maxSiblings：siblingCounter.get(parentSessionId) >= maxSiblings → 拒绝
 *  3. maxConcurrent：concurrentCounter.current >= maxConcurrent → 拒绝
 *
 * 注意：本函数只检查，不修改计数。计数修改由调用方在 spawn 成功/完成时调用
 * siblingCounter.increment/decrement 与 concurrentCounter.increment/decrement。
 */
export function checkRecursionGuard(
  guard: RecursionGuard,
  context: RecursionCheckContext
): RecursionCheckResult {
  const currentDepth = context.ancestorSessionIds.length + 1;
  if (currentDepth > guard.maxDepth) {
    return {
      ok: false,
      reason: 'max-depth-exceeded',
      limit: guard.maxDepth,
      actual: currentDepth,
    };
  }
  const siblings = context.siblingCounter.get(context.parentSessionId);
  if (siblings >= guard.maxSiblings) {
    return {
      ok: false,
      reason: 'max-siblings-exceeded',
      limit: guard.maxSiblings,
      actual: siblings,
    };
  }
  if (context.concurrentCounter.current >= guard.maxConcurrent) {
    return {
      ok: false,
      reason: 'max-concurrent-exceeded',
      limit: guard.maxConcurrent,
      actual: context.concurrentCounter.current,
    };
  }
  return { ok: true };
}

/**
 * 从 ToolExecutionContext 提取递归上下文（保留现有 extractDepthContext 语义，扩展为祖先链）。
 *
 * 现有实现仅传递 subagentDepth 数字，本 Round 扩展为 ancestorSessionIds 数组
 * （同时保留 subagentDepth 数字字段以兼容现有代码，共存阶段）。
 */
export function extractRecursionContext(
  context: ToolExecutionContext,
  siblingCounter: SiblingCounter,
  concurrentCounter: ConcurrentCounter
): RecursionCheckContext {
  const metadata = context.metadata as Record<string, unknown> | undefined;
  const rawAncestors = metadata?.ancestorSessionIds;
  const ancestorSessionIds: string[] = Array.isArray(rawAncestors)
    ? rawAncestors.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    ancestorSessionIds,
    parentSessionId: context.sessionId,
    siblingCounter,
    concurrentCounter,
  };
}
```

#### 3.2.2 关键实现逻辑

```ts
// 关键实现要点（伪代码，实际实现见文件）

/**
 * 1. 三维度检查顺序遵循"早退不占配额"原则：
 *    maxDepth → maxSiblings → maxConcurrent
 *    深度检查无需任何状态查询，最先做；并发检查最后做（涉及共享状态）。
 *
 * 2. 计数器通过依赖注入，不使用模块级全局变量：
 *    现有 `let currentActiveSubagents = 0` 是反模式（多 Runtime 实例污染）。
 *    ConcurrencyController（§3.3）封装 ConcurrentCounter，每个 Runtime 实例独立。
 *
 * 3. ancestorSessionIds 数组化（替代现有 subagentDepth 数字）：
 *    - 现有 extractDepthContext 仅传递 depth 数字，无法做死锁检测。
 *    - 本 Round 扩展为 ancestorSessionIds 数组，DeadlockDetector 复用此字段。
 *    - 共存阶段：metadata 中同时保留 subagentDepth（数字）与 ancestorSessionIds（数组），
 *      旧代码读 subagentDepth，新代码读 ancestorSessionIds。
 *
 * 4. totalTokenBudget / totalTimeoutMs 预留字段不参与检查逻辑：
 *    checkRecursionGuard 不读取这两个字段（本 Round 第一版不实现）。
 *    字段存在于接口中供未来扩展，DEFAULT_RECURSION_GUARD 设为 0。
 */
```

#### 3.2.3 与现有 subagents.ts 的集成

现有 `subagents.ts` 第 175-202 行的递归守卫逻辑：

```ts
// 现有代码（将被替换）
const guard = options.depthGuard ?? DEFAULT_SUBAGENT_DEPTH_GUARD;
const parentDepth = extractDepthContext(context);
const currentDepth = parentDepth.currentDepth + 1;
if (currentDepth > guard.maxDepth) { return { text: "...", json: {...} }; }
const maxConcurrent = guard.maxConcurrent ?? DEFAULT_SUBAGENT_DEPTH_GUARD.maxConcurrent ?? 6;
if (currentActiveSubagents >= maxConcurrent) { return { text: "...", json: {...} }; }
const releaseSubagentSlot = await subagentSemaphore.acquire();
currentActiveSubagents++;
```

替换为：

```ts
// R9 新代码
const guard = options.recursionGuard ?? DEFAULT_RECURSION_GUARD;
const recursionContext = extractRecursionContext(
  context,
  scheduler.siblingCounter,
  scheduler.concurrentCounter
);
const checkResult = checkRecursionGuard(guard, recursionContext);
if (!checkResult.ok) {
  return {
    text: `Sub-agent creation denied: ${checkResult.reason} (limit=${checkResult.limit}, actual=${checkResult.actual}).`,
    json: {
      error: checkResult.reason,
      limit: checkResult.limit,
      actual: checkResult.actual,
      description,
    },
  };
}
// 死锁检测（§3.4）
const deadlockDetected = scheduler.deadlockDetector.detectCycle(
  recursionContext.ancestorSessionIds,
  subagentId
);
if (deadlockDetected) {
  throw new CrishError(
    `Sub-agent spawn denied: deadlock detected (target ${subagentId} is in ancestor chain).`,
    'subagent.deadlock',
    'permanent',
    false,
    {
      ancestorSessionIds: recursionContext.ancestorSessionIds,
      targetSessionId: subagentId,
    }
  );
}
// 并发槽位获取（封装原 subagentSemaphore.acquire）
const releaseSlot = await scheduler.concurrencyController.acquire(
  recursionContext.parentSessionId
);
try {
  // ... 执行子代理
} finally {
  releaseSlot();
}
```

### 3.3 ConcurrencyController 完整接口 + 实现

> 依据 本 Round（必须实现）、ROUND-09 §3.2 DEFAULT_RECURSION_GUARD（maxConcurrent=6 唯一权威值）。封装现有 `AsyncSemaphore` + 全局变量 `currentActiveSubagents` + `subagentSemaphore`。

#### 3.3.1 接口签名

```ts
// packages/agent-subagent/src/concurrency-controller.ts

import { AsyncSemaphore } from '@crish/shared-utils';
import type {
  RecursionGuard,
  SiblingCounter,
  ConcurrentCounter,
} from './recursion-guard';

/**
 * ConcurrencyController — 多维度并发控制
 *
 * 三维度上限（本 Round）：
 *  1. 全局并发上限（maxConcurrent）：所有子代理共享一个 AsyncSemaphore
 *  2. 每父并发上限（per-parent）：同一父 session 下的并发数（默认 = maxSiblings）
 *  3. 队列上限：等待中的任务数上限（防止无限排队，默认 = maxConcurrent * 2）
 *
 * 封装现有：
 *  - AsyncSemaphore 实例（原 subagentSemaphore，跨工具实例共享）
 *  - 全局变量 currentActiveSubagents（反模式，本 Round 消除）
 *
 * 设计决策：
 *  - 不重写 AsyncSemaphore（成熟原语，§1.3 资产清单确认）
 *  - 不引入优先级队列（本 Round priority 推迟，仅 FIFO）
 *  - 不引入超时排队（排队超时由 SubagentInstance.timeoutMs 在 spawn 后控制，排队阶段不计超时）
 */
export interface ConcurrencyController {
  /** 全局并发上限（= RecursionGuard.maxConcurrent） */
  readonly maxConcurrent: number;
  /** 每父并发上限（= RecursionGuard.maxSiblings） */
  readonly maxSiblings: number;
  /** 队列上限（= maxConcurrent * 2，防止无限排队） */
  readonly maxQueued: number;
  /** 当前并发数（封装原 currentActiveSubagents） */
  readonly currentConcurrent: number;
  /** 当前排队数 */
  readonly currentQueued: number;
  /** 兄弟计数器（供 RecursionGuard.check 使用） */
  readonly siblingCounter: SiblingCounter;
  /** 并发计数器（供 RecursionGuard.check 使用） */
  readonly concurrentCounter: ConcurrentCounter;

  /**
   * 获取执行槽位（异步，阻塞直到有可用槽位）。
   *
   * 调用时机：RecursionGuard.check 通过后、DeadlockDetector.detectCycle 通过后。
   *
   * @param parentSessionId 用于兄弟计数
   * @returns release 函数（必须在 finally 中调用）
   *
   * 副作用：
   *  - 全局 AsyncSemaphore.acquire（阻塞）
   *  - concurrentCounter.increment
   *  - siblingCounter.increment(parentSessionId)
   */
  acquire(parentSessionId: string): Promise<() => void>;

  /**
   * 快照当前状态（用于监控/调试）。
   */
  snapshot(): ConcurrencySnapshot;
}

export interface ConcurrencySnapshot {
  maxConcurrent: number;
  currentConcurrent: number;
  maxSiblings: number;
  perParentSiblings: ReadonlyMap<string, number>;
  maxQueued: number;
  currentQueued: number;
}

/**
 * ConcurrencyController 默认实现。
 *
 * 使用 AsyncSemaphore 控制全局并发，Map<parentSessionId, number> 控制兄弟数。
 * 不使用 Mutex 保护 Map（Node.js 单线程，acquire/release 是原子异步操作）。
 */
export class DefaultConcurrencyController implements ConcurrencyController {
  private readonly semaphore: AsyncSemaphore;
  private readonly siblings = new Map<string, number>();
  private queued = 0;

  constructor(private readonly guard: RecursionGuard) {
    this.semaphore = new AsyncSemaphore(guard.maxConcurrent);
  }

  get maxConcurrent(): number {
    return this.guard.maxConcurrent;
  }
  get maxSiblings(): number {
    return this.guard.maxSiblings;
  }
  get maxQueued(): number {
    return this.guard.maxConcurrent * 2;
  }
  get currentConcurrent(): number {
    return this.guard.maxConcurrent - this.semaphore.available;
  }
  get currentQueued(): number {
    return this.queued;
  }

  readonly siblingCounter: SiblingCounter = {
    get: (parentSessionId: string) => this.siblings.get(parentSessionId) ?? 0,
    increment: (parentSessionId: string) => {
      this.siblings.set(
        parentSessionId,
        (this.siblings.get(parentSessionId) ?? 0) + 1
      );
    },
    decrement: (parentSessionId: string) => {
      const current = this.siblings.get(parentSessionId) ?? 0;
      if (current <= 1) this.siblings.delete(parentSessionId);
      else this.siblings.set(parentSessionId, current - 1);
    },
  };

  readonly concurrentCounter: ConcurrentCounter = {
    get current() {
      return this.guard.maxConcurrent - this.semaphore.available;
    },
    increment: () => {
      /* AsyncSemaphore.acquire 已计数，无需额外操作 */
    },
    decrement: () => {
      /* AsyncSemaphore.release 在 release 函数中调用 */
    },
  };

  get perParentSiblings(): ReadonlyMap<string, number> {
    return this.siblings;
  }

  async acquire(parentSessionId: string): Promise<() => void> {
    if (this.queued >= this.maxQueued) {
      throw new Error(`Concurrency queue full (maxQueued=${this.maxQueued})`);
    }
    this.queued++;
    try {
      const releaseSemaphore = await this.semaphore.acquire();
      this.siblingCounter.increment(parentSessionId);
      this.queued--;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSemaphore();
        this.siblingCounter.decrement(parentSessionId);
      };
    } catch (error) {
      this.queued--;
      throw error;
    }
  }

  snapshot(): ConcurrencySnapshot {
    return {
      maxConcurrent: this.maxConcurrent,
      currentConcurrent: this.currentConcurrent,
      maxSiblings: this.maxSiblings,
      perParentSiblings: new Map(this.siblings),
      maxQueued: this.maxQueued,
      currentQueued: this.queued,
    };
  }
}

/**
 * 工厂函数（依赖注入 RecursionGuard）。
 */
export function createConcurrencyController(
  guard: RecursionGuard
): ConcurrencyController {
  return new DefaultConcurrencyController(guard);
}
```

#### 3.3.2 关键实现逻辑

```ts
// 关键实现要点：

/**
 * 1. AsyncSemaphore 复用：
 *    现有 subagentSemaphore = new AsyncSemaphore(6) 是模块级单例。
 *    本 Round 改为 ConcurrencyController 实例字段，每个 Runtime 独立。
 *    AsyncSemaphore 逻辑不重写（成熟原语）。
 *
 * 2. 兄弟计数 Map：
 *    现有代码无兄弟计数（maxSiblings 字段存在但未实际检查）。
 *    本 Round 通过 Map<parentSessionId, number> 实现兄弟计数。
 *    release 时若计数归零则 delete key（避免 Map 无限增长）。
 *
 * 3. 队列上限防止无限排队：
 *    maxQueued = maxConcurrent * 2 = 12。
 *    超过则抛错（而非无限等待，防止 OOM）。
 *    注意：此为反 OOM 措施，非调度策略（本 Round priority 推迟）。
 *
 * 4. release 幂等性：
 *    released 标志位防止重复 release（finally 中可能多次调用）。
 *
 * 5. 不引入 Mutex：
 *    Node.js 单线程事件循环，acquire/release 是原子异步操作。
 *    Map 读写无竞争（await 点之间的同步代码块是原子的）。
 */
```

### 3.4 DeadlockDetector 完整接口 + 实现（轻量级 spawn 时检查）

> 依据 本 Round（必须实现，轻量级 O(depth)）、本 Round（禁止后台线程扫描）。

#### 3.4.1 接口签名

```ts
// packages/agent-subagent/src/deadlock-detector.ts

import { CrishError } from '@crish/shared-types';

/**
 * DeadlockDetector — 轻量级 spawn 时环检测
 *
 * 依据 本 Round：
 *  - 在 spawn 时检查 ancestorSessionIds 是否包含目标 session
 *  - O(depth) 复杂度（depth 通常 ≤ 3，由 maxDepth=3 限制）
 *  - 禁止运行时后台线程扫描（不引入 setInterval/setTimeout 周期扫描）
 *
 * 检测逻辑：
 *  - 如果 targetSessionId 已经在 ancestorSessionIds 中，则 spawn 会形成环
 *    （A→B→C→A），导致死锁
 *  - 检测到环时抛 CrishError('subagent.deadlock', ...)
 *
 * 不检测的场景（明确排除）：
 *  - 跨树环（A→B 与 A→C 之间无环，但 B→C 与 C→B 形成环）：
 *    这种环需要全局等待图分析，超出轻量级实现范围。
 *    实际场景中子代理 spawn 是树状结构（父→子），不会形成跨树环。
 *  - 已运行子代理的动态环：本实现仅在 spawn 时检查，不监控运行时状态变化。
 */
export interface DeadlockDetector {
  /**
   * 检测 spawn 是否会造成环。
   *
   * @param ancestorSessionIds 从根到当前父 session 的祖先链（不含目标）
   * @param targetSessionId 要 spawn 的目标 session ID
   * @returns true 表示检测到环（将造成死锁），false 表示安全
   *
   * 复杂度：O(depth)，depth = ancestorSessionIds.length
   * 典型 depth ≤ 3（由 maxDepth=3 限制）。
   */
  detectCycle(ancestorSessionIds: string[], targetSessionId: string): boolean;

  /**
   * 断言：检测环并在检测到时抛 CrishError。
   *
   * 等价于：
   *   if (detectCycle(ancestorSessionIds, targetSessionId)) {
   *     throw createDeadlockError(ancestorSessionIds, targetSessionId);
   *   }
   *
   * 提供此方法是为了统一错误码与错误消息格式。
   */
  assertNoCycle(ancestorSessionIds: string[], targetSessionId: string): void;
}

/**
 * DeadlockDetector 默认实现（纯函数，无状态）。
 *
 * 设计决策：
 *  - 无状态：不维护任何 Map/Set，每次调用独立计算
 *  - 纯函数：detectCycle 无副作用，可在测试中直接断言
 *  - 无后台线程：不引入 setInterval/setTimeout
 */
export class DefaultDeadlockDetector implements DeadlockDetector {
  detectCycle(ancestorSessionIds: string[], targetSessionId: string): boolean {
    // 空祖先链不会成环（无祖先）
    if (ancestorSessionIds.length === 0) return false;
    // 线性扫描，O(depth)
    for (const ancestorId of ancestorSessionIds) {
      if (ancestorId === targetSessionId) return true;
    }
    return false;
  }

  assertNoCycle(ancestorSessionIds: string[], targetSessionId: string): void {
    if (this.detectCycle(ancestorSessionIds, targetSessionId)) {
      throw createDeadlockError(ancestorSessionIds, targetSessionId);
    }
  }
}

/**
 * 创建死锁错误（统一错误码与消息格式）。
 *
 * 错误码：subagent.deadlock
 * category：permanent（死锁不可重试，必须修改调用图）
 * retryable：false
 */
export function createDeadlockError(
  ancestorSessionIds: string[],
  targetSessionId: string
): CrishError {
  return new CrishError(
    `Sub-agent spawn denied: deadlock detected. Target session ${targetSessionId} is already in the ancestor chain [${ancestorSessionIds.join(' → ')}].`,
    'subagent.deadlock',
    'permanent',
    false,
    {
      ancestorSessionIds,
      targetSessionId,
      cycleLength: ancestorSessionIds.indexOf(targetSessionId) + 1,
    }
  );
}

/**
 * 工厂函数。
 */
export function createDeadlockDetector(): DeadlockDetector {
  return new DefaultDeadlockDetector();
}
```

#### 3.4.2 关键实现逻辑

```ts
// 关键实现要点：

/**
 * 1. O(depth) 复杂度：
 *    线性扫描 ancestorSessionIds 数组，最坏情况扫描全部元素。
 *    depth ≤ maxDepth = 3，所以最多扫描 3 次。
 *
 * 2. 禁止后台线程扫描（本 Round）：
 *    本实现无 setInterval/setTimeout/Worker。
 *    所有检查在 spawn 调用栈中同步完成。
 *
 * 3. 检测时机（由 SubagentScheduler 调用）：
 *    submit() 入口处，RecursionGuard.check 之后：
 *      a. RecursionGuard.check（maxDepth/maxSiblings/maxConcurrent）
 *      b. DeadlockDetector.assertNoCycle（环检测）
 *      c. ConcurrencyController.acquire（获取槽位）
 *    顺序理由：
 *      - RecursionGuard 先做（早退，不占配额）
 *      - DeadlockDetector 次之（O(depth) 极快，且死锁是 fatal 错误，应尽早拒绝）
 *      - ConcurrencyController 最后（可能阻塞等待槽位，不应在死锁时排队）
 *
 * 4. 正常场景不误报：
 *    线性祖先链 A→B→C（无环）：ancestorSessionIds=["A","B"], target="C"
 *    扫描 "A"≠"C", "B"≠"C"，返回 false（安全）。
 *
 * 5. 环场景正确检测：
 *    环 A→B→A：ancestorSessionIds=["A","B"], target="A"
 *    扫描 "A"==="A"，返回 true（检测到环，抛 CrishError）。
 *
 * 6. 不检测跨树环：
 *    子代理 spawn 是树状结构（父→子），不会形成跨树环。
 *    若未来支持子代理间直接通信（非父子），需扩展为全局等待图分析。
 *    当前 禁令 20 约束通信通过 ControlBus，不引入子代理间直接 spawn。
 */
```

### 3.5 SubagentScheduler 完整接口 + 实现（FIFO）

> 依据 本 Round（必须实现）、本 Round（仅 FIFO，priority/affinity 推迟）、禁令 21（capabilityMode 控制权限，不看 role）。

#### 3.5.1 接口签名

```ts
// packages/agent-subagent/src/scheduler.ts

import type { CrishError } from '@crish/shared-types';
import type { AgentRuntime } from '@crish/agent-core';
import type { RecursionGuard, RecursionCheckContext } from './recursion-guard';
import type { ConcurrencyController } from './concurrency-controller';
import type { DeadlockDetector } from './deadlock-detector';
import type { SubagentInstance, SubagentResult } from './instance';
import type {
  SubagentTaskCard,
  SubagentRole,
  CapabilityMode,
} from './subagent-types';

/**
 * SchedulingStrategy — 调度策略接口（预留，本 Round 第一版仅 FIFO）。
 *
 * 第一版不实现任何策略，仅 FIFO。
 * 未来扩展点：PriorityStrategy / AffinityStrategy。
 */
export interface SchedulingStrategy {
  readonly name: string;
  /** 从队列中选择下一个要执行的任务（FIFO 实现返回队首） */
  pick(queue: SubagentTaskCard[]): SubagentTaskCard | undefined;
}

/**
 * FifoSchedulingStrategy — FIFO 策略实现（唯一实现，本 Round）。
 */
export class FifoSchedulingStrategy implements SchedulingStrategy {
  readonly name = 'fifo';
  pick(queue: SubagentTaskCard[]): SubagentTaskCard | undefined {
    return queue.shift();
  }
}

/**
 * SubagentScheduler — 子代理调度器
 *
 * 依据 本 Round：第一版必须实现。
 * 依据 本 Round：仅 FIFO 调度，priority/affinity 推迟。
 * 依据 禁令 21：调度器只看 capabilityMode，不看 role。
 *
 * 职责：
 *  1. 接收任务提交（submit）
 *  2. 递归守卫检查（RecursionGuard.check）
 *  3. 死锁检测（DeadlockDetector.assertNoCycle）
 *  4. 并发控制（ConcurrencyController.acquire）
 *  5. 创建 SubagentInstance 并启动
 *  6. 维护任务表（taskId → SubagentInstance）
 *  7. 提供 await/cancel/getStatus/snapshot 查询接口
 *
 * 不职责：
 *  - 不实现任务优先级排序（本 Round 推迟）
 *  - 不实现 stuck detection（本 Round 推迟，仅 timeout）
 *  - 不实现 token budget 追踪（本 Round 推迟）
 *  - 不直接执行子代理 run loop（委托给 SubagentInstance）
 */
export interface SubagentScheduler {
  /** 递归守卫配置 */
  readonly recursionGuard: RecursionGuard;
  /** 并发控制器 */
  readonly concurrencyController: ConcurrencyController;
  /** 死锁检测器 */
  readonly deadlockDetector: DeadlockDetector;
  /** 调度策略（第一版仅 FIFO） */
  readonly strategy: SchedulingStrategy;

  /**
   * 提交子代理任务到调度队列。
   *
   * 流程：
   *  1. 生成 taskId
   *  2. 创建 SubagentInstance（状态 pending）
   *  3. 入队等待调度
   *  4. 异步触发调度循环（不阻塞 submit 调用）
   *
   * 注意：submit 不在此处做 RecursionGuard/Deadlock 检查。
   *       检查在 scheduleNext 中做（因为队列可能等待，检查时机应在实际 spawn 前）。
   *       但 maxQueued 检查在此处做（防止无限排队）。
   *
   * @returns 任务 ID
   */
  submit(task: SubagentTaskCard): Promise<string>;

  /**
   * 取消尚未完成的子代理任务。
   *
   * @returns true 表示成功取消（状态从 pending/running 转为 failed），
   *          false 表示任务已完成或不存在
   */
  cancel(taskId: string): Promise<boolean>;

  /**
   * 查询子代理实例状态。
   */
  getStatus(taskId: string): SubagentInstance['status'] | undefined;

  /**
   * 等待子代理任务完成（带超时）。
   *
   * @throws 若 taskId 不存在
   * @throws 若等待超时（不取消任务，仅拒绝 await 的 Promise）
   */
  await(taskId: string, timeoutMs?: number): Promise<SubagentResult>;

  /**
   * 获取当前调度队列快照。
   */
  snapshot(): SchedulerSnapshot;
}

export interface SchedulerSnapshot {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  maxConcurrent: number;
  currentConcurrent: number;
  currentQueued: number;
}
```

#### 3.5.2 默认实现

```ts
// packages/agent-subagent/src/scheduler.ts（实现部分）

import { createId } from '@crish/agent-context';
import { CrishError } from '@crish/shared-types';
import {
  DEFAULT_RECURSION_GUARD,
  checkRecursionGuard,
  extractRecursionContext,
  type RecursionCheckResult,
} from './recursion-guard';
import {
  createConcurrencyController,
  type ConcurrencyController,
} from './concurrency-controller';
import {
  createDeadlockDetector,
  type DeadlockDetector,
} from './deadlock-detector';
import { DefaultSubagentInstance, type SubagentResult } from './instance';
import type { SubagentTaskCard } from './subagent-types';
import type { ToolExecutionContext } from '@crish/shared-types';

export class DefaultSubagentScheduler implements SubagentScheduler {
  private readonly queue: SubagentTaskCard[] = [];
  private readonly instances = new Map<string, DefaultSubagentInstance>();
  private scheduling = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly context: ToolExecutionContext,
    override readonly recursionGuard: RecursionGuard = DEFAULT_RECURSION_GUARD,
    override readonly concurrencyController: ConcurrencyController = createConcurrencyController(
      recursionGuard
    ),
    override readonly deadlockDetector: DeadlockDetector = createDeadlockDetector(),
    override readonly strategy: SchedulingStrategy = new FifoSchedulingStrategy()
  ) {}

  async submit(task: SubagentTaskCard): Promise<string> {
    const taskId = createId('subagent-task');
    // maxQueued 检查（防止无限排队）
    if (this.queue.length >= this.concurrencyController.maxQueued) {
      throw new CrishError(
        `Sub-agent queue full (maxQueued=${this.concurrencyController.maxQueued}).`,
        'subagent.queue_full',
        'permanent',
        false,
        { taskId, queueLength: this.queue.length }
      );
    }
    const instance = new DefaultSubagentInstance(
      taskId,
      task,
      this.runtime,
      this.context,
      this.recursionGuard,
      this.concurrencyController,
      this.deadlockDetector
    );
    this.instances.set(taskId, instance);
    this.queue.push(task);
    void this.scheduleNext();
    return taskId;
  }

  async cancel(taskId: string): Promise<boolean> {
    const instance = this.instances.get(taskId);
    if (!instance) return false;
    if (instance.status === 'completed' || instance.status === 'failed')
      return false;
    await instance.cancel();
    return true;
  }

  getStatus(taskId: string): SubagentInstance['status'] | undefined {
    return this.instances.get(taskId)?.status;
  }

  async await(taskId: string, timeoutMs?: number): Promise<SubagentResult> {
    const instance = this.instances.get(taskId);
    if (!instance) {
      throw new CrishError(
        `Sub-agent task ${taskId} not found.`,
        'subagent.not_found',
        'permanent',
        false,
        { taskId }
      );
    }
    return instance.join(timeoutMs);
  }

  snapshot(): SchedulerSnapshot {
    let pending = 0,
      running = 0,
      completed = 0,
      failed = 0;
    for (const inst of this.instances.values()) {
      switch (inst.status) {
        case 'pending':
          pending++;
          break;
        case 'running':
          running++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }
    return {
      pending,
      running,
      completed,
      failed,
      maxConcurrent: this.concurrencyController.maxConcurrent,
      currentConcurrent: this.concurrencyController.currentConcurrent,
      currentQueued: this.concurrencyController.currentQueued,
    };
  }

  /**
   * 调度循环（FIFO）：
   * 1. 从队列取出队首任务
   * 2. 创建 SubagentInstance 并 start
   * 3. start 内部做 RecursionGuard/Deadlock 检查 + ConcurrencyController.acquire
   * 4. 不等待 start 完成，立即尝试调度下一个（并发上限由 ConcurrencyController 控制）
   */
  private async scheduleNext(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.queue.length > 0) {
        const task = this.strategy.pick(this.queue);
        if (!task) break;
        const instance = this.findInstanceByTask(task);
        if (!instance) continue;
        // 不 await：start 内部会异步获取槽位并执行
        void instance.start().catch(() => {
          /* 错误已记录在 instance.status */
        });
      }
    } finally {
      this.scheduling = false;
    }
  }

  private findInstanceByTask(
    task: SubagentTaskCard
  ): DefaultSubagentInstance | undefined {
    for (const inst of this.instances.values()) {
      if (inst.task === task) return inst;
    }
    return undefined;
  }
}

/**
 * 工厂函数。
 */
export function createSubagentScheduler(
  runtime: AgentRuntime,
  context: ToolExecutionContext,
  guard: RecursionGuard = DEFAULT_RECURSION_GUARD
): SubagentScheduler {
  return new DefaultSubagentScheduler(runtime, context, guard);
}
```

#### 3.5.3 关键实现逻辑

```ts
// 关键实现要点：

/**
 * 1. FIFO 调度（本 Round）：
 *    FifoSchedulingStrategy.pick 返回 queue.shift()（队首）。
 *    不实现优先级排序，不引入优先级队列。
 *
 * 2. 调度循环不阻塞：
 *    scheduleNext 中 instance.start() 不 await，立即尝试下一个。
 *    并发上限由 ConcurrencyController.acquire 内部的 AsyncSemaphore 控制：
 *      - 若有空槽，立即获取
 *      - 若无空槽，acquire 阻塞（排队等待）
 *    队列中的下一个任务会等到当前任务 release 槽位后被调度。
 *
 * 3. 调度检查时机（§3.4.2 要点 3）：
 *    RecursionGuard.check + DeadlockDetector.assertNoCycle 在 instance.start() 内做，
 *    而非在 submit() 内做。原因：
 *      - 队列可能等待，检查应在实际 spawn 前
 *      - 避免在 submit 时就拒绝（用户体验差，应给排队机会）
 *    但 maxQueued 检查在 submit 时做（防止无限排队，OOM 防护）。
 *
 * 4. 不看 role（禁令 21）：
 *    调度逻辑完全不读 task.role 字段。
 *    capabilityMode 在 SubagentInstance 内用于权限控制（read-only/read-write/execute/all）。
 *
 * 5. 不实现 stuck detection（本 Round）：
 *    仅通过 SubagentInstance.timeoutMs + AbortController 实现 timeout。
 *    stuck detection 接口预留（SubagentWatchdog.stuckDetection 留空）。
 *
 * 6. 不实现 token budget（本 Round）：
 *    RecursionGuard.totalTokenBudget 字段存在但默认 0，不参与调度逻辑。
 */
```

### 3.6 SubagentInstance 完整接口 + 实现（4 状态机）

> 依据 本 Round（必须实现）、本 Round（4 状态：pending/running/completed/failed，禁止 paused/resuming）。

#### 3.6.1 接口签名

```ts
// packages/agent-subagent/src/instance.ts

import type { CrishError, AgentEvent, JsonObject } from '@crish/shared-types';
import type { AgentRuntime } from '@crish/agent-core';
import type { ToolExecutionContext } from '@crish/shared-types';
import type { RecursionGuard, RecursionCheckContext } from './recursion-guard';
import type { ConcurrencyController } from './concurrency-controller';
import type { DeadlockDetector } from './deadlock-detector';
import type {
  SubagentTaskCard,
  SubagentProgressEvent,
  SubagentRunStats,
  SubagentRole,
  CapabilityMode,
} from './subagent-types';

/**
 * SubagentState — 子代理状态机（4 状态，本 Round）。
 *
 * 禁止的状态（本 Round 推迟）：
 *  - paused：暂停状态（context snapshot 复杂，推迟）
 *  - resuming：恢复中状态（同上）
 *
 * 合法转换：
 *  - pending → running（start 成功获取槽位后）
 *  - pending → failed（start 前被 cancel，或 RecursionGuard/Deadlock 检查失败）
 *  - running → completed（子代理 run loop 正常结束）
 *  - running → failed（子代理 run loop 抛错，或 timeout，或 cancel）
 *
 * 非法转换（抛错）：
 *  - completed → 任何（终态）
 *  - failed → 任何（终态）
 */
export type SubagentState = 'pending' | 'running' | 'completed' | 'failed';

/**
 * SubagentInstance — 子代理生命周期管理
 *
 * 依据 本 Round：第一版必须实现。
 * 依据 本 Round：4 状态机，timeout 检测通过 AbortController。
 *
 * 职责：
 *  1. 状态机管理（pending → running → completed/failed）
 *  2. timeout 检测（AbortController + timeoutMs）
 *  3. 取消机制（AbortController.abort）
 *  4. 进度事件收集（保留现有 SubagentProgressEvent 设计）
 *  5. 子代理 run loop 执行（委托给 AgentRuntime.run）
 *
 * 不职责：
 *  - 不实现 stuck detection（本 Round 推迟）
 *  - 不实现 pause/resume（本 Round 推迟）
 *  - 不实现 token budget 追踪（本 Round 推迟）
 */
export interface SubagentInstance {
  /** 任务 ID */
  readonly taskId: string;
  /** 任务卡片 */
  readonly task: SubagentTaskCard;
  /** 当前状态 */
  readonly status: SubagentState;
  /** 创建时间戳 */
  readonly createdAt: number;
  /** 启动时间戳（进入 running 状态时） */
  readonly startedAt: number | undefined;
  /** 完成时间戳（进入 completed/failed 状态时） */
  readonly finishedAt: number | undefined;
  /** timeout 配置（ms，0 = 不限制） */
  readonly timeoutMs: number;

  /**
   * 启动子代理。
   *
   * 流程：
   *  1. 状态转换：pending → running（若 pending → failed 则直接返回，已 cancel 或检查失败）
   *  2. RecursionGuard.check
   *  3. DeadlockDetector.assertNoCycle
   *  4. ConcurrencyController.acquire（可能阻塞等待槽位）
   *  5. 启动 timeout 计时器（若 timeoutMs > 0）
   *  6. 执行子代理 run loop（AgentRuntime.run）
   *  7. 收集进度事件
   *  8. 状态转换：running → completed/failed
   *  9. 释放槽位（finally）
   *
   * @throws 若状态非 pending（非法转换）
   * @throws 若 RecursionGuard 检查失败（不抛 CrishError，转为 failed 状态）
   * @throws 若 DeadlockDetector 检测到环（抛 CrishError('subagent.deadlock')，转为 failed 状态）
   * @throws 若 ConcurrencyController.acquire 抛错（队列满，转为 failed 状态）
   */
  start(): Promise<void>;

  /**
   * 取消子代理。
   *
   * 仅在 pending/running 状态有效。
   * 调用 AbortController.abort，子代理 run loop 在安全点检查 signal.aborted。
   * 状态转换为 failed（cancel 视为失败的一种）。
   */
  cancel(): Promise<void>;

  /**
   * 等待子代理完成（带超时）。
   *
   * 若子代理已完成，立即返回结果。
   * 若子代理仍在运行，等待完成或超时。
   *
   * 注意：await 超时不取消子代理，仅拒绝 await 的 Promise。
   *       子代理的取消必须显式调用 cancel()。
   *
   * @throws 若 taskId 不存在（scheduler 层已检查）
   * @throws 若 await 超时（错误码 subagent.await_timeout）
   */
  join(timeoutMs?: number): Promise<SubagentResult>;

  /**
   * 获取进度事件时间线（只读副本）。
   */
  getTimeline(): SubagentProgressEvent[];

  /**
   * 获取运行统计（只读）。
   */
  getStats(): SubagentRunStats;
}

/**
 * SubagentResult — 子代理执行结果
 */
export interface SubagentResult {
  taskId: string;
  status: SubagentState;
  output?: JsonObject;
  error?: CrishError;
  stats: SubagentRunStats;
  timeline: SubagentProgressEvent[];
  finalText: string;
  completionSummary: string;
}
```

#### 3.6.2 默认实现

```ts
// packages/agent-subagent/src/instance.ts（实现部分）

import {
  CrishError,
  type AgentEvent,
  type AgentMessage,
  type JsonObject,
} from '@crish/shared-types';
import { createId, nowIso } from '@crish/agent-context';
import {
  checkRecursionGuard,
  extractRecursionContext,
  type RecursionCheckResult,
} from './recursion-guard';
import type { ConcurrencyController } from './concurrency-controller';
import type { DeadlockDetector } from './deadlock-detector';
import type {
  SubagentTaskCard,
  SubagentProgressEvent,
  SubagentRunStats,
  SubagentRole,
  CapabilityMode,
} from './subagent-types';
import type { AgentRuntime } from '@crish/agent-core';
import type { ToolExecutionContext } from '@crish/shared-types';

const VALID_TRANSITIONS: Record<
  SubagentState,
  Partial<Record<string, SubagentState>>
> = {
  pending: { start: 'running', fail: 'failed', cancel: 'failed' },
  running: { complete: 'completed', fail: 'failed', cancel: 'failed' },
  completed: {},
  failed: {},
};

export class DefaultSubagentInstance implements SubagentInstance {
  private _status: SubagentState = 'pending';
  private _startedAt: number | undefined;
  private _finishedAt: number | undefined;
  private readonly _timeline: SubagentProgressEvent[] = [];
  private _stats: SubagentRunStats = { toolUses: 0, turns: 0, events: {} };
  private _result: SubagentResult | undefined;
  private readonly _abortController = new AbortController();
  private _timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private _completionResolve: ((result: SubagentResult) => void) | undefined;
  private _completionReject: ((error: CrishError) => void) | undefined;
  private readonly _completionPromise: Promise<SubagentResult>;
  private _releaseSlot: (() => void) | undefined;

  constructor(
    public readonly taskId: string,
    public readonly task: SubagentTaskCard,
    private readonly runtime: AgentRuntime,
    private readonly context: ToolExecutionContext,
    private readonly recursionGuard: RecursionGuard,
    private readonly concurrencyController: ConcurrencyController,
    private readonly deadlockDetector: DeadlockDetector
  ) {
    this._completionPromise = new Promise<SubagentResult>((resolve, reject) => {
      this._completionResolve = resolve;
      this._completionReject = reject;
    });
  }

  get status(): SubagentState {
    return this._status;
  }
  get createdAt(): number {
    return this.task.createdAt;
  }
  get startedAt(): number | undefined {
    return this._startedAt;
  }
  get finishedAt(): number | undefined {
    return this._finishedAt;
  }
  get timeoutMs(): number {
    return this.task.timeoutMs ?? 0;
  }

  async start(): Promise<void> {
    // 状态转换：pending → running
    if (!this.transition('start')) {
      throw new CrishError(
        `Cannot start sub-agent ${this.taskId}: current state is ${this._status} (expected pending).`,
        'subagent.invalid_state',
        'permanent',
        false,
        { taskId: this.taskId, currentState: this._status }
      );
    }

    // 递归守卫检查
    const recursionContext = extractRecursionContext(
      this.context,
      this.concurrencyController.siblingCounter,
      this.concurrencyController.concurrentCounter
    );
    const checkResult = checkRecursionGuard(
      this.recursionGuard,
      recursionContext
    );
    if (!checkResult.ok) {
      // 转为 failed 状态（不抛 CrishError，记录错误）
      this.transition('fail');
      this._finish({
        taskId: this.taskId,
        status: 'failed',
        error: new CrishError(
          `Sub-agent creation denied: ${checkResult.reason}.`,
          `subagent.${checkResult.reason}`,
          'permanent',
          false,
          { limit: checkResult.limit, actual: checkResult.actual }
        ),
        stats: this._stats,
        timeline: [...this._timeline],
        finalText: '',
        completionSummary: `Denied: ${checkResult.reason}`,
      });
      return;
    }

    // 死锁检测
    try {
      this.deadlockDetector.assertNoCycle(
        recursionContext.ancestorSessionIds,
        this.taskId
      );
    } catch (error) {
      this.transition('fail');
      this._finish({
        taskId: this.taskId,
        status: 'failed',
        error: error as CrishError,
        stats: this._stats,
        timeline: [...this._timeline],
        finalText: '',
        completionSummary: 'Denied: deadlock detected',
      });
      return;
    }

    // 并发槽位获取
    try {
      this._releaseSlot = await this.concurrencyController.acquire(
        recursionContext.parentSessionId
      );
    } catch (error) {
      this.transition('fail');
      this._finish({
        taskId: this.taskId,
        status: 'failed',
        error: new CrishError(
          `Concurrency acquire failed: ${(error as Error).message}`,
          'subagent.concurrency_acquire_failed',
          'transient',
          true,
          { taskId: this.taskId }
        ),
        stats: this._stats,
        timeline: [...this._timeline],
        finalText: '',
        completionSummary: 'Denied: concurrency acquire failed',
      });
      return;
    }

    this._startedAt = Date.now();
    await this.emitProgress({
      status: 'running',
      summary: 'sub-agent started',
    });

    // 启动 timeout 计时器
    if (this.timeoutMs > 0) {
      this._timeoutTimer = setTimeout(() => {
        this.handleTimeout();
      }, this.timeoutMs);
      this._timeoutTimer.unref?.();
    }

    // 执行子代理 run loop
    try {
      const result = await this.executeRunLoop();
      this.transition('complete');
      this._finish(result);
    } catch (error) {
      this.transition('fail');
      this._finish({
        taskId: this.taskId,
        status: 'failed',
        error:
          error instanceof CrishError
            ? error
            : new CrishError(
                (error as Error).message,
                'subagent.execution_failed',
                'transient',
                true,
                { taskId: this.taskId }
              ),
        stats: this._stats,
        timeline: [...this._timeline],
        finalText: '',
        completionSummary: `Failed: ${(error as Error).message}`,
      });
    } finally {
      this.clearTimeoutTimer();
      this._releaseSlot?.();
    }
  }

  async cancel(): Promise<void> {
    if (this._status !== 'pending' && this._status !== 'running') return;
    this.transition('cancel');
    this._abortController.abort();
    this.clearTimeoutTimer();
    this._releaseSlot?.();
    this._finish({
      taskId: this.taskId,
      status: 'failed',
      error: new CrishError(
        `Sub-agent ${this.taskId} cancelled.`,
        'subagent.cancelled',
        'permanent',
        false,
        { taskId: this.taskId }
      ),
      stats: this._stats,
      timeline: [...this._timeline],
      finalText: '',
      completionSummary: 'Cancelled',
    });
  }

  async join(timeoutMs?: number): Promise<SubagentResult> {
    if (this._result) return this._result;
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return this._completionPromise;
    }
    // 带超时的 await
    return Promise.race([
      this._completionPromise,
      new Promise<SubagentResult>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new CrishError(
              `Await sub-agent ${this.taskId} timed out after ${timeoutMs}ms.`,
              'subagent.await_timeout',
              'transient',
              true,
              { taskId: this.taskId, timeoutMs }
            )
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  getTimeline(): SubagentProgressEvent[] {
    return [...this._timeline];
  }

  getStats(): SubagentRunStats {
    return { ...this._stats, events: { ...this._stats.events } };
  }

  // ─── 私有方法 ──────────────────────────────────────────

  private transition(event: string): boolean {
    const allowed = VALID_TRANSITIONS[this._status];
    const next = allowed[event];
    if (!next) return false;
    this._status = next;
    if (next === 'completed' || next === 'failed') {
      this._finishedAt = Date.now();
    }
    return true;
  }

  private async executeRunLoop(): Promise<SubagentResult> {
    // 委托给 AgentRuntime.run（保留现有 subagents.ts 的 run loop 逻辑）
    // 此处为骨架，实际实现复用现有 observeSubagentEvent / emitProgress / stats 收集
    // 详见 §5.1 从 Round 5 骨架到完整的迁移
    const iterator = this.runtime.run(this.task.taskCard);
    let messages: AgentMessage[] = [];
    while (true) {
      if (this._abortController.signal.aborted) {
        throw new CrishError(
          `Sub-agent ${this.taskId} aborted.`,
          'subagent.cancelled',
          'permanent',
          false,
          { taskId: this.taskId }
        );
      }
      const next = await iterator.next();
      if (next.done) {
        messages = next.value;
        break;
      }
      this.observeEvent(next.value);
    }
    const finalText = this.extractFinalText(messages);
    return {
      taskId: this.taskId,
      status: 'completed',
      stats: this._stats,
      timeline: [...this._timeline],
      finalText,
      completionSummary: `${this.task.description} completed.`,
    };
  }

  private observeEvent(event: AgentEvent): void {
    this._stats.events[event.type] = (this._stats.events[event.type] ?? 0) + 1;
    if (event.type === 'tool-start') this._stats.toolUses += 1;
    if (event.type === 'turn-start') this._stats.turns += 1;
    // 保留现有 observeSubagentEvent 的进度事件触发逻辑
  }

  private async emitProgress(
    partial: Omit<
      SubagentProgressEvent,
      | 'id'
      | 'createdAt'
      | 'stats'
      | 'parentSessionId'
      | 'parentToolCallId'
      | 'subagentId'
      | 'description'
      | 'mode'
    >
  ): Promise<void> {
    const event: SubagentProgressEvent = {
      id: createId('subevent'),
      createdAt: nowIso(),
      stats: { ...this._stats },
      parentSessionId: this.context.sessionId,
      parentToolCallId: this.context.toolCallId,
      subagentId: this.taskId,
      description: this.task.description,
      mode: this.task.mode,
      ...partial,
    };
    this._timeline.push(event);
    this.context.emit({ json: { subagent: event } });
    await this.task.onProgress?.(event);
  }

  private handleTimeout(): void {
    this._abortController.abort();
    // run loop 会在下次安全点检查 signal.aborted 并抛错
  }

  private clearTimeoutTimer(): void {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
  }

  private _finish(result: SubagentResult): void {
    this._result = result;
    this._completionResolve?.(result);
  }

  private extractFinalText(messages: AgentMessage[]): string {
    const assistant = messages.findLast((m) => m.role === 'assistant');
    if (!assistant) return '';
    return assistant.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
  }
}
```

#### 3.6.3 关键实现逻辑

```ts
// 关键实现要点：

/**
 * 1. 4 状态机（本 Round）：
 *    VALID_TRANSITIONS 仅定义 4 状态：
 *      pending → running → completed/failed
 *    禁止 paused/resuming（本 Round 推迟）。
 *    非法转换（终态→任何）返回 false，调用方决定如何处理。
 *
 * 2. timeout 检测（本 Round 仅 timeout，无 stuck detection）：
 *    setTimeout + AbortController.abort。
 *    run loop 在每次迭代检查 signal.aborted（安全点）。
 *    timeout 触发后转为 failed 状态。
 *    stuck detection 接口预留（不实现 60s 无进展判定，本 Round 推迟理由）。
 *
 * 3. 取消机制：
 *    AbortController.abort() 触发，与 timeout 共用同一 signal。
 *    cancel 是同步操作（abort 立即返回），run loop 在下次迭代检查。
 *    cancel 转为 failed 状态（cancel 视为失败的一种，不单独设 cancelled 状态）。
 *    注意：这与 daemon 现有 SubagentLifecycleState.cancelled 不同。
 *    daemon 的 cancelled/orphaned 是 daemon 特有扩展状态（§2.4 要点 6）。
 *
 * 4. 进度事件收集（保留现有设计）：
 *    SubagentProgressEvent 结构与现有 subagents.ts 完全一致。
 *    emitProgress 保留现有 context.emit + onProgress 回调。
 *    timeline 数组在 _finish 时复制给 result。
 *
 * 5. join 与 cancel 分离：
 *    join 超时不取消子代理，仅拒绝 await 的 Promise。
 *    子代理取消必须显式调用 cancel()。
 *    设计理由：多个 awaiter 可能等待同一子代理，一个 awaiter 超时不应影响其他。
 *
 * 6. releaseSlot 幂等性：
 *    finally 中调用 this._releaseSlot?.()，可选链防止未赋值时抛错。
 *    cancel 中也调用（cancel 可能发生在 acquire 之后、run loop 之前）。
 *    重复调用由 ConcurrencyController 内部 release 幂等性保证。
 */
```

### 3.7 SubagentState 状态机图

> 依据 本 Round 简化为 4 状态：pending / running / completed / failed。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480" font-family="Segoe UI, sans-serif" font-size="13">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#333"/>
    </marker>
  </defs>

  <!-- 标题 -->
  <text x="360" y="24" text-anchor="middle" font-size="16" font-weight="bold">SubagentInstance 状态机（4 状态，依据 本 Round）</text>

  <!-- pending 状态 -->
  <rect x="40" y="180" width="140" height="60" rx="8" fill="#e3f2fd" stroke="#1976d2" stroke-width="2"/>
  <text x="110" y="208" text-anchor="middle" font-weight="bold">pending</text>
  <text x="110" y="228" text-anchor="middle" font-size="11">初始状态</text>

  <!-- running 状态 -->
  <rect x="290" y="180" width="140" height="60" rx="8" fill="#fff3e0" stroke="#f57c00" stroke-width="2"/>
  <text x="360" y="208" text-anchor="middle" font-weight="bold">running</text>
  <text x="360" y="228" text-anchor="middle" font-size="11">执行中</text>

  <!-- completed 状态 -->
  <rect x="540" y="80" width="140" height="60" rx="8" fill="#e8f5e9" stroke="#388e3c" stroke-width="2"/>
  <text x="610" y="108" text-anchor="middle" font-weight="bold">completed</text>
  <text x="610" y="128" text-anchor="middle" font-size="11">终态</text>

  <!-- failed 状态 -->
  <rect x="540" y="280" width="140" height="60" rx="8" fill="#ffebee" stroke="#d32f2f" stroke-width="2"/>
  <text x="610" y="308" text-anchor="middle" font-weight="bold">failed</text>
  <text x="610" y="328" text-anchor="middle" font-size="11">终态</text>

  <!-- 转换箭头 -->
  <!-- pending → running (start) -->
  <line x1="180" y1="210" x2="290" y2="210" stroke="#333" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="235" y="200" text-anchor="middle" font-size="11">start()</text>

  <!-- pending → failed (cancel before start / guard fail) -->
  <path d="M 110 240 Q 110 330 540 330" fill="none" stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
  <text x="300" y="370" text-anchor="middle" font-size="11" fill="#d32f2f">cancel() / guard 检查失败</text>

  <!-- running → completed -->
  <path d="M 430 200 Q 485 160 540 130" fill="none" stroke="#388e3c" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="485" y="160" text-anchor="middle" font-size="11">run loop 正常结束</text>

  <!-- running → failed (timeout) -->
  <path d="M 430 230 Q 485 270 540 300" fill="none" stroke="#d32f2f" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="485" y="280" text-anchor="middle" font-size="11" fill="#d32f2f">timeout</text>

  <!-- running → failed (error) -->
  <path d="M 430 240 Q 485 285 540 305" fill="none" stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
  <text x="485" y="270" text-anchor="middle" font-size="11" fill="#d32f2f">run loop 抛错</text>

  <!-- running → failed (cancel) -->
  <path d="M 360 240 Q 360 320 540 320" fill="none" stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="4 2" marker-end="url(#arrow)"/>
  <text x="450" y="345" text-anchor="middle" font-size="11" fill="#d32f2f">cancel()</text>

  <!-- 禁止状态说明 -->
  <rect x="40" y="400" width="640" height="60" rx="6" fill="#fafafa" stroke="#bdbdbd" stroke-width="1"/>
  <text x="60" y="420" font-size="11" font-weight="bold">禁止的状态转换（本 Round 推迟）：</text>
  <text x="60" y="438" font-size="11">- paused / resuming 状态不实现（context snapshot 复杂，推迟）</text>
  <text x="60" y="454" font-size="11">- 终态（completed/failed）不可转换到任何状态</text>
</svg>
```

---

## 4. ControlBus 扩展设计（request-response 语义）

> 依据 禁令 20（禁止新建 SubagentCommunicationBus，子代理通信通过扩展 ControlBus 实现）。

### 4.1 现有 ControlBus 资产分析

现有 `agent-core/src/control/control-bus.ts` 已实现：

| 层  | 现有能力                                                              | 子代理通信对应（禁令 20）                   |
| --- | --------------------------------------------------------------------- | ------------------------------------------- |
| L1  | `request()` / `requestSteer()` / `requestSoftInject()` — 入队控制意图 | send（点对点）：父→子消息注入               |
| L2  | `drainAsAction()` — drain 聚合为单一动作 + AgentEvent 流订阅          | subscribe（订阅）：子代理事件流             |
| L3  | **未显式实现** — 现有 `request()` 是单向入队，不返回 Promise          | request-response：需新增 correlationId 语义 |

**关键发现**：Round 5 设计文档 §3.3.3 描述 ControlBus 已有 L3 request-response，但实际代码 `control-bus.ts` 的 `request()` 方法是 **void 返回值的入队操作**（返回 `RunControlIntent` 而非 `Promise<AgentEvent>`）。本 Round 需要真正实现 L3。

### 4.2 L3 request-response 扩展设计

#### 4.2.1 新增类型

```ts
// packages/agent-core/src/control/types.ts（扩展）

/**
 * CorrelationId — L3 request-response 关联标识。
 *
 * 用于子代理通信场景：
 *  - 父 spawn 子代理后，通过 request 发送消息并等待子代理响应
 *  - 子代理通过 respond 发送响应，ControlBus 根据 correlationId 匹配
 *
 * 不破坏现有 L1/L2：
 *  - 现有 request() 是单向入队（void 返回 RunControlIntent）
 *  - 新增 requestResponse() 是双向（返回 Promise<AgentEvent>）
 *  - 两者并存，不互相影响
 */
export type CorrelationId = string;

/**
 * L3 request-response 信封（包装现有 RunControlIntent）。
 */
export interface RequestResponseEnvelope {
  /** 关联 ID（自动生成或调用方指定） */
  correlationId: CorrelationId;
  /** 原始控制意图（复用现有 RunControlIntent） */
  intent: RunControlIntent;
  /** 请求超时（ms，默认 30000） */
  timeoutMs?: number;
}

/**
 * L3 响应事件（扩展 AgentEvent，增加 correlationId 字段）。
 *
 * 通过 ControlBus.respond() 发送，requestResponse() 的 Promise 据此 resolve。
 */
export interface ResponseEvent {
  /** 关联 ID（与 request 的 correlationId 匹配） */
  correlationId: CorrelationId;
  /** 响应负载 */
  payload: AgentEvent;
}
```

#### 4.2.2 ControlBus 扩展方法

```ts
// packages/agent-core/src/control/control-bus.ts（扩展，不重写现有方法）

import type {
  CorrelationId,
  RequestResponseEnvelope,
  ResponseEvent,
} from './types';
import type { AgentEvent, AgentMessage } from '@crish/shared-types';
import { CrishError } from '@crish/shared-types';

let correlationSeq = 0;

function nextCorrelationId(): CorrelationId {
  correlationSeq += 1;
  return `corr-${Date.now().toString(36)}-${correlationSeq.toString(36)}`;
}

export class ControlBus {
  // ... 现有 L1/L2 代码保持不变 ...

  // ─── L3：request-response 语义（禁令 20 新增） ──────────────

  private readonly pendingRequests = new Map<
    CorrelationId,
    {
      resolve: (event: AgentEvent) => void;
      reject: (error: CrishError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * L3：发送请求并等待响应（带超时）。
   *
   * 流程：
   *  1. 生成 correlationId（或使用调用方指定的）
   *  2. 创建 pending Promise
   *  3. 通过现有 L1 request() 入队控制意图（复用 L1 wire）
   *  4. 启动 timeout 计时器
   *  5. 返回 Promise，等待 respond() 调用
   *
   * 与 L1 的关系：
   *  - L3 复用 L1 的入队机制（request() 入队 RunControlIntent）
   *  - L3 在 L1 之上增加"等待响应"语义
   *  - L1 单向入队不阻塞，L3 阻塞等待响应
   *
   * @param input 控制意图输入（复用 L1 的 RunControlIntentInput）
   * @param timeoutMs 超时（默认 30000ms，0 = 不超时）
   * @param correlationId 关联 ID（可选，默认自动生成）
   */
  requestResponse(
    input: RunControlIntentInput,
    timeoutMs: number = 30_000,
    correlationId?: CorrelationId
  ): Promise<AgentEvent> {
    const corrId = correlationId ?? nextCorrelationId();
    const intent = this.request(input); // 复用 L1 入队

    return new Promise<AgentEvent>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(corrId);
              reject(
                new CrishError(
                  `ControlBus request ${corrId} timed out after ${timeoutMs}ms.`,
                  'control.request_timeout',
                  'transient',
                  true,
                  { correlationId: corrId, timeoutMs }
                )
              );
            }, timeoutMs)
          : undefined;

      if (timer) timer.unref?.();
      this.pendingRequests.set(corrId, { resolve, reject, timer });
    });
  }

  /**
   * L3：发送响应（由子代理调用）。
   *
   * 流程：
   *  1. 根据 correlationId 查找 pending request
   *  2. 若找到，resolve 其 Promise 并清除 timer
   *  3. 若未找到，忽略（响应可能已超时或重复）
   *
   * @param correlationId 关联 ID（与 request 的 correlationId 匹配）
   * @param payload 响应负载
   */
  respond(correlationId: CorrelationId, payload: AgentEvent): void {
    const pending = this.pendingRequests.get(correlationId);
    if (!pending) return; // 已超时或重复，忽略
    this.pendingRequests.delete(correlationId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  /**
   * L3：取消所有 pending 请求（ControlBus 销毁时调用）。
   */
  cancelAllPendingRequests(): void {
    for (const [corrId, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new CrishError(
          `ControlBus request ${corrId} cancelled (bus shutting down).`,
          'control.request_cancelled',
          'permanent',
          false,
          { correlationId: corrId }
        )
      );
    }
    this.pendingRequests.clear();
  }

  /**
   * L3：获取 pending 请求数（监控用）。
   */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }
}
```

### 4.3 关键设计约束

1. **不新建 SubagentCommunicationBus**（禁令 20）：L3 在现有 ControlBus 类上扩展，不新建类
2. **不破坏 L1/L2**（禁令 20）：现有 `request()` / `requestSteer()` / `drainAsAction()` 签名与行为不变
3. **L3 复用 L1 wire**：`requestResponse()` 内部调用 `this.request()` 入队，不重复实现入队逻辑
4. **correlationId 自动生成**：默认自动生成，调用方可指定（用于跨进程传递，如 daemon 通过 IPC 透传）
5. **timeout 默认 30s**：避免无限等待，子代理应在 30s 内响应（可通过参数覆盖）
6. **响应幂等性**：重复 `respond()` 同一 correlationId 时，第二次忽略（已 resolve 或已超时）
7. **不引入消息持久化**：pending 请求在内存中，ControlBus 销毁时全部 reject（不持久化到磁盘）

### 4.4 与 daemon 集成的契约

daemon 的 `subagent-handlers.ts` 中 `handleSendToSubagent` 当前通过 `runtimeFactory.sendToSubagent` 单向发送。本 Round 扩展为：

```ts
// daemon 端使用 L3 的契约（伪代码）
const response = await controlBus.requestResponse(
  { kind: 'steer', message: userMessage, reason: 'send-to-subagent' },
  30_000,
  daemonCorrelationFields.correlationId // 透传 IPC 层的 correlationId
);
// 响应通过 controlBus.respond() 由子代理侧调用
```

---

## 5. 与现有代码的集成

### 5.1 从 Round 5 骨架到完整的迁移

#### 5.1.1 迁移映射表

| R5 骨架（接口/占位）                                            | R9 完整（实现）                                                        | 迁移动作                                                                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recursion-guard.ts`（接口骨架 + DEFAULT_RECURSION_GUARD）      | `recursion-guard.ts`（完整实现） + `concurrency-controller.ts`（拆分） | 替换接口骨架为完整实现，拆分 ConcurrencyController 到独立文件                                                                                               |
| `recursion-guard.ts` 内 DeadlockDetector 接口骨架               | `deadlock-detector.ts`（独立文件）                                     | 移出 DeadlockDetector 到独立文件，recursion-guard.ts re-export                                                                                              |
| `scheduler.ts`（SubagentScheduler + SubagentInstance 接口骨架） | `scheduler.ts`（完整实现） + `instance.ts`（拆分 SubagentInstance）    | 替换接口骨架为完整实现，拆分 SubagentInstance 到独立文件                                                                                                    |
| `subagents.ts`（560 行，含全局变量 + 内联守卫）                 | `subagents.ts`（保留入口，委托给新组件）                               | 移除全局变量 currentActiveSubagents + subagentSemaphore，移除内联守卫逻辑，改为调用 RecursionGuard/ConcurrencyController/DeadlockDetector/SubagentScheduler |

#### 5.1.2 subagents.ts 改造清单

现有 `subagents.ts` 的以下片段将被改造（行号对照原文件）：

| 现有代码位置                                                                     | 改造动作                                                                                           | 理由                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| L41-52：`SubagentDepthGuard` 接口 + `DEFAULT_SUBAGENT_DEPTH_GUARD`（maxDepth=2） | 移除（已由 R5 迁入 `recursion-guard.ts` 并更新为 maxDepth=3）                                      | 避免重复定义，统一权威来源 |
| L54-56：`subagentSemaphore` + `currentActiveSubagents` 全局变量                  | 移除（封装到 ConcurrencyController）                                                               | 消除模块级全局变量反模式   |
| L58-60：`resetSubagentActiveCount()`                                             | 移除（不再需要，无全局变量）                                                                       | 全局变量消除后无需重置     |
| L68-71：`SubagentDepthContext`                                                   | 保留（兼容现有 metadata.subagentDepth 数字字段）                                                   | 共存阶段，旧字段保留       |
| L142-379：`createSubagentTool` 内联守卫逻辑（L175-202 递归检查 + 并发检查）      | 替换为调用 SubagentScheduler                                                                       | 委托给调度器               |
| L170-377：`execute` 函数内的执行循环                                             | 保留核心逻辑（emitProgress / observeSubagentEvent / stats 收集），改为创建 SubagentInstance 并委托 | 复用成熟逻辑，仅重构控制流 |
| L426-451：`observeSubagentEvent`                                                 | 保留（移入 SubagentInstance.observeEvent）                                                         | 成熟逻辑                   |
| L480-501：`resolveMaybe` + `createAsyncMutex`                                    | 保留（移入 instance.ts 或保留在 subagents.ts）                                                     | 成熟工具函数               |
| L504-521：`resolveSubagentProjectProgress`                                       | 保留                                                                                               | 成熟逻辑                   |
| L552-560：`extractDepthContext`                                                  | 替换为 `extractRecursionContext`（扩展为 ancestorSessionIds 数组）                                 | 支持死锁检测               |

#### 5.1.3 共存阶段策略（禁令 23）

依据 禁令 23 三阶段迁移策略，本 Round 为迁移阶段：

1. **共存**（R5 已完成）：`subagents.ts` 全局变量与新 `RecursionGuard`/`ConcurrencyController` 并存
2. **迁移**（本 Round）：`subagents.ts` 改为调用新组件，但保留 `createSubagentTool` 入口签名不变，daemon 等消费者无需改动
3. **删除**（R12）：移除 `subagents.ts` 的旧全局变量与内联守卫（本 Round 已完成迁移阶段，删除阶段在 R12）

**关键约束**：`createSubagentTool` 的对外签名（`SubagentToolOptions` / 返回 `AgentTool`）不变，确保 daemon 的 `subagent-runtime.ts` 可平滑切换。

### 5.2 Daemon subagent-runtime 更新

#### 5.2.1 subagent-runtime.ts 改造

现有 `agent-daemon/src/subagent-runtime.ts` 的问题：

| 问题           | 现有代码                                    | 改造为                                                                                         |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 并发上限不一致 | `AsyncSemaphore(32)`（L86）                 | 通过 ConcurrencyController 注入，默认 maxConcurrent=6（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD） |
| 深度上限不一致 | `DEFAULT_MAX_SUBAGENT_DEPTH = 8`（L15）     | 通过 RecursionGuard 注入，默认 maxDepth=3（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD）             |
| 硬封顶         | `SUBAGENT_DEPTH_HARD_CAP = 32`（L17）       | 保留作为安全封顶（防止配置错误导致无限递归）                                                   |
| 内联守卫逻辑   | `resolveMaxSubagentDepth` + 手动 depth 检查 | 委托给 SubagentScheduler + RecursionGuard                                                      |

**改造后的 subagent-runtime.ts 契约**：

```ts
// packages/agent-daemon/src/subagent-runtime.ts（改造后骨架）

import {
  createSubagentScheduler,
  DEFAULT_RECURSION_GUARD,
} from '@crish/agent-subagent';
import type { SubagentScheduler, RecursionGuard } from '@crish/agent-subagent';

export interface DaemonSubagentToolOptions {
  parentRunId: string;
  parentSessionId: string;
  cwd: string;
  // 保留 depth 字段用于兼容（共存阶段），但实际由 recursionGuard 控制
  depth: number;
  maxDepth?: number; // 共存阶段保留，R12 移除
  permissionMode: 'ask' | 'auto' | 'full-access' | 'plan' | 'unattended';
  maxTurns?: number;
  parentRunAbortSignal?: AbortSignal;
  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle>;
  cancelRun(runId: string, reason?: string): boolean;
  // [NEW] 注入调度器（可选，默认创建）
  scheduler?: SubagentScheduler;
  // [NEW] 注入递归守卫（可选，默认 DEFAULT_RECURSION_GUARD）
  recursionGuard?: RecursionGuard;
}

export function createDaemonSubagentTool(
  options: DaemonSubagentToolOptions
): AgentTool {
  // 共存阶段：保留 resolveMaxSubagentDepth 用于日志，但实际由 recursionGuard.maxDepth 控制
  const scheduler =
    options.scheduler ??
    createSubagentScheduler(
      runtime,
      context,
      options.recursionGuard ?? DEFAULT_RECURSION_GUARD
    );
  // ... 委托给 scheduler.submit / scheduler.await ...
}
```

#### 5.2.2 subagent-lifecycle.ts 改造

现有 `agent-daemon/src/subagent-lifecycle.ts` 的 6 状态机（starting/running/completed/failed/cancelled/orphaned）保留，因为：

1. **cancelled/orphaned 是 daemon 特有**（§2.4 要点 6）：进程级清理需要 cancelled（用户主动取消）与 orphaned（父进程崩溃后的孤儿清理）
2. **agent-subagent 的 4 状态机不违反 本 Round**：本 Round 约束的是 `agent-subagent` 包的 `SubagentInstance`，daemon 作为消费者可以扩展状态

改造点：

```ts
// packages/agent-daemon/src/subagent-lifecycle.ts（改造后）

import type { SubagentState } from '@crish/agent-subagent';

/**
 * Daemon 特有的子代理生命周期状态。
 *
 * 与 agent-subagent.SubagentState（4 状态）的关系：
 *  - starting ≈ pending（agent-subagent 包的初始状态）
 *  - running = running
 *  - completed = completed
 *  - failed = failed（agent-subagent 的 failed 包含 cancelled 场景）
 *  - cancelled：daemon 特有，用户主动取消（对应 agent-subagent 的 failed + cancel 原因）
 *  - orphaned：daemon 特有，父进程崩溃后的孤儿状态（agent-subagent 不涉及）
 *
 * 本 Round 约束的是 agent-subagent.SubagentState（4 状态），
 * daemon 作为消费者扩展状态不违反 本 Round。
 */
export type SubagentLifecycleState =
  | 'starting' // ≈ agent-subagent.pending
  | 'running' // = agent-subagent.running
  | 'completed' // = agent-subagent.completed
  | 'failed' // = agent-subagent.failed
  | 'cancelled' // daemon 特有（agent-subagent.failed + cancel 原因）
  | 'orphaned'; // daemon 特有（父进程崩溃）

/**
 * 将 agent-subagent.SubagentState 映射到 daemon SubagentLifecycleState。
 *
 * 用于 SubagentInstance 状态变化时同步 daemon 注册表。
 */
export function mapSubagentStateToDaemon(
  state: SubagentState,
  cancelReason?: string
): SubagentLifecycleState {
  switch (state) {
    case 'pending':
      return 'starting';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      // failed + cancel 原因 → cancelled
      // 其他 failed 原因 → failed
      return cancelReason === 'cancelled' ? 'cancelled' : 'failed';
  }
}
```

#### 5.2.3 subagent-handlers.ts 改造

现有 `subagent-handlers.ts` 使用字符串错误码 `"SUBAGENT_SEND_ERROR"`。改造为 CrishError：

```ts
// packages/agent-daemon/src/handlers/subagent-handlers.ts（改造后）

import { CrishError } from '@crish/shared-types';

export function handleSendToSubagent(
  ws: WebSocket,
  msg: SendToSubagentMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: SubagentTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(
    response: T,
    msg: DaemonCorrelationFields
  ) => T
): void {
  try {
    const accepted = runtimeFactory.sendToSubagent(
      msg.subagentRunId,
      msg.message
    );
    transport.send(
      ws,
      correlateResponse(
        {
          type: 'subagent-message-sent',
          subagentRunId: msg.subagentRunId,
          accepted,
        },
        msg
      )
    );
  } catch (error) {
    // 共存阶段：字符串错误码与 CrishError 并存
    // 迁移阶段（本 Round）：优先使用 CrishError，字符串错误码作为 fallback
    const crishError =
      error instanceof CrishError
        ? error
        : new CrishError(
            (error as Error).message,
            'subagent.send_failed',
            'transient',
            true,
            { subagentRunId: msg.subagentRunId }
          );
    transport.sendError(
      ws,
      crishError.code, // 共存阶段：code 仍是 string
      crishError.message,
      undefined,
      msg
    );
  }
}
```

---

## 6. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，每轮结束前必须通过以下 8 项检查。

### 6.1 基线建立

Round 9 开始时，Agent 9-E 执行以下命令记录基线：

```bash
# 记录 TSC 错误基线
npx tsc --noEmit 2>&1 | tee round-09-tsc-baseline.json

# 记录依赖图基线
npm run lint:depcruise 2>&1 | tee round-09-depcruise-baseline.json
```

### 6.2 验证检查项

| 序号 | 检查项           | 命令                        | 通过标准                                                              | 责任 Agent |
| ---- | ---------------- | --------------------------- | --------------------------------------------------------------------- | ---------- |
| 1    | TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ `round-09-tsc-baseline.json`（不恶化，禁令 26）              | 9-E        |
| 2    | Rust 编译        | `cargo check --workspace`   | 0 errors                                                              | 9-E        |
| 3    | 单元测试（TS）   | `npx vitest run`            | 全部通过（含新增 4 类测试）                                           | 9-E        |
| 4    | 单元测试（Rust） | `cargo test --workspace`    | 全部通过                                                              | 9-E        |
| 5    | 循环依赖         | `npm run lint:depcruise`    | 0 violations（特别验证 `agent-subagent` → `plugin-sdk` 新边方向正确） | 9-E        |
| 6    | 构建             | `npx turbo run build`       | `agent-subagent` / `agent-core` / `agent-daemon` 全部成功             | 9-E        |
| 7    | Lint             | `npm run lint`              | 0 errors                                                              | 9-E        |
| 8    | Store 类型       | `npm run check:store-types` | 通过                                                                  | 9-E        |

### 6.3 Round 9 专项验证

除上述 8 项标准检查外，Round 9 须额外验证：

| 序号 | 专项检查                      | 验证方法                                               | 通过标准                                                                                                                    |
| ---- | ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| S1   | RecursionGuard 三维度检查     | 检查 `recursion-guard.ts` 的 `checkRecursionGuard`     | 含 maxDepth/maxSiblings/maxConcurrent 三维度检查，早退顺序正确                                                              |
| S2   | RecursionGuard 默认值         | 检查 `DEFAULT_RECURSION_GUARD`                         | maxDepth=3, maxSiblings=5, maxConcurrent=6, totalTokenBudget=0, totalTimeoutMs=0（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD）   |
| S3   | ConcurrencyController 封装    | 检查 `concurrency-controller.ts`                       | 无模块级全局变量，封装 AsyncSemaphore + 兄弟计数 Map                                                                        |
| S4   | DeadlockDetector 轻量级       | 检查 `deadlock-detector.ts`                            | O(depth) 线性扫描，无 setInterval/setTimeout 后台扫描（本 Round）                                                           |
| S5   | DeadlockDetector 错误码       | 检查 `createDeadlockError`                             | 错误码 `subagent.deadlock`，category=permanent，retryable=false                                                             |
| S6   | SubagentScheduler FIFO        | 检查 `scheduler.ts` 的 `FifoSchedulingStrategy`        | 仅 FIFO，无 priority/affinity 实现（本 Round）                                                                              |
| S7   | SubagentInstance 4 状态机     | 检查 `instance.ts` 的 `VALID_TRANSITIONS`              | 仅 pending/running/completed/failed，无 paused/resuming（本 Round）                                                         |
| S8   | ControlBus L3 扩展            | 检查 `control-bus.ts` 的 `requestResponse` / `respond` | 新增方法不破坏现有 L1/L2，correlationId 语义正确                                                                            |
| S9   | 禁止 SubagentCommunicationBus | grep `SubagentCommunicationBus` in `packages/`         | 无此类（禁令 20）                                                                                                           |
| S10  | role 为标签                   | 检查调度逻辑是否读取 `task.role`                       | 调度逻辑不读 role，仅 capabilityMode 控制权限（禁令 21）                                                                    |
| S11  | 子代理发现统一到插件系统      | 检查 `discovery.ts`                                    | 使用 PluginManifest.agents + BuiltinDiscoverySource，无独立 ProjectFileDiscoverySource/UserFileDiscoverySource（禁令 22）   |
| S12  | daemon 并发统一               | 检查 `subagent-runtime.ts`                             | 不再使用 `AsyncSemaphore(32)`，通过 ConcurrencyController 注入默认 maxConcurrent=6（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD） |
| S13  | 共存阶段保留旧入口            | 检查 `subagents.ts` 的 `createSubagentTool` 签名       | 对外签名不变，内部委托给新组件（禁令 23）                                                                                   |
| S14  | 错误码迁移共存                | 检查 `subagent-handlers.ts`                            | 字符串错误码与 CrishError 并存（禁令 23 迁移阶段）                                                                          |

### 6.4 TSC 错误管理

依据 guardrails 禁令 26：

- **禁止承诺"每轮 TSC 清零"**。本 Round 引入新文件与 ControlBus 扩展可能产生临时类型错误，这是正常的。
- **本 Round 验证标准**：Round 9 结束时 TSC 错误数 ≤ `round-09-tsc-baseline.json` 记录的基线。
- **不恶化判定**：如果基线为 N，Round 9 结束时错误数 ≤ N 即通过。
- **最终清零目标**：仅在 Round 11 要求 TSC 错误 < 50。

---

## 7. 交付物

### 7.1 包交付物

| 交付物                                    | 路径                                     | 文件数                                  | 责任 Agent    |
| ----------------------------------------- | ---------------------------------------- | --------------------------------------- | ------------- |
| `@crish/agent-subagent` 完整包            | `packages/agent-subagent/src/`           | 5 新建 + 4 改造 + 1 barrel 更新         | 9-A, 9-B, 9-C |
| `@crish/agent-core` ControlBus 扩展       | `packages/agent-core/src/control/`       | 2 文件改造（control-bus.ts + types.ts） | 9-D           |
| `@crish/agent-daemon` subagent 三件套更新 | `packages/agent-daemon/src/`             | 3 文件改造                              | 9-D           |
| 测试套件                                  | `packages/agent-subagent/src/__tests__/` | 4 测试文件                              | 9-E           |

### 7.2 接口签名交付物

| 接口                                                          | 包             | 签名                                                                                                                                                                                                                                                  | 状态                  |
| ------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `RecursionGuard`                                              | agent-subagent | `interface RecursionGuard { maxDepth, maxSiblings, maxConcurrent, totalTokenBudget, totalTimeoutMs }` + `DEFAULT_RECURSION_GUARD` + `checkRecursionGuard()` + `extractRecursionContext()`                                                             | R5 骨架 → R9 完整实现 |
| `ConcurrencyController`                                       | agent-subagent | `interface ConcurrencyController { maxConcurrent, maxSiblings, maxQueued, currentConcurrent, currentQueued, siblingCounter, concurrentCounter, acquire(parentSessionId), snapshot() }`                                                                | [NEW] R9 完整实现     |
| `DeadlockDetector`                                            | agent-subagent | `interface DeadlockDetector { detectCycle(ancestorSessionIds, targetSessionId), assertNoCycle(ancestorSessionIds, targetSessionId) }` + `createDeadlockError()`                                                                                       | R5 骨架 → R9 完整实现 |
| `SubagentScheduler`                                           | agent-subagent | `interface SubagentScheduler { recursionGuard, concurrencyController, deadlockDetector, strategy, submit(task), cancel(taskId), getStatus(taskId), await(taskId, timeoutMs), snapshot() }` + `FifoSchedulingStrategy` + `SchedulingStrategy` 接口预留 | R5 骨架 → R9 完整实现 |
| `SubagentInstance`                                            | agent-subagent | `interface SubagentInstance { taskId, task, status, createdAt, startedAt, finishedAt, timeoutMs, start(), cancel(), join(timeoutMs), getTimeline(), getStats() }` + `SubagentState = pending\|running\|completed\|failed` + `SubagentResult`          | R5 骨架 → R9 完整实现 |
| `ControlBus.requestResponse`                                  | agent-core     | `requestResponse(input, timeoutMs, correlationId): Promise<AgentEvent>` + `respond(correlationId, payload)` + `cancelAllPendingRequests()` + `pendingRequestCount`                                                                                    | [NEW] L3 扩展         |
| `CorrelationId` / `RequestResponseEnvelope` / `ResponseEvent` | agent-core     | 类型定义                                                                                                                                                                                                                                              | [NEW] L3 类型         |
| `SubagentRole` / `CapabilityMode`                             | agent-subagent | `SubagentRole = researcher\|implementer\|reviewer\|debugger\|planner` + `CapabilityMode = read-only\|read-write\|execute\|all`                                                                                                                        | [NEW] 禁令 21         |
| `DaemonSubagentToolOptions`                                   | agent-daemon   | 增加 `scheduler?: SubagentScheduler` + `recursionGuard?: RecursionGuard`                                                                                                                                                                              | 改造                  |
| `mapSubagentStateToDaemon`                                    | agent-daemon   | `function mapSubagentStateToDaemon(state, cancelReason?)`                                                                                                                                                                                             | [NEW] 状态映射        |

### 7.3 验证报告交付物

| 报告                               | 内容                                                    | 责任 Agent |
| ---------------------------------- | ------------------------------------------------------- | ---------- |
| `round-09-tsc-baseline.json`       | Round 9 开始时的 TSC 错误基线                           | 9-E        |
| `round-09-tsc-final.json`          | Round 9 结束时的 TSC 错误                               | 9-E        |
| `round-09-depcruise-report.json`   | 循环依赖检查结果（含 agent-subagent → plugin-sdk 新边） | 9-E        |
| `round-09-turbo-build-report.json` | 构建结果                                                | 9-E        |
| `round-09-verification-report.md`  | 验证报告（8 项标准检查 + 14 项专项检查）                | 9-E        |

### 7.4 错误码交付物

本 Round 新增的 CrishError 错误码（供 `03-ERROR-MIGRATION.md` 录入）：

| 错误码                                | category  | retryable | 场景                               |
| ------------------------------------- | --------- | --------- | ---------------------------------- |
| `subagent.deadlock`                   | permanent | false     | DeadlockDetector 检测到环          |
| `subagent.max-depth-exceeded`         | permanent | false     | RecursionGuard maxDepth 超限       |
| `subagent.max-siblings-exceeded`      | permanent | false     | RecursionGuard maxSiblings 超限    |
| `subagent.max-concurrent-exceeded`    | permanent | false     | RecursionGuard maxConcurrent 超限  |
| `subagent.queue_full`                 | permanent | false     | ConcurrencyController 队列满       |
| `subagent.concurrency_acquire_failed` | transient | true      | ConcurrencyController.acquire 抛错 |
| `subagent.invalid_state`              | permanent | false     | SubagentInstance 非法状态转换      |
| `subagent.cancelled`                  | permanent | false     | 子代理被取消                       |
| `subagent.await_timeout`              | transient | true      | join 超时（不取消子代理）          |
| `subagent.execution_failed`           | transient | true      | 子代理 run loop 抛错               |
| `subagent.not_found`                  | permanent | false     | taskId 不存在                      |
| `subagent.send_failed`                | transient | true      | daemon 发送消息失败                |
| `control.request_timeout`             | transient | true      | ControlBus L3 请求超时             |
| `control.request_cancelled`           | permanent | false     | ControlBus L3 请求被取消           |

### 7.5 文档更新交付物

| 文档                      | 更新内容                                      | 依据          |
| ------------------------- | --------------------------------------------- | ------------- |
| `02-FILE-MAPPING.md` §9.2 | 确认 `agent-subagent` → `plugin-sdk` 新依赖边 | 本 Round §1.2 |
| `03-ERROR-MIGRATION.md`   | 录入 14 个新错误码                            | 本 Round §7.4 |
| `01-OVERVIEW.md` §3.2     | 确认 Layer 5（agent-subagent 完整）创建完成   | 本 Round      |

---

## 8. 风险与缓解

| 风险                                 | 影响                              | 缓解措施                                                   | 责任人   |
| ------------------------------------ | --------------------------------- | ---------------------------------------------------------- | -------- |
| 全局变量封装引入回归                 | subagents.ts 改造后行为变化       | 共存阶段保留 createSubagentTool 入口签名 + 端到端测试覆盖  | 9-A, 9-E |
| ControlBus L3 破坏现有 L1/L2         | 现有 drainAsAction 行为变化       | L3 新增方法不修改现有方法 + control-bus.test.ts 回归       | 9-D, 9-E |
| daemon 并发从 32 降到 6 导致性能回退 | 高并发场景阻塞                    | 通过 RecursionGuard 参数可配置（默认 6，可上调）+ 性能测试 | 9-D      |
| DeadlockDetector 误报                | 线性祖先链被误判为环              | 线性扫描逻辑 + 正反例测试                                  | 9-B, 9-E |
| SubagentInstance 状态机非法转换      | cancel 已完成任务抛错             | transition 返回 false 而非抛错 + 状态机测试                | 9-C, 9-E |
| 子代理发现机制未对齐 PluginManifest  | discovery.ts 与 R8 实际接口不一致 | R8 已交付 PluginManifest.agents，本 Round 核对实际类型     | 9-C      |
| TSC 错误恶化                         | 新增类型引入临时错误              | 每步迁移后运行 tsc --noEmit 对比基线（禁令 26）            | 9-E      |

---

## 9. Round 9 与后续 Round 的衔接

### 9.1 Round 9 完成后的下一步

依据 `01-OVERVIEW.md` §4.2：

```
R8 ──→ R9（本 Round）──→ R10（Rust 对齐）──→ R11（前端韧性）──→ R12（CI 与文档）
```

### 9.2 Round 9 → Round 10（Rust 侧对齐）

Round 10 将：

1. 在 `crates/conex-types` 中实现 `CrishErrorPayload` Rust impl
2. 对齐本 Round 新增的 14 个错误码到 Rust `CoreError` variant
3. Tauri command 错误传播格式对齐

本 Round 交付的：

- 14 个新错误码（§7.4）作为 R10 的输入
- SubagentState 4 状态机作为 R10 Rust 端状态机对齐参考
- ControlBus L3 correlationId 语义作为 R10 IPC 对齐参考

### 9.3 不迁移到本 Round 的组件

| 组件                                | 推迟理由（本 Round）            | 预留方式                                   | 实现 Round |
| ----------------------------------- | ------------------------------- | ------------------------------------------ | ---------- |
| `SubagentWatchdog.stuckDetection`   | 60s 无进展判定标准不明确        | 仅 timeout 检测，stuck detection 留空接口  | 未规划     |
| `TokenBudgetTracker`                | 跨子代理聚合 token 使用复杂度高 | RecursionGuard.totalTokenBudget 字段默认 0 | 未规划     |
| `priority` / `affinity` 调度策略    | 子代理任务通常同优先级          | SchedulingStrategy 接口预留，仅 FIFO 实现  | 未规划     |
| `isolationMode: worktree / process` | 进程间通信复杂度高              | 仅支持 none，通过 capabilityMode 控制权限  | 未规划     |
| `SubagentState.paused / resuming`   | pause 后 context snapshot 复杂  | 4 状态机，无 paused/resuming               | 未规划     |

---

## 10. 附录：Agent 编排时序

```
Round 9 开始
  │
  ├── Agent 9-E：记录 TSC 基线（round-09-tsc-baseline.json）
  │
  ├── [并行] Agent 9-A：实现 RecursionGuard + ConcurrencyController（封装现有全局变量）
  │
  ├── [并行] Agent 9-B：实现 DeadlockDetector（轻量级 spawn 时检查）
  │   ↑ 9-A 与 9-B 文件集不相交（recursion-guard.ts/concurrency-controller.ts vs deadlock-detector.ts）
  │   ↑ 且 9-B 仅依赖 9-A 的接口定义（recursion-guard.ts 的 RecursionCheckContext.ancestorSessionIds）
  │   ↑ 实际可并行：9-B 先定义 detectCycle 接口，9-A 在 recursion-guard.ts 中 re-export
  │
  ├── [串行·依赖 9-A + 9-B] Agent 9-C：实现 SubagentScheduler + SubagentInstance
  │   ↑ 依赖 9-A 的 RecursionGuard/ConcurrencyController
  │   ↑ 依赖 9-B 的 DeadlockDetector
  │
  ├── [串行·依赖 9-C] Agent 9-D：ControlBus L3 扩展 + Daemon 三件套更新
  │   ↑ ControlBus 扩展可与 9-C 并行（文件集不相交：agent-core/control vs agent-subagent）
  │   ↑ 但 daemon 三件套依赖 9-C 的 SubagentScheduler
  │   ↑ 拆分为：ControlBus 扩展（与 9-C 并行）+ daemon 更新（依赖 9-C）
  │
  ├── [串行·依赖 9-A~9-D] Agent 9-E：
  │   ├── 编写 4 类测试
  │   ├── 运行验证门禁（8 项标准 + 14 项专项）
  │   └── 生成验证报告
  │
  └── Round 9 结束 → 生成交付物清单 → Round 10（Rust 对齐）启动
```

**并行性说明**（依据 guardrails 01-OVERVIEW.md §5.1）：

- Agent 9-A 与 9-B 可并行：文件集不相交（recursion-guard.ts/concurrency-controller.ts vs deadlock-detector.ts），仅接口依赖（9-B 使用 9-A 的 ancestorSessionIds 字段类型，但 9-A 已在 R5 定义此字段类型）
- Agent 9-C 必须串行：依赖 9-A + 9-B 的完整实现
- Agent 9-D 的 ControlBus 扩展部分可与 9-C 并行（文件集不相交：agent-core/control vs agent-subagent）
- Agent 9-D 的 daemon 更新部分必须串行：依赖 9-C 的 SubagentScheduler
- Agent 9-E 必须串行：依赖 9-A~9-D 全部完成

**协调次数**：

- 9-A：1 次（与 9-C 约定 check/acquire 契约）
- 9-B：1 次（与 9-C 约定 detectCycle 调用时机）
- 9-C：2 次（依赖 9-A + 9-B）
- 9-D：2 次（依赖 9-C + 与 9-E 约定测试用例）
- 9-E：2 次（依赖 9-A~9-D 全部产出 + Round 8 基线）

全部满足 guardrails 禁令 28"协调次数 ≤ 2 次"约束。
