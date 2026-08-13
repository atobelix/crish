// 业务区块（M4 §2.3 L3：ApprovalCard/EventRow/SessionRow/ConnectionBanner/…）
// 区块 props 一律为「领域类型 + 派生标记」，不感知数据来源
export { default as ApprovalCard } from './ApprovalCard';
export type { ApprovalCardProps } from './ApprovalCard';
export {
  decisionStatusText,
  formatRemainingMs,
  maskCommandSecrets,
  maskSensitiveParamValue,
  summarizeParameters,
  COUNTDOWN_WARNING_MS,
} from './ApprovalCard';
export { default as ApprovalActionBar } from './ApprovalActionBar';
export type { ApprovalActionBarProps } from './ApprovalActionBar';
export { default as SlideToConfirm } from './SlideToConfirm';
export type {
  SlideToConfirmProps,
  SlidePanConfig,
  SlidePanDeps,
} from './SlideToConfirm';
export {
  SLIDE_TRIGGER_THRESHOLD,
  SLIDE_ARBITER_MIN_DX,
  SLIDE_ARBITER_RATIO,
  SLIDE_THUMB_SIZE,
  SLIDE_REBOUND_MS,
  createSlideConfirmState,
  slideUsableWidth,
  shouldClaimSlidePan,
  slideStart,
  slideMove,
  slideEnd,
  slideCancel,
} from './slideConfirmMachine';
export type { SlideConfirmState, SlidePhase } from './slideConfirmMachine';
