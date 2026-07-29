import { CORRELATION_FIELDS } from './shared.js';

export const CHECKPOINTS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'checkpoints',
] as const;
export const CHECKPOINT_DIFF_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'checkpointId',
  'files',
] as const;
export const CHECKPOINT_RESTORED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'checkpointId',
  'runId',
] as const;
export const CONVERSATION_REWIND_BOUNDARY_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'sessionId',
  'userMessageId',
  'latestUserMessage',
  'mode',
  'boundary',
  'checkpoint',
  'target',
  'missingFacts',
  'diagnostics',
  'plan',
  'runtimeTargetLeafId',
] as const;
export const CONVERSATION_REWIND_PREVIEW_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'plan',
] as const;
export const CONVERSATION_REWIND_APPLIED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'plan',
  'stepResults',
] as const;
export const CONVERSATION_REWIND_STEP_RESULT_FIELDS = [
  'type',
  'status',
  'code',
  'message',
  'affectedIds',
  'metadata',
] as const;
export const SESSION_TREE_ENTRY_FIELDS = [
  'type',
  'id',
  'parentId',
  'createdAt',
  'payload',
  'summary',
  'abandonedLeafId',
  'details',
] as const;
export const REWIND_CHECKPOINT_FIELDS = [
  'source',
  'checkpointId',
  'manifestPath',
  'checkpoint',
  'cleanUntracked',
] as const;
export const REWIND_ACTIVE_SUBAGENT_FIELDS = [
  'parentRunId',
  'subagentRunId',
  'subagentId',
] as const;
export const REWIND_BOUNDARY_RECORD_FIELDS = [
  'sessionId',
  'runId',
  'userMessageId',
  'sessionTreeLeafIdBefore',
  'sessionTreeLeafIdAfter',
  'runtimeLeafIdBefore',
  'runtimeLeafIdAfter',
  'eventSequence',
  'workspaceRoot',
  'checkpointId',
  'checkpointRef',
  'checkpointSource',
  'changedPaths',
  'createdAt',
  'metadata',
] as const;
export const REWIND_CHECKPOINT_RECORD_FIELDS = [
  'sessionId',
  'runId',
  'userMessageId',
  'toolCall',
  'checkpointId',
  'checkpointRef',
  'workspaceRoot',
  'changedPaths',
  'source',
  'createdAt',
  'metadata',
] as const;
export const REWIND_CHECKPOINT_TOOL_CALL_FIELDS = [
  'id',
  'toolName',
  'actor',
  'sessionId',
  'targetSummary',
] as const;
export const REWIND_TARGET_FACTS_FIELDS = [
  'sessionId',
  'runId',
  'userMessageId',
  'mode',
  'eventSequence',
  'workspaceRoot',
  'changedPaths',
  'createdAt',
  'sessionTreeTargetLeafId',
  'runtimeTargetLeafId',
  'checkpoint',
  'missingFacts',
  'metadata',
] as const;
export const REWIND_TARGET_CHECKPOINT_FACTS_FIELDS = [
  'checkpointId',
  'checkpointRef',
  'checkpointSource',
  'workspaceRoot',
  'changedPaths',
  'createdAt',
] as const;
export const REWIND_BOUNDARY_DIAGNOSTIC_FIELDS = [
  'code',
  'fact',
  'message',
  'blocked',
  'metadata',
] as const;
export const REWIND_PLAN_FIELDS = [
  'sessionId',
  'fromLeafId',
  'targetLeafId',
  'targetPath',
  'entryProjection',
  'runCancellations',
  'approvalClearances',
  'workspaceRestore',
  'steps',
] as const;
export const REWIND_ENTRY_PROJECTION_FIELDS = [
  'currentPath',
  'targetPath',
  'commonAncestorId',
  'retainedEntryIds',
  'hiddenEntryIds',
  'hiddenCurrentPathEntryIds',
  'hiddenBranchEntryIds',
] as const;
export const REWIND_RUN_CANCELLATION_FIELDS = [
  'runId',
  'reason',
  'role',
] as const;
export const REWIND_APPROVAL_CLEARANCE_FIELDS = [
  'toolCallId',
  'runId',
  'reason',
] as const;
export const REWIND_WORKSPACE_RESTORE_FIELDS = [
  'required',
  'source',
  'checkpointId',
  'checkpoint',
  'manifestPath',
  'cleanUntracked',
] as const;
export const REWIND_STEP_FIELDS = [
  'type',
  'runs',
  'approvals',
  'restore',
  'sessionId',
  'fromLeafId',
  'toLeafId',
] as const;
export const CHECKPOINT_RECORD_FIELDS = [
  'id',
  'runId',
  'sessionId',
  'label',
  'createdAt',
  'messageCount',
] as const;
