/**
 * apps/crish-desktop/src/components/chat-message-list/messageVirtualizerTailBuffer.ts
 *
 * R12b 尾部缓冲的动画编排（自 MessageVirtualizer 抽出）：张开斜坡、终态收合、
 * 卸载清理三段 effect。状态本体（tailBufferPx / 各 ref）仍由宿主持有，本
 * hook 只负责按帧推进已张开值——几何裁决（窗口/目标）留在宿主渲染期单点完成。
 */
import {
  useEffect,
  useLayoutEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  planPositionAt,
  prefersReducedMotion,
  resolveScrollToBottomDurationMs,
  type ScrollToBottomPlan,
} from './messageVirtualizerScrollPlan';
import { resolveTailBufferRampStepPx } from './chatScrollGeometry';

export interface TailBufferAnimationDeps {
  /** 已张开值（state 驱动渲染几何） */
  tailBufferPx: number;
  /** 本帧裁决出的张开目标 */
  tailBufferTargetPx: number;
  /** 轮次是否进行中（窗口信号单点派生） */
  turnActive: boolean;
  /** 跟随态（state，仅作斜坡 effect 依赖唤醒） */
  isAtBottom: boolean;
  /** 跟随态 ref（帧间判定读） */
  isAtBottomRef: MutableRefObject<boolean>;
  /** 内容高镜像（斜坡帧间增量计量；宿主渲染期赋值） */
  tailContentHeightRef: MutableRefObject<number>;
  /** 斜坡上一帧计量时的内容高基线 */
  tailRampBaselineRef: MutableRefObject<number>;
  /** 收合计划（rAF 定时律） */
  tailCollapseRef: MutableRefObject<{
    rafId: number | null;
    plan: ScrollToBottomPlan | null;
  }>;
  setTailBufferPx: Dispatch<SetStateAction<number>>;
}

export function useTailBufferAnimation(deps: TailBufferAnimationDeps): void {
  const {
    tailBufferPx,
    tailBufferTargetPx,
    turnActive,
    isAtBottom,
    isAtBottomRef,
    tailContentHeightRef,
    tailRampBaselineRef,
    tailCollapseRef,
    setTailBufferPx,
  } = deps;

  // R12b 缓冲开启斜坡：窗口开启后缓冲不一次跳满（否则 maxScroll 一次跳 B、
  // 内容被突然拽落），按帧预算制张开——单帧步长由 resolveTailBufferRampStepPx
  // 裁决（≤ 当帧内容增量 25%、≤24px、内容停长时 12px 兜底）；
  // 步进经 tailBufferPx → totalHeight 的同一 layout 通道提交，跟随 effect 同步
  // 吸底，张开感知为「呼吸区缓缓让出」，无独立滚动动画；
  // 途中用户离底即冻结（不再改变 maxScroll 骚扰读者），回到跟随态再续开；
  // 系统减少动效时塌缩为一次到位；窗口内目标下调（视口变矮）为离散几何事件，
  // 直接钳回；窗口关闭（turnActive 转假）的退出不在此处——由下方收合 effect
  // 按定时律接管。
  useLayoutEffect(() => {
    if (tailBufferPx === tailBufferTargetPx) return;
    if (tailBufferPx > tailBufferTargetPx) {
      if (turnActive) setTailBufferPx(tailBufferTargetPx);
      return;
    }
    if (!isAtBottomRef.current) return;
    let rafId: number | null = null;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!isAtBottomRef.current) return; // 帧间离底：冻结在当前值
      if (prefersReducedMotion()) {
        setTailBufferPx(tailBufferTargetPx);
        return;
      }
      const contentNow = tailContentHeightRef.current;
      const contentIncrement = Math.max(
        0,
        contentNow - tailRampBaselineRef.current
      );
      tailRampBaselineRef.current = contentNow;
      const step = resolveTailBufferRampStepPx(
        contentIncrement,
        tailBufferTargetPx - tailBufferPx
      );
      if (step > 0) setTailBufferPx(tailBufferPx + step);
    });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tailBufferPx, tailBufferTargetPx, turnActive, isAtBottom, isAtBottomRef]);

  // R12b 缓冲收合：轮次终态（turnActive 转假）且缓冲未归零时，按与 FAB 回底
  // 同一条定时律（resolveScrollToBottomDurationMs + planPositionAt：2400px/s、
  // clamp 120–450ms、easeOutCubic）逐帧递减 effB 至精确 0。跟随态由跟随 effect
  // 随 totalHeight 同步扣减 scrollTop——已读内容相对视口不动、只有空白被收走；
  // 离底阅读时本 effect 只写 effB、从不写 scrollTop，阅读位置像素级不变
  // （恰停缓冲带内者由既有钳制收束到新 maxScroll，位移 ≤ 其越过内容底的距离）。
  // turnActive 再真（收合中再发送）即取消计划，当前值成为续张基线（斜坡以
  // 剩余量计步）；系统减少动效时单帧归零。
  useLayoutEffect(() => {
    const collapse = tailCollapseRef.current;
    if (turnActive) {
      if (collapse.rafId !== null) {
        cancelAnimationFrame(collapse.rafId);
        collapse.rafId = null;
      }
      collapse.plan = null;
      return;
    }
    if (tailBufferPx <= 0 || collapse.plan !== null) return;
    if (prefersReducedMotion()) {
      setTailBufferPx(0);
      return;
    }
    const plan: ScrollToBottomPlan = {
      from: tailBufferPx,
      target: 0,
      startTime: performance.now(),
      durationMs: resolveScrollToBottomDurationMs(tailBufferPx),
    };
    collapse.plan = plan;
    const tick = () => {
      if (collapse.plan !== plan) return; // 已取消（再发送 / 切会话 / 卸载）
      const { position, done } = planPositionAt(plan, performance.now());
      if (done) {
        collapse.plan = null;
        collapse.rafId = null;
        setTailBufferPx(0);
        return;
      }
      setTailBufferPx(position);
      collapse.rafId = requestAnimationFrame(tick);
    };
    collapse.rafId = requestAnimationFrame(tick);
    // tailBufferPx 只在计划建立帧取样为起点，逐帧递减不重启计划，故不入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnActive]);

  // 卸载时取消未完成的收合计划
  useEffect(() => {
    return () => {
      const collapse = tailCollapseRef.current;
      if (collapse.rafId !== null) cancelAnimationFrame(collapse.rafId);
      collapse.plan = null;
    };
  }, []);
}
