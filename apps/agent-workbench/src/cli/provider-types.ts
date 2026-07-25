export type ProviderEngine = "openai-compatible" | "anthropic" | "gemini";
export type AuthMethod = "bearer" | "api-key" | "basic" | "aws-sig-v4" | "azure-api-key" | "oauth2" | "custom" | "chain" | "none";
export type ApiKeySource = "env" | "direct" | "file";

export interface ProviderAuthConfig {
  method: AuthMethod;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  keyHeader?: string;
  bearerPrefix?: string;
  username?: string;
  usernameEnv?: string;
  awsRegion?: string;
  awsService?: string;
  awsAccessKeyIdEnv?: string;
  awsSecretAccessKeyEnv?: string;
  azureHeader?: string;
  credentialSource?: {
    type: "env" | "direct" | "file" | "account" | "oauth";
    hint?: string;
  };
}

export interface RetryConfig {
  maxAttempts: number;
  totalBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ProviderFeatures {
  supportsToolCalls?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsPromptCaching?: boolean;
  supportsReasoning?: boolean;
  supportsAudioInput?: boolean;
  supportsComputerUse?: boolean;
  supportsWebSearch?: boolean;
}

export interface ProviderModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  features?: {
    supportsFunctionCalling?: boolean;
    supportsParallelFunctionCalling?: boolean;
    supportsVision?: boolean;
  };
  pricing?: {
    inputPer1K?: number;
    outputPer1K?: number;
    currency?: string;
  };
}

export interface ProviderDefinition {
  id: string;
  name: string;
  version: string;
  engine: ProviderEngine;
  description?: string;
  tags?: string[];
  baseUrl: string;
  pathPrefix?: string;
  auth: ProviderAuthConfig;
  defaultModel: string;
  models?: ProviderModelEntry[];
  modelListEndpoint?: string;
  endpoint?: "auto" | "chat-completions" | "responses";
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeout?: number;
  headers?: Record<string, string>;
  retry?: RetryConfig;
  transport?: "fetch" | "rust-reqwest" | "auto";
  features?: ProviderFeatures;
  limitations?: string[];
  docsUrl?: string;
  anthropicVersion?: string;
  authViaQuery?: boolean;
}

export interface ConnectionTestResults {
  baseUrlReachable: boolean;
  baseUrlStatus: number;
  baseUrlLatencyMs: number;
  authSuccess: boolean;
  authStatusCode: number;
  modelsCount: number;
  modelsList: string[];
  streamTestSuccess: boolean;
  streamTestLatencyMs: number;
  toolCallSupported: boolean;
  warnings: string[];
  errors: string[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface ValidationResult {
  file: string;
  passed: boolean;
  checks: ValidationCheck[];
  networkChecks?: ValidationCheck[];
}

export interface TestSuiteResult {
  providerId: string;
  baseUrl: string;
  model: string;
  basic: TestResult[];
  modelList: TestResult[];
  stress: TestResult[];
  errors: TestResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
    rating: "recommended" | "acceptable" | "not-recommended";
  };
}

export interface TestResult {
  name: string;
  passed: boolean;
  latencyMs?: number;
  message?: string;
  severity?: "info" | "warning" | "error";
}
