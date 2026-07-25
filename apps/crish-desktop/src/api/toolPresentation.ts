/**
 * 工具展示 + 助手时间线（门面文件）。
 *
 * 原则：
 * - 保持 100% 向后兼容，重导出 tool-presentation 子模块中所有类型与公共 API。
 * - 文件体精简为 ≤250 行的门面。
 */

export type {
  AssistantTimelineItem,
  TimelineTextItem,
  ToolRenderItem,
  ToolRowTone,
} from './tool-presentation/toolPresentationTypes';

export {
  buildAssistantTimeline,
  buildToolRenderItems,
  dedupeToolCalls,
  normalizeAssistantTimeline,
} from './tool-presentation/timelineNormalizer';

export {
  assistantCopyText,
  extractImageRefs,
  extractToolCommand,
  formatToolDiffStat,
  fullToolOutput,
  humanizeAgentSummary,
  humanizeShellCommand,
  isInspectTool,
  isInterruptedTool,
  isPlaceholderToolOutput,
  isShellToolName,
  isToolRowDefaultOpen,
  isTrivialToolOutput,
  normalizeToolDiffStat,
  parseGitShortstat,
  resolveToolRowOpen,
  toolCommandPreview,
  toolDiffLineStats,
  toolHasDiffStat,
  toolHasDisplayableResult,
  toolHasExpandableBody,
  toolHumanLabel,
  toolPathDisplayName,
  toolResultPreview,
  toolRowTone,
  toolSummaryLabel,
  truncateToolOutput,
} from './tool-presentation/toolCardPresenter';
