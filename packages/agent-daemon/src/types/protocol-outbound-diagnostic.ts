import type {
  DaemonLifecycleSnapshot,
  DaemonProviderStatusSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonCapabilitySnapshot,
  ApprovalStatusSnapshot,
} from "./snapshot-types.js";

export interface StatusResponseMessage {
  type: "status-response";
  lifecycle: DaemonLifecycleSnapshot;
  activeRuns: Array<{
    runId: string;
    prompt: string;
    status: string;
    startedAt: number;
    cwd: string;
  }>;
  pendingApprovals: ApprovalStatusSnapshot[];
  recentApprovals: ApprovalStatusSnapshot[];
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
  capabilities: DaemonCapabilitySnapshot;
}

export interface CapabilitiesResponseMessage {
  type: "capabilities-response";
  snapshot: DaemonCapabilitySnapshot;
}

export interface ConfigUpdatedMessage {
  type: "config-updated";
  updatedFields: string[];
}

export interface ProviderModelsProbedMessage {
  type: "provider-models-probed";
  ok: boolean;
  models: string[];
  error?: string;
}

export interface ProviderChatProbedMessage {
  type: "provider-chat-probed";
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
