import type { JsonObject, JsonValue } from "./primitive-types";

export type ToolCategory = "terminal" | "filesystem" | "network" | "mcp" | "skill" | "agent" | "internal";
export type ToolConcurrency = "parallel" | "sequential" | "exclusive";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonObject | undefined;
  execute(input: JsonObject, ctx: ToolExecutionContext): Promise<ToolOutput>;
}

export interface ToolExecutionContext {
  toolCallId: string;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  emit(update: ToolProgressUpdate): void;
  metadata?: Record<string, unknown>;
  traceId?: string;
  runId?: string;
  batchId?: string;
  mode?: string;
  providerId?: string;
}

export interface ToolOutput {
  text?: string;
  json?: JsonValue;
  artifacts?: ToolArtifact[];
}

export interface ToolArtifact {
  kind: "file" | "diff" | "image" | "link" | "log";
  title: string;
  uri?: string;
  text?: string;
  metadata?: JsonObject;
}

export interface ToolProgressUpdate {
  text?: string;
  json?: JsonValue;
  metadata?: JsonObject;
}

export interface ToolBatchCall {
  id: string;
  toolName: string;
  summary: string;
  input: JsonObject;
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

export type ToolBatchFailurePolicy = "continue-drain" | "cancel-siblings";

export type ProviderErrorKind =
  | "network"
  | "gateway-challenge"
  | "rate-limit"
  | "auth"
  | "quota"
  | "endpoint-unavailable"
  | "schema"
  | "server"
  | "timeout"
  | "cancelled"
  | "invalid-stream"
  | "unknown";

export interface ProviderDiagnostic {
  phase:
    | "request-start"
    | "response-start"
    | "sse-first-byte"
    | "retry"
    | "request-error"
    | "stream-end"
    | "endpoint-fallback"
    | "transport-fallback"
    | "model-selected"
    | "model-mismatch";
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
  headers?: Record<string, string>;
  configuredModel?: string;
  actualModel?: string;
  modelMismatch?: boolean;
  streamRequested?: boolean;
  systemPromptWireMode?: "native-system-role" | "user-prefix";
  hasSystemRole?: boolean;
  systemPromptPresent?: boolean;
  systemMessageCount?: number;
  rewrittenSystemMessageCount?: number;
  messageCount?: number;
  toolCount?: number;
  messageRoleCounts?: Record<string, number>;
}

export type RuntimeCheckpointKind = "workspace-checkpoint" | "git-checkpoint" | "file-snapshot";

export interface RuntimeCheckpointRecord {
  id: string;
  kind: RuntimeCheckpointKind;
  label: string;
  toolCallId: string;
  toolName: string;
  artifactUri?: string | undefined;
  manifestPath?: string | undefined;
  snapshotPath?: string | undefined;
  sourcePath?: string | undefined;
  metadata?: JsonObject | undefined;
}

export interface RuntimeCheckpointRestoreRecord {
  checkpointId: string;
  toolCallId: string;
  toolName: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
  metadata?: JsonObject | undefined;
}

export type ContextCompressionTrigger = "auto" | "preflight" | "manual" | "threshold" | "overflow" | "idle" | "incomplete" | "handoff";
export type ContextCompressionReason = "manual" | "threshold" | "overflow" | "idle" | "incomplete" | "handoff";
export type ContextCompressionPolicyTier = "manual" | "proactive" | "recovery" | "background" | "handoff";
export type ContextCompressionPolicyAction = "compact" | "promote-handoff";

export interface ContextCompressionPolicyMetadata {
  tier: ContextCompressionPolicyTier;
  action: ContextCompressionPolicyAction;
  forced: boolean;
  thresholdExceeded: boolean;
  providerRetry: false;
}

export interface ContextCompressionHandoffMetadata {
  trigger: ContextCompressionTrigger;
  reason: ContextCompressionReason;
  tier: ContextCompressionPolicyTier;
  action: ContextCompressionPolicyAction;
  providerRetry: false;
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
  kind: "context-compression-cache-boundary";
  version: 1;
  stablePrefixHash: string;
  cacheKey: string;
  structuredSummaryCacheKey: string;
  structuredSummaryStableHash: string;
  invalidates: Array<"prompt-stable-prefix" | "message-history" | "usage-baseline" | "volatile-context">;
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
  details?: JsonObject;
}

export interface ContextCompressionOptions {
  contextWindowTokens: number;
  thresholdRatio?: number;
  thresholdTokens?: number;
  targetRecentRatio?: number;
  targetRecentTokens?: number;
  minRecentMessages?: number;
  maxSummaryTokens?: number;
  minMessagesToCompress?: number;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
}

export interface ToolOutputBudgetRuntimeOptions {
  inlineChars?: number;
  headRatio?: number;
  artifactChars?: number;
  artifactDir?: string;
}
