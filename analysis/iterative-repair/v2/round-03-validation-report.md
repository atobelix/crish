# Round 3 验证报告

> 依据 `ROUND-03-split-phase-a.md` §2.5 Agent 3-E 验证门禁要求生成。
> 基线对比：`tsc-errors-baseline-r3-start.json`（轮次开始） vs `tsc-errors-after-r3.json`（轮次结束）。

---

## 1. TSC 编译验证

### 1.1 结果摘要

| 包                         | 轮次开始基线 | 轮次结束 | 状态 |
| -------------------------- | ------------ | -------- | ---- |
| `@crish/shared-types`      | 0            | 0        | PASS |
| `@crish/decision-engine`   | 0            | 0        | PASS |
| `@crish/agent-context`     | N/A（新包）  | 0        | PASS |
| `@crish/agent-permissions` | N/A（新包）  | 0        | PASS |
| `@crish/agent-mcp`         | N/A（新包）  | 0        | PASS |
| `@crish/agent-runtime`     | 0            | 0        | PASS |

**门禁判定**：PASS（不恶化原则满足：0 → 0）

### 1.2 迁移过程错误修复记录

迁移过程中 agent-runtime 出现 46 个 TSC 错误（TS2307 Cannot find module），全部由 re-export shim 创建后修复：

- agent-context 域：encoding, blob-externalization, checkpoints, checkpoint-manifest, context-compression, context-projection, context-state, context-slicer, conversation-boundary-manifest, conversation-rewind-target, checkpoint/
- agent-mcp 域：mcp-lifecycle
- agent-permissions 域：secrets-obfuscation, approval/, permission/trust-zone-policy

---

## 2. 循环依赖验证（depcruise）

### 2.1 结果摘要

- 命令：`npx depcruise --config .dependency-cruiser.cjs packages/agent-context packages/agent-permissions packages/agent-mcp packages/agent-runtime`
- 结果：37 violations（37 errors, 0 warnings）
- 模块数：520 modules, 1481 dependencies

### 2.2 违规分析

| 类别                       | 数量  | 说明                                                                                                 |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| agent-runtime 内部循环     | 35    | 全部为预先存在的循环依赖（hooks/, provider/, session/, prompt-assembly 等）                          |
| agent-context 内部循环     | 2     | 从 agent-runtime 迁移的代码（session-replay ↔ session-storage, ISessionStore ↔ session-store/index） |
| agent-permissions 内部循环 | 0     | 无                                                                                                   |
| agent-mcp 内部循环         | 0     | 无                                                                                                   |
| **跨包循环**               | **0** | **无新增跨包循环依赖**                                                                               |

**门禁判定**：PASS（不恶化原则满足：0 新增跨包循环依赖；agent-context 的 2 个循环为迁移前已存在于 agent-runtime 的同代码）

---

## 3. 构建验证（esbuild）

### 3.1 结果摘要

| 包                         | build:types (TSC) | build:js (esbuild) | 产物大小 | 状态 |
| -------------------------- | ----------------- | ------------------ | -------- | ---- |
| `@crish/agent-context`     | PASS              | PASS               | 248.4kb  | PASS |
| `@crish/agent-permissions` | PASS              | PASS               | 33.1kb   | PASS |
| `@crish/agent-mcp`         | PASS              | PASS               | 25.6kb   | PASS |
| `@crish/agent-runtime`     | PASS              | PASS               | (预存)   | PASS |

### 3.2 跨层依赖修复

迁移过程中发现 agent-context 的迁移文件存在 12 处对 agent-runtime 模块的跨层引用（`./tools`, `./skills`, `./tool-output-budget`, `./tool-output-guard`, `./provider-transport/stream-recovery`, `./tools/tool-preset-registry`, `../media/media-preprocessor`, `../state-machine`, `./types`）。已通过以下方式系统性修复：

- 类型下沉：`AgentSkill`, `SkillDiagnostic`, `ToolMode`, `SessionBranchState`, `GitCheckpoint` 等纯类型迁入 `@crish/shared-types`
- 本地实现：`defineTool`, `skills.ts`, `tool-output-budget.ts`, `tool-output-guard.ts` 等在 agent-context 内创建本地实现
- 依赖注入：`MediaPreprocessor`, `StreamRecoveryGlobalRegistry`, `ToolPresetRegistry` 等通过参数注入或可选依赖消除硬引用

---

## 4. 依赖最小化验证

### 4.1 agent-mcp 依赖约束

```
grep -r "from '@crish/agent-(tools|model|core|context|permissions)" packages/agent-mcp/src/
→ No matches found
```

```
cat packages/agent-mcp/package.json | grep -E "agent-(tools|model|core|context|permissions)"
→ No matches found
```

**门禁判定**：PASS（agent-mcp 仅依赖 @crish/shared-types + @crish/shared-utils）

### 4.2 agent-permissions 依赖约束

```
cat packages/agent-permissions/package.json | grep -E "agent-(tools|model|core|mcp|context)"
→ No matches found
```

**门禁判定**：PASS（agent-permissions 仅依赖 @crish/shared-types + @crish/decision-engine + @crish/shared-utils）

### 4.3 agent-context 依赖约束

```
cat packages/agent-context/package.json | dependencies
→ @crish/shared-types, @crish/shared-utils, @crish/logger, @crish/telemetry
```

**门禁判定**：PASS（agent-context 不依赖 agent-tools/agent-model/agent-core/agent-permissions/agent-mcp）

---

## 5. Agent 3-E Phase 2 变更清单

### 5.1 依赖接线

- `packages/agent-runtime/package.json`：添加 `@crish/agent-context`, `@crish/agent-permissions`, `@crish/agent-mcp` 依赖；将 `@crish/shared-utils` 从 devDependencies 移至 dependencies（运行时依赖）
- `package.json`（workspace 根）：添加 `packages/agent-mcp` 到 workspaces 列表

### 5.2 re-export shim 创建（18 个文件）

**agent-context 域**（12 个）：

- `encoding.ts`, `blob-externalization.ts`, `checkpoints.ts`, `checkpoint-manifest.ts`
- `context-compression.ts`, `context-projection.ts`, `context-state.ts`, `context-slicer.ts`
- `conversation-boundary-manifest.ts`, `conversation-rewind-target.ts`
- `checkpoint/index.ts`, `checkpoint/checkpoint-manager.ts`

**agent-mcp 域**（1 个）：

- `mcp-lifecycle.ts`

**agent-permissions 域**（5 个）：

- `secrets-obfuscation.ts`
- `approval/index.ts`, `approval/approval-pipeline.ts`, `approval/approval-cache.ts`
- `permission/trust-zone-policy.ts`

### 5.3 跨层依赖修复

- `packages/shared-types/src/`：新增 `git-checkpoint.ts`（GitCheckpoint 等类型下沉）
- `packages/agent-context/src/`：修复 12 处跨层 import，创建 `skills.ts`, `tool-output-budget.ts`, `tool-output-guard.ts` 等本地实现
- `packages/agent-runtime/src/git-versioning/git-types.ts`：类型 re-export 指向 @crish/shared-types

### 5.4 类型下沉

- `AgentTool`, `ToolSource`, `ProviderStreamEvent`, `ProviderUsage`, `HealthCheckResult` → `@crish/shared-types/tool.ts`（Round 3 开始时已完成）
- `AgentSkill`, `SkillDiagnostic` → `@crish/shared-types/skill.ts`
- `GitCheckpoint`, `GitCheckpointToolCall` 等 → `@crish/shared-types/git-checkpoint.ts`

---

## 6. 已知问题与后续计划

| 问题                                                                                  | 严重性 | 计划                                                  |
| ------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| agent-runtime 与 agent-context 存在重复代码（memory.ts, session.ts, snapshots.ts 等） | 低     | Round 5 legacy shim 阶段删除 agent-runtime 侧重复文件 |
| agent-runtime 内部 35 个预先存在的循环依赖                                            | 中     | Round 5+ 逐步重构                                     |
| agent-context 内部 2 个循环依赖（session-replay ↔ session-storage）                   | 低     | Round 5+ 重构                                         |
| turbo build 的 shared-utils ↔ logger 循环依赖                                         | 中     | 预先存在问题，需在后续 Round 修复                     |
| 3 个 @ts-expect-error 指令在 agent-context 测试文件中                                 | 低     | Round 5 接线后移除                                    |

---

## 7. 门禁总结

| 门禁            | 结果 | 备注                                                   |
| --------------- | ---- | ------------------------------------------------------ |
| TypeScript 编译 | PASS | 6 包 0 errors                                          |
| 循环依赖        | PASS | 0 新增跨包循环                                         |
| 构建（esbuild） | PASS | 3 新包 + agent-runtime 全部成功                        |
| 依赖最小化      | PASS | agent-mcp/agent-permissions/agent-context 依赖约束满足 |
| 不恶化原则      | PASS | TSC 0→0，depcruise 无新增跨包循环                      |
