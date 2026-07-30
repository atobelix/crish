import type { ProviderStreamEvent } from "@crish/shared-types";
import type { AgentProvider } from "../core/runtime-options";
import type { FallbackConfig, FallbackEvent, FallbackErrorType, FallbackTarget } from "./types";
import { ErrorClassifier, ErrorDomain } from "../error-classifier";

export function classifyFallbackError(err: unknown, status?: number): { type: FallbackErrorType; retryable: boolean; message: string } {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const lowerMsg = rawMsg.toLowerCase();

  const classified = ErrorClassifier.classify(err, {
    ...(status !== undefined ? { status } : {}),
  });

  const type = domainToFallbackErrorType(classified, lowerMsg);
  return {
    type,
    retryable: type === "context-overflow" ? false : classified.retryable,
    message: rawMsg,
  };
}

function domainToFallbackErrorType(classified: { domain: ErrorDomain; subType?: string; legacyKind: string }, lowerMsg: string): FallbackErrorType {
  switch (classified.domain) {
    case ErrorDomain.USER_ABORT:          return "unknown";
    case ErrorDomain.TRANSIENT_NETWORK:    return /timeout|timed out/i.test(lowerMsg) ? "timeout" : "network-error";
    case ErrorDomain.TRANSIENT_SERVER:     return "server-error";
    case ErrorDomain.RATE_LIMIT:           return "rate-limit";
    case ErrorDomain.CLIENT_AUTH:          return "auth-error";
    case ErrorDomain.CLIENT_INVALID_INPUT:
      return classified.legacyKind === "context-overflow" ? "context-overflow" : "bad-request";
    case ErrorDomain.QUOTA_EXHAUSTED:      return "quota-exhausted";
    case ErrorDomain.STREAM_INTERRUPT:     return "unknown";
      case ErrorDomain.ENDPOINT_UNAVAILABLE: return "server-error";
    case ErrorDomain.GATEWAY_CHALLENGE:    return "unknown";
    default:                               return "unknown";
  }
}

export function selectFallbackList(errorType: FallbackErrorType, config: FallbackConfig): FallbackTarget[] | undefined {
  switch (errorType) {
    case "rate-limit": return config.onRateLimit ?? config.onError;
    case "context-overflow": return config.onContextOverflow ?? config.onError;
    case "timeout": return config.onTimeout ?? config.onError;
    case "server-error": return config.onServerError ?? config.onError;
    case "network-error": return config.onNetworkError ?? config.onError;
    case "quota-exhausted": return config.onQuotaExhausted ?? config.onError;
    default: return config.onError;
  }
}

export function resolveFallbackId(target: FallbackTarget): string {
  return typeof target === "string" ? target : target.id;
}

export function isNonRetryableClientError(type: FallbackErrorType): boolean {
  return type === "auth-error" || type === "bad-request";
}

export interface ProviderResolver {
  getProvider(id: string): AgentProvider;
}

export async function* callWithFallbackChain(
  primaryProvider: AgentProvider,
  request: Parameters<AgentProvider["stream"]>[0],
  config: FallbackConfig,
  resolver: ProviderResolver,
): AsyncIterable<ProviderStreamEvent> {
  const attemptedModels = new Set<string>();
  const events: FallbackEvent[] = [];
  let currentProvider = primaryProvider;
  let currentId = primaryProvider.id;

  for (let attempt = 0; attempt <= Math.min(config.maxAttempts, 5); attempt++) {
    try {
      if (attempt > 0) {
        yield {
          type: "provider-diagnostic",
          diagnostic: {
            phase: "endpoint-fallback",
            providerId: currentId,
            reason: `Falling back to ${currentId} (attempt ${attempt})`,
            retryable: true,
          },
        };
      }

      let shouldRetry = false;
      for await (const event of currentProvider.stream(request)) {
        yield event;
        if (event.type === "stop" && event.reason === "error") {
          const errorMsg = event.error ?? "";
          const classification = classifyFallbackError(new Error(errorMsg));
          if (!classification.retryable || isNonRetryableClientError(classification.type)) {
            return;
          }
          const fallbackList = selectFallbackList(classification.type, config);
          if (!fallbackList || fallbackList.length === 0 || attempt >= config.maxAttempts) {
            return;
          }
          let fallbackFound = false;
          for (const target of fallbackList) {
            const nextId = resolveFallbackId(target);
            if (attemptedModels.has(nextId)) continue;
            attemptedModels.add(nextId);
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            currentProvider = resolver.getProvider(nextId);
            currentId = nextId;
            events.push({ primaryModelId: primaryProvider.id, fallbackModelId: nextId, errorType: classification.type, attemptIndex: attempt, latencyMs: 0, message: classification.message });
            fallbackFound = true;
            break;
          }
          if (!fallbackFound) return;
          shouldRetry = true;
          break;
        }
      }
      if (!shouldRetry) return;
    } catch (err) {
      const classification = classifyFallbackError(err);
      if (!classification.retryable || isNonRetryableClientError(classification.type)) throw err;

      const fallbackList = selectFallbackList(classification.type, config);
      if (!fallbackList || fallbackList.length === 0 || attempt >= config.maxAttempts) throw err;

      let fallbackFound = false;
      for (const target of fallbackList) {
        const nextId = resolveFallbackId(target);
        if (attemptedModels.has(nextId)) continue;
        attemptedModels.add(nextId);
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        currentProvider = resolver.getProvider(nextId);
        currentId = nextId;
        events.push({ primaryModelId: primaryProvider.id, fallbackModelId: nextId, errorType: classification.type, attemptIndex: attempt, latencyMs: 0, message: classification.message });
        fallbackFound = true;
        break;
      }
      if (!fallbackFound) throw err;
    }
  }
}
