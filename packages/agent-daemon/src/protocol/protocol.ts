// Protocol source guard: register message types and capability groups before
// adding validators here. Registry tests keep allowlists, groups, and switch
// cases aligned so schema.ts does not become a second independent protocol map.
//
// This file is the stable public facade. Validator implementations live under
// ./validators/ by message family; codec functions live under ./protocol-codec.js;
// protocol types live under ./protocol-types.js.
// Do not change validation logic when moving code.
//
// ── 四端同步清单（新增消息类型时需同步修改以下 4 处） ──
// 1. registry.ts        → DAEMON_INBOUND_MESSAGE_TYPES / DAEMON_OUTBOUND_MESSAGE_TYPES
// 2. validators/<file>.ts → 实现 validateXxxMessage 函数
// 3. protocol.ts         → switch case + re-export 新 validator
// 4. server-handlers.ts   → handleInboundMessage 中新增 case（仅 inbound）

export type {
  ProtocolValidationErrorCode,
  ProtocolValidationIssue,
  ProtocolValidationError,
  ProtocolValidationResult,
} from './protocol-types.js';

export {
  validateInboundMessage,
  validateOutboundMessage,
  encodeOutboundMessage,
  formatProtocolValidationError,
} from './protocol-codec.js';

export {
  INBOUND_MESSAGE_TYPES,
  OUTBOUND_MESSAGE_TYPES,
  validateMessageBase,
  validateOptionalNullableString,
} from './validators/common.js';

export {
  validateRunTaskMessage,
  validateApproveToolMessage,
  validateDenyToolMessage,
  validateCancelRunMessage,
  validateRunControlMessage,
  validateStreamPauseMessage,
  validateStreamResumeMessage,
  validatePingMessage,
  validateListCapabilitiesMessage,
  validateDaemonReadyMessage,
  validateEventMessage,
  validateApprovalRequestedMessage,
  validateApprovalResolvedMessage,
  validateErrorMessage,
  validatePongMessage,
} from './validators/run.js';

export {
  validateListRunsMessage,
  validateReadSessionEventsMessage,
  validateReadRunEventsMessage,
  validateGetRunSnapshotMessage,
  validateEnqueuePendingInputMessage,
  validateCancelPendingInputMessage,
  validateDispatchPendingInputMessage,
  validateListPendingInputsMessage,
  validateRunsListedMessage,
  validateSessionEventsMessage,
  validateRunEventsMessage,
  validateRunSnapshotMessage,
  validatePendingInputQueuedMessage,
  validatePendingInputCancelledMessage,
  validatePendingInputDispatchedMessage,
  validatePendingInputsListedMessage,
  validatePendingInputRecord,
  validateRunRecord,
  validateGoalRunState,
  validateGoalContinuationDecision,
  validateOrchestratorEvent,
  validateAgentEvent,
  validateTaskSnapshot,
  validateTaskMessage,
  validateTaskToolCall,
  validateTaskApproval,
  validateTaskProgress,
  validateTaskUsage,
  validateTaskCache,
  validateTaskBackgroundTask,
  validateTaskCurrentRun,
  validateEventReadDiagnostics,
} from './validators/session-events.js';

export {
  validateGetStatusMessage,
  validateStatusResponseMessage,
  validateCapabilitiesResponseMessage,
  validateLifecycleSnapshot,
  validateClientDisconnect,
  validateEventStoreStatus,
  validateLifecycleDiagnostic,
  validateStatusActiveRun,
  validatePendingApproval,
  validateCapabilitySnapshot,
  validateCapabilityRecord,
  validateCapabilityDiagnostic,
} from "./validators/status.js";

export {
  validateUpdateConfigMessage,
  validateConfigUpdatedMessage,
  validateProbeProviderModelsMessage,
  validateProbeProviderChatMessage,
  validateProviderModelsProbedMessage,
  validateProviderChatProbedMessage,
  validateProviderStatus,
  validateRedactedApiKeyStatus,
  validateProviderGatewayStatus,
  validateProviderDiagnostic,
  validateMcpStatus,
} from "./validators/provider.js";

export {
  validateListSessionsMessage,
  validateSessionsListedMessage,
  validateSessionRecord,
  validateSessionSummary,
  validateSessionListDiagnostics,
} from "./validators/session.js";

export {
  validateListWorkflowsMessage,
  validateCreateWorkflowMessage,
  validateUpdateWorkflowMessage,
  validateDeleteWorkflowMessage,
  validateTriggerWorkflowMessage,
  validateListWorkflowRunsMessage,
  validateWorkflowsListedMessage,
  validateWorkflowCreatedMessage,
  validateWorkflowUpdatedMessage,
  validateWorkflowDeletedMessage,
  validateWorkflowTriggeredMessage,
  validateWorkflowRunUpdatedMessage,
  validateWorkflowRunsListedMessage,
  validateWorkflowDefinition,
  validateWorkflowSchedule,
  validateWorkflowRunEntry,
} from './validators/workflow.js';

export {
  validateGitStatusMessage,
  validateGitDiffMessage,
  validateGitStatusResponseMessage,
  validateGitDiffResponseMessage,
  validateGitStatusFile,
} from './validators/git.js';

export {
  validateListPlanDocumentsMessage,
  validateCreatePlanDocumentMessage,
  validateCreateRequirementsAlignmentPlanMessage,
  validateGetPlanDocumentMessage,
  validatePatchPlanDocumentMessage,
  validateDeletePlanDocumentMessage,
  validatePlanDocumentsListedMessage,
  validatePlanDocumentCreatedMessage,
  validatePlanDocumentMessage,
  validatePlanDocumentPatchedMessage,
  validatePlanDocumentDeletedMessage,
  validatePlanDocumentPayload,
  validatePlanDocumentSummary,
} from './validators/plan.js';

export {
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
  validateMcpServerControlMessage,
  validateListMcpServersMessage,
  validateScopedContextRuntimeConfig,
  validateGetScopedContextMessage,
  validateUpsertScopedContextMessage,
  validateDeleteScopedContextMessage,
  validateResolveScopedContextMessage,
  validateMutationLeasesListedMessage,
  validateBackgroundTasksListedMessage,
  validateBackgroundTaskHistoryMessage,
  validateBackgroundTaskStartedMessage,
  validateBackgroundTaskCancelledMessage,
  validateBackgroundTaskListResponse,
  validateBackgroundTaskSingleResponse,
  validateBackgroundTaskSnapshot,
  validateBackgroundTaskDiagnostic,
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
  validateMcpServerStateMessage,
  validateScopedContextResponseMessage,
  validateScopedContextUpsertedMessage,
  validateScopedContextDeletedMessage,
  validateScopedContextResolvedMessage,
  validateMutationLeaseSnapshot,
  validateMutationLeaseScope,
  validateMutationLeaseOwner,
  validateArtifactRecord,
  validateMemoryRecord,
  validateCheckpointRecord,
  validateChangedFileRecord,
  validateMcpServerRecord,
  validateScopedContextRecord,
  validateScopedContextSource,
  validateScopedContextStoreDiagnostic,
  validateScopedContextCandidate,
  validateScopedContextResolvedItem,
  validateScopedContextResolverDiagnostic,
  validateScopedContextResourceDiagnostic,
  validatePromptContextBlock,
} from './validators/background.js';

export {
  validateSendToSubagentMessage,
  validateGetSubagentStatusMessage,
  validateSubagentStartedMessage,
  validateSubagentEndedMessage,
  validateSubagentEventMessage,
  validateSubagentMessageSentMessage,
  validateSubagentStatusMessage,
} from './validators/subagent.js';

export {
  validatePreviewConversationRewindMessage,
  validateResolveConversationRewindBoundaryMessage,
  validatePreviewConversationRewindByBoundaryMessage,
  validateApplyConversationRewindMessage,
  validateApplySessionActionMessage,
  validateSessionActionConsistency,
  validateConversationRewindBoundaryRequest,
  validateConversationRewindRequest,
  validateConversationRewindPreviewMessage,
  validateConversationRewindBoundaryMessage,
  validateConversationRewindAppliedMessage,
  validateSessionActionReceiptMessage,
  validateSessionTreeEntry,
  validateConversationRewindCheckpoint,
  validateConversationRewindActiveSubagent,
  validateConversationRewindBoundaryRecord,
  validateConversationRewindCheckpointRecord,
  validateConversationRewindCheckpointToolCall,
  validateConversationRewindTargetFacts,
  validateConversationRewindTargetCheckpointFacts,
  validateConversationRewindBoundaryDiagnostic,
  validateConversationRewindMissingFact,
  validateConversationRewindPlan,
  validateConversationRewindEntryProjection,
  validateConversationRewindApprovalClearance,
  validateConversationRewindWorkspaceRestore,
  validateConversationRewindStep,
  validateConversationRewindStepResult,
} from './validators/session-actions.js';
