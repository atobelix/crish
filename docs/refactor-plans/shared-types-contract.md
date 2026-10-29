# ST · shared-types 契约生成一体化

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. Rust 契约能生成的类型，TS 侧只保留生成物。不留同名手写类型，不留 `Engine*` / `Device*` 兼容别名。
> 2. 禁止手改 `generated/**`，禁止改生成器逻辑或契约 JSON 去迁就手写版。禁止 `as any`、`as unknown as`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`。禁止把必填字段改回可选。
> 3. 测试只在 ST-P4。提交：`refactor(ST-P<n>): <摘要> [BATCH-SHARED-TYPES-CONTRACT-SSOT]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-shared-types`，分支 `refactor/shared-types-contract`。不 stash、不 push、不在主仓库改代码。
> 5. 进度写 `C:\Users\orange\conex-review\plans\shared-types契约生成一体化.progress.md`。
> 6. Node 24。本模块不跑 cargo。
> 7. 行号是 `bf3d60fa3` 快照。开工前按类型名重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `ST` |
| 波次 | W4。门控 G-ST：必须在 SS 合入集成分支之后开分支 |
| 依据 | `plans\shared-types契约生成一体化.md` |

## a. 范围

### a.1 可改

- `packages/shared-types/src/` 下的 `index.ts`、`message.ts`、`tool.ts`、`events.ts`、`run-control.ts`、`cache-metrics.ts`、`orchestration.ts`、`type-drift.test.ts`。
- 消费方只改 import 和类型收紧所必需的最小改动：
  - `apps/crish-desktop/src/store/types.ts` 里的 `EngineAgentMessage as AgentMessage`
  - `apps/crish-desktop/src/api/chat-bridge/handlers/cacheEventsStore.ts` 及其测试
  - `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts` 的深路径导入
  - `apps/crish-desktop/src/api/controlMetrics.ts`
  - `apps/crish-desktop/src/api/runControlClient.ts`：**SS-P2 正在改这个文件**，见 j
- `scripts/generate-engine-bindings.mjs` 只许改头注释（编写时写「41 事件」，`engine-events.json` 的 `eventCount` 是 57）。不改生成逻辑。

### a.2 不在范围

- `apps/crish-mobile/**`。`useRunControlVm.ts` 用 `RunControlLevel`；两份测试深路径导入 `primitive-types`；`network/protocolVersion.ts` 手抄 `PROTOCOL_VERSION=1`（真源在 `crates/conex-types/src/device/version.rs`）。这三项是 **ST-03**，归 `crish-mobile.md`。本模块保持导出名 `RunControlLevel` 不变。
- `packages/shared-types/src/generated/**` 禁止手改。
- `crates/conex-types/contracts/*.json` 本模块不改。错误码契约归 EC。

## b. 问题清单

| # | 事实 | 结论 |
|---|---|---|
| B1 | `index.ts` 先 `export * from './generated/engine/types'`，再显式导出手写同名类型，手写导出遮蔽生成类型。另造了 `EngineAgentMessage` / `EngineAgentMessageBlock` 以便同时拿到生成版 | 同名双源 |
| B2 | 手写与生成同名 23 个：`RunControlLevel`、`MissAttribution`、`RunCacheStats`、`AgentMessage`、`AgentMessageBlock`、`ToolCategory`、`ToolConcurrency`、`ToolOutput`、`ToolArtifact`、`ToolBatchCall`、`ToolBatchResult`、`ProviderDiagnostic`、`RuntimeCheckpointKind`、`RuntimeCheckpointRecord`、`RuntimeCheckpointRestoreRecord`、以及 8 个 `ContextCompression*` | 删手写 |
| B3 | 已经漂移：手写 `AgentMessage` 的 metadata 是 `JsonObject`，没有 `content` / `clientMessageId`；生成版 metadata 是 `JsonValue`，带这两个可选字段，role 用 `AgentMessageRole`。`ToolCallBlock.input` 手写 `JsonObject`、生成 `JsonValue`。`RunCacheStats` 手写全可选，生成版计数字段必填 | 以生成版（Rust 真源）为准 |
| B4 | `RunControlLevel` 在 `run-control.ts` 与 `generated/device/types.ts` 是同一字面量联合。`index.ts` 还有 `DeviceRunControlLevel`、`DeviceApprovalDecision`、`DEVICE_APPROVAL_DECISION_VALUES`，编写时外部引用为 0。`APPROVAL_DECISION_VALUES` 在 engine 与 device 生成物里各一份，内容相同 | 删别名 |
| B5 | 手写事件联合 `AgentDomainEvent` … `AgentEvent` 与生成的 `EngineEvent`（57 个变体）平行。外部只有 `eventParser.test.ts` 用 `AgentEvent`（深路径）。包内 `orchestration.ts` 用它推导 `latestAgentEndReason` | 统一用 `EngineEvent` |
| B6 | `type-drift.test.ts` 用 `expectTypeOf` 比对手写版与生成版。手写版删除后测试对象不存在 | 整文件删除。里面若有不依赖手写版的行为断言，先迁走 |
| B7 | `orchestration.ts` 的 `OrchestratorSessionRecord`、`StoredEvent` 等，编写时外部引用为 0 | knip 确认后删除 |
| B8 | 生成器头注释写「41 事件」，契约是 57 | 改注释 |

误报：`packages/shared-utils` 的 `ToolDefinition` 是另一类型，不动。`ProviderUsage` 在 desktop 里只出现在注释和测试标题，不是 import。`CacheMetrics` / `CacheUsage` / `MessageCacheState` 不在生成物里，是唯一定义，保留。

## c. 目标架构

1. 契约能生成的类型只来自 `generated/**`。手写文件只留生成器不覆盖的纯前端类型。
2. `index.ts` 导出顺序：`generated/engine` → `generated/device` → 纯前端模块。删除 `EngineAgentMessage*` 与 `Device*` 别名。
3. `run-control.ts` 不再定义 `RunControlLevel`，改为 `export type { RunControlLevel } from './generated/device/types'`。这是同名单源再导出，不是兼容别名。与该文件引用 `PermissionMode` 的方式相同。
4. engine 与 device 生成物同名且等价的符号（如 `APPROVAL_DECISION_VALUES`）在 `index.ts` 只导出一份。选哪一份，以 Rust 定义所在模块为准，执行时读 `crates/conex-types/src` 确认，写入 progress。禁止改生成器来改名。
5. 事件联合只用 `EngineEvent` / `EngineEventType`。`latestAgentEndReason` 改为从 `Extract<EngineEvent, { type: 'agent-end' }>` 推导。
6. `RunCacheStats` 计数字段变为必填。`cacheEventsStore.ts` 里按可选处理的分支删掉。不能用 `?? 0` 掩盖。若运行时 payload 确实可能缺字段，说明 Rust 契约有误，停工记入 progress，不得在 TS 侧放宽。

## d. 删除清单

1. B2 的 23 个手写定义。文件变空就删文件，并删 `index.ts` 对应导出。
2. `events.ts` 的手写联合：`AgentDomainEvent`、`TurnDomainEvent`、`MessageDomainEvent`、`ToolDomainEvent`、`CacheDomainEvent`、`AgentEvent`。
3. `tool.ts` 里外部 0 引用的 `ToolDefinition`、`AgentTool`、`ToolExecutionContext`、`ProviderStreamEvent`、`ProviderUsage`、`ProviderErrorKind`、`HealthCheckResult`、`RegisteredTool`、`ToolRegistrationOptions`、`ToolSource`。每个先 `rg -w`，有引用就留。
4. `index.ts` 的五个别名，以及手写同名删除后已无用的解析器歧义消解块（执行时确认）。
5. `type-drift.test.ts`。
6. `orchestration.ts` 里 knip 确认无引用的导出。

## e. 分阶段步骤

**ST-P1 · 删手写同名类型**
- 做 d.1、d.3、d.4、d.5，以及 c.2～c.4。
- 判据：

```powershell
rg -n "^export (type|interface|enum|const) (RunControlLevel|MissAttribution|RunCacheStats|AgentMessage|AgentMessageBlock|Tool(Category|Concurrency|Output|Artifact|BatchCall|BatchResult)|ProviderDiagnostic|RuntimeCheckpoint\w*|ContextCompression\w*)\b" packages/shared-types/src -g "!generated/**"
# 期望：0
rg -n "EngineAgentMessage|DeviceRunControlLevel|DeviceApprovalDecision|DEVICE_APPROVAL_DECISION_VALUES" apps packages -g "!node_modules"
# 期望：0
Test-Path packages/shared-types/src/type-drift.test.ts
# False
```

**ST-P2 · 事件联合改为 EngineEvent**
- 做 d.2 与 c.5。`eventParser.test.ts` 改为从 `@crish/shared-types` 导入 `EngineEvent`，去掉深路径。
- 判据：`rg -n "\bAgentEvent\b|AgentDomainEvent|TurnDomainEvent" packages/shared-types/src apps/crish-desktop/src -g "!generated/**"` 只剩注释（逐条贴出）。`rg -n "packages/shared-types/src" apps/crish-desktop/src -g "!**/*.md"` 为 0。

**ST-P3 · 消费方收紧**
- `store/types.ts` 改为 `import type { AgentMessage } from '@crish/shared-types'`。`cacheEventsStore.ts`、`controlMetrics.ts`、`runControlClient.ts` 只改 import 和 c.6 的收紧。完成 d.6 与 B8。
- 判据：`rg -n "41 事件" scripts/generate-engine-bindings.mjs` 为 0。knip 在 ST-P4 跑，不得新增 shared-types 的 unused。

**ST-P4 · 验证**（§h）。

## f. 禁止事项

不得手改生成物。不得改生成逻辑或契约 JSON。不得新增 `export type X = Y` 兼容名。不得把必填字段改回可选，不得 `?? 0` 掩盖。不得改 `apps/crish-mobile/**`。不得改 `runControlClient.ts` 的行为，只改类型导入；若 SS 还没合入，本阶段不开工。

## g. 项目规范

TS strict。包导入用 `@crish/shared-types`，禁止深路径。`check-line-counts`。knip 不新增条目。`check-legacy-shim` 必须通过，不得改那个脚本。

## h. 集中测试

```powershell
npm run typecheck
npm run lint
node scripts/generate-engine-bindings.mjs
git diff --exit-code -- packages/shared-types/src/generated
npx knip
node scripts/check-legacy-shim.mjs
npm run check:line-counts
npm run test -- packages/shared-types apps/crish-desktop/src/api/chat-bridge apps/crish-desktop/src/store
npm run test
```

## i. 审计清单

- [ ] A1 ST-P1 / ST-P2 探针重跑
- [ ] A2 `git diff <base>..refactor/shared-types-contract -- packages/shared-types/src/generated` 为空（注释修正在生成器源文件，不在 generated）
- [ ] A3 diff 里没有新增 `@ts-ignore`、`@ts-expect-error`、`eslint-disable`、`as any`、`as unknown as`
- [ ] A4 `apps/crish-mobile` 无 diff
- [ ] A5 `cacheEventsStore` 的 diff 里没有新增 `?? 0`
- [ ] A6 删除的测试只有 `type-drift.test.ts`。其他测试没有删除 `expect(`
- [ ] A7 §h 通过

## j. 风险与门控

**G-ST**：`runControlClient.ts` 是 SS-P2 的文件。ST 基于已含 SS 的集成分支开分支。检测：

```powershell
git -C C:\Software\conex log --oneline -E main --grep "SS-P2|BATCH-SESSION-STREAM-SSOT"
```

看不到 SS-P2 时，不要在 main 的脏工作区上改这个文件。

`eventParser.test.ts` 不在 SS 当前改动里，可以改。

`RunCacheStats` 收紧后的编译错误按 c.6 处理：以生成版为准，不得放宽。

与 CF 都动 desktop。串行合并，后开工者基于前者的集成结果。与 EC 的文件面：EC 改 `errors/`，本方案不改那两个文件。仍建议不要并行改 `packages/shared-types/src/index.ts`。

## k. 已决事项

手写同名类型删除，事件联合用 `EngineEvent`，mobile 的 ST-03 不在本模块。没有剩余的「待用户决策」。
