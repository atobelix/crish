import type {
  DaemonProviderReadiness,
  DaemonAccountCenterStatusSnapshot,
  DaemonProviderGatewayStatusSnapshot,
  DaemonProviderDiagnostic,
  DaemonProviderStatusSnapshot,
  DaemonLifecycleSnapshot,
  DaemonMcpStatusSnapshot,
} from "./daemon-status";

export type WorkbenchMode = "plan" | "execute" | "review" | "discuss";

export type WorkbenchRunState =
  | "idle"
  | "planning"
  | "running"
  | "waiting"
  | "blocked"
  | "done";

export type WorkbenchRunLifecycleStatus = "running" | "completed" | "cancelled" | "failed";

export type WorkbenchPlanState = "todo" | "doing" | "done" | "blocked";
export type WorkbenchEvidenceKind = "file" | "command" | "check" | "decision";
export type WorkbenchConfirmationKind = "write" | "danger" | "outside-project" | "credential" | "network";
export type WorkbenchBackgroundTaskKind = "command" | "service" | "check" | "scheduled";
export type WorkbenchBackgroundTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
export type WorkbenchOutputReferenceKind = "image" | "markdown" | "text" | "code" | "directory" | "file" | "link" | "unknown";
export type WorkbenchOutputReferenceRender = "inline" | "sidebar" | "open";
export type WorkbenchOutputReferenceSource =
  | "markdown-image"
  | "markdown-link"
  | "workbench-tag"
  | "tool-artifact"
  | "final-summary";
export type WorkbenchDisclosureIssueKind =
  | "relative-path"
  | "missing-local-file"
  | "image-preview-failed"
  | "mojibake"
  | "command-failed"
  | "command-not-found"
  | "empty-output";
export type WorkbenchDisclosureIssueSeverity = "info" | "warning" | "error";

export interface WorkbenchProject {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
}

export interface WorkbenchPlanItem {
  id: string;
  title: string;
  state: WorkbenchPlanState;
  note?: string;
  evidenceIds?: string[];
}

export interface WorkbenchAcceptanceItem {
  id: string;
  title: string;
  required: boolean;
  passed: boolean;
  evidenceIds: string[];
}

export interface WorkbenchEvidenceItem {
  id: string;
  kind: WorkbenchEvidenceKind;
  title: string;
  detail?: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchChangeItem {
  path: string;
  additions: number;
  deletions: number;
  state: "draft" | "checked" | "needs-review";
  checkpointId?: string;
}

export interface WorkbenchConfirmationRequest {
  id: string;
  kind: WorkbenchConfirmationKind;
  title: string;
  detail: string;
  primaryAction: string;
  secondaryAction: string;
}

export interface WorkbenchHealth {
  state: "good" | "busy" | "degraded";
  summary: string;
  memoryMb?: number;
  cpuPercent?: number;
  lastEventAt?: string;
  stalledForMs?: number;
}

export interface WorkbenchTokenBudgetSnapshot {
  enabled: boolean;
  difficulty: string;
  maxTotalTokens: number;
  usedTotalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  missingUsageMessages: number;
  warned: boolean;
  reached: boolean;
  updatedAt: string;
}

export interface WorkbenchLongRunPolicy {
  enabled: boolean;
  targetMinutes: number;
  reviewEveryMinutes: number;
  maxSilentMinutes: number;
  continuationPrompt: string;
}

export type WorkbenchMetricsStoreStatus = "ok" | "degraded";
export type WorkbenchMetricsScope = "global" | "session" | "run";

export interface WorkbenchDurationMetrics {
  count: number;
  min?: number;
  max?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface WorkbenchProviderUsageMetrics {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface WorkbenchCacheMetricsSnapshot {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
}

export interface WorkbenchStreamingMetricsSnapshot {
  textDeltaCount: number;
  textDeltaBytes?: number;
  textDeltaCharacters?: number;
  providerDiagnosticCount: number;
  firstTextDeltaLatencyMs?: number;
  firstProviderResponseLatencyMs?: number;
  providerStreamDurationMs?: number;
  tokensPerSecond?: number;
  textBytesPerSecond?: number;
  textCharactersPerSecond?: number;
  eventsPerSecond?: number;
  terminalEventCount?: number;
  interruptedCount?: number;
  errorCount?: number;
  terminalReasons?: Record<string, number>;
  cancelRequestedCount?: number;
  cancelObserved?: boolean;
  cancelLatencyMs?: number;
}

export interface WorkbenchToolNameMetricsSnapshot {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: WorkbenchDurationMetrics;
}

export interface WorkbenchToolMetricsSnapshot {
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: WorkbenchDurationMetrics;
  byName: Record<string, WorkbenchToolNameMetricsSnapshot>;
}

export interface WorkbenchFailureMetricsSnapshot {
  errorCount: number;
  runtimeErrorCount: number;
  agentErrorCount: number;
  providerErrorCount: number;
  contextCompressionErrorCount: number;
  timeoutCount: number;
  cancelCount: number;
}

export interface WorkbenchMetricsDimensions {
  providerFamily?: string;
  providerId?: string;
  modelFamily?: string;
  configuredModel?: string;
  actualModel?: string;
  cacheStrategy?: string;
  stablePrefixHash?: string;
  toolSchemaHash?: string;
  cacheKey?: string;
}

export interface WorkbenchMetricsDimensionSnapshot extends WorkbenchMetricsDimensions {
  promptAssemblyCount: number;
  providerUsage: WorkbenchProviderUsageMetrics;
  cache: WorkbenchCacheMetricsSnapshot;
  providerLatencyMs: WorkbenchDurationMetrics;
}

export interface WorkbenchRuntimeMetricsSnapshot {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  eventCount: number;
  turnCount: number;
  tools: WorkbenchToolMetricsSnapshot;
  providerUsage: WorkbenchProviderUsageMetrics;
  providerLatencyMs: WorkbenchDurationMetrics;
  streaming: WorkbenchStreamingMetricsSnapshot;
  cache: WorkbenchCacheMetricsSnapshot;
  failures: WorkbenchFailureMetricsSnapshot;
  latestDimensions?: WorkbenchMetricsDimensions;
  dimensions: WorkbenchMetricsDimensionSnapshot[];
}

export interface WorkbenchMetricsRunRecord {
  runId: string;
  sessionId: string;
  updatedAt: string;
  snapshot: WorkbenchRuntimeMetricsSnapshot;
}

export interface WorkbenchMetricsSummary {
  scope: WorkbenchMetricsScope;
  runCount: number;
  sessionCount: number;
  snapshot: WorkbenchRuntimeMetricsSnapshot;
}

export interface WorkbenchMetricsSource {
  kind: "jsonl";
  path: string;
  generation: number;
  status: WorkbenchMetricsStoreStatus;
  badLineCount: number;
}

export interface WorkbenchMetricsDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  path?: string;
  detail?: string;
}

export interface WorkbenchMetricsQuery {
  runId?: string;
  sessionId?: string;
  includeRuns?: boolean;
}

export interface WorkbenchMetricsQueryResult {
  status: WorkbenchMetricsStoreStatus;
  query: {
    runId?: string;
    sessionId?: string;
    includeRuns: boolean;
  };
  source: WorkbenchMetricsSource;
  summary: WorkbenchMetricsSummary;
  runs?: WorkbenchMetricsRunRecord[];
  diagnostic?: WorkbenchMetricsDiagnostic;
}

export interface WorkbenchBackgroundTask {
  id: string;
  kind: WorkbenchBackgroundTaskKind;
  title: string;
  state: WorkbenchBackgroundTaskState;
  cwd?: string;
  command?: string;
  detail?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  heartbeatAt?: string;
  heartbeatCount: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  summary?: string;
  outputPreview?: string;
  continuationPrompt?: string;
  evidenceIds?: string[];
}

export interface WorkbenchOutputReference {
  id: string;
  label: string;
  kind: WorkbenchOutputReferenceKind;
  render: WorkbenchOutputReferenceRender;
  source: WorkbenchOutputReferenceSource;
  path?: string;
  url?: string;
  mimeType?: string;
  previewable: boolean;
  editable: boolean;
  absolute: boolean;
  issues: string[];
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WorkbenchDisclosureIssue {
  id: string;
  kind: WorkbenchDisclosureIssueKind;
  severity: WorkbenchDisclosureIssueSeverity;
  title: string;
  detail: string;
  suggestion: string;
  targetId?: string;
  createdAt: string;
}

export interface WorkbenchDisclosureSuggestion {
  shouldInject: boolean;
  message: string;
  issues: WorkbenchDisclosureIssue[];
  createdAt: string;
}

export interface WorkbenchTaskSnapshot {
  id: string;
  project: WorkbenchProject;
  mode: WorkbenchMode;
  state: WorkbenchRunState;
  title: string;
  userGoal: string;
  progressLabel: string;
  completionPercent: number;
  plan: WorkbenchPlanItem[];
  acceptance: WorkbenchAcceptanceItem[];
  evidence: WorkbenchEvidenceItem[];
  changes: WorkbenchChangeItem[];
  confirmations: WorkbenchConfirmationRequest[];
  backgroundTasks: WorkbenchBackgroundTask[];
  outputReferences: WorkbenchOutputReference[];
  disclosureIssues: WorkbenchDisclosureIssue[];
  tokenBudget?: WorkbenchTokenBudgetSnapshot;
  nextActions: string[];
  health: WorkbenchHealth;
  longRun: WorkbenchLongRunPolicy;
}

export interface WorkbenchRuntimeStatus {
  ok: boolean;
  shell: "cli" | "tauri";
  cwd: string;
  message: string;
  capabilities: WorkbenchRuntimeCapability[];
}

export interface WorkbenchRuntimeCapability {
  id: string;
  title: string;
  ready: boolean;
}

export type WorkbenchProviderMode = "direct" | "account-center" | "auto";
export type WorkbenchApiKeySource = "frontend" | "env" | "unset" | "unknown";
export type WorkbenchAccountCenterConfigured = boolean | "unknown";
export type WorkbenchProviderCredentialStatus =
  | "ready"
  | "missing"
  | "account-center-pending"
  | "login-required"
  | "insufficient-quota"
  | "gateway-unavailable"
  | "credential-unavailable"
  | "invalid-response"
  | "unknown";

export interface WorkbenchProviderConfigSnapshot {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeySource: WorkbenchApiKeySource;
  accountCenterConfigured: WorkbenchAccountCenterConfigured;
  credentialMode: WorkbenchProviderMode;
  credentialStatus: WorkbenchProviderCredentialStatus;
  statusText: string;
  updatedAt: string;
  endpoint?: "auto" | "responses" | "chat-completions";
  stream?: boolean;
  systemPromptWireMode?: "native-system-role" | "user-prefix";
  providerId?: string;
  accountId?: string;
  upstreamModel?: string;
  readiness?: DaemonProviderReadiness;
  accountCenter?: DaemonAccountCenterStatusSnapshot;
  gateway?: DaemonProviderGatewayStatusSnapshot;
  lastDiagnostic?: DaemonProviderDiagnostic;
}

export interface WorkbenchStatus {
  activeRuns: number;
  pendingApprovals: number;
  activeRunList?: DaemonActiveRunEntry[];
  pendingApprovalList?: DaemonPendingApprovalEntry[];
  providerConfig?: WorkbenchProviderConfigSnapshot;
  providerStatus?: DaemonProviderStatusSnapshot;
  lifecycle?: DaemonLifecycleSnapshot;
  mcpStatus?: DaemonMcpStatusSnapshot;
  [key: string]: unknown;
}

export interface DaemonActiveRunEntry {
  runId: string;
  prompt: string;
  status: string;
  startedAt: number;
  cwd: string;
}

export interface DaemonPendingApprovalEntry {
  toolCallId: string;
  runId: string;
  toolName: string;
  summary: string;
  createdAt: number;
}

export interface WorkbenchProviderConfigUpdate {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: WorkbenchProviderMode;
  endpoint?: "auto" | "responses" | "chat-completions";
  stream?: boolean;
}

export interface WorkbenchStartRequest {
  cwd: string;
  prompt: string;
  mode?: WorkbenchMode;
}

export interface WorkbenchContinuationDecision {
  action: "continue" | "pause" | "complete";
  reason: string;
  prompt?: string;
}

export type WorkbenchRunEventType =
  | "run-start"
  | "message-update"
  | "tool-update"
  | "plan-update"
  | "progress-update"
  | "change-update"
  | "approval-required"
  | "health-update"
  | "checkpoint-created"
  | "disclosure-suggestion"
  | "background-task-start"
  | "background-task-heartbeat"
  | "background-task-end"
  | "resume-requested"
  | "run-end"
  | "run-error";

export interface WorkbenchRunEvent {
  runId?: string;
  type: WorkbenchRunEventType;
  message: string;
  timestamp: string;
  payload?: unknown;
}
