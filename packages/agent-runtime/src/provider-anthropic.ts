/**
 * Native Anthropic Messages API provider (production-ready minimum).
 *
 * Implements `types.AgentProvider` (`id` + `stream(AgentProviderRequest)`).
 * POST `{baseUrl}/v1/messages` with x-api-key + anthropic-version, SSE parse of
 * content_block_delta (text / tool_use) → ProviderStreamEvent.
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
  anthropicAuthHeaders,
  buildAnthropicMessagesBody,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_VERSION,
  resolveAnthropicMessagesUrl,
} from './anthropic-request-build';
import {
  parseAnthropicMessagesJsonResponse,
  parseAnthropicMessagesStreamingResponse,
} from './anthropic-stream-parse';

export interface AnthropicProviderOptions {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  anthropicVersion?: string;
  stream?: boolean;
  requestTimeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class AnthropicProvider implements AgentProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;
  private readonly topP: number | undefined;
  private readonly anthropicVersion: string;
  private readonly streamEnabled: boolean;
  private readonly requestTimeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id ?? 'anthropic';
    this.baseUrl =
      (options.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '') ||
      DEFAULT_BASE_URL;
    this.model = options.model;
    this.apiKey = resolveApiKey(options);
    this.maxTokens =
      options.maxTokens !== undefined &&
      Number.isFinite(options.maxTokens) &&
      options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : DEFAULT_ANTHROPIC_MAX_TOKENS;
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.anthropicVersion =
      options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
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
      throw new Error(
        'A fetch implementation is required for AnthropicProvider'
      );
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    if (request.signal.aborted) {
      throw abortError(request.signal);
    }

    const url = resolveAnthropicMessagesUrl(this.baseUrl);
    const body = buildAnthropicMessagesBody({
      model: this.model,
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      messages: request.messages,
      ...(request.tools.length > 0 ? { tools: request.tools } : {}),
      maxTokens: this.maxTokens,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.topP !== undefined ? { topP: this.topP } : {}),
      stream: this.streamEnabled,
    });

    const headers = anthropicAuthHeaders(
      this.apiKey,
      this.anthropicVersion,
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
      // Never silent: surface HTTP status + body text.
      throw new Error(
        formatHttpError(response.status, response.statusText, detail)
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (this.streamEnabled && contentType.includes('text/event-stream')) {
      yield* parseAnthropicMessagesStreamingResponse(
        response,
        undefined,
        request.signal
      );
      return;
    }

    // Non-streaming JSON (or stream requested but server returned JSON).
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new Error(
        `Anthropic response JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('Anthropic response body is not a JSON object');
    }
    yield* parseAnthropicMessagesJsonResponse(
      json as import('@crish/shared-types').JsonObject
    );
  }
}

/**
 * Build AnthropicProvider from a gateway ProviderFactoryPlan (daemon wiring).
 */
export function createAnthropicProviderFromPlan(
  plan: ProviderFactoryPlan,
  overrides: Partial<AnthropicProviderOptions> = {}
): AnthropicProvider {
  const providerOptions =
    plan.providerOptions && typeof plan.providerOptions === 'object'
      ? plan.providerOptions
      : {};
  const maxTokens =
    typeof providerOptions.maxTokens === 'number'
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

  return new AnthropicProvider({
    id: plan.route.providerId || 'anthropic',
    baseUrl: plan.credential.baseUrl ?? overrides.baseUrl ?? DEFAULT_BASE_URL,
    model: plan.route.upstreamModel || plan.route.model,
    ...(plan.credential.apiKey ?? overrides.apiKey !== undefined ? { apiKey: plan.credential.apiKey ?? overrides.apiKey } : {}),
    ...((maxTokens ?? overrides.maxTokens) !== undefined ? { maxTokens: maxTokens ?? overrides.maxTokens } : {}),
    ...((temperature ?? overrides.temperature) !== undefined ? { temperature: temperature ?? overrides.temperature } : {}),
    ...((topP ?? overrides.topP) !== undefined ? { topP: topP ?? overrides.topP } : {}),
    ...((stream ?? overrides.stream) !== undefined ? { stream: stream ?? overrides.stream } : {}),
    ...((requestTimeoutMs ?? overrides.requestTimeoutMs) !== undefined ? { requestTimeoutMs: requestTimeoutMs ?? overrides.requestTimeoutMs } : {}),
    headers: {
      ...headers,
      ...plan.credential.headers,
      ...overrides.headers,
    },
    ...(overrides.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides.anthropicVersion !== undefined ? { anthropicVersion: overrides.anthropicVersion } : {}),
  });
}

/**
 * Heuristic: should this route/plan use the native Anthropic Messages adapter?
 * - providerId contains "anthropic"
 * - metadata.family === "anthropic"
 * - baseUrl hosts api.anthropic.com
 */
export function shouldUseAnthropicProvider(input: {
  providerId?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown> | null;
  providerOptions?: Record<string, unknown> | null;
}): boolean {
  const family =
    stringField(input.metadata?.family) ??
    stringField(input.providerOptions?.family) ??
    stringField(input.metadata?.providerFamily);
  if (family === 'anthropic') return true;
  if (family && family !== 'anthropic') return false;

  const providerId = (input.providerId ?? '').toLowerCase();
  if (providerId.includes('anthropic') || providerId.includes('claude'))
    return true;

  const baseUrl = (input.baseUrl ?? '').toLowerCase();
  if (baseUrl.includes('api.anthropic.com')) return true;

  return false;
}

function resolveApiKey(options: AnthropicProviderOptions): string | undefined {
  if (options.apiKey?.trim()) return options.apiKey.trim();
  if (options.apiKeyEnv) {
    const fromEnv = process.env[options.apiKeyEnv];
    if (fromEnv?.trim()) return fromEnv.trim();
  }
  const defaultEnv = process.env.ANTHROPIC_API_KEY;
  if (defaultEnv?.trim()) return defaultEnv.trim();
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
  if (!body) return `Anthropic API error: ${head}`;
  // Prefer short structured error if present
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string };
      message?: string;
    };
    const msg = parsed.error?.message ?? parsed.message;
    const type = parsed.error?.type;
    if (msg && type) return `Anthropic API error: ${head}: ${type}: ${msg}`;
    if (msg) return `Anthropic API error: ${head}: ${msg}`;
  } catch {
    // fall through
  }
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  return `Anthropic API error: ${head}: ${clipped}`;
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
      new Error(`Anthropic request timed out after ${timeoutMs}ms`)
    );
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
