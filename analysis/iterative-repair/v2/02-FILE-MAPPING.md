# 统一文件→包映射表（权威文档）

> 本文档是 `agent-runtime` 拆分的**唯一权威文件映射表**。
> 所有 Round 设计文档引用文件映射时必须指向本文档。
> 依赖方向以实际代码 import 验证为准（见 §9）。
> 本文档遵守 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 10-12 包拆分边界与判定标准、禁令 29-31 文档一致性要求。

---

## 1. 目标包总览

九个目标包及其职责（依赖图见 `01-OVERVIEW.md` §3，本节仅概述；权威依赖关系见 §9）：

| 目标包                     | 拓扑层           | 职责                                                                                                                                                                                                                                                                                       | 创建轮次 |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `@crish/agent-core`        | Layer 4 (top)    | 运行时核心：SessionLoop、StateMachine、ControlBus、SteeringCoordinator、RecoveryPipeline、FallbackChain、Hooks 派发器、EventProtocol/EventQueue、RuntimeComponents、RuntimeMetrics、Config、Rendering、ProcessLifecycle、Recovery（注：ErrorClassifier 已下沉 shared-utils，见 §2.1/§6.2） | R5       |
| `@crish/agent-tools`       | Layer 3 (middle) | 工具系统：ToolDefinition、ToolMiddleware、local-tools、tool-discovery、tool-registry、background-command、lsp-tools、rich-read、resource-uri、workspace-mutation-coordinator、script-wait-policy、skills、git-versioning（注：tool-output-budget 已迁入 agent-context，见 §2.1）           | R4       |
| `@crish/agent-model`       | Layer 3 (middle) | 模型/Provider 系统：provider/、provider-gateway/、provider-transport/、provider-stream-contract/、stream-parse、request-build、model-routing、model-catalog、pricing-engine、token-ledger、media、preview-queue                                                                            | R4       |
| `@crish/agent-context`     | Layer 2 (leaf)   | 上下文管理：context-compression、checkpoint、session/session-store、prompt-assembly、canonical-schema、wasm-tiktoken、structured-summary、trajectory-compressor、memory、scoped-context、blob-externalization、canonical-event                                                             | R3       |
| `@crish/agent-mcp`         | Layer 2 (leaf)   | MCP 生命周期：McpLifecycleManager、McpServerController、registerPluginServer 入口                                                                                                                                                                                                          | R3/R4    |
| `@crish/agent-permissions` | Layer 2 (leaf)   | 运行时信任执行：approval-pipeline、trust-zone-policy、secrets-obfuscation（不含 command-classification，该文件留 decision-engine）                                                                                                                                                         | R3       |
| `@crish/agent-subagent`    | Layer 5          | 子代理调度：subagents、subagent-loop、subagent-skill-runner、subagent-types、subagent-context-pack                                                                                                                                                                                         | R5/R9    |
| `@crish/logger`            | Layer 1 (leaf)   | 结构化日志：从 shared-utils/logger.ts 提取 + daemon-logger.ts 合并 + RotatingFileSink                                                                                                                                                                                                      | R2       |
| `@crish/telemetry`         | Layer 1 (leaf)   | 追踪：从 agent-runtime/trace/ 提取 + TraceManager + AsyncLocalStorage                                                                                                                                                                                                                      | R2       |

> 额外：`plugin-registry.ts` 与 `plugin-fs-registry.ts` 迁入 `plugin-sdk/src/registry/`（R8 重建）。

---

## 2. agent-runtime/src 文件→包映射

> 格式：`文件路径 → 目标包`。测试文件随其被测文件归属。
> 根目录文件按字母序排列；子目录各自成节。
> 标注 `[拆分]` 的文件需按域拆分到多个包。

### 2.1 根目录文件

| 文件                                     | 目标包                   | 说明                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IAgentRuntime.ts`                       | agent-core               | 运行时核心接口                                                                                                                                                                                                                                                                                                                                                                                   |
| `ISessionStore.ts`                       | agent-context            | Session Store 契约，与 session-store/ 实现同包                                                                                                                                                                                                                                                                                                                                                   |
| `agent-context.ts`                       | agent-context            | 上下文聚合入口                                                                                                                                                                                                                                                                                                                                                                                   |
| `agent-input-queue.ts`                   | agent-core               | Agent 输入队列（runtime 核心）                                                                                                                                                                                                                                                                                                                                                                   |
| `agent-input-queue.test.ts`              | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `agent-session-loop.ts`                  | agent-core               | SessionLoop 主体                                                                                                                                                                                                                                                                                                                                                                                 |
| `agent-session-loop.test.ts`             | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `anthropic-request-build.ts`             | agent-model              | provider request-build（冲突已解决，见 §3）                                                                                                                                                                                                                                                                                                                                                      |
| `anthropic-stream-parse.ts`              | agent-model              | provider stream-parse（冲突已解决，见 §3）                                                                                                                                                                                                                                                                                                                                                       |
| `background-command.ts`                  | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `background-command.test.ts`             | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blob-externalization.ts`                | agent-context            | 冲突已解决，见 §3                                                                                                                                                                                                                                                                                                                                                                                |
| `blob-externalization.test.ts`           | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `canonical-schema.ts`                    | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checkpoint-manifest.ts`                 | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checkpoint-manifest.test.ts`            | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checkpoints.ts`                         | agent-context            | checkpoint 域                                                                                                                                                                                                                                                                                                                                                                                    |
| `checkpoints.test.ts`                    | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `context-compression.ts`                 | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `context-compression.test.ts`            | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `context-projection.ts`                  | agent-context            | 上下文投影                                                                                                                                                                                                                                                                                                                                                                                       |
| `context-projection.test.ts`             | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `context-slicer.ts`                      | agent-context            | 上下文切片                                                                                                                                                                                                                                                                                                                                                                                       |
| `context-state.ts`                       | agent-context            | 上下文状态（InMemoryContextState 被 subagents.ts 引用）                                                                                                                                                                                                                                                                                                                                          |
| `context-state.test.ts`                  | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conversation-boundary-manifest.ts`      | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conversation-boundary-manifest.test.ts` | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conversation-rewind-target.ts`          | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conversation-rewind-target.test.ts`     | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `doctor-report.ts`                       | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `encoding.ts`                            | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `encoding.test.ts`                       | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `error-classifier.ts`                    | shared-utils             | 【解耦调整】原归 agent-core，被 agent-model 的 5 个生产文件反向引用（provider-stream-contract/error.ts、provider-stream-contract/normalizer.ts、provider-error-classifier.ts、provider-openai-helpers.ts、provider/engines/base-engine.ts）。ErrorClassifier/ErrorDomain/ClassifiedError/ErrorClassifierOptions 是跨层共享的基础设施，下沉 shared-utils（Layer 0）消除反向依赖。成熟资产，261 行 |
| `gemini-request-build.ts`                | agent-model              | provider request-build                                                                                                                                                                                                                                                                                                                                                                           |
| `gemini-stream-parse.ts`                 | agent-model              | provider stream-parse                                                                                                                                                                                                                                                                                                                                                                            |
| `git-versioning.ts`                      | agent-tools              | 根文件（区别于 git-versioning/ 目录）                                                                                                                                                                                                                                                                                                                                                            |
| `git-versioning.test.ts`                 | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `goal-disk-oracle.ts`                    | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `goal-disk-oracle.test.ts`               | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `index.ts`                               | agent-core               | barrel，R5 后转为 legacy shim（见 禁令 24）                                                                                                                                                                                                                                                                                                                                                      |
| `local-tools.ts`                         | agent-tools              | 根文件（区别于 local-tools/ 目录）                                                                                                                                                                                                                                                                                                                                                               |
| `local-tools.test.ts`                    | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lsp-tools.ts`                           | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lsp-tools.test.ts`                      | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mcp-lifecycle.ts`                       | agent-mcp                | 根文件（区别于 mcp-lifecycle/ 目录）                                                                                                                                                                                                                                                                                                                                                             |
| `mcp-lifecycle.test.ts`                  | agent-mcp                |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `memory.ts`                              | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `memory.test.ts`                         | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `model-routing-enhanced.ts`              | agent-model              | 根文件                                                                                                                                                                                                                                                                                                                                                                                           |
| `model-routing-roles.ts`                 | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `model-routing-roles.test.ts`            | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `model-routing.ts`                       | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `model-routing.test.ts`                  | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `model-routing.adversarial.test.ts`      | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `openai-request-build.ts`                | agent-model              | provider request-build                                                                                                                                                                                                                                                                                                                                                                           |
| `openai-request-build.test.ts`           | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `openai-retry.ts`                        | agent-model              | provider 重试                                                                                                                                                                                                                                                                                                                                                                                    |
| `openai-retry.test.ts`                   | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `openai-retry.adversarial.test.ts`       | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `openai-stream-parse.ts`                 | agent-model              | provider stream-parse                                                                                                                                                                                                                                                                                                                                                                            |
| `openai-stream-parse.test.ts`            | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `payload-image-recovery.ts`              | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `payload-image-recovery.test.ts`         | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `permissions.test.ts`                    | agent-permissions        |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plan-document.ts`                       | agent-core               | 计划文档运行时能力（daemon 侧有独立 store）                                                                                                                                                                                                                                                                                                                                                      |
| `plan-document.test.ts`                  | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plugin-fs-registry.ts`                  | plugin-sdk/src/registry/ |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plugin-registry.ts`                     | plugin-sdk/src/registry/ | 516 行，非真正注册表，迁移价值有限                                                                                                                                                                                                                                                                                                                                                               |
| `plugin-registry.test.ts`                | plugin-sdk/src/registry/ |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `preview-queue.ts`                       | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `preview-queue.test.ts`                  | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `preview-queue.adversarial.test.ts`      | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pricing-engine.ts`                      | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pricing-engine.adversarial.test.ts`     | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `project-progress-ledger.ts`             | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `project-progress-ledger.test.ts`        | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt-assembly.ts`                     | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt-assembly.test.ts`                | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt-context.ts`                      | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt-context.test.ts`                 | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-anthropic.ts`                  | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-anthropic.test.ts`             | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-cache-hints.ts`                | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-cache-hints.test.ts`           | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-error-classifier.ts`           | agent-model              | provider 专用错误分类（区别于 agent-core 的 error-classifier.ts）                                                                                                                                                                                                                                                                                                                                |
| `provider-gateway-edge.test.ts`          | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-gateway.test.ts`               | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-gemini.ts`                     | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-gemini.test.ts`                | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-openai-base.ts`                | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-chat.ts`                | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-class.ts`               | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-compatible.ts`          | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-compatible.test.ts`     | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `provider-openai-config.ts`              | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-helpers.ts`             | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-openai-responses.ts`           | agent-model              | provider                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-request-machine.ts`            | agent-model              | provider 请求状态机                                                                                                                                                                                                                                                                                                                                                                              |
| `provider-stream-contract.ts`            | agent-model              | 根文件（区别于 provider-stream-contract/ 目录）                                                                                                                                                                                                                                                                                                                                                  |
| `provider-stream-contract.test.ts`       | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `recovery-pipeline.ts`                   | agent-core               | RecoveryPipeline 3-Tier（成熟资产，184 行）                                                                                                                                                                                                                                                                                                                                                      |
| `recovery-pipeline.test.ts`              | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `resource-uri.ts`                        | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `resource-uri.test.ts`                   | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `response-style.ts`                      | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `response-style.test.ts`                 | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rich-read.ts`                           | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rich-read.test.ts`                      | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `runtime-defaults.ts`                    | agent-core               | runtime 默认值                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime-helpers.ts`                     | agent-core               | runtime 辅助                                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime-helpers.test.ts`                | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `runtime-metrics.ts`                     | agent-core               | RuntimeMetrics barrel                                                                                                                                                                                                                                                                                                                                                                            |
| `runtime-metrics.test.ts`                | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `runtime.ts`                             | agent-core               | runtime 核心（AgentRuntime）                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime.test.ts`                        | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scoped-context.ts`                      | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scoped-context.test.ts`                 | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scoped-context-resources.ts`            | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scoped-context-resources.test.ts`       | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `script-wait-policy.ts`                  | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `script-wait-policy.test.ts`             | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `secrets-obfuscation.ts`                 | agent-permissions        |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `secrets-obfuscation.test.ts`            | agent-permissions        |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session.ts`                             | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session.test.ts`                        | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `skills.ts`                              | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `skills.test.ts`                         | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `snapshots.ts`                           | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `snapshots.test.ts`                      | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `structured-summary.ts`                  | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `structured-summary.test.ts`             | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagent-context-pack.ts`               | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagent-context-pack.test.ts`          | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagent-loop.ts`                       | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagent-skill-runner.ts`               | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagent-types.ts`                      | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subagents.ts`                           | agent-subagent           | SubagentDepthGuard + semaphore（560 行）                                                                                                                                                                                                                                                                                                                                                         |
| `subagents.test.ts`                      | agent-subagent           |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `testing.ts`                             | agent-core               | 测试工具 barrel                                                                                                                                                                                                                                                                                                                                                                                  |
| `testing.test.ts`                        | agent-core               |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `token-ledger.ts`                        | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `token-ledger.test.ts`                   | agent-model              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tool-discovery.ts`                      | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tool-discovery.test.ts`                 | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tool-output-budget.ts`                  | agent-context            | 【解耦调整】原归 agent-tools，被 agent-context 的 4 个生产文件反向引用（context-compression/token-estimator.ts、context-compression/serializer.ts、context-compression/index.ts、context-projection.ts）。stringifyToolOutput/budgetTextForContext/budgetToolOutputForContext 与上下文压缩强内聚，迁入 agent-context（Layer 2）。agent-tools 和 agent-core 可正向引用 agent-context              |
| `tool-output-budget.test.ts`             | agent-context            | 随被测文件迁入 agent-context（解耦调整）                                                                                                                                                                                                                                                                                                                                                         |
| `tool-output-guard.ts`                   | agent-tools              | 工具输出守卫                                                                                                                                                                                                                                                                                                                                                                                     |
| `tool-output-guard.test.ts`              | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tool-registry.ts`                       | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools.ts`                               | agent-tools              | tools barrel                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools.test.ts`                          | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trajectory-compressor.ts`               | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `types.ts`                               | `[拆分]`                 | 见 §2.2 专项说明                                                                                                                                                                                                                                                                                                                                                                                 |
| `wasm-tiktoken.ts`                       | agent-context            |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `workspace-mutation-coordinator.ts`      | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |
| `workspace-mutation-coordinator.test.ts` | agent-tools              |                                                                                                                                                                                                                                                                                                                                                                                                  |

### 2.2 `types.ts` 按域拆分说明

`types.ts`（285 行）不整体迁入单一包，按域拆分（依据 禁令 10-12 与任务约束）：

| 类型/工厂片段                           | 目标包                                     | 说明                                                                                 |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| runtime options 类型                    | agent-core                                 | 运行时配置选项                                                                       |
| provider interfaces（AgentProvider 等） | agent-model                                | provider 契约                                                                        |
| session store 类型                      | shared-types（纯类型）+ agent-core（工厂） | 纯类型定义入 shared-types，工厂函数随 agent-core                                     |
| permission 类型                         | agent-permissions                          | 权限域类型                                                                           |
| tool 接口（AgentTool、ToolSource 等）   | shared-types                               | 纯类型，被 agent-mcp/agent-tools/agent-subagent 共同引用，必须下沉到 leaf 层避免循环 |
| 其余纯类型定义                          | shared-types                               | 纯类型定义入 shared-types                                                            |
| 工厂函数                                | 随各包迁移                                 | 工厂随其实现的包迁移                                                                 |

> 关键：`AgentTool`/`ToolSource` 被 `mcp-lifecycle-manager.ts`、`mcp-server-controller.ts`、`plugin-registry.ts`、`subagents.ts` 等多方引用，必须下沉到 `shared-types`，否则 agent-mcp（leaf）会反向依赖 agent-tools（middle），引入循环。此条与 §9 import 验证一致。

### 2.3 `approval/` 目录 → agent-permissions

| 文件                              | 目标包            |
| --------------------------------- | ----------------- |
| `approval/approval-cache.ts`      | agent-permissions |
| `approval/approval-cache.test.ts` | agent-permissions |
| `approval/approval-pipeline.ts`   | agent-permissions |
| `approval/chain-approval.ts`      | agent-permissions |

### 2.4 `checkpoint/` 目录 → agent-context

| 文件                               | 目标包        |
| ---------------------------------- | ------------- |
| `checkpoint/checkpoint-manager.ts` | agent-context |
| `checkpoint/index.ts`              | agent-context |

### 2.5 `config/` 目录 → agent-core

| 文件                      | 目标包     |
| ------------------------- | ---------- |
| `config/config-merger.ts` | agent-core |
| `config/index.ts`         | agent-core |

### 2.6 `context-compression/` 目录 → agent-context

> 【解耦调整】`token-estimator.ts` 需要 `MediaPreprocessor`/`ImageContent` 估算多模态 token 数，但 media/ 归 agent-model（Layer 3）。解耦方案：在 shared-types 定义 `MediaTokenEstimator` 纯类型接口，由 agent-model 的 `media/media-preprocessor.ts` 实现；`token-estimator.ts` import 接口而非实现。同时 `serializer.ts`/`index.ts` 通过 `tool-output-budget.ts`（已迁入 agent-context，见 §2.1）调用 `budgetToolOutputForContext`，不再反向依赖 agent-tools。

| 文件                                            | 目标包        | 说明                                                    |
| ----------------------------------------------- | ------------- | ------------------------------------------------------- |
| `context-compression/compression-utils.ts`      | agent-context |                                                         |
| `context-compression/compression-utils.test.ts` | agent-context |                                                         |
| `context-compression/index.ts`                  | agent-context | 引用本包 tool-output-budget.ts（已迁入，见 §2.1）       |
| `context-compression/serializer.ts`             | agent-context | 引用本包 tool-output-budget.ts（已迁入，见 §2.1）       |
| `context-compression/token-estimator.ts`        | agent-context | import shared-types 的 MediaTokenEstimator 接口（解耦） |

### 2.7 `control/` 目录 → agent-core（ControlBus L1/L2/L3）

| 文件                          | 目标包     |
| ----------------------------- | ---------- |
| `control/control-bus.ts`      | agent-core |
| `control/control-bus.test.ts` | agent-core |
| `control/index.ts`            | agent-core |
| `control/types.ts`            | agent-core |

### 2.8 `event-architecture/` 目录 → agent-context（canonical-event）+ agent-core（架构）

> 边界判定：`canonical-event.ts` 是上下文域的规范事件类型，agent-context（leaf）需直接产出/消费，必须位于 leaf 层；若放入 agent-core（top），agent-context 将反向依赖 top 层，违反拓扑。`index.ts` 作为 barrel 随 canonical-event 归属。"EventArchitecture"在 agent-core 中指代 `event-protocol/` + `event-queue/`（运行时事件基础设施）。见 §3 第 6 项。

| 文件                                         | 目标包        | 说明                      |
| -------------------------------------------- | ------------- | ------------------------- |
| `event-architecture/canonical-event.ts`      | agent-context | 规范事件类型，leaf 层必需 |
| `event-architecture/canonical-event.test.ts` | agent-context |                           |
| `event-architecture/index.ts`                | agent-context | barrel                    |

### 2.9 `event-protocol/` 目录 → agent-core

| 文件                                          | 目标包     |
| --------------------------------------------- | ---------- |
| `event-protocol/core-event-projector.ts`      | agent-core |
| `event-protocol/core-event-projector.test.ts` | agent-core |
| `event-protocol/core-event-types.ts`          | agent-core |
| `event-protocol/index.ts`                     | agent-core |

### 2.10 `event-queue/` 目录 → agent-core

| 文件                        | 目标包     |
| --------------------------- | ---------- |
| `event-queue/index.ts`      | agent-core |
| `event-queue/index.test.ts` | agent-core |

### 2.11 `fallback-chain/` 目录 → agent-core（FallbackChain 引擎）

| 文件                            | 目标包     |
| ------------------------------- | ---------- |
| `fallback-chain/engine.ts`      | agent-core |
| `fallback-chain/engine.test.ts` | agent-core |
| `fallback-chain/index.ts`       | agent-core |
| `fallback-chain/types.ts`       | agent-core |

### 2.12 `git-versioning/` 目录 → agent-tools

| 文件                                   | 目标包      |
| -------------------------------------- | ----------- |
| `git-versioning/git-commit-ops.ts`     | agent-tools |
| `git-versioning/git-patch-ops.ts`      | agent-tools |
| `git-versioning/git-patch-ops.test.ts` | agent-tools |
| `git-versioning/git-service.ts`        | agent-tools |
| `git-versioning/git-types.ts`          | agent-tools |

### 2.13 `hooks/` 目录 → agent-core（Hooks 派发器）

> 依据 禁令 10：钩子派发器（HookBus / LifecycleHookRegistry）留 agent-core；插件钩子类型定义在 R8 迁入 `shared-types/src/plugin.ts`。当前 hooks/ 整体归 agent-core，R8 时按需将纯类型下沉 shared-types。

| 文件                               | 目标包                                           |
| ---------------------------------- | ------------------------------------------------ |
| `hooks/agent-hooks.ts`             | agent-core                                       |
| `hooks/compact-lifecycle.ts`       | agent-core                                       |
| `hooks/compact-lifecycle.test.ts`  | agent-core                                       |
| `hooks/extension-registry.ts`      | agent-core                                       |
| `hooks/health-hook-pack.ts`        | agent-core                                       |
| `hooks/health-hook-pack.test.ts`   | agent-core                                       |
| `hooks/hook-types.ts`              | agent-core（R8 纯类型下沉 shared-types）         |
| `hooks/index.ts`                   | agent-core                                       |
| `hooks/lifecycle-hooks.ts`         | agent-core（348 行，必须保留 observe/on 双模式） |
| `hooks/lifecycle-hooks.test.ts`    | agent-core                                       |
| `hooks/tool-hook-observability.ts` | agent-core                                       |
| `hooks/tool-hook-types.ts`         | agent-core（R8 纯类型下沉 shared-types）         |

### 2.14 `local-tools/` 目录 → agent-tools

> 【解耦调整】`local-tools/types.ts` 原先 import `ProcessGuardOptions`、`ProcessShell` 类型（来自 `process-lifecycle/`，agent-core, Layer 4），导致 agent-tools（Layer 3）反向依赖 agent-core。解耦方案：将 `ProcessGuardOptions`、`ProcessShell` 类型下沉到 `shared-types`（见 §2.22、§5.3），`local-tools/types.ts` 改为从 shared-types import。此条与 §9.2 一致。

| 文件                                            | 目标包      | 说明                                                                                   |
| ----------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `local-tools/checkpoint-tools.ts`               | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools.ts`                  | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools.test.ts`             | agent-tools |                                                                                        |
| `local-tools/fs-read-tools.ts`                  | agent-tools |                                                                                        |
| `local-tools/index.ts`                          | agent-tools |                                                                                        |
| `local-tools/pre-mutation.ts`                   | agent-tools |                                                                                        |
| `local-tools/search-tools.ts`                   | agent-tools |                                                                                        |
| `local-tools/shared.ts`                         | agent-tools |                                                                                        |
| `local-tools/shell-tools.ts`                    | agent-tools |                                                                                        |
| `local-tools/types.ts`                          | agent-tools | ProcessGuardOptions/ProcessShell 改从 shared-types import（解耦，不再依赖 agent-core） |
| `local-tools/fs-edit-tools/apply-edits-tool.ts` | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools/edit-tool.ts`        | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools/index.ts`            | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools/types.ts`            | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools/utils.ts`            | agent-tools |                                                                                        |
| `local-tools/fs-edit-tools/write-tool.ts`       | agent-tools |                                                                                        |

### 2.15 `mcp-lifecycle/` 目录 → agent-mcp

| 文件                                          | 目标包    |
| --------------------------------------------- | --------- |
| `mcp-lifecycle/index.ts`                      | agent-mcp |
| `mcp-lifecycle/mcp-lifecycle-manager.ts`      | agent-mcp |
| `mcp-lifecycle/mcp-server-controller.ts`      | agent-mcp |
| `mcp-lifecycle/mcp-server-controller.test.ts` | agent-mcp |
| `mcp-lifecycle/types.ts`                      | agent-mcp |
| `mcp-lifecycle/utils.ts`                      | agent-mcp |

### 2.16 `media/` 目录 → agent-model

> 【解耦调整】`context-compression/token-estimator.ts`（agent-context, Layer 2）需要 `MediaPreprocessor` 和 `ImageContent` 来估算 token 数，但 media/ 归 agent-model（Layer 3），会导致 agent-context 反向依赖 agent-model。解耦方案：在 `shared-types` 中定义 `MediaTokenEstimator` 纯类型接口（含 estimateImageTokens/estimateMediaTokens 等方法签名），由 `media/media-preprocessor.ts`（agent-model）实现该接口。`context-compression/token-estimator.ts` import 接口而非实现。此条与 §9.2 一致。

| 文件                              | 目标包      | 说明                                                                           |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `media/media-cache.ts`            | agent-model |                                                                                |
| `media/media-cache.test.ts`       | agent-model |                                                                                |
| `media/media-preprocessor.ts`     | agent-model | 实现 shared-types 的 MediaTokenEstimator 接口（解耦）                          |
| `media/media-types.ts`            | agent-model | ImageContent 等类型；纯类型部分下沉 shared-types 供 agent-context 引用（解耦） |
| `media/provider-media-adapter.ts` | agent-model |                                                                                |

### 2.17 `model-catalog/` 目录 → agent-model

| 文件                            | 目标包      |
| ------------------------------- | ----------- |
| `model-catalog/catalog-sync.ts` | agent-model |
| `model-catalog/index.ts`        | agent-model |
| `model-catalog/types.ts`        | agent-model |

### 2.18 `model-routing/` 目录 → agent-model

| 文件                       | 目标包      |
| -------------------------- | ----------- |
| `model-routing/index.ts`   | agent-model |
| `model-routing/matcher.ts` | agent-model |
| `model-routing/profile.ts` | agent-model |
| `model-routing/types.ts`   | agent-model |

### 2.19 `path-handling/` 目录 → shared-utils

> 系统化判定：path-handling 是被 agent-tools（fs-edit-tools）、agent-context、agent-core 共同需要的底层工具。若置于 agent-core（top），middle 层 agent-tools 将反向依赖 top 层，违反拓扑。归入 shared-utils（leaf 基础设施），在 R2 一并迁移。

| 文件                          | 目标包       |
| ----------------------------- | ------------ |
| `path-handling/conex-path.ts` | shared-utils |
| `path-handling/index.ts`      | shared-utils |

### 2.20 `permission/` 目录 → 拆分（agent-permissions + decision-engine）

> 依据 禁令 12：`command-classification.ts` 留 decision-engine（纯决策），`trust-zone-policy.ts` 归 agent-permissions（运行时信任执行）。禁止两包同时包含 command-classification。

| 文件                                   | 目标包            | 说明                     |
| -------------------------------------- | ----------------- | ------------------------ |
| `permission/command-classification.ts` | decision-engine   | 纯决策逻辑，无运行时状态 |
| `permission/trust-zone-policy.ts`      | agent-permissions | 运行时信任区策略         |
| `permission/trust-zone-policy.test.ts` | agent-permissions |                          |

### 2.21 `plan-document/` 目录 → agent-core

| 文件                          | 目标包     |
| ----------------------------- | ---------- |
| `plan-document/index.ts`      | agent-core |
| `plan-document/markdown.ts`   | agent-core |
| `plan-document/operations.ts` | agent-core |
| `plan-document/types.ts`      | agent-core |
| `plan-document/validation.ts` | agent-core |

### 2.22 `process-lifecycle/` 目录 → agent-core

> 【解耦调整】`ProcessGuardOptions`、`ProcessShell` 类型被 `local-tools/types.ts`（agent-tools, Layer 3）引用，导致 agent-tools 反向依赖 agent-core。解耦方案：将这两个纯类型下沉到 `shared-types`（见 §5.3），`process-lifecycle/` 内部实现从 shared-types re-export 或直接 import。此条与 §9.2 一致。

| 文件                                         | 目标包     | 说明                                                            |
| -------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `process-lifecycle/index.ts`                 | agent-core |                                                                 |
| `process-lifecycle/process-executor.ts`      | agent-core | ProcessGuardOptions/ProcessShell 从 shared-types import（解耦） |
| `process-lifecycle/process-executor.test.ts` | agent-core |                                                                 |
| `process-lifecycle/process-manager.ts`       | agent-core | ProcessGuardOptions/ProcessShell 从 shared-types import（解耦） |

### 2.23 `provider/` 目录（含全部子目录）→ agent-model

> provider/ 整体归 agent-model，含 auth/oauth、builtin、cli、engines、spi、**tests** 全部子目录。

**provider/ 根文件：**

| 文件                              | 目标包      |
| --------------------------------- | ----------- |
| `provider/declarative-schema.ts`  | agent-model |
| `provider/factory.ts`             | agent-model |
| `provider/faux-provider.ts`       | agent-model |
| `provider/health-checker.ts`      | agent-model |
| `provider/index.ts`               | agent-model |
| `provider/loader.ts`              | agent-model |
| `provider/provider-gateway-v2.ts` | agent-model |
| `provider/registry-v2.ts`         | agent-model |
| `provider/types.ts`               | agent-model |

**provider/**tests**/：**

| 文件                                                        | 目标包      |
| ----------------------------------------------------------- | ----------- |
| `provider/__tests__/auth.test.ts`                           | agent-model |
| `provider/__tests__/base-engine.test.ts`                    | agent-model |
| `provider/__tests__/declarative-loader.test.ts`             | agent-model |
| `provider/__tests__/factory.test.ts`                        | agent-model |
| `provider/__tests__/registry.test.ts`                       | agent-model |
| `provider/__tests__/benchmarks/provider-lifecycle.bench.ts` | agent-model |
| `provider/__tests__/e2e/context-length-recovery.test.ts`    | agent-model |
| `provider/__tests__/e2e/exponential-backoff-e2e.test.ts`    | agent-model |
| `provider/__tests__/e2e/mock-server.ts`                     | agent-model |
| `provider/__tests__/e2e/provider-factory.test.ts`           | agent-model |
| `provider/__tests__/e2e/steering-injection.test.ts`         | agent-model |
| `provider/__tests__/e2e/stream-parser.test.ts`              | agent-model |

**provider/auth/：**

| 文件                                        | 目标包      |
| ------------------------------------------- | ----------- |
| `provider/auth/auth-method-bridge.ts`       | agent-model |
| `provider/auth/base-url-validator.ts`       | agent-model |
| `provider/auth/base-url-validator.test.ts`  | agent-model |
| `provider/auth/credential-pool.ts`          | agent-model |
| `provider/auth/credential-resolver.ts`      | agent-model |
| `provider/auth/encrypted-file-store.ts`     | agent-model |
| `provider/auth/index.ts`                    | agent-model |
| `provider/auth/key-rotation.ts`             | agent-model |
| `provider/auth/log-sanitizer.ts`            | agent-model |
| `provider/auth/secret-store.ts`             | agent-model |
| `provider/auth/types.ts`                    | agent-model |
| `provider/auth/oauth/account-store.ts`      | agent-model |
| `provider/auth/oauth/chatgpt-pool.ts`       | agent-model |
| `provider/auth/oauth/chatgpt-pool.test.ts`  | agent-model |
| `provider/auth/oauth/cross-process-lock.ts` | agent-model |
| `provider/auth/oauth/index.ts`              | agent-model |
| `provider/auth/oauth/local-server.ts`       | agent-model |
| `provider/auth/oauth/oauth-flow.ts`         | agent-model |
| `provider/auth/oauth/oauth-ui.ts`           | agent-model |
| `provider/auth/oauth/pkce.ts`               | agent-model |
| `provider/auth/oauth/state-machine.ts`      | agent-model |
| `provider/auth/oauth/token-guardian.ts`     | agent-model |

**provider/builtin/：**

| 文件                                           | 目标包      |
| ---------------------------------------------- | ----------- |
| `provider/builtin/anthropic-provider-class.ts` | agent-model |
| `provider/builtin/gemini-provider-class.ts`    | agent-model |
| `provider/builtin/index.ts`                    | agent-model |
| `provider/builtin/types.ts`                    | agent-model |

**provider/cli/：**

| 文件                                | 目标包      |
| ----------------------------------- | ----------- |
| `provider/cli/index.ts`             | agent-model |
| `provider/cli/main.ts`              | agent-model |
| `provider/cli/provider-dev.ts`      | agent-model |
| `provider/cli/provider-list.ts`     | agent-model |
| `provider/cli/provider-test.ts`     | agent-model |
| `provider/cli/provider-utils.ts`    | agent-model |
| `provider/cli/provider-validate.ts` | agent-model |

**provider/engines/：**

| 文件                                                 | 目标包      |
| ---------------------------------------------------- | ----------- |
| `provider/engines/anthropic-messages-engine.ts`      | agent-model |
| `provider/engines/anthropic-messages-engine.test.ts` | agent-model |
| `provider/engines/base-engine.ts`                    | agent-model |
| `provider/engines/index.ts`                          | agent-model |
| `provider/engines/ollama-engine.ts`                  | agent-model |
| `provider/engines/ollama-engine.test.ts`             | agent-model |
| `provider/engines/openai-compatible-engine.ts`       | agent-model |
| `provider/engines/openai-compatible-engine.test.ts`  | agent-model |

**provider/spi/：**

| 文件                               | 目标包      |
| ---------------------------------- | ----------- |
| `provider/spi/engine-class.ts`     | agent-model |
| `provider/spi/index.ts`            | agent-model |
| `provider/spi/provider-class.ts`   | agent-model |
| `provider/spi/provider-factory.ts` | agent-model |

### 2.24 `provider-gateway/` 目录 → agent-model

| 文件                                           | 目标包      |
| ---------------------------------------------- | ----------- |
| `provider-gateway/credential-resolver.ts`      | agent-model |
| `provider-gateway/credential-resolver.test.ts` | agent-model |
| `provider-gateway/factory.ts`                  | agent-model |
| `provider-gateway/index.ts`                    | agent-model |
| `provider-gateway/route-selector.ts`           | agent-model |
| `provider-gateway/route-selector.test.ts`      | agent-model |
| `provider-gateway/types.ts`                    | agent-model |

### 2.25 `provider-stream-contract/` 目录 → agent-model

| 文件                                           | 目标包      |
| ---------------------------------------------- | ----------- |
| `provider-stream-contract/error.ts`            | agent-model |
| `provider-stream-contract/index.ts`            | agent-model |
| `provider-stream-contract/json-repair.ts`      | agent-model |
| `provider-stream-contract/json-repair.test.ts` | agent-model |
| `provider-stream-contract/normalizer.ts`       | agent-model |
| `provider-stream-contract/normalizer.test.ts`  | agent-model |
| `provider-stream-contract/sequencer.ts`        | agent-model |
| `provider-stream-contract/types.ts`            | agent-model |

### 2.26 `provider-transport/` 目录 → agent-model

| 文件                                            | 目标包      |
| ----------------------------------------------- | ----------- |
| `provider-transport/connection-manager.ts`      | agent-model |
| `provider-transport/connection-manager.test.ts` | agent-model |
| `provider-transport/index.ts`                   | agent-model |
| `provider-transport/stream-recovery.ts`         | agent-model |
| `provider-transport/stream-recovery.test.ts`    | agent-model |
| `provider-transport/token-tracker.ts`           | agent-model |

### 2.27 `recovery/` 目录 → agent-core

| 文件                               | 目标包     |
| ---------------------------------- | ---------- |
| `recovery/stream-recovery.ts`      | agent-core |
| `recovery/stream-recovery.test.ts` | agent-core |

### 2.28 `rendering/` 目录 → agent-core

| 文件                              | 目标包     |
| --------------------------------- | ---------- |
| `rendering/index.ts`              | agent-core |
| `rendering/rendering-pipeline.ts` | agent-core |

### 2.29 `runtime-components/` 目录 → agent-core

> RuntimeComponents 是运行时集成层（含 context-manager、tool-executor、provider-call-gateway 等）。虽部分文件名含 "context"，但属运行时与上下文/工具/Provider 的集成胶水，归 agent-core。
> 【解耦调整】`context-manager.ts` 的实现类 `ContextManager` 被 `tools/tool-middleware.ts`（agent-tools, Layer 3）import 类型，导致 agent-tools 反向依赖 agent-core（Layer 4），与 `tool-executor.ts`（agent-core → agent-tools）形成循环。解耦方案：将 `ContextManager` 的纯类型接口下沉到 `shared-types`，定义为 `IContextManager` 接口；`tool-middleware.ts` import `IContextManager` 接口而非实现类。`context-manager.ts` 实现 `IContextManager`。此条与 §9.2 一致。

| 文件                                                    | 目标包     | 说明                                              |
| ------------------------------------------------------- | ---------- | ------------------------------------------------- |
| `runtime-components/context-compression-gate.ts`        | agent-core |                                                   |
| `runtime-components/context-compression-gate.test.ts`   | agent-core |                                                   |
| `runtime-components/context-manager.ts`                 | agent-core | 实现 shared-types 的 IContextManager 接口（解耦） |
| `runtime-components/context-manager.test.ts`            | agent-core |                                                   |
| `runtime-components/conversation-engine.ts`             | agent-core |                                                   |
| `runtime-components/conversation-engine.test.ts`        | agent-core |                                                   |
| `runtime-components/execution-strategy.ts`              | agent-core |                                                   |
| `runtime-components/index.ts`                           | agent-core |                                                   |
| `runtime-components/provider-call-gateway.ts`           | agent-core |                                                   |
| `runtime-components/provider-call-gateway.test.ts`      | agent-core |                                                   |
| `runtime-components/provider-response-consumer.ts`      | agent-core |                                                   |
| `runtime-components/provider-response-consumer.test.ts` | agent-core |                                                   |
| `runtime-components/single-tool-executor.ts`            | agent-core |                                                   |
| `runtime-components/token-estimator.ts`                 | agent-core |                                                   |
| `runtime-components/tool-executor.ts`                   | agent-core | import tools/（agent-tools），属正向依赖          |
| `runtime-components/tool-executor.test.ts`              | agent-core |                                                   |
| `runtime-components/tool-executor-options.ts`           | agent-core |                                                   |
| `runtime-components/tool-executor-timeout.test.ts`      | agent-core |                                                   |

### 2.30 `runtime-metrics/` 目录 → agent-core

| 文件                            | 目标包     |
| ------------------------------- | ---------- |
| `runtime-metrics/collectors.ts` | agent-core |
| `runtime-metrics/index.ts`      | agent-core |
| `runtime-metrics/snapshot.ts`   | agent-core |
| `runtime-metrics/types.ts`      | agent-core |

### 2.31 `session/` 目录 → agent-context

| 文件                         | 目标包        |
| ---------------------------- | ------------- |
| `session/session-replay.ts`  | agent-context |
| `session/session-storage.ts` | agent-context |
| `session/session-types.ts`   | agent-context |

### 2.32 `session-loop/` 目录 → agent-core（SessionLoop 子模块）

| 文件                                 | 目标包     |
| ------------------------------------ | ---------- |
| `session-loop/control-check.ts`      | agent-core |
| `session-loop/control-check.test.ts` | agent-core |
| `session-loop/index.ts`              | agent-core |
| `session-loop/index.test.ts`         | agent-core |
| `session-loop/provider-call.ts`      | agent-core |
| `session-loop/provider-call.test.ts` | agent-core |
| `session-loop/recovery.ts`           | agent-core |
| `session-loop/steering-delegate.ts`  | agent-core |
| `session-loop/tool-execution.ts`     | agent-core |
| `session-loop/types.ts`              | agent-core |

### 2.33 `session-store/` 目录 → agent-context

| 文件                             | 目标包        |
| -------------------------------- | ------------- |
| `session-store/archive-store.ts` | agent-context |
| `session-store/index.ts`         | agent-context |
| `session-store/types.ts`         | agent-context |

### 2.34 `state-machine/` 目录 → agent-core（StateMachine）

| 文件                                  | 目标包     |
| ------------------------------------- | ---------- |
| `state-machine/agent-session.ts`      | agent-core |
| `state-machine/core.ts`               | agent-core |
| `state-machine/core.test.ts`          | agent-core |
| `state-machine/index.ts`              | agent-core |
| `state-machine/run-lifecycle.ts`      | agent-core |
| `state-machine/run-lifecycle.test.ts` | agent-core |
| `state-machine/session-branch.ts`     | agent-core |
| `state-machine/turn-types.ts`         | agent-core |

### 2.35 `steering/` 目录 → agent-core（SteeringCoordinator）

| 文件                                        | 目标包     |
| ------------------------------------------- | ---------- |
| `steering/compression-recovery-strategy.ts` | agent-core |
| `steering/goal-audit-strategy.ts`           | agent-core |
| `steering/index.ts`                         | agent-core |
| `steering/recovery-steering-strategy.ts`    | agent-core |
| `steering/steering-coordinator.ts`          | agent-core |
| `steering/steering-input-queue.ts`          | agent-core |
| `steering/steering-input-queue.test.ts`     | agent-core |
| `steering/steering-types.ts`                | agent-core |

### 2.36 `stream/` 目录 → 拆分（agent-model + agent-core）

> 冲突已解决（见 §3 第 3 项）：stream-parse/request-build 归 agent-model；`thinking-config.ts` 归 agent-core（thinking 配置是运行时关注点，非 provider 流解析）。

| 文件                                     | 目标包      | 说明                                      |
| ---------------------------------------- | ----------- | ----------------------------------------- |
| `stream/index.ts`                        | agent-model | stream barrel                             |
| `stream/streaming-tool-executor.ts`      | agent-model | 流式工具执行（provider 流内工具调用解析） |
| `stream/streaming-tool-executor.test.ts` | agent-model |                                           |
| `stream/thinking-config.ts`              | agent-core  | thinking 配置（运行时关注点）             |
| `stream/thinking-config.test.ts`         | agent-core  |                                           |

### 2.37 `testing/` 目录 → agent-core

> 测试基础设施（faux-provider、faux-call-gateway、mock-tool、fixture-loader）归 agent-core。若 agent-model 测试需要 provider 专用 test double，可在 agent-model 内新建，不反向依赖。

| 文件                                      | 目标包     |
| ----------------------------------------- | ---------- |
| `testing/faux-call-gateway.ts`            | agent-core |
| `testing/faux-provider.ts`                | agent-core |
| `testing/fixture-loader.ts`               | agent-core |
| `testing/index.ts`                        | agent-core |
| `testing/mock-tool.ts`                    | agent-core |
| `testing/__tests__/faux-provider.test.ts` | agent-core |

### 2.38 `tool-stream/` 目录 → agent-core

> `tool-stream.ts` 是运行时工具流处理（区别于 provider 的 stream-parse），归 agent-core。

| 文件                              | 目标包     |
| --------------------------------- | ---------- |
| `tool-stream/tool-stream.ts`      | agent-core |
| `tool-stream/tool-stream.test.ts` | agent-core |

### 2.39 `tools/` 目录 → agent-tools

> 【解耦调整】`tool-middleware.ts` 原先 import `ContextManager` 类型（agent-core, Layer 4），导致 agent-tools（Layer 3）反向依赖 agent-core，与 `runtime-components/tool-executor.ts`（agent-core → agent-tools）形成循环。解耦方案：`tool-middleware.ts` 改为 import shared-types 中的 `IContextManager` 纯类型接口（见 §2.29），不再依赖 agent-core。此条与 §9.2 一致。

| 文件                            | 目标包      | 说明                                                                                            |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `tools/index.ts`                | agent-tools |                                                                                                 |
| `tools/tool-definition.ts`      | agent-tools | RegisteredTool 三层体系，176 行                                                                 |
| `tools/tool-middleware.ts`      | agent-tools | ToolMiddleware 3-Hook；import shared-types 的 IContextManager 接口（解耦，不再依赖 agent-core） |
| `tools/tool-preset-registry.ts` | agent-tools |                                                                                                 |
| `tools/tool-system.test.ts`     | agent-tools |                                                                                                 |

### 2.40 `trace/` 目录 → @crish/telemetry

| 文件                  | 目标包                                                       |
| --------------------- | ------------------------------------------------------------ |
| `trace/index.ts`      | @crish/telemetry（TraceManager + AsyncLocalStorage，367 行） |
| `trace/index.test.ts` | @crish/telemetry                                             |

### 2.41 `__tests__/` 目录（集成测试）→ 按被测域拆分

| 文件                                                | 目标包        | 说明                                    |
| --------------------------------------------------- | ------------- | --------------------------------------- |
| `__tests__/canonical-schema.test.ts`                | agent-context |                                         |
| `__tests__/canonicalize-tools.test.ts`              | agent-tools   |                                         |
| `__tests__/context-slicer.test.ts`                  | agent-context |                                         |
| `__tests__/error-classifier.test.ts`                | shared-utils  | 随被测文件迁入 shared-utils（解耦调整） |
| `__tests__/exponential-backoff.test.ts`             | agent-model   | provider 重试                           |
| `__tests__/steering-input-queue.test.ts`            | agent-core    |                                         |
| `__tests__/integrations/chatgpt-pool.test.ts`       | agent-model   | oauth/chatgpt pool                      |
| `__tests__/integrations/media-pipeline.test.ts`     | agent-model   | media                                   |
| `__tests__/integrations/oauth-flow.test.ts`         | agent-model   | oauth                                   |
| `__tests__/integrations/state-machine.test.ts`      | agent-core    |                                         |
| `__tests__/integrations/streaming-executor.test.ts` | agent-model   | provider 流式执行                       |
| `__tests__/integrations/tool-stream.test.ts`        | agent-core    | 运行时工具流                            |

---

## 3. 冲突解决记录

> 前 5 项为之前方案（plan-03 / implementation_plan）的冲突；第 6 项为本表新增的边界判定（任务清单中 agent-core "EventArchitecture" 与 agent-context "canonical-event.ts" 的归属歧义）；第 7-11 项为 v2 迭代修复中发现的反向依赖与循环依赖的解耦决策（系统化修复，非补丁式）。

| 序号 | 文件/目录                                                            | 之前冲突                                                                                         | 最终决策                                                          | 决策依据                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `approval/`                                                          | plan-03 说 agent-core，implementation_plan 说 agent-permissions                                  | **agent-permissions**                                             | 审批管线是运行时信任执行，与 agent-permissions 的 trust-zone-policy 强内聚；禁令 12 明确切线                                                                               |
| 2    | `stream/`（5 文件）                                                  | plan-03 说独立 agent-stream 包，implementation_plan 说 agent-core                                | **agent-model**（thinking-config 除外）                           | stream-parse 与 provider 实现强内聚；禁令 10 明确禁止 agent-stream 独立包（仅 5 文件不满足条件 1）                                                                         |
| 3    | `*-stream-parse.ts`（openai/anthropic/gemini）                       | plan-03 说 agent-stream，implementation_plan 说 agent-model                                      | **agent-model**                                                   | 与 provider 实现强内聚，独立破坏内聚性（禁令 10）                                                                                                                          |
| 4    | `*-request-build.ts`（openai/anthropic/gemini）                      | plan-03 说 agent-stream，implementation_plan 说 agent-model                                      | **agent-model**                                                   | 与 provider 实现强内聚（禁令 10）                                                                                                                                          |
| 5    | `blob-externalization.ts`                                            | plan-03 说 agent-core，implementation_plan 说 agent-context                                      | **agent-context**                                                 | 上下文 blob 外部化与 context 管理强内聚                                                                                                                                    |
| 6    | `event-architecture/canonical-event.ts`                              | 本任务清单中 agent-core 列 "EventArchitecture" 与 agent-context 列 "canonical-event.ts" 存在歧义 | **agent-context**                                                 | agent-context（leaf）需直接产出/消费规范事件；若归 agent-core（top），leaf 反向依赖 top，违反拓扑层。"EventArchitecture" 在 agent-core 指代 event-protocol/ + event-queue/ |
| 7    | `error-classifier.ts`                                                | 原归 agent-core，被 agent-model 5 个生产文件反向引用                                             | **shared-utils**                                                  | ErrorClassifier/ErrorDomain/ClassifiedError/ErrorClassifierOptions 是跨层共享基础设施，下沉 Layer 0 消除 agent-model→agent-core 反向依赖（见 §2.1/§6.2/§9.4）              |
| 8    | `tool-output-budget.ts`                                              | 原归 agent-tools，被 agent-context 4 个生产文件反向引用                                          | **agent-context**                                                 | stringifyToolOutput/budgetTextForContext/budgetToolOutputForContext 与上下文压缩强内聚，迁入 Layer 2 消除 agent-context→agent-tools 反向依赖（见 §2.1/§2.6/§9.4）          |
| 9    | `tools/tool-middleware.ts` ↔ `runtime-components/context-manager.ts` | tool-middleware.ts import ContextManager 类型，与 tool-executor.ts 形成循环                      | **IContextManager 接口下沉 shared-types**                         | 纯类型接口下沉 Layer 0，tool-middleware.ts import 接口，消除 agent-tools↔agent-core 循环（见 §2.29/§2.39/§5.3/§9.4）                                                       |
| 10   | `local-tools/types.ts` ↔ `process-lifecycle/`                        | local-tools/types.ts import ProcessGuardOptions/ProcessShell 类型                                | **ProcessGuardOptions/ProcessShell 下沉 shared-types**            | 纯类型下沉 Layer 0，消除 agent-tools→agent-core 反向依赖（见 §2.14/§2.22/§5.3/§9.4）                                                                                       |
| 11   | `context-compression/token-estimator.ts` ↔ `media/`                  | token-estimator.ts import MediaPreprocessor/ImageContent，跨层反向引用                           | **MediaTokenEstimator 接口 + ImageContent 类型下沉 shared-types** | 纯类型接口下沉 Layer 0，由 media-preprocessor.ts 实现，消除 agent-context→agent-model 反向依赖（见 §2.6/§2.16/§5.3/§9.4）                                                  |

---

## 4. 遗漏文件补录

> 以下文件/目录在之前方案（plan-03 / implementation_plan）中未明确归属，本表予以补录。

| 文件/目录                                                                        | 补录归属                    | 说明                                                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `local-tools.ts`（根文件）                                                       | agent-tools                 | 区别于 `local-tools/` 目录，之前方案易混淆遗漏                                                                                         |
| `git-versioning.ts`（根文件）                                                    | agent-tools                 | 区别于 `git-versioning/` 目录                                                                                                          |
| `provider-stream-contract.ts`（根文件）                                          | agent-model                 | 区别于 `provider-stream-contract/` 目录                                                                                                |
| `model-routing-enhanced.ts`（根文件）                                            | agent-model                 |                                                                                                                                        |
| `plugin-registry.ts` / `plugin-fs-registry.ts`                                   | plugin-sdk/src/registry/    | 禁令 10 明确并入 plugin-sdk，非独立包                                                                                                  |
| `path-handling/` 目录                                                            | shared-utils                | 被多层依赖的底层工具，须下沉 leaf 基础设施层避免循环                                                                                   |
| `tool-stream/` 目录                                                              | agent-core                  | 运行时工具流处理，之前方案未提及                                                                                                       |
| `testing/` 目录 + `testing.ts`                                                   | agent-core                  | 测试基础设施，之前方案未提及                                                                                                           |
| `__tests__/` 目录（集成测试）                                                    | 按被测域拆分（见 §2.41）    | 之前方案未覆盖集成测试归属                                                                                                             |
| `plan-document/` 目录 + `plan-document.ts`                                       | agent-core                  | 计划文档运行时能力，之前方案未提及                                                                                                     |
| `process-lifecycle/` 目录                                                        | agent-core                  | ProcessLifecycle，之前方案未提及                                                                                                       |
| `recovery/` 目录                                                                 | agent-core                  | stream-recovery，之前方案未提及                                                                                                        |
| `agent-input-queue.ts`                                                           | agent-core                  | Agent 输入队列，之前方案未提及                                                                                                         |
| `context-projection.ts` / `context-slicer.ts` / `context-state.ts`               | agent-context               | 上下文域文件，之前方案未逐项列明                                                                                                       |
| `runtime-defaults.ts` / `runtime-helpers.ts`                                     | agent-core                  | runtime 辅助，之前方案未提及                                                                                                           |
| `provider-error-classifier.ts`                                                   | agent-model                 | provider 专用错误分类，区别于 shared-utils 的 error-classifier.ts（解耦后下沉，见 §2.1/§6.2）                                          |
| `tool-output-budget.ts` / `tool-output-guard.ts`                                 | agent-context / agent-tools | 【解耦调整】`tool-output-budget.ts` 迁入 agent-context（被 4 个 context 文件反向引用），`tool-output-guard.ts` 留 agent-tools。见 §2.1 |
| `types.ts` 拆分（AgentTool/ToolSource 下沉 shared-types）                        | shared-types                | 关键：mcp-lifecycle-manager.ts 与 plugin-registry.ts 均引用，须下沉 leaf 层避免 agent-mcp 反向依赖 agent-tools                         |
| 所有 `.adversarial.test.ts` 文件                                                 | 随被测文件归属              | 之前方案未覆盖对抗性测试归属                                                                                                           |
| provider/ 下 `auth/`（含 oauth/）、`builtin/`、`cli/`、`engines/`、`spi/` 子目录 | agent-model                 | provider 全部子结构整体归 agent-model，之前方案仅笼统提 provider/                                                                      |

---

## 5. shared-types/src 文件映射（Round 1 增强）

> Round 1 增强 shared-types：扩展 errors.ts、新建 result.ts / error-payload.ts / error-codes.ts / plugin.ts。现有文件保留，新增文件见下表。

### 5.1 现有文件（保留 shared-types）

| 文件                                          | 目标包       | 说明                                                     |
| --------------------------------------------- | ------------ | -------------------------------------------------------- |
| `shared-types/src/index.ts`                   | shared-types | barrel                                                   |
| `shared-types/src/index.test.ts`              | shared-types |                                                          |
| `shared-types/src/errors.ts`                  | shared-types | R1 增强：CrishError 扩展（code 当前为裸 string，需分域） |
| `shared-types/src/events.ts`                  | shared-types |                                                          |
| `shared-types/src/message.ts`                 | shared-types |                                                          |
| `shared-types/src/message-identity.ts`        | shared-types |                                                          |
| `shared-types/src/orchestration.ts`           | shared-types |                                                          |
| `shared-types/src/permissions.ts`             | shared-types |                                                          |
| `shared-types/src/primitive-types.ts`         | shared-types |                                                          |
| `shared-types/src/provider-defaults.ts`       | shared-types |                                                          |
| `shared-types/src/run-control.ts`             | shared-types |                                                          |
| `shared-types/src/session-identity.ts`        | shared-types |                                                          |
| `shared-types/src/session-workspace.ts`       | shared-types |                                                          |
| `shared-types/src/stored-event.ts`            | shared-types |                                                          |
| `shared-types/src/tool.ts`                    | shared-types |                                                          |
| `shared-types/src/config-constants.ts`        | shared-types |                                                          |
| `shared-types/src/a1-contracts.test.ts`       | shared-types |                                                          |
| `shared-types/src/validators/index.ts`        | shared-types |                                                          |
| `shared-types/src/validators/ipc-schemas.ts`  | shared-types |                                                          |
| `shared-types/src/validators/typed-invoke.ts` | shared-types |                                                          |

### 5.2 Round 1 新增文件

| 文件（新建）                        | 目标包       | 说明                                                                 |
| ----------------------------------- | ------------ | -------------------------------------------------------------------- |
| `shared-types/src/result.ts`        | shared-types | CrishResult ADT + mapResult/flatMapResult/match（F-08）              |
| `shared-types/src/error-payload.ts` | shared-types | CrishErrorPayload 双端对齐，递归 cause（最多 8 层，F-09）            |
| `shared-types/src/error-codes.ts`   | shared-types | 64 正式码 + 10 reserved 码（domain.reason 格式）+ migrateErrorCode() |
| `shared-types/src/plugin.ts`        | shared-types | 插件钩子类型定义（禁令 10，R8 从 hooks/ 下沉）                       |

### 5.3 从 agent-runtime 迁入 shared-types 的类型

| 来源                                                      | 迁入内容                                           | 说明                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-runtime/src/types.ts`                              | AgentTool / ToolSource 等纯工具接口                | 被 agent-mcp（leaf）引用，须下沉                                                                                                                             |
| `agent-runtime/src/types.ts`                              | session store 纯类型                               |                                                                                                                                                              |
| `agent-runtime/src/hooks/hook-types.ts`                   | 插件钩子纯类型（R8）                               | 禁令 10                                                                                                                                                      |
| `agent-runtime/src/hooks/tool-hook-types.ts`              | 工具钩子纯类型（R8）                               | 禁令 10                                                                                                                                                      |
| `agent-runtime/src/runtime-components/context-manager.ts` | `IContextManager` 纯类型接口                       | 【解耦调整】消除 `tools/tool-middleware.ts`（agent-tools）对 agent-core 的反向依赖；`context-manager.ts` 实现此接口（见 §2.29、§2.39）                       |
| `agent-runtime/src/media/media-types.ts`                  | `ImageContent` 纯类型 + `MediaTokenEstimator` 接口 | 【解耦调整】消除 `context-compression/token-estimator.ts`（agent-context）对 agent-model 的反向依赖；由 `media/media-preprocessor.ts` 实现（见 §2.6、§2.16） |
| `agent-runtime/src/process-lifecycle/`                    | `ProcessGuardOptions`、`ProcessShell` 纯类型       | 【解耦调整】消除 `local-tools/types.ts`（agent-tools）对 agent-core 的反向依赖（见 §2.14、§2.22）                                                            |

---

## 6. shared-utils/src 文件映射（Round 2 提取）

> Round 2 从 shared-utils 提取 logger.ts 到 @crish/logger；path-handling/ 从 agent-runtime 迁入 shared-utils。其余文件保留 shared-utils。

### 6.1 提取到 @crish/logger

| 文件                                | 目标包        | 说明                                                                          |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `shared-utils/src/logger.ts`        | @crish/logger | 结构化 Logger + LogTransport（108 行），R2 增强 flush/span + RotatingFileSink |
| `agent-daemon/src/daemon-logger.ts` | @crish/logger | DaemonFileLogger（52 行）合并入 @crish/logger                                 |

### 6.2 迁入 shared-utils

| 文件                                                   | 目标包       | 说明                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-runtime/src/path-handling/conex-path.ts`        | shared-utils | 底层路径工具，多层共享                                                                                                                                                                                             |
| `agent-runtime/src/path-handling/index.ts`             | shared-utils | barrel                                                                                                                                                                                                             |
| `agent-runtime/src/error-classifier.ts`                | shared-utils | 【解耦调整】原归 agent-core，被 agent-model 5 个生产文件反向引用。ErrorClassifier/ErrorDomain/ClassifiedError/ErrorClassifierOptions 是跨层共享基础设施，下沉 shared-utils（Layer 0）消除反向依赖（见 §2.1、§9.2） |
| `agent-runtime/src/__tests__/error-classifier.test.ts` | shared-utils | 随被测文件迁入（解耦调整）                                                                                                                                                                                         |

### 6.3 现有文件（保留 shared-utils）

> 以下文件均保留 shared-utils，不迁出：

`index.ts`、`browser-index.ts`、`node-index.ts`、`backpressure.ts`、`backpressure.test.ts`、`__tests__/StreamRenderBuffer.test.ts`、`retry.ts`、`retry.adversarial.test.ts`、`cache.ts`、`cache.adversarial.test.ts`、`wal.ts`、`wal.adversarial.test.ts`、`abort-utils.ts`、`abort-utils.adversarial.test.ts`、`jsonl-append-batcher.ts`、`jsonl-append-batcher.test.ts`、`skill-id.ts`、`skill-id.test.ts`、`use-platform-adaptation.ts`、`platform-adaptation.ts`、`dynamic-adaptation.ts`、`seek-sequence.ts`、`seek-sequence.test.ts`、`ring-buffer.ts`、`ring-buffer.test.ts`、`prometheus-exporter.ts`、`metrics-exporter.ts`、`memory-manager.ts`、`hardware-profile.ts`、`performance-tier.ts`、`object.ts`、`object.test.ts`、`object-pool.ts`、`guards.ts`、`fsync.ts`、`error.ts`、`deep-equal.ts`、`deep-equal.test.ts`、`bounds.ts`、`bounded-array.ts`、`bounded-map.ts`、`bounded-map.test.ts`、`async-mutex.ts`、`async-mutex.test.ts`、`test/mockFactories.ts`、`file/index.ts`、`file/streaming-jsonl-reader.ts`、`file/streaming-jsonl-reader.test.ts`、`file/streaming-file-reader.ts`、`file/streaming-file-reader.test.ts`、`file/streaming-diff-parser.ts`、`file/streaming-diff-parser.test.ts`、`file/seek-sequence.ts`、`file/seek-sequence.test.ts`、`file/file-watchdog.ts`、`file/file-watchdog.test.ts`、`bench/perf-benchmark.ts`、`bench/mem-benchmark.ts`、`bench/mem-bench-definitions.ts`、`bench/bench-definitions.ts`、`bench/run-mem-benchmarks.ts`、`bench/run-benchmarks.ts`

---

## 7. agent-orchestrator/src 文件映射（Round 6 重构）

> Round 6 对 agent-orchestrator 做集成性重构（CrishError 集成 + 日志集成 + TSC 修复），文件不迁出，全部保留 agent-orchestrator。下表为完整清单。

| 文件                                                              | 目标包                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `agent-orchestrator/src/index.ts`                                 | agent-orchestrator                                              |
| `agent-orchestrator/src/types.ts`                                 | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator.ts`                          | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator.test.ts`                     | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator/agent-loop.ts`               | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator/task-dispatcher.ts`          | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts` | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator/dispatcher/goal-executor.ts` | agent-orchestrator                                              |
| `agent-orchestrator/src/orchestrator/dispatcher/task-queue.ts`    | agent-orchestrator                                              |
| `agent-orchestrator/src/runtime-engine.ts`                        | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store.ts`                           | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store.test.ts`                      | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store/event-indexer.ts`             | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store/event-types.ts`               | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store/event-storage.ts`             | agent-orchestrator                                              |
| `agent-orchestrator/src/event-store-projection.ts`                | agent-orchestrator                                              |
| `agent-orchestrator/src/event-scan-goal-strategy.ts`              | agent-orchestrator（GoalLoopStrategy + FNV-1a stall，成熟资产） |
| `agent-orchestrator/src/session-tree.ts`                          | agent-orchestrator（SessionTree + BoundedMap，成熟资产）        |
| `agent-orchestrator/src/session-tree.test.ts`                     | agent-orchestrator                                              |
| `agent-orchestrator/src/session-summary.ts`                       | agent-orchestrator                                              |
| `agent-orchestrator/src/state-machine.ts`                         | agent-orchestrator                                              |
| `agent-orchestrator/src/state-machine.test.ts`                    | agent-orchestrator                                              |
| `agent-orchestrator/src/state-snapshot.ts`                        | agent-orchestrator                                              |
| `agent-orchestrator/src/epoch-snapshot.ts`                        | agent-orchestrator                                              |
| `agent-orchestrator/src/task-assessment.ts`                       | agent-orchestrator                                              |
| `agent-orchestrator/src/task-assessment.test.ts`                  | agent-orchestrator                                              |
| `agent-orchestrator/src/goal-continuation.ts`                     | agent-orchestrator                                              |
| `agent-orchestrator/src/conversation-rewind.ts`                   | agent-orchestrator                                              |
| `agent-orchestrator/src/conversation-rewind.test.ts`              | agent-orchestrator                                              |
| `agent-orchestrator/src/artifact-store.ts`                        | agent-orchestrator                                              |
| `agent-orchestrator/src/artifact-store.test.ts`                   | agent-orchestrator                                              |
| `agent-orchestrator/src/protocol.ts`                              | agent-orchestrator                                              |
| `agent-orchestrator/src/protocol.test.ts`                         | agent-orchestrator                                              |
| `agent-orchestrator/src/simple-import-test.test.ts`               | agent-orchestrator                                              |
| `agent-orchestrator/src/__tests__/types.test.ts`                  | agent-orchestrator                                              |

---

## 8. agent-daemon/src 文件映射（Round 7 重构）

> Round 7 对 agent-daemon 做集成性重构（日志升级 + 错误传播 + TSC 修复）。仅 `daemon-logger.ts` 迁出至 @crish/logger，其余全部保留 agent-daemon。

### 8.1 迁出文件

| 文件                                | 目标包        | 说明                            |
| ----------------------------------- | ------------- | ------------------------------- |
| `agent-daemon/src/daemon-logger.ts` | @crish/logger | 合并入 @crish/logger（见 §6.1） |

### 8.2 保留文件（agent-daemon）

> 以下文件均保留 agent-daemon，不迁出（仅做 R7 集成重构）：

`index.ts`、`types.ts`、`server.ts`、`server.test.ts`、`server-handlers.ts`、`server-handlers.test.ts`、`server-event-store.ts`、`server-event-store.test.ts`、`server-runtime-factory.ts`、`server-runtime-factory.test.ts`、`server-runtime-factory/index.ts`、`server-runtime-factory/types.ts`、`server-runtime-factory/tool-assembly.ts`、`server-runtime-factory/mcp-factory.ts`、`server-runtime-factory/config-assembly.ts`、`server/index.ts`、`server/connection-manager.ts`、`server/message-router.ts`、`server/http-servers.ts`、`server/approval-bridge.ts`、`server/store-registry.ts`、`server/workflow-manager.ts`、`capabilities.ts`、`capabilities.test.ts`、`daemon-lifecycle.ts`、`daemon-client-registry.ts`、`daemon-product-adapters.ts`、`daemon-subagent-bridge.ts`、`daemon-approval-handler.ts`、`daemon-approval-handler.test.ts`、`daemon-permission-policy.ts`、`daemon-permission-policy.test.ts`、`daemon-provider-gateway.ts`、`daemon-provider-gateway.test.ts`、`daemon-provider-gateway/index.ts`、`daemon-provider-gateway/types.ts`、`daemon-provider-gateway/provider-factory.ts`、`daemon-provider-gateway/health.ts`、`daemon-provider-gateway/credential-modes.ts`、`approval-queue.ts`、`approval-queue.test.ts`、`approval-projection.ts`、`approval-projection.test.ts`、`background-task-manager.ts`、`binary-frame.ts`、`binary-frame.test.ts`、`binary-frame.property.test.ts`、`binary-frame.cross-contract.test.ts`、`conversation-rewind-boundary.ts`、`conversation-rewind-boundary.test.ts`、`env-whitelist.ts`、`env-whitelist.adversarial.test.ts`、`mcp-config.ts`、`mcp-config.test.ts`、`mcp-stdio-adapter.ts`、`mcp-stdio-adapter.test.ts`、`observability/prometheus-exporter.ts`、`persistence.ts`、`permission-store.ts`、`permission-store.adversarial.test.ts`、`plan-document-store.ts`、`plan-document-store.test.ts`、`scoped-context-runtime.ts`、`scoped-context-store.ts`、`scoped-context-store.test.ts`、`scoped-context-query-handlers.ts`、`session-metadata-store.ts`、`session-metadata-store.test.ts`、`session-query-handlers.ts`、`session-query-handlers.test.ts`、`stream-backpressure.ts`、`stream-backpressure.test.ts`、`subagent-runtime.ts`、`subagent-runtime.test.ts`、`subagent-lifecycle.ts`、`task-snapshot-projection.ts`、`task-snapshot-projection.test.ts`、`task-snapshot/index.ts`、`task-snapshot/event-handlers.ts`、`test-temp-cleanup.ts`、`workflow-store.ts`、`workflow-store.test.ts`、`workflow-store/index.ts`、`workflow-store/types.ts`、`workflow-store/storage-engine.ts`、`workflow-store/validation.ts`、`workflow-scheduler.ts`、`workflow-scheduler.test.ts`、`types/index.ts`、`types/config.ts`、`types/entities.ts`、`types/snapshot-types.ts`、`types/provider-types.ts`、`types/protocol-inbound.ts`、`types/protocol-inbound-run.ts`、`types/protocol-inbound-session.ts`、`types/protocol-inbound-diagnostic.ts`、`types/protocol-inbound-auth.ts`、`types/protocol-outbound.ts`、`types/protocol-outbound-run.ts`、`types/protocol-outbound-session.ts`、`types/protocol-outbound-diagnostic.ts`、`types/protocol-outbound-auth.ts`、`protocol/protocol.ts`、`protocol/protocol-codec.ts`、`protocol/protocol-types.ts`、`protocol/registry.ts`、`protocol/registry.test.ts`、`protocol/schema-groups.ts`、`protocol/codec/decode.ts`、`protocol/codec/encode.ts`、`protocol/codec/shared.ts`、`protocol/validators/base.ts`、`protocol/validators/base-types.ts`、`protocol/validators/base-schema.ts`、`protocol/validators/common.ts`、`protocol/validators/common.test.ts`、`protocol/validators/common-fields.ts`、`protocol/validators/common-fields-msg.ts`、`protocol/validators/common-fields-entity.ts`、`protocol/validators/common-helpers.ts`、`protocol/validators/common-schema.ts`、`protocol/validators/common-types.ts`、`protocol/validators/common-zod-helpers.ts`、`protocol/validators/status.ts`、`protocol/validators/provider.ts`、`protocol/validators/run.ts`、`protocol/validators/session.ts`、`protocol/validators/session-events.ts`、`protocol/validators/session-actions.ts`、`protocol/validators/rewind.ts`、`protocol/validators/plan.ts`、`protocol/validators/git.ts`、`protocol/validators/workflow.ts`、`protocol/validators/subagent.ts`、`protocol/validators/background.ts`、`protocol/validators/background/tool-validators.ts`、`protocol/validators/background/context-validators.ts`、`protocol/validators/background/mutation-validators.ts`、`protocol/validators/background/mcp-validators.ts`、`protocol/validators/background/lifecycle-validators.ts`、`protocol/validators/background/task-validators.ts`、`protocol/validators/session-events/state-events.ts`、`protocol/validators/session-events/message-events.ts`、`protocol/validators/common-fields/shared.ts`、`protocol/validators/common-fields/system-resource-entity.ts`、`protocol/validators/common-fields/task-session-entity.ts`、`protocol/validators/common-fields/scoped-context-entity.ts`、`protocol/validators/common-fields/rewind-entity.ts`、`handlers/run-handlers.ts`、`handlers/run-control.test.ts`、`handlers/run-handlers.stream-pause.test.ts`、`handlers/run-handlers/run-lifecycle.ts`、`handlers/run-handlers/run-tool-executor.ts`、`handlers/run-handlers/lifecycle/run-handler.ts`、`handlers/run-handlers/lifecycle/run-start.ts`、`handlers/run-handlers/lifecycle/run-end.ts`、`handlers/run-handlers/lifecycle/run-stream.ts`、`handlers/run-handlers/lifecycle/admission-control.ts`、`handlers/run-handlers/lifecycle/workflow-orchestration.ts`、`handlers/approval-handlers.ts`、`handlers/approval-handlers.test.ts`、`handlers/background-task-handlers.ts`、`handlers/config-handlers.ts`、`handlers/git-handlers.ts`、`handlers/mcp-handlers.ts`、`handlers/pending-input-handlers.ts`、`handlers/plan-document-handlers.ts`、`handlers/scoped-context-handlers.ts`、`handlers/session-handlers.ts`、`handlers/subagent-handlers.ts`、`handlers/workflow-handlers.ts`、`handlers/artifact-handlers.ts`、`__tests__/live-provider.e2e.test.ts`、`__tests__/agent-protocol.e2e.test.ts`、`__tests__/agent-real-workflow-e2e.test.ts`

---

## 9. 依赖方向验证

> 依赖方向以实际代码 import 验证为准。本节为权威依赖关系，引用 `01-OVERVIEW.md` §3 依赖图并修正其 mermaid 中 agent-subagent 边的方向错误。

### 9.1 关键文件 import 验证

**`subagents.ts`（前 30 行）import：**

- `./runtime`（AgentRuntime）→ agent-core
- `./session`（createId, nowIso）→ agent-context
- `./project-progress-ledger` → agent-context
- `./subagent-context-pack` → agent-subagent（包内）
- `./tools`（defineTool）→ agent-tools
- `@crish/shared-types` → shared-types
- `./types`（AgentRuntimeOptions, AgentTool, ToolSource）→ 拆分后主要入 shared-types
- `./context-state`（InMemoryContextState）→ agent-context
- `@crish/shared-utils`（AsyncSemaphore）→ shared-utils

**验证结论：** agent-subagent 依赖 agent-core + agent-tools + agent-context + shared-types + shared-utils。即 **agent-subagent 依赖 agent-core**，而非 agent-core 依赖 agent-subagent。

**`subagent-loop.ts`（前 30 行）import：**

- `./runtime`（AgentRuntime）→ agent-core
- `./provider-stream-contract`（provider stream 契约）→ agent-model
- `./session`（createId, nowIso）→ agent-context
- `./subagent-context-pack` → agent-subagent（包内）
- `./tools`（defineTool）→ agent-tools
- `@crish/shared-types` → shared-types
- `@crish/shared-utils` → shared-utils

**验证结论：** agent-subagent 还依赖 agent-model（`subagent-loop.ts` import `./provider-stream-contract`）。§9.2 依赖表已补充 `agent-subagent → agent-model` 边。

**`mcp-lifecycle/mcp-lifecycle-manager.ts`（前 20 行）import：**

- `../types`（AgentTool, ToolSource）→ 拆分后入 shared-types
- `@crish/shared-utils`（RingBuffer）→ shared-utils
- `./types`（本地 Mcp* 类型）→ agent-mcp（包内）

**验证结论：** agent-mcp 仅依赖 shared-types + shared-utils，不依赖 agent-tools / agent-model。`01-OVERVIEW.md` §3.1 的修正（"agent-mcp 仅依赖 shared-types + shared-utils"）成立。

**`mcp-lifecycle/mcp-server-controller.ts`（前 20 行）import：**

- `@crish/shared-types`（JsonObject, ToolExecutionContext, ToolOutput）→ shared-types
- `../types`（AgentTool）→ 拆分后入 shared-types
- `@crish/shared-utils`（errorMessage, RingBuffer）→ shared-utils
- `./types`（本地）→ agent-mcp（包内）

**验证结论：** 同上，agent-mcp 仅依赖 shared-types + shared-utils。

**`tools/tool-definition.ts`（前 20 行）import：**

- `@crish/shared-types`（ToolDefinition, JsonObject, ToolCategory, ToolConcurrency, ToolExecutionContext, ToolOutput）→ shared-types

**验证结论：** agent-tools 依赖 shared-types（leaf），无反向依赖。

**`plugin-registry.ts`（前 20 行）import：**

- `./tool-discovery` → agent-tools
- `@crish/shared-types` → shared-types
- `./types`（AgentTool, ToolSource）→ 拆分后入 shared-types

**验证结论：** plugin-sdk（registry）依赖 agent-tools + shared-types。

### 9.2 权威包间依赖关系（import 验证后）

> 箭头 `A --> B` 表示 **A 依赖 B**（A 的 package.json 中声明 B）。
> 【解耦调整】本表已根据 §2.1/§2.6/§2.14/§2.16/§2.22/§2.29/§2.39 的归属调整与接口下沉方案同步修正：error-classifier 下沉 shared-utils、tool-output-budget 迁入 agent-context、IContextManager/MediaTokenEstimator/ProcessGuardOptions/ProcessShell 接口下沉 shared-types。修正后消除原 13 条反向依赖与 3 组循环依赖。

| 包                 | 依赖（→ 指向被依赖方）                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared-types       | （无内部依赖，Layer 0 基础）                                                                                                                                                                                                                             |
| shared-utils       | shared-types（含迁入的 error-classifier.ts）                                                                                                                                                                                                             |
| decision-engine    | shared-types                                                                                                                                                                                                                                             |
| @crish/logger      | shared-types, shared-utils（Layer 1 leaf）                                                                                                                                                                                                               |
| @crish/telemetry   | shared-types, shared-utils（Layer 1 leaf）                                                                                                                                                                                                               |
| agent-context      | shared-types, shared-utils, @crish/logger, @crish/telemetry（Layer 2 leaf；**不再反向依赖 agent-tools**——tool-output-budget 已迁入本包；**不再反向依赖 agent-model**——token-estimator 通过 shared-types 的 MediaTokenEstimator 接口解耦）                |
| agent-permissions  | shared-types, decision-engine（Layer 2 leaf）                                                                                                                                                                                                            |
| agent-mcp          | shared-types, shared-utils（Layer 2 leaf，**不依赖** agent-tools/agent-model）                                                                                                                                                                           |
| agent-tools        | shared-types, agent-context, agent-mcp, @crish/logger（Layer 3 middle；**不再反向依赖 agent-core**——tool-middleware.ts 改 import shared-types 的 IContextManager 接口；local-tools/types.ts 改 import shared-types 的 ProcessGuardOptions/ProcessShell） |
| agent-model        | shared-types, agent-context, @crish/logger, @crish/telemetry（Layer 3 middle；**不再反向依赖 agent-core**——error-classifier 已下沉 shared-utils，5 个 provider 文件改 import shared-utils）                                                              |
| agent-core         | shared-types, shared-utils, agent-context, agent-tools, agent-model, agent-permissions, agent-mcp, @crish/logger, @crish/telemetry（Layer 4 top；新增 shared-utils 依赖以使用 error-classifier）                                                         |
| agent-subagent     | agent-core, agent-model, agent-tools, agent-mcp, agent-context, shared-types, shared-utils（Layer 5；**补充 agent-model 依赖**——subagent-loop.ts import ./provider-stream-contract）                                                                     |
| agent-orchestrator | agent-core, agent-tools, shared-types（Layer 6）                                                                                                                                                                                                         |
| agent-daemon       | agent-orchestrator, agent-model, agent-permissions, @crish/logger（Layer 7）                                                                                                                                                                             |
| plugin-sdk         | agent-core, shared-types（Layer 8）                                                                                                                                                                                                                      |
| crish-desktop      | agent-daemon, shared-types（Layer 9）                                                                                                                                                                                                                    |

### 9.3 对 `01-OVERVIEW.md` §3 mermaid 的修正说明

`01-OVERVIEW.md` §3 的 mermaid 图中，agent-subagent 相关边标注为：

```
AC --> AS
AT --> AS
AM2 --> AS
```

按该文档自定义的箭头约定（`A --> B` = A 依赖 B），这表示 "agent-core 依赖 agent-subagent"，与同文档 §3.1 修正表（"v2 修正: AS 依赖 AC"）及实际 import 验证矛盾。

**权威方向（以 import 验证为准）：**

```
AS --> AC   （agent-subagent 依赖 agent-core）
AS --> AM   （agent-subagent 依赖 agent-model；subagent-loop.ts import ./provider-stream-contract，§9.2 已补充）
AS --> AT   （agent-subagent 依赖 agent-tools）
AS --> AM2  （agent-subagent 依赖 agent-mcp）
```

后续 Round 文档引用 agent-subagent 依赖关系时，以本节为准。建议 `01-OVERVIEW.md` §3 mermaid 同步修正此边方向，并补充 `AS --> AM` 边（此前遗漏）。

### 9.4 拓扑层一致性验证

依据 §9.2 依赖关系，拓扑层（自底向上）为：

```
Layer 0: shared-types, shared-utils, decision-engine
Layer 1: @crish/logger, @crish/telemetry
Layer 2: agent-context, agent-permissions, agent-mcp
Layer 3: agent-tools, agent-model
Layer 4: agent-core
Layer 5: agent-subagent
Layer 6: agent-orchestrator
Layer 7: agent-daemon
Layer 8: plugin-sdk
Layer 9: Rust crates
Layer 10: crish-desktop
```

所有依赖边均从高层指向低层，无反向边，无循环。与 `01-OVERVIEW.md` §3.2 拓扑层级一致。

**【解耦调整】循环依赖消除验证：**

| 原循环                                                                     | 根因                                                                                             | 修复后                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| agent-core ↔ agent-model（通过 error-classifier.ts）                       | agent-model 5 个文件反向 import agent-core 的 error-classifier.ts                                | error-classifier.ts 下沉 shared-utils（Layer 0），agent-model 改 import shared-utils，agent-core 也正向依赖 shared-utils                                           |
| agent-tools ↔ agent-core（通过 tool-middleware.ts ↔ tool-executor.ts）     | tool-middleware.ts import agent-core 的 ContextManager 类型；tool-executor.ts import agent-tools | ContextManager 纯类型接口 IContextManager 下沉 shared-types，tool-middleware.ts 改 import 接口；agent-tools 不再依赖 agent-core，agent-core 仍正向依赖 agent-tools |
| agent-tools ↔ agent-core（通过 local-tools/types.ts ↔ process-lifecycle/） | local-tools/types.ts import agent-core 的 ProcessGuardOptions/ProcessShell                       | ProcessGuardOptions/ProcessShell 下沉 shared-types，local-tools/types.ts 改 import 接口                                                                            |
| agent-context ↔ agent-tools（通过 tool-output-budget.ts）                  | agent-context 4 个文件反向 import agent-tools 的 tool-output-budget.ts                           | tool-output-budget.ts 迁入 agent-context，agent-context 不再反向依赖 agent-tools；agent-tools/agent-core 可正向引用 agent-context                                  |
| agent-context ↔ agent-model（通过 token-estimator.ts ↔ media/）            | token-estimator.ts import agent-model 的 MediaPreprocessor/ImageContent                          | MediaTokenEstimator 接口 + ImageContent 类型下沉 shared-types，token-estimator.ts import 接口；由 media-preprocessor.ts 实现                                       |

修正后共消除 13 条反向依赖（agent-model→agent-core 5 条、agent-context→agent-tools 4 条、agent-tools→agent-core 2 条、agent-context→agent-model 1 条、agent-tools→agent-core 1 条）与 3 组循环依赖（agent-core↔agent-model、agent-tools↔agent-core、agent-context↔agent-tools/agent-model）。

---

## 10. 映射统计

### 10.1 agent-runtime/src 各目标包文件统计

| 目标包                   | 文件数（约） | 主要内容                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-core               | ~93          | runtime/SessionLoop/StateMachine/ControlBus/Steering/Recovery/Hooks/EventProtocol/EventQueue/RuntimeComponents/RuntimeMetrics/Config/Rendering/ProcessLifecycle/stream(thinking)/plan-document/testing/tool-stream（error-classifier.ts 已下沉 shared-utils，见 §2.1/§6.2） |
| agent-model              | ~95          | provider/(全部)/provider-gateway/provider-transport/provider-stream-contract/stream(非 thinking)/_-stream-parse/_-request-build/model-routing/model-catalog/pricing-engine/token-ledger/media/preview-queue/openai-retry                                                    |
| agent-context            | ~47          | context-compression/checkpoint/session/session-store/canonical-event/blob-externalization/prompt-assembly/canonical-schema/wasm-tiktoken/structured-summary/trajectory-compressor/memory/scoped-context/tool-output-budget（迁入）等                                        |
| agent-tools              | ~38          | tools/local-tools/tool-discovery/tool-registry/background-command/lsp-tools/rich-read/resource-uri/workspace-mutation-coordinator/script-wait-policy/skills/git-versioning/tool-output-guard（tool-output-budget 已迁出至 agent-context）                                   |
| agent-permissions        | ~6           | approval/ + permission/trust-zone-policy + secrets-obfuscation + permissions.test                                                                                                                                                                                           |
| agent-mcp                | ~7           | mcp-lifecycle/ + mcp-lifecycle.ts                                                                                                                                                                                                                                           |
| agent-subagent           | ~6           | subagents/subagent-loop/subagent-skill-runner/subagent-types/subagent-context-pack                                                                                                                                                                                          |
| @crish/telemetry         | ~2           | trace/                                                                                                                                                                                                                                                                      |
| plugin-sdk/src/registry  | ~3           | plugin-registry/plugin-fs-registry                                                                                                                                                                                                                                          |
| shared-utils（迁入）     | ~4           | path-handling/ + error-classifier.ts + error-classifier.test.ts（解耦迁入）                                                                                                                                                                                                 |
| shared-types（迁入类型） | —            | types.ts 拆分 + hooks 纯类型（R8）+ IContextManager/MediaTokenEstimator/ImageContent/ProcessGuardOptions/ProcessShell（解耦下沉）                                                                                                                                           |
| `[拆分]` types.ts        | —            | 见 §2.2                                                                                                                                                                                                                                                                     |

> 文件数为约值（含 .test.ts / .adversarial.test.ts / .bench.ts）。精确计数以 §2 各表为准。

### 10.2 与 禁令 10 判定的对齐

| 目标包            | 禁令 10 文件数        | 本表文件数                                      | 判定 |
| ----------------- | --------------------- | ----------------------------------------------- | ---- |
| agent-core        | ~55（核心，不含测试） | ~95（含测试）                                   | 一致 |
| agent-tools       | ~28                   | ~40（含测试）                                   | 一致 |
| agent-model       | ~57                   | ~95（含测试 + provider 子目录全展开）           | 一致 |
| agent-context     | ~28                   | ~45（含测试）                                   | 一致 |
| agent-mcp         | ~6                    | ~7                                              | 一致 |
| agent-permissions | ~7                    | ~6（command-classification 留 decision-engine） | 一致 |
| agent-subagent    | ~10                   | ~6（现有，R9 扩展至 ~10）                       | 一致 |
| @crish/logger     | ~8                    | 2（提取源）+ R2 新增                            | 一致 |
| @crish/telemetry  | ~10                   | 2（提取源）+ R2 新增                            | 一致 |

---

## 11. 后续 Round 引用约定

1. 所有 Round 设计文档（`ROUND-03` ~ `ROUND-09`）引用文件→包映射时，必须写"见 `02-FILE-MAPPING.md` §2.x"，不得在本轮文档内重新定义映射。
2. 引用依赖关系时必须写"见 `02-FILE-MAPPING.md` §9"，不得在 mermaid 图中重新声明边方向。
3. 引用冲突决策时必须写"见 `02-FILE-MAPPING.md` §3"。
4. 若执行中发现实际归属与本表不符，必须先更新本表（§2/§3/§4），再在 Round 文档中引用更新后的版本，禁止"文档说 X 实际做 Y"的漂移（禁令 31）。
5. `types.ts` 的拆分在 R3-R5 各轮按需执行，拆分后本表 §2.2 同步更新实际迁入清单。
