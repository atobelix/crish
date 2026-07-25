declare const __secret: unique symbol;
export type SecretValue = string & { [__secret]: true };

export function createSecret(raw: string): SecretValue {
  return raw as SecretValue;
}

export function obfuscateSecret(secret: SecretValue): string {
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "*".repeat(Math.min(secret.length - 8, 12)) + secret.slice(-4);
}

export type AuthMethod =
  | { type: "no_auth" }
  | { type: "bearer_token"; token: SecretValue }
  | { type: "api_key"; headerName: string; key: SecretValue }
  | { type: "basic"; username: string; password: SecretValue }
  | { type: "aws_sig_v4"; region: string; accessKeyId: SecretValue; secretAccessKey: SecretValue; sessionToken?: SecretValue }
  | { type: "azure_api_key"; key: SecretValue }
  | { type: "oauth"; provider: string; config: OAuth2Config }
  | { type: "custom"; providerName: string; params: Record<string, string> }
  | { type: "chain"; methods: AuthMethod[] };

export interface OAuth2Config {
  clientId: string;
  clientSecret?: SecretValue;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: string[];
  redirectUri: string;
}
