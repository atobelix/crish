# 子计划 03：Layer C — Agent Runtime 引擎（C1 文件拆分 + C2 Provider 抽象升级）

> **层级编号**：Layer C（Round 2 执行 C1 Phase 1，Round 3 执行 C2 Phase 2）
> **建议 Agent 数量**：C1 Phase 1 需 6-8 个 Agent，C2 Phase 2 需 8-10 个 Agent（互不交叉）
> **涉及维度**：D1（架构耦合）、D3（重复）、D4（并发安全）、D5（IPC 边界）、D8（圈复杂度）、D7（错误恢复）、D11（Provider 抽象）
> **下游依赖方**：Layer D (Daemon) 消费 Runtime API、Layer H (Tool Hook) 消费 tool-executor、Layer E (State) 消费 provider-gateway 接口
> **包路径**：`packages/agent-runtime/src/`

---

## 一、层级目标

Layer C 拆分为两个连续阶段：

**C1 Phase 1（Round 2，文件拆分阶段）**：拆分 Runtime 核心上帝文件，降低控制流复杂度，修复异步竞态，强化状态机约束。不做接口级别变更——所有拆分保持行为不变，仅做文件级重组。

1. **拆分** `agent-session-loop.ts`（2,294 行）提取 4 个 Delegate 类。
2. **拆分** `runtime-metrics.ts`、`model-routing.ts` 的类型/逻辑分离。
3. **拆分** `provider-gateway.ts`、`mcp-lifecycle.ts`、`plan-document.ts`、`fs-edit-tools.ts`、`context-compression.ts` 的职责拆分。
4. **修复** AbortSignal 传播链断裂问题、`stream-recovery.ts` AsyncMutex 竞态。
5. **简化** `tool-executor.ts` CC 降低 + Options 模式提取、`conversation-engine.ts` CC 降低。
6. **暂缓** `provider-openai-compatible.ts` 拆分——该文件已 `@deprecated`，将在 C2 Phase 2 中通过接口统一后删除而非拆分。

**C2 Phase 2（Round 3，Provider 抽象升级阶段）**：消除两层流事件类型映射，建立统一的 Provider Registry 双轨注册机制，引入 Provider 生命周期管理，统一错误分类。

1. **创建** `ProviderRegistryV2` 双轨注册中心（声明式 + 程序化 SPI）。
2. **统一** 流事件协议——仅保留 `ProviderStreamContractEvent`。
3. **消除** `normalizeProviderStreamEvents` 映射层，Engine 直接输出 `ProviderStreamContractEvent`。
4. **统一** 错误分类——`ProviderErrorClassifier` 消除 4 处独立分类逻辑。
5. **去单例化** `GatewayV2Bridge`。
6. **创建** `FauxProvider` 作为标准测试替身。
7. **精简** `DaemonProviderGatewayController`。

---

## 二、任务总表（C1 Phase 1：文件拆分）

| 任务 ID | 目标文件 | 行数/KB | 核心问题 | 修复策略 | 来源维度 | 分配 Agent |
|---------|---------|---------|---------|---------|---------|-----------|
| C1-1 | `agent-session-loop.ts` | 2,294 / 84KB | 上帝类：30+ 字段、状态机驱动 + 工具执行 + Provider 调用 + 压缩 + Steering + 恢复 + 指标 | 提取 Delegate 类（ProviderCall/ToolExecution/Steering/Recovery） | D1 | Agent C1 |
| C1-2 | `runtime-metrics.ts` | 1,345 / 50KB | 类型定义 + 收集逻辑 + 快照生成混杂 | 类型/收集/快照分离 | D1 | Agent C2 |
| C1-3 | `model-routing.ts` | 1,087 / 45KB | 50+ 类型定义与路由匹配逻辑混杂 | 类型定义和路由逻辑分离 | D1 | Agent C2 |
| C1-4 | `provider-gateway.ts` | 1,002 / 38KB | 凭证解析 + 路由选择 + Provider 工厂 + 健康检查混杂 | 按职责拆分为 5 个子模块（纯拆分，不改接口） | D1 | Agent C3 |
| C1-5 | `mcp-lifecycle.ts` | 1,194 / 42KB | MCP 工具生命周期与连接管理混杂 | 按职责拆分 | D1 | Agent C4 |
| C1-6 | `plan-document.ts` | 1,050 / 36KB | Plan 类型定义与执行逻辑混杂 | 类型/逻辑分离 | D1 | Agent C4 |
| C1-7 | `fs-edit-tools.ts` | 1,205 / 45KB | 文件编辑工具全堆在一个文件 | 按工具类型拆分 | D1 | Agent C5 |
| C1-8 | `runtime-components/conversation-engine.ts` | 339 / 30KB | CC 过高 | 拆分条件分支为策略方法 | D2 | Agent C5 |
| C1-9 | `tool-executor.ts` | 860 / 32KB | CC 过高 + 参数爆炸 | 提取 Options 模式 + 拆分条件分支 | D2, D5 | Agent C6 |
| C1-10 | `provider-call-gateway.ts` | 321 / 12KB | 降级链处理不完整 | 修复降级链 | D7 | Agent C6 |
| C1-11 | AbortSignal 传播链 | 多文件 | 工具执行层、MCP 调用层、流恢复层缺少 signal 传递 | 添加 signal 参数传递 | D4 | Agent C7 |
| C1-12 | `stream-recovery.ts` | 690 / 23KB | AsyncMutex 保护流恢复中的并发重试竞态 | 修复 lock scope 与 retry 边界（依赖 A-3） | D4 | Agent C7 |
| C1-13 | `context-compression.ts` | 894 / 36KB | token 估算 + 压缩策略 + 序列化混杂 | 提取 token 估算和序列化辅助 | D1 | Agent C8 |
| C1-14 | `state-machine/core.ts` | 254 / 18KB | FSM 隐式化 | 状态转移显式化 | D2 | Agent C8 |
| C1-15 | 脚本空 catch{} 消除 | `scripts/run-mimo-*.ts` | 空 catch 吞没错误 | 添加错误处理路径 | D7 | Agent C8 |

**注意**：`provider-openai-compatible.ts` 已 `@deprecated`，暂缓其拆分。现有导出函数（`classifyProviderErrorMessage`）将在 C2 Phase 2 的错误分类统一任务中被替代后安全删除。

---

## 二-B、任务总表（C2 Phase 2：Provider 抽象升级）

| 任务 ID | 目标文件 | 当前问题 | 修复策略 | 来源维度 |
|---------|---------|---------|---------|---------|
| C2-1 | `provider/registry-v2.ts` | 无程序化注册 API，仅支持声明式 | 创建 `ProviderRegistryV2` 双轨注册中心 | D11 |
| C2-2 | `provider/spi/` | 无 `ProviderClass`/`ProviderFactory` 接口 | 提取 SPI 接口 | D11 |
| C2-3 | `provider/factory.ts` | Engine 同步初始化，无懒加载 | 延迟 Engine 实例化到首次使用 | D11 |
| C2-4 | `provider/types.ts` | Engine 输出 `ProviderStreamEvent` | 改为直接输出 `ProviderStreamContractEvent` | D11 |
| C2-5 | `provider-stream-contract.ts` | 两层事件类型并存，需 `mapProviderStreamEvent` 映射 | 删除映射函数，仅保留 `ProviderStreamContractEvent` | D11 |
| C2-6 | `provider-stream-contract.ts` | 工具调用 id/index 为可选 | 必选化 + 添加自定义 delta 扩展变体 | D11 |
| C2-7 | `schemas/provider-stream-event.json` | Rust `StreamEvent` 与 TS 事件类型无共享定义 | 创建 JSON Schema + 代码生成 | D11 |
| C2-8 | `provider-error-classifier.ts` | 4 处独立错误分类逻辑 | 统一为 `ProviderErrorClassifier` | D11 |
| C2-9 | `provider-gateway.ts` | `_gatewayBridge` 全局单例 | 移除单例，通过依赖注入传递 | D11 |
| C2-10 | `types.ts` | `AgentProvider` 无生命周期方法 | 添加 `init()`/`dispose()`/`healthCheck()` 可选方法 | D11 |
| C2-11 | `provider-gateway.ts` | `ProviderRouteOffer` 与 `ModelProfile` 字段重叠 | 统一为 `deriveModelProfile()` | D11 |
| C2-12 | `provider-gateway.ts` | `StaticProviderRouteCatalog` 与 `ProviderRegistry` 独立 | 集成：注册新 Provider 时自动创建路由 | D11 |
| C2-13 | `stream-recovery.ts` | 累积逻辑消费旧 `ProviderStreamEvent` | 迁移为消费 `ProviderStreamContractEvent` | D11 |
| C2-14 | `daemon-provider-gateway.ts` | 硬编码 `shouldUseAnthropicProvider`/`shouldUseGeminiProvider` | 统一使用 `ProviderGateway.resolveProvider` | D11 |
| C2-15 | `agent-session-loop.ts` | 错误处理代码跨 120 行内联于 streaming 状态 | 提取为 `ProviderRetryStrategy` 类 | D11 |
| C2-16 | `provider/faux-provider.ts` | 手动 mock 分散在各 `*.test.ts` | 创建标准 `FauxProvider` 测试替身 | D11 |
| C2-17 | `provider/builtin/` | Anthropic/Gemini 判断硬编码 | 创建 `AnthropicProviderClass`/`GeminiProviderClass` | D11 |
| C2-18 | `provider/health-checker.ts` | 无 Provider 实例级别健康检查 | 定期健康检查 + 状态同步 | D11 |

## 二-C、C2 Phase 2 验收标准

| 编号 | 检查项 | 验证方式 | 通过条件 |
|------|--------|---------|---------|
| V-C2-1 | ProviderRegistryV2 双轨注册 | `npm test -- registry-v2` | 声明式 + 程序化注册均通过 |
| V-C2-2 | 统一流事件协议 | `grep "ProviderStreamEvent" src/provider/` | 仅 `ProviderStreamContractEvent` 存在 |
| V-C2-3 | normalizeProviderStreamEvents 删除 | 代码审查 | 映射函数已被移除 |
| V-C2-4 | ProviderErrorClassifier 统一 | `grep -r "classifyProviderError" src/` | 仅 classifier 中存在分类逻辑 |
| V-C2-5 | GatewayV2Bridge 去单例化 | 代码审查 | 无模块级 `_gatewayBridge` 全局变量 |
| V-C2-6 | FauxProvider 可用 | `new FauxProvider("test").stream(req)` | 返回预设事件序列 |
| V-C2-7 | Provider 生命周期方法 | `grep "init\|dispose\|healthCheck" types.ts` | `AgentProvider` 接口包含生命周期 |
| V-C2-8 | 内置 Provider 类 | `ls provider/builtin/` | `AnthropicProviderClass` + `GeminiProviderClass` |
| V-C2-9 | Provider 健康检查 | `npm test -- health-checker` | 检查/预热测试通过 |
| V-C2-10 | 全量构建 + 测试 | `npm run build && npm test` | 零错误、零回归 |

## 二-D、C1 与 C2 的执行关系

```
Round 2 ────────────────────────
  C1 Phase 1 执行（与 Layer B 并行）
  ├── C1-1~C1-8  文件拆分（6 Agent 并行）
  ├── C1-9~C1-10  CC 降低 + 模式提取（2 Agent）
  ├── C1-11~C1-12 AbortSignal + recovery 修复（2 Agent）
  └── C1-13~C1-15 瘦身 + 状态机（2 Agent）

Round 3 ────────────────────────
  C2 Phase 2 执行（与 Layer H 和 Layer D 并行）
  ├── C2-1~C2-3  Registry + SPI + 懒加载（3 Agent）
  ├── C2-4~C2-6  事件协议统一（3 Agent）
  ├── C2-7~C2-9  Schema + 分类器 + 去单例（3 Agent）
  ├── C2-10~C2-12 生命周期 + 类型统一 + Catalog（2 Agent）
  ├── C2-13~C2-15 Recovery + Daemon + SessionLoop（3 Agent）
  └── C2-16~C2-18 FauxProvider + 内置 Provider + 健康检查（2 Agent）
```

**依赖关系**：C1→C2 为顺序依赖。C2 必须在 C1 完成后执行，因为 C2 的接口变更操作在 C1 拆分的文件边界上进行。

## 三、C2 Phase 2 实现指引

### 三-A：ProviderRegistryV2 双轨注册（C2-1~C2-3）

**架构描述**：创建双轨注册机制，保留现有的声明式 JSON 文件注册轨道，新增程序化 SPI 注册轨道。

**声明式轨道**：维持现有 `providers.json` 配置文件注册方式不变，ProviderRegistryV2 自动扫描并加载。

**程序化轨道**：新增 SPI 接口，允许通过代码直接注册 Provider 类和工厂函数：

```typescript
interface ProviderRegistryV2 {
  // 声明式（保留）
  loadFromConfig(configPath: string): Promise<void>;
  
  // 程序化 SPI
  registerProviderClass(id: string, providerClass: ProviderClass): void;
  registerProviderFactory(id: string, factory: ProviderFactory): void;
  registerEngineClass(id: string, engineClass: EngineClass): void;
  
  // 统一查询
  getProvider(id: string): AgentProvider | undefined;
  getEngine(id: string): Engine | undefined;
  listProviders(): string[];

  // 托管实例化——减少分散在各处的 new EngineProvider()
  createProvider(providerId: string, credential?: ProviderCredentialSource): AgentProvider;

  // 优雅下线——触发 DRAINING → DISPOSED 状态转换，释放连接/缓存
  disposeProvider(providerId: string): Promise<void>;

  // 路由同步——注册新 Provider 后确保 StaticProviderRouteCatalog 与 Registry 一致
  syncRoutes(): Promise<void>;
}
```

**与现有 ProviderRegistry 的差异**：

| 差异点 | 当前 ProviderRegistry | ProviderRegistryV2 |
|--------|---------------------|-------------------|
| 注册方式 | 仅声明式（JSON） | 声明式 + 程序化 SPI |
| Provider 实例化 | 注册时立即创建 | 支持懒加载（C2-3） |
| Engine 管理 | 无 Engine 概念 | 独立的 Engine 注册通道 |
| SPI 接口 | 无 | ProviderClass / ProviderFactory 接口 |

### 三-B：统一流事件协议（C2-4~C2-7）

**目标**：消除两层映射，Engine 直接输出 `ProviderStreamContractEvent`，删除中间映射函数。

**当前映射链**：

```
Engine → ProviderStreamEvent → mapProviderStreamEvent → ProviderStreamContractEvent → 消费者
```

**修复后**：

```
Engine → ProviderStreamContractEvent → 消费者
```

**需要删除的函数**：

| 函数 | 所在文件 | 替代方案 |
|------|---------|---------|
| `normalizeProviderStreamEvents` | `provider-stream-contract.ts` | 直接输出 `ProviderStreamContractEvent` |
| `mapProviderStreamEvent` | `provider-stream-contract.ts` | Engine 内部直接构造目标类型 |
| `normalizeAndCoalesceProviderStreamEvents` | `provider-stream-contract.ts` | 仅保留 `ProviderStreamContractEvent` 序列 |

**跨语言 Schema 生成**：创建 JSON Schema 作为单一事实来源，通过代码生成工具同步 TypeScript 和 Rust 类型：

| 工具 | 目标语言 | 输入 | 输出 |
|------|---------|------|------|
| `json-schema-to-typescript` | TypeScript | `schemas/provider-stream-event.json` | `provider-stream-contract/types.ts` |
| `schemars` (Rust) | Rust | `schemas/provider-stream-event.json` | Daemon 侧的 StreamEvent 类型 |

**关于 adapter.ts**：§6.1 原有的 `adapter.ts` 作为旧→新事件映射的过渡件暂留，但在 C2 Phase 2 中需随 `normalizeProviderStreamEvents` 一并删除。

### 三-C：ProviderErrorClassifier 统一错误分类（C2-8）

**当前分散的分类逻辑**：

| 位置 | 行号 | 实现方式 |
|------|------|---------|
| `provider-stream-contract.ts` | ~465 | 内联条件判断 |
| `base-engine.ts` | ~61 | 内联条件判断 |
| `fallback-chain/engine.ts` | ~6 | 内联条件判断 |
| `provider-openai-compatible.ts` | 已废弃 | `classifyProviderErrorMessage` 导出函数 |

**统一策略**：创建 `ProviderErrorClassifier` 策略类：

```typescript
interface ErrorClassificationInput {
  message: string;
  status?: number;
  code?: string;
  headers?: Record<string, string>;
}

interface ErrorClassificationOutput {
  kind: 'rate_limit' | 'auth_error' | 'timeout' | 'server_error' | 'invalid_request' | 'unknown';
  retryable: boolean;
}

class ProviderErrorClassifier {
  classify(input: ErrorClassificationInput): ErrorClassificationOutput;
  registerStrategy(strategy: ClassificationStrategy): void;
}
```

**迁移计划**：

1. 创建 `ProviderErrorClassifier` 类及内置策略。
2. 逐个替换 4 处分散的分类逻辑。
3. 删除 `provider-openai-compatible.ts` 中的 `classifyProviderErrorMessage` 导出。
4. 验证标准：`grep -r "classifyProviderError" src/` 仅 classifier 中存在分类逻辑。

**验收更新**：V-14 由"所有 caller 正常导入"更新为"所有 `classifyProviderErrorMessage` 调用点已迁移到 `ProviderErrorClassifier`（Zero remaining callers）"。

### 三-D：GatewayV2Bridge 去单例化（C2-9）

**现状**：`provider-gateway.ts:972` 的 `_gatewayBridge` 为模块级单例变量：

```typescript
// 当前（模块级单例）
let _gatewayBridge: GatewayV2Bridge | null = null;

function getGatewayBridge(): GatewayV2Bridge {
  if (!_gatewayBridge) {
    _gatewayBridge = new GatewayV2Bridge();
  }
  return _gatewayBridge;
}
```

**修复**：使用依赖注入替代模块级变量：

```typescript
// 修复后
class ProviderGateway {
  private gatewayBridge: GatewayV2Bridge;
  
  constructor(options: ProviderGatewayOptions) {
    this.gatewayBridge = options.gatewayBridge ?? new GatewayV2Bridge();
  }
}
```

`AgentRuntimeOptions` 需支持直接传入 `ProviderRegistry` 实例：

```typescript
interface AgentRuntimeOptions {
  // 新增
  providerRegistry?: ProviderRegistryV2;
  // 移除单例依赖
}
```

### 三-E：Provider 生命周期 + 类型统一（C2-10~C2-12）

**Provider 生命周期状态机**：定义六状态模型，统一管理 Provider 从创建到销毁的完整生命周期：

```
UNINITIALIZED
    → createProvider() 首次调用 → INITIALIZING
    → init() 成功 → READY
    → healthCheck() 连续失败 → DEGRADED
    → disposeProvider() → DRAINING（等待进行中请求完成）
    → 所有请求完成 → DISPOSED
```

| 状态 | 含义 | 可接受操作 | 转换条件 |
|------|------|-----------|---------|
| `UNINITIALIZED` | 初始状态，Provider 已注册但未实例化 | `createProvider()` | 调用 `createProvider()` → `INITIALIZING` |
| `INITIALIZING` | Provider 正在初始化（连接建立、资源分配） | 无外部操作；内部重试 | `init()` 成功 → `READY`；初始化失败 → `UNINITIALIZED`（可重试） |
| `READY` | Provider 正常工作，可接受请求 | `stream()`, `healthCheck()` | `healthCheck()` 连续失败 → `DEGRADED`；`disposeProvider()` → `DRAINING` |
| `DEGRADED` | Provider 部分不可用，应触发降级/重试逻辑 | `healthCheck()`（恢复探测） | `healthCheck()` 恢复 → `READY`；`disposeProvider()` → `DRAINING` |
| `DRAINING` | 正在等待进行中请求完成，不再接受新请求 | 仅等待进行中请求完成 | 所有请求完成 → `DISPOSED`；超时 → 强制 `DISPOSED` |
| `DISPOSED` | 已释放所有资源，不可再使用 | 无 | 无（终态） |

**Provider 生命周期方法（C2-10）**：`AgentProvider` 接口新增可选方法：

```typescript
interface AgentProvider {
  // 现有方法
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamContractEvent>;
  
  // 新增可选生命周期方法
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  healthCheck?(): Promise<HealthCheckResult>;
}
```

**类型统一（C2-11）**：`ProviderRouteOffer` 与 `ModelProfile` 的字段重叠问题：

```typescript
// 统一方案：deriveModelProfile()
function deriveModelProfile(offer: ProviderRouteOffer): ModelProfile {
  return {
    modelId: offer.modelId,
    capabilities: offer.capabilities,
    // ... 自动映射
  };
}
```

**Catalog 集成（C2-12）**：`StaticProviderRouteCatalog` 与 `ProviderRegistry` 集成，注册新 Provider 时自动创建路由。

### 三-F：Daemon 网关精简 + FauxProvider（C2-13~C2-18）

| 任务 ID | 目标 | 概要 |
|---------|------|------|
| C2-13 | `stream-recovery.ts` 迁移 | 迁移为消费 `ProviderStreamContractEvent`，替代旧的 `ProviderStreamEvent` |
| C2-14 | Daemon 网关精简 | 消除 `shouldUseAnthropicProvider`/`shouldUseGeminiProvider` 硬编码，统一使用 `ProviderGateway.resolveProvider` |
| C2-15 | 错误处理提取 | 从 `agent-session-loop.ts` 的 streaming 状态中提取 120 行内联错误处理为 `ProviderRetryStrategy` 类 |
| C2-16 | FauxProvider | 创建标准测试替身 `FauxProvider`，替代分散在各 `*.test.ts` 中的手动 mock |
| C2-17 | 内置 Provider 类 | 创建 `AnthropicProviderClass`/`GeminiProviderClass`，消除硬编码判断 |
| C2-18 | 健康检查 | 实现 Provider 实例级别的定期健康检查 + 状态同步 |

---

## 四、任务 C-2：agent-session-loop.ts 上帝类拆分

### 4.1 问题现状

[agent-session-loop.ts](file:///c:/Software/conex/packages/agent-runtime/src/agent-session-loop.ts) 是 2,294 行的**上帝类**，拥有 **30+ 实例字段**：

```typescript
class AgentSessionLoop {
  // 状态机
  private machine: ConexStateMachine<...>;
  // 工具执行
  private toolExecutor: ToolExecutor;
  private singleToolExecutor: SingleToolExecutor;
  private toolExecution: NormalizedToolExecutionOptions;
  // Provider 消费
  private providerConsumer: ProviderResponseConsumer;
  // 上下文压缩
  private compressionGate: ContextCompressionGate;
  // Steering
  private steeringCoordinator: SteeringCoordinator;
  // 权限
  private permissionPolicy: RuntimePermissionPolicy;  // （C2 Phase 2 和 H Layer 中将被 ApprovalPipeline 替代）
  // 扩展
  private extensionRegistry: ExtensionRegistry;
  private composedHooks: AgentHooksType;
  // 计数器/标志 (10+)
  private synthesisNudgeUsed = false;
  private sawToolsThisRun = false;
  private providerTransientRetries = 0;
  private payloadRecoveryRetries = 0;
  private lengthMaxTokensEscalationCount = 0;
  private lengthContinueNudgeCount = 0;
  private maxTokensOverride: number | undefined;
  private lastPromptAssembly: PromptAssemblyMetadata | undefined;
  // 度量
  private readonly ledger: TokenLedger;
  // ... 更多
}
```

### 4.2 修复方案：Delegate 模式提取

将上帝类的职责提取到以下 Delegate 类中：

| Delegate 类 | 文件 | 提取的字段 | 提取的方法 |
|-------------|------|-----------|-----------|
| `ProviderCallCoordinator` | `session-loop/provider-call.ts` | `providerConsumer`, `providerTransientRetries`, `payloadRecoveryRetries`, `lengthMaxTokensEscalationCount`, `maxTokensOverride` | `callProvider()`, `handleProviderError()`, `handleLengthFinishReason()` |
| `ToolExecutionCoordinator` | `session-loop/tool-execution.ts` | `toolExecutor`, `singleToolExecutor`, `toolExecution`, `sawToolsThisRun` | `executeToolBatch()`, `executeSingleTool()`, `handleToolResult()` |
| `SteeringDelegate` | `session-loop/steering-delegate.ts` | `steeringCoordinator`, `synthesisNudgeUsed` | `getSteeringMessages()`, `shouldNudgeSynthesis()` |
| `RecoveryCoordinator` | `session-loop/recovery.ts` | `lengthContinueNudgeCount` | `handleRecoverableError()`, `shouldRetryWithEscalation()` |

### 4.3 目标结构

```
packages/agent-runtime/src/
├── session-loop/
│   ├── index.ts                    # AgentSessionLoop 瘦身后的主类
│   ├── provider-call.ts            # Provider 调用协调器
│   ├── tool-execution.ts           # 工具执行协调器
│   ├── steering-delegate.ts        # Steering 协调器代理
│   ├── recovery.ts                 # 错误恢复协调器
│   └── types.ts                    # 内部共享类型
├── agent-session-loop.ts           # 保留为 barrel 重导出
```

### 4.4 重构后的主类结构

```typescript
class AgentSessionLoop {
  // 状态机（保留）
  private machine: ConexStateMachine<...>;
  
  // 委托组件
  private providerCall: ProviderCallCoordinator;
  private toolExec: ToolExecutionCoordinator;
  private steering: SteeringDelegate;
  private recovery: RecoveryCoordinator;
  
  // 核心基础设施（保留）
  private readonly options: AgentRuntimeOptions;
  private readonly inputQueue: AgentInputQueue;
  private readonly conversation: ConversationEngine;
  private readonly contextManager: ContextManager;
  private readonly abortController: AbortController;
  private readonly recorder: SessionRecorder;
  private readonly ledger: TokenLedger;
  
  async *run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]> {
    // 状态机驱动循环（保留在此）
    // 每个 case 委托到对应的 Delegate
  }
}
```

### 4.5 质量门槛

- 重构后 `AgentSessionLoop` ≤ 800 行。
- 每个 Delegate ≤ 400 行。
- `npm test -- agent-session-loop` 全部通过。

---

## 五、任务 C-3/C-4：runtime-metrics.ts 与 model-routing.ts 拆分

### 5.1 runtime-metrics.ts（1,345 行）

**领域分析**：

| 子模块 | 内容 |
|-------|------|
| `runtime-metrics/types.ts` | 所有 `interface` 定义（~20 个 snapshot/metrics 接口） |
| `runtime-metrics/collectors.ts` | 数据收集器类（Provider usage, tool metrics, cache metrics） |
| `runtime-metrics/snapshot.ts` | 快照生成与聚合逻辑 |
| `runtime-metrics/index.ts` | barrel 重导出 |

### 5.2 model-routing.ts（1,087 行）

**领域分析**：

| 子模块 | 内容 |
|-------|------|
| `model-routing/types.ts` | 50+ 类型定义（`ModelCapabilityTag`, `ModelProfile`, `TaskCapabilityRequest` 等） |
| `model-routing/matcher.ts` | 路由匹配逻辑（`matchRoute()`, `scoreRoute()`, capability 比较） |
| `model-routing/profile.ts` | `enrichProfileFromCatalog()`, `profileFromProviderRouteOffer()` |
| `model-routing/index.ts` | barrel 重导出 |

### 5.3 关键约束

- 类型导出路径必须通过 barrel 保持不变。
- `model-routing` 已有 `model-routing-roles.ts` 和 `model-routing-dynamic/` 子目录，新子模块需与它们和谐共存。

---

## 六、任务 C-5/C-6：provider-stream-contract.ts 与 provider-gateway.ts 拆分

### 6.1 provider-stream-contract.ts（1,016 行）

**领域分析**：

| 子模块 | 内容 |
|-------|------|
| `provider-stream-contract/types.ts` | 协议事件类型定义 (`ProviderStreamContractEvent`, 各种 Event 接口) |
| `provider-stream-contract/sequencer.ts` | 事件序列化、序号管理 |
| `provider-stream-contract/json-repair.ts` | 工具调用 JSON 修复逻辑（`ProviderToolCallJsonRepairResult` 等） |
| `provider-stream-contract/adapter.ts` | 旧 `ProviderStreamEvent` → 新 `ProviderStreamContractEvent` 适配器（过渡件。C2 Phase 2 中将随 normalizeProviderStreamEvents 一并删除） |
| `provider-stream-contract/index.ts` | barrel |

### 6.2 provider-gateway.ts（1,002 行）

**领域分析**：

| 子模块 | 内容 |
|-------|------|
| `provider-gateway/types.ts` | `ProviderRouteOffer`, `ProviderCredentialSource`, `ResolvedProviderCredential` 等 |
| `provider-gateway/credential-resolver.ts` | 凭证解析逻辑 |
| `provider-gateway/route-selector.ts` | 路由选择、权重计算、健康检查 |
| `provider-gateway/factory.ts` | Provider 工厂函数、实例缓存 |
| `provider-gateway/index.ts` | barrel + `ProviderGateway` 主类 |

---

## 七、任务 C-7：AbortSignal 传播链修复

### 7.1 问题现状

项目中 `AbortController` 被广泛使用（150+ 处 grep 命中），但传播链存在多处断裂：

**断裂点 1：Rust Reqwest Daemon**

`provider-openai-compatible.ts` 中的 `sendRustReqwestDaemonRequest()` 接收 `signal: AbortSignal` 参数，但在 Daemon 子进程 `spawn()` 后的 `stdout.on('data')` 回调中，如果 signal 被 abort，仅通过 `killDaemon()` 杀死子进程。**问题在于**：kill 是异步的，可能有 data 事件在 kill 之前已经入队，导致已取消的请求仍然向 `bodyController` 写入数据。

**修复方案**：在 `onAbort` handler 中设置 `streamDone = true` 标志，在 `onData` 回调的入口处检查此标志：

```typescript
const onAbort = (): void => {
  streamDone = true;   // ← 新增：阻止后续 data 写入
  killDaemon();
  if (bodyController && !bodyClosed) {
    try { bodyController.error(new Error("AbortError")); } catch {}
    bodyClosed = true;
  }
  cleanup();
  if (!responseResolved) {
    responseResolved = true;
    reject(new DOMException("The operation was aborted", "AbortError"));
  }
};
```

**断裂点 2：MCP 工具调用**

[mcp-lifecycle.ts](file:///c:/Software/conex/packages/agent-runtime/src/mcp-lifecycle.ts) 中 `callTool()` 创建了本地 `AbortController`（L314），但未将外部 `signal` 链接到该 controller：

```typescript
// 当前代码
const abortController = new AbortController();  // ← 独立的，不受外部 signal 控制

// 修复方案
const abortController = new AbortController();
const onParentAbort = () => abortController.abort();
parentSignal?.addEventListener("abort", onParentAbort, { once: true });
// ... cleanup 时 removeEventListener
```

**断裂点 3：stream-recovery.ts 重试**

重试循环中不检查 signal 状态，导致已取消的 run 仍然发起重试请求。

### 7.2 系统性修复清单

| 文件 | 函数 | 断裂类型 | 修复动作 |
|------|------|---------|---------|
| `provider-openai-compatible.ts` | `sendRustReqwestDaemonRequest` | Data 写入在 abort 后继续 | 添加 `streamDone` 前置检查 |
| `mcp-lifecycle.ts` | `callTool`, `connect` | 本地 AC 不链接到 parent signal | 添加 parent signal forward |
| `stream-recovery.ts` | `executeWithRecovery` | 重试循环不检查 signal | 在重试前检查 `signal.aborted` |
| `lsp-tools.ts` | 多个工具函数 | 创建本地 AC 但不转发 | 添加 signal 参数和转发 |

### 7.3 验证

```bash
npm test -- --grep "abort"
npm test -- mcp-lifecycle
npm test -- stream-recovery
```

---

## 八、任务 C-8：stream-recovery.ts AsyncMutex 竞态修复

### 8.1 问题现状

[stream-recovery.ts](file:///c:/Software/conex/packages/agent-runtime/src/provider-transport/stream-recovery.ts) 使用了 `@crish/shared-utils` 的 `AsyncMutex` 来保护流恢复的并发访问。根据 Layer A 中对 `AsyncMutex` 的分析，该类存在递归 `release()` 可能导致栈溢出的问题。

**具体风险**：当流中断并发恢复时，如果两个恢复操作同时进入 `executeWithRecovery()`：

1. 操作 A 获取 mutex lock。
2. 操作 B 等待 lock。
3. 操作 A 在恢复过程中出错，release lock。
4. 如果 `release()` 触发了 `waiter()` 回调中的递归 `release()`（Layer A 已识别的 bug），会导致栈溢出。

### 8.2 修复方案

1. **前提**：Layer A 的 `AsyncMutex` 修复已完成（使用 `queueMicrotask` 替代同步回调）。
2. **额外修复**：在 `stream-recovery.ts` 中，确保 mutex lock 的 `acquire/release` 配对使用 try-finally：

```typescript
async executeWithRecovery(...) {
  await this.mutex.acquire();
  try {
    return await this.doExecute(...);
  } finally {
    this.mutex.release();
  }
}
```

3. **信号检查**：在重试路径中检查 `signal.aborted`：

```typescript
async doExecute(...) {
  for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
    if (this.signal?.aborted) {
      return { action: { type: "surface-error", message: "Aborted" } };
    }
    // ... 执行流式调用
  }
}
```

---

## 九、任务 C-9：context-compression.ts 瘦身

### 9.1 问题现状

[context-compression.ts](file:///c:/Software/conex/packages/agent-runtime/src/context-compression.ts) 894 行，包含：

- Token 估算逻辑（`estimateTokens`, `IMAGE_TOKEN_COST`, 安全系数）
- 压缩决策逻辑（`shouldCompress()`, 阈值计算）
- 序列化逻辑（`serializeContextForSummary()`）
- 压缩执行逻辑（`compressContext()`）

### 9.2 修复方案

提取以下辅助模块：

| 子模块 | 内容 | 预计行数 |
|-------|------|---------|
| `context-compression/token-estimator.ts` | Token 估算、IMAGE_TOKEN_COST、safety factor | ~120 |
| `context-compression/serializer.ts` | `serializeContextForSummary()` 及相关辅助 | ~150 |
| `context-compression/index.ts` | 压缩决策 + 执行逻辑（瘦身后的主文件） | ~500 |

---

## 十、多 Agent 并行分配方案

```
┌─────────────────────────────────────────────────────────────────┐
│                    Round 3: Layer C                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Agent C1    │  │  Agent C2    │  │  Agent C3    │          │
│  │  provider-   │  │  session-    │  │  metrics +   │          │
│  │  openai-     │  │  loop 上帝  │  │  model-      │          │
│  │  compatible  │  │  类拆分      │  │  routing     │          │
│  │  拆分        │  │              │  │  拆分        │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Agent C4    │  │  Agent C5    │  │  Agent C6    │          │
│  │  stream-     │  │  AbortSignal │  │  context-    │          │
│  │  contract +  │  │  + stream    │  │  compression │          │
│  │  gateway     │  │  recovery    │  │  瘦身        │          │
│  │  拆分        │  │  修复        │  │              │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### C2 Phase 2 Agent 分配

```
┌─────────────────────────────────────────────────────────────────┐
│                    C2 Phase 2 Agent 分配                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  │  Agent C9    │  │  Agent C10   │  │  Agent C11   │  │  Agent C12   │
│  │  C2-1~C2-3   │  │  C2-4~C2-6   │  │  C2-7~C2-9   │  │  C2-10~C2-12 │
│  │  Registry +  │  │  事件协议    │  │  Schema +    │  │  生命周期 +  │
│  │  SPI + 懒加载│  │  统一        │  │  分类器 +    │  │  类型统一    │
│  │              │  │              │  │  去单例      │  │  + Catalog   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  │  Agent C13   │  │  Agent C14   │  │  Agent C15   │  │  Agent C16   │
│  │  C2-13~C2-15 │  │  C2-16~C2-18 │  │  Provider-   │  │  测试与      │
│  │  Recovery +  │  │  FauxProvider│  │  specific    │  │  集成验证    │
│  │  Daemon +    │  │  + 内置     │  │  迁移        │  │              │
│  │  SessionLoop │  │  + 健康检查  │  │              │  │              │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
└─────────────────────────────────────────────────────────────────┘
```

### Agent 互斥边界

| Agent | 独占文件 | 不得修改 |
|-------|---------|---------|
| C1 | `provider-openai-compatible.ts`, `openai-retry.ts`, `openai-stream-parse.ts` | `agent-session-loop.ts`, `model-routing.ts` |
| C2 | `agent-session-loop.ts`, `runtime-components/` | `provider-openai-compatible.ts`, `provider-gateway.ts` |
| C3 | `runtime-metrics.ts`, `model-routing.ts` | `provider-openai-compatible.ts`, `agent-session-loop.ts` |
| C4 | `provider-stream-contract.ts`, `provider-gateway.ts` | `provider-openai-compatible.ts`, `agent-session-loop.ts` |
| C5 | `stream-recovery.ts`, `connection-manager.ts`, `mcp-lifecycle.ts`, `lsp-tools.ts`（仅 signal 相关） | Provider 和 Session Loop 文件 |
| C6 | `context-compression.ts` | 其余所有文件 |

---

## 十一、验收标准总表

| 编号 | 检查项 | 验证方式 | 通过条件 |
|-----|--------|---------|---------|
| V-1 | provider-openai-compatible 拆分 | `wc -l provider-openai-compatible/*.ts` | 每个子文件 ≤ 600 行 |
| V-2 | 原 import 路径兼容 | `grep -r "from.*provider-openai-compatible" --include='*.ts'` | 所有 import 正常解析 |
| V-3 | AgentSessionLoop 瘦身 | `wc -l session-loop/index.ts` | ≤ 800 行 |
| V-4 | Delegate 类行数 | `wc -l session-loop/*.ts` | 每个 ≤ 400 行 |
| V-5 | runtime-metrics 拆分 | `wc -l runtime-metrics/*.ts` | 每个 ≤ 500 行 |
| V-6 | model-routing 拆分 | `wc -l model-routing/*.ts` | types.ts 仅含类型定义 |
| V-7 | stream-contract 拆分 | `wc -l provider-stream-contract/*.ts` | 每个 ≤ 400 行 |
| V-8 | gateway 拆分 | `wc -l provider-gateway/*.ts` | 每个 ≤ 400 行 |
| V-9 | AbortSignal 传播 | `npm test -- --grep "abort"` | 所有 abort 测试通过 |
| V-10 | stream-recovery 修复 | `npm test -- stream-recovery` | 0 失败 |
| V-11 | context-compression 瘦身 | `wc -l context-compression/*.ts` | 主文件 ≤ 500 行 |
| V-12 | 全量构建 | `npm run build` | 零错误 |
| V-13 | 全量测试 | `npm test` | 零回归 |
| V-14 | classifyProviderErrorMessage 迁移 | `grep -r "classifyProviderErrorMessage" --include='*.ts'` | `classifyProviderErrorMessage` 的所有调用点已迁移到 `ProviderErrorClassifier`（Zero remaining callers） |

---

## 十二、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| C-1 拆分破坏 package 公开 API | 中 | 高 | 原文件保留为 barrel 重导出，所有 `export type` 通过 barrel 传递 |
| C-2 上帝类拆分引入 Delegate 间循环依赖 | 中 | 中 | 所有 Delegate 单向依赖主类的 types.ts，不互相依赖 |
| C-7 AbortSignal 修复产生 unhandled rejection | 低 | 高 | 所有 `signal.addEventListener` 使用 `{ once: true }`，cleanup 时 `removeEventListener` |
| C-8 AsyncMutex 修复与 Layer A 冲突 | 低 | 中 | C-8 依赖 Layer A 完成后启动 |
| provider-openai-compatible 的 @deprecated 状态 | — | — | 迁移到引擎体系需要后续独立任务，本轮仅拆分不删除 |

### 执行顺序建议

```
C3 (metrics + routing) ────── 独立，可立即启动（纯类型/逻辑拆分）
C4 (stream-contract + gateway) ── 独立，可立即启动
C6 (context-compression) ──── 独立，可立即启动
C1 (provider-openai-compatible) ─ 独立，可立即启动
C5 (AbortSignal + recovery) ── 依赖 Layer A 的 AsyncMutex 修复
C2 (session-loop) ─────────── 依赖 C1 完成（消费 classifyProviderErrorMessage 路径变更）
```

即 C1/C3/C4/C6 可完全并行，C5 等待 Layer A 完成，C2 等待 C1 完成。
