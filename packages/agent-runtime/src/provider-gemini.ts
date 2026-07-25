/**
 * Native Gemini generateContent stream provider (production-ready minimum).
 *
 * Implements `types.AgentProvider` (`id` + `stream(AgentProviderRequest)`).
 * POST `{baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse`
 * with `x-goog-api-key` (or `?key=`), SSE parse of candidates parts
 * (text / functionCall) → ProviderStreamEvent.
 *
 * Never yields a silent empty complete: HTTP non-2xx throws with status text;
 * empty stream without events yields stop/error.
 */

import { errorMessage } from '@crish/shared-utils';
import type {
  AgentProvider,
  AgentProviderRequest,
  ProviderStreamEvent,
} from './types';
import type { ProviderFactoryPlan } from './provider-gateway';
import {
  appendGeminiApiKeyQuery,
  buildGeminiGenerateContentBody,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MAX_OUTPUT_TOKENS,
  geminiAuthHeaders,
  resolveGeminiGenerateContentUrl,
} from './gemini-request-build';
import {
  parseGeminiJsonResponse,
  parseGeminiStreamingResponse,
} from './gemini-stream-parse';

export interface GeminiProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  /** Prefer header (x-goog-api-key); also allow query ?key= when true. */
  authViaQuery?: boolean;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  requestTimeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class GeminiProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly authViaQuery: boolean;
  private readonly maxOutputTokens: number;
  private readonly temperature: number | undefined;
  private readonly topP: number | undefined;
  private readonly streamEnabled: boolean;
  private readonly requestTimeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.id = options.id ?? 'gemini';
    this.baseUrl =
      (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).trim().replace(/\/+$/, '') ||
      DEFAULT_GEMINI_BASE_URL;
    this.model = options.model;
    this.apiKey = resolveApiKey(options);
    this.authViaQuery = options.authViaQuery === true;
    this.maxOutputTokens =
      options.maxOutputTokens !== undefined &&
      Number.isFinite(options.maxOutputTokens) &&
      options.maxOutputTokens > 0
        ? Math.floor(options.maxOutputTokens)
        : DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.streamEnabled = options.stream !== false;
    this.requestTimeoutMs =
      options.requestTimeoutMs !== undefined &&
      Number.isFinite(options.requestTimeoutMs) &&
      options.requestTimeoutMs > 0
        ? Math.floor(options.requestTimeoutMs)
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.extraHeaders = { ...(options.headers ?? {}) };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required for GeminiProvider');
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    if (request.signal.aborted) {
      throw abortError(request.signal);
    }

    let url = resolveGeminiGenerateContentUrl(this.baseUrl, this.model, {
      stream: this.streamEnabled,
    });
    if (this.authViaQuery) {
      url = appendGeminiApiKeyQuery(url, this.apiKey);
    }

    const body = buildGeminiGenerateContentBody({
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      messages: request.messages,
      ...(request.tools.length > 0 ? { tools: request.tools } : {}),
      maxOutputTokens: this.maxOutputTokens,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.topP !== undefined ? { topP: this.topP } : {}),
    });

    const headers = geminiAuthHeaders(
      this.authViaQuery ? undefined : this.apiKey,
      this.extraHeaders
    );

    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        request.signal,
        this.requestTimeoutMs
      );
    } catch (cause) {
      if (request.signal.aborted) throw abortError(request.signal);
      throw cause instanceof Error ? cause : new Error(errorMessage(cause));
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(
        formatHttpError(response.status, response.statusText, detail)
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (this.streamEnabled && contentType.includes('text/event-stream')) {
      yield* parseGeminiStreamingResponse(response, undefined, request.signal);
      return;
    }

    // Non-streaming JSON (or stream requested but server returned JSON / NDJSON-ish object).
    // Some Gemini proxies return application/json even for streamGenerateContent without alt=sse.
    if (
      contentType.includes('text/event-stream') ||
      looksLikeSseBody(response)
    ) {
      yield* parseGeminiStreamingResponse(response, undefined, request.signal);
      return;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new Error(
        `Gemini response JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('Gemini response body is not a JSON object');
    }
    yield* parseGeminiJsonResponse(
      json as import('@crish/shared-types').JsonObject
    );
  }
}

/**
 * Build GeminiProvider from a gateway ProviderFactoryPlan (daemon wiring).
 */
export function createGeminiProviderFromPlan(
  plan: ProviderFactoryPlan,
  overrides: Partial<GeminiProviderOptions> = {}
): GeminiProvider {
  const providerOptions =
    plan.providerOptions && typeof plan.providerOptions === 'object'
      ? plan.providerOptions
      : {};
  const maxOutputTokens =
    typeof providerOptions.maxOutputTokens === 'number'
      ? providerOptions.maxOutputTokens
      : typeof providerOptions.max_output_tokens === 'number'
        ? providerOptions.max_output_tokens
        : typeof providerOptions.maxTokens === 'number'
          ? providerOptions.maxTokens
          : typeof providerOptions.max_tokens === 'number'
            ? providerOptions.max_tokens
            : undefined;
  const temperature =
    typeof providerOptions.temperature === 'number'
      ? providerOptions.temperature
      : undefined;
  const topP =
    typeof providerOptions.topP === 'number' ? providerOptions.topP : undefined;
  const stream =
    typeof providerOptions.stream === 'boolean'
      ? providerOptions.stream
      : undefined;
  const requestTimeoutMs =
    typeof providerOptions.requestTimeoutMs === 'number'
      ? providerOptions.requestTimeoutMs
      : undefined;
  const authViaQuery =
    typeof providerOptions.authViaQuery === 'boolean'
      ? providerOptions.authViaQuery
      : undefined;
  const headers =
    providerOptions.headers &&
    typeof providerOptions.headers === 'object' &&
    !Array.isArray(providerOptions.headers)
      ? Object.fromEntries(
          Object.entries(
            providerOptions.headers as Record<string, unknown>
          ).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : undefined;

  return new GeminiProvider({
    id: plan.route.providerId || 'gemini',
    baseUrl:
      plan.credential.baseUrl ?? overrides.baseUrl ?? DEFAULT_GEMINI_BASE_URL,
    model: plan.route.upstreamModel || plan.route.model,
    ...(plan.credential.apiKey ?? overrides.apiKey !== undefined ? { apiKey: plan.credential.apiKey ?? overrides.apiKey } : {}),
    ...((maxOutputTokens ?? overrides.maxOutputTokens) !== undefined ? { maxOutputTokens: maxOutputTokens ?? overrides.maxOutputTokens } : {}),
    ...((temperature ?? overrides.temperature) !== undefined ? { temperature: temperature ?? overrides.temperature } : {}),
    ...((topP ?? overrides.topP) !== undefined ? { topP: topP ?? overrides.topP } : {}),
    ...((stream ?? overrides.stream) !== undefined ? { stream: stream ?? overrides.stream } : {}),
    ...((requestTimeoutMs ?? overrides.requestTimeoutMs) !== undefined ? { requestTimeoutMs: requestTimeoutMs ?? overrides.requestTimeoutMs } : {}),
    ...((authViaQuery ?? overrides.authViaQuery) !== undefined ? { authViaQuery: authViaQuery ?? overrides.authViaQuery } : {}),
    headers: {
      ...headers,
      ...plan.credential.headers,
      ...overrides.headers,
    },
    ...(overrides.fetch !== undefined ? { fetch: overrides.fetch } : {}),
  });
}

/**
 * Heuristic: should this route/plan use the native Gemini generateContent adapter?
 * - providerId contains "gemini" or "google"
 * - metadata.family === "gemini"
 * - baseUrl hosts generativelanguage.googleapis.com
 */
export function shouldUseGeminiProvider(input: {
  providerId?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown> | null;
  providerOptions?: Record<string, unknown> | null;
}): boolean {
  const family =
    stringField(input.metadata?.family) ??
    stringField(input.providerOptions?.family) ??
    stringField(input.metadata?.providerFamily);
  if (family === 'gemini') return true;
  if (family && family !== 'gemini') return false;

  const providerId = (input.providerId ?? '').toLowerCase();
  if (
    providerId.includes('gemini') ||
    providerId === 'google' ||
    providerId.startsWith('google-') ||
    providerId.includes('google-ai')
  ) {
    return true;
  }

  const baseUrl = (input.baseUrl ?? '').toLowerCase();
  if (baseUrl.includes('generativelanguage.googleapis.com')) return true;

  return false;
}

function resolveApiKey(options: GeminiProviderOptions): string | undefined {
  if (options.apiKey?.trim()) return options.apiKey.trim();
  if (options.apiKeyEnv) {
    const fromEnv = process.env[options.apiKeyEnv];
    if (fromEnv?.trim()) return fromEnv.trim();
  }
  const google = process.env.GOOGLE_API_KEY;
  if (google?.trim()) return google.trim();
  const gemini = process.env.GEMINI_API_KEY;
  if (gemini?.trim()) return gemini.trim();
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
  return new Error('aborted');
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim();
  } catch {
    return '';
  }
}

function formatHttpError(
  status: number,
  statusText: string,
  body: string
): string {
  const head = `${status}${statusText ? ` ${statusText}` : ''}`.trim();
  if (!body) return `Gemini API error: ${head}`;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; status?: string; code?: number };
      message?: string;
    };
    const msg = parsed.error?.message ?? parsed.message;
    const statusName = parsed.error?.status;
    if (msg && statusName)
      return `Gemini API error: ${head}: ${statusName}: ${msg}`;
    if (msg) return `Gemini API error: ${head}: ${msg}`;
  } catch {
    // fall through
  }
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  return `Gemini API error: ${head}: ${clipped}`;
}

function looksLikeSseBody(_response: Response): boolean {
  void _response;
  // Content-type already checked by caller; keep hook for future heuristics.
  return false;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetchImpl(url, { ...init, signal });
  }

  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Gemini request timed out after ${timeoutMs}ms`)
    );
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
