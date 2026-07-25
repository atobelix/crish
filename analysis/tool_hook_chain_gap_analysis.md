# Tool Hook 链与审批流水线 — 现状分析与差距识别

> 本文档是 conex 修复方案（docs/crish_desktop_architectural_remediation_plan/）缺失的
> 「Tool Hook 链与审批流水线」块的差距分析。

---

## 1. 执行摘要

conex 的 Tool 系统经历了两次重要的架构演进——从 Layer 1 的 `runtime.ts` 双层循环到
Layer 2 的 `agent-session-loop.ts` 单状态机，再到 Layer 3 的 `tool-executor.ts` 拆分与
`ToolMiddleware` 抽象。每一次演进都引入了正确的设计方向，但始终没有构建**完整的、
跨层的 Tool Hook 链与审批流水线**。

当前系统中存在三个平行的（且部分重叠的）Tool 拦截/扩展机制：

- **ExtensionRegistry + AgentHooks**（`packages/agent-runtime/src/hooks/`）：
  定义了 `beforeToolCall` / `afterToolCall` 生命周期钩子，但在 `agent-session-loop.ts`
  的实现中仅用于诊断和日志场景，且调用点在 `executeSingleTool` 方法内部——远在
  `ToolExecutor` 层面之下，无法表达批量层面的拦截。

- **ToolMiddleware + MiddlewarePipeline**（`packages/agent-runtime/src/tools/tool-middleware.ts`）：
  定义了更细粒度的 `beforeExecute` / `afterExecute` 中间件接口，并提供了
  `PermissionMiddleware`、`CheckpointMiddleware`、`OutputMaterializationMiddleware`
  三个内置实现。但 `MiddlewarePipeline` **没有接入任何实际的执行路径**——
  `tool-executor.ts` 和 `agent-session-loop.ts` 均未调用它。它是一段孤立的代码。

- **agent-session-loop.ts 的硬编码 Hook 调用**：
  `executeSingleTool` 方法内部有 `composedHooks.beforeToolCall` 和
  `composedHooks.afterToolCall` 调用点——但它们与 `ToolMiddleware` 系统完全独立，
  不共享接口、不共享事件流。Hook 的返回值直接影响工具执行（block / modifyInput / modifyOutput），
  但没有任何标准化管线将这些决策串联起来。

这三条路径的存在说明系统理解到了「工具执行需要多层拦截」的需求，但没有将它们整合为
单一的、全生命周期的 Hook 链。更严重的是，**审批流水线完全在 session-loop 内部实现**，
没有抽象为可复用、可测试的审批决策管线——`resolvePermission` 方法同时代理策略判定、
人工审批广播、超时等待和结果回填，耦合了四种职责。

### 解决方向

需要构建一个统一的 **Tool Hook Chain**，将以下六个阶段形式化为标准的生命周期 Hook 点：

1. **注册阶段**（Registration）— 工具来源管理、Preset 过滤、模型能力匹配
2. **解析阶段**（Resolution）— 输入修复、Schema 校验、参数别名解析
3. **审批阶段**（Approval）— 信任区评估 → 策略判定 → 自动/人工审批 → 链式审批
4. **执行阶段**（Execution）— 并行/串行调度、超时/重试/降级策略
5. **后处理阶段**（Post-processing）— 输出物化、Checkpoint 录制、审计日志
6. **完成阶段**（Completion）— 结果整合、事件发射、指标收集

同时需要将目前的 `ExtensionRegistry` + `ToolMiddleware` + `AgentHooks` 三套机制统一为
一个可组合的 **Hook Chain** 模型，消除职责重叠与执行路径分裂。

---

## 2. 当前 Tool 系统深度评估

### 2.1 Tool 类型系统评估

**评分：7/10**

#### 2.1.1 类型层次结构

当前类型系统存在三个半层次：

| 层次 | 接口/类 | 文件 | 消费方 |
|------|---------|------|--------|
| Layer 0: 协议定义 | `ToolDefinition`（来自 `@crish/shared-types`） | 外部依赖 | 第三方扩展 |
| Layer 1: 运行时接口 | `AgentTool` | `packages/agent-runtime/src/types.ts:21-34` | tool-executor、session-loop、prompt-assembly |
| Layer 2: 注册系统 | `ToolRegistry` + `RegisteredTool` | `packages/agent-runtime/src/tools/tool-definition.ts:33-147` | ToolMiddleware、MiddlewarePipeline |
| Layer 2.5: MCP 中间层 | `McpCachedTool` | `packages/agent-runtime/src/mcp-lifecycle.ts:92-102` | McpServerController |

**问题分析：**

**P1：`AgentTool` 与 `RegisteredTool` 并存但未收敛**
`AgentTool` 仍然是多数内部消费方使用的接口——`tool-executor.ts:29` 导入 `AgentTool`，
`agent-session-loop.ts:35` 也导入 `AgentTool`，`prompt-assembly.ts` 同样使用
`AgentTool`。而 `RegisteredTool`（`tool-definition.ts:33`）是新设计的标准，显式地
实现了 `AgentTool` 接口（第 46 行的 `readonly execute` 定义了与 `AgentTool.execute`
兼容的签名）。但实际消费方没有迁移，导致：

- 两个接口之间的字段存在细微差异：`AgentTool` 有 `allowParallel?: boolean`（第 29 行），
  而 `RegisteredTool` 将此字段作为 `RegistrationOptions` 的配置项而非接口字段。
- `AgentTool` 的 `isReadOnly(input)` 是方法签名（第 31 行），`RegisteredTool` 也提供
  了同名方法，但 `RegisteredTool` 不强制实现——它通过构造函数选项注入。
- 中间件系统（`ToolMiddleware`）只认识 `RegisteredTool`，而 executor 只认识
  `AgentTool`，导致中间件的 `beforeExecute(tool: RegisteredTool, ...)` 签名必须
  向下转型才能被 executor 消费。

**P2：缺乏 Schema 驱动的工具元属性**
`inputSchema` 只是标准 JSON Schema，没有扩展字段来表达语义元数据：

- 工具是否幂等（多次调用是否安全）——当前需要模型自己决定
- 工具的副作用声明——当前靠 `isReadOnly()` 方法表达，但它是运行时的、动态的
- 工具的最小安全权限——没有声明；所有工具在 session-loop 中被同等对待
- 工具的审计级别——没有声明；所有操作生成相同的审计事件
- 工具是否需要预置 Checkpoint——在 `fs-edit-tools.ts` 中通过
  `createPreMutationCheckpoint` 调用硬编码，而不是元数据驱动的
- 工具的结果格式约定——某些工具返回 `{ text, json, artifacts }`，某些只返回 `text`，
  没有 Schema 级别的约定

这些缺失的元属性导致 `agent-session-loop.ts` 中的 `findFatalToolError` 方法
（第 195-211 行）必须通过遍历 `output.json` 中的运行时字段来推断错误严重性，
而不是通过工具的静态声明。

**P3：`ToolDefinition` 与 `AgentTool` 之间的转换完全手工**
在 `mcp-lifecycle.ts:1090-1122` 中，`createManagedMcpTool` 需要手写从
`McpCachedTool` 到 `AgentTool` 的字段映射：

```typescript
return {
  name,
  label,
  description: tool.description,
  category: 'mcp',
  inputSchema: tool.inputSchema,
  concurrency,
  isReadOnly(input) { ... },
  summarize(input) { ... },
  execute,
};
```

同样的模式在 `fs-edit-tools.ts`、`shell-tools.ts`、`fs-read-tools.ts` 中重复。
每个工具实现都手写 `execute` 函数、`isReadOnly` 函数、`summarize` 函数。
`defineTool` 辅助函数（来自 `../tools`）虽然简化了一部分，但仍没有系统级的自动
Schema → AgentTool 转换器。

**P4：缺少工具 Schema 的版本管理**
`inputSchema` 是静态 JSON，没有任何版本号或变更记录。当工具更新 Schema 时，
旧的序列化事件流（session store 中的 tool call 记录）无法与当前 Schema 对齐。
这影响了会话恢复后的参数重放。

**P5：工具注册的 identity 不唯一**
`AgentTool.name` 是唯一的标识符。但在 MCP 场景下，不同 MCP server 可能注册
同名工具。当前 `McpServerController` 会覆盖之前的同名工具，但没有冲突检测机制。
`ToolRegistry.register()`（`tool-definition.ts:75`）会抛出 `Duplicate tool registered`
错误，但 MCP 工具的注册不经过 `ToolRegistry`——它们通过 `McpLifecycleManager.listTools()`
直接暴露给 session-loop。

### 2.2 Tool 注册机制评估

**评分：6/10**

#### 2.2.1 注册路径分析

注册机制分布在四个独立路径上：

**路径 A：本地工具注册**
通过 `createLocalWorkspaceTools`（`local-tools/index.ts:35-60`）工厂函数创建。
这个函数组装了 9 个内置工具：
1. `shell_command`（`createTerminalCommandTool`）
2. `run_background` + `list_tasks` + `wait_for_task` + `cancel_task`（`createBackgroundCommandTools`）
3. `read`（`createReadTool`）
4. `edit`（`createEditTool`）
5. `apply_workspace_edits`（`createApplyWorkspaceEditsTool`）
6. `list_directory`（`createListDirectoryTool`）
7. `search_files`（`createSearchFilesTool`）
8. `restore_file_snapshot`（`createRestoreFileSnapshotTool`）
9. `workspace_checkpoint` + `restore_workspace_checkpoint`（`createWorkspaceCheckpointTool`）

返回 `AgentTool[]` 数组，直接传入 `AgentRuntimeOptions.tools`。

**路径 B：MCP 工具注册**
通过 `McpLifecycleManager.listTools()`（`mcp-lifecycle.ts:771-774`）异步拉取，
返回 `AgentTool[]`。内部调用每个 `McpServerController.listTools()`，后者根据
server 状态决定返回 cached tools 还是 live tools。

**路径 C：扩展工具注册**
通过 `ExtensionRegistry.collectHooks() + ToolRegistry.register()`
（`tool-definition.ts:75-82`）注册。扩展工具在 `Extension.tools` 中定义。

**路径 D：运行时聚合**
在 `AgentRuntimeOptions.tools`（`types.ts:122`）和 `AgentRuntimeOptions.toolSources`
（`types.ts:123`）中合并。`runtime-factory` 负责将本地工具 + MCP 工具 + 扩展工具
聚合为最终的 `tools: AgentTool[]`。

**问题分析：**

**P1：注册时机不统一**
三种工具的注册路径完全不同，导致它们在运行时可用的时序不同步：

- 本地工具在 `AgentRuntime` 构造函数中就绪（通过 `options.tools`）
- MCP 工具在 `McpLifecycleManager.start()` 调用后才可用（异步）
- 扩展工具通过 `ExtensionRegistry.collectHooks()` 收集，但收集的是 Hook 而不是工具

这意味着 `agent-session-loop.ts` 在构造时（第 344 行 `this.tools = tools`）已经
「冻结」了工具列表。MCP 工具后续的变化（新增 server、工具列表刷新）不会自动同步
到 `this.tools`。`McpLifecycleManager` 的 `refreshAllTools()`（`mcp-lifecycle.ts:776`）
刷新了内部状态，但没有触发 session-loop 的工具列表更新。

**P2：没有「工具 Preset」概念**
不同运行模式（`plan` / `ask` / `auto` / `full-access` / `unattended`）下模型可见
的工具集应该是不同的。例如：

- `plan` 模式：应该只暴露只读工具 + 文件浏览工具，`edit`、`write_file`、`shell_command`
  不应该出现在模型的工具列表中。
- `unattended` 模式：应该只暴露自动安全的工具（read-only + 本地 git add/commit）。
- `ask` / `auto` 模式：全部工具可见。

当前所有 mode 看到的是同一组工具。`decision-engine` 的 `TRUST_ZONE_MATRIX`
（`trust-zone.ts:87-123`）定义了不同 mode 的审批行为，但它的作用是被告知（工具调用
发生后的审批决策），而不是预防（工具调用发生前的可见性过滤）。结果就是模型会写出
被禁止的工具调用，然后 session-loop 必须拒绝并处理错误——增加了不必要的模型输出
成本和用户延迟。

**P3：没有工具来源追踪**
`AgentTool` 接口（`types.ts:21-34`）有 `category: ToolCategory` 字段，但 `category`
的语义是功能分类（`filesystem` / `terminal` / `mcp` / `network` / `internal` / `skill` / `agent`），
而不是来源分类。无法从 `category` 区分：

- 本地工具中的 `HTTP fetch`（category: `network`） vs MCP 工具中的 `HTTP fetch`
  （category: `mcp`）
- 哪个 MCP server 提供了哪些工具
- 扩展系统注册的工具属于哪个 Extension

没有来源追踪意味着：
- 错误报告中无法说「MCP server 'weather-api' 的工具 weather 调用失败」
- 审批页面无法说「这个 weather 工具来自 MCP server 'weather-api'」
- 审计日志缺少工具来源维度

**P4：没有动态启停机制**
MCP server 的状态变化（`ready` → `degraded` → `reconnecting` → `stopped`）不会
通知执行路径。具体场景：

1. MCP server 短暂离线（`ready` → `degraded`）
2. `McpServerController` 内部状态变化，但 `McpLifecycleManager` 没有广播
   `tools-refreshed` 事件到 session-loop
3. `agent-session-loop` 中的 `this.tools` 仍然包含这个 MCP server 的所有工具
4. 模型发出这些工具的调用请求
5. `tool-executor.ts` 在 `partitionBatch` 中分配这些工具
6. `executeSingleWithEvents` 查找 tool（第 402 行）时仍然能找到
7. 但工具执行时通过 `createManagedMcpTool` 的 `execute` 函数进入
   `executeManagedTool`
8. `executeManagedTool` 调用 `waitForReady(30s)` 等待重连
9. 30s 后超时，返回 `McpLifecycleError`

在这整个过程中，session-loop 和 tool-executor 都无法提前知道 MCP 工具不可用。
工具已经进入执行管道后才失败，浪费了时间。

**P5：没有注册元数据的扩展机制**
`AgentTool` 接口没有「扩展字段」的概念。如果需要给工具增加一个属性（如 `requiredPermission`、
`mcpServerName`、`maxConcurrency`），必须修改 `AgentTool` 接口本身及其所有实现。
没有 `AgentTool.metadata?: Record<string, unknown>` 这样的逃生窗口。

### 2.3 Tool 执行管道评估

**评分：5/10**

#### 2.3.1 管道架构

执行管道涉及三个文件，职责分配如下：

| 文件 | 核心方法 | 职责 | 代码行数 |
|------|----------|------|----------|
| `tool-executor.ts` | `executeBatchWithEvents` | 批量调度（并行/串行分区 + 事件发射） | ~200 |
| `tool-executor.ts` | `executeSingleWithEvents` | 单工具执行循环（校验 → 执行 → 结果） | ~120 |
| `agent-session-loop.ts` | `executeSingleTool` | 完整的工具生命周期（350+ 行硬编码） | ~365 |
| `agent-session-loop.ts` | `executeToolCalls` | 批量执行的入口，构造 ToolExecuteHook | ~42 |
| `single-tool-executor.ts` | `execute` | 单工具执行（超时/取消） | ~70 |

**执行流程链**：

```
agent-session-loop.executeToolCalls()         ① 入口
  → tool-executor.executeBatchWithEvents()    ② 批量调度
    → tool-executor.executeSingleWithEvents()  ③ 单工具循环
      → ToolExecuteHook (agent-session-loop)   ④ Hook 注入
        → agent-session-loop.executeSingleTool() ⑤ 完整生命周期
          → composedHooks.beforeToolCall()     ⑤a Hook 前处理
          → repairToolInput() + validateToolInput() ⑤b 输入校验
          → resolvePermission()                ⑤c 审批
          → singleToolExecutor.execute()       ⑤d 执行
          → composedHooks.afterToolCall()      ⑤e Hook 后处理
          → materializeLargeToolOutput()       ⑤f 物化
          → recordToolCheckpointEvents()       ⑤g Checkpoint
```

这个链的问题是：**步骤③、④、⑤ 之间的职责边界模糊**。
步骤③（`executeSingleWithEvents`）认为自己是执行管道的中心——它负责事件发射、
结果格式化、工具查找。但步骤⑤（`executeSingleTool`）才真正执行所有业务逻辑
（审批、物化、Hook）。步骤③ 通过 `ToolExecuteHook` 委派给步骤⑤，但步骤③
自己又做了工具查找（第 402 行）和校验（第 427-453 行）——这些步骤⑤ 也会重复做。

#### 2.3.2 问题分析

**P1：生命周期阶段不完整**
当前执行管道只有「执行 → 收集结果 → 发射事件」三个阶段。缺乏以下阶段：

- **注册前校验阶段**：工具是否已注册、来源是否可用。当前在 `executeSingleWithEvents`
  第 402 行做 `tools.find()`，但这已经是执行阶段了。
- **审批前分析阶段**：在审批之前对输入做安全分析和风险标记。当前和审批混在一起
  （`resolvePermission` 内同时做信任区解析和策略判定）。
- **执行后审计阶段**：工具执行完成后，收集审计数据、更新计数器、检查 resource
  使用是否超标。当前这些逻辑散落在多个位置。
- **批次生命周期阶段**：`tool-batch-start` 和 `tool-batch-end` 事件在
  `executeBatchWithEvents` 中发射，但没有对应的 Hook 点。外部系统无法在批次
  开始前预留资源、在批次结束后做清理。

**P2：`ToolExecuteHook` 设计承载过多职责**
`ToolExecuteHook`（`tool-executor.ts:61-68`）是 `ToolExecutor` 暴露的唯一扩展点，
但它的签名是一个全功能的 AsyncGenerator：

```typescript
export type ToolExecuteHook = (
  toolCall: ToolCallBlock,
  tools: AgentTool[],
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  batchId: string
) => AsyncGenerator<AgentEvent, ToolBatchResult>;
```

这个签名的问题：
1. **参数过多**（6 个平铺参数）：调用方需要管理所有参数的传递，容易漏传或传错。
   在 `executeSequentialWithEvents`（第 288 行）中，这 6 个参数从调用栈一直传递
   到底层。
2. **返回类型是 AsyncGenerator**：可以发射任意数量的事件再返回结果。这使得调用方
   （`executeSingleWithEvents`）无法通过简单的 `await hook()` 调用 Hook，而必须
   用 `yield*` 展开事件流。
3. **没有错误契约**：Hook 抛出的异常被 `executeSingleWithEvents` 的第 351-353 行
   （并行路径）或更上层的 try-catch 捕获，但没有标准化的错误格式。
4. **没有上下文对象**：6 个平铺参数本应封装为 `ExecuteHookContext` 类型。

**P3：无标准化的错误建模**
`ToolExecutionCompletion`（`tool-executor.ts:36-38`）定义了三种完成状态：

```typescript
export type ToolExecutionCompletion =
  | { ok: true; output: ToolOutput }
  | { ok: false; kind: 'error' | 'timeout' | 'cancelled'; cause: unknown };
```

但这与 `agent-session-loop.ts` 的错误处理方式不一致：

- `findFatalToolError`（第 195 行）通过遍历 `output.json` 中的运行时字段
  （`softDeny`、`timedOut`、`cancelled`、`code === 'approval_expired'` 等）
  来推断错误类型。
- `SingleToolExecutor` 的执行结果通过 `output.json.runtimeToolExecution` 传递
  结构化元数据（`status: 'timeout' | 'cancelled' | 'error'`）。
- `resolvePermission` 的拒绝结果通过 `buildPermissionDenyToolOutput` 构建
  `{ json: { denied: true, reason: ... } }` 格式。

三种错误表示方式共存，同一个工具调用可能同时匹配 `ToolExecutionCompletion` 的
`kind: 'error'` 和 `output.json.runtimeToolExecution.status: 'timeout'`。

**P4：批量调度与业务逻辑耦合**
`ToolExecutor.executeBatchWithEvents`（第 184 行）同时做了两件事：
1. **调度**：分区、并行/串行执行
2. **事件管理**：`tool-batch-start` / `tool-batch-end` 事件的发射

事件发射没有通过独立的 `EventEmitter` 接口，而是直接内联在方法中。如果要修改
事件格式（如添加权限摘要），必须修改 `ToolExecutor` 核心代码。

**P5：并行执行的错误传播路径不一致**
在 `executeParallelWithEvents`（第 306 行）中，如果某个工具的 `executeOne`
调用抛出异常，它被 `ProgressEventQueue` 捕获为 `{ type: 'error', error }`
（第 351-353 行），然后整个批次被 abort（第 365 行）。

但在串行执行 `executeSequentialWithEvents`（第 276 行）中，异常是通过
`yield* executeOne(...)` 直接传播的——没有 `ProgressEventQueue` 的包装。
相同的错误在并行和串行路径中表现为不同的异常路径。

**P6：没有执行前/执行后的标准织入点**
`executeSingleWithEvents` 的工具执行部分（第 474-485 行）：

```typescript
const singleExecutor = new SingleToolExecutor(this.options.timeoutMs, []);
const effectiveCall: ToolCallBlock = { ...toolCall, input: repairedInput };
const executionPromise = singleExecutor
  .execute(effectiveCall, (input, ctx) => tool.execute(input, ctx), context, signal)
```

这里 `tool.execute` 直接被调用。没有「执行前准备」（注入上下文、读取工具状态）
和执行后收尾（关闭资源、记录结果）的标准织入点。`SingleToolExecutor` 的
构造函数参数 `[]`（空数组？）也没有被任何业务用途使用过。

### 2.4 Permission/审批集成评估

**评分：4/10**

#### 2.4.1 审批路径全景

审批路径的代码分布（从请求发起到决策完成）：

| 阶段 | 组件 | 文件 | 行号 | 职责 |
|------|------|------|------|------|
| ① 请求构造 | `buildRuntimePermissionRequest` | `agent-session-loop.ts` | 1803-1829 | 从 ToolCallBlock 构造 RuntimePermissionRequest |
| ② 策略判定 | `permissionPolicy.decide()` | `agent-session-loop.ts` | 1832 | 调用注册的 RuntimePermissionPolicy |
| ③ 事件广播 | yield `approval-requested` | `agent-session-loop.ts` | 1868 | 通知外部系统需要人工审批 |
| ④ 审批等待 | `approvalHandler.requestApproval()` | `agent-session-loop.ts` | 1874 | 等待外部系统回复 |
| ⑤ 结果回填 | yield `approval-resolved` | `agent-session-loop.ts` | 1878 | 告知外部系统审批完成 |
| ⑥ 拒绝处理 | `buildPermissionDenyToolOutput()` | `runtime-helpers.ts` | (外部) | 构造拒绝结果 |

Daemon 侧的审批组件：

| 组件 | 文件 | 职责 |
|------|------|------|
| `ApprovalQueue` | daemon 侧 | 审批队列管理 |
| `DaemonApprovalHandler` | daemon 侧 | 人工审批的 handler 实现 |
| `validateApproveToolMessage` | `protocol/validators/run.ts:332` | 协议层的审批消息校验 |
| `broadcastApprovalRequested` | `run-handlers.ts:688` | 审批事件广播 |

Decision-engine 侧的组件：

| 组件 | 文件 | 职责 |
|------|------|------|
| `PermissionEngine` | `decision-engine/src/permission-engine.ts:4-22` | 规则引擎（线性链） |
| `HardlineBlockRule` | `decision-engine/src/rules/hardline-rule.ts` | T4 hardline 阻止规则 |
| `resolveTrustZone` | `decision-engine/src/trust-zone.ts:359-502` | 信任区解析 |
| `behaviorForMode` | `decision-engine/src/trust-zone.ts:508-521` | 策略查表 |
| `buildIntentKey` | `decision-engine/src/trust-zone.ts:332-351` | 意图指纹生成 |
| `classifyCommand` | `decision-engine/src/command-classifier.ts:352-383` | 命令分类 |

中间件层面的组件（未接入）：

| 组件 | 文件 | 职责 |
|------|------|------|
| `PermissionMiddleware` | `tool-middleware.ts:131-218` | 权限中间件（与 resolvePermission 功能重叠） |
| `CheckpointMiddleware` | `tool-middleware.ts:243-291` | Checkpoint 中间件（未接入） |
| `OutputMaterializationMiddleware` | `tool-middleware.ts:309-330` | 输出物化中间件（未接入） |

#### 2.4.2 问题分析

**P1：审批逻辑高度耦合在 session-loop 中**
`resolvePermission` 方法（`agent-session-loop.ts:1798-1907`）是一个AsyncGenerator，
在同一个函数中交织了五种职责：

1. **请求构造**（第 1803-1829 行）：构造 `RuntimePermissionRequest` 和可序列化的
   `PermissionRequest`。后者需要从前者「提取扁平字段」，因为 `AgentTool` 包含
   `execute()` 函数无法序列化到事件流。
2. **策略判定**（第 1832 行）：调用 `permissionPolicy.decide(request)`。
3. **事件发射**（第 1839-1847 行）：`allow` 和 `deny` 路径分别发射 `approval-resolved`。
4. **人工审批等待**（第 1850-1886 行）：当 `behavior === 'ask'` 时，构造包含
   决策元数据的增强请求，发射 `approval-requested` 事件，然后通过
   `approvalHandler.requestApproval()` 等待异步回复。
5. **安全默认拒绝**（第 1889-1906 行）：如果 `ask` 但没有配置 `approvalHandler`，
   安全地默认拒绝。

这种耦合的后果：
- **不可独立测试**：要测试「人工审批超时」场景，必须构造完整的 session-loop 环境。
- **不可扩展**：要添加「双层审批」「审批链」「异步审批」，必须修改 `resolvePermission`
  的整个流程。
- **不可替换**：要使用不同的审批策略（如基于规则的自动审批），必须通过
  `RuntimePermissionPolicy` 间接实现，但 `policy.decide()` 之后的事件发射逻辑
  仍然硬编码在 session-loop 中。

**P2：无标准化的审批流水线抽象**
当前只有两段式模型（自动判定 → 人工审批），无法表达：

- **自动层 + 轻量确认层 + 管理员审批层 + 多重签名层**的层次化决策。
  例如：T2 操作自动放行，T3 操作需要用户弹窗确认，T4 操作需要管理员 + 部门经理
  的双层确认。
- **审批链**：当第一个审批人超时后自动转给第二个审批人。
- **异步审批**：`requestApproval()` 返回 Promise，但 Promise 的语义是「一次性」的。
  如果审批人 5 分钟后才在手机上回复，session-loop 必须等待 5 分钟。

**P3：TrustMode 与 Tool 可见性脱节**
`TrustPolicyMode` 只影响审批（工具调用后的决策），不影响工具可见性（工具调用前的
过滤）。这导致：

- 在 `plan` 模式下，模型能看到 `edit` 工具，可能输出 `edit` 调用。
- session-loop 收到 `edit` 调用 → 通过 `resolvePermission` → `behaviorForMode('plan', 'T1')`
  返回 `deny`。
- 工具执行被拒绝 → 模型得到拒绝结果 → 模型可能困惑或反复重试。

整个过程增加了模型输出 token 消耗（工具调用本身需要生成输入参数）和用户等待时间。
如果 `plan` 模式下 `edit` 从模型工具列表中直接移除，模型就不会输出这个调用。

**P4：无审批缓存与意图分组**
`buildIntentKey`（`trust-zone.ts:332-351`）已经定义了一套完善的意图指纹生成逻辑：

- Shell 命令：`T2|write|shell|git add *`（将具体参数泛化为 `*`）
- 编辑工具：`T1|write|edit-family|*`
- 只读工具：`T0|read|read|*`

但 `resolvePermission` 不使用这个意图键进行缓存。每次工具调用都重新触发
`permissionPolicy.decide()`，即使：

- 与上一次的意图完全相同（`read` 同一个文件的第二次调用）
- 与上一次的意图近似（`read` 同一个目录的不同文件）
- 在同一批（`batch`）中的多个相同工具调用

在 `ask` 模式下，这意味着每次工具调用都弹窗一次，无论是否是重复意图。

**P5：审批记录不持久化**
`RuntimePermissionPolicy` 接口(`types.ts:104-107`)定义了一个可选的 `recordDecision`
方法，但没有强制实现：

```typescript
export interface RuntimePermissionPolicy {
  decide(request: RuntimePermissionRequest): Promise<PermissionDecision> | PermissionDecision;
  recordDecision?(request: RuntimePermissionRequest, decision: PermissionDecision): void;
}
```

`agent-session-loop` 调用 `decide()` 后，没有检查或调用 `recordDecision()`。
审批决策(`PermissionDecision`)只在运行时的变量 `decision` 中存在，没有被写入
session store 或 event store。影响：

- 审计不可追溯。运行结束后无法回答「这个 run 中哪些工具调用被拒绝了」
- 窗口恢复后审批状态丢失
- AB 测试无法对比不同审批策略的效果

**P6：`PermissionMiddleware` 与 `resolvePermission` 重复实现**
`PermissionMiddleware.beforeExecute()`（`tool-middleware.ts:136-217`）与
`resolvePermission`（`agent-session-loop.ts:1798-1907`）实现了几乎相同的逻辑：

- 都构造 `RuntimePermissionRequest`
- 都调用 `permissionPolicy.decide()`
- 都在 `ask` 时发射 `approval-requested` 事件并等待 `approvalHandler`
- 都在 `deny` 时返回阻止结果

但它们是两个独立的实现，字段名不同（`proceed` vs `block`），事件流不同
（`MiddlewareBeforeResult.events` 数组 vs `AsyncGenerator<AgentEvent>` yield），
无法互相替换。`PermissionMiddleware` 无法被 session-loop 消费的原因是
MiddlewarePipeline 没有接入执行路径。

#### 2.4.3 重复审批的具体场景分析

以下场景全部发生在当前系统中，每个都导致用户不必要的审批弹窗：

| 场景 | 问题 | 影响 |
|------|------|------|
| 模型连续两次 `read` 同一文件 | 每次独立审批，第二次应自动 allow | 用户操作效率低 |
| 一轮中模型发出 5 个 `read` 调用（并行） | 5 次弹窗 | 用户操作效率低 |
| 模型发出 `bash ls`（已满足自动条件） | 如果模式是 ask，T0 仍可能弹窗 | 不必要的弹窗 |
| 用户在一轮中批准了 `edit file.js`，下一轮模型再次调用 | 审批缓存按 run 维度，跨轮不共享 | 合理的弹窗（跨轮的安全边界） |

### 2.5 Tool 执行上下文评估

**评分：6/10**

#### 2.5.1 上下文构建点

`ToolExecutionContext` 接口定义在 `@crish/shared-types`，在
`agent-session-loop.ts:1604-1623` 构建：

```typescript
const context: ToolExecutionContext = {
  toolCallId: toolCall.id,
  sessionId: this.sessionId,
  cwd: this.options.cwd,
  signal,
  emit: (update) => {
    toolEventQueue.push({
      type: 'event',
      event: {
        type: 'tool-update',
        sessionId: this.sessionId,
        batchId,
        toolCallId: toolCall.id,
        update,
        timestamp: nowIso(),
      },
    });
  },
  metadata: { subagentDepth: this.options.subagentDepth ?? 0 },
};
```

而在 `tool-executor.ts:457-472` 的 `executeSingleWithEvents` 中构建了另一个
上下文：

```typescript
const context: ToolExecutionContext = {
  toolCallId: toolCall.id,
  sessionId,
  cwd,
  signal,
  emit(update) {
    progressQueue.push({
      type: 'tool-update',
      sessionId,
      batchId,
      toolCallId: toolCall.id,
      update,
      timestamp: nowIso(),
    });
  },
};
```

注意这里有 `metadata` 字段差异：`tool-executor.ts` 版本没有 `metadata`字段。
两个构建点产生不同结构的上下文。

#### 2.5.2 问题分析

**P1：缺少批处理信息**
上下文没有 `batchId`、`batchType`（serial / parallel / exclusive）、同一批中的
其他工具调用信息。工具实现者不知道：

- 当前工具是单执行还是批量中的一部分
- 如果是批量执行，是自己独占执行还是与其他人并行
- 同一批中有哪些其他工具在执行（对有副作用的工具很重要）

这影响了工具的决策能力。例如 `shell_command` 如果知道自己在独占执行，可以安全地
修改工作目录；如果在并行执行，则需要使用绝对路径。

**P2：缺少运行时元数据**
`agent-session-loop.ts` 构建的上下文包含了 `subagentDepth` 作为唯一的元数据。
缺失的关键信息包括：

- `turnIndex`：工具不知道自己在第几轮，无法根据上下文长度调整输出
- `runId`：工具不知道自己的 run 标识，无法关联跨 run 的状态
- `providerId` 和 `model`：工具不知道当前使用什么模型，无法调整行为
- `mode` 和 `trustPolicyMode`：工具不知道当前是什么运行模式
- `batchId`：工具不知道自己的批次归属

**P3：`emit` 回调设计受限**
`emit` 回调只允许推送 `ToolProgressUpdate`（定义在 `@crish/shared-types`），
它通常只包含 `{ text }` 和可选的 `{ json, metadata }`。工具执行过程中如果希望
触发额外的 runtime 事件（如安全检查告警、资源使用统计、子任务状态），只能通过
`emit({ text: '告警信息' })` 间接传递，无法产生结构化事件。

**P4：`metadata` 字段未充分利用**
`metadata` 目前只承载 `subagentDepth` 一个字段。在 `agent-session-loop.ts` 中
被设置为 `{ subagentDepth: this.options.subagentDepth ?? 0 }`，没有扩展为
更完整的运行时元数据对象。工具实现者如果希望根据 `mode`（如 `plan` 模式下
输出更详细的编辑说明）或 `providerId`（如特定 provider 下绕开某些 bug）调整行为，
没有标准的信息渠道。

**P5：上下文传播链断裂**
从 `agent-session-loop` 到 `tool-executor` 到 `single-tool-executor` 到 `tool.execute()`
之间的上下文没有自动传播。

- `agent-session-loop.ts` 的 `executeSingleTool` 构建了完整上下文（含 `metadata.subagentDepth`）
- 这个上下文被传给 `singleToolExecutor.execute()` 然后传给 `tool.execute(input, context)`
- 但 `tool-executor.ts` 的 `executeSingleWithEvents` 构建了一个**不同的**上下文
  （不含 `metadata`），这个上下文在流式工具执行路径中被使用

当工具执行经过 `tool-executor.ts` 路径时，上下文丢失了 `subagentDepth` 信息。

### 2.6 Tool 结果处理评估

**评分：5/10**

#### 2.6.1 结果格式化的分布

结果处理分布在三个文件中：

**文件一：`agent-session-loop.ts:1961-1978` — `toToolBatchResult`**
构造 `ToolBatchResult` 的标准方法：

```typescript
private toToolBatchResult(call: ToolBatchCall, startedAt: number, output: ToolOutput, isError: boolean): ToolBatchResult {
  return {
    id: call.id,
    toolName: call.toolName,
    output,
    isError,
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: nowIso,
    outputByteSize: Buffer.byteLength(JSON.stringify(output), 'utf8'),
  };
}
```

这个方法被 5 个不同的路径调用（工具未找到、校验失败、权限拒绝、执行前 abort、
执行完成）。

**文件二：`tool-executor.ts:494-508` — `executeSingleWithEvents` 内部构造**
`tool-executor.ts` 也有自己的 `ToolBatchResult` 构造逻辑：

```typescript
const result: ToolBatchResult = {
  id: call.id,
  toolName: call.toolName,
  output: completed.output,
  isError: completed.isError,
  durationMs: Date.now() - startedAt,
  startedAt: startedAtIso,
  endedAt: endedAtIso,
  outputByteSize: calcOutputByteSize(completed.output),
};
```

与 session-loop 的实现字段结构相同但代码重复。

**文件三：`runtime-helpers.ts` — `buildPermissionDenyToolOutput`**
构造审批拒绝的结构化输出：

```typescript
// 返回 { text: "...", json: { denied: true, reason: "...", ... } }
```

#### 2.6.2 问题分析

**P1：结果格式化与错误映射不统一**
三种错误路径使用不同的格式：

- **权限拒绝**：结构化 JSON `{ json: { denied: true, reason: "..." } }`，由
  `buildPermissionDenyToolOutput` 生成。
- **工具未找到**：纯文本 `{ text: "Tool not found: xxx" }`，没有 JSON 结构。
- **输入校验失败**：纯文本 `{ text: "Tool input validation failed:\n- ..." }`，
  没有 JSON 结构。
- **执行错误**：结构化 JSON `{ json: { runtimeToolExecution: { status: "error" } } }`，
  由 `executeSingleTool` 的第 1746-1767 行构建。

`findFatalToolError`（第 195 行）必须同时兼容三种格式：

```typescript
if (o.softDeny === true) return true;     // 权限拒绝格式
if (o.timedOut === true) return true;      // 执行错误格式
if (o.cancelled === true) return true;     // 执行错误格式
const code = o.code;                        // 权限拒绝格式
if (code === 'approval_expired' || code === 'user_denied') return true;
const rte = o.runtimeToolExecution;        // 执行错误格式
```

这种「字段嗅探」式的格式检测是脆弱的。新增一种错误类型需要更新所有解析点。

**P2：大输出物化在 session-loop 中硬编码**
`materializeLargeToolOutput`（第 1787-1792 行）在 `executeSingleTool` 中被调用两次：
- 成功路径：第 1667-1670 行
- afterToolCall 修改后：第 1703-1708 行

这个职责属于 `ContextManager`，本应通过 `OutputMaterializationMiddleware` 注入。
但 session-loop 绕过了中间件系统，直接调用 `contextManager.materializeOutput`。

**P3：Checkpoint 录制与结果处理耦合**
`recordToolCheckpointEvents`（第 1918-1947 行）在工具结果生成后被调用，同时在
`executeSingleTool` 内部被 `yield*` 展开。具体流程：

```
① 结果构造（第 1711-1716 行）→ ToolBatchResult
② trackToolFileOp（第 1717 行）
③ yield tool-end 事件（第 1718-1724 行）
④ yield* recordToolCheckpointEvents（第 1725 行）
```

步骤③ 发射的 `tool-end` 事件中包含结果，但步骤④ 发射的 `checkpoint-created`
事件在 `tool-end` 之后——这意味着事件消费者收到 `tool-end` 时，Checkpoint
可能还没有完成。事件的时序语义不清晰。

### 2.7 MCP 工具集成评估

**评分：7/10**

#### 2.7.1 MCP 工具生命周期

MCP 工具集成通过 `McpLifecycleManager` 和 `McpServerController` 实现了一套
完整的状态机：

**McpServerController 状态机**：
```
discovering → starting → ready
                              ↓ (连接失败)
                        → degraded → reconnecting → starting → ready
starting → (被 teardown) → stopped (终态)
ready → (连接断开) → degraded → reconnecting → ...
ready → teardown → stopped
```

**MCP 工具的生命周期事件**：
- `server-state`：状态变化通知
- `server-diagnostic`：诊断信息
- `tools-refreshed`：工具列表刷新

**MCP 工具的执行流程**：
```
tool-executor 找到 MCP 工具 → 调用 createManagedMcpTool 的 execute 函数
  → McpServerController.executeManagedTool
    → waitForReady(30s) — 等待 server 就绪
    → 在 liveTools 中查找工具
    → tool.execute(input, context) — 调用 MCP server
```

#### 2.7.2 问题分析

**P1：MCP 工具的生命周期事件未被 Tool Hook 链消费**
`McpServerStateEvent` 类型（`mcp-lifecycle.ts:134-154`）定义了 `server-state`、
`server-diagnostic`、`tools-refreshed` 三种事件类型，但这些事件只被
`McpLifecycleManager` 内部和外部 subscriber 消费，没有传播到 Hook 系统：

- `server-state: ready → degraded`：session-loop 不知道，工具仍然可调用
- `tools-refreshed`：session-loop 不知道，`this.tools` 列表不更新

**P2：MCP 工具的执行总是同步等待 30s**
`executeManagedTool`（`mcp-lifecycle.ts:557-593`）在每次工具调用前都调用
`waitForReady(DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS)`，这个超时值是 30 秒
（第 12 行）。当 MCP server 离线时：

1. 第一个工具调用等待 30s → 超时 → 返回 `McpLifecycleError`
2. 同批中的其他工具（如果串行）也被阻塞
3. `ToolExecutor` 层面的超时（`this.options.timeoutMs`）可能与 30s 嵌套，导致
   不可预测的超时行为

`ToolExecutor` 层面无法区分「MCP 工具正在连接」和「MCP 工具已超时」——两者
都表现为 `Promise<ToolOutput>` 的延迟。没有超时原因的结构化传递到 executor。

**P3：MCP 工具的审批不经过 MCP 层面**
MCP 工具的审批走的是通用路径（`resolvePermission`），但 `PermissionRequest`
（`agent-session-loop.ts:1814-1829`）中的 `toolMetadata` 只包含通用字段：

```typescript
toolMetadata: {
  category: tool.category,        // 'mcp'
  isReadOnly: tool.isReadOnly(input),
  fatalOnError: tool.fatalOnError,
  concurrency: tool.concurrency,
}
```

缺少 MCP 特有的上下文：
- MCP server 名称（`serverName`）
- MCP server 当前状态（`state`：是否 degraded）
- MCP 传输类型（`stdio` / `sse` / `streamable-http`）
- MCP server 的诊断信息

这意味着审批页面无法显示「这个工具来自 MCP server 'xxx'，它当前处于 degraded 状态」。

**P4：MCP 工具不可用的降级策略缺失**
当 MCP 工具不可用时（server degraded），`executeManagedTool` 抛出
`McpLifecycleError`。session-loop 的 `executeSingleTool` 捕获它吗？不——
`executeManagedTool` 被包装在 `createManagedMcpTool.execute` 中，后者直接
返回 `Promise<ToolOutput>`。如果 MCP server 不可用，这个 Promise reject。
rejection 在 `single-tool-executor.ts` 中被转换为错误输出 `{ output: { text: message }, isError: true }`。

没有降级策略——不会尝试使用本地等效工具替代、不会优雅地等待重连、不会给出比
「MCP server xxx is yyy」更友好的错误信息。

### 2.5 Tool 执行上下文评估

**评分：6/10**

`ToolExecutionContext` 接口定义在 `@crish/shared-types` 中，在 `agent-session-loop.ts:1604-1623`
构建：

```typescript
const context: ToolExecutionContext = {
  toolCallId: toolCall.id,
  sessionId: this.sessionId,
  cwd: this.options.cwd,
  signal,
  emit: (update) => { ... },
  metadata: { subagentDepth: this.options.subagentDepth ?? 0 },
};
```

**问题：**

- **缺少批处理信息**：上下文没有 `batchId`、`batchType`（serial / parallel / exclusive）、
  同一批中的其他工具调用信息。工具不知道自己是单执行还是批量中的一部分。

- **缺少运行时元数据**：没有 `turnIndex`、`runId`、`providerId`、`mode`、`trustPolicyMode`
  等信息。`HookContext`（`hook-types.ts:25-42`）中有 `turnIndex`，但 `ToolExecutionContext`
  中没有——这意味着工具本身不知道当前是第几轮。

- **`emit` 回调设计受限**：`emit` 回调只允许推送 `ToolProgressUpdate`，无法推送
  `AgentEvent`。工具执行过程中如果希望触发额外的 runtime 事件（如安全检查告警、
  资源使用统计），只能通过 `emit({ text })` 间接传递。

- **`metadata` 字段未充分扩展**：当前的 `metadata` 只有一个 `subagentDepth` 字段。
  应该有 `providerId`、`model`、`mode`、`permissionDecision` 等字段，让工具实现者
  可以根据运行态环境调整行为。

### 2.6 Tool 结果处理评估

**评分：5/10**

结果处理分布在多个方法中：

- `tool-executor.ts`：`executeSingleWithEvents` 内部的 `outputByteSize` 计算和 `ToolBatchResult` 构建
- `agent-session-loop.ts`：`toToolBatchResult`、`materializeLargeToolOutput`、`buildPermissionDenyToolOutput`
- `runtime-helpers.ts`：`buildPermissionDenyToolOutput`、`isToolTimeoutCause`

**问题：**

- **结果格式化与错误映射不统一**：三种错误路径（权限拒绝、工具未找到、输入校验失败）
  使用相同的 `toToolBatchResult` 方法，但错误格式不统一——权限拒绝有结构化 JSON
  （`{ denied: true, reason: "..." }`），输入校验失败只有 text，工具未找到只有
  纯文本。`findFatalToolError` 的解析逻辑必须同时兼容两种格式。

- **大输出物化在 session-loop 中硬编码**：`materializeLargeToolOutput` 在
  `executeSingleTool` 中被调用两次（成功路径和失败路径），但这个职责属于
  `ContextManager`，本应通过 `OutputMaterializationMiddleware` 注入。session-loop
  绕过了这个中间件，直接调用 `contextManager.materializeOutput`。

- **Checkpoint 录制与结果处理耦合**：`recordToolCheckpointEvents`（`agent-session-loop.ts:1918-1947`）
  在工具结果生成后被调用，同时在 `executeSingleTool` 内部被 `yield*` 展开。这导致
  tool-end 事件不是在工具执行后立即发射，而是被 checkpoint 事件穿插——事件的时序
  语义不清晰。

### 2.7 MCP 工具集成评估

**评分：7/10**

MCP 工具集成通过 `McpLifecycleManager` 和 `McpServerController` 实现了一套完整的状态机。

**问题：**

- **MCP 工具的生命周期事件未被 Tool Hook 链消费**：`McpServerStateEvent`（server-state、
  server-diagnostic、tools-refreshed）只被 `McpLifecycleManager` 内部消费。
  `AgentSessionLoop` 不知道 MCP server 的状态变化，因此当 MCP server 降级时，
  工具调用可能已经在管线上排队了。

- **MCP 工具的执行总是同步等待**：`executeManagedTool`（`mcp-lifecycle.ts:557-593`）
  在每次工具调用前都会 `waitForReady`（带 30s 超时）。这个超时可能是合理的，
  但 `ToolExecutor` 层面无法区分「MCP 工具正在连接」和「MCP 工具已超时」——两者
  都表现为 `Promise<ToolOutput>` 的延迟。没有超时原因的结构化传递。

- **MCP 工具的审批不经过 MCP 层面**：MCP 工具的审批走的是通用路径
  （`resolvePermission`），没有 MCP 特有的审批上下文（如 server 名称、server 状态、
  传输类型）。`PermissionRequest` 中的 `toolMetadata` 只包含通用字段。

---

## 3. 差距深度分析

### 3.1 缺少 beforeTool/afterTool 生命周期 Hook

**现状**：`AgentHooks` 定义了 `beforeToolCall` 和 `afterToolCall`
（`hook-types.ts:105-122`），但这两个 Hook 只在大循环的硬编码调用点中执行
（`agent-session-loop.ts:1462-1497, 1672-1709`），没有标准化的事件驱动注册机制。

**差距**：

1. **Hook 与 Middleware 各自为政**：`AgentHooks.beforeToolCall` 是 session-loop 级别
   的拦截，`ToolMiddleware.beforeExecute` 是 tool-executor 级别的拦截。二者可以
   同时注册，但执行顺序没有定义，也没有冲突消解机制。

2. **Hook 返回值与 Middleware 返回值不同构**：
   - `AgentHooks.beforeToolCall` 返回 `{ block, reason, modifiedInput }`
   - `ToolMiddleware.beforeExecute` 返回 `{ proceed, modifiedInput, blockReason, events }`
   两个接口语义相同但字段名不同（`block` vs `proceed`，含义正好相反），增加了消费方
   的转换成本。

3. **没有 afterMiddleware 级别的批量拦截点**：当前 afterToolCall 只针对单工具结果。
   没有 `afterBatch` Hook，因此无法在整批工具执行后做结果汇总、资源释放、审计快照。

4. **Hook 不能被 MCP 层消费**：MCP server 列表刷新后（`tools-refreshed` 事件）
   不会触发任何 Hook。扩展系统无法监听到工具集的变更。

### 3.2 缺少 Tool Preset 系统

**现状**：工具选择完全由上层（`AgentRuntimeOptions.tools` + `toolSources`）决定，
`AgentSessionLoop` 全量接收，不进行任何过滤。

**差距**：

1. **没有模式绑定的工具可见性**：不同运行模式应当看到不同工具集：
   - `plan` 模式：只读工具 + 文件系统浏览工具（无 edit/write/run）
   - `ask` 模式：全部工具（但危险操作需要确认）
   - `full-access` 模式：全部工具（自动放行，T4 仍需确认）
   - `unattended` 模式：只读 + 自动工具
   当前所有模式看到的是同一组工具。

2. **没有工具组（Tool Group）的概念**：工具的「族」（`tool.category`）定义了工具的
   行为分类（filesystem / terminal / network / mcp / agent / skill），但没有组的概念
   来按场景选择工具子集。例如「调试场景」可能需要 `shell_command + read + grep`，
   「编码场景」需要 `edit + search + apply_workspace_edits`。

3. **没有模型能力驱动的工具过滤**：不同模型对工具 Schema 的支持不同（OpenAI 的
   `strict` 模式 vs Anthropic 的 tool_use 模式）。当前所有工具无差别地发给所有模型。

### 3.3 缺少 Model-Tool-Routing

**现状**：`prompt-assembly.ts` 是全量发送 tools 数组给 provider，不做任何按模型
能力的剪裁。

**差距**：

1. **没有模型能力声明**：没有模型注册表来描述「模型 X 支持多少工具」、
   「支持 tool_use_id 重复」、「支持 parallel tool call 数量上限」等。

2. **没有工具兼容性适配层**：`ProviderToolCallJsonAccumulator`
  （`provider-stream-contract.ts:192-238`）的设计假设所有 provider 都使用 JSON 参数，
  但不同 provider 的参数编码不同（OpenAI function calling 的 strict 模式要求 JSON Schema）。
  没有一个适配层来根据模型类型对工具 Schema 做转换。

3. **没有回退机制**：如果模型不支持当前工具集的某个特性（如嵌套 object schema），
   没有回退到简化 Schema 的策略。当前工具 Schema 直接传递给 provider，如果 provider
   拒绝，整个请求失败。

### 3.4 缺少审批流水线

**现状**：审批路径是 `resolvePermission` → `permissionPolicy.decide` →
`approvalHandler.requestApproval` 的三段式硬编码。

**差距**：

1. **没有分层决策模型**：没有「自动层 → 轻量确认层 → 管理员审批层 → 多重签名层」
   的层次化决策模型。当前只有「自动过」和「弹出确认」两档。

2. **没有链式审批**：对于高风险操作（T4 hardline 命令），需要双层确认——用户先确认
   「我知道」，再确认「我确定」。当前只有单次确认（approval-requested →
   用户 approve/deny）。

3. **没有审批策略的组合**：`TrustMode × TrustZone → TrustBehavior` 是唯一的策略。
   没有「来源规则」（如「MCP server X 的所有工具需要审批」）、「时间窗口规则」
   （如「凌晨 2-6 点所有写操作需要审批」）、「频率规则」（如「同一文件连续编辑
   3 次后需要审批」）。

4. **没有审批缓存**：同一意图（intentKey）的审批在 run 内永久不缓存。模型调
   `read` 同一文件 10 次，用户需要确认 10 次。

5. **审批事件与 session-loop 耦合**：`approval-requested` / `approval-resolved` 事件
   在 `resolvePermission` 内部发射，导致 session-loop 必须等待审批结果才能推进
   状态机。如果审批系统想要异步处理（如推送通知给手机、等待 5 分钟），session-loop
   做不到。

### 3.5 缺少 Tool 执行策略

**现状**：执行策略分散在 `ToolExecutorOptions`（`tool-executor.ts:42-47`）和
`AgentSessionLoop` 的字段中。

**差距**：

1. **没有统一的执行策略抽象**：`timeoutMs`、`parallelFailurePolicy`、最大并发数、
   重试策略、降级策略都是平铺的字段，没有封装为 `ExecutionStrategy` 类型。

2. **没有工具级别的超时定制**：所有工具共享同一个 `timeoutMs`。但 `bash` 工具
   和 `read` 工具的超时需求差异很大——`read` 应该 ~5s 超时，`bash` 可能需要
   600s。当前工具定义中 `inputSchema` 可以包含 `timeoutMs` 参数，但执行器层面
   并不使用工具级别的超时。

3. **没有重试策略**：`retryWithBackoff`（`provider-call-gateway.ts:155-166`）只在
   provider 侧使用，工具执行没有重试。临时性失败（如 MCP server 短暂离线）会导致
   整次工具调用失败。

4. **没有并发控制**：`ToolExecutor.partitionBatch` 只根据 `concurrency` 分区，
   没有全局并发度控制。如果模型一次发出 50 个 parallel 工具调用，它们会同时执行——
   没有上限。

### 3.6 缺少可观测性

**现状**：唯一的时间信息是 `durationMs` 字段（`ToolBatchResult.durationMs`）。

**差距**：

1. **没有执行追踪**：工具执行过程中没有 Trace ID、Span ID，无法与外部 APM 系统
   关联。一次工具调用在 session-loop、tool-executor、single-tool-executor、工具实现
   四个层面的耗时无法聚合。

2. **没有一个总的工具执行计数器**：`AgentSessionLoop` 有 `turnIndex` 和
   `toolCallCount`（在状态机上下文中），但这些是轮次级别的。没有全局的工具调用
   次数、成功/失败次数、总耗时等指标。

3. **没有进度事件的结构化**：`tool-update` 事件的 `update` 字段是 `ToolProgressUpdate`，
   但只包含 `{ text }` 和可选的 `{ json, metadata }`。工具执行中的分阶段进度
   （「正在分析文件...」「正在写入...」）无法被 UI 解析为结构化进度条。

4. **没有工具级别的日志**：工具的 stdin/stdout/stderr（对于 bash）或输入/输出
   （对于 file tools）只出现在 `ToolBatchResult` 中。没有单独的审计日志来记录
   「谁在什么时候调用了什么工具」。

### 3.7 缺少 Tool 上下文（ExecutionContext 设计不足）

**现状**：`ToolExecutionContext` 包含最小字段集。`HookContext` 包含更多字段但不
继承自 `ToolExecutionContext`。

**差距**：

1. **`HookContext` 和 `ToolExecutionContext` 互不兼容**：二者都是「工具调用的上下文」，
   但字段不同——`HookContext` 有 `tool`、`turnIndex`；`ToolExecutionContext` 有
   `emit`、`signal`。如果某个中间件既需要访问 tool 实例又需要 emit 进度，必须
   同时接受两个参数。

2. **没有运行态参数注入**：工具可能需要知道当前 `mode`、`trustPolicyMode`、
   `providerId`、`model` 等信息来调整行为。当前无法获取。

3. **没有上下文传播链**：session-loop → tool-executor → single-tool-executor →
   tool.execute() 之间的上下文没有自动传播。每个层级重新构造上下文。

---

## 4. 具体代码证据

以下是根据代码审查确认的具体代码文件与行号，作为上述差距分析的证据：

1. **`packages/agent-runtime/src/agent-session-loop.ts:1462-1497`** — `beforeToolCall` Hook
   调用点，与 `ToolMiddleware` 系统无关联。

2. **`packages/agent-runtime/src/agent-session-loop.ts:1672-1709`** — `afterToolCall` Hook
   调用点，同样隔离于 MiddlewarePipeline。

3. **`packages/agent-runtime/src/agent-session-loop.ts:1798-1907`** — `resolvePermission`，
   审批逻辑、事件发射、人工审批等待全部耦合在一个 AsyncGenerator 中。

4. **`packages/agent-runtime/src/agent-session-loop.ts:1421-1785`** — `executeSingleTool`，
   350+ 行方法同时处理输入修复、校验、权限、执行、物化、Checkpoint 六件事。

5. **`packages/agent-runtime/src/agent-session-loop.ts:195-211`** — `findFatalToolError`，
   通过 `tool.fatalOnError` 和 `output.json` 的结构化字段判断是否为致命错误，
   与 `ToolExecutionCompletion` 类型脱节。

6. **`packages/agent-runtime/src/runtime-components/tool-executor.ts:61-68`** —
   `ToolExecuteHook` 类型，是整个 `ToolExecutor` 唯一的扩展点，签名过度泛化。

7. **`packages/agent-runtime/src/runtime-components/tool-executor.ts:36-38`** —
   `ToolExecutionCompletion` 只有三种状态，无法表达审批拒绝、softDeny 等场景。

8. **`packages/agent-runtime/src/runtime-components/tool-executor.ts:125-544`** —
   `ToolExecutor` 类，完全不感知审批、不感知 Hook、不感知 Middleware。

9. **`packages/agent-runtime/src/hooks/hook-types.ts:25-42`** — `HookContext` 接口，
   有 `turnIndex` 但 `ToolExecutionContext` 没有。

10. **`packages/agent-runtime/src/hooks/hook-types.ts:103-137`** — `AgentHooks` 接口，
    定义了 `beforeToolCall` / `afterToolCall`，但没有 `beforeBatch` / `afterBatch`。

11. **`packages/agent-runtime/src/tools/tool-middleware.ts:47-80`** — `ToolMiddleware` 接口，
    与 `AgentHooks` 功能重叠但字段命名不兼容（`proceed` vs `block`）。

12. **`packages/agent-runtime/src/tools/tool-middleware.ts:342-424`** — `MiddlewarePipeline`
    实现，未在任何执行路径中被调用——代码被孤立。

13. **`packages/agent-runtime/src/tools/create-permission-pipeline.ts:28-39`** —
    `createPermissionMiddlewarePipeline` 工厂函数，说明系统设计者意图将审批统一为
    中间件，但 session-loop 没有接入。

14. **`packages/agent-runtime/src/tools/tool-definition.ts:33-63`** — `RegisteredTool` 类，
    实现了 `AgentTool` 接口，但 `AgentTool` 仍然是主要消费接口（在 `tool-executor.ts`、
    `agent-session-loop.ts`、`prompt-assembly.ts` 中）。

15. **`packages/agent-runtime/src/mcp-lifecycle.ts:557-593`** — `executeManagedTool`，
    每次工具调用前 `waitForReady` 30s，没有超时传播到 `ToolExecutor`。

16. **`packages/agent-runtime/src/mcp-lifecycle.ts:1090-1122`** — `createManagedMcpTool`，
    MCP 工具到 AgentTool 的手工映射。

17. **`packages/agent-runtime/src/types.ts:21-34`** — `AgentTool` 接口，缺少来源追踪
    （哪个 server 来的）、模型兼容性信息。

18. **`packages/agent-runtime/src/types.ts:94-102`** — `RuntimePermissionRequest`，
    缺少 `trustPolicyMode`、`trustZone`、`intentKey` 字段。

19. **`packages/agent-runtime/src/types.ts:104-107`** — `RuntimePermissionPolicy`，
    只有 `decide` 和 `recordDecision`，没有 `getPolicyMode`、`getTrustZone` 方法。

20. **`packages/decision-engine/src/trust-zone.ts:87-123`** — `TRUST_ZONE_MATRIX`，
    策略矩阵只用于 session-loop 的 resolvePermission，没有用于工具可见性过滤。

21. **`packages/decision-engine/src/trust-zone.ts:332-351`** — `buildIntentKey`，
    定义了意图指纹，但 `resolvePermission` 不使用缓存。

22. **`packages/decision-engine/src/permission-engine.ts:4-22`** — `PermissionEngine`，
    简单的线性规则链，没有分层决策模型。

23. **`packages/agent-daemon/src/handlers/run-handlers.ts:589-596`** — Daemon 层
    的 `approval-requested` / `approval-resolved` 事件处理，与 session-loop 的审批
    事件是两套独立的事件流。

24. **`packages/agent-daemon/src/protocol/validators/run.ts:332-360`** — 协议层的
    `approve-tool` 消息校验，与审批决策在 session-loop 内部处理的事实形成对比——
    协议层不知道审批结果最终如何消费。

25. **`packages/agent-runtime/src/provider-stream-contract.ts:38-44`** — `ProviderStreamToolCall`，
    流式工具调用类型，与 `ToolCallBlock` 有字段差异（`argumentsText` vs `input`），
    在流执行路径中需要转换。

---

## 5. 根因分析与影响评估

### 5.1 根因分析

**根本原因一：架构演进中的三层设计没有统一集成**

conex 的 Tool 系统经历了三次设计迭代：

- **Layer 1**（`runtime.ts` 时代）：工具执行是 `runtime.ts` 中 `while` 循环里的一个
  case 分支。审批、校验、执行全部在同一个函数中。

- **Layer 2**（`agent-session-loop.ts` 时代）：引入了状态机驱动的主循环，工具执行
  被提取为 `executeSingleTool` 方法，Hook 系统被引入，但`ToolMiddleware`尚未存在。

- **Layer 3**（`tool-executor.ts` + `ToolMiddleware` 时代）：`ToolExecutor` 被拆分为
  独立组件，`ToolMiddleware` 被设计为中间件管线。但**执行路径没有迁移到
  MiddlewarePipeline**——可能是出于稳定性考虑，新路径运行在旧路径旁边但从未切换。

结果是三个 Layer 的设计都在代码中可见，但没有任何一个 Layer 的 Hook 系统是完整的。

**根本原因二：审批被当作功能特性而非架构组件**

审批逻辑（`resolvePermission`）直接被编码在 `AgentSessionLoop` 中，而不是通过
依赖注入或中间件形式接入。这导致：

- 审批无法独立于 session-loop 测试
- 审批策略无法热切换（需要重启 run）
- 审批流无法扩展（双层审批、异步审批需要修改核心循环代码）

**根本原因三：工具执行缺少可组合的策略模型**

`ToolExecutorOptions` 和 `AgentRecoveryRuntimeOptions` 平铺了十几个策略字段
（`timeoutMs`、`parallelFailurePolicy`、`maxConsecutiveToolErrors`、
`maxRepeatedToolCalls`、`maxSteeringMessages`...），但这些字段之间没有逻辑组合。
`MiddlewarePipeline` 提供了组合的语法（`runBefore → execute → runAfter`），但
没有提供组合的语义——中间件之间没有数据依赖声明、没有冲突消解、没有条件执行。

### 5.2 影响评估

| 影响域 | 严重程度 | 说明 |
|--------|----------|------|
| 安全性 | 高 | T4 操作在 plan 模式下可能穿越审批（因为没有工具可见性过滤，完全依赖审批拦截） |
| 用户体验 | 高 | 频繁审批弹窗（无缓存）、太长等待（异步审批不支持）、模式切换不改变工具行为 |
| 系统可扩展性 | 高 | 增加新的审批策略需要修改 session-loop；增加新的 Hook 需要修改核心循环 |
| 测试覆盖 | 中 | `resolvePermission` 涉及事件流、审批等待、超时，难以单元测试 |
| 性能 | 中 | 意图重复审批浪费用户时间；MCP 工具 30s waitForReady 可能导致超时链式反应 |
| 可靠性 | 中 | 三套 Hook 系统（AgentHooks / ToolMiddleware / 硬编码）的执行顺序无保证 |
| 调试/可观测性 | 中 | 没有 Trace ID、没有工具执行计数器、没有审计日志 |
| MCP 集成 | 中 | MCP 降级不通知执行路径；MCP 工具不经过审批流水线 |
| Provider 适配 | 低 | Model-tool-routing 的缺失导致不支持的 Schema 可能被发给不支持的模型 |

### 5.3 优先级建议

基于影响评估，差距修复的优先级应为：

1. **P0 — 审批流水线拆分**：将 `resolvePermission` 从 session-loop 拆分为独立的
   `ApprovalPipeline` 组件，支持分层决策、审批缓存、异步审批。

2. **P0 — 统一 Hook Chain**：合并 `AgentHooks.beforeToolCall` 和
   `ToolMiddleware.beforeExecute` 为统一的 `ToolHook` 接口，将 `MiddlewarePipeline`
   接入实际的执行路径。

3. **P1 — Tool Preset 系统**：构建 mode 维度的工具可见性过滤层，让不同运行模式
   看到不同的工具集。

4. **P1 — 执行策略抽象**：将 `ToolExecutorOptions` 中的策略字段封装为
   `ExecutionStrategy` 类型，支持工具级别的策略定制。

5. **P2 — 可观测性**：添加 Trace ID、工具执行计数器、结构化进度事件。

6. **P2 — Model-Tool-Routing**：构建模型能力注册表，按模型能力剪裁工具 Schema。

7. **P3 — 执行上下文增强**：丰富 `ToolExecutionContext`，添加运行态参数和
   上下文传播链。
