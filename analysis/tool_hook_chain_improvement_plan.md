# Tool Hook 链与审批流水线 — 改进方案

> 本文档定义 Tool Hook 链与审批流水线的目标架构、设计原则和详细任务分解。
> 所有任务引用 conex 的实际文件路径，与现有的 `tool-executor.ts`、`agent-session-loop.ts`、
> `decision-engine` 自洽。

---

## 1. 设计原则

### 原则一：单一 Hook 链，统一拦截点

所有工具生命周期的拦截逻辑（审批、审计、日志、变形、过滤）必须通过**一个统一的
Hook Chain** 表达，而不是平铺在 session-loop 的三个独立调用点（`composedHooks`、
`resolvePermission`、`materializeLargeToolOutput`）中。

**推论**：
- `AgentHooks.beforeToolCall`、`ToolMiddleware.beforeExecute`、`resolvePermission`
  三者的职责合并为 `ToolHook.beforeExecute`。
- `MiddlewarePipeline` 成为唯一的执行前/执行后处理管线。
- `AgentHooks` 退化为只保留轮次级 Hook（`shouldStopAfterTurn`、`prepareNextTurn`、
  `onError`），工具级 Hook 全部由 `ToolHook` 接管。

### 原则二：审批是流水线，非函数调用

审批必须从 `resolvePermission` 方法中拆分为独立的流水线组件。这个流水线包含多个
阶段（自动判定 → 审批缓存 → 轻量确认 → 链式审批 → 回填结果），每个阶段可以独立
扩展、独立测试、独立切换。

**推论**：
- `ApprovalPipeline` 类接受 `PermissionRequest` 输入，产出 `PermissionDecision` 输出，
  中间过程对 session-loop 完全透明。
- 审批缓存（intentKey）驻留在 `ApprovalPipeline` 内部，不扩散到 session-loop。
- 异步审批场景（用户不在线）由 `ApprovalPipeline` 管理「挂起」状态，session-loop
  通过 Promise 等待最终决策。

### 原则三：执行策略可组合、可折叠

工具执行策略（超时、重试、并发控制、降级）不是平铺的字段，而是可组合的
`ExecutionStrategy` 对象。策略可以被继承（工具级覆盖默认）、组合（超时 + 重试）、
条件选择（根据模式选择不同策略）。

**推论**：
- `ToolExecutorOptions` 拆分为 `ExecutionStrategy` 类型，工具可以声明自己的策略。
- 策略的组合使用责任链（Chain of Responsibility）模式，不在 executor 中 switch-case。
- 策略的默认值由工具类型（category）自动推导。

### 原则四：工具可见性先于工具审批

在模型看到工具之前就过滤掉不该看到的工具，而不是等模型调用后再拒绝。这个原则
可以显著减少无效工具调用、提升用户体验（模型不会写出会被拒绝的代码）。

**推论**：
- `mode`（plan / ask / auto / full-access / unattended）决定工具 Preset。
- Preset 在 prompt-assembly 阶段生效，不在执行阶段生效。
- 对于 `ask` 和 `full-access` 模式，所有工具可见；对于 `plan` 和 `unattended` 模式，
  写操作工具被过滤。

### 原则五：上下文是连接的、类型安全的

从 session-loop 到 tool-executor 到单工具实现，上下文的传播必须是自动的、类型安全的。
`ToolExecutionContext` 与 `HookContext` 合并，`HookContext` 中的字段（`tool`、
`turnIndex`）被纳入执行上下文。

**推论**：
- `ToolExecutionContext` 从最小接口扩展为完整上下文，包含 `tool`、`turnIndex`、
  `runId`、`mode`、`providerId`、`batchId`。
- `HookContext` 不再作为独立类型存在——所有 Hook 函数直接接收 `ToolExecutionContext`。

### 原则六：可观测性是一等公民

每个工具执行的阶段（注册 → 解析 → 审批 → 执行 → 后处理 → 完成）都产生可观测的
结构化事件。这些事件既用于 UI 展示，也用于审计日志和指标聚合。

**推论**：
- 每个 Hook 点自动产生 `tool-hook-*` 事件，无需手动 emit。
- `ToolExecutionContext` 包含全局唯一的 `traceId`，串联从模型输出到工具结果的全路径。
- 工具执行耗时分阶段统计（审批耗时、排队耗时、执行耗时、后处理耗时）。

### 原则七：向后兼容，渐进迁移

所有新增的 Hook Chain 和审批流水线必须与现有路径并存至少一个发布周期。
`AgentHooks` 的调用点在迁移期间保持可用，但会标记为 deprecated。

**推论**：
- 新增的 `ToolHook` 系统不要求消费方一次性迁移。
- `MiddlewarePipeline` 先接入 `tool-executor.ts`，再通过 `agent-session-loop.ts`
  的 `ToolExecuteHook` 桥接到 session-loop。
- 现有 `resolvePermission` 方法在 `ApprovalPipeline` 就绪后标记为 deprecated。

---

## 2. 目标架构设计

### 2.1 Tool 生命周期模型

目标架构将一次工具调用定义为六个标准阶段的流水线：

```
注册（Register）
  │
  ▼
解析（Resolve）──── 输入修复、Schema 校验、参数别名解析
  │
  ▼
审批（Approve）──── 信任区评估 → 策略判定 → 审批缓存 → 链式审批
  │
  ▼
执行（Execute）──── 策略选择（超时/重试/并发）→ 单工具执行
  │
  ▼
后处理（Post）──── 输出物化、Checkpoint 录制、审计日志
  │
  ▼
完成（Complete）── 结果整合、事件发射、指标收集
```

### 2.2 Hook 链设计

Hook Chain 定义五个标准 Hook 点：

```
ToolHook.beforeResolve(tool, input, ctx)
  │  可阻止、可修改输入
  ▼
ToolHook.beforeApprove(tool, input, ctx)
  │  可追加审批要求（如 T4 必须双层确认）
  ▼
ToolHook.beforeExecute(tool, input, ctx)
  │  最终执行前拦截（可阻止）
  ▼
— — — 工具执行 — — —
  ▼
ToolHook.afterExecute(tool, input, output, ctx)
  │  可修改输出、可触发 Checkpoint
  ▼
ToolHook.afterComplete(tool, result, ctx)
  │  审计、指标、资源释放
```

每个 Hook 点的实现是一个链——多个 `ToolHook` 实现按顺序执行。早期阶段可以阻止
或修改输入输出，后期阶段不允许修改（只读审计）。

**与现有接口的映射**：

| 现有关 | 目标接口 | 迁移路径 |
|--------|----------|----------|
| `AgentHooks.beforeToolCall` | `ToolHook.beforeExecute` | 在 `BeforeExecuteHookAdapter` 中包装 |
| `AgentHooks.afterToolCall` | `ToolHook.afterExecute` | 在 `AfterExecuteHookAdapter` 中包装 |
| `ToolMiddleware.beforeExecute` | `ToolHook.beforeExecute` | 函数签名微调后自动适配 |
| `ToolMiddleware.afterExecute` | `ToolHook.afterExecute` | 同上 |
| `resolvePermission` | `ToolHook.beforeApprove` | 拆分为 ApprovalPipeline + beforeApprove |
| `materializeLargeToolOutput` | `ToolHook.afterExecute` | 由 OutputMaterializationMiddleware 接管 |

### 2.3 Preset 系统设计

Preset 系统根据 mode 和运行场景选择工具子集：

```
                    ┌──────────────────────┐
                    │  ToolPresetRegistry   │
                    │  (mode → ToolGroup[]) │
                    └──────┬───────────────┘
                           │ 按 mode 选择
                           ▼
                    ┌──────────────────────┐
                    │  ToolGroup           │
                    │  - id: string        │
                    │  - tools: AgentTool[]│
                    │  - filter:           │
                    │    (tool, ctx)→bool  │
                    └──────┬───────────────┘
                           │ 按 filter 过滤
                           ▼
                    ┌──────────────────────┐
                    │  可见工具集           │
                    │  → prompt-assembly   │
                    │  → provider          │
                    └──────────────────────┘
```

**模式映射表**：

| mode | 可见 Preset | 自动审批范围 |
|------|------------|--------------|
| `plan` | 只读组（read + list + search + grep） | T0 自动，T1+ 不可见（不是拒绝，是不可见） |
| `ask` | 全部组 | T0/T2 自动，T1/T3 需确认，T4 拒绝 |
| `auto` | 全部组 | T0/T2 自动，T1/T3 需确认，T4 拒绝 |
| `full-access` | 全部组（含危险组） | T0-T3 自动，T4 需确认 |
| `unattended` | 只读组 + 自动批处理组 | T0/T2 自动，T1/T3/T4 拒绝 |

**Preset 不是硬编码的**：第三方可以通过 `ToolPresetRegistry.registerPreset()` 注册
自定义 Preset。系统内置 Preset 和第三方 Preset 可以合并。

### 2.4 审批流水线设计

审批流水线 `ApprovalPipeline` 是一个独立组件，从 `agent-session-loop.ts` 的
`resolvePermission` 方法中提取：

```
PermissionRequest
  │
  ▼
┌─────────────────────────────────────────┐
│            ApprovalPipeline             │
│                                         │
│  ① TrustZone Resolver                   │
│     resolveTrustZone(tool, input)       │
│     → TrustZoneResolution               │
│                                         │
│  ② Policy Decider                       │
│     behaviorForMode(mode, zone)         │
│     → TrustBehavior                     │
│                                         │
│  ③ Intent Cache                         │
│     buildIntentKey → check cache        │
│     → cached decision | null            │
│                                         │
│  ④ Approval Router                      │
│     allow:  → return PermissionDecision  │
│     deny:   → return PermissionDecision  │
│     ask:    → ApprovalChain              │
│                                         │
│  ⑤ Approval Chain                       │
│     SingleLayerApproval                 │
│     DoubleLayerApproval                 │
│     MultiLayerApproval                  │
│     → PermissionDecision                │
│                                         │
└─────────────────────────────────────────┘
  │
  ▼
PermissionDecision
```

**关键特性**：

- **缓存层**（步骤③）根据 `intentKey` 缓存同一 run 内的审批结果，避免重复弹窗。
  缓存由 `ApprovalPipeline` 管理，不需要 session-loop 感知。
- **链式层**（步骤⑤）支持多层审批。`DoubleLayerApproval` 执行两次
  `approvalHandler.requestApproval`——第一次确认「知情」，第二次确认「执行」。
  两次之间有间隔，让用户可以在第一次确认后取消。
- **异步挂起**：如果 `approvalHandler.requestApproval` 返回一个长时间等待的
  Promise（推送通知后等待回复），`ApprovalPipeline` 可以挂起审批并返回一个
  `{ behavior: 'pending', promise: ... }` 的中间状态。session-loop 通过 `await`
  这个 promise 继续等待，而不持有 session-loop 状态机的锁。

**与现有 decision-engine 的集成**：

| 现有组件 | 集成方式 |
|----------|----------|
| `PermissionEngine`（`permission-engine.ts`） | 作为 ApprovalPipeline 的 Policy Decider 实现之一 |
| `resolveTrustZone`（`trust-zone.ts:359`） | 直接复用，内置为 TrustZone Resolver |
| `behaviorForMode`（`trust-zone.ts:508`） | 直接复用，内置为策略判定函数 |
| `buildIntentKey`（`trust-zone.ts:332`） | 直接复用，内置为缓存键生成器 |
| `HardlinePatternRegistry`（`hardline-patterns.ts`） | T4 规则继续通过 HardlineBlockRule 守卫 |

### 2.5 执行策略模型

执行策略 `ExecutionStrategy` 封装超时、重试、并发控制和降级逻辑：

```typescript
interface ExecutionStrategy {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  retryableErrors: Array<ErrorKind>;
  concurrencyLimit: number;     // 0 = unlimited
  failurePolicy: 'continue-drain' | 'cancel-siblings';
  escalationPolicy?: {          // 降级策略
    afterRetries: number;
    fallbackTool?: string;      // 降级到哪个替代工具
    fallbackInput?: JsonObject; // 降级时使用的默认输入
  };
}
```

**策略的来源优先级**：
1. 工具本身的 `inputSchema` 中的参数（如 `bash.timeoutMs`）
2. 工具注册时的 `RegistrationOptions`
3. `ToolCategory` 的默认策略（terminal 60s / filesystem 30s / network 15s / mcp 30s）
4. `ToolExecutorOptions` 的全局默认

**策略的组合**：通过 `StrategyPipeline` 将多个策略按优先级链式组合。高优先级策略
覆盖低优先级策略的对应字段。

---

## 3. 详细任务分解

### 任务 T1：ToolHook 接口定义

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/hooks/tool-hook-types.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/hooks/hook-types.ts`（删除工具级 Hook 定义） |
| **依赖** | 无 |

**当前问题**：
- `AgentHooks` 接口中混合了工具级 Hook（`beforeToolCall` / `afterToolCall`）和
  轮次级 Hook（`shouldStopAfterTurn` / `prepareNextTurn` / `onError`）。
- `ToolMiddleware` 接口定义了类似的 Hook 但命名不同（`proceed` / `block`）。

**改进策略**：

1. 新建 `tool-hook-types.ts`，定义 `ToolHook` 接口：

```typescript
export interface ToolHook {
  name: string;
  priority?: number; // 执行顺序（小优先）
  beforeResolve?(ctx: ToolHookContext): Promise<HookBeforeResolveResult>;
  beforeApprove?(ctx: ToolHookContext): Promise<HookBeforeApproveResult>;
  beforeExecute?(ctx: ToolHookContext): Promise<HookBeforeExecuteResult>;
  afterExecute?(ctx: ToolHookContext): Promise<HookAfterExecuteResult>;
  afterComplete?(ctx: ToolHookContext): Promise<HookAfterCompleteResult>;
}

export interface ToolHookContext {
  sessionId: string;
  runId: string;
  turnIndex: number;
  toolCallId: string;
  toolName: string;
  tool: AgentTool;
  input: JsonObject;
  output?: ToolOutput;
  batchId?: string;
  cwd: string;
  signal: AbortSignal;
  mode: TrustPolicyMode;
  providerId?: string;
  model?: string;
  traceId: string;
  emit(event: AgentEvent): void;
}
```

2. 在 `hook-types.ts` 中将 `AgentHooks.beforeToolCall` 和 `AgentHooks.afterToolCall`
   标记为 `@deprecated`，推荐使用新的 `ToolHook` 接口。

3. 提供 `BeforeExecuteHookAdapter` 和 `AfterExecuteHookAdapter` 桥接类，将旧的
   `AgentHooks` 实现适配为 `ToolHook`。

### 任务 T2：MiddlewarePipeline 接入执行路径

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/runtime-components/tool-executor.ts` |
| **受影响文件** | `packages/agent-runtime/src/tools/tool-middleware.ts` |
| **依赖** | 任务 T1 |

**当前问题**：
- `MiddlewarePipeline` 完全孤立，没有代码调用 `runBefore` 或 `runAfter`。
- `tool-executor.ts` 的唯一扩展点是 `ToolExecuteHook`，调用方通过它实现全部逻辑。

**改进策略**：

1. 在 `ToolExecutor` 中添加 `middlewarePipeline` 可选构造函数参数。
2. 修改 `executeSingleWithEvents` 方法，在工具执行前插入 `middlewarePipeline.runBefore()`，
   在工具执行后插入 `middlewarePipeline.runAfter()`。
3. `ToolExecuteHook` 保留为外部注入点，但默认实现使用 `MiddlewarePipeline`。
4. 迁移路径：`agent-session-loop.ts` 逐步将硬编码逻辑迁移到中间件中。

### 任务 T3：ApprovalPipeline 拆分

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/approval/approval-pipeline.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/agent-session-loop.ts` |
| **依赖** | 任务 T2 |

**当前问题**：
- `resolvePermission`（`agent-session-loop.ts:1798-1907`）耦合了策略判定、事件发射、
  审批等待、结果回填四种职责。
- 无法扩展为双层审批或异步审批。

**改进策略**：

1. 新建 `ApprovalPipeline` 类，封装完整的审批流水线：

```typescript
export class ApprovalPipeline {
  constructor(
    private readonly permissionPolicy: RuntimePermissionPolicy,
    private readonly approvalHandler: ApprovalHandler | undefined,
    private readonly trustZoneResolver: typeof resolveTrustZone,
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {}

  async decide(
    request: RuntimePermissionRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, PermissionDecision> {
    // 1. 信任区解析
    // 2. 策略判定
    // 3. 意图缓存检查
    // 4. 审批路由
    // 5. 链式审批
    // 6. 结果回填
  }

  // 缓存控制
  clearCache(): void;
  clearRunCache(runId: string): void;
}
```

2. `PreapprovalCache` 内部类：基于 `intentKey` 的 LRU 缓存，存储本 run 内的
   审批结果。
3. `ApprovalChain` 抽象：`SingleLayerApproval` / `DoubleLayerApproval` 实现。
4. 在 `AgentSessionLoop` 中将 `resolvePermission` 方法替换为 `ApprovalPipeline`
   调用，保留 AsyncGenerator 签名以兼容事件流。

### 任务 T4：ToolPresetRegistry 实现

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/tools/tool-preset-registry.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/prompt-assembly.ts` |
| **依赖** | 无 |

**当前问题**：
- 所有 mode 下所有工具全部可见，完全依赖审批做执行时拒绝。
- 模型在 `plan` 模式下也会输出 `edit` 调用，导致体验差。

**改进策略**：

1. 定义 `ToolGroup` 和 `ToolPreset` 类型：

```typescript
export interface ToolGroup {
  id: string;
  label: string;
  tools: AgentTool[];
  categories: ToolCategory[];
  // 动态过滤函数（签入时评估）
  filter?: (tool: AgentTool, input: JsonObject) => boolean;
}

export interface ToolPreset {
  id: string;
  label: string;
  groups: ToolGroup[];
  // 可见性规则：哪些 tool group 可见
  visibleGroups: string[];
}
```

2. 内置 Preset 定义：

```typescript
const BUILTIN_PRESETS: Record<TrustPolicyMode, ToolPreset> = {
  'plan': {
    id: 'plan',
    label: '规划模式',
    groups: [READONLY_GROUP],
    visibleGroups: ['readonly'],
  },
  'ask': {
    id: 'ask',
    label: '询问模式',
    groups: [READONLY_GROUP, WORKSPACE_WRITE_GROUP, NETWORK_GROUP, DANGEROUS_GROUP],
    visibleGroups: ['readonly', 'workspace-write', 'network', 'dangerous'],
  },
  // ...
};
```

3. 在 `prompt-assembly.ts` 中，向 provider 发送工具列表前，先根据当前 mode
   和 ToolPreset 过滤工具。
4. `ToolPresetRegistry` 支持注册自定义 Preset，覆盖内置 Preset。

### 任务 T5：增强 ToolExecutionContext

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/types.ts`（AgentTool 和执行上下文相关） |
| **受影响文件** | `packages/agent-runtime/src/agent-session-loop.ts`（上下文构造）、`packages/agent-runtime/src/runtime-components/tool-executor.ts`（上下文传播） |
| **依赖** | 任务 T1 |

**当前问题**：
- `ToolExecutionContext` 只有 5 个字段，缺少运行态信息。
- `HookContext` 与 `ToolExecutionContext` 互不兼容。

**改进策略**：

1. 在 `types.ts` 中定义扩展的 `ToolExecutionContext`：

```typescript
export interface ToolExecutionContext {
  // 基础字段（保持向后兼容）
  toolCallId: string;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  emit(update: ToolProgressUpdate): void;

  // 新增字段（可选，通过 metadata 提供）
  metadata: {
    runId?: string;
    turnIndex?: number;
    batchId?: string;
    mode?: TrustPolicyMode;
    providerId?: string;
    model?: string;
    traceId?: string;
    subagentDepth: number;
    tool?: AgentTool;              // 当前工具实例
    permissionDecision?: PermissionDecision;
  };
}
```

2. 修改 `agent-session-loop.ts` 中 `executeSingleTool` 的上下文构造，填充新增字段。
3. 修改 `tool-executor.ts` 中 `executeSingleWithEvents` 的上下文传播，自动
   从 `ToolExecuteHook` 参数中继承 `batchId`。
4. 提供 `ExportableToolExecutionContext` 辅助类型，剔除函数引用（`emit`、`signal`）
   以便序列化到事件流中。

### 任务 T6：ExecutionStrategy 抽象

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/execution/execution-strategy.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/runtime-components/tool-executor.ts`、`packages/agent-runtime/src/runtime-components/single-tool-executor.ts` |
| **依赖** | 任务 T2 |

**当前问题**：
- `ToolExecutorOptions` 平铺了超时、并行失败策略字段。
- 所有工具共享同一超时，无法按工具类别定制。

**改进策略**：

1. 定义 `ExecutionStrategy` 类型和 `StrategyPipeline`：

```typescript
export interface ExecutionStrategy {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxConcurrency: number;     // 0 = 不限制
  failurePolicy: ToolBatchFailurePolicy;
  outputByteLimit?: number;   // 输出截断阈值
}

export class StrategyPipeline {
  // 按优先级合并策略链
  static resolve(chain: ExecutionStrategy[]): ExecutionStrategy;
  // 从工具和上下文推导策略
  static forTool(tool: AgentTool, options: ToolExecutorOptions): ExecutionStrategy;
}
```

2. 在 `ToolExecutor` 中，为每个工具调用解析 `ExecutionStrategy`：
   - 优先读取 `input.timeoutMs`（工具调用级参数）
   - 其次读取工具的 `registrationOptions`
   - 再次读取该类别的默认策略
   - 最后回退到 `ToolExecutorOptions` 全局默认

3. 将 `SingleToolExecutor` 的超时逻辑改为接受 `ExecutionStrategy` 参数。

### 任务 T7：审批缓存（PreapprovalCache）

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/approval/preapproval-cache.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| **依赖** | 任务 T3 |

**当前问题**：
- 同一意图的审批在 run 内重复弹窗。
- `buildIntentKey` 已定义但从未用于缓存。

**改进策略**：

1. 实现 `PreapprovalCache`：

```typescript
export class PreapprovalCache {
  private readonly cache = new Map<string, CachedApproval>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  get(intentKey: string): PermissionDecision | undefined;
  set(intentKey: string, decision: PermissionDecision): void;
  invalidate(intentKey: string): void;
  clear(): void;
}

interface CachedApproval {
  decision: PermissionDecision;
  timestamp: number;
  ttlMs: number;
}
```

2. 在 `ApprovalPipeline.decide()` 中，策略判定后（步骤②）检查缓存，命中则跳过
   审批路由。
3. 缓存的 TTL 由 `trustZone` 决定：T0 永久缓存，T1 缓存 5min，T2/T3 缓存 1min，
   T4 不缓存。
4. run 结束时自动 `clear()`。

### 任务 T8：审批链式实现（DoubleLayerApproval）

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/approval/approval-chain.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| **依赖** | 任务 T3、T7 |

**当前问题**：
- 没有双层确认机制。T4 操作（hardline 命令）与 T3 操作的审批流程相同。
- `resolvePermission` 无法表达「先确认知情，再确认执行」的两步流程。

**改进策略**：

1. 定义 `ApprovalChain` 抽象基类和两种实现：

```typescript
export abstract class ApprovalChain {
  abstract execute(
    request: PermissionRequest,
    handler: ApprovalHandler,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, PermissionDecision>;
}

export class SingleLayerApproval extends ApprovalChain {
  async execute(request, handler, signal) {
    // 标准确认：一次弹窗
  }
}

export class DoubleLayerApproval extends ApprovalChain {
  async execute(request, handler, signal) {
    // 第一次：知情确认弹窗
    // 间隔（用户可在此取消）
    // 第二次：执行确认弹窗
    // 两次都通过才 allow
  }
}
```

2. `ApprovalPipeline` 根据 `TrustZone` 选择 `ApprovalChain`：
   - T0-T2：`SingleLayerApproval`
   - T3：`SingleLayerApproval`（但提示风险）
   - T4：`DoubleLayerApproval`

3. 协议层（`packages/agent-daemon/src/protocol/validators/run.ts`）添加
   `requiresDoubleConfirm` 字段，使桌面客户端可以展示双阶段审批 UI。

### 任务 T9：可观测性集成

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/observability/tool-telemetry.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/runtime-components/tool-executor.ts`、`packages/agent-runtime/src/hooks/tool-hook-types.ts` |
| **依赖** | 任务 T1 |

**当前问题**：
- 没有 Trace ID、Span ID 跨上下文传播。
- 工具执行耗时只有总 `durationMs`，没有分阶段统计。

**改进策略**：

1. `ToolTelemetryHook` 实现 `ToolHook` 接口，在五个 Hook 点记录耗时：

```typescript
export class ToolTelemetryHook implements ToolHook {
  name = 'telemetry';
  priority = 100; // 最后执行

  beforeResolve(ctx: ToolHookContext): Promise<...> {
    // 记录 resolve 开始时间
  }
  afterExecute(ctx: ToolHookContext): Promise<...> {
    // 计算审批耗时、排队耗时、执行耗时
    // emit tool-metrics 事件
  }
}
```

2. 在 `ToolHookContext` 中添加 `traceId` 字段，使用 `crypto.randomUUID()` 生成。
3. 工具执行完成后，自动产生 `tool-metrics` 事件：

```typescript
interface ToolMetricsEvent extends AgentEvent {
  type: 'tool-metrics';
  sessionId: string;
  toolCallId: string;
  toolName: string;
  traceId: string;
  stages: {
    approval: number;   // 审批耗时 (ms)
    queue: number;      // 排队耗时 (ms)
    execution: number;  // 执行耗时 (ms)
    postProcess: number; // 后处理耗时 (ms)
    total: number;      // 总耗时 (ms)
  };
  outputByteSize: number;
  isError: boolean;
}
```

4. 在 `ToolExecutor` 的可选配置中启用遥测采样率（与现有 `sampleRate` 字段对齐）。

### 任务 T10：Tool Hook 链在 session-loop 中接入

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/agent-session-loop.ts` |
| **受影响文件** | `packages/agent-runtime/src/runtime-components/tool-executor.ts`（ToolExecuteHook 改造） |
| **依赖** | 任务 T1、T2、T3、T5 |

**当前问题**：
- `executeSingleTool` 方法（`agent-session-loop.ts:1421-1785`）包含了六种职责，
  但没有通过 Hook 链统一。
- 三套扩展机制（`composedHooks`、`resolvePermission`、`materializeLargeToolOutput`）
  在同一方法中按顺序调用但互不感知。

**改进策略**：

1. 修改 `ToolExecuteHook` 的实现方式：不再由 `AgentSessionLoop.executeSingleTool` 实现，
   而是创建一个包装函数，将 `ApprovalPipeline` + `MiddlewarePipeline` + 硬编码逻辑
   组合为一个 `ToolExecuteHook`。

2. 新的 `ToolExecuteHook` 的职责链：

```
executeSingleWithEvents 中的流程：
  ① 工具查找 + 输入修复 + Schema 校验（保留现有逻辑）
  ② beforeApprove Hook 链（ToolHook.beforeApprove）
  ③ ApprovalPipeline.decide()（替代 resolvePermission）
  ④ beforeExecute Hook 链（MiddlewarePipeline.runBefore）
  ⑤ SingleToolExecutor.execute()（保留现有）
  ⑥ afterExecute Hook 链（MiddlewarePipeline.runAfter）
  ⑦ 结果格式化 + tool-end 事件（保留现有）
```

3. 保留 `composedHooks` 的调用，但通过适配器桥接到 Hook 链中，而不是直接调用。

### 任务 T11：ToolRegistry 注册时机统一

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/tools/tool-definition.ts`（ToolRegistry 增强） |
| **受影响文件** | `packages/agent-runtime/src/mcp-lifecycle.ts`、`packages/agent-runtime/src/local-tools/index.ts` |
| **依赖** | 任务 T4 |

**当前问题**：
- 本地工具通过 `createLocalWorkspaceTools` 工厂函数创建为 `AgentTool[]`。
- MCP 工具通过 `McpLifecycleManager.listTools()` 拉取。
- 扩展工具通过 `ExtensionRegistry` 收集。
- 三种来源的工具在 `AgentRuntimeOptions.tools` 中合并。

**改进策略**：

1. 在 `ToolRegistry` 中添加 `source` 字段记录工具来源：

```typescript
export type ToolSourceKind = 'local' | 'mcp' | 'extension' | 'external';

export class ToolRegistry {
  // register 方法不再只接受 name，添加 source 参数
  register(def: ToolDefinition, options?: ToolRegistrationOptions & {
    source?: ToolSourceKind;
    sourceId?: string;   // MCP server name 或 extension id
  }): RegisteredTool;
}
```

2. 提供 `ToolRegistry.fromTools()` 工厂方法，从 `AgentTool[]` 批量注册并标记来源。
3. MCP server 的工具刷新时自动更新 `ToolRegistry` 中的对应工具集。

### 任务 T12：Model-Tool-Routing 适配层

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/provider/model-tool-adapter.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/prompt-assembly.ts`、`packages/agent-runtime/src/provider-openai-compatible.ts` |
| **依赖** | 任务 T4 |

**当前问题**：
- 工具 Schema 对所有模型一视同仁。
- OpenAI 的 `strict` 模式要求 JSON Schema 严格类型化，Anthropic 不要求。
- 某些模型不支持同时发送过多工具（工具数上限不同）。

**改进策略**：

1. 定义 `ModelCapability` 类型描述模型能力：

```typescript
export interface ModelCapability {
  maxTools: number;
  supportStrictSchema: boolean;
  supportParallelToolCalls: boolean;
  supportToolCallIdDedup: boolean;
  maxNestedObjectDepth: number;
}
```

2. 实现 `ModelToolAdapter` 根据模型能力剪裁工具 Schema：

```typescript
export class ModelToolAdapter {
  adapt(tools: AgentTool[], capability: ModelCapability): AgentTool[] {
    // 1. 按 maxTools 截断（优先保留核心工具）
    // 2. 按 maxNestedObjectDepth 展平嵌套 Schema
    // 3. 如不支持 parallel，所有工具标记为 exclusive
    // 4. strict schema 转换（OpenAI）
    return adaptedTools;
  }
}
```

3. 在 `prompt-assembly.ts` 的 `assemblePromptForProvider` 中调用 `ModelToolAdapter`。
4. 模型能力来源：`prompt-assembly.metadata` 中的 `providerFamily` 推断。

### 任务 T13：审批事件持久化

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/approval/approval-recorder.ts`（新建） |
| **受影响文件** | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| **依赖** | 任务 T3 |

**当前问题**：
- 审批决定只在内存中存在。
- `permissionPolicy.recordDecision` 是可选方法，没有记录到 session store。

**改进策略**：

1. 实现 `ApprovalRecorder`：

```typescript
export class ApprovalRecorder implements ToolHook {
  name = 'approval-recorder';
  afterComplete(ctx: ToolHookContext): Promise<void> {
    // 将审批结果持久化到 session store
    // 包括：时间、工具名、输入摘要、信任区、审批模式、决策行为、原因
  }
}
```

2. `ApprovalRecord` 结构：

```typescript
interface ApprovalRecord {
  sessionId: string;
  runId: string;
  turnIndex: number;
  timestamp: string;
  toolName: string;
  toolCallId: string;
  inputSummary: string;
  trustZone: TrustZone;
  mode: TrustPolicyMode;
  behavior: TrustBehavior;
  decision: 'allow' | 'deny' | 'expired';
  reason: string;
  cached: boolean;
  durationMs: number;
}
```

3. 通过 `SessionRecorder.recordEvent` 写入 session store，类似 checkpoint 记录。

### 任务 T14：MCP 工具生命周期 Hook

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/mcp-lifecycle.ts` |
| **受影响文件** | `packages/agent-runtime/src/hooks/tool-hook-types.ts` |
| **依赖** | 任务 T1 |

**当前问题**：
- `McpServerController` 的状态变化不通知 `ToolHook` 链。
- MCP 工具不可用时，`executeManagedTool` 抛出 `McpLifecycleError`，但没有过
  Hook 链的降级路径。

**改进策略**：

1. 在 `McpServerController` 中添加状态变化事件的订阅点，将 `server-state` 事件
   广播到 Hook 系统。
2. 定义一个 `ToolHook.onMcpStateChange` 可选方法（或通过现有 `afterComplete`
   检查结果中是否包含 `McpLifecycleError`）。
3. MCP 工具的降级策略：当 MCP 工具不可用时，`ToolHook.beforeExecute` 根据
   `ExecutionStrategy.escalationPolicy` 选择降级方案（改用本地替代工具 / 返回
   友好错误 / 等待后重试）。

### 任务 T15：会话恢复场景的 Hook Chain 初始化

| 属性 | 值 |
|------|-----|
| **目标文件** | `packages/agent-runtime/src/runtime-factory.ts`（确定其中位置后修改） |
| **受影响文件** | `packages/agent-runtime/src/agent-session-loop.ts` |
| **依赖** | 任务 T2、T3、T10 |

**当前问题**：
- 会话恢复时（`resumeSession: true`），`AgentSessionLoop` 重建所有组件，但 Tools
  和审批状态丢失（特别是审批缓存）。

**改进策略**：

1. 在 `AgentRuntimeOptions` 中添加 `toolHookChain` 可选字段。
2. `agent-session-loop.ts` 的构造函数中，如果 `options.toolHookChain` 存在则使用，
   否则按默认配置构建（旧路径）。
3. 恢复后的 `ApprovalPipeline` 的 `PreapprovalCache` 初始化为空（不恢复缓存以
   保证安全）。

---

## 4. 任务间逻辑依赖关系

```
T1 (ToolHook 接口)
  ├─→ T2 (MiddlewarePipeline 接入) ──→ T10 (session-loop 接入)
  ├─→ T5 (ExecutionContext 增强) ──→ T10
  ├─→ T9 (可观测性) ────────────→ T10
  ├─→ T14 (MCP Hook) ──────────→ T10
  └─→ T13 (审批持久化) ─────────→ T3

T3 (ApprovalPipeline)
  ├─→ T7 (审批缓存) ────────────→ T10
  └─→ T8 (双层审批) ────────────→ T10

T4 (ToolPreset)
  ├─→ T11 (注册时机统一) ───────→ T10
  └─→ T12 (Model-Tool-Routing)  → T10

T6 (ExecutionStrategy) ──────────────→ T10

T15 (恢复场景) ──────────────────────→ T10 (最终验证)
```

**实现顺序推荐**：

1. 第一阶段（核心抽象）：T1 → T2 → T3
2. 第二阶段（策略与 Preset）：T4 → T5 → T6 → T7
3. 第三阶段（扩展实现）：T8 → T9 → T11 → T12
4. 第四阶段（集成收尾）：T10 → T13 → T14 → T15

---

## 5. 与现有系统的集成点

### 5.1 与 `ToolExecutor` 的集成

现有 `ToolExecutor`（`packages/agent-runtime/src/runtime-components/tool-executor.ts`）

**集成方式**：
- `ToolExecutor` 新增可选参数 `middlewarePipeline?: MiddlewarePipeline`。
- 当提供 `middlewarePipeline` 时，`executeSingleWithEvents` 内部在工具执行前后
  调用 `runBefore` / `runAfter`。
- `ToolExecuteHook` 签名保持不变（向后兼容），但默认实现改为使用
  `MiddlewarePipeline`。
- `PartitionBatch` 和 `isFullyParallel` 逻辑不受影响——分区在 Hook 链之前。

### 5.2 与 `AgentSessionLoop` 的集成

现有 `AgentSessionLoop`（`packages/agent-runtime/src/agent-session-loop.ts`）

**集成方式**：
- `executeSingleTool` 中的 `resolvePermission` 调用替换为 `ApprovalPipeline.decide`。
- `executeSingleTool` 中的 `composedHooks.beforeToolCall` / `afterToolCall` 替换为
  `MiddlewarePipeline.runBefore` / `runAfter`。
- `executeSingleTool` 中的 `materializeLargeToolOutput` 替换为
  `OutputMaterializationMiddleware`。
- `executeSingleTool` 中的 `recordToolCheckpointEvents` 替换为 `CheckpointMiddleware`。
- 状态机（`createAgentSessionMachine`）不受影响——Hook 链在 executing-tools 状态
  内部处理，不改变外部状态转移。

### 5.3 与 `@crish/decision-engine` 的集成

现有组件包括 `PermissionEngine`、`trust-zone.ts`、`command-classifier.ts`。

**集成方式**：
- `ApprovalPipeline` 直接复用 `resolveTrustZone` 和 `behaviorForMode`，不做修改。
- `PermissionEngine` 作为 `ApprovalPipeline` 的默认 Policy Decider，也不做修改。
- `HardlineBlockRule` 继续作为权限规则链的第一条。
- `ToolPresetRegistry` 依赖于 `TrustPolicyMode`——mode 值决定了 Preset 选择。

**不修改** `decision-engine` 中的任何文件。所有新增逻辑在 `agent-runtime` 中实现，
通过依赖已有类型的方式与 `decision-engine` 集成。

### 5.4 与 MCP 工具生命周期的集成

现有 `McpLifecycleManager` 和 `McpServerController`（`packages/agent-runtime/src/mcp-lifecycle.ts`）。

**集成方式**：
- MCP 工具通过 `ToolRegistry` 注册（标记 `source='mcp'`, `sourceId='server-name'`）。
- `McpServerController` 的 `tools-refreshed` 事件触发 `ToolRegistry` 的更新。
- MCP 工具不可用时，`ToolHook.beforeExecute` 可以根据 `ExecutionStrategy` 中的
  降级策略选择替代方案。
- 不修改 `McpLifecycleManager` 的核心状态机逻辑。

---

## 6. 验证标准

### 6.1 功能验证

| 验证项 | 验证方法 | 预期结果 |
|--------|----------|----------|
| Tool Hook 链正确拦截 | 注册 `beforeExecute` hook，返回 `proceed: false` | 工具执行被阻止，返回 block 结果 |
| 审批流水线正确决策 | 构造已知策略的 PermissionRequest | 决策与 TRUST_ZONE_MATRIX 一致 |
| 审批缓存生效 | 两次调用同一 intentKey 的工具 | 第二次不弹窗，自动 allow |
| 双层审批 | T4 操作 | 第一次确认后出现第二次确认 |
| Preset 过滤 | plan 模式下编辑工具 | edit/write 不在 tools 数组中 |
| ExecutionStrategy 按工具生效 | 不同工具设不同 timeoutMs | 每个工具按自己的超时执行 |
| 审批持久化 | 审批记录写入 session store | run 结束后可查到全量审批历史 |

### 6.2 兼容性验证

| 验证项 | 验证方法 | 预期结果 |
|--------|----------|----------|
| 不配置 Hook Chain | 不传 `middlewarePipeline` | `ToolExecutor` 行为完全不变 |
| 旧 ExtensionRegistry | 注册旧 `AgentHooks` | 通过适配器桥接到新 Hook 链 |
| 无 approvalHandler | 不配置审批处理器 | `ask` 策略默认安全拒绝（无悬挂） |
| MCP 无变化 | 不传 `toolHookChain` | MCP 工具执行路径不变 |

### 6.3 错误场景验证

| 验证项 | 验证方法 | 预期结果 |
|--------|----------|----------|
| 审批超时 | `approvalHandler` 不回复 | 返回 `deny` + `approval_expired` |
| 缓存击穿 | 缓存满后新审批 | 淘汰最旧缓存条目，正常审批 |
| Hook 链异常 | `beforeExecute` 抛出异常 | 触发 `onError`，不阻塞执行线程 |
| Preset 为空 | 所有工具被过滤 | 模型收到空工具列表，只输出文本 |

---

## 7. 风险评估

### 7.1 兼容性风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 现有 Extension 依赖 `AgentHooks.beforeToolCall` | 中 | 提供桥接适配器，标记为 deprecated 但不立即移除 |
| 旧审批流程的 override | 低 | `ApprovalPipeline` 支持自定义 `PolicyDecider` 函数 |
| 序列化变化影响事件流 | 低 | 新增字段都是可选的，旧客户端忽略未知字段 |

### 7.2 性能风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| Hook 链增加执行前延迟 | 低 | 内置中间件都是同步/微秒级操作 |
| 审批缓存增加内存 | 低 | 默认 100 条 LRU 条目，< 50KB |
| Preset 过滤增加 prompt-assembly 耗时 | 低 | 过滤操作为 O(n)，工具数通常 < 60 |

### 7.3 复杂度风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| Hook 链优先级冲突 | 中 | `priority` 字段明确排序，小值优先 |
| 审批流水线路径过多 | 中 | 默认为简单的 `SingleLayerApproval`，双层只在 T4 启用 |
| 三套系统并存过渡期混乱 | 高 | 严格执行「新实现验证后旧实现才标记 deprecated」的策略 |

### 7.4 安全风险

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 审批缓存可能绕过安全策略 | 高 | T4 操作永不缓存；缓存 TTL 由 trustZone 决定 |
| Preset 不当暴露危险工具 | 高 | 默认 Preset 列表经过代码审查；第三方自定义 Preset 需
      用户确认 |
| Hook 链自定义中间件可能绕过审批 | 中 | 审批中间件必须在权限中间件之后注册，
      优先级机制保证 |

---

## 附录 A：文件变更清单

| 任务 | 新增文件 | 修改文件 |
|------|----------|----------|
| T1 | `packages/agent-runtime/src/hooks/tool-hook-types.ts` | `packages/agent-runtime/src/hooks/hook-types.ts` |
| T2 | — | `packages/agent-runtime/src/runtime-components/tool-executor.ts` |
| T3 | `packages/agent-runtime/src/approval/approval-pipeline.ts` | `packages/agent-runtime/src/agent-session-loop.ts` |
| T4 | `packages/agent-runtime/src/tools/tool-preset-registry.ts` | `packages/agent-runtime/src/prompt-assembly.ts` |
| T5 | — | `packages/agent-runtime/src/types.ts`、`packages/agent-runtime/src/agent-session-loop.ts` |
| T6 | `packages/agent-runtime/src/execution/execution-strategy.ts` | `packages/agent-runtime/src/runtime-components/tool-executor.ts` |
| T7 | `packages/agent-runtime/src/approval/preapproval-cache.ts` | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| T8 | `packages/agent-runtime/src/approval/approval-chain.ts` | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| T9 | `packages/agent-runtime/src/observability/tool-telemetry.ts` | `packages/agent-runtime/src/runtime-components/tool-executor.ts` |
| T10 | — | `packages/agent-runtime/src/agent-session-loop.ts` |
| T11 | — | `packages/agent-runtime/src/tools/tool-definition.ts` |
| T12 | `packages/agent-runtime/src/provider/model-tool-adapter.ts` | `packages/agent-runtime/src/prompt-assembly.ts` |
| T13 | `packages/agent-runtime/src/approval/approval-recorder.ts` | `packages/agent-runtime/src/approval/approval-pipeline.ts` |
| T14 | — | `packages/agent-runtime/src/mcp-lifecycle.ts` |
| T15 | — | `packages/agent-runtime/src/runtime-factory.ts` |

---

## 附录 B：类型引用索引

本文档引用的项目类型定义位置：

| 类型 | 文件路径 |
|------|----------|
| `AgentTool` | `packages/agent-runtime/src/types.ts:21-34` |
| `AgentHooks` | `packages/agent-runtime/src/hooks/hook-types.ts:103-137` |
| `HookContext` | `packages/agent-runtime/src/hooks/hook-types.ts:25-42` |
| `TurnContext` | `packages/agent-runtime/src/hooks/hook-types.ts:51-70` |
| `ErrorContext` | `packages/agent-runtime/src/hooks/hook-types.ts:79-88` |
| `ToolMiddleware` | `packages/agent-runtime/src/tools/tool-middleware.ts:47-80` |
| `MiddlewarePipeline` | `packages/agent-runtime/src/tools/tool-middleware.ts:342-424` |
| `ToolRegistry` | `packages/agent-runtime/src/tools/tool-definition.ts:71-147` |
| `RegisteredTool` | `packages/agent-runtime/src/tools/tool-definition.ts:33-63` |
| `ToolExecutor` | `packages/agent-runtime/src/runtime-components/tool-executor.ts:125-544` |
| `ToolExecuteHook` | `packages/agent-runtime/src/runtime-components/tool-executor.ts:61-68` |
| `ToolExecutionContext` | `@crish/shared-types`（在 `agent-session-loop.ts:1604-1623` 构建） |
| `RuntimePermissionRequest` | `packages/agent-runtime/src/types.ts:94-102` |
| `RuntimePermissionPolicy` | `packages/agent-runtime/src/types.ts:104-107` |
| `PermissionEngine` | `packages/decision-engine/src/permission-engine.ts:4-22` |
| `TrustZone` | `packages/decision-engine/src/trust-zone.ts:20` |
| `TrustPolicyMode` | `packages/decision-engine/src/trust-zone.ts:25-31` |
| `TrustBehavior` | `packages/decision-engine/src/trust-zone.ts:22` |
| `TRUST_ZONE_MATRIX` | `packages/decision-engine/src/trust-zone.ts:87-123` |
| `resolveTrustZone` | `packages/decision-engine/src/trust-zone.ts:359-502` |
| `behaviorForMode` | `packages/decision-engine/src/trust-zone.ts:508-521` |
| `buildIntentKey` | `packages/decision-engine/src/trust-zone.ts:332-351` |
| `McpLifecycleManager` | `packages/agent-runtime/src/mcp-lifecycle.ts:708-1088` |
| `McpServerController` | `packages/agent-runtime/src/mcp-lifecycle.ts:231-706` |
| `ProviderCallGateway` | `packages/agent-runtime/src/runtime-components/provider-call-gateway.ts:65-304` |
| `ExtensionRegistry` | `packages/agent-runtime/src/hooks/extension-registry.ts` |
| `AgentSessionLoop` | `packages/agent-runtime/src/agent-session-loop.ts:285-2269` |
| `ApprovalHandler` | `@crish/shared-types` |
| `PermissionRequest` | `@crish/shared-types` |
| `PermissionDecision` | `@crish/shared-types` |
