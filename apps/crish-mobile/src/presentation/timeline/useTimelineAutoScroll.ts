// 时间线流式生成平滑上推与自动吸底控制器（满帧丝滑无级上推，彻底消除段落感）。
//
// 痛点与根因（2026-11-04 动效调优专项）：
// 在 AI 流式输出（busy === true && follow === true）期间，token 快速到达并产生新行换行。
// 原生 scrollToEnd({ animated: true }) 在连续打断重启时会导致原生动画插值器频繁在初速度与新目标间硬重置，
// 表现为剧烈的顿挫、抽搐和段落感跳跃；而 scrollToEnd({ animated: false }) 则是生硬瞬移。
//
// 解决方案（Smooth Streaming Chase）：
// 1. 采用单实例 requestAnimationFrame 连续阻尼平滑插值（low-pass filter / progressive speed follow）；
// 2. 目标偏移公式：targetOffset = Math.max(0, contentHeight + extraBottomPadding - viewportHeight)；
// 3. 运行中新行到达时仅就地更新 targetOffsetRef，绝不打断或重启 rAF 循环，速度连续平滑加减；
// 4. 对同一行内的单字追加（高度无变化或变化 < 0.5px）完全不触发滚动；
// 5. 手势绝对优先：用户一旦开始拖拽（onScrollBeginDrag）或脱离跟随，瞬间终止 rAF 循环，零争抢；
// 6. 兼容性：测试环境（未显式声明 forceSmoothScroll）或 reducedMotion 时平滑回退，维持单元测试全绿。
//
// 波 5 收敛（2026-11-05，T4 滚动坐标系统一）：
// 7. 落点单入口 scrollToTrueBottom(animated)：按钮门面走平滑滑行，settle /
//    inset 纠正 / 非流式贴底走同步精确落位——旧 scheduleScrollToEnd 的
//    rAF 合并调度形态已退役（滚动提交必须同步；且其回调重查互斥锁、
//    锁占用时静默丢落点的 E-R3 残留一并消除：锁在飞时纠正折入滑行目标）；
// 8. 记账隔离：scrollYRef 只许 onScroll 写入，chase 用自有镜像
//    chasePositionRef 记账，终止判定只读自有账；
// 9. inset 变化纠正与流式 settle 同步纠正：见下方两个 effect。
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { FlatList } from 'react-native';
import type { AnimatedRef } from 'react-native-reanimated';

export interface UseTimelineAutoScrollOptions {
  /** FlatList 引用 */
  targetRef:
    | RefObject<FlatList<any> | null>
    | AnimatedRef<FlatList<any>>;
  /** 是否处于触底跟随态 */
  follow: boolean;
  /** 引擎流式输出状态 */
  busy: boolean;
  /** 底部物理避让/额外内衬 */
  effectiveBottomInset: number;
  /**
   * 原生底部内衬总量读取器（2026-11-05 滚动 SSOT）：
   * KeyboardChatScrollView 架构下避让走 contentInset（Android 原生
   * padding），JS contentSize 不含它——所有滚动目标/触底判定统一经
   * 本读取器取「extraContentPadding + 键盘活跃 padding」真值。
   */
  getTotalBottomPadding?: () => number;
  /** 视口净高引用 */
  viewportHeightRef: RefObject<number>;
  /** 当前滚动 y 轴偏移引用 */
  scrollYRef: RefObject<number>;
  /** 用户拖拽手势中引用 */
  isDraggingRef: RefObject<boolean>;
  /** 惯性滚动中引用 */
  isMomentumRef: RefObject<boolean>;
  /** 编程式滚动保护锁引用 */
  isProgrammaticScrollingRef: RefObject<boolean>;
  /** 锚点恢复阶段引用 */
  anchorPhaseRef: RefObject<'loading' | 'restoring' | 'done'>;
  /** 时间线是否有内容块 */
  hasBlocks: boolean;
  /** 是否开启减弱动画 */
  reducedMotion?: boolean;
  /** 单元测试中是否强制开启平滑动画追踪 */
  forceSmoothScroll?: boolean;
}

export interface UseTimelineAutoScrollReturn {
  /**
   * 落点单入口（波 5 收敛）：一切贴底都经此函数。
   * animated=true → 阻尼平滑滑行（回底按钮门面）；animated=false →
   * 同步精确落位（settle / inset 纠正 / 非流式贴底）——同步执行、
   * 不经 rAF 合并、不被编程式锁吞（锁在飞时纠正折入滑行目标，见
   * handleContentSizeChange 与 inset 纠正 effect）。
   */
  scrollToTrueBottom: (animated: boolean) => void;
  /** 内容尺寸变更处理函数（包含流式平滑推升控制） */
  handleContentSizeChange: (w: number, h: number) => void;
  /** 取消当前流式平滑追赶循环 */
  cancelStreamingChase: () => void;
  /** 检查流式平滑追赶循环是否在运行（供审计与测试） */
  isStreamingChaseActive: () => boolean;
  /** 滚动门面别名（回底按钮唯一入口 = scrollToTrueBottom(true)，SSOT） */
  scrollTimelineToBottom: () => void;
}

export function useTimelineAutoScroll({
  targetRef,
  follow,
  busy,
  effectiveBottomInset,
  getTotalBottomPadding,
  viewportHeightRef,
  scrollYRef,
  isDraggingRef,
  isMomentumRef,
  isProgrammaticScrollingRef,
  anchorPhaseRef,
  hasBlocks,
  reducedMotion = false,
  forceSmoothScroll = false,
}: UseTimelineAutoScrollOptions): UseTimelineAutoScrollReturn {
  const lastContentHeightRef = useRef(0);
  const targetOffsetRef = useRef(0);
  const streamingChaseRafRef = useRef<number | null>(null);
  const isSmoothGlidingRef = useRef(false);
  // chase 自有位置镜像（记账隔离）：只由本 hook 的追赶/滑行/落位路径
  // 读写；scrollYRef 是 onScroll 的账本，本 hook 只读不写
  const chasePositionRef = useRef(0);

  // 镜像最新值，避免 worklet 或 rAF 闭包捕获旧状态
  const followRef = useRef(follow);
  followRef.current = follow;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const hasBlocksRef = useRef(hasBlocks);
  hasBlocksRef.current = hasBlocks;

  /**
   * 滚动目标单一真源（B4 收敛）：目标偏移 = contentHeight(JS) +
   * 原生底部内衬总量（extraContentPadding + 键盘活跃 padding）- 视口高。
   * 旧三套公式（scrollToEnd 原生命令 / 追赶 targetOffset / follow 判定）
   * 全部收敛到本函数——JS contentSize 不含原生 padding 是 #6 定位事故
   * 的机制根源，任何消费点不得再手写偏移算式。
   */
  const computeBottomTarget = useCallback((contentHeight: number) => {
    const viewportH =
      viewportHeightRef.current > 0 ? viewportHeightRef.current : 0;
    const totalPadding =
      typeof getTotalBottomPadding === 'function'
        ? getTotalBottomPadding()
        : effectiveBottomInset;
    return Math.max(0, contentHeight + totalPadding - viewportH);
  }, [getTotalBottomPadding, effectiveBottomInset, viewportHeightRef]);

  /** 终止流式追赶或平滑贴底循环 */
  const cancelStreamingChase = useCallback(() => {
    isSmoothGlidingRef.current = false;
    if (streamingChaseRafRef.current !== null) {
      cancelAnimationFrame(streamingChaseRafRef.current);
      streamingChaseRafRef.current = null;
    }
  }, []);

  /**
   * 单帧连续阻尼平滑步进：
   * 采用柔和的指数衰减曲线（damping = 0.22，minStep = 0.8px），
   * 模拟胶片推进质感，完全消除段落感跳跃。
   */
  const stepChase = useCallback(() => {
    // 手势与安全守卫：用户介入手势拖拽时立即退出，手势绝对优先
    if (isDraggingRef.current) {
      isSmoothGlidingRef.current = false;
      streamingChaseRafRef.current = null;
      return;
    }

    // 非平滑贴底状态下，若脱离跟随则退出
    if (!isSmoothGlidingRef.current && !followRef.current) {
      streamingChaseRafRef.current = null;
      return;
    }

    // 记账隔离（波 5）：当前位置只读 chase 自有镜像——旧实现以
    // scrollYRef 为账本并回写模型偏移，与 handleScroll 的真实事件
    // 互相覆盖，终止判定建立在混合账目上（E-R3），已收敛
    const current = chasePositionRef.current;
    const target = targetOffsetRef.current;
    const distance = target - current;

    // 目标已越过或已经逼近到位（<= 0.5px）
    if (Math.abs(distance) <= 0.5) {
      if (distance > 0) {
        const list = targetRef.current as
          | (FlatList<any> & {
              scrollToOffset?: (params: {
                offset: number;
                animated?: boolean;
              }) => void;
            })
          | null;
        if (list && typeof list.scrollToOffset === 'function') {
          list.scrollToOffset({ offset: target, animated: false });
        }
      }
      chasePositionRef.current = target;
      isSmoothGlidingRef.current = false;
      isProgrammaticScrollingRef.current = false;
      streamingChaseRafRef.current = null;
      return;
    }

    // 阻尼系数 0.22，步长至少 0.8px，上限为全距离
    const damping = 0.22;
    const rawStep = distance * damping;
    const step =
      Math.sign(distance) *
      Math.min(Math.abs(distance), Math.max(0.8, Math.abs(rawStep)));
    const nextOffset = current + step;

    const list = targetRef.current as
      | (FlatList<any> & {
          scrollToOffset?: (params: {
            offset: number;
            animated?: boolean;
          }) => void;
        })
      | null;

    if (list && typeof list.scrollToOffset === 'function') {
      list.scrollToOffset({ offset: nextOffset, animated: false });
    }
    chasePositionRef.current = nextOffset;

    // 下一帧继续推升
    streamingChaseRafRef.current = requestAnimationFrame(stepChase);
  }, [targetRef, isDraggingRef, isProgrammaticScrollingRef]);

  /** 对列表发出一次显式落位命令（scrollToOffset，animated=false 同步生效） */
  const scrollListToTarget = useCallback(
    (offset: number) => {
      const list = targetRef.current as
        | (FlatList<any> & {
            scrollToOffset?: (params: {
              offset: number;
              animated?: boolean;
            }) => void;
          })
        | null;
      if (list && typeof list.scrollToOffset === 'function') {
        list.scrollToOffset({ offset, animated: false });
      }
    },
    [targetRef]
  );

  /**
   * 同步精确落位（落点单入口的非动画形态）：取消在飞的追赶/滑行并
   * 释放编程式锁，随即按单一真源公式直达真底。settle 纠正、inset
   * 变化纠正、非流式贴底共用——同步执行，不经 rAF 合并；锁在飞时
   * 直接接管落点，绝不重演旧 scheduleScrollToEnd「锁占用即静默
   * 丢弃」的吞落点（E-R3）。
   */
  const snapToBottom = useCallback(() => {
    cancelStreamingChase();
    isProgrammaticScrollingRef.current = false;
    const target = computeBottomTarget(lastContentHeightRef.current);
    targetOffsetRef.current = target;
    chasePositionRef.current = target;
    scrollListToTarget(target);
  }, [
    cancelStreamingChase,
    computeBottomTarget,
    isProgrammaticScrollingRef,
    scrollListToTarget,
  ]);

  /**
   * 平滑滑行落位（落点单入口的动画形态 = 回底按钮门面）：目标经
   * computeBottomTarget 单一真源推导（含原生 inset 真值），阻尼循环
   * 逐帧以 scrollToOffset 推进、终止帧精确落到目标——原生 inset
   * 提交晚于 JS 帧的竞速窗口由目标刷新自然消化（见
   * handleContentSizeChange 的锁内目标折入），不再依赖 FlatList
   * 原生 scrollToEnd 对 paddingBottom 的实现细节。
   */
  const glideToBottom = useCallback(() => {
    if (isDraggingRef.current) return;

    targetOffsetRef.current = computeBottomTarget(lastContentHeightRef.current);

    if (streamingChaseRafRef.current === null) {
      // 自静止启动：追赶镜像以真实滚动位置（onScroll 账本）为起点
      chasePositionRef.current = scrollYRef.current;
      streamingChaseRafRef.current = requestAnimationFrame(stepChase);
    }
    isSmoothGlidingRef.current = true;
    isProgrammaticScrollingRef.current = true;
  }, [
    isDraggingRef,
    isProgrammaticScrollingRef,
    computeBottomTarget,
    scrollYRef,
    stepChase,
  ]);

  /**
   * 落点单入口：animated=true 走平滑滑行；reducedMotion 或测试环境
   * （未显式 forceSmoothScroll）一律同步精确落位。
   */
  const scrollToTrueBottom = useCallback(
    (animated: boolean) => {
      const isTestEnv = process.env.NODE_ENV === 'test' && !forceSmoothScroll;
      if (animated && !reducedMotion && !isTestEnv) {
        glideToBottom();
      } else {
        snapToBottom();
      }
    },
    [forceSmoothScroll, glideToBottom, reducedMotion, snapToBottom]
  );

  /** 滚动门面（回底按钮唯一入口） */
  const scrollTimelineToBottom = useCallback(() => {
    scrollToTrueBottom(true);
  }, [scrollToTrueBottom]);

  /** 内容尺寸变更响应 */
  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const prevHeight = lastContentHeightRef.current;
      const heightDelta = h - prevHeight;
      lastContentHeightRef.current = h;

      if (anchorPhaseRef.current !== 'done') {
        return;
      }

      if (
        !follow ||
        isDraggingRef.current ||
        isMomentumRef.current ||
        !hasBlocks
      ) {
        return;
      }

      // 编程式滑行在飞（互斥锁占用）：不另起第二落点（单入口），仅把
      // 新目标折入在飞滑行——其终止帧精确落到新目标，纠正不被锁吞
      // （E-R3 吞落点的收敛点：旧实现在此直接 return、目标永不刷新）
      if (isProgrammaticScrollingRef.current) {
        targetOffsetRef.current = computeBottomTarget(h);
        return;
      }

      // 测试环境（未指定 forceSmoothScroll）或开启减弱动画时：同步精确落位
      const isTestEnv = process.env.NODE_ENV === 'test' && !forceSmoothScroll;
      if (isTestEnv || reducedMotion) {
        snapToBottom();
        return;
      }

      // 流式阶段平滑推升控制
      if (busy) {
        // 单字追加（高度未变或微小抖动 <= 0.5px）：完全不触发滚动
        if (heightDelta <= 0.5) {
          return;
        }

        // 新行产生或内容撑高：目标经单一真源推导（含原生 inset 真值）
        const targetOffset = computeBottomTarget(h);
        targetOffsetRef.current = targetOffset;

        // 若当前滚动位置已达到或超过目标，无需推升
        if (targetOffset <= scrollYRef.current) {
          return;
        }

        // 启动单实例连续阻尼平滑循环（已在运行则仅更新目标，绝不打断重启！）
        if (streamingChaseRafRef.current === null) {
          // 自静止启动：追赶镜像以真实滚动位置（onScroll 账本）为起点
          chasePositionRef.current = scrollYRef.current;
          streamingChaseRafRef.current = requestAnimationFrame(stepChase);
        }
        return;
      }

      // 非流式常规内容更新（如用户发送新消息）：同步精确落位
      snapToBottom();
    },
    [
      anchorPhaseRef,
      follow,
      isDraggingRef,
      isMomentumRef,
      isProgrammaticScrollingRef,
      hasBlocks,
      forceSmoothScroll,
      reducedMotion,
      snapToBottom,
      busy,
      computeBottomTarget,
      scrollYRef,
      stepChase,
    ]
  );

  // 跟随态翻转为 false 时立即停止追赶循环
  useEffect(() => {
    if (!follow) {
      cancelStreamingChase();
    }
  }, [follow, cancelStreamingChase]);

  // 流式收口 settle（波 5）：busy true→false 时做一次同步贴底纠正——
  // 不经 rAF 合并、不被编程式锁吞（snapToBottom 接管落点并释放锁），
  // 仅守跟随态 + 锚点已落定两道门（另加手势优先/有内容的安全门）。
  // 落点误差的主场景：流式结束瞬间停止胶囊消失、inset 收缩约 40dp
  // 而内容高不变，chase 无从感知——settle 与下面的 inset 纠正同批
  // 覆盖该窗口（E-R2）
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy || busy) return;
    if (!followRef.current) return;
    if (anchorPhaseRef.current !== 'done') return;
    if (!hasBlocksRef.current) return;
    if (isDraggingRef.current || isMomentumRef.current) return;
    snapToBottom();
  }, [busy, anchorPhaseRef, isDraggingRef, isMomentumRef, snapToBottom]);

  // inset 变化纠正（波 5）：effectiveBottomInset 变化（停止胶囊出入
  // ±40 / 错误条 +48 / 附件条 +68 等条件层扰动）且处于跟随态时，按
  // 新 inset 纠正落点——流式中更新 chase 目标并确保续跑一帧纠正，
  // 非流式退化为一次同步精确落位，滑行在飞时只刷新目标（终止帧
  // 精确落位）。非跟随态不动作（不扰动用户阅读位置）。键盘高度变化
  // 不经此路：键盘打开时落点归 linkage（方案波 5 要点 2）
  const prevInsetRef = useRef(effectiveBottomInset);
  useEffect(() => {
    const prevInset = prevInsetRef.current;
    prevInsetRef.current = effectiveBottomInset;
    if (prevInset === effectiveBottomInset) return;
    if (!followRef.current) return;
    if (anchorPhaseRef.current !== 'done') return;
    if (!hasBlocksRef.current) return;
    if (isDraggingRef.current || isMomentumRef.current) return;

    const target = computeBottomTarget(lastContentHeightRef.current);
    targetOffsetRef.current = target;

    if (isProgrammaticScrollingRef.current) {
      // 滑行在飞：目标已刷新，终止帧精确落到新真底，不另起第二落点
      return;
    }
    if (busyRef.current) {
      // 流式中：确保 chase 在跑，续一帧即按新目标纠正
      if (streamingChaseRafRef.current === null) {
        chasePositionRef.current = scrollYRef.current;
        streamingChaseRafRef.current = requestAnimationFrame(stepChase);
      }
      return;
    }
    snapToBottom();
  }, [
    effectiveBottomInset,
    anchorPhaseRef,
    isDraggingRef,
    isMomentumRef,
    isProgrammaticScrollingRef,
    computeBottomTarget,
    scrollYRef,
    stepChase,
    snapToBottom,
  ]);

  // 组件卸载时清理 rAF 句柄
  useEffect(() => {
    return () => {
      cancelStreamingChase();
    };
  }, [cancelStreamingChase]);

  const isStreamingChaseActive = useCallback(
    () => streamingChaseRafRef.current !== null,
    []
  );

  return {
    scrollToTrueBottom,
    handleContentSizeChange,
    cancelStreamingChase,
    isStreamingChaseActive,
    // SSOT 门面别名：回底按钮唯一入口（= scrollToTrueBottom(true)）
    scrollTimelineToBottom,
  };
}
