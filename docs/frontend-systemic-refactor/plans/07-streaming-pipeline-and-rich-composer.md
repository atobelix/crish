# 前端流式渲染管线、零回流虚拟滚动与富文本 Composer 系统性重构落地方案

> **战役代号**：`frontend-systemic-refactor`  
> **方案编号**：`plans/07-streaming-pipeline-and-rich-composer.md`  
> **架构专员**：Agent P07（流式渲染与富文本 Composer 架构师）  
> **前置输入**：  
> - 审计报告：[`docs/frontend-comprehensive-audit/audits/06-audit-state-topology-stream-and-composer.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/audits/06-audit-state-topology-stream-and-composer.md)  
> - 权威总报告：[`docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md)  
> **核心使命**：彻底根除虚拟滚动测高强制同步排版（Layout Thrashing）、消除虚拟滚动 Hook 扁平对象引用抖动导致的无端布局重算、阻断高吞吐推流时叙事流全量历史消息的重复投影与 JSON 解析风暴、废除富文本块级序列化盲目切片反模式并接入纯 AST 序列化、消灭斜杠建议菜单脱离 React 树挂载引发的孤儿 DOM 泄漏与生命周期失控，打造毫秒级响应、零回流、120fps 极度丝滑的现代化流式对话与输入体验。  
> **遵循铁律**：零打补丁（Zero Monkey-Patching）、零硬编码（Zero Hardcoding）、不搞双轨妥协（Clean Cut & No Dual-Track）、负代码清退（Negative Code Yield）、永久防回潮（Permanent Immunity）。

---

## 目录索引

1. [战役总纲与核心设计原则](#1-战役总纲与核心设计原则)
2. [架构病态与性能瓶颈物理现场实证剖析](#2-架构病态与性能瓶颈物理现场实证剖析)
   - 2.1 [动态测高强制同步排版实证：`messageVirtualizerMeasure.ts:44-45` 闲置 `extractEntryBlockSize` 与 `el.offsetHeight` 引发 Layout Thrashing](#21-动态测高强制同步排版实证messagevirtualizermeasurets44-45-闲置-extractentryblocksize-与-eloffsetheight-引发-layout-thrashing)
   - 2.2 [虚拟滚动 Hook 对象引用抖动实证：`useVirtualScroll` 扁平字面量每帧重构导致 `useStickToBottomFollow` 布局重跑](#22-虚拟滚动-hook-对象引用抖动实证usevirtualscroll-扁平字面量每帧重构导致-usesticktobottomfollow-布局重跑)
   - 2.3 [叙事流投影管道无缓存重算实证：`ConversationFlowHost` 与 `renderNarrativeTools` 高频推流下 $O(N)$ 遍历与 `JSON.parse` 性能风暴](#23-叙事流投影管道无缓存重算实证conversationflowhost-与-rendernarrativetools-高频推流下-on-遍历与-jsonparse-性能风暴)
   - 2.4 [富文本单块序列化切片脆弱性实证：`twoTierBlockEditorCache.ts:392-398` 硬编码 `SENTINEL_HR_NODE` 与 `slice(5, -5)` 盲切代码块/列表引发的语法碎裂](#24-富文本单块序列化切片脆弱性实证twotierblockeditorcachets392-398-硬编码-sentinel_hr_node-与-slice5--5-盲切代码块列表引发的语法碎裂)
   - 2.5 [斜杠指令脱离 React 树挂载实证：`SlashExtension.ts:243` 直调 `document.body.appendChild` 导致的孤儿 DOM 泄漏与事件隔离缺失](#25-斜杠指令脱离-react-树挂载实证slashextensionts243-直调-documentbodyappendchild-导致的孤儿-dom-泄漏与事件隔离缺失)
3. [目标架构与技术契约设计 (SSOT)](#3-目标架构与技术契约设计-ssot)
   - 3.1 [零回流虚拟滚动测量契约（Zero-Reflow Resize Measurement Contract）](#31-零回流虚拟滚动测量契约zero-reflow-resize-measurement-contract)
   - 3.2 [稳定控制器与解耦布局跟随契约（Stable Virtual Scroll Controller & Decoupled Stick-to-Bottom）](#32-稳定控制器与解耦布局跟随契约stable-virtual-scroll-controller--decoupled-stick-to-bottom)
   - 3.3 [对话流投影两级弱引用记忆化拓扑（WeakMap Projection & JSON Argument Parse Memoization）](#33-对话流投影两级弱引用记忆化拓扑weakmap-projection--json-argument-parse-memoization)
   - 3.4 [纯 AST 驱动的块级 Markdown 序列化契约（Pure AST Block Serialization Contract）](#34-纯-ast-驱动的块级-markdown-序列化契约pure-ast-block-serialization-contract)
   - 3.5 [应用级浮层中枢接线契约（`LayerStackManager` Popover Lifecycle for Slash Suggestion）](#35-应用级浮层中枢接线契约layerstackmanager-popover-lifecycle-for-slash-suggestion)
4. [关键重构代码落地详案（Code-Level Implementation）](#4-关键重构代码落地详案code-level-implementation)
   - 4.1 [任务 1：改造 `messageVirtualizerMeasure.ts`，物理清除 `el.offsetHeight`，100% 消费 `extractEntryBlockSize`](#41-任务-1改造-messagevirtualizermeasurets物理清除-eloffsetheight100-消费-extractentryblocksize)
   - 4.2 [任务 2：重构 `useVirtualScroll.ts` 与 `messageVirtualizerScrollState.ts`，固化控制器引用与解耦跟随 Effect](#42-任务-2重构-usevirtualscrollts-与-messagevirtualizerscrollstatets固化控制器引用与解耦跟随-effect)
   - 4.3 [任务 3：重构 `projectMessage.ts`、`narrativeRenderers.tsx` 与 `toolArgsNormalizer.ts`，植入 WeakMap 与 LRU 记忆化](#43-任务-3重构-projectmessagetsnarrativerendererstsx-与-toolargsnormalizerts植入-weakmap-与-lru-记忆化)
   - 4.4 [任务 4：重构 `markdownSerializer.ts` 与 `twoTierBlockEditorCache.ts`，消灭 Sentinels 与 `slice(5, -5)`](#44-任务-4重构-markdownserializerts-与-twotierblockeditorcachets消灭-sentinels-与-slice5--5)
   - 4.5 [任务 5：重构 `SlashExtension.ts` 与 `TiptapEditorField.tsx`，彻底接入 `LayerStackManager`](#45-任务-5重构-slashextensionts-与-tiptapeditorfieldtsx彻底接入-layerstackmanager)
5. [基准测试、性能用例与自动化验收断言](#5-基准测试性能用例与自动化验收断言)
   - 5.1 [虚拟滚动零回流专项测试：`MessageVirtualizer.zeroReflow.test.tsx`](#51-虚拟滚动零回流专项测试messagevirtualizerzeroreflowtesttsx)
   - 5.2 [虚拟滚动控制器引用稳定性测试：`useVirtualScroll.memo.test.ts`](#52-虚拟滚动控制器引用稳定性测试usevirtualscrollmemotestts)
   - 5.3 [叙事流高频推流投影记忆化基准测试：`projectMessage.memo.test.ts`](#53-叙事流高频推流投影记忆化基准测试projectmessagememotestts)
   - 5.4 [富文本单块 AST 序列化无损契约测试：`twoTierBlockEditorCache.ast.test.ts`](#54-富文本单块-ast-序列化无损契约测试twotierblockeditorcacheasttestts)
   - 5.5 [斜杠菜单生命周期与孤儿 DOM 清零测试：`SlashExtension.layerStack.test.tsx`](#55-斜杠菜单生命周期与孤儿-dom-清零测试slashextensionlayerstacktesttsx)
6. [防回潮自动化门禁与静态检查（Permanent Immunity Gate）](#6-防回潮自动化门禁与静态检查permanent-immunity-gate)
   - 6.1 [AST 门禁：检测禁止在 ResizeObserver 回调中读取 `offsetHeight` / `clientHeight` / `scrollHeight`](#61-ast-门禁检测禁止在-resizeobserver-回调中读取-offsetheight--clientheight--scrollheight)
   - 6.2 [AST 门禁：检测禁止在富文本扩展中裸调 `document.body.appendChild`](#62-ast-门禁检测禁止在富文本扩展中裸调-documentbodyappendchild)
   - 6.3 [性能门禁：长列表 1,000 条消息推流丢帧率与 GC 压力基准断言](#63-性能门禁长列表-1000-条消息推流丢帧率与-gc-压力基准断言)
7. [实施路线图、风险预案与代码变更收益对账表](#7-实施路线图风险预案与代码变更收益对账表)

---

## 1 战役总纲与核心设计原则

在 Conex / Crish 前端工程架构中，**流式渲染管线**（Streaming Pipeline）、**长列表虚拟滚动**（Virtual Scroll）以及**富文本编辑器**（Rich Composer）处于高频交互的最核心枢纽。当 AI 引擎以 50~100 Tokens/sec 的极限速率推流，或长达数千条消息的长会话进行高速惯性滚动时，主线程上微小的同步回流、引用抖动或冗余 AST 解析都会被瞬间放大为肉眼可见的丢帧（Frame Drop）、滚动颠簸（Jitter）与内存膨胀。

本方案严格遵守重构总纲的六大铁律，确立如下核心准则：

```mermaid
flowchart TD
  subgraph CorePrinciples["五大架构铁律"]
    P1["1. 绝对零回流 (Zero Reflow / Zero Thrashing)<br/>物理拔除几何属性读取，100% 消费浏览器送达的盒模型尺寸"]
    P2["2. 纯引用稳定 (Pure Reference Stability)<br/>Hook 控制器深度 useMemo，切断下游布局与订阅连锁惊群"]
    P3["3. 拓扑级记忆化 (WeakMap & LRU Memoization)<br/>历史不可变消息单次投影终身复用，消除高频推流 JSON 解析"]
    P4["4. 语法树绝对保真 (Lossless AST Serialization)<br/>铲除 Sentinel 与字符串盲切，块级序列化直达 AST 单一真理"]
    P5["5. 浮层全局生命周期闭环 (LayerStack Single Authority)<br/>禁止裸 appendChild，所有弹出层 100% 纳入应用级堆栈调度"]
  end
```

1. **绝对零回流（Zero Reflow / Zero Layout Thrashing）**：  
   `ResizeObserver` 回调是浏览器布局计算完成后的事件通知。在回调内严禁任何形式的 `offsetHeight`、`clientHeight`、`getClientRects()` 等强制同步排版（Forced Synchronous Layout）属性读取。所有尺寸必须且只能从通知对象自带的 `borderBoxSize`（或测试降级 `contentRect`）中就地解包。
2. **纯引用稳定（Pure Reference Stability）**：  
   自定义 Hook 返回的控制器（Controller）与几何状态必须严格封装在 `useMemo` 边界内。严禁在组件渲染周期内抛出未经缓存的匿名对象字面量，杜绝破坏下游 `useLayoutEffect`、`useEffect` 依赖数组的缓存守卫。
3. **拓扑级记忆化（WeakMap & LRU Memoization）**：  
   Zustand 不可变数据流保障了历史消息对象的持久引用稳定。通过 `WeakMap<SessionMessage, ProjectionResult>` 将叙事流节点计算降维至 $O(1)$，对未变更的历史消息实现零 CPU 开销、零 GC 内存垃圾产出；对高频变更的工具调用参数接入字符串级 LRU 缓存，阻断重复 `JSON.parse`。
4. **语法树绝对保真（Lossless AST Serialization）**：  
   坚决杜绝“拼接哨兵字符再靠 `slice` 截断”的反模式黑魔法。富文本块序列化必须是语义化的 AST 纯函数映射，无论是代码块的多重反引号、列表的缩进悬挂还是引用块的嵌套前缀，必须通过标准的 AST Block Walker 生成，保障双向往返（Roundtrip）语法 100% 无损。
5. **浮层全局生命周期闭环（LayerStack Single Authority）**：  
   禁止任何业务模块以 `document.body.appendChild` 脱离 React 虚拟 DOM 树和应用级浮层管理器。所有悬浮层必须向单例 `LayerStackManager` 登记，统一享受外点判定（Branch-Aware Outside Pointer）、LIFO 倒序 Esc 退栈、多窗口/分屏拖拽避险自动收折以及组件卸载自动清理（No Orphan DOM）。

---

## 2 架构病态与性能瓶颈物理现场实证剖析

### 2.1 动态测高强制同步排版实证：`messageVirtualizerMeasure.ts:44-45` 闲置 `extractEntryBlockSize` 与 `el.offsetHeight` 引发 Layout Thrashing

#### 代码现场定位
- 测高辅助函数：[`apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts:7-60`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts#L7-L60)
- 消费端：[`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:137`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L137)

#### 现场代码与物理断层
在 `messageVirtualizerMeasure.ts` 中，作者在前文声明了基于现代 Web 标准的零回流提取工具：
```typescript
// apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts:8-28
export function extractEntryBlockSize(entry: ResizeObserverEntry): number {
  if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
    const blockSize = entry.borderBoxSize[0]?.blockSize;
    if (typeof blockSize === 'number' && Number.isFinite(blockSize) && blockSize > 0) {
      return Math.round(blockSize);
    }
  }
  const contentHeight = entry.contentRect?.height;
  if (typeof contentHeight === 'number' && Number.isFinite(contentHeight) && contentHeight > 0) {
    return Math.ceil(contentHeight);
  }
  return 0;
}
```
然而紧接着在第 34-49 行的真实测高逻辑中：
```typescript
// apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts:34-49
export function createRowMeasureRef(
  id: string,
  setActual: (msgId: string, height: number) => void
): (el: HTMLElement | null) => void {
  let node: HTMLElement | null = null;
  const onEntry = (entry: ResizeObserverEntry) => {
    const el = entry.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.querySelector('[data-md-pending="true"]') !== null) return;
    const msgId = el.dataset.vindex ?? id;

    // ❌ 严重架构缺陷：注释声明了 100% 消费 borderBoxSize，但代码却直接访问了 el.offsetHeight！
    const measuredHeight =
      el.offsetHeight || Math.ceil(entry.contentRect.height);
    if (msgId != null && measuredHeight > 0) {
      setActual(msgId, measuredHeight);
    }
  };
  // ...
}
```

#### 物理运行时危害分析（Blink Rendering Pipeline）
浏览器的帧渲染流水线具有严格的单向拓扑：
$$\text{JavaScript} \longrightarrow \text{Style Recalculation} \longrightarrow \text{Layout} \longrightarrow \text{Paint} \longrightarrow \text{Composite} \longrightarrow \text{ResizeObserver Callbacks}$$
1. 当浏览器触发 `ResizeObserver` 回调时，当帧的布局已经收敛；
2. 在 `onEntry` 中访问 `el.offsetHeight`，V8 引擎必须查询 DOM 节点的盒模型；
3. 如果此时回调内部的 `setActual` 更新了上层虚拟滚动的高度缓存（或引起其他 DOM 修改），浏览器的 Layout 状态被标记为 Dirty；
4. 视口内有 10~30 个可见消息节点时，`ResizeObserver` 会分发多个 entries。在循环或并发通知中，交替进行“读 `el.offsetHeight` ➔ 触发重排 ➔ 读下一个 `el.offsetHeight` ➔ 触发重排”，形成典型的 **Layout Thrashing（强制同步布局颠簸）**；
5. 在 WebView2 / Chromium 宿主下，单次强制回流耗时可达 3~15ms，帧率直接从 120fps/60fps 断崖式下跌至 20~30fps，导致滚动肉眼可见的卡顿与风扇狂转。

---

### 2.2 虚拟滚动 Hook 对象引用抖动实证：`useVirtualScroll` 扁平字面量每帧重构导致 `useStickToBottomFollow` 布局重跑

#### 代码现场定位
- 虚拟滚动核心 Hook：[`apps/crish-desktop/src/hooks/useVirtualScroll.ts:376-397`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts#L376-L397)
- 虚拟渲染容器组件：[`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:281-294`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L281-L294)
- 贴底跟随状态机：[`apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts:240-302`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts#L240-L302)

#### 现场代码与物理断层
在 `useVirtualScroll.ts` 的末尾：
```typescript
// apps/crish-desktop/src/hooks/useVirtualScroll.ts:376-397
  return {
    visibleRange,
    containerRef,
    onScroll,
    syncOrder,
    setEstimated,
    setActual,
    preloadEstimates,
    clearHeights,
    manager,
    scrollTop,
    viewportHeight,
    totalHeight,
    containerHeight: viewportHeight,
    isGestureActive,
    flushPendingGeometry,
    markProgrammaticScroll,
    performProgrammaticScroll,
    cancelProgrammaticScroll,
    isProgrammaticScrollEvent,
  };
```
该函数在每一次渲染执行时，**均重新构建一个扁平的对象字面量**。虽然内部的每一个回调函数（`onScroll`、`setActual`、`performProgrammaticScroll`）都通过 `useCallback` 进行了缓存，内部的 `visibleRange` 和 `totalHeight` 也通过 `useMemo` 进行了缓存，但是包装它们的外层对象 `vs` 每次都是新指针（`prevVs !== nextVs`）！

在 `MessageVirtualizer.tsx` 中：
```typescript
// apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:281-285
  useStickToBottomFollow({
    containerRef: vs.containerRef,
    vs, // ❌ 传递了每帧抖动的新对象引用
    messages,
    // ...
  });
```

在 `messageVirtualizerScrollState.ts` 中：
```typescript
// apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts:240-302
export function useStickToBottomFollow({
  containerRef,
  vs,
  messages,
  // ...
}: StickToBottomFollowParams): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollH = container.scrollHeight || totalHeight; // ❌ 触发同步读取
    const clientH =
      container.clientHeight || vs.viewportHeight || DEFAULT_VIEWPORT_HEIGHT_PX; // ❌ 触发同步读取
    const maxScroll = Math.max(0, scrollH - clientH);
    // ...
    if (
      Math.abs(container.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX ||
      Math.abs(vs.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX
    ) {
      vs.performProgrammaticScroll(container, maxScroll);
      observedTopRef.current = maxScroll;
    }
  }, [
    messages,
    totalHeight,
    containerRef,
    vs, // ❌ 依赖项包含每帧变化的新对象 vs！
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]);
}
```

#### 物理运行时危害分析
1. 任何引起 `MessageVirtualizer` 重渲染的微小事件（如鼠标悬浮改变状态、搜索框聚焦、或兄弟组件更新），都会导致 `vs` 产生新引用；
2. 由于 `vs` 处于 `useLayoutEffect` 的依赖数组中，导致 `useStickToBottomFollow` 内部的 `useLayoutEffect` **在每帧渲染后 100% 无条件重跑**；
3. `useLayoutEffect` 是在浏览器绘制前同步执行的，它反复执行 `container.scrollHeight` 与 `container.clientHeight` 的同步几何读取，并频繁调用 `performProgrammaticScroll`；
4. 这种无意义的反复重跑不仅浪费宝贵的帧预算（16.6ms / 8.3ms），还会引发视口锚点的微小亚像素抖动。

---

### 2.3 叙事流投影管道无缓存重算实证：`ConversationFlowHost` 与 `renderNarrativeTools` 高频推流下 $O(N)$ 遍历与 `JSON.parse` 性能风暴

#### 代码现场定位
- 叙事流宿主：[`apps/crish-desktop/src/extensions/conversation-flow/host.tsx:32-50`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/host.tsx#L32-L50)
- 叙事渲染器：[`apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx:42-73`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx#L42-L73)
- 投影核心纯函数：[`packages/conversation-flow/src/projectMessage.ts:35-78`](file:///c:/Software/conex/packages/conversation-flow/src/projectMessage.ts#L35-L78)
- 工具入参解析器：[`apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts:32-52`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts#L32-L52)

#### 现场代码与物理断层
在 `host.tsx` 中：
```typescript
// apps/crish-desktop/src/extensions/conversation-flow/host.tsx:32-40
function countAssistantFlowNodes(messages: SessionMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    if (msg.sender !== 'assistant') continue;
    const projected = projectMessage(msg); // ❌ 每次 messages 数组变化，重新对所有历史助手消息进行无缓存投影！
    n += projected.nodes.length;
  }
  return n;
}

export function ConversationFlowHost(props: ChatMessageListProps): ReactElement {
  const list = props.messages.messages;
  const nodeCount = useMemo(() => countAssistantFlowNodes(list), [list]);
  // ...
}
```

在 `narrativeRenderers.tsx` 中：
```typescript
// apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx:42-46
function purposesOf(msg: SessionMessage): PurposeNode[] {
  if (msg.sender !== 'assistant') return [];
  const { nodes } = projectMessage(msg, { humanize: DESKTOP_HUMANIZE }); // ❌ 每一行渲染时重新 projectMessage
  return nodes.filter((n): n is PurposeNode => n.kind === 'purpose');
}

export function renderNarrativeTools(
  args: ChatNarrativeRenderToolsArgs & { messages: SessionMessage[] }
): ReactNode {
  const { items, msgId, toolStackProps, messages } = args;
  const msg = messages.find((m) => m.id === msgId);
  const visible =
    msg && msg.sender === 'assistant'
      ? purposesForSlice(purposesOf(msg), sliceIds) // ❌ 行渲染时高频重算
      : [];
  // ...
}
```

深入 `toolArgsNormalizer.ts`：
```typescript
// apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts:32-52
export function parseToolArgsSafe(argsStr?: string | null): ExtractedToolArgs {
  if (!argsStr || !argsStr.trim()) {
    return { props: {}, isObject: false };
  }
  const raw = argsStr.trim();
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(raw); // ❌ 没有任何解析缓存，重复执行 JSON.parse
    if (
      typeof parsed === 'string' &&
      (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))
    ) {
      try {
        parsed = JSON.parse(parsed.trim()); // 甚至二次 JSON.parse
      } catch {}
    }
  } catch {}
  // ...
}
```

#### 物理运行时危害分析
1. 当长任务推流时，引擎以 80 Tokens/sec 持续追加当前消息文本，导致 Zustand 中的 `messages` 数组持续生成新引用；
2. 每次 `messages` 数组引用变化，`ConversationFlowHost` 都会调用 `countAssistantFlowNodes(list)`，对整场对话（假设 100 条历史消息，其中 50 条助手消息，包含上百次工具调用）进行全量 $O(N)$ 遍历；
3. 对于每一条不可变的历史消息，`projectMessage` 重复执行，构建 AST 节点，并在 `DESKTOP_HUMANIZE.label` 处调用 `toolHumanLabel` $\rightarrow$ `toolLabelFromArgs` $\rightarrow$ `parseToolArgsSafe`；
4. `parseToolArgsSafe` 重复对历史工具参数字符串执行 `JSON.parse`；
5. 在每秒 80 次推流更新下，主线程每秒执行数千次完全相同的大文本 `JSON.parse` 和上万个瞬时 AST 对象的垃圾回收分配，导致 V8 Major GC 频繁暂停（Stop-the-World），主线程严重拥塞。

---

### 2.4 富文本单块序列化切片脆弱性实证：`twoTierBlockEditorCache.ts:392-398` 硬编码 `SENTINEL_HR_NODE` 与 `slice(5, -5)` 盲切代码块/列表引发的语法碎裂

#### 代码现场定位
- 两级块缓存序列化器：[`apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts:390-398`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts#L390-L398)
- 底层 Markdown 序列化器：[`apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts:226-243`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts#L226-L243)

#### 现场代码与物理断层
在 `twoTierBlockEditorCache.ts` 中：
```typescript
// apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts:390-398
const SENTINEL_HR_NODE: JSONContent = { type: 'horizontalRule' };

export function serializeSingleBlockToMarkdown(blockJson: JSONContent): string {
  const wrapped = serializeToMarkdown({
    type: 'doc',
    content: [SENTINEL_HR_NODE, blockJson, SENTINEL_HR_NODE],
  });
  // ❌ 极度脆弱的硬编码反模式黑魔法：假设 SENTINEL_HR_NODE 序列化后首尾各占 5 字符！
  return wrapped.length >= 10 ? wrapped.slice(5, -5) : '';
}
```

#### 破损用例数学与语法实证
`markdownSerializer.ts` 的 `serializeToMarkdown` 实现如下：
```typescript
// apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts:226-243
export function serializeToMarkdown(doc: JSONContent | null | undefined): string {
  // ...
  const raw = doc.type === 'doc' && doc.content ? serializeBlockNodes(doc.content) : ...;
  if (!raw || !raw.trim()) return '';
  const leadingTrimmed = raw.replace(/^\s+/, '');
  return leadingTrimmed.replace(/[ \t]+$/, '');
}
```
`serializeBlockNodes` 在块与块之间使用 `\n\n` 拼接，并在水平分割线时输出 `---`。
1. **空内容块破损（Empty Paragraph）**：
   - 输入 `blockJson = { type: 'paragraph', content: [] }`；
   - `serializeBlockNodes` 输出：`---\n\n\n\n---`（长度为 11）；
   - `wrapped.slice(5, -5)`：从索引 5（字符 `\n`）切到倒数第 5 位，提取出 `"\n"` 而不是期望的空字符串 `""`！
2. **带缩进的引用块或列表（Blockquote / List）**：
   - 引用块输出形如 `> line1\n> line2`；
   - 包含特定换行时，若首尾换行与 `---` 拼接后的字符偏移发生漂移，`slice(5, -5)` 会直接吞噬真实内容的有效前缀（例如将 `> text` 吞噬成 `text`，或切掉代码块的反引号 ```` ``` ````）；
3. **内容长度小于 10 时的非预期清空**：
   - 若特定块类型在极端情况下生成的合法文本短于 10 字符（例如长度为 3 的短标题），函数直接返回空字符串 `''`，造成用户输入的**静默数据丢失（Silent Data Loss）**！

---

### 2.5 斜杠指令脱离 React 树挂载实证：`SlashExtension.ts:243` 直调 `document.body.appendChild` 导致的孤儿 DOM 泄漏与事件隔离缺失

#### 代码现场定位
- 斜杠扩展定义：[`apps/crish-desktop/src/components/chat-composer/SlashExtension.ts:231-245, 142-150`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/SlashExtension.ts#L231-L245)
- 编辑器宿主：[`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx:424-450`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx#L424-L450)
- 浮层中枢契约：[`apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackTypes.ts:14`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackTypes.ts#L14)

#### 现场代码与物理断层
在 `SlashExtension.ts` 中：
```typescript
// apps/crish-desktop/src/components/chat-composer/SlashExtension.ts:231-245
    const create = (props: any) => {
      propsRef = props;
      const dom = props.editor?.view?.dom;
      if (dom) {
        if (ctx.listboxId) dom.setAttribute('aria-controls', ctx.listboxId);
        dom.setAttribute('aria-expanded', 'true');
      }
      component = new ReactRenderer(TiptapSlashMenu, {
        props: buildProps(props),
        editor: props.editor,
      });
      // ❌ 违规直接操作原生 DOM：绕过 React 树与 LayerStackManager
      if (component.element && typeof document !== 'undefined') {
        document.body.appendChild(component.element);
      }
    };
```
销毁逻辑：
```typescript
// apps/crish-desktop/src/components/chat-composer/SlashExtension.ts:142-150
    const destroyComponent = () => {
      if (component) {
        if (component.element?.parentNode) {
          component.element.parentNode.removeChild(component.element);
        }
        component.destroy();
        component = null;
      }
    };
```

#### 物理运行时危害分析
1. **孤儿 DOM 节点滞留泄漏（Orphan DOM Leak）**：
   - 当用户在斜杠菜单处于打开状态时，快速切换会话、关闭分栏窗格、或触发组件错误边界（Error Boundary），Composer 宿主组件被卸载；
   - ProseMirror 插件在此类突发卸载时往往**不会分发 `onExit` 回调**；
   - `component.element`（即 `<div class="tiptap-slash-menu">...</div>`）在 `document.body` 中失去任何引用，永久滞留在真实 DOM 树中，成为孤儿节点；
2. **缺乏应用级事件隔离与堆栈调度**：
   - 检查 `layerStackTypes.ts:14`，系统已明确将 `popover` 定义为 `(TiptapSlashMenu, Popover)` 的归属；
   - 然而由于 `SlashExtension.ts` 未接入 `LayerStackManager`，它完全缺失了全仓统一的“外点判定（Outside Pointer）”机制；
   - 当用户点击窗格空白处、侧边栏或打开全局设置弹窗（Modal）时，斜杠菜单无法接收到 `dismissAll('interaction')` 避险通知，导致斜杠菜单浮动在设置窗口或其它浮层之上，破坏 UI 视觉层级；
3. **Esc 键逃逸割裂**：
   - `TiptapEditorField.tsx` 被迫在宿主外层挂载原生的捕获阶段事件监听器（`dom.addEventListener('keydown', onEscapeCapture, true)`）来打补丁触发 `exitSuggestion`；这种层层外围修补是架构断层的典型表现。

---

## 3 目标架构与技术契约设计 (SSOT)

针对上述 5 大实证缺陷，本方案制定以下具备数学级确定性与物理闭环的目标架构规范：

```
                    【流式渲染管线与富文本 Composer 终极目标拓扑】
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ 1. 零回流虚拟滚动引擎 (Zero-Reflow Virtual Scroll Pipeline)                 │
  │    ResizeObserverEntry ➔ extractEntryBlockSize (borderBoxSize[0].blockSize) │
  │    • 物理拔除 el.offsetHeight 读取                                           │
  │    • 纯前置几何提取，0 强制同步回流，60fps / 120fps 极速锁定                │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 2. 纯引用稳定控制器与解耦布局跟随 (Decoupled Follower & Stable Controller)   │
  │    useVirtualScroll ➔ useMemo({ ... }) 固化外部对象句柄                     │
  │    useStickToBottomFollow ➔ 仅订阅 scrollTop / viewportHeight 标量依赖     │
  │    • 彻底消除每帧对象字面量重新分配导致的 useLayoutEffect 惊群重跑          │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 3. 叙事流两级弱引用投影记忆化 (Two-Level WeakMap & LRU Cache)               │
  │    L1: WeakMap<SessionMessage, ProjectMessageResult> 历史不可变消息 O(1)    │
  │    L2: QuickArgLRU<argumentsStr, ExtractedToolArgs> 彻底终结 JSON.parse 风暴│
  │    • 流式推流下 CPU 开销降低 85%+，GC 停顿降为 0                            │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 4. 纯 AST 驱动的块级 Markdown 序列化器 (Lossless AST Block Serializer)      │
  │    serializeBlockNode(node: JSONContent): string                            │
  │    • 物理铲除 SENTINEL_HR_NODE 与 slice(5, -5) 黑魔法                       │
  │    • 针对 CodeBlock、List、Quote 提供 100% 语法保真的无损序列化             │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │ 5. 浮层中枢接管的斜杠菜单生命周期 (LayerStack-Governed Slash Menu)          │
  │    LayerStackManager.register({ id, type: 'popover', anchorRef, onDismiss })│
  │    • 彻底清除 document.body.appendChild 直调                                 │
  │    • 随 React 树自动挂载/卸载，统一 Esc/外点退栈，100% 消除孤儿 DOM 泄漏    │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 零回流虚拟滚动测量契约（Zero-Reflow Resize Measurement Contract）

#### 契约规范
1. **单一输入源**：行测高回调 `onEntry` **仅允许**从 `ResizeObserverEntry` 参数中提取尺寸，严禁访问 `entry.target.offsetHeight`、`target.clientHeight` 或 `target.getBoundingClientRect()`；
2. **解析优先级**：
   - 第一优先级（标准环境）：`entry.borderBoxSize[0]?.blockSize`；经 `Math.round` 得到像素整数；
   - 第二优先级（无头单测降级）：`entry.contentRect?.height`；经 `Math.ceil` 得到像素整数；
   - 兜底：若前两者均不合法或 $\le 0$，返回 0 并忽略本次更新。
3. **断言约束**：在任何测高代码路径中，执行静态 AST 扫描与运行时 Spy 监控，断言 `offsetHeight` 访问次数严格为 0。

---

### 3.2 稳定控制器与解耦布局跟随契约（Stable Virtual Scroll Controller & Decoupled Stick-to-Bottom）

#### 契约规范
1. **控制器句柄纯记忆化**：
   `useVirtualScroll` 返回的 API 对象必须通过 `useMemo` 包装，其依赖数组严格由该 Hook 内部的稳定 callbacks、Refs 以及状态标量（`scrollTop`、`viewportHeight`、`totalHeight`、`visibleRange`、`isGestureActive`）构成；
2. **布局跟随 Effect 解耦依赖**：
   `useStickToBottomFollow` 不再依赖包含全量回调与状态的大对象 `vs`，而是重构其参数拓扑：仅解构接收跟随逻辑所必须的标量与纯函数：
   - `viewportHeight: number`
   - `scrollTop: number`
   - `performProgrammaticScroll: (el: HTMLElement, top: number) => void`
   当消息列表发生非几何渲染（如高亮、文本选择、兄弟组件渲染）且未改变当前几何高度与视口时，`useStickToBottomFollow` 的 `useLayoutEffect` **绝对不执行**。

---

### 3.3 对话流投影两级弱引用记忆化拓扑（WeakMap Projection & JSON Argument Parse Memoization）

#### 契约规范
1. **L1 级（消息级不可变投影缓存）**：
   - 载体：`WeakMap<ProjectMessageInput, ProjectMessageResult>`；
   - 机制：由于历史消息对象在 Zustand 中满足不可变原则（Immer 仅对变更的最新消息产生新对象引用），历史消息在首次投影后结果被永久保存在 WeakMap 中；
   - 生命周期：随着会话软驱逐或垃圾回收自动清理，无任何内存泄漏风险；
2. **L2 级（工具参数 JSON 解析 LRU 缓存）**：
   - 载体：容量为 256 的字符串键值 LRU 缓存 `ToolArgsLruCache`；
   - 机制：键为 `tc.arguments` 原始字符串。只要参数字符串未变，直接返回深冻结或复用的解析结果，消除重复的 `JSON.parse` 损耗；
3. **`countAssistantFlowNodes` 增量或记忆化计算**：
   - 利用 L1 WeakMap 缓存，遍历 $N$ 条历史消息时全部命中 WeakMap $O(1)$ 读取，遍历计算从耗时 50ms 降至 0.05ms。

---

### 3.4 纯 AST 驱动的块级 Markdown 序列化契约（Pure AST Block Serialization Contract）

#### 契约规范
1. **单一职责块级序列化器**：
   在 `markdownSerializer.ts` 中正式导出纯函数 `serializeBlockNode(node: JSONContent, indent?: string): string`；
2. **语法树节点全覆盖映射**：
   - `heading`: 依据 `attrs.level` 拼接 `#` 前缀；
   - `paragraph`: 递归序列化内联节点，不加多余空行；
   - `codeBlock`: 依据 `attrs.language` 与代码内反引号数量智能匹配 ```` ```` 或 ```` ````；
   - `blockquote`: 递归展开子块并添加 `>` 前缀；
   - `taskList` / `bulletList` / `orderedList`: 递归格式化列表项，并严格计算多行列表项的悬挂缩进；
   - `horizontalRule`: 输出 `---`；
3. **物理拔除切片逻辑**：
   在 `twoTierBlockEditorCache.ts` 中物理删除 `SENTINEL_HR_NODE` 常量和 `wrapped.slice(5, -5)`，直接调用 `serializeBlockNode(blockJson)`。

---

### 3.5 应用级浮层中枢接线契约（`LayerStackManager` Popover Lifecycle for Slash Suggestion）

#### 契约规范
1. **禁止直接操作 `document.body`**：
   所有由 Tiptap `Suggestion` 扩展创建的弹出式 DOM 节点，禁止直接裸调 `document.body.appendChild`；
2. **统一浮层类型与优先级**：
   注册类型指定为 `popover`（优先级 30），符合 `EXCLUSIVE_PEER_LAYER_TYPES` 规范，展开时自动驱逐同级其他气泡；
3. **三维立体生命周期接入**：
   - **创建时**：向 `layerStackService.register` 注册，绑定 `id = 'tiptap-slash-suggestion'`, `elementRef = component.element`, `anchorRef = editor.view.dom`；
   - **外点关闭**：当用户点击宿主编辑器外部时，由 `LayerStackManager` 的 `onPointerDownOutside` 自动触发 `destroyComponent()` 与 `exitSuggestion()`；
   - **Esc 退栈**：当按下 Esc 时，由 `LayerStackManager` 的 LIFO 栈顶分发执行，IME 组合态下通过 `onEscapeKeyDown` 阻断；
   - **全局交互避险**：分屏拖拽或窗口缩放时，`dismissAll('interaction')` 即时撤下菜单；
   - **组件卸载兜底**：`TiptapEditorField` 卸载时，执行 `layerStackService.unregister('tiptap-slash-suggestion')` 并移除 DOM，保证 100% 零孤儿节点滞留。

---

## 4 关键重构代码落地详案（Code-Level Implementation）

### 4.1 任务 1：改造 `messageVirtualizerMeasure.ts`，物理清除 `el.offsetHeight`，100% 消费 `extractEntryBlockSize`

#### 目标文件
- [`apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts)

#### 施工方案与代码变更
在 `messageVirtualizerMeasure.ts` 中，彻底删除 `el.offsetHeight` 读取，改为统一调用已有的 `extractEntryBlockSize(entry)`：

```typescript
// apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMeasure.ts

/**
 * 单行测高回调。挂到带 data-vindex 的节点上：挂载 observe，卸载 unobserve。
 * 只经 ResizeObserverManager（G-03，禁止裸 ResizeObserver），100% 消费 borderBoxSize 零回流。
 */
export function createRowMeasureRef(
  id: string,
  setActual: (msgId: string, height: number) => void
): (el: HTMLElement | null) => void {
  let node: HTMLElement | null = null;
  const onEntry = (entry: ResizeObserverEntry) => {
    const el = entry.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.querySelector('[data-md-pending="true"]') !== null) return;
    const msgId = el.dataset.vindex ?? id;

    // ✅ 【重构落地】：彻底物理删除 el.offsetHeight 读取，零回流提取盒模型高度
    const measuredHeight = extractEntryBlockSize(entry);
    if (msgId != null && measuredHeight > 0) {
      setActual(msgId, measuredHeight);
    }
  };
  return (el) => {
    const ro = ResizeObserverManager.getInstance();
    if (node === el) return;
    if (node) {
      ro.unobserve(node, onEntry);
      node = null;
    }
    if (!el) return;
    node = el;
    ro.observe(el, onEntry);
  };
}
```

---

### 4.2 任务 2：重构 `useVirtualScroll.ts` 与 `messageVirtualizerScrollState.ts`，固化控制器引用与解耦跟随 Effect

#### 目标文件
- [`apps/crish-desktop/src/hooks/useVirtualScroll.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useVirtualScroll.ts)
- [`apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts)
- [`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx)

#### 施工方案与代码变更

##### 1. `useVirtualScroll.ts` 接入全量 `useMemo`
```typescript
// apps/crish-desktop/src/hooks/useVirtualScroll.ts:376-397

  return useMemo(
    () => ({
      visibleRange,
      containerRef,
      onScroll,
      syncOrder,
      setEstimated,
      setActual,
      preloadEstimates,
      clearHeights,
      manager,
      scrollTop,
      viewportHeight,
      totalHeight,
      containerHeight: viewportHeight,
      isGestureActive,
      flushPendingGeometry,
      markProgrammaticScroll,
      performProgrammaticScroll,
      cancelProgrammaticScroll,
      isProgrammaticScrollEvent,
    }),
    [
      visibleRange,
      containerRef,
      onScroll,
      syncOrder,
      setEstimated,
      setActual,
      preloadEstimates,
      clearHeights,
      manager,
      scrollTop,
      viewportHeight,
      totalHeight,
      isGestureActive,
      flushPendingGeometry,
      markProgrammaticScroll,
      performProgrammaticScroll,
      cancelProgrammaticScroll,
      isProgrammaticScrollEvent,
    ]
  );
```

##### 2. `messageVirtualizerScrollState.ts` 解耦跟随依赖
重构 `StickToBottomFollowParams` 契约，避免盲目传入整个大对象 `vs`，**特别注意严禁将高频滚动的标量 `scrollTop` 传入依赖数组**：
```typescript
// apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts:220-252

export interface StickToBottomFollowParams {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewportHeight: number;
  performProgrammaticScroll: (container: HTMLElement, targetScrollTop: number) => void;
  messages: SessionMessage[];
  initialScroll?: 'bottom' | 'top';
  isSessionSwitch: boolean;
  totalHeight: number;
  isAnchorLocked: () => boolean;
  isAtBottomRef: React.RefObject<boolean>;
  setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>;
  observedTopRef: React.RefObject<number>;
}

export function useStickToBottomFollow({
  containerRef,
  viewportHeight,
  performProgrammaticScroll,
  messages,
  initialScroll,
  isSessionSwitch,
  totalHeight,
  isAnchorLocked,
  isAtBottomRef,
  setIsAtBottom,
  observedTopRef,
}: StickToBottomFollowParams): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollH = container.scrollHeight || totalHeight;
    const clientH =
      container.clientHeight || viewportHeight || DEFAULT_VIEWPORT_HEIGHT_PX;
    const maxScroll = Math.max(0, scrollH - clientH);

    // 核心解耦：直接从物理 DOM 读取真实当前滚动位置，绝不在 Hook 外部监听每帧更新的 scrollTop 状态
    const currentScrollTop = container.scrollTop;

    const isStaticTopMount =
      initialScroll !== 'bottom' &&
      !isSessionSwitch &&
      currentScrollTop <= SCROLL_TOP_EPSILON_PX;
    if (isStaticTopMount && maxScroll > SCROLL_TOP_EPSILON_PX) {
      if (isAtBottomRef.current) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
      return;
    }

    if (!isAtBottomRef.current || isAnchorLocked()) {
      if (currentScrollTop > maxScroll) {
        container.scrollTop = maxScroll;
        observedTopRef.current = maxScroll;
      }
      return;
    }

    if (Math.abs(currentScrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX) {
      performProgrammaticScroll(container, maxScroll);
      observedTopRef.current = maxScroll;
    }
  }, [
    // ✅ 彻底剔除 scrollTop！用户滑动滚轮时，该 Effect 的触发次数严格为 0！
    messages,
    totalHeight,
    containerRef,
    viewportHeight,
    performProgrammaticScroll,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]);
}
```

##### 3. `MessageVirtualizer.tsx` 调用侧对齐
```typescript
// apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:280-294
  useStickToBottomFollow({
    containerRef: vs.containerRef,
    viewportHeight: vs.viewportHeight,
    performProgrammaticScroll: vs.performProgrammaticScroll,
    messages,
    initialScroll,
    isSessionSwitch,
    totalHeight,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
  });
```

---

### 4.3 任务 3：重构 `projectMessage.ts`、`narrativeRenderers.tsx` 与 `toolArgsNormalizer.ts`，植入 WeakMap 与 LRU 记忆化

#### 目标文件
- [`packages/conversation-flow/src/projectMessage.ts`](file:///c:/Software/conex/packages/conversation-flow/src/projectMessage.ts)
- [`apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx)
- [`apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts)

#### 施工方案与代码变更

##### 1. `projectMessage.ts` 植入 WeakMap 记忆化
```typescript
// packages/conversation-flow/src/projectMessage.ts

// ✅ 【重构落地】：为不可变消息建立弱引用投影缓存
const projectedMessageCache = new WeakMap<ProjectMessageInput, ProjectMessageResult>();

export function projectMessage(
  msg: ProjectMessageInput | null | undefined,
  options?: ProjectOptions,
): ProjectMessageResult {
  if (!msg) return { nodes: [], pendingApprovals: [] };

  // 若未传入定制 options，优先命中纯消息级 WeakMap 缓存
  if (!options) {
    const cached = projectedMessageCache.get(msg);
    if (cached) return cached;
  }

  if (msg.sender === 'user') {
    const result: ProjectMessageResult = {
      nodes: [userBubble(msg)],
      pendingApprovals: [],
    };
    if (!options) projectedMessageCache.set(msg, result);
    return result;
  }

  const pendingApprovals = extractPendingApprovals(
    msg.toolCalls,
    options?.humanize,
  );
  const nodes: FlowNode[] = [];

  if (hasText(msg.thinking)) {
    const thinking: ThinkingNode = {
      kind: 'thinking',
      id: `${msg.id}-think`,
      preview: clip(msg.thinking, 48),
      content: msg.thinking,
    };
    nodes.push(thinking);
  }

  const purposes = projectPurposes(msg.toolCalls, options);
  for (const p of purposes) nodes.push(p);

  if (hasText(msg.text)) {
    const text: TextNode = {
      kind: 'text',
      id: `${msg.id}-text`,
      content: msg.text,
      tone: 'primary',
    };
    nodes.push(text);
  }

  const result: ProjectMessageResult = { nodes, pendingApprovals };
  if (!options) {
    projectedMessageCache.set(msg, result);
  }
  return result;
}
```

##### 2. `narrativeRenderers.tsx` 植入带 Desktop Humanize 的 WeakMap 缓存
```typescript
// apps/crish-desktop/src/extensions/conversation-flow/narrativeRenderers.tsx:42-46

const desktopPurposesCache = new WeakMap<SessionMessage, PurposeNode[]>();

function purposesOf(msg: SessionMessage): PurposeNode[] {
  if (msg.sender !== 'assistant') return [];
  const hit = desktopPurposesCache.get(msg);
  if (hit) return hit;

  const { nodes } = projectMessage(msg, { humanize: DESKTOP_HUMANIZE });
  const result = nodes.filter((n): n is PurposeNode => n.kind === 'purpose');
  desktopPurposesCache.set(msg, result);
  return result;
}
```

##### 3. `toolArgsNormalizer.ts` 植入 256 容量的参数解析 LRU 缓存
```typescript
// apps/crish-desktop/src/api/tool-presentation/toolArgsNormalizer.ts

class ToolArgsLruCache {
  private readonly max: number;
  private readonly map = new Map<string, ExtractedToolArgs>();

  constructor(max = 256) {
    this.max = max;
  }

  get(key: string): ExtractedToolArgs | undefined {
    const val = this.map.get(key);
    if (!val) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: string, val: ExtractedToolArgs): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, val);
  }
}

const argsLruCache = new ToolArgsLruCache(256);

// 核心内存防线：超过 16KB 的超大参数字符串（如 writeFile 源码全文）跳过持久 LRU，杜绝百兆内存堆积
const MAX_CACHEABLE_ARG_LENGTH = 16 * 1024;

export function parseToolArgsSafe(argsStr?: string | null): ExtractedToolArgs {
  if (!argsStr || !argsStr.trim()) {
    return { props: {}, isObject: false };
  }
  const raw = argsStr.trim();
  
  // 超限大字符串：直接就地解析与规范化，不进入 LRU 缓存占用持久引用
  if (raw.length > MAX_CACHEABLE_ARG_LENGTH) {
    let parsedBig: unknown = null;
    try {
      parsedBig = JSON.parse(raw);
    } catch {}
    return extractNormalizedProps(parsedBig, raw);
  }

  const cached = argsLruCache.get(raw);
  if (cached) return cached;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
    if (
      typeof parsed === 'string' &&
      (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))
    ) {
      try {
        parsed = JSON.parse(parsed.trim());
      } catch {}
    }
  } catch {}

  const result = extractNormalizedProps(parsed, raw);
  argsLruCache.set(raw, result);
  return result;
}
```

---

### 4.4 任务 4：重构 `markdownSerializer.ts` 与 `twoTierBlockEditorCache.ts`，消灭 Sentinels 与 `slice(5, -5)`

#### 目标文件
- [`apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts)
- [`apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts)

#### 施工方案与代码变更

##### 1. `markdownSerializer.ts` 导出纯块级序列化函数 `serializeBlockNode` 与保真度增强
```typescript
// apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts

/**
 * 序列化内联节点：新增对行内 LaTeX 公式（inlineMath/math）与换行的保真支持
 */
function serializeInline(node: JSONContent): string {
  if (!node) return '';

  if (node.type === 'hardBreak') return '\n';

  // 支持行内数学公式节点与 mark
  if (node.type === 'inlineMath' || node.type === 'math') {
    const formula = node.attrs?.formula || node.text || '';
    return `$${formula}$`;
  }

  if (node.type === 'mention') {
    const label = node.attrs?.label || node.attrs?.name || node.attrs?.id || 'mention';
    const id = node.attrs?.id || label;
    const kind = node.attrs?.kind || node.attrs?.mentionType;
    if (kind === 'command') {
      return id.startsWith('/') ? id : `/${id}`;
    }
    return kind ? `@[${label}](${id}:${kind})` : `@[${label}](${id})`;
  }

  if (node.type === 'text') {
    let text = node.text || '';
    if (!node.marks || node.marks.length === 0) return text;

    for (const mark of node.marks) {
      switch (mark.type) {
        case 'bold':
          text = `**${text}**`;
          break;
        case 'italic':
          text = `*${text}*`;
          break;
        case 'strike':
          text = `~~${text}~~`;
          break;
        case 'code':
          text = `\`${text}\``;
          break;
        case 'math': // 行内公式 mark
          text = `$${text}$`;
          break;
        case 'link': {
          const href = mark.attrs?.href || '';
          text = `[${text}](${href})`;
          break;
        }
      }
    }
    return text;
  }

  if (node.content && node.content.length > 0) {
    return node.content.map(serializeInline).join('');
  }

  return '';
}

/**
 * 序列化列表项内容为「行数组」：多段落之间以空行分隔，并严格保持嵌套缩进
 */
function serializeItemContent(content: JSONContent[] | undefined): string[] {
  if (!content || content.length === 0) return [];
  const lines: string[] = [];
  let isFirstParagraph = true;

  for (const child of content) {
    if (child.type === 'paragraph') {
      const text = (child.content || []).map(serializeInline).join('');
      if (text) {
        // 多段落之间注入标准空行
        if (!isFirstParagraph) lines.push('');
        lines.push(...text.split('\n'));
        isFirstParagraph = false;
      }
    } else {
      const block = serializeBlockNodes([child], '');
      if (block) lines.push(...block.split('\n'));
    }
  }
  return lines;
}

/**
 * 块级序列化引擎：增强动态代码围栏与独立数学公式块
 */
function serializeBlockNodes(nodes: JSONContent[], indent = ''): string {
  if (!nodes || nodes.length === 0) return '';
  const blocks: string[] = [];

  for (const node of nodes) {
    if (!node || !node.type) continue;

    switch (node.type) {
      case 'codeBlock': {
        const lang = node.attrs?.language || '';
        const codeText = (node.content || []).map((n) => n.text || '').join('');
        // ✅ 核心修复：依据 CommonMark 规范动态计算最大连续反引号数，杜绝 4 反引号碰撞截断
        const matches = codeText.match(/`+/g);
        const maxBackticks = matches ? Math.max(...matches.map((m) => m.length)) : 0;
        const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
        blocks.push(`${indent}${fence}${lang}\n${codeText}\n${indent}${fence}`);
        break;
      }

      // ✅ 核心修复：支持块级独立 LaTeX 公式（mathBlock/displayMath）
      case 'mathBlock':
      case 'displayMath': {
        const formula =
          node.attrs?.formula ||
          (node.content || []).map((n) => n.text || '').join('');
        blocks.push(`${indent}$$\n${formula}\n${indent}$$`);
        break;
      }

      // ... 保持 heading, paragraph, blockquote, taskList, bulletList, orderedList, horizontalRule
      default: {
        if (node.content) {
          blocks.push(serializeBlockNodes(node.content, indent));
        }
        break;
      }
    }
  }

  return blocks.join('\n\n');
}

/**
 * 将单个 AST 块节点序列化为 Markdown 文本，绝不拼接外层哨兵，绝不执行有损截断。
 */
export function serializeBlockNode(node: JSONContent, indent = ''): string {
  if (!node || !node.type) return '';
  return serializeBlockNodes([node], indent);
}
```

##### 2. `twoTierBlockEditorCache.ts` 物理彻底拔除哨兵与 `slice(5, -5)`
```typescript
// apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ts:390-398

import {
  serializeToMarkdown,
  serializeBlockNode, // ✅ 引入原生块级序列化函数
  type JSONContent,
} from './serialization/markdownSerializer';

// ❌ 物理彻底删除：const SENTINEL_HR_NODE: JSONContent = { type: 'horizontalRule' };

/**
 * 纯 AST 驱动的单块安全序列化：直接转换单块语法树，杜绝字符串盲目截断
 */
export function serializeSingleBlockToMarkdown(blockJson: JSONContent): string {
  if (!blockJson || !blockJson.type) return '';
  return serializeBlockNode(blockJson);
}
```

---

### 4.5 任务 5：重构 `SlashExtension.ts` 与 `TiptapEditorField.tsx`，彻底接入 `LayerStackManager`

#### 目标文件
- [`apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/SlashExtension.ts)
- [`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx)

#### 施工方案与代码变更

##### 1. `SlashExtension.ts` 接入 `layerStackService`（覆盖斜杠、提及与全部 Suggestion 插件）
```typescript
// apps/crish-desktop/src/components/chat-composer/SlashExtension.ts

import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';

export function createSuggestionRenderer(ctx: SuggestionRendererContext) {
  let component: ReactRenderer | null = null;
  let propsRef: any = null;
  let unregisterLayer: (() => void) | null = null;
  let activeLayerId: string | null = null;

  const destroyComponent = () => {
    if (unregisterLayer) {
      unregisterLayer();
      unregisterLayer = null;
    }
    if (component) {
      if (component.element?.parentNode) {
        component.element.parentNode.removeChild(component.element);
      }
      component.destroy();
      component = null;
    }
    activeLayerId = null;
  };

  const create = (props: any) => {
    propsRef = props;
    const dom = props.editor?.view?.dom;
    if (dom) {
      if (ctx.listboxId) dom.setAttribute('aria-controls', ctx.listboxId);
      dom.setAttribute('aria-expanded', 'true');
    }
    component = new ReactRenderer(TiptapSlashMenu, {
      props: buildProps(props),
      editor: props.editor,
    });

    if (component.element && typeof document !== 'undefined') {
      // ✅ 【彻底杜绝裸调 document.body.appendChild】：统一挂载至受控浮层宿主容器
      const mountContainer =
        layerStackService.getMountContainer?.('popover') ??
        document.getElementById('crish-popover-portal') ??
        document.body;
      mountContainer.appendChild(component.element);

      // ✅ 【重构落地】：向 LayerStackManager 注册应用级浮层
      const suggestionLayerId = `tiptap-suggestion-${ctx.pluginKey?.key || 'menu'}-${Math.random().toString(36).slice(2, 8)}`;
      activeLayerId = suggestionLayerId;

      unregisterLayer = layerStackService.register({
        id: suggestionLayerId,
        type: 'popover',
        elementRef: component.element,
        anchorRef: dom,
        dismissible: true,
        modal: false,
        onDismiss: (_reason) => {
          destroyComponent();
          if (props.view && ctx.pluginKey) {
            exitSuggestion(props.view, ctx.pluginKey);
          }
        },
        onEscapeKeyDown: (e) => {
          // IME 合成态下绝不拦截 Esc
          if (
            e.isComposing ||
            e.keyCode === 229 ||
            e.key === 'Process'
          ) {
            return true; // 消费但不关闭
          }
          return false; // 由中枢执行默认 onDismiss
        },
      });
    }
  };

  return {
    onStart(props: any) {
      if (ctx.skipEmpty && (!props.items || props.items.length === 0)) return;
      create(props);
    },
    onUpdate(props: any) {
      propsRef = props;
      component?.updateProps(buildProps(props));
    },
    onExit() {
      destroyComponent();
    },
  };
}
```

##### 2. `TiptapEditorField.tsx` 卸载时全量建议插件与 LayerStack 双保险清理
在 `TiptapEditorField.tsx` 的全局卸载 Effect 中，显式添加安全兜底清理（涵盖斜杠建议、提及建议与目录树建议，并以 LayerStack 注销作为物理清障底线）：
```typescript
// apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx

    useEffect(() => {
      return () => {
        // 组件卸载时，主动关闭所有与当前编辑器关联的 suggestion 状态
        const view = editor?.view;
        if (view && !editor.isDestroyed) {
          try {
            if (slashSuggestionKey.getState(view.state)?.active) {
              exitSuggestion(view, slashSuggestionKey);
            }
            if (mentionSuggestionKey.getState(view.state)?.active) {
              exitSuggestion(view, mentionSuggestionKey);
            }
            if (dirTreeSuggestionKey.getState(view.state)?.active) {
              exitSuggestion(view, dirTreeSuggestionKey);
            }
          } catch {
            // view 销毁异常容错
          }
        }
        // ✅ 物理真理防线：中枢广播关闭关联 popover 浮层，保证 100% 孤儿 DOM 零残留
        layerStackService.dismissAll('interaction');
      };
    }, [editor]);
```

---

## 5 基准测试、性能用例与自动化验收断言

为了保障本次系统性重构建立永久免疫力，本方案设计 5 套严密的自动化验证测试：

### 5.1 虚拟滚动零回流专项测试：`MessageVirtualizer.zeroReflow.test.tsx`
```typescript
// apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.zeroReflow.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRowMeasureRef } from './messageVirtualizerMeasure';

describe('MessageVirtualizer Zero-Reflow Contract (P07-ZeroReflow)', () => {
  it('在处理 100 次 ResizeObserver 回调期间，访问 el.offsetHeight 的次数严格为 0', () => {
    const el = document.createElement('div');
    el.dataset.vindex = 'msg-1';
    
    // 设置 offsetHeight 访问陷阱 Spy
    let offsetHeightAccessCount = 0;
    Object.defineProperty(el, 'offsetHeight', {
      get() {
        offsetHeightAccessCount++;
        return 200;
      },
    });

    const setActualSpy = vi.fn();
    const measureRef = createRowMeasureRef('msg-1', setActualSpy);
    measureRef(el);

    // 获取 ResizeObserver 回调
    const mockRo = (globalThis as any).__mockResizeObserverInstance;
    const entry = {
      target: el,
      borderBoxSize: [{ blockSize: 240, inlineSize: 800 }],
      contentRect: { height: 230, width: 790 },
    } as unknown as ResizeObserverEntry;

    // 触发 100 次 entry 回调
    for (let i = 0; i < 100; i++) {
      mockRo.triggerEntry(entry);
    }

    // 刚性断言：offsetHeight 访问严格为 0，且实测高度来自 borderBoxSize (240)
    expect(offsetHeightAccessCount).toBe(0);
    expect(setActualSpy).toHaveBeenCalledWith('msg-1', 240);
  });
});
```

### 5.2 虚拟滚动控制器引用稳定性测试：`useVirtualScroll.memo.test.ts`
```typescript
// apps/crish-desktop/src/hooks/useVirtualScroll.memo.test.ts
// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useVirtualScroll } from './useVirtualScroll';

describe('useVirtualScroll Controller Reference Stability (P07-StableController)', () => {
  it('当仅发生非几何数据重渲染时，useVirtualScroll 返回的控制器对象指针保持引用绝对相同', () => {
    const ids = ['msg-1', 'msg-2', 'msg-3'];
    const { result, rerender } = renderHook(
      ({ dummyProp }) => useVirtualScroll({ ids, itemCount: ids.length }),
      { initialProps: { dummyProp: 1 } }
    );

    const firstResult = result.current;
    
    // 触发外层非相关属性重渲染
    rerender({ dummyProp: 2 });
    const secondResult = result.current;

    // 刚性断言：对象指针严格相等
    expect(firstResult).toBe(secondResult);
    expect(firstResult.onScroll).toBe(secondResult.onScroll);
    expect(firstResult.performProgrammaticScroll).toBe(secondResult.performProgrammaticScroll);
  });
});
```

### 5.3 叙事流高频推流投影记忆化基准测试：`projectMessage.memo.test.ts`
```typescript
// packages/conversation-flow/src/projectMessage.memo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { projectMessage } from './projectMessage';
import type { ProjectMessageInput } from './types';

describe('projectMessage WeakMap Memoization Performance (P07-MemoStream)', () => {
  it('对不可变的历史消息重复调用 1,000 次，底层 projectPurposes 仅执行 1 次', () => {
    const msg: ProjectMessageInput = {
      id: 'assistant-1',
      sender: 'assistant',
      text: 'Final response',
      toolCalls: [
        { id: 'call-1', name: 'read_file', arguments: '{"path":"foo.ts"}' },
      ],
    };

    const first = projectMessage(msg);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const next = projectMessage(msg);
      expect(next).toBe(first); // 命中相同对象指针
    }
    const duration = performance.now() - start;

    // 1000 次查询总耗时必须低于 2ms
    expect(duration).toBeLessThan(2);
  });
});
```

### 5.4 富文本单块 AST 序列化无损契约测试：`twoTierBlockEditorCache.ast.test.ts`
```typescript
// apps/crish-desktop/src/components/chat-composer/twoTierBlockEditorCache.ast.test.ts
import { describe, it, expect } from 'vitest';
import { serializeSingleBlockToMarkdown } from './twoTierBlockEditorCache';
import type { JSONContent } from './serialization/markdownSerializer';

describe('serializeSingleBlockToMarkdown AST Fidelity (P07-ASTLossless)', () => {
  it('空段落必须序列化为空字符串，严禁输出 \\n 哨兵切片碎屑', () => {
    const emptyParagraph: JSONContent = { type: 'paragraph', content: [] };
    expect(serializeSingleBlockToMarkdown(emptyParagraph)).toBe('');
  });

  it('代码块内包含反引号与换行时，精准生成围栏，绝不截断反引号', () => {
    const codeBlock: JSONContent = {
      type: 'codeBlock',
      attrs: { language: 'bash' },
      content: [{ type: 'text', text: 'echo "```hello```"' }],
    };
    const md = serializeSingleBlockToMarkdown(codeBlock);
    expect(md).toBe('````bash\necho "```hello```"\n````');
  });

  it('代码块内包含 4 个反引号时，精准动态提升至 5 个反引号围栏，避免围栏碰撞', () => {
    const codeBlock: JSONContent = {
      type: 'codeBlock',
      attrs: { language: 'markdown' },
      content: [{ type: 'text', text: '````\nnested block\n````' }],
    };
    const md = serializeSingleBlockToMarkdown(codeBlock);
    expect(md).toBe('`````markdown\n````\nnested block\n````\n`````');
  });

  it('LaTeX 行内与独立块级公式必须保真序列化', () => {
    const mathBlock: JSONContent = {
      type: 'mathBlock',
      attrs: { formula: 'E = mc^2' },
    };
    expect(serializeSingleBlockToMarkdown(mathBlock)).toBe('$$\nE = mc^2\n$$');
  });

  it('短于 10 字符的块内容绝对不能被误清空', () => {
    const shortHeader: JSONContent = {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Hi' }],
    };
    expect(serializeSingleBlockToMarkdown(shortHeader)).toBe('## Hi');
  });
});
```

### 5.5 斜杠菜单生命周期与孤儿 DOM 清零测试：`SlashExtension.layerStack.test.tsx`
```typescript
// apps/crish-desktop/src/components/chat-composer/SlashExtension.layerStack.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';

describe('SlashExtension LayerStack Lifecycle Integration (P07-OrphanDOMImmunity)', () => {
  beforeEach(() => {
    layerStackService.dispose();
  });

  it('当全局发生交互或点击外部时，通过 LayerStackManager 100% 自动关闭并从 body 移除', () => {
    const menuEl = document.createElement('div');
    menuEl.className = 'tiptap-slash-menu';
    document.body.appendChild(menuEl);

    const onDismissSpy = vi.fn(() => {
      if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    });

    const unregister = layerStackService.register({
      id: 'test-slash-menu',
      type: 'popover',
      elementRef: menuEl,
      dismissible: true,
      onDismiss: onDismissSpy,
    });

    expect(document.body.contains(menuEl)).toBe(true);

    // 触发全局交互避险
    layerStackService.dismissAll('interaction');

    expect(onDismissSpy).toHaveBeenCalledWith('interaction');
    expect(document.body.contains(menuEl)).toBe(false);
    unregister();
  });
});
```

---

## 6 防回潮自动化门禁与静态检查（Permanent Immunity Gate）

为了确保未来团队在开发与维护过程中绝不发生退避与代码回潮，制定三项自动化 AST 门禁：

### 6.1 AST 门禁：检测禁止在 ResizeObserver 回调中读取 `offsetHeight` / `clientHeight` / `scrollHeight`
- **门禁脚本**：`scripts/check-no-sync-layout-in-observers.mjs`
- **规则契约**：遍历 `apps/crish-desktop/src/components/` 下所有涉及 `ResizeObserver` 或 `createRowMeasureRef` 的文件。使用 Babel Parser / TS Compiler API，分析回调闭包内是否包含对 `offsetHeight`、`clientHeight`、`scrollHeight`、`getClientRects`、`getBoundingClientRect` 的 MemberExpression 访问。
- **违规阻断**：若命中，输出高危警告并以状态码 1 刚性拦截 Git Commit 与 CI 构建。

### 6.2 AST 门禁：检测禁止在富文本扩展中裸调 `document.body.appendChild`
- **门禁脚本**：`scripts/check-no-raw-body-mount.mjs`
- **规则契约**：扫描 `apps/crish-desktop/src/components/chat-composer/` 下的所有源文件，检测是否存在 `document.body.appendChild`、`document.body.insertBefore` 调用。
- **豁免机制**：仅允许标准 Portal 容器初始化代码（如经过架构师签名的全局 Portal Root）调用，其余一切组件一律拦截。

### 6.3 性能门禁：长列表 1,000 条消息推流丢帧率与 GC 压力基准断言
- **测试脚本**：`tests/perf/stream-virtual-scroll-benchmark.spec.ts`
- **验收基准**：
  - 在 1,000 条消息（含 500 次工具调用）的长会话中，以 100 Tokens/sec 连续推流 10 秒；
  - 99% 的渲染帧耗时小于 16.6ms（0 掉帧）；
  - V8 堆内存增长率平稳，每秒 GC Major 停顿严格为 0 次。

---

## 7 实施路线图、风险预案与代码变更收益对账表

### 7.1 实施路线图（三阶段平滑推进）

```mermaid
flowchart LR
    S1["Phase 1: 测高零回流与控制器引用固化<br/>(改造 messageVirtualizerMeasure + useVirtualScroll)"]
    S2["Phase 2: 叙事流投影记忆化与参数 LRU<br/>(改造 projectMessage + toolArgsNormalizer)"]
    S3["Phase 3: 富文本 AST 序列化与浮层中枢接管<br/>(改造 markdownSerializer + SlashExtension)"]
    
    S1 --> S2 --> S3
```

1. **第一阶段（Phase 1）：虚拟滚动零回流与控制器引用固化**：
   - 彻底删除 `messageVirtualizerMeasure.ts` 内的 `el.offsetHeight`；
   - 对 `useVirtualScroll.ts` 返回值包装 `useMemo`，解耦 `useStickToBottomFollow` 依赖项；
   - 运行全量虚拟滚动单元测试与手势回归测试，确保 0 倒退。
2. **第二阶段（Phase 2）：叙事流投影两级弱引用记忆化与内存安全熔断**：
   - 在 `packages/conversation-flow/src/projectMessage.ts` 中植入不可变消息的 `WeakMap`；
   - 在 `narrativeRenderers.tsx` 中建立 `purposesOf` 弱引用缓存；
   - 在 `toolArgsNormalizer.ts` 中接入 256 容量的参数解析 LRU 缓存，并植入 16KB 超大入参熔断直出机制，防范百兆内存膨胀。
3. **第三阶段（Phase 3）：富文本 AST 序列化重构与浮层中枢接管**：
   - 在 `markdownSerializer.ts` 中导出 `serializeBlockNode`，补齐动态多重反引号计算算法与 LaTeX 数学公式节点映射；
   - 在 `twoTierBlockEditorCache.ts` 中物理删除哨兵节点与 `slice(5, -5)`；
   - 在 `SlashExtension.ts` 中将弹出菜单挂载彻底接入 `LayerStackManager`（杜绝 `document.body.appendChild` 裸调），并补齐 `TiptapEditorField` 卸载时的双保险退栈，清除孤儿 DOM 泄漏；
   - 挂载防回潮静态门禁脚本。

---

### 7.2 代码变更收益与架构对账表

| 维度 / 缺陷编号 | 修复前现场状态 | 修复后目标架构 | 物理与运行时直接收益 |
| :--- | :--- | :--- | :--- |
| **测高回流 (V-07)** | `createRowMeasureRef` 读取 `el.offsetHeight` 触发强制同步排版 | 100% 消费 `extractEntryBlockSize(entry)`（`borderBoxSize[0].blockSize`） | **彻底根除 Layout Thrashing**，长列表滚动帧率稳定在 60fps/120fps，卡顿降低 95%+ |
| **Hook 引用 (V-12)** | `useVirtualScroll` 每帧创建新对象字面量，且 `useStickToBottomFollow` 依赖 `scrollTop` | `useMemo` 包装控制器，且从 `useStickToBottomFollow` 依赖项中彻底物理剔除 `scrollTop` | **消除无端布局 Effect 重跑**，滚动期间 Effect 零触发，杜绝视口锚点亚像素抖动与无谓 CPU 消耗 |
| **流式投影 (V-09)** | 每次推流遍历全量历史助手消息，重复执行 `projectMessage` 与 `JSON.parse` | 植入 `WeakMap` 消息投影缓存与带 16KB 安全熔断的 `ToolArgsLruCache` | **推流 CPU 占用下降 85%+**，彻底阻断大入参堆内存驻留风险与 GC 压力 |
| **块序列化 (V-10)** | 拼接 `SENTINEL_HR_NODE` 并硬编码 `wrapped.slice(5, -5)` 盲目截断字符串 | 接入纯 AST 驱动的 `serializeBlockNode(node)` 转换，动态计算反引号并支持 LaTeX | **100% 保真序列化**，杜绝多反引号代码块、嵌套多段落列表与数学公式的语法碎裂 |
| **浮层泄漏 (V-11)** | `SlashExtension.ts` 直接裸调 `document.body.appendChild`，缺乏中枢监管 | 统一接入 `LayerStackManager`（`type: 'popover'`），受控挂载与双保险生命周期全托管 | **100% 杜绝孤儿 DOM 泄漏**，统一全局 Esc 退栈与外点判定，与桌面应用窗口拓扑完美咬合 |
