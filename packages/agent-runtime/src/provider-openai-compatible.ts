/**
 * OpenAI 兼容 provider 入口.
 *
 * 保留 OpenAICompatibleProvider 类、工厂函数与公共导出
 * 底层传输、错误分类、验证工具在 provider-openai-base
 * Chat Completions 解析在 provider-openai-chat
 * Responses API 解析在 provider-openai-responses
 * 配置与解析校验在 provider-openai-config
 * 诊断与辅助工具在 provider-openai-helpers
 * Provider 类实现在 provider-openai-class
 */

import { ProviderError } from "@crish/shared-types";
import {
  OpenAICompatibleProviderConfig,
  OpenAICompatibleProviderOptions,
  OpenAICompatibleModel,
  defaultKeepAliveFetch,
  readEnv,
  fetchWithTimeout,
  fetchWithOptionalRustReqwestOverride,
  formatProviderError
} from "./provider-openai-base";
import { authHeaderObject } from "./openai-request-build";
import { OpenAICompatibleProvider } from "./provider-openai-class";
import {
  parseProviderConfig,
  resolveProviderConfigSecrets,
  resolveModelsUrl
} from "./provider-openai-config";
import {
  readError,
  classifyHttpProviderError
} from "./provider-openai-helpers";

// Re-export public types & class & functions
export { OpenAICompatibleProvider } from "./provider-openai-class";
export type { OpenAICompatibleRetryOptions } from "./openai-retry";
export type {
  OpenAICompatibleAuthHeader, OpenAICompatibleMaxTokensField,
  OpenAICompatibleReasoningContentMode, OpenAICompatibleReasoningEffort,
  OpenAICompatibleReasoningEffortFormat, OpenAICompatibleToolChoice, SystemPromptWireMode,
} from "./openai-request-build";
export type {
  OpenAICompatibleProviderOptions, OpenAICompatibleDiagnosticsOptions,
  OpenAICompatibleProviderFileConfig, OpenAICompatibleProviderConfig,
  OpenAICompatibleEndpoint, OpenAICompatibleTransport, OpenAICompatibleModel,
} from "./provider-openai-base";
export { classifyHttpProviderError } from "./provider-openai-helpers";

// Factory functions

export async function loadOpenAICompatibleProviderConfig(
  filePath: string,
  options: { resolveApiKey?: boolean } = {}
): Promise<OpenAICompatibleProviderConfig> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config = parseProviderConfig(parsed, filePath);
  return options.resolveApiKey === false ? config : resolveProviderConfigSecrets(config, filePath, options);
}

export async function createOpenAICompatibleProviderFromConfig(
  filePath: string,
  overrides: Partial<OpenAICompatibleProviderOptions> = {},
  loadOptions: { resolveApiKey?: boolean } = {}
): Promise<OpenAICompatibleProvider> {
  const config = await loadOpenAICompatibleProviderConfig(filePath, loadOptions);
  return new OpenAICompatibleProvider({ ...config, ...overrides });
}

export async function listOpenAICompatibleModels(options: {
  baseUrl: string;
  modelsPath?: string;
  fetch?: typeof fetch;
  transport?: string;
  apiKey?: string;
  authHeader?: import("./openai-request-build").OpenAICompatibleAuthHeader;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  rustReqwestFetch?: typeof fetch;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
}): Promise<OpenAICompatibleModel[]> {
  const fetchImpl = options.fetch ?? defaultKeepAliveFetch();
  const transport = options.transport ?? "fetch";
  if (!fetchImpl && transport === "fetch") throw new ProviderError("A fetch implementation is required to list models", "CONFIG_ERROR", false);
  const apiKey = options.apiKey ?? readEnv("CRISH_API_KEY") ?? readEnv("FLOWBIT_API_KEY") ?? readEnv("OPENAI_API_KEY");
  const modelsUrl = resolveModelsUrl(options);
  const signal = new AbortController().signal;
  const request = {
    method: "GET" as const,
    headers: { accept: "application/json", ...authHeaderObject(options.authHeader ?? "authorization", apiKey), ...options.headers },
    ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {})
  };
  let response = transport === "rust-reqwest" || !fetchImpl
    ? await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options)
    : await fetchWithTimeout(fetchImpl, modelsUrl, request, signal);
  if (transport === "auto" && !response.ok) {
    const error = await readError(response.clone());
    const providerError = classifyHttpProviderError(response, error);
    if (providerError.kind === "gateway-challenge") response = await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options);
  }
  if (!response.ok) {
    const error = await readError(response);
    const providerError = classifyHttpProviderError(response, error);
    throw new ProviderError(formatProviderError(error, providerError.kind), providerError.kind, false);
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  return body.data.map((item: unknown): OpenAICompatibleModel | null => {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return null;
    const parsedObject = typeof record.object === "string" ? record.object : undefined;
    const parsedCreated = typeof record.created === "number" ? record.created : undefined;
    const parsedOwnedBy = typeof record.owned_by === "string" ? record.owned_by : undefined;
    return {
      id: record.id,
      ...(parsedObject !== undefined ? { object: parsedObject } : {}),
      ...(parsedCreated !== undefined ? { created: parsedCreated } : {}),
      ...(parsedOwnedBy !== undefined ? { ownedBy: parsedOwnedBy } : {})
    };
  }).filter((model): model is OpenAICompatibleModel => model !== null);
}
