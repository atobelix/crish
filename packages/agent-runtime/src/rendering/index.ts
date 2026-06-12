/**
 * 中央统一渲染机制 - 公共导出
 */

export {
  RenderingPipeline,
  DiagnosticInspector,
  DEFAULT_RENDERING_OPTIONS,
} from "./rendering-pipeline";

export type {
  RenderItemType,
  RenderPriority,
  RenderItem,
  RenderStage,
  RenderStageResult,
  RenderFilter,
  RenderTransformer,
  RenderingPipelineOptions,
  RenderingPipelineDiagnostics,
  DiagnosticReport,
} from "./rendering-pipeline";
