# 子计划 04：Layer D — Daemon & Orchestrator (Daemon 服务与编排层)

> **层级编号**：Layer D（Round 4，依赖 Layer A 基础设施、Layer C Runtime API 稳定后启动）
> **建议 Agent 数量**：5 个（按文件/模块互斥划分）
> **涉及维度**：D1（上帝文件/上帝类）、D3（逻辑重复 — 消息类型/协议定义）、D4（并发 — WS 消息路由竞态）、D5（IPC 边界 — 协议验证）、D6（API 层）
> **涉及包**：`packages/agent-daemon/src/`、`apps/agent-workbench/src/shared/`
> **下游依赖方**：Layer E (State & API) 消费 Daemon 的 session/event 接口、Layer F (UI) 消费 workbench-contract 类型

---

## 一、层级目标

Layer D 的核心使命是拆分 Daemon 服务和 Workbench 共享层的上帝文件群：

1. **[已完成：A-1]** `workbench-contract.ts` 拆分已在 Layer A 中完成，Layer D 不再重复。
2. **拆分** `types.ts`（1,884 行 / 47 KB）— Daemon 消息协议与实体类型混杂。
3. **拆分** `server.ts`（1,407 行 / 46 KB）— `DaemonServer` 上帝类。
4. **拆分** `server-runtime-factory.ts`（1,381 行 / 42 KB）— 运行时工厂。
5. **拆分** `daemon-provider-gateway.ts`（1,183 行 / 37 KB）— Provider 网关。
6. **瘦身** `workflow-store.ts`（781 行）、`task-snapshot-projection.ts`（590 行）。
7. **重构** WS 消息路由与 handler 注册机制。
8. **修复** 事件广播与客户端资源泄漏。

---

## 二、任务总表

| 任务 ID | 目标文件 | 行数/KB | 核心问题 | 修复策略 | 来源维度 | 分配 Agent |
|---------|---------|---------|---------|---------|---------|-----------|
| D-1 | `types.ts` (daemon) | 1,884 / 47KB | 100+ 消息类型 + 实体 + 配置全混杂 | 协议/消息/实体分离 | D1 | Agent D1 |
| D-2 | `server.ts` | 1,407 / 46KB | DaemonServer 30+ 字段的上帝类 | 提取 Delegate 组件 | D1 | Agent D2 |
| D-3 | `server-runtime-factory.ts` | 1,381 / 42KB | 运行时工厂混杂配置合并+MCP+Provider+工具+权限 | 按子工厂拆分 | D1 | Agent D2 |
| D-4 | `daemon-provider-gateway.ts` | 1,183 / 37KB | 凭证模式+Provider创建+健康管理+诊断混杂 | 按职责拆分 | D1 | Agent D3 |
| D-5 | `workflow-store.ts` | 781 / 25KB | 文件持久化+CRUD+fsync+验证混杂 | 提取存储引擎 | D1 | Agent D3 |
| D-6 | `task-snapshot-projection.ts` | 590 / 22KB | 单函数 CC≈35 的事件遍历 | 拆分为子处理器 | D1, D8 | Agent D4 |
| D-7 | `workbench-config.ts` | ~500 / 17KB | 配置类型+解析+默认值混杂 | 类型与解析分离 | D1 | Agent D1 |
| D-8 | WS 消息路由 | server.ts | 巨型 switch/if-else 消息分发 | 注册式 handler map | D8 | Agent D2 |
| D-9 | 事件广播泄漏 | server.ts | WS 断开后未清理 run 监听器 | 添加 client disconnect cleanup | D4 | Agent D4 |
| D-2f | ApprovalBridge | `server/approval-bridge.ts`(新建) | 审批请求未对接 ApprovalPipeline | 异步挂起/恢复桥接 | D6 | Agent D2 |

---

## 三、任务 D-1：workbench-contract.ts 领域拆分

> **状态：已在 Layer A（A-1）中完成。** Layer A-1 已将此文件拆分为 7 个独立的领域子模块（`plan-document.ts`、`approval.ts`、`daemon-session.ts`、`conversation-rewind.ts`、`daemon-status.ts`、`task-snapshot.ts`、`workbench-ui.ts`），并通过 barrel `workbench-contract/index.ts` 保持 100% 向后兼容。Layer D 不再重复此任务。

### 3.4 迁移步骤

**Step 1**：创建 `workbench-contract/` 目录。

**Step 2**：从上到下，将每个领域的类型定义剪切到对应子文件中。注意跨领域的基础类型（如 `WorkbenchJsonValue`, `WorkbenchJsonObject`）应放在 `workbench-ui.ts` 中，被其他文件 import。

**Step 3**：创建 `index.ts` barrel：

```typescript
export * from './plan-document';
export * from './approval';
export * from './daemon-session';
export * from './conversation-rewind';
export * from './daemon-status';
export * from './task-snapshot';
export * from './workbench-ui';
```

**Step 4**：简化原始 `workbench-contract.ts` 为：

```typescript
export * from './workbench-contract/index';
```

**Step 5**：验证所有消费者的 import 正常：

```bash
npx tsc --noEmit
```

---

## 四、任务 D-2：daemon types.ts 拆分

### 4.1 问题现状

[types.ts](file:///c:/Software/conex/packages/agent-daemon/src/types.ts)（1,884 行 / 47 KB）是 Daemon 包的"协议圣经"，包含：

- **100+ 个 WebSocket 消息类型**（`DaemonInboundMessage` 联合类型，包含 50+ 个消息变体）
- **实体类型**（`WorkflowDefinition`, `DaemonTaskSnapshot`, `DaemonProviderStatusSnapshot`）
- **配置类型**（`DaemonConfig`, `DaemonMcpServerConfig`）
- **工厂输入类型**（`DaemonProviderApiKeySource`, `DaemonProviderCredentialMode`）

### 4.2 目标结构

```
packages/agent-daemon/src/types/
├── index.ts                    # barrel 重导出
├── protocol-inbound.ts         # DaemonInboundMessage 联合类型 + 所有入站消息接口
├── protocol-outbound.ts        # DaemonOutboundMessage 联合类型 + 所有出站消息接口
├── entities.ts                 # 实体类型（Workflow, Task, Session, Approval 等）
├── config.ts                   # DaemonConfig, MCP 配置
├── provider-types.ts           # Provider 相关类型（凭证模式、API key 来源、诊断）
└── snapshot-types.ts           # 各种 Snapshot 接口（DaemonTaskSnapshot, ProviderStatus 等）
```

### 4.3 关键约束

- 原 `types.ts` 的所有导出通过 barrel 保持不变。
- `types.js` 被 Daemon 包内**所有文件** import，barrel 必须正确。
- 入站消息类型之间有大量的 `& DaemonCorrelationFields` 交叉类型，需保持引用链完整。

---

## 五、任务 D-3：server.ts DaemonServer 上帝类拆分

### 5.1 问题现状

[server.ts](file:///c:/Software/conex/packages/agent-daemon/src/server.ts) 的 `DaemonServer` 类拥有 **30+ 实例字段**，负责：

```typescript
class DaemonServer {
  private wss!: WebSocketServer;              // WS 服务器
  private port!: number;
  private lifecycle!: DaemonLifecycleTracker;  // 生命周期
  private clients!: DaemonClientRegistry;      // 客户端管理
  private messageTasks = new Set<Promise<void>>();
  private orchestrator!: AgentOrchestrator;     // 编排器
  private eventStore!: DaemonEventStore;        // 事件存储
  private approvalQueue!: ApprovalQueue;        // 审批队列
  private config!: DaemonConfig;               // 配置
  private workflowStore!: FileWorkflowStore;    // 工作流存储
  private planDocumentStore!: FilePlanDocumentStore;
  private scopedContextStore!: FileScopedContextStore;
  private sessionMetadataStore!: FileSessionMetadataStore;
  private workflowScheduler!: WorkflowScheduler;
  private runtimeFactory!: DaemonRuntimeFactory;
  private backgroundTasks!: DaemonBackgroundTaskManager;
  private requestHandlers!: DaemonRequestHandlers;
  private runHandler!: RunHandler;
  private subagentBridge!: DaemonSubagentBridge;
  // ... 更多
}
```

### 5.2 修复方案

将 `DaemonServer` 拆分为以下 Delegate 组件：

| Delegate | 文件 | 提取的字段 | 职责 |
|----------|------|-----------|------|
| `DaemonStoreRegistry` | `server/store-registry.ts` | `workflowStore`, `planDocumentStore`, `scopedContextStore`, `sessionMetadataStore`, `eventStore` | 统一管理所有存储实例 |
| `DaemonConnectionManager` | `server/connection-manager.ts` | `wss`, `clients`, `connectionLimiter`, `byteLimiter` | WS 连接管理与限流 |
| `DaemonMessageRouter` | `server/message-router.ts` | `requestHandlers`, `runHandler`, `messageTasks` | 消息路由与分发 |
| `DaemonWorkflowManager` | `server/workflow-manager.ts` | `workflowScheduler`, `workflowSchedulerTimer` | 工作流调度管理 |
| `DaemonApprovalBridge` | `server/approval-bridge.ts` | `pendingApprovals` | ApprovalPipeline 异步挂起/恢复桥接 |

### 5.2.1 D-2f（新增）：ApprovalPipeline 异步挂起/恢复桥接

- **目标模块**：`server/approval-bridge.ts`（新建，作为 DaemonServer 的子模块）
- **说明**：Daemon 收到的 tool_call 审批请求（`workbench_approve_tool_call`/`workbench_deny_tool_call`）需要与 AgentSessionLoop 内部的 ApprovalPipeline（Layer H）对接。

对接协议：
```
Daemon WS 收到审批请求
  → approval-bridge 将请求转发到对应 run 的 ApprovalPipeline
  → ApprovalPipeline.decide() 返回 PermissionDecision
  → approval-bridge 将结果写入 run 的挂起 Promise
  → AgentSessionLoop 的 resolvePermission 被 resolve
```

注意事项：
1. `approval-bridge` 需要维护 `Map<runId, PendingApproval>` 映射表
2. 超时未响应的审批自动降级为 `deny`（默认 120 秒超时）
3. WS 断开后挂起的审批全部自动 `deny`
4. 此桥接模块的接口在 D 层定义，但 ApprovalPipeline 的类型来自 H 层——需要在 H 层完成后再对接实现

### 5.3 目标结构

```
packages/agent-daemon/src/
├── server/
│   ├── index.ts                    # DaemonServer 瘦身后的主类
│   ├── store-registry.ts           # 存储注册表
│   ├── connection-manager.ts       # 连接管理
│   ├── message-router.ts           # 消息路由
│   ├── workflow-manager.ts         # 工作流调度
│   └── approval-bridge.ts          # ApprovalPipeline 异步挂起/恢复桥接（D-2f）
├── server.ts                       # 保留为 barrel
```

### 5.4 重构后的 DaemonServer

```typescript
class DaemonServer {
  private stores!: DaemonStoreRegistry;
  private connections!: DaemonConnectionManager;
  private messageRouter!: DaemonMessageRouter;
  private workflows!: DaemonWorkflowManager;
  private orchestrator!: AgentOrchestrator;
  private runtimeFactory!: DaemonRuntimeFactory;
  private lifecycle!: DaemonLifecycleTracker;
  private config!: DaemonConfig;
  
  // 方法委托
  async start(): Promise<void> { ... }
  async stop(): Promise<void> { ... }
}
```

### 5.5 质量门槛

- `DaemonServer` 瘦身至 ≤ 500 行。
- 每个 Delegate ≤ 400 行。
- `npm test -- server.test` 全部通过。

---

## 六、任务 D-4：server-runtime-factory.ts 拆分

### 6.1 问题现状

[server-runtime-factory.ts](file:///c:/Software/conex/packages/agent-daemon/src/server-runtime-factory.ts)（1,381 行）的 `DaemonRuntimeFactory` 类混合了：

- **配置合并**（`ConfigMerger` 集成、多来源优先级解析）
- **MCP 管理**（McpLifecycleManager 创建和配置热更新）
- **Provider 工厂**（根据凭证模式创建 Provider）
- **工具工厂**（注入 BackgroundCommandManager、WorkspaceMutationCoordinator）
- **权限策略**（`DaemonPermissionPolicy` 创建）
- **Subagent 创建**（`createDaemonSubagentTool` 集成）

### 6.2 修复方案

```
packages/agent-daemon/src/
├── server-runtime-factory/
│   ├── index.ts                    # DaemonRuntimeFactory 瘦身后
│   ├── config-assembly.ts          # 配置合并与来源优先级
│   ├── mcp-factory.ts              # MCP lifecycle manager 工厂
│   ├── tool-assembly.ts            # 工具组装（本地工具 + MCP + subagent）
│   └── types.ts                    # 工厂输入/输出类型
├── server-runtime-factory.ts       # barrel
```

---

## 七、任务 D-5：daemon-provider-gateway.ts 拆分

### 7.1 问题现状

[daemon-provider-gateway.ts](file:///c:/Software/conex/packages/agent-daemon/src/daemon-provider-gateway.ts)（1,183 行）包含：

- **凭证模式管理**（`account-center` vs `api-key` 模式切换）
- **Provider 实例创建**（根据 providerId 创建 Anthropic/Gemini/OpenAI Provider）
- **健康检查与就绪状态**（`DaemonProviderReadiness`）
- **状态快照生成**（`DaemonProviderStatusSnapshot`）
- **诊断收集**（`DaemonProviderDiagnostic`）
- **配置热更新**（`applyUpdate()`）

### 7.2 修复方案

```
packages/agent-daemon/src/
├── daemon-provider-gateway/
│   ├── index.ts                    # DaemonProviderGateway 主类
│   ├── types.ts                    # 配置/状态/诊断类型
│   ├── credential-modes.ts         # 凭证模式逻辑
│   ├── provider-factory.ts         # Provider 实例创建
│   └── health.ts                   # 健康检查与状态快照
├── daemon-provider-gateway.ts      # barrel
```

---

## 八、任务 D-7：task-snapshot-projection.ts 拆分

### 8.1 问题现状

[task-snapshot-projection.ts](file:///c:/Software/conex/packages/agent-daemon/src/task-snapshot-projection.ts)（590 行）的核心函数 `buildDaemonTaskSnapshot()` 包含一个 **巨型事件遍历 switch**（CC ≈ 35）：

```typescript
export function buildDaemonTaskSnapshot(input: BuildDaemonTaskSnapshotInput): DaemonTaskSnapshot {
  // ... 初始化 ~60 行
  for (const event of events) {
    switch (event.type) {
      case "run-queued": { ... }           // ~15 行
      case "run-started": { ... }          // ~10 行
      case "agent-start": { ... }          // ~8 行
      case "agent-message-start": { ... }  // ~20 行
      case "agent-text-delta": { ... }     // ~10 行
      case "agent-tool-call": { ... }      // ~25 行
      case "agent-tool-result": { ... }    // ~30 行
      case "agent-message-end": { ... }    // ~15 行
      case "approval-requested": { ... }   // ~20 行
      case "approval-resolved": { ... }    // ~15 行
      case "agent-end": { ... }            // ~15 行
      case "run-completed": { ... }        // ~10 行
      case "run-failed": { ... }           // ~10 行
      case "run-cancelled": { ... }        // ~10 行
      case "runtime-error": { ... }        // ~10 行
      // ... 更多 case
    }
  }
  // ... 最终组装 ~30 行
}
```

### 8.2 修复方案：事件处理器注册表

```typescript
// task-snapshot/event-handlers.ts

type EventHandler = (event: OrchestratorEvent, ctx: SnapshotBuildContext) => void;

const EVENT_HANDLERS: Record<string, EventHandler> = {
  "run-queued": handleRunQueued,
  "run-started": handleRunStarted,
  "agent-start": handleAgentStart,
  "agent-message-start": handleAgentMessageStart,
  "agent-text-delta": handleAgentTextDelta,
  "agent-tool-call": handleAgentToolCall,
  "agent-tool-result": handleAgentToolResult,
  "agent-message-end": handleAgentMessageEnd,
  "approval-requested": handleApprovalRequested,
  "approval-resolved": handleApprovalResolved,
  "agent-end": handleAgentEnd,
  "run-completed": handleRunCompleted,
  "run-failed": handleRunFailed,
  "run-cancelled": handleRunCancelled,
  "runtime-error": handleRuntimeError,
};

// task-snapshot/index.ts
export function buildDaemonTaskSnapshot(input: BuildDaemonTaskSnapshotInput): DaemonTaskSnapshot {
  const ctx = createSnapshotBuildContext(input);
  for (const event of ctx.events) {
    const handler = EVENT_HANDLERS[event.type];
    if (handler) handler(event, ctx);
  }
  return assembleSnapshot(ctx);
}
```

### 8.3 质量门槛

- `buildDaemonTaskSnapshot()` ≤ 30 行。
- 每个 handler ≤ 40 行。
- `npm test -- task-snapshot-projection` 全部通过。

---

## 九、任务 D-9：WS 消息路由重构

### 9.1 问题现状

`server.ts` 中的消息分发目前通过 `DaemonRequestHandlers` 和 `RunHandler` 类处理，但消息类型的路由（决定哪个 handler 处理哪个消息类型）仍然隐式分散在多个地方。

### 9.2 修复方案

创建一个注册式的消息路由表：

```typescript
// server/message-router.ts

type MessageHandler = (
  msg: DaemonInboundMessage,
  client: ConnectedClient
) => Promise<DaemonOutboundMessage | void>;

class DaemonMessageRouter {
  private handlers = new Map<string, MessageHandler>();
  
  register(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }
  
  async route(msg: DaemonInboundMessage, client: ConnectedClient): Promise<void> {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      client.send(errorResponse(msg, `Unknown message type: ${msg.type}`));
      return;
    }
    const response = await handler(msg, client);
    if (response) client.send(response);
  }
}
```

在 `buildDependencies()` 中一次性注册所有 handler：

```typescript
this.messageRouter = new DaemonMessageRouter();
this.messageRouter.register("run-task", (msg, client) => this.runHandler.handleRunTask(msg, client));
this.messageRouter.register("get-status", (msg) => this.requestHandlers.handleGetStatus(msg));
this.messageRouter.register("list-sessions", (msg) => this.requestHandlers.handleListSessions(msg));
// ... 其他消息类型
```

---

## 十、任务 D-10：事件广播与客户端资源泄漏修复

### 10.1 问题现状

当 WS 客户端断开连接时，`DaemonClientRegistry` 会移除客户端记录。但如果有正在运行的 Run 通过 `orchestrator.on('event')` 将事件广播到该客户端，这些监听器可能不会被清理，导致：

1. **内存泄漏**：事件监听器持有对已断开客户端的 WS 引用。
2. **静默错误**：向已关闭的 WS 发送消息抛出异常被默默吞掉。

### 10.2 修复方案

在 `DaemonClientRegistry` 的 `remove()` 方法中，确保清理与该客户端关联的所有事件监听器：

```typescript
// daemon-client-registry.ts
remove(clientId: string): void {
  const client = this.clients.get(clientId);
  if (client) {
    // 清理该客户端的所有事件订阅
    for (const unsubscribe of client.subscriptions) {
      unsubscribe();
    }
    client.subscriptions.clear();
    this.clients.delete(clientId);
  }
}
```

---

## 十一、多 Agent 并行分配方案

```
┌─────────────────────────────────────────────────────────────────┐
│                    Round 4: Layer D                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Agent D1    │  │  Agent D2    │  │  Agent D3    │          │
│  │  workbench-  │  │  daemon      │  │  server.ts + │          │
│  │  contract +  │  │  types.ts    │  │  runtime-    │          │
│  │  workbench-  │  │  拆分        │  │  factory +   │          │
│  │  config      │  │              │  │  msg router  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │  Agent D4            │  │  Agent D5            │            │
│  │  provider-gateway +  │  │  task-snapshot +     │            │
│  │  workflow-store      │  │  event broadcast     │            │
│  │  拆分                │  │  修复                │            │
│  └──────────────────────┘  └──────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Agent 互斥边界

| Agent | 独占文件 | 不得修改 |
|-------|---------|---------|
| D1 | `workbench-contract.ts`, `workbench-config.ts` | `server.ts`, `types.ts` (daemon) |
| D2 | `types.ts` (daemon), `protocol/`, `server/approval-bridge.ts`(新建) | `server.ts`, `workbench-contract.ts` |
| D3 | `server.ts`, `server-runtime-factory.ts`, `server-handlers.ts` | `types.ts`, `workbench-contract.ts` |
| D4 | `daemon-provider-gateway.ts`, `workflow-store.ts` | `server.ts`, `types.ts` |
| D5 | `task-snapshot-projection.ts`, `daemon-client-registry.ts` | `server.ts`, `types.ts` |

---

## 十二、验收标准总表

| 编号 | 检查项 | 验证方式 | 通过条件 |
|-----|--------|---------|---------|
| V-1 | workbench-contract 拆分 | `wc -l workbench-contract/*.ts` | 每个子文件 ≤ 500 行 |
| V-2 | 原 import 路径兼容 | `npx tsc --noEmit` (workbench) | 零错误 |
| V-3 | daemon types 拆分 | `wc -l types/*.ts` | 每个子文件 ≤ 400 行 |
| V-4 | DaemonServer 瘦身 | `wc -l server/index.ts` | ≤ 500 行 |
| V-5 | runtime-factory 拆分 | `wc -l server-runtime-factory/*.ts` | 每个 ≤ 400 行 |
| V-6 | provider-gateway 拆分 | `wc -l daemon-provider-gateway/*.ts` | 每个 ≤ 400 行 |
| V-7 | task-snapshot CC降低 | `buildDaemonTaskSnapshot()` 行数 | ≤ 30 行 |
| V-8 | 消息路由注册式 | 代码审查 | handler map 替代 switch |
| V-9 | 客户端断开清理 | 代码审查 | subscription cleanup on disconnect |
| V-10 | 全量构建 (daemon) | `npm run build` (agent-daemon) | 零错误 |
| V-11 | 全量测试 (daemon) | `npm test` (agent-daemon) | 零回归 |
| V-12 | 全量构建 (workbench) | `npm run build` (workbench) | 零错误 |
| V-13 | ApprovalBridge 超时降级 | 代码审查 + 单元测试 | 120 秒超时 → auto deny；WS 断开 → 所有挂起审批 deny |

---

## 十三、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| workbench-contract 拆分影响大量 UI 组件 | 高 | 中 | 原文件保留为 barrel `export *`，所有消费者零修改 |
| types.ts 拆分破坏 Daemon 包内 import | 高 | 高 | 原文件保留为 barrel，所有 `import type {...} from './types.js'` 不变 |
| DaemonServer Delegate 提取引入循环依赖 | 中 | 中 | Delegate 单向依赖主类的 types，不互相依赖 |
| 消息路由重构遗漏 handler 注册 | 中 | 高 | 编写测试验证所有 50+ 消息类型都有对应 handler |
| 事件广播修复改变时序语义 | 低 | 高 | cleanup 仅在 WS close 事件后执行，不影响正常流程 |

### 执行顺序建议

```
D1 (workbench-contract + config) ── 独立，可立即启动（纯类型移动）
D2 (daemon types) ─────────────── 独立，可立即启动（纯类型移动）
D4 (provider-gateway + workflow) ─ 独立，可立即启动
D5 (task-snapshot + broadcast) ─── 独立，可立即启动
D2f (approval-bridge) ──────────── 依赖 D2 完成（consumes types barrel），接口需等 H 层 ApprovalPipeline 类型就位
D3 (server + factory + router) ─── 依赖 D2 完成（消费 types barrel 变更）
```

即 D1/D2/D4/D5 可完全并行，D3 在 D2 完成后启动，D2f 在 D2 和 H 层完成后启动。
