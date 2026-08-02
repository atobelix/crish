# 子计划 08：Layer H — Tool Hook 链与审批流水线

> **层级编号**：Layer H（Round 3，依赖 Layer A 类型稳定和 Layer C1 tool-executor 拆分完成后启动）
> **建议 Agent 数量**：6–8 个（按文件/模块互斥划分）
> **涉及维度**：D12（Tool Hook 链与审批流水线）
> **下游依赖方**：Layer E (State) 消费审批状态、Layer F (UI) 消费工具执行事件
> **包路径**：`packages/agent-runtime/src/hooks/`、`packages/agent-runtime/src/approval/`、`packages/agent-runtime/src/tools/`、`packages/decision-engine/src/`

> **重要**：08 的 Agent H1/H3/H8 将在 Round 3 修改 `agent-session-loop.ts`。03 的 Agent C13 也在同一 Round 修改同一文件（C2-15 ProviderRetryStrategy 提取，L790-L909 段）。为消除冲突：
> - 03 §三-F 明确要求 C13 只改 L790-L909（错误处理区）
> - 08 §四 明确要求 H1/H3/H8 只改 L130-L420（注入点区，含 resolvePermission 替换和 beforeApprove 链接）
> - 两个区域在 C1-1 拆分后位于不同的子文件（错误处理区→ recovery.ts，注入点区→ index.ts 主类）
> - 必须在 C1-1 完成拆分后才能派发 C13 和 H1/H3/H8

---

## 一、层级目标

Layer H 的核心使命是建立统一的 Tool 生命周期 Hook 链，替代当前三套并行的拦截机制，并将审批逻辑提取为独立组件：

1. **统一 Hook 链**：将 `AgentHooks.beforeToolCall`、`resolvePermission`、`ToolMiddleware` 三套并行机制合并为单条 `ToolHook` 链。工具执行的全生命周期（注册→解析→审批→执行→后处理→完成）由 6 个统一的 Hook 点覆盖。
2. **审批流水线化**：将审批逻辑从内联的 `resolvePermission` 方法（`agent-session-loop.ts:285`）提取为 `ApprovalPipeline` 独立组件。包含自动判定、审批缓存（intentKey）、链式审批三个阶段。
3. **Preset 系统**：引入 `ToolPresetRegistry` 实现按 mode（plan/ask/auto/unattended）的工具可见性控制和自动审批行为。Preset 在 prompt-assembly 阶段生效，不在执行阶段生效。
4. **执行策略组合**：将超时/重试/并发/降级策略从 `ToolExecutorOptions` 的平铺字段改为可组合的 `ExecutionStrategy` 对象，支持责任链组合。
5. **可观测性**：每个 Hook 点自动产生 `tool-hook-*` 结构化事件，包含全局唯一的 `traceId` 串联从模型输出到工具结果的全路径。

---

## 二、设计原则

### 原则 1：单一 Hook 链，统一拦截点

所有工具生命周期的拦截逻辑通过一个统一的 `ToolHook` 链表达，而不是平铺在 session-loop 的三个独立调用点（`composedHooks`、`resolvePermission`、`materializeLargeToolOutput`）中。

**推论**：`AgentHooks.beforeToolCall`、`ToolMiddleware.beforeExecute`、`resolvePermission` 三者的职责合并为 `ToolHook.beforeExecute`。`MiddlewarePipeline` 成为唯一的执行前/执行后处理管线。`AgentHooks` 退化为只保留轮次级 Hook（`shouldStopAfterTurn`、`onError`）。

### 原则 2：审批是流水线，非函数调用

审批必须是独立于 session-loop 的流水线组件，包含多个可独立扩展、独立测试的阶段。

**推论**：`ApprovalPipeline` 类接受 `PermissionRequest` 输入，产出 `PermissionDecision` 输出，中间过程对 session-loop 完全透明。审批缓存（intentKey）驻留在 `ApprovalPipeline` 内部。异步审批场景（用户不在线）由 `ApprovalPipeline` 管理"挂起"状态，session-loop 通过 Promise 等待。

### 原则 3：工具可见性先于工具审批

在模型看到工具之前就过滤掉不该看到的工具，而非等模型调用后再拒绝。

**推论**：mode（plan/ask/auto/unattended）决定工具 Preset。Preset 在 prompt-assembly 阶段生效，不在执行阶段生效。对于 `ask` 和 `full-access` 模式所有工具可见；对于 `plan` 和 `unattended` 模式写操作工具被过滤。

### 原则 4：向后兼容，渐进迁移

`AgentHooks` 保留但不推荐使用，通过适配器层将旧 Hook 映射到新 `ToolHook` 链。

**推论**：`ToolHookAdapter` 包装旧 `AgentHooks` 实例使其实现 `ToolHook` 接口。每个工具在迁移到新 Hook 链前仍能使用旧接口。`AgentHooks` 接口标记 `@deprecated` 并在一个版本后移除。

---

## 三、问题现状

### 3.1 三套并行的拦截机制

当前 `agent-session-loop.ts` 中工具执行的拦截点散布在三处：

**点 1：`composedHooks.beforeToolCall`**（`agent-session-loop.ts:395`）
```typescript
const hookResult = await this.composedHooks.beforeToolCall?.(
  toolDef,
  parsed.input,
  this.recorder
);
```

**点 2：`resolvePermission`**（`agent-session-loop.ts:285`）
```typescript
async resolvePermission(toolCall, context): PermissionDecision {
  if (this.permissionMode === "accept") return { behavior: "allow" };
  if (this.permissionMode === "reject") return { behavior: "deny" };
  // ... 混合审批决策逻辑，跨 80+ 行
}
```

**点 3：`materializeLargeToolOutput`**（`tool-executor.ts:120`）
```typescript
async materializeLargeToolOutput(result, toolCall) {
  if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
    // 单独的后处理路径
  }
}
```

三个拦截点无统一接口：`beforeToolCall` 返回修改后的 input/policy/skip，`resolvePermission` 返回 `PermissionDecision`，`materializeLargeToolOutput` 直接修改 result。session-loop 需要在三个不同位置协调它们的调用顺序。

### 3.2 审批逻辑内联

`resolvePermission` 是 `AgentSessionLoop` 的私有方法，不可被外部测试。其 80+ 行逻辑混合了规则匹配、权限模式判断、用户交互响应——这些本应是独立组件的职责。

### 3.3 工具可见性硬编码

当前工具列表在 `tool-executor.ts` 初始化时确定，不同 mode（plan/ask/auto）下的工具差异通过 `options.skipTools` 数组在 session-loop 中传递。没有声明式的 Preset 定义，新增 mode 需要修改 session-loop 代码。

---

## 四、目标架构

### 4.1 新 Hook 链架构

```
┌─────────────────────────────────────────────────────────┐
│                AgentSessionLoop                          │
│  状态机 case 'executing-tools'                           │
│            │                                            │
│            ▼                                            │
│   ┌────────────────────────────────────────────────────┐                  │
│   │                  MiddlewarePipeline                │                  │
│   │  ┌─────┐ ┌─────┐ ┌──────────────┐ ┌───────────┐  │                  │
│   │  │Hook1│→│Hook2│→│beforeApprove │→│ Approval  │→│→ beforeExecute  │
│   │  └─────┘ └─────┘ └──────────────┘ └───────────┘  │                  │
│   │              │                  │                  │
│   │              ▼                  │                  │
│   │         ExecutionStrategy       │                  │
│   │  ┌──────────────────────────┐  │                  │
│   │  │ timeout(30000) + retry(3)│  │                  │
│   │  │ + concurrent(parallel)   │  │                  │
│   │  └──────────────────────────┘  │                  │
│   │              │                  │                  │
│   │              ▼                  │                  │
│   │        tool.execute(input)      │                  │
│   │              │                  │                  │
│   │              ▼                  │                  │
│   │  ┌──────────────────────────┐  │                  │
│   │  │ afterExecute → Hook3→Hook4│  │                  │
│   │  └──────────────────────────┘  │                  │
│   └──────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 ToolHook 接口定义

```typescript
export interface ToolHook<TInput = unknown, TOutput = unknown> {
  /** 工具注册时调用，可修改工具定义或拒绝注册 */
  beforeRegister?(tool: AgentTool): AgentTool;

  /** 工具解析后、审批前调用 */
  beforeResolve?(resolution: ToolResolution, ctx: ToolExecutionContext): ToolResolution;

  /** 审批前调用，可附加风险标签、注入审批规则、修改审批行为 */
  beforeApprove?(request: PermissionRequest, context: ToolExecutionContext): BeforeApproveResult | Promise<BeforeApproveResult>;

  /** 工具执行前调用，返回拒绝则跳过执行 */
  beforeExecute?(input: TInput, ctx: ToolExecutionContext): BeforeExecuteResult;

  /** 工具执行后调用，可修改执行结果 */
  afterExecute?(result: ToolResult<TOutput>, ctx: ToolExecutionContext): ToolResult<TOutput>;

  /** 工具执行出错时调用 */
  onError?(error: Error, ctx: ToolExecutionContext): OnErrorResult;
}
```

### 4.3 ApprovalPipeline 设计

```typescript
export class ApprovalPipeline {
  constructor(private options: ApprovalPipelineOptions) {}

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    // 阶段 1: 规则匹配（alwaysAllow / alwaysDeny / alwaysAsk）
    // 阶段 2: 审批缓存（intentKey → cached decision）
    // 阶段 3: 自动审批（auto mode 下的 AI 分类器）
    // 阶段 4: 用户交互（发送审批请求到 UI）
    // 阶段 5: 拒绝跟踪（同一操作高频拒绝触发的自适应行为）
  }

  private ruleMatcher: RuleMatcher;
  private cache: ApprovalCache;
  private autoClassifier?: AutoApprovalClassifier;
  private denialTracker: DenialTracker;
}
```

### 4.4 ToolPresetRegistry

```typescript
export type ToolMode = "plan" | "ask" | "auto" | "full-access" | "unattended";

export interface ToolPreset {
  toolIds: string[];
  autoApproved: string[];
  categoryFilter?: ToolCategory[];
}

const DEFAULT_PRESETS: Record<ToolMode, ToolPreset> = {
  "plan": { toolIds: ["read_files", "search_codebase"], autoApproved: ["read_files"] },
  "ask": { toolIds: [], autoApproved: ["read_files", "search_codebase"] },
  "auto": { toolIds: [], autoApproved: ["*"] },
  "full-access": { toolIds: [], autoApproved: ["*"] },
  "unattended": { toolIds: [], autoApproved: ["*"] },
};
```

---

## 五、任务总表

| 编号 | 任务 | 目标文件/模块 | 核心问题 | 修复策略 | 前置依赖 |
|------|------|---------------|---------|---------|---------|
| H-1 | 定义统一 `ToolHook` 接口 | `hooks/tool-hook-types.ts`（新建） | 三套并行拦截机制互不通信 | 定义 5 个 Hook 点的 `ToolHook` 接口 | Layer A 类型稳定 |
| H-2 | 创建 `MiddlewarePipeline` | `hooks/middleware-pipeline.ts`（新建） | tool-executor 无中间件概念 | 责任链模式串联多个 `ToolHook` 实现 | H-1 |
| H-3 | 提取 `ApprovalPipeline` | `approval/approval-pipeline.ts`（新建） | 审批逻辑内联于 session-loop 私有方法 | 独立为可测试的 `ApprovalPipeline` 组件 | H-1, C1-9 |
| H-4 | 审批缓存机制 | `approval/approval-cache.ts`（新建） | 同一操作反复请求审批 | intentKey 缓存，可配置 TTL | H-3 |
| H-5 | 链式审批支持 | `approval/chain-approval.ts`（新建） | 子审批等待父审批结果 | 父审批 resolve 后自动触发挂起的子审批 | H-3 |
| H-6 | `ToolPresetRegistry` | `tools/tool-preset-registry.ts`（新建） | 工具可见性硬编码 | 声明式 Preset + mode→preset 映射 | 无 |
| H-7 | `AgentHooks` 适配器 | `hooks/tool-hook-adapter.ts`（新建） | 已有代码依赖旧接口 | 旧 Hook 调用适配到新 `ToolHook` 接口 | H-1 |
| H-8 | `ToolExecutionContext` 增强 | `runtime-components/tool-executor.ts` | 缺 traceId/runId/mode | 添加 `traceId/runId/batchId/mode/providerId` | C1-9 |
| H-9 | `ExecutionStrategy` 组合 | `runtime-components/execution-strategy.ts`（新建） | 超时/重试为平铺字段 | 可组合策略对象 | 无 |
| H-10 | 可观测性事件发射 | `hooks/tool-hook-observability.ts`（新建） | 工具事件散落多处 | 每个 Hook 点自动发射结构化事件 | H-1 |
| H-11 | `AgentHooks` 废弃标记 | `hooks/agent-hooks.ts` | 旧接口可能被误用 | `@deprecated` + 迁移文档 | H-7 |
| H-12 | 审批与 TrustZone 集成 | `decision-engine/src/permissions.ts` | 未利用 TrustZone | `ApprovalPipeline.decide()` 引用 `TRUST_ZONE_MATRIX` | H-3 |

---

## 六、Agent 分配

| Agent | 独占文件 | 不得修改 |
|-------|---------|---------|
| H1 | `hooks/tool-hook-types.ts`, `hooks/middleware-pipeline.ts` | `approval/`, `tools/` |
| H2 | `approval/*` 全部文件 | `hooks/` |
| H3 | `tools/tool-preset-registry.ts`, `runtime-components/prompt-assembly.ts`（新增授权） | 全部其他文件 |
| H4 | `runtime-components/tool-executor.ts`（仅 ExecutionContext + ExecutionStrategy） | `hooks/`, `approval/` |
| H5 | `hooks/tool-hook-observability.ts`, `hooks/agent-hooks.ts` | `approval/` |
| H6 | `decision-engine/src/permissions.ts` | 全部 agent-runtime 文件 |

> **H3 修改范围说明**：H3 对 `prompt-assembly.ts` 的修改限于：
> 1. 在 prompt-assembly.ts 中注入 `ToolPresetRegistry.getPreset(mode)` 调用，按 mode 过滤工具列表
> 2. 不修改 prompt-assembly.ts 的核心消息构建逻辑
> 3. 修改点仅限工具列表注入位置（约 20 行）

---

## 七、验证标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| V-H1 | ToolHook 接口 | `grep "implements ToolHook"` | ≥3 个实现 |
| V-H2 | MiddlewarePipeline | 单元测试 | 5 个 Hook 点的串联/中断行为正确 |
| V-H3 | ApprovalPipeline 独立 | 无 `agent-session-loop` 引用 | 可独立实例化 |
| V-H4 | 审批缓存 | 相同 intentKey 不触发二次交互 | 命中率测试通过 |
| V-H5 | Preset 切换 | 不同 mode 下工具列表不同 | `plan` 不包含 `bash` |
| V-H6 | 向后兼容 | 已有测试全部通过 | `npm test` 零回归 |

---

## 八、风险评估

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| ToolHook 接口变更影响已有插件 | 中 | 高 | 适配器层（H-7）保持 `AgentHooks` 兼容 |
| 审批流水线增加执行延迟 | 低 | 中 | `ApprovalPipeline` 自动判定阶段有超时兜底（200ms） |
| Preset 系统与现有 mode 冲突 | 中 | 中 | Preset 初始映射为当前 mode 行为 exact 复刻，只增不改 |
| H-8 修改 `tool-executor.ts` 与 C1-9 重叠 | 高 | 高 | 执行顺序：C1-9 提取 Options → H-8 叠加 ExecutionContext |
