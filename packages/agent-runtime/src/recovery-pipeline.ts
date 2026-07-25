import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "./types";
import { ErrorClassifier, ErrorDomain } from "./error-classifier";
import type { ClassifiedError } from "./error-classifier";
import type { FallbackConfig } from "./fallback-chain/types";

const RETRYABLE_TIER1: ReadonlySet<ErrorDomain> = new Set([
  ErrorDomain.TRANSIENT_NETWORK,
  ErrorDomain.TRANSIENT_SERVER,
  ErrorDomain.RATE_LIMIT,
]);

const MAX_BACKOFF_MS = 30_000;
const MAX_DEPTH = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


export interface RecoveryPipelineConfig {
  maxTransportRetries: number;
  transportBackoffMs: number;
  fallbackProviders: string[];
  fallbackConfig: FallbackConfig;
  providerResolver: (id: string) => AgentProvider;
  contextHealer?: () => Promise<boolean>;
  onActionableError?: (classified: ClassifiedError) => void;
}

export type PipelineResult =
  | { ok: true; events: AsyncIterable<ProviderStreamEvent>; tierUsed: 1 | 2 | 3 }
  | { ok: false; error: ClassifiedError };

async function tryStream(
  provider: AgentProvider,
  request: AgentProviderRequest,
): Promise<{ iter: AsyncIterator<ProviderStreamEvent>; first: IteratorResult<ProviderStreamEvent> } | { error: ClassifiedError }> {
  try {
    const stream = provider.stream(request);
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    return { iter, first };
  } catch (err) {
    return { error: ErrorClassifier.classify(err, { providerId: provider.id }) };
  }
}

async function* wrapTier1Retry(
  provider: AgentProvider,
  request: AgentProviderRequest,
  config: RecoveryPipelineConfig,
  startAttempt: number,
): AsyncIterable<ProviderStreamEvent> {
  const maxRetries = config.maxTransportRetries ?? 3;
  const backoffMs = config.transportBackoffMs ?? 1000;
  let cur: AsyncIterable<ProviderStreamEvent> = provider.stream(request);

  for (let attempt = startAttempt; attempt <= maxRetries; attempt++) {
    let shouldRetry = false;
    try {
      for await (const ev of cur) {
        if (ev.type === "stop" && ev.reason === "error") {
          const classified = ErrorClassifier.classify(new Error(ev.error), { providerId: provider.id });
          if (RETRYABLE_TIER1.has(classified.domain) && attempt < maxRetries) {
            shouldRetry = true;
            break;
          }
          yield ev;
          return;
        }
        yield ev;
      }
      if (!shouldRetry) return;
    } catch (err) {
      const classified = ErrorClassifier.classify(err, { providerId: provider.id });
      if (RETRYABLE_TIER1.has(classified.domain) && attempt < maxRetries) {
        shouldRetry = true;
      } else {
        yield { type: "stop", reason: "error", error: err instanceof Error ? err.message : String(err) };
        return;
      }
    }

    if (shouldRetry) {
      const delay = Math.min(backoffMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
      await sleep(delay);
      cur = provider.stream(request);
    }
  }
}

async function tier3Heal(
  request: AgentProviderRequest,
  config: RecoveryPipelineConfig,
  primaryProvider: AgentProvider,
  depth: number,
): Promise<PipelineResult> {
  if (config.contextHealer) {
    const healed = await config.contextHealer();
    if (healed) return executeWithFallback(request, primaryProvider, config, depth + 1);
  }

  const classified: ClassifiedError = {
    domain: ErrorDomain.CLIENT_INVALID_INPUT,
    retryable: false,
    uiSeverity: "warning",
    legacyKind: "context-overflow",
    subType: "context_length_exceeded",
    recoveryHint: "Context healing failed or not available",
  };
  config.onActionableError?.(classified);
  return { ok: false, error: classified };
}

export async function executeWithFallback(
  request: AgentProviderRequest,
  primaryProvider: AgentProvider,
  config: RecoveryPipelineConfig,
  _depth = 0,
): Promise<PipelineResult> {
  if (_depth > MAX_DEPTH) {
    const classified: ClassifiedError = {
      domain: ErrorDomain.UNKNOWN,
      retryable: false,
        uiSeverity: "error",
      legacyKind: "unknown",
      recoveryHint: "Recovery recursion limit exceeded",
    };
    config.onActionableError?.(classified);
    return { ok: false, error: classified };
  }

  const maxRetries = config.maxTransportRetries ?? 3;
  const backoffMs = config.transportBackoffMs ?? 1000;

  // Tier 1: Transport retry with mid-stream error wrapping
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await tryStream(primaryProvider, request);
    if ("error" in result) {
      const classified = result.error;
      if (RETRYABLE_TIER1.has(classified.domain) && attempt < maxRetries) {
        const delay = Math.min(backoffMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await sleep(delay);
        continue;
      }
      // Route non-retryable or exhausted
      if (classified.domain === ErrorDomain.CLIENT_INVALID_INPUT && classified.subType === "context_length_exceeded") {
        return tier3Heal(request, config, primaryProvider, _depth);
      }
      config.onActionableError?.(classified);
      return { ok: false, error: classified };
    }

    // Stream started — check first event
    if (!result.first.done && result.first.value.type === "stop" && result.first.value.reason === "error") {
      const classified = ErrorClassifier.classify(new Error(result.first.value.error), { providerId: primaryProvider.id });
      if (RETRYABLE_TIER1.has(classified.domain) && attempt < maxRetries) {
        const delay = Math.min(backoffMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await sleep(delay);
        continue;
      }
      if (classified.domain === ErrorDomain.CLIENT_INVALID_INPUT && classified.subType === "context_length_exceeded") {
        return tier3Heal(request, config, primaryProvider, _depth);
      }
      config.onActionableError?.(classified);
      return { ok: false, error: classified };
    }

    // Successful start — wrap with in-tier retry for mid-stream errors
    const wrapped = wrapTier1Retry(primaryProvider, request, config, attempt);
    return { ok: true, events: wrapped, tierUsed: 1 };
  }

  // Fallback: should not be reached
  const classified: ClassifiedError = {
    domain: ErrorDomain.UNKNOWN,
    retryable: false,
    uiSeverity: "error",
    legacyKind: "unknown",
    recoveryHint: "Unexpected exit from recovery pipeline",
  };
  config.onActionableError?.(classified);
  return { ok: false, error: classified };
}
