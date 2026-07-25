import type { JsonObject } from "@crish/shared-types";
import {
  isWorkbenchRecord,
  isFiniteNumber,
  isDaemonProviderStatusSnapshot,
  isDaemonLifecycleSnapshot,
  isDaemonMcpStatusSnapshot,
} from "./guards";
import type {
  WorkbenchProviderConfigSnapshot,
  DaemonActiveRunEntry,
  DaemonPendingApprovalEntry,
  WorkbenchStatus,
  WorkbenchApiKeySource,
  WorkbenchProviderCredentialStatus,
  WorkbenchProviderMode,
} from "./workbench-ui";

export type DaemonProviderCredentialMode = "direct" | "account-center" | "auto";
export type DaemonProviderReadiness =
  | "ready"
  | "missing"
  | "login-required"
  | "insufficient-quota"
  | "gateway-unavailable"
  | "credential-unavailable"
  | "invalid-response"
  | "unknown";
export type DaemonProviderApiKeySource =
  | "default"
  | "env"
  | "runtime-update"
  | "user-config"
  | "workspace-config"
  | "unset"
  | "unknown";
export interface DaemonProviderRedactedApiKeyStatus {
  hasApiKey: boolean;
  source: DaemonProviderApiKeySource;
  last4?: string;
}
export type DaemonAccountLoginStatus = "ready" | "required" | "unknown";
export type DaemonAccountQuotaStatus = "ready" | "insufficient" | "unknown";
export type DaemonAccountGatewayStatus = "ready" | "unavailable" | "unknown";
export type DaemonAccountRuntimeCredentialStatus = "ready" | "unavailable" | "unknown";

export interface DaemonProviderDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  kind?: string;
  status?: number;
  detail?: string;
  metadata?: JsonObject;
}

export interface DaemonAccountCenterStatusSnapshot {
  configured: boolean;
  accountId?: string;
  login: DaemonAccountLoginStatus;
  quota: DaemonAccountQuotaStatus;
  gateway: DaemonAccountGatewayStatus;
  runtimeCredential: DaemonAccountRuntimeCredentialStatus;
  lastCheckedAt?: string;
  lastDiagnostic?: DaemonProviderDiagnostic;
}

export interface DaemonProviderGatewayStatusSnapshot {
  ready: boolean;
  credentialConfigured: boolean;
  routeDecision: string[];
  code?: string;
  selectedRouteId?: string;
  selectedProviderId?: string;
  selectedEndpointSupport?: "responses" | "chat-completions" | "auto";
  selectedStreamingSupport?: "streaming" | "non-streaming" | "optional" | "unknown";
  updatedAt?: string;
}

export interface DaemonProviderStatusSnapshot {
  credentialMode: DaemonProviderCredentialMode;
  readiness: DaemonProviderReadiness;
  providerId: string;
  routeId: string;
  baseUrl: string;
  model: string;
  upstreamModel: string;
  endpoint: "auto" | "responses" | "chat-completions";
  stream: boolean;
  systemPromptWireMode: "native-system-role" | "user-prefix";
  apiKey: DaemonProviderRedactedApiKeyStatus;
  hasDirectApiKey: boolean;
  apiKeySource: DaemonProviderApiKeySource;
  accountCenter: DaemonAccountCenterStatusSnapshot;
  gateway: DaemonProviderGatewayStatusSnapshot;
  lastDiagnostic?: DaemonProviderDiagnostic;
  updatedAt: string;
}

export type DaemonMcpReadiness = "ready" | "degraded" | "starting" | "stopped" | "unknown";

export interface DaemonMcpStatusSnapshot {
  configured: boolean;
  readiness: DaemonMcpReadiness;
  serverCount: number;
  summary: JsonObject;
  diagnostics: JsonObject[];
  servers: JsonObject[];
  updatedAt: string;
}

export type DaemonLifecycleState = "starting" | "ready" | "stopping" | "stopped" | "degraded";

export type DaemonLifecycleDiagnosticSource =
  | "daemon"
  | "websocket"
  | "client"
  | "event-store"
  | "provider"
  | "mcp";

export type DaemonLifecycleDiagnosticSeverity = "warning" | "error";

export interface DaemonLifecycleDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  source: DaemonLifecycleDiagnosticSource;
  severity: DaemonLifecycleDiagnosticSeverity;
  detail?: string;
  metadata?: JsonObject;
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
  failure?: DaemonLifecycleDiagnostic;
}

export interface DaemonLifecycleSnapshot {
  state: DaemonLifecycleState;
  startedAt: string;
  updatedAt: string;
  readyAt?: string;
  stoppingAt?: string;
  stoppedAt?: string;
  uptimeMs: number;
  currentPort: number | null;
  connectedClientCount: number;
  totalClientConnectionCount: number;
  totalClientDisconnectCount: number;
  activeRunCount: number;
  recentDisconnect?: DaemonClientDisconnectSnapshot;
  recentError?: DaemonLifecycleDiagnostic;
  eventStore: DaemonEventStoreStatusSnapshot;
  providerReadiness: DaemonProviderReadiness;
  mcpReadiness: DaemonMcpReadiness;
}

export interface DaemonStatusResponse {
  type?: "status-response";
  lifecycle: DaemonLifecycleSnapshot;
  activeRuns: Array<{
    runId: string;
    prompt: string;
    status: string;
    startedAt: number;
    cwd: string;
  }>;
  pendingApprovals: Array<{
    toolCallId: string;
    runId: string;
    toolName: string;
    summary: string;
    createdAt: number;
    metadata?: JsonObject;
  }>;
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
}

export interface DaemonStatusProjectionOptions {
  providerConfig?: WorkbenchProviderConfigSnapshot;
  previousProviderConfig?: WorkbenchProviderConfigSnapshot | null;
}

function workbenchApiKeySourceFromDaemon(source: DaemonProviderApiKeySource): WorkbenchApiKeySource {
  if (source === "env") return "env";
  if (source === "runtime-update") return "frontend";
  if (source === "workspace-config") return "frontend";
  if (source === "user-config") return "frontend";
  if (source === "unset") return "unset";
  return "unknown";
}

function workbenchCredentialStatusFromReadiness(
  status: DaemonProviderStatusSnapshot
): WorkbenchProviderCredentialStatus {
  if (status.readiness === "ready") return "ready";
  if (status.readiness === "missing") return "missing";
  if (status.readiness === "unknown" && status.credentialMode !== "direct") {
    return status.accountCenter.configured ? "account-center-pending" : "unknown";
  }
  return status.readiness;
}

function providerStatusText(status: DaemonProviderStatusSnapshot): string {
  switch (status.readiness) {
    case "ready":
      return status.credentialMode === "direct" || (status.credentialMode === "auto" && status.apiKey.hasApiKey)
        ? "Direct provider key is ready"
        : "Account center is ready";
    case "missing":
      return status.credentialMode === "direct"
        ? "Provider API key is required"
        : "Account center is not configured";
    case "login-required":
      return "Account-center login is required";
    case "insufficient-quota":
      return "Account-center quota is insufficient";
    case "gateway-unavailable":
      return "Account-center gateway is unavailable";
    case "credential-unavailable":
      return "Runtime provider credential is unavailable";
    case "invalid-response":
      return "Account-center returned an invalid response";
    case "unknown":
    default:
      return "Provider readiness is unknown";
  }
}

export function projectDaemonProviderStatusToWorkbench(
  status: DaemonProviderStatusSnapshot,
  previous?: WorkbenchProviderConfigSnapshot | null
): WorkbenchProviderConfigSnapshot {
  const apiKey = status.apiKey ?? {
    hasApiKey: status.hasDirectApiKey,
    source: status.apiKeySource,
  };
  const apiKeySource = workbenchApiKeySourceFromDaemon(apiKey.source);
  const credentialStatus = workbenchCredentialStatusFromReadiness(status);
  const lastDiag = status.lastDiagnostic ?? status.accountCenter.lastDiagnostic;
  return {
    baseUrl: status.baseUrl,
    model: status.model || previous?.model || "",
    hasApiKey: apiKey.hasApiKey,
    apiKeySource,
    accountCenterConfigured: status.accountCenter.configured,
    credentialMode: status.credentialMode as WorkbenchProviderMode,
    credentialStatus,
    statusText: providerStatusText(status),
    updatedAt: status.updatedAt,
    endpoint: status.endpoint,
    stream: status.stream,
    systemPromptWireMode: status.systemPromptWireMode,
    providerId: status.providerId,
    ...(status.accountCenter.accountId ? { accountId: status.accountCenter.accountId } : {}),
    upstreamModel: status.upstreamModel,
    readiness: status.readiness,
    accountCenter: status.accountCenter,
    gateway: status.gateway,
    ...(lastDiag ? { lastDiagnostic: lastDiag } : {}),
  };
}

export function projectDaemonStatusToWorkbench(
  input: unknown,
  options: DaemonStatusProjectionOptions = {}
): WorkbenchStatus {
  const record = isWorkbenchRecord(input) ? input : {};
  const rest: Record<string, unknown> = { ...record };
  delete rest.activeRuns;
  delete rest.pendingApprovals;
  delete rest.providerStatus;
  delete rest.providerConfig;
  delete rest.lifecycle;
  delete rest.mcpStatus;
  const activeRunArray = Array.isArray(record.activeRuns) ? record.activeRuns : [];
  const activeRuns = activeRunArray.length || (isFiniteNumber(record.activeRuns) ? record.activeRuns : 0);
  const pendingApprovalArray = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : [];
  const pendingApprovals = pendingApprovalArray.length || (isFiniteNumber(record.pendingApprovals) ? record.pendingApprovals : 0);
  const providerStatus = isDaemonProviderStatusSnapshot(record.providerStatus)
    ? record.providerStatus
    : undefined;
  const lifecycle = isDaemonLifecycleSnapshot(record.lifecycle) ? record.lifecycle : undefined;
  const mcpStatus = isDaemonMcpStatusSnapshot(record.mcpStatus) ? record.mcpStatus : undefined;
  const providerConfig = providerStatus
    ? projectDaemonProviderStatusToWorkbench(providerStatus, options.previousProviderConfig)
    : options.providerConfig;

  return {
    ...rest,
    activeRuns,
    pendingApprovals,
    ...(activeRunArray.length > 0 ? { activeRunList: activeRunArray as DaemonActiveRunEntry[] } : {}),
    ...(pendingApprovalArray.length > 0 ? { pendingApprovalList: pendingApprovalArray as DaemonPendingApprovalEntry[] } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerConfig ? { providerConfig } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(mcpStatus ? { mcpStatus } : {}),
  };
}
