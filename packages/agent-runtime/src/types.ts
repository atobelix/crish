export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThoughtBlock {
  type: "thought";
  text: string;
  redacted?: boolean;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolOutput;
  isError: boolean;
}

export type AgentMessageBlock = TextBlock | ThoughtBlock | ToolCallBlock | ToolResultBlock;

export interface AgentMessage {
  id: string;
  role: AgentRole;
  createdAt: string;
  blocks: AgentMessageBlock[];
  metadata?: JsonObject;
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

export type ToolConcurrency = "parallel" | "sequential" | "exclusive";
export type ToolCategory = "terminal" | "filesystem" | "network" | "mcp" | "skill" | "agent" | "internal";

export interface ToolExecutionContext {
  toolCallId: string;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  emit(update: ToolProgressUpdate): void;
}

export interface ToolProgressUpdate {
  text?: string;
  json?: JsonValue;
  metadata?: JsonObject;
}

export interface AgentTool {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  inputSchema?: JsonObject;
  concurrency: ToolConcurrency;
  isReadOnly(input: JsonObject): boolean;
  summarize(input: JsonObject): string;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolOutput>;
}

export interface ToolSource {
  id: string;
  label: string;
  listTools(): Promise<AgentTool[]>;
  dispose?(): Promise<void>;
}

export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thought-delta"; text: string; redacted?: boolean }
  | { type: "tool-call"; id?: string; toolName: string; input: JsonObject }
  | { type: "provider-diagnostic"; diagnostic: ProviderDiagnostic }
  | { type: "stop"; reason: "stop" | "tool-call" | "length" | "error"; error?: string; usage?: ProviderUsage };

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ProviderErrorKind =
  | "network"
  | "gateway-challenge"
  | "rate-limit"
  | "auth"
  | "quota"
  | "endpoint-unavailable"
  | "schema"
  | "server"
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
}

export type RuntimeCheckpointKind = "workspace-checkpoint" | "file-snapshot";

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
  metadata?: JsonObject;
}

export interface RuntimeCheckpointRestoreRecord {
  checkpointId: string;
  toolCallId: string;
  toolName: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
  metadata?: JsonObject;
}

export interface AgentProvider {
  id: string;
  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface AgentProviderRequest {
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
}

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  cwd: string;
  tool: AgentTool;
  input: JsonObject;
  summary: string;
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason?: string;
  metadata?: JsonObject;
}

export interface PermissionPolicy {
  decide(request: PermissionRequest): Promise<PermissionDecision> | PermissionDecision;
  recordDecision?(request: PermissionRequest, decision: PermissionDecision): void;
}

export interface ApprovalHandler {
  requestApproval(request: PermissionRequest): Promise<PermissionDecision>;
}

export type RuntimeRecoveryReason = "tool-errors" | "tool-loop" | "empty-response";
export type RuntimeInterventionChoice = "rollback" | "pause" | "user-instruction";

export type AgentEvent =
  | { type: "agent-start"; sessionId: string; timestamp: string }
  | { type: "agent-end"; sessionId: string; timestamp: string; reason: "stop" | "max-turns" | "aborted" | "error"; error?: string }
  | { type: "turn-start"; sessionId: string; turnIndex: number; timestamp: string }
  | { type: "turn-end"; sessionId: string; turnIndex: number; timestamp: string; toolCallCount: number }
  | { type: "context-compression-start"; sessionId: string; timestamp: string; reason: ContextCompressionTrigger; tokensBefore: number }
  | {
      type: "context-compression-end";
      sessionId: string;
      timestamp: string;
      result?: ContextCompressionRecord;
      aborted: boolean;
      error?: string;
    }
  | { type: "runtime-steering"; sessionId: string; timestamp: string; reason: RuntimeRecoveryReason; message: AgentMessage }
  | {
      type: "runtime-intervention-required";
      sessionId: string;
      timestamp: string;
      reason: RuntimeRecoveryReason;
      choices: RuntimeInterventionChoice[];
      message: string;
    }
  | { type: "checkpoint-created"; sessionId: string; timestamp: string; checkpoint: RuntimeCheckpointRecord }
  | { type: "checkpoint-restored"; sessionId: string; timestamp: string; restore: RuntimeCheckpointRestoreRecord }
  | { type: "provider-diagnostic"; sessionId: string; timestamp: string; diagnostic: ProviderDiagnostic }
  | { type: "tool-input-repaired"; sessionId: string; timestamp: string; toolCallId: string; toolName: string; notes: string[] }
  | { type: "message-start"; sessionId: string; message: AgentMessage }
  | { type: "message-delta"; sessionId: string; messageId: string; block: AgentMessageBlock }
  | { type: "message-end"; sessionId: string; message: AgentMessage }
  | { type: "tool-batch-start"; sessionId: string; batchId: string; timestamp: string; summary: string; calls: ToolBatchCall[] }
  | { type: "tool-batch-end"; sessionId: string; batchId: string; timestamp: string; calls: ToolBatchResult[] }
  | { type: "tool-start"; sessionId: string; batchId: string; call: ToolBatchCall; timestamp: string }
  | { type: "tool-update"; sessionId: string; batchId: string; toolCallId: string; update: ToolProgressUpdate; timestamp: string }
  | { type: "tool-end"; sessionId: string; batchId: string; result: ToolBatchResult; timestamp: string }
  | { type: "approval-requested"; sessionId: string; request: PermissionRequest; timestamp: string }
  | { type: "approval-resolved"; sessionId: string; requestId: string; decision: PermissionDecision; timestamp: string }
  | { type: "runtime-error"; sessionId: string; timestamp: string; error: string };

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

export interface AgentRuntimeOptions {
  sessionId?: string;
  cwd: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
  provider: AgentProvider;
  tools?: AgentTool[];
  toolSources?: ToolSource[];
  permissionPolicy?: PermissionPolicy;
  approvalHandler?: ApprovalHandler;
  sessionStore?: SessionStore;
  resumeSession?: boolean;
  maxTurns?: number;
  contextCompression?: ContextCompressionRuntimeOptions;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  recovery?: AgentRecoveryRuntimeOptions;
}

export interface AgentRecoveryRuntimeOptions {
  enabled?: boolean;
  maxConsecutiveToolErrors?: number;
  maxRepeatedToolCalls?: number;
  maxSteeringMessages?: number;
}

export interface SessionStore {
  open(session: SessionHeader): Promise<void>;
  append(entry: SessionEntry): Promise<void>;
  readAll?(): Promise<SessionEntry[]>;
}

export interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  createdAt: string;
  version: 1;
}

export type SessionEntry =
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: string;
      message: AgentMessage;
    }
  | {
      type: "event";
      id: string;
      parentId: string | null;
      timestamp: string;
      event: AgentEvent;
    }
  | {
      type: "checkpoint";
      id: string;
      parentId: string | null;
      timestamp: string;
      label: string;
      metadata?: JsonObject;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      timestamp: string;
      record: ContextCompressionRecord;
    };

export type ContextCompressionTrigger = "auto" | "manual" | "preflight" | "overflow";

export interface ContextCompressionRecord {
  id: string;
  trigger: ContextCompressionTrigger;
  summary: string;
  firstKeptMessageId?: string;
  compressedMessageIds: string[];
  keptMessageIds: string[];
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
  details?: JsonObject;
}

export interface ContextCompressionRuntimeOptions extends ContextCompressionOptions {
  enabled?: boolean;
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
  summarizer: ContextSummarizer;
  contextState?: ContextStateReader;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
}

export interface ToolOutputBudgetRuntimeOptions {
  inlineChars?: number;
  headRatio?: number;
  artifactChars?: number;
  artifactDir?: string;
}

export interface ContextSummarizer {
  summarize(request: ContextSummaryRequest): Promise<string>;
}

export interface ContextSummaryRequest {
  trigger: ContextCompressionTrigger;
  serializedConversation: string;
  previousSummary?: string;
  recentSuccessfulCommands: string[];
  recentFailedDiagnostics: string[];
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  maxSummaryTokens: number;
}

export interface ContextStateSnapshot {
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  previousCompressionSummary?: string;
}

export interface ContextStateReader {
  snapshotForCompression(): Promise<ContextStateSnapshot> | ContextStateSnapshot;
  recordCompression?(record: ContextCompressionRecord): Promise<void> | void;
  recordCheckpoint?(checkpoint: RuntimeCheckpointRecord): Promise<void> | void;
}
