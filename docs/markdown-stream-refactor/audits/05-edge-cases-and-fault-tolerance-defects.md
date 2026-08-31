# 挑刺审查报告 05：边缘交互与异常容错缺陷深度审查

> **审查范围**：`MessageContent.tsx`、`ChatAssistantMessageRow.tsx`、`useStreamingBlocks.ts`、`parseMarkdownIntoBlocks.ts`、`streamSession.ts`、`streamFinishControl.ts`、`EventRouter.ts`、`streamCallbacksEvents.ts`、`useStreamCallbacks.ts` 等核心交互与容错模块。  
> **审查原则**：严格只挑刺、只记录缺陷与隐患，严禁套话、总结与夸奖。

---

## 1. 异常状态与错误提示横幅吞噬缺陷 (P0 致命缺陷)

### 1.1 思考后正文首帧报错，错误提示横幅被 100% 彻底吞噬
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:282-311, 330-372` 与 `TimelineBody.tsx:57-151`
- **缺陷根因**：
  错误提示横幅卡片渲染逻辑（`msg.status === 'error'`）被硬编码置于 `if (!timeline.length)` 降级分支内部。当模型输出了思考链 `<think>...</think>` 时，时间线通过 `buildAssistantTimelineCached` 成功解析并构建出至少 1 个 `thought` 项（`timeline.length >= 1`）。若紧接着在正文输出第一帧时遇到后端 500/502、网络连接重置或模型提供商流式报错，消息状态被置为 `msg.status = 'error'`，但由于 `!timeline.length` 条件为 `false`，代码直接跳过错误卡片分支，转而进入主渲染流程 `TimelineBody`（lines 330-372）。而在 `TimelineBody` 内部，仅处理了 `item.kind === 'thought' | 'text' | 'tools'`，完全没有任何针对 `msg.status === 'error'` 的渲染兜底。
- **后果**：
  错误横幅与错误详情（`msg.errorDetail?.message`）被 **100% 完全吞噬**。用户界面上只显示已经渲染完成的思考折叠框，下方正文区域完全空白死寂，用户无法获得任何错误提示或重试指引。

### 1.2 错误分发阶段纯思考消息（无 text）被强行物理删除
- **缺陷位置**：`apps/crish-desktop/src/hooks/chat-stream/streamCallbacksEvents.ts:274-277, 298-307`
- **缺陷根因**：
  在 `handleRunError` 中，判断消息是否已产生内容的逻辑为：
  ```typescript
  const hadText = !!(
    (asstErr?.text || '').trim() || getStreamText(sid, assistantMsgId)?.trim()
  );
  ```
  该判定仅排查纯文本 `text`，完全忽略了 `asstErr.blocks` 中的 `thought` 块、`thinkingTurns` 以及 `thinking` 字段。当思考模型输出了长篇深度推理（如 5000 字的思考链），但在正文首帧建立前网络发生中断时，`hadText` 判定为 `false`，代码直接执行：
  ```typescript
  st.withdrawMessage(wsId, sid, assistantMsgId);
  clearStream(sid, assistantMsgId);
  ```
- **后果**：
  整条助手消息（连同模型已产出的全部思考过程与分析记录）被从 Session 中 **彻底物理删除抹去**，用户眼睁睁看着正在生成的思考内容突然瞬间消失蒸发，且关联的 User 消息永久停留在异常或孤立状态。

---

## 2. 超长长文（50k+ tokens）流式性能与 CPU 满载瓶颈

### 2.1 每帧全量 marked Lexer 词法扫描引发主线程 100% 满载卡死
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:42-49` 与 `apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:220`
- **缺陷根因**：
  在流式传输过程中，每个到达的文本增量 chunk（每秒可达 30~60 帧）均触发 `useStreamingBlocks` 的 `useMemo` 计算。在该计算中，无条件执行 `parseMarkdownIntoBlocks(fullText)`，进而调用 `Lexer.lex(fullText, { gfm: true })`。
  当文本累积到 50k+ tokens（约 150,000 ~ 200,000 字符）时长文生成进入后半程，`Lexer.lex` 必须在每一帧从第 0 个字符开始对累积的几十万字符进行全量正则与词法扫描（匹配 Heading、Table、Blockquote、List、HTML、Code Fence 等数十种规则），单次同步耗时高达 20ms~60ms。
- **后果**：
  主线程事件循环彻底被密集的 Lexer 词法扫描打满，CPU 长期处于 100% 占用状态。浏览器渲染帧率（FPS）从 60 暴跌至个位数甚至完全冻结（UI Freeze），造成输入框打字卡顿、滚动条掉帧、取消按钮无响应。

### 2.2 缺乏滑动尾窗与增量词法扫描机制
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/useStreamingBlocks.ts:59-87`
- **缺陷根因**：
  虽然设计了 `sealedCacheRef` 用于复用 React 虚拟节点对象，但分块算法本身是无状态的无界全量计算。分块输入未基于已封口块的字节偏移量进行切片截断，整个流式生命周期的时间复杂度退化为 $O(N^2)$（$N$ 为流式增量帧数）。在长文本生成中，前序已经稳定的数百个段落和代码块在每一帧都被反复重复分词。

---

## 3. 空回复（Empty Run）与异常布局缺陷

### 3.1 空回复产生底部悬空操作栏的怪异残缺布局
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:312-314` 与 `apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx:116-160`
- **缺陷根因**：
  当 LLM 响应 0 字符且以 completed 状态正常结束（如模型触发内容过滤拒答、服务商返回空 delta、或 prompt 异常），`msg.status === 'completed'` 且 `msg.text === ''`。
  在 `MessageContent.tsx` 中：
  ```typescript
  if (!fallback.trim()) {
    return null;
  }
  ```
  `MessageContent` 直接返回 `null`，导致 `.assistantBody` 容器高度坍塌为 0。但在 `ChatAssistantMessageRow.tsx` 中，`!isLive`（`!isThinkingMsg && msg.status !== 'processing'`）为 `true`，无条件渲染 `<MessageActions />`。
- **后果**：
  界面中呈现出一个完全没有任何正文内容的“幽灵消息卡片”，底部悬空漂浮着「复制、重新生成、置顶、发送到笔记、时间戳」一行操作图标。

### 3.2 空气泡内操作按钮盲目响应引发误导性 Toast 与脏数据
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx:89-93` 与 `apps/crish-desktop/src/components/chat-message/MessageActions.tsx:73-85`
- **缺陷根因**：
  悬浮的动作栏未做空文本禁用防护。用户点击「复制」时触发 `assistantCopyText(msg)` 判空，弹出「没有可复制的正文」报错 Toast；用户点击「发送到笔记」时，将空字符串 `""` 写入笔记存储，污染用户知识库。

---

## 4. 词法分块语法误伤与奇偶校验死锁缺陷

### 4.1 行内代码包含 `$$` 误伤奇偶校验导致整篇长文永久合并死锁
- **缺陷位置**：`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:114-125, 276-289`
- **缺陷根因**：
  `countDoubleDollars` 采用简单的字符串逐字符扫描，未排除行内代码（codespan，如 `` `$$` `` 或 `` `echo $$` ``）：
  ```typescript
  export function countDoubleDollars(str: string): number {
    let count = 0;
    for (let i = 0; i < str.length - 1; i += 1) {
      if (str[i] === '$' && str[i + 1] === '$') {
        count += 1;
        i += 1;
      }
    }
    return count;
  }
  ```
  当段落中包含行内代码如“在 Bash 中使用 `` `$$` `` 获取当前 PID”时，Marked 分词产出的 token 类型为 `paragraph` 而非 `code`（`previousTokenWasCode` 为 `false`）。
  `countDoubleDollars(previousBlock)` 统计出奇数（1 次），触发数学公式块未闭合判定（`prevDollarCount % 2 === 1`）。这导致当前块后面的下一个块被强制合并进当前块；合并后由于 `$$` 数量依然为奇数，后续所有段落、列表、代码块均被无限递归合并进该块中。
- **后果**：
  一旦文档前部出现一次行内 `` `$$` ``，后续整篇文档的所有语法块被 **100% 永久合并为单个巨型未封口块**，渐进流式分块渲染机制彻底瘫痪，全篇退化为无语法高亮、无块级锁定的纯文本打字机模式。

### 4.2 反斜杠转义 `\$$` 依然被计入数学公式
- **缺陷位置**：`apps/crish-desktop/src/api/markdown/parseMarkdownIntoBlocks.ts:118-123`
- **缺陷根因**：
  `countDoubleDollars` 没有跳过反斜杠转义字符（`\$$`）。在 Markdown 中字面量转义的 `\$$` 依然使计数加 1，同样会导致奇偶校验翻转并引发整篇长文的错误合并。

---

## 5. 中止（Cancel / Stop）与异常恢复时序闭环缺陷

### 5.1 强制取消/中止时 `EventRouter` 因果时序缓冲（`pendingToolEnds`）被永久遗弃
- **缺陷位置**：`apps/crish-desktop/src/api/chat-bridge/streamFinishControl.ts:77-98` 与 `apps/crish-desktop/src/api/chat-bridge/EventRouter.ts:128-147, 151`
- **缺陷根因**：
  当用户点击停止或强制取消时，`createStreamCancel` 直接执行 `cleanup()`（解绑 transport 监听）并将 `state.cancelled = true`，但从未调用 `EventRouter.flushPendingCausalBuffers('abort')`。
  在 `EventRouter` 中，`flushPendingCausalBuffers` 仅在接收到 `run-terminal` 或 `agent-end` 事件时触发（line 209）。如果在中止前由于 IPC 乱序抖动导致 `tool-end` 先于 `tool-start` 到达并暂存在 `pendingToolEnds` 中，该缓冲区随 Router 实例销毁被永久遗弃。
- **后果**：
  未配对的工具调用无法完成终态收口，导致 UI 上的工具卡片永久停留在加载中动画（`running`）状态，造成界面状态死锁。

### 5.2 停止生成时状态统一被置为 `'completed'` 导致中断语义丢失
- **缺陷位置**：`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:134-135`
- **缺陷根因**：
  在 `finalizeStopGeneration` 中，无论用户执行的是协作停止（L2 cooperative stop）还是强制取消（L3 force cancel），代码无条件调用：
  ```typescript
  st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
  st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
  ```
- **后果**：
  强行将主动中断的消息状态覆盖为 `completed` 而非 `stopped` / `cancelled`。系统丢失了用户主动中断与模型正常输出完毕的状态区分，导致重试逻辑、对话历史导出与 Token 统计无法准确识别中断边界。

### 5.3 思考中停止未清除 `thinking` 占位导致完成态残留「正在处理…」
- **缺陷位置**：`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:121-132`
- **缺陷根因**：
  当用户在思考阶段点击停止时，`stopText` 为空，代码仅清空了正文文本（`st.updateMessageText(sid, cur.assistantMsgId, '')`）并清理流式缓冲，但遗漏了对 `asst.thinking` 字段的清理（仍残留 `'正在处理…'` 或 `'正在思考中...'`）。
- **后果**：
  消息转入 `completed` 终态后，气泡依然挂载着一个处于非活跃但内容为「正在处理…」的思考中卡片。

---

## 6. DOM 垫片与并发渲染缺陷

### 6.1 `MarkdownBlockItem` 失败回退时直接操作 DOM 与 React VDOM 产生双节点冲突
- **缺陷位置**：`apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx:71-86, 93-96, 126-130`
- **缺陷根因**：
  在异步渲染过渡期，`MarkdownBlockItem` 通过 `el.textContent = text` 绕过 React 运行时直接在 DOM 容器上设置纯文本。当 Rust Markdown 编译失败（`failed === true`）时，`useEffect` 中仅执行了 `el.removeAttribute('data-has-html')`，并未清空 `el.textContent`。紧接着 React JSX 渲染了回退节点：
  ```tsx
  {failed && !html ? (
    <pre className={`${styles.mdTextFallback} md-text-fallback`}>
      {text}
    </pre>
  ) : null}
  ```
- **后果**：
  容器内同时存在直接写入的原生 text 文本节点和 React 插入的 `<pre>` 元素节点，导致渲染失败时页面出现 **双份文本重叠与排版错乱**。
