import type { JsonObject } from '@crish/shared-types';
import type {
  ProviderStreamContractEvent,
  ProviderStreamSequencer,
  ProviderStreamDelta,
  ProviderStreamDeltaEvent,
  ProviderStreamSequenceOptions,
  ProviderStreamDeltaCoalescer,
  ProviderStreamDeltaCoalescingOptions,
  ProviderStreamCoalescingIdentity,
} from './types';
import { DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS } from './types';

export function createProviderStreamSequencer(
  options: ProviderStreamSequenceOptions = {}
): ProviderStreamSequencer {
  let sequence = Math.floor(options.initialSequence ?? 0);
  return {
    next(event) {
      sequence += 1;
      return {
        sequence,
        ...(options.streamId !== undefined
          ? { streamId: options.streamId }
          : {}),
        ...(options.providerId !== undefined
          ? { providerId: options.providerId }
          : {}),
        ...event,
      } as ProviderStreamContractEvent;
    },
    current() {
      return sequence;
    },
  };
}

export function createProviderStreamDeltaCoalescer(
  options: ProviderStreamDeltaCoalescingOptions = {}
): ProviderStreamDeltaCoalescer {
  const config = normalizeProviderStreamDeltaCoalescingOptions(options);
  const buckets = new Map<string, ProviderStreamDeltaCoalescingBucket>();

  function flushKeys(keys: string[]): ProviderStreamContractEvent[] {
    const selected = uniqueStrings(keys)
      .map((key) => buckets.get(key))
      .filter(
        (bucket): bucket is ProviderStreamDeltaCoalescingBucket =>
          bucket !== undefined
      )
      .sort((left, right) => left.sequence - right.sequence);
    for (const bucket of selected) buckets.delete(bucket.key);
    return selected.map(providerStreamDeltaBucketToEvent);
  }

  function flushUpToSequence(sequence: number): ProviderStreamContractEvent[] {
    return flushKeys(
      [...buckets.values()]
        .filter((bucket) => bucket.sequence <= sequence)
        .map((bucket) => bucket.key)
    );
  }

  function flushBoundary(
    event: ProviderStreamContractEvent
  ): ProviderStreamContractEvent[] {
    const key = providerStreamIdentityKey(event);
    const flushable = [...buckets.values()]
      .filter(
        (bucket) => bucket.key === key || bucket.sequence <= event.sequence
      )
      .map((bucket) => bucket.key);
    return flushKeys(flushable);
  }

  function flushExpiredAt(now: number): ProviderStreamContractEvent[] {
    const expired = [...buckets.values()].filter(
      (bucket) => bucket.startedAt + config.maxDelayMs <= now
    );
    if (expired.length === 0) return [];
    return flushUpToSequence(
      Math.max(...expired.map((bucket) => bucket.sequence))
    );
  }

  return {
    push(event) {
      const now = config.now();
      const emitted = flushExpiredAt(now);
      if (!isCoalescibleProviderStreamDelta(event)) {
        emitted.push(...flushBoundary(event), event);
        return emitted;
      }

      const key = providerStreamIdentityKey(event);
      const current = buckets.get(key);
      if (!current) {
        buckets.set(key, createProviderStreamDeltaBucket(event, key, now));
      } else if (canMergeProviderStreamDeltaBucket(current, event)) {
        mergeProviderStreamDeltaBucket(current, event, now);
      } else {
        emitted.push(...flushKeys([key]));
        buckets.set(key, createProviderStreamDeltaBucket(event, key, now));
      }

      const bucket = buckets.get(key);
      if (bucket && shouldFlushProviderStreamDeltaBucket(bucket, config, now)) {
        emitted.push(...flushUpToSequence(bucket.sequence));
      }
      return emitted;
    },
    flush(identity) {
      if (identity) return flushKeys([providerStreamIdentityKey(identity)]);
      return flushKeys([...buckets.keys()]);
    },
    flushExpired(now = config.now()) {
      return flushExpiredAt(now);
    },
    timeUntilNextFlush(now = config.now()) {
      let delay: number | undefined;
      for (const bucket of buckets.values()) {
        const remaining = bucket.startedAt + config.maxDelayMs - now;
        delay = delay === undefined ? remaining : Math.min(delay, remaining);
      }
      return delay === undefined ? undefined : Math.max(0, delay);
    },
  };
}

export function coalesceProviderStreamContractEvents(
  events: Iterable<ProviderStreamContractEvent>,
  options: ProviderStreamDeltaCoalescingOptions = {}
): ProviderStreamContractEvent[] {
  const coalescer = createProviderStreamDeltaCoalescer(options);
  const output: ProviderStreamContractEvent[] = [];
  for (const event of events) output.push(...coalescer.push(event));
  output.push(...coalescer.flush());
  return output;
}

export async function* coalesceProviderStreamContractEventStream(
  source:
    | Iterable<ProviderStreamContractEvent>
    | AsyncIterable<ProviderStreamContractEvent>,
  options: ProviderStreamDeltaCoalescingOptions = {}
): AsyncGenerator<ProviderStreamContractEvent> {
  const coalescer = createProviderStreamDeltaCoalescer(options);
  const iterator = providerStreamAsyncIterable(source)[Symbol.asyncIterator]();
  let next = iterator.next();

  try {
    while (true) {
      const delay = coalescer.timeUntilNextFlush();
      if (delay === undefined) {
        const result = await next;
        if (result.done === true) break;
        for (const event of coalescer.push(result.value)) yield event;
        next = iterator.next();
        continue;
      }

      if (delay <= 0) {
        const expired = coalescer.flushExpired();
        if (expired.length > 0) {
          for (const event of expired) yield event;
          continue;
        }
      }

      const result = await raceProviderStreamNextOrFlushDelay(
        next,
        Math.max(1, delay)
      );
      if (result.type === 'flush') {
        for (const event of coalescer.flushExpired()) yield event;
        continue;
      }

      if (result.result.done === true) break;
      for (const event of coalescer.push(result.result.value)) yield event;
      next = iterator.next();
    }

    for (const event of coalescer.flush()) yield event;
  } catch (cause) {
    for (const event of coalescer.flush()) yield event;
    throw cause;
  } finally {
    await iterator.return?.(undefined);
  }
}

type ProviderStreamCoalescibleDelta = Extract<
  ProviderStreamDelta,
  { type: 'text' | 'thought' }
>;
type ProviderStreamCoalescibleDeltaEvent = ProviderStreamDeltaEvent & {
  delta: ProviderStreamCoalescibleDelta;
};
type ProviderStreamDeltaCoalescingConfig = Required<
  Omit<ProviderStreamDeltaCoalescingOptions, 'now'>
> & {
  now: () => number;
};

interface ProviderStreamDeltaCoalescingBucket extends ProviderStreamCoalescingIdentity {
  key: string;
  deltaType: ProviderStreamCoalescibleDelta['type'];
  text: string;
  redacted?: boolean;
  sequence: number;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  charCount: number;
  metadata: JsonObject | undefined;
}

function normalizeProviderStreamDeltaCoalescingOptions(
  options: ProviderStreamDeltaCoalescingOptions
): ProviderStreamDeltaCoalescingConfig {
  return {
    maxDelayMs: nonNegativeFiniteNumber(
      options.maxDelayMs,
      DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxDelayMs
    ),
    maxChars: positiveFiniteInteger(
      options.maxChars,
      DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxChars
    ),
    maxEvents: positiveFiniteInteger(
      options.maxEvents,
      DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxEvents
    ),
    now: options.now ?? providerStreamNow,
  };
}

function providerStreamNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function nonNegativeFiniteNumber(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function positiveFiniteInteger(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function isCoalescibleProviderStreamDelta(
  event: ProviderStreamContractEvent
): event is ProviderStreamCoalescibleDeltaEvent {
  return (
    event.type === 'delta' &&
    (event.delta.type === 'text' || event.delta.type === 'thought')
  );
}

function providerStreamIdentityKey(
  identity: ProviderStreamCoalescingIdentity
): string {
  return `${identity.providerId ?? ''}\u0000${identity.streamId ?? ''}`;
}

function createProviderStreamDeltaBucket(
  event: ProviderStreamCoalescibleDeltaEvent,
  key: string,
  now: number
): ProviderStreamDeltaCoalescingBucket {
  return {
    key,
    ...(event.providerId !== undefined ? { providerId: event.providerId } : {}),
    ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
    deltaType: event.delta.type,
    text: event.delta.text,
    ...(event.delta.type === 'thought' && event.delta.redacted !== undefined
      ? { redacted: event.delta.redacted }
      : {}),
    sequence: event.sequence,
    startedAt: now,
    updatedAt: now,
    eventCount: 1,
    charCount: event.delta.text.length,
    metadata: event.metadata,
  };
}

function canMergeProviderStreamDeltaBucket(
  bucket: ProviderStreamDeltaCoalescingBucket,
  event: ProviderStreamCoalescibleDeltaEvent
): boolean {
  if (bucket.deltaType !== event.delta.type) return false;
  if (event.delta.type === 'thought')
    return bucket.redacted === event.delta.redacted;
  return true;
}

function mergeProviderStreamDeltaBucket(
  bucket: ProviderStreamDeltaCoalescingBucket,
  event: ProviderStreamCoalescibleDeltaEvent,
  now: number
): void {
  bucket.text += event.delta.text;
  bucket.sequence = event.sequence;
  bucket.updatedAt = now;
  bucket.eventCount += 1;
  bucket.charCount += event.delta.text.length;
  bucket.metadata = event.metadata;
}

function shouldFlushProviderStreamDeltaBucket(
  bucket: ProviderStreamDeltaCoalescingBucket,
  config: ProviderStreamDeltaCoalescingConfig,
  now: number
): boolean {
  return (
    bucket.eventCount >= config.maxEvents ||
    bucket.charCount >= config.maxChars ||
    bucket.startedAt + config.maxDelayMs <= now
  );
}

function providerStreamDeltaBucketToEvent(
  bucket: ProviderStreamDeltaCoalescingBucket
): ProviderStreamDeltaEvent {
  return {
    type: 'delta',
    sequence: bucket.sequence,
    ...(bucket.streamId !== undefined ? { streamId: bucket.streamId } : {}),
    ...(bucket.providerId !== undefined
      ? { providerId: bucket.providerId }
      : {}),
    ...(bucket.metadata !== undefined ? { metadata: bucket.metadata } : {}),
    delta:
      bucket.deltaType === 'text'
        ? { type: 'text', text: bucket.text }
        : {
            type: 'thought',
            text: bucket.text,
            ...(bucket.redacted !== undefined
              ? { redacted: bucket.redacted }
              : {}),
          },
  };
}

async function* providerStreamAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>
): AsyncGenerator<T> {
  for await (const item of source) yield item;
}

function raceProviderStreamNextOrFlushDelay<T>(
  next: Promise<IteratorResult<T>>,
  delayMs: number
): Promise<{ type: 'next'; result: IteratorResult<T> } | { type: 'flush' }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const flushDelay = new Promise<{ type: 'flush' }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ type: 'flush' }),
      Math.max(1, delayMs)
    );
  });
  return Promise.race([
    next.then((result) => ({ type: 'next' as const, result })),
    flushDelay,
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
