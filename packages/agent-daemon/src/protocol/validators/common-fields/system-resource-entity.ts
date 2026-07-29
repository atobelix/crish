import { CORRELATION_FIELDS } from './shared.js';

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
export const APPROVAL_PROTOCOL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
] as const;
