export type AuthMode = 'api_key' | 'oauth2' | 'none' | 'sigv4' | 'custom_header';

export type AuthConfig = {
  mode: AuthMode;
  apiKey?: string;
  apiKeyHeader?: string;
  oauth2?: OAuth2Config;
  sigv4?: SigV4Config;
  customHeaders?: Record<string, string>;
};

export type OAuth2Config = {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: string[];
  redirectUri: string;
};

export type SigV4Config = { region: string; service: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; };

export type ProviderHealth = { status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'ok' | 'error'; latencyMs?: number; lastCheckedAt?: number };
export type ProviderModel = ModelMeta & { name?: string };

export type ModelCap = 'tool_call' | 'vision' | 'reasoning' | 'streaming' | 'structured_output' | 'function_calling' | 'parallel_tool_call' | 'thinking' | 'multimodal' | 'audio' | 'image_generation' | 'code_execution';

export type ThinkingConfig = { enabled: boolean; budgetToken?: number; temperature?: number; effort?: 'low' | 'medium' | 'high'; displayThinking?: boolean; };

export type ModelMeta = {
  id: string; providerId: string; displayName?: string; description?: string;
  contextWindow: number; maxOutputTokens: number;
  pricing: ModelPricing[];
  capabilities: ModelCap[];
  thinkingConfig?: ThinkingConfig;
  aliases: string[]; releasedAt?: string; deprecatedAt?: string; isDeprecated: boolean;
  order: number; enabled: boolean;
};

export type ModelPricing = { currency: 'CNY' | 'USD' | 'EUR'; inputPricePer1K: number; outputPricePer1K: number; cachedInputPricePer1K?: number; batchInputPricePer1K?: number; batchOutputPricePer1K?: number; };

export type EngineType = 'openai-compatible' | 'anthropic-native' | 'gemini-native' | 'azure-openai' | 'aws-bedrock' | 'gcp-vertex' | 'ollama' | 'custom';

export type RateLimitConfig = { rpm: number; tpm: number; rpmBurst?: number; coolDownMs: number; maxConcurrency: number; maxRequestsPerMinute?: number; maxTokensPerMinute?: number; maxConcurrentRequests?: number; };

export type HealthStatus = { providerId: string; status: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'; latencyMs?: number; lastCheckedAt?: string; error?: string; };

export type FallbackErrorType = 'rate_limit' | 'timeout' | 'auth_error' | 'server_error' | 'context_overflow';
export type FallbackRule = { errorType: FallbackErrorType; fallbackProviderId: string; fallbackModelId?: string; retryCount?: number; };

export type FallbackConfig = { errorTypes: FallbackRule[]; enabled?: boolean; fallbackProviderId?: string; fallbackModels?: string[]; onTimeout?: boolean; onRateLimit?: boolean; onError?: boolean; };

export type ProviderConfig = {
  id: string; name: string; engineType: EngineType; baseUrl: string;
  displayName?: string; description?: string; icon?: string;
  auth: AuthConfig;
  models: ModelMeta[];
  autoSyncModels: boolean; lastSyncedAt?: string;
  rateLimit: RateLimitConfig;
  healthStatus?: HealthStatus;
  fallback: FallbackConfig;
  enabled: boolean; createdAt: string; updatedAt: string;
};

export type RoutingRole = 'primary' | 'fast' | 'editor' | 'embedding';
export type ModelRole = RoutingRole;
export type TaskType = 'chat' | 'code' | 'planning' | 'vision' | 'audio' | 'embedding' | 'tool_use';

export type ModelRoute = {
  id: string; role: RoutingRole; taskTypes: TaskType[];
  providerId: string; modelId: string; priority: number;
  fallbackChain: FallbackRule[];
  budget?: BudgetConfig; enabled: boolean;
};

export type BudgetConfig = { maxCostPerRun?: number; maxCostPerDay?: number; maxCostPerMonth?: number; currency: 'CNY' | 'USD'; };

export type AccountProvider = 'chatgpt' | 'anthropic' | 'google' | 'custom_oauth';
export interface Account {
  id: string; provider: AccountProvider; label: string;
  email?: string;
  authType: 'oauth2' | 'session_token' | 'api_key';
  sessionToken?: string; accessToken?: string; refreshToken?: string; expiresAt?: number;
  oauthConfig?: OAuth2Config;
  status: 'active' | 'expired' | 'error' | 'cooling';
  cooldownUntil?: number;
  lastCheckedAt?: number;
  usageScore?: number;
  lastUsedAt?: string; poolWeight?: number; isDefault: boolean;
}
