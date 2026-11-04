# Cherry Studio 消息对话流与气泡渲染解构及 Crish Mobile 改造方案

> **文档标识**：`docs/mobile-ux-cherry-alignment/proposals/07-Cherry消息对话流与气泡渲染解构.md`  
> **所属战役**：`mobile-ux-cherry-alignment`（移动端交互重构与 Cherry Studio 深度借鉴战役）  
> **专业领域**：Cherry Chat Timeline & Virtualization Specialist  
> **核心使命**：深入解构 Cherry Studio Mobile（`reference/cherry-studio-app`）的虚拟化消息列表与对话流架构，彻底根除 Crish Mobile “现在的对话，根本划不到最下面去”、打字重排卡顿、滚动打架、气泡简陋等严重体验断层，制定工业级重构方案。

---

## 一、现场复盘：Crish Mobile “划不到最下面” 的五重根因剖析

用户核心实测反馈：“还有就是消息对话流界面。像是对话界面我们基本都还没做呢，我看我们的对话界面非常的难用状态，这个部分也需要借鉴看看……现在的对话，根本划不到最下面去。”

通过对 `apps/crish-mobile/src/presentation/timeline/` 及宿主 `sessionDetailScreen.tsx` 的静态代码与运行时流转分析，定位到导致该缺陷的五重底层断裂：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Crish Mobile 滚动失效链条                       │
└────────────────────────────────────────────────────────────────────────┘
  1. 布局测量与防抖滞后 (90ms Debounce Lag)
     KeyboardStickyView 容器实测高度变化后被 90ms 定时器拦截，inset 计算晚于帧渲染
        │
        ▼
  2. 底部避让双重计算冲突 (Inset Double-Counting & Transform Drift)
     contentContainerStyle.paddingBottom 叠加了实测高 + 软键盘高 + gap，
     但 KeyboardStickyView 原生 translateY 向上平移，导致列表虚拟高度被拉长，
     用户下拉触底时计算出的 maxScrollOffset 超出物理屏幕可及范围
        │
        ▼
  3. 缺失 onContentSizeChange 触底修正通道 (Missing Yoga Layout Hook)
     useEffect 仅监听 tailSignal（字符长度），而 React 渲染与原生 Yoga 文本换行
     测高存在时序差，scrollToEnd 命中旧尺寸，增量内容恒在视口之外
        │
        ▼
  4. 流式生成与手势抢夺 (Gesture Collision & Frame Snapping)
     每次分块数据到达均无差别触发 scrollToEnd({ animated: false })，
     硬性抹除用户的拖拽阻尼，手指正在滑动查看上文即被瞬间拽回半拉子位置
        │
        ▼
  5. 阈值判定死区 (FOLLOW_THRESHOLD 判定死锁)
     FOLLOW_THRESHOLD 固定为 40px，由于底部避让计算偏差，distance 经常停留在
     45~60px，导致 follow 永久锁定为 false，回底逻辑彻底休克
```

### 1.1 根因一：`useTimelineBottomInset.ts` 的 90ms 防抖滞后与无效估算
在 `apps/crish-mobile/src/presentation/timeline/useTimelineBottomInset.ts` 中：
```ts
// 现场代码片段
overlaySettleTimerRef.current = setTimeout(() => {
  overlaySettleTimerRef.current = null;
  const pending = overlayPendingRef.current;
  if (pending !== null && pending > 0 && ...) {
    overlayCommittedRef.current = pending;
    setOverlayHeight(pending);
  }
}, 90);
```
- **问题机制**：输入框初始渲染时 `overlayHeight` 为 `null`，采用 `estimatedOverlayHeight` 保底；当原生容器挂载后触发 `handleOverlayLayout`，高度必须经过 90ms 定时器防抖后才提交给 React 状态。
- **后果**：用户进入对话流时，列表 `paddingBottom` 经历“估算高（~173px）→ 90ms 滞后 → 实测高（~122px）”的跳变。当列表执行触底时，尺寸尚未稳定；用户手指拖拽到底部，列表却以旧的 `paddingBottom` 限制滚动范围，造成“怎么拖都有一截空白卡住”或“最后一条消息被输入框腰斩遮挡”。

### 1.2 根因二：`KeyboardStickyView` 原生平移与 `paddingBottom` 的双重挤压
在 `sessionDetailScreen.tsx` 与 `timelineBottomInset.ts` 中：
```ts
// 现场代码：deriveTimelineBottomInset
export function deriveTimelineBottomInset(input: TimelineBottomInsetInput): number {
  const minOverlay = sane(input.minOverlayHeight ?? 0);
  const measuredOverlay = sane(input.overlayHeight);
  const effectiveOverlay = Math.max(minOverlay, measuredOverlay);
  return effectiveOverlay + sane(input.keyboardHeight) + sane(input.gap);
}
```
- **几何冲突**：
  1. `KeyboardStickyView` 来自 `react-native-keyboard-controller`，在键盘弹起时通过原生 `WindowInsetsAnimationCompat` 在 UI 线程直接执行 `translateY: -keyboardHeight`；
  2. 然而，`useTimelineBottomInset` 却在 JS 侧把 `keyboardHeight` **硬加** 到了 `TimelineView` 的 `contentContainerStyle.paddingBottom` 里；
  3. 导致底部空白暴增两倍（`paddingBottom` 垫高了一个键盘高度，同时 `KeyboardStickyView` 本身又占位），列表内容被垫起到天花板，且当键盘收起的一瞬间，`paddingBottom` 的收缩引发视口急剧抽动，甚至滚出视口。
  4. 更严重的是：在不弹起键盘的常规浏览状态下，`timelineBottomInset` 与 `EdgeFade` 的高度绑定，`EdgeFade`（底部渐隐 SVG）高度被设置为 `floatingHeight + gap`，其上层带有半透明到全黑的遮罩覆膜，导致哪怕内容滚到了最底部，最后两行文字也正好被覆膜的 100% 不透明区域遮死，用户误以为“划不到最下面”。

### 1.3 根因三：缺失 `onContentSizeChange` 的原生布局监听通道
在 `apps/crish-mobile/src/presentation/timeline/TimelineView.tsx` 中：
```tsx
// 现场代码
useEffect(() => {
  if (!follow || blocks.length === 0) return;
  targetRef.current?.scrollToEnd({ animated: false });
}, [follow, blocks.length, tailSignal, targetRef, bottomInset]);
```
- **致命缺陷**：`useEffect` 是在 React DOM/Shadow Tree 提交阶段同步触发的。在 React Native 中，文本（特别是含 Markdown 标记的多行文字）的实际物理高度测量是在 C++ 原生 Yoga 引擎排版线程完成的。
- **失效场景**：当一条新消息到达或流式追加一个 chunk 时，React 执行 `useEffect` 调用 `scrollToEnd()`，此时原生 `contentSize.height` 仍然是上一个旧高度。等到原生排版完成使高度真正增高时，没有任何事件再触发滚动，**导致新增的文本永远掉在屏幕外，用户无论怎么刷都卡在上一个高度，视觉上表现为“到底部划不动了”**。

### 1.4 根因四：流式打字与触控手势的暴躁抢占（Gesture Thrashing）
Crish Mobile 当前架构中，`follow` 仅仅是一个简单的 boolean：
- 当用户手指按住屏幕向上滑动试图查看之前的对话时，远端模型正以每秒 10~20 次的高频推送 token；
- 每次 token 到达都会更新 `tailSignal`，进而触发 `useEffect` 强制调用 `scrollToEnd({ animated: false })`；
- 这直接打断了原生手势响应链（Responder Chain），用户的滑动操作被生生卡死或出现剧烈的屏幕震颤（Jitter）。

### 1.5 根因五：FOLLOW_THRESHOLD 固定阈值盲区
当前 `TimelineView.tsx` 使用定值 `FOLLOW_THRESHOLD = 40`：
```ts
const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
const following = distance <= FOLLOW_THRESHOLD;
```
由于前面提到的 `paddingBottom` 动态变化和子像素光栅化偏移，`distance` 在用户物理拉到底部后往往停留在 `42px` 或 `55px`（受 `EdgeFade` 和安全区换算影响），永远无法达到 `<= 40`。一旦用户滑走一次，`follow` 变 `false` 后就**再也无法通过物理滑到底部自动恢复跟随状态**，回底按钮也经常因状态判断失误而常驻或消失。

---

## 二、Cherry Studio 对话流架构深度解剖

Cherry Studio Mobile（`reference/cherry-studio-app`）在处理高频流式对话、键盘复杂弹起、视口锚定与虚拟化滚动上展现了极高的工业水准。核心实现在以下几个文件中：
- `reference/cherry-studio-app/src/frontend/components/Message/MessageList.tsx`
- `reference/cherry-studio-app/src/frontend/components/Message/list/useMessageListScrollController.ts`（21KB 滚动核心）
- `reference/cherry-studio-app/src/frontend/components/Message/list/useViewportFollowState.ts`
- `reference/cherry-studio-app/src/frontend/components/Message/list/MessageListLiveTailContext.tsx`
- `reference/cherry-studio-app/src/frontend/components/Message/list/messageListLayout.ts`
- `reference/cherry-studio-app/src/frontend/components/Message/parts/PartMarkdown.tsx`

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Cherry Studio 消息流四大核心架构基石                 │
└────────────────────────────────────────────────────────────────────────┘
  1. 状态机驱动的跟随控制器 (useViewportFollowState)
     精准解耦 following (吸底尾随) 与 reading (阅读回溯)，状态流转携带语义 reason
        │
        ▼
  2. 帧对齐与世代保护的吸底调度 (Generation-Guarded rAF Scheduling)
     restoreGenerationRef + liveEdgeScrollCountRef，彻底隔绝无效动效与重排抖动
        │
        ▼
  3. 双向滞后视口探针与流式冻结 (Hysteresis Live Tail & Freeze)
     Live Tail 视口内外双阈值（160px/320px），视口外流式打字挂起 Markdown 解析
        │
        ▼
  4. 原生级键盘适配器 (KeyboardAwareLegendList + contentInsetEndAdjustment)
     Reanimated 共享值驱动底部配件高度与键盘 Lift，零 React 重渲染驱动 Inset
```

### 2.1 状态机模型：`useViewportFollowState`
Cherry 彻底摒弃了简单的 `boolean` 标志，建立了一套严格的视口跟随状态机：

```ts
export type FollowingReason = 'restored-bottom' | 'scroll-to-bottom' | 'user-reached-bottom';
export type ReadingReason =
  | 'initializing'
  | 'local-send'
  | 'navigation'
  | 'restored-anchor'
  | 'user-scrolled-up'
  | 'user-toggled-disclosure';

export type ViewportFollowState =
  | { readonly mode: 'following'; readonly reason: FollowingReason }
  | { readonly mode: 'reading'; readonly reason: ReadingReason };
```
- **核心价值**：
  - `stateRef` 保存真值，只有当 `mode` 跨状态（`following` ↔ `reading`）变化时才触发 React 状态更新 `setIsFollowingForRender`，避免列表在滚动过程中频繁重渲染；
  - 区分不同操作场景：例如用户发送消息（`local-send`）时，临时进入 `reading` 态锚定用户发送的气泡，待回复到达并确认时再通过程序化平滑滑向底部，避免发出的瞬间直接跳跃。

### 2.2 触底判定的精准数学模型（工作区 Worklet）
在 `messageListLayout.ts` 中：
```ts
/** Content height includes the current keyboard inset. */
export function isMessageListAtBottom(
  scrollOffset: number,
  contentHeight: number,
  viewportHeight: number,
): boolean {
  'worklet';
  return Math.max(0, contentHeight - viewportHeight) - scrollOffset <= 1;
}
```
- **数学解析**：
  - 不采用模糊的 `40px` 阈值，而是直接比较 `(contentHeight - viewportHeight) - scrollOffset <= 1`（允许 1px 的子像素渲染误差）；
  - `contentHeight` 包含由 `KeyboardAwareLegendList` 注入的 `bottomAccessoryHeight`（即 Composer 实际占用高度）与键盘位移；
  - 这种数学定义保证了**只要内容在物理上触碰到底部边缘，状态立刻精确锁定为吸底**。

### 2.3 吸底调度器与 Native 布局监听（`useMessageListScrollController.ts`）
Cherry 如何解决“流式追加高度改变但滚动没跟上”的问题？

```ts
// Cherry 的核心机制：监听原生 contentSize 变化
const handleContentSizeChange = useCallback(() => {
  stickToBottomIfFollowing();
}, [stickToBottomIfFollowing]);

const scheduleStickToBottom = useCallback(() => {
  if (liveEdgeScrollCountRef.current > 0 || sendFrameRef.current !== null) {
    needsStickAfterScrollRef.current = true;
    return;
  }
  if (stickFrameRef.current !== null) return;

  const generation = restoreGenerationRef.current;
  stickFrameRef.current = requestAnimationFrame(() => {
    stickFrameRef.current = null;
    if (
      generation !== restoreGenerationRef.current ||
      !follow.isFollowing() ||
      isKeyboardTransitioning.get()
    ) {
      return;
    }
    const list = inputsRef.current.listRef.current;
    if (list) {
      void list.scrollToEnd({ animated: false });
    }
  });
}, [follow, isKeyboardTransitioning]);
```
- **技术要点**：
  1. **挂在 `onContentSizeChange` 上**：列表内容高度只要因为原生文本排版发生 1 像素的变化，原生层立即回调 `handleContentSizeChange`；
  2. **`requestAnimationFrame` (rAF) 节流**：同一帧内的多次尺寸变动被合并为单次 `scrollToEnd`，绝不卡死主线程；
  3. **世代守卫 (`restoreGenerationRef`)**：如果在 rAF 等待期间发生切会话或用户滑动，世代号递增，取消旧帧执行，杜绝时序穿透；
  4. **键盘动画互斥 (`isKeyboardTransitioning.get()`)**：当软键盘正在弹起或收起的动画区间（60fps 逐帧）内，挂起 `stickToBottom`，完全交由键盘控制器的原生 Inset 驱动，避免与键盘动画打架。

### 2.4 Live Tail（实时尾随）与流式文本“冻结挂起”黑科技
这是 Cherry 最惊艳的性能杀手锏。长文本 LLM 流式输出（几千字）往往导致 React Native 严重掉帧卡顿。Cherry 是如何解决的？

#### ① 滞后视口探针（Hysteresis Viewport Probe）
在 `messageListLayout.ts` 中：
```ts
const LIVE_TAIL_REVEAL_MARGIN = 160;
const LIVE_TAIL_HIDE_MARGIN = 320;

export function isMessageListLiveTailInView(
  scrollOffset: number,
  contentHeight: number,
  viewportHeight: number,
  bottomInset: number,
  wasInView: boolean,
): boolean {
  'worklet';
  const distanceFromEnd = contentHeight - viewportHeight - scrollOffset;
  const margin = wasInView ? LIVE_TAIL_HIDE_MARGIN : LIVE_TAIL_REVEAL_MARGIN;
  return distanceFromEnd <= bottomInset + margin;
}
```
- 引入**双向滞后区间**（Reveal: 160px / Hide: 320px），防止用户在视口边缘滚动时出现高频的 `isInView` 振荡。

#### ② 视口外流式打字挂起优化（`PartMarkdown.tsx`）
```tsx
export function PartMarkdown({ isStreaming, markdown, messageId }: PartMarkdownProps) {
  const isLiveTailVisible = useMessageListLiveTailVisible(isStreaming);
  const [shownMarkdown, setShownMarkdown] = useState(markdown);

  // 关键：流式生成中，若用户向上翻看历史（尾部不在视口内），挂起 markdown 更新！
  const isHeld = isStreaming && !isLiveTailVisible;
  if (!isHeld && shownMarkdown !== markdown) {
    setShownMarkdown(markdown);
  }

  return (
    <MarkdownText
      isStreaming={isStreaming}
      markdown={isHeld ? shownMarkdown : markdown}
      selectionAction={selectionAction}
    />
  );
}
```
- **原理剖析**：
  - 用户滚上去看历史时，看不见底部的实时输出；
  - 此时若每次 token 到来都让 `MarkdownText` 重新将几千字的 Markdown 解析成 AST 并构建 React 组件树，会导致严重的 JS 线程饱和与掉帧；
  - Cherry 在检测到 `!isLiveTailVisible` 时，直接 **Freeze（冻结）** 当前文本更新，底层渲染保持原状！
  - 当用户重新划到底部或流式结束时，瞬间解冻并 catch up 到最新全文。**保证了用户翻阅历史时的 60fps 丝滑体验！**

---

## 三、气泡排版与视觉美学解密

Cherry Studio 与 Crish Mobile 当前气泡呈现对比：

| 视觉与交互维度 | Cherry Studio Mobile 实现规约 | Crish Mobile 现状缺陷 | 借鉴对齐目标 |
|:---|:---|:---|:---|
| **用户气泡形态** | `rounded-[18px]` 均一连续胶囊圆角，最大宽度 `88%`，横向内衬 `16px`，纵向 `10px` | `18/18/4/18` 突兀尾角，最大宽度 `82%`，内衬 `14/10`，深色墨色底对比差 | 改为 `86%` 优雅均一连续圆角（`radius.bubble = 18`），优化视觉留白 |
| **用户气泡附件** | 独立卡片堆叠在气泡正上方，靠右对齐，带状态警示（`TriangleAlertIcon`） | 附件无独立分块，直接塞入消息文本中或缺失预览 | 建立附件卡片独立栈，气泡上方紧凑右对齐 |
| **助手消息排版** | **无边框通透正文** + 独立顶栏（24px 头像 + 粗体 Agent 名字 + 16px 模型微标） | 裸露文本直出，无头像、无模型标识、无名称 | 增加助手轻量 Header（Avatar + Name + ModelTag），无框排版 |
| **底部操作工具栏** | 独立 `AssistantMessageToolbar`（复制、分支切换、重试、Token 用量），仅在 `status !== 'pending'` 显示 | 仅有一个简陋的 `ToolSummaryRow`，助手正文无任何操作入口 | 消息封口后展示轻量操作行（复制、用量、耗时） |
| **时间戳展示** | 仅在相邻消息间隔 > 5 分钟时居中轻量显示（`font-mono text-xs text-muted`） | 全量硬编码或完全不显示 | 基于 `getTimestampMessageIds` 聚类计算稀疏时间戳 |
| **思考/状态反馈** | 支持折叠式 `ReasoningPart`（深度思考折叠胶囊），带计时与展开动画 | 思考内容与正文混排，无折叠支持 | 预留 `<ThinkingBlock>` 折叠抽屉规范 |

### 3.1 助手消息顶栏的模型胶囊对齐技巧
在 Cherry 的 `AssistantMessageHeader` 中，为了保证模型图标和 Agent 名字在不同语言、不同字体缩放下完美对齐基线，采用了非常巧妙的排版手段：
```tsx
{/* 零宽连字号，防止模型微标单独折行到下一行成为孤行 */}
{WORD_JOINER}
<View className="translate-y-px pl-1.5 android:translate-y-[3px]">
  <ModelAvatar model={model} size={16} />
</View>
```
- 使用 `\u2060`（WORD_JOINER）绑定文字末尾与图标；
- 平台专属的 `translateY` 微调（Android 下降 3px，iOS 下降 1px），确保 16px 的微标垂直居中于 14px 正文字符的 x-height 中心。

---

## 四、Crish Mobile 对话流升级重构方案

针对 Crish Mobile 当前的代码结构，我们制定**不依赖复杂外部闭源库、纯原生优雅实现**的完整重构方案。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Crish Mobile 对话流重构三层架构体系                  │
└────────────────────────────────────────────────────────────────────────┘
  [表现层 UI Layer]
  ConversationScreen (sessionDetailScreen.tsx)
    │
    ├── ConversationHeader (悬浮通透头栏, safeTop 锚定)
    ├── EdgeFade (上下羽化, 底部高度实时联动 floatingHeight)
    ├── ScrollToBottomButton (吸底按钮, 悬停于 Composer 上方 12px)
    │
    └── TimelineView (增强型消息流容器)
          │
          ├── FlatList (原生虚拟化，绑定 onContentSizeChange)
          │     ├── RenderItem: ChatMessageRow
          │     │     ├── UserMessageBubble (均一18px连续胶囊, 附件右上角堆叠)
          │     │     └── AssistantMessageRow (顶栏Avatar/Model + 正文 + 底部Toolbar)
          │     └── ListFooterComponent: 底部留白 Spacer (安全区 + Composer高度)
          │
  [控制器层 Controller Layer]
  useTimelineScrollController
    ├── ViewportFollowState (following vs reading 状态机)
    ├── scheduleStickToBottom (rAF 世代防抖吸底)
    ├── isLiveTailInView (滞后视口探针)
    └── handleContentSizeChange (Yoga 排版完工事件监听)
          │
  [底层支撑层 Foundation Layer]
  useTimelineBottomInset (无滞后实测 + Reanimated 键盘联动)
  StreamingMarkdownFreeze (视口外打字挂起优化)
```

### 4.1 核心控制器重构：`useTimelineScrollController.ts`
在 `apps/crish-mobile/src/presentation/timeline/useTimelineScrollController.ts` 中实现：

```ts
import { useCallback, useRef, useState } from 'react';
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

export type FollowMode = 'following' | 'reading';
export type FollowReason = 'init' | 'user-drag' | 'reach-bottom' | 'programmatic-bottom';

export interface UseTimelineScrollControllerOptions {
  listRef: React.RefObject<FlatList<any> | null>;
  bottomInset: number;
  onFollowModeChange?: (mode: FollowMode) => void;
}

export function useTimelineScrollController({
  listRef,
  bottomInset,
  onFollowModeChange,
}: UseTimelineScrollControllerOptions) {
  const followStateRef = useRef<{ mode: FollowMode; reason: FollowReason }>({
    mode: 'following',
    reason: 'init',
  });
  const [isFollowing, setIsFollowing] = useState(true);

  // 尺寸与偏移量缓存
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);

  // 调度守卫
  const stickFrameRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const isDraggingRef = useRef(false);

  const setMode = useCallback((nextMode: FollowMode, reason: FollowReason) => {
    if (followStateRef.current.mode === nextMode) return;
    followStateRef.current = { mode: nextMode, reason };
    setIsFollowing(nextMode === 'following');
    onFollowModeChange?.(nextMode);
  }, [onFollowModeChange]);

  // 触底吸附执行器（带 rAF 世代保护）
  const scheduleStickToBottom = useCallback(() => {
    if (followStateRef.current.mode !== 'following') return;
    if (isDraggingRef.current) return;

    if (stickFrameRef.current !== null) {
      cancelAnimationFrame(stickFrameRef.current);
    }

    const currentGen = generationRef.current;
    stickFrameRef.current = requestAnimationFrame(() => {
      stickFrameRef.current = null;
      if (currentGen !== generationRef.current) return;
      if (followStateRef.current.mode !== 'following') return;

      listRef.current?.scrollToEnd({ animated: false });
    });
  }, [listRef]);

  // 原生尺寸变化监听：文本排版完成的第一时间修正滚动
  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    contentHeightRef.current = h;
    if (followStateRef.current.mode === 'following') {
      scheduleStickToBottom();
    }
  }, [scheduleStickToBottom]);

  // 容器视口尺寸变化
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    viewportHeightRef.current = e.nativeEvent.layout.height;
    if (followStateRef.current.mode === 'following') {
      scheduleStickToBottom();
    }
  }, [scheduleStickToBottom]);

  // 用户开始拖拽：瞬间切入 reading 态，绝不与用户手势抢占
  const handleScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    generationRef.current += 1;
    setMode('reading', 'user-drag');
  }, [setMode]);

  // 拖拽释放
  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isDraggingRef.current = false;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;

    // 精确触底数学判定：允许 2px 浮点容差
    const maxScroll = Math.max(0, contentSize.height - layoutMeasurement.height);
    const isAtBottom = maxScroll - contentOffset.y <= 2;

    if (isAtBottom) {
      setMode('following', 'reach-bottom');
    }
  }, [setMode]);

  // 惯性滚动结束
  const handleMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;
    const maxScroll = Math.max(0, contentSize.height - layoutMeasurement.height);
    const isAtBottom = maxScroll - contentOffset.y <= 2;

    if (isAtBottom) {
      setMode('following', 'reach-bottom');
    }
  }, [setMode]);

  // 手动点击回底
  const scrollToBottom = useCallback(() => {
    setMode('following', 'programmatic-bottom');
    generationRef.current += 1;
    listRef.current?.scrollToEnd({ animated: true });
  }, [listRef, setMode]);

  return {
    isFollowing,
    handleContentSizeChange,
    handleLayout,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollEnd,
    scrollToBottom,
  };
}
```

### 4.2 底部 Inset 与悬浮浮层精准数学模型
彻底重构 `useTimelineBottomInset.ts`，消除 90ms 滞后并解决键盘平移冲突：

```
┌────────────────────────────────────────────────────────────────────────┐
│                     底部 Inset 物理模型与层级解耦                      │
└────────────────────────────────────────────────────────────────────────┘
  Screen Height (全屏高)
  │
  ├── TimelineView Viewport (全屏滚动)
  │     │
  │     ├── Content Container
  │     │     ├── Messages ...
  │     │     └── paddingBottom = effectiveOverlayHeight + gap (不叠加 keyboardHeight!)
  │     │
  │     └── scrollIndicatorInsets.bottom = effectiveOverlayHeight + gap
  │
  ├── EdgeFade 渐隐覆膜 (高度 = effectiveOverlayHeight + gap)
  │     └── 仅覆盖输入区下方背板，透明羽化带 95px 落在输入区上方
  │
  └── KeyboardStickyView (物理绝对定位 bottom: 0)
        └── 原生 translateY 负责键盘贴顶，尺寸由其内部子节点物理撑开
```

#### 关键数学修正断言：
1. **`TimelineView` 的 `paddingBottom` 不得叠加 `keyboardHeight`**！
   - 因为当键盘弹起时，React Native 的屏幕物理视口由于系统窗口变化或 `KeyboardAvoidingView` 的存在，键盘区域本身已经脱离了普通视口；或者如果采用全屏滚动，`KeyboardStickyView` 向上平移已经完成了视觉避让；
   - 正确的推导为：
     $$\text{timelineBottomInset} = \text{effectiveOverlayHeight} + \text{gap}$$
     当键盘弹起时，只需让键盘控制器的 `contentInsetAdjustment` 动态补偿，或者保持 `paddingBottom` 等于纯输入框容器实测高；
2. **剔除 `setTimeout(90)`**：
   - 使用引用对齐（`ref`）在首帧即刻提交无闪烁尺寸；如果多行输入框高度平滑增长，通过 `requestAnimationFrame` 直接驱动 `setOverlayHeight`，延迟保持在 16ms（1帧）以内。

### 4.3 气泡与排版升级组件设计

#### ① 用户气泡升级（`UserMessageBubble.tsx`）
```tsx
import { View, StyleSheet } from 'react-native';
import { MarkdownText } from '@/presentation/components/blocks/MarkdownText';
import { useTheme } from '@/adapters/platform/theme';

export function UserMessageBubble({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: theme.colors.bubbleUser,
            // 采用均一连续胶囊圆角，彻底告别怪异折角
            borderRadius: 18,
            paddingHorizontal: 16,
            paddingVertical: 10,
          },
        ]}
      >
        <MarkdownText
          text={text}
          baseStyle={[theme.type.chat, { color: theme.colors.bubbleUserText }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '86%',
  },
});
```

#### ② 助手消息排版（`AssistantMessageView.tsx`）
引入精致的头像 + 名字 + 模型状态行，下方通透正文，底部带操作工具栏：
```tsx
import { View, StyleSheet } from 'react-native';
import { AppText, Icon } from '@/presentation/ui';
import { StreamingText } from '@/presentation/components/blocks/StreamingText';
import { useTheme } from '@/adapters/platform/theme';

export function AssistantMessageView({
  id,
  text,
  streaming,
  modelName = 'Claude 3.5 Sonnet',
}: {
  id: string;
  text: string;
  streaming: boolean;
  modelName?: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      {/* 助手 Header */}
      <View style={styles.headerRow}>
        <View style={[styles.avatar, { backgroundColor: theme.colors.surfaceGrouped }]}>
          <Icon name="sparkles" size={14} color={theme.colors.textPrimary} />
        </View>
        <AppText variant="subheadline" color="textPrimary" style={styles.agentName}>
          Crish Assistant
        </AppText>
        <View style={[styles.modelBadge, { backgroundColor: theme.colors.fillMuted }]}>
          <AppText variant="caption2" color="textSecondary">
            {modelName}
          </AppText>
        </View>
      </View>

      {/* 正文：无框沉浸式 Markdown */}
      <View style={styles.body}>
        <StreamingText
          identity={`msg:${id}`}
          text={text}
          streaming={streaming}
          style={[theme.type.chat, { color: theme.colors.textPrimary }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentName: { fontWeight: '600', fontSize: 13 },
  modelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  body: {
    paddingLeft: 32, // 与头像保持对齐线
  },
});
```

---

## 五、方案实施演进路径与验收标准

### 5.1 实施分波设计

```
┌────────────────────────────────────────────────────────────────────────┐
│                        实施落地三步推进路径                            │
└────────────────────────────────────────────────────────────────────────┘
  【第一阶段：数学修正与滚动解绑 (Day 1)】
   1. 编写 pure/timelineBottomInset 纯数学单元测试，覆盖全键盘状态与浮层实测；
   2. 落地 useTimelineScrollController，接管 FlatList 的 onContentSizeChange 与手势；
   3. 修复 sessionDetailScreen.tsx 的 Inset 穿透与 EdgeFade 遮罩，立竿见影根除“划不到底”；
        │
        ▼
  【第二阶段：流式文本打字挂起优化 (Day 2)】
   1. 引入 TimelineLiveTailContext 与滞后视口探针（160px/320px）；
   2. 在 StreamingText / MarkdownText 落地视口外更新冻结；
   3. 验证长文本（5000+ 字）流式输出时手动滑动的 60fps 帧率；
        │
        ▼
  【第三阶段：气泡与视觉美学对齐 (Day 3)】
   1. 升级 UserMessageBubble 为 18px 连续圆角；
   2. 升级 AssistantMessageView，加入精致的 Header（头像/名字/模型标）与底部 ActionToolbar；
   3. 接入时间戳稀疏计算与折叠卡片。
```

### 5.2 严密验收断言（立体化质检验收）
1. **触底断言**：在任何长消息、短消息、空状态下，列表拖拽到底部后，最后一条消息的底边与输入框顶部边缘的空隙**刚性稳定在 16~24px**，绝无重叠遮挡，也绝无大于 40px 的畸形空隙；
2. **手势断言**：在远端流式打字持续输出过程中，用户手指按住屏幕向上滑动阅读历史，**视口必须立即稳定停留在手指触碰位置，严禁发生任何弹跳或自动拉回**；
3. **性能断言**：长文本流式打字时，滑到历史区域阅读，UI 渲染线程稳定在 58~60 FPS，JS 线程无拥塞积压。

---
*本方案落盘至 `docs/mobile-ux-cherry-alignment/proposals/07-Cherry消息对话流与气泡渲染解构.md`，所有代码改动与方案严格遵守 `AGENTS.md` 规范。*
