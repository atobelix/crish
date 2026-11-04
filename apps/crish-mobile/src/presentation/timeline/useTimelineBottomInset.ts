// 时间线底部避让与悬浮浮层测量 Hook。
//
// 统一对话屏的时间线消息流为全屏滚动，底部输入区（Composer 及相关条件层）
// 是绝对定位悬浮其上的浮层（由 KeyboardStickyView 承载）。
// 为保证列表尾部内容在未激活键盘与键盘激活两种状态下，都能完整滚到浮层上方
// 并与浮层顶部至少保持 16~24px 的舒适呼吸空隙（2026-11-03 方案 07 重构）：
// 1. 实测优先并立即同步：以 onLayout 测量到的高度为主，挂载及后续尺寸变化立即落值，
//    消除 90ms 防抖滞后；刚性过滤 <= 0 的无效帧，严禁穿透覆盖为 0；
// 2. 精确估算保底：计算 Composer 基础高度（两行形态 98px / 单行 52px）+ 快捷条（27px）+
//    附件条（68px）+ 错误条/停止胶囊等条件层 + 容器内边距 + 底部 safeAreaInset + 阴影出血；
// 3. 几何冲突解耦：列表底部 inset 仅按「有效浮层高 + gap」避让；键盘弹起时由 KeyboardStickyView
//    在 UI 线程执行 translateY 向上平移，不再在列表 paddingBottom 叠加键盘高度，消除双重垫高；
// 4. 浮层总占高与物理高：产出 floatingHeight（含键盘高，专供 EdgeFade 底部羽化遮罩消费）与
//    overlayHeight（实测纯物理高，专供 ScrollToBottomButton 锚定输入框左上角）。
import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useTheme } from '@/adapters/platform/theme';
import { deriveTimelineBottomInset } from '@/domain/pure/timelineBottomInset';
import { ATTACHMENT_STRIP_HEIGHT } from '@/presentation/components/chat/AttachmentStrip';

/** Composer 两行形态总高（首行 36 + 行距 6 + 次行 36 + 上下边距 10×2 = 98） */
export const COMPOSER_TWO_ROW_HEIGHT = 98;
/** 快捷条高（胶囊 22 + 下距 5 = 27） */
export const COMPOSER_CONTEXT_BAR_HEIGHT = 27;
/** 错误条估算高（message + detail + padding + margin） */
export const COMPOSER_ERROR_BAR_ESTIMATED_HEIGHT = 48;
/** 停止胶囊估算高（pill 32 + 上下 padding + marginBottom） */
export const COMPOSER_STOP_PILL_ESTIMATED_HEIGHT = 40;
/** 阴影与出血安全保护间距 */
export const COMPOSER_SHADOW_BLEED_MARGIN = 6;

export interface UseTimelineBottomInsetOptions {
  /** 底部安全区高度（insets.bottom，全面屏手势条通常 24~34px，三键导航 0） */
  bottomSafeArea?: number;
  /** 是否存在快捷条（contextBar） */
  hasContextBar?: boolean;
  /** 是否注入了模型控制器（注入即恒两行形态 98px；未注入为单行 minHeight 52px） */
  hasModelControl?: boolean;
  /** 是否有已选附件（附件条展开 68px） */
  hasAttachments?: boolean;
  /** 是否有常驻错误条 */
  hasError?: boolean;
  /** 是否处于生成中且可停止（停止胶囊在场） */
  isBusyWithStop?: boolean;
  /** 列表尾部与浮层顶部的呼吸间距（建议 16~24px，默认取 theme.space.xl = 20px） */
  gap?: number;
}

export interface UseTimelineBottomInsetResult {
  /** 时间线列表 contentContainerStyle.paddingBottom 与 scrollIndicatorInsets 消费的 inset */
  timelineBottomInset: number;
  /** 包含键盘高度的浮层总高（仅供 EdgeFade 底部遮罩消费，严禁用于按钮绝对定位） */
  floatingHeight: number;
  /** 供悬浮输入区容器（KeyboardStickyView）挂载的 onLayout 监听函数 */
  handleOverlayLayout: (event: LayoutChangeEvent) => void;
  /** 实测或估算的有效浮层物理高度（不含键盘，专供 ScrollToBottomButton 锚定输入框左上角） */
  overlayHeight: number;
  /** 当前软键盘高度 */
  keyboardHeight: number;
}

export function useTimelineBottomInset(
  options: UseTimelineBottomInsetOptions = {}
): UseTimelineBottomInsetResult {
  const theme = useTheme();
  const keyboardHeight = useKeyboardHeight();

  const {
    bottomSafeArea = 0,
    hasContextBar = false,
    hasModelControl = false,
    hasAttachments = false,
    hasError = false,
    isBusyWithStop = false,
    gap = theme.space.xl,
  } = options;

  // 1. 计算悬浮浮层的物理保底高度与估算高度
  const composerBase = hasModelControl
    ? COMPOSER_TWO_ROW_HEIGHT
    : theme.size.composerMin;
  const containerPaddingTop = theme.space.sm; // 8px
  const containerPaddingBottom = Math.max(bottomSafeArea, theme.space.sm);

  // 最小物理保底（即便没有附加条件层，Composer + 安全区也不可小于此值）
  const minOverlayHeight =
    composerBase +
    (hasContextBar ? COMPOSER_CONTEXT_BAR_HEIGHT : 0) +
    containerPaddingTop +
    containerPaddingBottom;

  // 全量估算初值（首测前以及实测无效时的精确安全兜底）
  const estimatedOverlayHeight =
    minOverlayHeight +
    (hasAttachments ? ATTACHMENT_STRIP_HEIGHT : 0) +
    (hasError ? COMPOSER_ERROR_BAR_ESTIMATED_HEIGHT : 0) +
    (isBusyWithStop ? COMPOSER_STOP_PILL_ESTIMATED_HEIGHT : 0) +
    COMPOSER_SHADOW_BLEED_MARGIN;

  // 2. 实测高度状态管理（无滞后立即同步，<= 0 拦截守卫）
  const [overlayHeight, setOverlayHeight] = useState<number | null>(null);
  const overlayCommittedRef = useRef<number | null>(null);

  const handleOverlayLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    // 关键守卫：挂载首帧或空容器可能汇报 0/NaN/负数，绝不将其作为有效高度提交，
    // 坚决防止估算值被覆盖为 0 导致最后一条消息被输入框遮挡
    if (!Number.isFinite(height) || height <= 0) return;

    if (
      overlayCommittedRef.current !== null &&
      Math.abs(height - overlayCommittedRef.current) < 1
    ) {
      return;
    }

    overlayCommittedRef.current = height;
    setOverlayHeight(height);
  }, []);

  // 3. 有效高度裁决：实测存在且大于 0 则采用实测值，否则取精确估算兜底
  const effectiveOverlayHeight =
    overlayHeight !== null && overlayHeight > 0
      ? overlayHeight
      : estimatedOverlayHeight;

  // 4. 浮层总占高与时间线底部内边距推导
  const floatingHeight = effectiveOverlayHeight + keyboardHeight;
  const timelineBottomInset = deriveTimelineBottomInset({
    overlayHeight: effectiveOverlayHeight,
    minOverlayHeight,
    keyboardHeight,
    gap,
  });

  return {
    timelineBottomInset,
    floatingHeight,
    handleOverlayLayout,
    overlayHeight: effectiveOverlayHeight,
    keyboardHeight,
  };
}
