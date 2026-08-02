# 审计报告：第六部分 · 子智能体编排轻量化（6.1-6.4）

> 审计日期：2026-07-23
> 审计范围：`docs/refac/refactor_plan.md` 第 747-870 行
> 代码基线：当前 main 分支

---

## 6.1 同进程子 Agent 直接执行路径

### 6.1.1 执行策略枚举是否存在？

**结论：❌ 不存在。当前代码库中没有 `SubagentExecutionStrategy` 类型，也没有 `in-process` / `daemon-rpc` / `isolated` 的区分。**

现状是存在两条独立的执行路径，但它们是**硬编码的二选一**，而非策略枚举驱动：

| 路径 | 文件 | 入口 | 事件通道 |
|------|------|------|----------|
| **同进程直连** | `packages/agent-runtime/src/subagents.ts:136` `createSubagentTool()` | 在本进程内 new `AgentRuntime` → 直接调用 `runtime.run()` | 子 `AgentEvent` 经 `observeSubagentEvent()` → 转成 `SubagentProgressEvent` → 通过 `context.emit({json: ...})` 序列化后传回父 Agent |
| **Daemon RPC 桥接** | `packages/agent-daemon/src/subagent-runtime.ts:84` `createDaemonSubagentTool()` | 调用 `options.startRun()` → Orchestrator 新建 RunEngine → 异步事件流 | `OrchestratorEvent` → `DaemonSubagentBridgeUpdate` 消息 → 经 WebSocket 广播到前端 |

同进程路径（`subagents.ts`）已经是 "in-process"，但它仍然经过了 `context.emit()` 的 JSON 序列化 → WebSocket → 前端再反序列化。子 Agent 的内部 `AgentEvent` 流必须先序列化为 JSON（`SubagentProgressEvent`），再作为 `tool-update` 事件传递给父 Agent 的运行时，然后父 Agent 遍历自己的事件迭代器时将其作为普通 `tool-update` 发射出去。前端 Timeline 必须解两层嵌套才能还原子 Agent 事件。

daemon 路径（`subagent-runtime.ts`）是 "daemon-rpc"，它通过 Orchestrator 创建独立 Run/AgentRuntime，事件走 `events: AsyncIterable<OrchestratorEvent>` 通道。

**没有 "isolated" 路径** — 虽然有 `C:\Software\conex\packages\agent-runtime\src\subagent-skill-runner.ts` 实现了工具的只读过滤和 Skill 隔离执行，但它仍然在同一个进程中 new `AgentRuntime` 执行，没有独立子进程。

### 6.1.2 `agentLoop(prompts, childContext, childConfig)` 是否存在？

**结论：❌ 不存在。原方案定义的纯函数签名 `agentLoop(prompts, childContext, childConfig) → EventStream` 未实现。**

当前等效逻辑：

| 环节 | 当前实现位置 |
|------|-------------|
| Runtime 构建 | `subagents.ts:257-268` — 手动 new `AgentRuntime(options)` |
| 主循环启动 | `subagents.ts:283` — `const iterator = runtime.run(contextPack.taskCard)` |
| AsyncGenerator 消费 | `subagents.ts:284-299` — `while (true) { const next = await iterator.next(); ... }` |
| 事件收割 | `subagents.ts:290-298` — 在循环中逐个检查 `next.value.type` |

`runtime.run()` 的定义在 `packages/agent-runtime/src/runtime.ts:106` — 这是一个 `async *run()` 方法，内部创建 `AgentSessionLoop`（`runtime.ts:149`）并委托给它。

**问题**：
- 没有统一的 `agentLoop` 纯函数。子 Agent 的创建和运行在工具 execute 函数内部通过 `new AgentRuntime` + `runtime.run()` 实现，边界模糊
- 当前架构中，同进程子 Agent 仍然使用完整的 `AgentRuntime` 构造（包含 PermissionPolicy、ConnectionManager、TokenTracker 等），造成不必要的内存开销

### 6.1.3 改进方案

#### 1) 引入 `SubagentExecutionStrategy` 枚举

```typescript
// packages/agent-runtime/src/subagent-types.ts（新建）
export type SubagentExecutionStrategy =
  | 'in-process'    // 同进程内存直连，不经过 JSON 序列化
  | 'daemon-rpc'    // 通过 Daemon RPC 桥接（现有 daemon-subagent-bridge 路径）
  | 'isolated';     // 独立子进程（Tauri Sidecar 或 child_process）

export interface SubagentStrategyConfig {
  strategy: SubagentExecutionStrategy;
  // in-process 专用
  shareToolRegistry?: boolean;
  toolFilter?: (tool: AgentTool) => boolean;
  // daemon-rpc 专用
  permissionMode?: DaemonSubagentToolOptions['permissionMode'];
  maxDepth?: number;
  // isolated 专用
  sidecarCommand?: string;
  envOverrides?: Record<string, string>;
}
```

#### 2) 重构 `createSubagentTool` 为策略驱动

将 `packages/agent-runtime/src/subagents.ts` 中 `createSubagentTool()` 函数的 execute 逻辑拆分为三个策略实现：

```typescript
// 伪代码 — 策略分派入口
async function executeSubagentByStrategy(
  strategy: SubagentExecutionStrategy,
  params: SubagentExecuteParams
): Promise<ToolOutput> {
  switch (strategy) {
    case 'in-process':
      return executeInProcess(params);
    case 'daemon-rpc':
      return executeDaemonRpc(params);
    case 'isolated':
      return executeIsolated(params);
  }
}
```

#### 3) 提取 `agentLoop` 纯函数（in-process 专用）

```typescript
// packages/agent-runtime/src/subagent-loop.ts（新建）
import type { AgentEvent, AgentMessage } from '@crish/shared-types';
import type { AgentProvider } from './types';

export interface SubagentLoopConfig {
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  provider: AgentProvider;
  tools: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface SubagentLoopResult {
  events: AgentEvent[];
  messages: AgentMessage[];
  finalText: string;
  stats: { toolUses: number; turns: number; events: Record<string, number> };
}

export async function agentLoop(
  prompt: string,
  config: SubagentLoopConfig,
): Promise<SubagentLoopResult> {
  // 轻量版：跳过 PermissionPolicy / ConnectionManager / TokenTracker 等非必要组件
  // 直接构造 AgentSessionLoop 或简化版 TurnLoop
  // ...
}
```

**当前 `agentLoop` 的位置**：应在 `packages/agent-runtime/src/` 下新建文件，与 `runtime.ts` 同级。`AgentRuntime.run()`（`runtime.ts:106`）可以降级为对 `agentLoop` 的包装。

> 也可以直接在 `packages/agent-runtime/src/runtime.ts` 中新增 `static agentLoop(...)` 方法。

#### 4) 工具调用与权限隔离（补充原方案）

**问题**：原方案未讨论子 Agent 工具调用是否共享父 Agent 的 `ToolRegistry`。

当前同进程路径（`subagents.ts:230`）：子 Agent 的 tools 由调用方通过 `options.tools` 或 `options.toolSources` 传入，**与父 Agent 的 `ToolRegistry` 完全隔离**。每个子 Agent 有自己独立的 `new ToolRegistry()`。

Daemon RPC 路径（`subagent-runtime.ts`）：子 Agent 运行在 Orchestrator 的新 Run 中，**使用全局 DaemonRegistry**，与父 Agent 共享同一 daemon 注册的工具集合。

**改进方案**：

```typescript
// 策略：in-process 时共享 ToolRegistry 引用 + 按策略过滤
function resolveToolsForChild(
  parentRegistry: ToolRegistry,
  strategyConfig: SubagentStrategyConfig
): AgentTool[] {
  if (!strategyConfig.shareToolRegistry) {
    // 不共享：子 Agent 使用传入的独立 tool list（现有行为）
    return options.tools ?? [];
  }
  // 共享：从父 ToolRegistry 中获取，可选过滤
  let tools = parentRegistry.list();
  if (strategyConfig.toolFilter) {
    tools = tools.filter(strategyConfig.toolFilter);
  }
  return tools;
}
```

**权限隔离**：
- 子 Agent 应当使用**独立的 `PermissionPolicy` 实例**，不可与父 Agent 共享状态（如 `MutationLeaseOwner`）
- `in-process` 子 Agent 应默认继承父 Agent 的 `PermissionPolicy`，但需覆盖 `ToolExecutionContext.sessionId` 以隔离 MutationLease
- 关键隔离点：`packages/agent-runtime/src/runtime-components/tool-executor.ts:440` — `ToolExecutionContext` 的构造，应注入子 Agent 的 `sessionId` 而非父 Agent 的

---

## 6.2 Copy-on-Write 上下文隔离（COW Context Views）

### 6.2.1 `AgentContextBase` 是否存在？

**结论：❌ 不存在。当前没有 `AgentContextBase` / `AgentContextView` 的分层设计。**

当前实现是 `buildSubagentContextPack()`（`packages/agent-runtime/src/subagent-context-pack.ts:72`），它：
1. 接收全部输入（`baseSystemPrompt`, `policyPack`, `projectProgress`, `recentSubagentTasks`, `contextState` 等）
2. 立即生成三个字符串：`renderStablePrefix()`、`renderVolatileContext()`、`renderTaskCard()`
3. 立刻拼装成 `prompt` 大字符串（第 78 行）：`const prompt = `${stablePrefix}\n\n${volatileContext}\n\n${taskCard}``
4. 立即计算 Sha256 哈希（第 79-81 行）
5. 所有子 Agent 的 `stablePrefix` 即使内容相同也会重复执行字符串拼接和哈希

### 6.2.2 `AgentContextBase` 不可变引用的安全性

**结论：`readonly` 在 TypeScript 层面是编译时约束，运行时无法阻止引用修改。**

以 `AgentContextBase.systemPrompt` 为例：
```typescript
interface AgentContextBase {
  readonly systemPrompt: string;  // string 是 immutable 的，安全
  readonly policyPack: PolicyPack;  // 如果 PolicyPack 内部有 mutable 字段则不安全
  readonly toolSchemas: CanonicalTool[];  // readonly 不阻止数组元素修改
}
```

- `string` 在 JS 中不可变 ✅
- `readonly` 在 TS 编译后就丢失，`policyPack` 如果是 `{ items: string[] }`，外部仍可通过 `(base as any).policyPack.items.push(...)` 修改 ❌
- `readonly CanonicalTool[]` 不阻止 `base.toolSchemas[0] = x` 或 `base.toolSchemas.push(x)` ❌

**安全实现要求**：
1. 对于 `toolSchemas`，必须使用 `ReadonlyArray<CanonicalTool>` + `Object.freeze()` 运行时加固
2. `policyPack` 或其内部数组需要通过 `deepFreeze()` 加固

### 6.2.3 改进方案

```typescript
// packages/agent-runtime/src/agent-context.ts（新建）

export interface AgentContextBase {
  readonly systemPrompt: string;
  readonly policyPack: Readonly<PolicyPack>;
  readonly toolSchemas: ReadonlyArray<CanonicalTool>;
}

export interface AgentContextView extends AgentContextBase {
  messages: AgentMessage[];
  cwd: string;
  sessionId: string;
  parentSessionId?: string;
}

let sharedBase: AgentContextBase | null = null;

export function initAgentContextBase(input: {
  systemPrompt: string;
  policyPack: PolicyPack;
  toolSchemas: CanonicalTool[];
}): AgentContextBase {
  if (sharedBase) return sharedBase;
  sharedBase = Object.freeze({
    systemPrompt: input.systemPrompt,
    policyPack: deepFreeze(input.policyPack),
    toolSchemas: Object.freeze([...input.toolSchemas]),
  });
  return sharedBase;
}
```

#### 懒渲染（Lazy Rendering）

当前 `renderStablePrefix()`（`subagent-context-pack.ts:125-141`）在每次调用时立即拼接字符串。改进为：

```typescript
// 结构化模板，不预渲染
export interface StructuredSystemPrompt {
  base: string;
  policyLines: string[];
  progressLines: string[];
}

// 仅在向 LLM 发送请求前渲染
function renderSystemPrompt(base: StructuredSystemPrompt, view: AgentContextView): string {
  return [
    '<subagent_context stable_prefix="true" version="1">',
    '# Role',
    'You are a focused sub-agent...',
    section('Base System Prompt', base.base),
    section('Policy Pack', bullets(base.policyLines)),
    ...view.messages.length ? section('Message Context', '...') : '',
    '</subagent_context>',
  ].filter(Boolean).join('\n');
}
```

##### 缓存策略

```typescript
const stablePrefixCache = new Map<string, {
  hash: string;
  content: string;
}>();

function getOrRenderStablePrefix(input: {
  baseSystemPrompt: string;
  policyPack: string[];
  projectProgress: string[];
}): { hash: string; content: string } {
  // stablePrefixHash 作为缓存 key 已有基础（subagent-context-pack.ts:95），但未用作跨子 Agent 共享
  const key = hashText(input.baseSystemPrompt + input.policyPack.join('|'));
  const cached = stablePrefixCache.get(key);
  if (cached) return cached;
  const content = renderStablePrefixImpl(input);
  const hash = hashText(content);
  stablePrefixCache.set(key, { hash, content });
  return { hash, content };
}
```

当前代码中已有 `cacheKey`（`subagent-context-pack.ts:95`）但只在 metadata 中记录，未实际用于跨实例缓存。

---

## 6.3 事件冒泡与零拷贝 Timeline 更新

### 6.3.1 `BubbledAgentEvent` 是否存在？

**结论：❌ 不存在。没有 `BubbledAgentEvent` 类型，也没有 `_bubbled` / `parentToolCallId` / `subagentRunId` / `depth` 字段在事件类型中的定义。**

当前事件冒泡路径：

**同进程路径（`subagents.ts`）**：
```
子 AgentEvent → observeSubagentEvent() → SubagentProgressEvent(JSON)
→ context.emit({json: {subagent: ...}})
→ 父 AgentEventStream 中作为 tool-update 出现
→ DaemonSubagentBridge.processAgentEvent() 收到后重新广播
→ 前端接收 "subagent-event" 消息
→ applySubagentEventToMessages() 反序列化渲染
```

**Daemon RPC 路径（`subagent-runtime.ts`）**：
```
OrchestratorEvent → runtime-event → DaemonSubagentBridgeUpdate
→ context.emit({json: DaemonSubagentBridgeUpdate})
→ 父 DaemonSubagentBridge.processBridgeUpdate() 收到
→ 广播 "subagent-started/event/ended" WebSocket 消息
→ 前端接收 → applySubagentEventToMessages()
```

两条路径都经过**双重甚至三重 JSON 序列化**：
1. 子 Agent 的 `AgentEvent` → JSON（作为 `tool-update.json`）
2. `DaemonSubagentBridge.processAgentEvent()` 递归解嵌
3. 再次序列化为 WebSocket outbound 消息

### 6.3.2 `depth` 字段是否足够？

**结论：`depth: number` 字段可以表示嵌套深度，但缺少层级路径标识，无法精确定位祖先。**

当前代码已有 depth 概念：
- `packages/agent-runtime/src/subagents.ts:62-65` — `SubagentDepthContext` 有 `currentDepth`
- `packages/agent-runtime/src/types.ts:139` — `AgentRuntimeOptions.subagentDepth`
- `packages/agent-daemon/src/subagent-runtime.ts:169` — `depth: options.depth + 1`

但 depth 仅用于**递归守卫**（是否超过 `maxDepth`），**未附加到事件上**供前端归因。

**改进建议**：增加 `subagentPath: string[]` 字段（每个元素为 `subagentRunId`），形成完整祖先路径链：

```typescript
interface BubbledAgentEvent extends AgentEvent {
  _bubbled: true;
  parentToolCallId: string;
  subagentRunId: string;
  depth: number;
  subagentPath: string[];  // 新增：如 ["run_a", "run_b"] 表示父→子→孙
}
```

### 6.3.3 零拷贝传输与前端的反序列化（补充原方案）

**问题**：原方案说 "无需 JSON 反序列化"，但没有说明在内存直连时前端如何接收结构化对象。

**当前前端架构限制**：
- 前端通过 WebSocket 接收消息（`C:\Software\conex\apps\crish-desktop\src\api\subagentApi.ts` — `sendToSubagent()` 通过 `client.request()`）
- `subagentTimeline.ts:106` — `applySubagentEventToMessages()` 接受 `Record<string, unknown>`，本质是 `JSON.parse` 后的结果
- 即使同进程内存通道拿到结构化 `AgentEvent` 对象，前端也无法直接接收 — 因为前（Tauri WebView）后（Tauri Rust/Daemon）是跨进程的

**Tauri Desktop 模式下的零拷贝方案**：

```
Daemon (Rust/Node) → Tauri IPC → Tauri frontend (WebView)
```

在 Tauri IPC 中实现零拷贝需要：
1. 使用 Tauri 的 `invoke` 或 `events` 机制传 `serde_json::Value`，减少 Frame 封装与 `JSON.parse` 开销 — 但仍然是序列化-反序列化
2. 真正的零拷贝需通过 `Tauri::ipc::Response` 直接传递 `Vec<u8>` 的共享内存，前端通过 `ArrayBuffer` 访问

**实际的可行方案**（Tauri Desktop）：

```typescript
// 1. 在 Daemon 端，不经过 WebSocket 帧封装，直接用 Tauri event 发射
// packages/agent-daemon/src/sidecar/commands.rs
#[tauri::command]
async fn emit_subagent_event(event: BubbledAgentEvent, app: tauri::AppHandle) {
    app.emit("subagent-event", serde_json::to_value(event)?);
}

// 2. 前端监听 Tauri event，跳过 WebSocket 消息解析层
// apps/crish-desktop/src/hooks/useChatStream.ts
import { listen } from '@tauri-apps/api/event';
listen<BubbledAgentEvent>('subagent-event', (event) => {
  // event.payload 是已反序列化的 JS 对象，无需 JSON.parse
  applySubagentEventToMessages(messages, event.payload as unknown as Record<string, unknown>);
});
```

**对于纯浏览器（WebSocket）路径**：
- JSON 序列化不可避免
- 但可消除一层嵌套：当前 `tool-update` 中嵌 `{ json: { subagent: { ... } } }`，应改为直接发射 `subagent-event` 消息类型
- 减少 `DaemonSubagentBridge.processAgentEvent()` 的递归解嵌调用（`daemon-subagent-bridge.ts:32-37`）

### 6.3.4 改进方案

1. **新增 `BubbledAgentEvent` 类型**（在 `packages/shared-types/src/events.ts` 中）：

```typescript
export interface BubbledAgentEventMetadata {
  _bubbled: true;
  parentToolCallId: string;
  subagentRunId: string;
  depth: number;
  subagentPath: string[];
}

// 在 AgentEvent 中增加 bubbled 变体，或使用元数据附加
export type AgentEvent = 
  | AgentDomainEvent 
  | TurnDomainEvent 
  | ...
  | (DiagnosticDomainEvent & { _bubbled?: BubbledAgentEventMetadata });
```

为保持类型安全，建议使用 discriminated union：
```typescript
export type AgentEvent = 
  | { type: 'agent-start' | 'agent-end' | ... }
  | (AgentDomainEvent & { _bubbled: BubbledAgentEventMetadata });
```

2. **重构 `subagentTimeline.ts`**：增加直接接收已结构化 `BubbledAgentEvent` 的重载

3. **Tauri IPC 路径**：在 `useChatStream.ts`（`apps/crish-desktop/src/hooks/useChatStream.ts:978`）的 `applySubagentEventToMessages` 调用处，增加 Tauri event listener 分支

---

## 6.4 子 Agent 断线恢复状态机简化

### 6.4.1 `SubagentLifecycleState` 是否存在？

**结论：❌ 不存在。当前没有统一的 `SubagentLifecycleState` 枚举，状态管理分散在多个数据结构中。**

当前状态管理分布：

| 状态集合 | 位置 | 状态值 |
|----------|------|--------|
| `SubagentStatus` | `packages/agent-runtime/src/subagents.ts:30` | `"started" | "running" | "completed" | "failed"` |
| `DaemonSubagentBridgeUpdate["phase"]` | `packages/agent-daemon/src/subagent-runtime.ts:61-64` | `"started" | "event" | "ended"` |
| `SubagentRunState["status"]` | `packages/agent-daemon/src/subagent-runtime.ts:67` | `"completed" | "failed"` |
| `ActiveSubagent` | `packages/agent-daemon/src/daemon-subagent-bridge.ts:12-19` | **隐式** — 存在 Map 中即为 running，不存在即为 ended/cleared |
| 全局并发计数 | `packages/agent-runtime/src/subagents.ts:54` | `activeSubagentCount: number`（仅计数，无状态细节） |

**缺失的机制**：
- `orphaned` 状态 ❌ — `DaemonSubagentBridge.clearRun()`（`daemon-subagent-bridge.ts:131`）直接删除，不标记 orphaned
- 超时回收 ❌ — 无 orphaned timeout 机制
- 统一状态转换函数 ❌ — `clearRun` 和 `clearAll` 直接操作 Map，没有 `transition()` 函数

### 6.4.2 状态机完备性评估

原方案定义的 6 状态：
```
starting → running → completed
                    → failed
                    → cancelled
          → orphaned (父 Run 结束，子悬空)
```

**问题 1：`cancelled` 的触发时机**
- 父 Agent Cancel 触发子 Agent 取消时，是通过 `DaemonSubagentToolOptions.cancelRun()`（`subagent-runtime.ts:199`）还是 `AbortController`？
- 当前同进程路径（`subagents.ts`）没有 Cancel 传播逻辑 — 父 `AbortController` 不会自动传播到子 `AgentRuntime`

**问题 2：`orphaned` 超时回收的实现**
- 父 Run 结束（如 `clearRun` 调用）时子 Agent 可能仍在运行（daemon 后台 forkMode: "background"）
- 当前 `DaemonSubagentBridge.clearRun()` 直接删除 Map 条目，**不发送 cancel 信号**，子 Agent 会在后台继续执行直到自然结束，但 bridge 不再跟踪
- 这些就是事实上的 "孤儿"，但无超时回收机制

### 6.4.3 改进方案

```typescript
// packages/agent-daemon/src/subagent-lifecycle.ts（新建）

export type SubagentLifecycleState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

export type SubagentLifecycleEvent =
  | { type: 'STARTED' }
  | { type: 'EVENT' }
  | { type: 'COMPLETED'; summary: string }
  | { type: 'FAILED'; error: string }
  | { type: 'CANCELLED'; reason: string }
  | { type: 'PARENT_RUN_ENDED' }
  | { type: 'TIMEOUT' };

export class SubagentRegistry {
  private entries = new Map<string, SubagentLifecycleEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  transition(id: string, event: SubagentLifecycleEvent): SubagentLifecycleState {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Subagent ${id} not found`);
    const next = this.nextState(entry.state, event);
    entry.state = next;
    // orphaned → 30s 超时自动 cancel
    if (next === 'orphaned') {
      this.scheduleOrphanTimeout(id);
    }
    return next;
  }

  private nextState(
    current: SubagentLifecycleState,
    event: SubagentLifecycleEvent
  ): SubagentLifecycleState {
    switch (current) {
      case 'starting':
        if (event.type === 'STARTED') return 'running';
        if (event.type === 'FAILED') return 'failed';
        if (event.type === 'CANCELLED') return 'cancelled';
        if (event.type === 'PARENT_RUN_ENDED') return 'orphaned';
        return current;
      case 'running':
        if (event.type === 'COMPLETED') return 'completed';
        if (event.type === 'FAILED') return 'failed';
        if (event.type === 'CANCELLED') return 'cancelled';
        if (event.type === 'PARENT_RUN_ENDED') return 'orphaned';
        return current;
      case 'orphaned':
        if (event.type === 'TIMEOUT') {
          this.forceCancel(id, 'orphaned-timeout');
          return 'cancelled';
        }
        if (event.type === 'COMPLETED') return 'completed';
        if (event.type === 'FAILED') return 'failed';
        return current;
      // completed / failed / cancelled 为终态
      default:
        return current;
    }
  }

  private scheduleOrphanTimeout(id: string): void {
    const timer = setTimeout(() => {
      this.transition(id, { type: 'TIMEOUT' });
    }, 30_000);
    this.timers.set(id, timer);
  }

  private forceCancel(id: string, reason: string): void {
    // 调用 cancelRun 发送 CANCEL 信号
    const entry = this.entries.get(id);
    entry?.cancelRun(entry.runId, reason);
    this.entries.delete(id);
  }
}
```

**状态转换矩阵**：

```
                    ┌─────────┐
                    │starting │
                    └────┬────┘
              ┌──────────┼──────────┐
              │          │          │
         PARENT_RUN   STARTED    FAILED/CANCELLED
              │          │          │
              ▼          ▼          ▼
          ┌───────┐  ┌───────┐  ┌──────────┐
          │orphaned│  │running│  │终态(f/c)│
          └───┬───┘  └───┬───┘  └──────────┘
              │          │
        TIMEOUT│    ┌────┼──────────┐
        (30s)  │    │    │          │
              ▼    │    │          │
          ┌───────┐│    ▼          ▼
          │cancelled││  completed  failed
          └────────┘│
```

### 6.4.4 孤儿检测的触发时机

```typescript
// 在 DaemonSubagentBridge.clearRun() 中，不应直接 delete，而应 transition 为 orphaned
// packages/agent-daemon/src/daemon-subagent-bridge.ts:131-142
clearRun(runId: string): string[] {
  const removed: string[] = [];
  for (const [subagentId, info] of this.activeSubagents) {
    if (info.runId !== runId) continue;
    // Before: this.activeSubagents.delete(subagentId);
    // After:
    registry.transition(subagentId, { type: 'PARENT_RUN_ENDED' });
    removed.push(subagentId);
  }
  return removed;
}
```

此外，DaemonSubagentBridge 的事件处理中（`daemon-subagent-bridge.ts:29`），应在子 Agent 自然结束时调用 `transition(..., COMPLETED)`，在错误时调用 `transition(..., FAILED)`。

---

## 总结：当前代码覆盖度矩阵

| 原方案概念 | 代码中是否存在 | 关键文件 | 状态 |
|-----------|--------------|---------|------|
| `SubagentExecutionStrategy` 三种策略 | ❌ | 不存在 | ⚠️ 需新建 |
| `agentLoop()` 纯函数 | ❌ | 不存在 | ⚠️ 需从 `runtime.ts:106` 和 `agent-session-loop.ts` 提取 |
| `AgentContextBase` 不可变视图 | ❌ | 不存在 | ⚠️ 需新建，当前 `buildSubagentContextPack()` 在 `subagent-context-pack.ts:72` |
| COW 懒渲染 | ❌ | 不存在 | ⚠️ 当前是 eager 拼接 |
| 共享 ToolRegistry | ⚠️ 部分 | `tool-definition.ts:71` | 同进程不共享，daemon 路径共享全局 |
| `BubbledAgentEvent` | ❌ | 不存在 | ⚠️ 需在 `shared-types/events.ts` 新增 |
| 零拷贝前端传输 | ❌ | 不存在 | ⚠️ 需在 Tauri IPC 层实现 |
| `SubagentLifecycleState` 枚举 | ❌ | 不存在 | ⚠️ 需新建 |
| `orphaned` 超时回收 | ❌ | 不存在 | ⚠️ 需在 `daemon-subagent-bridge.ts` 中新增 |
| 统一 `transition()` 函数 | ❌ | 不存在 | ⚠️ 需新建 `SubagentRegistry` |

### 下一步行动建议

1. **P0**：在 `packages/shared-types/src/events.ts` 中新增 `BubbledAgentEvent` 类型，在 `packages/agent-runtime/src/` 下新建 `subagent-types.ts` 定义 `SubagentExecutionStrategy`
2. **P0**：在 `packages/agent-daemon/src/` 下新建 `subagent-lifecycle.ts` 实现 `SubagentRegistry` + 状态机
3. **P1**：从 `AgentRuntime.run()` 提取 `agentLoop()` 纯函数到 `subagent-loop.ts`
4. **P1**：在 `subagent-context-pack.ts` 中引入 stablePrefix 跨子 Agent 共享缓存
5. **P2**：在 Tauri IPC 层实现零拷贝 event 传输（绕过 WebSocket）
6. **P2**：补充 `in-process` 子 Agent 的工具隔离策略 — `ToolExecutionContext.sessionId` 和 `MutationLeaseOwner` 必须隔离
