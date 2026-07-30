import { ErrorClassifier } from '../error-classifier';
import type { ProviderStreamEvent, ProviderUsage } from '@crish/shared-types';
import type {
  ProviderStreamContractEvent,
  ProviderStreamSequencer,
  ProviderStreamContractEventInput,
  ProviderStreamDeltaCoalescingOptions,
  ProviderStreamFinishReason,
  ProviderStreamProviderError,
} from './types';
import {
  createProviderStreamSequencer,
  coalesceProviderStreamContractEventStream,
} from './sequencer';

export interface NormalizeAndCoalesceOptions {
  streamId?: string;
  providerId?: string;
  model?: string;
  coalescing?: ProviderStreamDeltaCoalescingOptions;
}

export interface NormalizeProviderStreamEventOptions {
  initialSequence?: number;
  streamId?: string;
  providerId?: string;
  includeDone?: boolean;
}

function isRawToolCall(event: Record<string, unknown>): boolean {
  return event.type === 'tool-call' && !('phase' in event);
}

function isContractEvent(event: unknown): event is ProviderStreamContractEvent {
  const e = event as Record<string, unknown>;
  const t = e.type as string;
  if (t === 'tool-call') return !isRawToolCall(e);
  return (
    t === 'start' ||
    t === 'delta' ||
    t === 'end' ||
    t === 'done' ||
    t === 'error'
  );
}

export function legacyFinishReason(reason: string): ProviderStreamFinishReason {
  if (reason === 'error') return 'error';
  if (reason === 'tool-call') return 'tool-call';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  return 'stop';
}

function classifyErrorMessage(
  msg: string
): ProviderStreamProviderError['kind'] {
  return ErrorClassifier.classify(new Error(msg))
    .legacyKind as ProviderStreamProviderError['kind'];
}

function normalizeProviderEvent(
  event: ProviderStreamEvent | ProviderStreamContractEvent,
  sequencer: ProviderStreamSequencer
): ProviderStreamContractEvent[] {
  if (isContractEvent(event)) {
    const sequenced = sequencer.next(
      event as ProviderStreamContractEvent as ProviderStreamContractEventInput
    ) as ProviderStreamContractEvent;
    if (event.type === 'error') {
      const errEvent = event as { error?: ProviderStreamProviderError };
      const finishReason: ProviderStreamFinishReason = 'error';
      const error: ProviderStreamProviderError = errEvent.error ?? {
        kind: 'unknown',
        message: '',
        retryable: false,
      };
      return [
        sequenced,
        sequencer.next({
          type: 'end',
          finishReason,
          error,
        }) as ProviderStreamContractEvent,
        sequencer.next({
          type: 'done',
          finishReason,
        }) as ProviderStreamContractEvent,
      ];
    }
    return [sequenced];
  }

  const raw = event as ProviderStreamEvent;
  const results: ProviderStreamContractEvent[] = [];

  if (raw.type === 'text-delta') {
    results.push(
      sequencer.next({
        type: 'delta',
        delta: { type: 'text', text: raw.text },
      }) as ProviderStreamContractEvent
    );
  } else if (raw.type === 'thought-delta') {
    const redacted = (raw as { redacted?: boolean }).redacted;
    results.push(
      sequencer.next({
        type: 'delta',
        delta: {
          type: 'thought',
          text: raw.text,
          ...(redacted !== undefined ? { redacted } : {}),
        },
      }) as ProviderStreamContractEvent
    );
  } else if (raw.type === 'tool-call') {
    results.push(
      sequencer.next({
        type: 'tool-call',
        phase: 'end',
        toolCall: {
          id: (raw as { id?: string }).id ?? '',
          index: 0,
          toolName: raw.toolName,
          argumentsText: raw.input ? JSON.stringify(raw.input) : '',
          input: raw.input,
        },
      }) as ProviderStreamContractEvent
    );
  } else if (raw.type === 'provider-diagnostic') {
    results.push(
      sequencer.next({
        type: 'delta',
        delta: {
          type: 'diagnostic',
          diagnostic: (
            raw as {
              diagnostic: import('@crish/shared-types').ProviderDiagnostic;
            }
          ).diagnostic,
        },
      }) as ProviderStreamContractEvent
    );
  } else if (raw.type === 'stop') {
    const finishReason = legacyFinishReason(raw.reason);
    const usage: ProviderUsage | undefined = raw.usage;
    const error: ProviderStreamProviderError | undefined = raw.error
      ? {
          kind: classifyErrorMessage(raw.error),
          message: raw.error,
          retryable: false,
        }
      : undefined;

    results.push(
      sequencer.next({
        type: 'end',
        finishReason,
        ...(usage ? { usage } : {}),
        ...(error ? { error } : {}),
      }) as ProviderStreamContractEvent
    );
    results.push(
      sequencer.next({
        type: 'done',
        finishReason,
        ...(usage ? { usage } : {}),
      }) as ProviderStreamContractEvent
    );
  }

  return results;
}

export function normalizeProviderStreamEvent(
  event: ProviderStreamEvent,
  options: NormalizeProviderStreamEventOptions = {}
): ProviderStreamContractEvent[] {
  const sequencer = createProviderStreamSequencer(options);
  const results: ProviderStreamContractEvent[] = [];
  for (const e of normalizeProviderEvent(event, sequencer)) {
    results.push(e);
  }
  return results;
}

export async function* normalizeProviderStreamEvents(
  source: Iterable<ProviderStreamEvent> | AsyncIterable<ProviderStreamEvent>,
  options: { streamId?: string; providerId?: string; model?: string } = {}
): AsyncIterable<ProviderStreamContractEvent> {
  const sequencer = createProviderStreamSequencer(options);

  yield sequencer.next({
    type: 'start',
    ...(options.model ? { model: options.model } : {}),
  }) as ProviderStreamContractEvent;

  const iterator =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<ProviderStreamEvent>)[Symbol.asyncIterator]()
      : (async function* () {
          yield* source as ProviderStreamEvent[];
        })();

  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) break;
      const normalized = normalizeProviderEvent(value, sequencer);
      for (const e of normalized) {
        yield e;
      }
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return(undefined);
    }
  }
}

export async function* normalizeAndCoalesceProviderStreamEvents(
  source: Iterable<ProviderStreamEvent> | AsyncIterable<ProviderStreamEvent>,
  options: NormalizeAndCoalesceOptions = {}
): AsyncGenerator<ProviderStreamContractEvent> {
  const { coalescing, ...sequencerOptions } = options;
  const normalizedStream = normalizeProviderStreamEvents(
    source,
    sequencerOptions
  );
  yield* coalesceProviderStreamContractEventStream(
    normalizedStream,
    coalescing ?? {}
  );
}
