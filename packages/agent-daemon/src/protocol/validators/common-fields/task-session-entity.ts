export const TASK_SNAPSHOT_FIELDS = [
  'runId',
  'sessionId',
  'status',
  'title',
  'messages',
  'latestError',
  'approval',
  'pendingToolCalls',
  'backgroundTasks',
  'progress',
  'usage',
  'cache',
  'updatedAt',
  'progressLabel',
  'currentRun',
] as const;
export const TASK_MESSAGE_FIELDS = [
  'id',
  'role',
  'content',
  'createdAt',
  'toolCalls',
] as const;
export const TASK_TOOL_CALL_FIELDS = [
  'id',
  'name',
  'input',
  'status',
  'summary',
  'startedAt',
  'updatedAt',
  'output',
  'approvalMetadata',
] as const;
export const TASK_APPROVAL_FIELDS = [
  'toolCallId',
  'toolName',
  'input',
  'summary',
  'requestedAt',
  'status',
  'risk',
  'riskReason',
  'requiresDoubleConfirm',
  'recommendSnapshot',
  'metadata',
] as const;
export const TASK_PROGRESS_FIELDS = [
  'label',
  'eventCount',
  'turnCount',
  'textDeltaCount',
  'toolCallCount',
  'completedToolCallCount',
  'pendingToolCallCount',
  'approvalPending',
  'updatedAt',
] as const;
export const TASK_USAGE_FIELDS = [
  'sampleCount',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'reasoningTokens',
] as const;
export const TASK_CACHE_FIELDS = [
  'sampleCount',
  'promptTokens',
  'readTokens',
  'writeTokens',
  'missTokens',
  'hitRatio',
  'writeRatio',
  'stablePrefixHash',
  'cacheKey',
  'cacheStrategy',
] as const;
export const TASK_CURRENT_RUN_FIELDS = [
  'id',
  'sessionId',
  'cwd',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'metadata',
] as const;
export const SESSION_RECORD_FIELDS = [
  'id',
  'cwd',
  'createdAt',
  'updatedAt',
  'status',
  'currentLeafId',
  'metadata',
] as const;
export const RUN_RECORD_FIELDS = [
  'id',
  'sessionId',
  'cwd',
  'status',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'outcome',
  'reason',
  'outcomeDetail',
  'error',
  'kind',
  'goal',
  'lastEventId',
  'metadata',
] as const;
export const ORCHESTRATOR_EVENT_FIELDS = [
  'protocolVersion',
  'id',
  'sequence',
  'type',
  'sessionId',
  'runId',
  'timestamp',
  'payload',
] as const;
export const SESSION_STATUSES = ['open', 'closed', 'archived'] as const;
export const PENDING_INPUT_MODES = ['after-current-run', 'steer'] as const;
export const PENDING_INPUT_STATUSES = [
  'pending',
  'cancelled',
  'dispatched',
] as const;
export const PENDING_INPUT_SOURCES = [
  'workbench',
  'daemon',
  'automation',
] as const;
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting-approval',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
] as const;
export const RUN_KINDS = ['task', 'goal'] as const;
export const GOAL_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'blocked',
  'cancelled',
  'failed',
] as const;
export const GOAL_STOPPED_REASONS = [
  'complete',
  'blocked',
  'max-rounds',
  'stalled',
  'cancelled',
  'error',
] as const;
export const GOAL_CONTINUATION_ACTIONS = [
  'continue',
  'complete',
  'block',
] as const;
export const GOAL_STATE_FIELDS = [
  'status',
  'visibleGoal',
  'maxRounds',
  'maxStalledRounds',
  'currentRound',
  'completedRounds',
  'stalledRounds',
  'stoppedReason',
  'lastProgressSignature',
  'lastDecision',
] as const;
export const GOAL_DECISION_FIELDS = [
  'action',
  'reason',
  'prompt',
  'progressSignature',
  'detail',
] as const;
export const ORCHESTRATOR_EVENT_TYPES = [
  'session-created',
  'conversation-rewind-audit',
  'session-leaf-moved',
  'pending-input-created',
  'pending-input-cancelled',
  'pending-input-dispatched',
  'run-queued',
  'run-started',
  'goal-round-started',
  'goal-round-completed',
  'goal-continuation-decided',
  'runtime-event',
  'run-cancel-requested',
  'run-cancelled',
  'run-completed',
  'run-failed',
] as const;
