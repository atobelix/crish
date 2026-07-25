/**
 * OpenAI 兼容 provider �?entry point.
 *
 * 保留 OpenAICompatibleProvider 类、工厂函数与公共导出�? * 底层传输、错误分类、验证工�?�?provider-openai-base
 * Chat Completions 解析 �?provider-openai-chat
 * Responses API 解析 �?provider-openai-responses
 */

import { deepEqual, errorMessage } from "@crish/shared-utils";
import { ProviderError, type JsonObject, type ProviderDiagnostic, type ProviderErrorKind } from "@crish/shared-types";
import { createProviderCacheHintPlan, type OpenAICompatibleCacheHints, type ProviderCacheHintPlan } from "./provider-cache-hints";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "./types";
import { ErrorClassifier } from "./error-classifier";
import {
  compactObject, textContent,
  type OpenAICompatibleAuthHeader,
  type ResolvedOpenAICompatibleEndpoint, type SystemPromptWireMode,
} from "./openai-request-build";
import { delay, normalizeRetryOptions, parseRetryAfterMs, retryDelayMs, withinRetryBudget } from "./openai-retry";
import { type SseDiagnosticsOptions } from "./openai-stream-parse";
import {
  OpenAICompatibleProviderOptions,
  OpenAICompatibleProviderConfig,
  OpenAICompatibleEndpoint, OpenAICompatibleModel, OpenAICompatibleTransport,
  RequestBuildContext, fetchWithTimeout, fetchWithRustReqwestProcess, defaultKeepAliveFetch,
  formatProviderError, readEnv,
  objectRecord, requiredString, optionalString, optionalBoolean,
  optionalNumber, optionalPositiveInteger, optionalStringRecord,
  optionalStringArray, recordField, stringField, resolveApiKey,
  freezeHeaders, defaultWorkspaceRoot, readEnvFrom,
} from "./provider-openai-base";
import { buildChatCompletionsRequestBody, parseChatCompletionsJsonResponse, parseChatCompletionsStreamingResponse } from "./provider-openai-chat";
import { buildResponsesRequestBody, parseResponsesJsonResponse, parseResponsesStreamingResponse } from "./provider-openai-responses";

// ── Local types ──

interface HttpRequest {
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FetchResult {
  response: Response;
  diagnostics?: Array<{ phase: "transport-fallback"; status?: number; statusText?: string; retryable?: boolean; errorKind?: ProviderErrorKind; reason: string }>;
}

// Re-export public types
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


// ── Provider class ──

export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolvedApiKey: string | undefined;
  private readonly resolvedHeaders: Record<string, string>;
  private readonly wireModeCache = new Map<ResolvedOpenAICompatibleEndpoint, SystemPromptWireMode>();

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? defaultKeepAliveFetch();
    if (!this.fetchImpl && (options.transport ?? "fetch") === "fetch") {
      throw new ProviderError("A fetch implementation is required for OpenAICompatibleProvider", "CONFIG_ERROR", false);
    }
    this.resolvedApiKey = resolveApiKey(this.options);
    this.resolvedHeaders = freezeHeaders(this.options, this.resolvedApiKey);
  }

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const retry = normalizeRetryOptions(this.options.retry);
    const startedAt = Date.now();
    const endpoints = this.resolvedEndpoints();
    const diagEnabled = this.diagnosticsEnabled();
    const cacheHintPlan = this.buildCacheHintPlan(request);
    let lastBodyObject: JsonObject | undefined;
    let lastBodyString: string | undefined;

    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
      const endpoint = endpoints[endpointIndex]!;
      const rawPath = this.requestPath(endpoint);
      const path = (this.baseUrl.endsWith("/v1") && rawPath.startsWith("/v1/")) ? rawPath.slice(3) : rawPath;
      const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      attemptLoop: for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        let wireMode = this.wireModeCache.get(endpoint) ?? this.defaultSystemPromptWireMode();
        let retriedSystemPromptCompatibility = false;
        while (true) {
          const attemptStartedAt = Date.now();
          yield* this.diagnostic({
            phase: "request-start", endpoint, url, attempt, maxAttempts: retry.maxAttempts,
            elapsedMs: attemptStartedAt - startedAt, configuredModel: this.options.model,
            ...((wireMode === "user-prefix") ? { reason: "system-prompt-user-prefix" } : {}),
            ...(diagEnabled ? requestDiagnosticFields(request, wireMode, this.options.stream !== false) : {})
          });

          const bodyObject = this.buildRequestBody({ request, endpoint, wireMode, ...(cacheHintPlan !== undefined ? { cacheHintPlan } : {}), attempt });
          let bodyString: string;
          if (lastBodyObject && deepEqual(lastBodyObject, bodyObject)) bodyString = lastBodyString!;
          else { bodyString = JSON.stringify(bodyObject); lastBodyObject = bodyObject; lastBodyString = bodyString; }

          let fetchResult: FetchResult;
          let response: Response;
          try {
            fetchResult = await this.fetchOnce(request, url, bodyString);
            for (const diagnostic of fetchResult.diagnostics ?? []) {
              yield* this.diagnostic({ ...diagnostic, endpoint, url, attempt, maxAttempts: retry.maxAttempts });
            }
            response = fetchResult.response;
          } catch (cause) {
            const reason = errorMessage(cause);
            const error = classifyTransportProviderError(reason);
            const retryable = attempt < retry.maxAttempts && error.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({ phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, retryable, errorKind: error.kind, reason });
            if (!retryable) throw cause;
            yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error.kind);
            await delay(retryDelayMs(retry, attempt), request.signal);
            break;
          }

          const respHeaders = this.diagnosticHeaders(response);
          yield* this.diagnostic({
            phase: "response-start", endpoint, url, attempt, maxAttempts: retry.maxAttempts,
            elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText,
            ...(respHeaders !== undefined ? { headers: respHeaders } : {})
          });

          if (!response.ok) {
            const error = await readError(response);
            const providerError = classifyHttpProviderError(response, error);
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            if (this.shouldRetryWithSystemPromptUserPrefix(request, wireMode, retriedSystemPromptCompatibility, response.status, error)) {
              wireMode = "user-prefix"; retriedSystemPromptCompatibility = true;
              this.wireModeCache.set(endpoint, wireMode);
              yield* this.diagnostic({ phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText, retryable: true, errorKind: providerError.kind, reason: "Provider rejected system-role messages; retrying this endpoint with the system prompt as a stable user-prefix instruction." });
              continue;
            }
            if (this.shouldFallbackEndpoint(endpoint, endpointIndex, endpoints, providerError.kind, response.status, error)) {
              yield* this.diagnostic({ phase: "endpoint-fallback", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText, retryable: true, errorKind: providerError.kind, reason: trimDiagnosticReason(error) });
              break attemptLoop;
            }
            const retryable = attempt < retry.maxAttempts && providerError.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText,
              retryable, errorKind: providerError.kind, reason: trimDiagnosticReason(error),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
            });
            if (!retryable) throw new ProviderError(formatProviderError(error, providerError.kind), providerError.kind, false);
            yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, error, response.status, response.statusText, providerError.kind, retryAfterMs);
            await delay(retryAfterMs ?? retryDelayMs(retry, attempt), request.signal);
            break;
          }

          const contentType = response.headers.get("content-type") ?? "";
          const streamRequested = this.options.stream !== false;
          if (streamRequested && contentType.includes("text/event-stream")) {
            let emittedModelEvent = false;
            let retrySystemPromptCompatibilityAfterStreamError = false;
            try {
              const stream = endpoint === "responses"
                ? parseResponsesStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal)
                : parseChatCompletionsStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal);
              for await (const event of stream) {
                if (event.type === "stop" && event.reason === "error" && !emittedModelEvent && this.shouldRetryWithSystemPromptUserPrefix(request, wireMode, retriedSystemPromptCompatibility, response.status >= 400 ? response.status : 400, event.error ?? "")) {
                  wireMode = "user-prefix"; retriedSystemPromptCompatibility = true;
                  retrySystemPromptCompatibilityAfterStreamError = true;
                  this.wireModeCache.set(endpoint, wireMode);
                  yield* this.diagnostic({ phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText, retryable: true, errorKind: "schema", reason: "Provider emitted a streaming system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.", ...(diagEnabled ? requestDiagnosticFields(request, "native-system-role", streamRequested) : {}) });
                  break;
                }
                if (event.type !== "provider-diagnostic") emittedModelEvent = true;
                yield event;
              }
              if (retrySystemPromptCompatibilityAfterStreamError) continue;
              return;
            } catch (cause) {
              const reason = errorMessage(cause);
              const error2 = classifyStreamProviderError(reason, cause);
              const retryable = !request.signal.aborted && !emittedModelEvent && error2.retryable && attempt < retry.maxAttempts && withinRetryBudget(startedAt, retry.totalBudgetMs);
              yield* this.diagnostic({ phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, retryable, errorKind: error2.kind, reason });
              if (emittedModelEvent) { yield { type: "stop", reason: "error", error: formatProviderError(reason, error2.kind) }; return; }
              if (!retryable) throw cause;
              yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error2.kind);
              await delay(retryDelayMs(retry, attempt), request.signal);
              break;
            }
          }

          if (streamRequested) {
            yield* this.diagnostic({ phase: "transport-fallback", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, retryable: false, errorKind: "invalid-stream", reason: `Provider returned ${contentType || "unknown content type"} for a streaming request; parsing the response as non-streaming JSON.` });
          }

          const body = (await response.json()) as JsonObject;
          const bodyError2 = providerBodyError(body);
          if (this.shouldRetryWithSystemPromptUserPrefix(request, wireMode, retriedSystemPromptCompatibility, response.status >= 400 ? response.status : 400, bodyError2 ?? "")) {
            wireMode = "user-prefix"; retriedSystemPromptCompatibility = true;
            this.wireModeCache.set(endpoint, wireMode);
            yield* this.diagnostic({ phase: "request-error", endpoint, url, attempt, maxAttempts: retry.maxAttempts, elapsedMs: Date.now() - attemptStartedAt, status: response.status, statusText: response.statusText, retryable: true, errorKind: "schema", reason: "Provider returned a JSON system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.", ...(diagEnabled ? requestDiagnosticFields(request, "native-system-role", streamRequested) : {}) });
            continue;
          }
          yield* this.modelMismatchDiagnostic(endpoint, url, attempt, retry.maxAttempts, body);
          yield* (endpoint === "responses" ? parseResponsesJsonResponse(body) : parseChatCompletionsJsonResponse(body));
          return;
        }
      }
    }
  }

  private endpoint(): OpenAICompatibleEndpoint { return this.options.endpoint ?? "auto"; }

  private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
    const endpoint = this.endpoint();
    if (endpoint === "auto") return ["responses", "chat-completions"];
    return [endpoint];
  }


  private buildRequestBody(context: RequestBuildContext): JsonObject {
    const body = context.endpoint === "responses"
      ? buildResponsesRequestBody(this.options, context)
      : buildChatCompletionsRequestBody(this.options, context);
    return this.withCacheHint(body, context.cacheHintPlan);
  }

  private withCacheHint(body: JsonObject, plan: ProviderCacheHintPlan | undefined): JsonObject {
    if (!plan) return body;
    const hints = plan.providerHints as OpenAICompatibleCacheHints | { kind: string };
    if (hints.kind !== "openai-compatible") return body;
    const affinityKey = (hints as OpenAICompatibleCacheHints).stablePromptCacheAffinityKey;
    if (!affinityKey) return body;
    return { ...body, prompt_cache_key: affinityKey };
  }

  private buildCacheHintPlan(request: AgentProviderRequest): ProviderCacheHintPlan | undefined {
    if (!request.promptAssembly) return undefined;
    try { return createProviderCacheHintPlan(request.promptAssembly); } catch { return undefined; }
  }

  private requestPath(endpoint: ResolvedOpenAICompatibleEndpoint): string {
    if (endpoint === "responses") {
      return this.options.paths?.responses ?? "/responses";
    }
    return this.options.paths?.chatCompletions ?? "/chat/completions";
  }

  private async fetchOnce(request: AgentProviderRequest, url: string, bodyString: string): Promise<FetchResult> {
    const httpRequest: HttpRequest = { method: "POST", headers: this.resolvedHeaders, body: bodyString, ...(this.options.requestTimeoutMs !== undefined ? { timeoutMs: this.options.requestTimeoutMs } : {}) };
    const transport = this.options.transport ?? "fetch";
    if (transport === "rust-reqwest") return { response: await this.fetchWithRustReqwest(url, httpRequest, request.signal) };
    try {
      const fetchImpl = this.fetchImpl ?? defaultKeepAliveFetch();
      if (!fetchImpl) return { response: await this.fetchWithRustReqwest(url, httpRequest, request.signal), diagnostics: [{ phase: "transport-fallback", retryable: true, errorKind: "network", reason: "Fetch transport is unavailable; using Rust reqwest transport." }] };
      const response = await fetchWithTimeout(fetchImpl, url, httpRequest, request.signal);
      if (transport !== "auto" || response.ok) return { response };
      const error = await readError(response.clone());
      const providerError = classifyHttpProviderError(response, error);
      if (providerError.kind !== "gateway-challenge") return { response };
      return { response: await this.fetchWithRustReqwest(url, httpRequest, request.signal), diagnostics: [{ phase: "transport-fallback", status: response.status, statusText: response.statusText, retryable: true, errorKind: providerError.kind, reason: trimDiagnosticReason(error) }] };
    } catch (cause) {
      if (transport !== "auto" || request.signal.aborted) throw cause;
      const reason = errorMessage(cause);
      const response = await this.fetchWithRustReqwest(url, httpRequest, request.signal).catch((fallbackCause) => { throw new ProviderError(`Fetch transport failed: ${reason}; Rust reqwest fallback failed: ${errorMessage(fallbackCause)}`, "NETWORK_ERROR", true); });
      return { response, diagnostics: [{ phase: "transport-fallback", retryable: true, errorKind: "network", reason: trimDiagnosticReason(reason) }] };
    }
  }

  private async fetchWithRustReqwest(url: string, request: HttpRequest, signal: AbortSignal): Promise<Response> {
    if (this.options.rustReqwestFetch) return fetchWithTimeout(this.options.rustReqwestFetch, url, request, signal);
    const cwd = this.rustReqwestCwd();
    return fetchWithRustReqwestProcess(url, request, signal, {
      command: this.rustReqwestCommand(), args: this.rustReqwestArgs(),
      ...(cwd !== undefined ? { cwd } : {})
    });
  }

  private rustReqwestCommand(): string {
    return this.options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo";
  }

  private rustReqwestArgs(): string[] {
    if (this.options.rustReqwestArgs) return this.options.rustReqwestArgs;
    if (readEnv("AGENT_PROVIDER_HTTP_COMMAND")) return ["--stdio"];
    return ["run", "-p", "agent-provider-http", "--quiet", "--", "--stdio"];
  }

  private rustReqwestCwd(): string | undefined {
    return this.options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot();
  }

  private *retryDiagnostic(endpoint: ResolvedOpenAICompatibleEndpoint, url: string, attempt: number, maxAttempts: number, reason: string, status?: number, statusText?: string, errorKind?: ProviderErrorKind, retryAfterMs?: number): Iterable<ProviderStreamEvent> {
    yield* this.diagnostic({
      phase: "retry", endpoint, url, attempt, maxAttempts, retryable: true, reason,
      ...(status !== undefined ? { status } : {}),
      ...(statusText !== undefined ? { statusText } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    });
  }

  private sseDiagnostics(endpoint: ResolvedOpenAICompatibleEndpoint, url: string, attempt: number, maxAttempts: number): SseDiagnosticsOptions | undefined {
    if (!this.diagnosticsEnabled() && !this.options.firstByteTimeoutMs && !this.options.streamIdleTimeoutMs) return undefined;
    return {
      enabled: this.diagnosticsEnabled(), providerId: this.id, endpoint, url, attempt, maxAttempts, configuredModel: this.options.model,
      ...(this.options.firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs: this.options.firstByteTimeoutMs } : {}),
      ...(this.options.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: this.options.streamIdleTimeoutMs } : {})
    };
  }

  private *modelMismatchDiagnostic(endpoint: ResolvedOpenAICompatibleEndpoint, url: string, attempt: number, maxAttempts: number, body: JsonObject): Iterable<ProviderStreamEvent> {
    const actualModel = actualModelFromPayload(body);
    if (!actualModel || actualModel === this.options.model) return;
    yield* this.diagnostic({ phase: "model-mismatch", endpoint, url, attempt, maxAttempts, configuredModel: this.options.model, actualModel, modelMismatch: true, reason: "Provider response model differed from the configured request model; keeping the configured model for session state." });
  }

  private *diagnostic(input: Omit<ProviderDiagnostic, "providerId">): Iterable<ProviderStreamEvent> {
    if (!this.diagnosticsEnabled()) return;
    yield { type: "provider-diagnostic", diagnostic: compactObject({ providerId: this.id, ...input }) as unknown as ProviderDiagnostic };
  }

  private diagnosticsEnabled(): boolean {
    if (this.options.diagnostics === true) return true;
    if (this.options.diagnostics && typeof this.options.diagnostics === "object") return this.options.diagnostics.enabled !== false;
    return false;
  }

  private diagnosticHeaders(response: Response): Record<string, string> | undefined {
    if (!this.diagnosticsEnabled()) return undefined;
    const configured = typeof this.options.diagnostics === "object" ? this.options.diagnostics.headers : undefined;
    const names = configured?.length ? configured : DEFAULT_DIAGNOSTIC_HEADERS;
    const headers: Record<string, string> = {};
    for (const name of names) { const value = response.headers.get(name); if (value) headers[name.toLowerCase()] = value.slice(0, 160); }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }


  private shouldFallbackEndpoint(endpoint: ResolvedOpenAICompatibleEndpoint, endpointIndex: number, endpoints: ResolvedOpenAICompatibleEndpoint[], errorKind: ProviderErrorKind, status: number, error: string): boolean {
    if (this.endpoint() !== "auto") return false;
    if (endpoint !== "responses") return false;
    if (endpointIndex >= endpoints.length - 1) return false;
    if (errorKind !== "endpoint-unavailable") return false;
    return isResponsesEndpointUnavailable(status, error);
  }

  private shouldRetryWithSystemPromptUserPrefix(request: AgentProviderRequest, wireMode: SystemPromptWireMode, alreadyRetried: boolean, status: number, error: string): boolean {
    if (alreadyRetried || wireMode !== "native-system-role") return false;
    if (!hasSystemRoleWireContent(request)) return false;
    return isSystemRoleUnsupported(status, error);
  }

  private defaultSystemPromptWireMode(): SystemPromptWireMode {
    return this.options.systemPromptWireMode ?? "native-system-role";
  }
}

// ── Factory functions ──

export async function loadOpenAICompatibleProviderConfig(filePath: string, options: { resolveApiKey?: boolean } = {}): Promise<OpenAICompatibleProviderConfig> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config = parseProviderConfig(parsed, filePath);
  return options.resolveApiKey === false ? config : resolveProviderConfigSecrets(config, filePath, options);
}

export async function createOpenAICompatibleProviderFromConfig(filePath: string, overrides: Partial<OpenAICompatibleProviderOptions> = {}, loadOptions: { resolveApiKey?: boolean } = {}): Promise<OpenAICompatibleProvider> {
  const config = await loadOpenAICompatibleProviderConfig(filePath, loadOptions);
  return new OpenAICompatibleProvider({ ...config, ...overrides });
}

export async function listOpenAICompatibleModels(options: { baseUrl: string; modelsPath?: string; fetch?: typeof fetch; transport?: string; apiKey?: string; authHeader?: OpenAICompatibleAuthHeader; headers?: Record<string, string>; requestTimeoutMs?: number; rustReqwestFetch?: typeof fetch; rustReqwestCommand?: string; rustReqwestArgs?: string[]; rustReqwestCwd?: string }): Promise<OpenAICompatibleModel[]> {
  const { fetchWithTimeout: doFetch, fetchWithOptionalRustReqwestOverride, readEnv } = await import("./provider-openai-base");
  const { authHeaderObject } = await import("./openai-request-build");

  const fetchImpl = options.fetch ?? defaultKeepAliveFetch();
  const transport = options.transport ?? "fetch";
  if (!fetchImpl && transport === "fetch") throw new ProviderError("A fetch implementation is required to list models", "CONFIG_ERROR", false);
  const apiKey = options.apiKey ?? readEnv("CRISH_API_KEY") ?? readEnv("FLOWBIT_API_KEY") ?? readEnv("OPENAI_API_KEY");
  const modelsUrl = resolveModelsUrl(options);
  const signal = new AbortController().signal;
  const request: HttpRequest = { method: "GET", headers: { accept: "application/json", ...authHeaderObject(options.authHeader ?? "authorization", apiKey), ...options.headers }, ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}) };
  let response = transport === "rust-reqwest" || !fetchImpl ? await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options) : await doFetch(fetchImpl, modelsUrl, request, signal);
  if (transport === "auto" && !response.ok) {
    const error = await readError(response.clone());
    const providerError = classifyHttpProviderError(response, error);
    if (providerError.kind === "gateway-challenge") response = await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options);
  }
  if (!response.ok) { const error = await readError(response); const providerError = classifyHttpProviderError(response, error); throw new ProviderError(formatProviderError(error, providerError.kind), providerError.kind, false); }
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

// ── Config parsing (stays here for factory functions) ──

function parseProviderConfig(input: unknown, filePath: string): OpenAICompatibleProviderConfig {
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

async function resolveProviderConfigSecrets(config: OpenAICompatibleProviderConfig, filePath: string, options: { resolveApiKey?: boolean; env?: Record<string, string | undefined> }): Promise<OpenAICompatibleProviderConfig> {
  const { readFile } = await import("node:fs/promises");
  const { resolve, dirname, isAbsolute } = await import("node:path");
  const apiKeyFile = config.apiKeyFile ? (isAbsolute(config.apiKeyFile) ? config.apiKeyFile : resolve(dirname(resolve(filePath)), config.apiKeyFile)) : undefined;
  const apiKey = config.apiKey ?? (config.apiKeyEnv ? readEnvFrom(options.env, config.apiKeyEnv) : undefined) ?? (apiKeyFile ? (await readFile(apiKeyFile, "utf8")).trim() : undefined);
  return compactObject({ ...config, apiKeyFile, apiKey }) as unknown as OpenAICompatibleProviderConfig;
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl.trim().replace(/\/+$/, "").endsWith("/v1") ? baseUrl.trim().replace(/\/+$/, "") : `${baseUrl.trim().replace(/\/+$/, "")}/v1`);
}

function resolveModelsUrl(options: { baseUrl: string; modelsPath?: string }): string {
  const path = options.modelsPath?.trim() || "/models";
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(options.baseUrl)}${normalizedPath}`;
}

// ── Local helpers for the class ──

const DEFAULT_DIAGNOSTIC_HEADERS = ["cf-ray", "cf-cache-status", "x-request-id", "x-openrouter-provider", "x-openrouter-model", "x-openrouter-id", "x-vercel-id", "cf-mitigated", "retry-after", "content-type", "via", "server"];

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

function classifyTransportProviderError(reason: string): { kind: ProviderErrorKind; retryable: boolean } {
  const classified = ErrorClassifier.classify(new Error(reason));
  return { kind: classified.legacyKind as ProviderErrorKind, retryable: classified.retryable };
}

function classifyStreamProviderError(reason: string, cause: unknown): { kind: ProviderErrorKind; retryable: boolean } {
  const error = cause instanceof Error ? cause : new Error(reason);
  const classified = ErrorClassifier.classify(error);
  return { kind: classified.legacyKind as ProviderErrorKind, retryable: classified.retryable };
}

export function classifyHttpProviderError(response: Response, error: string): { kind: ProviderErrorKind; retryable: boolean } {
  const classified = ErrorClassifier.classify(new Error(error), { status: response.status, headers: response.headers });
  return { kind: classified.legacyKind as ProviderErrorKind, retryable: classified.retryable };
}

function isResponsesEndpointUnavailable(status: number, error: string): boolean {
  if (status === 404 || status === 405 || status === 415) return true;
  if (status === 400 || status === 422) return /\bresponses?\b/i.test(error) && /\b(unknown|unsupported|invalid|not found|not_found)\b/i.test(error);
  return false;
}

function isSystemRoleUnsupported(status: number, error: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /system\s+messages?\s+are\s+not\s+allowed|system\s+role\s+(is\s+)?(not\s+)?(allowed|supported)|role[^"'`]*system[^"'`]*(not\s+allowed|unsupported|invalid)/i.test(error);
}

function hasSystemRoleWireContent(request: AgentProviderRequest): boolean {
  return Boolean(request.systemPrompt?.trim()) || request.messages.some((message) => message.role === "system" && textContent(message).trim().length > 0);
}

function requestDiagnosticFields(request: AgentProviderRequest, wireMode: SystemPromptWireMode, streamRequested: boolean): Record<string, unknown> {
  const roleCounts = { system: 0, user: 0, assistant: 0, tool: 0 };
  let systemMessageCount = request.systemPrompt?.trim() ? 1 : 0;
  for (const message of request.messages) { roleCounts[message.role] += 1; if (message.role === "system" && textContent(message).trim().length > 0) systemMessageCount += 1; }
  return compactObject({ streamRequested, systemPromptWireMode: wireMode, hasSystemRole: systemMessageCount > 0, systemPromptPresent: Boolean(request.systemPrompt?.trim()), systemMessageCount, rewrittenSystemMessageCount: wireMode === "user-prefix" ? systemMessageCount : 0, messageCount: request.messages.length, toolCount: request.tools.length, messageRoleCounts: roleCounts });
}

function trimDiagnosticReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}


function actualModelFromPayload(body: JsonObject): string | undefined {
  return stringField(body.model) ?? stringField(recordField(body.response, undefined)?.model);
}

function providerBodyError(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const error = recordField(body.error, undefined);
  return stringField(error?.message) ?? stringField(body.error) ?? stringField(body.message) ?? stringField(body.error_description) ?? stringField(body.code);
}

// ── Config parsing option validators ──

function optionalEndpoint(value: unknown, label: string): OpenAICompatibleEndpoint | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto") return "auto";
  if (normalized === "chat" || normalized === "chat-completions") return "chat-completions";
  if (normalized === "response" || normalized === "responses") return "responses";
  throw new ProviderError(`${label} must be "auto", "chat-completions", or "responses"`, "CONFIG_ERROR", false);
}

function optionalTransport(value: unknown, label: string): OpenAICompatibleTransport | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "fetch" || normalized === "rust-reqwest" || normalized === "auto") return normalized;
  throw new ProviderError(`${label} must be "fetch", "rust-reqwest", or "auto"`, "CONFIG_ERROR", false);
}

function optionalSystemPromptWireMode(value: unknown, label: string): SystemPromptWireMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user-prefix" || normalized === "user" || normalized === "prefix") return "user-prefix";
  throw new ProviderError(`${label} must be "native-system-role" or "user-prefix"`, "CONFIG_ERROR", false);
}

function optionalAuthHeader(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["authorization", "api-key", "x-api-key", "none"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "authorization", "api-key", "x-api-key", or "none"`, "CONFIG_ERROR", false);
}

function optionalMaxTokensField(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["max_tokens", "max_completion_tokens", "max_output_tokens"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "max_tokens", "max_completion_tokens", or "max_output_tokens"`, "CONFIG_ERROR", false);
}

function optionalReasoningContentMode(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["omit", "include", "require"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "omit", "include", or "require"`, "CONFIG_ERROR", false);
}

function optionalReasoningEffort(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (["off", "auto", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "off", "auto", "minimal", "low", "medium", "high", or "xhigh"`, "CONFIG_ERROR", false);
}

function optionalReasoningEffortFormat(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (["auto", "responses", "chat-completions", "none"].includes(normalized)) return normalized;
  throw new ProviderError(`${label} must be "auto", "responses", "chat-completions", or "none"`, "CONFIG_ERROR", false);
}

function optionalToolChoice(value: unknown, label: string): string | { type: "function"; name: string } | undefined {
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

function optionalDiagnostics(value: unknown, label: string): boolean | { enabled?: boolean; headers?: string[] } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const record = objectRecord(value, label);
  return compactObject({ enabled: optionalBoolean(record.enabled, `${label}.enabled`), headers: optionalStringArray(record.headers, `${label}.headers`) });
}

function optionalRetryOptions(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return compactObject({ maxAttempts: optionalPositiveInteger(record.maxAttempts, `${label}.maxAttempts`), initialDelayMs: optionalPositiveInteger(record.initialDelayMs, `${label}.initialDelayMs`), maxDelayMs: optionalPositiveInteger(record.maxDelayMs, `${label}.maxDelayMs`), totalBudgetMs: optionalPositiveInteger(record.totalBudgetMs, `${label}.totalBudgetMs`), jitterRatio: optionalNumber(record.jitterRatio, `${label}.jitterRatio`) });
}
