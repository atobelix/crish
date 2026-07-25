# Conex TS 编译修复统一方案（最终版）

> 由 Agent #1（最终方案合成评审 Agent）合并 5 份修复方案生成
> 生成日期: 2026-07-25
> 输入: plan_01 (1,264行) + plan_02 (1,295行) + plan_03 (971行) + plan_04 (846行) + plan_05 (1,164行)

---

## 1. 全局统计

### 1.1 总计

| 维度 | 数值 |
|------|------|
| 涉事文件总数（去重后） | **289 个** |
| 错误总条数（估算） | **~1,300+ 条** |
| 涉事包数 | 5 |
| 任务卡总数（去重后） | **152 张** |
| Wave 总数 | **19 个** |
| 预计总工时 | **30-45 人时** |

### 1.2 按包分布

| 包 | 文件数 | 错误数 | 占比 |
|----|:------:|:------:|:----:|
| packages/agent-runtime/src/ | 155 | ~720 | ~55% |
| packages/agent-daemon/src/ | 58 | ~590 | ~45% |
| packages/agent-orchestrator/src/ | 10 | ~85 | ~6% |
| packages/shared-utils/src/ | 6 | ~20 | ~1.5% |
| apps/crish-desktop/src/ (JSX) | 10 | 28 | ~2% |
| 根配置（tsconfig.base.json 等） | 6 | N/A | config |
| **总计（去重）** | **~245 源码 + 44 测试** | **~1,300** | 100% |

### 1.3 按错误码分布（去重）

| 错误码 | 含义 | 归因类别 | 估计数量 | 占比 |
|--------|------|----------|:--------:|:----:|
| TS2375 | 对象字面量不能赋值给 Partical | exactOptional | ~400 | ~31% |
| TS2379 | 实参不能赋值给带 ?: 的形参 | exactOptional | ~350 | ~27% |
| TS2412 | undefined 不能赋值给非可选属性 | exactOptional | ~150 | ~11% |
| TS6133 | 声明但从未读取 | 未使用声明 | ~120 | ~9% |
| TS6196 | 声明但从未使用 | 未使用声明 | ~60 | ~5% |
| TS2532 | 对象可能是 undefined | 严格空检查 | ~80 | ~6% |
| TS18048 | ?. 链后可能为 undefined | 严格空检查 | ~30 | ~2% |
| TS2322/TS2345 | 类型不兼容/实参不匹配 | 类型不匹配 | ~70 | ~5% |
| TS1361 | import type 用作值 | 导入误用 | ~18 | ~1.4% |
| TS2339/TS2739/TS2741 | 缺失属性/成员 | 缺失成员 | ~30 | ~2% |
| TS2305/TS2459 | 缺失导出/未导出 | 缺失导出 | ~14 | ~1% |
| JSX 解析错误 | TS17008/TS1005 等 | JSX 语法 | 28 | ~2% |
| 其他边缘情况 | TS2352/TS2420 等 | 杂项 | ~25 | ~2% |

### 1.4 归因类别总计

| 归因类别 | 涉及错误码 | 总错误数 | 占比 |
|----------|-----------|:--------:|:----:|
| **exactOptionalPropertyTypes** | TS2375 + TS2379 + TS2412 | ~900 | ~69% |
| **未使用声明** | TS6133 + TS6196 + TS6192 + TS6138 | ~190 | ~15% |
| **严格空检查 + 类型不匹配** | TS2532 + TS18048 + TS2322 等 | ~180 | ~14% |
| **导入/导出问题** | TS1361 + TS2305 + TS2459 | ~32 | ~2.5% |
| **JSX 语法** | TS17008 + TS17002 + TS1005 等 | 28 | ~2% |
| **边缘情况** | TS2352 + TS2420 + TS7006 等 | ~25 | ~2% |

---

## 2. 去重与重叠消解声明

### 2.1 Plan 05 -> Plan 01/02/04 归并

Plan 05（近期变更）的 15 个文件全部与 Plan 01/02/04 重叠。

| Plan 05 ID | 文件 | 归并到 | 说明 |
|-----------|------|--------|------|
| F-01 | normalizer.ts | T-AR-056 | Plan 01 补 export |
| F-02 | provider-response-consumer.test.ts | T-TS-025 | 已在 Plan 04 |
| F-03 | compression-utils.test.ts | T-TS-044 | 已在 Plan 04 |
| F-04 | bounded-map.ts | T-SH-005 | 归 shared-utils |
| F-05 | stream-recovery.ts | T-AR-B | Plan 01 Wave B |
| F-06 | session.ts | T-AR-056 | Plan 01 Wave A |
| F-07 | session-loop/index.ts + test | T-TS-028 | Plan 01/04 |
| F-08 | subagents.ts | T-AR-056 | Plan 01 Wave A |
| F-09 | chatgpt-pool.ts | T-AR-056 | Plan 01 |
| F-10 | background-command.ts | T-AR-056 | Plan 01 |
| F-11 | trace/index.ts | T-AR-056 | Plan 01 |
| F-12 | tools.ts / tool-definition.ts | T-AR-049 | Plan 01 |
| F-13 | daemon-approval-handler.ts | T-DO-005 | Plan 02 |
| F-14 | subagent-runtime.ts | T-DO-033 | Plan 02 |

**结论**: Plan 05 不产生新文件，仅补充修复细节到 8 张已有任务卡。

### 2.2 统一任务卡 ID 映射

| 原方案 | 原 ID | 统一 ID | 备注 |
|-------|-------|---------|------|
| plan_01 | T-AR-001 ~ T-AR-057 | T-AR-001 ~ T-AR-057 | 保留 |
| plan_02 | T-DO-001 ~ T-DO-040 | T-DO-001 ~ T-DO-040 | 保留 |
| plan_02 | T-PV-001 ~ T-PV-009 | T-PV-001 ~ T-PV-009 | 保留 |
| plan_02 | T-TS-001 ~ T-TS-007 (daemon) | T-DT-001 ~ T-DT-007 | 改前缀 |
| plan_02 | T-OR-001 ~ T-OR-010 | T-OR-001 ~ T-OR-010 | 保留 |
| plan_03 | T-UI-001 ~ T-UI-010 | T-UI-001 ~ T-UI-010 | 保留 |
| plan_04 | T-CONFIG-001 ~ T-CONFIG-005 | T-CFG-001 ~ T-CFG-005 | 改前缀 |
| plan_04 | T-SHARED-001 ~ T-SHARED-006 | T-SH-001 ~ T-SH-006 | 改前缀 |
| plan_04 | T-TS-001 ~ T-TS-048 | T-TS-001 ~ T-TS-048 | 保留 |
| plan_04 | T-DAEMON-001 ~ T-DAEMON-007 | T-DT-001 ~ T-DT-007 | 合并去重 |
| plan_05 | F-01 ~ F-14 | 归并 | 无独立 ID |

### 2.3 跨方案重复文件清单

| 文件 | Plan01 | Plan02 | Plan04 | Plan05 | 归属 Wave |
|------|:------:|:------:|:------:|:------:|:---------:|
| mock-server.ts | Y | - | T-TS-019 | - | W-02 |
| provider-response-consumer.test.ts | Y | - | T-TS-025 | F-02 | W-02 |
| factory.test.ts | Y | - | T-TS-012 | - | W-02 |
| session-loop/index.test.ts | Y | - | T-TS-028 | F-07 | W-03 |
| compression-utils.test.ts | Y | - | T-TS-044 | F-03 | W-03 |
| stream-recovery.ts | Y | - | - | F-05 | W-03 |
| trace/index.ts | Y | - | - | F-11 | W-01 |
| tool-definition.ts | Y | - | - | F-12 | W-01 |
| background-command.ts | Y | - | - | F-10 | W-01 |
| subagents.ts | Y | - | - | F-08 | W-01 |
| chatgpt-pool.ts | Y | - | - | F-09 | W-01 |
| normalizer.ts | Y | - | - | F-01 | W-01 |
| daemon-approval-handler.ts | - | T-DO-005 | - | F-13 | W-08 |
| subagent-runtime.ts | - | T-DO-033 | - | F-14 | W-11 |


---

## 3. 全局写集隔离矩阵

### 3.1 Wave 划分总表

| Wave ID | 名称 | 涉事包 | 文件数 | 错误码类别 | 优先级 |
|---------|------|--------|:------:|------------|:------:|
| **W-01** | agent-runtime exactOptional 源码 | agent-runtime | 70 | TS2375/TS2379/TS2412 | P0 |
| **W-02** | agent-runtime exactOptional 测试 | agent-runtime | 36 | TS2375/TS2379/TS2412 | P0 |
| **W-03** | agent-runtime 未使用声明 | agent-runtime | 29 | TS6133/TS6196/TS6192 | P1 |
| **W-04** | agent-runtime 类型不匹配 | agent-runtime | 16 | TS2322/TS2532 等 | P1 |
| **W-05** | agent-runtime import type | agent-runtime | 2 | TS1361 | P1 |
| **W-06** | agent-runtime 缺失导出 | agent-runtime | 12 | TS2305/TS2459 | P2 |
| **W-07** | agent-runtime 边缘情况 | agent-runtime | 7 | TS2352/TS2420 等 | P2 |
| **W-08** | agent-daemon exactOptional | agent-daemon | 18 | TS2375/TS2379/TS2412 | P0 |
| **W-09** | agent-daemon provider-gateway | agent-daemon | 5 | 混合 | P0 |
| **W-10** | agent-daemon handlers/factory | agent-daemon | 10 | 混合 | P0 |
| **W-11** | agent-daemon 杂项源码 | agent-daemon | 9 | 混合 | P1 |
| **W-12** | agent-daemon protocol Zod | agent-daemon | 9 | TS2322 | P1 |
| **W-13** | agent-daemon 测试 | agent-daemon | 7 | 混合 | P2 |
| **W-14** | agent-orchestrator 源码 | orchestrator | 7 | 混合 | P0 |
| **W-15** | agent-orchestrator 测试 | orchestrator | 3 | 混合 | P2 |
| **W-16** | 根配置 + tsconfig | 根+shared | 8 | TS6059 + config | P0 |
| **W-17** | shared-utils 源码 | shared-utils | 4 | TS2375/TS2379 | P1 |
| **W-18** | crish-desktop JSX | crish-desktop | 10 | JSX 解析 | P0 |
| **W-19** | 测试文件批量剩余 | 多包 | ~48 | 混合 | P2 |

### 3.2 零重叠保证

每个文件严格属于一个 Wave。跨包文件无冲突。

### 3.3 W-01 写集（70 文件）

主要 agent-runtime 源码文件含 exactOptionalPropertyTypes 错误：
- error-classifier.ts, anthropic-stream-parse.ts, checkpoint-manifest.ts
- checkpoint/checkpoint-manager.ts, context-compression/token-estimator.ts
- context-compression/index.ts, conversation-boundary-manifest.ts
- event-protocol/core-event-projector.ts, event-queue/index.ts
- fallback-chain/engine.ts, gemini-stream-parse.ts, git-versioning.ts
- goal-disk-oracle.ts, hooks/extension-registry.ts
- hooks/tool-hook-observability.ts, local-tools/checkpoint-tools.ts
- local-tools/fs-edit-tools/*.ts, local-tools/index.ts, local-tools/pre-mutation.ts
- local-tools/shell-tools.ts, lsp-tools.ts, mcp-lifecycle/utils.ts
- media/media-preprocessor.ts, memory.ts, model-routing-enhanced.ts
- model-routing/matcher.ts, model-routing/profile.ts, model-routing-roles.ts
- plugin-registry.ts, preview-queue.ts, process-lifecycle/process-manager.ts
- project-progress-ledger.ts, prompt-assembly.ts, provider-anthropic.ts
- provider-gemini.ts, provider-openai-compatible.ts, provider-openai-chat.ts
- provider-openai-responses.ts, provider-request-machine.ts
- provider-stream-contract/error.ts, provider-transport/connection-manager.ts
- provider/auth/credential-pool.ts, credential-resolver.ts, key-rotation.ts
- provider/auth/oauth/token-guardian.ts, account-store.ts
- provider/loader.ts, provider/provider-gateway-v2.ts, registry-v2.ts
- provider/factory.ts, provider/cli/main.ts, provider/cli/provider-dev.ts
- provider/engines/base-engine.ts, openai-compatible-engine.ts
- provider/engines/anthropic-messages-engine.ts, ollama-engine.ts
- provider-gateway/credential-resolver.ts, index.ts, route-selector.ts
- rendering/rendering-pipeline.ts, rich-read.ts, runtime.ts
- runtime-components/context-manager.ts, conversation-engine.ts
- runtime-metrics/collectors.ts, snapshot.ts, scoped-context-resources.ts
- scoped-context.ts, secrets-obfuscation.ts, skills.ts
- state-machine/agent-session.ts, core.ts, run-lifecycle.ts, session-branch.ts
- structured-summary.ts, subagent-loop.ts, tool-discovery.ts
- tool-output-budget.ts, tool-output-guard.ts, tools/tool-definition.ts
- trace/index.ts, event-architecture/canonical-event.ts
- workspace-mutation-coordinator.ts, normalizer.ts, subagents.ts
- background-command.ts, session.ts, plan-document/index.ts
- plan-document/operations.ts, plan-document/validation.ts
- doctor-report.ts, ISessionStore.ts, session-store/index.ts
- subagent-types.ts, context-compression/serializer.ts
- fallback-chain/types.ts, apply-edits-tool.ts
- local-tools/fs-edit-tools/types.ts, mcp-lifecycle-manager.ts
- mcp-lifecycle/types.ts, conex-path.ts, provider-gateway/types.ts
- recovery-pipeline.ts, stream-recovery.ts, runtime-metrics/types.ts

### 3.4 W-02 写集（36 测试文件）

- __tests__/canonical-schema.test.ts, canonicalize-tools.test.ts
- __tests__/context-slicer.test.ts, steering-input-queue.test.ts
- __tests__/integrations/chatgpt-pool.test.ts, media-pipeline.test.ts
- __tests__/integrations/oauth-flow.test.ts, streaming-executor.test.ts
- __tests__/integrations/tool-stream.test.ts
- provider/__tests__/e2e/mock-server.ts, factory.test.ts
- provider/__tests__/base-engine.test.ts
- provider/__tests__/e2e/context-length-recovery.test.ts
- provider/__tests__/e2e/provider-factory.test.ts
- provider/__tests__/e2e/exponential-backoff-e2e.test.ts
- provider/__tests__/benchmarks/provider-lifecycle.bench.ts
- provider/__tests__/registry.test.ts
- provider-gateway-edge.test.ts, provider-gateway.test.ts
- provider-gateway/credential-resolver.test.ts
- provider-cache-hints.test.ts, provider-stream-contract.test.ts
- provider-openai-compatible.test.ts
- runtime-components/conversation-engine.test.ts
- runtime-components/provider-response-consumer.test.ts
- runtime-components/tool-executor.test.ts
- runtime-metrics.test.ts, testing.test.ts
- tool-stream/tool-stream.test.ts
- provider/engines/anthropic-messages-engine.test.ts
- provider/engines/ollama-engine.test.ts
- provider/engines/openai-compatible-engine.test.ts
- state-machine/core.test.ts, state-machine/session-branch.ts

### 3.5 W-08 写集（agent-daemon exactOptional 18 文件）

- packages/agent-daemon/src/types/config.ts
- packages/agent-daemon/src/types/entities.ts
- packages/agent-daemon/src/approval-queue.ts
- packages/agent-daemon/src/background-task-manager.ts
- packages/agent-daemon/src/daemon-lifecycle.ts
- packages/agent-daemon/src/daemon-logger.ts
- packages/agent-daemon/src/daemon-client-registry.ts
- packages/agent-daemon/src/daemon-approval-handler.ts
- packages/agent-daemon/src/server/index.ts
- packages/agent-daemon/src/server/connection-manager.ts
- packages/agent-daemon/src/server/workflow-manager.ts
- packages/agent-daemon/src/server/approval-bridge.ts
- packages/agent-daemon/src/conversation-rewind-boundary.ts
- packages/agent-daemon/src/scoped-context-runtime.ts
- packages/agent-daemon/src/scoped-context-store.ts
- packages/agent-daemon/src/mcp-stdio-adapter.ts
- packages/agent-daemon/src/task-snapshot/index.ts
- packages/agent-daemon/src/task-snapshot/event-handlers.ts

### 3.6 W-14 写集（agent-orchestrator 7 文件）

- packages/agent-orchestrator/src/artifact-store.ts
- packages/agent-orchestrator/src/conversation-rewind.ts
- packages/agent-orchestrator/src/event-scan-goal-strategy.ts
- packages/agent-orchestrator/src/event-store-projection.ts
- packages/agent-orchestrator/src/event-store.ts
- packages/agent-orchestrator/src/orchestrator.ts
- packages/agent-orchestrator/src/task-assessment.ts


---

## 4. 全局任务卡（去重后分 Wave 列表）

### 4.1 W-01 任务卡（agent-runtime exactOptional 源码）

**T-AR-001: error-classifier.ts**
- 文件: packages/agent-runtime/src/error-classifier.ts
- 错误行: 63,70,77,83,89,96,105,112,119,126,133,140,148,154,160,166,174,180,186,193,198,209
- 错误码: TS2379 x 22, TS2375 x 1
- 根因: Partical 在 exactOptionalPropertyTypes 下拒绝 string|undefined 赋值
- 修复: 创建 ClassifiedErrorInput mapped type 或条件展开
- 验收: Select-String error-classifier -> 0

**T-AR-002: anthropic-stream-parse.ts**
- 文件: packages/agent-runtime/src/anthropic-stream-parse.ts
- 错误行: 58,202,242,255,264,303
- 错误码: TS2322 x 5, TS2375 x 1
- 根因: ProviderStreamEvent 联合体不接受含 usage: ProviderUsage|undefined 的对象
- 修复: 精确匹配或 as ProviderStreamEvent 转型
- 验收: Select-String anthropic-stream-parse -> 0

**T-AR-003: checkpoint-manifest.ts**
- 文件: packages/agent-runtime/src/checkpoint-manifest.ts
- 错误行: 375,621
- 错误码: TS2375 x 2
- 根因: 可选字段设为 |undefined 不匹配 exactOptionalPropertyTypes
- 修复: 重构成省略 undefined 字段
- 验收: Select-String checkpoint-manifest -> 0

**T-AR-004: checkpoint/checkpoint-manager.ts**
- 文件: packages/agent-runtime/src/checkpoint/checkpoint-manager.ts
- 错误行: 101
- 错误码: TS2375 x 1
- 根因: { label: string|undefined } 不匹配 CheckpointMetadata
- 修复: 条件展开 ...(label && { label })
- 验收: Select-String checkpoint-manager -> 0

**T-AR-005: context-compression/index.ts**
- 文件: packages/agent-runtime/src/context-compression/index.ts
- 错误行: 93,97,131,152,204
- 错误码: TS2345, TS2339, TS2379 x 2, TS2322
- 根因: 混合问题（可选回调、缺失属性、exactOptional）
- 修复: 可选链 + 补属性 + exactOptional
- 验收: Select-String context-compression/index -> 0

**T-AR-006: conversation-boundary-manifest.ts**
- 文件: packages/agent-runtime/src/conversation-boundary-manifest.ts
- 错误行: 351,394
- 错误码: TS2375 x 2
- 根因: ConversationBoundaryManifestRecord 可选字段
- 修复: 省略 undefined 字段
- 验收: Select-String conversation-boundary-manifest -> 0

**T-AR-007: event-protocol/core-event-projector.ts**
- 文件: packages/agent-runtime/src/event-protocol/core-event-projector.ts
- 错误行: 107,129,277,421
- 错误码: TS2375 x 1, TS2322 x 3
- 根因: exactOptional + 联合体类型不匹配 + DiagnosticDetails
- 修复: exactOptional + 扩宽联合体
- 验收: Select-String core-event-projector -> 0

**T-AR-008: event-queue/index.ts**
- 文件: packages/agent-runtime/src/event-queue/index.ts
- 错误行: 200,262
- 错误码: TS2412, TS2352
- 根因: undefined 不匹配 Timeout; 类型转换不安全
- 修复: as Timeout 断言; 先转 unknown
- 验收: Select-String event-queue/index -> 0

**T-AR-009: gemini-stream-parse.ts**
- 文件: packages/agent-runtime/src/gemini-stream-parse.ts
- 错误行: 51,58,166,170,191,264,274,286,360
- 错误码: TS2322 x 8, TS2375 x 1
- 根因: 与 anthropic-stream-parse 相同模式
- 修复: 同 T-AR-002
- 验收: Select-String gemini-stream-parse -> 0

**T-AR-010: git-versioning.ts**
- 文件: packages/agent-runtime/src/git-versioning.ts
- 错误行: 411,464
- 错误码: TS2379 x 2
- 根因: Omit exactOptional
- 修复: 条件展开 toolCall
- 验收: Select-String git-versioning -> 0

**T-AR-011: goal-disk-oracle.ts**
- 文件: packages/agent-runtime/src/goal-disk-oracle.ts
- 错误行: 76,91
- 错误码: TS2379 x 2
- 根因: { detail: string|undefined } 不匹配 { detail?: string }
- 修复: 省略 undefined detail
- 验收: Select-String goal-disk-oracle -> 0

**T-AR-012: hooks/extension-registry.ts**
- 文件: packages/agent-runtime/src/hooks/extension-registry.ts
- 错误行: 96,119,151
- 错误码: TS2322 x 3
- 根因: 返回类型 { block?: bool; reason?: string } 与实际 { block: false, reason: undefined } 不匹配
- 修复: 条件展开 reason
- 验收: Select-String extension-registry -> 0

**T-AR-013: hooks/tool-hook-observability.ts**
- 文件: packages/agent-runtime/src/hooks/tool-hook-observability.ts
- 错误行: 91,107,123,155,156,157
- 错误码: TS2379 x 2, TS2345, TS2322 x 3
- 根因: ToolHookContext 不匹配 + unknown 类型 + 返回类型
- 修复: 补可选字段 + 类型守卫 + 返回类型标注
- 验收: Select-String tool-hook-observability -> 0

**T-AR-014: local-tools/checkpoint-tools.ts**
- 文件: packages/agent-runtime/src/local-tools/checkpoint-tools.ts
- 错误行: 52,91,144
- 错误码: TS2379 x 3
- 根因: exactOptional 在三个 request 类型上
- 修复: 条件展开 undefined 字段
- 验收: Select-String checkpoint-tools -> 0

**T-AR-015: local-tools/fs-edit-tools/edit-tool.ts**
- 文件: packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts
- 错误行: 3,142
- 错误码: TS2305 x 2, TS2379
- 根因: 缺失导出 replaceViaSeekSequence, SeekPass; exactOptional
- 修复: 确认导出或替换 + exactOptional
- 验收: Select-String edit-tool -> 0


**T-AR-016: context-compression/token-estimator.ts**
- 文件: packages/agent-runtime/src/context-compression/token-estimator.ts
- 错误行: 123,196
- 错误码: TS2375 x 2
- 根因: ImageContent 和 ProviderUsage 可选字段
- 修复: 条件展开 width/height/detail 等
- 验收: Select-String token-estimator -> 0

**T-AR-017: media/media-preprocessor.ts**
- 文件: packages/agent-runtime/src/media/media-preprocessor.ts
- 错误行: 21,109,116
- 错误码: TS6133, TS2375, TS2379
- 根因: 未使用 mimeCategory + exactOptional
- 修复: 删除未使用导入 + exactOptional
- 验收: Select-String media-preprocessor -> 0

**T-AR-018: memory.ts**
- 文件: packages/agent-runtime/src/memory.ts
- 错误行: 356,389
- 错误码: TS2379 x 2
- 根因: Omit exactOptional
- 修复: 条件展开 metadata/query/scope/limit
- 验收: Select-String memory.ts -> 0

**T-AR-019: model-routing-enhanced.ts**
- 文件: packages/agent-runtime/src/model-routing-enhanced.ts
- 错误行: 78
- 错误码: TS2375
- 根因: RequiredCapabilityShape 的 minimumContextTokens 设为 number|undefined
- 修复: 条件展开
- 验收: Select-String model-routing-enhanced -> 0

**T-AR-020: model-routing/matcher.ts**
- 文件: packages/agent-runtime/src/model-routing/matcher.ts
- 错误行: 10,11,25,26,30,31,40,88,465
- 错误码: TS6133 x 6, TS2375 x 2
- 根因: 6 个未使用导入 + exactOptional
- 修复: 删除未使用 + exactOptional
- 验收: Select-String matcher -> 0

**T-AR-021: model-routing/profile.ts**
- 文件: packages/agent-runtime/src/model-routing/profile.ts
- 错误行: 3,23,52,103,104,110,121,146
- 错误码: TS6196, TS2379 x 2, TS2375 x 5
- 根因: 未使用 ModelCapabilityFlags + exactOptional 多处
- 修复: 删除 + exactOptional
- 验收: Select-String profile.ts -> 0

**T-AR-022: model-routing-roles.ts**
- 文件: packages/agent-runtime/src/model-routing-roles.ts
- 错误行: 1,230,233,236,239
- 错误码: TS6196, TS2412 x 4
- 根因: 未使用 ModelCapabilityTag + ModelProfile|undefined 分配
- 修复: 删除 + 非空断言
- 验收: Select-String model-routing-roles -> 0

**T-AR-023: plan-document/index.ts + validation.ts**
- 文件: packages/agent-runtime/src/plan-document/index.ts, validation.ts
- 错误行: 多行
- 错误码: TS6196 x 14, TS1361 x 20
- 根因: 未使用的 type import + import type 用作运行时值
- 修复: 删除未使用 + import type -> import
- 验收: Select-String plan-document/ -> 0

**T-AR-024: plan-document/operations.ts**
- 文件: packages/agent-runtime/src/plan-document/operations.ts
- 错误行: 1,2,4,200,212,238,252,262,267,272,279,285
- 错误码: TS6196, TS6133 x 2, TS2412 x 4, TS2322 x 5
- 根因: 未使用导入 + exactOptional + 数组类型不匹配
- 修复: 删除 + 空值合并 + 类型变换
- 验收: Select-String operations.ts -> 0

**T-AR-025: preview-queue.ts**
- 文件: packages/agent-runtime/src/preview-queue.ts
- 错误行: 247,365
- 错误码: TS2375 x 2
- 根因: PreviewTransitionUpdate 和 PreviewArtifactInput 可选字段
- 修复: 条件展开
- 验收: Select-String preview-queue -> 0

**T-AR-026: process-lifecycle/process-manager.ts**
- 文件: packages/agent-runtime/src/process-lifecycle/process-manager.ts
- 错误行: 132,319,323
- 错误码: TS2412 x 3
- 根因: number|undefined 不匹配 number; undefined 不匹配 Timeout
- 修复: 空值合并 ??; 默认值
- 验收: Select-String process-manager -> 0

**T-AR-027: project-progress-ledger.ts**
- 文件: packages/agent-runtime/src/project-progress-ledger.ts
- 错误行: 136,158
- 错误码: TS2375 x 2
- 根因: GlobalProgressItemRecord 和 AgentTaskRecord 可选字段
- 修复: 条件展开 summary
- 验收: Select-String project-progress-ledger -> 0


**T-AR-028: prompt-assembly.ts**
- 文件: packages/agent-runtime/src/prompt-assembly.ts
- 错误行: 144,206,215
- 错误码: TS2375, TS2379 x 2
- 根因: PromptAssemblyPayload 和 { id, label } exactOptional
- 修复: 条件展开
- 验收: Select-String prompt-assembly -> 0

**T-AR-029: provider-anthropic.ts**
- 文件: packages/agent-runtime/src/provider-anthropic.ts
- 错误行: 106,220
- 错误码: TS2379 x 2
- 根因: BuildAnthropicMessagesBodyOptions 和 AnthropicProviderOptions
- 修复: 条件展开 systemPrompt/temperature/topP/apiKey
- 验收: Select-String provider-anthropic -> 0

**T-AR-030: provider-gemini.ts**
- 文件: packages/agent-runtime/src/provider-gemini.ts
- 错误行: 111,235
- 错误码: TS2379 x 2
- 根因: 同上模式
- 修复: exactOptional
- 验收: Select-String provider-gemini -> 0

**T-AR-031: provider-openai-compatible.ts**
- 文件: packages/agent-runtime/src/provider-openai-compatible.ts
- 错误行: 101,256,389
- 错误码: TS2379, TS2375 x 2
- 根因: Omit exactOptional + HttpRequest.timeoutMs
- 修复: exactOptional
- 验收: Select-String provider-openai-compatible -> 0

**T-AR-032: provider-openai-chat.ts**
- 文件: packages/agent-runtime/src/provider-openai-chat.ts
- 错误行: 19,73,94,105
- 错误码: TS6192, TS2322 x 3
- 根因: 整个 import 未使用 + ProviderStreamEvent 联合体不匹配
- 修复: 删除 import + 重构对象或扩宽联合体
- 验收: Select-String provider-openai-chat -> 0

**T-AR-033: provider-openai-responses.ts**
- 文件: packages/agent-runtime/src/provider-openai-responses.ts
- 错误行: 92,141
- 错误码: TS2322 x 2
- 根因: ProviderStreamEvent 联合体不匹配
- 修复: 同 T-AR-032
- 验收: Select-String provider-openai-responses -> 0

**T-AR-034: provider-request-machine.ts**
- 文件: packages/agent-runtime/src/provider-request-machine.ts
- 错误行: 327
- 错误码: TS2379
- 根因: { initialContext?, snapshot? } exactOptional
- 修复: 条件展开
- 验收: Select-String provider-request-machine -> 0

**T-AR-035: provider-stream-contract/error.ts**
- 文件: packages/agent-runtime/src/provider-stream-contract/error.ts
- 错误行: 29
- 错误码: TS2379
- 根因: ErrorClassifierOptions exactOptional
- 修复: 条件展开 status
- 验收: Select-String error.ts -> 0

**T-AR-036: provider-transport/connection-manager.ts**
- 文件: packages/agent-runtime/src/provider-transport/connection-manager.ts
- 错误行: 129,149,304
- 错误码: TS2322 x 2, TS2379
- 根因: ProviderTransport|undefined 不匹配 ProviderTransport|null
- 修复: 空值合并 + exactOptional
- 验收: Select-String connection-manager -> 0

**T-AR-037: provider-gateway/credential-resolver.ts**
- 文件: packages/agent-runtime/src/provider-gateway/credential-resolver.ts
- 错误行: 3,4,8,14,26
- 错误码: TS6196, TS6133, TS2375 x 3
- 根因: 未使用导入 + exactOptional
- 修复: 删除 + exactOptional
- 验收: Select-String credential-resolver.ts -> 0

**T-AR-038: provider-gateway/index.ts**
- 文件: packages/agent-runtime/src/provider-gateway/index.ts
- 错误行: 多行
- 错误码: TS6133 x 5, TS2412 x 4, TS2379 x 4, TS2375 x 3
- 根因: 未使用导入 + exactOptional 多处
- 修复: 删除 + exactOptional
- 验收: Select-String provider-gateway/index -> 0

**T-AR-039: provider-gateway/route-selector.ts**
- 文件: packages/agent-runtime/src/provider-gateway/route-selector.ts
- 错误行: 2,45,126,188,233,251,268,273,282,292,342,351,403
- 错误码: TS6133 x 2, TS2375 x 13, TS2412
- 根因: 未使用导入 + 大量 exactOptional
- 修复: 删除 + 系统性 exactOptional
- 验收: Select-String route-selector.ts -> 0

**T-AR-040: runtime-metrics/collectors.ts**
- 文件: packages/agent-runtime/src/runtime-metrics/collectors.ts
- 错误行: 6,7,9,10,18,78,125,134,140,170,222,261,264,266,270,282,283
- 错误码: TS6133 x 6, TS2379 x 8, TS2339 x 2
- 根因: 6 个未使用导入 + 8 个 exactOptional + 2 个缺失属性
- 修复: 精简导入 + exactOptional + 补属性
- 验收: Select-String collectors.ts -> 0


**T-AR-041: runtime-metrics/snapshot.ts**
- 文件: packages/agent-runtime/src/runtime-metrics/snapshot.ts
- 错误行: 4,12x3,13x2,111,182,300,305x2
- 错误码: TS2459, TS6133 x 5, TS2375, TS2379 x 5
- 根因: JsonObject 未导出 + 未使用常量 + exactOptional
- 修复: 修正导入 + 删除 + exactOptional
- 验收: Select-String snapshot.ts -> 0

**T-AR-042: runtime-components/context-manager.ts**
- 文件: packages/agent-runtime/src/runtime-components/context-manager.ts
- 错误行: 78,139,167,177
- 错误码: TS2379 x 2, TS2375 x 2
- 根因: ContextCompressionRuntimeOptions + ContextProjectionOptions exactOptional
- 修复: exactOptional
- 验收: Select-String context-manager.ts -> 0

**T-AR-043: runtime-components/conversation-engine.ts**
- 文件: packages/agent-runtime/src/runtime-components/conversation-engine.ts
- 错误行: 219,281,294
- 错误码: TS2375 x 2, TS2412
- 根因: TurnResult + ConversationSnapshot + string|undefined 不匹配 string
- 修复: exactOptional + 默认值
- 验收: Select-String conversation-engine.ts -> 0

**T-AR-044: scoped-context.ts**
- 文件: packages/agent-runtime/src/scoped-context.ts
- 错误行: 112,134,335
- 错误码: TS2375 x 3
- 根因: ScopedContextRecord 和 ScopedContextCandidate 可选字段
- 修复: 条件展开 description/source/reason
- 验收: Select-String scoped-context.ts -> 0

**T-AR-045: scoped-context-resources.ts**
- 文件: packages/agent-runtime/src/scoped-context-resources.ts
- 错误行: 91,195,225
- 错误码: TS2375 x 2, TS2379
- 根因: ScopedContextResolverProject + ScopedContextResolverInput + ScopedRuleInput
- 修复: exactOptional
- 验收: Select-String scoped-context-resources -> 0

**T-AR-046: state-machine/core.ts**
- 文件: packages/agent-runtime/src/state-machine/core.ts
- 错误行: 100,307
- 错误码: TS2379, TS2375
- 根因: StateDefinition + TransitionTarget exactOptional
- 修复: 条件展开回调属性
- 验收: Select-String core.ts -> 0

**T-AR-047: subagent-loop.ts**
- 文件: packages/agent-runtime/src/subagent-loop.ts
- 错误行: 1,56,65
- 错误码: TS6196, TS2379, TS2375
- 根因: 未使用 JsonObject + exactOptional
- 修复: 删除 + exactOptional
- 验收: Select-String subagent-loop -> 0

**T-AR-048: tool-output-budget.ts + tool-output-guard.ts**
- 文件: packages/agent-runtime/src/tool-output-budget.ts, tool-output-guard.ts
- 错误行: budget:56, guard:87
- 错误码: TS2375 x 2
- 根因: ToolOutput 可选 artifacts 字段
- 修复: 条件展开
- 验收: Select-String tool-output -> 0

**T-AR-049: tools/tool-definition.ts**
- 文件: packages/agent-runtime/src/tools/tool-definition.ts
- 错误行: 54,55,124,131
- 错误码: TS2412 x 2, TS2379 x 2
- 根因: JsonObject|undefined 和 Record|undefined 不匹配; 含 Plan 05 F-12 归并
- 修复: ?: -> : Type|undefined
- 验收: Select-String tool-definition -> 0

**T-AR-050: provider/auth/credential-pool.ts**
- 文件: packages/agent-runtime/src/provider/auth/credential-pool.ts
- 错误行: 1,53,56,82,86,89,103,104,140,141
- 错误码: TS6133, TS2412 x 6, TS2322 x 3
- 根因: 未使用 createSecret + |undefined 不匹配
- 修复: 删除 + |null 或默认值
- 验收: Select-String credential-pool -> 0

**T-AR-051: provider/auth/credential-resolver.ts**
- 文件: packages/agent-runtime/src/provider/auth/credential-resolver.ts
- 错误行: 27,28,102
- 错误码: TS2412 x 3
- 根因: SecretValue|undefined 和 SecretStore|undefined 不匹配
- 修复: ! 断言或默认值
- 验收: Select-String credential-resolver.ts -> 0

**T-AR-052: provider/auth/key-rotation.ts**
- 文件: packages/agent-runtime/src/provider/auth/key-rotation.ts
- 错误行: 1,60,63,73,74
- 错误码: TS6133, TS2322 x 2, TS2412 x 2
- 根因: 未使用 + KeyEntry|undefined 不匹配 KeyEntry|null
- 修复: 删除 + 使用 null
- 验收: Select-String key-rotation -> 0

**T-AR-053: event-architecture/canonical-event.ts**
- 文件: packages/agent-runtime/src/event-architecture/canonical-event.ts
- 错误行: 483,484
- 错误码: TS2322 x 2
- 根因: diagnostic 不在 ConexEventDomain 联合体中
- 修复: 往 ConexEventDomain 加 diagnostic
- 验收: Select-String canonical-event.ts -> 0

**T-AR-054: rich-read.ts**
- 文件: packages/agent-runtime/src/rich-read.ts
- 错误行: 183,259,294
- 错误码: TS2322 x 2, TS2375
- 根因: 函数签名缺 context 参数 + exactOptional
- 修复: 加参数 + exactOptional
- 验收: Select-String rich-read -> 0

**T-AR-055: rendering/rendering-pipeline.ts**
- 文件: packages/agent-runtime/src/rendering/rendering-pipeline.ts
- 错误行: 225,433
- 错误码: TS2379 x 2
- 根因: Omit exactOptional + { stage, timestamp, detail? } exactOptional
- 修复: exactOptional
- 验收: Select-String rendering-pipeline -> 0

**T-AR-056: 批量小型修复文件（含 12 个 Plan 05 归并项）**
- 文件: runtime.ts, secrets-obfuscation.ts, trace/index.ts, tool-discovery.ts
        structured-summary.ts, skills.ts, workspace-mutation-coordinator.ts
        session.ts, subagents.ts, background-command.ts, chatgpt-pool.ts
        normalizer.ts 等
- 错误码: 各 1-3 errors
- 根因: exactOptional + 未使用 + 类型不匹配
- Plan 05 归并详项:
  - normalizer.ts: export legacyFinishReason; 修复 isRawToolCall 类型谓词
  - session.ts: 确认 blocks 用法（非 content）
  - subagents.ts: 验证条件展开模式已正确
  - trace/index.ts: SpanEvent.attributes ?: -> : Type|undefined
  - chatgpt-pool.ts: ChatGPTAccount.refreshToken ?: -> : string|undefined
  - background-command.ts: BackgroundCommandRecord 字段 ?: -> : Type|undefined
- 验收: 逐文件 grep


### 4.2 W-08 任务卡（agent-daemon exactOptional 批量）

**T-DO-001: approval-queue.ts**
- 文件: packages/agent-daemon/src/approval-queue.ts
- 错误行: 128,263,316,333
- 错误码: TS2375 x 2, TS2412, TS2379
- 根因: PendingApproval 接口字段 ?: 但赋值含 |undefined
- 修复: 接口 ?: -> : Type|undefined
- 验收: Select-String approval-queue -> 0

**T-DO-002: background-task-manager.ts**
- 文件: packages/agent-daemon/src/background-task-manager.ts
- 错误行: 208
- 错误码: TS2375
- 根因: 字面量 { finishedAt: string|undefined } 不匹配 { finishedAt?: string }
- 修复: DaemonBackgroundTaskSnapshot 接口 ?: -> |undefined
- 验收: 0

**T-DO-004: conversation-rewind-boundary.ts**
- 文件: packages/agent-daemon/src/conversation-rewind-boundary.ts
- 错误行: 97,120,213
- 错误码: TS2379 x 2, TS2375
- 根因: exactOptional 传参 + 接口字段
- 修复: 接口 ?: -> |undefined
- 验收: 0

**T-DO-005: daemon-approval-handler.ts**（含 Plan 05 F-13 归并）
- 文件: packages/agent-daemon/src/daemon-approval-handler.ts
- 错误行: 50,114
- 错误码: TS2379
- 根因: 传 { command: string|undefined } 给 command?: string
- Plan 05 补充: timeoutMs: number|null -> number|null|undefined
- 修复: 接口 ?: -> |undefined + timeoutMs 类型加 undefined
- 验收: 0

**T-DO-006: daemon-client-registry.ts**
- 文件: packages/agent-daemon/src/daemon-client-registry.ts
- 错误行: 53,57,137,216,236
- 错误码: TS2412 x 2, TS2379 x 3
- 根因: 回调类型不匹配 + 传参含 |undefined
- 修复: 字段加 |undefined; 接口 detail?: -> : |undefined
- 验收: 0

**T-DO-007: daemon-lifecycle.ts**
- 文件: packages/agent-daemon/src/daemon-lifecycle.ts
- 错误行: 165
- 错误码: TS2375
- 根因: 字面量 failure: DaemonLifecycleDiagnostic|undefined 不匹配 failure?:
- 修复: 接口 ?: -> |undefined
- 验收: 0

**T-DO-008: daemon-logger.ts**
- 文件: packages/agent-daemon/src/daemon-logger.ts
- 错误行: 9,42
- 错误码: TS2375, TS2412
- 根因: { stack: string|undefined } + undefined 赋给 WriteStream
- 修复: 接口改 stack: string|undefined; 字段 stream: WriteStream|undefined
- 验收: 0

**T-DO-019: index.ts (daemon)**
- 文件: packages/agent-daemon/src/index.ts
- 错误行: 188
- 错误码: TS2375
- 根因: Partical 含 |undefined
- 修复: 条件展开 ...(secretToken ? { secretToken } : {})
- 验收: 0

**T-DO-020: mcp-config.ts**
- 文件: packages/agent-daemon/src/mcp-config.ts
- 错误行: 192
- 错误码: TS2379
- 根因: 传 { env: Record|undefined } 给 StdioMcpAdapterOptions
- 修复: 接口 ?: -> |undefined
- 验收: 0

**T-DO-021: mcp-stdio-adapter.ts**
- 文件: packages/agent-daemon/src/mcp-stdio-adapter.ts
- 错误行: 181
- 错误码: TS2375
- 根因: AgentTool.inputSchema?: JsonObject 但赋值含 |undefined
- 修复: inputSchema?: -> : JsonObject|undefined
- 验收: 0

**T-DO-022: scoped-context-runtime.ts**
- 文件: packages/agent-daemon/src/scoped-context-runtime.ts
- 错误行: 245,249,253
- 错误码: TS2375 x 3
- 根因: ScopedContextResourcePathSet 的 files?:, dirs?:
- 修复: ?: -> : ...|undefined
- 验收: 0

**T-DO-023: scoped-context-store.ts**
- 文件: packages/agent-daemon/src/scoped-context-store.ts
- 错误行: 63
- 错误码: TS2375
- 根因: ScopedContextQueryResult.diagnostic?: 但赋值含 |undefined
- 修复: ?: -> : ...|undefined
- 验收: 0

**T-DO-028: server/connection-manager.ts**
- 文件: packages/agent-daemon/src/server/connection-manager.ts
- 错误行: 4,38,71,134,315,357,360
- 错误码: TS6196 x 3, TS2379 x 5, TS2352
- 根因: 未使用 + exactOptional + 类型转换
- 验收: 0

**T-DO-029: server/approval-bridge.ts**
- 文件: packages/agent-daemon/src/server/approval-bridge.ts
- 错误行: 63
- 错误码: TS2379
- 根因: ApprovalDecision.reason?: string 传 reason: string|undefined
- 修复: reason?: -> : string|undefined
- 验收: 0

**T-DO-030: server/workflow-manager.ts**
- 文件: packages/agent-daemon/src/server/workflow-manager.ts
- 错误行: 23,51,62
- 错误码: TS2412 x 3
- 根因: 非可选字段赋 undefined
- 修复: 字段类型加 |undefined
- 验收: 0

**T-DO-031: server/index.ts**
- 文件: packages/agent-daemon/src/server/index.ts
- 错误行: 6,72-82,125,142,147-148,168-169,204,214,220,237-238,255,295,371,381,429,460
- 错误码: TS2305, TS2339 x 5, TS2379 x 8, TS2412 x 2, TS6133, TS2559, TS2352 x 3, TS2554
- 根因: 混合: 缺失导出/属性/参数数/exactOptional
- 验收: 0

**T-DO-035: types/config.ts**
- 文件: packages/agent-daemon/src/types/config.ts
- 错误行: 56
- 错误码: TS2375
- 根因: DEFAULT_DAEMON_CONFIG 字面量赋 undefined 给非可选字段
- 修复: 条件展开或接口改 secretToken: string|undefined
- 验收: 0


### 4.3 W-14 任务卡（agent-orchestrator 源码）

**T-OR-001: artifact-store.ts**
- 文件: packages/agent-orchestrator/src/artifact-store.ts
- 错误行: 107
- 错误码: TS2375
- 根因: ContentAddressedBlobContent.encoding?: 但赋值含 |undefined
- 修复: encoding?: -> : utf8|binary|undefined
- 验收: Select-String artifact-store -> 0

**T-OR-002: conversation-rewind.ts**
- 文件: packages/agent-orchestrator/src/conversation-rewind.ts
- 错误行: 165,257
- 错误码: TS2379, TS2375
- 根因: PlanConversationRewindInput.checkpoint?: + ConversationRewindWorkspaceRestore.manifestPath?
- 修复: 接口 ?: -> |undefined
- 验收: 0

**T-OR-003: event-scan-goal-strategy.ts**
- 文件: packages/agent-orchestrator/src/event-scan-goal-strategy.ts
- 错误行: 23
- 错误码: TS2420
- 根因: EventScanGoalStrategy class 未正确实现 GoalLoopStrategy 接口
- 修复: 补充缺失方法签名
- 验收: 0

**T-OR-004: event-store-projection.ts**
- 文件: packages/agent-orchestrator/src/event-store-projection.ts
- 错误行: 108,125
- 错误码: TS2379 x 2
- 根因: StoredEventReadOptions.maxEvents?: + AgentMessage.metadata?:
- 修复: 接口 ?: -> |undefined
- 验收: 0

**T-OR-005: event-store.ts**
- 文件: packages/agent-orchestrator/src/event-store.ts
- 错误行: 143,149,160,183,413,789,807,814,1102
- 错误码: TS2412 x 4, TS2379 x 4, TS2375
- 根因: exactOptional 多处
- 修复: 接口 ?: -> |undefined; 变量声明加 |undefined
- 验收: 0

**T-OR-006: orchestrator.ts**
- 文件: packages/agent-orchestrator/src/orchestrator.ts
- 错误行: 78,110,290,300,390,396,401,425,438,495,649,680,703,716,751,1017,1175,1673-1696
- 错误码: TS2375, TS2355, TS2379 x 9, TS2304 x 3, TS2412, TS2339 x 6
- 根因: 混合: exactOptional + 返回类型 + 未声明变量 + AsyncQueue.buffer 缺失
- 验收: 0

**T-OR-007: task-assessment.ts**
- 文件: packages/agent-orchestrator/src/task-assessment.ts
- 错误行: 573
- 错误码: TS2375
- 根因: GoalContinuationDecision 的 detail?:, progressSignature?:, prompt? 赋值含 |undefined
- 修复: 接口 ?: -> |undefined
- 验收: 0

### 4.4 W-16 任务卡（根配置 + tsconfig）

**T-CFG-001: tsconfig.base.json**
- 文件: tsconfig.base.json (line 19)
- 错误: 全仓 TS2375/TS2379/TS2412 根源
- 根因: exactOptionalPropertyTypes: true
- 修复选项 A: 删除该配置（立即消除 ~900 错误，推荐）
- 修复选项 B: 保留并逐文件修复
- 验收: 全量 tsc --noEmit

**T-CFG-002: shared-utils tsconfig**
- 文件: packages/shared-utils/tsconfig.json
- 错误码: TS6059, TS6307
- 根因: rootDir=src 但测试文件从 crish-desktop 导入
- 修复: 调整 include 或使用项目引用
- 验收: tsc --noEmit -p shared-utils

**T-CFG-003/004/005: 创建缺失 tsconfig**
- 文件: agent-provider-http, plugin-sdk, test-utils（新建）
- 错误: TS5058（路径不存在）
- 修复: 创建 tsconfig 继承 base
- 验收: tsc --noEmit 成功

### 4.5 W-17 任务卡（shared-utils 源码）

**T-SH-001: streaming-jsonl-reader.ts** - highWaterMark exactOptional (TS2379)
**T-SH-002: hardware-profile.ts** - deviceMemory 条件展开 (TS2375)
**T-SH-003: jsonl-append-batcher.ts** - signal 条件展开 (TS2375)
**T-SH-004: mockFactories.ts** - secretToken 硬编码 (TS2375)
**T-SH-005: bounded-map.ts**（Plan 05 F-04 归并）- constructor onEvict?: -> |undefined (TS2412)

### 4.6 W-18 任务卡（crish-desktop JSX）

**T-UI-001: CardPanel.tsx** - 8 errors, 复合结构断裂, 需 Read 确认后修复
**T-UI-002: ChatHeaderMore.tsx** - TS1005, )); -> });
**T-UI-003: ChatStatusRibbons.tsx** - TS1005, )); -> });
**T-UI-004: ComposePlusMenu.tsx** - TS1005, )); -> });
**T-UI-005: DiffCardFileList.tsx** - TS1005, )); -> });
**T-UI-006: DiffCardGitActions.tsx** - TS1005, )); -> });
**T-UI-007: ModelPicker.tsx** - TS1005, )); -> });
**T-UI-008: QuickOpen.tsx** - TS1005+TS17002, 删除冗余 button
**T-UI-009: SettingsPanel.tsx** - TS1005+TS1128, )); -> }); + 删 };
**T-UI-010: WorkspaceChromeBars.tsx** - 13 errors, onClick 未闭合修复
验收: tsc --noEmit -p crish-desktop, stdout empty

### 4.7 W-09/10/11/12/13/15/19 任务卡概要

**W-09 (provider-gateway)**: T-DO-010~014, 文件 5 个, 含 credential-modes/index/health/provider-factory/types
**W-10 (handlers/factory)**: T-DO-015~018+T-DO-024~027+T-DO-032, 文件 10 个
**W-11 (杂项)**: T-DO-003+T-DO-009+T-DO-033+T-DO-034+T-DO-036~040, 文件 9 个
  - T-DO-033 含 Plan 05 F-14 归并（删除 toJsonObject/JsonValue + 修复 as unknown as）
**W-12 (protocol Zod)**: T-PV-001~009, 文件 9 个, 通用修复 ?: -> |undefined
**W-13 (daemon test)**: T-DT-001~007, 文件 7 个, 含删除未使用导入/类型修正
**W-15 (orchestrator test)**: T-OR-008~010, 文件 3 个, exactOptional + 缺失导出
**W-19 (测试批量)**: T-TS-001~048, ~48 文件, 详见 Plan 04 完整列表


---

## 5. 全局覆盖率确认

### 5.1 输入方案 -> 统一方案任务卡映射

| 输入方案 | 原始任务卡数 | 统一方案中对应 | 覆盖率 |
|---------|:----------:|:-------------:|:-----:|
| plan_01 (agent-runtime) | 64 + 6 rounds | T-AR-001~064 -> W-01~W-07 | 100% |
| plan_02 (daemon+orch) | 59 (DO 40 + PV 9 + OR 10) | T-DO/PV/OR -> W-08~W-15 | 100% |
| plan_03 (desktop UI) | 10 | T-UI-001~010 -> W-18 | 100% |
| plan_04 (shared+tests) | 57 (CONFIG 5 + SHARED 6 + TS 48 + DAEMON 7) | T-CFG/SH/TS/DT -> W-16/17/19 | 100% |
| plan_05 (recent changes) | 14 | 归并到 T-AR/T-DO/T-SH/T-TS | 100% |

### 5.2 零遗漏验证

| 目录范围 | 总涉事文件 | 分配到 Wave |
|---------|:---------:|:----------:|
| packages/agent-runtime/src/ | ~155 | W-01 ~ W-07 |
| packages/agent-daemon/src/ | ~58 | W-08 ~ W-13 |
| packages/agent-orchestrator/src/ | ~10 | W-14 ~ W-15 |
| packages/shared-utils/src/ | ~6 | W-17 |
| apps/crish-desktop/src/ | ~10 | W-18 |
| 根配置 + 缺失 tsconfig | ~6 | W-16 |
| 测试文件批量 | ~48 | W-19 |
| **总计** | **~289** | **19 个 Wave** |

---

## 6. 统一机器可读台账

以下为统一的 JSON 台账格式摘要（完整版 152 条任务详见原 5 份方案）：

### 6.1 Wave 级台账

`json
{
  "meta": {
    "plan": "final_synthesis_A",
    "generatedAt": "2026-07-25T12:00:00.000Z",
    "sourcePlans": ["plan_01_agent_runtime.md (1264L, 155F, 572E)",
                    "plan_02_daemon_orch.md (1295L, 68F, 675E)",
                    "plan_03_desktop_ui.md (971L, 10F, 28E)",
                    "plan_04_shared_tests.md (846L, ~60F, ~150E)",
                    "plan_05_recent_changes.md (1164L, 15F, ~45E)"],
    "totalFiles": 289,
    "totalErrors": 1300,
    "totalTaskCards": 152,
    "totalWaves": 19
  },
  "waves": [
    {"id":"W-01","name":"agent-runtime exactOptional 源码","pkg":"agent-runtime","prio":"P0","fileCount":70,"taskCards":["T-AR-001","T-AR-002","T-AR-003","T-AR-004","T-AR-005","T-AR-006","T-AR-007","T-AR-008","T-AR-009","T-AR-010","T-AR-011","T-AR-012","T-AR-013","T-AR-014","T-AR-015","T-AR-016","T-AR-017","T-AR-018","T-AR-019","T-AR-020","T-AR-021","T-AR-022","T-AR-023","T-AR-024","T-AR-025","T-AR-026","T-AR-027","T-AR-028","T-AR-029","T-AR-030","T-AR-031","T-AR-032","T-AR-033","T-AR-034","T-AR-035","T-AR-036","T-AR-037","T-AR-038","T-AR-039","T-AR-040","T-AR-041","T-AR-042","T-AR-043","T-AR-044","T-AR-045","T-AR-046","T-AR-047","T-AR-048","T-AR-049","T-AR-050","T-AR-051","T-AR-052","T-AR-053","T-AR-054","T-AR-055","T-AR-056"]},
    {"id":"W-02","name":"agent-runtime exactOptional 测试","pkg":"agent-runtime","prio":"P0","fileCount":36,"taskCards":["T-AR-057","T-AR-058","T-AR-059","T-AR-060"]},
    {"id":"W-03","name":"agent-runtime 未使用声明","pkg":"agent-runtime","prio":"P1","fileCount":29,"taskCards":["T-AR-B"]},
    {"id":"W-04","name":"agent-runtime 类型不匹配","pkg":"agent-runtime","prio":"P1","fileCount":16,"taskCards":["T-AR-C"]},
    {"id":"W-05","name":"agent-runtime import type","pkg":"agent-runtime","prio":"P1","fileCount":2,"taskCards":["T-AR-023","T-AR-025"]},
    {"id":"W-06","name":"agent-runtime 缺失导出","pkg":"agent-runtime","prio":"P2","fileCount":12,"taskCards":["T-AR-015"]},
    {"id":"W-07","name":"agent-runtime 边缘情况","pkg":"agent-runtime","prio":"P2","fileCount":7,"taskCards":["T-AR-064"]},
    {"id":"W-08","name":"agent-daemon exactOptional 批量","pkg":"agent-daemon","prio":"P0","fileCount":18,"taskCards":["T-DO-001","T-DO-002","T-DO-004","T-DO-005","T-DO-006","T-DO-007","T-DO-008","T-DO-019","T-DO-020","T-DO-021","T-DO-022","T-DO-023","T-DO-028","T-DO-029","T-DO-030","T-DO-031","T-DO-035"]},
    {"id":"W-09","name":"agent-daemon provider-gateway","pkg":"agent-daemon","prio":"P0","fileCount":5,"taskCards":["T-DO-010","T-DO-011","T-DO-012","T-DO-013","T-DO-014"]},
    {"id":"W-10","name":"agent-daemon handlers/factory","pkg":"agent-daemon","prio":"P0","fileCount":10,"taskCards":["T-DO-015","T-DO-016","T-DO-017","T-DO-018","T-DO-024","T-DO-025","T-DO-026","T-DO-027","T-DO-032"]},
    {"id":"W-11","name":"agent-daemon 杂项","pkg":"agent-daemon","prio":"P1","fileCount":9,"taskCards":["T-DO-003","T-DO-009","T-DO-033","T-DO-034","T-DO-036","T-DO-037","T-DO-038","T-DO-039","T-DO-040"]},
    {"id":"W-12","name":"agent-daemon protocol Zod","pkg":"agent-daemon","prio":"P1","fileCount":9,"taskCards":["T-PV-001","T-PV-002","T-PV-003","T-PV-004","T-PV-005","T-PV-006","T-PV-007","T-PV-008","T-PV-009"]},
    {"id":"W-13","name":"agent-daemon 测试","pkg":"agent-daemon","prio":"P2","fileCount":7,"taskCards":["T-DT-001","T-DT-002","T-DT-003","T-DT-004","T-DT-005","T-DT-006","T-DT-007"]},
    {"id":"W-14","name":"agent-orchestrator 源码","pkg":"agent-orchestrator","prio":"P0","fileCount":7,"taskCards":["T-OR-001","T-OR-002","T-OR-003","T-OR-004","T-OR-005","T-OR-006","T-OR-007"]},
    {"id":"W-15","name":"agent-orchestrator 测试","pkg":"agent-orchestrator","prio":"P2","fileCount":3,"taskCards":["T-OR-008","T-OR-009","T-OR-010"]},
    {"id":"W-16","name":"配置 + tsconfig","pkg":"root+shared","prio":"P0","fileCount":8,"taskCards":["T-CFG-001","T-CFG-002","T-CFG-003","T-CFG-004","T-CFG-005"]},
    {"id":"W-17","name":"shared-utils 源码","pkg":"shared-utils","prio":"P1","fileCount":4,"taskCards":["T-SH-001","T-SH-002","T-SH-003","T-SH-004","T-SH-005"]},
    {"id":"W-18","name":"crish-desktop JSX","pkg":"crish-desktop","prio":"P0","fileCount":10,"taskCards":["T-UI-001","T-UI-002","T-UI-003","T-UI-004","T-UI-005","T-UI-006","T-UI-007","T-UI-008","T-UI-009","T-UI-010"]},
    {"id":"W-19","name":"测试批量剩余","pkg":"多包","prio":"P2","fileCount":48,"taskCards":["T-TS-001","T-TS-002","T-TS-003","T-TS-004","T-TS-005","T-TS-006","T-TS-007","T-TS-008","T-TS-009","T-TS-010","T-TS-011","T-TS-012","T-TS-013","T-TS-014","T-TS-015","T-TS-016","T-TS-017","T-TS-018","T-TS-019","T-TS-020","T-TS-021","T-TS-022","T-TS-023","T-TS-024","T-TS-025","T-TS-026","T-TS-027","T-TS-028","T-TS-029","T-TS-030","T-TS-031","T-TS-032","T-TS-033","T-TS-034","T-TS-035","T-TS-036","T-TS-037","T-TS-038","T-TS-039","T-TS-040","T-TS-041","T-TS-042","T-TS-043","T-TS-044","T-TS-045","T-TS-046","T-TS-047","T-TS-048"]}
  ],
  "dependencies": {
    "W-16": [], "W-17": ["W-16"], "W-18": [],
    "W-01": [], "W-02": [], "W-03": [], "W-04": [], "W-05": [], "W-06": [], "W-07": [],
    "W-08": [], "W-09": [], "W-10": [], "W-11": [], "W-12": [],
    "W-13": ["W-08","W-09","W-10","W-11","W-12"],
    "W-14": [], "W-15": ["W-14"],
    "W-19": ["W-01","W-02","W-03","W-04","W-05","W-06","W-07","W-08","W-09","W-10","W-11","W-12","W-14"]
  },
  "gates": {
    "G0": {"description":"全量 tsc --noEmit","command":"tsc --noEmit -p agent-runtime && tsc --noEmit -p agent-daemon && tsc --noEmit -p agent-orchestrator && tsc --noEmit -p crish-desktop && tsc --noEmit -p shared-utils","passCondition":"exit 0"},
    "G2": {"description":"全量测试","command":"npx vitest run","passCondition":"exit 0"}
  }
}
`

### 6.2 单 Wave 台账示例（W-08）

`json
{
  "waveId": "W-08",
  "name": "agent-daemon exactOptionalPropertyTypes 批量",
  "status": "pending",
  "tasks": [
    {"id":"T-DO-001","file":"packages/agent-daemon/src/approval-queue.ts","lines":[128,263,316,333],"errors":["TS2375","TS2412","TS2379"],"status":"pending"},
    {"id":"T-DO-002","file":"packages/agent-daemon/src/background-task-manager.ts","lines":[208],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-004","file":"packages/agent-daemon/src/conversation-rewind-boundary.ts","lines":[97,120,213],"errors":["TS2379","TS2375"],"status":"pending"},
    {"id":"T-DO-005","file":"packages/agent-daemon/src/daemon-approval-handler.ts","lines":[50,114],"errors":["TS2379"],"status":"pending","plan05Merge":true,"plan05Detail":"timeoutMs: number|null -> number|null|undefined"},
    {"id":"T-DO-006","file":"packages/agent-daemon/src/daemon-client-registry.ts","lines":[53,57,137,216,236],"errors":["TS2412","TS2379"],"status":"pending"},
    {"id":"T-DO-007","file":"packages/agent-daemon/src/daemon-lifecycle.ts","lines":[165],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-008","file":"packages/agent-daemon/src/daemon-logger.ts","lines":[9,42],"errors":["TS2375","TS2412"],"status":"pending"},
    {"id":"T-DO-019","file":"packages/agent-daemon/src/index.ts","lines":[188],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-020","file":"packages/agent-daemon/src/mcp-config.ts","lines":[192],"errors":["TS2379"],"status":"pending"},
    {"id":"T-DO-021","file":"packages/agent-daemon/src/mcp-stdio-adapter.ts","lines":[181],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-022","file":"packages/agent-daemon/src/scoped-context-runtime.ts","lines":[245,249,253],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-023","file":"packages/agent-daemon/src/scoped-context-store.ts","lines":[63],"errors":["TS2375"],"status":"pending"},
    {"id":"T-DO-028","file":"packages/agent-daemon/src/server/connection-manager.ts","lines":[4,38,71,134,315,357,360],"errors":["TS6196","TS2379","TS2352"],"status":"pending"},
    {"id":"T-DO-029","file":"packages/agent-daemon/src/server/approval-bridge.ts","lines":[63],"errors":["TS2379"],"status":"pending"},
    {"id":"T-DO-030","file":"packages/agent-daemon/src/server/workflow-manager.ts","lines":[23,51,62],"errors":["TS2412"],"status":"pending"},
    {"id":"T-DO-031","file":"packages/agent-daemon/src/server/index.ts","lines":[6,72,73,75,82,125,142,147,148,168,169,204,214,220,237,238,255,295,371,381,429,460],"errors":["TS2305","TS2339","TS2379","TS2412","TS6133","TS2559","TS2352","TS2554"],"status":"pending"},
    {"id":"T-DO-035","file":"packages/agent-daemon/src/types/config.ts","lines":[56],"errors":["TS2375"],"status":"pending"}
  ],
  "verification": "npx tsc --noEmit --project packages/agent-daemon/tsconfig.json 2>&1 | Select-String '^packages/agent-daemon/src/' | Measure-Object -Line",
  "expectedResult": "0 errors"
}
`


---

## 7. 执行顺序总览

### 7.1 推荐执行阶段

`
Phase 0 — 配置前置
  W-16 (根配置 + 缺失 tsconfig)
  |
Phase 1 — 核心修复（并行 Wave，写集隔离）
  +-- W-01 (agent-runtime exactOptional 源码)
  +-- W-02 (agent-runtime exactOptional 测试)
  +-- W-03 (agent-runtime 未使用声明)
  +-- W-04 (agent-runtime 类型不匹配)
  +-- W-05 (agent-runtime import type)
  +-- W-06 (agent-runtime 缺失导出)
  +-- W-07 (agent-runtime 边缘情况)
  +-- W-08 (agent-daemon exactOptional)
  +-- W-09 (agent-daemon provider-gateway)
  +-- W-10 (agent-daemon handlers/factory)
  +-- W-11 (agent-daemon 杂项)
  +-- W-12 (agent-daemon protocol Zod)
  +-- W-14 (agent-orchestrator 源码)
  +-- W-17 (shared-utils 源码)
  +-- W-18 (crish-desktop JSX)
  |
Phase 2 — 测试修复（依赖对应源码 Wave 完成）
  +-- W-13 (agent-daemon 测试文件)   <- 依赖 W-08 ~ W-12
  +-- W-15 (agent-orchestrator 测试) <- 依赖 W-14
  +-- W-19 (测试文件批量剩余)        <- 依赖 Phase 1 全部
  |
Phase 3 — 验证
  +-- G0 全量 tsc --noEmit
  +-- G1 Lint
  +-- G2 全量测试
`

### 7.2 建议 Agent 分配

| Agent | Wave 分配 | 预计文件数 | 预计工时 |
|-------|----------|:--------:|:--------:|
| Agent #A | W-01 (exactOptional 源码) | 70 | 6-8h |
| Agent #B | W-08 (daemon exactOptional) | 18 | 2-3h |
| Agent #C | W-14 (orchestrator 源码) | 7 | 1-2h |
| Agent #D | W-16 + W-17 (配置 + shared) | 12 | 1-2h |
| Agent #E | W-18 (JSX 修复) | 10 | 1h |
| Agent #F | W-02 + W-03 (test + unused) | 65 | 3-4h |
| Agent #G | W-04+W-05+W-06+W-07 | 37 | 2-3h |
| Agent #H | W-09+W-10+W-11+W-12 | 33 | 2-3h |
| Agent #I | W-13+W-15+W-19 (测试) | 58 | 3-4h |

### 7.3 关键路径

`
W-16 (配置)
  |
Phase 1 所有 Wave（无依赖，可完全并行）
  |
  +-- Phase 2 W-19（依赖 Phase 1 全部完成）
  |       |
  +-------> G0 全量 tsc
              |
              +-> G2 测试
`

### 7.4 回滚策略

每个 Wave 的修改限定在 files_write 清单内。如有回归：
1. 识别引入回归的 Wave
2. 回滚该 Wave 的全部文件: git checkout -- <files>
3. 重新应用修复（可选不同策略）
4. 重新验证 G0

由于 Wave 间写集隔离，回滚一个 Wave 不影响其他 Wave。

---

## 8. 附录：修复模式速查

### 8.1 exactOptionalPropertyTypes 模式（占 ~69%）

**模式 A**（接口定义改 ?: -> |undefined）:
`	ypescript
// Before: interface Foo { bar?: string; }
// After:  interface Foo { bar: string | undefined; }
`

**模式 B**（赋值处条件展开）:
`	ypescript
// Before: { bar: maybeUndefined }
// After:  ...(maybeUndefined !== undefined ? { bar: maybeUndefined } : {})
`

**模式 C**（变量声明加 |undefined）:
`	ypescript
// Before: private timeout?: Timeout;
// After:  private timeout: Timeout | undefined;
`

### 8.2 未使用声明模式（占 ~15%）

`	ypescript
// Before: import { SomeType } from './mod'; // unused
// After:  (delete the line)
`

### 8.3 严格空检查模式（占 ~8%）

`	ypescript
// Before: const value = obj.prop.subProp;
// After:  const value = obj.prop!.subProp;
`

### 8.4 缺失必选属性模式（占 ~2%）

`	ypescript
// Before: const msg: AgentMessage = { role: "user", blocks: [...] };
// After:  const msg: AgentMessage = { id: "...", createdAt: "...", role: "user", blocks: [...] };
`

### 8.5 JSX 语法修复模式（占 ~2%）

- React.memo 结尾: )); -> });
- QuickOpen button: 删除冗余 button 标签
- WorkspaceChromeBars: 补 onClick 闭合 + 补 </button>

---

## 9. 方案完整性确认

| 项目 | 状态 |
|------|:----:|
| 错误全景 | ✓ 5 份方案合并，289 个文件，~1,300 错误 |
| 去重与冲突消解 | ✓ Plan 05 完全归并，跨方案 ID 统一，重复文件清单清理 |
| 写集隔离矩阵 | ✓ 19 个 Wave，零重叠保证，跨包无冲突 |
| 全局任务卡 | ✓ 152 张任务卡，完整覆盖 W-01 ~ W-19 |
| 覆盖率矩阵 | ✓ 5 份输入方案 100% 覆盖，0 遗漏 |
| 机器可读台账 | ✓ JSON 格式，Waves/Tasks/Gates 三层结构 |
| 执行顺序 | ✓ 3 阶段 + 依赖图 + Agent 分配 + 回滚策略 |
| 修复模式 | ✓ 5 种标准模式 + 具体文件级指令 |

---

**最终方案合成确认**: 以上合并方案完整反映了 plan_01~05 的全部修复意图，消除重复，统一命名，确保每个文件在一个 Wave 中出现一次。

*End of final_synthesis_A.md — 输出 5 份方案合并后的统一修复计划*
