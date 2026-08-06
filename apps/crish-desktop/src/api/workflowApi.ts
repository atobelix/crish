/**
 * 引擎 workflow 调度 API（正式版 H3 - 门面层）
 */

// 调度类型与校验/标签工具来自 workflowScheduler（引擎契约层）
export type {
  WorkflowSchedule,
  CronValidationResult,
  ScheduleValidationResult,
} from './workflow-api/workflowScheduler';

export {
  DEFAULT_DAILY_TIME,
  DEFAULT_INTERVAL_MINUTES,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  WORKFLOW_INTERVAL_MINUTES_MAX,
  isValidDailyTime,
  tryNormalizeDailyTime,
  normalizeDailyTime,
  isValidIanaTimezone,
  parseIntervalMinutes,
  validateCronExpression,
  isValidCronExpression,
  cronExpressionLabel,
  validateWorkflowSchedule,
  normalizeWorkflowSchedule,
  scheduleLabel,
  defaultTimezone,
} from './workflow-api/workflowScheduler';

// 草稿、预设模板与空态文案来自 workflowDraft（UI 契约层）
export type {
  WorkflowScheduleType,
  WorkflowScheduleDraft,
  WorkflowSchedulePreset,
  WorkflowJobsEmptyKind,
} from './workflow-api/workflowDraft';

export {
  WORKFLOW_SCHEDULE_TYPES,
  WORKFLOW_SCHEDULE_PRESETS,
  WORKFLOW_SCHEDULE_CAPABILITY_NOTE,
  WORKFLOW_SCHEDULE_PLANNED_TYPES,
  WORKFLOW_JOBS_EMPTY_LABELS,
  watchTriggerHint,
  workflowJobsEmptyLabel,
  resolveWorkflowJobsEmptyCopy,
  workflowEnabledLabel,
  validateWorkflowDraft,
  emptyWorkflowDraft,
  buildScheduleFromDraft,
} from './workflow-api/workflowDraft';

export type {
  WorkflowDefinition,
  WorkflowRunEntry,
} from './workflow-api/workflowRunner';

export {
  SCHEDULED_SESSION_TITLE_PREFIX,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  triggerWorkflow,
  listWorkflowRuns,
  workflowRunStatusLabel,
  scheduledSessionTitle,
  canReplaceSessionTitleWithScheduled,
  workflowTriggerOkMessage,
  workflowActionErrorMessage,
} from './workflow-api/workflowRunner';
