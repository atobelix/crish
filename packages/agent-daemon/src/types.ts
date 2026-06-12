/**
 * Daemon 内部类型定义
 * 定义 WebSocket 消息协议和内部数据结构
 */

import type { JsonObject, AgentEvent } from "@crish/shared-types";
import type {
  CheckpointManifestRecord,
  ConversationBoundaryManifestRecord,
  ConversationRewindBoundaryTargetMode,
  ConversationRewindTargetFacts,
  OpenAICompatibleEndpoint,
  CreatePlanDocumentInput,
  PromptAssemblyContextBlock,
  PlanDocument,
  PlanDocumentPatch,
  PlanDocumentSummary,
  RuntimeMetricsSnapshot,
  ScopedContextActivation,
  ScopedContextCandidate,
  ScopedContextDiagnostic,
  ScopedContextKind,
  ScopedContextResolvedItem,
  ScopedContextResolverProject,
  ScopedContextScope,
  ScopedContextSource,
} from "@crish/agent-runtime";
import type {
  ConversationRewindCheckpointTarget,
  ConversationRewindPlan,
  ConversationRewindRestorePolicy,
  OrchestratorEvent,
  OrchestratorEventLogMetadata,
  OrchestratorRunRecord,
  PendingInputMode,
  PendingInputRecord,
  RunStatus,
  OrchestratorSessionRecord,
  SessionTreeEntry,
} from "@crish/agent-orchestrator";
import type { SessionAction, SessionActionReceipt } from "@crish/shared-types";
import { homedir } from "node:os";
import { join } from "node:path";

// ==================== WebSocket 消息协议 ====================

/** 客户端 → Daemon 的消息类型 */
export type DaemonInboundMessage = (
  | RunTaskMessage
  | ApproveToolMessage
  | DenyToolMessage
  | ListApprovalHistoryMessage
  | CancelRunMessage
  | HelloMessage
  | PingMessage
  | GetStatusMessage
  | ListCapabilitiesMessage
  | UpdateConfigMessage
  | ListSessionsMessage
  | ListRunsMessage
  | ReadSessionEventsMessage
  | ReadRunEventsMessage
  | GetRunSnapshotMessage
  | EnqueuePendingInputMessage
  | CancelPendingInputMessage
  | DispatchPendingInputMessage
  | ListPendingInputsMessage
  | GetMetricsMessage
  | GetMetricsSnapshotMessage
  | ListWorkflowsMessage
  | CreateWorkflowMessage
  | UpdateWorkflowMessage
  | DeleteWorkflowMessage
  | TriggerWorkflowMessage
  | ListWorkflowRunsMessage
  | GitStatusMessage
  | GitDiffMessage
  | ListPlanDocumentsMessage
  | CreatePlanDocumentMessage
  | CreateRequirementsAlignmentPlanMessage
  | GetPlanDocumentMessage
  | PatchPlanDocumentMessage
  | DeletePlanDocumentMessage
  | ListMutationLeasesMessage
  | ListBackgroundTasksMessage
  | StartBackgroundTaskMessage
  | CancelBackgroundTaskMessage
  | GetBackgroundTaskHistoryMessage
  | ListArtifactsMessage
  | GetArtifactContentMessage
  | ListMemoriesMessage
  | DeleteMemoryMessage
  | ListCheckpointsMessage
  | RestoreCheckpointMessage
  | GetCheckpointDiffMessage
  | ResolveConversationRewindBoundaryMessage
  | PreviewConversationRewindMessage
  | PreviewConversationRewindByBoundaryMessage
  | ApplyConversationRewindMessage
  | ApplySessionActionMessage
  | SendToSubagentMessage
  | GetSubagentStatusMessage
  | StartMcpServerMessage
  | StopMcpServerMessage
  | ListMcpServersMessage
  | GetScopedContextMessage
  | UpsertScopedContextMessage
  | DeleteScopedContextMessage
  | ResolveScopedContextMessage
) & DaemonCorrelationFields;

/** Daemon → 客户端的消息类型 */
export type DaemonOutboundMessage = (
  | WelcomeMessage
  | DaemonReadyMessage
  | EventMessage
  | ApprovalRequestedMessage
  | ApprovalResolvedMessage
  | ApprovalHistoryListedMessage
  | ErrorMessage
  | PongMessage
  | StatusResponseMessage
  | CapabilitiesResponseMessage
  | ConfigUpdatedMessage
  | SubagentStartedMessage
  | SubagentEndedMessage
  | SubagentEventMessage
  | SessionsListedMessage
  | RunsListedMessage
  | SessionEventsMessage
  | RunEventsMessage
  | RunSnapshotMessage
  | PendingInputQueuedMessage
  | PendingInputCancelledMessage
  | PendingInputDispatchedMessage
  | PendingInputsListedMessage
  | MetricsResponseMessage
  | WorkflowsListedMessage
  | WorkflowCreatedMessage
  | WorkflowUpdatedMessage
  | WorkflowDeletedMessage
  | WorkflowTriggeredMessage
  | WorkflowRunUpdatedMessage
  | WorkflowRunsListedMessage
  | GitStatusResponseMessage
  | GitDiffResponseMessage
  | PlanDocumentsListedMessage
  | PlanDocumentCreatedMessage
  | PlanDocumentMessage
  | PlanDocumentPatchedMessage
  | PlanDocumentDeletedMessage
  | MutationLeasesListedMessage
  | BackgroundTasksListedMessage
  | BackgroundTaskStartedMessage
  | BackgroundTaskCancelledMessage
  | BackgroundTaskHistoryMessage
  | ArtifactsListedMessage
  | ArtifactContentMessage
  | MemoriesListedMessage
  | MemoryDeletedMessage
  | CheckpointsListedMessage
  | CheckpointDiffMessage
  | CheckpointRestoredMessage
  | ConversationRewindBoundaryMessage
  | ConversationRewindPreviewMessage
  | ConversationRewindAppliedMessage
  | SessionActionReceiptMessage
  | SubagentMessageSentMessage
  | SubagentStatusMessage
  | McpServerStartedMessage
  | McpServerStoppedMessage
  | McpServersListedMessage
  | ScopedContextResponseMessage
  | ScopedContextUpsertedMessage
  | ScopedContextDeletedMessage
  | ScopedContextResolvedMessage
) & DaemonCorrelationFields;

// ---- 入站消息 ----

export interface DaemonCorrelationFields {
  requestId?: string;
  correlationId?: string;
}

export interface RunTaskMessage {
  type: "run-task";
  runId: string;
  sessionId?: string;
  prompt: string;
  mode?: string;
  workspaceMode?: "project" | "none";
  cwd?: string;
  visibleGoal?: string;
  budgetDifficulty?: string;
  runTokenBudget?: number;
  maxRounds?: number;
  maxStalledRounds?: number;
  backgroundDrainTimeoutMs?: number;
  /** 权限模式："ask" = 需要审批，"full-access" = 全部自动允许 */
  permissionMode?: "ask" | "full-access";
  workspaceRoot?: string;
  projectRoot?: string;
  projectMarkers?: string[];
  projectFiles?: string[];
  projectTags?: string[];
  packageNames?: string[];
  scopedContextConfig?: ScopedContextRuntimeConfig;
}

export interface ApproveToolMessage {
  type: "approve-tool";
  toolCallId: string;
  /** 审批范围："project" = 在项目中允许, "always" = 始终允许 */
  scope?: "project" | "always";
}

export interface DenyToolMessage {
  type: "deny-tool";
  toolCallId: string;
}

export interface ListApprovalHistoryMessage {
  type: "list-approval-history";
  sessionId?: string;
  runId?: string;
  toolName?: string;
  status?: ApprovalProtocolStatus;
  decision?: ApprovalProtocolStatus;
  risk?: string;
  limit?: number;
}

export interface CancelRunMessage {
  type: "cancel-run";
  runId: string;
}

export interface EnqueuePendingInputMessage {
  type: "enqueue-pending-input";
  sessionId: string;
  text: string;
  runId?: string;
  mode?: PendingInputMode;
  inputId?: string;
  source?: PendingInputRecord["source"];
  metadata?: JsonObject;
}

export interface CancelPendingInputMessage {
  type: "cancel-pending-input";
  inputId: string;
  sessionId?: string;
  reason?: string;
}

export interface DispatchPendingInputMessage {
  type: "dispatch-pending-input";
  inputId: string;
  sessionId?: string;
  targetRunId?: string;
}

export interface ListPendingInputsMessage {
  type: "list-pending-inputs";
  sessionId?: string;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  clientName?: string;
}

export interface PingMessage {
  type: "ping";
}

export interface GetStatusMessage {
  type: "get-status";
}

export interface ListCapabilitiesMessage {
  type: "list-capabilities";
}

export interface UpdateConfigMessage {
  type: "update-config";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: DaemonProviderCredentialMode;
  endpoint?: OpenAICompatibleEndpoint;
  stream?: boolean;
}

export interface ListSessionsMessage {
  type: "list-sessions";
  includeArchived?: boolean;
  includeDeleted?: boolean;
}

export interface ListRunsMessage {
  type: "list-runs";
  sessionId?: string;
}

export interface ReadSessionEventsMessage {
  type: "read-session-events";
  sessionId: string;
  afterSequence?: number;
  lastEventId?: string;
  maxEvents?: number;
  cursor?: DaemonEventReplayCursor;
}

export interface ReadRunEventsMessage {
  type: "read-run-events";
  runId: string;
  afterSequence?: number;
  lastEventId?: string;
  includeSnapshot?: boolean;
  maxEvents?: number;
  cursor?: DaemonEventReplayCursor;
}

export interface GetRunSnapshotMessage {
  type: "get-run-snapshot";
  runId: string;
}

export interface GetMetricsMessage {
  type: "get-metrics";
  runId?: string;
  sessionId?: string;
  includeRuns?: boolean;
}

export interface GetMetricsSnapshotMessage {
  type: "get-metrics-snapshot";
  runId?: string;
  sessionId?: string;
  includeRuns?: boolean;
}

export interface ListWorkflowsMessage {
  type: "list-workflows";
}

export interface CreateWorkflowMessage {
  type: "create-workflow";
  id?: string;
  name: string;
  prompt: string;
  cwd?: string;
  mode?: string;
  schedule: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface UpdateWorkflowMessage {
  type: "update-workflow";
  workflowId: string;
  name?: string;
  prompt?: string;
  cwd?: string;
  mode?: string;
  schedule?: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface DeleteWorkflowMessage {
  type: "delete-workflow";
  workflowId: string;
}

export interface TriggerWorkflowMessage {
  type: "trigger-workflow";
  workflowId: string;
  runId?: string;
  sessionId?: string;
}

export interface ListWorkflowRunsMessage {
  type: "list-workflow-runs";
  workflowId?: string;
}

export interface GitStatusMessage {
  type: "git-status";
  cwd?: string;
}

export interface GitDiffMessage {
  type: "git-diff";
  cwd?: string;
  path?: string;
  staged?: boolean;
}

export interface ListPlanDocumentsMessage {
  type: "list-plan-documents";
}

export interface CreatePlanDocumentMessage extends CreatePlanDocumentInput {
  type: "create-plan-document";
}

export interface CreateRequirementsAlignmentPlanMessage {
  type: "create-requirements-alignment-plan";
  id?: string;
  title?: string;
  goal: string;
  context?: string;
  questions?: string[];
  assumptions?: string[];
  acceptance?: string[];
  risks?: string[];
  source?: "user" | "assistant" | "slash-command" | "workflow" | "system";
  metadata?: JsonObject;
}

export interface GetPlanDocumentMessage {
  type: "get-plan-document";
  documentId: string;
}

export interface PatchPlanDocumentMessage {
  type: "patch-plan-document";
  documentId: string;
  patch: PlanDocumentPatch;
}

export interface DeletePlanDocumentMessage {
  type: "delete-plan-document";
  documentId: string;
}

export interface ListMutationLeasesMessage {
  type: "list-mutation-leases";
  cwd?: string;
}

export interface ListBackgroundTasksMessage {
  type: "list-background-tasks";
  includeHistory?: boolean;
  state?: DaemonBackgroundTaskSnapshot["state"];
  limit?: number;
}

export interface StartBackgroundTaskMessage {
  type: "start-background-task";
  command: string;
  cwd?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
}

export interface CancelBackgroundTaskMessage {
  type: "cancel-background-task";
  taskId: string;
}

export interface GetBackgroundTaskHistoryMessage {
  type: "get-background-task-history";
  state?: DaemonBackgroundTaskSnapshot["state"];
  limit?: number;
}

export interface ListArtifactsMessage {
  type: "list-artifacts";
  sessionId?: string;
}

export interface GetArtifactContentMessage {
  type: "get-artifact-content";
  artifactUri: string;
}

export interface ListMemoriesMessage {
  type: "list-memories";
  scope?: string;
}

export interface DeleteMemoryMessage {
  type: "delete-memory";
  memoryId: string;
}

export interface ListCheckpointsMessage {
  type: "list-checkpoints";
  runId?: string;
  sessionId?: string;
}

export interface RestoreCheckpointMessage {
  type: "restore-checkpoint";
  checkpointId: string;
}

export interface GetCheckpointDiffMessage {
  type: "get-checkpoint-diff";
  checkpointId: string;
}

export interface ResolveConversationRewindBoundaryMessage {
  type: "resolve-conversation-rewind-boundary";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
}

export interface PreviewConversationRewindMessage {
  type: "preview-conversation-rewind";
  sessionId: string;
  targetLeafId: string | null;
  entries: SessionTreeEntry[];
  checkpoint?: ConversationRewindCheckpointTarget;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface PreviewConversationRewindByBoundaryMessage {
  type: "preview-conversation-rewind-by-boundary";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface ApplyConversationRewindMessage {
  type: "apply-conversation-rewind";
  sessionId: string;
  targetLeafId?: string | null;
  entries?: SessionTreeEntry[];
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
  checkpoint?: ConversationRewindCheckpointTarget;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface ApplySessionActionMessage {
  type: "apply-session-action";
  action: SessionAction;
}

export interface SendToSubagentMessage {
  type: "send-to-subagent";
  subagentRunId: string;
  message: string;
}

export interface GetSubagentStatusMessage {
  type: "get-subagent-status";
  subagentRunId: string;
}

export interface StartMcpServerMessage {
  type: "start-mcp-server";
  serverId: string;
}

export interface StopMcpServerMessage {
  type: "stop-mcp-server";
  serverId: string;
}

export interface ListMcpServersMessage {
  type: "list-mcp-servers";
}

export interface GetScopedContextMessage {
  type: "get-scoped-context";
  scope?: ScopedContextScope;
  kind?: ScopedContextKind;
}

export interface UpsertScopedContextMessage {
  type: "upsert-scoped-context";
  record: ScopedContextRecord;
}

export interface DeleteScopedContextMessage {
  type: "delete-scoped-context";
  recordId: string;
}

export interface ResolveScopedContextMessage extends ScopedContextResolverProject {
  type: "resolve-scoped-context";
  userEnabledIds?: string[];
  userDisabledIds?: string[];
  scopedContextConfig?: ScopedContextRuntimeConfig;
}

// ---- 出站消息 ----

/** Protocol version for the daemon-ready handshake. Increment when breaking changes are made. */
export const DAEMON_HANDSHAKE_PROTOCOL_VERSION = 1;

export interface DaemonReadyMessage {
  type: "daemon-ready";
  port: number;
  /** Handshake protocol version — must match the version the Tauri client expects. */
  protocolVersion: number;
  /** Build hash identifying the exact daemon build. Empty string when unavailable. */
  buildHash: string;
  /** PID of the daemon process. */
  pid?: number;
}

export interface EventMessage {
  type: "event";
  runId: string;
  event: AgentEvent;
}

export interface ApprovalRequestedMessage {
  type: "approval-requested";
  runId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  risk?: string;
  riskReason?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  metadata?: JsonObject;
}

export type ApprovalProtocolDecision = "approved" | "denied" | "expired";
export type ApprovalProtocolStatus = "pending" | ApprovalProtocolDecision;

export interface ApprovalResolvedMessage {
  type: "approval-resolved";
  toolCallId: string;
  decision: ApprovalProtocolDecision;
  reason?: string;
  expiredAt?: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
  runId?: string;
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  serverName: string;
  capabilities: string[];
}

export interface PongMessage {
  type: "pong";
}

export interface StatusResponseMessage {
  type: "status-response";
  lifecycle: DaemonLifecycleSnapshot;
  activeRuns: Array<{
    runId: string;
    prompt: string;
    status: string;
    startedAt: number;
    cwd: string;
  }>;
  pendingApprovals: ApprovalStatusSnapshot[];
  recentApprovals: ApprovalStatusSnapshot[];
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
  capabilities: DaemonCapabilitySnapshot;
}

export type DaemonCapabilityState =
  | "implemented"
  | "experimental"
  | "unsupported"
  | "degraded"
  | "backend-not-wired";

export type DaemonCapabilityOwner =
  | "agent-daemon"
  | "agent-runtime"
  | "agent-orchestrator"
  | "workbench"
  | "tauri";

export interface DaemonCapabilityDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  updatedAt: string;
  detail?: string;
  metadata?: JsonObject;
}

export interface DaemonCapabilityRecord {
  id: string;
  title: string;
  state: DaemonCapabilityState;
  reason: string;
  owner: DaemonCapabilityOwner;
  relatedMessageTypes: string[];
  relatedTauriCommands: string[];
  updatedAt: string;
  diagnostics: DaemonCapabilityDiagnostic[];
}

export interface DaemonCapabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  capabilities: DaemonCapabilityRecord[];
}

export interface CapabilitiesResponseMessage {
  type: "capabilities-response";
  snapshot: DaemonCapabilitySnapshot;
}

export interface ApprovalStatusSnapshot {
  toolCallId: string;
  runId: string;
  toolName: string;
  summary: string;
  createdAt: number;
  status: ApprovalProtocolStatus;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  resolvedAt?: number;
  expiredAt?: number;
  reason?: string;
  expiredReason?: string;
  risk?: string;
  riskReason?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  metadata?: JsonObject;
}

export type ApprovalHistorySource = "event-log" | "live-queue";

export interface ApprovalHistoryFilters {
  sessionId?: string;
  runId?: string;
  toolName?: string;
  status?: ApprovalProtocolStatus;
  risk?: string;
}

export interface ApprovalHistoryEntry {
  toolCallId: string;
  runId: string;
  sessionId?: string;
  toolName: string;
  summary: string;
  input: JsonObject;
  createdAt: number;
  status: ApprovalProtocolStatus;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  resolvedAt?: number;
  expiredAt?: number;
  reason?: string;
  expiredReason?: string;
  risk?: string;
  riskReason?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  metadata?: JsonObject;
  requestSequence?: number;
  resolvedSequence?: number;
  source: ApprovalHistorySource;
  live?: boolean;
  updatedAt: number;
}

export interface ApprovalHistoryDiagnostics {
  queryMs: number;
  eventCount: number;
  projectedCount: number;
  liveOverlayCount: number;
  filteredOutCount: number;
  limit: number;
  truncated: boolean;
}

export interface ApprovalHistoryListedMessage {
  type: "approval-history-listed";
  approvals: ApprovalHistoryEntry[];
  eventLog: OrchestratorEventLogMetadata;
  filters: ApprovalHistoryFilters;
  total: number;
  returned: number;
  truncated: boolean;
  diagnostics: ApprovalHistoryDiagnostics;
}

export type DaemonLifecycleState = "starting" | "ready" | "stopping" | "stopped" | "degraded";

export type DaemonLifecycleDiagnosticSource =
  | "daemon"
  | "websocket"
  | "client"
  | "event-store"
  | "provider"
  | "mcp";

export type DaemonLifecycleDiagnosticSeverity = "warning" | "error";

export interface DaemonLifecycleDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  source: DaemonLifecycleDiagnosticSource;
  severity: DaemonLifecycleDiagnosticSeverity;
  detail?: string;
  metadata?: JsonObject;
}

export interface DaemonClientDisconnectSnapshot {
  clientId: string;
  code: number;
  reason: string;
  connectedAt: string;
  disconnectedAt: string;
  durationMs: number;
}

export interface DaemonEventStoreStatusSnapshot {
  status: "ok" | "failed";
  path: string;
  failure?: DaemonLifecycleDiagnostic;
}

export interface DaemonLifecycleSnapshot {
  state: DaemonLifecycleState;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  stoppingAt?: string;
  stoppedAt?: string;
  uptimeMs: number;
  currentPort: number | null;
  connectedClientCount: number;
  totalClientConnectionCount: number;
  totalClientDisconnectCount: number;
  activeRunCount: number;
  recentDisconnect?: DaemonClientDisconnectSnapshot;
  recentError?: DaemonLifecycleDiagnostic;
  eventStore: DaemonEventStoreStatusSnapshot;
  providerReadiness: DaemonProviderReadiness;
  mcpReadiness: DaemonMcpReadiness;
}

export type DaemonProviderCredentialMode = "direct" | "account-center" | "auto";

export type DaemonProviderReadiness =
  | "ready"
  | "missing"
  | "login-required"
  | "insufficient-quota"
  | "gateway-unavailable"
  | "credential-unavailable"
  | "invalid-response"
  | "unknown";

export type DaemonSystemPromptWireMode = "native-system-role" | "user-prefix";

export type DaemonProviderApiKeySource =
  | "default"
  | "env"
  | "runtime-update"
  | "user-config"
  | "workspace-config"
  | "unset"
  | "unknown";

export interface DaemonProviderRedactedApiKeyStatus {
  hasApiKey: boolean;
  source: DaemonProviderApiKeySource;
  last4?: string;
}

export type DaemonAccountLoginStatus = "ready" | "required" | "unknown";
export type DaemonAccountQuotaStatus = "ready" | "insufficient" | "unknown";
export type DaemonAccountGatewayStatus = "ready" | "unavailable" | "unknown";
export type DaemonAccountRuntimeCredentialStatus = "ready" | "unavailable" | "unknown";

export interface DaemonProviderDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  kind?: string;
  status?: number;
  detail?: string;
  metadata?: JsonObject;
}

export interface DaemonAccountCenterStatusSnapshot {
  configured: boolean;
  accountId?: string;
  login: DaemonAccountLoginStatus;
  quota: DaemonAccountQuotaStatus;
  gateway: DaemonAccountGatewayStatus;
  runtimeCredential: DaemonAccountRuntimeCredentialStatus;
  lastCheckedAt?: string;
  lastDiagnostic?: DaemonProviderDiagnostic;
}

export interface DaemonProviderGatewayStatusSnapshot {
  ready: boolean;
  credentialConfigured: boolean;
  routeDecision: string[];
  code?: string;
  selectedRouteId?: string;
  selectedProviderId?: string;
  selectedEndpointSupport?: "responses" | "chat-completions" | "auto";
  selectedStreamingSupport?: "streaming" | "non-streaming" | "optional" | "unknown";
  selectedCredentialSource?: JsonObject;
  lastSuccess?: JsonObject;
  lastFailure?: JsonObject;
  updatedAt?: string;
}

export interface DaemonProviderStatusSnapshot {
  credentialMode: DaemonProviderCredentialMode;
  readiness: DaemonProviderReadiness;
  providerId: string;
  routeId: string;
  baseUrl: string;
  model: string;
  upstreamModel: string;
  endpoint: OpenAICompatibleEndpoint;
  stream: boolean;
  systemPromptWireMode: DaemonSystemPromptWireMode;
  apiKey: DaemonProviderRedactedApiKeyStatus;
  hasDirectApiKey: boolean;
  apiKeySource: DaemonProviderApiKeySource;
  accountCenter: DaemonAccountCenterStatusSnapshot;
  gateway: DaemonProviderGatewayStatusSnapshot;
  lastDiagnostic?: DaemonProviderDiagnostic;
  updatedAt: string;
}

export type DaemonMcpReadiness = "ready" | "degraded" | "starting" | "stopped" | "unknown";

export interface DaemonMcpStatusSnapshot {
  configured: boolean;
  readiness: DaemonMcpReadiness;
  serverCount: number;
  summary: JsonObject;
  diagnostics: JsonObject[];
  servers: JsonObject[];
  updatedAt: string;
}

export interface ConfigUpdatedMessage {
  type: "config-updated";
  updatedFields: string[];
}

export interface SubagentStartedMessage {
  type: "subagent-started";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  description: string;
  mode: string;
}

export interface SubagentEndedMessage {
  type: "subagent-ended";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  status: "completed" | "failed";
  summary: string;
}

export interface SubagentEventMessage {
  type: "subagent-event";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  event: AgentEvent;
}

export interface SessionsListedMessage {
  type: "sessions-listed";
  sessions: OrchestratorSessionRecord[];
  summaries?: DaemonSessionSummary[];
  eventLog?: OrchestratorEventLogMetadata;
  diagnostics?: DaemonSessionListDiagnostics;
}

export interface RunsListedMessage {
  type: "runs-listed";
  runs: OrchestratorRunRecord[];
  sessionId?: string;
}

export interface SessionEventsMessage {
  type: "session-events";
  sessionId: string;
  events: OrchestratorEvent[];
  eventLog: OrchestratorEventLogMetadata;
  cursorDiagnostic?: DaemonEventCursorDiagnostic;
  diagnostics?: DaemonEventReadDiagnostics;
  nextAfterSequence: number;
  hasMore?: boolean;
  nextCursor?: DaemonEventReplayCursor;
  afterSequence?: number;
  lastEventId?: string;
}

export interface RunEventsMessage {
  type: "run-events";
  runId: string;
  events: OrchestratorEvent[];
  eventLog: OrchestratorEventLogMetadata;
  cursorDiagnostic?: DaemonEventCursorDiagnostic;
  diagnostics?: DaemonEventReadDiagnostics;
  nextAfterSequence: number;
  hasMore?: boolean;
  nextCursor?: DaemonEventReplayCursor;
  afterSequence?: number;
  lastEventId?: string;
  snapshot?: DaemonTaskSnapshot;
}

export interface DaemonSessionSummary {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runCount: number;
  activeRunCount?: number;
  activeRunIds?: string[];
  latestRunId?: string;
  latestRunStatus?: RunStatus;
  latestRunUpdatedAt?: string;
  pendingInputCount?: number;
  pendingApprovalCount?: number;
  lastEventId?: string;
  lastSequence?: number;
  lastMessagePreview?: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  metadataUpdatedAt?: string;
}

export type DaemonPendingInputRecord = PendingInputRecord;

export interface PendingInputQueuedMessage {
  type: "pending-input-queued";
  input: DaemonPendingInputRecord;
  event: OrchestratorEvent;
}

export interface PendingInputCancelledMessage {
  type: "pending-input-cancelled";
  input: DaemonPendingInputRecord;
  event: OrchestratorEvent;
}

export interface PendingInputDispatchedMessage {
  type: "pending-input-dispatched";
  input: DaemonPendingInputRecord;
  event: OrchestratorEvent;
}

export interface PendingInputsListedMessage {
  type: "pending-inputs-listed";
  inputs: DaemonPendingInputRecord[];
  sessionId?: string;
}

export interface DaemonSessionListDiagnostics {
  queryMs: number;
  sessionCount: number;
  summaryCount: number;
  metadataCount: number;
  filteredOutCount: number;
  summarySource: "event-store" | "unavailable";
}

export interface RunSnapshotMessage {
  type: "run-snapshot";
  runId: string;
  snapshot: DaemonTaskSnapshot;
}

export interface DaemonEventReplayCursor {
  eventLogId: string;
  generation: number;
  schemaVersion: number;
  protocolVersion: number;
  afterSequence: number;
  lastEventId?: string;
}

export interface DaemonEventCursorDiagnostic {
  code: "EVENT_LOG_CURSOR_MISMATCH";
  message: string;
  severity: "warning";
  previous?: DaemonEventReplayCursor;
  current: OrchestratorEventLogMetadata;
  replayedFromSequence: number;
}

export type DaemonEventReadMode = "incremental" | "full-replay" | "cursor-replay";

export interface DaemonEventReadDiagnostics {
  mode: DaemonEventReadMode;
  requestedAfterSequence: number;
  storeReadAfterSequence: number;
  projectedAfterSequence: number;
  eventsFetched: number;
  eventsReturned?: number;
  truncated?: boolean;
  maxEvents?: number;
  queryMs: number;
}

export type DaemonMetricsStoreStatus = "ok" | "degraded";

export interface DaemonMetricsDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  path?: string;
  detail?: string;
}

export interface DaemonMetricsRunRecord {
  runId: string;
  sessionId: string;
  updatedAt: string;
  snapshot: RuntimeMetricsSnapshot;
}

export interface DaemonMetricsSummary {
  scope: "global" | "session" | "run";
  runCount: number;
  sessionCount: number;
  snapshot: RuntimeMetricsSnapshot;
}

export interface DaemonMetricsSource {
  kind: "jsonl";
  path: string;
  generation: number;
  status: DaemonMetricsStoreStatus;
  badLineCount: number;
}

export interface DaemonMetricsQueryResult {
  status: DaemonMetricsStoreStatus;
  query: {
    runId?: string;
    sessionId?: string;
    includeRuns: boolean;
  };
  source: DaemonMetricsSource;
  summary: DaemonMetricsSummary;
  runs?: DaemonMetricsRunRecord[];
  diagnostic?: DaemonMetricsDiagnostic;
}

export interface MetricsResponseMessage extends DaemonMetricsQueryResult {
  type: "metrics-response";
}

export interface WorkflowsListedMessage {
  type: "workflows-listed";
  workflows: WorkflowDefinition[];
}

export interface WorkflowCreatedMessage {
  type: "workflow-created";
  workflow: WorkflowDefinition;
}

export interface WorkflowUpdatedMessage {
  type: "workflow-updated";
  workflow: WorkflowDefinition;
}

export interface WorkflowDeletedMessage {
  type: "workflow-deleted";
  workflowId: string;
}

export interface WorkflowTriggeredMessage {
  type: "workflow-triggered";
  accepted: true;
  runId: string;
  workflowRunId: string;
  run: WorkflowRunEntry;
}

export interface WorkflowRunUpdatedMessage {
  type: "workflow-run-updated";
  runId: string;
  workflowRunId: string;
  workflowId: string;
  run: WorkflowRunEntry;
}

export interface WorkflowRunsListedMessage {
  type: "workflow-runs-listed";
  runs: WorkflowRunEntry[];
  workflowId?: string;
}

export interface DaemonGitStatusFile {
  path: string;
  status: "A" | "M" | "D" | "U" | "R" | "C" | "?" | "!" | "mixed";
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  originalPath?: string;
}

export interface GitStatusResponseMessage {
  type: "git-status-response";
  cwd: string;
  found: boolean;
  repositoryRoot?: string;
  gitDir?: string;
  head?: string | null;
  branch?: string | null;
  clean?: boolean;
  files: DaemonGitStatusFile[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  reason?: string;
}

export interface GitDiffResponseMessage {
  type: "git-diff-response";
  cwd: string;
  repositoryRoot?: string;
  path?: string;
  staged: boolean;
  unified: string;
  stat: string;
  files: ChangedFileRecord[];
}

export interface PlanDocumentsListedMessage {
  type: "plan-documents-listed";
  documents: PlanDocumentSummary[];
}

export interface PlanDocumentCreatedMessage {
  type: "plan-document-created";
  document: PlanDocument;
}

export interface PlanDocumentMessage {
  type: "plan-document";
  document: PlanDocument;
}

export interface PlanDocumentPatchedMessage {
  type: "plan-document-patched";
  document: PlanDocument;
}

export interface PlanDocumentDeletedMessage {
  type: "plan-document-deleted";
  documentId: string;
}

export interface MutationLeaseSnapshot {
  token: string;
  scope: { type: "workspace" } | { type: "files"; paths: string[] };
  owner?: {
    runId?: string;
    sessionId?: string;
    toolCallId?: string;
    toolName?: string;
    cwd?: string;
    targetSummary?: string;
  };
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface MutationLeasesListedMessage {
  type: "mutation-leases-listed";
  leases: MutationLeaseSnapshot[];
}

export interface DaemonBackgroundTaskDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  updatedAt: string;
  detail?: string;
  metadata?: JsonObject;
}

export interface BackgroundTasksListedMessage {
  type: "background-tasks-listed";
  tasks: DaemonBackgroundTaskSnapshot[];
  diagnostics: DaemonBackgroundTaskDiagnostic[];
}

export interface BackgroundTaskStartedMessage {
  type: "background-task-started";
  task: DaemonBackgroundTaskSnapshot;
  diagnostics: DaemonBackgroundTaskDiagnostic[];
}

export interface BackgroundTaskCancelledMessage {
  type: "background-task-cancelled";
  task: DaemonBackgroundTaskSnapshot;
  diagnostics: DaemonBackgroundTaskDiagnostic[];
}

export interface BackgroundTaskHistoryMessage {
  type: "background-task-history";
  tasks: DaemonBackgroundTaskSnapshot[];
  diagnostics: DaemonBackgroundTaskDiagnostic[];
}

export interface ArtifactRecord {
  uri: string;
  type: string;
  name: string;
  size?: number;
  createdAt?: string;
  sessionId?: string;
  runId?: string;
}

export interface ArtifactsListedMessage {
  type: "artifacts-listed";
  artifacts: ArtifactRecord[];
}

export interface ArtifactContentMessage {
  type: "artifact-content";
  artifactUri: string;
  content: string;
  mimeType?: string;
}

export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  scope: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MemoriesListedMessage {
  type: "memories-listed";
  memories: MemoryRecord[];
}

export interface MemoryDeletedMessage {
  type: "memory-deleted";
  memoryId: string;
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  sessionId: string;
  label?: string;
  createdAt: string;
  messageCount?: number;
}

export interface CheckpointsListedMessage {
  type: "checkpoints-listed";
  checkpoints: CheckpointRecord[];
}

export interface ChangedFileRecord {
  path: string;
  status: string;
  addedLines?: number;
  removedLines?: number;
}

export interface CheckpointDiffMessage {
  type: "checkpoint-diff";
  checkpointId: string;
  files: ChangedFileRecord[];
}

export interface CheckpointRestoredMessage {
  type: "checkpoint-restored";
  checkpointId: string;
  runId: string;
}

export interface ConversationRewindActiveSubagentRecord {
  parentRunId: string;
  subagentRunId: string;
  subagentId?: string;
}

export type ConversationRewindBoundaryMissingFact =
  | ConversationRewindTargetFacts["missingFacts"][number]
  | "boundary-record"
  | "checkpoint-manifest-record"
  | "session-record"
  | "session-tree-entries";

export interface ConversationRewindBoundaryDiagnostic {
  code: string;
  fact: ConversationRewindBoundaryMissingFact;
  message: string;
  blocked: boolean;
  metadata?: JsonObject;
}

export interface ConversationRewindBoundaryMessage {
  type: "conversation-rewind-boundary";
  status: "ok" | "blocked";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage: boolean;
  mode: ConversationRewindBoundaryTargetMode;
  boundary?: ConversationBoundaryManifestRecord;
  checkpoint?: CheckpointManifestRecord;
  target?: ConversationRewindTargetFacts;
  missingFacts: ConversationRewindBoundaryMissingFact[];
  diagnostics: ConversationRewindBoundaryDiagnostic[];
  plan?: ConversationRewindPlanSnapshot;
  runtimeTargetLeafId?: string;
}

export type ConversationRewindPlanSnapshot = ConversationRewindPlan;

export type ConversationRewindApplyStepStatus = "applied" | "deferred" | "unsupported" | "skipped" | "failed";

export interface ConversationRewindApplyStepResult {
  type: ConversationRewindPlanSnapshot["steps"][number]["type"];
  status: ConversationRewindApplyStepStatus;
  code?: string;
  message?: string;
  affectedIds?: string[];
  metadata?: JsonObject;
}

export interface ConversationRewindPreviewMessage {
  type: "conversation-rewind-preview";
  sessionId: string;
  plan: ConversationRewindPlanSnapshot;
}

export interface ConversationRewindAppliedMessage {
  type: "conversation-rewind-applied";
  sessionId: string;
  plan: ConversationRewindPlanSnapshot;
  stepResults: ConversationRewindApplyStepResult[];
}

export interface SessionActionReceiptMessage extends SessionActionReceipt {
  type: "session-action-receipt";
}

export interface SubagentMessageSentMessage {
  type: "subagent-message-sent";
  subagentRunId: string;
  accepted: boolean;
}

export interface SubagentStatusMessage {
  type: "subagent-status";
  subagentRunId: string;
  status: string;
  progress?: string;
  latestError?: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  state: string;
  transport?: string;
  cachedToolCount?: number;
  lastError?: string;
  startedAt?: string;
}

export interface McpServersListedMessage {
  type: "mcp-servers-listed";
  servers: McpServerRecord[];
}

export interface McpServerStartedMessage {
  type: "mcp-server-started";
  serverId: string;
  state: string;
}

export interface McpServerStoppedMessage {
  type: "mcp-server-stopped";
  serverId: string;
  state: string;
}

export type DaemonScopedContextStoreStatus = "ok" | "degraded";

export interface DaemonScopedContextDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  path?: string;
  detail?: string;
}

export interface DaemonScopedContextResourceDiagnostic {
  severity: "warning";
  path: string;
  message: string;
}

export interface ScopedContextRuntimeConfig {
  userEnabledIds?: string[];
  userDisabledIds?: string[];
  includeRecommendationHints?: boolean;
  includeAncestorContextFiles?: boolean;
  includeProjectSkillDirs?: boolean;
  includeWorkspaceSkillDirs?: boolean;
  includeGlobalSkillDirs?: boolean;
  globalSkillDirs?: string[];
  workspaceSkillDirs?: string[];
  projectSkillDirs?: string[];
  globalRuleFiles?: string[];
  workspaceRuleFiles?: string[];
  projectRuleFiles?: string[];
  globalRuleDirs?: string[];
  workspaceRuleDirs?: string[];
  projectRuleDirs?: string[];
}

export interface ScopedContextRecord {
  id: string;
  kind: ScopedContextKind;
  title: string;
  content: string;
  description?: string;
  scope: ScopedContextScope;
  activation: ScopedContextActivation;
  appliesTo: string[];
  tags: string[];
  source?: ScopedContextSource;
  sourceMetadata?: JsonObject;
  order: number;
  updatedAt: string;
}

export interface ScopedContextQueryResult {
  status: DaemonScopedContextStoreStatus;
  records: ScopedContextRecord[];
  diagnostic?: DaemonScopedContextDiagnostic;
}

export interface ScopedContextResponseMessage extends ScopedContextQueryResult {
  type: "scoped-context-response";
}

export interface ScopedContextUpsertedMessage {
  type: "scoped-context-upserted";
  status: DaemonScopedContextStoreStatus;
  record: ScopedContextRecord;
  persisted: boolean;
  diagnostic?: DaemonScopedContextDiagnostic;
}

export interface ScopedContextDeletedMessage {
  type: "scoped-context-deleted";
  status: DaemonScopedContextStoreStatus;
  recordId: string;
  deleted: boolean;
  diagnostic?: DaemonScopedContextDiagnostic;
}

export interface ScopedContextResolvedMessage {
  type: "scoped-context-resolved";
  status: DaemonScopedContextStoreStatus;
  stableContext: PromptAssemblyContextBlock[];
  recommended: ScopedContextCandidate[];
  items: ScopedContextResolvedItem[];
  diagnostics: ScopedContextDiagnostic[];
  stableContextHash: string;
  storeRecordCount: number;
  resourceRecordCount: number;
  resourceDiagnostics: DaemonScopedContextResourceDiagnostic[];
  storeDiagnostic?: DaemonScopedContextDiagnostic;
}

export type WorkflowSchedule =
  | { type: "manual" }
  | { type: "daily"; time: string; timezone: string }
  | { type: "intervalMinutes"; intervalMinutes: number };

export interface WorkflowDefinition {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  mode: string;
  schedule: WorkflowSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export type WorkflowRunStatus = "running" | "awaiting-approval" | "completed" | "failed" | "cancelled";

export interface WorkflowRunEntry {
  workflowId: string;
  runId: string;
  sessionId: string;
  scheduledFor: string;
  startedAt: string;
  status: WorkflowRunStatus;
  error?: string;
}

export type DaemonTaskSnapshotStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type DaemonTaskMessageRole = "system" | "user" | "assistant";

export interface DaemonTaskMessageSnapshot {
  id: string;
  role: DaemonTaskMessageRole;
  content: string;
  createdAt: string;
  toolCalls?: DaemonTaskSnapshotToolCall[];
}

export interface DaemonTaskSnapshotToolCall {
  id: string;
  name: string;
  input: JsonObject;
  status: "pending" | "running" | "approval-required" | "completed" | "failed";
  summary?: string;
  startedAt: string;
  updatedAt: string;
  output?: string;
  approvalMetadata?: JsonObject;
}

export interface DaemonTaskSnapshotApproval {
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  summary: string;
  requestedAt: string;
  status: "pending";
  risk?: string;
  riskReason?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  metadata?: JsonObject;
}

export interface DaemonBackgroundTaskSnapshot {
  id: string;
  kind: "command";
  title: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
  command: string;
  cwd?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  timeoutMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputPreview?: string;
  diagnostics?: DaemonBackgroundTaskDiagnostic[];
}

export interface DaemonTaskSnapshotRunMetadata {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  metadata: JsonObject;
}

export interface DaemonTaskSnapshot {
  runId: string;
  sessionId: string;
  status: DaemonTaskSnapshotStatus;
  title: string;
  messages: DaemonTaskMessageSnapshot[];
  latestError?: string;
  approval?: DaemonTaskSnapshotApproval;
  pendingToolCalls: DaemonTaskSnapshotToolCall[];
  backgroundTasks: DaemonBackgroundTaskSnapshot[];
  progress: DaemonTaskSnapshotProgress;
  usage: DaemonTaskSnapshotUsage;
  cache: DaemonTaskSnapshotCache;
  updatedAt: string;
  progressLabel: string;
  currentRun: DaemonTaskSnapshotRunMetadata;
}

export interface DaemonTaskSnapshotProgress {
  label: string;
  eventCount: number;
  turnCount: number;
  textDeltaCount: number;
  toolCallCount: number;
  completedToolCallCount: number;
  pendingToolCallCount: number;
  approvalPending: boolean;
  updatedAt: string;
}

export interface DaemonTaskSnapshotUsage {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface DaemonTaskSnapshotCache {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
  stablePrefixHash?: string;
  cacheKey?: string;
  cacheStrategy?: string;
}

// ==================== 内部运行时状态 ====================

/** Daemon 全局配置 */
export interface DaemonConfig {
  /** WebSocket 监听端口，0 表示动态分配 */
  port: number;
  /** 最大并发任务数 */
  maxConcurrentRuns: number;
  /** 运行时实例空闲保留时间 (ms) */
  runtimeIdleTimeoutMs: number;
  /** 审批超时时间 (ms)，默认会过期；只有显式配置 0 才无限等待 */
  approvalTimeoutMs: number;
  /** 默认工作目录 */
  defaultCwd: string;
  noProjectCwd: string;
  /** Session/run event log directory */
  sessionEventLogDir: string;
  /** Workflow definition and run history JSON file */
  workflowStorePath: string;
  /** Daemon-owned editable plan documents JSON file */
  planDocumentStorePath: string;
  /** Daemon-owned metrics JSON file */
  metricsStorePath: string;
  /** Daemon-owned scoped rules and skills JSON file */
  scopedContextStorePath: string;
  /** Daemon-owned memory JSON file */
  memoryStorePath: string;
  /** Workflow scheduler polling interval. 0 disables the daemon-owned loop. */
  workflowSchedulerIntervalMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  port: 0, // 动态分配
  maxConcurrentRuns: 5,
  runtimeIdleTimeoutMs: 5 * 60 * 1000, // 5 分钟
  approvalTimeoutMs: 5 * 60 * 1000,
  defaultCwd: process.cwd(),
  noProjectCwd: join(defaultDaemonDataDir(), "no-project-workspace"),
  sessionEventLogDir: join(defaultDaemonDataDir(), "events"),
  workflowStorePath: join(defaultDaemonDataDir(), "workflows.json"),
  planDocumentStorePath: join(defaultDaemonDataDir(), "plan-documents.json"),
  metricsStorePath: join(defaultDaemonDataDir(), "metrics.json"),
  scopedContextStorePath: join(defaultDaemonDataDir(), "scoped-context.json"),
  memoryStorePath: join(defaultDaemonDataDir(), "memories.jsonl"),
  workflowSchedulerIntervalMs: 30_000,
};

function defaultDaemonDataDir(): string {
  if (process.env.CRISH_DAEMON_HOME) {
    return process.env.CRISH_DAEMON_HOME;
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Crish", "agent-daemon");
  }

  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "crish", "agent-daemon");
  }

  return join(homedir(), ".crish", "agent-daemon");
}
