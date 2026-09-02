/**
 * apps/crish-desktop/src/components/ui/PreviewCard/index.ts
 * PreviewCard 富媒体悬停预览组件出口
 */

export {
  PreviewCard,
  PreviewCardTrigger,
  PreviewCardContent,
  PreviewCardTitle,
  PreviewCardDescription,
  usePreviewCardContext,
  computePreviewCardPosition,
  PREVIEW_CARD_EDGE_PAD,
} from './PreviewCard';

export { PreviewCardArrow } from './PreviewCardArrow';

export type {
  PreviewCardProps,
  PreviewCardTriggerProps,
  PreviewCardContentProps,
  PreviewCardTitleProps,
  PreviewCardDescriptionProps,
  PreviewCardArrowProps,
  PreviewCardSide,
  PreviewCardAlign,
  PreviewCardContextValue,
  PreviewCardPositionResult,
} from './types';
