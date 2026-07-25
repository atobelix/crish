import { CORRELATION_FIELDS } from './common-fields-msg.js';

export const GIT_STATUS_FILE_FIELDS = [
  'path',
  'status',
  'index',
  'worktree',
  'staged',
  'unstaged',
  'untracked',
  'conflicted',
  'originalPath',
] as const;
export const GIT_DIFF_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
  'repositoryRoot',
  'path',
  'staged',
  'unified',
  'stat',
  'files',
] as const;
export const PLAN_DOCUMENTS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'documents',
] as const;
export const PLAN_DOCUMENT_MESSAGE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'document',
] as const;
export const PLAN_DOCUMENT_DELETED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'documentId',
] as const;
export const MUTATION_LEASES_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'leases',
] as const;
export const BACKGROUND_TASKS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'tasks',
  'diagnostics',
] as const;
export const BACKGROUND_TASK_SINGLE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'task',
  'diagnostics',
] as const;
export const ARTIFACTS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'artifacts',
] as const;
export const ARTIFACT_CONTENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'artifactUri',
  'content',
  'mimeType',
] as const;
export const MEMORIES_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'memories',
] as const;
export const MEMORY_DELETED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'memoryId',
] as const;
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
export const MUTATION_LEASE_FIELDS = [
  'token',
  'scope',
  'owner',
  'createdAt',
  'expiresAt',
  'ttlMs',
] as const;
export const MUTATION_LEASE_OWNER_FIELDS = [
  'runId',
  'sessionId',
  'toolCallId',
  'toolName',
  'cwd',
  'targetSummary',
] as const;
export const BACKGROUND_TASK_FIELDS = [
  'id',
  'kind',
  'title',
  'state',
  'command',
  'cwd',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'durationMs',
  'timeoutMs',
  'exitCode',
  'signal',
  'timedOut',
  'cancelled',
  'truncated',
  'stdoutBytes',
  'stderrBytes',
  'outputPreview',
  'diagnostics',
] as const;
export const BACKGROUND_TASK_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'severity',
  'updatedAt',
  'detail',
  'metadata',
] as const;
export const ARTIFACT_RECORD_FIELDS = [
  'uri',
  'type',
  'name',
  'size',
  'createdAt',
  'sessionId',
  'runId',
] as const;
export const MEMORY_RECORD_FIELDS = [
  'id',
  'key',
  'value',
  'scope',
  'createdAt',
  'updatedAt',
] as const;
export const CHECKPOINT_RECORD_FIELDS = [
  'id',
  'runId',
  'sessionId',
  'label',
  'createdAt',
  'messageCount',
] as const;
export const CHANGED_FILE_RECORD_FIELDS = [
  'path',
  'status',
  'addedLines',
  'removedLines',
] as const;
export const SEND_TO_SUBAGENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'subagentRunId',
  'message',
] as const;
export const GET_SUBAGENT_STATUS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'subagentRunId',
] as const;
export const MCP_SERVER_CONTROL_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'serverId',
] as const;
export const MCP_SERVERS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'servers',
] as const;
export const MCP_SERVER_STARTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'serverId',
  'state',
] as const;
export const MCP_SERVER_STOPPED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'serverId',
  'state',
] as const;
export const GET_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'scope',
  'kind',
] as const;
export const UPSERT_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'record',
] as const;
export const DELETE_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'recordId',
] as const;
export const RESOLVE_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
  'workspaceRoot',
  'projectRoot',
  'projectMarkers',
  'projectFiles',
  'projectTags',
  'packageNames',
  'userEnabledIds',
  'userDisabledIds',
  'scopedContextConfig',
] as const;
export const SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS = [
  'userEnabledIds',
  'userDisabledIds',
  'includeRecommendationHints',
  'includeAncestorContextFiles',
  'includeProjectSkillDirs',
  'includeWorkspaceSkillDirs',
  'includeGlobalSkillDirs',
  'globalSkillDirs',
  'workspaceSkillDirs',
  'projectSkillDirs',
  'globalRuleFiles',
  'workspaceRuleFiles',
  'projectRuleFiles',
  'globalRuleDirs',
  'workspaceRuleDirs',
  'projectRuleDirs',
] as const;
export const MCP_SERVER_RECORD_FIELDS = [
  'id',
  'name',
  'state',
  'transport',
  'cachedToolCount',
  'lastError',
  'startedAt',
] as const;
export const SUBAGENT_MESSAGE_SENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'subagentRunId',
  'accepted',
] as const;
export const SUBAGENT_STATUS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'subagentRunId',
  'status',
  'progress',
  'latestError',
] as const;
export const SCOPED_CONTEXT_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'records',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_UPSERTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'record',
  'persisted',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_DELETED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'recordId',
  'deleted',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_RESOLVED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'stableContext',
  'recommended',
  'items',
  'diagnostics',
  'stableContextHash',
  'storeRecordCount',
  'resourceRecordCount',
  'resourceDiagnostics',
  'storeDiagnostic',
] as const;
export const SCOPED_CONTEXT_RECORD_FIELDS = [
  'id',
  'kind',
  'title',
  'content',
  'description',
  'scope',
  'activation',
  'appliesTo',
  'tags',
  'source',
  'sourceMetadata',
  'order',
  'updatedAt',
] as const;
export const SCOPED_CONTEXT_SOURCE_FIELDS = ['type', 'path', 'label'] as const;
export const SCOPED_CONTEXT_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'updatedAt',
  'path',
  'detail',
] as const;
export const SCOPED_CONTEXT_CANDIDATE_FIELDS = [
  'id',
  'kind',
  'title',
  'description',
  'scope',
  'activation',
  'appliesTo',
  'tags',
  'source',
  'reason',
] as const;
export const SCOPED_CONTEXT_ITEM_FIELDS = [
  ...SCOPED_CONTEXT_CANDIDATE_FIELDS,
  'status',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS = [
  'severity',
  'id',
  'code',
  'message',
] as const;
export const SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS = [
  'severity',
  'path',
  'message',
] as const;
export const PROMPT_CONTEXT_BLOCK_FIELDS = [
  'id',
  'kind',
  'label',
  'content',
] as const;
export const WORKFLOW_FIELDS = [
  'id',
  'name',
  'prompt',
  'cwd',
  'mode',
  'schedule',
  'enabled',
  'createdAt',
  'updatedAt',
  'metadata',
] as const;
export const WORKFLOW_RUN_FIELDS = [
  'workflowId',
  'runId',
  'sessionId',
  'scheduledFor',
  'startedAt',
  'status',
  'error',
] as const;
export const PLAN_DOCUMENT_SUMMARY_FIELDS = [
  'id',
  'title',
  'goal',
  'status',
  'version',
  'createdAt',
  'updatedAt',
  'steps',
  'questions',
  'assumptions',
  'acceptance',
  'risks',
] as const;
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
export const TASK_BACKGROUND_TASK_FIELDS = [
  'id',
  'kind',
  'title',
  'state',
  'command',
  'cwd',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'durationMs',
  'exitCode',
  'signal',
  'outputPreview',
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
export const WORKFLOW_RUN_STATUSES = [
  'running',
  'awaiting-approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export const BACKGROUND_TASK_STATES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
] as const;
export const WORKFLOW_SCHEDULE_TYPES = [
  'manual',
  'daily',
  'intervalMinutes',
] as const;
export const PROVIDER_CREDENTIAL_MODES = ['direct', 'auto'] as const;
export const PROVIDER_ENDPOINTS = [
  'auto',
  'responses',
  'chat-completions',
] as const;
export const SYSTEM_PROMPT_WIRE_MODES = [
  'native-system-role',
  'user-prefix',
] as const;
export const PROVIDER_READINESS_STATUSES = [
  'ready',
  'missing',
  'login-required',
  'insufficient-quota',
  'gateway-unavailable',
  'credential-unavailable',
  'invalid-response',
  'unknown',
] as const;
export const PROVIDER_API_KEY_SOURCES = [
  'default',
  'env',
  'runtime-update',
  'user-config',
  'workspace-config',
  'unset',
  'unknown',
] as const;
export const DAEMON_LIFECYCLE_STATES = [
  'starting',
  'ready',
  'stopping',
  'stopped',
  'degraded',
] as const;
export const LIFECYCLE_DIAGNOSTIC_SOURCES = [
  'daemon',
  'websocket',
  'client',
  'event-store',
  'provider',
  'mcp',
] as const;
export const LIFECYCLE_DIAGNOSTIC_SEVERITIES = ['warning', 'error'] as const;
export const EVENT_STORE_STATUSES = ['ok', 'failed'] as const;
export const MCP_READINESS_STATUSES = [
  'ready',
  'degraded',
  'starting',
  'stopped',
  'unknown',
] as const;
export const CAPABILITY_STATES = [
  'implemented',
  'experimental',
  'unsupported',
  'degraded',
  'backend-not-wired',
] as const;
export const CAPABILITY_OWNERS = [
  'agent-daemon',
  'agent-runtime',
  'agent-orchestrator',
  'workbench',
  'tauri',
] as const;
export const CAPABILITY_DIAGNOSTIC_SEVERITIES = [
  'info',
  'warning',
  'error',
] as const;
export const SCOPED_CONTEXT_KINDS = ['rule', 'skill'] as const;
export const SCOPED_CONTEXT_SCOPES = [
  'global',
  'project',
  'workspace',
] as const;
export const SCOPED_CONTEXT_ACTIVATIONS = [
  'enabled',
  'recommended',
  'disabled',
] as const;
export const SCOPED_CONTEXT_STORE_STATUSES = ['ok', 'degraded'] as const;
export const SCOPED_CONTEXT_SOURCE_TYPES = [
  'global-rule',
  'project-rule',
  'workspace-rule',
  'skill-file',
  'user',
  'system',
] as const;
export const SCOPED_CONTEXT_ITEM_STATUSES = [
  'active',
  'recommended',
  'disabled',
  'inapplicable',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES = [
  'info',
  'warning',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES = [
  'disabled',
  'scope-mismatch',
  'applies-to-mismatch',
  'empty-content',
] as const;
export const PROMPT_CONTEXT_BLOCK_KINDS = [
  'project-profile',
  'runtime-profile',
  'skills-hook',
  'memory-hook',
  'plan-hook',
  'custom-stable',
  'custom-volatile',
] as const;
export const RUN_KINDS = ['task', 'goal'] as const;
export const APPROVAL_PROTOCOL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
] as const;
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
