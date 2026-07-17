import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@crish/shared-utils";
import type {
  JsonObject,
  JsonValue,
  ProviderDiagnostic,
  ProviderErrorKind
} from "@crish/shared-types";
import type {
  AgentProvider,
  AgentProviderRequest,
  ProviderUsage,
  ProviderStreamEvent
} from "./types";
import {
  authHeaderObject,
  compactObject,
  maxTokensObject,
  reasoningEffortObject,
  textContent,
  toChatMessages,
  toChatToolChoice,
  toOpenAITool,
  toResponsesInput,
  toResponsesTool,
  toResponsesToolChoice,
  type OpenAICompatibleAuthHeader,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleReasoningContentMode,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
  type ResolvedOpenAICompatibleEndpoint,
  type SystemPromptWireMode
} from "./openai-request-build";
import {
  delay,
  normalizeRetryOptions,
  parseRetryAfterMs,
  retryDelayMs,
  withinRetryBudget,
  type OpenAICompatibleRetryOptions
} from "./openai-retry";
import {
  isSseReadDiagnostic,
  readSseJson,
  type SseDiagnosticsOptions
} from "./openai-stream-parse";

// 公共类型：从纯模块再导出，保持 package 对外 API 不变
export type { OpenAICompatibleRetryOptions } from "./openai-retry";
export type {
  OpenAICompatibleAuthHeader,
  OpenAICompatibleMaxTokensField,
  OpenAICompatibleReasoningContentMode,
  OpenAICompatibleReasoningEffort,
  OpenAICompatibleReasoningEffortFormat,
  OpenAICompatibleToolChoice,
  SystemPromptWireMode
} from "./openai-request-build";

export interface OpenAICompatibleProviderOptions {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  model: string;
  endpoint?: OpenAICompatibleEndpoint;
  authHeader?: OpenAICompatibleAuthHeader;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  reasoningContent?: OpenAICompatibleReasoningContentMode;
  toolChoice?: OpenAICompatibleToolChoice;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: OpenAICompatibleReasoningEffort;
  reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  diagnostics?: boolean | OpenAICompatibleDiagnosticsOptions;
  systemPromptWireMode?: SystemPromptWireMode;
  headers?: Record<string, string>;
  retry?: OpenAICompatibleRetryOptions;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  rustReqwestFetch?: typeof fetch;
  fetch?: typeof fetch;
}

export interface OpenAICompatibleDiagnosticsOptions {
  enabled?: boolean;
  headers?: string[];
}

export interface OpenAICompatibleProviderFileConfig {
  provider: OpenAICompatibleProviderConfig;
}

export interface OpenAICompatibleProviderConfig {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  model: string;
  endpoint?: OpenAICompatibleEndpoint;
  authHeader?: OpenAICompatibleAuthHeader;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  reasoningContent?: OpenAICompatibleReasoningContentMode;
  toolChoice?: OpenAICompatibleToolChoice;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: OpenAICompatibleReasoningEffort;
  reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  diagnostics?: boolean | OpenAICompatibleDiagnosticsOptions;
  systemPromptWireMode?: SystemPromptWireMode;
  headers?: Record<string, string>;
  retry?: OpenAICompatibleRetryOptions;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
}

export type OpenAICompatibleEndpoint = "auto" | "chat-completions" | "responses";
export type OpenAICompatibleTransport = "fetch" | "rust-reqwest" | "auto";

export interface OpenAICompatibleProviderConfigLoadOptions {
  env?: Record<string, string | undefined>;
  resolveApiKey?: boolean;
}

export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface ResponsePendingToolCall {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
  argumentsDone?: boolean;
  itemDone?: boolean;
}

const DEFAULT_DIAGNOSTIC_HEADERS = [
  "cf-ray",
  "cf-cache-status",
  "x-request-id",
  "x-openrouter-provider",
  "x-openrouter-model",
  "x-openrouter-id",
  "x-vercel-id",
  "cf-mitigated",
  "retry-after",
  "content-type",
  "via",
  "server"
];

interface ProviderHttpRequest {
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface ProviderFetchResult {
  response: Response;
  diagnostics?: Array<Omit<ProviderDiagnostic, "providerId" | "endpoint" | "url" | "attempt" | "maxAttempts">>;
}

interface RustReqwestProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
}

interface RustReqwestRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  timeoutMs?: number;
  streamBody?: boolean;
}

interface RustReqwestResponseHeader {
  status: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  error?: string;
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  // Wire mode 检测结果在每个 stream() 调用中独立跟踪，不跨 run 缓存
  // @deprecated 使用 stream() 局部 `wireModeCache` Map 替代

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl && (options.transport ?? "fetch") === "fetch") {
      throw new Error("A fetch implementation is required for OpenAICompatibleProvider");
    }
  }

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const retry = normalizeRetryOptions(this.options.retry);
    const startedAt = Date.now();
    const endpoints = this.resolvedEndpoints();
    // 每个 stream() 调用独立跟踪 wire mode，不跨 run 共享
    const wireModeCache = new Map<ResolvedOpenAICompatibleEndpoint, SystemPromptWireMode>();

    // 多 endpoint 重试结构（三层，避免用 attempt=maxAttempts 等副作用跳出）：
    // 1) endpoint 层：当前 endpoint 不可用时 fall through 到下一个
    // 2) attempt 层：可重试的传输/HTTP 错误，递增 attempt
    // 3) wireMode 内循环：同一 attempt 内因 system-role 兼容问题切换 wireMode 后原地重试
    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
      const endpoint = endpoints[endpointIndex]!;
      const url = `${this.baseUrl}${this.requestPath(endpoint)}`;
      attemptLoop: for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        let wireMode = wireModeCache.get(endpoint) ?? this.defaultSystemPromptWireMode();
        let retriedSystemPromptCompatibility = false;
        // wireMode 兼容重试：continue 留在本 attempt；break 进入下一 attempt；break attemptLoop 换 endpoint
        while (true) {
          const attemptStartedAt = Date.now();
          yield* this.diagnostic({
            phase: "request-start",
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: attemptStartedAt - startedAt,
            configuredModel: this.options.model,
            reason: wireMode === "user-prefix" ? "system-prompt-user-prefix" : undefined,
            ...requestDiagnosticFields(request, wireMode, this.options.stream !== false)
          });

          let fetchResult: ProviderFetchResult;
          let response: Response;
          try {
            fetchResult = await this.fetchOnce(request, url, endpoint, wireMode);
            for (const diagnostic of fetchResult.diagnostics ?? []) {
              yield* this.diagnostic({
                ...diagnostic,
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts
              });
            }
            response = fetchResult.response;
          } catch (cause) {
            const reason = errorMessage(cause);
            const error = classifyTransportProviderError(reason);
            const retryable = attempt < retry.maxAttempts && error.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable,
              errorKind: error.kind,
              reason
            });
            if (!retryable) throw cause;
            yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error.kind);
            await delay(retryDelayMs(retry, attempt), request.signal);
            break;
          }

          yield* this.diagnostic({
            phase: "response-start",
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: Date.now() - attemptStartedAt,
            status: response.status,
            statusText: response.statusText,
            headers: this.diagnosticHeaders(response)
          });

          if (!response.ok) {
            const error = await readError(response);
            const providerError = classifyHttpProviderError(response, error);
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            if (this.shouldRetryWithSystemPromptUserPrefix(request, wireMode, retriedSystemPromptCompatibility, response.status, error)) {
              wireMode = "user-prefix";
              retriedSystemPromptCompatibility = true;
              wireModeCache.set(endpoint, wireMode);
              yield* this.diagnostic({
                phase: "request-error",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason: "Provider rejected system-role messages; retrying this endpoint with the system prompt as a stable user-prefix instruction."
              });
              continue;
            }
            if (this.shouldFallbackEndpoint(endpoint, endpointIndex, endpoints, providerError.kind, response.status, error)) {
              yield* this.diagnostic({
                phase: "endpoint-fallback",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason: trimDiagnosticReason(error)
              });
              // 放弃当前 endpoint 的剩余 attempt，直接切换到下一 endpoint
              break attemptLoop;
            }
            const retryable = attempt < retry.maxAttempts && providerError.retryable && withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable,
              errorKind: providerError.kind,
              retryAfterMs,
              reason: trimDiagnosticReason(error)
            });
            if (!retryable) throw new Error(formatProviderError(error, providerError.kind));
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
              const stream =
                endpoint === "responses"
                  ? parseResponsesStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal)
                  : parseChatCompletionsStreamingResponse(response, this.sseDiagnostics(endpoint, url, attempt, retry.maxAttempts), request.signal);
              for await (const event of stream) {
                if (
                  event.type === "stop" &&
                  event.reason === "error" &&
                  !emittedModelEvent &&
                  this.shouldRetryWithSystemPromptUserPrefix(
                    request,
                    wireMode,
                    retriedSystemPromptCompatibility,
                    response.status >= 400 ? response.status : 400,
                    event.error ?? ""
                  )
                ) {
                  wireMode = "user-prefix";
                  retriedSystemPromptCompatibility = true;
                  retrySystemPromptCompatibilityAfterStreamError = true;
                  wireModeCache.set(endpoint, wireMode);
                  yield* this.diagnostic({
                    phase: "request-error",
                    endpoint,
                    url,
                    attempt,
                    maxAttempts: retry.maxAttempts,
                    elapsedMs: Date.now() - attemptStartedAt,
                    status: response.status,
                    statusText: response.statusText,
                    retryable: true,
                    errorKind: "schema",
                    reason: "Provider emitted a streaming system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.",
                    ...requestDiagnosticFields(request, "native-system-role", streamRequested)
                  });
                  break;
                }
                if (event.type !== "provider-diagnostic") emittedModelEvent = true;
                yield event;
              }
              if (retrySystemPromptCompatibilityAfterStreamError) continue;
              return;
            } catch (cause) {
              const reason = errorMessage(cause);
              const error = classifyStreamProviderError(reason, cause);
              const retryable =
                !request.signal.aborted &&
                !emittedModelEvent &&
                error.retryable &&
                attempt < retry.maxAttempts &&
                withinRetryBudget(startedAt, retry.totalBudgetMs);
              yield* this.diagnostic({
                phase: "request-error",
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                retryable,
                errorKind: error.kind,
                reason
              });
              if (emittedModelEvent) {
                yield { type: "stop", reason: "error", error: formatProviderError(reason, error.kind) };
                return;
              }
              if (!retryable) throw cause;
              yield* this.retryDiagnostic(endpoint, url, attempt, retry.maxAttempts, reason, undefined, undefined, error.kind);
              await delay(retryDelayMs(retry, attempt), request.signal);
              break;
            }
          }

          if (streamRequested) {
            const streamFallbackReason = `Provider returned ${contentType || "unknown content type"} for a streaming request; parsing the response as non-streaming JSON.`;
            yield* this.diagnostic({
              phase: "transport-fallback",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable: false,
              errorKind: "invalid-stream",
              reason: streamFallbackReason
            });
          }

          const body = (await response.json()) as JsonObject;
          const bodyError = providerBodyError(body);
          if (
            this.shouldRetryWithSystemPromptUserPrefix(
              request,
              wireMode,
              retriedSystemPromptCompatibility,
              response.status >= 400 ? response.status : 400,
              bodyError ?? ""
            )
          ) {
            wireMode = "user-prefix";
            retriedSystemPromptCompatibility = true;
            wireModeCache.set(endpoint, wireMode);
            yield* this.diagnostic({
              phase: "request-error",
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable: true,
              errorKind: "schema",
              reason: "Provider returned a JSON system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.",
              ...requestDiagnosticFields(request, "native-system-role", streamRequested)
            });
            continue;
          }
          yield* this.modelMismatchDiagnostic(endpoint, url, attempt, retry.maxAttempts, body);
          yield* (endpoint === "responses" ? parseResponsesJsonResponse(body) : parseChatCompletionsJsonResponse(body));
          return;
        }
      }
    }
  }

  private endpoint(): OpenAICompatibleEndpoint {
    return this.options.endpoint ?? "auto";
  }

  private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
    const endpoint = this.endpoint();
    if (endpoint === "auto") return ["responses", "chat-completions"];
    return [endpoint];
  }

  private buildHeaders(): Record<string, string> {
    const apiKey =
      this.options.apiKey ??
      (this.options.apiKeyEnv ? readEnv(this.options.apiKeyEnv) : undefined) ??
      (this.options.apiKeyFile ? readSecretFileSync(this.options.apiKeyFile) : undefined) ??
      readEnv("FLOWBIT_API_KEY") ??
      readEnv("OPENAI_API_KEY");
    return {
      "content-type": "application/json",
      accept: this.options.stream === false ? "application/json" : "text/event-stream",
      ...authHeaderObject(this.options.authHeader ?? "authorization", apiKey),
      ...this.options.headers
    };
  }

  private buildRequestBody(request: AgentProviderRequest, endpoint: ResolvedOpenAICompatibleEndpoint, wireMode: SystemPromptWireMode): JsonObject {
    return endpoint === "responses" ? this.buildResponsesRequestBody(request, wireMode) : this.buildChatCompletionsRequestBody(request, wireMode);
  }

  private buildChatCompletionsRequestBody(request: AgentProviderRequest, wireMode: SystemPromptWireMode): JsonObject {
    return compactObject({
      model: this.options.model,
      stream: this.options.stream !== false,
      temperature: this.options.temperature,
      top_p: this.options.topP,
      ...maxTokensObject(this.chatMaxTokensField(), this.options.maxTokens),
      ...reasoningEffortObject("chat-completions", this.options.model, this.options.reasoningEffort, this.options.reasoningEffortFormat),
      messages: toChatMessages(request.systemPrompt, request.messages, this.options.reasoningContent ?? "omit", wireMode),
      tools: request.tools.length > 0 ? request.tools.map(toOpenAITool) : undefined,
      tool_choice: request.tools.length > 0 ? toChatToolChoice(this.options.toolChoice ?? "auto") : undefined,
      stream_options: this.options.stream !== false ? { include_usage: true } : undefined
    });
  }

  private buildResponsesRequestBody(request: AgentProviderRequest, wireMode: SystemPromptWireMode): JsonObject {
    return compactObject({
      model: this.options.model,
      stream: this.options.stream !== false,
      temperature: this.options.temperature,
      top_p: this.options.topP,
      max_output_tokens: this.options.maxTokens,
      ...reasoningEffortObject("responses", this.options.model, this.options.reasoningEffort, this.options.reasoningEffortFormat),
      input: toResponsesInput(request.systemPrompt, request.messages, wireMode),
      tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined,
      tool_choice: request.tools.length > 0 ? toResponsesToolChoice(this.options.toolChoice ?? "auto") : undefined
    });
  }

  private requestPath(endpoint: ResolvedOpenAICompatibleEndpoint): string {
    return endpoint === "responses" ? "/responses" : "/chat/completions";
  }

  private async fetchOnce(
    request: AgentProviderRequest,
    url: string,
    endpoint: ResolvedOpenAICompatibleEndpoint,
    wireMode: SystemPromptWireMode
  ): Promise<ProviderFetchResult> {
    const httpRequest: ProviderHttpRequest = {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildRequestBody(request, endpoint, wireMode)),
      timeoutMs: this.options.requestTimeoutMs
    };
    const transport = this.options.transport ?? "fetch";

    if (transport === "rust-reqwest") {
      return {
        response: await this.fetchWithRustReqwest(url, httpRequest, request.signal)
      };
    }

    try {
      const fetchImpl = this.fetchImpl ?? (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);
      if (!fetchImpl) {
        return {
          response: await this.fetchWithRustReqwest(url, httpRequest, request.signal),
          diagnostics: [
            {
              phase: "transport-fallback",
              retryable: true,
              errorKind: "network",
              reason: "Fetch transport is unavailable; using Rust reqwest transport."
            }
          ]
        };
      }
      const response = await fetchWithTimeout(fetchImpl, url, httpRequest, request.signal);
      if (transport !== "auto" || response.ok) {
        return { response };
      }

      const error = await readError(response.clone());
      const providerError = classifyHttpProviderError(response, error);
      if (providerError.kind !== "gateway-challenge") {
        return { response };
      }

      return {
        response: await this.fetchWithRustReqwest(url, httpRequest, request.signal),
        diagnostics: [
          {
            phase: "transport-fallback",
            status: response.status,
            statusText: response.statusText,
            retryable: true,
            errorKind: providerError.kind,
            reason: trimDiagnosticReason(error)
          }
        ]
      };
    } catch (cause) {
      if (transport !== "auto" || request.signal.aborted) throw cause;
      const reason = errorMessage(cause);
      const response = await this.fetchWithRustReqwest(url, httpRequest, request.signal).catch((fallbackCause) => {
        const fallbackMsg = errorMessage(fallbackCause);
        const hint = fallbackMsg.includes("agent-provider-http") ? " (提示: 请运行 cargo build -p agent-provider-http 构建传输层)" : "";
        throw new Error(`Fetch transport failed: ${reason}; Rust reqwest fallback failed: ${fallbackMsg}${hint}`);
      });
      return {
        response,
        diagnostics: [
          {
            phase: "transport-fallback",
            retryable: true,
            errorKind: "network",
            reason: trimDiagnosticReason(reason)
          }
        ]
      };
    }
  }

  private async fetchWithRustReqwest(url: string, request: ProviderHttpRequest, signal: AbortSignal): Promise<Response> {
    if (this.options.rustReqwestFetch) {
      return fetchWithTimeout(this.options.rustReqwestFetch, url, request, signal);
    }
    return fetchWithRustReqwestProcess(url, request, signal, {
      command: this.rustReqwestCommand(),
      args: this.rustReqwestArgs(),
      cwd: this.rustReqwestCwd()
    });
  }

  private rustReqwestCommand(): string {
    return this.options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo";
  }

  private rustReqwestArgs(): string[] {
    if (this.options.rustReqwestArgs) return this.options.rustReqwestArgs;
    if (readEnv("AGENT_PROVIDER_HTTP_COMMAND")) return [];
    return ["run", "-p", "agent-provider-http", "--quiet"];
  }

  private rustReqwestCwd(): string | undefined {
    return this.options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot();
  }

  private *retryDiagnostic(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number,
    reason: string,
    status?: number,
    statusText?: string,
    errorKind?: ProviderErrorKind,
    retryAfterMs?: number
  ): Iterable<ProviderStreamEvent> {
    yield* this.diagnostic({
      phase: "retry",
      endpoint,
      url,
      attempt,
      maxAttempts,
      status,
      statusText,
      retryable: true,
      errorKind,
      retryAfterMs,
      reason
    });
  }

  private sseDiagnostics(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number
  ): SseDiagnosticsOptions | undefined {
    if (!this.diagnosticsEnabled() && !this.options.firstByteTimeoutMs && !this.options.streamIdleTimeoutMs) return undefined;
    return {
      enabled: this.diagnosticsEnabled(),
      providerId: this.id,
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      firstByteTimeoutMs: this.options.firstByteTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs
    };
  }

  private *modelMismatchDiagnostic(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number,
    body: JsonObject
  ): Iterable<ProviderStreamEvent> {
    const actualModel = actualModelFromPayload(body);
    if (!actualModel || actualModel === this.options.model) return;
    yield* this.diagnostic({
      phase: "model-mismatch",
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      actualModel,
      modelMismatch: true,
      reason: "Provider response model differed from the configured request model; keeping the configured model for session state."
    });
  }

  private *diagnostic(input: Omit<ProviderDiagnostic, "providerId">): Iterable<ProviderStreamEvent> {
    if (!this.diagnosticsEnabled()) return;
    yield { type: "provider-diagnostic", diagnostic: compactObject({ providerId: this.id, ...input }) as unknown as ProviderDiagnostic };
  }

  private diagnosticsEnabled(): boolean {
    if (this.options.diagnostics === true) return true;
    if (this.options.diagnostics && typeof this.options.diagnostics === "object") {
      return this.options.diagnostics.enabled !== false;
    }
    return false;
  }

  private diagnosticHeaders(response: Response): Record<string, string> | undefined {
    if (!this.diagnosticsEnabled()) return undefined;
    const configured = typeof this.options.diagnostics === "object" ? this.options.diagnostics.headers : undefined;
    const names = configured?.length ? configured : DEFAULT_DIAGNOSTIC_HEADERS;
    const headers: Record<string, string> = {};
    for (const name of names) {
      const value = response.headers.get(name);
      if (value) headers[name.toLowerCase()] = value.slice(0, 160);
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private chatMaxTokensField(): OpenAICompatibleMaxTokensField {
    if (this.options.maxTokensField) return this.options.maxTokensField;
    return isMimoModel(this.options.model) ? "max_completion_tokens" : "max_tokens";
  }

  private shouldFallbackEndpoint(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    endpointIndex: number,
    endpoints: ResolvedOpenAICompatibleEndpoint[],
    errorKind: ProviderErrorKind,
    status: number,
    error: string
  ): boolean {
    if (this.endpoint() !== "auto") return false;
    if (endpoint !== "responses") return false;
    if (endpointIndex >= endpoints.length - 1) return false;
    if (errorKind !== "endpoint-unavailable") return false;
    return isResponsesEndpointUnavailable(status, error);
  }

  private shouldRetryWithSystemPromptUserPrefix(
    request: AgentProviderRequest,
    wireMode: SystemPromptWireMode,
    alreadyRetried: boolean,
    status: number,
    error: string
  ): boolean {
    if (alreadyRetried || wireMode !== "native-system-role") return false;
    if (!hasSystemRoleWireContent(request)) return false;
    return isSystemRoleUnsupported(status, error);
  }

  private defaultSystemPromptWireMode(): SystemPromptWireMode {
    return this.options.systemPromptWireMode ?? "native-system-role";
  }
}

export async function loadOpenAICompatibleProviderConfig(
  filePath: string,
  options: OpenAICompatibleProviderConfigLoadOptions = {}
): Promise<OpenAICompatibleProviderConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config = parseProviderConfig(parsed, filePath);
  return options.resolveApiKey === false ? config : resolveProviderConfigSecrets(config, filePath, options);
}

export async function createOpenAICompatibleProviderFromConfig(
  filePath: string,
  overrides: Partial<OpenAICompatibleProviderOptions> = {},
  loadOptions: OpenAICompatibleProviderConfigLoadOptions = {}
): Promise<OpenAICompatibleProvider> {
  const config = await loadOpenAICompatibleProviderConfig(filePath, loadOptions);
  return new OpenAICompatibleProvider({
    ...config,
    ...overrides
  });
}

export async function listOpenAICompatibleModels(options: {
  baseUrl: string;
  modelsUrl?: string;
  modelsPath?: string;
  apiKey?: string;
  authHeader?: OpenAICompatibleAuthHeader;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  transport?: OpenAICompatibleTransport;
  rustReqwestCommand?: string;
  rustReqwestArgs?: string[];
  rustReqwestCwd?: string;
  rustReqwestFetch?: typeof fetch;
  fetch?: typeof fetch;
}): Promise<OpenAICompatibleModel[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const transport = options.transport ?? "fetch";
  if (!fetchImpl && transport === "fetch") {
    throw new Error("A fetch implementation is required to list models");
  }
  const apiKey = options.apiKey ?? readEnv("FLOWBIT_API_KEY") ?? readEnv("OPENAI_API_KEY");
  const modelsUrl = resolveModelsUrl(options);
  const signal = new AbortController().signal;
  const request: ProviderHttpRequest = {
    method: "GET",
    headers: {
      accept: "application/json",
      ...authHeaderObject(options.authHeader ?? "authorization", apiKey),
      ...options.headers
    },
    timeoutMs: options.requestTimeoutMs
  };
  let response =
    transport === "rust-reqwest" || !fetchImpl
      ? await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options)
      : await fetchWithTimeout(fetchImpl, modelsUrl, request, signal);
  if (transport === "auto" && !response.ok) {
    const error = await readError(response.clone());
    const providerError = classifyHttpProviderError(response, error);
    if (providerError.kind === "gateway-challenge") {
      response = await fetchWithOptionalRustReqwestOverride(modelsUrl, request, signal, options);
    }
  }
  if (!response.ok) {
    const error = await readError(response);
    const providerError = classifyHttpProviderError(response, error);
    throw new Error(formatProviderError(error, providerError.kind));
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    return [];
  }
  return body.data
    .map((item): OpenAICompatibleModel | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") return null;
      return {
        id: record.id,
        object: typeof record.object === "string" ? record.object : undefined,
        created: typeof record.created === "number" ? record.created : undefined,
        ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined
      };
    })
    .filter((model): model is OpenAICompatibleModel => model !== null);
}

function parseProviderConfig(input: unknown, filePath: string): OpenAICompatibleProviderConfig {
  const root = objectRecord(input, `${filePath}: root`);
  const provider = objectRecord(root.provider, `${filePath}: provider`);
  const config = compactObject({
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
  });
  return config as unknown as OpenAICompatibleProviderConfig;
}

async function resolveProviderConfigSecrets(
  config: OpenAICompatibleProviderConfig,
  filePath: string,
  options: OpenAICompatibleProviderConfigLoadOptions
): Promise<OpenAICompatibleProviderConfig> {
  const apiKeyFile = config.apiKeyFile ? resolveConfigRelativePath(config.apiKeyFile, filePath) : undefined;
  const apiKey =
    config.apiKey ??
    (config.apiKeyEnv ? readEnvFrom(options.env, config.apiKeyEnv) : undefined) ??
    (apiKeyFile ? (await readFile(apiKeyFile, "utf8")).trim() : undefined);
  return compactObject({
    ...config,
    apiKeyFile,
    apiKey
  }) as unknown as OpenAICompatibleProviderConfig;
}

function resolveConfigRelativePath(filePath: string, configPath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(dirname(resolve(configPath)), filePath);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function resolveModelsUrl(options: { baseUrl: string; modelsUrl?: string; modelsPath?: string }): string {
  if (options.modelsUrl?.trim()) return options.modelsUrl.trim();
  const path = options.modelsPath?.trim() || "/models";
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(options.baseUrl)}${normalizedPath}`;
}

async function* parseChatCompletionsJsonResponse(body: JsonObject): AsyncIterable<ProviderStreamEvent> {
  const error = providerBodyError(body);
  if (error) {
    yield { type: "stop", reason: "error", error };
    return;
  }

  const choice = Array.isArray(body.choices) ? (body.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : undefined;
  if (!message) {
    yield { type: "stop", reason: "error", error: "OpenAI-compatible response did not include a message" };
    return;
  }

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    yield { type: "thought-delta", text: message.reasoning_content };
  }

  if (typeof message.content === "string" && message.content.length > 0) {
    yield { type: "text-delta", text: message.content };
  }

  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      const call = parseFullToolCall(rawCall);
      if (call) {
        yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
      }
    }
  }

  yield { type: "stop", reason: finishReasonToStop(choice?.finish_reason), usage: parseUsage(body.usage) };
}

async function* parseChatCompletionsStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    yield { type: "stop", reason: "error", error: "Streaming response body is empty" };
    return;
  }

  const pending = new Map<number, PendingToolCall>();
  let finishReason: ProviderStreamEvent & { type: "stop" } = { type: "stop", reason: "stop" };
  let usage: ProviderUsage | undefined;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: "provider-diagnostic", diagnostic: payload.diagnostic };
      continue;
    }
    if (!modelMismatchReported) {
      const modelMismatch = modelMismatchStreamEvent(actualModelFromPayload(payload), diagnostics);
      if (modelMismatch) {
        modelMismatchReported = true;
        yield modelMismatch;
      }
    }
    const payloadError = providerBodyError(payload);
    if (payloadError) {
      yield { type: "stop", reason: "error", error: payloadError, usage };
      return;
    }
    usage = parseUsage(payload.usage) ?? usage;
    const choice = Array.isArray(payload.choices) ? (payload.choices[0] as Record<string, unknown> | undefined) : undefined;
    const delta = choice?.delta && typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : undefined;
    if (!choice || !delta) continue;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text-delta", text: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { type: "thought-delta", text: delta.reasoning_content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        mergeToolCallDelta(pending, raw);
      }
    }

    if (choice.finish_reason) {
      finishReason = { type: "stop", reason: finishReasonToStop(choice.finish_reason) };
    }
  }

  for (const call of [...pending.entries()].sort(([left], [right]) => left - right).map(([, call]) => call)) {
    if (call.name) {
      yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
    }
  }
  yield { ...finishReason, usage };
}

async function* parseResponsesJsonResponse(body: JsonObject): AsyncIterable<ProviderStreamEvent> {
  const output = Array.isArray(body.output) ? body.output : [];
  let sawToolCall = false;

  for (const item of output) {
    for (const event of responseOutputItemEvents(item)) {
      if (event.type === "tool-call") sawToolCall = true;
      yield event;
    }
  }

  yield compactObject({
    type: "stop",
    reason: sawToolCall ? "tool-call" : responseStatusToStop(body),
    error: responseError(body),
    usage: parseUsage(body.usage)
  }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
}

async function* parseResponsesStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    yield { type: "stop", reason: "error", error: "Streaming response body is empty" };
    return;
  }

  const pending = new Map<string, ResponsePendingToolCall>();
  const emitted = new Set<string>();
  let usage: ProviderUsage | undefined;
  let finalReason: "stop" | "tool-call" | "length" | "error" = "stop";
  let finalError: string | undefined;
  let sawToolCall = false;
  let sawTerminal = false;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: "provider-diagnostic", diagnostic: payload.diagnostic };
      continue;
    }
    if (!modelMismatchReported) {
      const modelMismatch = modelMismatchStreamEvent(actualModelFromPayload(payload), diagnostics);
      if (modelMismatch) {
        modelMismatchReported = true;
        yield modelMismatch;
      }
    }
    const type = typeof payload.type === "string" ? payload.type : "";
    usage = parseUsage(payload.usage) ?? parseUsage(recordField(payload.response, "usage")) ?? usage;

    if (type === "error") {
      yield {
        type: "stop",
        reason: "error",
        error: responseError(payload) ?? stringField(payload.message) ?? stringField(payload.code) ?? "Responses stream emitted an error event",
        usage
      };
      return;
    }

    if (type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta.length > 0) {
      yield { type: "text-delta", text: payload.delta };
      continue;
    }

    if (isResponsesThoughtDelta(type) && typeof payload.delta === "string" && payload.delta.length > 0) {
      yield { type: "thought-delta", text: payload.delta, redacted: true };
      continue;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const call = mergeResponseToolCallItem(pending, payload.item);
      if (type === "response.output_item.done") {
        if (call) call.itemDone = true;
        const event = call && (call.argumentsDone || call.argumentsText.trim()) ? emitResponseToolCall(call, emitted) : undefined;
        if (event) {
          sawToolCall = true;
          yield event;
        }
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      mergeResponseToolCallArguments(pending, payload, "append");
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const call = mergeResponseToolCallArguments(pending, payload, "replace");
      if (call) call.argumentsDone = true;
      const event = emitResponseToolCall(call, emitted);
      if (event) {
        sawToolCall = true;
        yield event;
      }
      continue;
    }

    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      sawTerminal = true;
      const responsePayload = recordField(payload.response, undefined);
      usage = parseUsage(recordField(responsePayload, "usage")) ?? usage;
      finalReason = responseStatusToStop(responsePayload ?? payload);
      finalError = responseError(responsePayload ?? payload);
      for (const item of responseOutputItems(responsePayload)) {
        mergeResponseToolCallItem(pending, item);
      }
    }
  }

  for (const call of pending.values()) {
    const event = emitResponseToolCall(call, emitted);
    if (event) {
      sawToolCall = true;
      yield event;
    }
  }

  if (!sawTerminal) {
    yield compactObject({
      type: "stop",
      reason: "error",
      error: formatProviderError("Responses stream ended without a terminal response event", "invalid-stream"),
      usage
    }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
    return;
  }

  yield compactObject({
    type: "stop",
    reason: sawToolCall ? "tool-call" : finalReason,
    error: finalError,
    usage
  }) as unknown as Extract<ProviderStreamEvent, { type: "stop" }>;
}

function* responseOutputItemEvents(item: unknown): Iterable<ProviderStreamEvent> {
  const record = recordField(item, undefined);
  if (!record) return;

  if (record.type === "message") {
    for (const part of responseContentParts(record.content)) {
      const content = recordField(part, undefined);
      if (!content) continue;
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string" && content.text.length > 0) {
        yield { type: "text-delta", text: content.text };
      }
    }
    return;
  }

  if (record.type === "function_call") {
    const name = stringField(record.name);
    if (!name) return;
    yield {
      type: "tool-call",
      id: stringField(record.call_id) ?? stringField(record.id),
      toolName: name,
      input: parseArguments(stringField(record.arguments) ?? "")
    };
    return;
  }

  if (record.type === "reasoning") {
    for (const part of responseContentParts(record.summary)) {
      const content = recordField(part, undefined);
      const text = stringField(content?.text);
      if (text) yield { type: "thought-delta", text, redacted: true };
    }
  }
}

function responseContentParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [{ type: "text", text: value }];
  return [];
}

function responseOutputItems(response: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(response?.output) ? response.output : [];
}

function mergeResponseToolCallItem(pending: Map<string, ResponsePendingToolCall>, item: unknown): ResponsePendingToolCall | undefined {
  const record = recordField(item, undefined);
  if (!record || record.type !== "function_call") return undefined;
  const itemId = stringField(record.id);
  const callId = stringField(record.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId ?? `response_call_${pending.size}`;
  const current = pending.get(key) ?? {
    id: itemId ?? callId ?? key,
    callId: callId ?? itemId ?? key,
    name: "",
    argumentsText: ""
  };
  current.callId = callId ?? current.callId;
  current.name = stringField(record.name) ?? current.name;
  if (typeof record.arguments === "string") current.argumentsText = record.arguments;
  pending.set(key, current);
  return current;
}

function mergeResponseToolCallArguments(
  pending: Map<string, ResponsePendingToolCall>,
  payload: JsonObject,
  mode: "append" | "replace"
): ResponsePendingToolCall | undefined {
  const itemId = stringField(payload.item_id);
  const callId = stringField(payload.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId;
  if (!key) return undefined;
  const current = pending.get(key) ?? {
    id: itemId ?? key,
    callId: callId ?? key,
    name: "",
    argumentsText: ""
  };
  const argumentsText = stringField(payload.arguments) ?? stringField(payload.delta);
  if (argumentsText !== undefined) {
    current.argumentsText = mode === "append" ? current.argumentsText + argumentsText : argumentsText;
  }
  pending.set(key, current);
  return current;
}

function findResponseToolCallKey(pending: Map<string, ResponsePendingToolCall>, itemId: string | undefined, callId: string | undefined): string | undefined {
  if (itemId && pending.has(itemId)) return itemId;
  if (callId && pending.has(callId)) return callId;
  if (callId) {
    for (const [key, call] of pending.entries()) {
      if (call.callId === callId) return key;
    }
  }
  return undefined;
}

function emitResponseToolCall(
  call: ResponsePendingToolCall | undefined,
  emitted: Set<string>
): Extract<ProviderStreamEvent, { type: "tool-call" }> | undefined {
  const emittedKey = call?.callId || call?.id;
  if (!call || !call.name || !emittedKey || emitted.has(emittedKey)) return undefined;
  emitted.add(emittedKey);
  return {
    type: "tool-call",
    id: call.callId || call.id,
    toolName: call.name,
    input: parseArguments(call.argumentsText)
  };
}

function isResponsesThoughtDelta(type: string): boolean {
  return (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta"
  );
}

function responseStatusToStop(body: Record<string, unknown> | undefined): "stop" | "tool-call" | "length" | "error" {
  const status = body?.status;
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  return "stop";
}

function responseError(body: Record<string, unknown> | undefined): string | undefined {
  const error = recordField(body?.error, undefined);
  return stringField(error?.message) ?? stringField(body?.error);
}

function providerBodyError(body: Record<string, unknown> | undefined): string | undefined {
  const error = responseError(body);
  return (
    error ??
    stringField(body?.message) ??
    stringField(body?.error_description) ??
    stringField(body?.code)
  );
}

function mergeToolCallDelta(pending: Map<number, PendingToolCall>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const record = raw as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : pending.size;
  const current = pending.get(index) ?? { id: `call_${index}`, name: "", argumentsText: "" };
  if (typeof record.id === "string") current.id = record.id;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  if (typeof fn?.name === "string") current.name = fn.name;
  if (typeof fn?.arguments === "string") current.argumentsText += fn.arguments;
  pending.set(index, current);
}

function parseFullToolCall(raw: unknown): PendingToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
  if (!fn || typeof fn.name !== "string") return null;
  return {
    id: typeof record.id === "string" ? record.id : `call_${fn.name}`,
    name: fn.name,
    argumentsText: typeof fn.arguments === "string" ? fn.arguments : "{}"
  };
}

function parseArguments(input: string): JsonObject {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input) as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: parsed };
  } catch (cause) {
    return {
      __rawArguments: input,
      __parseError: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

function finishReasonToStop(reason: unknown): "stop" | "tool-call" | "length" | "error" {
  if (reason === "tool_calls" || reason === "function_call") return "tool-call";
  if (reason === "length") return "length";
  if (reason === "stop" || reason == null) return "stop";
  return "error";
}

function parseUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const details =
    (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  const completionDetails =
    (usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  return compactObject({
    promptTokens: numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    completionTokens: numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    totalTokens: numberField(usage.total_tokens),
    cacheReadTokens: numberField(details.cached_tokens),
    reasoningTokens: numberField(completionDetails.reasoning_tokens)
  }) as unknown as ProviderUsage;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function actualModelFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return stringField(payload.model) ?? stringField(recordField(payload.response, undefined)?.model);
}

function modelMismatchStreamEvent(
  actualModel: string | undefined,
  diagnostics: SseDiagnosticsOptions | undefined
): Extract<ProviderStreamEvent, { type: "provider-diagnostic" }> | undefined {
  if (!actualModel || !diagnostics?.enabled || !diagnostics.configuredModel || actualModel === diagnostics.configuredModel) return undefined;
  return {
    type: "provider-diagnostic",
    diagnostic: {
      phase: "model-mismatch",
      providerId: diagnostics.providerId,
      endpoint: diagnostics.endpoint,
      url: diagnostics.url,
      attempt: diagnostics.attempt,
      maxAttempts: diagnostics.maxAttempts,
      configuredModel: diagnostics.configuredModel,
      actualModel,
      modelMismatch: true,
      reason: "Provider response model differed from the configured request model; keeping the configured model for session state."
    }
  };
}

function isMimoModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "mimo" || normalized.startsWith("mimo-") || normalized.includes("/mimo-");
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal
): Promise<Response> {
  if (!request.timeoutMs) {
    return fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal
    });
  }

  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(signal.reason);
  if (signal.aborted) {
    abortFromRequest();
  } else {
    signal.addEventListener("abort", abortFromRequest, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(new Error(`Provider request timed out after ${request.timeoutMs}ms`)), request.timeoutMs);
  try {
    return await fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromRequest);
  }
}

async function fetchWithRustReqwestProcess(
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal,
  options: RustReqwestProcessOptions
): Promise<Response> {
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let responseResolved = false;
    let stdoutEnded = false;
    let bodyClosed = false;
    let headerBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stdoutPaused = false;

    const cleanupAbort = (): void => {
      signal.removeEventListener("abort", abortFromRequest);
    };
    const failBeforeResponse = (error: Error): void => {
      cleanupAbort();
      if (!child.killed) child.kill();
      rejectResponse(error);
    };
    const errorBody = (error: Error): void => {
      cleanupAbort();
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.error(error);
      }
    };
    const closeBody = (): void => {
      if (bodyController && !bodyClosed) {
        bodyClosed = true;
        bodyController.close();
      }
    };
    const pauseStdoutForBackpressure = (): void => {
      if (!stdoutPaused) {
        child.stdout.pause();
        stdoutPaused = true;
      }
    };
    const resumeStdout = (): void => {
      if (stdoutPaused && !bodyClosed) {
        child.stdout.resume();
        stdoutPaused = false;
      }
    };
    const enqueueBodyChunk = (chunk: Buffer | Uint8Array): void => {
      if (!bodyController || bodyClosed || chunk.byteLength === 0) return;
      bodyController.enqueue(new Uint8Array(chunk));
      if ((bodyController.desiredSize ?? 1) <= 0) {
        pauseStdoutForBackpressure();
      }
    };
    const abortFromRequest = (): void => {
      const error = new Error("aborted");
      if (responseResolved) {
        errorBody(error);
      } else {
        failBeforeResponse(error);
      }
    };

    if (signal.aborted) {
      abortFromRequest();
      return;
    }
    signal.addEventListener("abort", abortFromRequest, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = Buffer.concat([stderrBuffer, chunk]).subarray(0, 16_000);
    });

    child.on("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (responseResolved) errorBody(error);
      else failBeforeResponse(error);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (!responseResolved) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const separator = headerBuffer.indexOf(0x0a);
        if (separator === -1) return;
        const headerBytes = headerBuffer.subarray(0, separator);
        const rest = headerBuffer.subarray(separator + 1);
        let header: RustReqwestResponseHeader;
        try {
          header = JSON.parse(headerBytes.toString("utf8")) as RustReqwestResponseHeader;
        } catch (cause) {
          failBeforeResponse(new Error(`Rust reqwest transport returned an invalid response header: ${errorMessage(cause)}`));
          return;
        }
        if (header.error) {
          failBeforeResponse(new Error(header.error));
          return;
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            enqueueBodyChunk(rest);
            if (stdoutEnded) closeBody();
          },
          pull() {
            resumeStdout();
          },
          cancel() {
            cleanupAbort();
            bodyClosed = true;
            if (!child.killed) child.kill();
          }
        });
        responseResolved = true;
        resolveResponse(
          new Response(body, {
            status: header.status,
            statusText: header.statusText ?? "",
            headers: new Headers(header.headers ?? [])
          })
        );
        return;
      }

      enqueueBodyChunk(chunk);
    });

    child.stdout.on("end", () => {
      stdoutEnded = true;
      closeBody();
    });

    child.on("close", (code, processSignal) => {
      cleanupAbort();
      if (code === 0) {
        if (responseResolved) closeBody();
        return;
      }

      const detail = rustReqwestExitDetail(stderrBuffer, responseResolved ? Buffer.alloc(0) : headerBuffer);
      const reason = `Rust reqwest transport exited with ${processSignal ?? `code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`;
      const error = new Error(reason);
      if (responseResolved) errorBody(error);
      else rejectResponse(error);
    });

    const payload: RustReqwestRequest = {
      method: request.method,
      url,
      headers: Object.entries(request.headers),
      body: request.body,
      timeoutMs: request.timeoutMs,
      streamBody: true
    };
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

function rustReqwestExitDetail(stderrBuffer: Buffer, stdoutBuffer: Buffer): string {
  const stderr = stderrBuffer.toString("utf8").trim();
  if (stderr) return stderr;
  const stdout = stdoutBuffer.toString("utf8").trim();
  if (!stdout) return "";
  const parsed = parseRustReqwestErrorResponse(stdout);
  return parsed ?? trimRustReqwestExitOutput(stdout);
}

function parseRustReqwestErrorResponse(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const error = (value as { error?: unknown }).error;
    return typeof error === "string" && error.trim() ? error.trim() : undefined;
  } catch {
    return undefined;
  }
}

function trimRustReqwestExitOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

async function fetchWithOptionalRustReqwestOverride(
  url: string,
  request: ProviderHttpRequest,
  signal: AbortSignal,
  options: {
    rustReqwestFetch?: typeof fetch;
    rustReqwestCommand?: string;
    rustReqwestArgs?: string[];
    rustReqwestCwd?: string;
  }
): Promise<Response> {
  if (options.rustReqwestFetch) {
    return fetchWithTimeout(options.rustReqwestFetch, url, request, signal);
  }
  return fetchWithRustReqwestProcess(url, request, signal, {
    command: options.rustReqwestCommand ?? readEnv("AGENT_PROVIDER_HTTP_COMMAND") ?? "cargo",
    args: options.rustReqwestArgs ?? (readEnv("AGENT_PROVIDER_HTTP_COMMAND") ? [] : ["run", "-p", "agent-provider-http", "--quiet"]),
    cwd: options.rustReqwestCwd ?? readEnv("AGENT_PROVIDER_HTTP_CWD") ?? defaultWorkspaceRoot()
  });
}

interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  retryable: boolean;
}

/**
 * 基于错误消息字符串分类 provider 错误。
 * 供 session-loop 等上层使用，避免在多处重复正则判定瞬时错误。
 * 完整分类（带 Response 对象）仍用 classifyHttpProviderError。
 */
export function classifyProviderErrorMessage(message: string): ProviderErrorClassification {
  const m = message.toLowerCase();
  // 用户取消：不可重试（优先判定，避免被网络分类吞掉）
  if (/aborted|cancelled|canceled/.test(m)) return { kind: "cancelled", retryable: false };
  // 认证 / 配额：不可重试
  if (/401|403|unauthor|forbidden/.test(m)) return { kind: "auth", retryable: false };
  if (/402|insufficient[_\s-]*(quota|balance|credit)|余额不足|额度不足/.test(m)) return { kind: "quota", retryable: false };
  // 速率限制：可重试
  if (/429|rate.?limit/.test(m)) return { kind: "rate-limit", retryable: true };
  // 网关 / 服务端错误：可重试
  if (/\b502\b|\b503\b|\b504\b|\b520\b|\b522\b|\b523\b|\b524\b|bad gateway|gateway timeout|server error|overloaded|temporarily unavailable/.test(m)) {
    return { kind: "server", retryable: true };
  }
  // 超时：可重试
  if (/timeout|timed out/.test(m)) return { kind: "timeout", retryable: true };
  // 网络错误：可重试
  if (/econnreset|enotfound|fetch failed|network|socket/.test(m)) {
    return { kind: "network", retryable: true };
  }
  // Schema / 参数：不可重试
  if (/400|422|schema|invalid|bad request/.test(m)) return { kind: "schema", retryable: false };
  return { kind: "unknown", retryable: false };
}

function classifyTransportProviderError(reason: string): ProviderErrorClassification {
  if (/aborted|abort|cancelled|canceled/i.test(reason)) return { kind: "cancelled", retryable: false };
  return { kind: "network", retryable: true };
}

function classifyStreamProviderError(reason: string, cause: unknown): ProviderErrorClassification {
  const code = cause instanceof Error ? cause.name : "";
  if (/aborted|abort|cancelled|canceled/i.test(`${reason} ${code}`)) {
    return { kind: "cancelled", retryable: false };
  }
  if (/timeout|timed out/i.test(`${reason} ${code}`)) {
    return { kind: "timeout", retryable: true };
  }
  if (/invalid|json|parse|terminal response event|event-stream|sse/i.test(reason)) {
    return { kind: "invalid-stream", retryable: false };
  }
  return { kind: "network", retryable: true };
}

function classifyHttpProviderError(response: Response, error: string): ProviderErrorClassification {
  if (looksLikeGatewayChallenge(response, error)) return { kind: "gateway-challenge", retryable: false };
  if (response.status === 429) return { kind: "rate-limit", retryable: true };
  if (response.status === 402 || /insufficient[_\s-]*(quota|balance|credit)|余额不足|额度不足/i.test(error)) {
    return { kind: "quota", retryable: false };
  }
  if (response.status === 401 || response.status === 403) return { kind: "auth", retryable: false };
  if (isResponsesEndpointUnavailable(response.status, error)) return { kind: "endpoint-unavailable", retryable: false };
  if (response.status === 400 || response.status === 422) return { kind: "schema", retryable: false };
  if (isRetryableServerStatus(response.status)) return { kind: "server", retryable: true };
  return { kind: "unknown", retryable: false };
}

function isRetryableServerStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 520 || status === 522 || status === 523 || status === 524;
}

function isResponsesEndpointUnavailable(status: number, error: string): boolean {
  if (status === 404 || status === 405 || status === 415) return true;
  if (status === 400 || status === 422) {
    return /\bresponses?\b/i.test(error) && /\b(unknown|unsupported|invalid|not found|not_found)\b/i.test(error);
  }
  return false;
}

function isSystemRoleUnsupported(status: number, error: string): boolean {
  if (status < 400 || status >= 500) return false;
  return /system\s+messages?\s+are\s+not\s+allowed|system\s+role\s+(is\s+)?(not\s+)?(allowed|supported)|role[^"'`]*system[^"'`]*(not\s+allowed|unsupported|invalid)/i.test(
    error
  );
}

function hasSystemRoleWireContent(request: AgentProviderRequest): boolean {
  return Boolean(request.systemPrompt?.trim()) || request.messages.some((message) => message.role === "system" && textContent(message).trim().length > 0);
}

function requestDiagnosticFields(
  request: AgentProviderRequest,
  wireMode: SystemPromptWireMode,
  streamRequested: boolean
): Pick<
  ProviderDiagnostic,
  | "streamRequested"
  | "systemPromptWireMode"
  | "hasSystemRole"
  | "systemPromptPresent"
  | "systemMessageCount"
  | "rewrittenSystemMessageCount"
  | "messageCount"
  | "toolCount"
  | "messageRoleCounts"
> {
  const roleCounts = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0
  };
  let systemMessageCount = request.systemPrompt?.trim() ? 1 : 0;
  for (const message of request.messages) {
    roleCounts[message.role] += 1;
    if (message.role === "system" && textContent(message).trim().length > 0) {
      systemMessageCount += 1;
    }
  }

  return compactObject({
    streamRequested,
    systemPromptWireMode: wireMode,
    hasSystemRole: systemMessageCount > 0,
    systemPromptPresent: Boolean(request.systemPrompt?.trim()),
    systemMessageCount,
    rewrittenSystemMessageCount: wireMode === "user-prefix" ? systemMessageCount : 0,
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    messageRoleCounts: roleCounts
  }) as Pick<
    ProviderDiagnostic,
    | "streamRequested"
    | "systemPromptWireMode"
    | "hasSystemRole"
    | "systemPromptPresent"
    | "systemMessageCount"
    | "rewrittenSystemMessageCount"
    | "messageCount"
    | "toolCount"
    | "messageRoleCounts"
  >;
}

function looksLikeGatewayChallenge(response: Response, error: string): boolean {
  const mitigated = response.headers.get("cf-mitigated") ?? "";
  const server = response.headers.get("server") ?? "";
  return (
    /challenge/i.test(mitigated) ||
    (/cloudflare/i.test(server) && /challenge|just a moment|cf_chl|challenge-platform|enable javascript/i.test(error)) ||
    /cf_chl|challenge-platform|just a moment|enable javascript and cookies/i.test(error)
  );
}

function formatProviderError(error: string, kind: ProviderErrorKind): string {
  return `[${kind}] ${error}`;
}

function trimDiagnosticReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalEndpoint(value: unknown, label: string): OpenAICompatibleEndpoint | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto") return "auto";
  if (normalized === "chat" || normalized === "chat-completions") return "chat-completions";
  if (normalized === "response" || normalized === "responses") return "responses";
  throw new Error(`${label} must be "auto", "chat-completions", or "responses"`);
}

function optionalTransport(value: unknown, label: string): OpenAICompatibleTransport | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "fetch" || normalized === "rust-reqwest" || normalized === "auto") return normalized;
  throw new Error(`${label} must be "fetch", "rust-reqwest", or "auto"`);
}

function optionalSystemPromptWireMode(value: unknown, label: string): SystemPromptWireMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user-prefix" || normalized === "user" || normalized === "prefix") return "user-prefix";
  throw new Error(`${label} must be "native-system-role" or "user-prefix"`);
}

function optionalAuthHeader(value: unknown, label: string): OpenAICompatibleAuthHeader | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "authorization" || normalized === "api-key" || normalized === "x-api-key" || normalized === "none") {
    return normalized;
  }
  throw new Error(`${label} must be "authorization", "api-key", "x-api-key", or "none"`);
}

function optionalMaxTokensField(value: unknown, label: string): OpenAICompatibleMaxTokensField | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "max_tokens" || normalized === "max_completion_tokens" || normalized === "max_output_tokens") {
    return normalized;
  }
  throw new Error(`${label} must be "max_tokens", "max_completion_tokens", or "max_output_tokens"`);
}

function optionalReasoningContentMode(value: unknown, label: string): OpenAICompatibleReasoningContentMode | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "omit" || normalized === "include" || normalized === "require") return normalized;
  throw new Error(`${label} must be "omit", "include", or "require"`);
}

function optionalReasoningEffort(value: unknown, label: string): OpenAICompatibleReasoningEffort | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase();
  if (
    normalized === "off" ||
    normalized === "auto" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error(`${label} must be "off", "auto", "minimal", "low", "medium", "high", or "xhigh"`);
}

function optionalReasoningEffortFormat(value: unknown, label: string): OpenAICompatibleReasoningEffortFormat | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, label).toLowerCase().replace(/_/g, "-");
  if (normalized === "auto" || normalized === "responses" || normalized === "chat-completions" || normalized === "none") return normalized;
  throw new Error(`${label} must be "auto", "responses", "chat-completions", or "none"`);
}

function optionalToolChoice(value: unknown, label: string): OpenAICompatibleToolChoice | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "auto" || normalized === "none" || normalized === "required") return normalized;
    throw new Error(`${label} must be "auto", "none", "required", or a function choice object`);
  }

  const record = objectRecord(value, label);
  if (record.type !== "function") {
    throw new Error(`${label}.type must be "function"`);
  }
  const functionRecord = record.function === undefined ? undefined : objectRecord(record.function, `${label}.function`);
  const name = optionalString(record.name, `${label}.name`) ?? optionalString(functionRecord?.name, `${label}.function.name`);
  if (!name) throw new Error(`${label} function choice requires a name`);
  return { type: "function", name };
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const number = optionalNumber(value, label);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
      return [key, item];
    })
  );
}

function optionalDiagnostics(value: unknown, label: string): boolean | OpenAICompatibleDiagnosticsOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const record = objectRecord(value, label);
  return compactObject({
    enabled: optionalBoolean(record.enabled, `${label}.enabled`),
    headers: optionalStringArray(record.headers, `${label}.headers`)
  }) as unknown as OpenAICompatibleDiagnosticsOptions;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalRetryOptions(value: unknown, label: string): OpenAICompatibleRetryOptions | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value, label);
  return compactObject({
    maxAttempts: optionalPositiveInteger(record.maxAttempts, `${label}.maxAttempts`),
    initialDelayMs: optionalPositiveInteger(record.initialDelayMs, `${label}.initialDelayMs`),
    maxDelayMs: optionalPositiveInteger(record.maxDelayMs, `${label}.maxDelayMs`),
    totalBudgetMs: optionalPositiveInteger(record.totalBudgetMs, `${label}.totalBudgetMs`),
    jitterRatio: optionalNumber(record.jitterRatio, `${label}.jitterRatio`)
  }) as unknown as OpenAICompatibleRetryOptions;
}

function readEnv(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return processLike.process?.env?.[name];
}

function readEnvFrom(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  return env?.[name] ?? readEnv(name);
}

function readSecretFileSync(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return undefined;
  }
}

function defaultWorkspaceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function recordField(value: unknown, key: string | undefined): Record<string, unknown> | undefined {
  const candidate = key === undefined ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? (candidate as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
