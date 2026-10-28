/**
 * apps/crish-desktop/src/components/ui/layer/index.ts
 * 浮层与模态调度中枢公开桥接导出
 */
export {
  layerStackManager,
  layerStackService,
  useIsModalActive,
  useLayerStackModalActive,
  useFloatingActive,
  LayerContext,
  LayerProvider,
  useLayerContext,
  getLayerTier,
  isModalLayer,
  isPopoverMenuLayer,
  isOverlayToastLayer,
  LAYER_TIER_MAP,
  LAYER_TIER_PRIORITY,
} from '../internal/layer-stack/LayerStackManager';
export type {
  DismissReason,
  LayerType,
  LayerTier,
  LayerRegistration,
  LayerTraceRecord,
  DismissedByPointerSnapshot,
  StackListener,
  LayerContextValue,
  LayerProviderProps,
} from '../internal/layer-stack/LayerStackManager';

export {
  useLayerRegistration,
  useVirtualLayer,
} from '../internal/layer-registration/useLayerRegistration';
