// L2 滑动确认状态机（F2 §5.3 / R2UX §2.1 / §2.4-3 / §3.2 纯逻辑层）
// - 方案 A（注入式手势状态机）：本模块为无副作用纯函数，组件薄层只做 PanResponder 事件转发；
// - 阈值语义（F2 §5.3「横向滑过阈值 70% 才可抬起触发」）：拖动进度 >= 70% 进入「松手确认」
//   （armed）态；抬起（slideEnd）时 armed 才触发；未达阈值抬起 → 回弹（idle，progress 0）。
//   进度到 100% 不自动触发——F2 语义为「抬起触发」，100% 只是 armed 态的进度上限；
// - 锁定语义：locked（busy/disabled）期间全部事件幂等返回原状态（防双点，R2UX-04-03）；
// - 冲突仲裁（R2UX §2.1）：shouldClaimSlidePan 判定「横向位移 > 12dp 且 > 纵向 ×1.2」才劫持触摸。

export const SLIDE_TRIGGER_THRESHOLD = 0.7; // F2 §5.3 / R2UX §2.4-3：滑过 70% 阈值才可抬起触发
export const SLIDE_ARBITER_MIN_DX = 12; // R2UX §2.1：横向位移超过 12dp 前不劫持触摸
export const SLIDE_ARBITER_RATIO = 1.2; // R2UX §2.1：横向位移 > 纵向位移 ×1.2 才判定为水平
export const SLIDE_THUMB_SIZE = 44; // 滑块触控目标 ≥44（R2UX §1.2 热区基线 / M4 §3.4）
export const SLIDE_REBOUND_MS = 200; // R2UX §2.2-3：回弹 spring 200ms（组件侧动效目标值）

export type SlidePhase = 'idle' | 'dragging' | 'armed' | 'triggered';

export interface SlideConfirmState {
  phase: SlidePhase;
  /** 拖动进度 0..1（按可滑动距离 trackWidth - 滑块宽度 归一化，越界 clamp） */
  progress: number;
}

export function createSlideConfirmState(): SlideConfirmState {
  return { phase: 'idle', progress: 0 };
}

/** 可滑动距离（轨道宽 - 滑块宽；轨道未测量（<=0）时返回 0，进度恒 0） */
export function slideUsableWidth(
  trackWidthPx: number,
  thumbSize: number = SLIDE_THUMB_SIZE
): number {
  return Math.max(trackWidthPx - thumbSize, 0);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * 水平位移优先仲裁（R2UX §2.1 冲突仲裁表）：横向位移超过 minDxPx 且显著大于纵向位移时
 * 才劫持触摸，否则回吐给父级（ScrollView 纵向滚动）。双向判定（abs）。
 */
export function shouldClaimSlidePan(
  dxPx: number,
  dyPx: number,
  minDxPx: number = SLIDE_ARBITER_MIN_DX,
  ratio: number = SLIDE_ARBITER_RATIO
): boolean {
  return Math.abs(dxPx) > minDxPx && Math.abs(dxPx) > Math.abs(dyPx) * ratio;
}

/** 手指按下（PanResponder grant）：进入拖动，进度归零；locked 期间忽略 */
export function slideStart(
  state: SlideConfirmState,
  locked = false
): SlideConfirmState {
  if (locked) return state;
  return { phase: 'dragging', progress: 0 };
}

/** 拖动更新：dxPx → 进度（clamp 0..1）；>= 阈值置 armed（松手确认态，滑轨变绿） */
export function slideMove(
  state: SlideConfirmState,
  dxPx: number,
  trackWidthPx: number,
  locked = false
): SlideConfirmState {
  if (locked || state.phase === 'idle' || state.phase === 'triggered') {
    return state;
  }
  const usable = slideUsableWidth(trackWidthPx);
  const progress = usable > 0 ? clamp01(dxPx / usable) : 0;
  const armed = progress >= SLIDE_TRIGGER_THRESHOLD;
  return { phase: armed ? 'armed' : 'dragging', progress };
}

/**
 * 抬起（F2 §5.3「滑过阈值 70% 才可抬起触发」）：armed（progress >= 70%）→ 触发
 * （triggered，progress 1）；未达阈值 → 回弹（idle，progress 0）；locked 期间幂等不触发。
 */
export function slideEnd(
  state: SlideConfirmState,
  locked = false
): { state: SlideConfirmState; triggered: boolean } {
  if (locked || state.phase === 'idle' || state.phase === 'triggered') {
    return { state, triggered: false };
  }
  if (state.progress >= SLIDE_TRIGGER_THRESHOLD) {
    return { state: { phase: 'triggered', progress: 1 }, triggered: true };
  }
  return { state: createSlideConfirmState(), triggered: false };
}

/** 手势被抢占/终止（terminate）：回弹回 idle；locked 期间忽略 */
export function slideCancel(
  state: SlideConfirmState,
  locked = false
): SlideConfirmState {
  if (locked) return state;
  return createSlideConfirmState();
}
