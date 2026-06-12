// 基础 JSON 类型
export type { JsonPrimitive, JsonValue, JsonObject } from "./primitive-types";
export type { ISO8601Timestamp, DiagnosticSeverity, DiagnosticRecord, SessionIdentity, ConfigPriorityLevel, ConfigSource } from "./primitive-types";
export { CONFIG_PRIORITY } from "./primitive-types";

// 事件
export type {
  AgentEvent, AgentDomainEvent, TurnDomainEvent, MessageDomainEvent,
  ToolDomainEvent, CompressionDomainEvent, DiagnosticDomainEvent,
} from "./events";

// 消息
export type { AgentMessage, AgentMessageBlock, TextBlock, ThoughtBlock, ToolCallBlock, ToolResultBlock } from "./message";

// 工具
export type {
  ToolDefinition, ToolCategory, ToolConcurrency,
  ToolExecutionContext, ToolOutput, ToolArtifact, ToolProgressUpdate,
  ToolBatchCall, ToolBatchResult, ToolBatchFailurePolicy,
  ProviderErrorKind, ProviderDiagnostic,
  RuntimeCheckpointKind, RuntimeCheckpointRecord, RuntimeCheckpointRestoreRecord,
  ContextCompressionTrigger, ContextCompressionReason,
  ContextCompressionPolicyTier, ContextCompressionPolicyAction,
  ContextCompressionPolicyMetadata, ContextCompressionRecord,
  ContextCompressionHandoffMetadata, ContextCompressionCacheBoundaryMetadata,
  ContextCompressionOptions, ToolOutputBudgetRuntimeOptions,
} from "./tool";

// 权限
export type { PermissionBehavior, PermissionRequest, PermissionDecision, PermissionRule, ApprovalHandler, ToolMetadata } from "./permissions";

// 存储事件
export type { StoredEvent, StoredEventType, StoredEventLogMetadata, StoredEventReadOptions, EventStore, OrchestratorSessionEventSummary } from "./stored-event";
export { STORED_EVENT_PROTOCOL_VERSION, STORED_EVENT_LOG_SCHEMA_VERSION } from "./stored-event";

// 编排
export type {
  SessionStatus, RunStatus, RunOutcome, RunOutcomeReason,
  GoalContinuationAction, GoalContinuationDecision,
  GoalRunStatus, GoalStoppedReason,
  OrchestratorGoalRunState, GoalRoundAssessmentState,
  OrchestratorSessionRecord, OrchestratorRunRecord,
  PendingInputMode, PendingInputStatus, PendingInputRecord,
  OrchestratorRunKind,
} from "./orchestration";

// 配置常量
export { DEFAULT_MAX_TURNS, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS, DEFAULT_STEERING_BUDGET } from "./config-constants";

// 错误
export { ConexError, ProviderError, PermissionError, SessionError, ProtocolError } from "./errors";

// Provider 默认配置
export type { CrishProviderCredentialMode, CrishProviderEndpoint, CrishDefaultProviderConfig } from "./provider-defaults";

// Session 工作区（布局、动作）
export type {
  SessionActionKind, SessionOpenTarget, SessionPaneRole, SessionPaneBinding,
  SplitAxis, SplitLayoutNode, SessionActionBase, SessionAction, SessionActionStatus,
  SessionActionReceipt, SplitLayout, SplitLayoutValidationIssue, SplitLayoutValidationResult,
} from "./session-workspace";
export {
  SESSION_ACTION_PROTOCOL_VERSION, SESSION_ACTION_KINDS, SESSION_OPEN_TARGETS, SESSION_ACTION_STATUSES,
  isSessionActionKind, isSessionOpenTarget, createSingleSessionLayout, validateSplitLayout,
  SPLIT_LAYOUT_MAX_PANES,
} from "./session-workspace";


