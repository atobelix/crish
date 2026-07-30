import type { ProviderStreamEvent } from '@crish/shared-types';
import type {
  AgentProviderRequest,
  Engine,
  EngineOptions,
  EngineRequest,
} from '../types';
import {
  ErrorClassifier,
  ErrorDomain,
  type ClassifiedError,
} from '../../error-classifier';

export type ErrorClassification = {
  kind:
    | 'auth'
    | 'rate-limit'
    | 'quota'
    | 'server'
    | 'timeout'
    | 'network'
    | 'cancelled'
    | 'context-overflow'
    | 'unknown';
  retryable: boolean;
  message: string;
};

export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  signal: AbortSignal,
  retries = 1
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });

      const timeoutMs = init.timeoutMs ?? 120_000;
      const timer = setTimeout(
        () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
        timeoutMs
      );

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        return response;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (signal.aborted || attempt >= retries) break;
      await new Promise((r) =>
        setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 10000))
      );
    }
  }
  throw lastError ?? new Error('Request failed');
}

export abstract class AbstractBaseEngine implements Engine {
  abstract readonly id: string;

  abstract buildRequest(
    request: AgentProviderRequest,
    options: EngineOptions
  ): EngineRequest | Promise<EngineRequest>;

  abstract parseStream(
    response: Response,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;

  abstract parseResponse(
    body: unknown,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;

  protected async fetchWithRetry(
    url: string,
    init: RequestInit & { timeoutMs?: number },
    signal: AbortSignal,
    retries = 1
  ): Promise<Response> {
    return fetchWithRetry(url, init, signal, retries);
  }

  classifyError(
    error: unknown,
    status?: number,
    signal?: AbortSignal
  ): ErrorClassification {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const lowerMsg = rawMsg.toLowerCase();

    const classified = ErrorClassifier.classify(error, {
      ...(status !== undefined && { status }),
      ...(signal !== undefined && { signal }),
    });

    const kind = this.mapClassifiedKind(classified, lowerMsg);

    return {
      kind,
      retryable: kind === 'context-overflow' ? false : classified.retryable,
      message: rawMsg,
    };
  }

  private mapClassifiedKind(
    classified: ClassifiedError,
    lowerMsg: string
  ): ErrorClassification['kind'] {
    switch (classified.domain) {
      case ErrorDomain.USER_ABORT:
        return 'cancelled';
      case ErrorDomain.TRANSIENT_NETWORK:
        return /timeout|timed out/i.test(lowerMsg) ? 'timeout' : 'network';
      case ErrorDomain.TRANSIENT_SERVER:
        return 'server';
      case ErrorDomain.RATE_LIMIT:
        return 'rate-limit';
      case ErrorDomain.CLIENT_AUTH:
        return 'auth';
      case ErrorDomain.CLIENT_INVALID_INPUT:
        return classified.legacyKind === 'context-overflow'
          ? 'context-overflow'
          : classified.legacyKind === 'payload-too-large'
            ? 'unknown'
            : 'unknown';
      case ErrorDomain.QUOTA_EXHAUSTED:
        return 'quota';
      case ErrorDomain.STREAM_INTERRUPT:
        return 'unknown';
      case ErrorDomain.ENDPOINT_UNAVAILABLE:
        return 'server';
      case ErrorDomain.GATEWAY_CHALLENGE:
        return 'auth';
      default:
        return 'unknown';
    }
  }

  protected buildAuthHeaders(options: EngineOptions): Record<string, string> {
    if (!options.apiKey) return {};
    const authHeaderField =
      (options.extra?.authHeader as string) ?? 'authorization';
    return {
      [authHeaderField === 'authorization' ? 'Authorization' : authHeaderField]:
        `Bearer ${options.apiKey}`,
    };
  }

  protected diagnostic(
    code: string,
    message: string,
    _severity: 'info' | 'warning' | 'error' = 'info'
  ): ProviderStreamEvent {
    return {
      type: 'provider-diagnostic',
      diagnostic: { phase: 'request-error', reason: `[${code}] ${message}` },
    } satisfies ProviderStreamEvent;
  }
}
