import { CRISH_DEFAULT_PROVIDER_CONFIG } from "@crish/shared-types";
import { createDefaultLongRunPolicy, type WorkbenchLongRunPolicy } from "./workbench-contract";

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

export const BUILTIN_WORKBENCH_MODEL_PROFILES: WorkbenchModelProfile[] = [
  createMimoProfile("mimo-v2.5", "mimo-v2.5"),
  createMimoProfile("mimo-v2.5-pro", "mimo-v2.5-pro"),
  createOpenAiProfile("gpt-5.4", "GPT-5.4"),
  createOpenAiProfile("gpt-5.3", "GPT-5.3"),
  createOpenAiProfile("gpt-5.2", "GPT-5.2"),
  createOpenAiProfile("gpt-4o", "GPT-4o", {
    contextWindowTokens: 128_000,
    preferredWorkingTokens: 64_000,
    autoCompactAtTokens: 56_000,
    reserveOutputTokens: 16_000,
    maxOutputTokens: 16_000
  })
];

export function createDefaultWorkbenchSettings(): WorkbenchRuntimeSettings {
  const model =
    findModelProfile(CRISH_DEFAULT_PROVIDER_CONFIG.model) ??
    createMimoProfile(CRISH_DEFAULT_PROVIDER_CONFIG.model, CRISH_DEFAULT_PROVIDER_CONFIG.model);
  return {
    provider: {
      id: "flowbit-mimo",
      baseUrl: CRISH_DEFAULT_PROVIDER_CONFIG.baseUrl,
      endpoint: CRISH_DEFAULT_PROVIDER_CONFIG.endpoint,
      authHeader: "authorization",
      apiKeyEnv: CRISH_DEFAULT_PROVIDER_CONFIG.apiKeyEnv,
      maxTokensField: "max_output_tokens",
      reasoningEffort: "auto",
      reasoningEffortFormat: "auto",
      stream: CRISH_DEFAULT_PROVIDER_CONFIG.stream,
      diagnostics: true,
      transport: "auto",
      model,
      models: BUILTIN_WORKBENCH_MODEL_PROFILES
    },
    longRun: createDefaultLongRunPolicy(),
    runBudget: createDefaultRunBudgetSettings(),
    permissions: {
      projectWriteDefault: "allow",
      dangerousActionDefault: "ask",
      outsideProjectDefault: "ask",
      credentialAccessDefault: "ask"
    }
  };
}

export function createWorkbenchSettingsFromConfig(
  config: WorkbenchRuntimeSettingsConfig = {},
  defaults = createDefaultWorkbenchSettings()
): WorkbenchRuntimeSettings {
  const configuredProfiles = (config.provider?.models ?? []).map((model) => normalizeConfiguredModelProfile(model));
  const modelProfiles = mergeModelProfiles(defaults.provider.models, configuredProfiles);
  const selectedModel = resolveConfiguredModel(config.provider?.model, modelProfiles, defaults.provider.model);
  const models = mergeModelProfiles(modelProfiles, [selectedModel]);

  return {
    provider: {
      ...defaults.provider,
      ...definedProviderOverrides(config.provider),
      model: selectedModel,
      models
    },
    longRun: {
      ...defaults.longRun,
      ...config.longRun
    },
    runBudget: normalizeRunBudgetSettings(config.runBudget, defaults.runBudget),
    permissions: {
      ...defaults.permissions,
      ...config.permissions
    }
  };
}

export function createDefaultRunBudgetSettings(): WorkbenchRunBudgetSettings {
  return {
    enabled: true,
    defaultDifficulty: "normal",
    warnAtRatio: 0.85,
    profiles: {
      simple: {
        difficulty: "simple",
        maxTotalTokens: 50_000,
        maxTurns: 8,
        requestMaxOutputTokens: 16_000
      },
      normal: {
        difficulty: "normal",
        maxTotalTokens: 200_000,
        maxTurns: 32,
        requestMaxOutputTokens: 32_000
      },
      complex: {
        difficulty: "complex",
        maxTotalTokens: 800_000,
        maxTurns: 64,
        requestMaxOutputTokens: 64_000
      },
      longrun: {
        difficulty: "longrun",
        maxTotalTokens: 2_000_000,
        maxTurns: 160,
        requestMaxOutputTokens: 128_000
      },
      custom: {
        difficulty: "custom",
        maxTotalTokens: 200_000,
        maxTurns: 32,
        requestMaxOutputTokens: 32_000
      }
    }
  };
}

export function resolveRunBudgetProfile(
  settings: WorkbenchRunBudgetSettings,
  difficulty = settings.defaultDifficulty
): WorkbenchRunBudgetProfile {
  return settings.profiles[difficulty] ?? settings.profiles.normal;
}

export function createMimoTokenPlanProviderConfig(
  overrides: WorkbenchProviderSettingsConfig = {}
): WorkbenchProviderSettingsConfig {
  return {
    id: "mimo-token-plan",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    endpoint: "chat-completions",
    authHeader: "api-key",
    apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
    maxTokensField: "max_completion_tokens",
    reasoningEffort: "auto",
    reasoningEffortFormat: "chat-completions",
    model: "mimo-v2.5",
    stream: true,
    diagnostics: true,
    ...overrides
  };
}

export function mergeRemoteModelGroups(groups: WorkbenchRemoteModelGroup[]): WorkbenchModelProfile[] {
  const profiles = new Map<string, WorkbenchModelProfile>();
  for (const profile of BUILTIN_WORKBENCH_MODEL_PROFILES) {
    profiles.set(profile.id, profile);
  }
  for (const group of groups) {
    for (const model of group.models) {
      const profile = profileFromRemoteModel(model, group.vendor);
      profiles.set(profile.id, { ...(profiles.get(profile.id) ?? profile), ...profile });
    }
  }
  return [...profiles.values()];
}

export function mergeWorkbenchModelProfiles(
  baseProfiles: WorkbenchModelProfile[],
  extraProfiles: WorkbenchModelProfile[]
): WorkbenchModelProfile[] {
  return mergeModelProfiles(baseProfiles, extraProfiles);
}

export function findModelProfile(modelId: string, profiles = BUILTIN_WORKBENCH_MODEL_PROFILES): WorkbenchModelProfile | undefined {
  return profiles.find((profile) => profile.id === modelId);
}

export function profileFromRemoteModel(model: WorkbenchRemoteModel, fallbackVendor = "other"): WorkbenchModelProfile {
  const vendor = normalizeModelVendor(model.vendor ?? fallbackVendor, model.id);
  const contextWindowTokens = model.maxContext && model.maxContext > 0 ? model.maxContext : defaultContextWindow(vendor, model.id);
  const maxOutputTokens = defaultMaxOutput(vendor, model.id);
  const preferredWorkingTokens = Math.min(Math.floor(contextWindowTokens * 0.2), vendor === "mimo" ? 200_000 : 96_000);
  const autoCompactAtTokens = Math.max(16_000, Math.floor(preferredWorkingTokens * 0.9));
  return {
    id: model.id,
    displayName: model.name ?? model.id,
    vendor,
    contextWindowTokens,
    preferredWorkingTokens,
    autoCompactAtTokens,
    reserveOutputTokens: Math.min(maxOutputTokens, 32_000),
    maxOutputTokens,
    systemPromptOverhead: 8_000,
    defaultTopP: 0.95,
    defaultTemperature: vendor === "mimo" ? 1 : undefined,
    supportsTools: true,
    supportsStreaming: true,
    supportsResponses: true,
    available: model.available !== false
  };
}

function createMimoProfile(id: string, displayName: string): WorkbenchModelProfile {
  return {
    id,
    displayName,
    vendor: "mimo",
    contextWindowTokens: 1_000_000,
    preferredWorkingTokens: 200_000,
    autoCompactAtTokens: 180_000,
    reserveOutputTokens: 32_000,
    maxOutputTokens: 128_000,
    systemPromptOverhead: 8_000,
    defaultTopP: 0.95,
    defaultTemperature: 1,
    supportsTools: true,
    supportsStreaming: true,
    supportsResponses: true,
    available: true
  };
}

function normalizeConfiguredModelProfile(config: WorkbenchModelProfileConfig): WorkbenchModelProfile {
  const base =
    findModelProfile(config.id) ??
    profileFromRemoteModel({
      id: config.id,
      name: config.displayName,
      vendor: config.vendor,
      maxContext: config.contextWindowTokens,
      available: config.available
    });
  return {
    ...base,
    ...config,
    displayName: config.displayName ?? base.displayName,
    vendor: config.vendor ?? base.vendor,
    contextWindowTokens: config.contextWindowTokens ?? base.contextWindowTokens,
    preferredWorkingTokens: config.preferredWorkingTokens ?? base.preferredWorkingTokens,
    autoCompactAtTokens: config.autoCompactAtTokens ?? base.autoCompactAtTokens,
    reserveOutputTokens: config.reserveOutputTokens ?? base.reserveOutputTokens,
    maxOutputTokens: config.maxOutputTokens ?? base.maxOutputTokens,
    systemPromptOverhead: config.systemPromptOverhead ?? base.systemPromptOverhead,
    defaultTopP: config.defaultTopP ?? base.defaultTopP,
    supportsTools: config.supportsTools ?? base.supportsTools,
    supportsStreaming: config.supportsStreaming ?? base.supportsStreaming,
    supportsResponses: config.supportsResponses ?? base.supportsResponses,
    available: config.available ?? base.available
  };
}

function resolveConfiguredModel(
  model: WorkbenchProviderSettingsConfig["model"],
  profiles: WorkbenchModelProfile[],
  fallback: WorkbenchModelProfile
): WorkbenchModelProfile {
  if (!model) return fallback;
  if (typeof model === "string") {
    return findModelProfile(model, profiles) ?? normalizeConfiguredModelProfile({ id: model });
  }
  return normalizeConfiguredModelProfile(model);
}

function mergeModelProfiles(
  baseProfiles: WorkbenchModelProfile[],
  extraProfiles: WorkbenchModelProfile[]
): WorkbenchModelProfile[] {
  const map = new Map<string, WorkbenchModelProfile>();
  for (const profile of [...baseProfiles, ...extraProfiles]) {
    map.set(profile.id, { ...(map.get(profile.id) ?? profile), ...profile });
  }
  return [...map.values()];
}

function definedProviderOverrides(
  provider: WorkbenchProviderSettingsConfig | undefined
): Partial<Omit<WorkbenchProviderSettings, "model" | "models">> {
  if (!provider) return {};
  return Object.fromEntries(
    Object.entries({
      id: provider.id,
      baseUrl: provider.baseUrl,
      endpoint: provider.endpoint,
      authHeader: provider.authHeader,
      apiKey: provider.apiKey,
      apiKeyEnv: provider.apiKeyEnv,
      apiKeyFile: provider.apiKeyFile,
      modelsUrl: provider.modelsUrl,
      modelsPath: provider.modelsPath,
      maxTokensField: provider.maxTokensField,
      maxTokens: provider.maxTokens,
      reasoningEffort: provider.reasoningEffort,
      reasoningEffortFormat: provider.reasoningEffortFormat,
      stream: provider.stream,
      diagnostics: provider.diagnostics,
      transport: provider.transport,
      rustReqwestCommand: provider.rustReqwestCommand,
      rustReqwestArgs: provider.rustReqwestArgs,
      rustReqwestCwd: provider.rustReqwestCwd
    }).filter(([, value]) => value !== undefined)
  ) as Partial<Omit<WorkbenchProviderSettings, "model" | "models">>;
}

function normalizeRunBudgetSettings(
  config: WorkbenchRunBudgetSettingsConfig | undefined,
  defaults: WorkbenchRunBudgetSettings
): WorkbenchRunBudgetSettings {
  const profiles = { ...defaults.profiles };
  const difficulties: WorkbenchRunBudgetDifficulty[] = ["simple", "normal", "complex", "longrun", "custom"];

  for (const difficulty of difficulties) {
    const override = config?.profiles?.[difficulty];
    if (!override) continue;
    const base = profiles[difficulty];
    profiles[difficulty] = normalizeRunBudgetProfile({
      ...base,
      ...override,
      difficulty
    });
  }

  return {
    enabled: config?.enabled ?? defaults.enabled,
    defaultDifficulty: config?.defaultDifficulty ?? defaults.defaultDifficulty,
    warnAtRatio: clampRatio(config?.warnAtRatio ?? defaults.warnAtRatio),
    profiles
  };
}

function normalizeRunBudgetProfile(profile: WorkbenchRunBudgetProfile): WorkbenchRunBudgetProfile {
  return {
    difficulty: profile.difficulty,
    maxTotalTokens: positiveInteger(profile.maxTotalTokens, 1),
    maxTurns: positiveInteger(profile.maxTurns, 1),
    requestMaxOutputTokens: positiveInteger(profile.requestMaxOutputTokens, 1)
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(1, Math.max(0.1, value));
}

function createOpenAiProfile(id: string, displayName: string, overrides: Partial<WorkbenchModelProfile> = {}): WorkbenchModelProfile {
  return {
    id,
    displayName,
    vendor: "gpt-openai",
    contextWindowTokens: 400_000,
    preferredWorkingTokens: 160_000,
    autoCompactAtTokens: 144_000,
    reserveOutputTokens: 32_000,
    maxOutputTokens: 32_000,
    systemPromptOverhead: 8_000,
    defaultTopP: 1,
    supportsTools: true,
    supportsStreaming: true,
    supportsResponses: true,
    available: true,
    ...overrides
  };
}

function normalizeModelVendor(vendor: string, modelId: string): WorkbenchModelVendor {
  const value = `${vendor} ${modelId}`.toLowerCase();
  if (value.includes("mimo")) return "mimo";
  if (value.includes("gpt-openai")) return "gpt-openai";
  if (value.includes("openai") || value.includes("gpt")) return "openai";
  return "other";
}

function defaultContextWindow(vendor: WorkbenchModelVendor, modelId: string): number {
  if (vendor === "mimo") return 1_000_000;
  if (/4o/i.test(modelId)) return 128_000;
  if (vendor === "openai" || vendor === "gpt-openai") return 400_000;
  return 128_000;
}

function defaultMaxOutput(vendor: WorkbenchModelVendor, modelId: string): number {
  if (vendor === "mimo") return 128_000;
  if (/4o/i.test(modelId)) return 16_000;
  if (vendor === "openai" || vendor === "gpt-openai") return 32_000;
  return 16_000;
}
