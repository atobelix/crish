# Round 3：拆分 Phase-A（leaf 层）

> **本文件**是 Round 3 的详细设计文档，遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12（包拆分边界）、禁令 23-26（迁移策略）、禁令 27-28（Agent 任务量与编排）的约束。
> **文件→包映射**统一引用 `02-FILE-MAPPING.md`，不在本文档内重新定义。
> **依赖关系**统一引用 `02-FILE-MAPPING.md` §9，不在本文档 mermaid 中重新声明边方向。
> **错误码迁移**统一引用 `03-ERROR-MIGRATION.md` §3、§4、§7。

---

## 1. Round 概述

### 1.1 拓扑层说明（为什么先 leaf 层）

v1 方案（`implementation_plan.md`）的致命缺陷是按"业务重要性"排序：先创建 `agent-core`（top 层），导致 `agent-core` 依赖的 `agent-context`/`agent-tools`/`agent-model` 等下层包尚未创建，import 路径全部断裂，无法通过 typecheck。

v2 修正为按**依赖拓扑自底向上**执行：`leaf → middle → top`（参见 `01-OVERVIEW.md` §3.2）。

**Round 3 处于 Layer 2（leaf 层）**，创建 3 个不依赖其他新内部包的目标包：

| 目标包                     | 拓扑层  | 依赖（仅指向已存在/已增强的包）                                  |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `@crish/agent-context`     | Layer 2 | shared-types、shared-utils、@crish/logger、@crish/telemetry      |
| `@crish/agent-permissions` | Layer 2 | shared-types、decision-engine                                    |
| `@crish/agent-mcp`         | Layer 2 | shared-types、shared-utils（**不依赖** agent-tools/agent-model） |

依赖关系实证见 `02-FILE-MAPPING.md` 禁令 23：

- `mcp-lifecycle/mcp-lifecycle-manager.ts` 仅 import `../types`（拆分后入 shared-types）+ `@crish/shared-utils`，不依赖 agent-tools/agent-model。
- `tools/tool-definition.ts` 仅 import `@crish/shared-types`，但 `tools/` 目录归 `agent-tools`（middle 层，Round 4 创建），不在 Round 3 范围。

**为什么 leaf 层必须先于 middle 层**：

- middle 层（`agent-tools`、`agent-model`）在 Round 4 创建时将依赖 `agent-context`（参见 `02-FILE-MAPPING.md` §9.2：`agent-tools → agent-context`、`agent-model → agent-context`）。
- 若 `agent-context` 未在 Round 3 先建好，Round 4 创建 `agent-tools` 时 import 路径无可指向，typecheck 失败。
- 这是拓扑约束的硬性要求，不可绕过（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 严格拓扑顺序）。

### 1.2 目标包

| 目标包                     | 拓扑层               | 创建方式              | 文件来源                                                       | 文件数（约）                         |
| -------------------------- | -------------------- | --------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `@crish/agent-context`     | Layer 2 (leaf)       | 新建包 + 大规模迁移   | `02-FILE-MAPPING.md` §2.1 / §2.4 / §2.6 / §2.8 / §2.31 / §2.33 | ~45（含测试）                        |
| `@crish/agent-permissions` | Layer 2 (leaf)       | 新建包 + 中等规模迁移 | `02-FILE-MAPPING.md` §2.1 / §2.3 / §2.20                       | ~6（不含 command-classification.ts） |
| `@crish/agent-mcp`         | Layer 2 (leaf，骨架) | 新建包 + 小规模迁移   | `02-FILE-MAPPING.md` §2.1 / §2.15                              | ~7                                   |

**agent-mcp 标注"骨架"**的含义：

- Round 3 完成 `mcp-lifecycle/` 目录全部文件迁移 + `mcp-lifecycle.ts` 根文件迁移，包结构完整可用。
- "骨架"指**未实现 `registerPluginServer(pluginName, declaration)` 入口**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10、禁令 13，`plugin-mcp` 并入 `agent-mcp`，但具体实现推迟到 Round 8 plugin-sdk 重建时）。
- Round 4 在 `agent-mcp` 增加对 `agent-tools` 类型的引用（通过 shared-types 间接引用，不直接依赖 agent-tools 包）。

### 1.3 交付物清单

| 类别        | 交付物                                                                                                                                    | 责任 Agent |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 包骨架      | `packages/agent-context/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`                                                 | 3-A        |
| 包骨架      | `packages/agent-permissions/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`                                             | 3-C        |
| 包骨架      | `packages/agent-mcp/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`                                                     | 3-D        |
| 文件迁移    | `agent-context/src/` 完整目录结构（context-compression、checkpoint、session、session-store、event-architecture/canonical-event 等子目录） | 3-A + 3-B  |
| 文件迁移    | `agent-permissions/src/` 完整目录结构（approval/、permission/trust-zone-policy.ts、secrets-obfuscation.ts 等）                            | 3-C        |
| 文件迁移    | `agent-mcp/src/` 完整目录结构（mcp-lifecycle/、mcp-lifecycle.ts）                                                                         | 3-D        |
| 接口预留    | `agent-mcp/src/plugin-server.ts`：`registerPluginServer(pluginName, declaration)` 类型签名（不实现）                                      | 3-D        |
| import 接线 | `agent-runtime/src/` 中被迁移文件保留 re-export shim，import 路径指向新包                                                                 | 3-E        |
| 类型下沉    | `agent-runtime/src/types.ts` 中 `AgentTool`/`ToolSource` 等纯类型迁入 `shared-types/src/tool.ts`（参见 `02-FILE-MAPPING.md` §2.2）        | 3-E        |
| 验证报告    | `tsc-errors-baseline-r3.json`（轮次开始基线）+ `tsc-errors-after-r3.json`（轮次结束基线） + depcruise 报告 + turbo build 报告             | 3-E        |
| 边界声明    | `agent-permissions/src/index.ts` 的 JSDoc 注释明确与 decision-engine 的边界（`02-FILE-MAPPING.md` §2.20）                                 | 3-C        |

---

## 2. Agent 任务详细设计

### 2.1 Agent 3-A：agent-context 核心文件迁移

**职责**：创建 `@crish/agent-context` 包骨架 + 迁移 context 域核心文件（context-compression、checkpoint、blob、encoding、conversation-boundary）。

**输入**：

- `02-FILE-MAPPING.md` §2.1 / §2.4 / §2.6 的文件归属判定。
- `01-OVERVIEW.md` §3.2 拓扑层级（agent-context 位于 Layer 2）。
- `01-OVERVIEW.md` §1.3 资产清单（context-compression 已确认为高质量工作代码）。

**任务步骤**：

1. **创建包骨架**：
   - 新建 `packages/agent-context/package.json`（详见 §3.1）。
   - 新建 `packages/agent-context/tsconfig.json` + `tsconfig.build.json`（参照 `packages/agent-runtime/tsconfig.json` 的写法，`extends: ../../tsconfig.base.json`，`composite: true`）。
   - 新建 `packages/agent-context/src/index.ts` 作为 barrel，初始仅导出已迁移的模块。

2. **迁移 `context-compression/` 目录**（参见 `02-FILE-MAPPING.md` §2.6，5 文件）：
   - `context-compression/compression-utils.ts` + `.test.ts`
   - `context-compression/index.ts`
   - `context-compression/serializer.ts`
   - `context-compression/token-estimator.ts`
   - 迁入路径：`packages/agent-context/src/context-compression/`

3. **迁移 `checkpoint/` 目录**（参见 `02-FILE-MAPPING.md` §2.4，2 文件）：
   - `checkpoint/checkpoint-manager.ts`
   - `checkpoint/index.ts`
   - 迁入路径：`packages/agent-context/src/checkpoint/`

4. **迁移根目录的 context 域文件**（参见 `02-FILE-MAPPING.md` §2.1，11 文件，含测试）：
   - `context-compression.ts` + `.test.ts`
   - `context-projection.ts` + `.test.ts`
   - `context-slicer.ts`（无独立测试文件，由 `__tests__/context-slicer.test.ts` 覆盖，该集成测试随 §4.x 迁移到 agent-context）
   - `context-state.ts` + `.test.ts`
   - `checkpoint-manifest.ts`（27K）+ `.test.ts`
   - `checkpoints.ts` + `.test.ts`
   - `conversation-boundary-manifest.ts`（27K）+ `.test.ts`
   - `conversation-rewind-target.ts` + `.test.ts`
   - `blob-externalization.ts`（12K）+ `.test.ts`
   - `encoding.ts` + `.test.ts`

   迁入路径：`packages/agent-context/src/`（根目录平迁，保持原文件名）。

5. **更新 import 路径**：
   - 被迁移文件内部的相对 import 保持不变（目录结构平迁，相对路径仍然有效）。
   - 若被迁移文件 import `../types`（AgentTool/ToolSource 等），改为 `@crish/shared-types`（这些类型已在 Round 3 由 Agent 3-E 下沉到 shared-types，详见 §2.5）。
   - 若被迁移文件 import `@crish/shared-utils` / `@crish/shared-types` / `@crish/logger` / `@crish/telemetry`，路径不变。
   - 若被迁移文件 import 其他根目录文件（如 `./session`、`./memory`），这些文件由 Agent 3-B 同步迁移，路径保持相对引用。

6. **更新 `packages/agent-context/src/index.ts` barrel**：
   - 显式命名导出已迁移的公共符号（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24，禁止 `export * from`）。
   - 当前阶段仅导出 3-A 迁移的文件，3-B 完成后由 3-B 追加导出。

**输出**：

- `packages/agent-context/src/context-compression/` 目录（5 文件）
- `packages/agent-context/src/checkpoint/` 目录（2 文件）
- `packages/agent-context/src/` 根目录文件（11 文件 + 测试，含 27K 的 checkpoint-manifest.ts 与 conversation-boundary-manifest.ts）
- `packages/agent-context/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`
- 变更量预估：≥ 18 文件迁移 + 4 包配置 = 22 文件操作，远超 ≥ 5 文件门槛（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 28）。

**验证闭环**：

- `npx tsc -p packages/agent-context --noEmit` 通过（依赖包 shared-types/shared-utils/@crish/logger/@crish/telemetry 已在 R1/R2 就绪）。
- 已迁移文件无 `import '../...'`（指向 agent-runtime 残留路径）的断裂引用。

---

### 2.2 Agent 3-B：agent-context session/snapshots/大文件迁移

**职责**：在 Agent 3-A 创建的包骨架基础上，迁移 session、session-store、prompt、canonical-schema、wasm-tiktoken、structured-summary、memory、scoped-context、canonical-event 等剩余文件，完成 `@crish/agent-context` 的完整结构。

**输入**：

- Agent 3-A 的产出（`packages/agent-context/` 包骨架 + 已迁移的 context-compression/checkpoint/根文件）。
- `02-FILE-MAPPING.md` §2.1 / §2.8 / §2.31 / §2.33 的文件归属判定。
- `02-FILE-MAPPING.md` §3 第 6 项边界判定：`event-architecture/canonical-event.ts` 归 `agent-context`（若归 agent-core，agent-context 将反向依赖 top 层，违反拓扑）。

**任务步骤**：

1. **迁移 `session/` 目录**（参见 `02-FILE-MAPPING.md` §2.31，3 文件）：
   - `session/session-replay.ts`
   - `session/session-storage.ts`
   - `session/session-types.ts`
   - 迁入路径：`packages/agent-context/src/session/`

2. **迁移 `session-store/` 目录**（参见 `02-FILE-MAPPING.md` §2.33，3 文件）：
   - `session-store/archive-store.ts`
   - `session-store/index.ts`（14K）
   - `session-store/types.ts`
   - 迁入路径：`packages/agent-context/src/session-store/`

3. **迁移 `event-architecture/` 目录**（参见 `02-FILE-MAPPING.md` §2.8，3 文件）：
   - `event-architecture/canonical-event.ts` + `.test.ts`
   - `event-architecture/index.ts`
   - 迁入路径：`packages/agent-context/src/event-architecture/`

4. **迁移根目录的剩余 context 域文件**（参见 `02-FILE-MAPPING.md` §2.1，约 25 文件，含测试）：
   - `ISessionStore.ts`（Session Store 契约，与 session-store/ 实现同包）
   - `session.ts` + `.test.ts`
   - `snapshots.ts` + `.test.ts`
   - `prompt-assembly.ts`（19K）+ `.test.ts`
   - `prompt-context.ts` + `.test.ts`
   - `canonical-schema.ts`
   - `wasm-tiktoken.ts`
   - `structured-summary.ts` + `.test.ts`
   - `trajectory-compressor.ts`
   - `memory.ts` + `.test.ts`
   - `scoped-context.ts` + `.test.ts`
   - `scoped-context-resources.ts` + `.test.ts`
   - `goal-disk-oracle.ts` + `.test.ts`
   - `response-style.ts` + `.test.ts`
   - `doctor-report.ts`
   - `agent-context.ts`（上下文聚合入口）
   - `payload-image-recovery.ts` + `.test.ts`
   - `project-progress-ledger.ts` + `.test.ts`

   迁入路径：`packages/agent-context/src/`（根目录平迁）。

5. **迁移 `__tests__/` 中的相关集成测试**（参见 `02-FILE-MAPPING.md` §2.41）：
   - `__tests__/canonical-schema.test.ts` → `packages/agent-context/src/__tests__/canonical-schema.test.ts`
   - `__tests__/context-slicer.test.ts` → `packages/agent-context/src/__tests__/context-slicer.test.ts`

6. **更新 import 路径**：
   - 同 Agent 3-A 第 5 步的策略：相对 import 保持，跨包 import 改指向 `@crish/*`。
   - 若 import `./types`（AgentTool/ToolSource），改为 `@crish/shared-types`（依赖 Agent 3-E 的同步推进，见 §2.5 协调点）。
   - 若 import `./subagents` 或 `./runtime` 等 middle/top 层文件（如 `project-progress-ledger.ts` 被 `subagents.ts` 引用，但本项目是反向：被迁移文件本身不 import subagents/runtime，只被这些文件 import），不需要反向修改；这些跨层引用由 Agent 3-E 在 `agent-runtime` 侧通过 re-export shim 接线处理。

7. **更新 `packages/agent-context/src/index.ts` barrel**：
   - 在 Agent 3-A 的基础上追加本次迁移的公共符号导出。
   - 仍然遵循显式命名导出，禁止 `export * from`。

**协调点**（与 Agent 3-E）：

- Agent 3-B 完成后，`agent-runtime` 中被引用的 context 域文件（如 `./session`、`./memory`、`./project-progress-ledger`、`./context-state` 等）需要由 Agent 3-E 在原位置创建 re-export shim，指向 `@crish/agent-context`。参见 §2.5 的协调机制。

**输出**：

- `packages/agent-context/src/session/` 目录（3 文件）
- `packages/agent-context/src/session-store/` 目录（3 文件）
- `packages/agent-context/src/event-architecture/` 目录（3 文件）
- `packages/agent-context/src/__tests__/` 目录（2 集成测试文件）
- `packages/agent-context/src/` 根目录追加文件（约 25 文件）
- 变更量预估：≥ 36 文件迁移，远超门槛。

**验证闭环**：

- `npx tsc -p packages/agent-context --noEmit` 通过。
- `agent-context/src/index.ts` 导出的公共符号清单覆盖 `02-FILE-MAPPING.md` §2 中归属 agent-context 的所有非测试文件。

---

### 2.3 Agent 3-C：agent-permissions 创建 + 迁移

**职责**：创建 `@crish/agent-permissions` 包 + 迁移 approval、permission（trust-zone-policy 部分）、secrets-obfuscation 等运行时信任执行文件。明确与 decision-engine 的边界（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12）。

**输入**：

- `02-FILE-MAPPING.md` §2.1 / §2.3 / §2.20 的文件归属判定。
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12 边界切线规则。
- `03-ERROR-MIGRATION.md` §7.2 中 R3 的 throw 迁移清单（agent-permissions 约 5 处 throw → `plugin.permission_denied` / `approval.timeout` / `approval.rejected`）。

**任务步骤**：

1. **创建包骨架**：
   - 新建 `packages/agent-permissions/package.json`（详见 §3.2）。
   - 新建 `packages/agent-permissions/tsconfig.json` + `tsconfig.build.json`。
   - 新建 `packages/agent-permissions/src/index.ts` 作为 barrel。

2. **迁移 `approval/` 目录**（参见 `02-FILE-MAPPING.md` §2.3，4 文件）：
   - `approval/approval-cache.ts` + `.test.ts`
   - `approval/approval-pipeline.ts`
   - `approval/chain-approval.ts`
   - 迁入路径：`packages/agent-permissions/src/approval/`

3. **迁移 `permission/` 目录的 trust-zone-policy 部分**（参见 `02-FILE-MAPPING.md` §2.20，2 文件）：
   - `permission/trust-zone-policy.ts` + `.test.ts`
   - 迁入路径：`packages/agent-permissions/src/permission/trust-zone-policy.ts`
   - **关键约束**：`permission/command-classification.ts` **不迁移**，留在 `decision-engine`（禁令 12：纯决策逻辑，无运行时状态）。Agent 3-C 在 `packages/agent-permissions/src/permission/index.ts` 中通过 `export { classifyCommand } from '@crish/decision-engine'` re-export 分类结果（如果 agent-permissions 内部代码需要分类结果），保持单向依赖：`agent-permissions → decision-engine`。

4. **迁移根目录文件**（参见 `02-FILE-MAPPING.md` §2.1，2 文件）：
   - `secrets-obfuscation.ts`（30K）+ `.test.ts`
   - `permissions.test.ts`
   - 迁入路径：`packages/agent-permissions/src/`

5. **更新 import 路径**：
   - 被迁移文件若 import `./permission/command-classification`，改为 `@crish/decision-engine`（参见 §3.2 的边界说明）。
   - 被迁移文件若 import `./types`（permission 相关类型），改指向 `@crish/shared-types`（permission 类型已下沉，参见 `02-FILE-MAPPING.md` §2.2）。
   - 被迁移文件若 import `@crish/shared-types` / `@crish/decision-engine`，路径不变。

6. **更新 barrel 与边界声明**：
   - `packages/agent-permissions/src/index.ts` 显式导出 `approval-pipeline`、`trust-zone-policy`、`secrets-obfuscation`、`approval-cache`、`chain-approval` 的公共符号。
   - 在 `index.ts` 顶部添加 JSDoc 注释，明确边界（见 §3.2 的边界声明模板）。

7. **同步迁移 throw 调用点**（依据 `03-ERROR-MIGRATION.md` §7.2）：
   - `secrets-obfuscation.ts` 中的 throw 点（如有）→ `tool.path_escape` 或 `plugin.permission_denied`。
   - `approval-pipeline.ts` 中的 throw 点（如有）→ `approval.timeout` / `approval.rejected`。
   - 严格遵循三阶段策略（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）：本 Round 处于共存阶段后期/迁移阶段早期，允许保留旧 throw 与新 CrishError 并存，但每个被迁移文件至少完成 1 处 throw 的 CrishError 化作为示范。

**输出**：

- `packages/agent-permissions/src/approval/` 目录（4 文件）
- `packages/agent-permissions/src/permission/trust-zone-policy.ts` + `.test.ts`（2 文件）
- `packages/agent-permissions/src/secrets-obfuscation.ts` + `.test.ts`（2 文件）
- `packages/agent-permissions/src/permissions.test.ts`（1 文件）
- `packages/agent-permissions/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`
- 变更量预估：≥ 9 文件迁移 + 4 包配置 = 13 文件操作（满足门槛）。

**验证闭环**：

- `npx tsc -p packages/agent-permissions --noEmit` 通过。
- `grep -r "command-classification" packages/agent-permissions/src/` 应仅在 `index.ts` 的 re-export 行出现（如果存在），不在内部实现代码中重复分类逻辑。
- `grep -r "command-classification" packages/decision-engine/src/` 应保留原 `command-classification.ts` 文件。

---

### 2.4 Agent 3-D：agent-mcp 骨架创建 + 迁移

**职责**：创建 `@crish/agent-mcp` 包 + 迁移 mcp-lifecycle 目录与根文件 + 预留 `registerPluginServer` 接口（不实现）。

**输入**：

- `02-FILE-MAPPING.md` §2.1 / §2.15 的文件归属判定。
- `02-FILE-MAPPING.md` 禁令 23 的 import 验证结论（agent-mcp 仅依赖 shared-types + shared-utils，不依赖 agent-tools/agent-model）。
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10（plugin-mcp 并入 agent-mcp，增加 registerPluginServer 入口）。
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10（MCP 集成通过 `agent-mcp` 的 `registerPluginServer(pluginName, declaration)` 入口实现）。

**任务步骤**：

1. **创建包骨架**：
   - 新建 `packages/agent-mcp/package.json`（详见 §3.3，**仅声明 shared-types + shared-utils 依赖**）。
   - 新建 `packages/agent-mcp/tsconfig.json` + `tsconfig.build.json`。
   - 新建 `packages/agent-mcp/src/index.ts` 作为 barrel。

2. **迁移 `mcp-lifecycle/` 目录**（参见 `02-FILE-MAPPING.md` §2.15，6 文件）：
   - `mcp-lifecycle/mcp-lifecycle-manager.ts`（12K）
   - `mcp-lifecycle/mcp-server-controller.ts`（17K）+ `.test.ts`
   - `mcp-lifecycle/types.ts`
   - `mcp-lifecycle/utils.ts`
   - `mcp-lifecycle/index.ts`
   - 迁入路径：`packages/agent-mcp/src/mcp-lifecycle/`

3. **迁移根文件**（参见 `02-FILE-MAPPING.md` §2.1，2 文件）：
   - `mcp-lifecycle.ts` + `.test.ts`
   - 迁入路径：`packages/agent-mcp/src/`

4. **更新 import 路径**：
   - `mcp-lifecycle-manager.ts` 原 import `../types`（即 `agent-runtime/src/types.ts` 中的 AgentTool/ToolSource）→ 改为 `@crish/shared-types`（依赖 Agent 3-E 同步下沉类型，见 §2.5 协调点）。
   - `mcp-server-controller.ts` 原 import `../types`（同上）+ `@crish/shared-types`（JsonObject, ToolExecutionContext, ToolOutput）+ `@crish/shared-utils`（errorMessage, RingBuffer）→ 仅修改 `../types` 那一处，其余不变。
   - 验证迁移后 `grep -r "from '@crish/agent-tools'" packages/agent-mcp/src/` 输出为空（依赖最小化的硬性验证）。
   - 验证迁移后 `grep -r "from '@crish/agent-model'" packages/agent-mcp/src/` 输出为空。

5. **预留 `registerPluginServer` 接口**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10）：
   - 新建 `packages/agent-mcp/src/plugin-server.ts`。
   - 仅声明类型签名，**不实现**（实现推迟到 Round 8 plugin-sdk 重建时）。
   - 类型签名（见 §3.3 的接口定义）。
   - 在 `packages/agent-mcp/src/index.ts` 中导出 `registerPluginServer` 的类型声明。

6. **更新 barrel**：
   - `packages/agent-mcp/src/index.ts` 显式导出：
     - `McpLifecycleManager`、`McpServerController`（来自 `./mcp-lifecycle`）
     - `registerPluginServer` 的类型签名（来自 `./plugin-server`，仅类型导出）

**输出**：

- `packages/agent-mcp/src/mcp-lifecycle/` 目录（6 文件）
- `packages/agent-mcp/src/mcp-lifecycle.ts` + `.test.ts`（2 文件）
- `packages/agent-mcp/src/plugin-server.ts`（1 文件，仅类型签名）
- `packages/agent-mcp/{package.json, tsconfig.json, tsconfig.build.json, src/index.ts}`
- 变更量预估：≥ 8 文件迁移 + 5 包配置/新增 = 13 文件操作（满足门槛）。

**验证闭环**：

- `npx tsc -p packages/agent-mcp --noEmit` 通过。
- `cat packages/agent-mcp/package.json | grep -E "agent-(tools|model|core|context|permissions)"` 输出为空（依赖最小化验证）。
- `grep -r "from '@crish/agent-" packages/agent-mcp/src/` 仅出现 `@crish/shared-types` 与 `@crish/shared-utils`。

---

### 2.5 Agent 3-E：依赖接线 + TSC 修复 + 验证

**职责**：在 3-A/3-B/3-C/3-D 完成迁移后，处理 `agent-runtime` 侧的 import 接线、types.ts 类型下沉、re-export shim、TSC 错误回归、验证门禁执行。

**输入**：

- Agent 3-A/3-B/3-C/3-D 的产出（3 个新包 + 已迁移文件）。
- `02-FILE-MAPPING.md` §2.2 的 types.ts 拆分说明。
- `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24（Legacy Shim 约束）+ 禁令 26（TSC 错误管理）。
- `01-OVERVIEW.md` §6 的基线文件清单。

**任务步骤**：

1. **记录 Round 3 开始基线**（在 3-A 启动前完成）：
   - 执行 `npx tsc --noEmit -p packages/agent-runtime 2> tsc-errors-baseline-r3-start.json`。
   - 记录错误总数与按错误码分布。该值作为 Round 3 结束时"不恶化"门禁的基准。

2. **执行 types.ts 类型下沉**（参见 `02-FILE-MAPPING.md` §2.2）：
   - 将 `agent-runtime/src/types.ts` 中的 `AgentTool`/`ToolSource`/`AgentProvider` 等纯类型定义迁入 `shared-types/src/tool.ts`（如果 shared-types/src/tool.ts 已存在则追加，否则新建；具体清单以 `02-FILE-MAPPING.md` §2.2 表为准）。
   - 在 `agent-runtime/src/types.ts` 保留 re-export：`export type { AgentTool, ToolSource, ... } from '@crish/shared-types'`（共存阶段，向后兼容）。
   - 同步更新 `packages/agent-context/src/`、`packages/agent-permissions/src/`、`packages/agent-mcp/src/` 中已迁移文件的 import：`from '../types'` → `from '@crish/shared-types'`。
   - 不删除 `agent-runtime/src/types.ts`（删除阶段在 Round 12，依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23）。

3. **在 `agent-runtime/src/` 创建 re-export shim**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 24）：
   - 对每个被迁移到 agent-context/agent-permissions/agent-mcp 的根文件，在原位置创建 shim 文件：
     - 例：`agent-runtime/src/session.ts` 内容改为 `export * from '@crish/agent-context'; export { ... } from '@crish/agent-context';`（使用显式命名导出，禁止 `export * from`）。
     - 例：`agent-runtime/src/mcp-lifecycle.ts` 内容改为 `export { McpLifecycleManager, McpServerController } from '@crish/agent-mcp';`。
     - 例：`agent-runtime/src/secrets-obfuscation.ts` 内容改为 `export { ... } from '@crish/agent-permissions';`。
   - 对子目录的 shim：在 `agent-runtime/src/approval/index.ts`、`agent-runtime/src/mcp-lifecycle/index.ts` 等位置创建 re-export shim。
   - 每个 shim 添加 deprecation warning：
     ```ts
     if (process.env.NODE_ENV !== 'production') {
       console.warn(
         '[deprecated] @crish/agent-runtime is deprecated, import from @crish/agent-context directly'
       );
     }
     ```
   - 这些 shim 为 Round 5 的 legacy shim 做准备（Round 5 在 `agent-runtime/src/index.ts` 改为完整 barrel shim）。

4. **更新 `agent-runtime` 中跨层引用的 import 路径**：
   - `agent-runtime/src/subagents.ts` 原 import `./runtime`（保留，runtime 还在 agent-runtime 内，Round 5 才迁出）。
   - `agent-runtime/src/subagents.ts` 原 import `./session`、`./project-progress-ledger`、`./context-state` 等 → 改为 `@crish/agent-context`（因为这些文件已被迁移，原路径的 shim 也存在，但鼓励直接引用新包）。
   - 同理处理 `agent-runtime/src/runtime.ts`、`agent-runtime/src/agent-session-loop.ts` 等顶层文件中指向被迁移文件的 import。
   - **决策**：优先改为 `@crish/agent-context` 直接引用，shim 仅作为兜底（避免 deprecated warning 在内部代码中频繁触发）。

5. **修复因迁移产生的 TSC 错误**：
   - 依据 `tsc-errors-after-r3.json` 与 `tsc-errors-baseline-r3-start.json` 的 diff，识别新增错误。
   - 常见错误类型：
     - `TS2307 Cannot find module '@crish/agent-context'`：检查 `agent-runtime/package.json` 的 dependencies 是否添加新包。
     - `TS2305 Module has no exported member 'X'`：检查新包 barrel 是否导出该符号。
     - `TS2459 Module declares 'X' locally but it is not exported`：shim 文件的 re-export 链断裂。
   - **不恶化门禁**（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26）：Round 3 结束时 TSC 错误数 ≤ Round 3 开始时的基线。允许引入临时错误，但最终必须回归。
   - 在 `agent-runtime/package.json` 的 dependencies 中添加：
     ```json
     "dependencies": {
       "@crish/agent-context": "*",
       "@crish/agent-permissions": "*",
       "@crish/agent-mcp": "*",
       "@crish/decision-engine": "*",
       "@crish/shared-types": "*"
     }
     ```

6. **运行 8 项验证门禁**（参见 §5）：
   - TypeScript 编译：`npx tsc --noEmit`，错误数 ≤ baseline。
   - Rust 编译：`cargo check --workspace`，0 errors。
   - 单元测试（TS）：`npx vitest run`，全部通过（或失败数 ≤ baseline，遵循不恶化原则）。
   - 单元测试（Rust）：`cargo test --workspace`，全部通过。
   - 循环依赖：`npm run lint:depcruise`，0 violations。
   - 构建：`npx turbo run build`，全部成功。
   - Lint：`npm run lint`，0 errors。
   - Store 类型：`npm run check:store-types`，通过。

7. **生成验证报告**：
   - `analysis/iterative-repair/v2/round-03-validation-report.md`（可选，由 Agent 3-E 在验证完成后生成）。
   - 报告内容：
     - TSC 错误数变化（baseline → after）。
     - depcruise 报告摘要（验证无循环依赖）。
     - turbo build 摘要（3 个新包独立构建成功）。
     - 3 个新包的依赖关系实测验证（`npm ls @crish/agent-tools --workspace=@crish/agent-mcp` 应输出"not installed"）。

**协调点**（与 Agent 3-A/3-B/3-C/3-D）：

- Agent 3-E 的 types.ts 下沉步骤（第 2 步）必须在 3-A/3-B/3-C/3-D 迁移文件前**部分启动**：3-A/3-B/3-C/3-D 迁移文件时若 import `../types`，需要 3-E 已把 types.ts 的纯类型迁到 shared-types，否则被迁移文件会编译失败。
- **协调方案**：Agent 3-E 的第 1-2 步（基线记录 + types.ts 下沉）**先于** 3-A/3-B/3-C/3-D 启动，3-A/3-B/3-C/3-D 在 3-E 完成类型下沉后并行启动迁移。这是隐性的串行依赖，依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 必须显式声明。
- Agent 3-E 的第 3-7 步在 3-A/3-B/3-C/3-D 全部完成后执行。

**输出**：

- `tsc-errors-baseline-r3-start.json`（轮次开始基线）
- `tsc-errors-after-r3.json`（轮次结束基线）
- `agent-runtime/src/types.ts`（保留 re-export shim，指向 shared-types）
- `agent-runtime/src/` 下的 re-export shim 文件（覆盖所有被迁移的根文件 + 子目录 index.ts）
- `agent-runtime/package.json` 更新 dependencies
- 验证报告（如生成）
- 变更量预估：≥ 30 个 shim 文件 + package.json 更新 + types.ts 下沉 = 远超门槛。

**验证闭环**：

- 全部 8 项门禁通过（或回归到 baseline 内）。
- `npx turbo run build --filter=@crish/agent-context` 成功。
- `npx turbo run build --filter=@crish/agent-permissions` 成功。
- `npx turbo run build --filter=@crish/agent-mcp` 成功。

---

## 3. 各包设计详细

### 3.1 @crish/agent-context

#### 3.1.1 package.json

```json
{
  "name": "@crish/agent-context",
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
    "build:types": "node -e \"require('node:fs').rmSync('../../node_modules/.cache/agent-context.tsbuildinfo', { force: true })\" && tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false && tsc-alias -p tsconfig.build.json --resolve-full-paths",
    "build:js": "esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap",
    "build": "npm run clean && npm run build:types && npm run build:js"
  },
  "dependencies": {
    "@crish/shared-types": "0.1.0",
    "@crish/shared-utils": "0.1.0",
    "@crish/logger": "0.1.0",
    "@crish/telemetry": "0.1.0"
  }
}
```

**依赖说明**（依据 `02-FILE-MAPPING.md` §9.2）：

- `@crish/shared-types`：基础类型（AgentTool/ToolSource 在 Round 3 下沉后）+ CrishError/CrishResult/CrishErrorPayload（Round 1 已就绪）。
- `@crish/shared-utils`：AsyncSemaphore、RingBuffer 等基础设施（path-handling 在 Round 2 已迁入）。
- `@crish/logger`：结构化 Logger（Round 2 已就绪）。
- `@crish/telemetry`：TraceManager + AsyncLocalStorage（Round 2 已就绪）。
- **不依赖** decision-engine、agent-tools、agent-model、agent-core、agent-permissions、agent-mcp（leaf 层独立性）。

#### 3.1.2 目录结构

```
packages/agent-context/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md（可选，仅当 Agent 需要记录设计决策时创建）
└── src/
    ├── index.ts                            # barrel（显式命名导出）
    ├── agent-context.ts                    # 上下文聚合入口
    ├── ISessionStore.ts                    # Session Store 契约
    ├── blob-externalization.ts             # blob 外部化
    ├── blob-externalization.test.ts
    ├── canonical-schema.ts                 # 规范 schema
    ├── checkpoint-manifest.ts              # 27K
    ├── checkpoint-manifest.test.ts
    ├── checkpoints.ts
    ├── checkpoints.test.ts
    ├── context-compression.ts
    ├── context-compression.test.ts
    ├── context-projection.ts
    ├── context-projection.test.ts
    ├── context-slicer.ts
    ├── conversation-boundary-manifest.ts   # 27K
    ├── conversation-boundary-manifest.test.ts
    ├── conversation-rewind-target.ts
    ├── conversation-rewind-target.test.ts
    ├── doctor-report.ts
    ├── encoding.ts
    ├── encoding.test.ts
    ├── goal-disk-oracle.ts
    ├── goal-disk-oracle.test.ts
    ├── memory.ts
    ├── memory.test.ts
    ├── payload-image-recovery.ts
    ├── payload-image-recovery.test.ts
    ├── project-progress-ledger.ts
    ├── project-progress-ledger.test.ts
    ├── prompt-assembly.ts                  # 19K
    ├── prompt-assembly.test.ts
    ├── prompt-context.ts
    ├── prompt-context.test.ts
    ├── response-style.ts
    ├── response-style.test.ts
    ├── session.ts
    ├── session.test.ts
    ├── snapshots.ts
    ├── snapshots.test.ts
    ├── structured-summary.ts
    ├── structured-summary.test.ts
    ├── trajectory-compressor.ts
    ├── wasm-tiktoken.ts
    ├── scoped-context.ts
    ├── scoped-context.test.ts
    ├── scoped-context-resources.ts
    ├── scoped-context-resources.test.ts
    ├── checkpoint/                         # checkpoint 子目录
    │   ├── checkpoint-manager.ts
    │   └── index.ts
    ├── context-compression/                # context-compression 子目录
    │   ├── compression-utils.ts
    │   ├── compression-utils.test.ts
    │   ├── index.ts
    │   ├── serializer.ts
    │   └── token-estimator.ts
    ├── event-architecture/                # canonical-event 域
    │   ├── canonical-event.ts
    │   ├── canonical-event.test.ts
    │   └── index.ts
    ├── session/                            # session 域
    │   ├── session-replay.ts
    │   ├── session-storage.ts
    │   └── session-types.ts
    ├── session-store/                      # session-store 域
    │   ├── archive-store.ts
    │   ├── index.ts                        # 14K
    │   └── types.ts
    └── __tests__/                          # 集成测试
        ├── canonical-schema.test.ts
        └── context-slicer.test.ts
```

#### 3.1.3 导出接口

`src/index.ts` barrel 的公共导出清单（遵循显式命名导出，禁止 `export * from`）：

```ts
// packages/agent-context/src/index.ts
export type { ISessionStore } from './ISessionStore';
export {
  createContextAggregator,
  type ContextAggregatorOptions,
} from './agent-context';
export {
  externalizeBlob,
  internalizeBlob,
  type BlobExternalizationResult,
} from './blob-externalization';
export {
  validateCanonicalSchema,
  type CanonicalSchema,
} from './canonical-schema';
export {
  CheckpointManager,
  type CheckpointManifest,
  type CheckpointEntry,
} from './checkpoint';
export {
  loadCheckpointManifest,
  saveCheckpointManifest,
} from './checkpoint-manifest';
export { compressContext, type CompressionResult } from './context-compression';
export { projectContext, type ProjectionResult } from './context-projection';
export { sliceContext } from './context-slicer';
export { InMemoryContextState, type ContextState } from './context-state';
export {
  validateConversationBoundary,
  type ConversationBoundaryManifest,
} from './conversation-boundary-manifest';
export {
  createRewindTarget,
  type RewindTarget,
} from './conversation-rewind-target';
export { detectEncoding } from './encoding';
export { DiskOracle, type DiskOracleResult } from './goal-disk-oracle';
export { MemoryStore, type MemoryEntry } from './memory';
export { recoverPayloadImage } from './payload-image-recovery';
export { ProjectProgressLedger } from './project-progress-ledger';
export { assemblePrompt, type PromptAssemblyResult } from './prompt-assembly';
export { buildPromptContext, type PromptContext } from './prompt-context';
export { getResponseStyle, type ResponseStyle } from './response-style';
export { generateDoctorReport, type DoctorReport } from './doctor-report';
export { SessionReplay, type ReplayEntry } from './session';
export { SessionStorage, type SessionRecord } from './session';
export { SessionStore, type SessionStoreOptions } from './session-store';
export { createSnapshot, restoreSnapshot, type Snapshot } from './snapshots';
export {
  buildStructuredSummary,
  type StructuredSummary,
} from './structured-summary';
export {
  compressTrajectory,
  type TrajectoryCompressionResult,
} from './trajectory-compressor';
export { TiktokenEncoder, type TokenEstimate } from './wasm-tiktoken';
export { ScopedContext, type ScopedContextOptions } from './scoped-context';
export { ScopedContextResources } from './scoped-context-resources';
export {
  CanonicalEvent,
  type CanonicalEventPayload,
} from './event-architecture';
```

> 实际导出符号名以迁移完成后对源文件的 grep 为准（`grep -E "^export " packages/agent-context/src/**/*.ts`），本表为预期清单，可能存在偏差。Agent 3-A/3-B 在迁移完成后核对并补全。

---

### 3.2 @crish/agent-permissions

#### 3.2.1 package.json

```json
{
  "name": "@crish/agent-permissions",
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
    "build:types": "node -e \"require('node:fs').rmSync('../../node_modules/.cache/agent-permissions.tsbuildinfo', { force: true })\" && tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false && tsc-alias -p tsconfig.build.json --resolve-full-paths",
    "build:js": "esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap",
    "build": "npm run clean && npm run build:types && npm run build:js"
  },
  "dependencies": {
    "@crish/shared-types": "0.1.0",
    "@crish/decision-engine": "0.1.0"
  }
}
```

**依赖说明**（依据 `02-FILE-MAPPING.md` §9.2）：

- `@crish/shared-types`：基础类型 + permission 类型（Round 3 下沉）。
- `@crish/decision-engine`：`command-classification.ts` 的分类结果（`ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12：agent-permissions 从 decision-engine 导入分类结果，不自行分类）。
- **不依赖** agent-tools、agent-model、agent-core、agent-context、agent-mcp、@crish/logger、@crish/telemetry（leaf 层独立性）。
- 如果实测发现某些文件需要 Logger，则添加 `@crish/logger` 依赖；本设计阶段依据 `02-FILE-MAPPING.md` §9.2 不预先声明。

#### 3.2.2 目录结构

```
packages/agent-permissions/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── index.ts                            # barrel（含边界声明 JSDoc）
    ├── secrets-obfuscation.ts              # 30K
    ├── secrets-obfuscation.test.ts
    ├── permissions.test.ts
    ├── approval/                          # approval 子目录
    │   ├── approval-cache.ts
    │   ├── approval-cache.test.ts
    │   ├── approval-pipeline.ts
    │   └── chain-approval.ts
    └── permission/                         # permission 子目录（仅 trust-zone-policy）
        ├── trust-zone-policy.ts
        └── trust-zone-policy.test.ts
```

#### 3.2.3 与 decision-engine 的边界

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12 与 `02-FILE-MAPPING.md` §2.20：

| 包                         | 职责                                           | 状态   | 包含的文件                                                                                                         |
| -------------------------- | ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `@crish/decision-engine`   | 纯决策逻辑：命令分类、风险评估、硬性规则       | 无状态 | `command-classification.ts`、`risk-evaluator.ts`、`hardline-patterns.ts`                                           |
| `@crish/agent-permissions` | 运行时信任执行：审批管线、信任区策略、密钥脱敏 | 有状态 | `approval-pipeline.ts`、`trust-zone-policy.ts`、`secrets-obfuscation.ts`、`approval-cache.ts`、`chain-approval.ts` |

**边界切线**：

- `agent-permissions` 通过 `import { classifyCommand } from '@crish/decision-engine'` 导入分类结果。
- `agent-permissions` **不**重新实现命令分类逻辑，**不**包含 `command-classification.ts` 的副本。
- `decision-engine` **不** import `@crish/agent-permissions`（单向依赖：`agent-permissions → decision-engine`）。
- 决策引擎的输出是**纯数据**（如 `ClassificationResult`），agent-permissions 消费该结果决定是否触发审批管线。

**index.ts 的边界声明模板**：

```ts
// packages/agent-permissions/src/index.ts
/**
 * @crish/agent-permissions
 *
 * 运行时信任执行包。职责：审批管线、信任区策略、密钥脱敏。
 *
 * 与 @crish/decision-engine 的边界（ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 12）：
 * - decision-engine 保留 command-classification.ts（纯决策逻辑，无状态）。
 * - agent-permissions 从 decision-engine 导入分类结果，不自行分类。
 * - 禁止两包同时包含 command-classification。
 *
 * 依赖方向（02-FILE-MAPPING.md §9.2）：
 * - agent-permissions → shared-types
 * - agent-permissions → decision-engine
 */

export {
  ApprovalPipeline,
  type ApprovalDecision,
  type ApprovalRequest,
} from './approval/approval-pipeline';
export {
  ChainApproval,
  type ChainApprovalStep,
} from './approval/chain-approval';
export { ApprovalCache, type CacheEntry } from './approval/approval-cache';
export {
  TrustZonePolicy,
  type TrustZone,
  type TrustZoneConfig,
} from './permission/trust-zone-policy';
export {
  obfuscateSecrets,
  type ObfuscationResult,
} from './secrets-obfuscation';
```

---

### 3.3 @crish/agent-mcp

#### 3.3.1 package.json

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
    "build:types": "node -e \"require('node:fs').rmSync('../../node_modules/.cache/agent-mcp.tsbuildinfo', { force: true })\" && tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap false && tsc-alias -p tsconfig.build.json --resolve-full-paths",
    "build:js": "esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap",
    "build": "npm run clean && npm run build:types && npm run build:js"
  },
  "dependencies": {
    "@crish/shared-types": "0.1.0",
    "@crish/shared-utils": "0.1.0"
  }
}
```

**依赖说明**（依据 `02-FILE-MAPPING.md` 禁令 23 实证）：

- `@crish/shared-types`：AgentTool/ToolSource（Round 3 下沉后）+ JsonObject/ToolExecutionContext/ToolOutput。
- `@crish/shared-utils`：errorMessage、RingBuffer。
- **不依赖** agent-tools、agent-model、agent-core、agent-context、agent-permissions、@crish/logger、@crish/telemetry、decision-engine。
- **依赖最小化验证**（依据任务约束）：迁移完成后执行 `grep -r "from '@crish/agent-" packages/agent-mcp/src/` 应仅输出 `@crish/shared-types` 与 `@crish/shared-utils`。若发现其他 @crish/agent-* 引用，说明依赖判定错误，必须修正或更新 `02-FILE-MAPPING.md`。

#### 3.3.2 目录结构

```
packages/agent-mcp/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── index.ts                            # barrel
    ├── mcp-lifecycle.ts                    # 根文件
    ├── mcp-lifecycle.test.ts
    ├── plugin-server.ts                    # 预留接口（仅类型签名，不实现）
    └── mcp-lifecycle/                     # mcp-lifecycle 子目录
        ├── index.ts
        ├── mcp-lifecycle-manager.ts        # 12K
        ├── mcp-server-controller.ts        # 17K
        ├── mcp-server-controller.test.ts
        ├── types.ts
        └── utils.ts
```

#### 3.3.3 registerPluginServer 预留接口

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10（plugin-mcp 并入 agent-mcp，MCP 集成通过 `registerPluginServer(pluginName, declaration)` 入口实现）：

```ts
// packages/agent-mcp/src/plugin-server.ts
/**
 * Plugin MCP 服务器注册接口（预留，Round 8 实现）。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：
 * MCP 集成通过 agent-mcp 的 registerPluginServer(pluginName, declaration) 入口实现，
 * 不在 plugin-sdk 内重复实现 MCP 生命周期。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 10：
 * plugin-mcp 不独立成包，并入 agent-mcp（与现有 McpLifecycleManager 职责完全重叠）。
 *
 * Round 3 阶段：仅声明类型签名，不实现。
 * Round 8 阶段：在 plugin-sdk 重建时实现具体逻辑，调用 McpLifecycleManager 注册插件声明的 MCP 服务器。
 */

import type { AgentTool, ToolSource } from '@crish/shared-types';

/**
 * 插件声明的 MCP 服务器描述。
 * 具体字段在 Round 8 plugin-sdk 重建时根据 PluginManifest.declaredMcpServers 定义。
 */
export interface PluginMcpServerDeclaration {
  readonly pluginName: string;
  readonly serverName: string;
  readonly transport: 'stdio' | 'sse' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly declaredTools?: readonly string[];
}

/**
 * 注册插件声明的 MCP 服务器。
 *
 * @param pluginName - 插件名称
 * @param declaration - MCP 服务器声明
 * @returns 注册结果（Round 8 实现）
 *
 * @deprecated Round 3 阶段仅声明类型，调用会抛出 NotImplementedError。
 * Round 8 plugin-sdk 重建时实现。
 */
export function registerPluginServer(
  pluginName: string,
  declaration: PluginMcpServerDeclaration
): Promise<void> {
  throw new Error(
    'registerPluginServer is not implemented in Round 3; will be implemented in Round 8 (plugin-sdk rebuild)'
  );
}
```

**设计要点**：

- 接口预留而非空函数：调用时立即抛错，避免误用导致运行时静默失败。
- 类型签名完整：Round 8 实现时仅需替换函数体，调用方代码无需变更。
- `PluginMcpServerDeclaration` 字段基于现有 `McpServerController` 的配置结构推导，Round 8 时根据 `PluginManifest.declaredMcpServers` 字段最终确认。
- `AgentTool`/`ToolSource` 从 `@crish/shared-types` 引用，不依赖 `agent-tools`（依赖最小化验证）。

**index.ts barrel**：

```ts
// packages/agent-mcp/src/index.ts
/**
 * @crish/agent-mcp
 *
 * MCP 生命周期管理包。职责：McpLifecycleManager、McpServerController、registerPluginServer 入口。
 *
 * 依赖约束（02-FILE-MAPPING.md 禁令 23）：
 * - 仅依赖 @crish/shared-types + @crish/shared-utils。
 * - 不依赖 agent-tools / agent-model（依赖最小化）。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 2 (leaf)。
 */

export { McpLifecycleManager, type McpLifecycleOptions } from './mcp-lifecycle';
export { McpServerController, type McpServerConfig } from './mcp-lifecycle';
export {
  registerPluginServer,
  type PluginMcpServerDeclaration,
} from './plugin-server';
```

---

## 4. 文件迁移清单（引用 02-FILE-MAPPING.md）

> 本节汇总 Round 3 涉及的全部文件迁移，引用 `02-FILE-MAPPING.md` 的具体小节。所有归属判定以 `02-FILE-MAPPING.md` 为准，不在本文档重新定义。

### 4.1 迁入 @crish/agent-context

| 来源（agent-runtime/src/）                              | 目标包路径                               | 引用                         | 责任 Agent |
| ------------------------------------------------------- | ---------------------------------------- | ---------------------------- | ---------- |
| `context-compression/compression-utils.ts` + `.test.ts` | `agent-context/src/context-compression/` | 参见 02-FILE-MAPPING.md §2.6 | 3-A        |
| `context-compression/index.ts`                          | `agent-context/src/context-compression/` | §2.6                         | 3-A        |
| `context-compression/serializer.ts`                     | `agent-context/src/context-compression/` | §2.6                         | 3-A        |
| `context-compression/token-estimator.ts`                | `agent-context/src/context-compression/` | §2.6                         | 3-A        |
| `checkpoint/checkpoint-manager.ts`                      | `agent-context/src/checkpoint/`          | §2.4                         | 3-A        |
| `checkpoint/index.ts`                                   | `agent-context/src/checkpoint/`          | §2.4                         | 3-A        |
| `context-compression.ts` + `.test.ts`                   | `agent-context/src/`                     | §2.1                         | 3-A        |
| `context-projection.ts` + `.test.ts`                    | `agent-context/src/`                     | §2.1                         | 3-A        |
| `context-slicer.ts`                                     | `agent-context/src/`                     | §2.1                         | 3-A        |
| `context-state.ts` + `.test.ts`                         | `agent-context/src/`                     | §2.1                         | 3-A        |
| `checkpoint-manifest.ts`（27K）+ `.test.ts`             | `agent-context/src/`                     | §2.1                         | 3-A        |
| `checkpoints.ts` + `.test.ts`                           | `agent-context/src/`                     | §2.1                         | 3-A        |
| `conversation-boundary-manifest.ts`（27K）+ `.test.ts`  | `agent-context/src/`                     | §2.1                         | 3-A        |
| `conversation-rewind-target.ts` + `.test.ts`            | `agent-context/src/`                     | §2.1                         | 3-A        |
| `blob-externalization.ts`（12K）+ `.test.ts`            | `agent-context/src/`                     | §2.1                         | 3-A        |
| `encoding.ts` + `.test.ts`                              | `agent-context/src/`                     | §2.1                         | 3-A        |
| `session/session-replay.ts`                             | `agent-context/src/session/`             | §2.31                        | 3-B        |
| `session/session-storage.ts`                            | `agent-context/src/session/`             | §2.31                        | 3-B        |
| `session/session-types.ts`                              | `agent-context/src/session/`             | §2.31                        | 3-B        |
| `session-store/archive-store.ts`                        | `agent-context/src/session-store/`       | §2.33                        | 3-B        |
| `session-store/index.ts`（14K）                         | `agent-context/src/session-store/`       | §2.33                        | 3-B        |
| `session-store/types.ts`                                | `agent-context/src/session-store/`       | §2.33                        | 3-B        |
| `event-architecture/canonical-event.ts` + `.test.ts`    | `agent-context/src/event-architecture/`  | §2.8                         | 3-B        |
| `event-architecture/index.ts`                           | `agent-context/src/event-architecture/`  | §2.8                         | 3-B        |
| `ISessionStore.ts`                                      | `agent-context/src/`                     | §2.1                         | 3-B        |
| `session.ts` + `.test.ts`                               | `agent-context/src/`                     | §2.1                         | 3-B        |
| `snapshots.ts` + `.test.ts`                             | `agent-context/src/`                     | §2.1                         | 3-B        |
| `prompt-assembly.ts`（19K）+ `.test.ts`                 | `agent-context/src/`                     | §2.1                         | 3-B        |
| `prompt-context.ts` + `.test.ts`                        | `agent-context/src/`                     | §2.1                         | 3-B        |
| `canonical-schema.ts`                                   | `agent-context/src/`                     | §2.1                         | 3-B        |
| `wasm-tiktoken.ts`                                      | `agent-context/src/`                     | §2.1                         | 3-B        |
| `structured-summary.ts` + `.test.ts`                    | `agent-context/src/`                     | §2.1                         | 3-B        |
| `trajectory-compressor.ts`                              | `agent-context/src/`                     | §2.1                         | 3-B        |
| `memory.ts` + `.test.ts`                                | `agent-context/src/`                     | §2.1                         | 3-B        |
| `scoped-context.ts` + `.test.ts`                        | `agent-context/src/`                     | §2.1                         | 3-B        |
| `scoped-context-resources.ts` + `.test.ts`              | `agent-context/src/`                     | §2.1                         | 3-B        |
| `goal-disk-oracle.ts` + `.test.ts`                      | `agent-context/src/`                     | §2.1                         | 3-B        |
| `response-style.ts` + `.test.ts`                        | `agent-context/src/`                     | §2.1                         | 3-B        |
| `doctor-report.ts`                                      | `agent-context/src/`                     | §2.1                         | 3-B        |
| `agent-context.ts`                                      | `agent-context/src/`                     | §2.1                         | 3-B        |
| `payload-image-recovery.ts` + `.test.ts`                | `agent-context/src/`                     | §2.1                         | 3-B        |
| `project-progress-ledger.ts` + `.test.ts`               | `agent-context/src/`                     | §2.1                         | 3-B        |
| `__tests__/canonical-schema.test.ts`                    | `agent-context/src/__tests__/`           | §2.41                        | 3-B        |
| `__tests__/context-slicer.test.ts`                      | `agent-context/src/__tests__/`           | §2.41                        | 3-B        |

**小计**：约 45 文件（含测试）。

### 4.2 迁入 @crish/agent-permissions

| 来源（agent-runtime/src/）                     | 目标包路径                          | 引用                         | 责任 Agent |
| ---------------------------------------------- | ----------------------------------- | ---------------------------- | ---------- |
| `approval/approval-cache.ts` + `.test.ts`      | `agent-permissions/src/approval/`   | 参见 02-FILE-MAPPING.md §2.3 | 3-C        |
| `approval/approval-pipeline.ts`                | `agent-permissions/src/approval/`   | §2.3                         | 3-C        |
| `approval/chain-approval.ts`                   | `agent-permissions/src/approval/`   | §2.3                         | 3-C        |
| `permission/trust-zone-policy.ts` + `.test.ts` | `agent-permissions/src/permission/` | §2.20                        | 3-C        |
| `secrets-obfuscation.ts`（30K）+ `.test.ts`    | `agent-permissions/src/`            | §2.1                         | 3-C        |
| `permissions.test.ts`                          | `agent-permissions/src/`            | §2.1                         | 3-C        |

**小计**：约 8 文件（含测试）。

**留置不迁**：`permission/command-classification.ts`（留在 decision-engine，参见 `02-FILE-MAPPING.md` §2.20 + `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 12）。

### 4.3 迁入 @crish/agent-mcp

| 来源（agent-runtime/src/）                                  | 目标包路径                     | 引用                          | 责任 Agent |
| ----------------------------------------------------------- | ------------------------------ | ----------------------------- | ---------- |
| `mcp-lifecycle/index.ts`                                    | `agent-mcp/src/mcp-lifecycle/` | 参见 02-FILE-MAPPING.md §2.15 | 3-D        |
| `mcp-lifecycle/mcp-lifecycle-manager.ts`（12K）             | `agent-mcp/src/mcp-lifecycle/` | §2.15                         | 3-D        |
| `mcp-lifecycle/mcp-server-controller.ts`（17K）+ `.test.ts` | `agent-mcp/src/mcp-lifecycle/` | §2.15                         | 3-D        |
| `mcp-lifecycle/types.ts`                                    | `agent-mcp/src/mcp-lifecycle/` | §2.15                         | 3-D        |
| `mcp-lifecycle/utils.ts`                                    | `agent-mcp/src/mcp-lifecycle/` | §2.15                         | 3-D        |
| `mcp-lifecycle.ts` + `.test.ts`                             | `agent-mcp/src/`               | §2.1                          | 3-D        |

**小计**：约 8 文件（含测试）。

### 4.4 类型下沉到 @crish/shared-types

| 来源（agent-runtime/src/）                                            | 迁入位置                                                            | 引用                         | 责任 Agent            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------- | --------------------- |
| `types.ts` 中的 `AgentTool` / `ToolSource` / `AgentProvider` 等纯类型 | `shared-types/src/tool.ts`（追加；如不存在则新建）                  | 参见 02-FILE-MAPPING.md §2.2 | 3-E                   |
| `types.ts` 中的 session store 纯类型                                  | `shared-types/src/`（按域追加）                                     | §2.2                         | 3-E                   |
| `types.ts` 中的 permission 类型                                       | `shared-types/src/permissions.ts`（追加到现有文件）                 | §2.2                         | 3-E                   |
| `types.ts` 中的 runtime options 类型                                  | 保留在 `agent-runtime/src/types.ts`（迁移到 agent-core 在 Round 5） | §2.2                         | 3-E（仅保留，不迁移） |
| `types.ts` 中的工厂函数                                               | 随各包迁移                                                          | §2.2                         | 3-E（按需）           |

**关键约束**（参见 `02-FILE-MAPPING.md` §2.2 备注）：`AgentTool`/`ToolSource` 被 `mcp-lifecycle-manager.ts`、`mcp-server-controller.ts`、`plugin-registry.ts`、`subagents.ts` 等多方引用，必须下沉到 `shared-types`，否则 `agent-mcp`（leaf）会反向依赖 `agent-tools`（middle），引入循环。

---

## 5. 验证门禁

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27 + `01-OVERVIEW.md` §4.3，Round 3 结束前必须通过以下 8 项检查：

| 检查项           | 命令                        | 通过标准                                                                | 责任 Agent |
| ---------------- | --------------------------- | ----------------------------------------------------------------------- | ---------- |
| TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ Round 3 开始基线（不恶化，禁令 26）                            | 3-E        |
| Rust 编译        | `cargo check --workspace`   | 0 errors                                                                | 3-E        |
| 单元测试（TS）   | `npx vitest run`            | 失败数 ≤ Round 3 开始基线（不恶化）                                     | 3-E        |
| 单元测试（Rust） | `cargo test --workspace`    | 全部通过                                                                | 3-E        |
| 循环依赖         | `npm run lint:depcruise`    | 0 violations（关键：验证 agent-mcp 不反向依赖 agent-tools/agent-model） | 3-E        |
| 构建             | `npx turbo run build`       | 全部成功（3 个新包独立构建成功）                                        | 3-E        |
| Lint             | `npm run lint`              | 0 errors                                                                | 3-E        |
| Store 类型       | `npm run check:store-types` | 通过                                                                    | 3-E        |

### 5.1 Round 3 专项验证

除 8 项标准门禁外，Round 3 增加以下专项验证：

| 专项                            | 命令                                                                                                                                                          | 通过标准                                                               | 验证目标                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 依赖最小化（agent-mcp）         | `grep -rE "from ['\"]@crish/agent-(tools\|model\|core\|context\|permissions)" packages/agent-mcp/src/`                                                        | 输出为空                                                               | 验证 agent-mcp 仅依赖 shared-types + shared-utils（`02-FILE-MAPPING.md` 禁令 23） |
| 依赖最小化（agent-permissions） | `grep -rE "from ['\"]@crish/agent-(tools\|model\|core\|context\|mcp)" packages/agent-permissions/src/`                                                        | 输出为空                                                               | 验证 agent-permissions 不依赖其他新内部包                                         |
| command-classification 留置     | `ls packages/decision-engine/src/command-classification.ts`（或类似路径）+ `grep -r "command-classification" packages/agent-permissions/src/`                 | 文件留置在 decision-engine；agent-permissions 内部代码无重复分类逻辑   | 验证 禁令 12 边界（`02-FILE-MAPPING.md` §2.20）                                   |
| canonical-event 归属            | `ls packages/agent-context/src/event-architecture/canonical-event.ts`                                                                                         | 文件存在                                                               | 验证 §2.8 边界判定（`02-FILE-MAPPING.md` §3 第 6 项）                             |
| re-export shim 完整性           | `grep -r "deprecated.*agent-runtime" packages/agent-runtime/src/`                                                                                             | 覆盖所有被迁移文件的 shim 路径                                         | 验证 禁令 24 shim 约束                                                            |
| AgentTool/ToolSource 下沉       | `grep -E "export (type                                                                                                                                        | interface )(AgentTool\|ToolSource)" packages/shared-types/src/tool.ts` | 输出非空                                                                          | 验证 types.ts 拆分（`02-FILE-MAPPING.md` §2.2） |
| turbo 独立构建                  | `npx turbo run build --filter=@crish/agent-context && npx turbo run build --filter=@crish/agent-permissions && npx turbo run build --filter=@crish/agent-mcp` | 3 个命令均成功                                                         | 验证 3 个新包可独立构建                                                           |
| throw 迁移示范                  | `grep -rE "throw new CrishError\(" packages/agent-context/src/ packages/agent-permissions/src/`                                                               | 输出非空（至少 1 处示范迁移）                                          | 验证 §7.2 R3 阶段的 throw 迁移（`03-ERROR-MIGRATION.md`）                         |

### 5.2 不恶化基线管理

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 26：

- **轮次开始**（Agent 3-E 第 1 步）：执行 `npx tsc --noEmit 2>&1 | tee tsc-errors-baseline-r3-start.json`，记录错误数与分布。
- **轮次结束**（Agent 3-E 第 6 步）：执行 `npx tsc --noEmit 2>&1 | tee tsc-errors-after-r3.json`，对比 baseline。
- **通过标准**：`after ≤ baseline`。
- **失败处理**：若 after > baseline，识别新增错误的根因（通常是 import 路径断裂或类型下沉不完整），由 Agent 3-E 修复后重新验证，直至通过。
- **不承诺清零**：本 Round 不要求 TSC 错误清零，仅要求不恶化。最终清零目标在 Round 11（< 50）。

### 5.3 循环依赖专项

depcruise 门禁是 Round 3 最关键的验证项之一，因为：

1. agent-mcp 的依赖最小化是 `01-OVERVIEW.md` §3.1 修正 v1 方案错误的核心。
2. types.ts 类型下沉到 shared-types 的目的是避免 agent-mcp 反向依赖 agent-tools。
3. canonical-event.ts 归 agent-context 而非 agent-core 是为了避免 leaf 反向依赖 top 层（`02-FILE-MAPPING.md` §3 第 6 项）。

depcruise 规则文件（`/.dependency-cruiser.js` 或类似）应在 Round 3 结束前由 Agent 3-E 验证：

```
禁止的循环：
- agent-mcp → agent-tools
- agent-mcp → agent-model
- agent-mcp → agent-core
- agent-permissions → agent-tools
- agent-permissions → agent-model
- agent-permissions → agent-core
- agent-context → agent-tools
- agent-context → agent-model
- agent-context → agent-core
- 任何包 → agent-runtime（除 legacy shim 的 re-export）
```

---

## 6. 交付物

### 6.1 文件交付物

| 类别     | 路径                                                               | 责任 Agent | 验收标准                                                                   |
| -------- | ------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------- |
| 包骨架   | `packages/agent-context/package.json`                              | 3-A        | dependencies 仅含 shared-types/shared-utils/@crish/logger/@crish/telemetry |
| 包骨架   | `packages/agent-context/tsconfig.json` + `tsconfig.build.json`     | 3-A        | extends ../../tsconfig.base.json                                           |
| 包骨架   | `packages/agent-permissions/package.json`                          | 3-C        | dependencies 仅含 shared-types + decision-engine                           |
| 包骨架   | `packages/agent-permissions/tsconfig.json` + `tsconfig.build.json` | 3-C        | 同上                                                                       |
| 包骨架   | `packages/agent-mcp/package.json`                                  | 3-D        | dependencies 仅含 shared-types + shared-utils                              |
| 包骨架   | `packages/agent-mcp/tsconfig.json` + `tsconfig.build.json`         | 3-D        | 同上                                                                       |
| 包内容   | `packages/agent-context/src/`（约 45 文件）                        | 3-A + 3-B  | turbo build 成功                                                           |
| 包内容   | `packages/agent-permissions/src/`（约 8 文件）                     | 3-C        | turbo build 成功                                                           |
| 包内容   | `packages/agent-mcp/src/`（约 8 文件 + plugin-server.ts）          | 3-D        | turbo build 成功                                                           |
| 接口预留 | `packages/agent-mcp/src/plugin-server.ts`                          | 3-D        | 仅类型签名 + 抛 NotImplementedError                                        |
| shim     | `packages/agent-runtime/src/` 下被迁移文件的 re-export shim        | 3-E        | 每个 shim 含 deprecation warning + 显式命名导出                            |
| 类型下沉 | `packages/shared-types/src/tool.ts` 追加 AgentTool/ToolSource      | 3-E        | grep 验证导出存在                                                          |
| 类型下沉 | `packages/agent-runtime/src/types.ts` 改为 re-export               | 3-E        | 保留向后兼容                                                               |
| 配置更新 | `packages/agent-runtime/package.json` dependencies 添加 3 个新包   | 3-E        | npm install 成功                                                           |

### 6.2 报告交付物

| 文件                                                                 | 内容                                                               | 责任 Agent |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| `analysis/iterative-repair/v2/tsc-errors-baseline-r3-start.json`     | Round 3 开始基线 TSC 错误清单                                      | 3-E        |
| `analysis/iterative-repair/v2/tsc-errors-after-r3.json`              | Round 3 结束 TSC 错误清单                                          | 3-E        |
| `analysis/iterative-repair/v2/round-03-validation-report.md`（可选） | 验证报告：TSC 变化、depcruise 摘要、turbo build 摘要、专项验证结果 | 3-E        |

### 6.3 接口签名交付物（结构化契约，供 Round 4 消费）

依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 27（轮次间数据契约）：

```ts
// Round 4 (agent-tools/agent-model) 将消费以下接口：

// 1. @crish/agent-context 的公共导出（Round 4 agent-tools/agent-model 依赖 agent-context）
//    完整清单见 §3.1.3，关键消费点：
//    - InMemoryContextState（被 subagents.ts 引用，但 subagents 在 Round 9）
//    - createContextAggregator（被 runtime-components/context-manager 引用，但 runtime-components 在 Round 5）
//    - SessionStorage / SessionStore（被 daemon 引用，Round 7）

// 2. @crish/agent-permissions 的公共导出（Round 5 agent-core 依赖 agent-permissions）
//    完整清单见 §3.2.3，关键消费点：
//    - ApprovalPipeline（被 runtime-components 引用，Round 5）
//    - TrustZonePolicy（被 runtime 引用，Round 5）

// 3. @crish/agent-mcp 的公共导出（Round 4 agent-tools + Round 5 agent-core 依赖 agent-mcp）
//    完整清单见 §3.3.3，关键消费点：
//    - McpLifecycleManager（被 server-runtime-factory/mcp-factory 引用，Round 7）
//    - McpServerController（同上）
//    - registerPluginServer 类型（Round 8 plugin-sdk 实现）

// 4. shared-types 的新增类型（Round 3 下沉）
//    - AgentTool / ToolSource / AgentProvider（从 agent-runtime/src/types.ts 下沉）
//    - 用于 agent-mcp（mcp-lifecycle-manager.ts）+ agent-tools（tool-definition.ts，Round 4）+ agent-subagent（subagents.ts，Round 5/9）
```

### 6.4 边界声明交付物

| 边界                                | 声明位置                                                                                | 声明内容                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-permissions ↔ decision-engine | `packages/agent-permissions/src/index.ts` JSDoc                                         | decision-engine 管决策（无状态），agent-permissions 管运行时信任执行（有状态），command-classification.ts 留 decision-engine                                                                 |
| agent-mcp 依赖最小化                | `packages/agent-mcp/src/index.ts` JSDoc                                                 | 仅依赖 shared-types + shared-utils，不依赖 agent-tools/agent-model                                                                                                                           |
| canonical-event 归属                | `packages/agent-context/src/event-architecture/index.ts` JSDoc                          | canonical-event.ts 是上下文域规范事件类型，agent-context（leaf）需直接产出/消费；EventArchitecture 在 agent-core 指代 event-protocol/ + event-queue/（参见 `02-FILE-MAPPING.md` §3 第 6 项） |
| types.ts 拆分                       | `packages/shared-types/src/tool.ts` JSDoc + `packages/agent-runtime/src/types.ts` JSDoc | AgentTool/ToolSource 下沉 shared-types 以避免 agent-mcp 反向依赖 agent-tools（参见 `02-FILE-MAPPING.md` §2.2 备注）                                                                          |

---

## 7. 风险与缓解

| 风险                                                                    | 概率 | 影响 | 缓解措施                                                                                                                                     |
| ----------------------------------------------------------------------- | ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 3-E 类型下沉未及时完成，导致 3-A/3-B/3-C/3-D 迁移文件 import 失败 | 中   | 高   | 显式声明串行依赖：3-E 第 1-2 步先于 3-A/3-B/3-C/3-D 启动（§2.5 协调点）                                                                      |
| agent-mcp 实测发现依赖 agent-tools/agent-model 的隐藏 import            | 低   | 高   | 依据 `02-FILE-MAPPING.md` 禁令 23 已实证仅依赖 shared-types + shared-utils；若发现新 import，更新 禁令 23 并通过类型下沉到 shared-types 解决 |
| canonical-event.ts 实际依赖 agent-core 的类型                           | 低   | 中   | 依据 `02-FILE-MAPPING.md` §3 第 6 项已判定为 agent-context；若发现依赖，将依赖类型下沉 shared-types                                          |
| TSC 错误恶化（迁移引入大量新错误）                                      | 中   | 中   | Agent 3-E 的不恶化门禁 + 修复步骤；允许引入临时错误但必须回归                                                                                |
| re-export shim 漏写导致 import 断裂                                     | 中   | 中   | Agent 3-E 用 `grep -r "from '\./" packages/agent-runtime/src/` 扫描所有相对 import，对照迁移清单识别需 shim 的文件                           |
| throw 迁移过度（违反三阶段策略）                                        | 低   | 中   | Round 3 仅要求每包至少 1 处示范迁移，不要求全量迁移（依据 `03-ERROR-MIGRATION.md` §7.2 + `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 25）      |

---

## 8. 与后续 Round 的衔接

### 8.1 Round 4（middle 层）将消费的接口

| Round 4 包           | 消费的 Round 3 接口                                                              | 引用                         |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| `@crish/agent-tools` | `@crish/agent-context` 的 InMemoryContextState、SessionStorage 等                | `02-FILE-MAPPING.md` §9.2    |
| `@crish/agent-tools` | `@crish/agent-mcp` 的 McpLifecycleManager（通过 shared-types 的 AgentTool 类型） | `02-FILE-MAPPING.md` 禁令 23 |
| `@crish/agent-model` | `@crish/agent-context` 的 canonical-schema、prompt-context 等                    | `02-FILE-MAPPING.md` §9.2    |

### 8.2 Round 5（top 层）将消费的接口

| Round 5 包                      | 消费的 Round 3 接口                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@crish/agent-core`             | `@crish/agent-context` 全部 + `@crish/agent-permissions` 全部 + `@crish/agent-mcp` 全部                            |
| `@crish/agent-subagent`（骨架） | `@crish/agent-context` 的 InMemoryContextState、project-progress-ledger；`@crish/agent-mcp` 的 McpLifecycleManager |

### 8.3 Round 8（plugin-sdk）将实现

- `@crish/agent-mcp` 的 `registerPluginServer(pluginName, declaration)` 函数体（Round 3 仅预留类型签名）。

---

## 变更记录

| 版本 | 日期       | 变更                                                                                                                                                       |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于 `01-OVERVIEW.md` §3.2 拓扑层级 + `02-FILE-MAPPING.md` 权威映射 + `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12/禁令 23-26/禁令 27-28 约束设计 |
