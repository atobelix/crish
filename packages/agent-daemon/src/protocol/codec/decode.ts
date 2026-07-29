/**
 * Protocol Codec: Inbound Message Decoding & Validation
 */

import type { DaemonInboundMessage } from '../../types.js';
import {
  type ProtocolValidationResult,
  INBOUND_MESSAGE_TYPES,
  validateMessageBase,
  withMessageCorrelation,
} from '../validators/common.js';

import {
  validateRunTaskMessage,
  validateApproveToolMessage,
  validateDenyToolMessage,
  validateCancelRunMessage,
  validateRunControlMessage,
  validateStreamPauseMessage,
  validateStreamResumeMessage,
  validatePingMessage,
  validateListCapabilitiesMessage,
} from '../validators/run.js';
import {
  validateListRunsMessage,
  validateReadSessionEventsMessage,
  validateReadRunEventsMessage,
  validateGetRunSnapshotMessage,
  validateEnqueuePendingInputMessage,
  validateCancelPendingInputMessage,
  validateDispatchPendingInputMessage,
  validateListPendingInputsMessage,
} from '../validators/session-events.js';
import {
  validateGetStatusMessage,
} from "../validators/status.js";
import {
  validateUpdateConfigMessage,
  validateProbeProviderModelsMessage,
  validateProbeProviderChatMessage,
} from "../validators/provider.js";
import {
  validateListSessionsMessage,
} from "../validators/session.js";
import {
  validateListWorkflowsMessage,
  validateCreateWorkflowMessage,
  validateUpdateWorkflowMessage,
  validateDeleteWorkflowMessage,
  validateTriggerWorkflowMessage,
  validateListWorkflowRunsMessage,
} from '../validators/workflow.js';
import {
  validateGitStatusMessage,
  validateGitDiffMessage,
} from '../validators/git.js';
import {
  validateListPlanDocumentsMessage,
  validateCreatePlanDocumentMessage,
  validateCreateRequirementsAlignmentPlanMessage,
  validateGetPlanDocumentMessage,
  validatePatchPlanDocumentMessage,
  validateDeletePlanDocumentMessage,
} from '../validators/plan.js';
import {
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
  validateStartMcpServerMessage,
  validateStopMcpServerMessage,
  validateListMcpServersMessage,
  validateGetScopedContextMessage,
  validateUpsertScopedContextMessage,
  validateDeleteScopedContextMessage,
  validateResolveScopedContextMessage,
} from '../validators/background.js';
import {
  validateResolveConversationRewindBoundaryMessage,
  validatePreviewConversationRewindMessage,
  validatePreviewConversationRewindByBoundaryMessage,
  validateApplyConversationRewindMessage,
  validateApplySessionActionMessage,
} from '../validators/session-actions.js';
import {
  validateSendToSubagentMessage,
  validateGetSubagentStatusMessage,
} from '../validators/subagent.js';

export function validateInboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonInboundMessage> {
  const base = validateMessageBase(value, INBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case 'hello':
      return { ok: true, value: base.value as unknown as DaemonInboundMessage };
    case 'run-task':
      return withMessageCorrelation(
        base.value,
        validateRunTaskMessage(base.value)
      );
    case 'approve-tool':
      return withMessageCorrelation(
        base.value,
        validateApproveToolMessage(base.value)
      );
    case 'deny-tool':
      return withMessageCorrelation(
        base.value,
        validateDenyToolMessage(base.value)
      );
    case 'cancel-run':
      return withMessageCorrelation(
        base.value,
        validateCancelRunMessage(base.value)
      );
    case 'run-control':
      return withMessageCorrelation(
        base.value,
        validateRunControlMessage(base.value)
      );
    case 'stream-pause':
      return withMessageCorrelation(
        base.value,
        validateStreamPauseMessage(base.value)
      );
    case 'stream-resume':
      return withMessageCorrelation(
        base.value,
        validateStreamResumeMessage(base.value)
      );
    case 'ping':
      return withMessageCorrelation(
        base.value,
        validatePingMessage(base.value)
      );
    case 'get-status':
      return withMessageCorrelation(
        base.value,
        validateGetStatusMessage(base.value)
      );
    case 'list-capabilities':
      return withMessageCorrelation(
        base.value,
        validateListCapabilitiesMessage(base.value)
      );
    case 'update-config':
      return withMessageCorrelation(
        base.value,
        validateUpdateConfigMessage(base.value)
      );
    case 'list-sessions':
      return withMessageCorrelation(
        base.value,
        validateListSessionsMessage(base.value)
      );
    case 'list-runs':
      return withMessageCorrelation(
        base.value,
        validateListRunsMessage(base.value)
      );
    case 'read-session-events':
      return withMessageCorrelation(
        base.value,
        validateReadSessionEventsMessage(base.value)
      );
    case 'read-run-events':
      return withMessageCorrelation(
        base.value,
        validateReadRunEventsMessage(base.value)
      );
    case 'get-run-snapshot':
      return withMessageCorrelation(
        base.value,
        validateGetRunSnapshotMessage(base.value)
      );
    case 'enqueue-pending-input':
      return withMessageCorrelation(
        base.value,
        validateEnqueuePendingInputMessage(base.value)
      );
    case 'cancel-pending-input':
      return withMessageCorrelation(
        base.value,
        validateCancelPendingInputMessage(base.value)
      );
    case 'dispatch-pending-input':
      return withMessageCorrelation(
        base.value,
        validateDispatchPendingInputMessage(base.value)
      );
    case 'list-pending-inputs':
      return withMessageCorrelation(
        base.value,
        validateListPendingInputsMessage(base.value)
      );
    case 'list-workflows':
      return withMessageCorrelation(
        base.value,
        validateListWorkflowsMessage(base.value)
      );
    case 'create-workflow':
      return withMessageCorrelation(
        base.value,
        validateCreateWorkflowMessage(base.value)
      );
    case 'update-workflow':
      return withMessageCorrelation(
        base.value,
        validateUpdateWorkflowMessage(base.value)
      );
    case 'delete-workflow':
      return withMessageCorrelation(
        base.value,
        validateDeleteWorkflowMessage(base.value)
      );
    case 'trigger-workflow':
      return withMessageCorrelation(
        base.value,
        validateTriggerWorkflowMessage(base.value)
      );
    case 'list-workflow-runs':
      return withMessageCorrelation(
        base.value,
        validateListWorkflowRunsMessage(base.value)
      );
    case 'git-status':
      return withMessageCorrelation(
        base.value,
        validateGitStatusMessage(base.value)
      );
    case 'git-diff':
      return withMessageCorrelation(
        base.value,
        validateGitDiffMessage(base.value)
      );
    case 'list-plan-documents':
      return withMessageCorrelation(
        base.value,
        validateListPlanDocumentsMessage(base.value)
      );
    case 'create-plan-document':
      return withMessageCorrelation(
        base.value,
        validateCreatePlanDocumentMessage(base.value)
      );
    case 'create-requirements-alignment-plan':
      return withMessageCorrelation(
        base.value,
        validateCreateRequirementsAlignmentPlanMessage(base.value)
      );
    case 'get-plan-document':
      return withMessageCorrelation(
        base.value,
        validateGetPlanDocumentMessage(base.value)
      );
    case 'patch-plan-document':
      return withMessageCorrelation(
        base.value,
        validatePatchPlanDocumentMessage(base.value)
      );
    case 'delete-plan-document':
      return withMessageCorrelation(
        base.value,
        validateDeletePlanDocumentMessage(base.value)
      );
    case 'list-mutation-leases':
      return withMessageCorrelation(
        base.value,
        validateListMutationLeasesMessage(base.value)
      );
    case 'list-background-tasks':
      return withMessageCorrelation(
        base.value,
        validateListBackgroundTasksMessage(base.value)
      );
    case 'start-background-task':
      return withMessageCorrelation(
        base.value,
        validateStartBackgroundTaskMessage(base.value)
      );
    case 'cancel-background-task':
      return withMessageCorrelation(
        base.value,
        validateCancelBackgroundTaskMessage(base.value)
      );
    case 'get-background-task-history':
      return withMessageCorrelation(
        base.value,
        validateGetBackgroundTaskHistoryMessage(base.value)
      );
    case 'list-artifacts':
      return withMessageCorrelation(
        base.value,
        validateListArtifactsMessage(base.value)
      );
    case 'get-artifact-content':
      return withMessageCorrelation(
        base.value,
        validateGetArtifactContentMessage(base.value)
      );
    case 'list-memories':
      return withMessageCorrelation(
        base.value,
        validateListMemoriesMessage(base.value)
      );
    case 'delete-memory':
      return withMessageCorrelation(
        base.value,
        validateDeleteMemoryMessage(base.value)
      );
    case 'list-checkpoints':
      return withMessageCorrelation(
        base.value,
        validateListCheckpointsMessage(base.value)
      );
    case 'restore-checkpoint':
      return withMessageCorrelation(
        base.value,
        validateRestoreCheckpointMessage(base.value)
      );
    case 'get-checkpoint-diff':
      return withMessageCorrelation(
        base.value,
        validateGetCheckpointDiffMessage(base.value)
      );
    case 'resolve-conversation-rewind-boundary':
      return withMessageCorrelation(
        base.value,
        validateResolveConversationRewindBoundaryMessage(base.value)
      );
    case 'preview-conversation-rewind':
      return withMessageCorrelation(
        base.value,
        validatePreviewConversationRewindMessage(base.value)
      );
    case 'preview-conversation-rewind-by-boundary':
      return withMessageCorrelation(
        base.value,
        validatePreviewConversationRewindByBoundaryMessage(base.value)
      );
    case 'apply-conversation-rewind':
      return withMessageCorrelation(
        base.value,
        validateApplyConversationRewindMessage(base.value)
      );
    case 'apply-session-action':
      return withMessageCorrelation(
        base.value,
        validateApplySessionActionMessage(base.value)
      );
    case 'send-to-subagent':
      return withMessageCorrelation(
        base.value,
        validateSendToSubagentMessage(base.value)
      );
    case 'get-subagent-status':
      return withMessageCorrelation(
        base.value,
        validateGetSubagentStatusMessage(base.value)
      );
    case 'start-mcp-server':
      return withMessageCorrelation(
        base.value,
        validateStartMcpServerMessage(base.value)
      );
    case 'stop-mcp-server':
      return withMessageCorrelation(
        base.value,
        validateStopMcpServerMessage(base.value)
      );
    case 'list-mcp-servers':
      return withMessageCorrelation(
        base.value,
        validateListMcpServersMessage(base.value)
      );
    case 'get-scoped-context':
      return withMessageCorrelation(
        base.value,
        validateGetScopedContextMessage(base.value)
      );
    case 'upsert-scoped-context':
      return withMessageCorrelation(
        base.value,
        validateUpsertScopedContextMessage(base.value)
      );
    case 'delete-scoped-context':
      return withMessageCorrelation(
        base.value,
        validateDeleteScopedContextMessage(base.value)
      );
    case 'resolve-scoped-context':
      return withMessageCorrelation(
        base.value,
        validateResolveScopedContextMessage(base.value)
      );
    case 'probe-provider-models':
      return withMessageCorrelation(
        base.value,
        validateProbeProviderModelsMessage(base.value)
      );
    case 'probe-provider-chat':
      return withMessageCorrelation(
        base.value,
        validateProbeProviderChatMessage(base.value)
      );
  }
  return {
    ok: false,
    error: {
      code: 'UNKNOWN_MESSAGE_TYPE',
      message: `Unhandled message type: ${base.value.type}`,
      issues: [],
    },
  };
}
