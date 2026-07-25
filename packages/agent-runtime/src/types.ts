import type {
  JsonObject, AgentMessage, AgentEvent,
  ToolCategory, ToolConcurrency,
  ToolExecutionContext, ToolOutput,
  PermissionDecision, ApprovalHandler,
  ProviderDiagnostic,
  ToolBatchFailurePolicy,
  RuntimeCheckpointRecord,
  ContextCompressionTrigger, ContextCompressionReason,
  ContextCompressionPolicyMetadata,
  ContextCompressionRecord,
} from "@crish/shared-types";
import type { PromptAssemblyContextBlock, PromptAssemblyMetadata } from "./prompt-assembly";
import type { WorkspaceMutationCoordinator } from "./workspace-mutation-coordinator";

// types.ts 不再重导出核心类型。请�?@crish/shared-types 直接导入�?
export type AgentRole = import("@crish/shared-types").AgentMessage["role"];

// ─── 运行时持有的扩展工具接口（后续步骤将删除，统一使用 ToolDefinition�?─────
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  inputSchema?: JsonObject | undefined;
  inputAliases?: Record<string, string[]> | undefined;
  concurrency: ToolConcurrency;
  allowParallel?: boolean | undefined;
  fatalOnError?: boolean | undefined;
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

export interface HealthCheckResult {
  healthy: boolean;
  status?: "healthy" | "degraded" | "unhealthy";
  latencyMs?: number;
  error?: string;
  lastCheckedAt?: number;
}

export interface AgentProvider {
  id: string;
  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  healthCheck?(): Promise<HealthCheckResult>;
}

export interface AgentProviderRequest {
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
  promptAssembly?: PromptAssemblyMetadata;
}

export type RuntimeRecoveryReason = "tool-errors" | "tool-loop" | "empty-response";
export type RuntimeInterventionChoice = "rollback" | "pause" | "user-instruction";

export interface ToolExecutionRuntimeOptions {
  timeoutMs?: number;
  parallelFailurePolicy?: ToolBatchFailurePolicy;
}

export interface RuntimePermissionRequest {
  id: string;
  sessionId: string;
  cwd: string;
  tool: AgentTool;
  input: JsonObject;
  summary: string;
  metadata?: JsonObject;
}

export interface RuntimePermissionPolicy {
  decide(request: RuntimePermissionRequest): Promise<PermissionDecision> | PermissionDecision;
  recordDecision?(request: RuntimePermissionRequest, decision: PermissionDecision): void;
}

export interface AgentRuntimeOptions {
  sessionId?: string;
  cwd: string;
  /**
   * 可选回调：运行时在 preparing-turn 阶段调用此回调，从事件存储拉取待处理输入�?   * 取代编排层主动的 injectSteerInput�?   */
  readPendingInputs?: (runId: string) => Promise<AgentMessage[]>;
  systemPrompt?: string;
  promptContext?: AgentRuntimePromptContext;
  initialMessages?: AgentMessage[];
  provider: AgentProvider;
  tools?: AgentTool[];
  toolSources?: ToolSource[];
  permissionPolicy?: RuntimePermissionPolicy;
  approvalHandler?: ApprovalHandler;
  sessionStore?: SessionPersistenceStore;
  sessionMessageStore?: SessionMessageStoreOptions;
  resumeSession?: boolean;
  maxTurns?: number;
  maxTokens?: number | undefined;
  contextCompression?: ContextCompressionRuntimeOptions;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  recovery?: AgentRecoveryRuntimeOptions;
  toolExecution?: ToolExecutionRuntimeOptions;
  workspaceMutationCoordinator?: WorkspaceMutationCoordinator;
  subagentDepth?: number;
  connectionManager?: import("./provider-transport/connection-manager").ConnectionManager;
  tokenTracker?: import("./provider-transport/token-tracker").TokenTracker;
  extensionRegistry?: import("./hooks/extension-registry").ExtensionRegistry;
  hooks?: import("./hooks").ToolHook<JsonObject, ToolOutput>[];
}

export interface AgentRuntimePromptContext {
  stableContext?: PromptAssemblyContextBlock[];
  volatileContext?: PromptAssemblyContextBlock[];
  metadata?: JsonObject;
}

export interface AgentRecoveryRuntimeOptions {
  enabled?: boolean;
  maxConsecutiveToolErrors?: number;
  maxRepeatedToolCalls?: number;
  maxSteeringMessages?: number;
}

export interface SessionPersistenceStore {
  open(session: SessionHeader): Promise<void>;
  append(entry: SessionEntry): Promise<void>;
  readAll?(): Promise<SessionEntry[]>;
  /**
   * 释放底层资源（如持久化文件句柄）�?   *
   * 实现可选。运行结束时调用以确保资源不泄漏�?   */
  close?(): Promise<void>;
}

export interface SessionMessageStoreOptions {
  maxShardMessages?: number;
  enableBranching?: boolean;
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
    }
  | {
      type: "leaf-pointer";
      id: string;
      parentId: string | null;
      timestamp: string;
      targetLeafId: string | null;
      reason?: string;
      metadata?: JsonObject;
    };

export interface ContextCompressionRuntimeOptions {
  enabled?: boolean;
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
  includeThought?: boolean | undefined;
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
  reason: ContextCompressionReason;
  policy: ContextCompressionPolicyMetadata;
  handoffIntent: boolean;
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
  previousCompressionSummary?: string | undefined;
}

export interface ContextStateReader {
  snapshotForCompression(): Promise<ContextStateSnapshot> | ContextStateSnapshot;
  recordCompression?(record: ContextCompressionRecord): Promise<void> | void;
  recordCheckpoint?(checkpoint: RuntimeCheckpointRecord): Promise<void> | void;
}

export type AgentEndReason = "stop" | "max-turns" | "aborted" | "error";

export interface ProviderResponse {
  finishReason: "stop" | "tool-call" | "length" | "error";
  text: string;
  thought?: string;
  toolCalls: Array<{
    id: string;
    toolName: string;
    input: JsonObject;
  }>;
  diagnostics: ProviderDiagnostic[];
  usage?: ProviderUsage;
  error?: string;
}
