# 测试基础设施改进方案

## 一、设计原则

### 原则 1：测试工具与业务代码同源共生

测试基础设施（FauxProvider、MockGateway、TestFixture）作为一等公民代码，存放于 `packages/` 下的 `test-utils` 目录或专用包中，与业务代码使用同一构建和类型系统。测试工具不引入额外的运行时依赖，但可以使用 `vitest`、`vi` 等测试框架的类型和工具。

### 原则 2：假 Provider 优先于 mock HTTP 服务

所有 Provider 层面的测试应优先使用实现 `AgentProvider` 接口的假 Provider，而非启动真实 HTTP 服务器的 mock server。假 Provider 确定性高、速度快、无网络依赖。`LlmApiMockServer` 仅在需要测试 HTTP 协议层行为（如流中断恢复、SSE 帧边界）时使用。

### 原则 3：测试隔离是硬门槛

每个测试套件启动前必须清理环境变量、临时文件和全局单例状态。使用 `beforeAll`/`afterAll` 和 `beforeEach`/`afterEach` 构成四层隔离边界。不允许测试之间共享可变全局状态。

### 原则 4：接口契约测试替代实现细节测试

测试应围绕公开接口（`ProviderGateway.planRoute()`、`ToolExecutor.executeBatchWithEvents()`、`ProviderCallGateway.call()`）编写，而非内部实现细节（私有方法、模块级变量）。契约测试确保接口行为稳定，使重构成为可能。

### 原则 5：测试数据由 fixture 驱动

Provider 响应数据、工具输入输出、路由配置等测试数据抽取为独立的 JSON/YAML fixture 文件，存放在 `tests/fixtures/` 目录下。测试代码只描述"从哪个 fixture 加载"和"断言什么"，不手写 JSON 字符串。

### 原则 6：覆盖率门禁自动化

在 vitest 配置中设置覆盖率阈值，并在 CI 中强制执行。覆盖率不达标的提交不允许合入。阈值的设定基于现状逐步提升——先设置到当前水平（约 60-70%），每季度提升 5-10%。

### 原则 7：可观测性从测试工具设计开始

每个测试工具（FauxProvider、MockProviderCallGateway）内置事件钩子和状态检查点，使断言不仅停留在"返回值正确"，还能验证"调用了哪些方法"、"事件顺序是否符合契约"。

---

## 二、测试基础设施架构设计

### 2.1 假 Provider 层级设计

我们的 Provider 体系分为三层，假 Provider 的设计必须对应这三层：

```
真实 Provider 体系：
┌─────────────────────────────────────────────────────┐
│ Layer 3: AgentSessionLoop / ProviderCallGateway       │
│   依赖 ProviderCallGateway.call(provider, request)    │
├─────────────────────────────────────────────────────┤
│ Layer 2: ProviderCallGateway                          │
│   依赖 AgentProvider.stream(request)                  │
├─────────────────────────────────────────────────────┤
│ Layer 1: AgentProvider 接口                           │
│   stream(request) → AsyncIterable<ProviderStreamEvent>│
└─────────────────────────────────────────────────────┘
```

假 Provider 层级对应（从下到上构建）：

```
Faux Provider 体系（测试工具）：
┌──────────────────────────────────────────────────────────┐
│ FauxProviderCallGateway                                    │
│   - 实现 ProviderCallGateway 接口                          │
│   - 可注入事件序列（决定 call() 的行为）                   │
│   - 内置调用记录（capturedRequests, eventsEmitted）        │
│   - 支持错误注入（超时、网络错误、协议错误）               │
├──────────────────────────────────────────────────────────┤
│ FauxAgentProvider                                          │
│   - 实现 AgentProvider 接口                                │
│   - 构造时传入事件序列（决定 stream() 的行为）             │
│   - 支持配置 latency、error scenarios                      │
│   - 提供 Usage 信息注入                                   │
├──────────────────────────────────────────────────────────┤
│ ProviderEventSequence (PES) DSL                            │
│   - 声明式描述一次 Provider 调用的完整响应                │
│   - 支持 text/tool-call/reasoning/diagnostic/error/stop    │
│   - 可配置 SSE chunk 发送时序                             │
└──────────────────────────────────────────────────────────┘
```

核心接口设计（TypeScript）：

```typescript
// FauxAgentProvider — 直接替换 AgentProvider
class FauxAgentProvider implements AgentProvider {
  readonly id: string;
  private sequence: ProviderEventSequence;
  callCount: number;
  capturedRequests: AgentProviderRequest[];

  constructor(id: string, sequence?: ProviderEventSequence);
  setSequence(sequence: ProviderEventSequence): void;
  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

// ProviderEventSequence — 声明式事件序列
class ProviderEventSequence {
  static text(content: string, options?: { prefix?: string; delayMs?: number }): ProviderEventSequence;
  static toolCall(name: string, input: JsonObject, id?: string): ProviderEventSequence;
  static error(message: string, retryable?: boolean): ProviderEventSequence;
  static stop(reason?: string, usage?: ProviderUsage): ProviderEventSequence;
  static thinking(text: string): ProviderEventSequence;
  static diagnostic(code: string, message: string): ProviderEventSequence;
  static sseChunks(chunks: string[]): ProviderEventSequence;
  concat(...sequences: ProviderEventSequence[]): ProviderEventSequence;
  thenWait(ms: number): ProviderEventSequence;
}

// FauxProviderCallGateway — 替换 ProviderCallGateway
class FauxProviderCallGateway extends ProviderCallGateway {
  capturedRequests: AgentProviderRequest[];
  capturedProviders: { id: string }[];
  defaultSequence: ProviderEventSequence;
  providerSequences: Map<string, ProviderEventSequence>;

  setDefaultSequence(seq: ProviderEventSequence): void;
  setProviderSequence(providerId: string, seq: ProviderEventSequence): void;
  async *call(provider, request): AsyncGenerator<...>;
}
```

这个设计直接映射到 `C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts:217-221` 的 `ProviderGateway` 接口和 `C:\Software\conex\packages\agent-runtime\src\runtime-components\provider-call-gateway.ts` 的 `ProviderCallGateway` 类。

### 2.2 测试隔离策略

采用两层隔离架构：

**外层隔离（全局级别）**：`vitest.globalSetup.ts`
```
- 备份所有 CONEX_API_KEY_* / ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量
- unset 这些环境变量
- 设置测试专用的环境变量（CONEX_TEST=1, NODE_ENV=test）
- 创建临时目录 TMP_ROOT
- 注册全局 afterAll 钩子恢复环境变量
```

**内层隔离（文件级别）**：`vitest.setup.ts` 增强
```
- beforeEach: 重置 vi.useFakeTimers() 和 vi.useRealTimers()
- beforeEach: 重置所有全局单例（_gatewayBridge 等）
- beforeEach: 创建测试级临时目录（测试专用 UUID 命名）
- afterEach: 清理测试级临时目录
- afterEach: 恢复 vi.useRealTimers()
- afterEach: 验证没有 pending 的 setTimeout/setInterval
```

**Rust 测试隔离**：
```
- 所有文件操作测试使用 tempfile crate（替代手工 temp_dir）
- 全局资源（RegexSet, OnceLock）测试只验证指针相等性，不修改
- 使用 serial_test crate 标记需要串行执行的测试
```

### 2.3 测试数据管理

```
tests/fixtures/
├── providers/
│   ├── anthropic-messages-text.json    # Anthropic text completion
│   ├── anthropic-messages-tool-call.json
│   ├── openai-chat-completions.json
│   ├── openai-stream-error.json
│   ├── gemini-text.json
│   └── ollama-chat.json
├── tools/
│   ├── shell-command-outputs.json
│   ├── file-read-outputs.json
│   └── tool-validation-schemas.json
├── routes/
│   ├── simple-routing.json
│   ├── fallback-chain.json
│   └── cooldown-scenarios.json
└── sessions/
    ├── basic-turn.json
    ├── multi-turn.json
    └── tool-call-loop.json
```

每个 fixture 文件是类型安全的 JSON。通过 `FixtureLoader` 加载：

```typescript
class FixtureLoader {
  static load<T>(path: string): T;
  static loadProviderScenario(name: string): ProviderEventSequence;
  static loadRouteConfig(name: string): ProviderRouteOffer[];
  static loadToolFixture(name: string): ToolCallBlock[];
}
```

---

## 三、详细任务分解

### 任务 T-001：创建 FauxAgentProvider 基类

- **目标文件**：`packages/agent-runtime/src/__tests__/faux-provider.ts`（新建）
- **问题**：没有共享的假 Provider 实现，每个测试文件自建 mock
- **策略**：
  1. 在 `packages/agent-runtime/src/__tests__/` 下创建 `faux-provider.ts`
  2. 实现 `FauxAgentProvider` 类，实现 `AgentProvider` 接口
  3. 实现 `ProviderEventSequence` DSL
  4. 支持标准事件类型：text delta、tool call begin/delta/end、reasoning、error、stop
  5. 内置调用计数和请求捕获
  6. 支持可配置的流式延迟
- **依赖**：`packages/agent-runtime/src/types.ts` 中的 `AgentProvider` 和 `ProviderStreamEvent` 类型
- **集成点**：替代 `provider-gateway.test.ts:14-24` 的 `PlannedProvider` 内联类

### 任务 T-002：创建 FauxProviderCallGateway

- **目标文件**：`packages/agent-runtime/src/__tests__/faux-provider-call-gateway.ts`（新建）
- **问题**：`agent-session-loop.test.ts:36-86` 需要 314 行匿名类来 mock ProviderCallGateway
- **策略**：
  1. 继承 `ProviderCallGateway` 并覆盖 `call` 方法
  2. 使用 `FauxAgentProvider` 作为底层的流生成器
  3. 支持默认事件序列和按 provider 覆盖
  4. 内置 `capturedRequests` 和 `capturedProviders` 记录
  5. 支持单个调用错误注入（超时、网络错误、协议错误）
- **依赖**：任务 T-001
- **集成点**：替代 `agent-session-loop.test.ts:36-58`；与 `C:\Software\conex\packages\agent-runtime\src\runtime-components\provider-call-gateway.ts` 一起使用

### 任务 T-003：创建共享的 MockAgentTool 工厂

- **目标文件**：`packages/shared-utils/src/test/mockTools.ts`（新建，扩展 `mockFactories.ts`）
- **问题**：`tool-executor.test.ts:6-41` 的 `shellTool()` 和 `exclusiveTool()` 只在该文件可用
- **策略**：
  1. 创建 `createMockTool()` 工厂函数，支持 `concurrency`、`inputSchema`、`isReadOnly`、`execute` 等配置
  2. 创建 `createToolCall()` 工厂函数
  3. 创建 `createMockToolContext()` 工厂函数
  4. 导出类型和 const 版本的常用工具（`SHELL_TOOL`、`READ_TOOL`、`WRITE_TOOL`）
  5. 支持 `vi.fn()` 的 spied execute（默认 spy）
- **依赖**：无
- **集成点**：替代 `tool-executor.test.ts:6-41` 和 `agent-session-loop.test.ts:8-24`

### 任务 T-004：创建测试隔离基础设施（外层）

- **目标文件**：
  - `vitest.globalSetup.ts`（新建）
  - `scripts/test.sh`（新建）
- **问题**：
  - `C:\Software\conex\.husky\pre-push:1` 直接运行 `npm test` 不清理环境
  - `C:\Software\conex\vitest.setup.ts` 无环境变量清理
  - `C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts:972-974` 的 `_gatewayBridge` 全局单例无 reset
- **策略**：
  1. 创建 `vitest.globalSetup.ts`：
     - 备份所有 provider API key 环境变量到 `process.env.__CONEX_TEST_BACKUP__`
     - unset `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CONEX_API_KEY_*` 等
     - 设置 `CONEX_TEST=1`
     - 创建 `TEST_TMP_ROOT` 临时目录
  2. 创建 `vitest.globalTeardown.ts`：
     - 恢复所有备份的环境变量
     - 清理 `TEST_TMP_ROOT`
  3. 创建 `scripts/test.sh`：
     - 备份重要环境变量
     - 显式 unset 所有 API key 环境变量
     - 运行 `vitest run`
     - 恢复环境变量
- **依赖**：无，但需要更新 `vitest.config.ts` 和 `package.json`
- **集成点**：修改 `vitest.config.ts` 增加 `globalSetup` 和 `globalTeardown`

### 任务 T-005：增强 vitest.setup.ts（内层隔离）

- **目标文件**：`vitest.setup.ts`（修改）
- **问题**：当前 setup 只有 `localStorage` mock，无时间控制和单例清理
- **策略**：
  1. 在 `beforeEach` 中：调用一个 `resetGlobalSingletons()` 函数
  2. 在 `beforeEach` 中：默认 `vi.useFakeTimers()`（测试明确需要真实时间时用 `vi.useRealTimers()`）
  3. 在 `afterEach` 中：清理所有 fake timers
  4. 在 `afterEach` 中：检查没有 pending timeout（`vi.getTimerCount()`）
  5. 注册 `onUnhandledRejection` 处理
- **依赖**：
  - 需要 `packages/agent-runtime/src/provider-gateway.ts` 增加 `resetProviderEngine()` 函数
  - 需要 `packages/agent-runtime/src/provider-gateway.ts:972-974` 暴露 `_gatewayBridge` 的 reset 能力
- **集成点**：修改 `vitest.config.ts:5` 保持 `setupFiles` 指向增强版

### 任务 T-006：创建 FixtureLoader

- **目标文件**：
  - `packages/shared-utils/src/test/fixtureLoader.ts`（新建）
  - `tests/fixtures/`（创建目录结构和前 5 个 fixture 文件）
- **问题**：
  - `C:\Software\conex\packages\agent-runtime\src\provider-anthropic.test.ts:52-80` 手写 message body
  - `C:\Software\conex\packages\agent-runtime\src\provider-gateway.test.ts:131-166` 手写 route 对象
- **策略**：
  1. 创建 `FixtureLoader` 类：
     - `FixtureLoader.loadProviderScenario(name)` 返回 `ProviderEventSequence`
     - `FixtureLoader.loadRouteConfig(name)` 返回 `ProviderRouteOffer[]`
     - `FixtureLoader.loadToolFixture(name)` 返回 `ToolCallBlock[]`
     - 使用 `import` 加载 JSON 文件（vitest 支持）
  2. 创建前 5 个 fixture JSON 文件：
     - `tests/fixtures/providers/anthropic-messages-text.json`
     - `tests/fixtures/providers/openai-chat-text.json`
     - `tests/fixtures/routes/priority-health-routing.json`
     - `tests/fixtures/routes/fallback-chain.json`
     - `tests/fixtures/sessions/basic-turn.json`
  3. 确保 fixture 类型安全（使用 `satisfies` 或 `as const`）
- **依赖**：任务 T-001（ProviderEventSequence 类型）
- **集成点**：替代所有测试文件中的内联 JSON 数据

### 任务 T-007：完善 ProviderGateway 测试套件

- **目标文件**：`packages/agent-runtime/src/provider-gateway.test.ts`（修改）
- **问题**：现有测试（625 行）覆盖了基本功能但缺少：
  - `FauxAgentProvider` 通过 `providerFactory` 的完整流式调用验证
  - `resolveProvider` 的 `materializeProvider: true` 路径
  - `GatewayV2Bridge` 集成测试
  - 凭证解析回退链测试（CredentialResolver → SecretStore → env var）
  - `recordRouteResult` 的边缘情况（`cooldownUntil` 显式覆盖、`metadata` 合并）
  - 能力路由（`modelRouteDecision`）的空数组情况
- **策略**：
  1. 使用 `FauxAgentProvider` 替代 `PlannedProvider`
  2. 新增 `describe("ProviderGateway with FauxAgentProvider")` 测试组
  3. 新增 `describe("GatewayV2Bridge integration")` 测试组
  4. 新增路由 cooldown 和 health 的边界测试
- **依赖**：任务 T-001、T-002、T-006
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts:248-538` 的 `DefaultProviderGateway` 类

### 任务 T-008：增强 ToolExecutor 测试套件

- **目标文件**：`packages/agent-runtime/src/runtime-components/tool-executor.test.ts`（修改）
- **问题**：
  - 缺少 `ToolExecuteHook` 的自定义钩子测试
  - 缺少 `executeSequentialWithEvents` 的串行执行顺序测试
  - 缺少 `executeSequential` （串行污染检查 `shouldExecuteSequential`）的边缘情况
  - 缺少 `ToolBatchFailurePolicy = 'cancel-siblings'` 的完整验证
  - 缺少超时场景（`timeoutMs`）
  - 缺少大输出物化测试（`outputByteSize` > 阈值）
  - 缺少 `ProgressEventQueue` 的并发 push/next 竞争条件测试
- **策略**：
  1. 使用任务 T-003 的 `MockAgentTool` 工厂替代内联工具
  2. 新增超时相关测试
  3. 新增 `ToolExecuteHook` 注入测试
  4. 使用 `vi.advanceTimersByTime` 控制时间
- **依赖**：任务 T-003、T-005
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts:125-544` 的 `ToolExecutor` 类

### 任务 T-009：创建 AgentSessionLoop 集成测试

- **目标文件**：
  - `packages/agent-runtime/src/__tests__/integrations/session-loop.test.ts`（新建）
- **问题**：`agent-session-loop.ts`（2293 行）只有一个测试文件（`agent-session-loop.test.ts`，990 行），覆盖的路径有限
- **策略**：
  1. 使用 `FauxAgentProvider` + `FauxProviderCallGateway` 替代匿名 ProviderCallGateway
  2. 测试完整 Turn 循环：user message → provider call → tool call → tool result → provider call
  3. 测试 Steering 注入（`SteeringCoordinator` + `RecoverySteeringStrategy`）
  4. 测试 MaxTurns 终止
  5. 测试 Session cancel/abort 路径
  6. 测试 `PermissionPolicy` 的 `decide` → `deny` → tool output override
- **依赖**：任务 T-001、T-002、T-003、T-006
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\agent-session-loop.ts:1-2293`

### 任务 T-010：创建 ProviderCallGateway 集成测试

- **目标文件**：`packages/agent-runtime/src/runtime-components/provider-call-gateway.test.ts`（修改/扩展）
- **问题**：`ProviderCallGateway`（`C:\Software\conex\packages\agent-runtime\src\runtime-components\provider-call-gateway.ts:321` 行）与 `ProviderResponseConsumer`、`StreamRecovery`、`CircuitBreaker` 等组件的联合行为无测试
- **策略**：
  1. 使用 `FauxAgentProvider` 构造各种流式场景
  2. 测试 `StreamRecovery` 连接恢复
  3. 测试 `CircuitBreaker` 熔断和半开
  4. 测试 `retryWithBackoff` 的回退策略
  5. 测试 `TokenTracker` 的 token 计数集成
- **依赖**：任务 T-001、T-002
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\runtime-components\provider-call-gateway.ts`

### 任务 T-011：创建 ToolExecutor 与 ProviderCallGateway 端到端管线测试

- **目标文件**：`packages/agent-runtime/src/__tests__/integrations/provider-tool-pipeline.test.ts`（新建）
- **问题**：ToolExecutor 和 ProviderCallGateway 之间的协作无联合测试
- **策略**：
  1. 构造一个完整场景：Provider 返回 tool_call → ToolExecutor 执行工具 → 结果送 Provider
  2. 使用 `FauxAgentProvider` + `FauxProviderCallGateway` + `MockAgentTool`
  3. 验证事件序列的正确性（tool-start → tool-end → batch-end）
  4. 验证错误传播
- **依赖**：任务 T-001、T-002、T-003
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts` 和 `C:\Software\conex\packages\agent-runtime\src\runtime-components\provider-call-gateway.ts`

### 任务 T-012：创建测试专用 test-utils 包或共享模块

- **目标文件**：
  - `packages/test-utils/package.json`（新建）
  - `packages/test-utils/src/index.ts`（新建）
  - `packages/test-utils/src/faux-provider.ts`（从 T-001 移动）
  - `packages/test-utils/src/faux-provider-call-gateway.ts`（从 T-002 移动）
  - `packages/test-utils/src/mock-tools.ts`（从 T-003 移动）
  - `packages/test-utils/src/fixture-loader.ts`（从 T-006 移动）
- **问题**：测试工具分散在 `packages/shared-utils/src/test/` 和各个包的 `__tests__/` 下，无统一入口
- **策略**：
  1. 创建 `packages/test-utils/` 包，所有测试工具汇总到此
  2. 每个包在自己的 `devDependencies` 中引入 `@crish/test-utils`
  3. 确保所有测试工具不依赖 vitest runtime API（只依赖 `vi` 类型）
  4. 导出所有工厂函数、mock 类、fixture loader
- **依赖**：任务 T-001、T-002、T-003、T-006
- **集成点**：更新每个包的 `package.json` 添加 `@crish/test-utils` 依赖

### 任务 T-013：配置覆盖率门禁

- **目标文件**：`vitest.config.ts`（修改）、`package.json`（修改）
- **问题**：`C:\Software\conex\vitest.config.ts:13-16` 无 `thresholds` 配置
- **策略**：
  1. 在 `vitest.config.ts` 的 `coverage` 配置中增加 `thresholds`：
     ```typescript
     coverage: {
       provider: 'v8',
       reporter: ['text', 'json', 'html'],
       thresholds: {
         statements: 60,
         branches: 50,
         functions: 55,
         lines: 60,
       },
     }
     ```
  2. 在 `package.json` 的 `test:coverage` 脚本中增加 `--coverage.thresholds.autoUpdate` 或手动维护
  3. 在 `.husky/pre-push` 中增加 `npm run test:coverage` 或 CI 级别的 coverage check
  4. 创建 `scripts/coverage-report.sh` 合并 TypeScript 和 Rust 的覆盖率报告
- **依赖**：无
- **集成点**：修改 `vitest.config.ts` 和 `.husky/pre-push`

### 任务 T-014：增强 Rust crate 测试

- **目标文件**：
  - `crates/conex-fs/src/reader.rs`（新增 `#[cfg(test)]`）
  - `crates/conex-net/src/http_client.rs`（新增 `#[cfg(test)]`）
  - `crates/conex-net/src/ws_client.rs`（新增 `#[cfg(test)]`）
  - `crates/conex-compaction/src/prefix_guard.rs`（新增 `#[cfg(test)]`）
  - `crates/conex-compaction/src/ast_compactor.rs`（新增 `#[cfg(test)]`）
  - `crates/conex-db/src/query.rs`（新增 `#[cfg(test)]`）
- **问题**：多个核心 crate 缺少单元测试或测试覆盖不足
- **策略**：
  1. 为 `conex-fs/src/reader.rs` 添加文件读取边界测试（空文件、大文件、UTF-8 BOM）
  2. 为 `conex-net/src/http_client.rs` 添加 HTTP 请求构造和响应解析测试（使用 mock 或本地 server）
  3. 为 `conex-net/src/ws_client.rs` 添加 WebSocket 消息编码/解码测试
  4. 为 `conex-compaction/src/prefix_guard.rs` 和 `ast_compactor.rs` 添加 AST 压缩测试
  5. 为 `conex-db/src/query.rs` 添加 SQL 查询构造测试
  6. 在 `Cargo.toml` 中添加 `tempfile` 和 `mockito`（或类似）作为 `dev-dependencies`
- **依赖**：无
- **集成点**：相关 crate 的源文件

### 任务 T-015：统一各包的测试分组策略

- **目标文件**：`vitest.config.ts`（修改）、`package.json`（修改）
- **问题**：`package.json:57-60` 中 `test:core` 手动指定目录，没有标签或分组机制
- **策略**：
  1. 在 vitest 配置中使用 `testNamePattern` 或自定义标签系统
  2. 定义三个测试标签：`@unit`、`@integration`、`@e2e`
  3. 只给集成测试和 E2E 测试文件添加 `// @integration` 或 `// @e2e` 注释标记
  4. 使用 `testNamePattern` 在 CI 中选择运行哪些组
  5. 或者使用 vitest workspace 模式（`vitest.workspace.ts`）定义多个 project
- **依赖**：任务 T-005
- **集成点**：修改 `vitest.config.ts` 和 `package.json` scripts

### 任务 T-016：添加 Rust 和 TypeScript 的统一 CI 执行脚本

- **目标文件**：`scripts/ci-test.mjs`（新建）
- **问题**：当前 `npm test` 只跑 vitest，不跑 Rust 测试和 stress 套件
- **策略**：
  1. 创建 `scripts/ci-test.mjs`：
     - 步骤 1：环境隔离（调用 `scripts/test.sh` 的逻辑）
     - 步骤 2：运行 `cargo test --workspace`
     - 步骤 3：运行 `vitest run`（TypeScript）
     - 步骤 4：运行 `npm run bench:native-sla`（性能门禁基准）
     - 步骤 5：汇总结果并退出适当的 exit code
- **依赖**：任务 T-004、T-013
- **集成点**：更新 `.husky/pre-push` 调用 `scripts/ci-test.mjs`

### 任务 T-017：重构压力测试套件

- **目标文件**：
  - `tests/stress/stress-runner.ts`（修改）
  - `tests/stress/stress-ai-stream.ts`（修改）
- **问题**：`tests/stress/stress-ai-stream.ts:10` 使用 `Math.random()` 无种子控制，不可重现
- **策略**：
  1. 为 `StressScenario` 接口增加 `seed?: number` 字段
  2. 在 `stress-runner.ts` 中使用 `seedrandom`（或内建 seedable RNG）替代 `Math.random()`
  3. 在 `runStressTest` 中：如果 `seed` 未指定，生成一个随机 seed 并打印
  4. 每次运行输出 seed，允许复现失败场景
  5. 将 stress 结果格式化为 JUnit XML，与 CI 集成
- **依赖**：无
- **集成点**：修改 `tests/stress/` 下的所有场景文件

### 任务 T-018：创建 Rust crate 假 Provider（mock LLM endpoint）

- **目标文件**：
  - `crates/conex-net/src/test-utils.rs`（新建）
  - `crates/conex-net/Cargo.toml`（修改，添加 `dev-dependencies`）
- **问题**：Rust 侧 `conex-net/src/llm_provider.rs` 的 LLM 调用无法测试
- **策略**：
  1. 创建 `test-utils.rs`，提供 `MockLlmEndpoint`：
     - 启动本地 `TcpListener` 返回预配置的 SSE 响应
     - 支持 `MockLlmScenario` 定义
     - 自动清理生命周期
  2. 创建 `MockLlmScenario` builder：
     - `text_response(text)`、`tool_call_response(name, args)`、`error_response(status, body)`
     - `streaming_chunks(chunks)`、`delayed_stream(delay_ms, chunks)`
  3. 在 `llm_provider.rs` 中使用 `MockLlmEndpoint` 测试流式和非流式调用
- **依赖**：无
- **集成点**：`crates/conex-net/src/llm_provider.rs`

### 任务 T-019：添加 vitest 的 test retry 和 flaky test 检测

- **目标文件**：`vitest.config.ts`（修改）
- **问题**：无 flaky test 检测机制
- **策略**：
  1. 在 CI 中设置 `retry: 2`（失败后重试 2 次）
  2. 添加 `onConsoleWarn` 和 `onUnhandledRejection` 全局处理器
  3. 配置 `testTimeout: 10000` 覆盖默认值
  4. 启用 `passWithNoTests: false`（防止空测试文件无声通过）
- **依赖**：无
- **集成点**：修改 `vitest.config.ts`

### 任务 T-020：为 provider-gateway.ts 添加单例 reset 函数

- **目标文件**：`packages/agent-runtime/src/provider-gateway.ts`（修改）
- **问题**：`_gatewayBridge` 是模块级单例，测试无法重置
- **策略**：
  1. 导出一个 `resetProviderEngine()` 函数：
     ```typescript
     export function resetProviderEngine(): void {
       if (_gatewayBridge) {
         _gatewayBridge.dispose?.();
         _gatewayBridge = null;
       }
     }
     ```
  2. 确保 `GatewayV2Bridge` 类有 `dispose()` 方法
  3. 在 `vitest.setup.ts` 的 `beforeEach` 中调用 `resetProviderEngine()`
  4. 验证没有其他测试依赖 `_gatewayBridge` 的跨测试持久性
- **依赖**：任务 T-005
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts:972-1001`

### 任务 T-021：为所有 Provider 测试使用 FauxAgentProvider 替代 HTTP mock server

- **目标文件**：
  - `packages/agent-runtime/src/provider-anthropic.test.ts`（修改）
  - `packages/agent-runtime/src/provider-openai-compatible.test.ts`（修改）
- **问题**：Provider 测试直接构造 `Response` 对象（`provider-anthropic.test.ts:20-33` 的 `sseResponse`），与真实 HTTP 调用路径不一致
- **策略**：
  1. 将 `sseResponse()` 和 `fetch` mock 替换为 `FauxAgentProvider`
  2. 对于流式解析测试，保留 `LlmApiMockServer` 但仅用于需要真实 HTTP 帧的场景
  3. 对于纯业务逻辑测试（如 request build、response parse），使用 FauxAgentProvider
  4. 将 `provider-anthropic.test.ts` 分为两个文件：
     - `provider-anthropic-parse.test.ts`（流式解析测试，使用 mock server）
     - `provider-anthropic-logic.test.ts`（业务逻辑测试，使用 FauxAgentProvider）
- **依赖**：任务 T-001、T-006
- **集成点**：`C:\Software\conex\packages\agent-runtime\src\provider-anthropic.ts:1-432` 和 `C:\Software\conex\packages\agent-runtime\src\provider-openai-compatible.ts`

### 任务 T-022：添加 Rust 测试覆盖率门禁

- **目标文件**：`scripts/ci-test.mjs`（修改）、根 `Cargo.toml`（修改）
- **问题**：Rust 测试无覆盖率要求
- **策略**：
  1. 在 `scripts/ci-test.mjs` 中添加 Rust 覆盖率步骤：
     - 使用 `cargo tarpaulin` 或 `cargo-llvm-cov` 运行覆盖率
     - 解析输出并检查阈值
     - 失败时输出覆盖率报告
  2. 或在 `Cargo.toml` 中添加 workspace-level 的测试脚本
- **依赖**：任务 T-016
- **集成点**：CI pipeline

### 任务 T-023：创建缺失的关键模块测试

- **目标文件**（多个新建）：
  - `packages/shared-utils/src/cache.test.ts`
  - `packages/shared-utils/src/retry.test.ts`
  - `packages/shared-utils/src/wal.test.ts`
  - `packages/shared-utils/src/metrics-exporter.test.ts`
  - `packages/shared-utils/src/error.test.ts`
  - `packages/shared-utils/src/logger.test.ts`
  - `packages/agent-runtime/src/pricing-engine.test.ts`
- **问题**：这些关键模块完全没有测试
- **策略**：为每个模块编写最低限度的覆盖测试
- **依赖**：任务 T-003、T-006
- **集成点**：各对应源文件

---

## 四、各层任务逻辑依赖关系

```
Layer 0（基础设施层）               Layer 1（工具层）                Layer 2（测试完善层）
┌─────────────────┐              ┌──────────────────┐             ┌─────────────────────┐
│ T-004: 外层隔离   │──依赖──→    │ T-001: FauxProvider│──依赖──→   │ T-007: ProviderGW 完善│
│ (globalSetup)    │              │ (基类)           │             │ (测试套件扩展)       │
└─────────────────┘              └──────┬───────────┘             └─────────────────────┘
                                        │                         ┌─────────────────────┐
┌─────────────────┐              ┌──────┴───────────┐             │ T-008: ToolExecutor  │
│ T-005: 内层隔离   │──依赖──→    │ T-002: FauxCallGW │──依赖──→   │ (测试套件扩展)       │
│ (setup 增强)     │              │                  │             └─────────────────────┘
└─────────────────┘              └──────┬───────────┘             ┌─────────────────────┐
                                        │                         │ T-009: SessionLoop   │
┌─────────────────┐              ┌──────┴───────────┐             │ (集成测试)           │
│ T-020: 单例 reset │────────────→│ T-003: MockTools  │──依赖──→   └─────────────────────┘
│ (provider-gateway)│              │ (共享工厂)       │             ┌─────────────────────┐
└─────────────────┘              └──────┬───────────┘             │ T-010: CallGW 集成   │
                                        │                         │ (stream recovery 等) │
┌─────────────────┐              ┌──────┴───────────┐             └─────────────────────┘
│ T-013: 覆盖率门禁 │←──独立于──→  │ T-006: FixtureLoader│─依赖──→  ┌─────────────────────┐
│ (vitest config)  │  其他任务    │ (JSON fixture   )│            │ T-011: 管线 E2E     │
└─────────────────┘              └──────────────────┘             │ (Tool+Provider)      │
                                                                  └─────────────────────┘
┌─────────────────┐              ┌──────────────────┐             ┌─────────────────────┐
│ T-019: retry配置 │←──独立      │ T-012: test-utils │←──聚合────→│ T-021: Provider 重构  │
│ (vitest config)  │  其他任务    │ (专用包)          │            │ (用 Faux 替代 mock)  │
└─────────────────┘              └──────────────────┘             └─────────────────────┘

│ T-014: Rust 增强  │←──独立     │ T-016: CI 统一脚本│←──依赖──→  │ T-022: Rust 覆盖率   │
│ (各 crate 测试)   │  其他任务   │ (ci-test.mjs)    │            │ (cargo-tarpaulin)   │
                                                      │
┌─────────────────┐              ┌──────────────────┐             │
│ T-017: Stress 重构 │←──独立   │ T-015: 测试分组    │←──依赖──→  │
│ (seed + 可重现)   │  其他任务   │ (workspace/tag)  │            │
                                                      │
┌─────────────────┐              ┌──────────────────┐             │
│ T-023: 缺失模块   │←──依赖 T-003│ T-018: Rust Mock  │←──独立     │
│ (cache/retry等)  │  T-006     │ (LLM endpoint)   │  其他任务   │
└─────────────────┘              └──────────────────┘
```

---

## 五、与现有代码的集成点

### 5.1 接入 provider-gateway.ts

`C:\Software\conex\packages\agent-runtime\src\provider-gateway.ts` 是 Provider 路由和凭证解析的核心。改进方案的集成点：

1. **FauxAgentProvider 替代 PlannedProvider**（`provider-gateway.test.ts:14-24`）：
   ```typescript
   // 替换前
   class PlannedProvider implements AgentProvider { ... }

   // 替换后
   const fauxProvider = new FauxAgentProvider("test-provider",
     ProviderEventSequence.text("mock response")
   );
   ```

2. **静态路由 catalog 测试数据从 fixture 加载**（`provider-gateway.test.ts:131-166`）：
   ```typescript
   // 替换前
   const routes: ProviderRouteOffer[] = [/* 50 行手写对象 */];

   // 替换后
   const routes = FixtureLoader.loadRouteConfig("priority-health-routing");
   ```

3. **凭证解析器注入**（`provider-gateway.test.ts:28-41`）：
   保持现有的 `ProviderCredentialResolver` 匿名类模式，但将 resolver 函数提取到共享位置。

### 5.2 接入 tool-executor.ts

`C:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts` 是工具执行的核心。集成点：

1. **共享工具工厂替代内联定义**（`tool-executor.test.ts:6-41`）：
   ```typescript
   // 替换前
   function shellTool(name = "shell"): AgentTool { ... }

   // 替换后
   import { createMockTool } from '@crish/shared-utils/test/mockTools';
   const shellTool = createMockTool({ name: 'shell', concurrency: 'parallel' });
   ```

2. **ProgressEventQueue 的边界测试**：保持现有 `ProgressEventQueue` 测试（`tool-executor.test.ts:240-284`），但增加并发测试。

3. **ToolExecuteHook 测试**：通过 FauxAgentProvider 验证 hook 的完整调用链。

### 5.3 与 agent-session-loop.ts 配合

`C:\Software\conex\packages\agent-runtime\src\agent-session-loop.ts` 是 Agent 运行循环的核心。集成点：

1. **FauxProviderCallGateway 替代匿名类**（`agent-session-loop.test.ts:36-86`）：
   ```typescript
   // 替换前：314 行匿名类
   const mockGateway = new (class extends ProviderCallGateway { ... })();

   // 替换后：2 行
   const mockGateway = new FauxProviderCallGateway();
   mockGateway.setDefaultSequence(ProviderEventSequence.text("hello"));
   ```

2. **会话状态机测试**：现有测试（`agent-session-loop.test.ts:1-990`）覆盖了基本状态转换。新测试需要覆盖：
   - Steering 注入（`SteeringCoordinator` 和 `RecoverySteeringStrategy`）
   - 权限决策集成（`RuntimePermissionPolicy` + `PermissionDecider`）
   - Checkpoint 恢复（`checkpointRecordsFromToolResult`）
   - Tool 超时（`isToolTimeoutCause`）

3. **`noopProviderStream` 函数**（`agent-session-loop.test.ts:26-34`）被 FauxAgentProvider 替代。

---

## 五、与现有代码的集成点（续）

### 5.4 与 agent-session-loop.ts 配合的详细代码变化

当前 `agent-session-loop.test.ts:36-86` 使用匿名继承模式创建 mock ProviderCallGateway。替换为 FauxProviderCallGateway 后，测试代码将变为：

**替换前（agent-session-loop.test.ts:36-86）**：

```typescript
function createMockProviderGateway(
  streamFn: (request: AgentProviderRequest) => AsyncIterable<ProviderStreamContractEvent>,
  capturedRequests?: AgentProviderRequest[]
): ProviderCallGateway {
  return new (class extends ProviderCallGateway {
    async *call(
      provider: { id: string },
      request: AgentProviderRequest
    ): AsyncGenerator<ProviderStreamContractEvent, ...> {
      void provider;
      capturedRequests?.push(request);
      const events: ProviderStreamContractEvent[] = [];
      for await (const event of streamFn(request)) { ... }
      ...
    }
  })();
}
```

**替换后**：

```typescript
import { FauxProviderCallGateway } from '@crish/test-utils';

function createMockProviderGateway(
  streamEvents: ProviderStreamContractEvent[],
  capturedRequests?: AgentProviderRequest[]
): FauxProviderCallGateway {
  const gateway = new FauxProviderCallGateway();
  gateway.setDefaultSequence(ProviderEventSequence.fromContractEvents(streamEvents));
  if (capturedRequests) {
    const originalCall = gateway.call.bind(gateway);
    gateway.call = async function*(provider, request) {
      capturedRequests.push(request);
      yield* originalCall(provider, request);
    };
  }
  return gateway;
}
```

**代码量从 50+ 行减少到 10+ 行**，且不再依赖匿名继承。

### 5.5 与 runtime-components 各模块的集成矩阵

| 组件 | 当前测试文件 | 当前 mock 方式 | 替换方案 | 影响文件 |
|------|------------|---------------|---------|---------|
| `tool-executor.ts` | `tool-executor.test.ts` | 内联工具定义 | `createMockTool()` | 移除 4 个内联函数 |
| `tool-executor.ts` | `tool-executor-timeout.test.ts` | 内联工具定义 + vi.useFakeTimers | `createMockTool()` + 增强 setup | 减少重复代码 |
| `provider-call-gateway.ts` | `provider-call-gateway.test.ts` | vi.spyOn fetch + 部分 LlmApiMockServer | `FauxAgentProvider` + `FauxProviderCallGateway` | 替换所有 fetch mock |
| `conversation-engine.ts` | `conversation-engine.test.ts` | 内联 mock 消息 + 工具 | `createMockTool()` + `FixtureLoader` | 替代手写消息数据 |
| `context-manager.ts` | `context-manager.test.ts` | 内联 mock 事件 | `ProviderEventSequence` | 统一事件构造方式 |

### 5.6 与 package.json 脚本体系的集成

当前脚本体系：
```
"test": "vitest run",
"test:core": "vitest run packages/agent-runtime/src ...",
"test:coverage": "vitest run --coverage",
"test:integration": "vitest run --config vitest.integration.config.ts",
```

集成后脚本体系：
```
"test": "node scripts/test.mjs",                  # 统一入口 + 环境隔离
"test:unit": "vitest run --project core",          # vitest workspace 模式
"test:integration": "vitest run --project integration",
"test:e2e": "vitest run --project e2e",
"test:coverage": "vitest run --coverage",
"test:core": "npm run test:unit",
"ci:test": "node scripts/ci-test.mjs",            # 统一 CI 入口
```

使用 vitest workspace 实现测试分组（`vitest.workspace.ts`）：

```typescript
export default [
  {
    test: {
      name: 'core',
      include: ['packages/**/src/**/*.test.ts'],
      exclude: [
        'packages/**/src/**/__tests__/e2e/**/*.test.ts',
        'packages/**/src/**/*.integration.test.ts',
      ],
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: [
        'packages/**/src/**/*.integration.test.ts',
        'tests/integration/**/*.test.ts',
      ],
      testTimeout: 10000,
      setupFiles: ['./vitest.setup.ts', './vitest.integration.setup.ts'],
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['packages/**/src/**/__tests__/e2e/**/*.test.ts'],
      testTimeout: 30000,
      setupFiles: ['./vitest.setup.ts', './vitest.e2e.setup.ts'],
    },
  },
];
```

每个 workspace project 可以有不同的 setup、timeout、pool，天然实现分组隔离。

### 5.7 与 Rust Cargo.toml 的集成

为每个缺少测试的核心 crate 的 `Cargo.toml` 添加 `[dev-dependencies]`：

```toml
# crates/conex-net/Cargo.toml
[dev-dependencies]
tempfile = "3"
mockito = "1"
tokio = { version = "1", features = ["rt", "macros"] }

# crates/conex-fs/Cargo.toml
[dev-dependencies]
tempfile = "3"
serial_test = "3"

# crates/conex-db/Cargo.toml
[dev-dependencies]
tempfile = "3"
serial_test = "3"
```

同时在工作区根 `Cargo.toml` 中添加统一的测试配置：

```toml
[workspace]
members = [...]

[profile.test]
opt-level = 0
debug = 1

[workspace.lints.rust]
unused_must_use = "deny"

# 测试专用 feature
[features]
test-utils = []
```

### 5.8 与 tests/ 顶层目录的集成

当前 `tests/` 下的压力、恢复、竞态、模糊、启动测试独立于 vitest。集成策略：

1. **压力测试**（`tests/stress/`）：保持独立 runner，但输出 JUnit 格式的结果，通过 `scripts/ci-test.mjs` 集成到 CI pipeline
2. **恢复测试**（`tests/recovery/`）：将 `crash-recovery.test.ts` 中的 `MockDaemonRecovery` 替换为使用真实模块加上 `FauxProvider`，保留为 vitest 测试
3. **竞态测试**（`tests/race/`）：将异步测试扩展到覆盖更多共享状态访问模式
4. **模糊测试**（`tests/fuzz/`）：引入真正的 fuzz 框架（如 `node-fuzz` 或 `jazzer.js`），将当前的手动 fuzz 测试降级为参数化测试的子集
5. **启动测试**（`tests/startup/`）：保留独立 runner，但通过 `scripts/ci-test.mjs` 集成

---

## 六、迁移策略

### 6.1 总体迁移路线

测试基础设施的改进不是一次性的全量替换，而是分阶段、低风险的渐进式迁移。每个阶段结束时，CI 必须保持绿色，所有现有测试必须通过。

**阶段 1：基础设施准备（不影响任何现有测试）**
1. 创建 `vitest.globalSetup.ts` 和 `vitest.globalTeardown.ts`（任务 T-004）
2. 增强 `vitest.setup.ts` 增加 `beforeEach`/`afterEach` 的隔离钩子（任务 T-005）
3. 为 `provider-gateway.ts` 添加 `resetProviderEngine()` 导出（任务 T-020）
4. 创建 `createMockTool()` 和 `createToolCall()` 工厂函数（任务 T-003）
5. 在 `vitest.config.ts` 中增加 `testTimeout`、`retry` 等配置（任务 T-019）

**阶段 2：核心测试工具创建（现有测试不变，新测试开始使用）**
1. 创建 `FauxAgentProvider` 和 `ProviderEventSequence`（任务 T-001）
2. 创建 `FauxProviderCallGateway`（任务 T-002）
3. 创建 `FixtureLoader` 和前 5 个 fixture 文件（任务 T-006）
4. 在 `vitest.config.ts` 中增加 `coverage.thresholds`（任务 T-013）

**阶段 3：现有测试逐步迁移（逐个文件替换）**
1. 迁移 `provider-gateway.test.ts` 使用 `FauxAgentProvider` + `FixtureLoader`（任务 T-007）
2. 迁移 `tool-executor.test.ts` 使用 `createMockTool()`（任务 T-008）
3. 迁移 `agent-session-loop.test.ts` 使用 `FauxProviderCallGateway`（任务 T-009）
4. 迁移 `provider-anthropic.test.ts` 使用 `FauxAgentProvider` + fixture（任务 T-021）
5. 迁移 `provider-openai-compatible.test.ts` 使用 `FauxAgentProvider` + fixture

**阶段 4：新增集成测试**
1. 创建 `provider-call-gateway` 集成测试（任务 T-010）
2. 创建 `provider-tool-pipeline` E2E 测试（任务 T-011）
3. 创建 `session-loop` 集成测试（任务 T-009 扩展）
4. 创建缺失模块的单元测试（任务 T-023）

**阶段 5：跨语言 CI 统一和工具包封装**
1. 创建 `packages/test-utils/` 包（任务 T-012）
2. 创建 `scripts/ci-test.mjs`（任务 T-016）
3. Rust 测试完善（任务 T-014、T-018）
4. 压力测试可重现重建（任务 T-017）
5. 统一测试分组（任务 T-015）

### 6.2 向后兼容策略

在整个迁移过程中，保持向后兼容需要：
1. **不删除旧的 mock 方式**：`PlannedProvider`、匿名类等旧 mock 代码在替换后可以删除，但不要在同一 PR 中同时替换多个文件的 mock 方式
2. **FixtureLoader 提供运行时验证**：如果 JSON fixture 加载失败（如文件缺失、格式错误），FixtureLoader 应抛出一个有意义的错误而不是静默返回 null
3. **环境隔离默认关闭**：`vitest.globalSetup.ts` 的环境变量清理默认只在 `CI=true` 时启用，本地开发可以通过 `CONEX_TEST_ISOLATION=1` 显式启用

---

## 七、验证标准

### 7.1 假 Provider 验证标准

**功能性验证**：
- [ ] `FauxAgentProvider` 的 `stream()` 方法实现 `AgentProvider` 接口，返回正确的 `AsyncIterable<ProviderStreamEvent>`
- [ ] `FauxAgentProvider` 的 `id` 属性与构造参数一致
- [ ] `FauxAgentProvider.callCount` 每次调用 `stream()` 后递增
- [ ] `FauxAgentProvider.capturedRequests` 包含每次调用 `stream()` 的完整 `AgentProviderRequest`
- [ ] `FauxAgentProvider.setSequence()` 可以在两次 `stream()` 调用之间更换事件序列
- [ ] 两个 `FauxAgentProvider` 实例的状态完全独立

**ProviderEventSequence 验证标准**：
- [ ] `ProviderEventSequence.text("Hello")` 产生的事件流：start → delta(text: "Hello") → end
- [ ] `ProviderEventSequence.toolCall("shell", { command: "ls" })` 产生的事件流包含 begin/delta/end 三个 phase
- [ ] `ProviderEventSequence.error("Rate limit", true)` 产生 error 事件且 `retryable=true`
- [ ] `ProviderEventSequence.stop("stop", { inputTokens: 10 })` 产生 stop 事件且包含 usage 信息
- [ ] `ProviderEventSequence.thinking("思考中...")` 产生 reasoning 事件且包含正确的文本
- [ ] `ProviderEventSequence.diagnostic("rate_limit", "warning message", "warning")` 产生 diagnostic 事件
- [ ] `ProviderEventSequence.concat(seq1, seq2)` 将多个序列串联为单一事件流
- [ ] `ProviderEventSequence.thenWait(500)` 在事件之间插入指定毫秒的延迟
- [ ] `ProviderEventSequence.fromContractEvents(events)` 从 `ProviderStreamContractEvent[]` 数组构造

**FauxProviderCallGateway 验证标准**：
- [ ] `FauxProviderCallGateway.call()` 正确代理到内部的 `FauxAgentProvider`
- [ ] `capturedRequests` 在每次 call() 后被更新，包含完整的请求参数
- [ ] `setDefaultSequence()` 影响所有没有 provider-specific 序列的调用
- [ ] `setProviderSequence("provider-a", seq)` 只影响 "provider-a" 的调用，不影响其他 Provider
- [ ] `FauxProviderCallGateway` 支持 `ProviderCallGatewayOptions` 的全部配置项
- [ ] `call()` 返回的 AsyncGenerator 在消费完所有事件后正确结束

### 7.2 测试隔离验证标准

**环境变量隔离**：
- [ ] `scripts/test.sh` 运行前后，`ANTHROPIC_API_KEY` 等环境变量的值不变（备份和恢复正确）
- [ ] 测试执行过程中，`process.env.ANTHROPIC_API_KEY` 为 `undefined`
- [ ] 如果 `CI=true`，`vitest.globalSetup.ts` 自动执行环境变量清理
- [ ] `CONEX_API_KEY_*` 前缀的所有环境变量也在清理范围内
- [ ] 备份和恢复是原子的——如果测试中途 SIGKILL，backup 侧不应丢失

**全局单例隔离**：
- [ ] 调用 `resetProviderEngine()` 后，`_gatewayBridge` 为 `null`
- [ ] 再次调用 `initProviderEngine()` 后，创建新的 bridge 实例，与旧实例无关
- [ ] 两个连续运行的测试文件之间，`_gatewayBridge` 始终被重置
- [ ] `resetProviderEngine()` 可以安全地多次调用（幂等）

**文件系统隔离**：
- [ ] `beforeEach` 中创建的测试唯一临时目录路径在测试间不重合
- [ ] `afterEach` 清理后，临时目录及其所有子文件和子目录被完全删除
- [ ] 如果 `afterEach` 清理失败，测试仍然是 FAILED 状态（不静默忽略）
- [ ] Rust 测试使用 `tempfile::tempdir()` 而非 `std::env::temp_dir()`

**网络隔离**：
- [ ] 所有使用 `FauxAgentProvider` 的测试不打开任何网络 socket
- [ ] `LlmApiMockServer` 仅在标记为 `@e2e` 的测试中使用
- [ ] 未 mock 的 `fetch` 调用在测试中抛出明确错误（通过增强 setup 实现）
- [ ] 并行运行的 e2e 测试使用不同的端口，不发生冲突

**时间隔离**：
- [ ] 使用 `vi.useFakeTimers()` 的测试在 `afterEach` 中调用 `vi.useRealTimers()`
- [ ] `afterEach` 检查没有 pending 的 `setTimeout`/`setInterval`（通过 `vi.getTimerCount()`）
- [ ] 没有测试依赖真实的 `Date.now()` 动态变化

### 7.3 覆盖率门禁验证标准

- [ ] `vitest.config.ts` 中配置了 `coverage.thresholds` 且初始值如下（在 baseline 测量后确定）：
  - `statements: 60`
  - `branches: 50`
  - `functions: 55`
  - `lines: 60`
- [ ] `npm run test:coverage` 在覆盖率不达标时返回非零 exit code
- [ ] `.husky/pre-push` 或 CI 脚本中调用了 `npm run test:coverage`
- [ ] CI artifact 包含 HTML 覆盖率报告（`coverage/index.html`）
- [ ] Rust 覆盖率通过 `cargo-llvm-cov` 或 `cargo-tarpaulin` 报告
- [ ] TypeScript 和 Rust 的覆盖率报告合并展示（通过 `scripts/coverage-report.sh`）

### 7.4 测试套件完整性验证标准

**ProviderGateway 测试完整性**：
- [ ] `provider-gateway.test.ts` 覆盖所有 `ProviderGatewayPlanCode`（`model_required`、`route_not_found`、`route_in_cooldown`、`provider_credential_missing`、`ssrf_rejected`）
- [ ] 覆盖 `recordRouteResult` 的所有健康状态转换路径（active → cooldown → recovery）
- [ ] 覆盖凭证解析回退链：内联 apiKey → CredentialResolver → SecretStore → env var
- [ ] 覆盖 SSRF 验证拒绝的场景
- [ ] 覆盖能力路由（`modelRouteDecision`）与网关路由的联合行为

**ToolExecutor 测试完整性**：
- [ ] 覆盖所有 `ToolBatchFailurePolicy` 值（`continue-drain`、`cancel-siblings`）
- [ ] 覆盖所有 `concurrency` 类型（`parallel`、`sequential`、`exclusive`）
- [ ] 覆盖超时场景（`timeoutMs` 到达后工具被取消）
- [ ] 覆盖 `ToolExecuteHook` 的自定义钩子注入
- [ ] 覆盖 `ProgressEventQueue` 的并发 push/next 竞争条件

**AgentSessionLoop 测试完整性**：
- [ ] 覆盖所有 `AgentEndReason` 值
- [ ] 覆盖方向盘注入（`SteeringCoordinator` + `RecoverySteeringStrategy`）
- [ ] 覆盖权限决策拒绝路径（`PermissionPolicy.decide()` 返回 `deny`）
- [ ] 覆盖最大轮次（`MaxTurns`）终止
- [ ] 覆盖 Session abort 和 cancel
- [ ] 覆盖 checkpoint 记录和恢复

**ProviderCallGateway 测试完整性**：
- [ ] 覆盖 `StreamRecovery` 的流中断恢复场景
- [ ] 覆盖 `CircuitBreaker` 的状态转换（closed → open → half-open → closed）
- [ ] 覆盖 `retryWithBackoff` 的重试策略
- [ ] 覆盖非流式响应解析
- [ ] 覆盖错误响应（401 unauthorized、429 rate limit、500 server error）到 `ProviderStreamContractEvent` 的转换

**缺失模块测试完成标准**：
- [ ] `packages/shared-utils/src/cache.test.ts` 覆盖 TTL 过期、手动 evict、clear 操作、并发访问
- [ ] `packages/shared-utils/src/retry.test.ts` 覆盖指数退避计算、最大重试次数、可重试和不可重试错误
- [ ] `packages/shared-utils/src/wal.test.ts` 覆盖 append、flush、truncate、recovery、corruption 检测
- [ ] `packages/shared-utils/src/error.test.ts` 覆盖所有错误分类和工具函数
- [ ] `packages/shared-utils/src/logger.test.ts` 覆盖所有日志级别、格式化、输出目标
- [ ] `packages/agent-runtime/src/pricing-engine.test.ts` 覆盖 token 计费和定价计算

**Rust crate 测试完成标准**：
- [ ] `crates/conex-net/src/http_client.rs` 覆盖请求构造、响应解析、超时处理
- [ ] `crates/conex-net/src/ws_client.rs` 覆盖连接建立、消息发送/接收、关闭握手
- [ ] `crates/conex-net/src/llm_provider.rs` 覆盖流式和非流式 LLM 调用
- [ ] `crates/conex-fs/src/reader.rs` 覆盖空文件、大文件、UTF-8 BOM、二进制文件
- [ ] `crates/conex-fs/src/watcher.rs` 覆盖文件创建、修改、删除事件的触发
- [ ] `crates/conex-compaction/src/prefix_guard.rs` 覆盖前缀匹配和缓存失效
- [ ] `crates/conex-compaction/src/ast_compactor.rs` 覆盖常见 AST 模式压缩
- [ ] `crates/conex-db/src/query.rs` 覆盖常见查询构造和参数化

**CI Pipeline 验证标准**：
- [ ] `scripts/ci-test.mjs` 按顺序执行：环境隔离 → Rust 测试 → TypeScript 单元测试 → 集成测试 → 压力测试 → 基准测试
- [ ] CI Pipeline 中任何步骤返回非零 exit code，pipeline 标记为 FAILED
- [ ] 压力测试结果持久化为 JUnit XML 格式，可在 CI 界面直接查看
- [ ] 基准测试结果与上次基线比较，超过阈值输出 warning
- [ ] 覆盖率报告自动上传为 CI artifact
- [ ] 如果 `CI=true` 且 `coverage.thresholds` 不满足，pipeline 标记为 FAILED

---

## 八、风险评估

### 8.1 风险：FauxAgentProvider 与真实 Provider 行为不一致

- **概率**：中
- **影响**：使用 FauxAgentProvider 的测试全部通过，但真实 Provider 的行为与 mock 不同，导致集成问题逃逸到生产环境
- **缓解**：
  1. `ProviderEventSequence` 的事件定义基于真实 Provider 的 wire format 文档（Anthropic SSE、OpenAI SSE、Gemini SSE）
  2. 保留 `LlmApiMockServer` 用于验证 `FauxAgentProvider` 与真实 HTTP 路径的一致性
  3. 每当 Provider 引擎更新时，同步更新 `ProviderEventSequence` 的工厂函数
  4. 每个 Release 前至少运行一次带真实 Provider API key 的 smoke test（由 CI 手动触发）
  5. FauxAgentProvider 的默认序列与 Provider 文档的 example response 一一对应

### 8.2 风险：全局隔离引入跨平台兼容问题

- **概率**：低
- **影响**：`vitest.globalSetup.ts` 和 `scripts/test.sh` 在 Windows（win32）和 Unix 系统上行为不一致
- **缓解**：
  1. 所有环境变量操作使用 `process.env` API（跨平台一致）
  2. `scripts/test.sh` 同时提供 `.cmd` 版本用于 Windows
  3. 在 CI 的 Windows 和 Linux runner 上都测试隔离脚本
  4. 提供 `.env.test.example` 模板文件
  5. 临时目录路径使用 `os.tmpdir()` + `path.join()` 确保路径分隔符正确

### 8.3 风险：覆盖率门禁导致紧急修复受阻

- **概率**：中
- **影响**：紧急安全修复或阻塞性 bug 修复因为覆盖率不达标无法合入
- **缓解**：
  1. 初始阈值设定为项目当前实测覆盖率（偏低），而不是理想值
  2. 每季度评估一次，每次提升 5-10%
  3. 允许在 coverage 检查中添加临时 exclude 列表（如 `// istanbul ignore next` 等价注释），但需要两人 code review 批准
  4. 紧急修复可以通过 `--no-verify` 跳过 pre-push hook，但需要在 commit message 中说明理由
  5. CI 中 coverage gate 作为"必须通过"但不作为"阻塞合并"的硬条件（前 3 个月）

### 8.4 风险：test-utils 包过度泛化

- **概率**：中
- **影响**：`@crish/test-utils` 包的 API 设计过度抽象，学习成本高，开发者选择继续使用内联 mock
- **缓解**：
  1. 严格限制 test-utils 的内容——只包含当前确需的工厂函数和 mock 类
  2. 如果某个 mock 或 helper 只在一个测试文件中使用，保持内联（不提取到共享包）
  3. 遵循 YAGNI 原则——不为"可能需要的"未来场景设计接口
  4. test-utils 的每项导出函数必须至少被两个不同的测试文件使用
  5. 提供详细的 TypeScript 类型（JSDoc 或 TSDoc），IDE 自动补全降低学习成本

### 8.5 风险：大量 fixture 文件管理成本

- **概率**：低
- **影响**：fixture 文件数量膨胀后，与 schema 不一致时产生误导
- **缓解**：
  1. 所有 fixture 文件使用 `as const satisfies <ExpectedType>` 声明类型，由 TypeScript 编译检查
  2. 创建 `scripts/validate-fixtures.mjs` 定期运行 fixture schema 验证
  3. 每个 fixture 文件不超过 100 行——复杂场景拆分为多个文件
  4. fixture 文件命名约定：`<module>-<scenario>.json`
  5. CI 中包含 fixture 验证步骤

### 8.6 风险：Rust 假 Provider 与 TypeScript FauxProvider 语义不一致

- **概率**：低
- **影响**：Rust `MockLlmEndpoint` 和 TypeScript `FauxAgentProvider` 的行为语义不同，跨语言集成测试无法共享场景
- **缓解**：
  1. 在测试工具设计中保持相同的"事件序列"概念（`ProviderEventSequence` ↔ `MockLlmScenario`）
  2. Rust `MockLlmEndpoint` 和 TypeScript `FauxAgentProvider` 使用相同的场景描述格式（通过 JSON schema 约束）
  3. 跨语言集成测试只通过 IPC 边界验证（不影响各语言内部的分离测试）
  4. 共享的 fixture 文件（JSON）同时被 Rust 和 TypeScript 的测试工具消费

### 8.7 风险：FauxProviderCallGateway 引入不必要的间接层

- **概率**：低
- **影响**：`FauxProviderCallGateway` 继承 `ProviderCallGateway` 导致与后者的构造函数参数耦合，基类接口变化时需要同时更新 mock
- **缓解**：
  1. `FauxProviderCallGateway` 不继承 `ProviderCallGateway`，而是实现相同的调用接口
  2. 定义 `ProviderCallGatewayLike` 接口（或使用 `typeof ProviderCallGateway.prototype.call` 的类型），使 mock 与基类解耦
  3. 如果基类接口变化，TypeScript 编译时类型检查会自动发现 mock 中的不匹配

### 8.8 风险：迁移期间测试覆盖率短暂下降

- **概率**：高
- **影响**：将现有测试从内联 mock 迁移到共享工具时，可能因迁移中断或代码删除而暂时降低覆盖率
- **缓解**：
  1. 每个迁移 PR 只迁移一个测试文件，保持其他测试不变
  2. 迁移完成后立即运行该文件的测试，覆盖率不下降才合入
  3. 不删除旧 mock 代码，直到新 mock 覆盖了所有旧场景
  4. CI 的覆盖率比较使用 baseline（迁移前）而非绝对值
