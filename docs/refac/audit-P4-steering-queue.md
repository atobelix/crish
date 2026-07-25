# 审计报告：第四部分——非阻塞用户转向队列（Steering Queue）

> 审计日期：2026-07-23 | 审计范围：4.1–4.5 | 代码基线：`agent-runtime` + `agent-orchestrator` + `crish-desktop`

---

## 4.1 问题根因分析

### 审计结论：描述基本准确，但遗漏了关键细节

**现状确认**：`isAiBusy` 的拦截逻辑位于 `useChatStream.ts:1901-1956`。

```typescript
// useChatStream.ts:1901-1903
const isAiBusy = sessMsgs.some(
  (m: SessionMessage) => m.status === 'processing'
);
```

当 `isAiBusy === true` 时（line 1929）：
- 消息被写入 store，`status` 设 `'queued'`
- `runStreamingAssistant` **不被调用**（line 1950），消息进入挂起状态

当 `isAiBusy === false` 时（line 1950）：
- `runStreamingAssistant` 被调用，启动新 Run

**原方案未指出的问题**：

1. **`queued` 消息没有自动消费机制**。消息标记为 `queued` 后，只有两种途径被消费：
   - 用户在 AI 空闲后再次 `handleSendChat`——但这实际上**创建了一条新消息**，`queued` 消息永远留在 store 中成为幽灵
   - 用户自己点"停止"后再发——同样不是真正的消费

2. **`isAiBusy` 的判定窗口不可靠**。`isAiBusy` 基于 **store 中的消息状态**（`sessMsgs.some(m => m.status === 'processing')`），但 store 更新与 WebSocket 消息之间存在延迟窗口。两条消息在短时间内先后到达时，第二条可能读到 `isAiBusy=false`（因为第一条的 assistant 尚未被标记为 `processing`），导致两个 Run 并发启动——这是原计划也未提及的竞态，但已在 UI-FLOW-AUDIT 中记录（`UI-FLOW-AUDIT-COMPLETE.md:836`）。

3. **`queued` 状态在 store 中没有下游处理**。没有定时器、没有监听器、没有消息泵来消费被标记为 `queued` 的消息。这是一个**只管写、不管读**的状态。

### 改进建议

- **将 `queued` 纳入 Steering 消费管道**：`queued` 的消息不应只是视觉标记，应能通过 steering 机制被自动注入到当前或下一个 Run
- **消除 `isAiBusy` 双窗口竞态**：`isAiBusy` 应从 store 读取改为从**运行时状态**（Run 是否活跃）读取，或者引入互斥锁

---

## 4.2 SteeringInputQueue 数据结构

### 审计结论：数据结构设计不足——已经有现成的 `AgentInputQueue`，方案应在此之上扩展

**实际代码已在使用的队列**：

`packages/agent-runtime/src/agent-input-queue.ts:16-48`

```typescript
export class AgentInputQueue {
  private readonly items = new RingBuffer<AgentMessage>(INPUT_QUEUE_CAPACITY);

  enqueue(message: AgentMessage): void {
    this.items.pushOverwritingOldest(message);  // 超容量时覆盖最旧，提供背压
  }
  dequeue(): AgentMessage | undefined { return this.items.shift(); }
  peek(): AgentMessage | null { return this.items.peekFirst() ?? null; }
  hasPending(): boolean { return this.items.size > 0; }
  clear(): void { this.items.clear(); }
}
```

**方案 4.2.1 提议创建一个 `SteeringInputQueue`，但代码中已经有一个正在使用的 `AgentInputQueue`**，由 `AgentSessionLoop` 持有（`agent-session-loop.ts:333`）。这意味着：

- 不需要新引入一个独立的 `SteeringInputQueue` 类
- 应该在 `AgentInputQueue` 上**扩展能力**，而不是另起炉灶

### 关于优先级的评估

**当前不需要优先级**。原因：
- steering 消息与初始输入在状态机中被同等对待（都是 `role: 'user'`）
- `AgentInputQueue` 是 FIFO，这在"消息被按序消费"的意义上是正确的
- 但如果未来需要区分"转向指令优先于系统纠偏消息"，则需要引入优先级

### 关于撤回（withdrawal）的评估

**需要支持撤回能力**。原因：
- 用户在 Composer 中连发两条 steer 消息（如"用中文回答"后立刻改口"用英文"），第二条应使第一条失效或覆盖
- 当前 `RingBuffer` 不支持按 `id` 删除消息

### 改进方案

```
AgentInputQueue 扩展接口：
--------------------------------------------------------------------------------
interface AgentInputEntry extends AgentMessage {
  groupId?: string;        // 同一组可互相覆盖（如用户连续 steer）
  isSteering: boolean;     // 标记是否来自 steering（非初始输入）
}

class AgentInputQueue {
  // 新增
  withdraw(predicate: (entry: AgentInputEntry) => boolean): number;  // 撤回匹配的条目
  replaceOrEnqueue(entry: AgentInputEntry): boolean;                 // 覆盖同 groupId 或追加

  // 容量策略改进
  // 当前 pushOverwritingOldest 会覆盖最旧的输入（可能是用户的初始输入）
  // 应改为 steering 条目优先被覆盖，初始输入/纠偏消息不受影响
}
```

### 关于 `readPendingInputs` 回调未使用的审计

**关键发现**：`packages/agent-runtime/src/types.ts:116` 定义了 `readPendingInputs` 回调接口，但 `agent-session-loop.ts` 中**没有任何调用该回调的代码**。这意味着编排层通过 `orchestrator.enqueuePendingInput()` 存入事件存储的 steer 消息，**运行时从未主动拉取**。这是一个断掉的契约。

```
编排层 (orchestrator)          运行时 (agent-session-loop)
     │                               │
     │  enqueuePendingInput()         │
     │  → 写入 pendingInputs Map      │
     │  → 写入事件存储               │
     │                               │
     │  (期望)              readPendingInputs?  ← 从未调用
     │                               │
     │  dispatchPendingInput()        │
     │  → 标记为 dispatched           │
     │  → (但运行时无感知)           │
```

---

## 4.3 UI 层改造：解除 `isAiBusy` 的绝对拦截

### 审计结论：方案思路正确，但需要更细粒度的状态区分

### 4.3.1 `uiEvents.ts` 新增转向事件

**现状**：当前没有 `steer-session` 事件类型。前端通过 `enqueue-pending-input` 协议消息与 daemon 通信（`packages/agent-daemon/src/types.ts:278-287`），但没有统一的 UI 事件总线层面的转向事件。

**是否需要新增 `steer-session` 事件**：建议新增，因为：
- 当前的 `handleSendChat` 在 `isAiBusy` 时走的是"标记 queued + 不做后续"路径
- 需要一个专门的 UI 事件入口来**区分**用户在 AI 繁忙时的发送意图（是"转向"还是"排队等下一轮"）

### 4.3.2 `useChatStream.ts` / `handleSendChat` 改造

**需要区分的三种状态**：

| AI 状态 | 用户操作 | 当前行为 | 目标行为 |
|---------|---------|---------|---------|
| 空闲 | 发送 | 启动新 Run | 不变 |
| 繁忙，消息是转向 | 发送 | 标记 queued（卡死） | 入 SteeringQueue，即时显示 |
| 繁忙，消息是排队 | 发送 | 标记 queued（卡死） | 入等待队列，当前 Run 结束后自动处理 |

**改进后的 `handleSendChat` 逻辑**：

```
handleSendChat():
  if not isAiBusy:
    → 启动新 Run（同当前）
  else:
    if 当前 Run 支持 steering（状态机处于 steering-capable 状态）:
      → emitUiEvent('steer-session', { sessionId, text, attachments })
      → daemon 侧走 enqueuePendingInput with mode='steer'
      → 消息以 status='processing' 即时显示（非 queued）
    else:
      → 退回到排队行为
      → daemon 侧走 enqueuePendingInput with mode='after-current-run'
      → 消息以 status='queued' 显示
```

### 4.3.3 Composer 视觉状态区分

**现状**（`ChatComposer.tsx:247-272`）：

```
isProcessing=true:
  ├── 发送按钮 → "排队"（processingSendLabel）
  └── 停止按钮 → ■ Square 图标
```

**问题**：
- "排队"文案不够直观，用户不清楚这是"转向"还是"排队等下一轮"
- 没有视觉区分 steer 和 queue 两种不同的"AI 忙时操作"
- `Square` 停止图标在语义上不明确（是停止整个 Run 还是停止当前生成？）

**改进方案**：

```
AI 运行中，Composer 按钮区域：
  ├── 转向按钮: "↩ 转向" (SteerIcon)
  │   → 工具提示: "向运行中的 Agent 注入补充指令"
  │   → 回车直接触发 steer
  │
  ├── 排队按钮: "⏳ 排队" (次要样式)
  │   → 工具提示: "当前回复结束后自动发送"
  │   → 通过 Shift+Enter 或菜单触发
  │
  └── 停止按钮: "■ 停止" (红色，确认步骤)
      → 工具提示: "立刻终止当前 AI 回复（不可恢复）"
      → 点击后可能需要二次确认，避免误触
```

---

## 4.4 Runtime 层改造：`AgentSessionLoop` 接入转向队列

### 审计结论：`preparing-turn` 已经是消费点，但方案描述与实际代码严重不符

### 4.4.1 状态机中的消费点

**方案 4.4.1 的描述**：
```
case 'preparing-turn': {
  if (this.steeringQueue.hasPending()) {
    const steerings = this.steeringQueue.dequeueAll();
    for (const entry of steerings) {
      await this.appendSteeringMessage(entry);
    }
  }
  this.dispatch('START_TURN');
}
```

**实际代码**（`agent-session-loop.ts:433-454`）：

```typescript
case 'preparing-turn': {
  // ...abortCheck...
  if (this.machine.getContext().toolCallCount > 0 && this.inputQueue.hasPending()) {
    const steerInput = this.inputQueue.dequeue();
    if (steerInput) {
      yield* this.recordMessage(steerInput, this.conversation, this.recorder);
    }
  }
  // ...recovery, compression, dispatch TURN_PREPARED...
}
```

**关键差异**：

| 维度 | 方案描述 | 实际代码 |
|------|---------|---------|
| 队列名 | `steeringQueue` | `inputQueue`（实为 `AgentInputQueue`） |
| 消费条件 | 总是检查 | **仅当 `toolCallCount > 0` 时检查** |
| 消费方式 | `dequeueAll()` 一次性全部取出 | `dequeue()` 一次取一条 |
| 消息标记 | `metadata.isSteeringInput: true` | 无标记 |
| 触发事件 | `START_TURN` | `TURN_PREPARED`（经过 recovery + compression） |

**这意味着**：当前 steering 注入只在**工具调用迭代**中工作（toolCallCount > 0 说明此前有 tool_calls）。如果 AI 处于没有工具调用的纯文本生成中，steering 消息不会被消费。

### 状态机中 steering 完整消费链

```
                      ┌──────────────────────┐
                      │    awaiting-input     │ ← 初始输入、INPUT_AVAILABLE 后的新输入周期
                      │   INPUT_READY →       │
                      └──────────┬───────────┘
                                 │
                      ┌──────────▼───────────┐
                      │    preparing-turn     │ ← 工具迭代中的 steering 消费（toolCallCount > 0）
                      │   TURN_PREPARED →     │
                      └──────────┬───────────┘
                                 │
                      ┌──────────▼───────────┐
                      │      streaming        │
                      │  STEERING_NEEDED →    │ ← 空响应纠偏触发
                      │  NO_PROGRESS_CONTINUE→│ ← provider 错误恢复
                      └──────────┬───────────┘
                           │           │
                    ┌──────▼───┐  ┌────▼──────────┐
                    │executing-│  │steering-       │ ← 内部纠偏注入
                    │tools     │  │evaluation      │
                    └──────┬───┘  └────┬──────────┘
                           │           │ STEERING_COMPLETE
                    ┌──────▼───────────▼──────────┐
                    │       turn-complete          │
                    │  INPUT_AVAILABLE → awaiting-input
                    │  NEXT_TURN → preparing-turn
                    │  SHOULD_STOP → done
                    └──────────────────────────────┘
```

**关键问题**：用户 steer 消息只能通过两条路径到达 AI：
1. `preparing-turn`（工具迭代中，`toolCallCount > 0`）
2. `turn-complete` → `INPUT_AVAILABLE` → `awaiting-input` → `INPUT_READY` → `preparing-turn`（新输入周期）

路径 2 会让 AI 进入全新的"用户输入→思考"周期，而不会立即打断当前正在进行的工具执行或流式输出。这实际上**不是真正的"转向"**，而是排队等下一轮。

### 真正需要的是：在任何状态都能注入

| 当前状态 | 是否直接支持 steer | 改进方案 |
|---------|-------------------|---------|
| `awaiting-input` | ✅ 自然支持（dequeue 后进入下一轮） | 无需改动 |
| `preparing-turn` | ✅ 支持（但仅 toolCallCount > 0） | 移除 toolCallCount 限制 |
| `streaming` | ❌ 不支持 | 新增 `STEER_SIGNAL` 事件，进入 `steering-pending` 子状态 |
| `executing-tools` | ❌ 不支持 | 新增 `STEER_SIGNAL` 事件，当前工具完成后立即检查 |
| `steering-evaluation` | ❌ 不支持（正在内部纠偏中） | 新增 `STEER_SIGNAL` 事件 |
| `turn-complete` | ✅ 支持（`INPUT_AVAILABLE`） | 无需改动 |

### 4.4.2 Steering 消息的 Turn 结构

**现状**：steering 消息与其他 user 消息完全一致，没有 `metadata.isSteeringInput` 标记。

**需要确保的集成点**：
- `conversation-engine.ts` 的 `appendMessage()` 方法能接受自定义 metadata
- UI timeline 的渲染引擎能识别 `isSteeringInput` 标记并显示不同样式
- 上下文压缩策略应将 steering 消息标记为**高保留优先级**（不应被压缩丢弃）

### 4.4.3 与 subagent 的集成

**现状**：子 Agent 的通信走 WebSocket `send-to-subagent` 消息经 Daemon 中转。

**方案正确**：在同进程执行路径下，通过 `SteeringInputQueue` 实现注入确实更简洁。但需要注意：
- 子 Agent 的 `AgentSessionLoop` 实例与父 Agent 在**不同进程中**（或至少不同上下文），队列不能直接共享
- 需要区分"父 Agent 强制子 Agent 转向"与"子 Agent 自己的用户 steer"

---

## 4.5 保留硬中断路径作为紧急出口

### 审计结论：正确，但"停止"按钮的语义需要澄清

**当前停止按钮**（`useChatStream.ts:1434-1489`）：
- `handleStopGeneration` 直接取消流式管理器、标记消息为 `completed`、调用 `safeCancelStream`
- 这是**前端层的停止**，不是运行时层的 `AbortController.abort()`
- 运行时的 `abortController` 是由后台管理的，前端的停止通过 `cancel` 回调传递给运行时

**关键问题**：前端的"停止"按钮触发的路径与运行时的 `AbortController` 不是同一个对象。`handleStopGeneration` 最终会调用 `cur.cancel`，这通过 `sessionStreamManager` 传递到运行时的 `AbortController`，但这个路径是间接的，且可能已经失效（如 streamManager 已被 delete）。

### 改进建议

**UI 上应提供三个按钮，而不是两个**：

| 按钮 | 行为 | 风险等级 | 适用场景 |
|------|------|---------|---------|
| 转向 (Steer) | 注入补充指令，不影响当前执行 | 无风险 | 用户想补充/修改指令 |
| 排队 (Queue) | 等当前 Run 结束后自动执行 | 低风险 | 用户不想打断，但希望后续生效 |
| 停止 (Stop) | 硬中断，销毁当前 Run | 高风险 | AI 完全跑偏、死循环、输出有害内容 |

**停止按钮的保护措施**：
- 初次点击后应有确认弹窗："将中断当前 AI 响应，此操作不可恢复"
- 或者点击后进入 3 秒冷却期，按钮变为红色闪烁"再次点击确认停止"
- 停止后应提供"快速重试"选项，自动以相同的上下文重启 Run

---

## 补充 1：Race Condition——Steering 入队时 Run 刚好结束

### 问题定义

用户发送 steer 消息时发生以下时序：
1. T1: UI 发送 `enqueuePendingInput(sessionId, text, mode='steer')`
2. T2: Daemon 收到消息，但此时 Run 刚好自然结束（`turn-complete` → `done`）
3. T3: Daemon 调用 `orchestrator.enqueuePendingInput()`，成功写入 `pendingInputs` Map
4. T4: Steering 消息成为"孤儿"——没有活跃 Run 来消费它

### 当前行为

- `orchestrator.enqueuePendingInput()` 不检查 Run 状态（`orchestrator.ts:177-218`）
- 消息被成功写入 `pendingInputs` Map 和事件存储
- 但 `AgentSessionLoop` 实例已销毁，`inputQueue` 已被 GC
- 消息永远停留在 `pending` 状态，除非用户手动触发新的 Run

### 改进方案

**方案 A：自动迁移到下一个 Run（推荐）**

```
orchestrator.enqueuePendingInput():
  if session 无活跃 Run (no activeAgentRun && no queued runs):
    1. 检查 event store 中是否有 pending inputs
    2. 如果当前没有待处理输入：
       - 将 steering 消息设为 mode='after-current-run'
       - 写入 pendingInputs Map
       - 不自动创建新 Run（等待用户显式触发）
    3. 如果已有待处理输入：
       - 保留为 pending，等待下一个 Run 创建时批量消费
  else:
    - 正常写入 pendingInputs Map，等待 readPendingInputs 拉取
```

**方案 B：自动创建新 Run（激进）**

```
orchestrator.enqueuePendingInput():
  if session 无活跃 Run:
    1. 自动创建新 Run
    2. 将 steering 消息作为初始输入
    3. 通知 UI: "AI 已空闲，您的补充指令已作为新对话处理"
  else:
    - 正常入队
```

**建议选择方案 A**，因为方案 B 会在用户无意时创建新 Run，可能产生意外的 API 调用消耗。

**具体实现**：

在 `orchestrator.ts` 的 `enqueuePendingInput()` 方法末尾增加：

```typescript
// 检查是否有活跃 Run
const activeRun = this.getActiveRunForSession(request.sessionId);
if (!activeRun) {
  // Run 已结束，将 steer 消息标记为 migrate 状态
  input.status = 'migrated';
  input.mode = 'after-current-run';
  // 更新事件存储
  await this.storeEvent(this.event('pending-input-migrated', ...));
}
```

---

## 补充 2：多个 Steering 消息同时入队时的顺序保证

### 问题定义

用户在短时间内连续发送多条 steer 消息：
1. "用中文回答"
2. "等等，还是用英文吧"
3. "加上详细的代码示例"

这三条消息会被依次写入 `pendingInputs` Map，但到达运行时的方式取决于多个因素。

### 当前保证

- `AgentInputQueue`（agent-input-queue.ts）底层使用 `RingBuffer`，**保证 FIFO 顺序**
- `orchestrator.enqueuePendingInput()` 按调用顺序写入 Map（`pendingInputs.set()`），Map 在 ES6 中保留插入顺序
- 但 `readPendingInputs` 回调从未被调用——所以这个保证实际上**没有兑现**

### 需要增加的保证

**1. 入队顺序的持久化**

```
pending-input-created 事件应包含 sequence number：
{
  type: 'pending-input-created',
  sessionId: '...',
  runId: '...',
  input: {
    id: '...',
    text: '...',
    seq: 3,           // ← 单调递增的会话内序号
    mode: 'steer',
    status: 'pending',
    previousId: '...', // ← 前一条 pending input 的 id，形成链表
  }
}
```

**2. 消费时的批处理**

```
readPendingInputs():
  1. 查询该 sessionId + runId 下所有 status='pending' 的 inputs
  2. 按 seq 升序排列
  3. 一次性返回所有 inputs（按序）
  4. 标记为 dispatched

AgentSessionLoop.preparing-turn:
  1. 调用 readPendingInputs(runId)
  2. 对于返回的 AgentMessage[]，按序依次注入
  3. 每条消息携带 metadata.steeringSeq 以便 UI 追踪
```

**3. 并发控制的注意点**

- `pendingInputs` Map 在 `orchestrator.ts` 中是非线程安全的
- 当前架构是单线程事件循环（Node.js 风格），但应防止 `enqueuePendingInput` 和 `dispatchPendingInput` 之间的竞态
- 建议在 `pendingInputs` 操作上增加版本号（`expectedVersion`），实现乐观锁：

```typescript
interface PendingInputRecord {
  id: string;
  sessionId: string;
  text: string;
  mode: PendingInputMode;
  status: PendingInputStatus;
  seq: number;         // 会话内单调递增
  version: number;     // 乐观锁版本号
  createdAt: string;
  updatedAt: string;
}
```

---

## 总结：代码现状 vs 方案目标对照表

| 维度 | 当前代码状态 | 原方案目标 | 差距 |
|------|------------|-----------|------|
| isAiBusy 拦截 | `useChatStream.ts:1901` 硬拦截 | 解除绝对拦截，区分 steer/queue | 需要改造 handleSendChat |
| SteeringInputQueue | `AgentInputQueue` 已存在（`agent-input-queue.ts`） | 新建独立队列 | 应扩展而非新建 |
| 优先级支持 | FIFO 无优先级 | 未提及 | 当前不需要 |
| 撤回支持 | 不支持 `withdraw()` | 未提及 | **建议增加** |
| preparing-turn 消费 | 已消费但仅限 `toolCallCount > 0` | 全量消费 | 移除条件限制 |
| streaming 状态 steer | 不支持 | 未明确 | **建议新增 `STEER_SIGNAL`** |
| executing-tools steer | 不支持 | 未明确 | **建议新增中断点** |
| readPendingInputs | 定义但未调用（`types.ts:116`） | 未提及 | **断掉的契约，必须修复** |
| UI 按钮区分 | "排队" + "停止" | "转向" + "停止" | 需要新增三个按钮 |
| UI 事件 | 无 steer-session | 新增 steer-session | 需要新增 |
| 子 Agent 集成 | WebSocket 中转 | 队列注入 | 需要区分进程边界 |
| Run 结束竞态 | 无处理 | 未提及 | **必须补充 migrate 逻辑** |
| 多条同时入队 | 无顺序保证 | 未提及 | **必须补充 seq + 批消费** |
| 状态机状态 | 6 个状态，无 steering-interrupt | 未明确 | **建议新增 `steer-signal` 事件** |
