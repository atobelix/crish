// 会话时间线渲染：用户气泡 / 助手无框正文 / 工具摘要行 / 系统提示。
// 审批不在流内呈现（原型对话流无审批行）：待审批统一由全局 ApprovalFloat
// 悬浮卡承载（含收起胶囊与队列），已决状态在审批记录里可查。
// 渲染前先经 groupToolRuns 把相邻工具折叠成摘要，详情交给工具抽屉。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import type { RefObject } from 'react';
import { KeyboardChatScrollView } from 'react-native-keyboard-controller';
import { useSmoothKeyboardTimelineLinkage } from './useSmoothKeyboardTimelineLinkage';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import {
  AppText,
  Button,
  EmptyState,
  LoadingState,
  type TextColor,
} from '@/presentation/ui';
import Icon from '@/presentation/ui/Icon';
import { StreamingText } from '@/presentation/components/blocks/StreamingText';
import {
  TimelineImage,
  TimelineImagePlaceholder,
} from '@/presentation/components/blocks/MarkdownText';
import type {
  AssistantMessageBlock,
  MessageImageBlock,
  NoticeBlock,
  TimelineBlock,
} from './buildTimeline';
import { groupToolRuns, type DisplayBlock } from './groupToolRuns';
import { ToolSummaryRow } from './ToolSummaryRow';
import { ReasoningCard } from './ReasoningCard';
import { MessageActionBar } from './MessageActionBar';
import { UserMessageRow } from './UserMessageRow';
import {
  formatTimeSeparator,
  insertTimeSeparators,
  type TimelineRow,
} from './insertTimeSeparators';
import {
  anchorOffsetWithinBlock,
  restoreScrollOffset,
} from './timelineScrollRules';
import {
  clearScrollAnchor,
  loadScrollAnchor,
  saveScrollAnchor,
  type ScrollAnchor,
} from '@/domain/store/scrollAnchorStore';
import { evaluateFollowState } from '@/domain/pure/timelineBottomInset';
import type { WebSearchSource } from '@crish/shared-types';
import { WebSourceSheet } from '@/presentation/components/tools/WebSourceSheet';
import { WebPreviewSheet } from '@/presentation/components/webview/WebPreviewSheet';
import { haptics } from '@/adapters/platform/haptics';

/** 锚点节流写入间隔（ms）：非跟随滚动中最多每 200ms 落一次盘 */
const ANCHOR_SAVE_THROTTLE_MS = 200;
/** 就绪遮罩看门狗（ms）：布局/锚点信号异常缺失时强制就绪——会话不许
 * 被永久遮住；这是看门狗而非动效时长，不入 motion token 口径 */
const READY_COVER_FAILSAFE_MS = 2000;
/** 遮罩淡出（theme.motion.duration.menu）完成后的卸载宽限（ms） */
const COVER_UNMOUNT_SLACK_MS = 60;

/**
 * 跟随态变更来源（批 B ⑰⑱）：宿主可忽略。存在是为了让「脱离跟随」
 * 的来源可审计，且一切脱离都走同一条 onFollowChange 通道——不另起
 * 第二套跟随状态机。
 */
export type FollowChangeReason = 'user-toggled-disclosure' | 'anchor-restored';

function rowKey(row: TimelineRow): string {
  return `${row.kind}:${row.id}`;
}

/** 点内容区收键盘（模块级稳定引用：FlatList props 逐渲染不变，
 * 不给列表引入额外重渲染面）。失焦判定接线见 TimelineView 的
 * FlatList onTouchStart 处注释与 TimelineView.dismiss.test 钉测。 */
function dismissKeyboardForTimelineTap(): void {
  Keyboard.dismiss();
}

export interface TimelineViewProps {
  blocks: readonly TimelineBlock[];
  follow: boolean;
  onFollowChange: (following: boolean, reason?: FollowChangeReason) => void;
  listRef?: RefObject<FlatList<TimelineRow> | null>;
  /** 打开工具抽屉并定位到某组（focusId = 该组首个工具 id）；不传则摘要行只读 */
  onOpenTools?: (focusId: string) => void;
  emptyTitle?: string;
  /** 空态动作（引擎空态引导，如本地未配置 → 去配置；不传 = 无动作） */
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  /** 顶部避让高度（悬浮头栏时 = 安全区 + 头栏高度；缺省 = 常规内衬） */
  headerClearance?: number;
  /**
   * 底部避让高度（悬浮输入区时由宿主按实测浮层高推导，见
   * domain/pure/timelineBottomInset；缺省 = 常规内衬 xxl）。
   * 尾部内容能否完整滚到浮层上方，只由这个值决定。
   */
  bottomInset?: number;
  /**
   * 底部悬浮输入区净高 (不含键盘，方案 16 满页联动专用)
   */
  floatingOverlayHeight?: number;
  /** 尾部呼吸间隙 (默认 20dp) */
  bottomGap?: number;
  /** 引擎生成中：等待占位行（首个过程块落地前）的显隐信号 */
  busy?: boolean;
  /**
   * 阅读锚点键（宿主以 `${engine.kind}:${engine.id}` 构成，远端/本地
   * 双宿主共用本组件面一并覆盖）；不传 = 不做锚点持久化与恢复。
   */
  anchorKey?: string;
  /**
   * 就绪遮罩：打开会话时盖住列表区，布局完成 + 锚点恢复 settle 后
   * 淡出（~180ms，theme.motion.duration.menu），不让首帧错位被看见。
   * 次级宿主（运行详情等）不启用。
   */
  readyCover?: boolean;
  /** 重新生成回调（透传助手消息底部工具栏） */
  onRegenerate?: (messageId: string) => void;
  /** 是否允许重新生成（引擎空闲状态） */
  canRegenerate?: boolean;
  /** 单元测试中是否强制开启平滑动画追踪 */
  forceSmoothScroll?: boolean;
}

export function TimelineView({
  blocks,
  follow,
  onFollowChange,
  listRef,
  onOpenTools,
  emptyTitle = '暂无消息',
  emptyActionLabel,
  onEmptyAction,
  headerClearance,
  bottomInset,
  floatingOverlayHeight,
  bottomGap,
  busy = false,
  anchorKey,
  readyCover = false,
  onRegenerate,
  canRegenerate,
  forceSmoothScroll = false,
}: TimelineViewProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const internalRef = useRef<FlatList<TimelineRow> | null>(null);
  const targetRef = listRef ?? internalRef;

  const effectiveBottomInset =
    floatingOverlayHeight !== undefined
      ? floatingOverlayHeight + (bottomGap ?? theme.space.xl)
      : bottomInset !== undefined && bottomInset > 0
        ? bottomInset
        : theme.space.xxl;

  // 底部额外内衬共享值（驱动 KeyboardChatScrollView 的 extraContentPadding）
  const extraPaddingSV = useSharedValue(effectiveBottomInset);
  useEffect(() => {
    extraPaddingSV.value = effectiveBottomInset;
  }, [effectiveBottomInset, extraPaddingSV]);

  // 方案 19：120fps UI 线程 useKeyboardHandler 平滑插值与平移动态联动引擎
  const linkage = useSmoothKeyboardTimelineLinkage(targetRef, {
    follow,
    overlayHeight:
      floatingOverlayHeight ??
      (bottomInset !== undefined && bottomInset > 0
        ? bottomInset
        : theme.space.xxl),
    gap: bottomGap ?? theme.space.xl,
    headerClearance,
    onFollowChange,
  });

  // 编程式滚动互斥锁：防止平滑回底动画期间 handleScroll 误判脱离跟随（方案 16）
  const isProgrammaticScrollingRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  // 拦截并保护平滑滚动
  useEffect(() => {
    const list = targetRef.current;
    if (!list) return;
    const originalScrollToEnd = list.scrollToEnd.bind(list);
    list.scrollToEnd = (params?: { animated?: boolean | null }) => {
      const animated = params?.animated ?? true;
      if (animated) {
        isProgrammaticScrollingRef.current = true;
        if (programmaticScrollTimerRef.current !== null) {
          clearTimeout(programmaticScrollTimerRef.current);
        }
        programmaticScrollTimerRef.current = setTimeout(() => {
          isProgrammaticScrollingRef.current = false;
          programmaticScrollTimerRef.current = null;
        }, 350);
      }
      originalScrollToEnd(params);
    };
    return () => {
      if (programmaticScrollTimerRef.current !== null) {
        clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      list.scrollToEnd = originalScrollToEnd;
    };
  }, [targetRef]);
  const display = useMemo(() => groupToolRuns(blocks), [blocks]);
  const rows = useMemo(() => insertTimeSeparators(display), [display]);
  // ── 批 B 状态面：折叠选择 / 锚点 / 就绪遮罩 ─────────────
  // 折叠区展开选择按块 id 记忆：FlatList 回收重挂载不丢用户在该块上
  // 的选择（Map 由本组件持有、引用稳定，不进渲染状态）。
  const disclosureRef = useRef(new Map<string, boolean>());
  // 回调内读最新值的镜像 refs（避免把高频变化值塞进 useCallback 依赖）
  const followRef = useRef(follow);
  followRef.current = follow;
  const anchorKeyRef = useRef(anchorKey);
  anchorKeyRef.current = anchorKey;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // 行布局图（key → 内容坐标 y/高）：锚点存取的地基，
  // 由每行外层 View 的 onLayout 回填（见 renderItem）。
  const layoutMapRef = useRef(new Map<string, { y: number; height: number }>());
  const scrollYRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const firstViewableKeyRef = useRef<string | null>(null);
  const lastAnchorSaveAtRef = useRef(0);
  // 锚点恢复阶段：loading（读盘中）→ restoring（有锚点待落位）→ done。
  // 阶段未 done 前跟随贴底被抑制（scheduleScrollToEnd 内守卫），防
  // 恢复落位与贴底互相打架；遮罩在此期间盖住列表（readyCover 时）。
  type AnchorPhase = 'loading' | 'restoring' | 'done';
  const anchorPhaseRef = useRef<AnchorPhase>(anchorKey ? 'loading' : 'done');
  const savedAnchorRef = useRef<ScrollAnchor | null>(null);
  const [anchorSettled, setAnchorSettled] = useState(!anchorKey);
  // 就绪遮罩：列表首帧布局完成（listLaidOut）+ 锚点 settle 后淡出
  const [listLaidOut, setListLaidOut] = useState(false);
  const [coverGone, setCoverGone] = useState(false);
  // 网页来源半屏详情抽屉与应用内安全预览抽屉交互态
  const [selectedSource, setSelectedSource] = useState<{
    source: WebSearchSource;
    citationIndex?: number;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState<string | undefined>(
    undefined
  );
  const [highlightedSourceIndex, setHighlightedSourceIndex] = useState<
    number | undefined
  >(undefined);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSelectSource = useCallback((source: WebSearchSource) => {
    void haptics.selection();
    setSelectedSource({ source });
  }, []);

  const handleCitationPress = useCallback(
    (citationIndex: number) => {
      void haptics.selection();
      setHighlightedSourceIndex(citationIndex - 1);
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedSourceIndex(undefined);
        highlightTimerRef.current = null;
      }, 2000);

      const allSources: WebSearchSource[] = [];
      for (const b of blocks) {
        if (b.kind === 'tool' && Array.isArray(b.webSources)) {
          allSources.push(...b.webSources);
        }
      }
      const matched = allSources[citationIndex - 1];
      if (matched) {
        setSelectedSource({
          source: matched,
          citationIndex,
        });
      }
    },
    [blocks]
  );

  const handleOpenPreview = useCallback(
    (url: string) => {
      const curTitle = selectedSource?.source.title;
      setSelectedSource(null);
      setPreviewUrl(url);
      setPreviewTitle(curTitle);
    },
    [selectedSource]
  );

  const handleCloseSourceSheet = useCallback(() => {
    setSelectedSource(null);
  }, []);

  const handleClosePreviewSheet = useCallback(() => {
    setPreviewUrl(null);
    setPreviewTitle(undefined);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);
  const coverOpacity = useSharedValue(1);
  const coverFadeMs = theme.motion.duration.menu;
  const coverStyle = useAnimatedStyle(() => ({ opacity: coverOpacity.value }));
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 1 });

  /** ⑰：展开/折叠任何折叠区即脱离跟随（走既有状态机通道，不另起状态） */
  const handleToggleDisclosure = useCallback(() => {
    onFollowChange(false, 'user-toggled-disclosure');
  }, [onFollowChange]);

  const handleRowLayout = useCallback(
    (key: string, event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      layoutMapRef.current.set(key, { y, height });
    },
    []
  );

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      firstViewableKeyRef.current = first?.key ?? null;
    },
    []
  );

  /** 当前阅读锚点 = 首个可见行 + 块内偏移（分隔行不作锚点：其 id 派生自触发块） */
  const computeCurrentAnchor = useCallback((): ScrollAnchor | null => {
    const key = firstViewableKeyRef.current;
    if (!key) return null;
    const row = rowsRef.current.find((r) => rowKey(r) === key);
    if (!row || row.kind === 'timeSeparator') return null;
    const layout = layoutMapRef.current.get(key);
    return {
      blockId: row.id,
      offsetPx: layout
        ? anchorOffsetWithinBlock(scrollYRef.current, layout.y)
        : 0,
    };
  }, []);
  const computeAnchorRef = useRef(computeCurrentAnchor);
  computeAnchorRef.current = computeCurrentAnchor;

  /** 锚点节流写入：仅非跟随态（跟随态底部即位置，锚点无意义且会被清） */
  const persistAnchorThrottled = useCallback(() => {
    const key = anchorKeyRef.current;
    if (!key || followRef.current) return;
    const now = Date.now();
    if (now - lastAnchorSaveAtRef.current < ANCHOR_SAVE_THROTTLE_MS) return;
    const anchor = computeAnchorRef.current();
    if (!anchor) return;
    lastAnchorSaveAtRef.current = now;
    saveScrollAnchor(key, anchor);
  }, []);

  /** 锚点落位：布局图有坐标走 scrollToOffset 精定位；否则 scrollToIndex 估算 + 失败重试 */
  const attemptAnchorRestore = useCallback(() => {
    if (anchorPhaseRef.current !== 'restoring') return;
    const anchor = savedAnchorRef.current;
    const list = targetRef.current;
    if (!anchor || !list) return;
    const index = rowsRef.current.findIndex(
      (row) => row.kind !== 'timeSeparator' && row.id === anchor.blockId
    );
    anchorPhaseRef.current = 'done';
    setAnchorSettled(true);
    if (index < 0) {
      // 锚点块已不在（历史被清理等）：保持宿主默认跟随，不强行定位
      return;
    }
    const layout = layoutMapRef.current.get(rowKey(rowsRef.current[index]!));
    if (layout) {
      list.scrollToOffset({
        offset: restoreScrollOffset(layout.y, anchor.offsetPx),
        animated: false,
      });
    } else {
      list.scrollToIndex({
        index,
        animated: false,
        viewOffset: -anchor.offsetPx,
      });
    }
    onFollowChange(false, 'anchor-restored');
  }, [onFollowChange, targetRef]);

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const list = targetRef.current;
      if (!list) return;
      list.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: false,
      });
      // 估算落位后行布局补齐，下一帧按锚点精定位一次（一次性重试，
      // 非滚动提交合并——红线针对的是流式贴底的 rAF 合并）
      requestAnimationFrame(() => {
        const anchor = savedAnchorRef.current;
        if (!anchor) return;
        const index = rowsRef.current.findIndex(
          (row) => row.kind !== 'timeSeparator' && row.id === anchor.blockId
        );
        if (index < 0) return;
        const layout = layoutMapRef.current.get(
          rowKey(rowsRef.current[index]!)
        );
        if (layout) {
          list.scrollToOffset({
            offset: restoreScrollOffset(layout.y, anchor.offsetPx),
            animated: false,
          });
        }
      });
    },
    [targetRef]
  );

  // 锚点读盘（anchorKey 变更即重走恢复链）
  useEffect(() => {
    if (!anchorKey) {
      anchorPhaseRef.current = 'done';
      setAnchorSettled(true);
      return;
    }
    let cancelled = false;
    anchorPhaseRef.current = 'loading';
    setAnchorSettled(false);
    void loadScrollAnchor(anchorKey).then((anchor) => {
      if (cancelled) return;
      savedAnchorRef.current = anchor;
      anchorPhaseRef.current = anchor ? 'restoring' : 'done';
      if (!anchor) {
        setAnchorSettled(true);
      } else {
        // 读盘完成即主动落位一次：contentSizeChange 可能先于读盘
        // 触发过（那时阶段还是 loading、attempt 空转），静态会话
        // 之后未必再有尺寸变化，不能把恢复押在下一次触发上
        attemptAnchorRestore();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchorKey, attemptAnchorRestore]);

  // 行集变化（含历史异步到达）时尝试锚点落位
  useEffect(() => {
    attemptAnchorRestore();
  }, [rows, attemptAnchorRestore]);

  // 脱离跟随后再回到跟随态 → 锚点作废（底部即当前位置）。只认
  // false→true 跃迁：宿主挂载时 follow 初始恒为 true，若挂载即清会
  // 与上面的锚点读盘赛跑、把待恢复的锚点误删
  const prevFollowRef = useRef(follow);
  useEffect(() => {
    const wasFollowing = prevFollowRef.current;
    prevFollowRef.current = follow;
    if (follow && !wasFollowing) {
      if (anchorKey) {
        clearScrollAnchor(anchorKey);
      }
      savedAnchorRef.current = null;
      anchorPhaseRef.current = 'done';
    }
  }, [follow, anchorKey]);

  // 卸载时补写最后锚点（节流窗口内的尾段滚动不丢）
  useEffect(
    () => () => {
      const key = anchorKeyRef.current;
      if (!key || followRef.current) return;
      const anchor = computeAnchorRef.current();
      if (anchor) saveScrollAnchor(key, anchor);
    },
    []
  );

  // 宽度变化（旋转/分屏）后行高重排：非跟随态按当前锚点重新落位
  const { width: windowWidth } = useWindowDimensions();
  const prevWidthRef = useRef(windowWidth);
  useEffect(() => {
    if (prevWidthRef.current === windowWidth) return;
    prevWidthRef.current = windowWidth;
    if (followRef.current) return;
    requestAnimationFrame(() => {
      const anchor = computeAnchorRef.current();
      const list = targetRef.current;
      if (!anchor || !list) return;
      const index = rowsRef.current.findIndex(
        (row) => row.kind !== 'timeSeparator' && row.id === anchor.blockId
      );
      if (index < 0) return;
      const layout = layoutMapRef.current.get(rowKey(rowsRef.current[index]!));
      if (layout) {
        list.scrollToOffset({
          offset: restoreScrollOffset(layout.y, anchor.offsetPx),
          animated: false,
        });
      }
    });
  }, [windowWidth, targetRef]);

  // 就绪遮罩退出：布局 + 锚点双就绪 → 淡出后卸载（卸载由 JS 计时器
  // 驱动，与 reanimated 淡出同长——测试环境无 UI 线程亦不残留遮罩）
  const coverReady = listLaidOut && anchorSettled;
  useEffect(() => {
    if (!readyCover || coverGone || !coverReady) return;
    if (reducedMotion) {
      setCoverGone(true);
      return;
    }
    coverOpacity.value = withTiming(0, {
      duration: coverFadeMs,
      easing: Easing.bezier(...theme.motion.easing.decelerate),
    });
    const timer = setTimeout(
      () => setCoverGone(true),
      coverFadeMs + COVER_UNMOUNT_SLACK_MS
    );
    return () => clearTimeout(timer);
  }, [
    readyCover,
    coverGone,
    coverReady,
    reducedMotion,
    coverOpacity,
    coverFadeMs,
    theme,
  ]);

  // 遮罩看门狗：信号异常缺失时强制就绪（见 READY_COVER_FAILSAFE_MS）
  useEffect(() => {
    if (!readyCover) return;
    const timer = setTimeout(() => {
      setListLaidOut(true);
      if (anchorPhaseRef.current !== 'done') {
        anchorPhaseRef.current = 'done';
        setAnchorSettled(true);
      }
    }, READY_COVER_FAILSAFE_MS);
    return () => clearTimeout(timer);
  }, [readyCover]);

  // 手势与滚动调度守卫：保护用户手动拖拽浏览，防止流式打字与 Yoga 排版测高抢夺手势
  const isDraggingRef = useRef(false);
  const isMomentumRef = useRef(false);
  const autoScroll = useTimelineAutoScroll({
    targetRef,
    follow,
    busy,
    effectiveBottomInset,
    viewportHeightRef,
    scrollYRef,
    isDraggingRef,
    isMomentumRef,
    isProgrammaticScrollingRef,
    anchorPhaseRef,
    hasBlocks: blocks.length > 0,
    reducedMotion,
    forceSmoothScroll,
  });

  const scheduleScrollToEndRef = useRef(autoScroll.scheduleScrollToEnd);
  scheduleScrollToEndRef.current = autoScroll.scheduleScrollToEnd;

  useEffect(() => {
    if (
      !follow ||
      isDraggingRef.current ||
      isMomentumRef.current ||
      isProgrammaticScrollingRef.current ||
      blocks.length === 0
    )
      return;
    scheduleScrollToEndRef.current(false);
  }, [follow, blocks.length]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollYRef.current = contentOffset.y;
    viewportHeightRef.current = layoutMeasurement.height;
    // 同步给动力学联动控制器（方案 19）
    linkage.notifyScroll(
      contentOffset.y,
      layoutMeasurement.height,
      contentSize.height
    );

    // 关键守卫：如果在编程式平滑回底过程中，绝对禁止逆向翻转 follow 状态！（方案 16）
    if (isProgrammaticScrollingRef.current) {
      const distance =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distance <= 32) {
        // 已经提前平滑到达底部，提前释放互斥锁
        isProgrammaticScrollingRef.current = false;
        if (programmaticScrollTimerRef.current !== null) {
          clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }
      return; // 屏蔽后续的 evaluateFollowState，防止动画半途中被误杀
    }

    const distance =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const isInteracting = isDraggingRef.current || isMomentumRef.current;
    // 传入 isInteracting：仅当用户明确手势滑动且离开底部 >64dp 时退出跟随；内容自然膨胀绝不退出
    const following = evaluateFollowState(distance, follow, isInteracting);
    if (following !== follow) {
      if (!following) {
        autoScroll.cancelStreamingChase();
      }
      onFollowChange(following);
    }
    // 锚点节流落盘（仅非跟随态，见 persistAnchorThrottled）
    persistAnchorThrottled();
  };

  const handleContentSizeChange = useCallback(
    (_w: number, _h: number) => {
      linkage.notifyContentHeight(_h);
      // 内容尺寸到位是锚点落位的最早可信时机（布局图随行 onLayout 同批补齐）
      attemptAnchorRestore();
      // 委托给 autoScroll 控制器：流式期间满帧阻尼平滑上推，消除段落感
      autoScroll.handleContentSizeChange(_w, _h);
    },
    [linkage, attemptAnchorRestore, autoScroll]
  );

  const handleScrollBeginDrag = useCallback(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // 用户手指介入拖拽，立即释放编程式滚动锁并让手势绝对优先
      if (isProgrammaticScrollingRef.current) {
        isProgrammaticScrollingRef.current = false;
        if (programmaticScrollTimerRef.current !== null) {
          clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }
      // 手势中断感知：一旦用户触摸屏幕拖动，瞬间取消自动推升循环，绝不与用户手势争抢
      autoScroll.cancelStreamingChase();
      // 锁定手势：用户手动拖拽期间严禁流式更新或 Yoga 排版重排打断手势响应链
      isDraggingRef.current = true;
      isMomentumRef.current = false;
    },
    [autoScroll]
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const vy = Math.abs(event.nativeEvent?.velocity?.y ?? 0);
      isMomentumRef.current = vy > 0.05;
      handleScroll(event);
      isDraggingRef.current = false;
    },
    [handleScroll]
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isDraggingRef.current = false;
      isMomentumRef.current = false;
      handleScroll(event);
    },
    [handleScroll]
  );

  // 等待占位行（04-3）：busy 且最后一个用户块之后尚无任何过程内容
  // （reasoning / 助手消息 / 工具 / 图片）时呈现，首个过程块落地即被
  // 真实块顶替。有前置工作（转写/OCR 等）的场景在本仓前置面位于
  // Composer/浮层侧、时间线内无原因信号，故占位行不带原因文案——
  // 无信号不编（批 B 口径）。
  const awaitingFirstToken = useMemo(() => {
    if (!busy || blocks.length === 0) return false;
    let lastUserIndex = -1;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!;
      if (block.kind === 'message' && block.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    const segment =
      lastUserIndex >= 0 ? blocks.slice(lastUserIndex + 1) : blocks;
    return !segment.some(
      (block) =>
        block.kind === 'reasoning' ||
        block.kind === 'message' ||
        block.kind === 'tool' ||
        block.kind === 'image'
    );
  }, [blocks, busy]);

  return (
    <>
      <FlatList
        ref={targetRef}
        testID="session-timeline"
        data={rows}
        keyExtractor={(row) => rowKey(row)}
        renderScrollComponent={(props) => (
          <KeyboardChatScrollView
            {...props}
            keyboardLiftBehavior="never"
            extraContentPadding={extraPaddingSV}
          />
        )}
        // 滚动复用免动画（实现波总方案 F5/N04：删除每项 FadeIn 包裹——
        // 回收再挂载反复淡入是高刷滚动闪烁根因）；首击不吞噬 + 滑动收键盘
        // 每行包一层 onLayout 壳回填布局图（锚点/尾部冻结地基）；壳无
        // 样式、布局语义与原先直子一致（contentContainer 的 gap 落在壳上）
        renderItem={({ item }) => {
          const key = rowKey(item);
          if (item.kind === 'timeSeparator') {
            return (
              <View
                style={{ width: '100%' }}
                onLayout={(event) => handleRowLayout(key, event)}
              >
                <TimeSeparatorRow atMs={item.atMs} />
              </View>
            );
          }
          return (
            <View
              style={{ width: '100%' }}
              onLayout={(event) => handleRowLayout(key, event)}
            >
              <TimelineBlockView
                block={item}
                onOpenTools={onOpenTools}
                onSelectSource={handleSelectSource}
                onCitationPress={handleCitationPress}
                highlightedSourceIndex={highlightedSourceIndex}
                disclosureStore={disclosureRef.current}
                onToggleDisclosure={handleToggleDisclosure}
                onRegenerate={onRegenerate}
                canRegenerate={canRegenerate}
              />
            </View>
          );
        }}
        viewabilityConfig={viewabilityConfigRef.current}
        onViewableItemsChanged={handleViewableItemsChanged}
        onLayout={(event) => {
          viewportHeightRef.current = event.nativeEvent.layout.height;
          linkage.notifyLayout(event.nativeEvent.layout.height);
          setListLaidOut(true);
        }}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // 点外失焦（2026-11-03 用户实测：点内容区输入框不失焦、键盘不
        // 退）：全仓原无一处 Keyboard.dismiss，列表只有 on-drag 一条收
        // 键盘路径，静止点按无路可走。onTouchStart 是被动通知（不认领
        // responder、不拦事件）：行内 Pressable 的点按/长按语义照常，
        // 触摸落在列表子树（行/空白/空态）即冒泡到此收键盘；Composer
        // 是宿主侧的兄弟浮层、不在本子树内，其内部控件永不触发本路。
        // 无悬浮输入区的宿主（runDetail 等）下 Keyboard.dismiss 为无操作。
        onTouchStart={dismissKeyboardForTimelineTap}
        onContentSizeChange={handleContentSizeChange}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollIndicatorInsets={{
          top: headerClearance ?? 0,
          bottom: 0, // 由 KeyboardChatScrollView 内部 indicatorPadding 统一托管
        }}
        contentContainerStyle={[
          {
            // 原型 conv-message-list：左右 18、消息 gap 16（token 无 18 档，定值落位）
            paddingHorizontal: 18,
            paddingTop: headerClearance ?? theme.space.lg,
            paddingBottom: 0, // 核心改动：彻底归零！完全交由 extraContentPadding 在原生层处理，严禁双重叠加
            gap: theme.space.lg,
          },
          blocks.length === 0 && styles.emptyContent,
        ]}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        initialNumToRender={16}
        maxToRenderPerBatch={16}
        windowSize={9}
        ListEmptyComponent={
          <EmptyState
            title={emptyTitle}
            action={
              emptyActionLabel && onEmptyAction ? (
                <Button
                  label={emptyActionLabel}
                  onPress={onEmptyAction}
                  testID="session-empty-action"
                />
              ) : undefined
            }
          />
        }
        ListFooterComponent={
          awaitingFirstToken ? (
            // 与 ReasoningView 组头同几何（reasoningContainer +
            // reasoningHeader + caption）：首 token 落地换成真实
            // reasoning 头时零跳动——行高由文字行高决定，占位行不带
            // 折叠箭头（箭头 12px 小于 caption 行高，不撑高）
            <View
              testID="timeline-waiting-row"
              style={styles.reasoningContainer}
            >
              <View
                style={[
                  styles.inlineRow,
                  styles.reasoningHeader,
                  { gap: theme.space.xs },
                ]}
              >
                <AppText variant="caption" color="textTertiary">
                  正在思考...
                </AppText>
              </View>
            </View>
          ) : null
        }
      />
      {readyCover && !coverGone ? (
        // 就绪遮罩：实色盖住列表区（头栏/Composer 在宿主侧后渲染、位于
        // 其上，不被遮），布局 + 锚点就绪后经 coverStyle 淡出并卸载
        <Animated.View
          testID="timeline-ready-cover"
          style={[
            styles.readyCover,
            { backgroundColor: theme.colors.canvas },
            coverStyle,
          ]}
        >
          <LoadingState label="正在打开会话…" />
        </Animated.View>
      ) : null}
      <WebSourceSheet
        visible={selectedSource !== null}
        source={selectedSource?.source ?? null}
        citationIndex={selectedSource?.citationIndex}
        onClose={handleCloseSourceSheet}
        onOpenPreview={handleOpenPreview}
      />
      <WebPreviewSheet
        visible={previewUrl !== null}
        url={previewUrl ?? ''}
        title={previewTitle}
        onClose={handleClosePreviewSheet}
      />
    </>
  );
}

/** 时间分隔行（批 B ㉑）：居中时间小字，间隔 ≥5 分钟才由 insertTimeSeparators 插入 */
function TimeSeparatorRow({ atMs }: { atMs: number }) {
  return (
    <View style={[styles.inlineRow, styles.center]}>
      <AppText variant="caption" color="textTertiary" style={styles.centerText}>
        {formatTimeSeparator(atMs)}
      </AppText>
    </View>
  );
}

const TimelineBlockView = memo(function TimelineBlockView({
  block,
  onOpenTools,
  onSelectSource,
  onCitationPress,
  highlightedSourceIndex,
  disclosureStore,
  onToggleDisclosure,
  onRegenerate,
  canRegenerate,
}: {
  block: DisplayBlock;
  onOpenTools?: (focusId: string) => void;
  onSelectSource?: (source: WebSearchSource) => void;
  onCitationPress?: (index: number) => void;
  highlightedSourceIndex?: number;
  /** 折叠选择记忆表（TimelineView 持有，按块 id 存展开态） */
  disclosureStore?: Map<string, boolean>;
  /** ⑰ 折叠区切换通知（宿主据此脱离跟随） */
  onToggleDisclosure?: () => void;
  onRegenerate?: (messageId: string) => void;
  canRegenerate?: boolean;
}) {
  switch (block.kind) {
    case 'message':
      return (
        <MessageView
          block={block}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
          onCitationPress={onCitationPress}
        />
      );
    case 'image':
      return <MessageImageView block={block} />;
    case 'toolRun':
      return (
        <ToolSummaryRow
          run={block}
          onOpen={onOpenTools}
          onSelectSource={onSelectSource}
          highlightedSourceIndex={highlightedSourceIndex}
        />
      );
    case 'approval':
      // 流内不渲染审批行：待审批由全局悬浮卡承载（见文件头注）
      return null;
    case 'notice':
      return <NoticeView block={block} />;
    case 'reasoning':
      return (
        <ReasoningCard
          block={block}
          disclosureStore={disclosureStore}
          onToggleDisclosure={onToggleDisclosure}
        />
      );
    default:
      return null;
  }
});

function MessageView({
  block,
  canRegenerate,
  onRegenerate,
  onCitationPress,
}: {
  block: AssistantMessageBlock;
  canRegenerate?: boolean;
  onRegenerate?: (messageId: string) => void;
  onCitationPress?: (index: number) => void;
}) {
  const theme = useTheme();
  if (block.role === 'user') {
    return <UserMessageRow id={block.id} text={block.text} />;
  }
  const cleanText = block.text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // 渲染层严格非空守门：收口后若无正文内容，绝不渲染幽灵空气泡
  if (cleanText === '' && !block.streaming) {
    return null;
  }
  return (
    <View style={styles.assistantMessageContainer}>
      <StreamingText
        identity={`message:${block.id}`}
        text={block.text}
        streaming={block.streaming}
        onCitationPress={onCitationPress}
        cursorStyle={{ color: theme.colors.textTertiary }}
        style={[theme.type.chat, { color: theme.colors.textPrimary }]}
      />
      <MessageActionBar
        messageId={block.id}
        text={block.text}
        streaming={block.streaming}
        canRegenerate={canRegenerate}
        onRegenerate={onRegenerate}
      />
    </View>
  );
}

/** 消息级图片块：有可用来源呈现图片，无来源呈现占位行（不静默丢内容） */
function MessageImageView({ block }: { block: MessageImageBlock }) {
  return block.source ? (
    <TimelineImage source={block.source} alt={block.alt} />
  ) : (
    <TimelineImagePlaceholder alt={block.alt} />
  );
}

function noticeColor(tone: NoticeBlock['tone']): TextColor {
  switch (tone) {
    case 'danger':
      return 'danger';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'info':
    case 'muted':
      return 'textTertiary';
  }
}

function NoticeView({ block }: { block: NoticeBlock }) {
  const theme = useTheme();
  const color = noticeColor(block.tone);
  // 批 C ⑮：失败 notice 的原始诊断串只在用户点开后呈现（主文案 =
  // 分类映射后的标题 + 一句话）；无 detail 的 notice 保持静态呈现。
  const [detailOpen, setDetailOpen] = useState(false);
  if (!block.detail) {
    return (
      <View style={[styles.inlineRow, styles.center, { gap: theme.space.xs }]}>
        {/* N05 裁定：danger 红字已表达警示，前置叹号属装饰，不显示 */}
        <AppText variant="caption" color={color} style={styles.centerText}>
          {block.text}
        </AppText>
      </View>
    );
  }
  return (
    <View style={{ gap: theme.space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={block.text}
        accessibilityState={{ expanded: detailOpen }}
        onPress={() => setDetailOpen((v) => !v)}
        style={[styles.inlineRow, styles.center, { gap: theme.space.xs }]}
      >
        <AppText variant="caption" color={color} style={styles.centerText}>
          {block.text}
        </AppText>
        <Icon name={detailOpen ? 'chevron-down' : 'chevron-right'} size={12} />
      </Pressable>
      {detailOpen ? (
        <AppText
          variant="caption"
          color="textTertiary"
          style={styles.centerText}
        >
          {block.detail}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  userRow: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '82%' },
  assistantMessageContainer: { width: '100%' },
  inlineRow: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  reasoningContainer: { marginVertical: 4 },
  reasoningHeader: { paddingVertical: 2 },
  reasoningBody: { borderLeftWidth: 2 },
  // 就绪遮罩：盖住列表区全域，内容垂直居中（LoadingState 自带节奏）
  readyCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
  },
});

export default TimelineView;
export { useSmoothKeyboardTimelineLinkage } from './useSmoothKeyboardTimelineLinkage';
export { useTimelineAutoScroll } from './useTimelineAutoScroll';
export { useKeyboardHandler } from 'react-native-keyboard-controller';
