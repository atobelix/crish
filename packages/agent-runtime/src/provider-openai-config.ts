import { ProviderError } from "@crish/shared-types";
import { compactObject } from "./openai-request-build";
import {
  OpenAICompatibleProviderConfig,
  OpenAICompatibleEndpoint, OpenAICompatibleTransport, SystemPromptWireMode,
  objectRecord, requiredString, optionalString, optionalBoolean,
  optionalNumber, optionalPositiveInteger, optionalStringRecord,
  optionalStringArray, readEnvFrom,
} from "./provider-openai-base";

export function parseProviderConfig(input: unknown, filePath: string): OpenAICompatibleProviderConfig {
  const root = objectRecord(input, `${filePath}: root`);
  const provider = objectRecord(root.provider, `${filePath}: provider`);
  return compactObject({
    id: optionalString(provider.id, `${filePath}: provider.id`),
    baseUrl: requiredString(provider.baseUrl, `${filePath}: provider.baseUrl`),
    apiKey: optionalString(provider.apiKey, `${filePath}: provider.apiKey`),
    apiKeyEnv: optionalString(provider.apiKeyEnv, `${filePath}: provider.apiKeyEnv`),
    apiKeyFile: optionalString(provider.apiKeyFile, `${filePath}: provider.apiKeyFile`),
    model: requiredString(provider.model, `${filePath}: provider.model`),
    endpoint: optionalEndpoint(provider.endpoint, `${filePath}: provider.endpoint`),
    authHeader: optionalAuthHeader(provider.authHeader, `${filePath}: provider.authHeader`),
    maxTokensField: optionalMaxTokensField(provider.maxTokensField, `${filePath}: provider.maxTokensField`),
    reasoningContent: optionalReasoningContentMode(provider.reasoningContent, `${filePath}: provider.reasoningContent`),
    reasoningEffort: optionalReasoningEffort(provider.reasoningEffort, `${filePath}: provider.reasoningEffort`),
    reasoningEffortFormat: optionalReasoningEffortFormat(provider.reasoningEffortFormat, `${filePath}: provider.reasoningEffortFormat`),
    toolChoice: optionalToolChoice(provider.toolChoice, `${filePath}: provider.toolChoice`),
    stream: optionalBoolean(provider.stream, `${filePath}: provider.stream`),
    temperature: optionalNumber(provider.temperature, `${filePath}: provider.temperature`),
    topP: optionalNumber(provider.topP, `${filePath}: provider.topP`),
    maxTokens: optionalPositiveInteger(provider.maxTokens, `${filePath}: provider.maxTokens`),
    requestTimeoutMs: optionalPositiveInteger(provider.requestTimeoutMs, `${filePath}: provider.requestTimeoutMs`),
    firstByteTimeoutMs: optionalPositiveInteger(provider.firstByteTimeoutMs, `${filePath}: provider.firstByteTimeoutMs`),
    streamIdleTimeoutMs: optionalPositiveInteger(provider.streamIdleTimeoutMs, `${filePath}: provider.streamIdleTimeoutMs`),
    diagnostics: optionalDiagnostics(provider.diagnostics, `${filePath}: provider.diagnostics`),
    systemPromptWireMode: optionalSystemPromptWireMode(provider.systemPromptWireMode, `${filePath}: provider.systemPromptWireMode`),
    headers: optionalStringRecord(provider.headers, `${filePath}: provider.headers`),
    retry: optionalRetryOptions(provider.retry, `${filePath}: provider.retry`),
    transport: optionalTransport(provider.transport, `${filePath}: provider.transport`),
    rustReqwestCommand: optionalString(provider.rustReqwestCommand, `${filePath}: provider.rustReqwestCommand`),
    rustReqwestArgs: optionalStringArray(provider.rustReqwestArgs, `${filePath}: provider.rustReqwestArgs`),
    rustReqwestCwd: optionalString(provider.rustReqwestCwd, `${filePath}: provider.rustReqwestCwd`)
  }) as unknown as OpenAICompatibleProviderConfig;
}

export async function resolveProviderConfigSecrets(
  config: OpenAICompatibleProviderConfig,
  filePath: string,
  options: { resolveApiKey?: boolean; env?: Record<string, string | undefined> }
): Promise<OpenAICompatibleProviderConfig> {
  const { readFile } = await import("node:fs/promises");
  const { resolve, dirname, isAbsolute } = await import("node:path");
  const apiKeyFile = config.apiKeyFile
    ? isAbsolute(config.apiKeyFile)
      ? config.apiKeyFile
      : resolve(dirname(resolve(filePath)), config.apiKeyFile)
    : undefined;
  const apiKey =
    config.apiKey ??
    (config.apiKeyEnv ? readEnvFrom(options.env, config.apiKeyEnv) : undefined) ??
    (apiKeyFile ? (await readFile(apiKeyFile, "utf8")).trim() : undefined);
  return compactObject({ ...config, apiKeyFile, apiKey }) as unknown as OpenAICompatibleProviderConfig;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").endsWith("/v1")
    ? baseUrl.trim().replace(/\/+$/, "")
    : `${baseUrl.trim().replace(/\/+$/, "")}/v1`;
}

export function resolveModelsUrl(options: { baseUrl: string; modelsPath?: string }): string {
  const path = options.modelsPath?.trim() || "/models";
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(options.baseUrl)}${normalizedPath}`;
}

export function optionalEndpoint(value: unknown, label: string): OpenAICompatibleEndpoint | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto") return "auto";
  if (normalized === "chat" || normalized === "chat-completions") return "chat-completions";
  if (normalized === "response" || normalized === "responses") return "responses";
  throw new ProviderError(`${label} must be "auto", "chat-completions", or "responses"`, "CONFIG_ERROR", false);
}

export function optionalTransport(value: unknown, label: string): OpenAICompatibleTransport | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "fetch" || normalized === "rust-reqwest" || normalized === "auto") return normalized;
  throw new ProviderError(`${label} must be "fetch", "rust-reqwest", or "auto"`, "CONFIG_ERROR", false);
}

export function optionalSystemPromptWireMode(value: unknown, label: string): SystemPromptWireMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user-prefix" || normalized === "user" || normalized === "prefix") return "user-prefix";
  throw new ProviderError(`${label} must be "native-system-role" or "user-prefix"`, "CONFIG_ERROR", false);
}

export function optionalAuthHeader(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["authorization", "api-key", "x-api-key", "none"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "authorization", "api-key", "x-api-key", or "none"`, "CONFIG_ERROR", false);
}

export function optionalMaxTokensField(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["max_tokens", "max_completion_tokens", "max_output_tokens"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "max_tokens", "max_completion_tokens", or "max_output_tokens"`, "CONFIG_ERROR", false);
}

export function optionalReasoningContentMode(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["omit", "include", "require"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "omit", "include", or "require"`, "CONFIG_ERROR", false);
}

export function optionalReasoningEffort(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["off", "auto", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "off", "auto", "minimal", "low", "medium", "high", or "xhigh"`, "CONFIG_ERROR", false);
}

export function optionalReasoningEffortFormat(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (["auto", "responses", "chat-completions", "none"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "auto", "responses", "chat-completions", or "none"`, "CONFIG_ERROR", false);
}

export function optionalToolChoice(value: unknown, label: string): string | { type: "function"; name: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["auto", "none", "required"].includes(normalized)) return normalized;
    throw new ProviderError(`${label} must be "auto", "none", "required", or a function choice object`, "CONFIG_ERROR", false);
  }
  const record = objectRecord(value, label);
  if (record.type !== "function") throw new ProviderError(`${label}.type must be "function"`, "CONFIG_ERROR", false);
  const functionRecord = record.function === undefined ? undefined : objectRecord(record.function, `${label}.function`);
  const name = optionalString(record.name, `${label}.name`) ?? optionalString(functionRecord?.name, `${label}.function.name`);
  if (!name) throw new ProviderError(`${label} function choice requires a name`, "CONFIG_ERROR", false);
  return { type: "function", name };
}

export function optionalDiagnostics(value: unknown, label: string): boolean | { enabled?: boolean; headers?: string[] } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const record = objectRecord(value, label);
  return compactObject({ enabled: optionalBoolean(record.enabled, `${label}.enabled`), headers: optionalStringArray(record.headers, `${label}.headers`) });
}

export function optionalRetryOptions(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return compactObject({
    maxAttempts: optionalPositiveInteger(record.maxAttempts, `${label}.maxAttempts`),
    initialDelayMs: optionalPositiveInteger(record.initialDelayMs, `${label}.initialDelayMs`),
    maxDelayMs: optionalPositiveInteger(record.maxDelayMs, `${label}.maxDelayMs`),
    totalBudgetMs: optionalPositiveInteger(record.totalBudgetMs, `${label}.totalBudgetMs`),
    jitterRatio: optionalNumber(record.jitterRatio, `${label}.jitterRatio`)
  });
}
