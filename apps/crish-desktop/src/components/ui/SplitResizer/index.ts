/**
 * apps/crish-desktop/src/components/ui/SplitResizer/index.ts
 * 统一分栏拖拽组件统一导出（手势 hook 本体在同目录 useSplitResize.ts）
 */
export { SplitResizer } from './SplitResizer';
export { ElasticSplitHandle } from './ElasticSplitHandle';
export type { ElasticSplitHandleProps } from './ElasticSplitHandle';
export type {
  SplitResizerProps,
  SplitResizerRestMode,
  SplitResizeCommitMode,
  SplitResizeOrientation,
} from './SplitResizer';
export {
  ElasticHandleEngine,
  ELASTIC_HANDLE_DEFAULTS,
  ELASTIC_SPRING_PRESET,
} from './elasticHandle';
export type {
  ElasticHandleParams,
  ElasticSpringKey,
  SpringConfig,
} from './elasticHandle';
export { useSplitResize } from './useSplitResize';
export type {
  UseSplitResizeOptions,
  UseSplitResizeResult,
} from './useSplitResize';
