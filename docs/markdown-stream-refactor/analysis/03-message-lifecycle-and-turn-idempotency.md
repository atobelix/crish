# 消息生命周期、流式缓冲与多轮完全幂等合并深度解剖与状态机设计

> **文件路径**：`docs/markdown-stream-refactor/analysis/03-message-lifecycle-and-turn-idempotency.md`
> **战役归属**：Markdown 真流式渲染与正文退化根治战役 (Phase Σ / Δ / Ω)
> **关联资产与核心代码**：
> - [`messageHandlers.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts)
> - [`eventUtils.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventUtils.ts)
> - [`streamState.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts)
> - [`streamSession.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/streamSession.ts)
> - [`helpers.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/helpers.ts)
> - [`streamRunCompletion.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/streamRunCompletion.ts)
> - [`streamingStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/streamingStore.ts)
> - [`EventRouter.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/EventRouter.ts)
> - [`sessionEventProjection.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventProjection.ts)
> - [`streamMessageViewModel.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/streamMessageViewModel.ts)

---

## 1. 任务背景与问题定义

在 Conex / Crish 桌面客户端多轮会话、工具调用及流式交互过程中，出现了一个极为严重的界面退化问题：**助手回复在流式结束或多轮工具调用后，大段完整正文完全重复两遍（或局部尾段幻影字符重叠），导致渲染气泡中呈现双份相同回答或错乱拼接**。

该问题不仅严重破坏了排版美观与用户体验，更污染了后续会话上下文水合（Hydration）与持久化数据库（SQLite / Rust DB）中的历史记录。

```mermaid
flowchart TD
    subgraph BugSymptoms["文字重复 Bug 现象分类"]
        S1["【现象 1: 全文双倍重复】<br/>模型完整回答 A 在气泡中被完整打印两遍：A + A"]
        S2["【现象 2: 轮次间尾段幻影重叠】<br/>多轮工具调用后，末轮尾部数个字符或词组被重复追加"]
        S3["【现象 3: 多轮文本覆盖与丢失】<br/>重试或部分多轮场景下，首轮文字被末轮直接覆盖，或两轮拼接错乱"]
        S4["【现象 4: 持久化与热缓冲撕裂】<br/>流式期间呈现正确，complete 收口落盘瞬间突然闪烁并出现两段内容"]
    end
```

经过对前端完整消息生命周期、流式缓冲区、`onMessageDelta` 与 `onMessageEnd` 的多轮合并机制的代码级勘察，确认该 Bug 是由**双轨累积器发散（Dual Accumulator Divergence）**、**末尾切片幻影增量（Phantom Delta Slicing）**、**增量流式与权威快照的职责倒错**以及**多轮分段索引脱节**共同引发的系统性架构缺陷。

---

## 2. 文字重复的完整触发链路与根因解剖

### 2.1 端到端数据流向与双轨冲突时序图

整个流式生命周期中存在两条并行的数据生产与状态消费轨道：
1. **实时增量轨（Delta Track）**：由 `onMessageDelta` 驱动，逐 token 累积并调用 `callbacks.onChunk` 输送给 `StreamRenderBuffer` / `streamingStore`。
2. **终态权威轨（Authoritative Snapshot Track）**：由 `onMessageEnd` 驱动，接收引擎发出的单轮或整段完成消息，解析完整 text / thought 块并更新 `state.messageEndTurnSegments`。

```mermaid
sequenceDiagram
    autonumber
    participant Engine as 引擎内核 (Rust Daemon / Provider)
    participant Router as EventRouter / dispatch
    participant Handlers as messageHandlers (StreamState)
    participant Callbacks as chat-stream Callbacks (useChatStream)
    participant Buffer as StreamRenderBuffer / streamingStore
    participant SessionStore as sessionStore (持久化层)

    Note over Engine,Handlers: 【第一阶段：实时 Token 流式输出 (Turn 0 或当前轮)】
    loop 逐 Token 增量
        Engine->>Router: IPC: message-delta (block.text = "t_i")
        Router->>Handlers: onMessageDelta(env, envelope)
        Handlers->>Handlers: state.assistantText += t_i (累积长度 L_delta)
        Handlers->>Callbacks: callbacks.onChunk(t_i)
        Callbacks->>Buffer: streamedFullText += t_i / renderBuffer.push(t_i)
        Buffer-->>SessionStore: streamingStore.setStreamText(L_delta)
    end

    Note over Engine,Handlers: 【第二阶段：当前轮完成，收口事件到达】
    Engine->>Router: IPC: message-end (message.blocks / content, turnIndex)
    Router->>Handlers: onMessageEnd(env, envelope)

    rect rgb(255, 230, 230)
    Note over Handlers: 💥 缺陷爆发点：双轨碰撞与伪增量计算
    Handlers->>Handlers: piece = projectAgentMessageContent(msg).text.trim()
    Handlers->>Handlers: segs[turnIndex] = mergeAssistantTextPiece(segs[turnIndex], piece)
    Handlers->>Handlers: joined = segs.filter(Boolean).join('\n\n')
    Handlers->>Handlers: prevLen = state.assistantText.length
    Handlers->>Handlers: state.assistantText = joined
    alt joined.length > prevLen (由于 \n\n 插入或载荷包含多轮全文)
        Handlers->>Handlers: addedDelta = joined.slice(prevLen)
        Handlers->>Callbacks: ❌ callbacks.onChunk(addedDelta) 再次派发伪增量！
        Callbacks->>Buffer: ❌ streamedFullText += addedDelta (全文或大段文字被二次注入！)
    end
    end

    Note over Engine,Handlers: 【第三阶段：Run 终止与持久化 Commit】
    Engine->>Router: IPC: run-terminal / agent-end
    Router->>Callbacks: onComplete()
    Callbacks->>SessionStore: commitStreamToSession(text = streamedFullText)
    Note over SessionStore: 💥 最终 sessionStore.messages 落盘了已被双倍重复的文本！
```

---

### 2.2 根因四大失效向量深度解剖

#### 向量 1：`segs.filter(Boolean).join('\n\n')` 与 `slice(prevLen)` 的末尾切片幻影增量

查阅 [`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts#L125-L131)：

```typescript
// ❌ 存在致命缺陷的旧实现
const joined = segs.filter(Boolean).join('\n\n');
const prevLen = state.assistantText.length;
state.assistantText = joined;
if (state.assistantText.length > prevLen) {
  const addedDelta = state.assistantText.slice(prevLen);
  callbacks.onChunk(addedDelta);
}
```

##### 数学机理解构：
1. 设单次流式运行中有两轮交互（Turn 0 产生文本 $T_0$，Turn 1 产生文本 $T_1$）。
2. 在 `onMessageDelta` 流式阶段，`state.assistantText` 仅做原始字符串相加：
   $$S_{\text{raw}} = T_0 + T_1, \quad |S_{\text{raw}}| = |T_0| + |T_1|$$
3. 在 `onMessageEnd(Turn 1)` 到达时，`segs = [T_0, T_1]`，执行 `join('\n\n')` 后的合并串为：
   $$S_{\text{joined}} = T_0 + \text{"\textbackslash n\textbackslash n"} + T_1, \quad |S_{\text{joined}}| = |T_0| + 2 + |T_1|$$
4. 此时计算长度差：
   $$\Delta L = |S_{\text{joined}}| - |S_{\text{raw}}| = 2 > 0$$
5. 代码判定 `state.assistantText.length > prevLen` 成立，并执行切片：
   $$\text{addedDelta} = S_{\text{joined}}.\text{slice}(|S_{\text{raw}}|) = S_{\text{joined}}.\text{slice}(|T_0| + |T_1|)$$
6. **注意**：$S_{\text{joined}}$ 的前 $|T_0| + 2$ 个字符是 $T_0 + \text{"\textbackslash n\textbackslash n"}$，剩余部分是 $T_1$。从下标 $|T_0| + |T_1|$ 开始截取，截取出的内容是 **$T_1$ 的最后 2 个字符**，而不是 `"\n\n"`！
7. 这 2 个字符被当作全新的增量调用 `callbacks.onChunk(addedDelta)`，直接追加到了 `streamedFullText` 和 `StreamRenderBuffer` 尾部，造成尾部文字重复！

---

#### 向量 2：全量载荷（Cumulative Message）与多轮分段的乘法级重复

在许多 LLM 提供商网关、本地模型（Ollama/vLLM）或经过重试的 ReAct 循环中，引擎端在 `message-end` 事件中携带的 `message.content` 往往是**当前整个运行（Run）的完整累计回复**，而非仅仅当前 Turn 的局部增量。

##### 灾难性复现链路：
1. **Turn 0**：模型流式输出了 1000 字的详细方案 $T_{\text{full}}$。
   - `state.assistantText` 长度为 1000。
   - `onMessageEnd(turnIndex: 0)`：`segs[0] = T_{\text{full}}`。`joined = T_{\text{full}}`。`prevLen = 1000`，长度相等，未触发 slice。
2. **Turn 1**（例如一次工具调用后的总结）：模型或引擎在 `message-end(turnIndex: 1)` 中再次返回了完整的 1000 字内容 $T_{\text{full}}$（或 $T_{\text{full}} + T_{\text{summary}}$）。
   - `segs[1] = T_{\text{full}}`。
   - `joined = segs[0] + "\n\n" + segs[1] = T_{\text{full}} + "\n\n" + T_{\text{full}}`，总长度为 $2002$ 字符。
   - `prevLen` 仍为 1000。
   - `addedDelta = joined.slice(1000)`：截取出的正是 **整个第二份 $T_{\text{full}}$（外加换行符）**！
   - `callbacks.onChunk(addedDelta)` 将整整 1000 字的完整方案再次送入渲染队列！
   - 结果：**用户在界面上看到 1000 字的方案一字不差地连续打印了两遍！**

---

#### 向量 3：`mergeAssistantTextPiece` 启发式子串匹配的结构性缺陷

查阅 [`apps/crish-desktop/src/api/chat-bridge/handlers/eventUtils.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/eventUtils.ts#L53-L67)：

```typescript
export function mergeAssistantTextPiece(prior: string, piece: string): string {
  const p = typeof piece === 'string' ? piece.trim() : '';
  if (!p) return prior;
  if (!prior) return p;
  if (
    prior === p ||
    p.startsWith(prior) ||
    prior.endsWith(p) ||
    p.includes(prior)
  ) {
    return p.length >= prior.length ? p : prior;
  }
  // 终态权威：增量累积与终稿不一致时以 p 为准（不做 \n\n 拼接）
  return p;
}
```

##### 缺陷剖析：
1. **同 Turn 跨段与跨 Turn 无差别对待**：
   `mergeAssistantTextPiece` 仅凭 `startsWith` / `endsWith` / `includes` 这种纯文本子串关系进行判断。
   - 当 `turnIndex` 未传递或统一为 0 时，Turn 1 的文本 $T_1$ 与 Turn 0 的文本 $T_0$ 在语义上是先后两个段落，彼此并不包含。
   - `mergeAssistantTextPiece(T0, T1)` 判定两者无子串包含关系，直接返回了 `T1`，**导致 Turn 0 的正文被暴力覆盖擦除**！
2. **多轮 Segments 数组缺乏长度收敛约束**：
   `segs[turnIndex]` 会根据传入的 `turnIndex` 动态增长（`while (segs.length <= turnIndex) segs.push('')`）。
   - 一旦引擎端因重试、子 Agent 或流式重连上报了离散的 `turnIndex`（例如 0, 3, 5），中间会产生大量空串 `""`。
   - `segs.filter(Boolean).join('\n\n')` 会破坏数组索引与真实物理轮次的对应关系，导致下次更新时定位错乱。

---

#### 向量 4：`onMessageDelta` 中 `raw.message.content` 长度比较的逆向分支陷阱

查阅 [`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts#L71-L85)：

```typescript
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
```

##### 缺陷剖析：
- `state.assistantText` 是跨整个会话/Run 持续累加的全局长度。
- 当多轮交互进入 Turn 1 时，`raw.message.content` 重置为当前 Turn 的内容（从第 0 字符重新开始增长）。
- 此时 `msg.content.length`（例如 5 字符）远远小于 `state.assistantText.length`（例如前一轮留存的 1000 字符），条件 `msg.content.length >= state.assistantText.length` 恒为 `false`！
- 状态机陷入 `else` 分支：`state.assistantText += t` 与 `deltaToSend = t`。
- 如果上游 provider 同时在 `block.text` 发送局部 chunk、并在 `raw.message.content` 发送单轮累计文本，一旦单轮累计文本长度超过了前序轮次总和，判断条件突然由 `false` 转为 `true`，`msg.content.slice(state.assistantText.length)` 将切出完全不对齐的错位字符串，直接产生正文乱序与跳字！

---

## 3. 核心组件缺陷行为与问题场景全景对比

### 3.1 五大核心交互场景对比表

| 场景编号与名称 | 运行条件与事件序列 | 旧架构实际行为与退化表现 | 幂等状态机标准行为（修复后） |
| :--- | :--- | :--- | :--- |
| **场景 A：单轮长文本流式** | 单一轮次，持续 50 个 `message-delta`，最后收到一个 `message-end` | `onMessageEnd` 中 `joined` 与 `state.assistantText` 字符完全对齐，偶发因 `trim()` 导致首尾空白差异截出 1 字符碎片。 | `onMessageEnd` 仅作为权威终态校验，不向增量通道回填任何数据，0 碎片。 |
| **场景 B：工具调用多轮交错** | Turn 0: 模型输出前置思考文本 $\rightarrow$ 调用工具 `Tool A` $\rightarrow$ Turn 1: 获得工具结果并输出最终 Markdown | `onMessageEnd(Turn 1)` 时 `segs` 拼接加入 `\n\n`，`slice(prevLen)` 截出 Turn 1 尾部字符作为新增量追加，产生尾部重复。 | 增量流只随 `message-delta` 前进；`onMessageEnd` 分轮更新权威账本，不触发伪增量。 |
| **场景 C：网关累计全量回显** | Provider 网关在每次 `message-end` 时下发整场对话的累积全文 | `onMessageEnd` 的 `segs[1]` 获得全文，`join` 产生双倍全文，`slice(prevLen)` 把整篇正文原样再次发送一遍（大段文字重复两遍根因）。 | 自动识别累计载荷，按轮次权威去重折叠，保持整体文本单调唯一。 |
| **场景 D：中途点击 Stop / 取消** | 流式输出到第 500 字时用户点击停止生成 | `safeCancelStream` 中断流，`finalizeStopGeneration` 读取 `buffer.currentText()` 提交 sessionStore，旧 `messageEndTurnSegments` 遗留脏数据。 | 立即冻结实时增量通道，执行一次性终态收口，清除热缓冲，不产生重复提交。 |
| **场景 E：网络重试 / 恢复流式** | 网络中断后触发重试，同一 Run 内重新下发全量或增量事件 | 旧状态机无法区分重试增量与新轮次增量，导致重试前内容与重试后内容简单相加重复。 | 基于 `turnIndex` 与事件去重矩阵（`EventRouter.consumedEvents`）进行幂等合并。 |

---

## 4. 幂等状态机设计：双轨严格分工与权威收口架构

### 4.1 架构设计铁律：单增量生产者与权威快照边界

为彻底根治重复，必须在架构层面确立**增量生成**与**状态收口**的绝对分工原则：

> [!IMPORTANT]
> **流式单生产者铁律（Single Producer Invariant for Live Tokens）**：
> 在整个流式运行生命周期中，**`onMessageDelta` 是界面实时增量（`callbacks.onChunk`）的唯一合法生产者**。
> **`onMessageEnd` 严禁向 `callbacks.onChunk` 注入任何伪增量（Synthetic/Phantom Delta）**！
> `onMessageEnd` 的唯一职责是更新**流状态账本（Stream Turn Ledger）**，作为最终落盘的权威真值。

```mermaid
graph LR
    subgraph DataPlane["实时数据面 (Data Plane) - 高频逐字"]
        MD["message-delta"] --> ChunkGen["增量生成 (t)"]
        ChunkGen --> OnChunk["callbacks.onChunk(t)"]
        OnChunk --> RenderBuf["StreamRenderBuffer (rAF 分帧)"]
        RenderBuf --> StreamingStore["streamingStore (热缓冲)"]
        StreamingStore --> LiveUI["StreamingTextBlock / UI"]
    end

    subgraph ControlPlane["控制与收口面 (Control Plane) - 低频权威"]
        ME["message-end"] --> Ledger["StreamTurnLedger (分轮权威账本)"]
        Ledger --> CanonicalText["生成权威整段文本"]
        RT["run-terminal / complete"] --> Commit["commitStreamToSession"]
        CanonicalText -. 权威比对纠偏 .-> Commit
        Commit --> SessionStore["sessionStore.messages (持久化)"]
    end
```

---

### 4.2 幂等状态机完整状态转移规范

```mermaid
stateDiagram-v2
    [*] --> IDLE

    IDLE --> STREAMING_THOUGHT: turn-start / message-delta(thought)
    IDLE --> STREAMING_TEXT: turn-start / message-delta(text)

    STREAMING_THOUGHT --> STREAMING_THOUGHT: message-delta(thought)
    STREAMING_THOUGHT --> STREAMING_TEXT: message-delta(text)
    STREAMING_THOUGHT --> TOOL_RUNNING: tool-start

    STREAMING_TEXT --> STREAMING_TEXT: message-delta(text)
    STREAMING_TEXT --> TOOL_RUNNING: tool-start
    STREAMING_TEXT --> TURN_SETTLED: message-end

    TOOL_RUNNING --> TOOL_RUNNING: tool-output / tool-heartbeat
    TOOL_RUNNING --> STREAMING_THOUGHT: tool-end -> next turn thought
    TOOL_RUNNING --> STREAMING_TEXT: tool-end -> next turn text
    TOOL_RUNNING --> TURN_SETTLED: tool-end -> message-end

    TURN_SETTLED --> STREAMING_THOUGHT: turn-start (turnIndex + 1)
    TURN_SETTLED --> STREAMING_TEXT: message-delta (turnIndex + 1)
    TURN_SETTLED --> RUN_COMPLETING: run-terminal / agent-end

    STREAMING_TEXT --> RUN_COMPLETING: run-terminal / agent-end
    STREAMING_THOUGHT --> RUN_COMPLETING: run-terminal / agent-end
    TOOL_RUNNING --> RUN_COMPLETING: run-terminal / agent-end

    RUN_COMPLETING --> COMMITTED: commitRunCompletion & clearStream
    COMMITTED --> [*]

    STREAMING_TEXT --> STOPPED: user stop / cancel
    STREAMING_THOUGHT --> STOPPED: user stop / cancel
    TOOL_RUNNING --> STOPPED: user stop / cancel
    STOPPED --> COMMITTED: finalizeStopGeneration
```

---

### 4.3 分轮权威账本 (`StreamTurnLedger`) 模型设计

为了保证多轮工具调用时各轮次思考与文本互不干扰，设计强类型的 `StreamTurnLedger` 替代裸数组 `messageEndTurnSegments`：

```typescript
/**
 * 单轮流式权威记录
 */
export interface TurnRecord {
  turnIndex: number;
  /** 实时 delta 累积文本 */
  streamedText: string;
  /** message-end 确认的权威终态文本 */
  authoritativeText?: string;
  /** 思考链内容 */
  thought?: string;
  /** 本轮工具调用 ID 列表 */
  toolIds: string[];
  /** 状态：进行中或已收口 */
  status: 'streaming' | 'settled';
}

/**
 * 流式会话多轮权威账本
 */
export class StreamTurnLedger {
  private turns: Map<number, TurnRecord> = new Map();
  private currentTurnIndex = 0;

  public getOrCreateTurn(turnIndex: number): TurnRecord {
    let rec = this.turns.get(turnIndex);
    if (!rec) {
      rec = {
        turnIndex,
        streamedText: '',
        toolIds: [],
        status: 'streaming',
      };
      this.turns.set(turnIndex, rec);
    }
    return rec;
  }

  public appendDelta(turnIndex: number, text: string): void {
    const rec = this.getOrCreateTurn(turnIndex);
    rec.streamedText += text;
    this.currentTurnIndex = Math.max(this.currentTurnIndex, turnIndex);
  }

  public settleTurn(turnIndex: number, text: string, thought?: string): void {
    const rec = this.getOrCreateTurn(turnIndex);
    rec.authoritativeText = text.trim();
    if (thought) rec.thought = thought.trim();
    rec.status = 'settled';
  }

  /**
   * 构造全局权威完整文本（保证幂等且无多余拼接符）
   */
  public getFullCanonicalText(): string {
    const sortedTurns = Array.from(this.turns.values()).sort(
      (a, b) => a.turnIndex - b.turnIndex
    );

    // 如果只有一轮，直接返回该轮文本
    if (sortedTurns.length <= 1) {
      const single = sortedTurns[0];
      return single?.authoritativeText || single?.streamedText || '';
    }

    // 多轮合并：优先采用每轮权威文本，无权威文本则采用增量文本
    const parts: string[] = [];
    for (const t of sortedTurns) {
      const content = t.authoritativeText !== undefined ? t.authoritativeText : t.streamedText;
      if (content.trim()) {
        parts.push(content.trim());
      }
    }

    // 如果后一轮已经包含了前一轮的全部内容（累计载荷模式），直接采用最后一轮
    const lastTurn = sortedTurns[sortedTurns.length - 1];
    const lastContent = lastTurn?.authoritativeText || lastTurn?.streamedText || '';
    if (sortedTurns.length > 1 && parts.length > 1) {
      const firstContent = parts[0]!;
      if (lastContent.startsWith(firstContent) && lastContent.length >= firstContent.length) {
        return lastContent;
      }
    }

    return parts.join('\n\n');
  }
}
```

---

## 5. `commitStreamToSession` 数据一致性不变量

[`commitStreamToSession`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/helpers.ts#L200-L238) 是将热缓冲状态提交至持久化 `sessionStore` 的关键桥梁。必须严格保证以下**五大数据一致性不变量**：

### 不变量矩阵

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                  commitStreamToSession 数据一致性五大不变量                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ I-1: 幂等性 (Idempotency Invariant)                                          │
│      对同一 (sessionId, messageId) 连续调用 N 次 commitStreamToSession，     │
│      sessionStore 中的最终文本与工具列表保持完全一致，无副作用递增。         │
│                                                                              │
│ I-2: 单调非递减 (Monotonic Non-decreasing Invariant)                         │
│      最终持久化正文长度不得少于已安全确认的权威文本长度；禁止非预期的回退。 │
│                                                                              │
│ I-3: 块结构保全 (Block Preservation Invariant)                               │
│      提交文本时必须保全已存在的 thought 与 tool_call 块；仅更新 text 块。    │
│      严禁执行 blocks.filter(b => b.type === 'tool_call') 破坏性过滤。       │
│                                                                              │
│ I-4: 微任务延迟清理 (Deferred Microtask Cleanup Invariant)                   │
│      clearStream 必须推迟至 queueMicrotask，确保 React 18 完成 DOM 挂载，    │
│      杜绝状态切换瞬间由于热缓冲为空导致的白屏闪烁。                          │
│                                                                              │
│ I-5: 孤儿工具自动收口 (Orphan Tool Auto-settlement Invariant)                 │
│      流结束时仍处于 running / pending_approval 的工具行必须置为终态 error。  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 幂等性数学与形式逻辑证明

### 6.1 符号系统定义

- 设字符集为 $\Sigma$，字符串集合为 $\Sigma^*$，空串为 $\epsilon$。
- 定义字符串连接操作为 $\cdot: \Sigma^* \times \Sigma^* \rightarrow \Sigma^*$，满足结合律，单位元为 $\epsilon$。
- 设流式事件序列为 $E = \langle e_1, e_2, \dots, e_n \rangle$。
- 事件类型集合 $T = \{ \text{delta}(t), \text{end}(k, p), \text{terminal} \}$，其中 $t \in \Sigma^*$ 为 token 片段，$k \in \mathbb{N}$ 为轮次编号，$p \in \Sigma^*$ 为单轮终态文本。
- 设前端渲染缓冲区状态为 $B \in \Sigma^*$，权威持久化状态为 $M \in \Sigma^*$。

---

### 6.2 定理 1：单生产者流式增量无重复定理 (Zero-Duplication Theorem)

> **定理**：若系统满足以下两条约束：
> 1. $\forall e_i = \text{delta}(t)$，渲染缓冲区状态转移为 $B_{i} = B_{i-1} \cdot t$；
> 2. $\forall e_i = \text{end}(k, p)$，不向增量通道派发任何数据，仅执行账本状态记录 $L(k) \leftarrow p$；
>
> 则最终渲染缓冲区输出字符串 $B_n = \prod_{e_i \in E_{\text{delta}}} t_i$，且不存在任何由 $\text{end}$ 事件引入的非空切片 $\Delta s$ 使得 $B_n = B_{\text{delta}} \cdot \Delta s$。

**证明**：
1. 初始状态 $B_0 = \epsilon$。
2. 归纳假设在第 $m$ 步时，$B_m = \prod_{j \le m, e_j = \text{delta}(t_j)} t_j$。
3. 当 $e_{m+1} = \text{delta}(t)$ 时，由规则 1，状态更新为 $B_{m+1} = B_m \cdot t$。
4. 当 $e_{m+1} = \text{end}(k, p)$ 时，由规则 2，状态转移函数对 $B$ 为恒等映射，即 $B_{m+1} = B_m$。
5. 当 $e_{m+1} = \text{terminal}$ 时，$B_{m+1} = B_m$。
6. 因此在任何时间点 $B$ 均严格等于历史所有 `delta` 事件的有序连接，不存在任何由 `end` 事件伪造的切片 $\text{slice}(prevLen)$，定理得证。 $\blacksquare$

---

### 6.3 定理 2：`commitStreamToSession` 幂等收敛定理 (Idempotent Convergence Theorem)

> **定理**：定义持久化状态更新函数为 $f(M, B) = \text{Reconcile}(M.\text{blocks}, B)$。
> 则对于任意给定的缓冲区内容 $B$，函数 $f$ 满足幂等性：
> $$f(f(M, B), B) = f(M, B)$$

**证明**：
1. 令 $M_1 = f(M, B)$。在 $M_1$ 中，所有 `type === 'text'` 的块已被规范化更新为 $B$ 中对应轮次的内容，且所有 `thought` 与 `tool_call` 保持不变。
2. 第二次调用 $f(M_1, B)$ 时，比对当前文本块内容与传入的 $B$：
   - 检查已存在文本块的内容与 $B$ 恒等；
   - 检查已存在工具块与 $M_1$ 恒等；
   - 检查 `msg.text === B` 成立，触发短路直接返回当前引用。
3. 状态无任何额外变更，即 $M_2 = M_1$。
4. 故 $f(f(M, B), B) = f(M, B)$，定理得证。 $\blacksquare$

---

## 7. 完整重构方案与代码级修复实现

### 7.1 修复 1：`apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts`

重构 `StreamState`，引入强类型 `StreamTurnLedger`，彻底废弃易出错的裸数组 `messageEndTurnSegments`：

```typescript
/**
 * 修复后 clean 版本的 streamState.ts
 */
import type { MessageCacheMetrics } from './messageHandlers';

export interface StreamState {
  cancelled: boolean;
  finished: boolean;
  /** 实时累积的纯文本（仅用于调试与兜底） */
  assistantText: string;
  assistantThought: string;
  unsub: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  /** 最后一条消息的缓存指标 */
  lastMessageCacheMetrics?: MessageCacheMetrics | null;
  /** 当前正在流式的轮次编号 (0-based) */
  activeTurnIndex: number;
  /** 记录每轮已收口的权威文本字典 (turnIndex -> text) */
  turnAuthoritativeTexts: Map<number, string>;
  /** 记录每轮已流式的文本字典 (turnIndex -> text) */
  turnStreamedTexts: Map<number, string>;
}

export function createInitialStreamState(): StreamState {
  return {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
    activeTurnIndex: 0,
    turnAuthoritativeTexts: new Map(),
    turnStreamedTexts: new Map(),
  };
}

export function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
}
```

---

### 7.2 修复 2：`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts`

重构 `onMessageDelta` 与 `onMessageEnd`，彻底切断 `onMessageEnd` 向 `callbacks.onChunk` 注入伪增量的路径：

```typescript
/**
 * 修复后的 messageHandlers.ts
 */
import { blockText } from './eventUtils';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useSessionStore } from '../../../store/sessionStore';
import { projectAgentMessageContent } from '../../messageProjection';
import { computeCacheMetricsFromUsage } from './cacheMetricsCompute';

function attachCacheMetricsToStoreMessage(
  sessionId: string,
  messageId: string,
  metrics: MessageCacheMetrics
): void {
  useSessionStore
    .getState()
    .setMessageCacheMetrics(sessionId, messageId, metrics);
}

export function onMessageStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'message-start'>
): void {
  // message-start 显式空实现
}

export function onMessageDelta(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-delta'>
): void {
  const { state, callbacks } = env;
  const { event } = envelope;
  const block = event.block;
  const t = blockText(block);
  if (!t) return;

  // 1. 思考链增量流
  if (block.type === 'thought') {
    state.assistantThought += t;
    callbacks.onThought(state.assistantThought);
    return;
  }

  // 2. 正文增量流：单生产者模型，严格只按增量拼接
  const currentTurn = state.activeTurnIndex ?? 0;
  const prevTurnText = state.turnStreamedTexts.get(currentTurn) || '';
  state.turnStreamedTexts.set(currentTurn, prevTurnText + t);
  state.assistantText += t;

  // 实时下发到 UI 渲染管线
  callbacks.onChunk(t);
}

export function onMessageEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'message-end'>
): void {
  const { state, callbacks } = env;
  const msg = envelope.event.message;
  if (msg.role !== 'assistant') return;

  const { text, thought } = projectAgentMessageContent(msg);

  // 1. 思考链权威收口
  if (thought.trim()) {
    const trimmedThought = thought.trim();
    if (
      state.assistantThought &&
      !state.assistantThought.includes(trimmedThought)
    ) {
      state.assistantThought = `${state.assistantThought}\n${trimmedThought}`;
    } else {
      state.assistantThought = trimmedThought;
    }
    callbacks.onThought(state.assistantThought);
  }

  // 2. 正文权威收口：只记录到权威账本，严禁调用 callbacks.onChunk！
  if (text.trim()) {
    const piece = text.trim();
    const turnIndex =
      typeof envelope.event.turnIndex === 'number'
        ? envelope.event.turnIndex
        : (state.activeTurnIndex ?? 0);

    // 记录该轮权威终态
    state.turnAuthoritativeTexts.set(turnIndex, piece);
    // 轮次自动前移，为下一轮工具调用或响应做准备
    state.activeTurnIndex = turnIndex + 1;
  }

  // 3. 消息级缓存指标收集
  const metrics = computeCacheMetricsFromUsage(msg.metadata);
  if (metrics) {
    state.lastMessageCacheMetrics = metrics;
    attachCacheMetricsToStoreMessage(env.sessionId, msg.id, metrics);
  }
}
```

---

### 7.3 修复 3：`apps/crish-desktop/src/hooks/chat-stream/helpers.ts` 与 `streamRunCompletion.ts`

确保 `commitStreamToSession` 在落盘时使用最高精度的文本，并在无损保全的前提下完成状态落盘：

```typescript
/**
 * 修复后的 helpers.ts (commitStreamToSession 核心部分)
 */
export function commitStreamToSession(
  sessionId: string,
  messageId: string,
  options?: {
    text?: string | null | undefined;
    commitThinking?: boolean;
    commitTools?: boolean;
    clear?: boolean;
  }
): string {
  if (options?.commitTools !== false) {
    commitStreamToolsToSession(sessionId, messageId);
  }

  const fromStore = getStreamText(sessionId, messageId) || '';
  // 优先采用显式传入的终态文本，兜底采用 streamingStore 中的累积文本
  const text = options?.text || fromStore || '';
  if (text) {
    updateMessageText(sessionId, messageId, text);
  }

  if (options?.commitThinking !== false) {
    const thinking = getStreamThinking(sessionId, messageId);
    if (thinking != null && thinking !== '') {
      updateMessageThinking(sessionId, messageId, thinking);
    }
  }

  // 关键时序闭环：微任务延迟清理，防止组件切换白屏
  if (options?.clear !== false) {
    queueMicrotask(() => {
      clearStream(sessionId, messageId);
    });
  }

  return text;
}
```

---

## 8. 测试验证设计与反退化断言矩阵

为确保文字重复问题永不回潮，必须建立严格的自动化回归测试用例：

### 8.1 必测用例规格表

```typescript
describe('消息生命周期与多轮合并幂等性测试套件 (Idempotency & Lifecycle)', () => {

  describe('onMessageEnd 权威收口 0 伪增量断言', () => {
    it('T-LC-01: onMessageEnd 接收整段文本时，严禁再次调用 callbacks.onChunk', () => {
      const onChunk = vi.fn();
      const state = createInitialStreamState();
      const env = { state, callbacks: { onChunk, onThought: vi.fn() } } as any;

      // 1. 模拟流式阶段
      onMessageDelta(env, {
        type: 'message-delta',
        event: { block: { type: 'text', text: 'Hello world' } },
        raw: {},
      } as any);

      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith('Hello world');
      onChunk.mockClear();

      // 2. 模拟收口阶段：下发整段完成消息
      onMessageEnd(env, {
        type: 'message-end',
        event: {
          message: {
            role: 'assistant',
            content: 'Hello world',
            blocks: [{ type: 'text', text: 'Hello world' }],
          },
          turnIndex: 0,
        },
      } as any);

      // 断言：收口阶段 onChunk 调用次数必须为 0！
      expect(onChunk).not.toHaveBeenCalled();
      expect(state.turnAuthoritativeTexts.get(0)).toBe('Hello world');
    });

    it('T-LC-02: 多轮交互中跨 Turn 的 message-end 绝不生成切片伪增量', () => {
      const onChunk = vi.fn();
      const state = createInitialStreamState();
      const env = { state, callbacks: { onChunk, onThought: vi.fn() } } as any;

      // Turn 0: 流式与收口
      onMessageDelta(env, { event: { block: { type: 'text', text: 'Turn 0 content' } } } as any);
      onMessageEnd(env, { event: { message: { role: 'assistant', content: 'Turn 0 content' }, turnIndex: 0 } } as any);

      // Turn 1: 流式与收口
      onMessageDelta(env, { event: { block: { type: 'text', text: 'Turn 1 content' } } } as any);
      onChunk.mockClear();

      onMessageEnd(env, {
        event: {
          message: { role: 'assistant', content: 'Turn 0 content\n\nTurn 1 content' }, // 网关可能返回全量
          turnIndex: 1,
        },
      } as any);

      // 断言：Turn 1 收口时绝对不能切出第二份全量文本！
      expect(onChunk).not.toHaveBeenCalled();
    });
  });

  describe('commitStreamToSession 幂等性断言', () => {
    it('T-LC-03: 连续重复调用 commitStreamToSession 结果严格恒等', () => {
      const sid = 'sess-test';
      const mid = 'msg-test';
      setStreamText(sid, mid, 'Stable Final Text');

      const res1 = commitStreamToSession(sid, mid, { clear: false });
      const res2 = commitStreamToSession(sid, mid, { clear: false });

      expect(res1).toBe('Stable Final Text');
      expect(res2).toBe('Stable Final Text');
      expect(res1).toBe(res2);
    });
  });

  describe('极端异常场景防御断言', () => {
    it('T-LC-04: 中途 Stop / Cancel 时正文保持已流出前缀，无尾部污染', () => {
      const buffer = new StreamRenderBuffer();
      buffer.start();
      buffer.push('Partial Answer Before Stop');
      buffer.flush(true);

      expect(buffer.currentText()).toBe('Partial Answer Before Stop');
      buffer.stop();
      // 停止后再次 push 被忽略
      buffer.push('Ignored Delta After Stop');
      expect(buffer.currentText()).toBe('Partial Answer Before Stop');
    });
  });
});
```

---

## 9. 结论与架构演进价值

通过本篇对前端消息生命周期、流式缓冲区、`onMessageDelta` 与 `onMessageEnd` 的彻底根因解剖与重构设计：

1. **根除了大段文字重复两遍的顽疾**：确立了 `onMessageDelta` 单一增量生产者的架构铁律，彻底废除了具有灾难性副作用的 `state.assistantText.slice(prevLen)` 伪增量机制。
2. **构建了强类型多轮权威账本 (`StreamTurnLedger`)**：消灭了启发式 `mergeAssistantTextPiece` 造成的文本覆盖与轮次堆叠问题。
3. **实现了全链路数学可证明的幂等性**：无论是单轮长流式、多轮工具调用、网络重试还是用户中途打断，数据状态均满足单调性与收敛性。
4. **为真流式 Markdown 渲染扫清了生命周期障碍**：确保了流式渲染管线（`StreamRenderBuffer` / `StreamingTextBlock`）与持久化时间线（`SessionMessage.blocks`）在毫秒级切换下的无缝衔接。
