/**
 * Protocol message dispatch — routes inbound/outbound messages to domain validators.
 *
 * This module imports validators from all domain schema files and provides
 * the public API: validateInboundMessage, validateOutboundMessage,
 * encodeOutboundMessage, and formatProtocolValidationError.
 */
import type { DaemonInboundMessage, DaemonOutboundMessage } from "../../types.js";
import {
  ProtocolValidationResult,
  ProtocolValidationError,
  INBOUND_MESSAGE_TYPES,
  OUTBOUND_MESSAGE_TYPES,
  UnknownRecord,
  ok,
  invalid,
  validateMessageBase,
  withMessageCorrelation,
} from "./schema-core.js";

// Domain validator imports — each domain file exports its message validators
import { validateRunTaskMessage, validateCancelRunMessage, validateListRunsMessage, validateReadRunEventsMessage, validateGetRunSnapshotMessage } from "./schema-runs.js";
import { validateApproveToolMessage, validateDenyToolMessage, validateListApprovalHistoryMessage, validateApprovalRequestedMessage, validateApprovalResolvedMessage, validateApprovalHistoryListedMessage } from "./schema-approvals.js";
import { validatePingMessage, validateGetStatusMessage, validateListCapabilitiesMessage, validateUpdateConfigMessage, validateDaemonReadyMessage, validateErrorMessage, validatePongMessage, validateStatusResponseMessage, validateCapabilitiesResponseMessage, validateConfigUpdatedMessage } from "./schema-daemon-lifecycle.js";
import { validateListSessionsMessage, validateReadSessionEventsMessage, validateSessionsListedMessage, validateRunsListedMessage, validateSessionEventsMessage, validateRunEventsMessage, validateRunSnapshotMessage } from "./schema-sessions.js";

// Remaining validators still in schema.ts (to be extracted gradually)
// These are imported from the main schema module
// We import the raw schema module for the remaining validators
import {
  validateEnqueuePendingInputMessage,
  validateCancelPendingInputMessage,
  validateDispatchPendingInputMessage,
  validateListPendingInputsMessage,
  validateGetMetricsMessage,
  validateGetMetricsSnapshotMessage,
  validateEventMessage,
  validateListWorkflowsMessage,
  validateCreateWorkflowMessage,
  validateUpdateWorkflowMessage,
  validateDeleteWorkflowMessage,
  validateTriggerWorkflowMessage,
  validateListWorkflowRunsMessage,
  validateGitStatusMessage,
  validateGitDiffMessage,
  validateListPlanDocumentsMessage,
  validateCreatePlanDocumentMessage,
  validateCreateRequirementsAlignmentPlanMessage,
  validateGetPlanDocumentMessage,
  validatePatchPlanDocumentMessage,
  validateDeletePlanDocumentMessage,
  validateListMutationLeasesMessage,
  validateListBackgroundTasksMessage,
  validateStartBackgroundTaskMessage,
  validateCancelBackgroundTaskMessage,
  validateGetBackgroundTaskHistoryMessage,
  validateListArtifactsMessage,
  validateGetArtifactContentMessage,
  validateListMemoriesMessage,
  validateDeleteMemoryMessage,
  validateListCheckpointsMessage,
  validateRestoreCheckpointMessage,
  validateGetCheckpointDiffMessage,
  validatePreviewConversationRewindMessage,
  validateResolveConversationRewindBoundaryMessage,
  validatePreviewConversationRewindByBoundaryMessage,
  validateApplyConversationRewindMessage,
  validateApplySessionActionMessage,
  validateSendToSubagentMessage,
  validateGetSubagentStatusMessage,
  validateStartMcpServerMessage,
  validateStopMcpServerMessage,
  validateListMcpServersMessage,
  validateGetScopedContextMessage,
  validateUpsertScopedContextMessage,
  validateDeleteScopedContextMessage,
  validateResolveScopedContextMessage,
  // Outbound validators
  validatePendingInputQueuedMessage,
  validatePendingInputCancelledMessage,
  validatePendingInputDispatchedMessage,
  validatePendingInputsListedMessage,
  validateMetricsResponseMessage,
  validateWorkflowsListedMessage,
  validateWorkflowCreatedMessage,
  validateWorkflowUpdatedMessage,
  validateWorkflowDeletedMessage,
  validateWorkflowTriggeredMessage,
  validateWorkflowRunUpdatedMessage,
  validateWorkflowRunsListedMessage,
  validateGitStatusResponseMessage,
  validateGitDiffResponseMessage,
  validatePlanDocumentsListedMessage,
  validatePlanDocumentCreatedMessage,
  validatePlanDocumentMessage,
  validatePlanDocumentPatchedMessage,
  validatePlanDocumentDeletedMessage,
  validateMutationLeasesListedMessage,
  validateBackgroundTasksListedMessage,
  validateBackgroundTaskHistoryMessage,
  validateBackgroundTaskStartedMessage,
  validateBackgroundTaskCancelledMessage,
  validateArtifactsListedMessage,
  validateArtifactContentMessage,
  validateMemoriesListedMessage,
  validateMemoryDeletedMessage,
  validateCheckpointsListedMessage,
  validateCheckpointDiffMessage,
  validateCheckpointRestoredMessage,
  validateConversationRewindPreviewMessage,
  validateConversationRewindBoundaryMessage,
  validateConversationRewindAppliedMessage,
  validateSessionActionReceiptMessage,
  validateSubagentStartedMessage,
  validateSubagentEndedMessage,
  validateSubagentEventMessage,
  validateSubagentMessageSentMessage,
  validateSubagentStatusMessage,
  validateMcpServersListedMessage,
  validateMcpServerStartedMessage,
  validateMcpServerStoppedMessage,
  validateScopedContextResponseMessage,
  validateScopedContextUpsertedMessage,
  validateScopedContextDeletedMessage,
  validateScopedContextResolvedMessage,
} from "../schema.js";

// ─── Dispatch functions ────────────────────────────────────────

export function validateInboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonInboundMessage> {
  const base = validateMessageBase(value, INBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case "run-task":
      return withMessageCorrelation(base.value, validateRunTaskMessage(base.value));
    case "approve-tool":
      return withMessageCorrelation(base.value, validateApproveToolMessage(base.value));
    case "deny-tool":
      return withMessageCorrelation(base.value, validateDenyToolMessage(base.value));
    case "list-approval-history":
      return withMessageCorrelation(base.value, validateListApprovalHistoryMessage(base.value));
    case "cancel-run":
      return withMessageCorrelation(base.value, validateCancelRunMessage(base.value));
    case "ping":
      return withMessageCorrelation(base.value, validatePingMessage(base.value));
    case "get-status":
      return withMessageCorrelation(base.value, validateGetStatusMessage(base.value));
    case "list-capabilities":
      return withMessageCorrelation(base.value, validateListCapabilitiesMessage(base.value));
    case "update-config":
      return withMessageCorrelation(base.value, validateUpdateConfigMessage(base.value));
    case "list-sessions":
      return withMessageCorrelation(base.value, validateListSessionsMessage(base.value));
    case "list-runs":
      return withMessageCorrelation(base.value, validateListRunsMessage(base.value));
    case "read-session-events":
      return withMessageCorrelation(base.value, validateReadSessionEventsMessage(base.value));
    case "read-run-events":
      return withMessageCorrelation(base.value, validateReadRunEventsMessage(base.value));
    case "get-run-snapshot":
      return withMessageCorrelation(base.value, validateGetRunSnapshotMessage(base.value));
    case "enqueue-pending-input":
      return withMessageCorrelation(base.value, validateEnqueuePendingInputMessage(base.value));
    case "cancel-pending-input":
      return withMessageCorrelation(base.value, validateCancelPendingInputMessage(base.value));
    case "dispatch-pending-input":
      return withMessageCorrelation(base.value, validateDispatchPendingInputMessage(base.value));
    case "list-pending-inputs":
      return withMessageCorrelation(base.value, validateListPendingInputsMessage(base.value));
    case "get-metrics":
      return withMessageCorrelation(base.value, validateGetMetricsMessage(base.value));
    case "get-metrics-snapshot":
      return withMessageCorrelation(base.value, validateGetMetricsSnapshotMessage(base.value));
    case "list-workflows":
      return withMessageCorrelation(base.value, validateListWorkflowsMessage(base.value));
    case "create-workflow":
      return withMessageCorrelation(base.value, validateCreateWorkflowMessage(base.value));
    case "update-workflow":
      return withMessageCorrelation(base.value, validateUpdateWorkflowMessage(base.value));
    case "delete-workflow":
      return withMessageCorrelation(base.value, validateDeleteWorkflowMessage(base.value));
    case "trigger-workflow":
      return withMessageCorrelation(base.value, validateTriggerWorkflowMessage(base.value));
    case "list-workflow-runs":
      return withMessageCorrelation(base.value, validateListWorkflowRunsMessage(base.value));
    case "git-status":
      return withMessageCorrelation(base.value, validateGitStatusMessage(base.value));
    case "git-diff":
      return withMessageCorrelation(base.value, validateGitDiffMessage(base.value));
    case "list-plan-documents":
      return withMessageCorrelation(base.value, validateListPlanDocumentsMessage(base.value));
    case "create-plan-document":
      return withMessageCorrelation(base.value, validateCreatePlanDocumentMessage(base.value));
    case "create-requirements-alignment-plan":
      return withMessageCorrelation(base.value, validateCreateRequirementsAlignmentPlanMessage(base.value));
    case "get-plan-document":
      return withMessageCorrelation(base.value, validateGetPlanDocumentMessage(base.value));
    case "patch-plan-document":
      return withMessageCorrelation(base.value, validatePatchPlanDocumentMessage(base.value));
    case "delete-plan-document":
      return withMessageCorrelation(base.value, validateDeletePlanDocumentMessage(base.value));
    case "list-mutation-leases":
      return withMessageCorrelation(base.value, validateListMutationLeasesMessage(base.value));
    case "list-background-tasks":
      return withMessageCorrelation(base.value, validateListBackgroundTasksMessage(base.value));
    case "start-background-task":
      return withMessageCorrelation(base.value, validateStartBackgroundTaskMessage(base.value));
    case "cancel-background-task":
      return withMessageCorrelation(base.value, validateCancelBackgroundTaskMessage(base.value));
    case "get-background-task-history":
      return withMessageCorrelation(base.value, validateGetBackgroundTaskHistoryMessage(base.value));
    case "list-artifacts":
      return withMessageCorrelation(base.value, validateListArtifactsMessage(base.value));
    case "get-artifact-content":
      return withMessageCorrelation(base.value, validateGetArtifactContentMessage(base.value));
    case "list-memories":
      return withMessageCorrelation(base.value, validateListMemoriesMessage(base.value));
    case "delete-memory":
      return withMessageCorrelation(base.value, validateDeleteMemoryMessage(base.value));
    case "list-checkpoints":
      return withMessageCorrelation(base.value, validateListCheckpointsMessage(base.value));
    case "restore-checkpoint":
      return withMessageCorrelation(base.value, validateRestoreCheckpointMessage(base.value));
    case "get-checkpoint-diff":
      return withMessageCorrelation(base.value, validateGetCheckpointDiffMessage(base.value));
    case "resolve-conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateResolveConversationRewindBoundaryMessage(base.value));
    case "preview-conversation-rewind":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindMessage(base.value));
    case "preview-conversation-rewind-by-boundary":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindByBoundaryMessage(base.value));
    case "apply-conversation-rewind":
      return withMessageCorrelation(base.value, validateApplyConversationRewindMessage(base.value));
    case "apply-session-action":
      return withMessageCorrelation(base.value, validateApplySessionActionMessage(base.value));
    case "send-to-subagent":
      return withMessageCorrelation(base.value, validateSendToSubagentMessage(base.value));
    case "get-subagent-status":
      return withMessageCorrelation(base.value, validateGetSubagentStatusMessage(base.value));
    case "start-mcp-server":
      return withMessageCorrelation(base.value, validateStartMcpServerMessage(base.value));
    case "stop-mcp-server":
      return withMessageCorrelation(base.value, validateStopMcpServerMessage(base.value));
    case "list-mcp-servers":
      return withMessageCorrelation(base.value, validateListMcpServersMessage(base.value));
    case "get-scoped-context":
      return withMessageCorrelation(base.value, validateGetScopedContextMessage(base.value));
    case "upsert-scoped-context":
      return withMessageCorrelation(base.value, validateUpsertScopedContextMessage(base.value));
    case "delete-scoped-context":
      return withMessageCorrelation(base.value, validateDeleteScopedContextMessage(base.value));
    case "resolve-scoped-context":
      return withMessageCorrelation(base.value, validateResolveScopedContextMessage(base.value));
    default:
      return invalid("Unknown message type", [{ path: "$.type", message: `Unsupported message type: ${(base.value as UnknownRecord).type}` }]);
  }
}

export function validateOutboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonOutboundMessage> {
  const base = validateMessageBase(value, OUTBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case "daemon-ready":
      return withMessageCorrelation(base.value, validateDaemonReadyMessage(base.value));
    case "event":
      return withMessageCorrelation(base.value, validateEventMessage(base.value));
    case "approval-requested":
      return withMessageCorrelation(base.value, validateApprovalRequestedMessage(base.value));
    case "approval-resolved":
      return withMessageCorrelation(base.value, validateApprovalResolvedMessage(base.value));
    case "approval-history-listed":
      return withMessageCorrelation(base.value, validateApprovalHistoryListedMessage(base.value));
    case "error":
      return withMessageCorrelation(base.value, validateErrorMessage(base.value));
    case "pong":
      return withMessageCorrelation(base.value, validatePongMessage(base.value));
    case "status-response":
      return withMessageCorrelation(base.value, validateStatusResponseMessage(base.value));
    case "capabilities-response":
      return withMessageCorrelation(base.value, validateCapabilitiesResponseMessage(base.value));
    case "config-updated":
      return withMessageCorrelation(base.value, validateConfigUpdatedMessage(base.value));
    case "subagent-started":
      return withMessageCorrelation(base.value, validateSubagentStartedMessage(base.value));
    case "subagent-ended":
      return withMessageCorrelation(base.value, validateSubagentEndedMessage(base.value));
    case "subagent-event":
      return withMessageCorrelation(base.value, validateSubagentEventMessage(base.value));
    case "sessions-listed":
      return withMessageCorrelation(base.value, validateSessionsListedMessage(base.value));
    case "runs-listed":
      return withMessageCorrelation(base.value, validateRunsListedMessage(base.value));
    case "session-events":
      return withMessageCorrelation(base.value, validateSessionEventsMessage(base.value));
    case "run-events":
      return withMessageCorrelation(base.value, validateRunEventsMessage(base.value));
    case "run-snapshot":
      return withMessageCorrelation(base.value, validateRunSnapshotMessage(base.value));
    case "pending-input-queued":
      return withMessageCorrelation(base.value, validatePendingInputQueuedMessage(base.value));
    case "pending-input-cancelled":
      return withMessageCorrelation(base.value, validatePendingInputCancelledMessage(base.value));
    case "pending-input-dispatched":
      return withMessageCorrelation(base.value, validatePendingInputDispatchedMessage(base.value));
    case "pending-inputs-listed":
      return withMessageCorrelation(base.value, validatePendingInputsListedMessage(base.value));
    case "metrics-response":
      return withMessageCorrelation(base.value, validateMetricsResponseMessage(base.value));
    case "workflows-listed":
      return withMessageCorrelation(base.value, validateWorkflowsListedMessage(base.value));
    case "workflow-created":
      return withMessageCorrelation(base.value, validateWorkflowCreatedMessage(base.value));
    case "workflow-updated":
      return withMessageCorrelation(base.value, validateWorkflowUpdatedMessage(base.value));
    case "workflow-deleted":
      return withMessageCorrelation(base.value, validateWorkflowDeletedMessage(base.value));
    case "workflow-triggered":
      return withMessageCorrelation(base.value, validateWorkflowTriggeredMessage(base.value));
    case "workflow-run-updated":
      return withMessageCorrelation(base.value, validateWorkflowRunUpdatedMessage(base.value));
    case "workflow-runs-listed":
      return withMessageCorrelation(base.value, validateWorkflowRunsListedMessage(base.value));
    case "git-status-response":
      return withMessageCorrelation(base.value, validateGitStatusResponseMessage(base.value));
    case "git-diff-response":
      return withMessageCorrelation(base.value, validateGitDiffResponseMessage(base.value));
    case "plan-documents-listed":
      return withMessageCorrelation(base.value, validatePlanDocumentsListedMessage(base.value));
    case "plan-document-created":
      return withMessageCorrelation(base.value, validatePlanDocumentCreatedMessage(base.value));
    case "plan-document":
      return withMessageCorrelation(base.value, validatePlanDocumentMessage(base.value));
    case "plan-document-patched":
      return withMessageCorrelation(base.value, validatePlanDocumentPatchedMessage(base.value));
    case "plan-document-deleted":
      return withMessageCorrelation(base.value, validatePlanDocumentDeletedMessage(base.value));
    case "mutation-leases-listed":
      return withMessageCorrelation(base.value, validateMutationLeasesListedMessage(base.value));
    case "background-tasks-listed":
      return withMessageCorrelation(base.value, validateBackgroundTasksListedMessage(base.value));
    case "background-task-started":
      return withMessageCorrelation(base.value, validateBackgroundTaskStartedMessage(base.value));
    case "background-task-cancelled":
      return withMessageCorrelation(base.value, validateBackgroundTaskCancelledMessage(base.value));
    case "background-task-history":
      return withMessageCorrelation(base.value, validateBackgroundTaskHistoryMessage(base.value));
    case "artifacts-listed":
      return withMessageCorrelation(base.value, validateArtifactsListedMessage(base.value));
    case "artifact-content":
      return withMessageCorrelation(base.value, validateArtifactContentMessage(base.value));
    case "memories-listed":
      return withMessageCorrelation(base.value, validateMemoriesListedMessage(base.value));
    case "memory-deleted":
      return withMessageCorrelation(base.value, validateMemoryDeletedMessage(base.value));
    case "checkpoints-listed":
      return withMessageCorrelation(base.value, validateCheckpointsListedMessage(base.value));
    case "checkpoint-diff":
      return withMessageCorrelation(base.value, validateCheckpointDiffMessage(base.value));
    case "checkpoint-restored":
      return withMessageCorrelation(base.value, validateCheckpointRestoredMessage(base.value));
    case "conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateConversationRewindBoundaryMessage(base.value));
    case "conversation-rewind-preview":
      return withMessageCorrelation(base.value, validateConversationRewindPreviewMessage(base.value));
    case "conversation-rewind-applied":
      return withMessageCorrelation(base.value, validateConversationRewindAppliedMessage(base.value));
    case "session-action-receipt":
      return withMessageCorrelation(base.value, validateSessionActionReceiptMessage(base.value));
    case "subagent-message-sent":
      return withMessageCorrelation(base.value, validateSubagentMessageSentMessage(base.value));
    case "subagent-status":
      return withMessageCorrelation(base.value, validateSubagentStatusMessage(base.value));
    case "mcp-servers-listed":
      return withMessageCorrelation(base.value, validateMcpServersListedMessage(base.value));
    case "mcp-server-started":
      return withMessageCorrelation(base.value, validateMcpServerStartedMessage(base.value));
    case "mcp-server-stopped":
      return withMessageCorrelation(base.value, validateMcpServerStoppedMessage(base.value));
    case "scoped-context-response":
      return withMessageCorrelation(base.value, validateScopedContextResponseMessage(base.value));
    case "scoped-context-upserted":
      return withMessageCorrelation(base.value, validateScopedContextUpsertedMessage(base.value));
    case "scoped-context-deleted":
      return withMessageCorrelation(base.value, validateScopedContextDeletedMessage(base.value));
    case "scoped-context-resolved":
      return withMessageCorrelation(base.value, validateScopedContextResolvedMessage(base.value));
    default:
      return invalid("Unknown message type", [{ path: "$.type", message: `Unsupported outbound message type: ${(base.value as UnknownRecord).type}` }]);
  }
}

export function encodeOutboundMessage(
  message: DaemonOutboundMessage
): ProtocolValidationResult<string> {
  let payload: string;

  try {
    payload = JSON.stringify(message);
  } catch (error) {
    return invalid("Outbound message is not JSON serializable", [
      {
        path: "$",
        message: (error as Error).message,
      },
    ]);
  }

  if (payload === undefined) {
    return invalid("Outbound message is not JSON serializable", [
      { path: "$", message: "JSON.stringify returned undefined" },
    ]);
  }

  const validation = validateOutboundMessage(JSON.parse(payload));
  if (!validation.ok) return validation;

  return ok(payload);
}

export function formatProtocolValidationError(
  error: ProtocolValidationError
): string {
  const issueSummary = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");

  if (!issueSummary) return error.message;

  const suffix = error.issues.length > 3 ? " ..." : "";
  return `${error.message}: ${issueSummary}${suffix}`;
}
