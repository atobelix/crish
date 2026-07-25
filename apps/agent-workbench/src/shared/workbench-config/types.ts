export type WorkbenchProviderEndpoint = "auto" | "responses" | "chat-completions";
export type WorkbenchProviderTransport = "fetch" | "rust-reqwest" | "auto";
export type WorkbenchAuthHeader = "authorization" | "api-key" | "x-api-key";
export type WorkbenchMaxTokensField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";
export type WorkbenchThinkingEffort = "off" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type WorkbenchThinkingEffortFormat = "auto" | "responses" | "chat-completions" | "none";
export type WorkbenchModelVendor = "mimo" | "openai" | "gpt-openai" | "other";
export type WorkbenchRunBudgetDifficulty = "simple" | "normal" | "complex" | "longrun" | "custom";

export interface WorkbenchRunBudgetProfile {
  difficulty: WorkbenchRunBudgetDifficulty;
  maxTotalTokens: number;
  maxTurns: number;
  requestMaxOutputTokens: number;
}

export interface WorkbenchRunBudgetSettings {
  enabled: boolean;
  defaultDifficulty: WorkbenchRunBudgetDifficulty;
  warnAtRatio: number;
  profiles: Record<WorkbenchRunBudgetDifficulty, WorkbenchRunBudgetProfile>;
}

export interface WorkbenchRunBudgetProfileConfig extends Partial<WorkbenchRunBudgetProfile> {}

export interface WorkbenchRunBudgetSettingsConfig extends Partial<Omit<WorkbenchRunBudgetSettings, "profiles">> {
  profiles?: Partial<Record<WorkbenchRunBudgetDifficulty, WorkbenchRunBudgetProfileConfig>>;
}

export interface WorkbenchModelProfile {
  id: string;
  displayName: string;
  vendor: WorkbenchModelVendor;
  contextWindowTokens: number;
  preferredWorkingTokens: number;
  autoCompactAtTokens: number;
  reserveOutputTokens: number;
  maxOutputTokens: number;
  systemPromptOverhead: number;
  defaultTopP: number;
  defaultTemperature?: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsResponses: boolean;
  available: boolean;
}

export interface WorkbenchProviderSettings {
  id: string;
  baseUrl: string;
  endpoint: WorkbenchProviderEndpoint;
  authHeader: WorkbenchAuthHeader;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  modelsUrl?: string;
  modelsPath?: string;
  maxTokensField?: WorkbenchMaxTokensField;
  maxTokens?: number;
  reasoningEffort: WorkbenchThinkingEffort;
  reasoningEffortFormat: WorkbenchThinkingEffortFormat;
  stream: boolean;
  diagnostics: boolean;
  transport: WorkbenchProviderTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  model: WorkbenchModelProfile;
  models: WorkbenchModelProfile[];
}

export interface WorkbenchPermissionSettings {
  projectWriteDefault: "allow" | "ask";
  dangerousActionDefault: "ask";
  outsideProjectDefault: "ask";
  credentialAccessDefault: "ask";
}

import type { WorkbenchLongRunPolicy } from "../workbench-contract";

export interface WorkbenchRuntimeSettings {
  provider: WorkbenchProviderSettings;
  longRun: WorkbenchLongRunPolicy;
  runBudget: WorkbenchRunBudgetSettings;
  permissions: WorkbenchPermissionSettings;
}

export interface WorkbenchModelProfileConfig extends Partial<WorkbenchModelProfile> {
  id: string;
}

export interface WorkbenchProviderSettingsConfig {
  id?: string;
  baseUrl?: string;
  endpoint?: WorkbenchProviderEndpoint;
  authHeader?: WorkbenchAuthHeader;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  modelsUrl?: string;
  modelsPath?: string;
  maxTokensField?: WorkbenchMaxTokensField;
  maxTokens?: number;
  reasoningEffort?: WorkbenchThinkingEffort;
  reasoningEffortFormat?: WorkbenchThinkingEffortFormat;
  stream?: boolean;
  diagnostics?: boolean;
  transport?: WorkbenchProviderTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  model?: string | WorkbenchModelProfileConfig;
  models?: WorkbenchModelProfileConfig[];
}

export interface WorkbenchRuntimeSettingsConfig {
  provider?: WorkbenchProviderSettingsConfig;
  longRun?: Partial<WorkbenchLongRunPolicy>;
  runBudget?: WorkbenchRunBudgetSettingsConfig;
  permissions?: Partial<WorkbenchPermissionSettings>;
}

export interface WorkbenchRemoteModel {
  id: string;
  name?: string;
  vendor?: string;
  maxContext?: number;
  available?: boolean;
}

export interface WorkbenchRemoteModelGroup {
  vendor: string;
  models: WorkbenchRemoteModel[];
}
