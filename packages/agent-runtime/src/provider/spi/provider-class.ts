import type { AgentProvider } from "../../types";
import type { ProviderCredentialSource } from "../../provider-gateway/types";

export interface ProviderClass {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  create(credential?: ProviderCredentialSource): AgentProvider;
}
