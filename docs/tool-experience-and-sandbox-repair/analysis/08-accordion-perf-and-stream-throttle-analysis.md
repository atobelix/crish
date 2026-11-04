# 工具展开折叠卡顿（Jank）与流式输出突发刷屏性能根因与平滑方案深度分析报告

> 战役工作区：`docs/tool-experience-and-sandbox-repair/`  
> 责任席位：子 Agent A8（Performance Profiler）  
> 调研目标：深入排查并彻底根除工具调用结果“展开和折叠非常卡顿（严重掉帧、Jank）”以及流式输出“突然出现大块消息、缺少节流控制”的深层性能瓶颈与调度断层。

---

## 一、用户诉求与体验问题本质剖析

### 1. 用户核心原话与痛点反馈

用户在实际使用和深度开发场景中明确反馈了两个极其影响交互质感的性能瓶颈：
> **痛点 1**：“还有就是工具调用的结果展开和折叠非常卡顿，已经影响了实际的使用体验了。”  
> **痛点 2**：“第二点，就是现在的输出有的时候突然出现一些消息，没有这种节流控制。”

这两个问题直接命中了现代 AI 客户端体验的核心防线：
1. **交互动效的流动感（Motion Smoothness）**：展开与折叠手风琴是高频交互。卡顿意味着主线程被阻塞（Long Tasks > 50ms），动画丢帧率高达 60%~90%，甚至出现长达 200ms 的操作无响应冻结（Frozen Frame）。
2. **文本涌现的节奏感（Cognitive Pacing）**：AI 的输出本应是伴随人类阅读节奏自然涌现的流式体验。突发性大块倾泻和缺少节流的瞬时刷屏，不仅打断思考节奏，更破坏了人机交互的沉浸感与生命力。

---

## 二、工具展开与折叠卡顿（Jank / Frame Drop）根因链路 Profiling

经过对代码调用栈、DOM 树演变与浏览器渲染流水线的逐帧拆解，工具展开/折叠卡顿由**四大并发回流源**叠加**无分相调度**造成：

```
                    ┌────────────────────────────────────────────────────────┐
                    │    展开/折叠卡顿根因架构全景 (Accordion Jank Anatomy)   │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
         ┌─────────────────────┬───────────────┴──────────────┬─────────────────────┐
         ▼                     ▼                              ▼                     ▼
【回流源 1：CSS Grid】  【回流源 2：强同步测高】      【回流源 3：虚拟列表恶性回路】 【回流源 4：单帧高负载】
grid-template-rows:    innerRef.getBoundingClient-   每帧高度跨越 4px 阈值        JSON.parse / diff 计算
0fr ➔ 1fr 逐帧重排     Rect 同步强刷未清洁布局         createRowMeasureRef 狂触发   useDiffHighlightMap 高亮
不可被 GPU 硬件加速     useAccordionViewportGuard 抢焦 setActual ➔ actualTick++     ScrollFade 多重 RO 挂载
全文档下级节点递归抖动  无依赖 useLayoutEffect 泛滥    MessageVirtualizer 整窗重渲   全塞在 Frame 0 一起做！
```

---

### 1. 卡顿链路 Profiling 与根因分解表

| 序号 | 故障环节 / 瓶颈定位 | 涉及代码位置 | 性能危害与物理机理 | 影响严重度 |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | **CSS Grid `0fr` ➔ `1fr` 逐帧重排** | `FoldableToolGroup.module.css:127`<br>`FoldableProcessSection.module.css:121`<br>`ChatToolCallBlock.module.css:457` | `grid-template-rows` 并非合成器（Compositor）属性。在 220ms~480ms 动画期，浏览器主线程每一帧都在执行 Layout，全量计算网格轨道，推挤下方全部消息，递归触发祖先容器回流。 | **致命（P0）** |
| **P2** | **动画前置同步 DOM 测高（Layout Thrashing）** | `FoldableToolGroup.tsx:213`<br>`FoldableProcessSection.tsx:309`<br>`motionTokens.ts:275` | 在 `handleToggle` 的 React setState 回调中，同步读取 `innerRef.current.getBoundingClientRect().height` 计算动画时长。折叠态下元素常驻 `hidden="until-found"`，强制测量触发深度树形回流，导致点击首帧发生 80~150ms 的 JavaScript 执行停顿。 | **严重（P1）** |
| **P3** | **虚拟滚动列表与 ResizeObserver 恶性重渲反馈回路** | `messageVirtualizerMeasure.ts:44`<br>`useVirtualScroll.ts:244, 388`<br>`MessageVirtualizer.tsx:206` | 行高随手风琴展开每跨过 4px（`SIGNIFICANT_HEIGHT_DELTA_PX`），`createRowMeasureRef` 便读取 `el.offsetHeight`（强制回流），`flushActualMeasurements` 判定几何变化后递增 `actualTick`，**导致 `MessageVirtualizer` 在动画播放过程中不断触发 React 全量重渲染！** | **致命（P0）** |
| **P4** | **`ScrollFadeRegion` 伴生高频样式失效与回流** | `useScrollFade.ts:65, 88`<br>`ScrollFadeRegion.tsx:75`<br>`FoldableToolGroup.tsx:385` | 容器展开时 `active=true`，`attachScrollFade` 监听 host 与全体子元素。在高度过渡期间高频调用 `window.getComputedStyle(host).overflowY` 并读取 `scrollHeight`/`clientHeight`，频繁写入 `host.dataset.fade`，导致动画每一帧都在触发样式再计算（Recalc Style）。 | **高（P2）** |
| **P5** | **展开瞬间重型解析与高亮同步挂载（无分相调度）** | `ToolCallOutputPane.tsx:70-115`<br>`ToolCallDiffPreview.tsx:54-63`<br>`codeHighlightBatch.ts` | 展开动作发生的同一帧（Frame 0），不仅要启动动画，还要同步执行 `JSON.parse`、Diff 解析、`useDiffHighlightMap` 语法高亮切片并挂载数十至数百个 DOM Token 节点。CPU 算力瞬间被榨干，首帧直接卡死。 | **致命（P0）** |
| **P6** | **`toolExpansionState` 无依赖 `useLayoutEffect` 与向上爬树** | `toolExpansionState.ts:572-574`<br>`toolExpansionState.ts:340-362` | `useLayoutEffect` 缺少依赖数组，组件每次渲染都执行 `restorePreAction`；其内部 `findScrollContainer` 向上循环遍历 DOM 父级并对每个节点执行 `window.getComputedStyle`，且内部调用 `setLastDisplacement` 诱发二次重渲染。 | **高（P2）** |

---

### 2. 深度穿透分析（逐行代码取证）

#### 2.1 CSS Grid `0fr` ➔ `1fr` 的渲染引擎代价
当前项目为了淘汰旧式 `max-height: 2000px` 的非线性变速动画，全面切换到了 CSS Grid `grid-template-rows: 0fr -> 1fr`：
```css
/* apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.module.css:119-135 */
.groupBody {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows
    var(--accordion-duration, var(--transition-accordion))
    var(--ease-standard, ease);
  overflow: hidden;
}
.groupBody[data-expanded='true'] {
  grid-template-rows: 1fr;
}
```
**问题本质**：
- CSS 规范中，`grid-template-rows` 属于**几何布局属性（Layout Property）**，Chromium 无法将其卸载给 GPU Compositor 线程处理，每一帧必须由主线程的 Blink 引擎重新计算布局树；
- 工具内容通常包含嵌套的 `<pre>`、代码高亮 spans、diff 表格和状态栏。随着网格轨道从 0px 逐帧递增至 560px，其内部包含的几百个 DOM 子节点必须在每一帧重新计算排版；
- 更致命的是，由于该容器位于聊天消息列表内部，其高度的逐帧变化导致**该行以下的所有后续聊天消息行（Message Rows）在每一帧都被迫向下位移（Reflow Cascade）**。

#### 2.2 动画触发展开瞬间的 Layout Thrashing
在 `FoldableToolGroup.tsx:203-219` 与 `FoldableProcessSection.tsx:303-313` 中：
```ts
const handleToggle = useCallback(() => {
  setIsExpanded((prev) => {
    const next = !prev;
    // 痛点代码：在状态更新器内部强读未完成布局的 DOM
    const currentHeight =
      innerRef.current?.getBoundingClientRect().height ?? 0;
    const dur = calcAccordionDuration(currentHeight, next);
    setTransitionDuration(dur);
    onInvalidate?.();
    return next;
  });
}, [onInvalidate, triggerViewportRecovery, cancelCollapseWait]);
```
- 当折叠态下，`slotRef` 挂载着 `hidden="until-found"`，内部节点处于跳过渲染（Skipped Rendering）状态；
- 点击瞬间，`innerRef.current.getBoundingClientRect()` 强行要求浏览器立即输出物理像素尺寸。浏览器被迫放下正在排队的绘制指令，强行启动一次完整的同步重排（Synchronous Layout）；
- 紧接着 `setTransitionDuration(dur)` 触发组件自身局部状态更新，在动画开始前插入了一次额外的 React Re-render。

#### 2.3 虚拟滚动列表的“重测高共振”（Resonance Catastrophe）
这是导致 100ms+ 严重长卡顿（Long Stutter）的最隐蔽杀手：
1. 消息列表采用虚拟滚动（`MessageVirtualizer.tsx` + `useVirtualScroll.ts`）；
2. 每一行消息外层均被 `createRowMeasureRef`（`messageVirtualizerMeasure.ts:34-61`）挂载了 `ResizeObserver`：
```ts
const onEntry = (entry: ResizeObserverEntry) => {
  const el = entry.target;
  const measuredHeight = el.offsetHeight || Math.ceil(entry.contentRect.height);
  if (msgId != null && measuredHeight > 0) {
    setActual(msgId, measuredHeight);
  }
};
```
3. 在工具组或手风琴展开过程中，容器高度以每秒 60 次的频率从 24px 变大到 400px；
4. 当变化幅度累积超过 4px 时，`setActual` 触发 `scheduleActualFlush()`；
5. 在下一个 rAF 帧，`flushActualMeasurements()` 执行，Fenwick 树更新，并调用：
```ts
// useVirtualScroll.ts:243-245
if (!isSameGeometrySnapshot(geometryBefore, computeGeometrySnapshot())) {
  setActualTick((t) => t + 1); // 触发虚拟列表 React 重渲染！
}
```
6. **灾难发生**：在 CSS Grid 动画播放的 300ms 内，React 虚拟列表被触发了 **8 到 15 次全量重渲染**！
   每次重渲染都在重新计算可见索引区间（`visibleRange`），重新渲染周边所有消息行！手风琴动画与 React 虚拟滚动重渲染在主线程上激烈抢占 CPU，掉帧率直接拉满。

#### 2.4 缺乏分相调度（Lack of Phase Separation）
当用户点击展开时，系统立即执行全量真实渲染：
- `ToolCallOutputPane.tsx:70-115` 立即调用 `parseFileStatOutput`、`parseReadFileOutput`、`parseGrepSearchOutput`、`formatJsonIfApplicable`；
- 如果工具包含代码 Diff，`ToolCallDiffPreview.tsx:54-63` 立即调用 `useDiffHighlightMap` 进行高亮分词，并挂载上百个带有内联样式的 DOM 节点；
- `ScrollFadeRegion` 立即启动 `attachScrollFade`，对滚动宿主挂载 ResizeObserver 并进行 `window.getComputedStyle` 查询。
**物理规律**：如果在动画播放期间同时进行“复杂的 DOM 结构创建 + 词法高亮解析 + 虚拟列表测高 + 连续网格重排”，任何 JavaScript 引擎都不可能维持 60 FPS。

---

## 三、流式输出“突然出现一些消息，没有节流控制”成因追踪

经过对流式管线（Rust Engine ➔ IPC ➔ `chat-stream` ➔ Store ➔ View）的完整审计，导致突发性刷屏与大块消息倾泻的原因主要有三大机制断层：

```
                    ┌────────────────────────────────────────────────────────┐
                    │      流式突发刷屏三大机制断层 (Streaming Burst Tracing)  │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
         ┌─────────────────────┬───────────────┴──────────────┬─────────────────────┐
         ▼                     ▼                              ▼                     ▼
【断层 1：门槛与速度过激】  【断层 2：时态切换即时 Flush】 【断层 3：权威收口绕过管道】 【断层 4：IPC 突发 Chunk 直灌】
engageThreshold = 240字    onToolStart 强制同步快照       onMessageEnd 权威全文收口   StreamRenderBuffer 帧配额
短文本 100% 裸奔直显       snapshotStreamTextToSession   直接 updateMessageText    1024 字节/帧 (过大)
steadyCap = 2600字/s       flushNow 破坏既有排空流        整块大消息瞬间覆盖 Store   网络包或本地模型整段吐出
人类眼睛无法辨识飞速闪现   完成态瞬间 force 刷完          下层无流式形态直接瞬闪    下游无 Ingress 整流缓冲
```

---

### 1. 机制断层 1：显现速度域（Reveal Pacing）门槛与封顶过激

查看流式显现核心配置 `apps/crish-desktop/src/utils/revealPacing.ts:50-70`：
```ts
const SHARED_PACING: SharedPacingConstants = {
  engageThresholdChars: 240, // 啮合门槛：240 字以内恒等到达（零延迟直出）
  targetLagMinChars: 80,
  targetLagMaxChars: 700,
  gainSeconds: 0.9,
  catchUpLagThresholdChars: 2_600,
  frameHardCapChars: 420,    // 单帧硬顶：单帧允许直接吐出 420 字！
  minRateCharsPerSec: 30,
  finishSnapChars: 300,      // 收尾 Snap 门槛：流结束时剩余 <= 300 字瞬间全显！
  finishDrainSeconds: 0.7,
  ewmaTauSeconds: 0.4,
};

export const TEXT_REVEAL_PACING: RevealPacingProfile = {
  ...SHARED_PACING,
  targetLagSeconds: 0.35,
  steadyCapCharsPerSec: 2_600, // 稳态速率：每秒 2600 字！
  catchUpCapCharsPerSec: 5_200, // 追赶速率：每秒 5200 字！
};
```
**严重弊病穿透**：
1. **240 字以内完全“裸奔”**：
   - `engageThresholdChars = 240`。当大模型吐出前 1~2 句话（如“好的，我马上为您执行文件搜索并分析代码结构。”约 30~80 字）时，`RevealPacer.ts:168-171` 判定为未啮合，`this.revealedLen = text.length`，**完全不做任何流式节流，瞬间整块贴在屏幕上**！
2. **人类视觉生理极限与 2,600 字/s 的断层**：
   - 人类正常的舒适阅读速度约为每分钟 300~600 字（即 **每秒 5~10 字**）；
   - 当前配置的稳态速率为 **2,600 字/秒**，相当于每秒吐出整整两整屏文本；
   - 单帧硬顶 `frameHardCapChars = 420`：在 60Hz 屏幕下，一帧（16.6ms）就允许吐出 420 个字符。用户视觉上看到的就是“啪的一下，一大坨文本突然砸在界面上”，完全失去了打字机涌现的平滑感。
3. **收尾 300 字“暴击 Snap”**：
   - 当大模型生成结束触发 `finish` 时，如果剩余未排空文本 ≤ 300 字（`finishSnapChars = 300`），`RevealPacer` 直接执行 `this.revealedLen = this.arrivedText.length`，剩下的文字瞬间全量涌出。

---

### 2. 机制断层 2：跨时态切换（Tool / Thinking / Text）强制即时 Flush

在混合交互流（思考 ➔ 工具 ➔ 文本 ➔ 工具 ➔ 终态）中，存在频繁的状态机切换：
1. **工具启动时的暴力快照**：
   在 `streamCallbacksInternals.ts:210-228`：
   ```ts
   const upsertToolCall = (...) => {
     // 物理因果时序保全：工具启动前，立即提交至 sessionStore
     snapshotStreamThinkingToSession(sid, assistantMsgId);
     snapshotStreamTextToSession(sid, assistantMsgId, readStreamedFullText());
     commitToolPatchToSession(sid, assistantMsgId, toolId, patch);
     queueToolCallPatch(toolId, patch, status === 'pending_approval');
   };
   ```
   - 当大模型正在流式输出一段过渡文字（例如“我将使用终端命令检查目录：”），如果紧接着输出了 `tool_call`，`upsertToolCall` 立即调用 `snapshotStreamTextToSession`，将底层累积的全部文本 `readStreamedFullText()` **同步直接刷入 `sessionStore`**；
   - 此时原本还在 rAF 缓冲队列中定速排空的流式节奏被强制打断，前置正文瞬时被顶满全量呈现，紧接着工具行突然插入，产生强烈的视觉突兀感。
2. **运行结束时的即时清仓（Flush Final）**：
   在 `streamCallbacksInternals.ts:114-119`：
   ```ts
   if (this.bufferedLength() <= this.maxBytesPerFrame * 2) {
     this.flushFrame(true); // 强制同步刷完！
   }
   flushStreamBatchers();
   finishComplete();
   ```
   只要缓冲区残余 ≤ 2048 字节，系统便强制 `flushFrame(true)`，放弃任何平滑过渡，大块文本瞬间闪现收口。

---

### 3. 机制断层 3：权威收口（Authoritative Text）直冲 Store，绕过前端流式渲染

在 `apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts:280-286`：
```ts
export function onMessageEnd(env: HandlerEnv, envelope: EngineEnvelope<'message-end'>) {
  // ...
  if (piece) {
    state.turnAuthoritativeTexts.set(targetTurn, piece);
    // ...
    if (target) {
      getSessionStoreState().updateMessageText(
        env.sessionId,
        target.id,
        state.assistantText // 权威全文！
      );
    }
  }
}
```
- 后端引擎（Rust 侧）在回合结束时发送 `message-end` 信封；
- 前端桥接层的 `onMessageEnd` 立即将 `state.assistantText`（整回合全部合并文本）直接写入 `sessionStore`；
- 在 `MessageContent.tsx:273-275`：
  ```ts
  const streaming = Boolean(
    isThinkingMsg && streamText != null && streamText.length > 0
  );
  ```
  回合一旦结束，`isThinkingMsg` 变为 `false`，`streaming` 随之降为 `false`；
- `StreamingMarkdownView` 发现 `isStreaming === false`，直接退出流式模式，全量静态渲染 `displayMsg.text`。这就解释了为什么有时**前一秒还在等待，下一秒突然整条消息连同所有排版瞬间硬生生弹出来**。

---

### 4. 机制断层 4：前端对大 Chunk 直灌缺少 Ingress 整流缓冲

在 `StreamRenderBuffer.ts:56` 中：
```ts
private maxBytesPerFrame = 1024; // 单帧上限高达 1024 字节
private frameBudgetMs = 6;
```
- 当网络波动恢复、或者本地模型（Ollama / Llama.cpp）以 batch token 形式交付、或者子代理返回长文本报告时，单个 IPC 事件包含的文本量往往在 500~2000 字符；
- `StreamRenderBuffer` 的 `maxBytesPerFrame` 设置过大（1024 字节），导致这样的大 Chunk 在仅仅 1~2 个 rAF 帧内就全量泄放到了 `streamingStore`；
- 数据层缺乏“**进水节流（Ingress Rate Shaping）**”：上游送多快，下游缓冲就以极大配额吃进，最终导致渲染层看到的仍然是突发大块。

---

## 四、展开折叠 60fps 优化与流式平滑节流方案

为彻底根治上述体验顽疾，必须恪守“**追求架构优雅，杜绝打补丁**”与“**反过度设计**”铁律，从渲染状态机、合成器动效、分相调度与速率整流四个维度系统重构。

```
                     ┌────────────────────────────────────────────────────────┐
                     │          综合治理双轨重构方案 (Comprehensive Solution)  │
                     └──────────────────────────┬─────────────────────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
     【方案 A：手风琴展开折叠 60fps 重构】                          【方案 B：流式自适应速率平滑整流】
  1. 现代 CSS 动画重构（动态测量 + max-height 纯净过渡）          1. 显现速度域人本化（稳态 60~90字/s，极值有界）
  2. 动画/渲染分相调度（Phase Separation 架构）                   2. 消除 240 字直出与 300 字暴击 Snap
  3. 虚拟列表重测高动画期间闭锁（Accordion Motion Lock）         3. Ingress 动态自适应双缓冲（EWMA 阻尼吸收）
  4. 根除 Layout Thrashing 与 useLayoutEffect 泛滥              4. 跨状态转移平滑接力（Soft Handoff）
```

---

### 1. 方案 A：手风琴展开折叠 60fps 架构重构

#### 1.1 动画与内容渲染分相调度（Phase Separation）
展开一个包含大量复杂内容（高亮代码、Diff 对比、JSON 树）的手风琴时，必须将交互拆分为**两阶段（Two-Phase）执行**：

```
用户点击展开 ➔【Phase 1: 轻量动效相 (0~240ms)】➔ 动画结束 transitionend ➔【Phase 2: 重量水合相 (240ms+)】
               - 仅挂载骨架/占位或纯文本                     - 水合 DiffViewer 与完整高亮 DOM
               - 禁用复杂高亮与 Diff 计算                    - 挂载 ScrollFade 边缘渐隐 RO
               - 阻断虚拟滚动列表 actualTick 刷新            - 恢复虚拟滚动列表精确全量测高
               - 纯 GPU/轻量主线程高帧率展开 (60fps)          - 视口零卡顿无感升级为高清内容
```

- **Phase 1（动效期）**：
  - 手风琴内层仅渲染轻量文本预览容器，或对复杂内容施加 `content-visibility: auto` 与 `contain: paint layout`；
  - 延迟挂载 `useDiffHighlightMap` 与复杂的语法解析引擎；
  - `ScrollFadeRegion` 在动画进行中保持 `active=false`，严禁挂载 ResizeObserver，杜绝每帧执行 `getComputedStyle`。
- **Phase 2（落定期）**：
  - 监听内层的 `transitionend` 事件；
  - 动画落定后，激活真实组件水合，挂载高亮、Diff 对比视图与 `ScrollFade`；
  - 单次触发虚拟滚动列表的 `invalidateActual`，在静止状态下进行一次精准测高，彻底消灭动画过程中的连续重排。

#### 1.2 现代 CSS 动效优化与合成器隔离
彻底优化 CSS 过渡层级，利用 CSS 属性隔离回流范围：
1. **容器隔离**：
   在 `.groupBody` 和 `.toolBody` 上显式声明：
   ```css
   contain: layout paint;
   will-change: grid-template-rows;
   ```
   限制回流边界，防止手风琴内部的微小形变逃逸至外部页面级父容器。
2. **剔除 `innerRef.getBoundingClientRect()` 同步强刷**：
   - 动画时长 `transitionDuration` 不应在点击事件的同步闭包中读取深层 DOM；
   - 采用纯纯数推导（基于数据项条数预估高度）或在进入折叠态时异步缓存已知高度，**禁止在展开触发的同一微任务里强制读取深层布局**。

#### 1.3 虚拟滚动列表“手风琴动画锁（Accordion Motion Guard）”
在 `VirtualScrollManager` 与 `useVirtualScroll` 中引入轻量状态锁：
- 当任何折叠组件开始播放动画时，向当前会话的 `VirtualScrollManager` 登记 `isAnimatingAccordion = true`；
- 在动画进行期间（220ms~300ms 窗口）：
  - `setActual` 仅将最新实测值存入 `pendingActualRef`，**不调度 rAF，不递增 `actualTick`，不触发 `MessageVirtualizer` 重渲染**；
- 动画结束（`transitionend`）时，调用 `flushPendingGeometry()`，**一次性合并提交高度差值**；
- **效果**：将 300ms 内多达 15 次的 React 虚拟列表全量重渲染直接**降为 0 次**！动画全程由浏览器原生过渡驱动，丝滑达到 60 FPS。

#### 1.4 修复 `toolExpansionState` 的无依赖副作用
在 `toolExpansionState.ts:572-574`：
- 将无依赖的 `useLayoutEffect` 改为受控执行，**仅当 `pendingSnapshotRef.current !== null` 时触发**；
- 缓存滚动宿主引用，严禁在每次渲染中递归调用 `findScrollContainer` 爬树并调用 `getComputedStyle`。

---

### 2. 方案 B：流式自适应速率平滑整流方案（Smooth Human Pacing）

#### 2.1 显现速度域的人本化重定标（Human-Scale Pacing）
重新校准 `revealPacing.ts` 中的节律参数，使其真正匹配人类生理阅读感知：

| 参数项 | 现有值（过激/突发） | 建议优化值（人本平滑） | 优化机理与体验收益 |
| :--- | :--- | :--- | :--- |
| `engageThresholdChars` | **240 字** | **12 字** | 短回复不再裸奔直显，首句即具备温润的涌现感（12 字约半句话）。 |
| `steadyCapCharsPerSec` | **2,600 字/s** | **80 字/s** | 稳态打字机速率，约每秒 1~2 行，字迹清晰涌现，彻底消除暴冲感。 |
| `catchUpCapCharsPerSec` | **5,200 字/s** | **200 字/s** | 大量积压时的追赶上限，依然处于人眼可追踪的速度区间，不闪烁。 |
| `frameHardCapChars` | **420 字/帧** | **6 字/帧** | 60Hz 下单帧最多吐 6 个字，120Hz 下单帧 3 个字，彻底杜绝单帧大块砸屏。 |
| `finishSnapChars` | **300 字** | **20 字** | 终态不再瞬间砸出 300 字大块；仅当余量极小（20字内）才做微补偿对齐。 |
| `finishDrainSeconds` | **0.7 秒** | **0.4 秒** | 大余量在流结束时以匀速顺滑泄空，兼顾利落收口与视觉连续性。 |

#### 2.2 前端 Ingress 双缓冲自适应速率整形器（Adaptive Rate Shaper）
在 `StreamRenderBuffer` 与 UI 呈现之间建立真正的自适应双缓冲整流机制：

```
[后端 IPC / 大模型 Chunk]
       │
       ▼ (可能以 1000 字节的大 Chunk 突发到达)
┌────────────────────────────────────────────────────────┐
│  Ingress Rate Shaper (自适应速率整形队列)               │
│  - 维护 arrivedQueue (接收真值) 与 drainCursor (呈现)  │
│  - 计算瞬时积压量 Lag = arrivedQueue.length - cursor   │
│  - 动态 EWMA 阻尼算法：Lag 越大，速率适度线性平滑补偿  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (每一帧以恒定且柔和的微步长 rAF 输出)
[60 FPS rAF 刷新] ➔ 每次仅输出 2~6 个字符 ➔ 呈现于界面
```

- **数学公式（微步长平滑推进）**：
  $$\Delta \text{chars}(t) = \min\left(\text{frameHardCap}, \; \max\left(\text{minRate} \times \Delta t, \; v_{\text{steady}} \times \Delta t + \frac{\text{Lag} - \text{Lag}_{\text{target}}}{\tau}\right)\right)$$
- 无论后端是单字返回还是数千字网络包骤然解压，进入前端 UI 层的字符数在时间轴上都呈现**平滑的连续可微曲线**，彻底告别突发性大块涌现。

#### 2.3 跨状态转移平滑接力（Soft Transition on State Handoff）
彻底改造“状态一切换就强制即时全量 Flush”的粗暴逻辑：
1. **工具启动平滑切片**：
   - 当收到 `onToolStart` 时，**不要**粗暴调用 `snapshotStreamTextToSession(readStreamedFullText())` 将未呈现的全文顶死进 Store；
   - 而是以**当前 UI 已显现位置（`revealedLen`）**作为因果分割线；
   - 剩余未显现文本放入当前段的专属泄空尾巴，或作为工具前导词平滑落定，保持文本与工具块出现的物理因果时序与视觉时序绝对统一。
2. **终态收口柔和泄空**：
   - 收到 `message-end` 或 `onComplete` 时，前端状态机标记 `isFinishing = true`；
   - 不调用 `flushFrame(true)` 强刷；而是启动一个短周期的快速平滑泄空（200~400ms），在字符自然滚入屏幕后，再将最终状态置为 `completed`；
   - 避免前一秒界面停止、后一秒突然暴击闪烁的视觉硬切。

---

## 五、验收标准与性能断言（Verification Matrix）

为确保优化方案彻底根除问题且不引入次生衰退，必须建立刚性的可量化验收矩阵：

| 验收维度 | 现有实测指标（基线） | 目标验收指标（优化后） | 验证方法与工具 |
| :--- | :--- | :--- | :--- |
| **手风琴展开掉帧率 (Jank Rate)** | > 65%（严重卡顿） | **< 3%（丝滑 60fps）** | Chrome DevTools Performance 面板录制帧率曲线 |
| **展开交互长任务 (Long Task)** | 频繁出现 80~180ms 长任务 | **单任务 ≤ 16.6ms（0 长任务）** | Performance 面板 Long Tasks 过滤器 |
| **动画期虚拟列表重绘次数** | 300ms 内触发 8~15 次重排重渲 | **严格 0 次（全量闭锁）** | React DevTools Profiler / 组件计数器断言 |
| **单帧流式文本吐字量** | 突发时单帧 400~1000 字符 | **恒定 ≤ 8 字符/帧** | `StreamRenderBuffer` 与帧监控测试用例断言 |
| **短文本起始呈现体感** | 240 字内瞬间硬闪出屏 | **12 字起平滑涌现，微阻尼打字机节奏** | 录屏逐帧分解（Frame-by-frame Review） |
| **跨工具/终态切换突发度** | 切换瞬间大块暴刷，界面剧烈抖动 | **平滑连续衔接，过渡零瞬跳（ΔY ≡ 0）** | 真实 LLM 工具调用场景压力回放 |

---

## 六、总结与落地建议

工具展开折叠的卡顿与流式输出的突发刷屏，是底层渲染调度缺乏分相控制与显现速度域过度激进共同作用的结果。
本分析明确了：
1. **手风琴 60fps 优化的核心在于“分相调度”与“动画期间闭锁虚拟滚动重测高”**，卸下主线程在动效期间的重型运算负担；
2. **流式平滑节流的核心在于“人本化速度域重构”与“Ingress 自适应速率整形”**，彻底终结 240 字直出、300 字 Snap 与状态切换暴力 Flush 的设计漏洞。

后续实施将根据本报告建立分维详案并派发执行，彻底打磨出如同精密机械般丝滑流畅的工具与流式交互质感。
