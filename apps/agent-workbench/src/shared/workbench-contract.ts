export type WorkbenchMode = "plan" | "execute" | "review" | "discuss";

export type WorkbenchJsonPrimitive = string | number | boolean | null;
export type WorkbenchJsonValue =
  | WorkbenchJsonPrimitive
  | WorkbenchJsonValue[]
  | { [key: string]: WorkbenchJsonValue };
export type WorkbenchJsonObject = { [key: string]: WorkbenchJsonValue };

export type WorkbenchPlanDocumentStatus =
  | "draft"
  | "aligning"
  | "ready"
  | "in_progress"
  | "blocked"
  | "completed"
  | "archived";
export type WorkbenchPlanStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type WorkbenchPlanQuestionStatus = "open" | "answered" | "resolved" | "deferred";
export type WorkbenchPlanAssumptionStatus = "proposed" | "confirmed" | "rejected" | "deferred";
export type WorkbenchPlanAcceptanceStatus = "pending" | "met" | "failed" | "waived";
export type WorkbenchPlanRiskSeverity = "low" | "medium" | "high";
export type WorkbenchPlanRiskStatus = "open" | "mitigated" | "accepted";
export type WorkbenchPlanDocumentSourceKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "slash-command"
  | "artifact"
  | "resource"
  | "inferred"
  | (string & {});

export interface WorkbenchPlanDocumentSource {
  kind: WorkbenchPlanDocumentSourceKind;
  id?: string;
  label?: string;
  uri?: string;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanAssumption {
  id: string;
  text: string;
  status: WorkbenchPlanAssumptionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanQuestion {
  id: string;
  question: string;
  status: WorkbenchPlanQuestionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: WorkbenchPlanStepStatus;
  dependencies: string[];
  evidenceIds: string[];
  toolHints: string[];
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanAcceptanceCriterion {
  id: string;
  text: string;
  status: WorkbenchPlanAcceptanceStatus;
  evidenceIds: string[];
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanRisk {
  id: string;
  title: string;
  detail?: string;
  severity: WorkbenchPlanRiskSeverity;
  status: WorkbenchPlanRiskStatus;
  mitigation?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanAssumptionInput {
  id?: string;
  text: string;
  status?: WorkbenchPlanAssumptionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanQuestionInput {
  id?: string;
  question: string;
  status?: WorkbenchPlanQuestionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanStepInput {
  id?: string;
  title: string;
  detail?: string;
  status?: WorkbenchPlanStepStatus;
  dependencies?: string[];
  evidenceIds?: string[];
  toolHints?: string[];
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanAcceptanceCriterionInput {
  id?: string;
  text: string;
  status?: WorkbenchPlanAcceptanceStatus;
  evidenceIds?: string[];
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchPlanRiskInput {
  id?: string;
  title: string;
  detail?: string;
  severity?: WorkbenchPlanRiskSeverity;
  status?: WorkbenchPlanRiskStatus;
  mitigation?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchCreatePlanDocumentRequest {
  id?: string;
  title: string;
  goal: string;
  assumptions?: WorkbenchPlanAssumptionInput[];
  questions?: WorkbenchPlanQuestionInput[];
  steps?: WorkbenchPlanStepInput[];
  acceptance?: WorkbenchPlanAcceptanceCriterionInput[];
  risks?: WorkbenchPlanRiskInput[];
  status?: WorkbenchPlanDocumentStatus;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchCreateRequirementsAlignmentPlanRequest {
  id?: string;
  title?: string;
  goal: string;
  context?: string;
  questions?: string[];
  assumptions?: string[];
  acceptance?: string[];
  risks?: string[];
  source?: "user" | "assistant" | "slash-command" | "workflow" | "system";
  metadata?: WorkbenchJsonObject;
}

export type WorkbenchPlanStepUpdate = Partial<Omit<WorkbenchPlanStepInput, "id">>;
export type WorkbenchPlanQuestionUpdate = Partial<Omit<WorkbenchPlanQuestionInput, "id">>;
export type WorkbenchPlanAssumptionUpdate = Partial<Omit<WorkbenchPlanAssumptionInput, "id">>;
export type WorkbenchPlanAcceptanceCriterionUpdate = Partial<Omit<WorkbenchPlanAcceptanceCriterionInput, "id">>;
export type WorkbenchPlanRiskUpdate = Partial<Omit<WorkbenchPlanRiskInput, "id">>;

export type WorkbenchPlanDocumentPatchOperation =
  | { op: "set-title"; title: string }
  | { op: "set-goal"; goal: string }
  | { op: "set-status"; status: WorkbenchPlanDocumentStatus }
  | { op: "set-metadata"; metadata: WorkbenchJsonObject }
  | { op: "merge-metadata"; metadata: WorkbenchJsonObject }
  | { op: "add-step"; step: WorkbenchPlanStepInput; index?: number }
  | { op: "update-step"; id: string; update: WorkbenchPlanStepUpdate }
  | { op: "remove-step"; id: string }
  | { op: "add-question"; question: WorkbenchPlanQuestionInput; index?: number }
  | { op: "update-question"; id: string; update: WorkbenchPlanQuestionUpdate }
  | { op: "remove-question"; id: string }
  | { op: "add-assumption"; assumption: WorkbenchPlanAssumptionInput; index?: number }
  | { op: "update-assumption"; id: string; update: WorkbenchPlanAssumptionUpdate }
  | { op: "remove-assumption"; id: string }
  | { op: "add-acceptance"; acceptance: WorkbenchPlanAcceptanceCriterionInput; index?: number }
  | { op: "update-acceptance"; id: string; update: WorkbenchPlanAcceptanceCriterionUpdate }
  | { op: "remove-acceptance"; id: string }
  | { op: "add-risk"; risk: WorkbenchPlanRiskInput; index?: number }
  | { op: "update-risk"; id: string; update: WorkbenchPlanRiskUpdate }
  | { op: "remove-risk"; id: string };

export interface WorkbenchPlanDocumentPatch {
  expectedVersion?: number;
  operations: WorkbenchPlanDocumentPatchOperation[];
}

export interface WorkbenchPlanItemSummary {
  id: string;
  title: string;
  status: string;
}

export interface WorkbenchPlanDocumentSummary {
  id: string;
  title: string;
  goal: string;
  status: WorkbenchPlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  steps: {
    total: number;
    byStatus: Record<WorkbenchPlanStepStatus, number>;
    next: WorkbenchPlanItemSummary[];
    blocked: WorkbenchPlanItemSummary[];
  };
  questions: {
    total: number;
    byStatus: Record<WorkbenchPlanQuestionStatus, number>;
    open: WorkbenchPlanItemSummary[];
  };
  assumptions: {
    total: number;
    byStatus: Record<WorkbenchPlanAssumptionStatus, number>;
    unresolved: WorkbenchPlanItemSummary[];
  };
  acceptance: {
    total: number;
    byStatus: Record<WorkbenchPlanAcceptanceStatus, number>;
  };
  risks: {
    total: number;
    bySeverity: Record<WorkbenchPlanRiskSeverity, number>;
    byStatus: Record<WorkbenchPlanRiskStatus, number>;
    open: WorkbenchPlanItemSummary[];
  };
}

export interface WorkbenchPlanDocument {
  id: string;
  title: string;
  goal: string;
  assumptions: WorkbenchPlanAssumption[];
  questions: WorkbenchPlanQuestion[];
  steps: WorkbenchPlanStep[];
  acceptance: WorkbenchPlanAcceptanceCriterion[];
  risks: WorkbenchPlanRisk[];
  status: WorkbenchPlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: WorkbenchJsonObject;
}

export interface WorkbenchPlanDocumentsListedResponse {
  type?: "plan-documents-listed";
  documents: WorkbenchPlanDocumentSummary[];
}

export interface WorkbenchPlanDocumentResponse {
  type?: "plan-document" | "plan-document-created" | "plan-document-patched";
  document: WorkbenchPlanDocument;
}

export interface WorkbenchPlanDocumentDeletedResponse {
  type?: "plan-document-deleted";
  documentId: string;
}

export type WorkbenchApprovalRiskLevel = "low" | "medium" | "high" | "unknown";
export type WorkbenchApprovalMetadataSource = "backend" | "unknown";

export interface WorkbenchApprovalMetadata {
  riskLevel: WorkbenchApprovalRiskLevel;
  source: WorkbenchApprovalMetadataSource;
  risk?: string;
  reason?: string;
  riskRule?: string;
  riskDetail?: string;
  matched?: string;
  checkpointId?: string;
  snapshotId?: string;
  recommendSnapshot?: boolean;
  requiresDoubleConfirm?: boolean;
  raw?: WorkbenchJsonObject;
}

export interface WorkbenchNormalizedApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  summary: string;
  metadata: WorkbenchApprovalMetadata;
}

export interface WorkbenchNormalizedEvent {
  type: string;
  approvalId?: string;
  requestId?: string;
  toolCallId?: string;
  request?: WorkbenchNormalizedApprovalRequest;
  approvalDecision?: "approved" | "denied";
  [key: string]: unknown;
}

export type DaemonSessionStatus = "open" | "closed" | "archived";

export type DaemonRunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type DaemonRunOutcome = "completed" | "blocked" | "cancelled" | "failed";

export type DaemonRunOutcomeReason =
  | "completed"
  | "cancelled"
  | "aborted"
  | "goal-completed"
  | "goal-blocked"
  | "goal-max-rounds"
  | "goal-stalled"
  | "max-turns"
  | "agent-error"
  | "provider-error"
  | "runtime-error"
  | "intervention-required"
  | "awaiting-approval"
  | "run-engine-error";

export interface DaemonSessionRecord {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: DaemonSessionStatus;
  currentLeafId?: string;
  metadata?: WorkbenchJsonObject;
}

export interface DaemonSessionSummary {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runCount: number;
  activeRunCount?: number;
  activeRunIds?: string[];
  latestRunId?: string;
  latestRunStatus?: DaemonRunStatus;
  latestRunUpdatedAt?: string;
  pendingInputCount?: number;
  pendingApprovalCount?: number;
  lastEventId?: string;
  lastSequence?: number;
  lastMessagePreview?: string;
}

export interface DaemonSessionsListedResponse {
  type?: "sessions-listed";
  sessions: DaemonSessionRecord[];
  summaries?: DaemonSessionSummary[];
}

export type DaemonPendingInputMode = "after-current-run" | "steer";
export type DaemonPendingInputStatus = "pending" | "cancelled" | "dispatched";
export type DaemonPendingInputSource = "workbench" | "daemon" | "automation";

export interface DaemonPendingInputRecord {
  id: string;
  sessionId: string;
  runId?: string;
  text: string;
  mode: DaemonPendingInputMode;
  status: DaemonPendingInputStatus;
  createdAt: string;
  updatedAt: string;
  source?: DaemonPendingInputSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchEnqueuePendingInputRequest {
  sessionId: string;
  runId?: string;
  text: string;
  mode?: DaemonPendingInputMode;
  inputId?: string;
  source?: DaemonPendingInputSource;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchCancelPendingInputRequest {
  inputId: string;
  sessionId?: string;
  reason?: string;
}

export interface WorkbenchDispatchPendingInputRequest {
  inputId: string;
  sessionId?: string;
  targetRunId?: string;
}

export interface DaemonPendingInputQueuedResponse {
  type?: "pending-input-queued";
  input: DaemonPendingInputRecord;
  event: DaemonOrchestratorEvent;
}

export interface DaemonPendingInputCancelledResponse {
  type?: "pending-input-cancelled";
  input: DaemonPendingInputRecord;
  event: DaemonOrchestratorEvent;
}

export interface DaemonPendingInputDispatchedResponse {
  type?: "pending-input-dispatched";
  input: DaemonPendingInputRecord;
  event: DaemonOrchestratorEvent;
}

export interface DaemonPendingInputsListedResponse {
  type?: "pending-inputs-listed";
  inputs: DaemonPendingInputRecord[];
  sessionId?: string;
}

export type DaemonGoalRunStatus = "queued" | "running" | "completed" | "blocked" | "cancelled" | "failed";
export type DaemonGoalStoppedReason = "complete" | "blocked" | "max-rounds" | "stalled" | "cancelled" | "error";
export type DaemonGoalContinuationAction = "continue" | "complete" | "block";

export interface DaemonGoalContinuationDecision {
  action: DaemonGoalContinuationAction;
  reason: string;
  prompt?: string;
  progressSignature?: string;
  detail?: WorkbenchJsonObject;
}

export interface DaemonGoalRunState {
  status: DaemonGoalRunStatus;
  visibleGoal?: string;
  maxRounds: number;
  maxStalledRounds: number;
  currentRound: number;
  completedRounds: number;
  stalledRounds: number;
  stoppedReason?: DaemonGoalStoppedReason;
  lastProgressSignature?: string;
  lastDecision?: DaemonGoalContinuationDecision;
}

export interface DaemonRunRecord {
  id: string;
  sessionId: string;
  cwd: string;
  status: DaemonRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: DaemonRunOutcome;
  reason?: DaemonRunOutcomeReason;
  outcomeDetail?: WorkbenchJsonObject;
  error?: string;
  kind?: "task" | "goal";
  goal?: DaemonGoalRunState;
  lastEventId?: string;
  metadata?: WorkbenchJsonObject;
}

export type DaemonOrchestratorEventType =
  | "session-created"
  | "run-queued"
  | "run-started"
  | "goal-round-started"
  | "goal-round-completed"
  | "goal-continuation-decided"
  | "pending-input-created"
  | "pending-input-cancelled"
  | "pending-input-dispatched"
  | "runtime-event"
  | "run-cancel-requested"
  | "run-cancelled"
  | "run-completed"
  | "run-failed";

export interface DaemonOrchestratorEvent {
  protocolVersion: 1;
  id: string;
  sequence: number;
  type: DaemonOrchestratorEventType;
  sessionId: string;
  runId?: string;
  timestamp: string;
  payload: WorkbenchJsonObject;
}

export interface DaemonEventLogMetadata {
  eventLogId: string;
  generation: number;
  schemaVersion: number;
  protocolVersion: number;
}

export interface DaemonEventReplayCursor extends DaemonEventLogMetadata {
  afterSequence: number;
  lastEventId?: string;
}

export interface DaemonEventCursorDiagnostic {
  code: "EVENT_LOG_CURSOR_MISMATCH";
  message: string;
  severity: "warning";
  previous?: DaemonEventReplayCursor;
  current: DaemonEventLogMetadata;
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

export interface DaemonSessionEventsResponse {
  type?: "session-events";
  sessionId: string;
  events: DaemonOrchestratorEvent[];
  eventLog: DaemonEventLogMetadata;
  cursorDiagnostic?: DaemonEventCursorDiagnostic;
  diagnostics?: DaemonEventReadDiagnostics;
  nextAfterSequence: number;
  hasMore?: boolean;
  nextCursor?: DaemonEventReplayCursor;
  afterSequence?: number;
  lastEventId?: string;
}

export interface DaemonRunEventsResponse {
  type?: "run-events";
  runId: string;
  events: DaemonOrchestratorEvent[];
  eventLog: DaemonEventLogMetadata;
  cursorDiagnostic?: DaemonEventCursorDiagnostic;
  diagnostics?: DaemonEventReadDiagnostics;
  nextAfterSequence: number;
  hasMore?: boolean;
  nextCursor?: DaemonEventReplayCursor;
  afterSequence?: number;
  lastEventId?: string;
  snapshot?: DaemonTaskSnapshot;
}

export interface DaemonRunEventsQuery {
  runId: string;
  afterSequence?: number;
  lastEventId?: string;
  includeSnapshot?: boolean;
  maxEvents?: number;
  cursor?: DaemonEventReplayCursor;
}

export interface DaemonRunSnapshotQuery {
  runId: string;
}

export interface DaemonRunSnapshotResponse {
  type?: "run-snapshot";
  runId: string;
  snapshot: DaemonTaskSnapshot;
}

export type WorkbenchSessionTreeLeafId = string | null;
export type WorkbenchSessionTreeEntryType = "node" | "branch_summary";

export interface WorkbenchSessionTreeBaseEntry {
  id: string;
  parentId: string | null;
  createdAt: string;
}

export interface WorkbenchSessionTreeNodeEntry extends WorkbenchSessionTreeBaseEntry {
  type: "node";
  payload: WorkbenchJsonObject;
}

export interface WorkbenchSessionTreeBranchSummaryEntry extends WorkbenchSessionTreeBaseEntry {
  type: "branch_summary";
  summary: string;
  abandonedLeafId: string | null;
  details?: WorkbenchJsonObject;
}

export type WorkbenchSessionTreeEntry =
  | WorkbenchSessionTreeNodeEntry
  | WorkbenchSessionTreeBranchSummaryEntry;

export type WorkbenchConversationRewindBoundaryTargetMode = "keep-user-message" | "remove-user-message";
export type WorkbenchConversationRewindRestorePolicy = "if-present" | "required" | "skip";
export type WorkbenchConversationBoundaryCheckpointSource = "runtime" | "tool" | "external" | "unknown";

export type WorkbenchConversationRewindCheckpointTarget =
  | {
      source: "runtime-manifest";
      checkpointId: string;
      manifestPath?: string;
    }
  | {
      source: "git-checkpoint";
      checkpoint: string;
      cleanUntracked?: boolean;
    };

export interface WorkbenchConversationRewindActiveSubagentRecord {
  parentRunId: string;
  subagentRunId: string;
  subagentId?: string;
}

export interface WorkbenchConversationRewindRequest {
  sessionId: string;
  runId?: string;
  targetLeafId?: WorkbenchSessionTreeLeafId;
  entries?: WorkbenchSessionTreeEntry[];
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: WorkbenchConversationRewindBoundaryTargetMode;
  retainTargetUserMessage?: boolean;
  checkpoint?: WorkbenchConversationRewindCheckpointTarget;
  restorePolicy?: WorkbenchConversationRewindRestorePolicy;
  activeSubagents?: WorkbenchConversationRewindActiveSubagentRecord[];
  dryRun?: boolean;
  force?: boolean;
}

export type WorkbenchConversationRewindPreviewRequest = WorkbenchConversationRewindRequest;
export type WorkbenchConversationRewindApplyRequest = WorkbenchConversationRewindRequest;

export type WorkbenchCapabilityState =
  | "implemented"
  | "experimental"
  | "degraded"
  | "backend-not-wired"
  | "unsupported";

export type WorkbenchSessionActionAvailability = WorkbenchCapabilityState;

export type WorkbenchSessionActionId =
  | "pin"
  | "unpin"
  | "fork"
  | "rename"
  | "archive"
  | "unarchive"
  | "delete"
  | "open-in"
  | "open-in-split-view"
  | "rewind"
  | "withdraw";

export type WorkbenchSessionActionEffect =
  | "metadata"
  | "branch"
  | "navigation"
  | "history-mutation"
  | "message-mutation";

export interface WorkbenchSessionActionContract {
  id: WorkbenchSessionActionId;
  label: string;
  availability: WorkbenchSessionActionAvailability;
  effect: WorkbenchSessionActionEffect;
  backendCommand?: string;
  daemonCapability?: string;
  reason: string;
}

export const WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION = 1;

export type WorkbenchSessionActionKind =
  | "pin"
  | "unpin"
  | "fork"
  | "rename"
  | "archive"
  | "unarchive"
  | "delete"
  | "rewind"
  | "open";

export type WorkbenchSessionOpenTarget = "split-view" | "vscode" | "explorer";
export type WorkbenchSessionActionStatus = "pending" | "committed" | "rejected" | "failed";

export interface WorkbenchSessionActionBase {
  protocolVersion: typeof WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: WorkbenchSessionActionKind;
  sessionId: string;
  requestedAt: string;
  requestedBy: "workbench" | "daemon" | "automation";
  idempotencyKey?: string;
  consistency?: {
    expectedSessionVersion?: string;
    eventLogCursor?: string;
    workspaceVersionId?: string;
    parentActionId?: string;
  };
}

export type WorkbenchSessionAction =
  | (WorkbenchSessionActionBase & { kind: "pin" | "unpin" | "archive" | "unarchive" | "delete" })
  | (WorkbenchSessionActionBase & { kind: "rename"; title: string })
  | (WorkbenchSessionActionBase & {
      kind: "fork";
      fromEventId?: string;
      fromMessageId?: string;
      targetSessionId?: string;
    })
  | (WorkbenchSessionActionBase & { kind: "rewind"; targetEventId: string; restoreWorkspace: boolean })
  | (WorkbenchSessionActionBase & { kind: "open"; target: WorkbenchSessionOpenTarget; paneId?: string });

export interface WorkbenchSessionActionReceipt {
  type?: "session-action-receipt";
  protocolVersion: typeof WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: WorkbenchSessionActionKind;
  sessionId: string;
  status: WorkbenchSessionActionStatus;
  committedAt?: string;
  resultingSessionId?: string;
  resultingEventId?: string;
  resultingWorkspaceVersionId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export const WORKBENCH_SESSION_ACTIONS: readonly WorkbenchSessionActionContract[] = [
  {
    id: "pin",
    label: "Pin",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Pinning is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "unpin",
    label: "Unpin",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Unpinning is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "rename",
    label: "Rename",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Renaming is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "archive",
    label: "Archive",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Archiving is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "unarchive",
    label: "Unarchive",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Unarchiving is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "delete",
    label: "Delete",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Deletion is a daemon-owned soft tombstone persisted through apply-session-action metadata.",
  },
  {
    id: "fork",
    label: "Fork",
    availability: "unsupported",
    effect: "branch",
    reason: "Forking needs a daemon session-branch command; it must not be represented by conversation rewind.",
  },
  {
    id: "open-in",
    label: "Open in",
    availability: "experimental",
    effect: "navigation",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Open is a daemon intent receipt; Workbench target handling remains experimental.",
  },
  {
    id: "open-in-split-view",
    label: "Open in split view",
    availability: "experimental",
    effect: "navigation",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Split-view open is a daemon intent receipt while layout binding is still experimental.",
  },
  {
    id: "rewind",
    label: "Rewind",
    availability: "implemented",
    effect: "history-mutation",
    backendCommand: "workbench_apply_conversation_rewind",
    daemonCapability: "conversation.rewind",
    reason: "Conversation rewind uses the daemon preview/apply protocol and may return unsupported step results.",
  },
  {
    id: "withdraw",
    label: "Withdraw",
    availability: "backend-not-wired",
    effect: "message-mutation",
    reason: "Withdrawing a message needs its own daemon command and must not be collapsed into rewind apply.",
  },
] as const;

export function isWorkbenchSessionActionReceipt(value: unknown): value is WorkbenchSessionActionReceipt {
  if (!isWorkbenchRecord(value)) return false;
  if (value.type !== undefined && value.type !== "session-action-receipt") return false;
  if (value.protocolVersion !== WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION) return false;
  if (typeof value.actionId !== "string" || !value.actionId) return false;
  if (!isWorkbenchSessionActionKind(value.kind)) return false;
  if (typeof value.sessionId !== "string" || !value.sessionId) return false;
  if (!isWorkbenchSessionActionStatus(value.status)) return false;
  if (value.committedAt !== undefined && typeof value.committedAt !== "string") return false;
  if (value.resultingSessionId !== undefined && typeof value.resultingSessionId !== "string") return false;
  if (value.resultingEventId !== undefined && typeof value.resultingEventId !== "string") return false;
  if (
    value.resultingWorkspaceVersionId !== undefined &&
    typeof value.resultingWorkspaceVersionId !== "string"
  ) {
    return false;
  }
  if (value.errorCode !== undefined && typeof value.errorCode !== "string") return false;
  if (value.errorMessage !== undefined && typeof value.errorMessage !== "string") return false;
  if ((value.status === "rejected" || value.status === "failed") && (!value.errorCode || !value.errorMessage)) {
    return false;
  }
  return true;
}

function isWorkbenchSessionActionKind(value: unknown): value is WorkbenchSessionActionKind {
  return (
    value === "pin" ||
    value === "unpin" ||
    value === "fork" ||
    value === "rename" ||
    value === "archive" ||
    value === "unarchive" ||
    value === "delete" ||
    value === "rewind" ||
    value === "open"
  );
}

function isWorkbenchSessionActionStatus(value: unknown): value is WorkbenchSessionActionStatus {
  return value === "pending" || value === "committed" || value === "rejected" || value === "failed";
}

export interface WorkbenchConversationBoundaryRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  sessionTreeLeafIdBefore?: string;
  sessionTreeLeafIdAfter?: string;
  runtimeLeafIdBefore?: string;
  runtimeLeafIdAfter?: string;
  eventSequence: number;
  workspaceRoot: string;
  checkpointId?: string;
  checkpointRef?: string;
  checkpointSource?: WorkbenchConversationBoundaryCheckpointSource;
  changedPaths: string[];
  createdAt: string;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchConversationCheckpointRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  checkpointId: string;
  checkpointRef: string;
  workspaceRoot: string;
  changedPaths: string[];
  source: WorkbenchConversationBoundaryCheckpointSource;
  createdAt: string;
  metadata?: WorkbenchJsonObject;
}

export type WorkbenchConversationRewindMissingFact =
  | "session-tree-target-leaf"
  | "runtime-target-leaf"
  | "workspace-checkpoint";

export type WorkbenchConversationRewindBoundaryMissingFact =
  | WorkbenchConversationRewindMissingFact
  | "boundary-record"
  | "checkpoint-manifest-record"
  | "session-record"
  | "session-tree-entries";

export interface WorkbenchConversationRewindWorkspaceCheckpointFacts {
  checkpointId: string;
  checkpointRef: string;
  checkpointSource: WorkbenchConversationBoundaryCheckpointSource;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
}

export interface WorkbenchConversationRewindTargetFacts {
  sessionId: string;
  runId: string;
  userMessageId: string;
  mode: WorkbenchConversationRewindBoundaryTargetMode;
  eventSequence: number;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
  sessionTreeTargetLeafId?: string;
  runtimeTargetLeafId?: string;
  checkpoint?: WorkbenchConversationRewindWorkspaceCheckpointFacts;
  missingFacts: WorkbenchConversationRewindMissingFact[];
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchConversationRewindBoundaryDiagnostic {
  code: string;
  fact: WorkbenchConversationRewindBoundaryMissingFact;
  message: string;
  blocked: boolean;
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchConversationRewindRunCancellation {
  runId: string;
  reason: "conversation-rewind";
  role: "session-run" | "subagent-run";
}

export interface WorkbenchConversationRewindApprovalClearance {
  toolCallId: string;
  runId: string;
  reason: "conversation-rewind";
}

export interface WorkbenchConversationRewindWorkspaceRestore {
  required: boolean;
  source: "runtime-manifest" | "git-checkpoint" | "none";
  checkpointId?: string;
  checkpoint?: string;
  manifestPath?: string;
  cleanUntracked: boolean;
}

export type WorkbenchConversationRewindStep =
  | { type: "cancel-runs"; runs: WorkbenchConversationRewindRunCancellation[] }
  | { type: "clear-approvals"; approvals: WorkbenchConversationRewindApprovalClearance[] }
  | { type: "restore-workspace"; restore: WorkbenchConversationRewindWorkspaceRestore }
  | {
      type: "move-session-leaf";
      sessionId: string;
      fromLeafId: WorkbenchSessionTreeLeafId;
      toLeafId: WorkbenchSessionTreeLeafId;
    };

export interface WorkbenchConversationRewindEntryProjection {
  currentPath: WorkbenchSessionTreeEntry[];
  targetPath: WorkbenchSessionTreeEntry[];
  commonAncestorId?: string;
  retainedEntryIds: string[];
  hiddenEntryIds: string[];
  hiddenCurrentPathEntryIds: string[];
  hiddenBranchEntryIds: string[];
}

export interface WorkbenchConversationRewindPlan {
  sessionId: string;
  fromLeafId: WorkbenchSessionTreeLeafId;
  targetLeafId: WorkbenchSessionTreeLeafId;
  targetPath: WorkbenchSessionTreeEntry[];
  entryProjection: WorkbenchConversationRewindEntryProjection;
  runCancellations: WorkbenchConversationRewindRunCancellation[];
  approvalClearances: WorkbenchConversationRewindApprovalClearance[];
  workspaceRestore: WorkbenchConversationRewindWorkspaceRestore;
  steps: WorkbenchConversationRewindStep[];
}

export interface WorkbenchConversationRewindPreviewResponse {
  type?: "conversation-rewind-preview";
  sessionId: string;
  plan: WorkbenchConversationRewindPlan;
  requestId?: string;
  correlationId?: string;
}

export interface WorkbenchConversationRewindBoundaryResponse {
  type?: "conversation-rewind-boundary";
  status: "ok" | "blocked";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage: boolean;
  mode: WorkbenchConversationRewindBoundaryTargetMode;
  boundary?: WorkbenchConversationBoundaryRecord;
  checkpoint?: WorkbenchConversationCheckpointRecord;
  target?: WorkbenchConversationRewindTargetFacts;
  missingFacts: WorkbenchConversationRewindBoundaryMissingFact[];
  diagnostics: WorkbenchConversationRewindBoundaryDiagnostic[];
  plan?: WorkbenchConversationRewindPlan;
  runtimeTargetLeafId?: string;
  requestId?: string;
  correlationId?: string;
}

export type WorkbenchConversationRewindPreviewResult =
  | WorkbenchConversationRewindPreviewResponse
  | WorkbenchConversationRewindBoundaryResponse;

export type WorkbenchConversationRewindApplyStepStatus =
  | "applied"
  | "deferred"
  | "unsupported"
  | "skipped"
  | "failed";

export interface WorkbenchConversationRewindApplyStepResult {
  type: WorkbenchConversationRewindStep["type"];
  status: WorkbenchConversationRewindApplyStepStatus;
  code?: string;
  message?: string;
  affectedIds?: string[];
  metadata?: WorkbenchJsonObject;
}

export interface WorkbenchConversationRewindAppliedResponse {
  type?: "conversation-rewind-applied";
  sessionId: string;
  plan: WorkbenchConversationRewindPlan;
  stepResults: WorkbenchConversationRewindApplyStepResult[];
  requestId?: string;
  correlationId?: string;
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
  metadata?: WorkbenchJsonObject;
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
  endpoint: "auto" | "responses" | "chat-completions";
  stream: boolean;
  systemPromptWireMode: "native-system-role" | "user-prefix";
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
  summary: WorkbenchJsonObject;
  diagnostics: WorkbenchJsonObject[];
  servers: WorkbenchJsonObject[];
  updatedAt: string;
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
  metadata?: WorkbenchJsonObject;
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

export interface DaemonStatusResponse {
  type?: "status-response";
  lifecycle: DaemonLifecycleSnapshot;
  activeRuns: Array<{
    runId: string;
    prompt: string;
    status: string;
    startedAt: number;
    cwd: string;
  }>;
  pendingApprovals: Array<{
    toolCallId: string;
    runId: string;
    toolName: string;
    summary: string;
    createdAt: number;
    metadata?: WorkbenchJsonObject;
  }>;
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
}

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
  input: WorkbenchJsonObject;
  status: "pending" | "running" | "approval-required" | "completed" | "failed";
  summary?: string;
  metadata?: WorkbenchJsonObject;
  startedAt: string;
  updatedAt: string;
  output?: string;
}

export interface DaemonTaskSnapshotApproval {
  toolCallId: string;
  toolName: string;
  input: WorkbenchJsonObject;
  summary: string;
  requestedAt: string;
  status: "pending";
  metadata?: WorkbenchJsonObject;
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
  exitCode?: number | null;
  signal?: string | null;
  outputPreview?: string;
}

export interface DaemonTaskSnapshotRunMetadata {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  metadata: WorkbenchJsonObject;
}

export interface DaemonTaskSnapshot {
  runId: string;
  sessionId: string;
  status: DaemonRunStatus;
  title: string;
  messages: DaemonTaskMessageSnapshot[];
  latestError?: string;
  approval?: DaemonTaskSnapshotApproval;
  pendingToolCalls: DaemonTaskSnapshotToolCall[];
  backgroundTasks: DaemonBackgroundTaskSnapshot[];
  progress?: DaemonTaskSnapshotProgress;
  usage?: DaemonTaskSnapshotUsage;
  cache?: DaemonTaskSnapshotCache;
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

export type WorkbenchRunState =
  | "idle"
  | "planning"
  | "running"
  | "waiting"
  | "blocked"
  | "done";

export type WorkbenchRunLifecycleStatus = "running" | "completed" | "cancelled" | "failed";

export type WorkbenchPlanState = "todo" | "doing" | "done" | "blocked";
export type WorkbenchEvidenceKind = "file" | "command" | "check" | "decision";
export type WorkbenchConfirmationKind = "write" | "danger" | "outside-project" | "credential" | "network";
export type WorkbenchBackgroundTaskKind = "command" | "service" | "check" | "scheduled";
export type WorkbenchBackgroundTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
export type WorkbenchOutputReferenceKind = "image" | "markdown" | "text" | "code" | "directory" | "file" | "link" | "unknown";
export type WorkbenchOutputReferenceRender = "inline" | "sidebar" | "open";
export type WorkbenchOutputReferenceSource =
  | "markdown-image"
  | "markdown-link"
  | "workbench-tag"
  | "tool-artifact"
  | "final-summary";
export type WorkbenchDisclosureIssueKind =
  | "relative-path"
  | "missing-local-file"
  | "image-preview-failed"
  | "mojibake"
  | "command-failed"
  | "command-not-found"
  | "empty-output";
export type WorkbenchDisclosureIssueSeverity = "info" | "warning" | "error";

export interface WorkbenchProject {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
}

export interface WorkbenchPlanItem {
  id: string;
  title: string;
  state: WorkbenchPlanState;
  note?: string;
  evidenceIds?: string[];
}

export interface WorkbenchAcceptanceItem {
  id: string;
  title: string;
  required: boolean;
  passed: boolean;
  evidenceIds: string[];
}

export interface WorkbenchEvidenceItem {
  id: string;
  kind: WorkbenchEvidenceKind;
  title: string;
  detail?: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchChangeItem {
  path: string;
  additions: number;
  deletions: number;
  state: "draft" | "checked" | "needs-review";
  checkpointId?: string;
}

export interface WorkbenchConfirmationRequest {
  id: string;
  kind: WorkbenchConfirmationKind;
  title: string;
  detail: string;
  primaryAction: string;
  secondaryAction: string;
}

export interface WorkbenchHealth {
  state: "good" | "busy" | "degraded";
  summary: string;
  memoryMb?: number;
  cpuPercent?: number;
  lastEventAt?: string;
  stalledForMs?: number;
}

export type WorkbenchMetricsStoreStatus = "ok" | "degraded";
export type WorkbenchMetricsScope = "global" | "session" | "run";

export interface WorkbenchDurationMetrics {
  count: number;
  min?: number;
  max?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface WorkbenchProviderUsageMetrics {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface WorkbenchCacheMetricsSnapshot {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
}

export interface WorkbenchStreamingMetricsSnapshot {
  textDeltaCount: number;
  textDeltaBytes?: number;
  textDeltaCharacters?: number;
  providerDiagnosticCount: number;
  firstTextDeltaLatencyMs?: number;
  firstProviderResponseLatencyMs?: number;
  providerStreamDurationMs?: number;
  tokensPerSecond?: number;
  textBytesPerSecond?: number;
  textCharactersPerSecond?: number;
  eventsPerSecond?: number;
  terminalEventCount?: number;
  interruptedCount?: number;
  errorCount?: number;
  terminalReasons?: Record<string, number>;
  cancelRequestedCount?: number;
  cancelObserved?: boolean;
  cancelLatencyMs?: number;
}

export interface WorkbenchToolNameMetricsSnapshot {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: WorkbenchDurationMetrics;
}

export interface WorkbenchToolMetricsSnapshot {
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: WorkbenchDurationMetrics;
  byName: Record<string, WorkbenchToolNameMetricsSnapshot>;
}

export interface WorkbenchFailureMetricsSnapshot {
  errorCount: number;
  runtimeErrorCount: number;
  agentErrorCount: number;
  providerErrorCount: number;
  contextCompressionErrorCount: number;
  timeoutCount: number;
  cancelCount: number;
}

export interface WorkbenchMetricsDimensions {
  providerFamily?: string;
  providerId?: string;
  modelFamily?: string;
  configuredModel?: string;
  actualModel?: string;
  cacheStrategy?: string;
  stablePrefixHash?: string;
  toolSchemaHash?: string;
  cacheKey?: string;
}

export interface WorkbenchMetricsDimensionSnapshot extends WorkbenchMetricsDimensions {
  promptAssemblyCount: number;
  providerUsage: WorkbenchProviderUsageMetrics;
  cache: WorkbenchCacheMetricsSnapshot;
  providerLatencyMs: WorkbenchDurationMetrics;
}

export interface WorkbenchRuntimeMetricsSnapshot {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  eventCount: number;
  turnCount: number;
  tools: WorkbenchToolMetricsSnapshot;
  providerUsage: WorkbenchProviderUsageMetrics;
  providerLatencyMs: WorkbenchDurationMetrics;
  streaming: WorkbenchStreamingMetricsSnapshot;
  cache: WorkbenchCacheMetricsSnapshot;
  failures: WorkbenchFailureMetricsSnapshot;
  latestDimensions?: WorkbenchMetricsDimensions;
  dimensions: WorkbenchMetricsDimensionSnapshot[];
}

export interface WorkbenchMetricsRunRecord {
  runId: string;
  sessionId: string;
  updatedAt: string;
  snapshot: WorkbenchRuntimeMetricsSnapshot;
}

export interface WorkbenchMetricsSummary {
  scope: WorkbenchMetricsScope;
  runCount: number;
  sessionCount: number;
  snapshot: WorkbenchRuntimeMetricsSnapshot;
}

export interface WorkbenchMetricsSource {
  kind: "jsonl";
  path: string;
  generation: number;
  status: WorkbenchMetricsStoreStatus;
  badLineCount: number;
}

export interface WorkbenchMetricsDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  path?: string;
  detail?: string;
}

export interface WorkbenchMetricsQuery {
  runId?: string;
  sessionId?: string;
  includeRuns?: boolean;
}

export interface WorkbenchMetricsQueryResult {
  status: WorkbenchMetricsStoreStatus;
  query: {
    runId?: string;
    sessionId?: string;
    includeRuns: boolean;
  };
  source: WorkbenchMetricsSource;
  summary: WorkbenchMetricsSummary;
  runs?: WorkbenchMetricsRunRecord[];
  diagnostic?: WorkbenchMetricsDiagnostic;
}

export interface WorkbenchTokenBudgetSnapshot {
  enabled: boolean;
  difficulty: string;
  maxTotalTokens: number;
  usedTotalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  missingUsageMessages: number;
  warned: boolean;
  reached: boolean;
  updatedAt: string;
}

export interface WorkbenchLongRunPolicy {
  enabled: boolean;
  targetMinutes: number;
  reviewEveryMinutes: number;
  maxSilentMinutes: number;
  continuationPrompt: string;
}

export interface WorkbenchBackgroundTask {
  id: string;
  kind: WorkbenchBackgroundTaskKind;
  title: string;
  state: WorkbenchBackgroundTaskState;
  cwd?: string;
  command?: string;
  detail?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  heartbeatAt?: string;
  heartbeatCount: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  summary?: string;
  outputPreview?: string;
  continuationPrompt?: string;
  evidenceIds?: string[];
}

export interface WorkbenchOutputReference {
  id: string;
  label: string;
  kind: WorkbenchOutputReferenceKind;
  render: WorkbenchOutputReferenceRender;
  source: WorkbenchOutputReferenceSource;
  path?: string;
  url?: string;
  mimeType?: string;
  previewable: boolean;
  editable: boolean;
  absolute: boolean;
  issues: string[];
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchDisclosureIssue {
  id: string;
  kind: WorkbenchDisclosureIssueKind;
  severity: WorkbenchDisclosureIssueSeverity;
  title: string;
  detail: string;
  suggestion: string;
  targetId?: string;
  createdAt: string;
}

export interface WorkbenchDisclosureSuggestion {
  shouldInject: boolean;
  message: string;
  issues: WorkbenchDisclosureIssue[];
  createdAt: string;
}

export interface DaemonTaskProjectionOptions {
  previous?: WorkbenchTaskSnapshot | null;
  now?: number;
}

export interface WorkbenchTaskSnapshot {
  id: string;
  project: WorkbenchProject;
  mode: WorkbenchMode;
  state: WorkbenchRunState;
  title: string;
  userGoal: string;
  progressLabel: string;
  completionPercent: number;
  plan: WorkbenchPlanItem[];
  acceptance: WorkbenchAcceptanceItem[];
  evidence: WorkbenchEvidenceItem[];
  changes: WorkbenchChangeItem[];
  confirmations: WorkbenchConfirmationRequest[];
  backgroundTasks: WorkbenchBackgroundTask[];
  outputReferences: WorkbenchOutputReference[];
  disclosureIssues: WorkbenchDisclosureIssue[];
  tokenBudget?: WorkbenchTokenBudgetSnapshot;
  nextActions: string[];
  health: WorkbenchHealth;
  longRun: WorkbenchLongRunPolicy;
}

export interface WorkbenchRuntimeStatus {
  ok: boolean;
  shell: "cli" | "tauri";
  cwd: string;
  message: string;
  capabilities: WorkbenchRuntimeCapability[];
}

export interface WorkbenchRuntimeCapability {
  id: string;
  title: string;
  ready: boolean;
}

export type WorkbenchProviderMode = "direct" | "account-center" | "auto";
export type WorkbenchApiKeySource = "frontend" | "env" | "unset" | "unknown";
export type WorkbenchAccountCenterConfigured = boolean | "unknown";
export type WorkbenchProviderCredentialStatus =
  | "ready"
  | "missing"
  | "account-center-pending"
  | "login-required"
  | "insufficient-quota"
  | "gateway-unavailable"
  | "credential-unavailable"
  | "invalid-response"
  | "unknown";

export interface WorkbenchProviderConfigSnapshot {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeySource: WorkbenchApiKeySource;
  accountCenterConfigured: WorkbenchAccountCenterConfigured;
  credentialMode: WorkbenchProviderMode;
  credentialStatus: WorkbenchProviderCredentialStatus;
  statusText: string;
  updatedAt: string;
  endpoint?: "auto" | "responses" | "chat-completions";
  stream?: boolean;
  systemPromptWireMode?: "native-system-role" | "user-prefix";
  providerId?: string;
  accountId?: string;
  upstreamModel?: string;
  readiness?: DaemonProviderReadiness;
  accountCenter?: DaemonAccountCenterStatusSnapshot;
  gateway?: DaemonProviderGatewayStatusSnapshot;
  lastDiagnostic?: DaemonProviderDiagnostic;
}

export interface WorkbenchStatus {
  activeRuns: number;
  pendingApprovals: number;
  /** Daemon 返回的活跃运行详情列表 */
  activeRunList?: DaemonActiveRunEntry[];
  /** Daemon 返回的待审批详情列表 */
  pendingApprovalList?: DaemonPendingApprovalEntry[];
  providerConfig?: WorkbenchProviderConfigSnapshot;
  providerStatus?: DaemonProviderStatusSnapshot;
  lifecycle?: DaemonLifecycleSnapshot;
  mcpStatus?: DaemonMcpStatusSnapshot;
  [key: string]: unknown;
}

export interface DaemonActiveRunEntry {
  runId: string;
  prompt: string;
  status: string;
  startedAt: number;
  cwd: string;
}

export interface DaemonPendingApprovalEntry {
  toolCallId: string;
  runId: string;
  toolName: string;
  summary: string;
  createdAt: number;
}

export interface WorkbenchProviderConfigUpdate {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: WorkbenchProviderMode;
  endpoint?: "auto" | "responses" | "chat-completions";
  stream?: boolean;
}

export interface WorkbenchStartRequest {
  cwd: string;
  prompt: string;
  mode?: WorkbenchMode;
}

export interface WorkbenchContinuationDecision {
  action: "continue" | "pause" | "complete";
  reason: string;
  prompt?: string;
}

export type WorkbenchRunEventType =
  | "run-start"
  | "message-update"
  | "tool-update"
  | "plan-update"
  | "progress-update"
  | "change-update"
  | "approval-required"
  | "health-update"
  | "checkpoint-created"
  | "disclosure-suggestion"
  | "background-task-start"
  | "background-task-heartbeat"
  | "background-task-end"
  | "resume-requested"
  | "run-end"
  | "run-error";

export interface WorkbenchRunEvent {
  runId?: string;
  type: WorkbenchRunEventType;
  message: string;
  timestamp: string;
  payload?: unknown;
}

export function buildInitialTaskSnapshot(cwd: string, now = Date.now()): WorkbenchTaskSnapshot {
  const projectName = projectNameFromPath(cwd);
  return {
    id: "local-session",
    project: {
      id: "local-project",
      name: projectName,
      path: cwd,
      updatedAt: now
    },
    mode: "plan",
    state: "idle",
    title: "准备开始",
    userGoal: "选择项目后描述你要完成的目标。",
    progressLabel: "等待指令",
    completionPercent: 0,
    plan: createDefaultPlan(),
    acceptance: createDefaultAcceptance(),
    evidence: [],
    changes: [],
    confirmations: [],
    backgroundTasks: [],
    outputReferences: [],
    disclosureIssues: [],
    nextActions: ["输入目标", "选择项目", "进入计划模式"],
    health: {
      state: "good",
      summary: "底座空闲"
    },
    longRun: createDefaultLongRunPolicy()
  };
}

export function isDaemonTaskSnapshot(value: unknown): value is DaemonTaskSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.messages) &&
    isWorkbenchRecord(value.currentRun)
  );
}

export function isDaemonPendingInputRecord(value: unknown): value is DaemonPendingInputRecord {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    (value.runId === undefined || typeof value.runId === "string") &&
    typeof value.text === "string" &&
    (value.mode === "after-current-run" || value.mode === "steer") &&
    (value.status === "pending" || value.status === "cancelled" || value.status === "dispatched") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.source === undefined ||
      value.source === "workbench" ||
      value.source === "daemon" ||
      value.source === "automation") &&
    (value.metadata === undefined || isWorkbenchRecord(value.metadata))
  );
}

export function isDaemonPendingInputQueuedResponse(
  value: unknown
): value is DaemonPendingInputQueuedResponse {
  return (
    isWorkbenchRecord(value) &&
    (value.type === undefined || value.type === "pending-input-queued") &&
    isDaemonPendingInputRecord(value.input)
  );
}

export function isDaemonPendingInputCancelledResponse(
  value: unknown
): value is DaemonPendingInputCancelledResponse {
  return (
    isWorkbenchRecord(value) &&
    (value.type === undefined || value.type === "pending-input-cancelled") &&
    isDaemonPendingInputRecord(value.input)
  );
}

export function isDaemonPendingInputDispatchedResponse(
  value: unknown
): value is DaemonPendingInputDispatchedResponse {
  return (
    isWorkbenchRecord(value) &&
    (value.type === undefined || value.type === "pending-input-dispatched") &&
    isDaemonPendingInputRecord(value.input)
  );
}

export function isDaemonPendingInputsListedResponse(
  value: unknown
): value is DaemonPendingInputsListedResponse {
  return (
    isWorkbenchRecord(value) &&
    (value.type === undefined || value.type === "pending-inputs-listed") &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isDaemonPendingInputRecord) &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

export function isWorkbenchConversationRewindPreviewResult(
  value: unknown
): value is WorkbenchConversationRewindPreviewResult {
  if (!isWorkbenchRecord(value)) return false;
  if (value.type === "conversation-rewind-boundary" || "diagnostics" in value || "missingFacts" in value) {
    return (
      (value.type === undefined || value.type === "conversation-rewind-boundary") &&
      (value.status === "ok" || value.status === "blocked") &&
      typeof value.sessionId === "string" &&
      typeof value.latestUserMessage === "boolean" &&
      isWorkbenchConversationRewindBoundaryTargetMode(value.mode) &&
      Array.isArray(value.missingFacts) &&
      value.missingFacts.every(isWorkbenchConversationRewindBoundaryMissingFact) &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.every(isWorkbenchConversationRewindBoundaryDiagnostic) &&
      (value.plan === undefined || isWorkbenchConversationRewindPlan(value.plan))
    );
  }
  return (
    (value.type === undefined || value.type === "conversation-rewind-preview") &&
    typeof value.sessionId === "string" &&
    isWorkbenchConversationRewindPlan(value.plan)
  );
}

export function isWorkbenchConversationRewindAppliedResponse(
  value: unknown
): value is WorkbenchConversationRewindAppliedResponse {
  return (
    isWorkbenchRecord(value) &&
    (value.type === undefined || value.type === "conversation-rewind-applied") &&
    typeof value.sessionId === "string" &&
    isWorkbenchConversationRewindPlan(value.plan) &&
    Array.isArray(value.stepResults) &&
    value.stepResults.every(isWorkbenchConversationRewindApplyStepResult)
  );
}

export function isDaemonProviderStatusSnapshot(value: unknown): value is DaemonProviderStatusSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.credentialMode === "string" &&
    typeof value.readiness === "string" &&
    typeof value.providerId === "string" &&
    typeof value.routeId === "string" &&
    typeof value.model === "string" &&
    (value.endpoint === undefined || value.endpoint === "auto" || value.endpoint === "responses" || value.endpoint === "chat-completions") &&
    (value.stream === undefined || typeof value.stream === "boolean") &&
    (value.systemPromptWireMode === "native-system-role" || value.systemPromptWireMode === "user-prefix") &&
    isWorkbenchRecord(value.apiKey) &&
    typeof value.apiKey.hasApiKey === "boolean" &&
    typeof value.apiKey.source === "string" &&
    (value.apiKey.last4 === undefined || typeof value.apiKey.last4 === "string") &&
    typeof value.hasDirectApiKey === "boolean" &&
    isWorkbenchRecord(value.accountCenter) &&
    isWorkbenchRecord(value.gateway) &&
    typeof value.updatedAt === "string"
  );
}

export function isDaemonMcpStatusSnapshot(value: unknown): value is DaemonMcpStatusSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.configured === "boolean" &&
    isDaemonMcpReadiness(value.readiness) &&
    isFiniteNumber(value.serverCount) &&
    isWorkbenchRecord(value.summary) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isWorkbenchRecord) &&
    Array.isArray(value.servers) &&
    value.servers.every(isWorkbenchRecord) &&
    typeof value.updatedAt === "string"
  );
}

export function isDaemonLifecycleSnapshot(value: unknown): value is DaemonLifecycleSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    isDaemonLifecycleState(value.state) &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isFiniteNumber(value.uptimeMs) &&
    (value.currentPort === null || isFiniteNumber(value.currentPort)) &&
    isFiniteNumber(value.connectedClientCount) &&
    isFiniteNumber(value.totalClientConnectionCount) &&
    isFiniteNumber(value.totalClientDisconnectCount) &&
    isFiniteNumber(value.activeRunCount) &&
    isDaemonEventStoreStatusSnapshot(value.eventStore) &&
    isDaemonProviderReadiness(value.providerReadiness) &&
    isDaemonMcpReadiness(value.mcpReadiness) &&
    (value.recentDisconnect === undefined || isDaemonClientDisconnectSnapshot(value.recentDisconnect)) &&
    (value.recentError === undefined || isDaemonLifecycleDiagnostic(value.recentError))
  );
}

export function projectDaemonProviderStatusToWorkbench(
  status: DaemonProviderStatusSnapshot,
  previous?: WorkbenchProviderConfigSnapshot | null
): WorkbenchProviderConfigSnapshot {
  const apiKey = status.apiKey ?? {
    hasApiKey: status.hasDirectApiKey,
    source: status.apiKeySource,
  };
  const apiKeySource = workbenchApiKeySourceFromDaemon(apiKey.source);
  const credentialStatus = workbenchCredentialStatusFromReadiness(status);
  return {
    baseUrl: status.baseUrl,
    model: status.model || previous?.model || "",
    hasApiKey: apiKey.hasApiKey,
    apiKeySource,
    accountCenterConfigured: status.accountCenter.configured,
    credentialMode: status.credentialMode,
    credentialStatus,
    statusText: providerStatusText(status),
    updatedAt: status.updatedAt,
    endpoint: status.endpoint,
    stream: status.stream,
    systemPromptWireMode: status.systemPromptWireMode,
    providerId: status.providerId,
    accountId: status.accountCenter.accountId,
    upstreamModel: status.upstreamModel,
    readiness: status.readiness,
    accountCenter: status.accountCenter,
    gateway: status.gateway,
    lastDiagnostic: status.lastDiagnostic ?? status.accountCenter.lastDiagnostic,
  };
}

export interface DaemonStatusProjectionOptions {
  providerConfig?: WorkbenchProviderConfigSnapshot;
  previousProviderConfig?: WorkbenchProviderConfigSnapshot | null;
}

export function projectDaemonStatusToWorkbench(
  input: unknown,
  options: DaemonStatusProjectionOptions = {}
): WorkbenchStatus {
  const record = isWorkbenchRecord(input) ? input : {};
  const rest: Record<string, unknown> = { ...record };
  delete rest.activeRuns;
  delete rest.pendingApprovals;
  delete rest.providerStatus;
  delete rest.providerConfig;
  delete rest.lifecycle;
  delete rest.mcpStatus;
  const activeRunArray = Array.isArray(record.activeRuns) ? record.activeRuns : [];
  const activeRuns = activeRunArray.length || (isFiniteNumber(record.activeRuns) ? record.activeRuns : 0);
  const pendingApprovalArray = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : [];
  const pendingApprovals = pendingApprovalArray.length || (isFiniteNumber(record.pendingApprovals) ? record.pendingApprovals : 0);
  const providerStatus = isDaemonProviderStatusSnapshot(record.providerStatus)
    ? record.providerStatus
    : undefined;
  const lifecycle = isDaemonLifecycleSnapshot(record.lifecycle) ? record.lifecycle : undefined;
  const mcpStatus = isDaemonMcpStatusSnapshot(record.mcpStatus) ? record.mcpStatus : undefined;
  const providerConfig = providerStatus
    ? projectDaemonProviderStatusToWorkbench(providerStatus, options.previousProviderConfig)
    : options.providerConfig;

  return {
    ...rest,
    activeRuns,
    pendingApprovals,
    ...(activeRunArray.length > 0 ? { activeRunList: activeRunArray as DaemonActiveRunEntry[] } : {}),
    ...(pendingApprovalArray.length > 0 ? { pendingApprovalList: pendingApprovalArray as DaemonPendingApprovalEntry[] } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerConfig ? { providerConfig } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(mcpStatus ? { mcpStatus } : {}),
  };
}

export function normalizeWorkbenchEvent(input: unknown): WorkbenchNormalizedEvent {
  const record = isWorkbenchRecord(input) ? input : {};
  const type = typeof record.type === "string" ? record.type : "";
  const nestedEvent = isWorkbenchRecord(record.event) ? normalizeWorkbenchEvent(record.event) : undefined;
  const normalized: WorkbenchNormalizedEvent = {
    ...record,
    type,
    ...(nestedEvent ? { event: nestedEvent } : {})
  };

  if (type === "approval-requested") {
    const request = normalizeWorkbenchApprovalRequest(record);
    if (request) {
      const approvalId = approvalIdFromEvent({ ...record, request }) ?? request.toolCallId ?? request.id;
      normalized.approvalId = approvalId;
      normalized.requestId = approvalId;
      normalized.toolCallId = approvalId;
      normalized.request = {
        ...request,
        id: approvalId,
        toolCallId: approvalId,
      };
    }
  }

  if (type === "approval-resolved") {
    const approvalId = approvalIdFromEvent(record);
    if (approvalId) {
      normalized.approvalId = approvalId;
      normalized.requestId = approvalId;
      normalized.toolCallId = approvalId;
    }
    const decision = normalizeApprovalDecision(record.decision ?? record.approvalDecision);
    if (decision) normalized.approvalDecision = decision;
  }

  return normalized;
}

export function approvalIdFromEvent(input: unknown): string | undefined {
  const record = isWorkbenchRecord(input) ? input : {};
  const nestedEvent = isWorkbenchRecord(record.event) ? record.event : undefined;
  const directRequest = isWorkbenchRecord(record.request) ? record.request : undefined;
  const nestedRequest = isWorkbenchRecord(nestedEvent?.request) ? nestedEvent.request : undefined;
  const records = [record, nestedEvent].filter(isWorkbenchRecord);
  const requests = [directRequest, nestedRequest].filter(isWorkbenchRecord);

  const toolCallId = firstStringValue(
    ...records.map((item) => stringFromRecord(item, "toolCallId")),
    ...requests.map((item) => stringFromRecord(item, "toolCallId"))
  );
  if (toolCallId) return toolCallId;

  const approvalId = firstStringValue(...records.map((item) => stringFromRecord(item, "approvalId")));
  if (approvalId) return approvalId;

  const requestId = firstStringValue(
    ...records.map((item) => stringFromRecord(item, "requestId")),
    ...requests.map((item) => stringFromRecord(item, "requestId"))
  );
  if (requestId) return requestId;

  const requestObjectId = firstStringValue(...requests.map((item) => stringFromRecord(item, "id")));
  if (requestObjectId) return requestObjectId;

  const directRequestLikeId =
    !directRequest && !nestedEvent && !stringFromRecord(record, "type")
      ? stringFromRecord(record, "id")
      : undefined;
  if (directRequestLikeId) return directRequestLikeId;

  return undefined;
}

export function normalizeWorkbenchApprovalMetadata(
  input: unknown,
  fallbackReason?: string,
  fallbackSource?: WorkbenchApprovalMetadataSource
): WorkbenchApprovalMetadata {
  const metadata = isWorkbenchRecord(input) ? input : undefined;
  const declaredSource = stringFromRecord(metadata, "source");
  const diagnosticSource = declaredSource === "local" || declaredSource === "diagnostic";
  const hasBackendRiskFacts = !diagnosticSource && (hasBackendApprovalRiskMetadata(metadata) || !!fallbackReason);
  const source = hasBackendRiskFacts ? approvalMetadataSourceFromInput(metadata) ?? fallbackSource ?? "backend" : "unknown";
  const rawRisk = stringFromRecord(metadata, "risk");
  const backendRisk =
    stringFromRecord(metadata, "riskLevel") ??
    rawRisk ??
    stringFromRecord(metadata, "severity");
  const reason = stringFromRecord(metadata, "reason") ?? fallbackReason;
  const detail = stringFromRecord(metadata, "detail") ?? stringFromRecord(metadata, "riskDetail") ?? reason;
  const checkpoint = isWorkbenchRecord(metadata?.checkpoint) ? metadata?.checkpoint : undefined;
  const snapshot = isWorkbenchRecord(metadata?.snapshot) ? metadata?.snapshot : undefined;
  const checkpointId = firstStringValue(
    stringFromRecord(metadata, "checkpointId"),
    stringFromRecord(checkpoint, "id"),
    stringFromRecord(checkpoint, "checkpointId")
  );
  const snapshotId = firstStringValue(
    stringFromRecord(metadata, "snapshotId"),
    stringFromRecord(snapshot, "id"),
    stringFromRecord(snapshot, "snapshotId"),
    stringFromRecord(metadata, "snapshotPath"),
    stringFromRecord(snapshot, "path")
  );
  const requiresDoubleConfirm =
    typeof metadata?.requiresDoubleConfirm === "boolean"
      ? metadata.requiresDoubleConfirm
      : stringFromRecord(metadata, "confirmation") === "double"
        ? true
        : stringFromRecord(metadata, "confirmation") === "single"
          ? false
          : undefined;
  const rule =
    stringFromRecord(metadata, "riskRule") ??
    stringFromRecord(metadata, "rule") ??
    riskRuleFromBackendRisk(backendRisk);
  const raw = isWorkbenchRecord(metadata?.raw) ? metadata.raw : metadata;

  return {
    riskLevel: hasBackendRiskFacts ? approvalRiskLevelFromBackend(backendRisk) : "unknown",
    source,
    ...(hasBackendRiskFacts && rawRisk ? { risk: rawRisk } : {}),
    ...(hasBackendRiskFacts && reason ? { reason } : {}),
    ...(hasBackendRiskFacts && rule ? { riskRule: rule } : {}),
    ...(hasBackendRiskFacts && detail ? { riskDetail: detail } : {}),
    ...(hasBackendRiskFacts && stringFromRecord(metadata, "matched") ? { matched: stringFromRecord(metadata, "matched") as string } : {}),
    ...(hasBackendRiskFacts && checkpointId ? { checkpointId } : {}),
    ...(hasBackendRiskFacts && snapshotId ? { snapshotId } : {}),
    ...(hasBackendRiskFacts && typeof metadata?.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {}),
    ...(hasBackendRiskFacts && requiresDoubleConfirm !== undefined ? { requiresDoubleConfirm } : {}),
    ...(raw ? { raw: raw as WorkbenchJsonObject } : {})
  };
}

export function projectDaemonTaskSnapshotToWorkbench(
  snapshot: DaemonTaskSnapshot,
  options: DaemonTaskProjectionOptions = {}
): WorkbenchTaskSnapshot {
  const now = options.now ?? Date.now();
  const cwd = snapshot.currentRun.cwd || options.previous?.project.path || "";
  const previous = options.previous ?? buildInitialTaskSnapshot(cwd, now);
  const updatedAt = parseDateMs(snapshot.updatedAt, now);
  const metadata = snapshot.currentRun.metadata;
  const mode = workbenchModeFromMetadata(metadata);
  const userGoal = metadataString(metadata, "prompt") ?? previous.userGoal;
  const title = snapshot.title || userGoal || previous.title;
  const statusState = workbenchStateFromDaemonStatus(snapshot.status);
  const confirmations = snapshot.approval
    ? [
        {
          id: snapshot.approval.toolCallId,
          kind: "write" as const,
          title: `Approve ${snapshot.approval.toolName}`,
          detail: snapshot.approval.summary,
          primaryAction: "Approve",
          secondaryAction: "Deny"
        }
      ]
    : [];

  return {
    ...previous,
    id: snapshot.runId,
    project: {
      id: snapshot.sessionId,
      name: projectNameFromPath(cwd),
      path: cwd,
      updatedAt
    },
    mode,
    state: confirmations.length > 0 ? "waiting" : statusState,
    title,
    userGoal,
    progressLabel: snapshot.progressLabel || progressLabelForDaemonStatus(snapshot.status),
    completionPercent: completionForDaemonStatus(snapshot.status, previous.completionPercent),
    plan: advancePlanForDaemonStatus(previous.plan, snapshot.status),
    confirmations,
    backgroundTasks: snapshot.backgroundTasks.map((task) =>
      projectDaemonBackgroundTask(task, previous.backgroundTasks.find((item) => item.id === task.id))
    ),
    nextActions: nextActionsForDaemonStatus(snapshot.status, confirmations.length > 0),
    health: {
      ...previous.health,
      ...healthForDaemonStatus(snapshot.status, snapshot.latestError),
      lastEventAt: snapshot.updatedAt
    }
  };
}

function normalizeWorkbenchApprovalRequest(record: Record<string, unknown>): WorkbenchNormalizedApprovalRequest | undefined {
  const source = isWorkbenchRecord(record.request) ? record.request : record;
  const tool = isWorkbenchRecord(source.tool) ? source.tool : undefined;
  const id =
    stringFromRecord(source, "id") ??
    stringFromRecord(source, "requestId") ??
    stringFromRecord(record, "requestId") ??
    stringFromRecord(source, "toolCallId") ??
    stringFromRecord(record, "toolCallId");
  if (!id) return undefined;

  const summary = stringFromRecord(source, "summary") ?? stringFromRecord(record, "summary") ?? "";
  const metadataInput = source.metadata ?? record.metadata;
  const reason = stringFromRecord(source, "reason") ?? stringFromRecord(record, "reason");

  return {
    id,
    toolCallId: stringFromRecord(source, "toolCallId") ?? stringFromRecord(record, "toolCallId") ?? id,
    toolName: stringFromRecord(source, "toolName") ?? stringFromRecord(record, "toolName") ?? stringFromRecord(tool, "name") ?? "unknown",
    input: source.input ?? record.input ?? summary,
    summary,
    metadata: normalizeWorkbenchApprovalMetadata(metadataInput, reason, metadataInput === undefined && !reason ? "unknown" : "backend")
  };
}

function normalizeApprovalDecision(value: unknown): "approved" | "denied" | undefined {
  if (value === "approved" || value === "allow") return "approved";
  if (value === "denied" || value === "deny") return "denied";
  if (!isWorkbenchRecord(value)) return undefined;
  if (value.behavior === "allow") return "approved";
  if (value.behavior === "deny") return "denied";
  return undefined;
}

function approvalMetadataSourceFromInput(
  metadata: Record<string, unknown> | undefined
): WorkbenchApprovalMetadataSource | undefined {
  const source = stringFromRecord(metadata, "source");
  return source === "backend" || source === "unknown" ? source : undefined;
}

function hasBackendApprovalRiskMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return (
    stringFromRecord(metadata, "riskLevel") !== undefined ||
    stringFromRecord(metadata, "risk") !== undefined ||
    stringFromRecord(metadata, "severity") !== undefined ||
    stringFromRecord(metadata, "riskRule") !== undefined ||
    stringFromRecord(metadata, "rule") !== undefined ||
    stringFromRecord(metadata, "reason") !== undefined ||
    stringFromRecord(metadata, "detail") !== undefined ||
    stringFromRecord(metadata, "riskDetail") !== undefined ||
    stringFromRecord(metadata, "matched") !== undefined ||
    typeof metadata.recommendSnapshot === "boolean" ||
    typeof metadata.requiresDoubleConfirm === "boolean" ||
    stringFromRecord(metadata, "confirmation") !== undefined ||
    stringFromRecord(metadata, "checkpointId") !== undefined ||
    stringFromRecord(metadata, "snapshotId") !== undefined ||
    isWorkbenchRecord(metadata.checkpoint) ||
    isWorkbenchRecord(metadata.snapshot)
  );
}

function approvalRiskLevelFromBackend(value: string | undefined): WorkbenchApprovalRiskLevel {
  const risk = value?.trim().toLowerCase();
  if (risk === "low" || risk === "medium" || risk === "high" || risk === "unknown") return risk;
  if (risk === "read" || risk === "safe-read") return "low";
  if (risk === "write" || risk === "network" || risk === "process" || risk === "external-side-effect" || risk === "moderate") {
    return "medium";
  }
  if (risk === "destructive" || risk === "secret" || risk === "hardline" || risk === "critical") return "high";
  return "unknown";
}

function riskRuleFromBackendRisk(value: string | undefined): string | undefined {
  const risk = value?.trim();
  if (!risk) return undefined;
  const normalized = risk.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "unknown") return undefined;
  return risk;
}

export function applyUserGoal(snapshot: WorkbenchTaskSnapshot, prompt: string): WorkbenchTaskSnapshot {
  const now = Date.now();
  return {
    ...snapshot,
    state: "planning",
    title: "正在整理计划",
    userGoal: prompt,
    progressLabel: "已收到目标，下一步会先确认范围和验收方式",
    completionPercent: Math.max(snapshot.completionPercent, 5),
    project: {
      ...snapshot.project,
      updatedAt: now
    },
    plan: snapshot.plan.map((item, index) =>
      index === 0
        ? {
            ...item,
            state: "doing",
            note: "正在确认目标、路径和风险"
          }
        : item
    ),
    nextActions: ["确认执行计划", "补充约束", "切换到执行模式"],
    health: {
      ...snapshot.health,
      state: "busy",
      summary: "正在规划"
    }
  };
}

export function calculateCompletion(snapshot: Pick<WorkbenchTaskSnapshot, "plan" | "acceptance">): number {
  const planScore =
    snapshot.plan.length === 0
      ? 0
      : snapshot.plan.filter((item) => item.state === "done").length / snapshot.plan.length;
  const requiredAcceptance = snapshot.acceptance.filter((item) => item.required);
  const acceptanceScore =
    requiredAcceptance.length === 0
      ? 0
      : requiredAcceptance.filter((item) => item.passed).length / requiredAcceptance.length;
  return Math.round((planScore * 0.45 + acceptanceScore * 0.55) * 100);
}

export function summarizeState(state: WorkbenchRunState): string {
  switch (state) {
    case "planning":
      return "正在规划";
    case "running":
      return "正在处理";
    case "waiting":
      return "等待确认";
    case "blocked":
      return "遇到阻碍";
    case "done":
      return "已完成";
    case "idle":
    default:
      return "空闲";
  }
}

export function summarizeMode(mode: WorkbenchMode): string {
  switch (mode) {
    case "execute":
      return "执行模式";
    case "review":
      return "审查模式";
    case "discuss":
      return "讨论模式";
    case "plan":
    default:
      return "计划模式";
  }
}

export function createRuntimeCapabilities(): WorkbenchRuntimeCapability[] {
  return [
    { id: "command", title: "命令执行", ready: true },
    { id: "filesystem", title: "文件读写", ready: true },
    { id: "checkpoint", title: "变更回退", ready: true },
    { id: "planning", title: "计划进度", ready: true },
    { id: "longrun", title: "长程续跑", ready: true },
    { id: "provider", title: "模型调用", ready: false }
  ];
}

export function createDefaultLongRunPolicy(): WorkbenchLongRunPolicy {
  return {
    enabled: true,
    targetMinutes: 15,
    reviewEveryMinutes: 5,
    maxSilentMinutes: 3,
    continuationPrompt: [
      "检查当前目标、已完成内容、未完成验收项和最近证据。",
      "如果目标尚未完成，先给出更细的下一步计划，再继续执行。",
      "不要扩大任务范围；需要用户判断时暂停并说明原因。"
    ].join("\n")
  };
}

export function workbenchRunLifecycleStatusFromDaemon(value: unknown): WorkbenchRunLifecycleStatus | null {
  const record = isWorkbenchRecord(value) ? value : undefined;
  const payload = isWorkbenchRecord(record?.payload) ? record.payload : undefined;
  const run = isWorkbenchRecord(record?.run)
    ? record.run
    : isWorkbenchRecord(payload?.run)
      ? payload.run
      : undefined;
  const eventType = firstStringValue(record?.type, payload?.type);
  const status = firstStringValue(record?.status, payload?.status, run?.status);
  const outcome = firstStringValue(record?.outcome, payload?.outcome, run?.outcome);
  const reason = firstStringValue(record?.reason, payload?.reason, run?.reason);

  if (eventType === "run-cancelled" || status === "cancelled" || outcome === "cancelled" || isCancelledReason(reason)) {
    return "cancelled";
  }
  if (eventType === "run-failed" || status === "failed" || outcome === "failed" || outcome === "blocked" || isFailedReason(reason)) {
    return "failed";
  }
  if (eventType === "run-completed" || status === "completed" || outcome === "completed" || isCompletedReason(reason)) {
    return "completed";
  }
  if (isActiveDaemonStatus(status)) {
    return "running";
  }
  return null;
}

function workbenchModeFromMetadata(metadata?: WorkbenchJsonObject): WorkbenchMode {
  const mode = metadataString(metadata, "mode");
  return mode === "execute" || mode === "review" || mode === "discuss" || mode === "plan" ? mode : "plan";
}

function workbenchStateFromDaemonStatus(status: DaemonRunStatus): WorkbenchRunState {
  switch (status) {
    case "queued":
      return "planning";
    case "running":
      return "running";
    case "awaiting-approval":
    case "cancelling":
      return "waiting";
    case "completed":
      return "done";
    case "cancelled":
    case "failed":
      return "blocked";
    default:
      return "idle";
  }
}

function completionForDaemonStatus(status: DaemonRunStatus, previous: number): number {
  const fallback: Record<DaemonRunStatus, number> = {
    queued: 10,
    running: 45,
    "awaiting-approval": 60,
    cancelling: 70,
    cancelled: 70,
    completed: 100,
    failed: 75
  };
  return Math.max(previous, fallback[status] ?? previous);
}

function progressLabelForDaemonStatus(status: DaemonRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "awaiting-approval":
      return "Awaiting approval";
    case "cancelling":
      return "Cancelling";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function nextActionsForDaemonStatus(status: DaemonRunStatus, hasConfirmation: boolean): string[] {
  if (hasConfirmation) return ["Review approval", "Approve or deny", "Continue after decision"];
  switch (status) {
    case "completed":
      return ["Review result", "Inspect changes", "Start next task"];
    case "failed":
      return ["Inspect error", "Retry with context", "Open event log"];
    case "cancelled":
      return ["Review partial output", "Resume if needed", "Start next task"];
    default:
      return ["Monitor progress", "Review events", "Cancel if needed"];
  }
}

function healthForDaemonStatus(
  status: DaemonRunStatus,
  latestError?: string
): Pick<WorkbenchHealth, "state" | "summary"> {
  if (latestError || status === "failed") return { state: "degraded", summary: latestError ?? "Run failed" };
  if (status === "running" || status === "queued" || status === "cancelling") {
    return { state: "busy", summary: progressLabelForDaemonStatus(status) };
  }
  return { state: "good", summary: progressLabelForDaemonStatus(status) };
}

function advancePlanForDaemonStatus(plan: WorkbenchPlanItem[], status: DaemonRunStatus): WorkbenchPlanItem[] {
  const next = plan.map((item) => ({ ...item }));
  const mark = (id: string, state: WorkbenchPlanState) => {
    const item = next.find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.state === "done" && state !== "blocked") return;
    item.state = state;
  };

  if (status === "queued") {
    mark("understand", "doing");
    return next;
  }
  if (status === "running" || status === "awaiting-approval" || status === "cancelling") {
    mark("understand", "done");
    mark("inspect", "done");
    mark("execute", status === "awaiting-approval" ? "blocked" : "doing");
    return next;
  }
  if (status === "completed") {
    return next.map((item) => ({ ...item, state: "done" }));
  }
  if (status === "failed" || status === "cancelled") {
    mark("understand", "done");
    mark("inspect", "done");
    mark("execute", "blocked");
  }
  return next;
}

function projectDaemonBackgroundTask(
  task: DaemonBackgroundTaskSnapshot,
  previous?: WorkbenchBackgroundTask
): WorkbenchBackgroundTask {
  return {
    id: task.id,
    kind: "command",
    title: task.title,
    state: task.state,
    cwd: task.cwd,
    command: task.command,
    detail: task.outputPreview,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    heartbeatAt: previous?.heartbeatAt ?? task.updatedAt,
    heartbeatCount: previous?.heartbeatCount ?? (task.state === "running" ? 1 : 0),
    durationMs: task.durationMs,
    exitCode: task.exitCode,
    signal: task.signal,
    summary: task.outputPreview,
    outputPreview: task.outputPreview,
    evidenceIds: previous?.evidenceIds
  };
}

function workbenchApiKeySourceFromDaemon(source: DaemonProviderApiKeySource): WorkbenchApiKeySource {
  if (source === "env") return "env";
  if (source === "runtime-update") return "frontend";
  if (source === "workspace-config") return "frontend";
  if (source === "user-config") return "frontend";
  if (source === "unset") return "unset";
  return "unknown";
}

function workbenchCredentialStatusFromReadiness(
  status: DaemonProviderStatusSnapshot
): WorkbenchProviderCredentialStatus {
  if (status.readiness === "ready") return "ready";
  if (status.readiness === "missing") return "missing";
  if (status.readiness === "unknown" && status.credentialMode !== "direct") {
    return status.accountCenter.configured ? "account-center-pending" : "unknown";
  }
  return status.readiness;
}

function providerStatusText(status: DaemonProviderStatusSnapshot): string {
  switch (status.readiness) {
    case "ready":
      return status.credentialMode === "direct" || (status.credentialMode === "auto" && status.apiKey.hasApiKey)
        ? "Direct provider key is ready"
        : "Account center is ready";
    case "missing":
      return status.credentialMode === "direct"
        ? "Provider API key is required"
        : "Account center is not configured";
    case "login-required":
      return "Account-center login is required";
    case "insufficient-quota":
      return "Account-center quota is insufficient";
    case "gateway-unavailable":
      return "Account-center gateway is unavailable";
    case "credential-unavailable":
      return "Runtime provider credential is unavailable";
    case "invalid-response":
      return "Account-center returned an invalid response";
    case "unknown":
    default:
      return "Provider readiness is unknown";
  }
}

function metadataString(metadata: WorkbenchJsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseDateMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDaemonProviderReadiness(value: unknown): value is DaemonProviderReadiness {
  return (
    value === "ready" ||
    value === "missing" ||
    value === "login-required" ||
    value === "insufficient-quota" ||
    value === "gateway-unavailable" ||
    value === "credential-unavailable" ||
    value === "invalid-response" ||
    value === "unknown"
  );
}

function isDaemonMcpReadiness(value: unknown): value is DaemonMcpReadiness {
  return (
    value === "ready" ||
    value === "degraded" ||
    value === "starting" ||
    value === "stopped" ||
    value === "unknown"
  );
}

function isDaemonLifecycleState(value: unknown): value is DaemonLifecycleState {
  return (
    value === "starting" ||
    value === "ready" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "degraded"
  );
}

function isWorkbenchConversationRewindBoundaryTargetMode(
  value: unknown
): value is WorkbenchConversationRewindBoundaryTargetMode {
  return value === "keep-user-message" || value === "remove-user-message";
}

function isWorkbenchSessionTreeEntry(value: unknown): value is WorkbenchSessionTreeEntry {
  if (!isWorkbenchRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.createdAt !== "string"
  ) {
    return false;
  }
  if (value.type === "node") {
    return isWorkbenchRecord(value.payload);
  }
  return (
    value.type === "branch_summary" &&
    typeof value.summary === "string" &&
    (value.abandonedLeafId === null || typeof value.abandonedLeafId === "string") &&
    (value.details === undefined || isWorkbenchRecord(value.details))
  );
}

function isWorkbenchConversationRewindPlan(value: unknown): value is WorkbenchConversationRewindPlan {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    (value.fromLeafId === null || typeof value.fromLeafId === "string") &&
    (value.targetLeafId === null || typeof value.targetLeafId === "string") &&
    Array.isArray(value.targetPath) &&
    value.targetPath.every(isWorkbenchSessionTreeEntry) &&
    isWorkbenchRecord(value.entryProjection) &&
    Array.isArray(value.runCancellations) &&
    Array.isArray(value.approvalClearances) &&
    isWorkbenchRecord(value.workspaceRestore) &&
    Array.isArray(value.steps)
  );
}

function isWorkbenchConversationRewindBoundaryMissingFact(
  value: unknown
): value is WorkbenchConversationRewindBoundaryMissingFact {
  return (
    value === "session-tree-target-leaf" ||
    value === "runtime-target-leaf" ||
    value === "workspace-checkpoint" ||
    value === "boundary-record" ||
    value === "checkpoint-manifest-record" ||
    value === "session-record" ||
    value === "session-tree-entries"
  );
}

function isWorkbenchConversationRewindBoundaryDiagnostic(
  value: unknown
): value is WorkbenchConversationRewindBoundaryDiagnostic {
  return (
    isWorkbenchRecord(value) &&
    typeof value.code === "string" &&
    isWorkbenchConversationRewindBoundaryMissingFact(value.fact) &&
    typeof value.message === "string" &&
    typeof value.blocked === "boolean" &&
    (value.metadata === undefined || isWorkbenchRecord(value.metadata))
  );
}

function isWorkbenchConversationRewindApplyStepResult(
  value: unknown
): value is WorkbenchConversationRewindApplyStepResult {
  return (
    isWorkbenchRecord(value) &&
    (value.type === "cancel-runs" ||
      value.type === "clear-approvals" ||
      value.type === "restore-workspace" ||
      value.type === "move-session-leaf") &&
    (value.status === "applied" ||
      value.status === "deferred" ||
      value.status === "unsupported" ||
      value.status === "skipped" ||
      value.status === "failed")
  );
}

function isDaemonLifecycleDiagnostic(value: unknown): value is DaemonLifecycleDiagnostic {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.updatedAt === "string" &&
    isDaemonLifecycleDiagnosticSource(value.source) &&
    (value.severity === "warning" || value.severity === "error")
  );
}

function isDaemonLifecycleDiagnosticSource(value: unknown): value is DaemonLifecycleDiagnosticSource {
  return (
    value === "daemon" ||
    value === "websocket" ||
    value === "client" ||
    value === "event-store" ||
    value === "provider" ||
    value === "mcp"
  );
}

function isDaemonClientDisconnectSnapshot(value: unknown): value is DaemonClientDisconnectSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.clientId === "string" &&
    isFiniteNumber(value.code) &&
    typeof value.reason === "string" &&
    typeof value.connectedAt === "string" &&
    typeof value.disconnectedAt === "string" &&
    isFiniteNumber(value.durationMs)
  );
}

function isDaemonEventStoreStatusSnapshot(value: unknown): value is DaemonEventStoreStatusSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    (value.status === "ok" || value.status === "failed") &&
    typeof value.path === "string" &&
    (value.failure === undefined || isDaemonLifecycleDiagnostic(value.failure))
  );
}

function isWorkbenchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isActiveDaemonStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function isCompletedReason(reason: string | undefined): boolean {
  return reason === "completed" || reason === "goal-completed";
}

function isCancelledReason(reason: string | undefined): boolean {
  return reason === "cancelled" || reason === "aborted";
}

function isFailedReason(reason: string | undefined): boolean {
  return (
    reason === "goal-blocked" ||
    reason === "goal-max-rounds" ||
    reason === "goal-stalled" ||
    reason === "max-turns" ||
    reason === "agent-error" ||
    reason === "provider-error" ||
    reason === "runtime-error" ||
    reason === "intervention-required" ||
    reason === "run-engine-error"
  );
}

function createDefaultPlan(): WorkbenchPlanItem[] {
  return [
    {
      id: "understand",
      title: "理解目标和项目边界",
      state: "todo"
    },
    {
      id: "inspect",
      title: "检查相关文件和现有实现",
      state: "todo"
    },
    {
      id: "execute",
      title: "按计划执行并持续更新进度",
      state: "todo"
    },
    {
      id: "verify",
      title: "运行检查并汇总结论",
      state: "todo"
    }
  ];
}

function createDefaultAcceptance(): WorkbenchAcceptanceItem[] {
  return [
    {
      id: "scope-clear",
      title: "目标范围已经确认",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "changes-tracked",
      title: "重要变更有记录并可回退",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "checks-run",
      title: "必要检查已经运行",
      required: true,
      passed: false,
      evidenceIds: []
    },
    {
      id: "result-reviewed",
      title: "结果经过最终审查",
      required: true,
      passed: false,
      evidenceIds: []
    }
  ];
}

function projectNameFromPath(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "当前项目";
}
