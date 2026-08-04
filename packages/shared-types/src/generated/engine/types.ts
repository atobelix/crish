// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)
// Registry: crates/conex-types/contracts/engine-events.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { JsonValue } from "../../primitive-types";

export const AGENT_MESSAGE_ROLE_VALUES = ["system","user","assistant","tool"] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLE_VALUES)[number];

export const AGENT_END_REASON_VALUES = ["stop","max-turns","aborted","error","stopped"] as const;
export type AgentEndReason = (typeof AGENT_END_REASON_VALUES)[number];

export const RUN_TERMINAL_STATUS_VALUES = ["completed","cancelled","failed"] as const;
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUS_VALUES)[number];

export const APPROVAL_DECISION_VALUES = ["approved","denied","expired"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION_VALUES)[number];

export const TOOL_CATEGORY_VALUES = ["terminal","filesystem","network","mcp","skill","agent","internal"] as const;
export type ToolCategory = (typeof TOOL_CATEGORY_VALUES)[number];

export const TOOL_CONCURRENCY_VALUES = ["parallel","sequential","exclusive"] as const;
export type ToolConcurrency = (typeof TOOL_CONCURRENCY_VALUES)[number];

export const TOOL_ARTIFACT_KIND_VALUES = ["file","diff","image","link","log"] as const;
export type ToolArtifactKind = (typeof TOOL_ARTIFACT_KIND_VALUES)[number];

export const PROVIDER_DIAGNOSTIC_PHASE_VALUES = ["request-start","response-start","sse-first-byte","retry","request-error","stream-end","endpoint-fallback","transport-fallback","model-selected","model-mismatch","invalid-tool-call"] as const;
export type ProviderDiagnosticPhase = (typeof PROVIDER_DIAGNOSTIC_PHASE_VALUES)[number];

export const SYSTEM_PROMPT_WIRE_MODE_VALUES = ["native-system-role","user-prefix"] as const;
export type SystemPromptWireMode = (typeof SYSTEM_PROMPT_WIRE_MODE_VALUES)[number];

export const PROVIDER_ERROR_KIND_VALUES = ["aborted","payload-too-large","gateway-challenge","auth","quota","endpoint-unavailable","context-length-exceeded","invalid-request","rate-limit","server-error","timeout","network","unknown"] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KIND_VALUES)[number];

export const RUNTIME_CHECKPOINT_KIND_VALUES = ["workspace-checkpoint","git-checkpoint","file-snapshot"] as const;
export type RuntimeCheckpointKind = (typeof RUNTIME_CHECKPOINT_KIND_VALUES)[number];

export const CONTEXT_COMPRESSION_TRIGGER_VALUES = ["auto","preflight","manual","threshold","overflow","idle","incomplete","handoff"] as const;
export type ContextCompressionTrigger = (typeof CONTEXT_COMPRESSION_TRIGGER_VALUES)[number];

export const CONTEXT_COMPRESSION_REASON_VALUES = ["manual","threshold","overflow","idle","incomplete","handoff"] as const;
export type ContextCompressionReason = (typeof CONTEXT_COMPRESSION_REASON_VALUES)[number];

export const CONTEXT_COMPRESSION_POLICY_TIER_VALUES = ["manual","proactive","recovery","background","handoff"] as const;
export type ContextCompressionPolicyTier = (typeof CONTEXT_COMPRESSION_POLICY_TIER_VALUES)[number];

export const CONTEXT_COMPRESSION_POLICY_ACTION_VALUES = ["compact","promote-handoff"] as const;
export type ContextCompressionPolicyAction = (typeof CONTEXT_COMPRESSION_POLICY_ACTION_VALUES)[number];

export const COMPRESSION_CACHE_INVALIDATION_VALUES = ["prompt-stable-prefix","message-history","usage-baseline","volatile-context"] as const;
export type CompressionCacheInvalidation = (typeof COMPRESSION_CACHE_INVALIDATION_VALUES)[number];

export const MISS_ATTRIBUTION_VALUES = ["model-switch","compaction","prefix-changed","idle-ttl-expired","cold","zero-read","low-read","unknown"] as const;
export type MissAttribution = (typeof MISS_ATTRIBUTION_VALUES)[number];

export const SECURITY_AUDIT_OPERATION_VALUES = ["delete","trash-restore","trash-purge","git-revert","command-exec","undeclared-write"] as const;
export type SecurityAuditOperation = (typeof SECURITY_AUDIT_OPERATION_VALUES)[number];

export const SECURITY_AUDIT_DECISION_VALUES = ["blocked","approved","denied","redirected","restored","purged"] as const;
export type SecurityAuditDecision = (typeof SECURITY_AUDIT_DECISION_VALUES)[number];

export const SUBAGENT_EVENT_KIND_VALUES = ["progress","message","tool"] as const;
export type SubagentEventKind = (typeof SUBAGENT_EVENT_KIND_VALUES)[number];

export const SUBAGENT_END_STATUS_VALUES = ["completed","failed","cancelled"] as const;
export type SubagentEndStatus = (typeof SUBAGENT_END_STATUS_VALUES)[number];

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  createdAt: string;
  blocks: AgentMessageBlock[];
  metadata?: JsonValue;
  clientMessageId?: string;
  content?: string;
}

export interface AgentMessageBlockText {
  type: "text";
  text: string;
}

export interface AgentMessageBlockThought {
  type: "thought";
  text: string;
  redacted?: boolean;
}

export interface AgentMessageBlockToolCall {
  type: "tool-call";
  id: string;
  toolName: string;
  input: JsonValue;
}

export interface AgentMessageBlockToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolOutput;
  isError: boolean;
}

export type AgentMessageBlock = AgentMessageBlockText | AgentMessageBlockThought | AgentMessageBlockToolCall | AgentMessageBlockToolResult;

export interface ToolOutput {
  text?: string;
  json?: JsonValue;
  artifacts?: ToolArtifact[];
}

export interface ToolArtifact {
  kind: ToolArtifactKind;
  title: string;
  uri?: string;
  text?: string;
  metadata?: JsonValue;
}

export interface ToolBatchCall {
  id: string;
  toolName: string;
  summary: string;
  input: JsonValue;
  category: ToolCategory;
  concurrency: ToolConcurrency;
}

export interface ToolBatchResult {
  id: string;
  toolName: string;
  output: ToolOutput;
  isError: boolean;
  durationMs: number;
}

export interface ToolProgressUpdate {
  text?: string;
  json?: JsonValue;
  metadata?: JsonValue;
}

export interface ProviderDiagnostic {
  phase: ProviderDiagnosticPhase;
  providerId?: string;
  endpoint?: string;
  url?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  status?: number;
  statusText?: string;
  retryable?: boolean;
  reason?: string;
  errorKind?: ProviderErrorKind;
  retryAfterMs?: number;
  chunks?: number;
  bytes?: number;
  headers?: JsonValue;
  configuredModel?: string;
  actualModel?: string;
  modelMismatch?: boolean;
  streamRequested?: boolean;
  systemPromptWireMode?: SystemPromptWireMode;
  hasSystemRole?: boolean;
  systemPromptPresent?: boolean;
  systemMessageCount?: number;
  rewrittenSystemMessageCount?: number;
  messageCount?: number;
  toolCount?: number;
  messageRoleCounts?: JsonValue;
  partial?: JsonValue;
}

export interface RuntimeCheckpointRecord {
  id: string;
  kind: RuntimeCheckpointKind;
  label: string;
  toolCallId: string;
  toolName: string;
  artifactUri?: string;
  manifestPath?: string;
  snapshotPath?: string;
  sourcePath?: string;
  metadata?: JsonValue;
}

export interface RuntimeCheckpointRestoreRecord {
  checkpointId: string;
  toolCallId: string;
  toolName: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
  metadata?: JsonValue;
}

export interface ToolMetadata {
  category?: string;
  isReadOnly?: boolean;
  fatalOnError?: boolean;
  concurrency?: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  parameters: JsonValue;
  summary: string;
  toolMetadata: ToolMetadata;
  metadata?: JsonValue;
}

export interface ContextCompressionPolicyMetadata {
  tier: ContextCompressionPolicyTier;
  action: ContextCompressionPolicyAction;
  forced: boolean;
  thresholdExceeded: boolean;
  providerRetry: boolean;
}

export interface ContextCompressionHandoffMetadata {
  trigger: ContextCompressionTrigger;
  reason: ContextCompressionReason;
  tier: ContextCompressionPolicyTier;
  action: ContextCompressionPolicyAction;
  providerRetry: boolean;
  summary: string;
  compressedMessageCount: number;
  keptMessageCount: number;
  tokensBefore: number;
  tokensAfter: number;
  thresholdTokens: number;
  firstKeptMessageId?: string;
  lastMessageId?: string;
  lastUserMessageId?: string;
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  recentSuccessfulCommands: string[];
  recentFailedDiagnostics: string[];
}

export interface ContextCompressionCacheBoundaryMetadata {
  kind: string;
  version: number;
  stablePrefixHash: string;
  cacheKey: string;
  structuredSummaryCacheKey: string;
  structuredSummaryStableHash: string;
  invalidates: CompressionCacheInvalidation[];
  invalidationReason: ContextCompressionReason;
  compressedMessageIds: string[];
  keptMessageIds: string[];
  firstKeptMessageId?: string;
}

export interface ContextCompressionRecord {
  id: string;
  trigger: ContextCompressionTrigger;
  reason?: ContextCompressionReason;
  policy?: ContextCompressionPolicyMetadata;
  summary: string;
  firstKeptMessageId?: string;
  compressedMessageIds: string[];
  keptMessageIds: string[];
  tokensBefore: number;
  tokensAfter: number;
  thresholdTokens?: number;
  createdAt: string;
  handoff?: ContextCompressionHandoffMetadata;
  cacheBoundary?: ContextCompressionCacheBoundaryMetadata;
  details?: JsonValue;
}

export interface RunCacheStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  sampleCount: number;
  hitRatio?: number;
  writeRatio?: number;
  missedTokens: number;
  warmUntilMs?: number;
}

export interface ImpactAssessment {
  fileCount: number;
  totalSizeBytes: number;
  directoryCount: number;
  crossDirectory: boolean;
  flagged: boolean;
}

export interface SubagentEventPayload {
  kind: SubagentEventKind;
  payload?: JsonValue;
}

