import type { ProviderCredentialSource } from "../../provider-gateway/types";

export interface ProviderConfig {
  id: string;
  name: string;
  description?: string;
  model: string;
  defaultBaseUrl?: string;
  defaultApiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  requestTimeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export type { ProviderCredentialSource };
