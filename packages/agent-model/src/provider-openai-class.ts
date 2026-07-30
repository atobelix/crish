import { deepEqual, errorMessage } from '@crish/shared-utils';
import {
  ProviderError,
  type JsonObject,
  type ProviderDiagnostic,
  type ProviderErrorKind,
} from '@crish/shared-types';
import {
  createProviderCacheHintPlan,
  type OpenAICompatibleCacheHints,
  type ProviderCacheHintPlan,
} from './provider-cache-hints';
import type { ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from './provider/types';
import {
  compactObject,
  type SystemPromptWireMode,
  type ResolvedOpenAICompatibleEndpoint,
} from './openai-request-build';
import {
  delay,
  normalizeRetryOptions,
  parseRetryAfterMs,
  retryDelayMs,
  withinRetryBudget,
} from './openai-retry';
import type { SseDiagnosticsOptions } from './openai-stream-parse';
import {
  OpenAICompatibleProviderOptions,
  RequestBuildContext,
  fetchWithTimeout,
  fetchWithRustReqwestProcess,
  defaultKeepAliveFetch,
  formatProviderError,
  readEnv,
  resolveApiKey,
  freezeHeaders,
  defaultWorkspaceRoot,
} from './provider-openai-base';
import {
  buildChatCompletionsRequestBody,
  parseChatCompletionsJsonResponse,
  parseChatCompletionsStreamingResponse,
} from './provider-openai-chat';
import {
  buildResponsesRequestBody,
  parseResponsesJsonResponse,
  parseResponsesStreamingResponse,
} from './provider-openai-responses';
import { normalizeBaseUrl } from './provider-openai-config';
import {
  DEFAULT_DIAGNOSTIC_HEADERS,
  actualModelFromPayload,
  classifyHttpProviderError,
  classifyStreamProviderError,
  classifyTransportProviderError,
  hasSystemRoleWireContent,
  isResponsesEndpointUnavailable,
  isSystemRoleUnsupported,
  providerBodyError,
  readError,
  requestDiagnosticFields,
  trimDiagnosticReason,
} from './provider-openai-helpers';

interface HttpRequest {
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FetchResult {
  response: Response;
  diagnostics?: Array<{
    phase: 'transport-fallback';
    status?: number;
    statusText?: string;
    retryable?: boolean;
    errorKind?: ProviderErrorKind;
    reason: string;
  }>;
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolvedApiKey: string | undefined;
  private readonly resolvedHeaders: Record<string, string>;
  private readonly wireModeCache = new Map<
    ResolvedOpenAICompatibleEndpoint,
    SystemPromptWireMode
  >();

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? 'openai-compatible';
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? defaultKeepAliveFetch();
    if (!this.fetchImpl && (options.transport ?? 'fetch') === 'fetch') {
      throw new ProviderError(
        'A fetch implementation is required for OpenAICompatibleProvider',
        'CONFIG_ERROR',
        false
      );
    }
    this.resolvedApiKey = resolveApiKey(this.options);
    this.resolvedHeaders = freezeHeaders(this.options, this.resolvedApiKey);
  }

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    const retry = normalizeRetryOptions(this.options.retry);
    const startedAt = Date.now();
    const endpoints = this.resolvedEndpoints();
    const diagEnabled = this.diagnosticsEnabled();
    const cacheHintPlan = this.buildCacheHintPlan(request);
    let lastBodyObject: JsonObject | undefined;
    let lastBodyString: string | undefined;

    for (
      let endpointIndex = 0;
      endpointIndex < endpoints.length;
      endpointIndex++
    ) {
      const endpoint = endpoints[endpointIndex]!;
      const rawPath = this.requestPath(endpoint);
      const path =
        this.baseUrl.endsWith('/v1') && rawPath.startsWith('/v1/')
          ? rawPath.slice(3)
          : rawPath;
      const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      attemptLoop: for (
        let attempt = 1;
        attempt <= retry.maxAttempts;
        attempt++
      ) {
        let wireMode =
          this.wireModeCache.get(endpoint) ??
          this.defaultSystemPromptWireMode();
        let retriedSystemPromptCompatibility = false;
        while (true) {
          const attemptStartedAt = Date.now();
          yield* this.diagnostic({
            phase: 'request-start',
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: attemptStartedAt - startedAt,
            configuredModel: this.options.model,
            ...(wireMode === 'user-prefix'
              ? { reason: 'system-prompt-user-prefix' }
              : {}),
            ...(diagEnabled
              ? requestDiagnosticFields(
                  request,
                  wireMode,
                  this.options.stream !== false
                )
              : {}),
          });

          const bodyObject = this.buildRequestBody({
            request,
            endpoint,
            wireMode,
            ...(cacheHintPlan !== undefined ? { cacheHintPlan } : {}),
            attempt,
          });
          let bodyString: string;
          if (lastBodyObject && deepEqual(lastBodyObject, bodyObject))
            bodyString = lastBodyString!;
          else {
            bodyString = JSON.stringify(bodyObject);
            lastBodyObject = bodyObject;
            lastBodyString = bodyString;
          }

          let fetchResult: FetchResult;
          let response: Response;
          try {
            fetchResult = await this.fetchOnce(request, url, bodyString);
            for (const diagnostic of fetchResult.diagnostics ?? []) {
              yield* this.diagnostic({
                ...diagnostic,
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
              });
            }
            response = fetchResult.response;
          } catch (cause) {
            const reason = errorMessage(cause);
            const error = classifyTransportProviderError(reason);
            const retryable =
              attempt < retry.maxAttempts &&
              error.retryable &&
              withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: 'request-error',
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable,
              errorKind: error.kind,
              reason,
            });
            if (!retryable) throw cause;
            yield* this.retryDiagnostic(
              endpoint,
              url,
              attempt,
              retry.maxAttempts,
              reason,
              undefined,
              undefined,
              error.kind
            );
            await delay(retryDelayMs(retry, attempt), request.signal);
            break;
          }

          const respHeaders = this.diagnosticHeaders(response);
          yield* this.diagnostic({
            phase: 'response-start',
            endpoint,
            url,
            attempt,
            maxAttempts: retry.maxAttempts,
            elapsedMs: Date.now() - attemptStartedAt,
            status: response.status,
            statusText: response.statusText,
            ...(respHeaders !== undefined ? { headers: respHeaders } : {}),
          });

          if (!response.ok) {
            const error = await readError(response);
            const providerError = classifyHttpProviderError(response, error);
            const retryAfterMs = parseRetryAfterMs(
              response.headers.get('retry-after')
            );
            if (
              this.shouldRetryWithSystemPromptUserPrefix(
                request,
                wireMode,
                retriedSystemPromptCompatibility,
                response.status,
                error
              )
            ) {
              wireMode = 'user-prefix';
              retriedSystemPromptCompatibility = true;
              this.wireModeCache.set(endpoint, wireMode);
              yield* this.diagnostic({
                phase: 'request-error',
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason:
                  'Provider rejected system-role messages; retrying this endpoint with the system prompt as a stable user-prefix instruction.',
              });
              continue;
            }
            if (
              this.shouldFallbackEndpoint(
                endpoint,
                endpointIndex,
                endpoints,
                providerError.kind,
                response.status,
                error
              )
            ) {
              yield* this.diagnostic({
                phase: 'endpoint-fallback',
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                status: response.status,
                statusText: response.statusText,
                retryable: true,
                errorKind: providerError.kind,
                reason: trimDiagnosticReason(error),
              });
              break attemptLoop;
            }
            const retryable =
              attempt < retry.maxAttempts &&
              providerError.retryable &&
              withinRetryBudget(startedAt, retry.totalBudgetMs);
            yield* this.diagnostic({
              phase: 'request-error',
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable,
              errorKind: providerError.kind,
              reason: trimDiagnosticReason(error),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
            if (!retryable)
              throw new ProviderError(
                formatProviderError(error, providerError.kind),
                providerError.kind,
                false
              );
            yield* this.retryDiagnostic(
              endpoint,
              url,
              attempt,
              retry.maxAttempts,
              error,
              response.status,
              response.statusText,
              providerError.kind,
              retryAfterMs
            );
            await delay(
              retryAfterMs ?? retryDelayMs(retry, attempt),
              request.signal
            );
            break;
          }

          const contentType = response.headers.get('content-type') ?? '';
          const streamRequested = this.options.stream !== false;
          if (streamRequested && contentType.includes('text/event-stream')) {
            let emittedModelEvent = false;
            let retrySystemPromptCompatibilityAfterStreamError = false;
            try {
              const stream =
                endpoint === 'responses'
                  ? parseResponsesStreamingResponse(
                      response,
                      this.sseDiagnostics(
                        endpoint,
                        url,
                        attempt,
                        retry.maxAttempts
                      ),
                      request.signal
                    )
                  : parseChatCompletionsStreamingResponse(
                      response,
                      this.sseDiagnostics(
                        endpoint,
                        url,
                        attempt,
                        retry.maxAttempts
                      ),
                      request.signal
                    );
              for await (const event of stream) {
                if (
                  event.type === 'stop' &&
                  event.reason === 'error' &&
                  !emittedModelEvent &&
                  this.shouldRetryWithSystemPromptUserPrefix(
                    request,
                    wireMode,
                    retriedSystemPromptCompatibility,
                    response.status >= 400 ? response.status : 400,
                    event.error ?? ''
                  )
                ) {
                  wireMode = 'user-prefix';
                  retriedSystemPromptCompatibility = true;
                  retrySystemPromptCompatibilityAfterStreamError = true;
                  this.wireModeCache.set(endpoint, wireMode);
                  yield* this.diagnostic({
                    phase: 'request-error',
                    endpoint,
                    url,
                    attempt,
                    maxAttempts: retry.maxAttempts,
                    elapsedMs: Date.now() - attemptStartedAt,
                    status: response.status,
                    statusText: response.statusText,
                    retryable: true,
                    errorKind: 'schema',
                    reason:
                      'Provider emitted a streaming system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.',
                    ...(diagEnabled
                      ? requestDiagnosticFields(
                          request,
                          'native-system-role',
                          streamRequested
                        )
                      : {}),
                  });
                  break;
                }
                if (event.type !== 'provider-diagnostic')
                  emittedModelEvent = true;
                yield event;
              }
              if (retrySystemPromptCompatibilityAfterStreamError) continue;
              return;
            } catch (cause) {
              const reason = errorMessage(cause);
              const error2 = classifyStreamProviderError(reason, cause);
              const retryable =
                !request.signal.aborted &&
                !emittedModelEvent &&
                error2.retryable &&
                attempt < retry.maxAttempts &&
                withinRetryBudget(startedAt, retry.totalBudgetMs);
              yield* this.diagnostic({
                phase: 'request-error',
                endpoint,
                url,
                attempt,
                maxAttempts: retry.maxAttempts,
                elapsedMs: Date.now() - attemptStartedAt,
                retryable,
                errorKind: error2.kind,
                reason,
              });
              if (emittedModelEvent) {
                yield {
                  type: 'stop',
                  reason: 'error',
                  error: formatProviderError(reason, error2.kind),
                };
                return;
              }
              if (!retryable) throw cause;
              yield* this.retryDiagnostic(
                endpoint,
                url,
                attempt,
                retry.maxAttempts,
                reason,
                undefined,
                undefined,
                error2.kind
              );
              await delay(retryDelayMs(retry, attempt), request.signal);
              break;
            }
          }

          if (streamRequested) {
            yield* this.diagnostic({
              phase: 'transport-fallback',
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              retryable: false,
              errorKind: 'invalid-stream',
              reason: `Provider returned ${contentType || 'unknown content type'} for a streaming request; parsing the response as non-streaming JSON.`,
            });
          }

          const body = (await response.json()) as JsonObject;
          const bodyError2 = providerBodyError(body);
          if (
            this.shouldRetryWithSystemPromptUserPrefix(
              request,
              wireMode,
              retriedSystemPromptCompatibility,
              response.status >= 400 ? response.status : 400,
              bodyError2 ?? ''
            )
          ) {
            wireMode = 'user-prefix';
            retriedSystemPromptCompatibility = true;
            this.wireModeCache.set(endpoint, wireMode);
            yield* this.diagnostic({
              phase: 'request-error',
              endpoint,
              url,
              attempt,
              maxAttempts: retry.maxAttempts,
              elapsedMs: Date.now() - attemptStartedAt,
              status: response.status,
              statusText: response.statusText,
              retryable: true,
              errorKind: 'schema',
              reason:
                'Provider returned a JSON system-role rejection; retrying this endpoint with the system prompt as a stable user-prefix instruction.',
              ...(diagEnabled
                ? requestDiagnosticFields(
                    request,
                    'native-system-role',
                    streamRequested
                  )
                : {}),
            });
            continue;
          }
          yield* this.modelMismatchDiagnostic(
            endpoint,
            url,
            attempt,
            retry.maxAttempts,
            body
          );
          yield* endpoint === 'responses'
            ? parseResponsesJsonResponse(body)
            : parseChatCompletionsJsonResponse(body);
          return;
        }
      }
    }
  }

  private endpoint(): 'auto' | 'chat-completions' | 'responses' {
    return this.options.endpoint ?? 'auto';
  }

  private resolvedEndpoints(): ResolvedOpenAICompatibleEndpoint[] {
    const endpoint = this.endpoint();
    if (endpoint === 'auto') return ['responses', 'chat-completions'];
    return [endpoint];
  }

  private buildRequestBody(context: RequestBuildContext): JsonObject {
    const body =
      context.endpoint === 'responses'
        ? buildResponsesRequestBody(this.options, context)
        : buildChatCompletionsRequestBody(this.options, context);
    return this.withCacheHint(body, context.cacheHintPlan);
  }

  private withCacheHint(
    body: JsonObject,
    plan: ProviderCacheHintPlan | undefined
  ): JsonObject {
    if (!plan) return body;
    const hints = plan.providerHints as
      OpenAICompatibleCacheHints | { kind: string };
    if (hints.kind !== 'openai-compatible') return body;
    const affinityKey = (hints as OpenAICompatibleCacheHints)
      .stablePromptCacheAffinityKey;
    if (!affinityKey) return body;
    return { ...body, prompt_cache_key: affinityKey };
  }

  private buildCacheHintPlan(
    request: AgentProviderRequest
  ): ProviderCacheHintPlan | undefined {
    if (!request.promptAssembly) return undefined;
    try {
      return createProviderCacheHintPlan(request.promptAssembly);
    } catch {
      return undefined;
    }
  }

  private requestPath(endpoint: ResolvedOpenAICompatibleEndpoint): string {
    if (endpoint === 'responses') {
      return this.options.paths?.responses ?? '/responses';
    }
    return this.options.paths?.chatCompletions ?? '/chat/completions';
  }

  private async fetchOnce(
    request: AgentProviderRequest,
    url: string,
    bodyString: string
  ): Promise<FetchResult> {
    const httpRequest: HttpRequest = {
      method: 'POST',
      headers: this.resolvedHeaders,
      body: bodyString,
      ...(this.options.requestTimeoutMs !== undefined
        ? { timeoutMs: this.options.requestTimeoutMs }
        : {}),
    };
    const transport = this.options.transport ?? 'fetch';
    if (transport === 'rust-reqwest')
      return {
        response: await this.fetchWithRustReqwest(
          url,
          httpRequest,
          request.signal
        ),
      };
    try {
      const fetchImpl = this.fetchImpl ?? defaultKeepAliveFetch();
      if (!fetchImpl)
        return {
          response: await this.fetchWithRustReqwest(
            url,
            httpRequest,
            request.signal
          ),
          diagnostics: [
            {
              phase: 'transport-fallback',
              retryable: true,
              errorKind: 'network',
              reason:
                'Fetch transport is unavailable; using Rust reqwest transport.',
            },
          ],
        };
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        httpRequest,
        request.signal
      );
      if (transport !== 'auto' || response.ok) return { response };
      const error = await readError(response.clone());
      const providerError = classifyHttpProviderError(response, error);
      if (providerError.kind !== 'gateway-challenge') return { response };
      return {
        response: await this.fetchWithRustReqwest(
          url,
          httpRequest,
          request.signal
        ),
        diagnostics: [
          {
            phase: 'transport-fallback',
            status: response.status,
            statusText: response.statusText,
            retryable: true,
            errorKind: providerError.kind,
            reason: trimDiagnosticReason(error),
          },
        ],
      };
    } catch (cause) {
      if (transport !== 'auto' || request.signal.aborted) throw cause;
      const reason = errorMessage(cause);
      const response = await this.fetchWithRustReqwest(
        url,
        httpRequest,
        request.signal
      ).catch((fallbackCause) => {
        throw new ProviderError(
          `Fetch transport failed: ${reason}; Rust reqwest fallback failed: ${errorMessage(fallbackCause)}`,
          'NETWORK_ERROR',
          true
        );
      });
      return {
        response,
        diagnostics: [
          {
            phase: 'transport-fallback',
            retryable: true,
            errorKind: 'network',
            reason: trimDiagnosticReason(reason),
          },
        ],
      };
    }
  }

  private async fetchWithRustReqwest(
    url: string,
    request: HttpRequest,
    signal: AbortSignal
  ): Promise<Response> {
    if (this.options.rustReqwestFetch)
      return fetchWithTimeout(
        this.options.rustReqwestFetch,
        url,
        request,
        signal
      );
    const cwd = this.rustReqwestCwd();
    return fetchWithRustReqwestProcess(url, request, signal, {
      command: this.rustReqwestCommand(),
      args: this.rustReqwestArgs(),
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }

  private rustReqwestCommand(): string {
    return (
      this.options.rustReqwestCommand ??
      readEnv('AGENT_PROVIDER_HTTP_COMMAND') ??
      'cargo'
    );
  }

  private rustReqwestArgs(): string[] {
    if (this.options.rustReqwestArgs) return this.options.rustReqwestArgs;
    if (readEnv('AGENT_PROVIDER_HTTP_COMMAND')) return ['--stdio'];
    return ['run', '-p', 'agent-provider-http', '--quiet', '--', '--stdio'];
  }

  private rustReqwestCwd(): string | undefined {
    return (
      this.options.rustReqwestCwd ??
      readEnv('AGENT_PROVIDER_HTTP_CWD') ??
      defaultWorkspaceRoot()
    );
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
      phase: 'retry',
      endpoint,
      url,
      attempt,
      maxAttempts,
      retryable: true,
      reason,
      ...(status !== undefined ? { status } : {}),
      ...(statusText !== undefined ? { statusText } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private sseDiagnostics(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    url: string,
    attempt: number,
    maxAttempts: number
  ): SseDiagnosticsOptions | undefined {
    if (
      !this.diagnosticsEnabled() &&
      !this.options.firstByteTimeoutMs &&
      !this.options.streamIdleTimeoutMs
    )
      return undefined;
    return {
      enabled: this.diagnosticsEnabled(),
      providerId: this.id,
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      ...(this.options.firstByteTimeoutMs !== undefined
        ? { firstByteTimeoutMs: this.options.firstByteTimeoutMs }
        : {}),
      ...(this.options.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: this.options.streamIdleTimeoutMs }
        : {}),
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
      phase: 'model-mismatch',
      endpoint,
      url,
      attempt,
      maxAttempts,
      configuredModel: this.options.model,
      actualModel,
      modelMismatch: true,
      reason:
        'Provider response model differed from the configured request model; keeping the configured model for session state.',
    });
  }

  private *diagnostic(
    input: Omit<ProviderDiagnostic, 'providerId'>
  ): Iterable<ProviderStreamEvent> {
    if (!this.diagnosticsEnabled()) return;
    yield {
      type: 'provider-diagnostic',
      diagnostic: compactObject({
        providerId: this.id,
        ...input,
      }) as unknown as ProviderDiagnostic,
    };
  }

  private diagnosticsEnabled(): boolean {
    if (this.options.diagnostics === true) return true;
    if (
      this.options.diagnostics &&
      typeof this.options.diagnostics === 'object'
    )
      return this.options.diagnostics.enabled !== false;
    return false;
  }

  private diagnosticHeaders(
    response: Response
  ): Record<string, string> | undefined {
    if (!this.diagnosticsEnabled()) return undefined;
    const configured =
      typeof this.options.diagnostics === 'object'
        ? this.options.diagnostics.headers
        : undefined;
    const names = configured?.length ? configured : DEFAULT_DIAGNOSTIC_HEADERS;
    const headers: Record<string, string> = {};
    for (const name of names) {
      const value = response.headers.get(name);
      if (value) headers[name.toLowerCase()] = value.slice(0, 160);
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private shouldFallbackEndpoint(
    endpoint: ResolvedOpenAICompatibleEndpoint,
    endpointIndex: number,
    endpoints: ResolvedOpenAICompatibleEndpoint[],
    errorKind: ProviderErrorKind,
    status: number,
    error: string
  ): boolean {
    if (this.endpoint() !== 'auto') return false;
    if (endpoint !== 'responses') return false;
    if (endpointIndex >= endpoints.length - 1) return false;
    if (errorKind !== 'endpoint-unavailable') return false;
    return isResponsesEndpointUnavailable(status, error);
  }

  private shouldRetryWithSystemPromptUserPrefix(
    request: AgentProviderRequest,
    wireMode: SystemPromptWireMode,
    alreadyRetried: boolean,
    status: number,
    error: string
  ): boolean {
    if (alreadyRetried || wireMode !== 'native-system-role') return false;
    if (!hasSystemRoleWireContent(request)) return false;
    return isSystemRoleUnsupported(status, error);
  }

  private defaultSystemPromptWireMode(): SystemPromptWireMode {
    return this.options.systemPromptWireMode ?? 'native-system-role';
  }
}
