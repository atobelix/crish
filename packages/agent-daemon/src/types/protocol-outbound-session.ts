import type { SessionActionReceipt } from "@crish/shared-types";
import type {
  PlanDocument,
  PlanDocumentSummary,
  CheckpointManifestRecord,
  ConversationBoundaryManifestRecord,
  ConversationRewindBoundaryTargetMode,
  ConversationRewindTargetFacts,
  ScopedContextCandidate,
  ScopedContextDiagnostic,
  ScopedContextResolvedItem,
  PromptAssemblyContextBlock,
} from "@crish/agent-runtime";
import type { OrchestratorEvent, OrchestratorEventLogMetadata, OrchestratorRunRecord, OrchestratorSessionRecord } from "@crish/agent-orchestrator";
import type { DaemonTaskSnapshot, DaemonBackgroundTaskSnapshot, DaemonBackgroundTaskDiagnostic } from "./snapshot-types.js";
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
  DaemonSessionSummary,
  DaemonEventReplayCursor,
  DaemonEventCursorDiagnostic,
  DaemonEventReadDiagnostics,
  DaemonSessionListDiagnostics,
  DaemonPendingInputRecord,
  DaemonGitStatusFile,
  ChangedFileRecord,
  MutationLeaseSnapshot,
  ArtifactRecord,
  MemoryRecord,
  CheckpointRecord,
  McpServerRecord,
  ConversationRewindBoundaryDiagnostic,
  ConversationRewindBoundaryMissingFact,
  ConversationRewindPlanSnapshot,
  ConversationRewindApplyStepResult,
  ScopedContextQueryResult,
  ScopedContextRecord,
  DaemonScopedContextStoreStatus,
  DaemonScopedContextDiagnostic,
  DaemonScopedContextResourceDiagnostic,
} from "./entities.js";
import type { DaemonCorrelationFields } from "./protocol-inbound-auth.js";
import type { WelcomeMessage, DaemonReadyMessage, PongMessage } from "./protocol-outbound-auth.js";
import type { EventMessage, ApprovalRequestedMessage, ApprovalResolvedMessage, ErrorMessage, SubagentStartedMessage, SubagentEndedMessage, SubagentEventMessage } from "./protocol-outbound-run.js";
import type { StatusResponseMessage, CapabilitiesResponseMessage, ConfigUpdatedMessage, ProviderModelsProbedMessage, ProviderChatProbedMessage } from "./protocol-outbound-diagnostic.js";

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

export interface RunSnapshotMessage {
  type: "run-snapshot";
  runId: string;
  snapshot: DaemonTaskSnapshot;
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

export interface MutationLeasesListedMessage {
  type: "mutation-leases-listed";
  leases: MutationLeaseSnapshot[];
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

export interface MemoriesListedMessage {
  type: "memories-listed";
  memories: MemoryRecord[];
}

export interface MemoryDeletedMessage {
  type: "memory-deleted";
  memoryId: string;
}

export interface CheckpointsListedMessage {
  type: "checkpoints-listed";
  checkpoints: CheckpointRecord[];
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

export type DaemonOutboundMessage = (
  | WelcomeMessage
  | DaemonReadyMessage
  | EventMessage
  | ApprovalRequestedMessage
  | ApprovalResolvedMessage
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
  | ProviderModelsProbedMessage
  | ProviderChatProbedMessage
) & DaemonCorrelationFields;
