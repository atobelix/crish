import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import type { SessionMessage } from '../../store/types';
import { StreamingAssistantRow } from './StreamingAssistantRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/VirtualScrollManager';
import {
  registerActiveVsm,
  unregisterActiveVsm,
  useLayoutStore,
} from '../../store/storeAccess';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';
import { FlowScrubber } from './FlowScrubber';
import { ChatOverlayScrollbar } from './ChatOverlayScrollbar';
import { ChatScrollFloorSlot } from './ChatScrollFloorSlot';
import { useStableRowMeasureRef } from './messageVirtualizerMeasure';
import {
  useSessionSwitchGeometryReset,
  useStickToBottomFollow,
  useVirtualizerScrollHandlers,
  useVirtualizerScrollRefs,
} from './messageVirtualizerScrollState';
import {
  deriveTailBufferWindow,
  type ScrollToBottomPlan,
  type TailBufferWindowState,
} from './messageVirtualizerScrollPlan';
import {
  memoizeMessageVirtualizer,
  type MessageVirtualizerProps,
  type PinnedItem,
} from './messageVirtualizerMemo';
import {
  CHAT_SCROLL_PAD_TOP,
  chatSpacerHeight,
  resolveTailBufferTargetPx,
} from './chatScrollGeometry';
import { useTailBufferAnimation } from './messageVirtualizerTailBuffer';
import {
  DEFAULT_VIEWPORT_HEIGHT_PX,
  MESSAGE_VIEWPORT_OVERSCAN,
  SCROLL_BOTTOM_THRESHOLD_PX,
  SIGNIFICANT_HEIGHT_DELTA_PX,
} from '../../hooks/virtualScrollConstants';
import { computePagingAnchor, restorePagingAnchor } from './PagingAnchor';
import { resolveAnchorTargetScrollTop } from './readingAnchorStore';
import { computeTimeSeparatorHosts } from './chatTimeSeparatorLib';
import { ChatTimeSeparator } from './ChatTimeSeparator';
import { SessionReadyCover } from './SessionReadyCover';
import { useSessionOpenAnchor } from './useSessionOpenAnchor';
import { useScrollAnchoringOnToggle } from './useScrollAnchoringOnToggle';
import {
  PurgedMessageRowSkeleton,
  computeActiveRowWindow,
  reseedAllMessageHeights,
  useFastScrollPurgeTracker,
  useVirtualizerHeightLifecycle,
} from './messageDomPurge';

export type { MessageVirtualizerProps, PinnedItem };

/**
 * R6：msgIds 增量维护（替代每次 messages 变化全量 `messages.map`）。
 * - 与上一轮逐项 id 相同（流式提交只换消息对象、id 序列不变 —— 占绝大多数）
 *   → 返回上一轮数组本身（引用不变，下游按 msgIds 身份的订阅/测高不重跑）；
 * - 纯尾部追加 → 复用前缀拼接新增 id；
 * - 其余结构变化 → 全量重建（低频路径）。
 */
export function deriveMsgIdsIncremental(
  prev: { ids: string[] } | null,
  messages: readonly SessionMessage[]
): string[] {
  if (prev) {
    const prevIds = prev.ids;
    if (prevIds.length === messages.length) {
      let same = true;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i]!.id !== prevIds[i]) {
          same = false;
          break;
        }
      }
      if (same) return prevIds;
    } else if (prevIds.length < messages.length) {
      let prefixSame = true;
      for (let i = 0; i < prevIds.length; i++) {
        if (messages[i]!.id !== prevIds[i]) {
          prefixSame = false;
          break;
        }
      }
      if (prefixSame) {
        const next = prevIds.slice();
        for (let i = prevIds.length; i < messages.length; i++) {
          next.push(messages[i]!.id);
        }
        return next;
      }
    }
  }
  return messages.map((m) => m.id);
}

const MessageVirtualizerInner: React.FC<MessageVirtualizerProps> = (props) => {
  const {
    messages,
    activeSessionId,
    initialScroll = 'top',
    searchHighlightQuery,
    pins,
    flowControl,
    interaction,
    generation,
    navigation,
    composer,
  } = props;

  // 领域分组对象直接解构（切除双向兼容与扁平回退代码）
  const {
    pinnedItems = [],
    pinnedColors = {},
    togglePin = () => {},
  } = pins ?? {};
  const {
    hideThinkingBlock = false,
    setPermissionMode = () => {},
    lastAssistantId = null,
    lastUserId,
    thinkingMsgId,
    showAllMessages = true,
  } = flowControl ?? {};
  const {
    expandedUserMsgs = {},
    onToggleExpandUser = () => {},
    dismissedFollowUps = {},
    handleDismissFollowUp = () => {},
    handleMarkdownClick = () => {},
  } = interaction ?? {};

  // 缺真实 toolStackProps 时不伪装审批可用：回调保持 undefined，由 CompactToolRow 显式不可用
  const fallbackToolStackProps = useMemo<
    import('../chat-tool-call/ChatToolCallBlock').ChatToolStackSharedProps
  >(
    () => ({
      activeSessionId,
      agents: [],
      expandedTools: {},
      onToggleTool: () => {},
      approvalBusy: false,
      actions: {
        onOpenDiff: navigation?.onOpenDiff ?? (() => {}),
        onOpenPath: navigation?.onOpenPath,
        onOpenTerminal: navigation?.onOpenTerminal,
      },
    }),
    [
      activeSessionId,
      navigation?.onOpenDiff,
      navigation?.onOpenPath,
      navigation?.onOpenTerminal,
    ]
  );
  const toolStackProps = interaction?.toolStackProps ?? fallbackToolStackProps;
  const onOpenDiff = navigation?.onOpenDiff;
  const onOpenDiffPanel = navigation?.onOpenDiffPanel;
  const onOpenPath = navigation?.onOpenPath;
  const onBranch = generation?.onBranch;
  const onRetract = generation?.onRetract;
  const onEditMessageAndResend = generation?.onEditMessageAndResend;
  const handleRegenerateRow = generation?.handleRegenerateRow;
  const handleFillFollowUp = composer?.handleFillFollowUp;
  const onSendFollowUp = composer?.onSendFollowUp;
  const handleSendFollowUp = composer?.handleSendFollowUp;
  // R6：msgIds 增量维护——id 序列不变时保持数组引用（见 deriveMsgIdsIncremental）
  const msgIdsRef = useRef<{ ids: string[] } | null>(null);
  const msgIds = useMemo(() => {
    const ids = deriveMsgIdsIncremental(msgIdsRef.current, messages);
    msgIdsRef.current = { ids };
    return ids;
  }, [messages]);
  const vs = useVirtualScroll({
    ids: msgIds,
    itemCount: messages.length,
    overscan: MESSAGE_VIEWPORT_OVERSCAN,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const {
    containerRef,
    setActual,
    clearHeights,
    manager,
    preloadEstimates,
    syncOrder,
    performProgrammaticScroll,
    cancelProgrammaticScroll,
    flushPendingGeometry,
    totalHeight: modelContentHeight,
  } = vs;
  const rowMeasureRef = useStableRowMeasureRef(setActual, msgIds);

  // 文档坐标系总高度（滚动回调运行时读取；赋值见 computeActiveRowWindow 之后）
  const totalHeightRef = useRef(0);

  // R12b 尾部缓冲：已张开值（state 驱动渲染几何）+ 回调镜像 ref。
  // 目标由轮次窗口单点裁决（派生与复位在 computeActiveRowWindow 之前的
  // 渲染期块内完成，见下方）；张开走斜坡 effect、退出走收合 effect，
  // 静止 / 阅读态恒 0（R12 的会话闩锁常驻已废止）。
  const [tailBufferPx, setTailBufferPx] = useState(0);
  const tailBufferRef = useRef(0);
  const tailPrevSessionIdRef = useRef<string | null>(activeSessionId);
  /** 窗口信号状态机（发送闩 + 尾行基线），渲染期逐帧推进 */
  const tailWindowRef = useRef<TailBufferWindowState>({
    baselineTailUserId: undefined,
    sendLatchUserId: null,
  });
  /** 收合计划（rAF 定时律）：turnActive 转假时由收合 effect 建立 */
  const tailCollapseRef = useRef<{
    rafId: number | null;
    plan: ScrollToBottomPlan | null;
  }>({ rafId: null, plan: null });
  const cancelTailCollapse = () => {
    const collapse = tailCollapseRef.current;
    if (collapse.rafId !== null) {
      cancelAnimationFrame(collapse.rafId);
      collapse.rafId = null;
    }
    collapse.plan = null;
  };
  /** 内容高镜像（斜坡帧间增量计量；渲染期赋值，与 totalHeightRef 同模式） */
  const tailContentHeightRef = useRef(0);
  /** 斜坡上一帧计量时的内容高基线 */
  const tailRampBaselineRef = useRef(0);

  // 滚动状态 refs/state（实现见 messageVirtualizerScrollState）
  const {
    isAtBottom,
    isAtTop,
    showFloorButton,
    isAtBottomRef,
    isAtTopRef,
    observedTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
    touchStartYRef,
  } = useVirtualizerScrollRefs();

  const isFirstMountRef = useRef(true);
  // 切会话后最多再量两遍已挂载行，把估高纠正赶在首帧绘制之前。
  const sessionMeasurePassesRef = useRef(0);

  // 批 B ⑱/⑳：会话开局编排（锚点恢复裁决 + 阅读位捕获 + 就绪遮罩，
  // 实现见 useSessionOpenAnchor；待恢复锚点供切会话重置/首挂载/测高消费）
  const { anchorRestoreTargetRef, sessionCover } = useSessionOpenAnchor({
    activeSessionId,
    containerRef,
    manager,
    isAtBottomRef,
    sessionMeasurePassesRef,
  });

  // W3-3: 快速滚动状态与超视距 DOM 回收控制器
  const fastScroll = useFastScrollPurgeTracker();
  const prevSessionIdRef = useRef<string | null>(activeSessionId);

  // VS-01：会话切换在同步 layout 阶段重置几何状态（实现见 messageVirtualizerScrollState）
  useSessionSwitchGeometryReset({
    activeSessionId,
    prevSessionIdRef,
    clearHeights,
    manager,
    msgIds,
    messages,
    vs,
    fastScroll,
    isAtBottomRef,
    setIsAtBottom,
    setShowFloorButton,
    isAtTopRef,
    setIsAtTop,
    observedTopRef,
    sessionMeasurePassesRef,
    tailBufferRef,
    restoreAnchorRef: anchorRestoreTargetRef,
  });

  const uiSize = useLayoutStore((s) => s.uiSize);
  const uiSizeSeededRef = useRef(false);

  useEffect(() => {
    if (!uiSizeSeededRef.current) {
      uiSizeSeededRef.current = true;
      return;
    }
    // 批 B ⑱：分栏宽度变化后按锚点恢复阅读位（仅非跟随态）——清高前先以
    // 当前 DOM 几何捕获锚点并武装待恢复目标 + 测高遍数，宽度变更引发的
    // 高度重排由测高 effect 以该锚点逐遍校正；跟随态仍以真底为准。
    if (!isAtBottomRef.current && !anchorRestoreTargetRef.current) {
      const container = containerRef.current;
      const liveAnchor = container
        ? computePagingAnchor(container, manager)
        : null;
      if (liveAnchor) {
        anchorRestoreTargetRef.current = liveAnchor;
        sessionMeasurePassesRef.current = 2;
      }
    }
    manager.clearRememberedHeights();
    clearHeights();
    reseedAllMessageHeights(manager, msgIds, messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiSize, clearHeights]);

  // 维护增量消息 unmeasuredEstimates 估高与生命周期
  useVirtualizerHeightLifecycle({
    manager,
    msgIds,
    messages,
    syncOrder,
    preloadEstimates,
  });

  useEffect(() => {
    registerActiveVsm(activeSessionId, manager);
    return () => {
      unregisterActiveVsm(activeSessionId);
    };
  }, [activeSessionId, manager]);

  useUndoWithScrollAnchor(containerRef, manager);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedItems.map((p) => p.id)),
    [pinnedItems]
  );

  // 批 B ㉑：时间分隔行宿主集（间隔 ≥5 分钟才挂，口径见 chatTimeSeparator）
  const timeSeparatorHosts = useMemo(
    () => computeTimeSeparatorHosts(messages),
    [messages]
  );

  const { handlePointerDownCapture, handleKeyDownCapture, isAnchorLocked } =
    useScrollAnchoringOnToggle({
      containerRef,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      expandedUserMsgs,
      expandedTools: toolStackProps?.expandedTools,
      messages,
    });

  // 滚动事件处理器（实现见 messageVirtualizerScrollState）
  const {
    handleWheelCapture,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleScroll,
    handleScrollToBottom,
  } = useVirtualizerScrollHandlers({
    containerRef: vs.containerRef,
    vs,
    totalHeightRef,
    isAnchorLocked,
    fastScroll,
    isAtBottomRef,
    isAtTopRef,
    observedTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
    touchStartYRef,
  });

  const isSessionSwitch = prevSessionIdRef.current !== activeSessionId;

  // R12b 尾部缓冲·渲染期单点派生（与 totalHeightRef 同为渲染期镜像模式）：
  // - 切会话先复位：收合计划取消、发送闩清零、已张开值本帧按 0 计（setState 同步
  //   收敛，提交帧即一致），新会话 idle 开局、直达真底，会话重置 hook 读到的
  //   tailBufferRef 亦为 0；
  // - 窗口信号由 deriveTailBufferWindow 单点裁决（主信号 thinkingMsgId + 发送闩
  //   桥接），目标由 resolveTailBufferTargetPx 按窗口与视口高裁决；本帧几何
  //   使用「已张开值」，张开走下方斜坡 effect、退出走收合 effect；
  // - 四个几何点位（本窗口计算 / 首挂载 / 测高收敛 / 会话重置）同帧同值。
  const tailSessionChanged = tailPrevSessionIdRef.current !== activeSessionId;
  if (tailSessionChanged) {
    tailPrevSessionIdRef.current = activeSessionId;
    tailRampBaselineRef.current = modelContentHeight;
    cancelTailCollapse();
    if (tailBufferPx !== 0) setTailBufferPx(0);
  }
  const tailLastMessage = messages[messages.length - 1];
  const tailWindow = deriveTailBufferWindow(tailWindowRef.current, {
    sessionChanged: tailSessionChanged,
    tailUserId:
      tailLastMessage && tailLastMessage.sender === 'user'
        ? tailLastMessage.id
        : null,
    thinkingMsgId,
    isAtBottom: isAtBottomRef.current,
  });
  tailWindowRef.current = tailWindow.state;
  const turnActive = tailWindow.turnActive;
  const effectiveTailBufferPx = tailSessionChanged ? 0 : tailBufferPx;
  const tailBufferTargetPx = resolveTailBufferTargetPx({
    turnActive,
    viewportHeight:
      vs.viewportHeight > 0 ? vs.viewportHeight : DEFAULT_VIEWPORT_HEIGHT_PX,
  });
  tailBufferRef.current = effectiveTailBufferPx;
  tailContentHeightRef.current = modelContentHeight;

  // VS-04 & W3-3：计算活跃行裁剪窗口、文档坐标系总高度与每行超视距回收状态
  const { startOffset, totalHeight, activeRows } = computeActiveRowWindow({
    visibleRange: vs.visibleRange,
    scrollTop: vs.scrollTop,
    viewportHeight: vs.viewportHeight,
    totalHeight: vs.totalHeight,
    tailBufferPx: effectiveTailBufferPx,
    vsManager: manager,
    messages,
    msgIds,
    pinnedIdSet,
    searchHighlightQuery,
    thinkingMsgId,
    editingMessageId: composer?.editingMessageId,
    isScrolling:
      !isSessionSwitch &&
      (fastScroll.isFastScrolling || fastScroll.isFastScrollingRef.current),
    isSessionSwitch,
    isInitialMount: isFirstMountRef.current,
    initialScroll,
    stickToBottom: isAtBottomRef.current && !isAnchorLocked(),
  });

  // 总高度写回 ref（滚动回调运行时读取）
  totalHeightRef.current = totalHeight;

  // 流式打字与动态测高自动跟随（实现见 messageVirtualizerScrollState.useStickToBottomFollow）
  useStickToBottomFollow({
    containerRef: vs.containerRef,
    vs,
    messages,
    initialScroll,
    isSessionSwitch,
    totalHeight,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
  });

  // R12b 尾部缓冲张开斜坡 + 终态收合 + 卸载清理（实现见 messageVirtualizerTailBuffer）
  useTailBufferAnimation({
    tailBufferPx,
    tailBufferTargetPx,
    turnActive,
    isAtBottom,
    isAtBottomRef,
    tailContentHeightRef,
    tailRampBaselineRef,
    tailCollapseRef,
    setTailBufferPx,
  });

  // 初次挂载若指定 initialScroll='bottom'（真实对话界面落地），同步吸底至最新消息
  useLayoutEffect(() => {
    if (!isFirstMountRef.current) return;
    if (initialScroll === 'bottom' && messages.length > 0) {
      isFirstMountRef.current = false;
      const estimatedContentHeight = manager.getTotalHeight(messages.length);
      const estimatedTotalHeight = chatSpacerHeight(
        estimatedContentHeight,
        tailBufferRef.current
      );
      const container = containerRef.current;
      const viewH =
        container?.clientHeight ||
        vs.viewportHeight ||
        DEFAULT_VIEWPORT_HEIGHT_PX;
      const targetBottomScrollTop = Math.max(0, estimatedTotalHeight - viewH);
      // 批 B ⑱：首挂载同样适用锚点恢复（有保存且非跟随态时改走锚点落点）
      const anchorTarget = resolveAnchorTargetScrollTop(
        manager,
        anchorRestoreTargetRef.current
      );
      const restored = anchorTarget !== null;
      const targetScrollTop = anchorTarget ?? targetBottomScrollTop;
      isAtBottomRef.current = !restored;
      setIsAtBottom(!restored);
      setShowFloorButton(
        restored &&
          targetBottomScrollTop - targetScrollTop > SCROLL_BOTTOM_THRESHOLD_PX
      );
      if (container) {
        performProgrammaticScroll(container, targetScrollTop);
      } else {
        performProgrammaticScroll(targetScrollTop);
      }
      observedTopRef.current = targetScrollTop;
      sessionMeasurePassesRef.current = 2;
    }
  }, [
    initialScroll,
    manager,
    messages.length,
    performProgrammaticScroll,
    vs.viewportHeight,
  ]);

  // 估高与实测差在绘制前写回。拖到下一帧再改高度，刚切过来的对话会跳一下。
  useLayoutEffect(() => {
    if (sessionMeasurePassesRef.current <= 0) return;
    const container = containerRef.current;
    if (!container) {
      sessionMeasurePassesRef.current = 0;
      return;
    }
    let queued = false;
    const nodes = container.querySelectorAll<HTMLElement>('[data-vindex]');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node) continue;
      if (node.querySelector('[data-md-pending="true"]')) continue;
      const id = node.dataset.vindex;
      const measured = node.offsetHeight;
      if (!id || measured <= 0) continue;
      const committed = manager.getActualHeight(id);
      if (
        committed !== null &&
        Math.abs(committed - measured) <= SIGNIFICANT_HEIGHT_DELTA_PX
      ) {
        continue;
      }
      setActual(id, measured);
      queued = true;
    }
    // 批 B ⑱：恢复窗口内本 effect 以锚点而非 maxScroll 校正（见下方分支）
    const restoreTarget = anchorRestoreTargetRef.current;
    sessionMeasurePassesRef.current -= 1;
    if (!queued) {
      sessionMeasurePassesRef.current = 0;
      if (restoreTarget) {
        // 高度已收敛：双径锚点做最后一遍校正并落定待恢复目标
        restorePagingAnchor(container, restoreTarget, manager);
        observedTopRef.current = container.scrollTop;
        anchorRestoreTargetRef.current = null;
      }
      return;
    }
    flushPendingGeometry();
    // 同一次布局里直接改占位和滚动。等下一帧再绘，第一眼就是错的高度。
    // R12：与渲染几何同值（含尾部缓冲），漏带会把 scrollTop 写到无缓冲的
    // maxScroll、与跟随 effect 隔帧对打（列表先沉 B 再弹回）。
    const nextTotal = chatSpacerHeight(
      manager.getTotalHeight(messages.length),
      tailBufferRef.current
    );
    const inner = container.querySelector<HTMLElement>(
      '[data-chat-list-inner]'
    );
    if (inner) inner.style.height = `${nextTotal}px`;
    if (restoreTarget) {
      // 恢复窗口：逐遍以双径锚点校正（高度逐遍收敛、落点随之收敛），
      // 遍数走完即落定；此窗口内绝不写 maxScroll（否则把读者拽回底部）
      restorePagingAnchor(container, restoreTarget, manager);
      observedTopRef.current = container.scrollTop;
      if (sessionMeasurePassesRef.current <= 0) {
        anchorRestoreTargetRef.current = null;
      }
    } else {
      const maxScroll = Math.max(0, nextTotal - container.clientHeight);
      container.scrollTop = maxScroll;
      observedTopRef.current = maxScroll;
    }
  }, [
    activeSessionId,
    modelContentHeight,
    messages.length,
    containerRef,
    manager,
    setActual,
    flushPendingGeometry,
  ]);

  return (
    <div
      className={styles.streamHost}
      data-chat-stream-host=""
      data-at-top={isAtTop ? 'true' : 'false'}
      data-at-bottom={isAtBottom ? 'true' : 'false'}
    >
      <div
        ref={vs.containerRef}
        className={styles.list}
        role="region"
        aria-label="会话消息"
        data-total-count={messages.length}
        data-show-all={showAllMessages ? 'true' : 'false'}
        data-virtual-scroll="true"
        data-chat-scroll-container=""
        data-testid="chat-scroll-container"
        style={{ overflowAnchor: 'none' }}
        onClick={handleMarkdownClick}
        onWheelCapture={handleWheelCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onKeyDownCapture={handleKeyDownCapture}
        onScroll={handleScroll}
      >
        <div
          className={styles.listInner}
          data-chat-list-inner=""
          data-vsm-spacer=""
          style={{
            height: `${totalHeight}px`,
            position: 'relative',
            overflow: 'hidden',
            overflowAnchor: 'none',
          }}
        >
          <div
            data-chat-slice-container=""
            style={{
              position: 'absolute',
              top: CHAT_SCROLL_PAD_TOP,
              left: 0,
              right: 0,
              transform: `translateY(${startOffset}px)`,
              overflowAnchor: 'none',
              boxSizing: 'border-box',
            }}
          >
            {/* 渲染身份（C2）：key / 高度缓存键 = message.id；stream 与 final 共用同一行 id */}
            {activeRows.map((row) => {
              const { msg, virtualIndex } = row;
              if (row.isPurged) {
                return (
                  <PurgedMessageRowSkeleton
                    key={msg.id}
                    msgId={msg.id}
                    sender={msg.sender}
                    itemHeight={row.itemHeight}
                    measureRef={rowMeasureRef(msg.id)}
                  />
                );
              }

              if (msg.sender === 'user') {
                return (
                  <AppErrorBoundary
                    key={msg.id}
                    variant="minimal"
                    title="消息出错"
                  >
                    <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                      {timeSeparatorHosts.has(msg.id) && (
                        <ChatTimeSeparator
                          timestamp={timeSeparatorHosts.get(msg.id)!}
                        />
                      )}
                      <ChatUserMessageRow
                        msg={msg}
                        isPinned={row.isPinnedMsg}
                        pinnedColor={pinnedColors[msg.id]}
                        isSearchHit={row.isSearchHit}
                        isExpanded={!!expandedUserMsgs[msg.id]}
                        onToggleExpand={onToggleExpandUser}
                        onTogglePin={togglePin}
                        isLastUser={msg.id === lastUserId}
                        onRetract={onRetract}
                        isEditing={row.isEditing}
                        onStartEdit={
                          composer?.onStartEditMessage
                            ? // 透传行内 sanitized 消息（信封剥离后的用户原文）；
                              // 无参调用回落原始 msg（信封 SSOT：编辑预填永不带信封）
                              (sanitized?: SessionMessage) =>
                                composer.onStartEditMessage?.(sanitized ?? msg)
                            : undefined
                        }
                        onCancelEdit={composer?.onCancelEditMessage}
                        composerElement={
                          row.isEditing ? composer?.composerElement : undefined
                        }
                        onEditMessageAndResend={onEditMessageAndResend}
                        messageIndex={virtualIndex}
                        virtualScrollManager={manager}
                        onOpenPath={onOpenPath}
                      />
                    </div>
                  </AppErrorBoundary>
                );
              }

              return (
                <AppErrorBoundary
                  key={msg.id}
                  variant="minimal"
                  title="消息出错"
                >
                  <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                    {timeSeparatorHosts.has(msg.id) && (
                      <ChatTimeSeparator
                        timestamp={timeSeparatorHosts.get(msg.id)!}
                      />
                    )}
                    <StreamingAssistantRow
                      msg={msg}
                      isFollowUp={row.isFollowUp}
                      isPinned={row.isPinnedMsg}
                      pinnedColor={pinnedColors[msg.id]}
                      isSearchHit={row.isSearchHit}
                      isThinkingMsg={msg.id === thinkingMsgId}
                      hideThinkingBlock={hideThinkingBlock}
                      isLastAssistant={msg.id === lastAssistantId}
                      toolStackProps={toolStackProps}
                      onTogglePin={togglePin}
                      onRegenerate={handleRegenerateRow}
                      onBranch={onBranch}
                      onOpenDiff={onOpenDiff}
                      onOpenDiffPanel={onOpenDiffPanel}
                      setPermissionMode={setPermissionMode}
                      onFillFollowUp={handleFillFollowUp}
                      onSendFollowUp={
                        onSendFollowUp ? handleSendFollowUp : undefined
                      }
                      followUpDismissed={!!dismissedFollowUps[msg.id]}
                      onDismissFollowUp={handleDismissFollowUp}
                      onRetract={onRetract}
                      messageIndex={virtualIndex}
                      virtualScrollManager={manager}
                    />
                  </div>
                </AppErrorBoundary>
              );
            })}
          </div>
        </div>
        <ChatScrollFloorSlot
          visible={showFloorButton}
          isAtBottom={isAtBottom}
          onScrollToBottom={handleScrollToBottom}
        />
      </div>
      <FlowScrubber
        messages={messages}
        manager={manager}
        totalHeight={totalHeight}
        scrollerRef={vs.containerRef}
        pinnedIdSet={pinnedIdSet}
        pinnedColors={pinnedColors}
        onTogglePin={togglePin}
        isFastScrolling={
          fastScroll.isFastScrolling || fastScroll.isFastScrollingRef.current
        }
      />
      {/* S3 路线 B：自研悬浮滚动条（原生条已关停，只读 scroller 几何，
          拖拽外不反写滚动位置；口径见 ChatOverlayScrollbar 头注释） */}
      <ChatOverlayScrollbar scrollerRef={vs.containerRef} />
      {/* 批 B ⑳：就绪遮罩（数据已到、布局未稳时盖住首帧；与 Loading 出口互斥不叠画） */}
      {sessionCover && <SessionReadyCover fading={sessionCover.fading} />}
    </div>
  );
};

export const MessageVirtualizer = memoizeMessageVirtualizer(
  MessageVirtualizerInner
);
