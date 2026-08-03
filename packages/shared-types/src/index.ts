// 基础 JSON 类型
export type { JsonPrimitive, JsonValue, JsonObject } from './primitive-types';
export type {
  ISO8601Timestamp,
  DiagnosticSeverity,
  DiagnosticRecord,
  SessionIdentity,
  ConfigPriorityLevel,
  ConfigSource,
} from './primitive-types';
export { CONFIG_PRIORITY } from './primitive-types';

// 事件
export type {
  AgentEvent,
  AgentDomainEvent,
  TurnDomainEvent,
  MessageDomainEvent,
  ToolDomainEvent,
  CompressionDomainEvent,
  DiagnosticDomainEvent,
  CacheDomainEvent,
  CacheStatsUpdated,
  CacheWasteAlert,
  ColdCacheWarning,
  MissAttribution,
} from './events';

// 消息
export type {
  AgentMessage,
  AgentMessageBlock,
  TextBlock,
  ThoughtBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './message';

// 工具
export type {
  ToolDefinition,
  ToolCategory,
  ToolConcurrency,
  ToolExecutionContext,
  ToolOutput,
  ToolArtifact,
  ToolProgressUpdate,
  ToolBatchCall,
  ToolBatchResult,
  ToolBatchFailurePolicy,
  ProviderErrorKind,
  ProviderDiagnostic,
  RuntimeCheckpointKind,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ContextCompressionTrigger,
  ContextCompressionReason,
  ContextCompressionPolicyTier,
  ContextCompressionPolicyAction,
  ContextCompressionPolicyMetadata,
  ContextCompressionRecord,
  ContextCompressionHandoffMetadata,
  ContextCompressionCacheBoundaryMetadata,
  ContextCompressionOptions,
  ToolOutputBudgetRuntimeOptions,
  AgentTool,
  ToolSource,
  ProviderUsage,
  ProviderStreamEvent,
  HealthCheckResult,
} from './tool';

// 权限
export type {
  PermissionBehavior,
  PermissionRequest,
  PermissionDecision,
  PermissionRule,
  ApprovalHandler,
  ToolMetadata,
  RuntimePermissionRequest,
  RuntimePermissionPolicy,
} from './permissions';

// 存储事件
export type {
  StoredEvent,
  StoredEventType,
  StoredEventLogMetadata,
  StoredEventReadOptions,
  EventStore,
  OrchestratorSessionEventSummary,
} from './stored-event';
export {
  STORED_EVENT_PROTOCOL_VERSION,
  STORED_EVENT_LOG_SCHEMA_VERSION,
} from './stored-event';

// 编排
export type {
  SessionStatus,
  RunStatus,
  RunOutcome,
  RunOutcomeReason,
  GoalContinuationAction,
  GoalContinuationDecision,
  GoalRunStatus,
  GoalStoppedReason,
  OrchestratorGoalRunState,
  GoalRoundAssessmentState,
  OrchestratorSessionRecord,
  OrchestratorRunRecord,
  PendingInputMode,
  PendingInputStatus,
  PendingInputRecord,
  OrchestratorRunKind,
} from './orchestration';

// 配置常量
export {
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  DEFAULT_STEERING_BUDGET,
} from './config-constants';

// 错误
export {
  CrishError,
  ProviderError,
  PermissionError,
  SessionError,
  ProtocolError,
} from './errors';
export type { SessionErrorCode } from './errors';
export type {
  CrishErrorCode,
  CrishErrorCategory,
  CrishErrorDomain,
} from './errors/codes';
export {
  CRISH_ERROR_DOMAINS,
  domainOf,
  isCrishErrorCode,
} from './errors/codes';
export type { CrishResult } from './errors/result';
export {
  ok,
  err,
  getOrThrow,
  unwrapOr,
  mapResult,
  flatMapResult,
  mapErr,
  match,
  isOk,
  isErr,
  fromPromise,
  promiseResult,
} from './errors/result';
// 错误序列化（与 dist 导出对齐：error-translation.ts / tauriInvoke 消费）
export {
  CRISH_ERROR_CAUSE_MAX_DEPTH,
  toErrorPayload,
  fromErrorPayload,
  fromUnknownError,
  makeErrorPayload,
  codeFromHttpStatus,
} from './errors/serialize';
export type { CrishErrorPayload } from './errors/serialize';

// Provider 默认配置
export type {
  CrishProviderCredentialMode,
  CrishProviderEndpoint,
  CrishDefaultProviderConfig,
} from './provider-defaults';

// Session 工作区（布局、动作）
export type {
  SessionActionKind,
  SessionOpenTarget,
  SessionPaneRole,
  SessionPaneBinding,
  SplitAxis,
  SplitLayoutNode,
  SessionActionBase,
  SessionAction,
  SessionActionStatus,
  SessionActionReceipt,
  SplitLayout,
  SplitLayoutValidationIssue,
  SplitLayoutValidationResult,
} from './session-workspace';
export {
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_KINDS,
  SESSION_OPEN_TARGETS,
  SESSION_ACTION_STATUSES,
  isSessionActionKind,
  isSessionOpenTarget,
  createSingleSessionLayout,
  validateSplitLayout,
  SPLIT_LAYOUT_MAX_PANES,
} from './session-workspace';

// 会话身份（中控 A1：draft | local | engine）
export type {
  SessionIdentityKind,
  SessionIdentityRef,
} from './session-identity';
export {
  SESSION_IDENTITY_KINDS,
  PENDING_DRAFT_SESSION_ID,
  PENDING_DRAFT,
  isPendingDraftSessionId,
  isSessionIdentityKind,
  resolveSessionIdentityKind,
} from './session-identity';

// 消息身份（中控 A1：clientMessageId 幂等键）
export type {
  ClientMessageId,
  EngineMessageId,
  MessageIdentity,
  ClientMessageIdCarrier,
  StableMessageIdField,
  StableMessageIdSource,
} from './message-identity';
export {
  STABLE_MESSAGE_ID_FIELDS,
  createClientMessageId,
  ensureClientMessageId,
  hasClientMessageId,
  pickStableMessageId,
} from './message-identity';

// Run 控制（中控 A1：L0–L3）
export type {
  RunControlLevel,
  RunControlLevelCode,
  RunControlIntent,
} from './run-control';
export {
  RUN_CONTROL_LEVELS,
  RUN_CONTROL_LEVEL,
  isRunControlLevel,
  runControlLevelCode,
  isTerminatingRunControl,
  isForceCancelRunControl,
  createRunControlIntent,
} from './run-control';

// 运行时辅助类型（从 agent-runtime 下沉的纯类型）
export type {
  ToolMode,
  StreamRecoveryGlobalStats,
  TokenLedgerStats,
  SessionBranchState,
} from './runtime-aux';

// 技能类型（从 agent-runtime/src/skills.ts 下沉）
export type { AgentSkill, SkillDiagnostic } from './skill';

// Git 检查点类型（从 agent-runtime/src/git-versioning/git-types.ts 下沉）
export type {
  GitCheckpoint,
  GitCheckpointToolCall,
  GitCheckpointStrategy,
  GitWorkspaceStatus,
  GitStatusEntry,
} from './git-checkpoint';

// 媒体内容类型（从 agent-runtime/src/media/media-types.ts 下沉）
export type { MediaSource, MediaType, ImageContent } from './media';

// 校验器
export * as validators from './validators';

// 缓存计量契约（P6 S2 §3.3.1；T-42；RunCacheStats re-export 自 ./events，
// 避免双定义——events.ts 为 run 级聚合唯一定义）
export type {
  CacheUsage,
  CacheBreakdown,
  SessionCacheSnapshot,
  CacheMetrics,
  UsageMetadataShape,
  MessageCacheState,
  RunCacheStats,
} from './cache-metrics';
