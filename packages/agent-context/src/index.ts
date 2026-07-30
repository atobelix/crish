/**
 * @crish/agent-context
 *
 * 上下文域聚合包。职责：context 压缩、checkpoint、session/snapshot、prompt 装配、
 * canonical schema、wasm-tiktoken、structured summary、memory、scoped context、
 * canonical event 等。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 2 (leaf)。
 * 依赖约束：仅依赖 shared-types / shared-utils / @crish/logger / @crish/telemetry，
 * 不依赖 agent-tools / agent-model / agent-core / agent-permissions / agent-mcp。
 */

// ─── Agent 3-A 迁移的公共符号（context-compression / checkpoint / 根 context 文件） ───

export {
  ContextCompressor,
  findFirstKeptMessageIndex,
  extractRecentTerminalCommandFacts,
  safeCompactionCutoff,
  estimateContextTokens,
  estimateMessageTokens,
  estimateMediaTokensFromMessages,
  estimateMediaTokensFromMessageParts,
  countMessageImages,
  applyTokenEstimateSafetyFactor,
  buildFileOpsXml,
  serializeMessagesForSummary,
  createCompressionSummaryMessage,
  TOKEN_ESTIMATE_SAFETY_FACTOR,
  IMAGE_TOKEN_COST,
} from './context-compression';
export type {
  CompressionHistoryEntry,
  ContextCompressionResult,
  ContextCompressionDecision,
  ContextTokenEstimate,
  ContextTokenEstimateOptions,
  SerializeContextOptions,
} from './context-compression';

export { CheckpointManager } from './checkpoint';
export type {
  CheckpointMetadata,
  RestoreWarningSeverity,
  RestoreWarning,
  CompatibilityCheckResult,
  RestoreResult,
} from './checkpoint';

export {
  CheckpointManifestService,
  createCheckpointManifestRecord,
  createCheckpointManifestInputFromBoundary,
  serializeCheckpointManifestRecord,
  parseCheckpointManifestRecord,
  validateCheckpointManifestRecord,
  findLatestCheckpointManifestRecord,
  checkpointManifestRecordToRewindRestoreFacts,
} from './checkpoint-manifest';
export type {
  CheckpointManifestSource,
  CheckpointManifestToolCall,
  CheckpointManifestCheckpointRef,
  CheckpointManifestRecord,
  CheckpointManifestInput,
  CheckpointManifestServiceOptions,
  CheckpointManifestListOptions,
  CheckpointRewindBoundaryLookupOptions,
  CheckpointManifestReadResult,
  CheckpointManifestStats,
  CheckpointManifestInvalidRecord,
} from './checkpoint-manifest';

export {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  checkpointToArtifact,
  checkpointRestoreResultToOutput,
  resolveCheckpointArchiveRoot,
  resolveCheckpointManifestPath,
} from './checkpoints';
export type {
  WorkspaceCheckpointOptions,
  CreateWorkspaceCheckpointRequest,
  RestoreWorkspaceCheckpointRequest,
  WorkspaceCheckpointFile,
  WorkspaceCheckpoint,
  WorkspaceCheckpointRestoreResult,
} from './checkpoints';

export {
  projectMessagesForProvider,
  projectMessageForProvider,
} from './context-projection';
export type { ContextProjectionOptions } from './context-projection';

export { sliceContextAtValidBoundary } from './context-slicer';
export type {
  LLMMessage,
  LLMMessageBlock,
  SliceResult,
} from './context-slicer';

export { InMemoryContextState, createContextStateTools } from './context-state';
export type {
  ContextTask,
  SessionEventNote,
  FileSnapshotHint,
} from './context-state';

export {
  ConversationBoundaryManifestService,
  createConversationBoundaryManifestRecord,
  serializeConversationBoundaryManifestRecord,
  parseConversationBoundaryManifestRecord,
  validateConversationBoundaryManifestRecord,
  findLatestConversationBoundaryManifestRecord,
  conversationBoundaryManifestRecordToRewindTargetFacts,
} from './conversation-boundary-manifest';
export type {
  ConversationBoundaryCheckpointSource,
  ConversationBoundaryCheckpointRef,
  ConversationBoundaryManifestRecord,
  ConversationRewindBoundaryTargetMode,
  ConversationRewindBoundaryTargetFacts,
  ConversationBoundaryManifestInput,
  ConversationBoundaryManifestServiceOptions,
  ConversationBoundaryManifestListOptions,
  ConversationBoundaryManifestReadResult,
  ConversationBoundaryManifestStats,
  ConversationBoundaryManifestInvalidRecord,
} from './conversation-boundary-manifest';

export { resolveConversationRewindTargetFacts } from './conversation-rewind-target';
export type {
  ConversationRewindMissingFact,
  ConversationRewindWorkspaceCheckpointFacts,
  ResolveConversationRewindTargetFactsInput,
  ConversationRewindTargetFacts,
} from './conversation-rewind-target';

export {
  decodeTextBuffer,
  encodeTextBuffer,
  isWritableTextEncoding,
} from './encoding';
export type {
  TextFileEncoding,
  WritableTextFileEncoding,
  DecodedTextBuffer,
} from './encoding';

export {
  externalizeToolOutputBlobs,
  blobReferenceJson,
  isBlobReferenceJson,
} from './blob-externalization';
export type {
  BlobExternalizationSource,
  BlobExternalizationEncoding,
  BlobExternalizationOptions,
  BlobReferenceJson,
  BlobExternalizationMetadata,
  ExternalizedBlob,
  BlobExternalizationResult,
} from './blob-externalization';

// ─── Agent 3-B 迁移的公共符号（session / snapshots / prompt / canonical-schema 等） ───

// ISessionStore 契约
export type { ISessionStore } from './ISessionStore';

// session/ 目录（通过 session.ts barrel 转出）
export {
  createId,
  nowIso,
  createTextMessage,
  pruneHistoricalToolOutputs,
  createCompactionSummaryAgentMessage,
  buildSessionContextFromEntries,
  findSessionLeafId,
  moveSessionLeaf,
  InMemorySessionStore,
  JsonlSessionStore,
  SessionRecorder,
} from './session';
export type {
  SessionLeafPointerEntry,
  SessionMessageEntry,
  SessionCheckpointEntry,
  SessionCompactionEntry,
  MoveSessionLeafOptions,
  MoveSessionLeafResult,
  JsonlSessionStoreMode,
  JsonlSessionStoreOptions,
} from './session';

// session-store/ 目录
export { SessionStore, BranchManager } from './session-store';
export { StoreCapacityError } from './session-store/types';
export type {
  AppendResult,
  MessageShard,
  SessionBranch,
  BranchSnapshot,
  MessageRangeQuery,
  MessageRangeResult,
  SessionStats,
} from './session-store';

// event-architecture/ 目录
export {
  RuntimeCanonicalAdapter,
  EventSchemaRegistry,
  createCanonicalEvent,
  createDefaultSchemaRegistry,
  RUNTIME_EVENT_SCHEMAS,
} from './event-architecture';
export type {
  ConexEventDomain,
  ConexEventSourceLayer,
  ConexDiagnostic,
  ConexCanonicalEvent,
  ConexCanonicalAdapter,
  AdapterContext,
  SchemaValidationResult,
  SchemaValidationError,
  EventSchemaDefinition,
} from './event-architecture';

// canonical-schema.ts
export {
  canonicalizeJsonSchema,
  canonicalizeTools,
  canonicalJsonStringify,
  computeToolsSchemaHash,
} from './canonical-schema';
export type { CacheProfile } from './canonical-schema';

// snapshots.ts
export {
  createFileSnapshot,
  restoreFileSnapshot,
  resolveArchiveRoot,
  resolveSnapshotLocation,
  resolveUnderRoot,
  joinUnderRoot,
  toRelativePosix,
} from './snapshots';
export type {
  WorkspaceSnapshotOptions,
  FileSnapshotRequest,
  RestoreSnapshotRequest,
} from './snapshots';

// trajectory-compressor.ts
export { compressMessageTrajectory } from './trajectory-compressor';
export type { TrajectoryCompressionOptions } from './trajectory-compressor';

// wasm-tiktoken.ts
export { WasmTokenEstimator } from './wasm-tiktoken';
export type { TokenEstimateResult } from './wasm-tiktoken';

// structured-summary.ts
export {
  STRUCTURED_SUMMARY_VERSION,
  createStructuredSummary,
  mergeStructuredSummaries,
  structuredSummaryToJson,
  parseStructuredSummaryJson,
  renderStructuredSummary,
  structuredSummaryCacheKey,
} from './structured-summary';
export type {
  StructuredSummaryKind,
  StructuredSummaryInput,
  StructuredSummary,
} from './structured-summary';

// memory.ts
export {
  InMemoryMemoryStore,
  JsonlMemoryStore,
  createMemoryTools,
} from './memory';
export type {
  MemoryScope,
  MemoryEntry,
  MemorySearchOptions,
  MemoryStore,
} from './memory';

// prompt-assembly.ts
export {
  PROMPT_ASSEMBLY_VERSION,
  assemblePromptForProvider,
  renderPromptContextBlocks,
  selectPromptCacheStrategy,
  inferPromptModelFamily,
  inferPromptProviderFamily,
} from './prompt-assembly';
export type {
  PromptAssemblyBlockStability,
  PromptAssemblyBlockKind,
  PromptProviderFamily,
  PromptModelFamily,
  PromptCacheStrategy,
  PromptUsageNormalization,
  PromptAssemblyPayload,
  PromptAssemblyContextBlock,
  PromptAssemblyInput,
  PromptCacheBlock,
  PromptCacheCandidate,
  PromptCacheStrategySelection,
  PromptAssemblyMetadata,
  PromptAssemblyResult,
} from './prompt-assembly';

// prompt-context.ts
export {
  PROMPT_CONTEXT_COMPOSER_VERSION,
  composePromptContext,
  promptContextMetadataJson,
} from './prompt-context';
export type {
  PromptContextProgressInput,
  PromptContextComposerInput,
  PromptContextComposerMetadata,
  PromptContextComposition,
} from './prompt-context';

// scoped-context.ts
export {
  SCOPED_CONTEXT_VERSION,
  defineScopedRule,
  skillToScopedContextRecord,
  resolveScopedContext,
} from './scoped-context';
export type {
  ScopedContextKind,
  ScopedContextScope,
  ScopedContextActivation,
  ScopedContextItemStatus,
  ScopedContextSource,
  ScopedContextRecord,
  ScopedRuleInput,
  ScopedSkillInput,
  ScopedContextResolverProject,
  ScopedContextResolverInput,
  ScopedContextCandidate,
  ScopedContextResolvedItem,
  ScopedContextDiagnostic,
  ScopedContextResolution,
} from './scoped-context';

// scoped-context-resources.ts
export {
  SCOPED_CONTEXT_RESOURCE_VERSION,
  loadScopedContextResources,
  loadAndResolveScopedContextResources,
} from './scoped-context-resources';
export type {
  ScopedContextResourcePathSet,
  ScopedSkillDirectory,
  LoadScopedContextResourcesOptions,
  LoadAndResolveScopedContextResourcesOptions,
  ScopedContextResourceDiagnostic,
  ScopedContextResourcesResult,
  ScopedContextResourcesResolutionResult,
} from './scoped-context-resources';

// payload-image-recovery.ts
export {
  IMAGE_OMITTED_PLACEHOLDER,
  MAX_PAYLOAD_IMAGE_RECOVERY,
  countContentPartImages,
  scrubImagesOldestFirst,
  looksLikePayloadTooLargeMessage,
} from './payload-image-recovery';

// project-progress-ledger.ts
export {
  ProjectProgressLedger,
  renderStableProgressLines,
  renderRecentSubagentTaskLines,
  snapshotForSubagentContext,
  snapshotProjectProgress,
} from './project-progress-ledger';
export type {
  ProjectProgressStatus,
  ProjectProgressClock,
  ProjectProgressLedgerOptions,
  StablePrincipleInput,
  StablePrincipleRecord,
  GlobalProgressItemInput,
  GlobalProgressItemRecord,
  AgentTaskRecordInput,
  AgentTaskRecord,
  ProjectProgressSnapshotOptions,
  ProjectProgressSnapshot,
} from './project-progress-ledger';

// goal-disk-oracle.ts
export { evaluateDiskOracle } from './goal-disk-oracle';
export type {
  DiskOracleCheck,
  DiskOracleResult,
  EvaluateDiskOracleOptions,
} from './goal-disk-oracle';

// response-style.ts
export {
  normalizeResponseStyleLevel,
  responseStyleSystemGuidance,
  mergeSystemPromptWithResponseStyle,
} from './response-style';
export type { ResponseStyleLevel } from './response-style';

// doctor-report.ts
export { DoctorReportBuilder } from './doctor-report';
export type { DoctorReport, DoctorReportDeps } from './doctor-report';

// agent-context.ts
export type {
  PolicyPack,
  AgentContextBase,
  AgentContextView,
} from './agent-context';
