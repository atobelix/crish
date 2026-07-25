import type { DaemonTaskSnapshot } from "./task-snapshot";
import type {
  DaemonPendingInputRecord,
  DaemonPendingInputQueuedResponse,
  DaemonPendingInputCancelledResponse,
  DaemonPendingInputDispatchedResponse,
  DaemonPendingInputsListedResponse,
} from "./daemon-session";
import type {
  WorkbenchSessionActionReceipt,
  WorkbenchSessionActionKind,
  WorkbenchSessionActionStatus,
  WorkbenchConversationRewindPreviewResult,
  WorkbenchConversationRewindAppliedResponse,
  WorkbenchConversationRewindPlan,
  WorkbenchConversationRewindBoundaryMissingFact,
  WorkbenchConversationRewindBoundaryDiagnostic,
  WorkbenchConversationRewindApplyStepResult,
  WorkbenchConversationRewindBoundaryTargetMode,
  WorkbenchSessionTreeEntry,
} from "./conversation-rewind";
import type {
  DaemonProviderStatusSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonLifecycleSnapshot,
  DaemonProviderReadiness,
  DaemonMcpReadiness,
  DaemonLifecycleState,
  DaemonLifecycleDiagnostic,
  DaemonLifecycleDiagnosticSource,
  DaemonClientDisconnectSnapshot,
  DaemonEventStoreStatusSnapshot,
} from "./daemon-status";

// --- Utility functions ---

export function isWorkbenchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function stringFromRecord(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function firstStringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

// --- Workbench session action guards ---

export function isWorkbenchSessionActionKind(value: unknown): value is WorkbenchSessionActionKind {
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

export function isWorkbenchSessionActionStatus(value: unknown): value is WorkbenchSessionActionStatus {
  return value === "pending" || value === "committed" || value === "rejected" || value === "failed";
}

export function isWorkbenchSessionActionReceipt(value: unknown): value is WorkbenchSessionActionReceipt {
  if (!isWorkbenchRecord(value)) return false;
  if (value.type !== undefined && value.type !== "session-action-receipt") return false;
  if (value.protocolVersion !== 1) return false;
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

// --- Daemon task snapshot guards ---

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

// --- Daemon pending input guards ---

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

// --- Conversation rewind guards ---

export function isWorkbenchConversationRewindBoundaryTargetMode(
  value: unknown
): value is WorkbenchConversationRewindBoundaryTargetMode {
  return value === "keep-user-message" || value === "remove-user-message";
}

export function isWorkbenchSessionTreeEntry(value: unknown): value is WorkbenchSessionTreeEntry {
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

export function isWorkbenchConversationRewindPlan(value: unknown): value is WorkbenchConversationRewindPlan {
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

export function isWorkbenchConversationRewindBoundaryMissingFact(
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

export function isWorkbenchConversationRewindBoundaryDiagnostic(
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

export function isWorkbenchConversationRewindApplyStepResult(
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

// --- Daemon status guards ---

export function isDaemonProviderReadiness(value: unknown): value is DaemonProviderReadiness {
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

export function isDaemonMcpReadiness(value: unknown): value is DaemonMcpReadiness {
  return (
    value === "ready" ||
    value === "degraded" ||
    value === "starting" ||
    value === "stopped" ||
    value === "unknown"
  );
}

export function isDaemonLifecycleState(value: unknown): value is DaemonLifecycleState {
  return (
    value === "starting" ||
    value === "ready" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "degraded"
  );
}

export function isDaemonLifecycleDiagnosticSource(value: unknown): value is DaemonLifecycleDiagnosticSource {
  return (
    value === "daemon" ||
    value === "websocket" ||
    value === "client" ||
    value === "event-store" ||
    value === "provider" ||
    value === "mcp"
  );
}

export function isDaemonLifecycleDiagnostic(value: unknown): value is DaemonLifecycleDiagnostic {
  if (!isWorkbenchRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.updatedAt === "string" &&
    isDaemonLifecycleDiagnosticSource(value.source) &&
    (value.severity === "warning" || value.severity === "error")
  );
}

export function isDaemonClientDisconnectSnapshot(value: unknown): value is DaemonClientDisconnectSnapshot {
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

export function isDaemonEventStoreStatusSnapshot(value: unknown): value is DaemonEventStoreStatusSnapshot {
  if (!isWorkbenchRecord(value)) return false;
  return (
    (value.status === "ok" || value.status === "failed") &&
    typeof value.path === "string" &&
    (value.failure === undefined || isDaemonLifecycleDiagnostic(value.failure))
  );
}

// --- Conversation rewind preview/applied guards ---

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

// --- Daemon status composite guards ---

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
