// 时间线键盘升降联动满帧 120fps 平滑平移与动力学控制器（方案 19 核心引擎）。
//
// 核心动力学准则（docs/mobile-interaction-refine/proposals/19-*.md）：
// 1. 原生级 useKeyboardHandler 的 onMove(e: { height, progress }) 连续平滑插值；
// 2. 满页触底状态下消息流随键盘 1:1 速度连续平滑推升，收起时无级对称回退，绝对零度反向冲顶；
// 3. 短对话未触及键盘区域时自动保护保持静止，绝不被推入顶部状态栏；
// 4. 历史翻阅态（follow === false）视口锁定静止，严禁位移；
// 5. 纯 UI 线程 Worklet 驱动，零 JS 调度与零 Android requestLayout 重排；
// 6. （波 5 追加）触底资格判定计入原生底部内衬总量，与 JS 侧
//     handleScroll 共用同一判底原点（旧式漏计把资格放宽了整个 inset）。
import { useCallback, useEffect, useMemo } from 'react';
import type { FlatList } from 'react-native';
import {
  scrollTo,
  useSharedValue,
  type AnimatedRef,
} from 'react-native-reanimated';
import { useKeyboardHandler } from 'react-native-keyboard-controller';

export interface UseSmoothKeyboardTimelineLinkageOptions {
  /** 是否处于跟随态 */
  follow: boolean;
  /** 悬浮输入框物理净高 (不含键盘) */
  overlayHeight: number;
  /** 尾部呼吸间隙 (默认 20dp) */
  gap: number;
  /**
   * 原生底部内衬总量（extraContentPadding + 键盘活跃 padding）：
   * 触底判定与 handleScroll 同一原点（波 5 归正）——JS contentSize
   * 不含原生内衬，漏计会把距真底放大一个 inset
   */
  bottomPadding: number;
  /** 顶部头栏避让高度 (默认 0) */
  headerClearance?: number;
  /** 跟随态变更回调 */
  onFollowChange?: (follow: boolean) => void;
}

export function useSmoothKeyboardTimelineLinkage<ItemT = unknown>(
  scrollViewRef: AnimatedRef<FlatList<ItemT>>,
  options: UseSmoothKeyboardTimelineLinkageOptions
) {
  const followSV = useSharedValue(options.follow);
  useEffect(() => {
    followSV.value = options.follow;
  }, [options.follow, followSV]);

  const overlayHeightSV = useSharedValue(options.overlayHeight);
  useEffect(() => {
    overlayHeightSV.value = options.overlayHeight;
  }, [options.overlayHeight, overlayHeightSV]);

  const gapSV = useSharedValue(options.gap);
  useEffect(() => {
    gapSV.value = options.gap;
  }, [options.gap, gapSV]);

  const bottomPaddingSV = useSharedValue(options.bottomPadding);
  useEffect(() => {
    bottomPaddingSV.value = options.bottomPadding;
  }, [options.bottomPadding, bottomPaddingSV]);

  const headerClearanceSV = useSharedValue(options.headerClearance ?? 0);
  useEffect(() => {
    headerClearanceSV.value = options.headerClearance ?? 0;
  }, [options.headerClearance, headerClearanceSV]);

  // UI 线程状态共享值
  const currentScrollY = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const initialScrollY = useSharedValue(0);
  const isEligibleForLift = useSharedValue(false);
  const maxDisplacement = useSharedValue(0);
  const currentLiftProgress = useSharedValue(0);
  const isClosing = useSharedValue(false);

  // 供 FlatList 事件同步视口与几何尺寸至 UI 线程。
  // 回调身份在流式期间保持稳定，避免滚动监听每次出字都换新函数。
  const notifyScroll = useCallback(
    (offsetY: number, layoutH: number, contentH: number) => {
      'worklet';
      currentScrollY.value = offsetY;
      if (layoutH > 0) viewportHeight.value = layoutH;
      if (contentH > 0) contentHeight.value = contentH;
    },
    [contentHeight, currentScrollY, viewportHeight]
  );

  const notifyLayout = useCallback(
    (height: number) => {
      'worklet';
      if (height > 0) viewportHeight.value = height;
    },
    [viewportHeight]
  );

  const notifyContentHeight = useCallback(
    (height: number) => {
      'worklet';
      if (height > 0) contentHeight.value = height;
    },
    [contentHeight]
  );

  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        if (e.height > 0) {
          // 键盘弹起开始
          isClosing.value = false;
          initialScrollY.value = currentScrollY.value;

          // 状态 C：历史翻阅态（非跟随态），视口锁定静止，严禁平移
          if (!followSV.value) {
            isEligibleForLift.value = false;
            maxDisplacement.value = 0;
            return;
          }

          // 判定触底状态：距真底 <= 48dp 认为处于吸底状态。真底
          // 原点与 handleScroll 一致（波 5 归正）：distance =
          // contentHeight + 原生底部内衬总量 − (scrollY + viewport)。
          // 旧式漏计内衬使资格实际放宽为 48 + inset（约 200–320dp），
          // 跟随态下用户上翻数行读旧文时弹键盘会被误判在底而推升
          // 内容（V4 S3）
          const vHeight = viewportHeight.value;
          const cHeight = contentHeight.value;
          const distanceToBottom = Math.max(
            0,
            cHeight + bottomPaddingSV.value - (currentScrollY.value + vHeight)
          );
          const isAtBottom = distanceToBottom <= 48;

          if (!isAtBottom) {
            isEligibleForLift.value = false;
            maxDisplacement.value = 0;
            return;
          }

          // 状态 B：短对话防越界方程
          // 视口可用空白高度：FreeSpace = vHeight - cHeight - overlayHeightSV.value
          const freeSpace = Math.max(
            0,
            vHeight - cHeight - overlayHeightSV.value
          );

          if (freeSpace >= e.height) {
            // 短对话且空白充足，键盘完全落入空白区内，保持静止，绝对不推入顶部状态栏！
            isEligibleForLift.value = false;
            maxDisplacement.value = 0;
          } else {
            // 状态 A：满页或短对话但空隙不足，仅推升溢出差额（满页时 freeSpace=0，即 1:1 伴随升起）
            const neededDisplacement = e.height - freeSpace;
            isEligibleForLift.value = true;
            maxDisplacement.value = neededDisplacement;
          }
        } else {
          // 键盘收起：以当前推升位移为基准，无级对称回退，绝对零度反向冲顶！
          isClosing.value = true;
        }
      },
      onMove: (e) => {
        'worklet';
        if (!isEligibleForLift.value || maxDisplacement.value <= 0) {
          return;
        }

        currentLiftProgress.value = e.progress;
        // 归一化进度：0 (完全收起) -> 1 (完全展开)
        const progress = Math.max(0, Math.min(1, e.progress));
        const targetDisplacement = maxDisplacement.value * progress;
        const targetScrollY = Math.max(
          0,
          initialScrollY.value + targetDisplacement
        );

        // 直接在 UI 线程 Worklet 连续调用平滑滚动，无任何 requestLayout 开销
        // 依托 useAnimatedRef 注册的跨线程安全句柄，Worklet 序列化时直接命中缓存
        scrollTo(scrollViewRef, 0, targetScrollY, false);
      },
      onEnd: (e) => {
        'worklet';
        if (e.height === 0) {
          // 键盘完全收平，平稳落定，清除瞬态标记
          isEligibleForLift.value = false;
          maxDisplacement.value = 0;
          isClosing.value = false;
          currentLiftProgress.value = 0;
        }
      },
    },
    [
      options.follow,
      options.overlayHeight,
      options.gap,
      options.bottomPadding,
      options.headerClearance,
    ]
  );

  return useMemo(
    () => ({
      notifyScroll,
      notifyLayout,
      notifyContentHeight,
      isEligibleForLift,
      maxDisplacement,
      currentLiftProgress,
      currentScrollY,
    }),
    [
      currentLiftProgress,
      currentScrollY,
      isEligibleForLift,
      maxDisplacement,
      notifyContentHeight,
      notifyLayout,
      notifyScroll,
    ]
  );
}
