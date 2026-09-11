# 助手消息时间线与数据模型深度调研报告

> 战役工作区：`docs/assistant-process-folding/`  
> 模块标识：`survey/01-timeline-and-data-model-survey.md`  
> 角色定位：时间线与数据模型调研员  
> 规范遵循：根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`00-纪律与调度状态.md`  

---

## 一、调研背景与核心目标

在 Conex/Crish 桌面工作台中，AI 助手在长链路推理与多步工具执行任务中，会持续产生复杂的交错事件流：
$$\text{思考 (Thought)} \to \text{上下文注入 (Injection)} \to \text{工具调用 (Tool Call)} \to \text{阶段正文 (Text)} \to \text{后续思考} \to \text{工具执行} \to \dots \to \text{总结正文}$$

随着**正文交错过程折叠战役（assistant-process-folding）**的启动，前端交互需要从原本粗暴的“整条消息统一折叠全部思考与工具”升级为参考现代 AI Agent 交互规范的高级体验：
1. **以正文作为天然物理界标**，将助手消息的时间线精确划分为若干个交错的“过程段（Process Segment）”与“正文段（Text Segment）”；
2. **终态自动收敛收拢**：AI 输出总结正文后，前面所有的思考与工具调用默认折叠为分类统计胶囊，整轮仅外露耗时指示、分割线与正文内容；
3. **用户中途插入节点（User Steering / Interruption）**：在 AI 运行过程中用户插话时，严格保证物理隔离，严禁将用户消息折叠混入 AI 的过程块中。

本调研报告对 Conex/Crish 前端的数据模型定义、流式状态机维护、时间线归一化/重水合管线、交错时序保持性以及用户中途插入消息的存储链路进行深入的代码级透视与根因剖析，为后续独立方案设计提供确凿的事实证据与契约设计基础。

---

## 二、核心数据类型与契约定义深度剖析

Conex/Crish 前端的消息与时间线数据结构定义集中在 `apps/crish-desktop/src/store/types.ts`。

### 1. `SessionMessage`：会话单条消息实体

`SessionMessage` 承载会话中一条完整的用户或助手交互实体。它是前端在 Rust 内核 `EngineAgentMessage`（派生溯源字段 `id`, `clientMessageId`, `metadata`）之上的超集投影装饰。

- **代码坐标**：`apps/crish-desktop/src/store/types.ts:527-589`
- **核心字段拓扑**：
  ```typescript
  export interface SessionMessage extends Pick<AgentMessage, 'id' | 'clientMessageId'> {
    sender: MessageSender;                                    // 'user' | 'assistant'
    text?: string | undefined;                                // 累计正式正文（Markdown 字符串）
    metadata?: unknown | undefined;                           // 引擎元数据承继
    thinking?: string | undefined;                            // 最新流式思考文本（单轨兜底）
    thinkingTurns?: Array<{                                   // 结构化思考分段（多轮回放权威源）
      turnIndex: number;
      content: string;
      durationMs?: number;
      id?: string;
      isStreaming?: boolean;
    }>;
    timestamp: number;                                        // epoch ms
    toolCalls?: MessageToolCall[] | undefined;                // 助手发起的扁平工具调用集合
    status?: SessionMessageStatus | undefined;                // 'queued' | 'processing' | 'completed' | 'error'
    precomputedHtml?: string | undefined;                     // Worker 异步预渲染 HTML 缓存
    toolCallResults?: SessionMessageToolCallResult[];         // 工具回执关联索引（配对淘汰）
    injections?: MessageContextInjection[] | undefined;       // 本条消息挂载的系统可见注入卡片
    blocks?: MessageTimelineBlock[] | undefined;              // 核心：按发生顺序交错的时间线块
    streamTextOffset?: number | undefined;                    // 上一工具插入时 text 的切分偏移游标
    thinkingTime?: number | undefined;                        // 思考总耗时
    images?: MessageImageRef[] | undefined;                   // 结构化图片资产索引
    attachments?: SessionMessageAttachment[] | undefined;     // 用户输入附件（文件/代码/图片）
    cacheMetrics?: MessageCacheState | null;                  // Prompt 缓存命中指标
  }
  ```
- **关键设计洞察**：
  - `msg.text` 存储的是整条助手消息**全局累计**的 Markdown 纯文本；
  - `msg.blocks` 是真正的**物理时序容器**，负责记录 `thought`、`tool_call`、`text`、`context_injection` 等交错事件；
  - `msg.streamTextOffset` 是一个**游标指针**，用于在流式期间把累计的 `msg.text` 截断切片为当前工具之后的新正文段。

### 2. `MessageTimelineBlock`：细粒度时间线块

- **代码坐标**：`apps/crish-desktop/src/store/types.ts:471-516`
- **类型定义**：
  ```typescript
  export type MessageTimelineBlockType =
    | 'thought'             // 思维链思考块（一等公民）
    | 'text'                // 正文段落块
    | 'tool_call'           // 工具调用锚点（通过 id 关联 toolCalls）
    | 'context_injection'   // 系统上下文注入卡片（规则/技能/环境快照）
    | 'image'               // 结构化图片资产块
    | 'step_start'          // 执行步骤开始标记
    | 'step_end';           // 执行步骤结束标记

  export interface MessageTimelineBlock {
    type: MessageTimelineBlockType;
    id?: string;                        // tool_call 对齐 MessageToolCall.id；injection 对齐 MessageContextInjection.id
    content?: string;                   // 文本或思考内容
    turnIndex?: number;                 // 关联轮次索引 (0-based)
    startTime?: number;                 // 开始时间戳（epoch ms）
    durationMs?: number;                // 耗时毫秒
    isStreaming?: boolean;              // 是否正在流式生成中
    isHistoricalCollapsed?: boolean;    // 是否处于历史默认折叠态
    redacted?: boolean;                 // 是否被模型安全策略脱敏
    images?: MessageImageRef[];         // 图片引用列表
    injection?: MessageContextInjection;// 注入卡片全量内联载荷
  }
  ```
- **关键设计洞察**：
  - `MessageTimelineBlock` 是扁平数组（Flat Sequence），其数组下标直接代表时间上的发生先后；
  - `turnIndex` 在 `thought` 块中通过 `updateMessageThinking` 显式维护（如 `cleanTurn`），但在 `updateMessageText` 创建 `text` 块时却常缺省（导致为 `undefined`，清洗后退化为 `0`）；
  - `tool_call` 块是一个轻量锚点（仅存 `type: 'tool_call'`, `id`, `startTime`, `durationMs`），其参数、输出和状态均保存在 `msg.toolCalls` 数组中。

### 3. `MessageToolCall`：工具调用实体

- **代码坐标**：`apps/crish-desktop/src/store/types.ts:321-350`
- **生命周期状态**：
  - `MessageToolCallStatus`: `'running' | 'success' | 'error' | 'pending_approval'`；
  - 与用户审批决定解耦：用户审批决定由独立字段 `approvalDecision?: 'approved' | 'rejected'` 承载，保证“工具执行结果”与“用户审批决议”正交解耦（`types.ts:260-274`）。
- **关键字段**：
  - `id: string`（唯一标识，如 `call_xyz123`）；
  - `name: string`（工具名称，如 `read_file`, `run_command`, `write_to_file`）；
  - `arguments?: string`（调用参数 JSON 串）；
  - `output?: string`（工具执行输出或回执文本）；
  - `diffs?: FileDiff[]`（文件改动快照列表，供展开态渲染代码增删统计）；
  - `startedAt?: number`, `finishedAt?: number`, `durationMs?: number`, `completedAt?: number`；
  - `turnId?: string`（同一轮并行调用的关联批次标识）。

### 4. `MessageContextInjection`：统一可见上下文注入卡片

- **代码坐标**：`apps/crish-desktop/src/store/types.ts:387-469`
- **设计定位**：Prompt 注入管线一等公民，用于将系统加载的规则、技能、Git 状态、环境切换等可见卡片无损插在对话流中，与 `ToolCard` 具有同构地位。
- **分类契约（9 类）**：`rule`, `skill`, `file_context`, `git_status`, `terminal_output`, `runtime_steering`, `schedule_trigger`, `memory`, `workspace_env`。
- **生命周期（5 态）**：`pending`, `injected`, `active`, `expired`, `failed`。
- **元数据扩展**：支持 `metadata: ContextStateMetadata`（如模型切换通知 `mode: 'context-state'`，`types.ts:424-431`）。

---

## 三、时间线生成与重水合管线剖析（Normalizer & Reconciler）

时间线从 Store 数据投影到 UI 渲染项的管线由 `timelineNormalizer.ts` 与 `timelineReconciler.ts` 构成。

```
[SessionMessage Store 实体]
   (blocks, toolCalls, thinkingTurns, injections)
          │
          ▼
normalizeAssistantTimeline (timelineReconciler.ts)
   ├── 双向重水合思考链 (thinkingTurns 补全 blocks)
   ├── alignToolCallBlocks (剔除幽灵工具、补齐缺失工具)
   ├── 补偿丢失的正文块 (若有 text 但无 text block)
   └── reconcileAssistantMessageBlocks (三元槽位保全合并)
          │
          ▼
buildAssistantTimeline (timelineNormalizer.ts)
   ├── 遍历 blocks
   ├── 连续 tool_call 聚合为 TimelineToolsItem (flushTools)
   ├── thought 映射为 TimelineThoughtItem
   ├── context_injection 映射为 TimelineInjectionItem
   ├── text 经 inlineTagParser 提取行内 <thought> 标签并映射
   ├── 孤儿注入与孤儿工具置顶/置底补偿
   └── enforceThoughtBeforeText (物理因果校准：确保思考在正文前)
          │
          ▼
[AssistantTimelineItem[] 渲染项列表]
```

### 1. 投影构建：`buildAssistantTimeline`

- **代码坐标**：`apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts:94-245`
- **运行时行为**：
  1. **工具连续合并（`flushTools`，行 109-124）**：
     维护局部缓冲 `toolBuf = []`。连续遇到 `b.type === 'tool_call'` 时暂存入 `toolBuf`；当遇到 `thought`、`context_injection`、`text` 或循环结束时，触发 `flushTools()`，调用 `buildToolRenderItems(toolBuf)` 将一批工具调用聚合为一个 `TimelineToolsItem`（`kind: 'tools'`），计算首个工具的 `startTime` 与总耗时 `durationMs`。
  2. **注入卡片映射（行 144-157）**：
     将 `context_injection` 映射为 `TimelineInjectionItem`（`kind: 'injection'`），优先从 `msg.injections` 查找，兜底使用 `b.injection`。
  3. **思考块映射（行 158-173）**：
     将 `thought` 块映射为 `TimelineThoughtItem`（`kind: 'thought'`），提取 `turnIndex`, `startTime`, `durationMs`, `isStreaming`, `isHistoricalCollapsed`。
  4. **正文段解析（行 174-188）**：
     将 `text` 块送入 `pushParsedText`（行 56-88），调用 `parseInlineThoughtAndTextSafely` 解析 Markdown 栅栏保护外的行内 `<thought>` 标签，生成 `TimelineTextItem`（`kind: 'text'`）及可能的行内 `TimelineThoughtItem`。
  5. **历史无 blocks 消息的降级分支（行 224-238）**：
     若 `msg.blocks` 为空，执行降级组装：
     $$\text{injections} \to \text{pushFallbackTurns (thoughts)} \to \text{tools} \to \text{text}$$
     这是一种完全**静态扁平拼接**，完全不具备多段交错能力。
  6. **因果时序守卫（`enforceThoughtBeforeText`，行 251-272）**：
     仅在两块明确指定且处于同一显式 `turnIndex` 时，确保 `thought` 移到该轮的 `text` 之前。

### 2. 三元槽位保全合并：`reconcileAssistantMessageBlocks`

- **代码坐标**：`apps/crish-desktop/src/api/tool-presentation/timelineReconciler.ts:78-125`
- **槽位契约**：以 `${cleanTurn}:${type}:${id}` 作为三元组槽位键（行 96, 105）。
- **合并逻辑**：
  1. 将 `existingBlocks` 填入 `existingMap`（保护已有的 `thought` 与 `tool_call`）；
  2. 遍历 `incomingBlocks`，命中槽位则更新合并，否则新增并压入 `result`；
  3. 遍历 `existingMap` 中剩余未被覆盖的历史项，若为 `tool_call` 或 `thought`，则全量追加至末尾（100% 永久保全孤儿历史块，行 115-120）；
  4. 严格按流式到达的顺序输出，禁止任何 type/turn 强制重排。

### 3. 工具对齐：`alignToolCallBlocks`

- **代码坐标**：`apps/crish-desktop/src/api/tool-presentation/timelineReconciler.ts:20-57`
- **对齐规则**：
  - 过滤掉 blocks 中不在 `tools` 列表中的幽灵工具块；
  - 对 `tools` 中存在但 blocks 中缺失的工具块（`missing`），若 blocks 只有 text 或为空，则置于首位；否则寻找最后一个 `text` 块，并将缺失工具块统一插入到**最后一个 text 块之前**（行 45-56）。

---

## 四、流式运行时 blocks 与 streamTextOffset 动态维护机制

在 AI 实时生成时，流式文本（SSE/Chunk）、思考事件与工具调用事件并发到达前端，前端通过 Store actions 进行增量维护。

### 1. 正文流式增量：`updateMessageText`

- **代码坐标**：`apps/crish-desktop/src/store/sessionMessageActionsCore.ts:193-250`
- **核心逻辑剖析**：
  ```typescript
  updateMessageText: (sessionId, messageId, text, precomputedHtml) =>
    set((state) => {
      const hit = getSessionMessage(state, sessionId, messageId);
      if (!hit) return;
      const msg = hit.message;
      ...
      msg.text = text; // 全局累计正文更新
      if (!msg.blocks) msg.blocks = [];
      
      let offset = typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
      // 容错重置：若 text 比 offset 短，或发生非前缀缩短，重置 offset 为 0 并清除非法 text 块
      if (text.length < offset || ...) {
        offset = 0;
        msg.streamTextOffset = 0;
        msg.blocks = msg.blocks.filter((b) => b.type !== 'text');
      }
      
      // 切出当前段落正文！
      const segment = text.length >= offset ? text.slice(offset) : text;
      
      // 定位是否已有可承接当前段落的最新 text 块（位于最后工具调用之后，或全块无工具）
      const lastToolIdx = msg.blocks.map((b) => b.type).lastIndexOf('tool_call');
      let targetTextIdx = -1;
      for (let i = msg.blocks.length - 1; i >= 0; i--) {
        if (msg.blocks[i]?.type === 'text') {
          if (lastToolIdx === -1 || i > lastToolIdx) {
            targetTextIdx = i;
          }
          break;
        }
      }

      const now = Date.now();
      if (targetTextIdx >= 0) {
        // 原地更新已有的最新 text 块
        const target = msg.blocks[targetTextIdx]!;
        target.content = segment;
        if (target.startTime) {
          target.durationMs = Math.max(0, now - target.startTime);
        }
      } else if (segment.length > 0) {
        // 创建新的 text 块并追加到 blocks 尾部
        msg.blocks.push({
          type: 'text' as const,
          content: segment,
          startTime: now,
          durationMs: 0,
        });
      }
      rebindSessionById(state, sessionId, hit.session);
    })
  ```

### 2. 思考流式增量：`updateMessageThinking`

- **代码坐标**：`apps/crish-desktop/src/store/sessionMessageActionsCore.ts:252-330`
- **核心逻辑剖析**：
  - 同步维护 `msg.thinkingTurns`（行 268-289）：按 `cleanTurn` 索引查找，存在则更新 `content` 与 `durationMs`，不存在则 push 新轮次；
  - 维护 `msg.blocks` 中的 `thought` 块（行 290-328）：
    - 查找 `b.type === 'thought'` 且 `b.turnIndex === cleanTurn` 的块；
    - 存在则原地更新内容与耗时；
    - 不存在且思考非空时，创建新 `thought` 块。
    - **物理插入时序保证（行 322-327）**：检查 blocks 末尾是否为无内容的正文块（`lastBlock.type === 'text' && !lastBlock.content?.trim()`），若是则插到其之前，否则直接 `msg.blocks.push(newBlock)` 追加到末尾。

### 3. 工具调用创建：`addMessageToolCall`

- **代码坐标**：`apps/crish-desktop/src/store/sessionMessageActionsTools.ts:51-110`
- **核心逻辑剖析**：
  ```typescript
  addMessageToolCall: (sessionId, messageId, toolCall) =>
    set((state) => {
      ...
      // 关键游标锚定：记录工具插入瞬间的 text 长度作为分段 offset
      msg.streamTextOffset = (msg.text || '').length;

      // 清理末尾无内容的空 text 块
      const lastB = msg.blocks[msg.blocks.length - 1];
      if (lastB && lastB.type === 'text' && !(lastB.content || '').trim()) {
        msg.blocks.pop();
      }

      msg.toolCalls.push(toolCall);
      // 向 blocks 末尾追加 tool_call 锚点块
      if (!msg.blocks.some((b) => b.type === 'tool_call' && b.id === toolCall.id)) {
        msg.blocks.push({
          type: 'tool_call' as const,
          id: toolCall.id,
          startTime: toolCall.startedAt || Date.now(),
          durationMs: toolCall.durationMs || 0,
        });
      }
      rebindSessionById(state, sessionId, hit.session);
    })
  ```

### 4. 流式生命周期编排与快照闭环

在 `apps/crish-desktop/src/hooks/chat-stream/` 中，流式事件的派发顺序严密配合：
1. **工具派发前强制落盘正文与思考快照**（`streamCallbacksInternals.ts:213-234`）：
   在工具启动派发（`upsertToolCall`）前：
   - 若有正在进行的思考，立即触发 `updateMessageThinking` 写入 Store；
   - 立即调用 `snapshotStreamTextToSession(sid, assistantMsgId, readStreamedFullText())` 将此前缓冲区中的全部正文提交至 `msg.text`；
   - 随后触发 `addMessageToolCall`，此时 `msg.streamTextOffset = msg.text.length` 准确截断前序正文！
2. **流式收口终态归一**（`streamRunCompletion.ts:134-175`）：
   在流结束时，`finalizeAssistantMessageText` 统一调用 `stripThoughtPlaceholders` 清洗占位，并触发 `updateMessageTimeline` 执行整轮时间线的重水合与归一化。

---

## 五、核心问题：多段正文与工具交错时的数据结构完备性与缺陷诊断

**核心问题结论先行**：  
当前的数据结构在**“严格交替且由工具调用作为分隔符”**的标准流式运行期间，能够在 `blocks` 数组中维持物理交错顺序；  
**但是**，在包含**多段正文**、**思考链插队**、**重水合（Hydration）**以及**时间线归一化（Normalize）**的复杂真实场景下，**存在 5 个致命的架构缺陷与时序断裂点**，导致数据结构无法真正完整、健壮地保留多段交错顺序。

### 缺陷 1：缺少工具调用时的正文切分失效（正文被错误合并）

- **现象**：当 AI 生成流程为：$\text{正文 1} \to \text{思考 1} \to \text{正文 2}$（即两段正文之间只有思考链，没有调用工具）。
- **根因代码**：
  1. `msg.streamTextOffset` **仅在 `addMessageToolCall` 时被重置**（`sessionMessageActionsTools.ts:91`），在 `updateMessageThinking` 中**根本没有更新 `streamTextOffset`**；
  2. 在 `updateMessageText`（`sessionMessageActionsCore.ts:223-232`）中：
     ```typescript
     const lastToolIdx = msg.blocks.map((b) => b.type).lastIndexOf('tool_call');
     let targetTextIdx = -1;
     for (let i = msg.blocks.length - 1; i >= 0; i--) {
       if (msg.blocks[i]?.type === 'text') {
         if (lastToolIdx === -1 || i > lastToolIdx) {
           targetTextIdx = i; // 依然命中了思考 1 前面的那个正文 1 块！
         }
         break;
       }
     }
     ```
  3. 因为 `i > lastToolIdx` 成立（正文 1 本就在最后工具之后），导致倒序寻找到的 `targetTextIdx` 直接是**思考 1 之前的正文 1 块**；
  4. 最终 `target.content = segment` 把正文 2 与正文 1 全部混写进同一个正文块中，原本插入在中间的 `thought` 块变成了排在正文之后的孤立思考，物理顺序彻底错乱。

### 缺陷 2：三元槽位合并算法（Reconciler）直接吞并多段正文

- **现象**：一旦在流式收口或状态更新时触发 `updateMessageTimeline`，原本已存在的多个 `text` 块会被覆盖只剩一个，甚至内容被篡改。
- **根因代码**：
  1. 在 `timelineReconciler.ts:85-124` `reconcileAssistantMessageBlocks` 中：
     槽位 Key 构造为：`${cleanTurn}:${b.type}:${b.id ?? ''}`；
  2. 在 `updateMessageText`（`sessionMessageActionsCore.ts:242`）新增 text 块时：
     `msg.blocks.push({ type: 'text', content: segment, startTime: now, durationMs: 0 })`；
     **text 块既没有 `id`，也没有设置 `turnIndex`**！
  3. `sanitizeTimelineTurnIndex(undefined)` 得到 `0`，因此：
     - 正文块 1 的槽位 Key：`"0:text:"`；
     - 正文块 2 的槽位 Key：`"0:text:"`；
     - 总结正文块 3 的槽位 Key：`"0:text:"`！
  4. 在 `existingMap.set(key, b)` 注册时，**后续的正文块直接无情覆盖前面的正文块**；
  5. 随后的 `incomingBlocks` 匹配时，只有一个正文块能匹配，其他正文块因 `existingMap.delete(key)` 成为失踪块或产生内容错位。这是目前多段正文最严重的静默数据破坏点！

### 缺陷 3：缺失工具补齐（`alignToolCallBlocks`）启发式定位盲目

- **现象**：当工具在 blocks 中偶发丢失（如重水合、历史消息迁移、乱序事件），`alignToolCallBlocks` 会试图补齐工具块。
- **根因代码**：`timelineReconciler.ts:45-56`：
  ```typescript
  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.type === 'text') {
      insertAt = i;
      break;
    }
  }
  return [...next.slice(0, insertAt), ...inject, ...next.slice(insertAt)];
  ```
  算法盲目假设“所有工具必然发生于最后一个正文块之前”。如果助手消息已经产生了“正文 1 -> 工具 2 -> 正文 2”，且工具 2 在 blocks 中需要补齐，算法会把它插到最后一个正文块（正文 2）之前，这看似巧合满足，但若是工具 1 丢失，工具 1 也会被插到正文 2 之前，直接导致工具 1 跑到正文 1 的后面，彻底颠倒时序。

### 缺陷 4：无 blocks 历史消息降级分支丧失交错性

- **现象**：对于历史无 `blocks` 的归档会话或老版本消息，`buildAssistantTimeline` 走降级分支（`timelineNormalizer.ts:224-238`）。
- **根因代码**：写死了固定拼装顺序：
  `injections -> fallbackTurns (thoughts) -> tools -> text`；
  所有工具被打包扔进一个 `tools-0`，所有正文作为末尾一段输出，原本运行中可能存在的交错全貌完全不可逆丢失。

### 缺陷 5：UI 视图层缺乏分段实体，仅依靠全局布尔值全局折叠

- **现象**：在当前 `MessageContent.tsx:310-386` 中：
  1. 仅维护一个全局状态：`const [isProcessExpanded, setIsProcessExpanded] = useState(true)`；
  2. 折叠逻辑为：`if (!isProcessExpanded && (item.kind === 'tools' || item.kind === 'thought')) return null;`（行 352-354）；
  3. 这种做法是将所有的思考和工具暴力清空，完全无法做到：
     - **过程段 1** 折叠收拢在 **正文段 1** 上方；
     - **过程段 2** 折叠收拢在 **正文段 2** 上方；
     - **最终过程段** 折叠收拢在 **总结正文** 上方。
  4. 视图层根本没有“段（Segment）”的概念，只有扁平打平的一维列表！

---

## 六、分段契约（TimelineSegment）物理切分架构设计

为了从根本上解决上述缺陷，实现真正高品质的交错过程折叠，必须确立**以正文作为天然物理界标（Physical Milestone / Delimiter）**的分段契约。

### 1. 为什么以“正文（Text）”作为物理界标？

在语义和认知模型上：
- **过程（Process）**：包括模型的内部反思（Thought）、系统的规则与上下文注入（Injection）、以及与环境的交互动作（Tool Calls）。过程通常具有**高噪音、临时性、可折叠**的特征；
- **正文（Text）**：是模型对用户输出的有效人类可读信息（无论是阶段性的进度解释，还是最终的总结结论）。正文具有**高信息密度、一等呈现、通常不可折叠**的特征。

因此，**正文是对话流天然的里程碑（Milestone）**。任何出现在正文之前的思考与工具，都是为该正文服务的执行过程；出现在正文之后、下一个正文之前的思考与工具，则是下一阶段的执行过程。

```
[原始扁平时间线 (AssistantTimelineItem[])]
   ├── thought-0       ──┐
   ├── injection-0       ├─► 【过程段 0 (Process Segment 0)】 ──► 可折叠胶囊 0 (已思考 12s · 运行 2 工具 ⌄)
   ├── tools-0 (t1, t2)──┘
   ├── text-0          ────► 【正文段 0 (Text Segment 0)】    ──► 常驻平铺展示 (阶段解释正文)
   ├── thought-1       ──┐
   ├── tools-1 (t3)    ──┼─► 【过程段 1 (Process Segment 1)】 ──► 可折叠胶囊 1 (已思考 5s · 运行 1 工具 ⌄)
   ├── tools-2 (t4)    ──┘
   └── text-1 (Final)  ────► 【正文段 1 (Text Segment 1)】    ──► 常驻平铺展示 (最终总结回答)
```

### 2. `TimelineSegment` 类型契约定义

建议在 `apps/crish-desktop/src/api/tool-presentation/toolPresentationTypes.ts`（或独立契约模块）中建立如下规范：

```typescript
import type {
  TimelineThoughtItem,
  TimelineToolsItem,
  TimelineInjectionItem,
  TimelineTextItem,
} from './toolPresentationTypes';

/** 过程子项联合：思考、工具集合、上下文注入 */
export type ProcessSegmentItem =
  | TimelineThoughtItem
  | TimelineToolsItem
  | TimelineInjectionItem;

/** 过程段聚合度量指标（用于折叠态胶囊展示） */
export interface ProcessSegmentMetrics {
  thoughtCount: number;
  toolCount: number;
  injectionCount: number;
  totalDurationMs: number;
  hasRunning: boolean;
  hasError: boolean;
  isStreaming: boolean;
}

/** 过程段（Process Segment）：正文之前的思考、注入与工具调用集合 */
export interface ProcessTimelineSegment {
  kind: 'process';
  /** 稳定分段唯一标识（如 "seg-process-0", "seg-process-1"） */
  key: string;
  /** 过程段在当前消息中的序号 (0-based) */
  index: number;
  /** 关联的轮次索引 */
  turnIndex?: number;
  /** 该过程段内部包含的所有过程项（保持发生时序） */
  items: ProcessSegmentItem[];
  /** 预聚合统计指标，供折叠 Header 快速渲染（0 计算成本） */
  metrics: ProcessSegmentMetrics;
  /** 是否处于运行/流式活跃态（若为活跃态，UI 默认展开） */
  isActive: boolean;
}

/** 正文段（Text Segment）：人类可见回复段落（物理界标） */
export interface TextTimelineSegment {
  kind: 'text';
  /** 稳定分段唯一标识（如 "seg-text-0", "seg-text-1"） */
  key: string;
  /** 正文段在当前消息中的序号 (0-based) */
  index: number;
  /** 关联的轮次索引 */
  turnIndex?: number;
  /** 正文 Markdown 文本内容 */
  content: string;
  /** 是否处于打字机流式输出中 */
  isStreaming?: boolean;
  /** 是否为消息最终收口正文 */
  isFinal?: boolean;
  /** 起始时间戳与耗时 */
  startTime?: number;
  durationMs?: number;
}

/** 统一分段契约（TimelineSegment） */
export type TimelineSegment = ProcessTimelineSegment | TextTimelineSegment;
```

### 3. 物理分段切分算法（Partition Algorithm）

切分算法是一个纯函数，接收 `AssistantTimelineItem[]`，以 `kind === 'text'` 作为界标进行无损流式划分：

```typescript
/**
 * 将线性时间线列表按正文（Text）界标物理切分为交错的 TimelineSegment
 */
export function partitionTimelineSegments(
  items: AssistantTimelineItem[],
  options?: { isMsgProcessing?: boolean }
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let currentProcessItems: ProcessSegmentItem[] = [];
  let processIndex = 0;
  let textIndex = 0;

  const flushProcess = () => {
    if (currentProcessItems.length === 0) return;
    
    // 计算过程段度量
    let totalDurationMs = 0;
    let thoughtCount = 0;
    let toolCount = 0;
    let injectionCount = 0;
    let hasRunning = false;
    let hasError = false;
    let isStreaming = false;

    for (const item of currentProcessItems) {
      totalDurationMs += item.durationMs || 0;
      if (item.kind === 'thought') {
        thoughtCount++;
        if (item.isStreaming) isStreaming = true;
      } else if (item.kind === 'tools') {
        for (const tr of item.items) {
          if (tr.kind === 'single') {
            toolCount++;
            if (tr.tc.status === 'running') hasRunning = true;
            if (tr.tc.status === 'error') hasError = true;
          } else if (tr.kind === 'group') {
            toolCount += tr.tools.length;
            if (tr.tools.some((t) => t.status === 'running')) hasRunning = true;
            if (tr.tools.some((t) => t.status === 'error')) hasError = true;
          }
        }
      } else if (item.kind === 'injection') {
        injectionCount++;
      }
    }

    segments.push({
      kind: 'process',
      key: `seg-process-${processIndex}`,
      index: processIndex++,
      items: [...currentProcessItems],
      metrics: {
        thoughtCount,
        toolCount,
        injectionCount,
        totalDurationMs,
        hasRunning,
        hasError,
        isStreaming,
      },
      isActive: hasRunning || isStreaming,
    });
    currentProcessItems = [];
  };

  for (const item of items) {
    if (item.kind === 'text') {
      // 遇到正文界标，先收口前序过程段
      flushProcess();
      // 推入正文段
      segments.push({
        kind: 'text',
        key: `seg-text-${textIndex}`,
        index: textIndex++,
        turnIndex: item.turnIndex,
        content: item.content,
        isFinal: item.isFinal,
        startTime: item.startTime,
        durationMs: item.durationMs,
      });
    } else {
      // thought / tools / injection 属于过程段项
      currentProcessItems.push(item);
    }
  }

  // 收口末尾残留的过程段（如模型末尾仍在调用工具或思考，尚未产出总结正文）
  flushProcess();

  return segments;
}
```

### 4. 架构配套改造关键点

为了让上述分段契约在 Store 状态机中完美运转，必须落地以下底层配套加固：
1. **给 `MessageTimelineBlock` 中的 `text` 块赋予显式身份**：
   - 在 `sessionMessageActionsCore.ts` `updateMessageText` 中，为创建的 text 块添加 `id: 'text-turn-${cleanTurn}'` 或 UUID，并明确写入 `turnIndex: cleanTurn`；
2. **在 `updateMessageThinking` 时刷新 `streamTextOffset`**：
   - 当检测到有非空新轮次思考产生时，同步将 `streamTextOffset` 推进至当前 `msg.text.length`，确保思考后的新正文能够被正确识别为新的正文段；
3. **改造 `reconcileAssistantMessageBlocks` 槽位算法**：
   - 槽位 Key 从 `${cleanTurn}:${type}:${id}` 升级为支持多正文槽位索引（例如基于分段序号或携带唯一 id），避免同一轮次多个正文块在 Map 中碰撞被覆盖。

---

## 七、用户中途插入消息（Interruption / Steering）存储与调度全链路

战役核心效果锁第 3 条明确要求：
> “若 AI 在工作过程中用户发送消息，必须根据用户插入节点将 AI 输出内容分开折叠组织，严禁将用户消息折叠进 AI 的过程块中。”

我们对前端处理用户在 AI 运行中途发送消息的代码链路进行了端到端穿透审计：

### 1. 并发忙碌判定与 Follow-Up 裁决

- **代码坐标**：`apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:160-168`
- **链路细节**：
  ```typescript
  const hasLiveStream = streamManagerRef.current?.hasStream(sessionId) ?? false;
  settleStaleSessionProcessingMessages(sessionId, hasLiveStream);

  const isAiBusy = checkSessionAiBusy(hasLiveStream, sessionId);
  const isFollowUp = decideSendWhileRunning(isAiBusy) === 'follow_up';
  const liveHandle = streamManagerRef.current?.get(sessionId);
  ```
  - 当前端 `streamManager` 中存在活跃流（`hasLiveStream === true`）或会话中存在未完成的助手消息时，`checkSessionAiBusy` 返回 `true`；
  - `decideSendWhileRunning(true)` 确定执行策略为 `'follow_up'`（追问/插话），而不是中断当前流或忽略用户输入。

### 2. 用户插入消息物理落盘：`enqueueFollowUpMessage`

- **代码坐标**：`apps/crish-desktop/src/hooks/chat-stream/slashSendQueueHelper.ts:123-161`
- **执行过程**：
  1. 调用 `flushContextStateBeforeSend(sessionId)` 将可能的状态切换卡片挂载；
  2. 调用 Store 的 `addMessage`：
     ```typescript
     addMessage(wsId, sessionId, {
       id: userMsgId,
       sender: 'user',
       text: displayText,
       timestamp: Date.now(),
       status: 'queued', // 关键：标记为 queued 状态！
       ...(images?.length ? { images } : {}),
       ...(attachments?.length ? { attachments } : {}),
     });
     ```
  3. 异步通过 IPC 通知 Rust 内核正在运行的 Agent 引擎（行 146-152）：
     ```typescript
     void getCompositionRoot().runControl.followUp({
       runId: liveHandleRunId ?? null,
       sessionId,
       text: displayText,
       clientMessageId: userMsgId,
       reason: reason || 'ui-send-while-running',
     });
     ```

### 3. 会话消息列表中的排序保全（Canonical Order SSOT）

- **代码坐标**：`apps/crish-desktop/src/store/messageOrderKey.ts` 与 `sessionSharedHelpers.messageMerge.ts:336-360`
- **插入与排序原理**：
  - `upsertMessageById` 使用 `findInsertIndex` 二分查找插入点；
  - 排序键优先级（`compareMessageOrder`）：
    $$\text{engineSequence (seq)} \to \text{timestamp (ts)} \to \text{id (tiebreak)}$$
  - 正在运行的助手消息（`assistantMsg`）在启动时分配的时间戳是其开始时间（`startTime`）；
  - 用户中途插入的消息其时间戳为当前时间 `Date.now()`（严格大于助手消息的 `startTime`）；
  - 因此，在 `session.messages` 数组中，这条新 `user` 消息会**精确地排在当前正在流式的助手消息之后**！

```
[会话消息物理数组 (session.messages)]
┌────────────────────────────────────────────────────────┐
│ Index i:   User Message (Initial)                      │
├────────────────────────────────────────────────────────┤
│ Index i+1: Assistant Message (status: 'processing')    │
│            ├── blocks: [thought0, tools0, text0, ...]  │
│            └── text: "..."                             │
├────────────────────────────────────────────────────────┤
│ Index i+2: User Message (Midway Interruption / Followup│
│            ├── sender: 'user'                          │
│            ├── status: 'queued'                        │
│            └── text: "等等，请改用方案 B 实现"         │
└────────────────────────────────────────────────────────┘
```

### 4. 为什么绝对不会将用户消息折叠进 AI 的过程块中？

从数据模型层与组件渲染层来看：
1. **模型层物理独立**：用户插入的消息是 `session.messages` 列表中的**独立项（`SessionMessage`，`sender: 'user'`）**，它拥有自己独立的 `id`，**绝不是**助手消息内部 `blocks` 的一部分；
2. **渲染树层次隔离**：
   - 聊天主界面 `useChatMessages` 遍历 `session.messages`；
   - 助手消息由 `MessageContent.tsx` 渲染；
   - 用户消息由 `UserMessageItem`（或用户消息卡片）独立渲染；
   - 助手消息内部的折叠状态机（`isProcessExpanded` 或新的 `TimelineSegment`）作用域仅局限于助手消息 DOM 容器内部，在 DOM 树和虚拟滚动列表中与用户消息卡片是平级的兄弟节点（Sibling Nodes）；
3. **中途插入对后续 AI 轮次的划分**：
   当用户在 AI 运行中途插入该消息后，引擎在处理完当前断点或结束当前 Run 之后，该 `queued` 消息将作为下一轮交互的输入，催生出一个**全新的 Assistant 消息实体**（拥有全新的 `assistantMsgId`）。因此，用户消息天然位于两段 AI 回复之间，结构上坚不可摧！

---

## 八、总结与对下一阶段方案设计的输入建议

通过本次全面深入的代码调研，我们得出以下结论与技术输入建议：

| 调研维度 | 当前现状事实 | 核心瓶颈 / 缺陷 | 方案设计阶段必须落地的改造建议 |
| :--- | :--- | :--- | :--- |
| **数据模型 (`types.ts`)** | `SessionMessage.blocks` 支持多类型块，但 `text` 块未被当作一等界标管理 | `text` 块缺稳定 id 和显式 turnIndex；缺少过程段聚合实体 | 确立 `TimelineSegment`（`ProcessTimelineSegment` 与 `TextTimelineSegment`）派生契约 |
| **流式维护 (`ActionsCore/Tools`)** | `streamTextOffset` 仅在 `addMessageToolCall` 更新 | 无工具调用的思考+多正文场景切分失效，正文被合并不分段 | 在 `updateMessageThinking` 时同步刷新 `streamTextOffset`；给新建 `text` 块分配标识 |
| **时间线重水合 (`Reconciler`)** | 依靠 `${cleanTurn}:${type}:${id}` 槽位 Map 合并 | 多个 `text` 块由于 id 为空且 turnIndex 均为 0 发生 Key 碰撞覆盖 | 升级三元槽位合并算法，针对 `text` 块支持多段槽位保全，禁止同轮多正文覆盖 |
| **投影与渲染 (`Normalizer/UI`)** | `MessageContent.tsx` 全局单布尔值 `isProcessExpanded` 暴力过滤 | 无法实现各过程段独立折叠；正文无法作为物理界标分别锚定 | 引入 `partitionTimelineSegments`，实现“过程段折叠胶囊 + 正文段平铺常驻”的独立自治组件 |
| **用户中途插入消息** | `status: 'queued'` 入库，按序插入消息数组 | 当前逻辑在消息级隔离良好，但缺少对“前一段已截断助手消息”的终态收口标记 | 在下一阶段明确当用户 Steering 时，前序流式助手消息如何优雅终态收口并默认折叠 |

本调研报告已完整厘清时间线、数据模型、流式更新与用户插入节点的所有技术事实，所有引用均有精确的代码行号支撑，为第二波多维度独立方案设计团队提供了坚实的事实底座。
