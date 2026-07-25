import type { JsonObject } from "@crish/shared-types";
import type { DaemonTaskSnapshot } from "./task-snapshot";

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
  metadata?: JsonObject;
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
  metadata?: JsonObject;
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
  detail?: JsonObject;
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
  outcomeDetail?: JsonObject;
  error?: string;
  kind?: "task" | "goal";
  goal?: DaemonGoalRunState;
  lastEventId?: string;
  metadata?: JsonObject;
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
  payload: JsonObject;
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


