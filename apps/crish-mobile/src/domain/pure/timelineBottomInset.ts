// 会话时间线底部避让推导与跟随状态机判定（纯函数）。
//
// 统一会话屏的输入区是绝对定位悬浮于全屏时间线之上的浮层：
// 列表尾部内容要能完整滚出到悬浮物上方并保留呼吸间距，
// 底部垫高必须等于「悬浮物自身高度 + 软键盘高度 + 呼吸间距」！
//
// 1. 消除 316dp 遮挡盲区：全屏无外层避让的 FlatList，当软键盘升起时，
//    软键盘直接覆盖屏幕下方，因此列表可滚动的底部内衬必须加上 keyboardHeight；
// 2. 避免误报与穿透：实测 overlayHeight 缺失或误报 <=0 时，由 minOverlayHeight 保底；
// 3. 双阈值迟滞带（Hysteresis Band）：消除触底临界点上下滑动打架。

export interface TimelineBottomInsetInput {
  /** 悬浮输入区实测或估算总高（含 Composer 卡体、条件层、快捷条与安全边距） */
  overlayHeight: number;
  /** 软键盘实际高度（0 或 280~380dp） */
  keyboardHeight?: number;
  /** 尾部内容与浮层顶部的呼吸间隙（建议 theme.space.xl = 20dp） */
  gap: number;
  /** 最小保底物理高度（实测缺失或误报 <=0 时的强力兜底） */
  minOverlayHeight?: number;
}

function sane(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * 推导时间线 FlatList 的 contentContainerStyle.paddingBottom。
 */
export function deriveTimelineBottomInset(
  input: TimelineBottomInsetInput
): number {
  const minOverlay = sane(input.minOverlayHeight);
  const measuredOverlay = sane(input.overlayHeight);
  const effectiveOverlay = Math.max(minOverlay, measuredOverlay);
  const keyboard = sane(input.keyboardHeight);
  const gap = sane(input.gap);

  return effectiveOverlay + keyboard + gap;
}

export interface FollowThresholds {
  enter: number;
  exit: number;
}

export const DEFAULT_FOLLOW_THRESHOLDS: FollowThresholds = {
  enter: 32,
  exit: 64,
};

/**
 * 迟滞带触底跟随状态判定器（纯函数）：
 * - 当前处于跟随态（follow === true）：只要离开距离 <= exit (64dp)，继续维持跟随；
 * - 当前处于离底态（follow === false）：只有逼近到距离 <= enter (32dp)，才重新吸附。
 */
export function evaluateFollowState(
  distanceToBottom: number,
  currentFollow: boolean,
  thresholds: FollowThresholds = DEFAULT_FOLLOW_THRESHOLDS
): boolean {
  if (currentFollow) {
    return distanceToBottom <= thresholds.exit;
  }
  return distanceToBottom <= thresholds.enter;
}
