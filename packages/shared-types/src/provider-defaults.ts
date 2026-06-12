export type CrishProviderCredentialMode = "direct" | "account-center" | "auto";
export type CrishProviderEndpoint = "auto" | "responses" | "chat-completions";

export interface CrishDefaultProviderConfig {
  providerId: string;
  baseUrl: string;
  model: string;
  endpoint: CrishProviderEndpoint;
  stream: boolean;
  credentialMode: CrishProviderCredentialMode;
  apiKeyEnv: string;
}
