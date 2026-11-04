/**
 * apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollPlan.ts
 *
 * 滚动计划与尾部缓冲窗口的纯函数面（自 messageVirtualizerScrollState 抽出）：
 * ease 曲线、回底定时律计划、尾部缓冲窗口派生、减动效偏好直读。全部无状态、
 * 可单测；滚动状态机与事件处理器仍在 messageVirtualizerScrollState。
 */
import {
  SCROLL_TO_BOTTOM_MAX_DURATION_MS,
  SCROLL_TO_BOTTOM_MIN_DURATION_MS,
  SCROLL_TO_BOTTOM_SPEED_PX_PER_SEC,
} from '../../hooks/virtualScrollConstants';

/** ease-out 三次曲线（单调、无过冲）：R12 机制 B 的位移曲线，构造上落点即终点、无回找 */
export function easeOutCubic(p: number): number {
  const t = Math.min(1, Math.max(0, p));
  return 1 - Math.pow(1 - t, 3);
}

/** R12 机制 B 定时律：T = clamp(D / 2400px·s⁻¹, 120ms, 450ms)，时长与距离成比例 */
export function resolveScrollToBottomDurationMs(distancePx: number): number {
  const d = Number.isFinite(distancePx) && distancePx > 0 ? distancePx : 0;
  const raw = (d / SCROLL_TO_BOTTOM_SPEED_PX_PER_SEC) * 1000;
  return Math.min(
    SCROLL_TO_BOTTOM_MAX_DURATION_MS,
    Math.max(SCROLL_TO_BOTTOM_MIN_DURATION_MS, raw)
  );
}

/** 一次回底动画的计划（from/target 均为 scrollTop 坐标） */
export interface ScrollToBottomPlan {
  from: number;
  target: number;
  startTime: number;
  durationMs: number;
}

/**
 * 计划在 now 时刻应提交的 scrollTop：逐帧由曲线对目标距离求值，
 * 末帧精确等于 target（零找补）；全程单调、永不越过 target。
 */
export function scrollToBottomPositionAt(
  plan: ScrollToBottomPlan,
  now: number
): { position: number; done: boolean } {
  const span = plan.target - plan.from;
  if (span <= 0 || plan.durationMs <= 0) {
    return { position: plan.target, done: true };
  }
  const p = (now - plan.startTime) / plan.durationMs;
  if (p >= 1) return { position: plan.target, done: true };
  return { position: plan.from + span * easeOutCubic(p), done: false };
}

/**
 * 通用定时律计划求值（R12b）：与 scrollToBottomPositionAt 同一曲线（easeOutCubic）
 * 与同一时长口径（resolveScrollToBottomDurationMs），但允许 target < from 的
 * 递减计划——供尾部缓冲收合复用（from = 当前 effB、target = 0），保证收合与
 * FAB 回底共用同一条定时律，不出现第二套参数。逐帧值单调趋近 target、
 * 末帧精确等于 target、无过冲。
 */
export function planPositionAt(
  plan: ScrollToBottomPlan,
  now: number
): { position: number; done: boolean } {
  const span = plan.target - plan.from;
  if (span === 0 || plan.durationMs <= 0) {
    return { position: plan.target, done: true };
  }
  const p = (now - plan.startTime) / plan.durationMs;
  if (p >= 1) return { position: plan.target, done: true };
  return { position: plan.from + span * easeOutCubic(p), done: false };
}

/** R12b 尾部缓冲窗口信号状态（宿主持 ref 逐帧推进，见 deriveTailBufferWindow） */
export interface TailBufferWindowState {
  /** 上一帧尾部 user 行 id（发送落账基线；undefined = 基线尚未建立） */
  baselineTailUserId: string | null | undefined;
  /** 发送闩：桥接中的 user 行 id（assistant 行创建前） */
  sendLatchUserId: string | null;
}

/**
 * R12b 尾部缓冲窗口信号状态机（纯函数）：由轮次状态单点派生 turnActive。
 * - 主信号：thinkingMsgId 非空（存在 processing 中的 assistant 消息）→ 窗口开，
 *   发送闩同时清零（主信号接管桥接）；
 * - 发送闩：尾部 user 行 id 相对上一帧基线新出现、且该帧处于跟随态时置位，
 *   桥接「user 行已落账、assistant 行尚未创建」的空窗；闩住的 user 行离开
 *   尾部且主信号未起时即失效（轮次已终态或消息被撤回）；
 * - 基线纪律：首帧（基线未建立）与切会话帧只记录尾部 user 行作基线、绝不
 *   置闩——打开会话直达真底，缓冲不在静止态张开；离底发送同样不置闩
 *   （该轮不进窗口、不拉回读者）。
 */
export function deriveTailBufferWindow(
  prev: TailBufferWindowState,
  input: {
    sessionChanged: boolean;
    tailUserId: string | null;
    thinkingMsgId: string | null | undefined;
    isAtBottom: boolean;
  }
): { state: TailBufferWindowState; turnActive: boolean } {
  const thinking = input.thinkingMsgId != null;
  if (input.sessionChanged) {
    return {
      state: {
        baselineTailUserId: input.tailUserId,
        sendLatchUserId: null,
      },
      turnActive: thinking,
    };
  }
  let sendLatchUserId = prev.sendLatchUserId;
  if (thinking) {
    sendLatchUserId = null;
  } else {
    if (sendLatchUserId !== null && sendLatchUserId !== input.tailUserId) {
      sendLatchUserId = null;
    }
    if (
      prev.baselineTailUserId !== undefined &&
      input.tailUserId !== null &&
      prev.baselineTailUserId !== input.tailUserId &&
      input.isAtBottom
    ) {
      sendLatchUserId = input.tailUserId;
    }
  }
  return {
    state: { baselineTailUserId: input.tailUserId, sendLatchUserId },
    turnActive: thinking || sendLatchUserId !== null,
  };
}

/** 系统减少动效偏好（与仓内 ScrollArea / SplitResizer 同口径的 matchMedia 直读） */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
