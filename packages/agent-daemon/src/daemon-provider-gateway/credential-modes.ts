import { ConfigMerger, PROVIDER_CONFIG_SCHEMA } from "@crish/agent-core";
import type { ConfigValidationResult, ConfigSourcePriority } from "@crish/agent-core";
import type { OpenAICompatibleEndpoint, SystemPromptWireMode } from "@crish/agent-model";
import { redactSensitive } from "@crish/shared-utils";
import { getDaemonLogger } from "../daemon-logger.js";
import {
  DEFAULT_AUTH_HEADER,
  DEFAULT_ENDPOINT,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_ROUTE_ID,
  type DaemonProviderApiKeySource,
  type DaemonProviderCredentialMode,
  type DaemonProviderRuntimeConfig,
  type DaemonProviderRuntimeConfigSourceName,
  type DaemonProviderRuntimeConfigSources,
  type NormalizedDaemonProviderRuntimeConfig,
  type ProviderConfigLayer,
  cloneHeaders,
  nonEmpty,
  positiveInteger,
  requireNonEmpty,
} from "./types.js";

const providerConfigMerger = new ConfigMerger(PROVIDER_CONFIG_SCHEMA);

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com';
  } catch {
    return false;
  }
}

function defaultSystemPromptWireMode(config: {
  baseUrl: string;
  credentialMode: DaemonProviderCredentialMode;
}): SystemPromptWireMode {
  return isOfficialOpenAIBaseUrl(config.baseUrl)
    ? 'native-system-role'
    : 'user-prefix';
}

export function normalizeConfig(
  config: DaemonProviderRuntimeConfig
): NormalizedDaemonProviderRuntimeConfig {
  const baseUrl = requireNonEmpty(config.baseUrl, 'baseUrl');
  const model = requireNonEmpty(config.model, 'model');
  const providerId = nonEmpty(config.providerId) ?? DEFAULT_PROVIDER_ID;
  const apiKey = nonEmpty(config.apiKey);
  const credentialMode =
    normalizeCredentialMode(config.credentialMode) ?? 'auto';
  return {
    credentialMode,
    apiKey,
    apiKeySource: apiKey ? (config.apiKeySource ?? 'unknown') : 'unset',
    accountId: nonEmpty(config.accountId),
    baseUrl,
    model,
    providerId,
    routeId:
      nonEmpty(config.routeId) ?? `${DEFAULT_ROUTE_ID}:${providerId}:${model}`,
    upstreamModel: nonEmpty(config.upstreamModel) ?? model,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    maxTokensField: config.maxTokensField,
    maxTokens: positiveInteger(config.maxTokens),
    stream: config.stream ?? true,
    diagnostics: config.diagnostics ?? true,
    transport: config.transport ?? 'auto',
    systemPromptWireMode:
      normalizeSystemPromptWireMode(config.systemPromptWireMode) ??
      defaultSystemPromptWireMode({ baseUrl, credentialMode }),
    requestTimeoutMs:
      positiveInteger(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    firstByteTimeoutMs:
      positiveInteger(config.firstByteTimeoutMs) ??
      DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs: positiveInteger(config.streamIdleTimeoutMs),
    headers: cloneHeaders(config.headers),
  };
}

function layerPriority(
  source: DaemonProviderRuntimeConfigSourceName
): ConfigSourcePriority {
  switch (source) {
    case 'default':
      return 0 as const;
    case 'workspace-config':
      return 100 as const;
    case 'user-config':
      return 200 as const;
    case 'env':
      return 300 as const;
    case 'runtime-update':
      return 500 as const;
    default:
      return 0 as const;
  }
}

function logProviderConfigValidation(result: ConfigValidationResult): void {
  if (result.errors.length === 0) return;
  const errorMessages = result.errors
    .map((e) => `  [${e.path}] ${e.message}` + (e.received !== undefined ? ` (received: ${JSON.stringify(e.received)})` : ""))
    .join("\n");
  getDaemonLogger().warn('Provider config validation warnings', {
    module: 'daemon-provider-gateway',
    warnings: redactSensitive(errorMessages),
  });
}

function providerRuntimeConfigFromEnv(
  env: Record<string, string | undefined>
): Partial<DaemonProviderRuntimeConfig> {
  const apiKey = firstNonEmpty(
    env.CRISH_API_KEY,
    env.FLOWBIT_API_KEY,
    env.OPENAI_API_KEY
  );
  const credentialMode = normalizeCredentialMode(
    firstNonEmpty(
      env.CRISH_CREDENTIAL_MODE,
      env.FLOWBIT_CREDENTIAL_MODE,
      env.OPENAI_CREDENTIAL_MODE,
      env.CRISH_PROVIDER_CREDENTIAL_MODE,
      env.FLOWBIT_PROVIDER_CREDENTIAL_MODE
    )
  );
  return {
    credentialMode,
    ...(apiKey ? { apiKey } : {}),
    apiKeySource: normalizeApiKeySource(
      firstNonEmpty(env.CRISH_API_KEY_SOURCE, env.FLOWBIT_API_KEY_SOURCE)
    ),
    ...(firstNonEmpty(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID) !== undefined
      ? { accountId: firstNonEmpty(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID) }
      : {}),
    ...(firstNonEmpty(env.CRISH_API_BASE_URL, env.FLOWBIT_API_BASE_URL, env.OPENAI_BASE_URL) !== undefined
      ? { baseUrl: firstNonEmpty(env.CRISH_API_BASE_URL, env.FLOWBIT_API_BASE_URL, env.OPENAI_BASE_URL) }
      : {}),
    ...(firstNonEmpty(env.CRISH_MODEL, env.FLOWBIT_MODEL, env.OPENAI_MODEL) !== undefined
      ? { model: firstNonEmpty(env.CRISH_MODEL, env.FLOWBIT_MODEL, env.OPENAI_MODEL) }
      : {}),
    ...(firstNonEmpty(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID) !== undefined
      ? { providerId: firstNonEmpty(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID) }
      : {}),
    ...(normalizeEndpoint(firstNonEmpty(env.CRISH_PROVIDER_ENDPOINT, env.FLOWBIT_PROVIDER_ENDPOINT, env.OPENAI_PROVIDER_ENDPOINT)) !== undefined
      ? { endpoint: normalizeEndpoint(firstNonEmpty(env.CRISH_PROVIDER_ENDPOINT, env.FLOWBIT_PROVIDER_ENDPOINT, env.OPENAI_PROVIDER_ENDPOINT)) }
      : {}),
    ...(normalizeBoolean(firstNonEmpty(env.CRISH_PROVIDER_STREAM, env.FLOWBIT_PROVIDER_STREAM, env.OPENAI_PROVIDER_STREAM)) !== undefined
      ? { stream: normalizeBoolean(firstNonEmpty(env.CRISH_PROVIDER_STREAM, env.FLOWBIT_PROVIDER_STREAM, env.OPENAI_PROVIDER_STREAM)) }
      : {}),
    ...(normalizeSystemPromptWireMode(firstNonEmpty(env.CRISH_SYSTEM_PROMPT_WIRE_MODE, env.FLOWBIT_SYSTEM_PROMPT_WIRE_MODE, env.OPENAI_SYSTEM_PROMPT_WIRE_MODE)) !== undefined
      ? { systemPromptWireMode: normalizeSystemPromptWireMode(firstNonEmpty(env.CRISH_SYSTEM_PROMPT_WIRE_MODE, env.FLOWBIT_SYSTEM_PROMPT_WIRE_MODE, env.OPENAI_SYSTEM_PROMPT_WIRE_MODE)) }
      : {}),
  } as Partial<DaemonProviderRuntimeConfig>;
}

function resolveApiKey(layers: ProviderConfigLayer[]): {
  value?: string;
  source: DaemonProviderApiKeySource;
} {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!hasOwnConfigValue(layer.config, "apiKey")) continue;
    const value = nonEmpty(layer.config.apiKey);
    return value
      ? { value, source: layer.config.apiKeySource ?? layer.source }
      : { source: 'unset' };
  }
  return { source: 'unset' };
}

function resolveCredentialMode(
  layers: ProviderConfigLayer[]
): DaemonProviderCredentialMode | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!hasOwnConfigValue(layer.config, "credentialMode")) continue;
    const credentialMode = normalizeCredentialMode(layer.config.credentialMode);
    if (credentialMode) return credentialMode;
  }
  return undefined;
}

function resolveOptionalStringConfig(
  layers: ProviderConfigLayer[],
  key: 'accountId' | 'baseUrl' | 'model' | 'providerId' | 'routeId' | 'upstreamModel'
): string | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const value = nonEmpty(layers[i]!.config[key]);
    if (value) return value;
  }
  return undefined;
}

function resolveEndpointConfig(
  layers: ProviderConfigLayer[]
): OpenAICompatibleEndpoint | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!hasOwnConfigValue(layer.config, "endpoint")) continue;
    const endpoint = normalizeEndpoint(layer.config.endpoint);
    if (endpoint) return endpoint;
  }
  return undefined;
}

function resolveBooleanConfig(
  layers: ProviderConfigLayer[],
  key: 'stream'
): boolean | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!hasOwnConfigValue(layer.config, key)) continue;
    const value = normalizeBoolean(layer.config[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasOwnConfigValue<K extends keyof DaemonProviderRuntimeConfig>(
  config: Partial<DaemonProviderRuntimeConfig>,
  key: K
): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

export function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export function normalizeCredentialMode(
  value: string | undefined
): DaemonProviderCredentialMode | undefined {
  const normalized = nonEmpty(value);
  if (normalized === 'direct' || normalized === 'auto') return normalized;
  return undefined;
}

export function normalizeEndpoint(
  value: string | undefined
): OpenAICompatibleEndpoint | undefined {
  const normalized = nonEmpty(value)
    ?.toLowerCase()
    .replace(/_/g, '-')
    .replace(/\//g, '-');
  if (
    normalized === 'auto' ||
    normalized === 'responses' ||
    normalized === 'chat-completions'
  )
    return normalized;
  if (normalized === 'chat') return 'chat-completions';
  if (normalized === 'response') return 'responses';
  return undefined;
}

export function normalizeSystemPromptWireMode(
  value: string | undefined
): SystemPromptWireMode | undefined {
  const normalized = nonEmpty(value)
    ?.toLowerCase()
    .replace(/_/g, '-')
    .replace(/\//g, '-');
  if (
    normalized === 'native' ||
    normalized === 'native-system-role' ||
    normalized === 'system'
  )
    return 'native-system-role';
  if (
    normalized === 'user' ||
    normalized === 'user-prefix' ||
    normalized === 'prefix'
  )
    return 'user-prefix';
  return undefined;
}

export function normalizeBoolean(
  value: string | boolean | undefined
): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const normalized = nonEmpty(value)?.toLowerCase();
  if (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'yes' ||
    normalized === 'on'
  )
    return true;
  if (
    normalized === 'false' ||
    normalized === '0' ||
    normalized === 'no' ||
    normalized === 'off'
  )
    return false;
  return undefined;
}

export function normalizeApiKeySource(
  value: string | undefined
): DaemonProviderApiKeySource | undefined {
  const normalized = nonEmpty(value);
  if (
    normalized === 'default' ||
    normalized === 'env' ||
    normalized === 'runtime-update' ||
    normalized === 'user-config' ||
    normalized === 'workspace-config' ||
    normalized === 'unset' ||
    normalized === 'unknown'
  ) {
    return normalized;
  }
  return undefined;
}

function providerConfigLayers(
  sources: DaemonProviderRuntimeConfigSources
): ProviderConfigLayer[] {
  return [
    { source: 'default', config: sources.defaults },
    { source: 'workspace-config', config: sources.workspaceConfig ?? {} },
    { source: 'user-config', config: sources.userConfig ?? {} },
    { source: 'env', config: providerRuntimeConfigFromEnv(sources.env ?? {}) },
    { source: 'runtime-update', config: sources.runtimeConfig ?? {} },
  ];
}

export function createDaemonProviderRuntimeConfig(
  sources: DaemonProviderRuntimeConfigSources
): DaemonProviderRuntimeConfig {
  const layers = providerConfigLayers(sources);
  const { config: baseConfig, validation } =
    providerConfigMerger.mergeAndValidate(
      layers.map((layer) => ({
        name: layer.source,
        priority: layerPriority(layer.source),
        config: layer.config as Record<string, unknown>,
      }))
    );
  logProviderConfigValidation(validation);
  const apiKey = resolveApiKey(layers);
  const credentialMode = resolveCredentialMode(layers);
  return normalizeConfig({
    ...baseConfig,
    credentialMode:
      credentialMode ??
      (baseConfig.credentialMode as DaemonProviderCredentialMode) ??
      'auto',
    apiKey: apiKey.value ?? (baseConfig.apiKey as string | undefined),
    apiKeySource: apiKey.value
      ? apiKey.source
      : (baseConfig.apiKeySource as DaemonProviderApiKeySource),
    accountId: (resolveOptionalStringConfig(layers, 'accountId') ??
      baseConfig.accountId) as string | undefined,
    baseUrl: (resolveOptionalStringConfig(layers, 'baseUrl') ??
      baseConfig.baseUrl) as string,
    model: (resolveOptionalStringConfig(layers, 'model') ??
      baseConfig.model) as string,
    providerId: (resolveOptionalStringConfig(layers, 'providerId') ??
      baseConfig.providerId) as string | undefined,
    routeId: (resolveOptionalStringConfig(layers, 'routeId') ??
      baseConfig.routeId) as string | undefined,
    upstreamModel: (resolveOptionalStringConfig(layers, 'upstreamModel') ??
      baseConfig.upstreamModel) as string | undefined,
    endpoint: (resolveEndpointConfig(layers) ??
      baseConfig.endpoint) as OpenAICompatibleEndpoint,
    stream: (resolveBooleanConfig(layers, 'stream') ?? baseConfig.stream) as
      boolean | undefined,
  });
}

export function createDaemonProviderRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
  defaults: Pick<DaemonProviderRuntimeConfig, 'baseUrl' | 'model'> &
    Partial<DaemonProviderRuntimeConfig>
): DaemonProviderRuntimeConfig {
  return createDaemonProviderRuntimeConfig({
    defaults,
    env,
  });
}
