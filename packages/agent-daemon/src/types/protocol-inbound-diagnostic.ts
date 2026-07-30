import type { OpenAICompatibleEndpoint } from "@crish/agent-model";
import type { DaemonMcpServerConfig } from "./config.js";
import type {
  DaemonProviderCredentialMode,
} from "./provider-types.js";

export interface GetStatusMessage {
  type: "get-status";
}

export interface ListCapabilitiesMessage {
  type: "list-capabilities";
}

export interface UpdateConfigMessage {
  type: "update-config";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: DaemonProviderCredentialMode;
  endpoint?: OpenAICompatibleEndpoint;
  stream?: boolean;
  mcpServers?: DaemonMcpServerConfig[];
}

export interface ProbeProviderModelsMessage {
  type: "probe-provider-models";
  profileId: string;
  baseUrl: string;
  apiKey: string;
}

export interface ProbeProviderChatMessage {
  type: "probe-provider-chat";
  profileId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}
