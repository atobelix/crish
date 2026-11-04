// 会话时间线底部避让推导与跟随状态机判定（纯函数）。
//
// 统一会话屏的输入区是绝对定位悬浮于全屏时间线之上的浮层：
// 在 KeyboardChatScrollView 架构下，列表底部内边距仅需物理浮层高 + gap；
// 键盘高度由 KeyboardChatScrollView 在 UI 线程与 KeyboardStickyView 联动处理，
// 绝对严禁在 timelineBottomInset 再次叠加 keyboardHeight！
//
// 1. 消除双重垫高与底部巨大空白：列表内衬仅计算有效物理浮层高度 + gap，
//    软键盘平移完全委托给 KeyboardChatScrollView（extraContentPadding）；
// 2. 避免误报与穿透：实测 overlayHeight 缺失或误报 <=0 时，由 minOverlayHeight 保底；
// 3. 双阈值迟滞带（Hysteresis Band）：消除触底临界点上下滑动打架。

export interface TimelineBottomInsetInput {
  /** 悬浮输入区实测或估算总高（含 Composer 卡体、条件层、快捷条与安全边距） */
  overlayHeight: number;
  /** 尾部内容与浮层顶部的呼吸间隙（建议 theme.space.xl = 20dp） */
  gap: number;
  /** 最小保底物理高度（实测缺失或误报 <=0 时的强力兜底） */
  minOverlayHeight?: number;
  /**
   * @deprecated 键盘高度已由 KeyboardChatScrollView 在 UI 线程接管，本纯函数不再叠加
   * @see useSmoothKeyboardTimelineLinkage
   */
  keyboardHeight?: number;
}

function sane(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * 推导时间线 FlatList 的物理底部避让高度（纯物理浮层有效高度 + gap）。
 */
export function deriveTimelineBottomInset(
  input: TimelineBottomInsetInput
): number {
  const minOverlay = sane(input.minOverlayHeight);
  const measuredOverlay = sane(input.overlayHeight);
  const effectiveOverlay = Math.max(minOverlay, measuredOverlay);
  const gap = sane(input.gap);

  // 纯粹且精确：物理浮层有效高度 + 呼吸空隙
  return effectiveOverlay + gap;
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
 * 迟滞带触底跟随状态判定器 2.0（支持手势意图识别的纯函数）：
 * - 当前处于跟随态（currentFollow === true）：
 *   - 关键守卫：若用户未与屏幕发生手势交互（isUserInteracting === false），任何 distance 增加
 *     均为内容自然膨胀或原生测高微滞后，坚决维持 follow = true，严禁误杀跟随态；
 *   - 仅当用户明确施加手势操作且划离底部超过 exit 阈值（64dp）时，才脱离跟随；
 * - 当前处于离底自由浏览态（currentFollow === false）：
 *   - 只要逼近到距离 <= enter 阈值（32dp），自动重新吸附贴底。
 */
export function evaluateFollowState(
  distanceToBottom: number,
  currentFollow: boolean,
  isUserInteracting = true,
  thresholds: FollowThresholds = DEFAULT_FOLLOW_THRESHOLDS
): boolean {
  if (currentFollow) {
    if (!isUserInteracting) {
      return true;
    }
    return distanceToBottom <= thresholds.exit;
  }
  return distanceToBottom <= thresholds.enter;
}
