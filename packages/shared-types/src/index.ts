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
  ToolRegistrationOptions,
  RegisteredTool,
} from './tool';

// 钩子（I8-E1：14 事件名 + 全 14 载荷 + HookPayloadMap + 双模式 handler；
// 冻结：HOOK_EVENT_NAMES ↔ crates/session-loop hooks.rs HookEventKind 双向锁定）
export { HOOK_EVENT_NAMES } from './hooks';
export type {
  HookEventName,
  ExistingHookEventName,
  NewHookEventName,
  HookEventNameLiteral,
  HookMode,
  HookFailStrategy,
  HookPayloadMap,
  TurnStartPayload,
  TurnEndPayload,
  ToolPrePayload,
  ToolPostPayload,
  ToolErrorPayload,
  ContextCompactStartPayload,
  ContextCompactEndPayload,
  SessionStartPayload,
  SessionEndPayload,
  ModelBeforeRequestPayload,
  ModelAfterResponsePayload,
  SubagentStartPayload,
  SubagentEndPayload,
  ErrorOccurredPayload,
  HookUnsubscribe,
  HookObserveHandler,
  HookOnHandler,
  LifecycleHandlerResult,
  ToolErrorHandlerResult,
  HookBusLike,
  HookRegistration,
} from './hooks';

// 插件契约（I8-E2 manifest 双轨收敛：shared-types 为跨端真源）
export type {
  PluginOrigin,
  PluginTrustLevel,
  PluginPermission,
  PluginEntrypoints,
  PluginAuthor,
  PluginManifest,
} from './plugin';

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

// 引擎生成面（generated/engine）公共 re-export 面。
// 维度 3 步骤 1（3-D 第 1 步）：消除 apps/crish-desktop 对
// `packages/shared-types/src/generated/engine` 深路径的直引，统一经本公共面。
//
// 命名冲突处理：generated 的 `AgentMessage` / `AgentMessageBlock` 与上方
// `./message` 的同名导出**字段不对齐**（generated.metadata 为 JsonValue、
// 含 content?: string；message.metadata 为 JsonObject、无 content）。
// ESM 规则：显式命名导出优先于 `export *` 通配，故裸 `AgentMessage`/
// `AgentMessageBlock` 绑定到 `./message` 版本；generated 版需经显式 alias
// （`EngineAgentMessage`/`EngineAgentMessageBlock`）才可达——消费方按需取用
// （如 store/types.ts 取 `EngineAgentMessage as AgentMessage` 本地别名），
// 避免静默拿到错误版本。其它与 ./tool 等冲突的生成名（ToolOutput 等）同理
// 由既有显式导出覆盖，generated 版被遮蔽（不破坏既有消费方）。
export * from './generated/engine/types';
export type {
  AgentMessage as EngineAgentMessage,
  AgentMessageBlock as EngineAgentMessageBlock,
} from './generated/engine/types';

// generated/engine 运行期常量逐条 re-export（events.ts 的值常量；
// types.ts 的 `as const` 值数组已由上方 `export *` 覆盖）。
export {
  ENGINE_EVENT_TYPES,
  ENGINE_EVENT_BACKPRESSURE,
  SUBAGENT_EVENT_KIND_BACKPRESSURE,
} from './generated/engine/events';

// 设备协议生成面（generated/device）公共 re-export 面。
// 消除 apps/crish-mobile 对 `packages/shared-types/src/generated/device`
// 深路径的直引，统一经本公共面。
//
export * from './generated/device/types';
export {
  APPROVAL_DECISION_VALUES,
  type ApprovalDecision,
} from './generated/engine/types';
export {
  APPROVAL_DECISION_VALUES as DEVICE_APPROVAL_DECISION_VALUES,
  type ApprovalDecision as DeviceApprovalDecision,
} from './generated/device/types';
export type {
  RunControlLevel as DeviceRunControlLevel,
} from './generated/device/types';
export * from './generated/device/kinds';
export * from './generated/device/commands';
export * from './generated/device/events';
export * from './generated/device/stream';
export * from './generated/device/errors';
export * from './generated/device/capabilities';
export * from './generated/device/parser';
