/**
 * Protocol Codec: Outbound Message Encoding & Validation
 */

import type { DaemonOutboundMessage } from '../../types.js';
import {
  type ProtocolValidationResult,
  OUTBOUND_MESSAGE_TYPES,
  validateMessageBase,
  withMessageCorrelation,
  invalid,
  ok,
} from '../validators/common.js';

import {
  validateDaemonReadyMessage,
  validateEventMessage,
  validateApprovalRequestedMessage,
  validateApprovalResolvedMessage,
  validateErrorMessage,
  validatePongMessage,
} from '../validators/run.js';
import {
  validateRunsListedMessage,
  validateSessionEventsMessage,
  validateRunEventsMessage,
  validateRunSnapshotMessage,
  validatePendingInputQueuedMessage,
  validatePendingInputCancelledMessage,
  validatePendingInputDispatchedMessage,
  validatePendingInputsListedMessage,
} from '../validators/session-events.js';
import {
  validateStatusResponseMessage,
  validateCapabilitiesResponseMessage,
} from "../validators/status.js";
import {
  validateConfigUpdatedMessage,
  validateProviderModelsProbedMessage,
  validateProviderChatProbedMessage,
} from "../validators/provider.js";
import {
  validateSessionsListedMessage,
} from "../validators/session.js";
import {
  validateWorkflowsListedMessage,
  validateWorkflowCreatedMessage,
  validateWorkflowUpdatedMessage,
  validateWorkflowDeletedMessage,
  validateWorkflowTriggeredMessage,
  validateWorkflowRunUpdatedMessage,
  validateWorkflowRunsListedMessage,
} from '../validators/workflow.js';
import {
  validateGitStatusResponseMessage,
  validateGitDiffResponseMessage,
} from '../validators/git.js';
import {
  validatePlanDocumentsListedMessage,
  validatePlanDocumentCreatedMessage,
  validatePlanDocumentMessage,
  validatePlanDocumentPatchedMessage,
  validatePlanDocumentDeletedMessage,
} from '../validators/plan.js';
import {
  validateMutationLeasesListedMessage,
  validateBackgroundTasksListedMessage,
  validateBackgroundTaskStartedMessage,
  validateBackgroundTaskCancelledMessage,
  validateBackgroundTaskHistoryMessage,
  validateArtifactsListedMessage,
  validateArtifactContentMessage,
  validateMemoriesListedMessage,
  validateMemoryDeletedMessage,
  validateCheckpointsListedMessage,
  validateCheckpointDiffMessage,
  validateCheckpointRestoredMessage,
  validateMcpServersListedMessage,
  validateMcpServerStartedMessage,
  validateMcpServerStoppedMessage,
  validateScopedContextResponseMessage,
  validateScopedContextUpsertedMessage,
  validateScopedContextDeletedMessage,
  validateScopedContextResolvedMessage,
} from '../validators/background.js';
import {
  validateConversationRewindBoundaryMessage,
  validateConversationRewindPreviewMessage,
  validateConversationRewindAppliedMessage,
  validateSessionActionReceiptMessage,
} from '../validators/session-actions.js';
import {
  validateSubagentStartedMessage,
  validateSubagentEndedMessage,
  validateSubagentEventMessage,
  validateSubagentMessageSentMessage,
  validateSubagentStatusMessage,
} from '../validators/subagent.js';

export function validateOutboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonOutboundMessage> {
  const base = validateMessageBase(value, OUTBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case 'daemon-ready':
      return withMessageCorrelation(
        base.value,
        validateDaemonReadyMessage(base.value)
      );
    case 'event':
      return withMessageCorrelation(
        base.value,
        validateEventMessage(base.value)
      );
    case 'approval-requested':
      return withMessageCorrelation(
        base.value,
        validateApprovalRequestedMessage(base.value)
      );
    case 'approval-resolved':
      return withMessageCorrelation(
        base.value,
        validateApprovalResolvedMessage(base.value)
      );
    case 'error':
      return withMessageCorrelation(
        base.value,
        validateErrorMessage(base.value)
      );
    case 'pong':
      return withMessageCorrelation(
        base.value,
        validatePongMessage(base.value)
      );
    case 'status-response':
      return withMessageCorrelation(
        base.value,
        validateStatusResponseMessage(base.value)
      );
    case 'capabilities-response':
      return withMessageCorrelation(
        base.value,
        validateCapabilitiesResponseMessage(base.value)
      );
    case 'config-updated':
      return withMessageCorrelation(
        base.value,
        validateConfigUpdatedMessage(base.value)
      );
    case 'subagent-started':
      return withMessageCorrelation(
        base.value,
        validateSubagentStartedMessage(base.value)
      );
    case 'subagent-ended':
      return withMessageCorrelation(
        base.value,
        validateSubagentEndedMessage(base.value)
      );
    case 'subagent-event':
      return withMessageCorrelation(
        base.value,
        validateSubagentEventMessage(base.value)
      );
    case 'sessions-listed':
      return withMessageCorrelation(
        base.value,
        validateSessionsListedMessage(base.value)
      );
    case 'runs-listed':
      return withMessageCorrelation(
        base.value,
        validateRunsListedMessage(base.value)
      );
    case 'session-events':
      return withMessageCorrelation(
        base.value,
        validateSessionEventsMessage(base.value)
      );
    case 'run-events':
      return withMessageCorrelation(
        base.value,
        validateRunEventsMessage(base.value)
      );
    case 'run-snapshot':
      return withMessageCorrelation(
        base.value,
        validateRunSnapshotMessage(base.value)
      );
    case 'pending-input-queued':
      return withMessageCorrelation(
        base.value,
        validatePendingInputQueuedMessage(base.value)
      );
    case 'pending-input-cancelled':
      return withMessageCorrelation(
        base.value,
        validatePendingInputCancelledMessage(base.value)
      );
    case 'pending-input-dispatched':
      return withMessageCorrelation(
        base.value,
        validatePendingInputDispatchedMessage(base.value)
      );
    case 'pending-inputs-listed':
      return withMessageCorrelation(
        base.value,
        validatePendingInputsListedMessage(base.value)
      );
    case 'workflows-listed':
      return withMessageCorrelation(
        base.value,
        validateWorkflowsListedMessage(base.value)
      );
    case 'workflow-created':
      return withMessageCorrelation(
        base.value,
        validateWorkflowCreatedMessage(base.value)
      );
    case 'workflow-updated':
      return withMessageCorrelation(
        base.value,
        validateWorkflowUpdatedMessage(base.value)
      );
    case 'workflow-deleted':
      return withMessageCorrelation(
        base.value,
        validateWorkflowDeletedMessage(base.value)
      );
    case 'workflow-triggered':
      return withMessageCorrelation(
        base.value,
        validateWorkflowTriggeredMessage(base.value)
      );
    case 'workflow-run-updated':
      return withMessageCorrelation(
        base.value,
        validateWorkflowRunUpdatedMessage(base.value)
      );
    case 'workflow-runs-listed':
      return withMessageCorrelation(
        base.value,
        validateWorkflowRunsListedMessage(base.value)
      );
    case 'git-status-response':
      return withMessageCorrelation(
        base.value,
        validateGitStatusResponseMessage(base.value)
      );
    case 'git-diff-response':
      return withMessageCorrelation(
        base.value,
        validateGitDiffResponseMessage(base.value)
      );
    case 'plan-documents-listed':
      return withMessageCorrelation(
        base.value,
        validatePlanDocumentsListedMessage(base.value)
      );
    case 'plan-document-created':
      return withMessageCorrelation(
        base.value,
        validatePlanDocumentCreatedMessage(base.value)
      );
    case 'plan-document':
      return withMessageCorrelation(
        base.value,
        validatePlanDocumentMessage(base.value)
      );
    case 'plan-document-patched':
      return withMessageCorrelation(
        base.value,
        validatePlanDocumentPatchedMessage(base.value)
      );
    case 'plan-document-deleted':
      return withMessageCorrelation(
        base.value,
        validatePlanDocumentDeletedMessage(base.value)
      );
    case 'mutation-leases-listed':
      return withMessageCorrelation(
        base.value,
        validateMutationLeasesListedMessage(base.value)
      );
    case 'background-tasks-listed':
      return withMessageCorrelation(
        base.value,
        validateBackgroundTasksListedMessage(base.value)
      );
    case 'background-task-started':
      return withMessageCorrelation(
        base.value,
        validateBackgroundTaskStartedMessage(base.value)
      );
    case 'background-task-cancelled':
      return withMessageCorrelation(
        base.value,
        validateBackgroundTaskCancelledMessage(base.value)
      );
    case 'background-task-history':
      return withMessageCorrelation(
        base.value,
        validateBackgroundTaskHistoryMessage(base.value)
      );
    case 'artifacts-listed':
      return withMessageCorrelation(
        base.value,
        validateArtifactsListedMessage(base.value)
      );
    case 'artifact-content':
      return withMessageCorrelation(
        base.value,
        validateArtifactContentMessage(base.value)
      );
    case 'memories-listed':
      return withMessageCorrelation(
        base.value,
        validateMemoriesListedMessage(base.value)
      );
    case 'memory-deleted':
      return withMessageCorrelation(
        base.value,
        validateMemoryDeletedMessage(base.value)
      );
    case 'checkpoints-listed':
      return withMessageCorrelation(
        base.value,
        validateCheckpointsListedMessage(base.value)
      );
    case 'checkpoint-diff':
      return withMessageCorrelation(
        base.value,
        validateCheckpointDiffMessage(base.value)
      );
    case 'checkpoint-restored':
      return withMessageCorrelation(
        base.value,
        validateCheckpointRestoredMessage(base.value)
      );
    case 'conversation-rewind-boundary':
      return withMessageCorrelation(
        base.value,
        validateConversationRewindBoundaryMessage(base.value)
      );
    case 'conversation-rewind-preview':
      return withMessageCorrelation(
        base.value,
        validateConversationRewindPreviewMessage(base.value)
      );
    case 'conversation-rewind-applied':
      return withMessageCorrelation(
        base.value,
        validateConversationRewindAppliedMessage(base.value)
      );
    case 'session-action-receipt':
      return withMessageCorrelation(
        base.value,
        validateSessionActionReceiptMessage(base.value)
      );
    case 'subagent-message-sent':
      return withMessageCorrelation(
        base.value,
        validateSubagentMessageSentMessage(base.value)
      );
    case 'subagent-status':
      return withMessageCorrelation(
        base.value,
        validateSubagentStatusMessage(base.value)
      );
    case 'mcp-servers-listed':
      return withMessageCorrelation(
        base.value,
        validateMcpServersListedMessage(base.value)
      );
    case 'mcp-server-started':
      return withMessageCorrelation(
        base.value,
        validateMcpServerStartedMessage(base.value)
      );
    case 'mcp-server-stopped':
      return withMessageCorrelation(
        base.value,
        validateMcpServerStoppedMessage(base.value)
      );
    case 'scoped-context-response':
      return withMessageCorrelation(
        base.value,
        validateScopedContextResponseMessage(base.value)
      );
    case 'scoped-context-upserted':
      return withMessageCorrelation(
        base.value,
        validateScopedContextUpsertedMessage(base.value)
      );
    case 'scoped-context-deleted':
      return withMessageCorrelation(
        base.value,
        validateScopedContextDeletedMessage(base.value)
      );
    case 'welcome':
      return {
        ok: true,
        value: base.value as unknown as DaemonOutboundMessage,
      };
    case 'scoped-context-resolved':
      return withMessageCorrelation(
        base.value,
        validateScopedContextResolvedMessage(base.value)
      );
    case 'provider-models-probed':
      return withMessageCorrelation(
        base.value,
        validateProviderModelsProbedMessage(base.value)
      );
    case 'provider-chat-probed':
      return withMessageCorrelation(
        base.value,
        validateProviderChatProbedMessage(base.value)
      );
  }
  return {
    ok: false,
    error: {
      code: 'UNKNOWN_MESSAGE_TYPE',
      message: `Unhandled outbound message type: ${base.value.type}`,
      issues: [],
    },
  };
}

export function encodeOutboundMessage(
  message: DaemonOutboundMessage
): ProtocolValidationResult<string> {
  const validation = validateOutboundMessage(message);
  if (!validation.ok) return validation;

  let payload: string;

  try {
    payload = JSON.stringify(message);
  } catch (error) {
    return invalid('Outbound message is not JSON serializable', [
      {
        path: '$',
        message: (error as Error).message,
      },
    ]);
  }

  if (payload === undefined) {
    return invalid('Outbound message is not JSON serializable', [
      { path: '$', message: 'JSON.stringify returned undefined' },
    ]);
  }

  return ok(payload);
}
