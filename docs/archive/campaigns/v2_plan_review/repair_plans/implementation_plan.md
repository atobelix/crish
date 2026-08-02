# Conex TS 编译修复 — 多 Agent 协同迭代修复方案

> **综合来源**: [final_synthesis_A.md](file:///C:/Software/conex/docs/v2_plan_review/repair_plans/final_synthesis_A.md) + [final_synthesis_B.md](file:///C:/Software/conex/docs/v2_plan_review/repair_plans/final_synthesis_B.md)
> **项目根**: `C:\Software\conex`（下文路径均为相对路径）
> **错误总量**: ~1585 errors · ~310 files · 7 packages · 173 task cards

---

## 0. 方案总纲

### 0.1 问题域摘要

| 归因类别 | 错误码 | 数量 | 占比 |
|---|---|:---:|:---:|
| exactOptionalPropertyTypes | TS2375 / TS2379 / TS2412 | ~1040 | ~66% |
| 未使用声明 | TS6133 / TS6196 / TS6192 / TS6138 | ~190 | ~12% |
| 严格空检查 + 类型不匹配 | TS2532 / TS18048 / TS2322 / TS2345 | ~210 | ~13% |
| 导入/导出问题 | TS1361 / TS2305 / TS2459 | ~32 | ~2% |
| JSX 语法 | TS17008 / TS17002 / TS1005 | 28 | ~2% |
| 缺失成员 / 边缘 | TS2339 / TS2739 / TS2352 / TS2420 等 | ~55 | ~3% |
| 配置问题 | TS6059 / TS5058 | ~10 | <1% |

### 0.2 迭代修复闭环架构

```
Round 0 ─ 配置基础
   │
Round 1 ─ 源码并行修复（≤12 Agent）
   │
Round 2 ─ 测试文件修复（≤12 Agent）
   │
Round 3 ─ 全局验证 Gate
   │
   ├─ PASS ──→ 完成
   └─ FAIL ──→ 生成回归台账 ──→ Round N（回归扫描）──→ Round N+1 Gate ──→ ...
```

每轮产出一份 **JSON 台账**（`round_N_ledger.json`），包含所有任务卡的状态更新。下一轮的调度器读取该台账中 `status == "regressed"` 或 `status == "open"` 的条目，自动生成新轮次的 Agent 分配。

### 0.3 轮次间接口：台账格式定义（硬性要求 5）

#### 状态机

```
open ──fix applied──→ fixed ──verify pass──→ verified
                        │                       │
                        └──verify fail──→ regressed ──re-queue──→ open
                                              ↑
                                    verified ──global gate fail──┘
```

#### JSON Schema

```json
{
  "$schema": "conex-repair-ledger/v1",
  "roundId": "R1",
  "timestamp": "2026-07-25T12:00:00.000Z",
  "inputLedger": null,
  "summary": {
    "totalTasks": 119,
    "open": 0,
    "fixed": 0,
    "verified": 119,
    "regressed": 0
  },
  "agents": [
    {
      "agentId": "RT-1",
      "status": "done",
      "filesWrite": [
        "packages/agent-runtime/src/error-classifier.ts",
        "packages/agent-runtime/src/anthropic-stream-parse.ts"
      ],
      "tasks": [
        {
          "taskId": "T-AR-001",
          "file": "packages/agent-runtime/src/error-classifier.ts",
          "errorLines": [63,70,77,83,89,96,105,112,119,126,133,140,148,154,160,166,174,180,186,193,198,209],
          "errorCodes": ["TS2379","TS2375"],
          "status": "verified",
          "fixStrategy": "mapped-type-ClassifiedErrorInput",
          "verifyCommand": "npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Out-String -Stream | Select-String 'error-classifier'",
          "verifyResult": "pass",
          "residualErrors": []
        }
      ]
    }
  ],
  "roundVerification": {
    "command": "npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Out-String -Stream | Select-String 'error TS' | Measure-Object -Line",
    "passCondition": "Count == 0",
    "result": "pass"
  },
  "globalGate": {
    "tsc": { "command": "npx turbo run typecheck 2>&1 | Out-String -Stream | Select-String 'error'", "result": null },
    "test": { "command": "npx vitest run --reporter=json", "result": null }
  }
}
```

#### 轮次衔接协议

1. **Round N 结束时**：调度器执行该轮的 `roundVerification.command`，对每个任务卡逐一执行 `verifyCommand`
2. **生成 `round_N_ledger.json`**：所有 verify pass 的标记 `verified`，fail 的标记 `regressed`
3. **Round N+1 输入**：读取 `round_N_ledger.json`，提取 `regressed` 条目 + 新增 `tsc` 输出中的新错误，生成新的任务卡
4. **写集重新分区**：对新任务卡执行写集分区算法，分配到 ≤12 个 Agent

---

## 1. Round 0 — 配置基础

### 1.1 Agent 分配（1 Agent）

| Agent | 任务卡 | 文件数 | 写集 |
|---|---|:---:|---|
| **CFG-1** | T-CFG-001 ~ T-CFG-005 | 5 | `tsconfig.base.json`, `packages/shared-utils/tsconfig.json`, `packages/agent-provider-http/tsconfig.json` [NEW], `packages/plugin-sdk/tsconfig.json` [NEW], `packages/test-utils/tsconfig.json` [NEW] |

### 1.2 任务卡

| ID | 文件 | 错误 | 修改逻辑 | 验收命令 |
|---|---|---|---|---|
| T-CFG-001 | `tsconfig.base.json` (L19) | TS2375/2379/2412 根源 | **保留** `exactOptionalPropertyTypes: true`，不做修改（战略决策：保持严格模式） | `npx tsc --showConfig -p tsconfig.base.json \| Select-String "exactOptional"` → 输出含 `true` |
| T-CFG-002 | `packages/shared-utils/tsconfig.json` | TS6059, TS6307 | `rootDir` 与 `include` 不匹配。修改 `include` 为 `["src/**/*.ts", "src/**/*.test.ts"]`，确保 `rootDir: "src"` 生效 | `npx tsc --noEmit -p packages/shared-utils/tsconfig.json 2>&1 \| Out-String -Stream \| Select-String "TS6059" \| Measure-Object -Line` → Count == 0 |
| T-CFG-003 | `packages/agent-provider-http/tsconfig.json` [NEW] | TS5058 | 创建文件，继承 `../../tsconfig.base.json`，设 `include: ["src"]` | `Test-Path packages/agent-provider-http/tsconfig.json` → True |
| T-CFG-004 | `packages/plugin-sdk/tsconfig.json` [NEW] | TS5058 | 同 T-CFG-003 模式 | `Test-Path packages/plugin-sdk/tsconfig.json` → True |
| T-CFG-005 | `packages/test-utils/tsconfig.json` [NEW] | TS5058 | 同 T-CFG-003 模式 | `Test-Path packages/test-utils/tsconfig.json` → True |

### 1.3 轮次验收

```powershell
# Round 0 Gate：所有 tsconfig 可被 tsc 解析（不报 TS5058/TS6059）
npx tsc --noEmit -p packages/shared-utils/tsconfig.json 2>&1 | Out-String -Stream | Select-String "TS6059|TS5058" | Measure-Object -Line
# 通过条件：Count == 0
```

---

## 2. Round 1 — 源码并行修复

### 2.1 Agent 分配（11 Agents）

> 所有 Agent 的 `filesWrite` 完全不相交。同一文件只出现在一个 Agent 的写集中。

| Agent | 包 | 波次来源 | 任务卡 | 文件数 |
|---|---|---|---|:---:|
| **RT-1** | agent-runtime | W-01 | T-AR-001 ~ T-AR-010 | 10 |
| **RT-2** | agent-runtime | W-01 | T-AR-011 ~ T-AR-022 | 12 |
| **RT-3** | agent-runtime | W-01 | T-AR-025 ~ T-AR-036 | 12 |
| **RT-4** | agent-runtime | W-01 | T-AR-037 ~ T-AR-049 | 15 |
| **RT-5** | agent-runtime | W-01 + W-03~W-07 | T-AR-023, T-AR-024, T-AR-050 ~ T-AR-056 | 22 |
| **DO-1** | agent-daemon | W-08 | T-DO-001~008, T-DO-019~023, T-DO-028~031, T-DO-035~036 | 18 |
| **DO-2** | agent-daemon | W-09~W-12 | T-DO-009~018, T-DO-024~027, T-DO-032~034, T-DO-037~040, T-PV-001~009 | 24 |
| **OR-1** | orchestrator + shared-utils | W-14 + W-17 | T-OR-001~007, T-SH-001~005 | 12 |
| **UI-1** | crish-desktop | W-18 | T-UI-001~010 | 10 |
| **AWB-1** | agent-workbench | W-AWB-1~4 | T-AWB-001~014 | 14 |
| **AWB-2** | agent-workbench | W-AWB-5~9 | T-AWB-015~028 | 14 |

### 2.2 写集隔离证明

```
RT-1 ∩ RT-2 = ∅  （不同 .ts 文件）
RT-* ∩ DO-* = ∅  （不同包: agent-runtime vs agent-daemon）
DO-1 ∩ DO-2 = ∅  （DO-1 = W-08 文件集，DO-2 = W-09~W-12 文件集，已证明不相交）
OR-1 ∩ * = ∅     （orchestrator + shared-utils 与其他包完全隔离）
UI-1 ∩ * = ∅     （apps/crish-desktop 与其他包完全隔离）
AWB-1 ∩ AWB-2 = ∅（AWB-1 = cli/*, AWB-2 = core/ + shared/*）
AWB-* ∩ * = ∅    （apps/agent-workbench 与其他包完全隔离）
```

### 2.3 Agent 写集与任务卡详表

---

#### Agent RT-1: agent-runtime — 流解析与事件（10 文件）

**写集**:
```
packages/agent-runtime/src/error-classifier.ts
packages/agent-runtime/src/anthropic-stream-parse.ts
packages/agent-runtime/src/gemini-stream-parse.ts
packages/agent-runtime/src/checkpoint-manifest.ts
packages/agent-runtime/src/checkpoint/checkpoint-manager.ts
packages/agent-runtime/src/conversation-boundary-manifest.ts
packages/agent-runtime/src/event-protocol/core-event-projector.ts
packages/agent-runtime/src/event-queue/index.ts
packages/agent-runtime/src/event-architecture/canonical-event.ts
packages/agent-runtime/src/git-versioning.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-AR-001 | error-classifier.ts | 63,70,77,83,89,96,105,112,119,126,133,140,148,154,160,166,174,180,186,193,198,209 | TS2379×22, TS2375×1 | 创建 mapped type: `type ClassifiedErrorInput<T> = { [K in keyof T]: T[K] \| undefined };` 替换所有 `Partial<T>` 入参 | `Select-String 'error-classifier'` → 0 行 |
| T-AR-002 | anthropic-stream-parse.ts | 58,202,242,255,264,303 | TS2322×5, TS2375×1 | `ProviderStreamEvent` 联合体不接受 `usage: ProviderUsage\|undefined`。修复: `...(usage ? { usage } : {})` 条件展开 6 处 | `Select-String 'anthropic-stream-parse'` → 0 行 |
| T-AR-003 | checkpoint-manifest.ts | 375,621 | TS2375×2 | 可选字段赋 `\|undefined`。修复: `...(field !== undefined ? { field } : {})` 2 处 | `Select-String 'checkpoint-manifest'` → 0 行 |
| T-AR-004 | checkpoint/checkpoint-manager.ts | 101 | TS2375×1 | `{ label: string\|undefined }` 不匹配 `CheckpointMetadata`。修复: `...(label && { label })` | `Select-String 'checkpoint-manager'` → 0 行 |
| T-AR-005 | event-protocol/core-event-projector.ts | 107,129,277,421 | TS2375×1, TS2322×3 | exactOptional + 联合体不匹配 + `DiagnosticDetails`。修复: 条件展开 + 扩宽联合体签名 | `Select-String 'core-event-projector'` → 0 行 |
| T-AR-006 | conversation-boundary-manifest.ts | 351,394 | TS2375×2 | `ConversationBoundaryManifestRecord` 可选字段。修复: 省略 undefined 字段 | `Select-String 'conversation-boundary-manifest'` → 0 行 |
| T-AR-007 | event-queue/index.ts | 200,262 | TS2412, TS2352 | `undefined` 不匹配 `Timeout`; 不安全类型转换。修复: L200 `as unknown as ReturnType<typeof setTimeout>`, L262 `as unknown` 中转 | `Select-String 'event-queue/index'` → 0 行 |
| T-AR-008 | event-architecture/canonical-event.ts | 483,484 | TS2322×2 | `diagnostic` 不在 `ConexEventDomain` 联合体。修复: 在联合体定义处追加 `\| 'diagnostic'` | `Select-String 'canonical-event'` → 0 行 |
| T-AR-009 | gemini-stream-parse.ts | 51,58,166,170,191,264,274,286,360 | TS2322×8, TS2375×1 | 同 T-AR-002 模式: `ProviderStreamEvent` 联合体修复 + 条件展开 9 处 | `Select-String 'gemini-stream-parse'` → 0 行 |
| T-AR-010 | git-versioning.ts | 411,464 | TS2379×2 | `Omit` exactOptional。修复: `...(toolCall ? { toolCall } : {})` 条件展开 | `Select-String 'git-versioning'` → 0 行 |

---

#### Agent RT-2: agent-runtime — Hooks 与工具链（12 文件）

**写集**:
```
packages/agent-runtime/src/goal-disk-oracle.ts
packages/agent-runtime/src/hooks/extension-registry.ts
packages/agent-runtime/src/hooks/tool-hook-observability.ts
packages/agent-runtime/src/local-tools/checkpoint-tools.ts
packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts
packages/agent-runtime/src/context-compression/token-estimator.ts
packages/agent-runtime/src/media/media-preprocessor.ts
packages/agent-runtime/src/memory.ts
packages/agent-runtime/src/model-routing-enhanced.ts
packages/agent-runtime/src/model-routing/matcher.ts
packages/agent-runtime/src/model-routing/profile.ts
packages/agent-runtime/src/model-routing-roles.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-AR-011 | goal-disk-oracle.ts | 76,91 | TS2379×2 | `{ detail: string\|undefined }` 不匹配 `{ detail?: string }`。修复: `...(detail !== undefined ? { detail } : {})` | `Select-String 'goal-disk-oracle'` → 0 |
| T-AR-012 | hooks/extension-registry.ts | 96,119,151 | TS2322×3 | 返回 `{ block: false, reason: undefined }` 不匹配。修复: 条件展开 `reason` 字段 | `Select-String 'extension-registry'` → 0 |
| T-AR-013 | hooks/tool-hook-observability.ts | 91,107,123,155,156,157 | TS2379×2, TS2345, TS2322×3 | `ToolHookContext` 不匹配 + `unknown` 类型。修复: 补可选字段 + 类型守卫 + 返回类型标注 | `Select-String 'tool-hook-observability'` → 0 |
| T-AR-014 | local-tools/checkpoint-tools.ts | 52,91,144 | TS2379×3 | exactOptional 在三个 request 类型。修复: 条件展开 undefined 字段 | `Select-String 'checkpoint-tools'` → 0 |
| T-AR-015 | local-tools/fs-edit-tools/edit-tool.ts | 3,142 | TS2305×2, TS2379 | 缺失导出 `replaceViaSeekSequence`, `SeekPass`。修复: 确认导出来源或替换导入路径 + exactOptional 条件展开 | `Select-String 'edit-tool'` → 0 |
| T-AR-016 | context-compression/token-estimator.ts | 123,196 | TS2375×2 | `ImageContent` / `ProviderUsage` 可选字段。修复: 条件展开 `width/height/detail` | `Select-String 'token-estimator'` → 0 |
| T-AR-017 | media/media-preprocessor.ts | 21,109,116 | TS6133, TS2375, TS2379 | 删除未使用 `mimeCategory` 导入 + exactOptional 条件展开 | `Select-String 'media-preprocessor'` → 0 |
| T-AR-018 | memory.ts | 356,389 | TS2379×2 | `Omit` exactOptional。修复: 条件展开 `metadata/query/scope/limit` | `Select-String 'memory.ts'` → 0 |
| T-AR-019 | model-routing-enhanced.ts | 78 | TS2375 | `minimumContextTokens: number\|undefined`。修复: 条件展开 | `Select-String 'model-routing-enhanced'` → 0 |
| T-AR-020 | model-routing/matcher.ts | 10,11,25,26,30,31,40,88,465 | TS6133×6, TS2375×2 | 删除 6 个未使用导入 + exactOptional 条件展开 | `Select-String 'matcher'` → 0 |
| T-AR-021 | model-routing/profile.ts | 3,23,52,103,104,110,121,146 | TS6196, TS2379×2, TS2375×5 | 删除未使用 `ModelCapabilityFlags` + exactOptional 多处条件展开 | `Select-String 'profile.ts'` → 0 |
| T-AR-022 | model-routing-roles.ts | 1,230,233,236,239 | TS6196, TS2412×4 | 删除未使用 `ModelCapabilityTag` + `ModelProfile\|undefined` 分配用非空断言或默认值 | `Select-String 'model-routing-roles'` → 0 |

---

#### Agent RT-3: agent-runtime — Provider 核心（12 文件）

**写集**:
```
packages/agent-runtime/src/preview-queue.ts
packages/agent-runtime/src/process-lifecycle/process-manager.ts
packages/agent-runtime/src/project-progress-ledger.ts
packages/agent-runtime/src/prompt-assembly.ts
packages/agent-runtime/src/provider-anthropic.ts
packages/agent-runtime/src/provider-gemini.ts
packages/agent-runtime/src/provider-openai-compatible.ts
packages/agent-runtime/src/provider-openai-chat.ts
packages/agent-runtime/src/provider-openai-responses.ts
packages/agent-runtime/src/provider-request-machine.ts
packages/agent-runtime/src/provider-stream-contract/error.ts
packages/agent-runtime/src/provider-transport/connection-manager.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-AR-025 | preview-queue.ts | 247,365 | TS2375×2 | `PreviewTransitionUpdate` / `PreviewArtifactInput` 可选字段。条件展开 | `Select-String 'preview-queue'` → 0 |
| T-AR-026 | process-lifecycle/process-manager.ts | 132,319,323 | TS2412×3 | `number\|undefined` 不匹配 `number`; `undefined` 不匹配 `Timeout`。修复: `?? 0` 空值合并 + 默认值 | `Select-String 'process-manager'` → 0 |
| T-AR-027 | project-progress-ledger.ts | 136,158 | TS2375×2 | `GlobalProgressItemRecord` 可选字段。条件展开 `summary` | `Select-String 'project-progress-ledger'` → 0 |
| T-AR-028 | prompt-assembly.ts | 144,206,215 | TS2375, TS2379×2 | `PromptAssemblyPayload` 和 `{ id, label }` exactOptional。条件展开 | `Select-String 'prompt-assembly'` → 0 |
| T-AR-029 | provider-anthropic.ts | 106,220 | TS2379×2 | `BuildAnthropicMessagesBodyOptions` / `AnthropicProviderOptions`。修复: `...(systemPrompt ? { systemPrompt } : {})` 等 | `Select-String 'provider-anthropic'` → 0 |
| T-AR-030 | provider-gemini.ts | 111,235 | TS2379×2 | 同 T-AR-029 模式 | `Select-String 'provider-gemini'` → 0 |
| T-AR-031 | provider-openai-compatible.ts | 101,256,389 | TS2379, TS2375×2 | `Omit` exactOptional + `HttpRequest.timeoutMs` | `Select-String 'provider-openai-compatible'` → 0 |
| T-AR-032 | provider-openai-chat.ts | 19,73,94,105 | TS6192, TS2322×3 | 删除整个未使用 import + 重构 `ProviderStreamEvent` 对象或扩宽联合体 | `Select-String 'provider-openai-chat'` → 0 |
| T-AR-033 | provider-openai-responses.ts | 92,141 | TS2322×2 | `ProviderStreamEvent` 联合体不匹配。同 T-AR-032 | `Select-String 'provider-openai-responses'` → 0 |
| T-AR-034 | provider-request-machine.ts | 327 | TS2379 | `{ initialContext?, snapshot? }` exactOptional。条件展开 | `Select-String 'provider-request-machine'` → 0 |
| T-AR-035 | provider-stream-contract/error.ts | 29 | TS2379 | `ErrorClassifierOptions` exactOptional。条件展开 `status` | `Select-String 'error.ts'` → 0 |
| T-AR-036 | provider-transport/connection-manager.ts | 129,149,304 | TS2322×2, TS2379 | `ProviderTransport\|undefined` 不匹配 `\|null`。修复: `?? null` 空值合并 + exactOptional | `Select-String 'connection-manager'` → 0 |

---

#### Agent RT-4: agent-runtime — Gateway 与运行时组件（15 文件）

**写集**:
```
packages/agent-runtime/src/provider-gateway/credential-resolver.ts
packages/agent-runtime/src/provider-gateway/index.ts
packages/agent-runtime/src/provider-gateway/route-selector.ts
packages/agent-runtime/src/runtime-metrics/collectors.ts
packages/agent-runtime/src/runtime-metrics/snapshot.ts
packages/agent-runtime/src/runtime-components/context-manager.ts
packages/agent-runtime/src/runtime-components/conversation-engine.ts
packages/agent-runtime/src/scoped-context.ts
packages/agent-runtime/src/scoped-context-resources.ts
packages/agent-runtime/src/state-machine/core.ts
packages/agent-runtime/src/subagent-loop.ts
packages/agent-runtime/src/tool-output-budget.ts
packages/agent-runtime/src/tool-output-guard.ts
packages/agent-runtime/src/tools/tool-definition.ts
packages/agent-runtime/src/rich-read.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-AR-037 | provider-gateway/credential-resolver.ts | 3,4,8,14,26 | TS6196, TS6133, TS2375×3 | 删除未使用导入 + exactOptional 3 处 | `Select-String 'credential-resolver.ts'` → 0 |
| T-AR-038 | provider-gateway/index.ts | 多行 | TS6133×5, TS2412×4, TS2379×4, TS2375×3 | 删除 5 个未使用导入 + exactOptional 多处 | `Select-String 'provider-gateway/index'` → 0 |
| T-AR-039 | provider-gateway/route-selector.ts | 2,45,126,188,233,251,268,273,282,292,342,351,403 | TS6133×2, TS2375×13, TS2412 | 删除 2 未使用导入 + 13 处 exactOptional 条件展开 | `Select-String 'route-selector.ts'` → 0 |
| T-AR-040 | runtime-metrics/collectors.ts | 6,7,9,10,18,78,125,134,140,170,222,261,264,266,270,282,283 | TS6133×6, TS2379×8, TS2339×2 | 精简导入 + 8 处条件展开 + 补缺失属性 | `Select-String 'collectors.ts'` → 0 |
| T-AR-041 | runtime-metrics/snapshot.ts | 4,12,13,111,182,300,305 | TS2459, TS6133×5, TS2375, TS2379×5 | `JsonObject` 未导出→修正导入路径 + 删除未使用 + exactOptional | `Select-String 'snapshot.ts'` → 0 |
| T-AR-042 | runtime-components/context-manager.ts | 78,139,167,177 | TS2379×2, TS2375×2 | `ContextCompressionRuntimeOptions` + `ContextProjectionOptions` exactOptional | `Select-String 'context-manager.ts'` → 0 |
| T-AR-043 | runtime-components/conversation-engine.ts | 219,281,294 | TS2375×2, TS2412 | `TurnResult` + `ConversationSnapshot` + `string\|undefined` 不匹配 `string`。条件展开 + 默认值 | `Select-String 'conversation-engine.ts'` → 0 |
| T-AR-044 | scoped-context.ts | 112,134,335 | TS2375×3 | `ScopedContextRecord` / `ScopedContextCandidate`。条件展开 `description/source/reason` | `Select-String 'scoped-context.ts'` → 0 |
| T-AR-045 | scoped-context-resources.ts | 91,195,225 | TS2375×2, TS2379 | `ScopedContextResolverProject` / `ScopedRuleInput`。exactOptional | `Select-String 'scoped-context-resources'` → 0 |
| T-AR-046 | state-machine/core.ts | 100,307 | TS2379, TS2375 | `StateDefinition` + `TransitionTarget` exactOptional。条件展开回调属性 | `Select-String 'core.ts'` → 0 |
| T-AR-047 | subagent-loop.ts | 1,56,65 | TS6196, TS2379, TS2375 | 删除未使用 `JsonObject` + exactOptional | `Select-String 'subagent-loop'` → 0 |
| T-AR-048 | tool-output-budget.ts (L56) + tool-output-guard.ts (L87) | 56,87 | TS2375×2 | `ToolOutput` 可选 `artifacts` 字段。条件展开 | `Select-String 'tool-output'` → 0 |
| T-AR-049 | tools/tool-definition.ts | 54,55,124,131 | TS2412×2, TS2379×2 | `JsonObject\|undefined` / `Record\|undefined` 不匹配。修复: `?: Type` → `: Type \| undefined`（含 Plan05 F-12 归并） | `Select-String 'tool-definition'` → 0 |
| T-AR-054 | rich-read.ts | 183,259,294 | TS2322×2, TS2375 | 函数签名缺 `context` 参数 + exactOptional。补参数 + 条件展开 | `Select-String 'rich-read'` → 0 |

---

#### Agent RT-5: agent-runtime — Plan-doc, Provider-auth, 批量修复（22 文件）

**写集**:
```
packages/agent-runtime/src/plan-document/index.ts
packages/agent-runtime/src/plan-document/validation.ts
packages/agent-runtime/src/plan-document/operations.ts
packages/agent-runtime/src/provider/auth/credential-pool.ts
packages/agent-runtime/src/provider/auth/credential-resolver.ts
packages/agent-runtime/src/provider/auth/key-rotation.ts
packages/agent-runtime/src/rendering/rendering-pipeline.ts
packages/agent-runtime/src/runtime.ts
packages/agent-runtime/src/secrets-obfuscation.ts
packages/agent-runtime/src/trace/index.ts
packages/agent-runtime/src/tool-discovery.ts
packages/agent-runtime/src/structured-summary.ts
packages/agent-runtime/src/skills.ts
packages/agent-runtime/src/workspace-mutation-coordinator.ts
packages/agent-runtime/src/session.ts
packages/agent-runtime/src/subagents.ts
packages/agent-runtime/src/background-command.ts
packages/agent-runtime/src/chatgpt-pool.ts
packages/agent-runtime/src/normalizer.ts
packages/agent-runtime/src/stream-recovery.ts
packages/agent-runtime/src/context-compression/serializer.ts
packages/agent-runtime/src/fallback-chain/types.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-AR-023 | plan-document/index.ts + validation.ts | 多行 | TS6196×14, TS1361×20 | 删除 14 个未使用 type import + 20 处 `import type` → `import`（因值被用于运行时） | `Select-String 'plan-document/'` → 0 |
| T-AR-024 | plan-document/operations.ts | 1,2,4,200,212,238,252,262,267,272,279,285 | TS6196, TS6133×2, TS2412×4, TS2322×5 | 删除未使用 + 空值合并 `?? []` + 数组类型变换 `as readonly T[]` | `Select-String 'operations.ts'` → 0 |
| T-AR-050 | provider/auth/credential-pool.ts | 1,53,56,82,86,89,103,104,140,141 | TS6133, TS2412×6, TS2322×3 | 删除未使用 `createSecret` + `\|undefined` 不匹配→用 `\|null` 或默认值 | `Select-String 'credential-pool'` → 0 |
| T-AR-051 | provider/auth/credential-resolver.ts | 27,28,102 | TS2412×3 | `SecretValue\|undefined` / `SecretStore\|undefined` 不匹配。修复: `!` 非空断言或提供默认值 | `Select-String 'credential-resolver.ts'` → 0 |
| T-AR-052 | provider/auth/key-rotation.ts | 1,60,63,73,74 | TS6133, TS2322×2, TS2412×2 | 删除未使用 + `KeyEntry\|undefined` 不匹配 `\|null`→统一用 `null` | `Select-String 'key-rotation'` → 0 |
| T-AR-055 | rendering/rendering-pipeline.ts | 225,433 | TS2379×2 | `Omit` exactOptional + `{ stage, timestamp, detail? }`。条件展开 | `Select-String 'rendering-pipeline'` → 0 |
| T-AR-056 | 批量 12 文件 | 各 1~3 错误 | 混合 | **含 Plan05 归并**: normalizer.ts → `export legacyFinishReason` + 修复 `isRawToolCall` 类型谓词; session.ts → 确认 `blocks` 用法; subagents.ts → 验证条件展开; trace/index.ts → `SpanEvent.attributes ?: → : Type\|undefined`; chatgpt-pool.ts → `ChatGPTAccount.refreshToken ?: → : string\|undefined`; background-command.ts → `BackgroundCommandRecord` 字段 `?: → : Type\|undefined`; stream-recovery.ts → exactOptional; 其余文件各 1~2 处条件展开 | 逐文件 `Select-String` → 0 |

---

#### Agent DO-1: agent-daemon — exactOptional 批量（18 文件）

**写集**:
```
packages/agent-daemon/src/approval-queue.ts
packages/agent-daemon/src/background-task-manager.ts
packages/agent-daemon/src/conversation-rewind-boundary.ts
packages/agent-daemon/src/daemon-approval-handler.ts
packages/agent-daemon/src/daemon-client-registry.ts
packages/agent-daemon/src/daemon-lifecycle.ts
packages/agent-daemon/src/daemon-logger.ts
packages/agent-daemon/src/index.ts
packages/agent-daemon/src/mcp-config.ts
packages/agent-daemon/src/mcp-stdio-adapter.ts
packages/agent-daemon/src/scoped-context-runtime.ts
packages/agent-daemon/src/scoped-context-store.ts
packages/agent-daemon/src/server/connection-manager.ts
packages/agent-daemon/src/server/approval-bridge.ts
packages/agent-daemon/src/server/workflow-manager.ts
packages/agent-daemon/src/server/index.ts
packages/agent-daemon/src/types/config.ts
packages/agent-daemon/src/types/entities.ts
```

> **统一修复策略**: daemon 包的公有接口采用**接口定义修改** (`?:` → `: Type | undefined`)，内部赋值处同步去除冗余条件展开。

| ID | 文件 | 行号 | 错误码 | 修改逻辑 | 单卡验收 |
|---|---|---|---|---|---|
| T-DO-001 | approval-queue.ts | 128,263,316,333 | TS2375×2, TS2412, TS2379 | `PendingApproval` 接口 `?: → : Type\|undefined` | `Select-String 'approval-queue'` → 0 |
| T-DO-002 | background-task-manager.ts | 208 | TS2375 | `DaemonBackgroundTaskSnapshot` 的 `finishedAt?: → : string\|undefined` | `Select-String 'background-task-manager'` → 0 |
| T-DO-004 | conversation-rewind-boundary.ts | 97,120,213 | TS2379×2, TS2375 | 接口 `?: → \|undefined` 3 处 | `Select-String 'conversation-rewind-boundary'` → 0 |
| T-DO-005 | daemon-approval-handler.ts | 50,114 | TS2379 | `command?: string` 传 `string\|undefined`。接口改 `\|undefined` + **Plan05 F-13 合并**: `timeoutMs: number\|null → number\|null\|undefined` | `Select-String 'daemon-approval-handler'` → 0 |
| T-DO-006 | daemon-client-registry.ts | 53,57,137,216,236 | TS2412×2, TS2379×3 | 回调类型不匹配 + 传参含 `\|undefined`。接口加 `\|undefined` | `Select-String 'daemon-client-registry'` → 0 |
| T-DO-007 | daemon-lifecycle.ts | 165 | TS2375 | `failure: DaemonLifecycleDiagnostic\|undefined` 不匹配 `failure?:`。接口改 `\|undefined` | `Select-String 'daemon-lifecycle'` → 0 |
| T-DO-008 | daemon-logger.ts | 9,42 | TS2375, TS2412 | `stack: string\|undefined` + `stream: WriteStream\|undefined` | `Select-String 'daemon-logger'` → 0 |
| T-DO-019 | index.ts | 188 | TS2375 | `Partial` 含 `\|undefined`。修复: `...(secretToken ? { secretToken } : {})` | `Select-String 'daemon.*index'` → 0 |
| T-DO-020 | mcp-config.ts | 192 | TS2379 | `{ env: Record\|undefined }` 传给 `StdioMcpAdapterOptions`。接口改 `\|undefined` | `Select-String 'mcp-config'` → 0 |
| T-DO-021 | mcp-stdio-adapter.ts | 181 | TS2375 | `AgentTool.inputSchema?: JsonObject` 赋值含 `\|undefined`。改 `: JsonObject\|undefined` | `Select-String 'mcp-stdio-adapter'` → 0 |
| T-DO-022 | scoped-context-runtime.ts | 245,249,253 | TS2375×3 | `ScopedContextResourcePathSet` 的 `files?:, dirs?:` → `\|undefined` | `Select-String 'scoped-context-runtime'` → 0 |
| T-DO-023 | scoped-context-store.ts | 63 | TS2375 | `ScopedContextQueryResult.diagnostic?:` → `\|undefined` | `Select-String 'scoped-context-store'` → 0 |
| T-DO-028 | server/connection-manager.ts | 4,38,71,134,315,357,360 | TS6196×3, TS2379×5, TS2352 | 删除未使用 + exactOptional + 类型转换 `as unknown as` | `Select-String 'server/connection-manager'` → 0 |
| T-DO-029 | server/approval-bridge.ts | 63 | TS2379 | `ApprovalDecision.reason?: → : string\|undefined` | `Select-String 'server/approval-bridge'` → 0 |
| T-DO-030 | server/workflow-manager.ts | 23,51,62 | TS2412×3 | 非可选字段赋 `undefined`。字段类型加 `\|undefined` | `Select-String 'server/workflow-manager'` → 0 |
| T-DO-031 | server/index.ts | 6,72~82,125,142,147~169,204,214,220,237~255,295,371,381,429,460 | TS2305, TS2339×5, TS2379×8, TS2412×2, TS6133, TS2559, TS2352×3, TS2554 | 混合修复: 补缺失导出/属性 + exactOptional + 删未使用 + 参数数修正 | `Select-String 'server/index'` → 0 |
| T-DO-035 | types/config.ts | 56 | TS2375 | `DEFAULT_DAEMON_CONFIG` 赋 `undefined`。接口改 `secretToken: string\|undefined` | `Select-String 'types/config'` → 0 |
| T-DO-036 | types/entities.ts | 多行 | TS2375 | 实体接口批量 `?: → \|undefined` | `Select-String 'types/entities'` → 0 |

---

#### Agent DO-2: agent-daemon — Gateway / Handlers / Protocol（24 文件）

**写集**:
```
packages/agent-daemon/src/daemon-provider-gateway/credential-modes.ts
packages/agent-daemon/src/daemon-provider-gateway/health.ts
packages/agent-daemon/src/daemon-provider-gateway/index.ts
packages/agent-daemon/src/daemon-provider-gateway/provider-factory.ts
packages/agent-daemon/src/daemon-provider-gateway/types.ts
packages/agent-daemon/src/handlers/background-task-handlers.ts
packages/agent-daemon/src/handlers/pending-input-handlers.ts
packages/agent-daemon/src/handlers/run-handlers.ts
packages/agent-daemon/src/handlers/session-handlers.ts
packages/agent-daemon/src/server-handlers.ts
packages/agent-daemon/src/session-query-handlers.ts
packages/agent-daemon/src/server-runtime-factory/index.ts
packages/agent-daemon/src/server-runtime-factory/mcp-factory.ts
packages/agent-daemon/src/server-runtime-factory/tool-assembly.ts
packages/agent-daemon/src/daemon-product-adapters.ts
packages/agent-daemon/src/subagent-runtime.ts
packages/agent-daemon/src/subagent-lifecycle.ts
packages/agent-daemon/src/capabilities.ts
packages/agent-daemon/src/workflow-store/index.ts
packages/agent-daemon/src/workflow-store/storage-engine.ts
packages/agent-daemon/src/types/provider-types.ts
packages/agent-daemon/src/protocol/protocol.ts
packages/agent-daemon/src/protocol/validators/common.ts
packages/agent-daemon/src/protocol/validators/background.ts
```

> 含 W-09 (5 files), W-10 (10 files), W-11 (9 files, 含 T-DO-033 + Plan05 F-14 合并), W-12 部分 (protocol)

| ID | 文件 | 错误码 | 修改逻辑 |
|---|---|---|---|
| T-DO-010~014 | daemon-provider-gateway/*.ts (5 files) | TS2375, TS2379, TS6133, TS2322 | 接口 `?: → \|undefined` + 删未使用 + 类型修正 |
| T-DO-015~018 | handlers/*.ts (4 files) | TS2379, TS2375, TS2412 | exactOptional 条件展开 + 接口修改 |
| T-DO-024~027 | server-handlers.ts, server-runtime-factory/*.ts, session-query-handlers.ts | 混合 | exactOptional + 缺失属性补全 |
| T-DO-032 | session-query-handlers.ts | TS2379 | exactOptional |
| T-DO-033 | subagent-runtime.ts **[+Plan05 F-14]** | TS2322, TS2352 | 删除 `toJsonObject`/`JsonValue` 引用 + `as unknown as` 安全转型 |
| T-DO-034 | subagent-lifecycle.ts | TS2375 | 条件展开 |
| T-DO-003,009,037~040 | capabilities.ts, daemon-product-adapters.ts, workflow-store/*.ts, types/provider-types.ts | 混合 | 接口修改 + 条件展开 |
| T-PV-001~009 | protocol/validators/*.ts, protocol/protocol.ts (9 files) | TS2322 | Zod 推导型变修复: 接口 `?: → \|undefined`（因 Zod 需要精确类型匹配） |

**单卡验收**: 所有卡统一使用 `npx tsc --noEmit -p packages/agent-daemon/tsconfig.json 2>&1 | Out-String -Stream | Select-String '<filename>'` → 0 行

---

#### Agent OR-1: orchestrator + shared-utils（12 文件）

**写集**:
```
packages/agent-orchestrator/src/artifact-store.ts
packages/agent-orchestrator/src/conversation-rewind.ts
packages/agent-orchestrator/src/event-scan-goal-strategy.ts
packages/agent-orchestrator/src/event-store-projection.ts
packages/agent-orchestrator/src/event-store.ts
packages/agent-orchestrator/src/orchestrator.ts
packages/agent-orchestrator/src/task-assessment.ts
packages/shared-utils/src/streaming-jsonl-reader.ts
packages/shared-utils/src/hardware-profile.ts
packages/shared-utils/src/jsonl-append-batcher.ts
packages/shared-utils/src/mockFactories.ts
packages/shared-utils/src/bounded-map.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 |
|---|---|---|---|---|
| T-OR-001 | artifact-store.ts | 107 | TS2375 | `encoding?: → : 'utf8'\|'binary'\|undefined` |
| T-OR-002 | conversation-rewind.ts | 165,257 | TS2379, TS2375 | 接口 `?: → \|undefined` |
| T-OR-003 | event-scan-goal-strategy.ts | 23 | TS2420 | class 未实现 `GoalLoopStrategy` 接口。补充缺失方法签名 |
| T-OR-004 | event-store-projection.ts | 108,125 | TS2379×2 | `StoredEventReadOptions.maxEvents?:` / `AgentMessage.metadata?:`。接口改 `\|undefined` |
| T-OR-005 | event-store.ts | 143,149,160,183,413,789,807,814,1102 | TS2412×4, TS2379×4, TS2375 | exactOptional 多处。接口 + 变量声明加 `\|undefined` |
| T-OR-006 | orchestrator.ts | 78,110,290,300,390~438,495,649,680,703~751,1017,1175,1673~1696 | TS2375, TS2355, TS2379×9, TS2304×3, TS2412, TS2339×6 | **高密度文件 (~22 errors)**。混合: exactOptional + 返回类型 + 未声明变量 + `AsyncQueue.buffer` 缺失属性 |
| T-OR-007 | task-assessment.ts | 573 | TS2375 | `GoalContinuationDecision` 的 `detail?:, progressSignature?:, prompt?:`。接口 `→ \|undefined` |
| T-SH-001 | streaming-jsonl-reader.ts | — | TS2379 | `highWaterMark` exactOptional 条件展开 |
| T-SH-002 | hardware-profile.ts | — | TS2375 | `deviceMemory` 条件展开 |
| T-SH-003 | jsonl-append-batcher.ts | — | TS2375 | `signal` 条件展开 |
| T-SH-004 | mockFactories.ts | — | TS2375 | `secretToken` 硬编码修复 |
| T-SH-005 | bounded-map.ts | — | TS2412 | **Plan05 F-04 归并**: constructor `onEvict?: → : ((k,v) => void) \| undefined` |

**单卡验收**: `Select-String '<filename>'` → 0 行（分别用 orchestrator 和 shared-utils 的 tsconfig）

---

#### Agent UI-1: crish-desktop JSX（10 文件）

**写集**:
```
apps/crish-desktop/src/components/CardPanel.tsx
apps/crish-desktop/src/components/ChatHeaderMore.tsx
apps/crish-desktop/src/components/ChatStatusRibbons.tsx
apps/crish-desktop/src/components/ComposePlusMenu.tsx
apps/crish-desktop/src/components/DiffCardFileList.tsx
apps/crish-desktop/src/components/DiffCardGitActions.tsx
apps/crish-desktop/src/components/ModelPicker.tsx
apps/crish-desktop/src/components/QuickOpen.tsx
apps/crish-desktop/src/components/SettingsPanel.tsx
apps/crish-desktop/src/components/WorkspaceChromeBars.tsx
```

| ID | 文件 | 错误码 | 修改逻辑 |
|---|---|---|---|
| T-UI-001 | CardPanel.tsx | 8 errors, 复合 | 8 处断裂的 JSX 结构。需 Read 确认后修复闭合标签 |
| T-UI-002~007 | ChatHeaderMore / ChatStatusRibbons / ComposePlusMenu / DiffCardFileList / DiffCardGitActions / ModelPicker | TS1005 各 1 处 | `React.memo` 结尾修复: `));` → `});` |
| T-UI-008 | QuickOpen.tsx | TS1005 + TS17002 | 删除冗余 `<button>` 标签 |
| T-UI-009 | SettingsPanel.tsx | TS1005 + TS1128 | `));` → `});` + 删除冗余 `};` |
| T-UI-010 | WorkspaceChromeBars.tsx | 13 errors | `onClick` 未闭合。补全 `onClick` 回调闭合 + 补 `</button>` |

**轮次验收**: `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Out-String -Stream | Select-String 'error TS'` → 0 行

---

#### Agent AWB-1: agent-workbench — CLI（14 文件）

**写集**:
```
apps/agent-workbench/src/cli/goal-runner.ts
apps/agent-workbench/src/cli/main.ts
apps/agent-workbench/src/cli/provider-add.ts
apps/agent-workbench/src/cli/provider-dev.ts
apps/agent-workbench/src/cli/provider-test.ts
apps/agent-workbench/src/cli/provider-utils.ts
apps/agent-workbench/src/cli/provider-validate.ts
apps/agent-workbench/src/cli/run-registry.ts
apps/agent-workbench/src/cli/runtime-factory.ts
apps/agent-workbench/src/cli/runtime-factory.test.ts
apps/agent-workbench/src/cli/workbench-runner.ts
apps/agent-workbench/src/cli/snapshot-aware-goal-strategy.ts
apps/agent-workbench/src/core/tauri-command-registry.ts
apps/agent-workbench/src/core/tauri-command-registry.test.ts
```

| ID | 文件 | 行号 | 错误码 | 修改逻辑 |
|---|---|---|---|---|
| T-AWB-001 | cli/goal-runner.ts | 107,123~125,143~175,186~188,251~279 | TS2379×10+, TS2375×6+ | 接口 `field?: Type` → `field: Type \| undefined` |
| T-AWB-002 | cli/main.ts | 131,158,182,210,220,227,246,308,369,386 | TS2375×5+, TS2379×4+ | 同上模式 |
| T-AWB-003 | cli/provider-add.ts | 2,75,92~93,197,210,222,296 | TS6133, TS2379×2, TS2375, TS6196 | 删未使用导入 + 接口修改 |
| T-AWB-004 | cli/provider-dev.ts | 10,24,43,65,82 | TS2375, TS2379 | 接口 `?: → \|undefined` |
| T-AWB-005 | cli/provider-test.ts | 1~3,95~155,184~456 | TS6133×3, TS2379×12+ | 删未使用导入 (`InferOutput`, `z`, `ProviderConfig`) + exactOptional |
| T-AWB-006 | cli/provider-utils.ts | 4 | TS6133 | 删除 1 个未使用导入 |
| T-AWB-007 | cli/provider-validate.ts | 4,82 | TS6133, TS2322 | 删未使用 + 修复返回类型 |
| T-AWB-008 | cli/run-registry.ts | 116,154,170 | TS2375, TS2379 | `RunRecord` 接口 `?: → \|undefined` |
| T-AWB-009 | cli/runtime-factory.ts | 99,117,137,149,191,248 | TS2375, TS2379 | 接口修改 |
| T-AWB-010 | cli/runtime-factory.test.ts | 189,216 | TS2375 | 条件展开或 `!` 断言 |
| T-AWB-011 | cli/workbench-runner.ts | 32,378,536,573,730,740,803,948 | TS2379, TS2375 | 接口 `?: → \|undefined` |
| T-AWB-012 | cli/snapshot-aware-goal-strategy.ts | 18,114,189,322 | TS2375, TS2379 | 接口修改 |
| T-AWB-013 | core/tauri-command-registry.ts | 465,675,756,800 | TS2379, TS2375, TS2352 | 接口修改 + `as T → as unknown as T` |
| T-AWB-014 | core/tauri-command-registry.test.ts | 359,363 | TS2375, TS2322 | 条件展开或类型断言 |

**单卡验收**: `npx tsc --noEmit -p apps/agent-workbench/tsconfig.json 2>&1 | Out-String -Stream | Select-String '<filename>'` → 0 行

---

#### Agent AWB-2: agent-workbench — Shared（14 文件）

**写集**:
```
apps/agent-workbench/src/shared/background-command-bridge.ts
apps/agent-workbench/src/shared/background-tasks.ts
apps/agent-workbench/src/shared/disclosure-diagnostics.ts
apps/agent-workbench/src/shared/output-references.ts
apps/agent-workbench/src/shared/perf-backend.ts
apps/agent-workbench/src/shared/runtime-bridge.ts
apps/agent-workbench/src/shared/task-controller.ts
apps/agent-workbench/src/shared/workbench-config/defaults.ts
apps/agent-workbench/src/shared/workbench-contract/config.ts
apps/agent-workbench/src/shared/workbench-contract/daemon-session.ts
apps/agent-workbench/src/shared/workbench-contract/guards.ts
apps/agent-workbench/src/shared/workbench-contract/plan-document.ts
apps/agent-workbench/src/shared/workbench-contract/ui-projections.ts
apps/agent-workbench/src/shared/workbench-contract/workbench-ui.ts
```

| ID | 文件 | 错误码 | 修改逻辑 |
|---|---|---|---|
| T-AWB-015 | background-command-bridge.ts | TS2379, TS2412 | 接口 `?: → \|undefined` |
| T-AWB-016 | background-tasks.ts | TS2375, TS2379, TS2412 | 接口修改 |
| T-AWB-017 | disclosure-diagnostics.ts | TS2375, TS2379 | 条件展开 undefined 字段 |
| T-AWB-018 | output-references.ts | TS2375, TS2379 | 条件展开 |
| T-AWB-019 | perf-backend.ts | TS2379, TS2375 | 接口 `?: → \|undefined` |
| T-AWB-020 | runtime-bridge.ts | TS6133 | 删除 1 个未使用导入 |
| T-AWB-021 | task-controller.ts | TS2379 | 条件展开 |
| T-AWB-022 | workbench-config/defaults.ts | TS2375, TS2379 | 接口修改 |
| T-AWB-023 | workbench-contract/config.ts | TS6133 | 删除未使用导入 |
| T-AWB-024 | workbench-contract/daemon-session.ts | TS6196 | 删除未使用 type export |
| T-AWB-025 | workbench-contract/guards.ts | TS6133 | 删除未使用导入 |
| T-AWB-026 | workbench-contract/plan-document.ts | TS6196 | 删除未使用 type export |
| T-AWB-027 | workbench-contract/ui-projections.ts | TS6133×3 | 删除 3 个未使用导入 |
| T-AWB-028 | workbench-contract/workbench-ui.ts | TS6133 | 删除未使用导入 |

---

### 2.4 Round 1 轮次验收命令

```powershell
# === Round 1 分包验收 ===

# 1. agent-runtime
npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0（源码部分；测试文件错误在 Round 2 处理，此处仅计源码）

# 2. agent-daemon
npx tsc --noEmit -p packages/agent-daemon/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count 显著下降（目标: 仅残留测试文件错误）

# 3. agent-orchestrator
npx tsc --noEmit -p packages/agent-orchestrator/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：源码错误 Count == 0

# 4. agent-workbench
npx tsc --noEmit -p apps/agent-workbench/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0

# 5. crish-desktop
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0

# 6. shared-utils
npx tsc --noEmit -p packages/shared-utils/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0
```

---

## 3. Round 2 — 测试文件修复

### 3.1 Agent 分配（9 Agents）

| Agent | 波次来源 | 任务卡 | 文件数 | 写集范围 |
|---|---|---|:---:|---|
| **TS-1** | W-02 batch 1 | T-AR-057 (part), T-AR-061 | 12 | `packages/agent-runtime/src/__tests__/*.test.ts` |
| **TS-2** | W-02 batch 2 | T-AR-058, T-AR-059, T-AR-060 | 12 | `packages/agent-runtime/src/provider/__tests__/**` |
| **TS-3** | W-02 batch 3 | T-AR-062, T-AR-063 | 12 | `packages/agent-runtime/src/provider/engines/*.test.ts` + gateway tests |
| **TS-4** | W-13 | T-DT-001 ~ T-DT-007 | 7 | `packages/agent-daemon/src/**/*.test.ts` |
| **TS-5** | W-15 | T-OR-008 ~ T-OR-010 | 3 | `packages/agent-orchestrator/src/**/*.test.ts` |
| **TS-6** | W-19 batch 1 | T-TS-001 ~ T-TS-012 | 12 | runtime test files (补集 1) |
| **TS-7** | W-19 batch 2 | T-TS-013 ~ T-TS-024 | 12 | runtime test files (补集 2) |
| **TS-8** | W-19 batch 3 | T-TS-025 ~ T-TS-036 | 12 | runtime test files (补集 3) |
| **TS-9** | W-19 batch 4 | T-TS-037 ~ T-TS-048 | 12 | runtime test files (补集 4) |

### 3.2 写集隔离证明

```
TS-1 ∩ TS-2 = ∅  （不同 __tests__ 子目录）
TS-* (1~3) ∩ TS-* (6~9) = ∅  （W-02 vs W-19，文件预分配不重叠）
TS-4 ∩ * = ∅     （daemon 测试 vs runtime 测试，不同包）
TS-5 ∩ * = ∅     （orchestrator 测试，不同包）
Round 2 全集 ∩ Round 1 全集 = ∅  （源码 vs 测试，不同文件集）
```

### 3.3 任务卡概要

> 测试文件修复遵循与源码相同的 exactOptional / 删未使用 / 类型修正模式。每个测试文件的修复策略为:
> 1. 删除未使用导入 (TS6133/TS6196)
> 2. 条件展开 mock 对象中的可选字段 (TS2375/TS2379)
> 3. 补全 mock 对象缺失的必选属性 (TS2739/TS2741)
> 4. 类型断言修复不安全转型 (TS2352)

**Agent TS-1 写集** (12 files):
```
packages/agent-runtime/src/__tests__/canonical-schema.test.ts
packages/agent-runtime/src/__tests__/canonicalize-tools.test.ts
packages/agent-runtime/src/__tests__/context-slicer.test.ts
packages/agent-runtime/src/__tests__/steering-input-queue.test.ts
packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts
packages/agent-runtime/src/__tests__/integrations/media-pipeline.test.ts
packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts
packages/agent-runtime/src/__tests__/integrations/streaming-executor.test.ts
packages/agent-runtime/src/__tests__/integrations/tool-stream.test.ts
packages/agent-runtime/src/runtime-components/conversation-engine.test.ts
packages/agent-runtime/src/runtime-components/provider-response-consumer.test.ts
packages/agent-runtime/src/runtime-components/tool-executor.test.ts
```

**Agent TS-2 写集** (12 files):
```
packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts
packages/agent-runtime/src/provider/__tests__/factory.test.ts
packages/agent-runtime/src/provider/__tests__/base-engine.test.ts
packages/agent-runtime/src/provider/__tests__/e2e/context-length-recovery.test.ts
packages/agent-runtime/src/provider/__tests__/e2e/provider-factory.test.ts
packages/agent-runtime/src/provider/__tests__/e2e/exponential-backoff-e2e.test.ts
packages/agent-runtime/src/provider/__tests__/benchmarks/provider-lifecycle.bench.ts
packages/agent-runtime/src/provider/__tests__/registry.test.ts
packages/agent-runtime/src/provider-gateway-edge.test.ts
packages/agent-runtime/src/provider-gateway.test.ts
packages/agent-runtime/src/provider-gateway/credential-resolver.test.ts
packages/agent-runtime/src/provider-cache-hints.test.ts
```

**Agent TS-3 写集** (12 files):
```
packages/agent-runtime/src/provider-stream-contract.test.ts
packages/agent-runtime/src/provider-openai-compatible.test.ts
packages/agent-runtime/src/provider/engines/anthropic-messages-engine.test.ts
packages/agent-runtime/src/provider/engines/ollama-engine.test.ts
packages/agent-runtime/src/provider/engines/openai-compatible-engine.test.ts
packages/agent-runtime/src/state-machine/core.test.ts
packages/agent-runtime/src/state-machine/session-branch.ts
packages/agent-runtime/src/runtime-metrics.test.ts
packages/agent-runtime/src/testing.test.ts
packages/agent-runtime/src/tool-stream/tool-stream.test.ts
packages/agent-runtime/src/context-compression/compression-utils.test.ts
packages/agent-runtime/src/session-loop/index.test.ts
```

**Agent TS-4 写集** (7 files):
```
packages/agent-daemon/src/daemon-approval-handler.test.ts
packages/agent-daemon/src/mcp-stdio-adapter.test.ts
packages/agent-daemon/src/server-handlers.test.ts
packages/agent-daemon/src/server-runtime-factory.test.ts
packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts
packages/agent-daemon/src/protocol/registry.test.ts
packages/agent-daemon/src/protocol/validators/common.test.ts
```

**Agent TS-5 写集** (3 files):
```
packages/agent-orchestrator/src/event-store.test.ts
packages/agent-orchestrator/src/orchestrator.test.ts
packages/agent-orchestrator/src/__tests__/types.test.ts
```

**Agent TS-6 ~ TS-9 写集**: T-TS-001 ~ T-TS-048 的 48 个测试文件均匀分为 4 批，每批 12 文件。详细文件列表参见 [final_synthesis_A.md §4.7](file:///C:/Software/conex/docs/v2_plan_review/repair_plans/final_synthesis_A.md) W-19 任务卡列表。

### 3.4 Round 2 轮次验收

```powershell
# === Round 2 分包验收（含源码 + 测试） ===

# 全包 tsc 检查（此时源码 + 测试均已修复）
npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0

npx tsc --noEmit -p packages/agent-daemon/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0

npx tsc --noEmit -p packages/agent-orchestrator/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 通过条件：Count == 0

# 测试运行验证
npx vitest run --reporter=json 2>&1 | Out-String -Stream | Select-String '"numFailedTests"'
# 通过条件：numFailedTests == 0
```

---

## 4. Round 3 — 全局验证 Gate

### 4.1 Gate 命令

```powershell
# G0: 全量 tsc
npx turbo run typecheck 2>&1 | Out-String -Stream | Select-String "error"
# 通过条件：0 个 error 行

# G1: 全量测试
npx vitest run 2>&1 | Out-String -Stream | Select-String "Tests.*failed"
# 通过条件：0 failed

# G2: Lint（可选）
npx turbo run lint 2>&1 | Out-String -Stream | Select-String "error"
# 通过条件：0 个 error 行
```

### 4.2 Gate 通过 → 修复完成

### 4.3 Gate 失败 → 进入 Round N 回归扫描

---

## 5. Round N (N≥4) — 回归扫描模板（可复用）

本模板适用于任意迭代轮次。每轮输入为上一轮的 `round_{N-1}_ledger.json`。

### 5.1 步骤 1: 问题识别

```powershell
# 收集当前残余错误
npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 > round_N_errors_runtime.txt
npx tsc --noEmit -p packages/agent-daemon/tsconfig.json 2>&1 > round_N_errors_daemon.txt
npx tsc --noEmit -p packages/agent-orchestrator/tsconfig.json 2>&1 > round_N_errors_orchestrator.txt
npx tsc --noEmit -p apps/agent-workbench/tsconfig.json 2>&1 > round_N_errors_workbench.txt
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json 2>&1 > round_N_errors_desktop.txt
npx tsc --noEmit -p packages/shared-utils/tsconfig.json 2>&1 > round_N_errors_shared.txt
```

### 5.2 步骤 2: 任务分解

解析错误输出，按文件分组生成新任务卡:
```
For each error line "filename(line,col): error TSxxxx: message":
  1. 提取 file, line, errorCode
  2. 查找 round_{N-1}_ledger.json 中对应 taskId
  3. 若已有 taskId 且 status == "regressed" → 重新打开
  4. 若无对应 taskId → 创建新任务卡（前缀 T-RN-xxx）
```

### 5.3 步骤 3: 写集分区

```
1. 按文件去重 → 生成文件集 F
2. 按包分区 → { runtime: [], daemon: [], ... }
3. 包内按子目录分组 → Agent 候选集
4. 验证: ∀ Agent_i, Agent_j, filesWrite_i ∩ filesWrite_j == ∅
5. 合并过小的 Agent（< 3 files）到相邻 Agent
6. 总数 ≤ 12
```

### 5.4 步骤 4: Agent 分派与执行

每个 Agent 接收:
- `filesWrite[]` — 允许修改的文件清单
- `tasks[]` — 任务卡列表（含文件、行号、错误码、修复策略）
- `verifyCommand` — 单卡验收命令模板

### 5.5 步骤 5: 结果汇总

每个 Agent 完成后:
1. 执行 `verifyCommand` 逐卡验收
2. 汇报 `{ taskId, status, residualErrors[] }`
3. 调度器聚合所有 Agent 结果 → 生成 `round_N_ledger.json`
4. 执行 Round Gate → 通过则完成，否则 N+1

---

## 6. 热点文件清单（硬性要求 1 补充）

以下文件因在多个原始 Plan 中被提及，具有更高的回归风险。它们在本方案中已被去重归并到唯一 Agent，但在回归扫描中应优先检查。

| 热点文件 | 原始 Plan | 归并到 | Round | Agent | 串行风险 |
|---|---|---|---|---|---|
| normalizer.ts | P01 + P05(F-01) | T-AR-056 | R1 | RT-5 | 若回归 → R4+ 由同 Agent 修 |
| session.ts | P01 + P05(F-06) | T-AR-056 | R1 | RT-5 | 同上 |
| subagents.ts | P01 + P05(F-08) | T-AR-056 | R1 | RT-5 | 同上 |
| trace/index.ts | P01 + P05(F-11) | T-AR-056 | R1 | RT-5 | 同上 |
| chatgpt-pool.ts | P01 + P05(F-09) | T-AR-056 | R1 | RT-5 | 同上 |
| background-command.ts | P01 + P05(F-10) | T-AR-056 | R1 | RT-5 | 同上 |
| stream-recovery.ts | P01 + P05(F-05) | T-AR-056 | R1 | RT-5 | 同上 |
| tools/tool-definition.ts | P01 + P05(F-12) | T-AR-049 | R1 | RT-4 | 若回归 → R4+ |
| daemon-approval-handler.ts | P02 + P05(F-13) | T-DO-005 | R1 | DO-1 | 若回归 → R4+ |
| subagent-runtime.ts | P02 + P05(F-14) | T-DO-033 | R1 | DO-2 | 若回归 → R4+ |
| mock-server.ts | P01 + P04(T-TS-019) | T-AR-058 | R2 | TS-2 | 若回归 → R4+ |
| provider-response-consumer.test.ts | P01 + P04 + P05(F-02) | — | R2 | TS-1 | 若回归 → R4+ |
| compression-utils.test.ts | P01 + P04 + P05(F-03) | — | R2 | TS-3 | 若回归 → R4+ |
| session-loop/index.test.ts | P01 + P04 + P05(F-07) | — | R2 | TS-3 | 若回归 → R4+ |

> **串行执行顺序**: 所有热点文件在当前方案中仅在单一 Round 的单一 Agent 中被修改，不存在跨轮次串行。若进入回归轮次 (R4+)，回归任务卡应分配给**原 Agent 的同一写集范围**，避免引入新的交叉。

---

## 7. 问题—任务交叉矩阵（硬性要求 4）

### 7.1 按归因类别 → 任务卡覆盖

| 归因类别 | 错误码 | 估计数量 | 覆盖任务卡 | 覆盖率 |
|---|---|:---:|---|:---:|
| exactOptionalPropertyTypes | TS2375/2379/2412 | ~1040 | T-AR-001~056, T-DO-001~008/019~023/028~031/035~036, T-DO-010~018/024~027/032~034/037~040, T-OR-001~007, T-AWB-001~022, T-SH-001~005 | **100%** |
| 未使用声明 | TS6133/6196/6192/6138 | ~190 | T-AR-017/020~024/032/037~041/047/050/052, T-DO-028, T-AWB-003/005~007/020/023~028, T-UI-* (JSX 相关) | **100%** |
| 严格空检查 + 类型不匹配 | TS2532/18048/2322/2345 | ~210 | T-AR-002/005/007/009/012/013/032~033/036/050~053, T-DO-028/031/033, T-OR-005/006, T-AWB-007/013/014 | **100%** |
| 导入/导出问题 | TS1361/2305/2459 | ~32 | T-AR-015/023/041, T-DO-031 | **100%** |
| JSX 语法 | TS17008/17002/1005 | 28 | T-UI-001~010 | **100%** |
| 缺失成员 / 边缘 | TS2339/2739/2352/2420 | ~55 | T-AR-007/040, T-DO-028/031/033, T-OR-003/006, T-AWB-013 | **100%** |
| 配置 | TS6059/5058 | ~10 | T-CFG-001~005 | **100%** |

### 7.2 按包 → 任务卡覆盖

| 包 | 原始错误数 | 任务卡范围 | 卡数 | 覆盖率 |
|---|:---:|---|:---:|:---:|
| agent-runtime | ~572 | T-AR-001 ~ T-AR-063 | 63 | **100%** |
| agent-daemon | ~590 | T-DO-001~040, T-PV-001~009, T-DT-001~007 | 56 | **100%** |
| agent-orchestrator | ~85 | T-OR-001~010 | 10 | **100%** |
| agent-workbench | ~140 | T-AWB-001~028 | 28 | **100%** |
| crish-desktop | 28 | T-UI-001~010 | 10 | **100%** |
| shared-utils | ~20 | T-SH-001~005 | 5 | **100%** |
| Config | ~10 | T-CFG-001~005 | 5 | **100%** |
| 测试文件 (跨包) | ~140 | T-TS-001~048 | 48 | **100%** |
| **总计** | **~1585** | | **173** (去重后) + 48 (W-19) | **100%** |

### 7.3 原始 Plan → 统一方案映射

| 原始 Plan | 原始任务卡数 | 统一方案覆盖 | 覆盖率 |
|---|:---:|---|:---:|
| Plan 01 (agent-runtime) | 64 | T-AR-001~063 → Round 1 (RT-1~5) + Round 2 (TS-1~3) | **100%** |
| Plan 02 (daemon + orch) | 59 | T-DO/PV/OR/DT-* → Round 1 (DO-1~2, OR-1) + Round 2 (TS-4~5) | **100%** |
| Plan 03 (desktop UI) | 10 | T-UI-001~010 → Round 1 (UI-1) | **100%** |
| Plan 04 (shared + tests) | 57 | T-CFG/SH/TS-* → Round 0 (CFG-1) + Round 1 (OR-1) + Round 2 (TS-6~9) | **100%** |
| Plan 05 (recent changes) | 14 | 全部归并到 T-AR-056/049, T-DO-005/033, T-SH-005 | **100%** |
| Synthesis B (workbench) | 28 | T-AWB-001~028 → Round 1 (AWB-1~2) | **100%** |

---

## 8. 修复模式速查（代码级实施参考）

### 模式 A: exactOptional — 条件展开（推荐用于 agent-runtime 内部）

```typescript
// Before（TS2375/TS2379 触发）:
const obj: FooOptions = {
  name: "test",
  detail: maybeUndefinedValue,    // TS2375: Type 'string | undefined' is not assignable to type 'string'
};

// After:
const obj: FooOptions = {
  name: "test",
  ...(maybeUndefinedValue !== undefined ? { detail: maybeUndefinedValue } : {}),
};
```

### 模式 B: exactOptional — 接口定义修改（推荐用于 daemon/orch 公有接口 + Zod schema）

```typescript
// Before:
interface PendingApproval {
  metadata?: ApprovalMetadata;    // ?:  means optional AND not-undefined
}

// After:
interface PendingApproval {
  metadata: ApprovalMetadata | undefined;  // required but can be undefined
}
```

### 模式 C: 未使用声明删除（TS6133/TS6196）

```typescript
// Before:
import { SomeType, UnusedType } from './mod';  // TS6133: 'UnusedType' is declared but never read

// After:
import { SomeType } from './mod';
```

### 模式 D: import type → import（TS1361）

```typescript
// Before:
import type { SomeClass } from './mod';
const instance = new SomeClass();  // TS1361: 'SomeClass' cannot be used as a value because it was imported using 'import type'

// After:
import { SomeClass } from './mod';
```

### 模式 E: 严格空检查（TS2532/TS18048）

```typescript
// Before:
const value = obj.prop.subProp;  // TS2532: Object is possibly 'undefined'

// After:
const value = obj.prop!.subProp;  // 或 obj.prop?.subProp ?? defaultValue
```

### 模式 F: JSX 闭合修复（TS1005/TS17008）

```typescript
// Before (React.memo 结尾错误):
export default React.memo(MyComponent));  // TS1005: ')' expected

// After:
export default React.memo(MyComponent);
```

---

## 9. 方案完整性确认

| 硬性要求 | 章节 | 状态 |
|---|---|:---:|
| ① 写集隔离 — 每个 Agent 的 filesWrite 列表 + 热点文件串行顺序 | §2.2, §2.3 (各 Agent 写集), §3.2, §6 | ✅ |
| ② 代码级实施指引 — 文件路径 / 行号 / 修改逻辑 / 伪代码 | §2.3 (全部 119 张源码卡), §3.3 (54 张测试卡), §8 (模式速查) | ✅ |
| ③ 自动化验收命令 — 每卡 + 每轮 + 全局 | §2.3 (单卡验收列), §2.4, §3.4, §4.1 | ✅ |
| ④ 全覆盖索引 — 问题→任务交叉矩阵 | §7 (按归因/按包/按原始 Plan 三维覆盖) | ✅ |
| ⑤ 轮次间接口 — JSON 台账 + 状态机 | §0.3 (完整 JSON schema + 状态转移图) | ✅ |

| 约束 | 状态 |
|---|:---:|
| 每轮 ≤ 12 Agent | R0: 1, R1: 11, R2: 9, RN: ≤12 ✅ |
| 所有问题等优先级 | ✅ 无优先级排序 |
| 可复用多轮迭代 | ✅ §5 回归模板 + JSON 台账闭环 |
| 闭环: 输出→下一轮输入 | ✅ ledger.json 状态机驱动 |
