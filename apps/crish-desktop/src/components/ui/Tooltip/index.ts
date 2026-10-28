/**
 * apps/crish-desktop/src/components/ui/Tooltip/index.ts
 * 气泡提示原子设计单元统一导出
 */
export { Tooltip } from './Tooltip';
export type { TooltipProps, TooltipSide } from './Tooltip';
export {
  DEFAULT_DELAY_SHOW_MS,
  isValidDOMRect,
  type ClampedTooltipResult,
} from './Tooltip';
export {
  resetTooltipControllerForTests,
  resetTooltipControllerForTests as resetTooltipControllerForTest,
  claimTooltipSlot,
  releaseTooltipSlot,
  isTooltipMuted,
} from './tooltipController';
