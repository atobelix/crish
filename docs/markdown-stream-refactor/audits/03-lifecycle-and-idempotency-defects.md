# 消息生命周期与多轮状态机严苛审查报告

**审查对象**：Conex / Crish 桌面端消息生命周期、流式分发、多轮状态机与时间线归一化核心实现  
**审查范围**：
- `apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts`
- `apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts`
- `apps/crish-desktop/src/hooks/chat-stream/helpers.ts`
- `apps/crish-desktop/src/hooks/chat-stream/streamRunCompletion.ts`
- `apps/crish-desktop/src/store/sessionMessageActionsTools.ts`
- `apps/crish-desktop/src/store/sessionMessageActionsCore.ts`
- `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts`
- `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`
- `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts`
- `apps/crish-desktop/src/hooks/chat-stream/streamExecutionHelper.ts`
- `apps/crish-desktop/src/utils/StatusTransitionGuard.ts`

---

## 1. `turnIndex` 异常值注入与数组边界 / 原型污染缺陷

### 1.1 `onMessageEnd` 中非安全索引导致的数组原型挂载与文本静默丢失

在 `apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts` 第 110-120 行：

```typescript
const turnIndex =
  typeof envelope.event.turnIndex === 'number'
    ? envelope.event.turnIndex
    : 0;
if (!state.messageEndTurnSegments) state.messageEndTurnSegments = [];
const segs = state.messageEndTurnSegments;
while (segs.length <= turnIndex) segs.push('');
// 幂等设置对应轮次的权威文本快照
segs[turnIndex] = piece;
state.assistantText = segs.filter(Boolean).join('\n\n');
```

#### 根因剖析与时序破坏
1. **负数索引（如 `-1`）**：
   - JavaScript 中 `typeof -1 === 'number'` 评估为 `true`。
   - `while (segs.length <= -1)` 条件恒为 `false`，循环直接跳过。
   - `segs[-1] = piece` 将字符串作为字面属性 `"-1"` 挂载到 `Array` 对象实体上，而非数字索引槽位。
   - `segs.filter(Boolean)` 仅遍历从 `0` 到 `segs.length - 1` 的稠密数组元素，`segs["-1"]` 被原生跳过。
   - **后果**：该轮次权威文本 `piece` 彻底丢失，`state.assistantText` 无法接收任何该轮文本更新。
2. **`NaN` 异常值**：
   - `typeof NaN === 'number'` 为 `true`，但 `Number.isNaN(NaN)` 为 `true`。
   - `segs.length <= NaN` 比较恒为 `false`，循环跳过。
   - `segs[NaN] = piece` 在数组上创建 `segs["NaN"]` 字符串属性。
   - `segs.filter(Boolean)` 忽略非数字键，导致当前轮文本静默丢失。
3. **非整数浮点数（如 `1.5`）**：
   - `segs.length <= 1.5` 在 `length=0` 时执行两次，填充 `['', '']`。
   - `segs[1.5] = piece` 创建 `segs["1.5"]` 属性。
   - `segs.filter(Boolean)` 输出空数组，`state.assistantText` 变为空字符串。
4. **超大跳号（如 `turnIndex = 1_000_000`）引发的内存耗尽（DoS）**：
   - 若引擎或桥接层意外发送或被恶意注入跳号，`while (segs.length <= 1000000) segs.push('')` 将同步分配 100 万个数组槽位。
   - 这会导致主线程 JavaScript 事件循环完全冻结，触发内存急剧暴涨甚至 V8 Heap OOM 崩溃。

---

### 1.2 `reconcileAssistantMessageBlocks` 排序比较器中 `NaN` 击穿严格弱序

在 `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` 第 124-129 行：

```typescript
return result.sort((a, b) => {
  const turnA = a.turnIndex ?? 0;
  const turnB = b.turnIndex ?? 0;
  if (turnA !== turnB) return turnA - turnB;
  return (order[a.type] ?? 9) - (order[b.type] ?? 9);
});
```

#### 根因剖析与时序破坏
- 若 `a.turnIndex` 或 `b.turnIndex` 为 `NaN`，则 `turnA !== turnB` 恒成立（因为 `NaN !== 0` 且 `NaN !== NaN`）。
- 执行 `turnA - turnB` 产生 `NaN`。
- ECMAScript 标准规定排序比较函数必须返回三态数字（`<0`, `0`, `>0`）以满足严格弱序（Strict Weak Ordering）。返回 `NaN` 将直接破坏 V8 Timsort / QuickSort 算法的不变量，导致数组排序结果产生非确定性乱序，历史块与最新块位置完全颠倒。

---

## 2. `reconcileAssistantMessageBlocks` 中无 ID 块的 Map 键冲突与块丢失

在 `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` 第 86-130 行：

```typescript
export function reconcileAssistantMessageBlocks(
  existingBlocks: MessageTimelineBlock[] | undefined,
  incomingBlocks: MessageTimelineBlock[]
): MessageTimelineBlock[] {
  const result: MessageTimelineBlock[] = [];
  const existingMap = new Map<string, MessageTimelineBlock>();

  // 1. 注册既有持久块（重点保护 thought 与 tool_call）
  if (existingBlocks && existingBlocks.length > 0) {
    for (const b of existingBlocks) {
      const key = `${b.turnIndex ?? 0}:${b.type}:${b.id ?? ''}`;
      existingMap.set(key, b);
    }
  }

  // 2. 融合 incoming blocks
  if (incomingBlocks && incomingBlocks.length > 0) {
    for (const b of incomingBlocks) {
      const key = `${b.turnIndex ?? 0}:${b.type}:${b.id ?? ''}`;
      if (existingMap.has(key)) {
        // 相同槽位：更新内容
        result.push({ ...existingMap.get(key)!, ...b });
        existingMap.delete(key);
      } else {
        result.push(b);
      }
    }
  }

  // 3. 追加未被覆盖的历史工具与思考块（防止丢块）
  for (const [, orphan] of existingMap) {
    if (orphan.type === 'tool_call' || orphan.type === 'thought') {
      result.push(orphan);
    }
  }
  ...
}
```

### 2.1 同轮次多段文本块在 Map 中发生键覆写与信息篡改

#### 根因剖析
- `MessageTimelineBlock` 中的 `text` 块通常没有 `id` 属性（`b.id` 为 `undefined`）。
- 在多步交错场景下（例如：`[Text_Part1, ToolCall_1, Text_Part2]`），同轮次（`turnIndex: 0`）内存在两个 `text` 块。
- 两者的键均为 `"0:text:"`。

#### 故障执行时序
1. **步骤 1（注册既有块）**：
   - 遍历 `Text_Part1`，写入 `existingMap.set("0:text:", Text_Part1)`。
   - 遍历 `Text_Part2`，写入 `existingMap.set("0:text:", Text_Part2)`，**`Text_Part1` 被彻底覆盖**。
2. **步骤 2（合并传入块）**：
   - `incomingBlocks` 中遍历到第一个 `text` 块（`Incoming_Text_1`），计算键为 `"0:text:"`。
   - `existingMap.has("0:text:")` 命中，执行 `{ ...existingMap.get("0:text:")!, ...Incoming_Text_1 }`。此时是将 `Incoming_Text_1` 与 `Text_Part2` 进行错误合并！
   - 执行 `existingMap.delete("0:text:")`。
   - `incomingBlocks` 遍历到第二个 `text` 块（`Incoming_Text_2`），键依然是 `"0:text:"`。
   - `existingMap.has("0:text:")` 此时返回 `false`，将其作为全新块 `result.push(Incoming_Text_2)`。
3. **步骤 3（孤儿块回收）**：
   - 即使 `Text_Part1` 曾因键名覆盖残留，步骤 3 显式限制 `orphan.type === 'tool_call' || orphan.type === 'thought'`，`text` 类型的孤儿块被**无条件丢弃**。

#### 后果
多步骤交互中，工具调用前后的多段解释文本在反复 `normalizeAssistantTimeline` 调用后发生内容错位覆盖与静默截断。

---

### 2.2 无 ID 思考块在多轮分段中的冲突覆写

#### 根因剖析
- 若上游流式传输或历史数据生成的 `thought` 块没有分配全局唯一 `id`（`b.id === undefined`），同一个轮次内的多次思考分段（例如工具执行前的思考与工具执行后的反思）键均为 `"${turnIndex}:thought:"`。
- 步骤 1 导致先前的思考块被后来的思考块覆盖；步骤 2 的 `existingMap.delete(key)` 导致后续思考块无法匹配既有状态，造成思考链断裂与重复。

---

## 3. `alignToolCallBlocks` 补齐块缺失 `turnIndex` 引发时序倒流与块重复

在 `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` 第 39-76 行与 176-190 行：

```typescript
export function alignToolCallBlocks(
  blocks: MessageTimelineBlock[] | undefined,
  tools: MessageToolCall[]
): MessageTimelineBlock[] {
  ...
  const missing = tools.filter((t) => !inBlocks.has(t.id));
  if (missing.length === 0) return next;

  const onlyTextOrEmpty =
    next.length === 0 || next.every((b) => b.type === 'text');
  if (onlyTextOrEmpty) {
    return [
      ...missing.map((t) => ({ type: 'tool_call' as const, id: t.id })),
      ...next,
    ];
  }

  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.type === 'text') {
      insertAt = i;
      break;
    }
  }
  const inject = missing.map((t) => ({
    type: 'tool_call' as const,
    id: t.id,
  }));
  return [...next.slice(0, insertAt), ...inject, ...next.slice(insertAt)];
}
```

### 3.1 补齐工具块丢失 `turnIndex` 导致的跨轮次回退与时间线错乱

#### 根因剖析
1. `alignToolCallBlocks` 生成的补齐块构造为 `{ type: 'tool_call', id: t.id }`，**完全未注入 `turnIndex`**（即 `turnIndex` 为 `undefined`）。
2. 在 `normalizeAssistantTimeline` 中，`alignToolCallBlocks` 的输出直接传入 `reconcileAssistantMessageBlocks`。
3. 在 `reconcileAssistantMessageBlocks` 排序步骤中：
   ```typescript
   const turnA = a.turnIndex ?? 0;
   const turnB = b.turnIndex ?? 0;
   ```
   未指定 `turnIndex` 的补齐工具块被强制默认归零（`turnIndex = 0`）。

#### 故障执行时序
1. 助手在第 3 轮（`turnIndex: 3`）执行工具调用 `tc-deploy`。
2. 此时 `blocks` 中已有第 0、1、2 轮的思考块与正文块。
3. `alignToolCallBlocks` 检测到 `tc-deploy` 尚未进入 `blocks`，生成 `{ type: 'tool_call', id: 'tc-deploy' }`（无 `turnIndex`）。
4. 进入 `reconcileAssistantMessageBlocks` 排序。
5. 排序将 `tc-deploy` 的 `turnIndex` 视为 `0`，将其直接提升至整个消息的最顶端（第 0 轮位置），排在第 1 轮和第 2 轮的所有思考和正文之前。
6. **后果**：本应在最后一步执行的工具调用在 UI 上瞬间跳跃到最前端，造成严重的时间倒流与交互逻辑混乱。

---

### 3.2 键不匹配引发的工具块二次重复生成（Ghost Duplication）

#### 故障执行时序
1. 设持久层 `existingBlocks` 中已有完整块 `{ type: 'tool_call', id: 'tc-2', turnIndex: 2 }`，其在 `reconcileAssistantMessageBlocks` 中的键为 `"2:tool_call:tc-2"`。
2. 上游传入的 `incomingBlocks` 是经过 `alignToolCallBlocks` 处理后的块，其中 `tc-2` 的 `turnIndex` 为 `undefined`，其键为 `"0:tool_call:tc-2"`。
3. 步骤 2 匹配：`existingMap.has("0:tool_call:tc-2")` 为 `false`，`incomingBlocks` 将无 `turnIndex` 的 `tc-2` 作为新块压入 `result`。
4. 步骤 3 孤儿回收：`existingMap` 中保留的 `"2:tool_call:tc-2"` 因为未被匹配，作为孤儿块被再次压入 `result`！
5. **后果**：同一个工具调用 `tc-2` 在最终时间线中分裂成两个块（一个在第 0 轮，一个在第 2 轮），造成工具卡片双重渲染。

---

## 4. `commitStreamToSession` 微任务延迟清理与快速并发操作的时序竞态

在 `apps/crish-desktop/src/hooks/chat-stream/helpers.ts` 第 239-247 行与 `streamExecutionHelper.ts` 第 195-207 行：

```typescript
// apps/crish-desktop/src/hooks/chat-stream/helpers.ts
if (options?.clear !== false) {
  queueMicrotask(() => {
    clearStream(sessionId, messageId);
  });
}
```

```typescript
// apps/crish-desktop/src/hooks/chat-stream/streamExecutionHelper.ts: executeStreamCompletion
executeStreamCompletion(ctx) {
  ...
  commitRunCompletion(...); // 内部触发 commitStreamToSession -> queueMicrotask(clearStream)
  ...
  state.runClosed = true;
  state.draining = false;
  if (!maybeContinueGoalMode(sid, assistantMsgId)) {
    drainQueuedAfterComplete(sid); // 同步开启下一轮队列中的任务！
  }
}
```

### 4.1 `drainQueuedAfterComplete` 同步执行与微任务清空的幽灵清空竞态

#### 根因剖析与执行时序
1. **Tick T0（同步主线程）**：
   - 当前流结束，进入 `executeStreamCompletion`。
   - 调用 `commitStreamToSession`，向微任务队列注册任务 `Task_Clear: () => clearStream(sid, assistantMsgId)`。
   - `executeStreamCompletion` 紧接着同步调用 `drainQueuedAfterComplete(sid)`。
   - `drainQueuedAfterComplete` 立即同步调用 `runStreamingAssistant` 启动队列中的下一轮生成（或者重试流）。
   - 新一轮生成立即创建新的渲染缓冲或对相同 `messageId`（如原地重新生成 / Retry）的 `streamingStore` 写入初始状态。
2. **Tick T1（微任务排空阶段）**：
   - 同步调用栈清空，V8 开始执行微任务队列。
   - 挂起的 `Task_Clear` 执行，无条件调用 `clearStream(sid, assistantMsgId)`。
   - **后果**：新一轮已经开始流式的状态在微任务阶段被上一轮的残余任务静默清空（Ghost Clearing），导致新一轮流式首帧丢失或直接触发白屏闪烁。

---

### 4.2 双存储状态分叉（Split-Brain State Divergence）

#### 根因剖析
- 在 `commitStreamToSession` 调用后到 `queueMicrotask` 执行前，`sessionStore` 已经同步写入了持久化文本 `text`。
- 但由于 `clearStream` 被延迟到微任务，`streamingStore` 依然保留着热路径文本。
- 若组件或选择器在同一渲染周期内混合读取 `getStreamText` 与 `session.messages[i].text`，或者某些 Hook 监听了 `streamingStore` 变更，在状态同步期间将产生数据不一致。
- 尤其当 `finalizeAssistantMessageText` 对持久化文本做 `stripThoughtPlaceholders` 清理后，`streamingStore` 中仍残存未清理的思考占位文本，UI 会在微任务触发前短暂闪烁显示未过滤的原始占位符。

---

## 5. Cancel / Stop / Error 时思考链占位符与消息状态的收口闭环缺陷

### 5.1 用户主动 Stop 时思考链占位符永久残留

在 `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts` 第 71-154 行：

```typescript
const finalizeStopGeneration = (force: boolean) => {
  ...
  const stopBufFull = stopBuf?.currentText() ?? '';
  const partialText = stopBufFull || getStreamText(sid, cur.assistantMsgId) || ...;
  const stopText = (partialText || '').trim();
  commitStreamToolsToSession(sid, cur.assistantMsgId);
  if (stopText) {
    commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
    ...
  } else {
    st.updateMessageText(sid, cur.assistantMsgId, '');
    clearStream(sid, cur.assistantMsgId);
    ...
  }
  const asst = buildMessageIndex(getSessionById(sid)).get(cur.assistantMsgId);
  st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
  st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
  ...
}
```

#### 根因剖析
1. 流式启动时（`useRunStreamingAssistant.ts` 第 114 行），初始消息被写入 `thinking: '正在处理…'`。
2. 若用户在模型正在思考或等待首个 Token 时点击 Stop：
   - `finalizeStopGeneration` 仅处理了 `stopText` 与 `toolCalls`。
   - **完全没有调用清理 `thinking` 的逻辑**（`finalizeAssistantMessageText` 仅在正常完成的 `executeStreamCompletion` 中被调用）。
   - `finalizeStopGeneration` 也没有向 `updateMessageThinking(sid, cur.assistantMsgId, '')` 派发重置。
3. **后果**：已停止的消息持久化状态中 `thinking` 字段被永久固化为 `"正在处理…"`。在会话列表中回放时，该消息永远渲染一个处于加载状态的思考中骨架屏。

---

### 5.2 运行错误（`onRunError`）导致工具调用永久悬挂在 `running` / `pending_approval` 态

在 `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts` 第 231-332 行：

```typescript
export function handleRunError(opts: ...): { hadNetworkError: boolean } {
  ...
  if (asstErr) {
    const st = getCompositionRoot().session.getState();
    if (surface === 'persistent') {
      if (!hadText) {
        st.withdrawMessage(wsId, sid, assistantMsgId);
        clearStream(sid, assistantMsgId);
      }
    } else if (!hadText) {
      st.withdrawMessage(wsId, sid, assistantMsgId);
      clearStream(sid, assistantMsgId);
    } else {
      st.setSessionMessageStatus(sid, assistantMsgId, 'error', undefined, {
        errorDetail: { message, kind, technical }
      });
    }
  }
  flushStreamBatchers();
  ...
}
```

#### 根因剖析
1. 正常完成（`executeStreamCompletion`）与停止（`finalizeStopGeneration`）均显式调用了：
   `buildTerminalToolPatches(asst?.toolCalls, ...)` 并通过 `applyToolCallPatches` 批量将未决工具置为终态。
2. **在 `handleRunError` 异常路径中，该收口逻辑完全缺失**！
3. 若助手在执行工具中途（或等待审批时）发生网络中断、引擎进程崩溃或后端超时：
   - `handleRunError` 仅将消息状态设置为 `error`（或撤回消息）。
   - `msg.toolCalls` 中的工具状态依然保留为 `status: 'running'` 或 `status: 'pending_approval'`。
4. **后果**：发生错误的会话消息中，工具卡片永远显示旋转的 Loading 动画或等待用户审批，用户无法重新触发该工具，也无法感知工具是否实际失败。

---

### 5.3 无正文错误时 `userMsg` 永久死锁在 `processing` 态

在 `apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts` 第 298-307 行：

```typescript
if (!hadText) {
  st.withdrawMessage(wsId, sid, assistantMsgId);
  clearStream(sid, assistantMsgId);
}
```

#### 根因剖析
1. 当发送消息后，`userMsg` 的状态在发送通道被置为 `processing`。
2. 若引擎在吐出任何正文前报错（`!hadText`），`handleRunError` 执行 `withdrawMessage` 撤回了 `assistantMsgId`。
3. **但对 `userMsgId` 未执行任何状态流转**（既未标记为 `error`，也未标记为 `completed`）。
4. 在 `apps/crish-desktop/src/hooks/chat-stream/helpers.ts` 第 311-322 行：
   ```typescript
   export function isSessionAiBusy(opts: {
     hasLiveStream: boolean;
     messages?: Array<{ sender?: string; status?: string }> | null;
   }): boolean {
     if (opts.hasLiveStream) return true;
     const msgs = opts.messages;
     if (!Array.isArray(msgs) || msgs.length === 0) return false;
     return msgs.some(
       (m) => m.sender === 'assistant' && m.status === 'processing'
     );
   }
   ```
   以及状态机冲突检测 `handleStreamConflict`：
   ```typescript
   const userMsg = getSessionById(sid)?.messages?.find(
     (m: SessionMessage) => m.id === userMsgId
   );
   if (userMsg?.sender === 'user' && userMsg.status === 'processing') {
     st.setSessionMessageStatus(sid, userMsgId, 'queued');
   }
   ```
5. **后果**：残留的 `userMsg` 保持 `status === 'processing'`，后续重试或状态校验逻辑将其误判为正在处理中的活动请求，造成状态机死锁与输入框异常禁用。

---

## 6. 多轮 Engine 增量在 `onMessageDelta` 与 `onMessageEnd` 间的切片脱节

在 `apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts` 第 57-89 行与 91-120 行：

```typescript
// onMessageDelta
let deltaToSend = t;
if (raw.message && typeof raw.message === 'object') {
  const msg = raw.message as Record<string, unknown>;
  if (
    typeof msg.content === 'string' &&
    msg.content.length >= state.assistantText.length
  ) {
    deltaToSend = msg.content.slice(state.assistantText.length);
    state.assistantText = msg.content;
  } else {
    state.assistantText += t;
  }
} else {
  state.assistantText += t;
}
if (deltaToSend) {
  callbacks.onChunk(deltaToSend);
}
```

```typescript
// onMessageEnd
if (text.trim()) {
  const piece = text.trim();
  const turnIndex =
    typeof envelope.event.turnIndex === 'number'
      ? envelope.event.turnIndex
      : 0;
  if (!state.messageEndTurnSegments) state.messageEndTurnSegments = [];
  const segs = state.messageEndTurnSegments;
  while (segs.length <= turnIndex) segs.push('');
  segs[turnIndex] = piece;
  state.assistantText = segs.filter(Boolean).join('\n\n');
}
```

### 根因剖析与多轮数据流崩溃时序
1. **第 0 轮流式与收口**：
   - 第 0 轮累积文本 `"Step 1 complete."`（长度 16）。`state.assistantText = "Step 1 complete."`。
   - `onMessageEnd` 触发：`segs[0] = "Step 1 complete."`，`state.assistantText = "Step 1 complete."`。
2. **第 1 轮流式到达**：
   - 引擎发送第 1 轮的增量。若引擎的 `raw.message.content` 代表当前第 1 轮的累积内容（例如 `"Step 2 in progress"`，长度 18）：
   - `msg.content.length (18) >= state.assistantText.length (16)` 成立。
   - `deltaToSend = msg.content.slice(16)` 取出 `"ss"`（切片索引完全基于跨轮总长度！）。
   - 前 16 个字符 `"Step 2 in progre"` 被直接吞噬！
   - `state.assistantText` 被强行重置为 `"Step 2 in progress"`（丢失了第 0 轮的内容）。
3. **若 `raw.message.content` 短于上一轮总长**：
   - 例如第 1 轮首个增量 `msg.content = "OK"`（长度 2）。
   - `2 >= 16` 为 `false`，进入分支 `state.assistantText += t`。
   - `state.assistantText` 变成 `"Step 1 complete.OK"`。
4. **第 1 轮 `onMessageEnd` 到达**：
   - `segs[1] = "OK"`。
   - `state.assistantText = segs.filter(Boolean).join('\n\n')` 变为 `"Step 1 complete.\n\nOK"`。
5. **后果**：`onMessageDelta` 假设 `state.assistantText` 为单调递增的单轮标量，而 `onMessageEnd` 采用多轮分段数组重构。两者对 `state.assistantText` 语义的认知发生严重冲突，导致多轮交互中流式输出剧烈跳字、乱码、重复或丢字。

---

## 7. `timelineSignature` 缓存失效盲区与流式渲染冻结

在 `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` 第 536-598 行：

```typescript
export function timelineSignature(msg: SessionMessage): string {
  const isLiveProcessing = msg.status === 'processing';
  const blocks = msg.blocks || [];
  ...
  const hasExplicitText = blocks.some(
    (b) => b.type === 'text' && (b.content || '').trim().length > 0
  );

  if (blocks.length === 0 || !hasExplicitText) {
    return JSON.stringify({
      b: blocksProj,
      t: toolsProj,
      st: msg.status || 'unknown',
      hasText: Boolean((msg.text || '').trim()),
      txt: isLiveProcessing ? undefined : msg.text || '',
    });
  }

  return JSON.stringify({
    b: blocksProj,
    t: toolsProj,
    st: msg.status || 'unknown',
  });
}
```

### 7.1 空 `blocks` 降级路径下流式增量无法触发重渲染

#### 根因剖析
1. 当消息处于流式生成初期或未初始化 `blocks` 数组时（`blocks.length === 0`），走 `!hasExplicitText` 分支。
2. 在流式进行中（`isLiveProcessing === true`）：
   `txt` 字段被显式设为 `undefined`。
   `hasText` 在收到第一个字符后即为 `true`。
3. 随后，文本从 1 个字符增长到 10000 个字符：
   - `b` 为 `[]`
   - `t` 为 `[]`
   - `st` 为 `'processing'`
   - `hasText` 恒为 `true`
   - `txt` 恒为 `undefined`
4. **生成的 JSON 字符串在整个流式过程中完全不变**！
5. 在 `buildAssistantTimelineCached` 中：
   ```typescript
   if (sig === prevSig && prevTimeline) {
     return { sig, timeline: prevTimeline };
   }
   ```
   签名完全命中，直接返回首帧构建的 `prevTimeline`。
6. **后果**：降级回退模式下的文本流式渲染被完全冻结，界面永远停留在第一个字符，直到流结束状态变为 `completed` 时才突变刷新。

---

### 7.2 思考块历史折叠状态（`isHistoricalCollapsed`）未进入签名

#### 根因剖析
- `blocksProj` 中针对 `thought` 块的投影仅包含 `{ t: 'thought', c: ..., turn: ... }`。
- **`isHistoricalCollapsed` 与 `durationMs` 字段被完全忽略**。
- 当用户在 UI 上点击展开/折叠历史思考块，或后台更新了思考耗时 `durationMs` 时，`timelineSignature` 产出的签名与上一帧完全相同。
- `buildAssistantTimelineCached` 命中缓存，返回旧的 `AssistantTimelineItem` 引用。
- **后果**：用户点击折叠/展开按钮无响应，UI 状态发生丢帧与阻滞。

---

## 8. 状态机守卫与转换漏洞（`StatusTransitionGuard` & `sessionMessageActionsTools`）

### 8.1 `StatusTransitionGuard` 中 `FORCE_TRANSITIONS` 成为死代码且校验形同虚设

在 `apps/crish-desktop/src/utils/StatusTransitionGuard.ts` 第 13-47 行：

```typescript
const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(['processing']),
  processing: new Set(['completed', 'error', 'cancelled']),
  completed: new Set(['processing']),
  error: new Set(['processing']),
  cancelled: new Set(),
};

const FORCE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  completed: new Set(['processing']),
};

function isValidTransition(from: string, to: string, force: boolean = false): boolean {
  const normalAllowed = VALID_TRANSITIONS[from];
  if (normalAllowed?.has(to)) {
    return true;
  }
  if (force) {
    const forceAllowed = FORCE_TRANSITIONS[from];
    return forceAllowed?.has(to) ?? false;
  }
  return false;
}
```

#### 根因剖析
1. 注释声明 `completed → processing` 与 `error → processing` 必须在 `force=true` 时才放行。
2. 然而在常量定义中，`VALID_TRANSITIONS['completed']` 与 `VALID_TRANSITIONS['error']` 直接包含了 `'processing'`！
3. 任何未传递 `force` 参数的非法转换（如普通调用触发 `completed → processing`）在第一道 `normalAllowed?.has(to)` 检查中直接返回 `true`。
4. 下方的 `if (force)` 及其 `FORCE_TRANSITIONS` 校验逻辑成为**永远无法执行到的死代码**。
5. 状态机防退避红线完全失守，后台事件可在无授权情况下随意将已完成消息拉回处理中状态。

---

### 8.2 空状态（`undefined` / `""`）消息被守卫直接拒收导致状态锁死

在 `apps/crish-desktop/src/store/sessionMessageActionsTools.ts` 第 139-151 行：

```typescript
try {
  validateStatusTransition(
    hit.message.status || '',
    status,
    opts?.force
  );
} catch (e) {
  console.warn(
    '[StatusTransition] 消息状态非法转换:',
    (e as Error).message
  );
  return;
}
```

#### 根因剖析
- 若消息初始创建时未显式设置 `status`（`hit.message.status` 为 `undefined`），回退传入 `""`。
- `VALID_TRANSITIONS[""]` 为 `undefined`，`isValidTransition` 恒返回 `false`。
- `validateStatusTransition` 直接抛出异常 `消息状态非法转换:  → processing`。
- `setSessionMessageStatus` 捕获异常并直接 `return`。
- **后果**：任何缺失初始 `status` 的消息（如历史导入消息、第三方注入消息）被状态机永久判定为非法状态，后续所有状态流转动作均被静默丢弃。

---

## 9. 状态遗留与内存泄漏审计（`streamState.ts` & 全局 Scope 广播）

### 9.1 `cleanupStreamState` 清理不完全导致残留状态跨 Run 泄漏

在 `apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts` 第 24-32 行：

```typescript
export function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  state.messageEndTurnSegments = undefined;
}
```

#### 根因剖析
- `cleanupStreamState` 仅重置了订阅句柄、定时器和分段数组。
- **以下关键字段完全未重置**：
  - `state.assistantText`
  - `state.assistantThought`
  - `state.cancelled`
  - `state.finished`
  - `state.lastMessageCacheMetrics`
- 若 `StreamState` 实例由调用方复用或未重新实例化，上一轮残留的 `cancelled = true`、旧文本或缓存指标将直接污染新启动的流式会话。

---

### 9.2 `markToolCallLocalStatus` 缺省 Scope 导致的全局跨会话污染

在 `apps/crish-desktop/src/store/sessionMessageActionsTools.ts` 第 257-270 行：

```typescript
markToolCallLocalStatus: (toolCallId, status, output, scope) =>
  set((state) => {
    if (!toolCallId) return;
    const sessions = scope?.sessionId
      ? state.sessions.filter((s) => s.id === scope.sessionId)
      : scope?.runId
        ? state.sessions.filter(
            (s) => s.engineLastRunId === scope.runId || s.id === scope.runId
          )
        : state.sessions;
    for (const s of sessions) {
      ...
```

#### 根因剖析
- 当调用方未传递 `scope` 时，`sessions` 默认为 `state.sessions`（全量会话）。
- 函数会无差别遍历所有会话的所有消息及所有 Agent。
- 若两个会话中存在同名或默认 ID（如 `tool-call-default`、`init`）的工具调用，修改当前会话的工具状态将**直接篡改其他不相关会话中的工具卡片状态**，造成跨会话数据破坏。

---

## 10. 缺陷汇总矩阵

| 缺陷编号 | 影响模块 | 缺陷本质 | 严重级别 | 关键风险 |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-01** | `messageHandlers.ts` | 负数 / NaN / 超大 `turnIndex` 导致数组原型属性挂载与主线程阻塞 | **CRITICAL** | 消息文本静默丢失；100 万循环 OOM 崩溃 |
| **BUG-02** | `timelineNormalizer.ts` | `sort` 比较器未处理 `NaN` 击穿 ECMAScript 严格弱序 | **HIGH** | 时间线块非确定性乱序、颠倒 |
| **BUG-03** | `timelineNormalizer.ts` | 无 ID 的 `text`/`thought` 块在 `existingMap` 中键名冲突覆写 | **CRITICAL** | 多步交互中正文块被截断覆盖、孤儿文本被永久丢弃 |
| **BUG-04** | `timelineNormalizer.ts` | `alignToolCallBlocks` 补齐块未注入 `turnIndex` | **CRITICAL** | 跨轮工具卡片跳跃至第 0 轮；工具块双重重复渲染 |
| **BUG-05** | `helpers.ts` / `streamExecutionHelper.ts` | `commitStreamToSession` 微任务延迟与快速后续操作竞态 | **HIGH** | 新流式任务状态被异步残余任务幽灵清空；闪烁白屏 |
| **BUG-06** | `useStreamCallbacks.ts` | Stop 终止路径未清除 `thinking` 占位符 | **HIGH** | 已停止消息永久显示“正在处理…”加载骨架屏 |
| **BUG-07** | `streamCallbacksEvents.ts` | `handleRunError` 缺失终态工具补丁与用户消息状态更新 | **CRITICAL** | 工具卡片永久处于 Loading；用户消息死锁在 `processing` |
| **BUG-08** | `messageHandlers.ts` | `onMessageDelta` 增量切片与 `onMessageEnd` 多轮分段数组语义冲突 | **CRITICAL** | 多轮交互中流式文本丢字、乱码、重复跳字 |
| **BUG-09** | `timelineNormalizer.ts` | 空 `blocks` 降级与思考折叠状态在 `timelineSignature` 中被忽略 | **HIGH** | 流式首帧后 UI 彻底冻结；折叠交互无响应 |
| **BUG-10** | `StatusTransitionGuard.ts` | `VALID_TRANSITIONS` 包含终态跃迁导致 `FORCE_TRANSITIONS` 沦为死代码 | **MEDIUM** | 非法状态转换无法拦截；无状态消息被永久锁死 |
| **BUG-11** | `streamState.ts` / `sessionMessageActionsTools.ts` | 清理函数残留字段；工具状态修改无 Scope 时全量广播 | **MEDIUM** | 跨 Run 状态污染；跨会话工具卡片状态被篡改 |
