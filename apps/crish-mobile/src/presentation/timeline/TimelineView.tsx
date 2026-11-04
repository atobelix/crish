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
  MarkdownText,
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
import {
  formatTimeSeparator,
  insertTimeSeparators,
  type TimelineRow,
} from './insertTimeSeparators';
import {
  anchorOffsetWithinBlock,
  restoreScrollOffset,
  shouldFreezeTail,
} from './timelineScrollRules';
import {
  clearScrollAnchor,
  loadScrollAnchor,
  saveScrollAnchor,
  type ScrollAnchor,
} from '@/domain/store/scrollAnchorStore';
import { evaluateFollowState } from '@/domain/pure/timelineBottomInset';

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
  busy = false,
  anchorKey,
  readyCover = false,
  onRegenerate,
  canRegenerate,
}: TimelineViewProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const internalRef = useRef<FlatList<TimelineRow> | null>(null);
  const targetRef = listRef ?? internalRef;
  const display = useMemo(() => groupToolRuns(blocks), [blocks]);
  const rows = useMemo(() => insertTimeSeparators(display), [display]);
  const tail = blocks[blocks.length - 1];
  const tailSignal =
    tail?.kind === 'message' ? tail.text.length : blocks.length;

  // ── 批 B 状态面：折叠选择 / 锚点 / 尾部冻结 / 就绪遮罩 ─────────────
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
  // 行布局图（key → 内容坐标 y/高）：锚点存取与尾部冻结的共同地基，
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
  // 离屏流式尾部冻结快照（冻结的行以捕获时的块对象渲染，见 ㉕）
  const [frozenTail, setFrozenTail] = useState<DisplayBlock | null>(null);
  const frozenTailKeyRef = useRef<string | null>(null);
  // 就绪遮罩：列表首帧布局完成（listLaidOut）+ 锚点 settle 后淡出
  const [listLaidOut, setListLaidOut] = useState(false);
  const [coverGone, setCoverGone] = useState(false);
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

  /** ㉕ 离屏流式尾部冻结评估：仅在迟滞带跨越时改状态，滚动热路径零重渲染 */
  const evaluateTailFreeze = useCallback(() => {
    const clear = () => {
      if (frozenTailKeyRef.current !== null) {
        frozenTailKeyRef.current = null;
        setFrozenTail(null);
      }
    };
    const currentRows = rowsRef.current;
    const tailRow = currentRows[currentRows.length - 1];
    if (!tailRow || tailRow.kind === 'timeSeparator') {
      clear();
      return;
    }
    const freezable =
      (tailRow.kind === 'message' && tailRow.streaming) ||
      (tailRow.kind === 'reasoning' &&
        (tailRow.streaming || tailRow.isThinking));
    // 跟随态尾部恒在屏内（贴底），冻结无意义且会挡住流式呈现
    if (!freezable || followRef.current) {
      clear();
      return;
    }
    const key = rowKey(tailRow);
    const layout = layoutMapRef.current.get(key);
    if (!layout) {
      clear();
      return;
    }
    const distanceBelow =
      layout.y - (scrollYRef.current + viewportHeightRef.current);
    if (shouldFreezeTail(distanceBelow, frozenTailKeyRef.current === key)) {
      if (frozenTailKeyRef.current !== key) {
        frozenTailKeyRef.current = key;
        setFrozenTail(tailRow);
      }
    } else {
      clear();
    }
  }, []);

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
    if (follow && !wasFollowing && anchorKey) {
      clearScrollAnchor(anchorKey);
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

  // 尾行变化（新流式尾块出现/封口）时重评冻结
  useEffect(() => {
    evaluateTailFreeze();
  }, [display, evaluateTailFreeze]);

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
  const rafScrollRef = useRef<number | null>(null);

  const scheduleScrollToEnd = useCallback(
    (animated = false) => {
      if (
        !follow ||
        isDraggingRef.current ||
        isMomentumRef.current ||
        blocks.length === 0
      )
        return;
      // 锚点恢复未 settle 前禁止贴底：恢复落位与贴底同帧竞争会把
      // 用户拽回底部（遮罩在此期间盖住列表，就绪后二选一生效）
      if (anchorPhaseRef.current !== 'done') return;
      if (rafScrollRef.current !== null) {
        cancelAnimationFrame(rafScrollRef.current);
      }
      rafScrollRef.current = requestAnimationFrame(() => {
        rafScrollRef.current = null;
        if (
          !follow ||
          isDraggingRef.current ||
          isMomentumRef.current ||
          blocks.length === 0
        )
          return;
        if (anchorPhaseRef.current !== 'done') return;
        targetRef.current?.scrollToEnd({ animated });
      });
    },
    [follow, blocks.length, targetRef]
  );

  useEffect(() => {
    return () => {
      if (rafScrollRef.current !== null) {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (
      !follow ||
      isDraggingRef.current ||
      isMomentumRef.current ||
      blocks.length === 0
    )
      return;
    scheduleScrollToEnd(false);
    // bottomInset 入 deps：浮层增厚（错误条/停止胶囊出现、键盘弹起）
    // 时跟随态须重新贴底，否则尾部会被新浮层压住一截
  }, [follow, blocks.length, tailSignal, scheduleScrollToEnd, bottomInset]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollYRef.current = contentOffset.y;
    viewportHeightRef.current = layoutMeasurement.height;
    const distance =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const following = evaluateFollowState(distance, follow);
    if (following !== follow) onFollowChange(following);
    // 锚点节流落盘 + 尾部冻结重评（均为 ref 级计算，跨阈值才改状态）
    persistAnchorThrottled();
    evaluateTailFreeze();
  };

  const handleContentSizeChange = useCallback(
    (_w: number, _h: number) => {
      // 内容尺寸到位是锚点落位的最早可信时机（布局图随行 onLayout 同批补齐）
      attemptAnchorRestore();
      evaluateTailFreeze();
      // 原生 Yoga 测高完成且处于 follow 状态时，通过 requestAnimationFrame 安排 scrollToEnd，
      // 彻底解决文本换行或新块渲染后尺寸增加留在视口外“划不动”的断裂
      if (
        follow &&
        !isDraggingRef.current &&
        !isMomentumRef.current &&
        blocks.length > 0
      ) {
        scheduleScrollToEnd(false);
      }
    },
    [
      follow,
      blocks.length,
      scheduleScrollToEnd,
      attemptAnchorRestore,
      evaluateTailFreeze,
    ]
  );

  const handleScrollBeginDrag = useCallback(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // 锁定手势：用户手动拖拽期间严禁流式更新或 Yoga 排版重排打断手势响应链
      isDraggingRef.current = true;
      isMomentumRef.current = false;
      if (rafScrollRef.current !== null) {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = null;
      }
    },
    []
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isDraggingRef.current = false;
      const vy = Math.abs(event.nativeEvent?.velocity?.y ?? 0);
      isMomentumRef.current = vy > 0.05;
      handleScroll(event);
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
        // 滚动复用免动画（实现波总方案 F5/N04：删除每项 FadeIn 包裹——
        // 回收再挂载反复淡入是高刷滚动闪烁根因）；首击不吞噬 + 滑动收键盘
        // 每行包一层 onLayout 壳回填布局图（锚点/尾部冻结地基）；壳无
        // 样式、布局语义与原先直子一致（contentContainer 的 gap 落在壳上）
        renderItem={({ item }) => {
          const key = rowKey(item);
          if (item.kind === 'timeSeparator') {
            return (
              <View onLayout={(event) => handleRowLayout(key, event)}>
                <TimeSeparatorRow atMs={item.atMs} />
              </View>
            );
          }
          // ㉕ 冻结中的尾行以捕获快照渲染（冻结块封口/回屏/跟随即解冻，
          // 由 evaluateTailFreeze 清快照后自动换回实时块）
          const shown =
            frozenTail !== null && frozenTailKeyRef.current === key
              ? frozenTail
              : item;
          return (
            <View onLayout={(event) => handleRowLayout(key, event)}>
              <TimelineBlockView
                block={shown}
                onOpenTools={onOpenTools}
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
          bottom:
            bottomInset !== undefined && bottomInset > 0
              ? bottomInset
              : theme.space.xxl,
        }}
        contentContainerStyle={[
          {
            // 原型 conv-message-list：左右 18、消息 gap 16（token 无 18 档，定值落位）
            paddingHorizontal: 18,
            paddingTop: headerClearance ?? theme.space.lg,
            paddingBottom:
              bottomInset !== undefined && bottomInset > 0
                ? bottomInset
                : theme.space.xxl,
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
  disclosureStore,
  onToggleDisclosure,
  onRegenerate,
  canRegenerate,
}: {
  block: DisplayBlock;
  onOpenTools?: (focusId: string) => void;
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
        />
      );
    case 'image':
      return <MessageImageView block={block} />;
    case 'toolRun':
      return <ToolSummaryRow run={block} onOpen={onOpenTools} />;
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
}: {
  block: AssistantMessageBlock;
  canRegenerate?: boolean;
  onRegenerate?: (messageId: string) => void;
}) {
  const theme = useTheme();
  if (block.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View
          style={[
            styles.userBubble,
            {
              // 用户气泡（原型 18/18/4/18）：尾角朝发言侧收窄
              backgroundColor: theme.colors.bubbleUser,
              borderTopLeftRadius: theme.radius.bubble,
              borderTopRightRadius: theme.radius.bubble,
              borderBottomRightRadius: theme.radius.bubbleTail,
              borderBottomLeftRadius: theme.radius.bubble,
              // 原型 msg-user-bubble：padding 10/14（原型的微阴影不采——
              // 去阴影裁决 2026-11-02，墨色气泡靠自身明度差区分）
              paddingHorizontal: 14,
              paddingVertical: 10,
            },
          ]}
        >
          <MarkdownText
            text={block.text}
            baseStyle={[
              theme.type.chat,
              { color: theme.colors.bubbleUserText },
            ]}
          />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantMessageContainer}>
      <StreamingText
        identity={`message:${block.id}`}
        text={block.text}
        streaming={block.streaming}
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
