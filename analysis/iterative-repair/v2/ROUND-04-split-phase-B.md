# Round 4：拆分 Phase-B（middle 层）

> **本文件是 Round 4 的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Agent 任务、文件迁移、依赖接线引用本文件时，必须以本文件的 Agent 分配与验证门禁为准。
>
> **前置文档**：
>
> - `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 包拆分边界、禁令 13-19 插件 SDK 约束、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量
> - `v2/01-OVERVIEW.md` §3 依赖图、§3.2 拓扑层级、§4.1 轮次总览
> - `v2/02-FILE-MAPPING.md` §2 文件映射表、§3 冲突解决、§9 依赖方向验证
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 7（§3.2）：ToolMiddleware 仅保留 3-Hook（`beforeExecute` + `onResult` / `onError`），禁止 6 阶段洋葱 Hook
> - 禁令 10：stream-parse / request-build 归入 `agent-model`，禁止独立 `agent-stream` 包
> - 禁令 10：`plugin-mcp` 并入 `agent-mcp`（增加 `registerPluginServer` 入口），禁止独立包
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为共存阶段（`agent-runtime` 保留 re-export）
> - 禁令 26：TSC 错误数 ≤ 该轮基线（不恶化），不承诺清零
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 4 处于拓扑 Layer 3（middle 层），在 Round 3（leaf 层）完成后执行。middle 层包依赖 leaf 层包，被 top 层（Round 5 的 `agent-core`）依赖。

```
Layer 0: shared-types, shared-utils, decision-engine          （已存在 / R1 增强）
Layer 1: @crish/logger, @crish/telemetry                       （R2 创建）
Layer 2: agent-context, agent-permissions, agent-mcp[骨架]     （R3 创建 — leaf 层）
Layer 3: agent-tools, agent-model, agent-mcp[完整]             （R4 创建 — middle 层）← 本 Round
Layer 4: agent-core                                            （R5 创建 — top 层）
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2）：

- Round 3 必须先于 Round 4：`agent-tools` / `agent-model` 依赖 `agent-context`（leaf 层）
- Round 4 必须先于 Round 5：`agent-core` 依赖 `agent-tools` / `agent-model` / `agent-context`
- 循环依赖必须保持为 0（dependency-cruiser 强制）

**Layer 2 → Layer 3 演进说明**：
`agent-mcp` 在 Round 3 作为 leaf 层骨架创建（仅依赖 `shared-types` + `shared-utils`）。Round 4 完整化后，因增加 `registerPluginServer` 入口需要 `agent-tools` 的工具注册类型，`agent-mcp` 从 Layer 2 演进到 Layer 3。此演进不违反拓扑约束，因为 `agent-tools` 在 Round 4 同步创建，且 `agent-tools` 不反向依赖 `agent-mcp`。

> **依赖方向修正说明**（依据 `02-FILE-MAPPING.md` §9.3 文档一致性要求）：
> `02-FILE-MAPPING.md` §9.2 中 `agent-tools` 依赖 `agent-mcp` 的记录，经 Round 4 实际代码验证后修正为：`agent-mcp` 依赖 `agent-tools`（用于 `registerPluginServer` 的工具注册类型）。`agent-tools` 不依赖 `agent-mcp`。此修正与 `01-OVERVIEW.md` §3 mermaid 中 `AT --> AM2`（AM2 依赖 AT）一致。Round 4 执行后须同步更新 `02-FILE-MAPPING.md` §9.2。

### 1.2 目标包

| 目标包                       | 拓扑层    | 职责                                                                                                                                                                                                                                                                | 创建 Agent | 文件数（约） |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| `@crish/agent-tools`         | Layer 3   | 工具系统：ToolDefinition / ToolMiddleware / local-tools / tool-discovery / tool-registry / background-command / lsp-tools / rich-read / resource-uri / workspace-mutation-coordinator / script-wait-policy / skills / git-versioning / tool-output-*                | 4-A, 4-B   | ~40          |
| `@crish/agent-model`         | Layer 3   | 模型 / Provider 系统：provider/ 全部子目录 / provider-gateway/ / provider-transport/ / provider-stream-contract/ / stream / *-stream-parse / *-request-build / model-routing / model-catalog / pricing-engine / token-ledger / media / preview-queue / openai-retry | 4-C, 4-D   | ~95          |
| `@crish/agent-mcp`（完整化） | Layer 2→3 | MCP 生命周期：McpLifecycleManager / McpServerController / `registerPluginServer` 入口                                                                                                                                                                               | 4-E        | ~7           |

**包间依赖关系**（本 Round 建立的新边以 `[NEW]` 标注）：

| 包                    | 依赖（→ 指向被依赖方）                                                               | 拓扑层    |
| --------------------- | ------------------------------------------------------------------------------------ | --------- |
| `agent-tools`         | `shared-types`, `shared-utils`, `agent-context`, `@crish/logger`                     | Layer 3   |
| `agent-model`         | `shared-types`, `shared-utils`, `agent-context`, `@crish/logger`, `@crish/telemetry` | Layer 3   |
| `agent-mcp`（完整化） | `shared-types`, `shared-utils`, `agent-tools` `[NEW]`                                | Layer 2→3 |

> 依据 `02-FILE-MAPPING.md` §9.2 与 `01-OVERVIEW.md` §3 mermaid。`agent-mcp` 增加 `agent-tools` 依赖为本 Round 的关键演进。

### 1.3 交付物清单

| 交付物                         | 路径                                              | 说明                                             |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------ |
| `@crish/agent-tools` 包        | `packages/agent-tools/`                           | package.json + tsconfig.json + src/ 目录结构     |
| `@crish/agent-model` 包        | `packages/agent-model/`                           | package.json + tsconfig.json + src/ 目录结构     |
| `@crish/agent-mcp` 完整化      | `packages/agent-mcp/`                             | 增加 `registerPluginServer` + `agent-tools` 依赖 |
| `agent-runtime` re-export shim | `packages/agent-runtime/src/index.ts`             | 显式命名导出 + deprecation warning（禁令 24）    |
| 测试文件迁移                   | 各新包 `src/__tests__/`                           | 随被测文件迁移                                   |
| 验证报告                       | 本文件 §6                                         | depcruise + turbo build + TSC 基线对比           |
| `02-FILE-MAPPING.md` §9.2 更新 | `analysis/iterative-repair/v2/02-FILE-MAPPING.md` | 修正 `agent-mcp` 依赖方向（禁令 31）             |

---

## 2. Agent 任务详细设计

### 2.1 Agent 4-A：agent-tools 核心

| 维度     | 说明                                                   |
| -------- | ------------------------------------------------------ |
| **类型** | 创建型 + 迁移型                                        |
| **目标** | 创建 `@crish/agent-tools` 包骨架，迁移核心工具系统文件 |
| **前置** | Round 3 已创建 `agent-context`（leaf 层）              |
| **后续** | Agent 4-B 迁移大文件到本包；Agent 4-E 做依赖接线与验证 |

**输入**：

- `packages/agent-runtime/src/tools/` 目录（4 文件）
- `packages/agent-runtime/src/local-tools/` 目录（16 文件，含 `fs-edit-tools/` 子目录）
- `packages/agent-runtime/src/tool-discovery.ts` + `.test.ts`
- `packages/agent-runtime/src/tool-output-budget.ts` + `.test.ts`
- `packages/agent-runtime/src/tool-output-guard.ts` + `.test.ts`
- `packages/agent-runtime/src/tool-registry.ts`
- `packages/agent-runtime/src/tools.ts` + `.test.ts`

**输出**：

- `packages/agent-tools/package.json`
- `packages/agent-tools/tsconfig.json`
- `packages/agent-tools/tsconfig.build.json`
- `packages/agent-tools/src/index.ts`（barrel）
- `packages/agent-tools/src/tools/` 目录（4 文件）
- `packages/agent-tools/src/local-tools/` 目录（16 文件）
- `packages/agent-tools/src/tool-discovery.ts` 等

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.14、§2.39）：

| 源文件                                                       | 目标路径                                          | 说明                                               |
| ------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------- |
| `agent-runtime/src/tools/index.ts`                           | `agent-tools/src/tools/index.ts`                  | tools barrel                                       |
| `agent-runtime/src/tools/tool-definition.ts`                 | `agent-tools/src/tools/tool-definition.ts`        | RegisteredTool 三层体系（176 行，成熟资产）        |
| `agent-runtime/src/tools/tool-middleware.ts`                 | `agent-tools/src/tools/tool-middleware.ts`        | ToolMiddleware 3-Hook（禁令 7）                    |
| `agent-runtime/src/tools/tool-preset-registry.ts`            | `agent-tools/src/tools/tool-preset-registry.ts`   |                                                    |
| `agent-runtime/src/tools/tool-system.test.ts`                | `agent-tools/src/tools/tool-system.test.ts`       |                                                    |
| `agent-runtime/src/local-tools/index.ts`                     | `agent-tools/src/local-tools/index.ts`            |                                                    |
| `agent-runtime/src/local-tools/fs-read-tools.ts`             | `agent-tools/src/local-tools/fs-read-tools.ts`    |                                                    |
| `agent-runtime/src/local-tools/fs-edit-tools.ts`             | `agent-tools/src/local-tools/fs-edit-tools.ts`    |                                                    |
| `agent-runtime/src/local-tools/fs-edit-tools/*.ts`（6 文件） | `agent-tools/src/local-tools/fs-edit-tools/*.ts`  | apply-edits / edit / index / types / utils / write |
| `agent-runtime/src/local-tools/shell-tools.ts`               | `agent-tools/src/local-tools/shell-tools.ts`      |                                                    |
| `agent-runtime/src/local-tools/search-tools.ts`              | `agent-tools/src/local-tools/search-tools.ts`     |                                                    |
| `agent-runtime/src/local-tools/checkpoint-tools.ts`          | `agent-tools/src/local-tools/checkpoint-tools.ts` |                                                    |
| `agent-runtime/src/local-tools/pre-mutation.ts`              | `agent-tools/src/local-tools/pre-mutation.ts`     |                                                    |
| `agent-runtime/src/local-tools/shared.ts`                    | `agent-tools/src/local-tools/shared.ts`           |                                                    |
| `agent-runtime/src/local-tools/types.ts`                     | `agent-tools/src/local-tools/types.ts`            |                                                    |
| `agent-runtime/src/tool-discovery.ts`                        | `agent-tools/src/tool-discovery.ts`               |                                                    |
| `agent-runtime/src/tool-discovery.test.ts`                   | `agent-tools/src/tool-discovery.test.ts`          |                                                    |
| `agent-runtime/src/tool-output-budget.ts`                    | `agent-tools/src/tool-output-budget.ts`           | 工具输出预算                                       |
| `agent-runtime/src/tool-output-budget.test.ts`               | `agent-tools/src/tool-output-budget.test.ts`      |                                                    |
| `agent-runtime/src/tool-output-guard.ts`                     | `agent-tools/src/tool-output-guard.ts`            | 工具输出守卫                                       |
| `agent-runtime/src/tool-output-guard.test.ts`                | `agent-tools/src/tool-output-guard.test.ts`       |                                                    |
| `agent-runtime/src/tool-registry.ts`                         | `agent-tools/src/tool-registry.ts`                |                                                    |
| `agent-runtime/src/tools.ts`                                 | `agent-tools/src/tools.ts`                        | tools barrel（19K）                                |
| `agent-runtime/src/tools.test.ts`                            | `agent-tools/src/tools.test.ts`                   |                                                    |

**任务量**：28 文件迁移 + 4 配置文件创建 = 32 文件操作，远超 禁令 28 的 5 文件门槛。

**import 路径更新规则**：

- `from '../types'` → `from '@crish/shared-types'`（AgentTool / ToolSource / RuntimePermissionPolicy 等已下沉 shared-types，见 `02-FILE-MAPPING.md` §2.2）
- `from '../session'` → `from '@crish/agent-context'`（createId / nowIso）
- `from '../checkpoint/checkpoint-manager'` → `from '@crish/agent-context'`（CheckpointManager）
- `from '../runtime-components/context-manager'` → 暂保留 `from '../runtime-components/context-manager'`（agent-core 在 Round 5 创建，本 Round 通过 `agent-runtime` re-export 共存，见 §3.1 共存策略）
- `from '@crish/shared-types'` → 保持不变
- `from '@crish/shared-utils'` → 保持不变

**关键设计约束**：

1. **ToolMiddleware 保留 3-Hook**（禁令 7）：`beforeExecute`（防爆网与审批）+ `onResult`（结果与日志）+ `onError`（错误处理）。禁止恢复 6 阶段洋葱 Hook。
2. **RegisteredTool 三层体系保留**：ToolDefinition（第三方最小接口）→ ToolRegistrationOptions（可选高级特性）→ RegisteredTool（运行时工具，176 行）。三层结构不得扁平化。
3. **ToolDefinition 类型来源**：`ToolDefinition` 是 `@crish/shared-types` 中 `SchemaToolDefinition` 的类型别名（见实际代码 `tools/tool-definition.ts` L16）。agent-tools 仅做 re-export，不重新定义。

**验证标准**：

- `packages/agent-tools/` 目录结构完整
- `package.json` 的 `dependencies` 声明正确（见 §3.1）
- 迁移文件数 = 28（含测试文件）
- `agent-runtime` 中被迁移文件保留（共存阶段，guardrails 禁令 23）

**协调点**：0 次（独立完成，不依赖其他 Agent）

---

### 2.2 Agent 4-B：agent-tools 大文件

| 维度     | 说明                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| **类型** | 迁移型                                                                             |
| **目标** | 迁移 agent-tools 中体积较大的文件（background-command / lsp-tools / rich-read 等） |
| **前置** | Agent 4-A 已创建 `agent-tools` 包骨架                                              |
| **后续** | Agent 4-E 做依赖接线与验证                                                         |

**输入**：

- `packages/agent-runtime/src/workspace-mutation-coordinator.ts`（16K）+ `.test.ts`
- `packages/agent-runtime/src/background-command.ts`（27K）+ `.test.ts`
- `packages/agent-runtime/src/script-wait-policy.ts` + `.test.ts`
- `packages/agent-runtime/src/lsp-tools.ts`（24K）+ `.test.ts`
- `packages/agent-runtime/src/rich-read.ts`（30K）+ `.test.ts`
- `packages/agent-runtime/src/resource-uri.ts`（24K）+ `.test.ts`
- `packages/agent-runtime/src/local-tools.ts`（根文件）+ `.test.ts`
- `packages/agent-runtime/src/git-versioning.ts`（根文件）+ `.test.ts`
- `packages/agent-runtime/src/git-versioning/` 目录（5 文件）
- `packages/agent-runtime/src/skills.ts` + `.test.ts`

**输出**：

- `packages/agent-tools/src/workspace-mutation-coordinator.ts` 等
- `packages/agent-tools/src/git-versioning/` 目录
- 更新后的 import 路径

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.1、§2.12）：

| 源文件                                                     | 目标路径                                                 | 大小 | 说明                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---- | ------------------------------------- |
| `agent-runtime/src/workspace-mutation-coordinator.ts`      | `agent-tools/src/workspace-mutation-coordinator.ts`      | 16K  |                                       |
| `agent-runtime/src/workspace-mutation-coordinator.test.ts` | `agent-tools/src/workspace-mutation-coordinator.test.ts` |      |                                       |
| `agent-runtime/src/background-command.ts`                  | `agent-tools/src/background-command.ts`                  | 27K  |                                       |
| `agent-runtime/src/background-command.test.ts`             | `agent-tools/src/background-command.test.ts`             |      |                                       |
| `agent-runtime/src/script-wait-policy.ts`                  | `agent-tools/src/script-wait-policy.ts`                  |      |                                       |
| `agent-runtime/src/script-wait-policy.test.ts`             | `agent-tools/src/script-wait-policy.test.ts`             |      |                                       |
| `agent-runtime/src/lsp-tools.ts`                           | `agent-tools/src/lsp-tools.ts`                           | 24K  |                                       |
| `agent-runtime/src/lsp-tools.test.ts`                      | `agent-tools/src/lsp-tools.test.ts`                      |      |                                       |
| `agent-runtime/src/rich-read.ts`                           | `agent-tools/src/rich-read.ts`                           | 30K  |                                       |
| `agent-runtime/src/rich-read.test.ts`                      | `agent-tools/src/rich-read.test.ts`                      |      |                                       |
| `agent-runtime/src/resource-uri.ts`                        | `agent-tools/src/resource-uri.ts`                        | 24K  |                                       |
| `agent-runtime/src/resource-uri.test.ts`                   | `agent-tools/src/resource-uri.test.ts`                   |      |                                       |
| `agent-runtime/src/local-tools.ts`                         | `agent-tools/src/local-tools.ts`                         |      | 根文件（区别于 local-tools/ 目录）    |
| `agent-runtime/src/local-tools.test.ts`                    | `agent-tools/src/local-tools.test.ts`                    |      |                                       |
| `agent-runtime/src/git-versioning.ts`                      | `agent-tools/src/git-versioning.ts`                      |      | 根文件（区别于 git-versioning/ 目录） |
| `agent-runtime/src/git-versioning.test.ts`                 | `agent-tools/src/git-versioning.test.ts`                 |      |                                       |
| `agent-runtime/src/git-versioning/git-commit-ops.ts`       | `agent-tools/src/git-versioning/git-commit-ops.ts`       |      |                                       |
| `agent-runtime/src/git-versioning/git-patch-ops.ts`        | `agent-tools/src/git-versioning/git-patch-ops.ts`        |      |                                       |
| `agent-runtime/src/git-versioning/git-patch-ops.test.ts`   | `agent-tools/src/git-versioning/git-patch-ops.test.ts`   |      |                                       |
| `agent-runtime/src/git-versioning/git-service.ts`          | `agent-tools/src/git-versioning/git-service.ts`          |      |                                       |
| `agent-runtime/src/git-versioning/git-types.ts`            | `agent-tools/src/git-versioning/git-types.ts`            |      |                                       |
| `agent-runtime/src/skills.ts`                              | `agent-tools/src/skills.ts`                              |      |                                       |
| `agent-runtime/src/skills.test.ts`                         | `agent-tools/src/skills.test.ts`                         |      |                                       |

**任务量**：23 文件迁移，含 5 个 ≥16K 的大文件，远超 禁令 28 门槛。

**import 路径更新规则**：

- `from '../types'` → `from '@crish/shared-types'`
- `from '../session'` → `from '@crish/agent-context'`
- `from '../path-handling/conex-path'` → `from '@crish/shared-utils'`（path-handling 已在 R2 迁入 shared-utils，见 `02-FILE-MAPPING.md` §2.19）
- `from '../checkpoint'` → `from '@crish/agent-context'`
- `from '../tools'` → 包内相对路径（已在 agent-tools 内）
- `from '../local-tools'` → 包内相对路径

**关键设计约束**：

1. **大文件不拆分**：background-command（27K）、rich-read（30K）、lsp-tools（24K）、resource-uri（24K）保持单文件迁移，不拆分为子文件。拆分属于过度设计（禁令 10：满足规模门槛的包已独立，包内文件不再强制拆分）。
2. **根文件与目录文件区分**：`local-tools.ts`（根文件，barrel 入口）与 `local-tools/` 目录（实现）共存于 agent-tools，不合并。`git-versioning.ts`（根文件）与 `git-versioning/` 目录同理。依据 `02-FILE-MAPPING.md` §4 遗漏文件补录说明。

**验证标准**：

- 23 文件成功迁移
- agent-tools/src/ 目录结构完整（含 tools/ + local-tools/ + git-versioning/ 子目录 + 根文件）
- 大文件保持原大小（无内容丢失）

**协调点**：1 次（依赖 Agent 4-A 已创建包骨架与 package.json）

---

### 2.3 Agent 4-C：agent-model Provider 核心

| 维度     | 说明                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| **类型** | 创建型 + 迁移型                                                              |
| **目标** | 创建 `@crish/agent-model` 包骨架，迁移 Provider 核心目录                     |
| **前置** | Round 3 已创建 `agent-context`（leaf 层）                                    |
| **后续** | Agent 4-D 迁移 OpenAI/Anthropic/Gemini + Gateway + Transport；Agent 4-E 验证 |

**输入**：

- `packages/agent-runtime/src/provider/` 目录（含 `__tests__/`、`auth/`、`builtin/`、`cli/`、`engines/`、`spi/` 全部子目录）
- Provider 根文件：`index.ts`、`types.ts`、`factory.ts`、`loader.ts`、`declarative-schema.ts`、`registry-v2.ts`、`provider-gateway-v2.ts`、`faux-provider.ts`、`health-checker.ts`

**输出**：

- `packages/agent-model/package.json`
- `packages/agent-model/tsconfig.json`
- `packages/agent-model/tsconfig.build.json`
- `packages/agent-model/src/index.ts`（barrel）
- `packages/agent-model/src/provider/` 目录（全部子结构）

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.23）：

**provider/ 根文件（9 文件）**：

| 源文件                                              | 目标路径                                          |
| --------------------------------------------------- | ------------------------------------------------- |
| `agent-runtime/src/provider/index.ts`               | `agent-model/src/provider/index.ts`               |
| `agent-runtime/src/provider/types.ts`               | `agent-model/src/provider/types.ts`               |
| `agent-runtime/src/provider/factory.ts`             | `agent-model/src/provider/factory.ts`             |
| `agent-runtime/src/provider/loader.ts`              | `agent-model/src/provider/loader.ts`              |
| `agent-runtime/src/provider/declarative-schema.ts`  | `agent-model/src/provider/declarative-schema.ts`  |
| `agent-runtime/src/provider/registry-v2.ts`         | `agent-model/src/provider/registry-v2.ts`         |
| `agent-runtime/src/provider/provider-gateway-v2.ts` | `agent-model/src/provider/provider-gateway-v2.ts` |
| `agent-runtime/src/provider/faux-provider.ts`       | `agent-model/src/provider/faux-provider.ts`       |
| `agent-runtime/src/provider/health-checker.ts`      | `agent-model/src/provider/health-checker.ts`      |

**provider/**tests**/（12 文件）**：

| 源文件                                                      | 目标路径                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `provider/__tests__/auth.test.ts`                           | `agent-model/src/provider/__tests__/auth.test.ts`                           |
| `provider/__tests__/base-engine.test.ts`                    | `agent-model/src/provider/__tests__/base-engine.test.ts`                    |
| `provider/__tests__/declarative-loader.test.ts`             | `agent-model/src/provider/__tests__/declarative-loader.test.ts`             |
| `provider/__tests__/factory.test.ts`                        | `agent-model/src/provider/__tests__/factory.test.ts`                        |
| `provider/__tests__/registry.test.ts`                       | `agent-model/src/provider/__tests__/registry.test.ts`                       |
| `provider/__tests__/benchmarks/provider-lifecycle.bench.ts` | `agent-model/src/provider/__tests__/benchmarks/provider-lifecycle.bench.ts` |
| `provider/__tests__/e2e/context-length-recovery.test.ts`    | `agent-model/src/provider/__tests__/e2e/context-length-recovery.test.ts`    |
| `provider/__tests__/e2e/exponential-backoff-e2e.test.ts`    | `agent-model/src/provider/__tests__/e2e/exponential-backoff-e2e.test.ts`    |
| `provider/__tests__/e2e/mock-server.ts`                     | `agent-model/src/provider/__tests__/e2e/mock-server.ts`                     |
| `provider/__tests__/e2e/provider-factory.test.ts`           | `agent-model/src/provider/__tests__/e2e/provider-factory.test.ts`           |
| `provider/__tests__/e2e/steering-injection.test.ts`         | `agent-model/src/provider/__tests__/e2e/steering-injection.test.ts`         |
| `provider/__tests__/e2e/stream-parser.test.ts`              | `agent-model/src/provider/__tests__/e2e/stream-parser.test.ts`              |

**provider/auth/（11 文件 + oauth/ 11 文件 = 22 文件）**：

| 源文件                                      | 目标路径                                                    |
| ------------------------------------------- | ----------------------------------------------------------- |
| `provider/auth/auth-method-bridge.ts`       | `agent-model/src/provider/auth/auth-method-bridge.ts`       |
| `provider/auth/base-url-validator.ts`       | `agent-model/src/provider/auth/base-url-validator.ts`       |
| `provider/auth/base-url-validator.test.ts`  | `agent-model/src/provider/auth/base-url-validator.test.ts`  |
| `provider/auth/credential-pool.ts`          | `agent-model/src/provider/auth/credential-pool.ts`          |
| `provider/auth/credential-resolver.ts`      | `agent-model/src/provider/auth/credential-resolver.ts`      |
| `provider/auth/encrypted-file-store.ts`     | `agent-model/src/provider/auth/encrypted-file-store.ts`     |
| `provider/auth/index.ts`                    | `agent-model/src/provider/auth/index.ts`                    |
| `provider/auth/key-rotation.ts`             | `agent-model/src/provider/auth/key-rotation.ts`             |
| `provider/auth/log-sanitizer.ts`            | `agent-model/src/provider/auth/log-sanitizer.ts`            |
| `provider/auth/secret-store.ts`             | `agent-model/src/provider/auth/secret-store.ts`             |
| `provider/auth/types.ts`                    | `agent-model/src/provider/auth/types.ts`                    |
| `provider/auth/oauth/account-store.ts`      | `agent-model/src/provider/auth/oauth/account-store.ts`      |
| `provider/auth/oauth/chatgpt-pool.ts`       | `agent-model/src/provider/auth/oauth/chatgpt-pool.ts`       |
| `provider/auth/oauth/chatgpt-pool.test.ts`  | `agent-model/src/provider/auth/oauth/chatgpt-pool.test.ts`  |
| `provider/auth/oauth/cross-process-lock.ts` | `agent-model/src/provider/auth/oauth/cross-process-lock.ts` |
| `provider/auth/oauth/index.ts`              | `agent-model/src/provider/auth/oauth/index.ts`              |
| `provider/auth/oauth/local-server.ts`       | `agent-model/src/provider/auth/oauth/local-server.ts`       |
| `provider/auth/oauth/oauth-flow.ts`         | `agent-model/src/provider/auth/oauth/oauth-flow.ts`         |
| `provider/auth/oauth/oauth-ui.ts`           | `agent-model/src/provider/auth/oauth/oauth-ui.ts`           |
| `provider/auth/oauth/pkce.ts`               | `agent-model/src/provider/auth/oauth/pkce.ts`               |
| `provider/auth/oauth/state-machine.ts`      | `agent-model/src/provider/auth/oauth/state-machine.ts`      |
| `provider/auth/oauth/token-guardian.ts`     | `agent-model/src/provider/auth/oauth/token-guardian.ts`     |

**provider/builtin/（4 文件）**：

| 源文件                                         | 目标路径                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `provider/builtin/anthropic-provider-class.ts` | `agent-model/src/provider/builtin/anthropic-provider-class.ts` |
| `provider/builtin/gemini-provider-class.ts`    | `agent-model/src/provider/builtin/gemini-provider-class.ts`    |
| `provider/builtin/index.ts`                    | `agent-model/src/provider/builtin/index.ts`                    |
| `provider/builtin/types.ts`                    | `agent-model/src/provider/builtin/types.ts`                    |

**provider/engines/（8 文件）**：

| 源文件                                               | 目标路径                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `provider/engines/base-engine.ts`                    | `agent-model/src/provider/engines/base-engine.ts`                    |
| `provider/engines/index.ts`                          | `agent-model/src/provider/engines/index.ts`                          |
| `provider/engines/openai-compatible-engine.ts`       | `agent-model/src/provider/engines/openai-compatible-engine.ts`       |
| `provider/engines/openai-compatible-engine.test.ts`  | `agent-model/src/provider/engines/openai-compatible-engine.test.ts`  |
| `provider/engines/anthropic-messages-engine.ts`      | `agent-model/src/provider/engines/anthropic-messages-engine.ts`      |
| `provider/engines/anthropic-messages-engine.test.ts` | `agent-model/src/provider/engines/anthropic-messages-engine.test.ts` |
| `provider/engines/ollama-engine.ts`                  | `agent-model/src/provider/engines/ollama-engine.ts`                  |
| `provider/engines/ollama-engine.test.ts`             | `agent-model/src/provider/engines/ollama-engine.test.ts`             |

**provider/cli/（7 文件）**：

| 源文件                              | 目标路径                                            |
| ----------------------------------- | --------------------------------------------------- |
| `provider/cli/index.ts`             | `agent-model/src/provider/cli/index.ts`             |
| `provider/cli/main.ts`              | `agent-model/src/provider/cli/main.ts`              |
| `provider/cli/provider-dev.ts`      | `agent-model/src/provider/cli/provider-dev.ts`      |
| `provider/cli/provider-list.ts`     | `agent-model/src/provider/cli/provider-list.ts`     |
| `provider/cli/provider-test.ts`     | `agent-model/src/provider/cli/provider-test.ts`     |
| `provider/cli/provider-utils.ts`    | `agent-model/src/provider/cli/provider-utils.ts`    |
| `provider/cli/provider-validate.ts` | `agent-model/src/provider/cli/provider-validate.ts` |

**provider/spi/（4 文件）**：

| 源文件                             | 目标路径                                           |
| ---------------------------------- | -------------------------------------------------- |
| `provider/spi/engine-class.ts`     | `agent-model/src/provider/spi/engine-class.ts`     |
| `provider/spi/index.ts`            | `agent-model/src/provider/spi/index.ts`            |
| `provider/spi/provider-class.ts`   | `agent-model/src/provider/spi/provider-class.ts`   |
| `provider/spi/provider-factory.ts` | `agent-model/src/provider/spi/provider-factory.ts` |

**任务量**：9 + 12 + 22 + 4 + 8 + 7 + 4 = 66 文件迁移 + 4 配置文件 = 70 文件操作，远超 禁令 28 门槛。

**import 路径更新规则**：

- `from '../../types'` → `from '@crish/shared-types'`（AgentProvider 等 provider 接口已下沉 shared-types，见 `02-FILE-MAPPING.md` §2.2）
- `from '../../session'` → `from '@crish/agent-context'`
- `from '@crish/shared-types'` → 保持不变
- `from '@crish/shared-utils'` → 保持不变
- 包内相对路径（`./types`、`../engines` 等）→ 保持不变

**关键设计约束**：

1. **stream-parse / request-build 归入 agent-model**（禁令 10）：不创建独立 `agent-stream` 包。stream-parse 与 provider 实现强内聚，独立破坏内聚性。Agent 4-D 负责这些文件的迁移。
2. **provider/ 整体迁移**：含 `__tests__/`、`auth/`（含 `oauth/`）、`builtin/`、`cli/`、`engines/`、`spi/` 全部子目录，不拆分到多个包。依据 `02-FILE-MAPPING.md` §2.23。
3. **Provider 抽象层保留**：SPI（`provider/spi/`）+ Engines（`provider/engines/`）+ Builtin（`provider/builtin/`）三层抽象保留，不扁平化。

**验证标准**：

- `packages/agent-model/` 目录结构完整
- `package.json` 的 `dependencies` 声明正确（见 §3.2）
- provider/ 全部子目录迁移完整（66 文件）
- `agent-runtime` 中被迁移文件保留（共存阶段）

**协调点**：0 次（独立完成）

---

### 2.4 Agent 4-D：agent-model OpenAI/Anthropic/Gemini + Gateway + Transport

| 维度     | 说明                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| **类型** | 迁移型                                                                                            |
| **目标** | 迁移 OpenAI/Anthropic/Gemini provider 文件、Gateway、Transport、Stream Contract、Model Routing 等 |
| **前置** | Agent 4-C 已创建 `agent-model` 包骨架与 provider/ 目录                                            |
| **后续** | Agent 4-E 做依赖接线与验证                                                                        |

**输入**：

- `packages/agent-runtime/src/provider-gateway/` 目录（7 文件）
- `packages/agent-runtime/src/provider-transport/` 目录（6 文件）
- `packages/agent-runtime/src/provider-stream-contract/` 目录（8 文件）
- `packages/agent-runtime/src/provider-openai-*.ts`（7 根文件）
- `packages/agent-runtime/src/openai-*.ts`（3 根文件）
- `packages/agent-runtime/src/provider-anthropic.ts` + `anthropic-*.ts`（3 文件）
- `packages/agent-runtime/src/provider-gemini.ts` + `gemini-*.ts`（3 文件）
- `packages/agent-runtime/src/provider-request-machine.ts`、`provider-cache-hints.ts`、`provider-error-classifier.ts`
- `packages/agent-runtime/src/model-routing/` 目录 + 根文件（7 文件）
- `packages/agent-runtime/src/model-catalog/` 目录（3 文件）
- `packages/agent-runtime/src/pricing-engine.ts`、`token-ledger.ts`
- `packages/agent-runtime/src/media/` 目录（5 文件）
- `packages/agent-runtime/src/preview-queue.ts`
- `packages/agent-runtime/src/provider-stream-contract.ts`（根文件）
- `packages/agent-runtime/src/stream/` 目录（3 文件，仅 index.ts + streaming-tool-executor，thinking-config 归 agent-core）

**输出**：

- `packages/agent-model/src/provider-gateway/` 目录
- `packages/agent-model/src/provider-transport/` 目录
- `packages/agent-model/src/provider-stream-contract/` 目录
- `packages/agent-model/src/provider-openai-*.ts` 等根文件
- `packages/agent-model/src/model-routing/` 目录
- `packages/agent-model/src/model-catalog/` 目录
- `packages/agent-model/src/media/` 目录
- `packages/agent-model/src/stream/` 目录

**文件迁移清单**（引用 `02-FILE-MAPPING.md` §2.1、§2.16、§2.17、§2.18、§2.24、§2.25、§2.26、§2.36）：

**provider-gateway/ 目录（7 文件）**：

| 源文件                                         | 目标路径                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `provider-gateway/index.ts`                    | `agent-model/src/provider-gateway/index.ts`                    |
| `provider-gateway/types.ts`                    | `agent-model/src/provider-gateway/types.ts`                    |
| `provider-gateway/route-selector.ts`           | `agent-model/src/provider-gateway/route-selector.ts`           |
| `provider-gateway/route-selector.test.ts`      | `agent-model/src/provider-gateway/route-selector.test.ts`      |
| `provider-gateway/credential-resolver.ts`      | `agent-model/src/provider-gateway/credential-resolver.ts`      |
| `provider-gateway/credential-resolver.test.ts` | `agent-model/src/provider-gateway/credential-resolver.test.ts` |
| `provider-gateway/factory.ts`                  | `agent-model/src/provider-gateway/factory.ts`                  |

**provider-transport/ 目录（6 文件）**：

| 源文件                                          | 目标路径                                                        |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `provider-transport/index.ts`                   | `agent-model/src/provider-transport/index.ts`                   |
| `provider-transport/connection-manager.ts`      | `agent-model/src/provider-transport/connection-manager.ts`      |
| `provider-transport/connection-manager.test.ts` | `agent-model/src/provider-transport/connection-manager.test.ts` |
| `provider-transport/stream-recovery.ts`         | `agent-model/src/provider-transport/stream-recovery.ts`         |
| `provider-transport/stream-recovery.test.ts`    | `agent-model/src/provider-transport/stream-recovery.test.ts`    |
| `provider-transport/token-tracker.ts`           | `agent-model/src/provider-transport/token-tracker.ts`           |

**provider-stream-contract/ 目录（8 文件）**：

| 源文件                                         | 目标路径                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `provider-stream-contract/index.ts`            | `agent-model/src/provider-stream-contract/index.ts`            |
| `provider-stream-contract/types.ts`            | `agent-model/src/provider-stream-contract/types.ts`            |
| `provider-stream-contract/sequencer.ts`        | `agent-model/src/provider-stream-contract/sequencer.ts`        |
| `provider-stream-contract/json-repair.ts`      | `agent-model/src/provider-stream-contract/json-repair.ts`      |
| `provider-stream-contract/json-repair.test.ts` | `agent-model/src/provider-stream-contract/json-repair.test.ts` |
| `provider-stream-contract/error.ts`            | `agent-model/src/provider-stream-contract/error.ts`            |
| `provider-stream-contract/normalizer.ts`       | `agent-model/src/provider-stream-contract/normalizer.ts`       |
| `provider-stream-contract/normalizer.test.ts`  | `agent-model/src/provider-stream-contract/normalizer.test.ts`  |

**OpenAI / Anthropic / Gemini 根文件（17 文件）**：

| 源文件                               | 目标路径                                             | 说明                                    |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------- |
| `provider-openai-base.ts`            | `agent-model/src/provider-openai-base.ts`            |                                         |
| `provider-openai-chat.ts`            | `agent-model/src/provider-openai-chat.ts`            |                                         |
| `provider-openai-class.ts`           | `agent-model/src/provider-openai-class.ts`           |                                         |
| `provider-openai-compatible.ts`      | `agent-model/src/provider-openai-compatible.ts`      |                                         |
| `provider-openai-compatible.test.ts` | `agent-model/src/provider-openai-compatible.test.ts` |                                         |
| `provider-openai-config.ts`          | `agent-model/src/provider-openai-config.ts`          |                                         |
| `provider-openai-helpers.ts`         | `agent-model/src/provider-openai-helpers.ts`         |                                         |
| `provider-openai-responses.ts`       | `agent-model/src/provider-openai-responses.ts`       |                                         |
| `openai-request-build.ts`            | `agent-model/src/openai-request-build.ts`            | request-build（禁令 10 归 agent-model） |
| `openai-request-build.test.ts`       | `agent-model/src/openai-request-build.test.ts`       |                                         |
| `openai-stream-parse.ts`             | `agent-model/src/openai-stream-parse.ts`             | stream-parse（禁令 10 归 agent-model）  |
| `openai-stream-parse.test.ts`        | `agent-model/src/openai-stream-parse.test.ts`        |                                         |
| `openai-retry.ts`                    | `agent-model/src/openai-retry.ts`                    |                                         |
| `openai-retry.test.ts`               | `agent-model/src/openai-retry.test.ts`               |                                         |
| `openai-retry.adversarial.test.ts`   | `agent-model/src/openai-retry.adversarial.test.ts`   |                                         |
| `provider-anthropic.ts`              | `agent-model/src/provider-anthropic.ts`              |                                         |
| `provider-anthropic.test.ts`         | `agent-model/src/provider-anthropic.test.ts`         |                                         |
| `anthropic-request-build.ts`         | `agent-model/src/anthropic-request-build.ts`         | request-build                           |
| `anthropic-stream-parse.ts`          | `agent-model/src/anthropic-stream-parse.ts`          | stream-parse                            |
| `provider-gemini.ts`                 | `agent-model/src/provider-gemini.ts`                 |                                         |
| `provider-gemini.test.ts`            | `agent-model/src/provider-gemini.test.ts`            |                                         |
| `gemini-request-build.ts`            | `agent-model/src/gemini-request-build.ts`            | request-build                           |
| `gemini-stream-parse.ts`             | `agent-model/src/gemini-stream-parse.ts`             | stream-parse                            |

**Provider 辅助根文件（3 文件）**：

| 源文件                         | 目标路径                                       | 说明                                                              |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `provider-request-machine.ts`  | `agent-model/src/provider-request-machine.ts`  | provider 请求状态机                                               |
| `provider-cache-hints.ts`      | `agent-model/src/provider-cache-hints.ts`      |                                                                   |
| `provider-cache-hints.test.ts` | `agent-model/src/provider-cache-hints.test.ts` |                                                                   |
| `provider-error-classifier.ts` | `agent-model/src/provider-error-classifier.ts` | provider 专用错误分类（区别于 agent-core 的 error-classifier.ts） |

**model-routing/ 目录 + 根文件（7 文件）**：

| 源文件                              | 目标路径                                            |
| ----------------------------------- | --------------------------------------------------- |
| `model-routing/index.ts`            | `agent-model/src/model-routing/index.ts`            |
| `model-routing/matcher.ts`          | `agent-model/src/model-routing/matcher.ts`          |
| `model-routing/profile.ts`          | `agent-model/src/model-routing/profile.ts`          |
| `model-routing/types.ts`            | `agent-model/src/model-routing/types.ts`            |
| `model-routing-enhanced.ts`         | `agent-model/src/model-routing-enhanced.ts`         |
| `model-routing-roles.ts`            | `agent-model/src/model-routing-roles.ts`            |
| `model-routing-roles.test.ts`       | `agent-model/src/model-routing-roles.test.ts`       |
| `model-routing.ts`                  | `agent-model/src/model-routing.ts`                  |
| `model-routing.test.ts`             | `agent-model/src/model-routing.test.ts`             |
| `model-routing.adversarial.test.ts` | `agent-model/src/model-routing.adversarial.test.ts` |

**model-catalog/ 目录（3 文件）**：

| 源文件                          | 目标路径                                        |
| ------------------------------- | ----------------------------------------------- |
| `model-catalog/index.ts`        | `agent-model/src/model-catalog/index.ts`        |
| `model-catalog/types.ts`        | `agent-model/src/model-catalog/types.ts`        |
| `model-catalog/catalog-sync.ts` | `agent-model/src/model-catalog/catalog-sync.ts` |

**pricing / token / media / preview（10 文件）**：

| 源文件                               | 目标路径                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `pricing-engine.ts`                  | `agent-model/src/pricing-engine.ts`                  |
| `pricing-engine.adversarial.test.ts` | `agent-model/src/pricing-engine.adversarial.test.ts` |
| `token-ledger.ts`                    | `agent-model/src/token-ledger.ts`                    |
| `token-ledger.test.ts`               | `agent-model/src/token-ledger.test.ts`               |
| `media/media-cache.ts`               | `agent-model/src/media/media-cache.ts`               |
| `media/media-cache.test.ts`          | `agent-model/src/media/media-cache.test.ts`          |
| `media/media-preprocessor.ts`        | `agent-model/src/media/media-preprocessor.ts`        |
| `media/media-types.ts`               | `agent-model/src/media/media-types.ts`               |
| `media/provider-media-adapter.ts`    | `agent-model/src/media/provider-media-adapter.ts`    |
| `preview-queue.ts`                   | `agent-model/src/preview-queue.ts`                   |
| `preview-queue.test.ts`              | `agent-model/src/preview-queue.test.ts`              |
| `preview-queue.adversarial.test.ts`  | `agent-model/src/preview-queue.adversarial.test.ts`  |

**provider-stream-contract.ts 根文件（2 文件）**：

| 源文件                             | 目标路径                                           | 说明                                            |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `provider-stream-contract.ts`      | `agent-model/src/provider-stream-contract.ts`      | 根文件（区别于 provider-stream-contract/ 目录） |
| `provider-stream-contract.test.ts` | `agent-model/src/provider-stream-contract.test.ts` |                                                 |

**stream/ 目录（2 文件，thinking-config 除外）**：

| 源文件                                   | 目标路径                                                 | 说明          |
| ---------------------------------------- | -------------------------------------------------------- | ------------- |
| `stream/index.ts`                        | `agent-model/src/stream/index.ts`                        | stream barrel |
| `stream/streaming-tool-executor.ts`      | `agent-model/src/stream/streaming-tool-executor.ts`      | 流式工具执行  |
| `stream/streaming-tool-executor.test.ts` | `agent-model/src/stream/streaming-tool-executor.test.ts` |               |

> `stream/thinking-config.ts` 归 `agent-core`（Round 5），不在本 Round 迁移。依据 `02-FILE-MAPPING.md` §2.36 冲突解决记录第 2 项。

**任务量**：7 + 6 + 8 + 23 + 4 + 10 + 3 + 12 + 2 = 75 文件迁移，远超 禁令 28 门槛。

**import 路径更新规则**：

- `from '../types'` → `from '@crish/shared-types'`
- `from '../session'` → `from '@crish/agent-context'`
- `from '../provider'` → 包内相对路径（已在 agent-model 内）
- `from '../provider-stream-contract'` → 包内相对路径
- `from '../tools'` → `from '@crish/agent-tools'`（部分 stream 文件可能引用工具类型）
- `from '../recovery'` → 暂保留 `from '../recovery'`（agent-core 在 Round 5 创建，本 Round 通过 `agent-runtime` re-export 共存）

**关键设计约束**：

1. **stream-parse / request-build 强内聚**（禁令 10）：`openai-stream-parse.ts`、`anthropic-stream-parse.ts`、`gemini-stream-parse.ts`、`openai-request-build.ts`、`anthropic-request-build.ts`、`gemini-request-build.ts` 全部归 `agent-model`，与对应 provider 实现同包。禁止独立 `agent-stream` 包。
2. **provider-error-classifier 不迁入 agent-core**：`provider-error-classifier.ts` 是 provider 专用错误分类，区别于 `agent-core` 的通用 `error-classifier.ts`（261 行，ErrorClassifier）。两者职责不同，不合并。依据 `02-FILE-MAPPING.md` §4 遗漏文件补录。
3. **stream/ 目录部分迁移**：仅 `index.ts` + `streaming-tool-executor.ts` + `.test.ts` 迁入 agent-model；`thinking-config.ts` 留待 Round 5 迁入 agent-core。依据 `02-FILE-MAPPING.md` §2.36。
4. **provider 系统统一**（S-07）：OpenAI/Anthropic/Gemini 的 57+ 文件统一提取到 `agent-model`，结束散落在根目录的历史。

**验证标准**：

- 75 文件成功迁移
- agent-model/src/ 目录结构完整（含 provider/ + provider-gateway/ + provider-transport/ + provider-stream-contract/ + stream/ + model-routing/ + model-catalog/ + media/ 子目录 + 根文件）
- stream/thinking-config.ts 未迁移（保留在 agent-runtime，待 Round 5）

**协调点**：1 次（依赖 Agent 4-C 已创建包骨架与 provider/ 目录）

---

### 2.5 Agent 4-E：agent-mcp 完整化 + 测试迁移 + 依赖接线 + 验证

| 维度     | 说明                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| **类型** | 实现型 + 修复型 + 验证型                                                                                       |
| **目标** | agent-mcp 完整化（增加 agent-tools 依赖 + registerPluginServer 接口）、测试文件迁移、import 路径修复、验证门禁 |
| **前置** | Agent 4-A ~ 4-D 已完成文件迁移；Round 3 已创建 `agent-mcp` 骨架                                                |
| **后续** | Round 5（agent-core 创建）依赖本 Round 的 middle 层包                                                          |

**输入**：

- `packages/agent-mcp/`（Round 3 创建的骨架，含 mcp-lifecycle/ 目录）
- `packages/agent-runtime/src/__tests__/canonicalize-tools.test.ts`（归 agent-tools）
- `packages/agent-runtime/src/__tests__/exponential-backoff.test.ts`（归 agent-model）
- `packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts`（归 agent-model）
- `packages/agent-runtime/src/__tests__/integrations/media-pipeline.test.ts`（归 agent-model）
- `packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts`（归 agent-model）
- `packages/agent-runtime/src/__tests__/integrations/streaming-executor.test.ts`（归 agent-model）
- `packages/agent-runtime/src/provider-gateway-edge.test.ts`、`provider-gateway.test.ts`（归 agent-model）

**输出**：

- `packages/agent-mcp/package.json`（增加 `agent-tools` 依赖）
- `packages/agent-mcp/src/register-plugin-server.ts`（`registerPluginServer` 接口骨架）
- `packages/agent-mcp/src/index.ts`（更新 barrel，导出 `registerPluginServer`）
- 各新包中的测试文件
- `packages/agent-runtime/src/index.ts`（更新 re-export shim）
- 验证报告（depcruise + turbo build + TSC 基线）

**任务 1：agent-mcp 完整化**

**1a. 增加 agent-tools 依赖**：

修改 `packages/agent-mcp/package.json`：

```json
{
  "dependencies": {
    "@crish/shared-types": "*",
    "@crish/shared-utils": "*",
    "@crish/agent-tools": "*"
  }
}
```

> 依赖方向修正说明：`02-FILE-MAPPING.md` §9.2 原记录 `agent-tools` 依赖 `agent-mcp`，经 Round 4 验证修正为 `agent-mcp` 依赖 `agent-tools`。修正后无循环依赖（`agent-tools` 不依赖 `agent-mcp`）。修正依据：`01-OVERVIEW.md` §3 mermaid 中 `AT --> AM2`（AM2 依赖 AT）。执行后须同步更新 `02-FILE-MAPPING.md` §9.2（禁令 31）。

**1b. 实现 registerPluginServer 接口骨架**：

创建 `packages/agent-mcp/src/register-plugin-server.ts`：

```ts
/**
 * registerPluginServer — 插件 MCP 服务器注册入口（Layer 3）
 *
 * 依据 禁令 10：plugin-mcp 独立包并入 agent-mcp，增加 registerPluginServer 入口。
 * 依据 禁令 10：MCP 集成通过此入口实现，不在 plugin-sdk 内重复实现 MCP 生命周期。
 *
 * MVP 阶段仅实现骨架（声明式注册 + McpLifecycleManager 委托），
 * 完整实现推迟到 Round 8（plugin-sdk 重建时）。
 */

import type {
  McpServerDefinition,
  McpServerOperationResult,
} from './mcp-lifecycle/types';
import type { McpLifecycleManager } from './mcp-lifecycle/mcp-lifecycle-manager';

/**
 * 插件 MCP 服务器声明
 */
export interface PluginMcpDeclaration {
  /** 插件名称（来自 PluginManifest.name） */
  pluginName: string;
  /** MCP 服务器名称（在 agent-mcp 内唯一） */
  serverName: string;
  /** MCP 服务器定义 */
  definition: McpServerDefinition;
}

/**
 * 注册插件声明的 MCP 服务器
 *
 * @param pluginName 插件名称
 * @param declaration MCP 服务器声明
 * @returns 注册结果
 *
 * @alpha MVP 阶段为骨架实现，完整校验（manifest 声明比对、权限校验）推迟到 Round 8
 */
export function registerPluginServer(
  manager: McpLifecycleManager,
  pluginName: string,
  declaration: PluginMcpDeclaration
): McpServerOperationResult {
  // MVP 骨架：委托给 McpLifecycleManager 的现有 startServer 能力
  // 完整实现（manifest 校验 + 权限校验 + 热重载）推迟到 Round 8
  throw new Error(
    '[registerPluginServer] not implemented in Round 4 — deferred to Round 8'
  );
}
```

> **设计说明**：
>
> - 依据 禁令 10，`plugin-mcp` 独立包被禁止，并入 `agent-mcp` 增加 `registerPluginServer` 入口。
> - 依据 禁令 10，MCP 集成通过此入口实现，不在 `plugin-sdk` 内重复实现 MCP 生命周期。
> - 依据 禁令 19，MVP 阶段禁止 OAuth 支持，HotReload 推迟到 Phase 2。本 Round 仅实现骨架。
> - 完整实现（含 `PluginManifest.declaredMcpServers` 校验、`TrustGate` 权限校验）推迟到 Round 8（plugin-sdk 重建），因为 `PluginManifest` 类型在 Round 8 定义。

**1c. 更新 agent-mcp barrel**：

修改 `packages/agent-mcp/src/index.ts`，增加：

```ts
export type { PluginMcpDeclaration } from './register-plugin-server';
export { registerPluginServer } from './register-plugin-server';
```

**任务 2：测试文件迁移**

引用 `02-FILE-MAPPING.md` §2.41：

| 源文件                                                                | 目标包      | 目标路径                                                            |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `agent-runtime/src/__tests__/canonicalize-tools.test.ts`              | agent-tools | `agent-tools/src/__tests__/canonicalize-tools.test.ts`              |
| `agent-runtime/src/__tests__/exponential-backoff.test.ts`             | agent-model | `agent-model/src/__tests__/exponential-backoff.test.ts`             |
| `agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts`       | agent-model | `agent-model/src/__tests__/integrations/chatgpt-pool.test.ts`       |
| `agent-runtime/src/__tests__/integrations/media-pipeline.test.ts`     | agent-model | `agent-model/src/__tests__/integrations/media-pipeline.test.ts`     |
| `agent-runtime/src/__tests__/integrations/oauth-flow.test.ts`         | agent-model | `agent-model/src/__tests__/integrations/oauth-flow.test.ts`         |
| `agent-runtime/src/__tests__/integrations/streaming-executor.test.ts` | agent-model | `agent-model/src/__tests__/integrations/streaming-executor.test.ts` |
| `agent-runtime/src/provider-gateway-edge.test.ts`                     | agent-model | `agent-model/src/provider-gateway-edge.test.ts`                     |
| `agent-runtime/src/provider-gateway.test.ts`                          | agent-model | `agent-model/src/provider-gateway.test.ts`                          |

> `agent-runtime/src/__tests__/integrations/state-machine.test.ts` 归 agent-core（Round 5），不在本 Round 迁移。
> `agent-runtime/src/__tests__/integrations/tool-stream.test.ts` 归 agent-core（Round 5），不在本 Round 迁移。
> `agent-runtime/src/__tests__/canonical-schema.test.ts` 归 agent-context（Round 3 已迁移），本 Round 不处理。
> `agent-runtime/src/__tests__/context-slicer.test.ts` 归 agent-context（Round 3 已迁移），本 Round 不处理。
> `agent-runtime/src/__tests__/error-classifier.test.ts` 归 agent-core（Round 5），本 Round 不处理。
> `agent-runtime/src/__tests__/steering-input-queue.test.ts` 归 agent-core（Round 5），本 Round 不处理。

**任务 3：agent-runtime re-export shim 更新**

依据 禁令 24，`agent-runtime` 作为 re-export barrel shim 是允许的过渡措施。更新 `packages/agent-runtime/src/index.ts`：

```ts
/**
 * @deprecated @crish/agent-runtime is deprecated.
 * Import from @crish/agent-tools, @crish/agent-model, @crish/agent-mcp directly.
 * This shim will be removed in v0.3.0.
 */

if (typeof console !== 'undefined') {
  console.warn(
    '[deprecated] @crish/agent-runtime is deprecated, import from @crish/agent-tools / @crish/agent-model / @crish/agent-mcp directly'
  );
}

// 显式命名导出（禁止 export *，禁令 24）
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  RegisteredTool,
  type ToolMiddleware,
  ToolRegistry,
} from '@crish/agent-tools';

export {
  type Engine,
  type ProviderDef,
  ProviderFactory,
  ProviderRegistry,
} from '@crish/agent-model';

export {
  McpLifecycleManager,
  type McpServerDefinition,
} from '@crish/agent-mcp';
```

> **共存策略**（guardrails 禁令 23）：本 Round 为共存阶段，`agent-runtime` 中被迁移的源文件保留（不删除），shim 通过 `@crish/agent-tools` / `@crish/agent-model` / `@crish/agent-mcp` 包的 `development` exports 指向源文件。删除阶段在 Round 5（agent-core 创建后）执行。

**任务 4：import 路径修复**

修复 `agent-runtime` 中未被迁移文件（归 agent-core 的文件）的 import 路径：

- `from './tools'` → `from '@crish/agent-tools'`（agent-core 文件引用工具系统）
- `from './provider'` → `from '@crish/agent-model'`（agent-core 文件引用 provider）
- `from './local-tools'` → `from '@crish/agent-tools'`
- `from './background-command'` → `from '@crish/agent-tools'`
- `from './rich-read'` → `from '@crish/agent-tools'`
- `from './mcp-lifecycle'` → `from '@crish/agent-mcp'`

> 仅修复归 agent-core 的文件（runtime.ts、agent-session-loop.ts、runtime-components/、session-loop/ 等）。归 agent-tools / agent-model 的文件已在 Agent 4-A ~ 4-D 中迁移，不需要在 agent-runtime 中修复。

**任务 5：验证门禁**

执行 §5 验证门禁的全部 8 项检查，生成验证报告。

**任务量**：

- agent-mcp 完整化：3 文件修改/创建（package.json + register-plugin-server.ts + index.ts）
- 测试迁移：8 文件
- shim 更新：1 文件
- import 修复：~15 文件（agent-runtime 中归 agent-core 的文件）
- 验证报告：1 文件
- 合计：~28 文件操作，超过 禁令 28 门槛。

**验证标准**：

- `agent-mcp/package.json` 含 `agent-tools` 依赖
- `registerPluginServer` 函数可从 `@crish/agent-mcp` 导入
- `agent-runtime` 导入 `@crish/agent-tools` / `@crish/agent-model` / `@crish/agent-mcp` 成功
- depcruise 0 violations（无循环依赖）
- turbo build 全部成功
- TSC 错误数 ≤ 基线（不恶化）

**协调点**：2 次（依赖 Agent 4-A ~ 4-D 的产出 + Round 3 的 agent-mcp 骨架）

---

## 3. 各包设计详细

### 3.1 @crish/agent-tools

#### package.json

```json
{
  "name": "@crish/agent-tools",
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
    "@crish/logger": "*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.9.2"
  }
}
```

> **依赖说明**（依据 `02-FILE-MAPPING.md` §9.2 + 本 Round 修正）：
>
> - `@crish/shared-types`：ToolDefinition / JsonObject / ToolCategory / ToolConcurrency / ToolExecutionContext / ToolOutput / AgentTool / ToolSource（已下沉 shared-types，见 §2.2）
> - `@crish/shared-utils`：RingBuffer / errorMessage / AsyncSemaphore 等工具函数
> - `@crish/agent-context`：createId / nowIso / CheckpointManager / ContextManager（工具执行需要 context 类型）
> - `@crish/logger`：工具执行日志
> - **不依赖 `@crish/agent-mcp`**（本 Round 修正，原 `02-FILE-MAPPING.md` §9.2 记录有误）

#### 目录结构

```
packages/agent-tools/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                          # barrel
    ├── tools/                            # 工具系统核心（§2.39）
    │   ├── index.ts
    │   ├── tool-definition.ts            # RegisteredTool 三层体系（176 行）
    │   ├── tool-middleware.ts            # ToolMiddleware 3-Hook（禁令 7）
    │   ├── tool-preset-registry.ts
    │   └── tool-system.test.ts
    ├── local-tools/                      # 本地工具实现（§2.14）
    │   ├── index.ts
    │   ├── fs-read-tools.ts
    │   ├── fs-edit-tools.ts
    │   ├── fs-edit-tools/
    │   │   ├── apply-edits-tool.ts
    │   │   ├── edit-tool.ts
    │   │   ├── index.ts
    │   │   ├── types.ts
    │   │   ├── utils.ts
    │   │   └── write-tool.ts
    │   ├── shell-tools.ts
    │   ├── search-tools.ts
    │   ├── checkpoint-tools.ts
    │   ├── pre-mutation.ts
    │   ├── shared.ts
    │   ├── types.ts
    │   └── fs-edit-tools.test.ts
    ├── git-versioning/                   # Git 版本控制（§2.12）
    │   ├── git-commit-ops.ts
    │   ├── git-patch-ops.ts
    │   ├── git-patch-ops.test.ts
    │   ├── git-service.ts
    │   └── git-types.ts
    ├── __tests__/
    │   └── canonicalize-tools.test.ts    # 集成测试（§2.41）
    ├── tool-discovery.ts
    ├── tool-discovery.test.ts
    ├── tool-output-budget.ts             # 工具输出预算
    ├── tool-output-budget.test.ts
    ├── tool-output-guard.ts              # 工具输出守卫
    ├── tool-output-guard.test.ts
    ├── tool-registry.ts
    ├── tools.ts                          # tools barrel（19K）
    ├── tools.test.ts
    ├── workspace-mutation-coordinator.ts # 16K
    ├── workspace-mutation-coordinator.test.ts
    ├── background-command.ts             # 27K
    ├── background-command.test.ts
    ├── script-wait-policy.ts
    ├── script-wait-policy.test.ts
    ├── lsp-tools.ts                      # 24K
    ├── lsp-tools.test.ts
    ├── rich-read.ts                      # 30K
    ├── rich-read.test.ts
    ├── resource-uri.ts                   # 24K
    ├── resource-uri.test.ts
    ├── local-tools.ts                    # 根文件（区别于 local-tools/ 目录）
    ├── local-tools.test.ts
    ├── git-versioning.ts                 # 根文件（区别于 git-versioning/ 目录）
    ├── git-versioning.test.ts
    ├── skills.ts
    └── skills.test.ts
```

#### 导出接口

`packages/agent-tools/src/index.ts`（barrel）：

```ts
/**
 * @crish/agent-tools — 工具系统（Layer 3 middle）
 *
 * 导出工具定义、中间件、注册表、本地工具实现。
 */

// ─── 工具系统核心 ──────────────────────────────────────────
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  type LlmToolDefinition,
  RegisteredTool,
  ToolRegistry,
} from './tools/tool-definition';

export {
  type ToolMiddleware,
  type MiddlewareBeforeResult,
  type MiddlewareAfterResult,
  PermissionMiddleware,
  type PermissionMiddlewareOptions,
  CheckpointMiddleware,
  type CheckpointMiddlewareOptions,
  OutputMaterializationMiddleware,
  type OutputMaterializationMiddlewareOptions,
} from './tools/tool-middleware';

export { ToolPresetRegistry } from './tools/tool-preset-registry';

// ─── 工具发现与注册 ────────────────────────────────────────
export { ToolDiscovery } from './tool-discovery';
export { ToolOutputBudget } from './tool-output-budget';
export { ToolOutputGuard } from './tool-output-guard';

// ─── 本地工具 ─────────────────────────────────────────────
export * from './local-tools/index';
export * from './local-tools/fs-edit-tools/index';

// ─── 大文件工具 ───────────────────────────────────────────
export { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator';
export { BackgroundCommandManager } from './background-command';
export { ScriptWaitPolicy } from './script-wait-policy';
export { LspToolsManager } from './lsp-tools';
export { RichReadManager } from './rich-read';
export { ResourceUri } from './resource-uri';
export { SkillsManager } from './skills';
export { GitVersioning } from './git-versioning';
```

> **导出接口宽度说明**：禁令 10 条件 4 要求"包间接口窄且稳定（>10 个导出符号说明拆分边界不自然）"。agent-tools 导出符号 >10 个，但这是因为工具系统天然需要导出多种工具类型（ToolDefinition / ToolMiddleware / RegisteredTool / 各工具实现）。导出符号虽多，但接口语义内聚（全部围绕"工具定义与执行"），不违反内聚性原则。

#### 关键设计约束

1. **ToolMiddleware 保留 3-Hook**（禁令 7）：
   - `beforeExecute(tool, input, ctx) → MiddlewareBeforeResult`：防爆网与审批
   - `onResult(tool, input, output, ctx) → MiddlewareAfterResult`：结果与日志
   - `onError(tool, input, error, ctx) → void`：错误处理
   - 禁止恢复 `beforeRegister` / `afterExecute` / `onCancel` 等 6 阶段洋葱 Hook

2. **RegisteredTool 三层体系保留**：
   - 第 1 层 `ToolDefinition`：第三方最小接口（类型别名，源自 shared-types）
   - 第 2 层 `ToolRegistrationOptions`：可选高级特性（label / category / concurrency / allowParallel / fatalOnError / isReadOnly / summarize / inputAliases）
   - 第 3 层 `RegisteredTool`：运行时工具类（系统根据 definition + options 自动填充所有字段，176 行）
   - 三层结构不得扁平化，不得合并为单一接口

3. **共存策略**（guardrails 禁令 23）：
   - `agent-runtime` 中被迁移的源文件保留（不删除）
   - `agent-runtime/src/index.ts` 通过 `@crish/agent-tools` 的 `development` exports re-export
   - 删除阶段在 Round 5 执行（agent-core 创建后）

---

### 3.2 @crish/agent-model

#### package.json

```json
{
  "name": "@crish/agent-model",
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
> - `@crish/shared-types`：AgentProvider 等 provider 接口（已下沉 shared-types，见 §2.2）、ToolCallBlock / AgentMessage / PermissionRequest 等
> - `@crish/shared-utils`：retry / cache / abort-utils 等工具函数
> - `@crish/agent-context`：session / context 类型（provider 需要 context 类型）
> - `@crish/logger`：provider 请求日志
> - `@crish/telemetry`：TraceManager + AsyncLocalStorage（provider 请求追踪）

#### 目录结构

```
packages/agent-model/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                              # barrel
    ├── provider/                             # Provider 核心（§2.23，全部子目录）
    │   ├── index.ts
    │   ├── types.ts
    │   ├── factory.ts
    │   ├── loader.ts
    │   ├── declarative-schema.ts
    │   ├── registry-v2.ts
    │   ├── provider-gateway-v2.ts
    │   ├── faux-provider.ts
    │   ├── health-checker.ts
    │   ├── __tests__/
    │   │   ├── auth.test.ts
    │   │   ├── base-engine.test.ts
    │   │   ├── declarative-loader.test.ts
    │   │   ├── factory.test.ts
    │   │   ├── registry.test.ts
    │   │   ├── benchmarks/
    │   │   │   └── provider-lifecycle.bench.ts
    │   │   └── e2e/
    │   │       ├── context-length-recovery.test.ts
    │   │       ├── exponential-backoff-e2e.test.ts
    │   │       ├── mock-server.ts
    │   │       ├── provider-factory.test.ts
    │   │       ├── steering-injection.test.ts
    │   │       └── stream-parser.test.ts
    │   ├── auth/
    │   │   ├── index.ts
    │   │   ├── types.ts
    │   │   ├── auth-method-bridge.ts
    │   │   ├── base-url-validator.ts
    │   │   ├── base-url-validator.test.ts
    │   │   ├── credential-pool.ts
    │   │   ├── credential-resolver.ts
    │   │   ├── encrypted-file-store.ts
    │   │   ├── key-rotation.ts
    │   │   ├── log-sanitizer.ts
    │   │   ├── secret-store.ts
    │   │   └── oauth/
    │   │       ├── index.ts
    │   │       ├── account-store.ts
    │   │       ├── chatgpt-pool.ts
    │   │       ├── chatgpt-pool.test.ts
    │   │       ├── cross-process-lock.ts
    │   │       ├── local-server.ts
    │   │       ├── oauth-flow.ts
    │   │       ├── oauth-ui.ts
    │   │       ├── pkce.ts
    │   │       ├── state-machine.ts
    │   │       └── token-guardian.ts
    │   ├── builtin/
    │   │   ├── index.ts
    │   │   ├── types.ts
    │   │   ├── anthropic-provider-class.ts
    │   │   └── gemini-provider-class.ts
    │   ├── engines/
    │   │   ├── index.ts
    │   │   ├── base-engine.ts
    │   │   ├── openai-compatible-engine.ts
    │   │   ├── openai-compatible-engine.test.ts
    │   │   ├── anthropic-messages-engine.ts
    │   │   ├── anthropic-messages-engine.test.ts
    │   │   ├── ollama-engine.ts
    │   │   └── ollama-engine.test.ts
    │   ├── cli/
    │   │   ├── index.ts
    │   │   ├── main.ts
    │   │   ├── provider-dev.ts
    │   │   ├── provider-list.ts
    │   │   ├── provider-test.ts
    │   │   ├── provider-utils.ts
    │   │   └── provider-validate.ts
    │   └── spi/
    │       ├── index.ts
    │       ├── engine-class.ts
    │       ├── provider-class.ts
    │       └── provider-factory.ts
    ├── provider-gateway/                     # Gateway（§2.24）
    │   ├── index.ts
    │   ├── types.ts
    │   ├── route-selector.ts
    │   ├── route-selector.test.ts
    │   ├── credential-resolver.ts
    │   ├── credential-resolver.test.ts
    │   └── factory.ts
    ├── provider-transport/                   # Transport（§2.26）
    │   ├── index.ts
    │   ├── connection-manager.ts
    │   ├── connection-manager.test.ts
    │   ├── stream-recovery.ts
    │   ├── stream-recovery.test.ts
    │   └── token-tracker.ts
    ├── provider-stream-contract/             # Stream Contract（§2.25）
    │   ├── index.ts
    │   ├── types.ts
    │   ├── sequencer.ts
    │   ├── json-repair.ts
    │   ├── json-repair.test.ts
    │   ├── error.ts
    │   ├── normalizer.ts
    │   └── normalizer.test.ts
    ├── stream/                               # Stream（§2.36，仅非 thinking 部分）
    │   ├── index.ts
    │   ├── streaming-tool-executor.ts
    │   └── streaming-tool-executor.test.ts
    ├── model-routing/                        # Model Routing（§2.18）
    │   ├── index.ts
    │   ├── types.ts
    │   ├── matcher.ts
    │   └── profile.ts
    ├── model-catalog/                        # Model Catalog（§2.17）
    │   ├── index.ts
    │   ├── types.ts
    │   └── catalog-sync.ts
    ├── media/                                # Media（§2.16）
    │   ├── media-cache.ts
    │   ├── media-cache.test.ts
    │   ├── media-preprocessor.ts
    │   ├── media-types.ts
    │   └── provider-media-adapter.ts
    ├── __tests__/
    │   ├── exponential-backoff.test.ts
    │   ├── integrations/
    │   │   ├── chatgpt-pool.test.ts
    │   │   ├── media-pipeline.test.ts
    │   │   ├── oauth-flow.test.ts
    │   │   └── streaming-executor.test.ts
    │   ├── provider-gateway-edge.test.ts
    │   └── provider-gateway.test.ts
    ├── provider-openai-base.ts               # OpenAI 系列
    ├── provider-openai-chat.ts
    ├── provider-openai-class.ts
    ├── provider-openai-compatible.ts
    ├── provider-openai-compatible.test.ts
    ├── provider-openai-config.ts
    ├── provider-openai-helpers.ts
    ├── provider-openai-responses.ts
    ├── openai-request-build.ts               # request-build（禁令 10 归 agent-model）
    ├── openai-request-build.test.ts
    ├── openai-stream-parse.ts                # stream-parse（禁令 10 归 agent-model）
    ├── openai-stream-parse.test.ts
    ├── openai-retry.ts
    ├── openai-retry.test.ts
    ├── openai-retry.adversarial.test.ts
    ├── provider-anthropic.ts                 # Anthropic 系列
    ├── provider-anthropic.test.ts
    ├── anthropic-request-build.ts
    ├── anthropic-stream-parse.ts
    ├── provider-gemini.ts                    # Gemini 系列
    ├── provider-gemini.test.ts
    ├── gemini-request-build.ts
    ├── gemini-stream-parse.ts
    ├── provider-request-machine.ts
    ├── provider-cache-hints.ts
    ├── provider-cache-hints.test.ts
    ├── provider-error-classifier.ts          # provider 专用错误分类
    ├── provider-stream-contract.ts           # 根文件（区别于目录）
    ├── provider-stream-contract.test.ts
    ├── model-routing.ts                      # 根文件
    ├── model-routing.test.ts
    ├── model-routing.adversarial.test.ts
    ├── model-routing-enhanced.ts
    ├── model-routing-roles.ts
    ├── model-routing-roles.test.ts
    ├── pricing-engine.ts
    ├── pricing-engine.adversarial.test.ts
    ├── token-ledger.ts
    ├── token-ledger.test.ts
    └── preview-queue.ts
    ├── preview-queue.test.ts
    └── preview-queue.adversarial.test.ts
```

#### Provider 抽象层设计

agent-model 的 Provider 系统采用三层抽象（保留现有结构，不重新设计）：

```
┌─────────────────────────────────────────────────────────────┐
│                    Provider 抽象层                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  SPI 层（provider/spi/）                               │  │
│  │  - ProviderClass / EngineClass 接口                   │  │
│  │  - ProviderFactory SPI 契约                            │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  Engines 层（provider/engines/）                       │  │
│  │  - AbstractBaseEngine（抽象基类）                      │  │
│  │  - OpenAICompatibleEngine                              │  │
│  │  - AnthropicMessagesEngine                             │  │
│  │  - OllamaEngine                                        │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │  Builtin 层（provider/builtin/）                       │  │
│  │  - AnthropicProviderClass                              │  │
│  │  - GeminiProviderClass                                 │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  辅助系统                                                   │
│  ├── provider-gateway/     # 网关：路由选择 + 凭证解析      │
│  ├── provider-transport/   # 传输：连接管理 + 流恢复        │
│  ├── provider-stream-contract/  # 流契约：序列化 + 修复     │
│  ├── auth/ + auth/oauth/   # 认证：密钥存储 + OAuth         │
│  ├── model-routing/        # 模型路由                      │
│  ├── model-catalog/        # 模型目录                      │
│  └── media/                # 媒体处理                      │
├─────────────────────────────────────────────────────────────┤
│  Provider 实现（根文件）                                    │
│  ├── provider-openai-*.ts      # OpenAI 系列（7 文件）     │
│  ├── openai-request-build.ts   # OpenAI 请求构建           │
│  ├── openai-stream-parse.ts    # OpenAI 流解析             │
│  ├── openai-retry.ts           # OpenAI 重试               │
│  ├── provider-anthropic.ts     # Anthropic                 │
│  ├── anthropic-request-build.ts                           │
│  ├── anthropic-stream-parse.ts                            │
│  ├── provider-gemini.ts        # Gemini                    │
│  ├── gemini-request-build.ts                              │
│  └── gemini-stream-parse.ts                               │
└─────────────────────────────────────────────────────────────┘
```

**关键设计约束**：

1. **stream-parse / request-build 归入 agent-model**（禁令 10）：
   - `openai-stream-parse.ts`、`anthropic-stream-parse.ts`、`gemini-stream-parse.ts` 与对应 provider 实现强内聚
   - `openai-request-build.ts`、`anthropic-request-build.ts`、`gemini-request-build.ts` 同理
   - 禁止独立 `agent-stream` 包（仅 5-8 文件，不满足 禁令 10 条件 1）

2. **Provider 系统统一**（S-07）：
   - OpenAI / Anthropic / Gemini 的 57+ 文件统一提取到 agent-model
   - 结束散落在 `agent-runtime/src/` 根目录的历史
   - provider/ 目录整体迁移（含全部子目录），不拆分到多个包

3. **provider-error-classifier 不合并到 agent-core**：
   - `provider-error-classifier.ts` 是 provider 专用错误分类（区分 HTTP 状态码、provider 特定错误）
   - 区别于 `agent-core` 的通用 `error-classifier.ts`（261 行，ErrorClassifier + ErrorDomain 枚举）
   - 两者职责不同，不合并

4. **不引入 DynamicModelRouter / FallbackChain**（禁令 3）：
   - agent-model 仅实现 provider 请求构建、流解析、重试
   - 禁止后台自动切换模型（用户选择什么模型，请求就固定使用该模型）
   - 仅在当前选定模型上做指数退避重试（`openai-retry.ts` 保留现有逻辑）

5. **不引入 CircuitBreaker**（禁令 6）：
   - `provider-transport/stream-recovery.ts` 保留现有流恢复逻辑
   - 禁止滑动窗口断路器状态机

---

### 3.3 @crish/agent-mcp（完整化）

#### 增加的 agent-tools 依赖

修改 `packages/agent-mcp/package.json`（Round 3 骨架基础上增加 `agent-tools` 依赖）：

```json
{
  "name": "@crish/agent-mcp",
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
    "@crish/agent-tools": "*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.9.2"
  }
}
```

> **依赖演进说明**：
>
> - Round 3（骨架）：`dependencies` 仅 `@crish/shared-types` + `@crish/shared-utils`（Layer 2 leaf）
> - Round 4（完整化）：增加 `@crish/agent-tools`（Layer 2 → Layer 3）
> - `agent-tools` 依赖用于 `registerPluginServer` 接口的工具注册类型（`ToolDefinition` / `RegisteredTool`）
> - **依赖方向修正**：`02-FILE-MAPPING.md` §9.2 原记录 `agent-tools` 依赖 `agent-mcp` 有误，修正为 `agent-mcp` 依赖 `agent-tools`。修正后拓扑层一致，无循环依赖。

#### registerPluginServer 接口

**接口定义**（`packages/agent-mcp/src/register-plugin-server.ts`）：

```ts
import type {
  McpServerDefinition,
  McpServerOperationResult,
} from './mcp-lifecycle/types';
import type { McpLifecycleManager } from './mcp-lifecycle/mcp-lifecycle-manager';

/**
 * 插件 MCP 服务器声明
 *
 * 对应 PluginManifest.declaredMcpServers 中的每一项声明，
 * 通过 PluginAPI.mcp.registerServer() 命令式注册。
 */
export interface PluginMcpDeclaration {
  /** 插件名称（来自 PluginManifest.name） */
  pluginName: string;
  /** MCP 服务器名称（在 agent-mcp 内唯一，用于生命周期管理） */
  serverName: string;
  /** MCP 服务器定义（stdio 命令 / 环境变量 / 启动参数） */
  definition: McpServerDefinition;
}

/**
 * 注册插件声明的 MCP 服务器
 *
 * 依据 禁令 10：plugin-mcp 独立包被禁止，并入 agent-mcp。
 * 依据 禁令 10：MCP 集成通过此入口实现，不在 plugin-sdk 内重复。
 * 依据 禁令 19：MVP 阶段禁止 OAuth，HotReload 推迟到 Phase 2。
 *
 * @param manager McpLifecycleManager 实例
 * @param pluginName 插件名称
 * @param declaration MCP 服务器声明
 * @returns 注册结果
 *
 * @alpha Round 4 为骨架实现，完整校验推迟到 Round 8
 */
export function registerPluginServer(
  manager: McpLifecycleManager,
  pluginName: string,
  declaration: PluginMcpDeclaration
): McpServerOperationResult;
```

**设计说明**：

1. **依据 禁令 10**：`plugin-mcp` 独立包被禁止，并入 `agent-mcp` 增加 `registerPluginServer` 入口。与现有 `McpLifecycleManager` 职责完全重叠，不重复实现 MCP 生命周期。

2. **依据 禁令 10**：MCP 集成通过 `agent-mcp` 的 `registerPluginServer` 入口实现，不在 `plugin-sdk` 内重复实现 MCP 生命周期。`plugin-sdk` 仅调用此入口。

3. **依据 禁令 15-17**：`PluginManifest` 声明能力清单（`declaredMcpServers: string[]`），实际注册通过 `activate(api)` 命令式完成。校验时比对 `registerPluginServer` 注册的 serverName 必须在 manifest 声明清单内。MVP 阶段为骨架，完整校验推迟到 Round 8（`PluginManifest` 类型在 Round 8 定义）。

4. **依据 禁令 19**：MVP 阶段禁止 OAuth 支持（MCP 服务器多为 stdio 本地进程），HotReload 推迟到 Phase 2。本 Round 仅实现骨架。

5. **MVP 骨架实现**：Round 4 仅声明接口签名，`registerPluginServer` 函数体 `throw new Error("[registerPluginServer] not implemented in Round 4 — deferred to Round 8")`。完整实现在 Round 8（plugin-sdk 重建时）开发，因为：
   - `PluginManifest` 类型在 Round 8 定义
   - `TrustGate` 权限校验在 Round 8 集成
   - `PluginAPI` 的 `api.mcp.registerServer()` 在 Round 8 定义

#### agent-mcp 目录结构（Round 4 完整化后）

```
packages/agent-mcp/
├── package.json                         # 增加 agent-tools 依赖
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
└── src/
    ├── index.ts                         # barrel（增加 registerPluginServer 导出）
    ├── register-plugin-server.ts        # [NEW] 插件 MCP 服务器注册入口（骨架）
    ├── mcp-lifecycle/                   # Round 3 已迁移
    │   ├── index.ts
    │   ├── mcp-lifecycle-manager.ts
    │   ├── mcp-server-controller.ts
    │   ├── mcp-server-controller.test.ts
    │   ├── types.ts
    │   └── utils.ts
    ├── mcp-lifecycle.ts                 # 根文件（Round 3 已迁移）
    └── mcp-lifecycle.test.ts            # 根文件测试（Round 3 已迁移）
```

---

## 4. 文件迁移清单（引用 02-FILE-MAPPING.md）

> 本节汇总 Round 4 全部文件迁移，引用 `02-FILE-MAPPING.md` 的权威映射表。本节不重新定义映射，仅汇总并标注 Agent 归属。

### 4.1 迁移到 @crish/agent-tools（Agent 4-A + 4-B）

| 源（agent-runtime/src/）                   | 目标（agent-tools/src/）                 | Agent | 映射依据 |
| ------------------------------------------ | ---------------------------------------- | ----- | -------- |
| `tools/index.ts`                           | `tools/index.ts`                         | 4-A   | §2.39    |
| `tools/tool-definition.ts`                 | `tools/tool-definition.ts`               | 4-A   | §2.39    |
| `tools/tool-middleware.ts`                 | `tools/tool-middleware.ts`               | 4-A   | §2.39    |
| `tools/tool-preset-registry.ts`            | `tools/tool-preset-registry.ts`          | 4-A   | §2.39    |
| `tools/tool-system.test.ts`                | `tools/tool-system.test.ts`              | 4-A   | §2.39    |
| `local-tools/index.ts`                     | `local-tools/index.ts`                   | 4-A   | §2.14    |
| `local-tools/fs-read-tools.ts`             | `local-tools/fs-read-tools.ts`           | 4-A   | §2.14    |
| `local-tools/fs-edit-tools.ts`             | `local-tools/fs-edit-tools.ts`           | 4-A   | §2.14    |
| `local-tools/fs-edit-tools/*.ts`（6 文件） | `local-tools/fs-edit-tools/*.ts`         | 4-A   | §2.14    |
| `local-tools/shell-tools.ts`               | `local-tools/shell-tools.ts`             | 4-A   | §2.14    |
| `local-tools/search-tools.ts`              | `local-tools/search-tools.ts`            | 4-A   | §2.14    |
| `local-tools/checkpoint-tools.ts`          | `local-tools/checkpoint-tools.ts`        | 4-A   | §2.14    |
| `local-tools/pre-mutation.ts`              | `local-tools/pre-mutation.ts`            | 4-A   | §2.14    |
| `local-tools/shared.ts`                    | `local-tools/shared.ts`                  | 4-A   | §2.14    |
| `local-tools/types.ts`                     | `local-tools/types.ts`                   | 4-A   | §2.14    |
| `local-tools/fs-edit-tools.test.ts`        | `local-tools/fs-edit-tools.test.ts`      | 4-A   | §2.14    |
| `tool-discovery.ts`                        | `tool-discovery.ts`                      | 4-A   | §2.1     |
| `tool-discovery.test.ts`                   | `tool-discovery.test.ts`                 | 4-A   | §2.1     |
| `tool-output-budget.ts`                    | `tool-output-budget.ts`                  | 4-A   | §2.1     |
| `tool-output-budget.test.ts`               | `tool-output-budget.test.ts`             | 4-A   | §2.1     |
| `tool-output-guard.ts`                     | `tool-output-guard.ts`                   | 4-A   | §2.1     |
| `tool-output-guard.test.ts`                | `tool-output-guard.test.ts`              | 4-A   | §2.1     |
| `tool-registry.ts`                         | `tool-registry.ts`                       | 4-A   | §2.1     |
| `tools.ts`                                 | `tools.ts`                               | 4-A   | §2.1     |
| `tools.test.ts`                            | `tools.test.ts`                          | 4-A   | §2.1     |
| `workspace-mutation-coordinator.ts`        | `workspace-mutation-coordinator.ts`      | 4-B   | §2.1     |
| `workspace-mutation-coordinator.test.ts`   | `workspace-mutation-coordinator.test.ts` | 4-B   | §2.1     |
| `background-command.ts`                    | `background-command.ts`                  | 4-B   | §2.1     |
| `background-command.test.ts`               | `background-command.test.ts`             | 4-B   | §2.1     |
| `script-wait-policy.ts`                    | `script-wait-policy.ts`                  | 4-B   | §2.1     |
| `script-wait-policy.test.ts`               | `script-wait-policy.test.ts`             | 4-B   | §2.1     |
| `lsp-tools.ts`                             | `lsp-tools.ts`                           | 4-B   | §2.1     |
| `lsp-tools.test.ts`                        | `lsp-tools.test.ts`                      | 4-B   | §2.1     |
| `rich-read.ts`                             | `rich-read.ts`                           | 4-B   | §2.1     |
| `rich-read.test.ts`                        | `rich-read.test.ts`                      | 4-B   | §2.1     |
| `resource-uri.ts`                          | `resource-uri.ts`                        | 4-B   | §2.1     |
| `resource-uri.test.ts`                     | `resource-uri.test.ts`                   | 4-B   | §2.1     |
| `local-tools.ts`（根文件）                 | `local-tools.ts`                         | 4-B   | §2.1     |
| `local-tools.test.ts`                      | `local-tools.test.ts`                    | 4-B   | §2.1     |
| `git-versioning.ts`（根文件）              | `git-versioning.ts`                      | 4-B   | §2.1     |
| `git-versioning.test.ts`                   | `git-versioning.test.ts`                 | 4-B   | §2.1     |
| `git-versioning/git-commit-ops.ts`         | `git-versioning/git-commit-ops.ts`       | 4-B   | §2.12    |
| `git-versioning/git-patch-ops.ts`          | `git-versioning/git-patch-ops.ts`        | 4-B   | §2.12    |
| `git-versioning/git-patch-ops.test.ts`     | `git-versioning/git-patch-ops.test.ts`   | 4-B   | §2.12    |
| `git-versioning/git-service.ts`            | `git-versioning/git-service.ts`          | 4-B   | §2.12    |
| `git-versioning/git-types.ts`              | `git-versioning/git-types.ts`            | 4-B   | §2.12    |
| `skills.ts`                                | `skills.ts`                              | 4-B   | §2.1     |
| `skills.test.ts`                           | `skills.test.ts`                         | 4-B   | §2.1     |
| `__tests__/canonicalize-tools.test.ts`     | `__tests__/canonicalize-tools.test.ts`   | 4-E   | §2.41    |

**agent-tools 小计**：51 文件

### 4.2 迁移到 @crish/agent-model（Agent 4-C + 4-D + 4-E）

| 源（agent-runtime/src/）                                      | 目标（agent-model/src/）    | Agent | 映射依据 |
| ------------------------------------------------------------- | --------------------------- | ----- | -------- |
| `provider/` 全部子目录（66 文件）                             | `provider/`                 | 4-C   | §2.23    |
| `provider-gateway/`（7 文件）                                 | `provider-gateway/`         | 4-D   | §2.24    |
| `provider-transport/`（6 文件）                               | `provider-transport/`       | 4-D   | §2.26    |
| `provider-stream-contract/`（8 文件）                         | `provider-stream-contract/` | 4-D   | §2.25    |
| `provider-openai-*.ts`（7 文件 + 1 test）                     | 根目录                      | 4-D   | §2.1     |
| `openai-request-build.ts` + `.test.ts`                        | 根目录                      | 4-D   | §2.1     |
| `openai-stream-parse.ts` + `.test.ts`                         | 根目录                      | 4-D   | §2.1     |
| `openai-retry.ts` + `.test.ts` + `.adversarial.test.ts`       | 根目录                      | 4-D   | §2.1     |
| `provider-anthropic.ts` + `.test.ts`                          | 根目录                      | 4-D   | §2.1     |
| `anthropic-request-build.ts`                                  | 根目录                      | 4-D   | §2.1     |
| `anthropic-stream-parse.ts`                                   | 根目录                      | 4-D   | §2.1     |
| `provider-gemini.ts` + `.test.ts`                             | 根目录                      | 4-D   | §2.1     |
| `gemini-request-build.ts`                                     | 根目录                      | 4-D   | §2.1     |
| `gemini-stream-parse.ts`                                      | 根目录                      | 4-D   | §2.1     |
| `provider-request-machine.ts`                                 | 根目录                      | 4-D   | §2.1     |
| `provider-cache-hints.ts` + `.test.ts`                        | 根目录                      | 4-D   | §2.1     |
| `provider-error-classifier.ts`                                | 根目录                      | 4-D   | §2.1     |
| `model-routing/`（4 文件）                                    | `model-routing/`            | 4-D   | §2.18    |
| `model-routing.ts` + `.test.ts` + `.adversarial.test.ts`      | 根目录                      | 4-D   | §2.1     |
| `model-routing-enhanced.ts`                                   | 根目录                      | 4-D   | §2.1     |
| `model-routing-roles.ts` + `.test.ts`                         | 根目录                      | 4-D   | §2.1     |
| `model-catalog/`（3 文件）                                    | `model-catalog/`            | 4-D   | §2.17    |
| `pricing-engine.ts` + `.adversarial.test.ts`                  | 根目录                      | 4-D   | §2.1     |
| `token-ledger.ts` + `.test.ts`                                | 根目录                      | 4-D   | §2.1     |
| `media/`（5 文件）                                            | `media/`                    | 4-D   | §2.16    |
| `preview-queue.ts` + `.test.ts` + `.adversarial.test.ts`      | 根目录                      | 4-D   | §2.1     |
| `provider-stream-contract.ts` + `.test.ts`（根文件）          | 根目录                      | 4-D   | §2.1     |
| `stream/index.ts` + `streaming-tool-executor.ts` + `.test.ts` | `stream/`                   | 4-D   | §2.36    |
| `__tests__/exponential-backoff.test.ts`                       | `__tests__/`                | 4-E   | §2.41    |
| `__tests__/integrations/chatgpt-pool.test.ts`                 | `__tests__/integrations/`   | 4-E   | §2.41    |
| `__tests__/integrations/media-pipeline.test.ts`               | `__tests__/integrations/`   | 4-E   | §2.41    |
| `__tests__/integrations/oauth-flow.test.ts`                   | `__tests__/integrations/`   | 4-E   | §2.41    |
| `__tests__/integrations/streaming-executor.test.ts`           | `__tests__/integrations/`   | 4-E   | §2.41    |
| `provider-gateway-edge.test.ts`                               | 根目录                      | 4-E   | §2.1     |
| `provider-gateway.test.ts`                                    | 根目录                      | 4-E   | §2.1     |

**agent-model 小计**：~141 文件（含 provider/ 全部子目录展开）

> **不迁移的文件**（留待 Round 5 迁入 agent-core）：
>
> - `stream/thinking-config.ts` + `.test.ts`（归 agent-core，依据 §2.36）
> - `__tests__/integrations/state-machine.test.ts`（归 agent-core，依据 §2.41）
> - `__tests__/integrations/tool-stream.test.ts`（归 agent-core，依据 §2.41）

### 4.3 agent-mcp 完整化（Agent 4-E）

| 操作 | 文件                                               | Agent | 说明                             |
| ---- | -------------------------------------------------- | ----- | -------------------------------- |
| 修改 | `packages/agent-mcp/package.json`                  | 4-E   | 增加 `@crish/agent-tools` 依赖   |
| 新建 | `packages/agent-mcp/src/register-plugin-server.ts` | 4-E   | `registerPluginServer` 接口骨架  |
| 修改 | `packages/agent-mcp/src/index.ts`                  | 4-E   | 增加 `registerPluginServer` 导出 |

> agent-mcp 的 `mcp-lifecycle/` 目录 + 根文件已在 Round 3 迁移完成，本 Round 不重复迁移。

### 4.4 agent-runtime re-export shim（Agent 4-E）

| 操作 | 文件                                  | 说明                                                                                                     |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 修改 | `packages/agent-runtime/src/index.ts` | 增加 `@crish/agent-tools` / `@crish/agent-model` / `@crish/agent-mcp` 的 re-export + deprecation warning |
| 修改 | `packages/agent-runtime/package.json` | 增加 `@crish/agent-tools` / `@crish/agent-model` / `@crish/agent-mcp` 依赖                               |

---

## 5. 验证门禁

> 依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 与 `01-OVERVIEW.md` §4.3，每轮结束前必须通过以下 8 项检查。

### 5.1 基线建立

Round 4 开始时，Agent 4-E 执行以下命令记录基线：

```bash
# 记录 TSC 错误基线
npx tsc --noEmit 2>&1 | tee round-04-tsc-baseline.json

# 记录依赖图基线
npm run lint:depcruise 2>&1 | tee round-04-depcruise-baseline.json
```

### 5.2 验证检查项

| 序号 | 检查项           | 命令                        | 通过标准                                                               | 责任 Agent |
| ---- | ---------------- | --------------------------- | ---------------------------------------------------------------------- | ---------- |
| 1    | TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ `round-04-tsc-baseline.json`（不恶化，禁令 26）               | 4-E        |
| 2    | Rust 编译        | `cargo check --workspace`   | 0 errors                                                               | 4-E        |
| 3    | 单元测试（TS）   | `npx vitest run`            | 全部通过                                                               | 4-E        |
| 4    | 单元测试（Rust） | `cargo test --workspace`    | 全部通过                                                               | 4-E        |
| 5    | 循环依赖         | `npm run lint:depcruise`    | 0 violations（特别验证 `agent-mcp → agent-tools` 不构成循环）          | 4-E        |
| 6    | 构建             | `npx turbo run build`       | `agent-tools` / `agent-model` / `agent-mcp` / `agent-runtime` 全部成功 | 4-E        |
| 7    | Lint             | `npm run lint`              | 0 errors                                                               | 4-E        |
| 8    | Store 类型       | `npm run check:store-types` | 通过                                                                   | 4-E        |

### 5.3 Round 4 专项验证

除上述 8 项标准检查外，Round 4 须额外验证：

| 序号 | 专项检查                | 验证方法                                                                                       | 通过标准                                                                    |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| S1   | agent-tools 包独立性    | `packages/agent-tools/` 目录存在 + `package.json` 含 `dependencies`                            | `agent-tools` 不依赖 `agent-mcp`（修正后方向）                              |
| S2   | agent-model 包独立性    | `packages/agent-model/` 目录存在 + `provider/` 全部子目录迁移完整                              | 66 文件迁移完成                                                             |
| S3   | agent-mcp 完整化        | `packages/agent-mcp/src/register-plugin-server.ts` 存在 + `package.json` 含 `agent-tools` 依赖 | `registerPluginServer` 可从 `@crish/agent-mcp` 导入                         |
| S4   | ToolMiddleware 3-Hook   | 检查 `agent-tools/src/tools/tool-middleware.ts`                                                | 仅含 `beforeExecute` / `onResult` / `onError`，无 6 阶段洋葱 Hook（禁令 7） |
| S5   | RegisteredTool 三层体系 | 检查 `agent-tools/src/tools/tool-definition.ts`                                                | 含 `ToolDefinition` / `ToolRegistrationOptions` / `RegisteredTool` 三层     |
| S6   | stream-parse 归属       | 检查 `agent-model/src/openai-stream-parse.ts` 等存在                                           | stream-parse 文件在 agent-model，非独立 agent-stream 包（禁令 10）          |
| S7   | 共存策略                | `agent-runtime/src/` 中被迁移文件保留                                                          | 共存阶段不删除源文件（guardrails 禁令 23）                                  |
| S8   | 拓扑层一致              | depcruise 验证依赖边方向                                                                       | 所有依赖边从高层指向低层，无反向边，无循环                                  |

### 5.4 TSC 错误管理

依据 禁令 26：

- **禁止承诺"每轮 TSC 清零"**。拆分过程会引入临时错误（import 路径变更、类型解析延迟等），这是正常的。
- **本 Round 验证标准**：Round 4 结束时 TSC 错误数 ≤ `round-04-tsc-baseline.json` 记录的基线。
- **不恶化判定**：如果基线为 N，Round 4 结束时错误数 ≤ N 即通过。新增的错误（如 `@crish/agent-tools` import 路径未更新）必须被减少的错误（如迁移后类型解析改善）抵消。
- **最终清零目标**：仅在 Round 11 要求 TSC 错误 < 50。完全清零作为后续独立任务。

---

## 6. 交付物

### 6.1 包交付物

| 交付物                         | 路径                                  | 文件数                       | 责任 Agent |
| ------------------------------ | ------------------------------------- | ---------------------------- | ---------- |
| `@crish/agent-tools` 包        | `packages/agent-tools/`               | ~51 源文件 + 4 配置文件      | 4-A, 4-B   |
| `@crish/agent-model` 包        | `packages/agent-model/`               | ~141 源文件 + 4 配置文件     | 4-C, 4-D   |
| `@crish/agent-mcp` 完整化      | `packages/agent-mcp/`                 | 1 新建 + 2 修改              | 4-E        |
| `agent-runtime` re-export shim | `packages/agent-runtime/src/index.ts` | 1 修改 + 1 package.json 修改 | 4-E        |

### 6.2 接口签名交付物

| 接口                      | 包          | 签名                                                                                                                                           | 状态                   |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ToolDefinition`          | agent-tools | `type ToolDefinition = SchemaToolDefinition`（re-export from shared-types）                                                                    | 保留                   |
| `ToolRegistrationOptions` | agent-tools | `interface ToolRegistrationOptions { label?, category?, concurrency?, allowParallel?, fatalOnError?, isReadOnly?, summarize?, inputAliases? }` | 保留                   |
| `RegisteredTool`          | agent-tools | `class RegisteredTool { definition, name, label, description, category, ..., execute }`                                                        | 保留（176 行）         |
| `ToolMiddleware`          | agent-tools | `interface ToolMiddleware { name, beforeExecute?, onResult?, onError? }`                                                                       | 保留（3-Hook，禁令 7） |
| `ToolRegistry`            | agent-tools | `class ToolRegistry { ... }`                                                                                                                   | 保留                   |
| `Engine` / `ProviderDef`  | agent-model | `type Engine = ...` / `type ProviderDef = ...`                                                                                                 | 保留                   |
| `ProviderFactory`         | agent-model | `class ProviderFactory { ... }`                                                                                                                | 保留                   |
| `ProviderRegistry`        | agent-model | `class ProviderRegistryV2Impl { ... }`                                                                                                         | 保留                   |
| `McpLifecycleManager`     | agent-mcp   | `class McpLifecycleManager implements ToolSource { ... }`                                                                                      | 保留                   |
| `registerPluginServer`    | agent-mcp   | `function registerPluginServer(manager, pluginName, declaration): McpServerOperationResult`                                                    | [NEW] 骨架             |
| `PluginMcpDeclaration`    | agent-mcp   | `interface PluginMcpDeclaration { pluginName, serverName, definition }`                                                                        | [NEW]                  |

### 6.3 验证报告交付物

| 报告                               | 内容                                    | 责任 Agent |
| ---------------------------------- | --------------------------------------- | ---------- |
| `round-04-tsc-baseline.json`       | Round 4 开始时的 TSC 错误基线           | 4-E        |
| `round-04-tsc-final.json`          | Round 4 结束时的 TSC 错误               | 4-E        |
| `round-04-depcruise-report.json`   | 循环依赖检查结果                        | 4-E        |
| `round-04-turbo-build-report.json` | 构建结果                                | 4-E        |
| `round-04-verification-report.md`  | 验证报告（8 项标准检查 + 8 项专项检查） | 4-E        |

### 6.4 文档更新交付物

| 文档                      | 更新内容                                                                                   | 依据          |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| `02-FILE-MAPPING.md` §9.2 | 修正 `agent-mcp` 依赖方向（增加 `agent-tools`，移除 `agent-tools → agent-mcp` 的错误记录） | 禁令 31       |
| `01-OVERVIEW.md` §3.2     | 确认 `agent-mcp` 从 Layer 2 演进到 Layer 3                                                 | 本 Round 设计 |

---

## 7. 风险与缓解

| 风险                          | 影响                                                               | 缓解措施                                                                                         | 责任人 |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ |
| import 路径断裂               | agent-runtime 中归 agent-core 的文件引用 tools/provider 时编译失败 | 共存阶段保留 agent-runtime 源文件 + re-export shim（guardrails 禁令 23）                         | 4-E    |
| 循环依赖引入                  | `agent-mcp → agent-tools` 与 `agent-tools → agent-mcp` 同时存在    | 修正依赖方向：仅 `agent-mcp → agent-tools`，`agent-tools` 不依赖 `agent-mcp`。depcruise 门禁验证 | 4-E    |
| TSC 错误恶化                  | 迁移过程中类型解析失败导致错误数增加                               | 每步迁移后运行 `tsc --noEmit` 对比基线；不恶化门禁（禁令 26）                                    | 4-E    |
| 大文件迁移内容丢失            | 27K/30K/24K 文件迁移时内容截断                                     | 迁移后对比文件大小 + 行数；vitest 验证测试通过                                                   | 4-B    |
| provider/ 子目录遗漏          | auth/oauth/ 等 22 文件子目录迁移不完整                             | 引用 `02-FILE-MAPPING.md` §2.23 完整清单，逐项核对                                               | 4-C    |
| registerPluginServer 过度实现 | Round 4 过早实现完整插件注册逻辑                                   | 仅实现骨架（throw not implemented），完整实现推迟到 Round 8（禁令 19）                           | 4-E    |

---

## 8. Round 4 与后续 Round 的衔接

### 8.1 Round 4 → Round 5（agent-core 创建）

Round 5 创建 `agent-core`（Layer 4 top 层），依赖本 Round 创建的全部 middle 层包：

```
agent-core 依赖：
  @crish/agent-context    （Round 3 创建）
  @crish/agent-tools      （Round 4 创建）← 本 Round
  @crish/agent-model      （Round 4 创建）← 本 Round
  @crish/agent-mcp        （Round 4 完整化）← 本 Round
  @crish/agent-permissions （Round 3 创建）
  @crish/logger           （Round 2 创建）
  @crish/telemetry        （Round 2 创建）
```

Round 5 将：

1. 迁移 `agent-runtime` 中归 `agent-core` 的文件（runtime.ts / agent-session-loop.ts / control/ / steering/ / hooks/ 等 ~95 文件）
2. 修复 `agent-runtime` 中归 `agent-core` 文件的 import 路径（指向 `@crish/agent-tools` / `@crish/agent-model`）
3. 完成 `agent-runtime` re-export shim 的最终版本
4. 删除阶段开始（guardrails 禁令 23 第三阶段）

### 8.2 Round 4 → Round 8（plugin-sdk 重建）

Round 8 重建 `plugin-sdk`，依赖本 Round 的 `registerPluginServer` 接口：

```
plugin-sdk 通过 PluginAPI.mcp.registerServer() 调用 agent-mcp 的 registerPluginServer()
```

Round 8 将：

1. 定义 `PluginManifest` 类型（含 `declaredMcpServers: string[]`）
2. 实现 `registerPluginServer` 的完整校验逻辑（manifest 声明比对 + TrustGate 权限校验）
3. 定义 `PluginAPI` 的 `api.mcp.registerServer()` 方法

### 8.3 不迁移到本 Round 的文件

以下文件明确不在 Round 4 迁移，留待后续 Round：

| 文件                                           | 目标包                   | 迁移 Round | 理由                                                      |
| ---------------------------------------------- | ------------------------ | ---------- | --------------------------------------------------------- |
| `stream/thinking-config.ts` + `.test.ts`       | agent-core               | R5         | thinking 配置是运行时关注点（`02-FILE-MAPPING.md` §2.36） |
| `__tests__/integrations/state-machine.test.ts` | agent-core               | R5         | 状态机集成测试归 agent-core（§2.41）                      |
| `__tests__/integrations/tool-stream.test.ts`   | agent-core               | R5         | 运行时工具流归 agent-core（§2.41）                        |
| `__tests__/error-classifier.test.ts`           | agent-core               | R5         | ErrorClassifier 归 agent-core（§2.41）                    |
| `__tests__/steering-input-queue.test.ts`       | agent-core               | R5         | SteeringCoordinator 归 agent-core（§2.41）                |
| `plugin-registry.ts` + `plugin-fs-registry.ts` | plugin-sdk/src/registry/ | R8         | 禁令 10 并入 plugin-sdk                                   |

---

## 9. 附录：Agent 编排时序

```
Round 4 开始
  │
  ├── Agent 4-E：记录 TSC 基线（round-04-tsc-baseline.json）
  │
  ├── [并行] Agent 4-A：创建 agent-tools 包骨架 + 迁移核心工具系统（28 文件）
  ├── [并行] Agent 4-C：创建 agent-model 包骨架 + 迁移 provider/ 核心（66 文件）
  │
  ├── [串行·依赖 4-A] Agent 4-B：迁移 agent-tools 大文件（23 文件）
  ├── [串行·依赖 4-C] Agent 4-D：迁移 agent-model OpenAI/Anthropic/Gemini + Gateway（75 文件）
  │
  ├── [串行·依赖 4-A~4-D] Agent 4-E：
  │   ├── agent-mcp 完整化（registerPluginServer + agent-tools 依赖）
  │   ├── 测试文件迁移（8 文件）
  │   ├── agent-runtime re-export shim 更新
  │   ├── import 路径修复
  │   └── 验证门禁（8 项标准 + 8 项专项）
  │
  └── Round 4 结束 → 生成交付物清单 → Round 5 开始
```

**并行性说明**（依据 禁令 28）：

- Agent 4-A 与 4-C 可并行：操作的文件集完全不相交（tools/ vs provider/），无接口依赖
- Agent 4-B 依赖 4-A（需要 agent-tools 包骨架），必须串行
- Agent 4-D 依赖 4-C（需要 agent-model 包骨架），必须串行
- Agent 4-E 依赖 4-A ~ 4-D 全部完成，必须串行

**协调次数**：

- 4-A：0 次
- 4-B：1 次（依赖 4-A 的包骨架）
- 4-C：0 次
- 4-D：1 次（依赖 4-C 的包骨架）
- 4-E：2 次（依赖 4-A~4-D 的产出 + Round 3 的 agent-mcp 骨架）

全部满足 禁令 28"协调次数 ≤ 2 次"约束。
