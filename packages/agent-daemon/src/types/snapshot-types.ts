import type { JsonObject } from "@crish/shared-types";
import type { OpenAICompatibleEndpoint } from "@crish/agent-runtime";
import type {
  DaemonProviderCredentialMode,
  DaemonProviderReadiness,
  DaemonSystemPromptWireMode,
  DaemonProviderApiKeySource,
  DaemonProviderRedactedApiKeyStatus,
  DaemonProviderDiagnostic,
  DaemonProviderGatewayStatusSnapshot,
} from "./provider-types.js";

export type DaemonTaskSnapshotStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type DaemonTaskMessageRole = "system" | "user" | "assistant";

export interface DaemonTaskMessageSnapshot {
  id: string;
  role: DaemonTaskMessageRole;
  content: string;
  createdAt: string;
  toolCalls: DaemonTaskSnapshotToolCall[] | undefined;
}

export interface DaemonTaskSnapshotToolCall {
  id: string;
  name: string;
  input: JsonObject;
  status: "pending" | "running" | "approval-required" | "completed" | "failed";
  summary: string | undefined;
  startedAt: string;
  updatedAt: string;
  output: string | undefined;
  approvalMetadata: JsonObject | undefined;
}

export interface DaemonTaskSnapshotApproval {
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  summary: string;
  requestedAt: string;
  status: "pending";
  risk: string | undefined;
  riskReason: string | undefined;
  requiresDoubleConfirm: boolean | undefined;
  recommendSnapshot: boolean | undefined;
  metadata: JsonObject | undefined;
}

export interface DaemonBackgroundTaskDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  updatedAt: string;
  detail: string | undefined;
  metadata: JsonObject | undefined;
}

export interface DaemonBackgroundTaskSnapshot {
  id: string;
  kind: "command";
  title: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
  command: string;
  cwd: string | undefined;
  startedAt: string | undefined;
  updatedAt: string;
  finishedAt: string | undefined;
  durationMs: number | undefined;
  timeoutMs: number | undefined;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  timedOut: boolean | undefined;
  cancelled: boolean | undefined;
  truncated: boolean | undefined;
  stdoutBytes: number | undefined;
  stderrBytes: number | undefined;
  outputPreview: string | undefined;
  diagnostics: DaemonBackgroundTaskDiagnostic[] | undefined;
}

export interface DaemonTaskSnapshotRunMetadata {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  metadata: JsonObject;
}

export interface DaemonTaskSnapshotProgress {
  label: string;
  eventCount: number;
  turnCount: number;
  textDeltaCount: number;
  toolCallCount: number;
  completedToolCallCount: number;
  pendingToolCallCount: number;
  approvalPending: boolean;
  updatedAt: string;
}

export interface DaemonTaskSnapshotUsage {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface DaemonTaskSnapshotCache {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
  stablePrefixHash: string | undefined;
  cacheKey: string | undefined;
  cacheStrategy: string | undefined;
}

export interface DaemonTaskSnapshot {
  runId: string;
  sessionId: string;
  status: DaemonTaskSnapshotStatus;
  title: string;
  messages: DaemonTaskMessageSnapshot[];
  latestError: string | undefined;
  approval: DaemonTaskSnapshotApproval | undefined;
  pendingToolCalls: DaemonTaskSnapshotToolCall[];
  backgroundTasks: DaemonBackgroundTaskSnapshot[];
  progress: DaemonTaskSnapshotProgress;
  usage: DaemonTaskSnapshotUsage;
  cache: DaemonTaskSnapshotCache;
  updatedAt: string;
  progressLabel: string;
  currentRun: DaemonTaskSnapshotRunMetadata;
}

export type DaemonLifecycleState =
  | "starting" | "ready" | "stopping" | "stopped" | "degraded";

export type DaemonLifecycleDiagnosticSource =
  | "daemon" | "websocket" | "client" | "event-store" | "provider" | "mcp";

export type DaemonLifecycleDiagnosticSeverity = "warning" | "error";

export interface DaemonLifecycleDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  source: DaemonLifecycleDiagnosticSource;
  severity: DaemonLifecycleDiagnosticSeverity;
  detail: string | undefined;
  metadata: JsonObject | undefined;
}

export interface DaemonClientDisconnectSnapshot {
  clientId: string;
  code: number;
  reason: string;
  connectedAt: string;
  disconnectedAt: string;
  durationMs: number;
}

export interface DaemonEventStoreStatusSnapshot {
  status: "ok" | "failed";
  path: string;
  failure: DaemonLifecycleDiagnostic | undefined;
}

export type DaemonMcpReadiness =
  | "ready" | "degraded" | "starting" | "stopped" | "unknown";

export interface DaemonMcpStatusSnapshot {
  configured: boolean;
  readiness: DaemonMcpReadiness;
  serverCount: number;
  summary: JsonObject;
  diagnostics: JsonObject[];
  servers: JsonObject[];
  updatedAt: string;
}

export interface DaemonLifecycleSnapshot {
  state: DaemonLifecycleState;
  startedAt: string;
  updatedAt: string;
  readyAt: string | undefined;
  stoppingAt: string | undefined;
  stoppedAt: string | undefined;
  uptimeMs: number;
  currentPort: number | null;
  connectedClientCount: number;
  totalClientConnectionCount: number;
  totalClientDisconnectCount: number;
  activeRunCount: number;
  recentDisconnect: DaemonClientDisconnectSnapshot | undefined;
  recentError: DaemonLifecycleDiagnostic | undefined;
  recentErrors: DaemonLifecycleDiagnostic[] | undefined;
  eventStore: DaemonEventStoreStatusSnapshot;
  providerReadiness: DaemonProviderReadiness;
  mcpReadiness: DaemonMcpReadiness;
}

export interface DaemonProviderStatusSnapshot {
  credentialMode: DaemonProviderCredentialMode;
  readiness: DaemonProviderReadiness;
  providerId: string;
  routeId: string;
  baseUrl: string;
  model: string;
  upstreamModel: string;
  endpoint: OpenAICompatibleEndpoint;
  stream: boolean;
  systemPromptWireMode: DaemonSystemPromptWireMode;
  apiKey: DaemonProviderRedactedApiKeyStatus;
  hasDirectApiKey: boolean;
  apiKeySource: DaemonProviderApiKeySource;
  gateway: DaemonProviderGatewayStatusSnapshot;
  lastDiagnostic: DaemonProviderDiagnostic | undefined;
  updatedAt: string;
  lastProbeOk: boolean | undefined;
  lastProbeAt: string | undefined;
}

export type ApprovalProtocolDecision = "approved" | "denied" | "expired";
export type ApprovalProtocolStatus = "pending" | ApprovalProtocolDecision;

export interface ApprovalStatusSnapshot {
  toolCallId: string;
  runId: string;
  toolName: string;
  summary: string;
  createdAt: number;
  status: ApprovalProtocolStatus;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  resolvedAt: number | undefined;
  expiredAt: number | undefined;
  reason: string | undefined;
  expiredReason: string | undefined;
  risk: string | undefined;
  riskReason: string | undefined;
  requiresDoubleConfirm: boolean | undefined;
  recommendSnapshot: boolean | undefined;
  metadata: JsonObject | undefined;
}

export type DaemonCapabilityState =
  | "implemented"
  | "experimental"
  | "unsupported"
  | "degraded"
  | "backend-not-wired";

export type DaemonCapabilityOwner =
  | "agent-daemon"
  | "agent-runtime"
  | "agent-orchestrator"
  | "workbench"
  | "tauri";

export interface DaemonCapabilityDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  updatedAt: string;
  detail: string | undefined;
  metadata: JsonObject | undefined;
}

export interface DaemonCapabilityRecord {
  id: string;
  title: string;
  state: DaemonCapabilityState;
  reason: string;
  owner: DaemonCapabilityOwner;
  relatedMessageTypes: string[];
  relatedTauriCommands: string[];
  updatedAt: string;
  diagnostics: DaemonCapabilityDiagnostic[];
}

export interface DaemonCapabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  capabilities: DaemonCapabilityRecord[];
}
