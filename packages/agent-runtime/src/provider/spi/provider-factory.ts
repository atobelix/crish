import type { AgentProvider } from "../../types";
import type { ProviderCredentialSource } from "../../provider-gateway/types";

export interface ProviderFactory {
  readonly id: string;
  create(credential?: ProviderCredentialSource): AgentProvider;
}
