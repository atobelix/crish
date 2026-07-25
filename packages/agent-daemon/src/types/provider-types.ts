import type { JsonObject } from "@crish/shared-types";

export type DaemonProviderCredentialMode = "direct" | "auto";

export type DaemonProviderReadiness = "ready" | "missing" | "unknown";

export type DaemonSystemPromptWireMode = "native-system-role" | "user-prefix";

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

export interface DaemonProviderDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  kind?: string;
  status?: number;
  detail?: string;
  metadata?: JsonObject;
}

export interface DaemonProviderGatewayStatusSnapshot {
  ready: boolean;
  credentialConfigured: boolean;
  routeDecision: string[];
  code?: string;
  selectedRouteId?: string;
  selectedProviderId?: string;
  selectedEndpointSupport?: "responses" | "chat-completions" | "auto";
  selectedStreamingSupport?:
    | "streaming"
    | "non-streaming"
    | "optional"
    | "unknown";
  selectedCredentialSource?: JsonObject;
  lastSuccess?: JsonObject;
  lastFailure?: JsonObject;
  updatedAt?: string;
}
