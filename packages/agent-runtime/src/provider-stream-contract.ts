import type { JsonObject, JsonValue, ProviderDiagnostic, ProviderErrorKind } from "@crish/shared-types";
import type { ProviderStreamEvent, ProviderUsage } from "./types";

export type ProviderStreamEnvelopeType = "start" | "delta" | "tool-call" | "end" | "done" | "error";
export type ProviderStreamFinishReason = "stop" | "tool-call" | "length" | "error" | "cancelled" | "unknown";
export type ProviderStreamErrorKind =
  | ProviderErrorKind
  | "timeout"
  | "cancelled"
  | "invalid-stream"
  | "invalid-tool-call";

export interface ProviderStreamEnvelopeBase {
  type: ProviderStreamEnvelopeType;
  sequence: number;
  streamId?: string;
  providerId?: string;
  metadata?: JsonObject;
}

export interface ProviderStreamStartEvent extends ProviderStreamEnvelopeBase {
  type: "start";
  model?: string;
}

export type ProviderStreamDelta =
  | { type: "text"; text: string }
  | { type: "thought"; text: string; redacted?: boolean }
  | { type: "diagnostic"; diagnostic: ProviderDiagnostic };

export interface ProviderStreamDeltaEvent extends ProviderStreamEnvelopeBase {
  type: "delta";
  delta: ProviderStreamDelta;
}

export type ProviderStreamToolCallPhase = "start" | "delta" | "end";

export interface ProviderStreamToolCall {
  id?: string;
  index?: number;
  toolName: string;
  argumentsText: string;
  input?: JsonObject;
}

export interface ProviderStreamToolCallEvent extends ProviderStreamEnvelopeBase {
  type: "tool-call";
  phase: ProviderStreamToolCallPhase;
  toolCall: ProviderStreamToolCall;
  repair?: ProviderToolCallJsonRepairResult;
}

export interface ProviderStreamProviderError {
  kind: ProviderStreamErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
  statusText?: string;
  code?: string;
  providerId?: string;
  phase?: ProviderDiagnostic["phase"] | "stream";
}

export interface ProviderStreamErrorEvent extends ProviderStreamEnvelopeBase {
  type: "error";
  error: ProviderStreamProviderError;
}

export interface ProviderStreamEndEvent extends ProviderStreamEnvelopeBase {
  type: "end";
  finishReason: ProviderStreamFinishReason;
  usage?: ProviderUsage;
  error?: ProviderStreamProviderError;
}

export interface ProviderStreamDoneEvent extends ProviderStreamEnvelopeBase {
  type: "done";
  finishReason: ProviderStreamFinishReason;
  usage?: ProviderUsage;
  error?: ProviderStreamProviderError;
}

export type ProviderStreamContractEvent =
  | ProviderStreamStartEvent
  | ProviderStreamDeltaEvent
  | ProviderStreamToolCallEvent
  | ProviderStreamEndEvent
  | ProviderStreamDoneEvent
  | ProviderStreamErrorEvent;

export type ProviderStreamContractEventInput =
  | Omit<ProviderStreamStartEvent, "sequence">
  | Omit<ProviderStreamDeltaEvent, "sequence">
  | Omit<ProviderStreamToolCallEvent, "sequence">
  | Omit<ProviderStreamEndEvent, "sequence">
  | Omit<ProviderStreamDoneEvent, "sequence">
  | Omit<ProviderStreamErrorEvent, "sequence">;

export interface ProviderStreamSequenceOptions {
  initialSequence?: number;
  streamId?: string;
  providerId?: string;
}

export interface ProviderStreamSequencer {
  next(event: ProviderStreamContractEventInput): ProviderStreamContractEvent;
  current(): number;
}

export interface ProviderStreamEventAdapterOptions extends ProviderStreamSequenceOptions {
  includeDone?: boolean;
}

export interface ProviderStreamEventsAdapterOptions extends ProviderStreamSequenceOptions {
  includeStart?: boolean;
  includeDone?: boolean;
  emitEndOnClose?: boolean;
  model?: string;
}

export interface ProviderStreamDeltaCoalescingOptions {
  maxDelayMs?: number;
  maxChars?: number;
  maxEvents?: number;
  now?: () => number;
}

export interface ProviderStreamCoalescingIdentity {
  streamId?: string;
  providerId?: string;
}

export interface ProviderStreamDeltaCoalescer {
  push(event: ProviderStreamContractEvent): ProviderStreamContractEvent[];
  flush(identity?: ProviderStreamCoalescingIdentity): ProviderStreamContractEvent[];
  flushExpired(now?: number): ProviderStreamContractEvent[];
  timeUntilNextFlush(now?: number): number | undefined;
}

export interface ProviderStreamContractAdapterOptions extends ProviderStreamEventsAdapterOptions {
  coalescing?: ProviderStreamDeltaCoalescingOptions | false;
}

export const DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS = {
  maxDelayMs: 5,
  maxChars: 2048,
  maxEvents: 32
} as const satisfies Required<Omit<ProviderStreamDeltaCoalescingOptions, "now">>;

export interface ProviderToolCallJsonDelta {
  id?: string;
  index?: number;
  toolName?: string;
  argumentsText?: string;
  argumentsDelta?: string;
  replaceArguments?: boolean;
  done?: boolean;
}

export interface ProviderToolCallJsonAccumulatorSnapshot {
  id?: string;
  index?: number;
  toolName: string;
  argumentsText: string;
  done: boolean;
}

export type ProviderToolCallJsonRepairStatus = "valid" | "repaired" | "invalid";

export interface ProviderToolCallJsonRepairResult {
  status: ProviderToolCallJsonRepairStatus;
  raw: string;
  input: JsonObject;
  notes: string[];
  repairedText?: string;
  error?: string;
}

export interface ProviderStreamErrorInput {
  message?: string;
  error?: unknown;
  status?: number;
  statusText?: string;
  code?: string;
  headers?: Headers | Record<string, string>;
  retryable?: boolean;
  providerId?: string;
  phase?: ProviderDiagnostic["phase"] | "stream";
  errorKind?: ProviderStreamErrorKind;
}

export class ProviderToolCallJsonAccumulator {
  private idValue: string | undefined;
  private indexValue: number | undefined;
  private toolNameValue = "";
  private argumentsValue = "";
  private doneValue = false;

  constructor(initial?: ProviderToolCallJsonDelta) {
    if (initial) this.append(initial);
  }

  append(delta: ProviderToolCallJsonDelta): ProviderToolCallJsonAccumulatorSnapshot {
    if (delta.id !== undefined) this.idValue = delta.id;
    if (delta.index !== undefined) this.indexValue = delta.index;
    if (delta.toolName !== undefined) this.toolNameValue = delta.toolName;
    if (delta.argumentsText !== undefined) {
      this.argumentsValue = delta.replaceArguments ? delta.argumentsText : this.argumentsValue + delta.argumentsText;
    }
    if (delta.argumentsDelta !== undefined) this.argumentsValue += delta.argumentsDelta;
    if (delta.done === true) this.doneValue = true;
    return this.snapshot();
  }

  snapshot(): ProviderToolCallJsonAccumulatorSnapshot {
    return {
      ...(this.idValue !== undefined ? { id: this.idValue } : {}),
      ...(this.indexValue !== undefined ? { index: this.indexValue } : {}),
      toolName: this.toolNameValue,
      argumentsText: this.argumentsValue,
      done: this.doneValue
    };
  }

  finalize(): ProviderToolCallJsonRepairResult {
    return repairToolCallJsonArguments(this.argumentsValue);
  }

  toToolCall(repair = this.finalize()): ProviderStreamToolCall {
    return {
      ...(this.idValue !== undefined ? { id: this.idValue } : {}),
      ...(this.indexValue !== undefined ? { index: this.indexValue } : {}),
      toolName: this.toolNameValue,
      argumentsText: this.argumentsValue,
      input: repair.input
    };
  }
}

export function createProviderStreamSequencer(options: ProviderStreamSequenceOptions = {}): ProviderStreamSequencer {
  let sequence = Math.floor(options.initialSequence ?? 0);
  return {
    next(event) {
      sequence += 1;
      return {
        sequence,
        ...(options.streamId !== undefined ? { streamId: options.streamId } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...event
      } as ProviderStreamContractEvent;
    },
    current() {
      return sequence;
    }
  };
}

export function createProviderToolCallEventFromAccumulator(
  accumulator: ProviderToolCallJsonAccumulator,
  phase: ProviderStreamToolCallPhase = "end"
): Omit<ProviderStreamToolCallEvent, "sequence"> {
  const repair = accumulator.finalize();
  return {
    type: "tool-call",
    phase,
    toolCall: accumulator.toToolCall(repair),
    repair
  };
}

export function createProviderStreamDeltaCoalescer(options: ProviderStreamDeltaCoalescingOptions = {}): ProviderStreamDeltaCoalescer {
  const config = normalizeProviderStreamDeltaCoalescingOptions(options);
  const buckets = new Map<string, ProviderStreamDeltaCoalescingBucket>();

  function flushKeys(keys: string[]): ProviderStreamContractEvent[] {
    const selected = uniqueStrings(keys)
      .map((key) => buckets.get(key))
      .filter((bucket): bucket is ProviderStreamDeltaCoalescingBucket => bucket !== undefined)
      .sort((left, right) => left.sequence - right.sequence);
    for (const bucket of selected) buckets.delete(bucket.key);
    return selected.map(providerStreamDeltaBucketToEvent);
  }

  function flushUpToSequence(sequence: number): ProviderStreamContractEvent[] {
    return flushKeys([...buckets.values()].filter((bucket) => bucket.sequence <= sequence).map((bucket) => bucket.key));
  }

  function flushBoundary(event: ProviderStreamContractEvent): ProviderStreamContractEvent[] {
    const key = providerStreamIdentityKey(event);
    const flushable = [...buckets.values()]
      .filter((bucket) => bucket.key === key || bucket.sequence <= event.sequence)
      .map((bucket) => bucket.key);
    return flushKeys(flushable);
  }

  function flushExpiredAt(now: number): ProviderStreamContractEvent[] {
    const expired = [...buckets.values()].filter((bucket) => bucket.startedAt + config.maxDelayMs <= now);
    if (expired.length === 0) return [];
    return flushUpToSequence(Math.max(...expired.map((bucket) => bucket.sequence)));
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
    }
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
  source: Iterable<ProviderStreamContractEvent> | AsyncIterable<ProviderStreamContractEvent>,
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

      const result = await raceProviderStreamNextOrFlushDelay(next, delay);
      if (result.type === "flush") {
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

export async function* normalizeAndCoalesceProviderStreamEvents(
  source: Iterable<ProviderStreamEvent> | AsyncIterable<ProviderStreamEvent>,
  options: ProviderStreamContractAdapterOptions = {}
): AsyncGenerator<ProviderStreamContractEvent> {
  const normalized = normalizeProviderStreamEvents(source, options);
  if (options.coalescing === false) {
    yield* normalized;
    return;
  }
  yield* coalesceProviderStreamContractEventStream(normalized, options.coalescing);
}

export function repairToolCallJsonArguments(raw: string): ProviderToolCallJsonRepairResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      status: "valid",
      raw,
      input: {},
      notes: []
    };
  }

  const direct = parseJsonArguments(trimmed);
  if (direct.ok) {
    return {
      status: direct.repaired ? "repaired" : "valid",
      raw,
      input: direct.input,
      notes: direct.notes,
      ...(direct.repairedText !== undefined ? { repairedText: direct.repairedText } : {})
    };
  }

  for (const candidate of jsonRepairCandidates(trimmed)) {
    if (candidate === trimmed) continue;
    const repaired = parseJsonArguments(candidate);
    if (repaired.ok) {
      return {
        status: "repaired",
        raw,
        input: repaired.input,
        notes: [...repaired.notes, "Repaired tool-call JSON arguments."],
        repairedText: candidate
      };
    }
  }

  return {
    status: "invalid",
    raw,
    input: {
      __rawArguments: raw,
      __parseError: direct.error ?? "Invalid JSON arguments"
    },
    notes: ["Preserved invalid tool-call JSON arguments as structured fallback."],
    ...(direct.error !== undefined ? { error: direct.error } : {})
  };
}

export function normalizeProviderStreamFinishReason(reason: unknown): ProviderStreamFinishReason {
  if (reason === "tool-call" || reason === "tool_calls" || reason === "function_call") return "tool-call";
  if (reason === "stop" || reason === "complete" || reason === "completed" || reason == null) return "stop";
  if (reason === "length" || reason === "max_tokens" || reason === "max_output_tokens") return "length";
  if (reason === "cancelled" || reason === "canceled" || reason === "abort" || reason === "aborted") return "cancelled";
  if (reason === "error" || reason === "failed" || reason === "incomplete") return "error";
  return "unknown";
}

export function classifyProviderStreamError(input: ProviderStreamErrorInput | ProviderDiagnostic | unknown): ProviderStreamProviderError {
  const record = objectRecord(input);
  const nestedError = record ? record.error : undefined;
  const nestedRecord = objectRecord(nestedError);
  const message =
    stringField(record?.message) ??
    stringField(record?.reason) ??
    stringField(nestedRecord?.message) ??
    stringField(record?.error) ??
    (input instanceof Error ? input.message : undefined) ??
    (typeof input === "string" ? input : undefined) ??
    "Provider stream failed";
  const status = numberField(record?.status);
  const statusText = stringField(record?.statusText);
  const code = stringField(record?.code) ?? stringField(nestedRecord?.code) ?? (input instanceof Error ? input.name : undefined);
  const headers = headersRecord(record?.headers);
  const explicitKind = providerStreamErrorKindField(record?.errorKind);
  const providerId = stringField(record?.providerId);
  const phase = providerStreamErrorPhaseField(record?.phase);
  const classified = explicitKind ?? classifyProviderStreamErrorKind({ message, status, code, headers });
  const retryable = booleanField(record?.retryable) ?? defaultRetryableForProviderStreamError(classified);

  return {
    kind: classified,
    message,
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(statusText !== undefined ? { statusText } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(phase !== undefined ? { phase } : {})
  };
}

export function normalizeProviderStreamEvent(
  event: ProviderStreamEvent,
  options: ProviderStreamEventAdapterOptions = {}
): ProviderStreamContractEvent[] {
  const sequencer = createProviderStreamSequencer(options);
  const events = mapProviderStreamEvent(event, sequencer);
  if (options.includeDone === true && event.type === "stop") {
    const end = events.find((candidate): candidate is ProviderStreamEndEvent => candidate.type === "end");
    events.push(
      sequencer.next({
        type: "done",
        finishReason: end?.finishReason ?? normalizeProviderStreamFinishReason(event.reason),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(end?.error !== undefined ? { error: end.error } : {})
      })
    );
  }
  return events;
}

export async function* normalizeProviderStreamEvents(
  source: Iterable<ProviderStreamEvent> | AsyncIterable<ProviderStreamEvent>,
  options: ProviderStreamEventsAdapterOptions = {}
): AsyncGenerator<ProviderStreamContractEvent> {
  const sequencer = createProviderStreamSequencer(options);
  let finishReason: ProviderStreamFinishReason | undefined;
  let usage: ProviderUsage | undefined;
  let terminalError: ProviderStreamProviderError | undefined;
  let sawEnd = false;

  if (options.includeStart !== false) {
    yield sequencer.next({
      type: "start",
      ...(options.model !== undefined ? { model: options.model } : {})
    });
  }

  try {
    for await (const event of source) {
      const mapped = mapProviderStreamEvent(event, sequencer);
      for (const contractEvent of mapped) {
        if (contractEvent.type === "error") terminalError = contractEvent.error;
        if (contractEvent.type === "end") {
          sawEnd = true;
          finishReason = contractEvent.finishReason;
          usage = contractEvent.usage;
          terminalError = contractEvent.error ?? terminalError;
        }
        yield contractEvent;
      }
    }
  } catch (cause) {
    if (!sawEnd) {
      terminalError = classifyProviderStreamError(cause);
      finishReason = "error";
      sawEnd = true;
      yield sequencer.next({ type: "error", error: terminalError });
      yield sequencer.next({ type: "end", finishReason, error: terminalError });
    }
  }

  if (!sawEnd && options.emitEndOnClose !== false) {
    finishReason = terminalError ? "error" : "unknown";
    sawEnd = true;
    yield sequencer.next({
      type: "end",
      finishReason,
      ...(terminalError !== undefined ? { error: terminalError } : {})
    });
  }

  if (options.includeDone !== false) {
    yield sequencer.next({
      type: "done",
      finishReason: finishReason ?? (terminalError ? "error" : "unknown"),
      ...(usage !== undefined ? { usage } : {}),
      ...(terminalError !== undefined ? { error: terminalError } : {})
    });
  }
}

function mapProviderStreamEvent(event: ProviderStreamEvent, sequencer: ProviderStreamSequencer): ProviderStreamContractEvent[] {
  if (event.type === "text-delta") {
    return [sequencer.next({ type: "delta", delta: { type: "text", text: event.text } })];
  }
  if (event.type === "thought-delta") {
    return [
      sequencer.next({
        type: "delta",
        delta: {
          type: "thought",
          text: event.text,
          ...(event.redacted !== undefined ? { redacted: event.redacted } : {})
        }
      })
    ];
  }
  if (event.type === "tool-call") {
    const raw = JSON.stringify(event.input);
    const repair: ProviderToolCallJsonRepairResult = {
      status: "valid",
      raw,
      input: event.input,
      notes: []
    };
    return [
      sequencer.next({
        type: "tool-call",
        phase: "end",
        toolCall: {
          ...(event.id !== undefined ? { id: event.id } : {}),
          toolName: event.toolName,
          argumentsText: raw,
          input: event.input
        },
        repair
      })
    ];
  }
  if (event.type === "provider-diagnostic") {
    return [sequencer.next({ type: "delta", delta: { type: "diagnostic", diagnostic: event.diagnostic } })];
  }

  const finishReason = normalizeProviderStreamFinishReason(event.reason);
  if (finishReason === "error") {
    const error = classifyProviderStreamError({
      message: event.error ?? "Provider stream stopped with error"
    });
    return [
      sequencer.next({ type: "error", error }),
      sequencer.next({
        type: "end",
        finishReason,
        error,
        ...(event.usage !== undefined ? { usage: event.usage } : {})
      })
    ];
  }

  return [
    sequencer.next({
      type: "end",
      finishReason,
      ...(event.usage !== undefined ? { usage: event.usage } : {})
    })
  ];
}

type ProviderStreamCoalescibleDelta = Extract<ProviderStreamDelta, { type: "text" | "thought" }>;
type ProviderStreamCoalescibleDeltaEvent = ProviderStreamDeltaEvent & { delta: ProviderStreamCoalescibleDelta };
type ProviderStreamDeltaCoalescingConfig = Required<Omit<ProviderStreamDeltaCoalescingOptions, "now">> & {
  now: () => number;
};

interface ProviderStreamDeltaCoalescingBucket extends ProviderStreamCoalescingIdentity {
  key: string;
  deltaType: ProviderStreamCoalescibleDelta["type"];
  text: string;
  redacted?: boolean;
  sequence: number;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  charCount: number;
  metadata?: JsonObject;
}

function normalizeProviderStreamDeltaCoalescingOptions(
  options: ProviderStreamDeltaCoalescingOptions
): ProviderStreamDeltaCoalescingConfig {
  return {
    maxDelayMs: nonNegativeFiniteNumber(options.maxDelayMs, DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxDelayMs),
    maxChars: positiveFiniteInteger(options.maxChars, DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxChars),
    maxEvents: positiveFiniteInteger(options.maxEvents, DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS.maxEvents),
    now: options.now ?? providerStreamNow
  };
}

function providerStreamNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function nonNegativeFiniteNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function positiveFiniteInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function isCoalescibleProviderStreamDelta(event: ProviderStreamContractEvent): event is ProviderStreamCoalescibleDeltaEvent {
  return event.type === "delta" && (event.delta.type === "text" || event.delta.type === "thought");
}

function providerStreamIdentityKey(identity: ProviderStreamCoalescingIdentity): string {
  return `${identity.providerId ?? ""}\u0000${identity.streamId ?? ""}`;
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
    ...(event.delta.type === "thought" && event.delta.redacted !== undefined ? { redacted: event.delta.redacted } : {}),
    sequence: event.sequence,
    startedAt: now,
    updatedAt: now,
    eventCount: 1,
    charCount: event.delta.text.length,
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {})
  };
}

function canMergeProviderStreamDeltaBucket(
  bucket: ProviderStreamDeltaCoalescingBucket,
  event: ProviderStreamCoalescibleDeltaEvent
): boolean {
  if (bucket.deltaType !== event.delta.type) return false;
  if (event.delta.type === "thought") return bucket.redacted === event.delta.redacted;
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
  return bucket.eventCount >= config.maxEvents || bucket.charCount >= config.maxChars || bucket.startedAt + config.maxDelayMs <= now;
}

function providerStreamDeltaBucketToEvent(bucket: ProviderStreamDeltaCoalescingBucket): ProviderStreamDeltaEvent {
  return {
    type: "delta",
    sequence: bucket.sequence,
    ...(bucket.streamId !== undefined ? { streamId: bucket.streamId } : {}),
    ...(bucket.providerId !== undefined ? { providerId: bucket.providerId } : {}),
    ...(bucket.metadata !== undefined ? { metadata: bucket.metadata } : {}),
    delta:
      bucket.deltaType === "text"
        ? { type: "text", text: bucket.text }
        : {
            type: "thought",
            text: bucket.text,
            ...(bucket.redacted !== undefined ? { redacted: bucket.redacted } : {})
          }
  };
}

async function* providerStreamAsyncIterable<T>(source: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  for await (const item of source) yield item;
}

function raceProviderStreamNextOrFlushDelay<T>(
  next: Promise<IteratorResult<T>>,
  delayMs: number
): Promise<{ type: "next"; result: IteratorResult<T> } | { type: "flush" }> {
  if (delayMs <= 0) {
    return Promise.race([next.then((result) => ({ type: "next" as const, result })), Promise.resolve({ type: "flush" as const })]);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const flushDelay = new Promise<{ type: "flush" }>((resolve) => {
    timeout = setTimeout(() => resolve({ type: "flush" }), delayMs);
  });
  return Promise.race([next.then((result) => ({ type: "next" as const, result })), flushDelay]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function parseJsonArguments(text: string):
  | { ok: true; input: JsonObject; notes: string[]; repaired: boolean; repairedText?: string }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    if (isJsonObject(parsed)) {
      return { ok: true, input: parsed, notes: [], repaired: false };
    }
    return {
      ok: true,
      input: { value: parsed },
      notes: ["Wrapped non-object JSON arguments in value."],
      repaired: true,
      repairedText: JSON.stringify({ value: parsed })
    };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function jsonRepairCandidates(text: string): string[] {
  const stripped = stripJsonMarkdownFence(text);
  const seeds = uniqueStrings([
    text,
    stripped,
    removeTrailingJsonCommas(text),
    removeTrailingJsonCommas(stripped),
    quoteUnquotedObjectKeys(text),
    quoteUnquotedObjectKeys(stripped),
    replaceSingleQuotedJsonStrings(text),
    replaceSingleQuotedJsonStrings(stripped)
  ]);
  const candidates: string[] = [];
  for (const seed of seeds) {
    candidates.push(seed);
    candidates.push(removeTrailingJsonCommas(seed));
    candidates.push(balanceJsonContainers(seed));
    candidates.push(removeTrailingJsonCommas(balanceJsonContainers(seed)));
  }
  return uniqueStrings(candidates);
}

function stripJsonMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? text;
}

function removeTrailingJsonCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function quoteUnquotedObjectKeys(text: string): string {
  return text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
}

function replaceSingleQuotedJsonStrings(text: string): string {
  if (text.includes('"')) return text;
  return text.replace(/'/g, '"');
}

function balanceJsonContainers(text: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      closers.push("}");
    } else if (char === "[") {
      closers.push("]");
    } else if (char === "}" || char === "]") {
      const expected = closers.at(-1);
      if (expected === char) closers.pop();
    }
  }

  return `${text}${inString ? '"' : ""}${closers.reverse().join("")}`;
}

function classifyProviderStreamErrorKind(input: {
  message: string;
  status?: number;
  code?: string;
  headers: Record<string, string>;
}): ProviderStreamErrorKind {
  const message = input.message;
  const code = input.code ?? "";
  if (looksLikeGatewayChallenge(input.headers, message)) return "gateway-challenge";
  if (input.status === 429 || /rate[_\s-]*limit|too many requests/i.test(`${message} ${code}`)) return "rate-limit";
  if (input.status === 402 || /insufficient[_\s-]*(quota|balance|credit)|quota exceeded/i.test(message)) return "quota";
  if (input.status === 401 || input.status === 403 || /unauthorized|forbidden|invalid api key|authentication/i.test(message)) return "auth";
  if (input.status !== undefined && isEndpointUnavailableStatus(input.status)) return "endpoint-unavailable";
  if (input.status === 400 || input.status === 422 || /schema|invalid request|validation/i.test(message)) return "schema";
  if (input.status !== undefined && isRetryableServerStatus(input.status)) return "server";
  if (/timeout|timed out/i.test(`${message} ${code}`)) return "timeout";
  if (/aborted|abort|cancelled|canceled/i.test(`${message} ${code}`)) return "cancelled";
  if (/network|fetch failed|econnreset|enotfound|socket|tls/i.test(`${message} ${code}`)) return "network";
  return "unknown";
}

function defaultRetryableForProviderStreamError(kind: ProviderStreamErrorKind): boolean {
  if (kind === "network" || kind === "rate-limit" || kind === "server" || kind === "timeout") return true;
  return false;
}

function looksLikeGatewayChallenge(headers: Record<string, string>, message: string): boolean {
  const mitigated = headers["cf-mitigated"] ?? "";
  const server = headers.server ?? "";
  return (
    /challenge/i.test(mitigated) ||
    (/cloudflare/i.test(server) && /challenge|just a moment|cf_chl|challenge-platform|enable javascript/i.test(message)) ||
    /cf_chl|challenge-platform|just a moment|enable javascript and cookies/i.test(message)
  );
}

function isEndpointUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 415;
}

function isRetryableServerStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 520 || status === 522 || status === 523 || status === 524;
}

function providerStreamErrorKindField(value: unknown): ProviderStreamErrorKind | undefined {
  if (typeof value !== "string") return undefined;
  return providerStreamErrorKinds.includes(value as ProviderStreamErrorKind) ? (value as ProviderStreamErrorKind) : undefined;
}

function providerStreamErrorPhaseField(value: unknown): ProviderDiagnostic["phase"] | "stream" | undefined {
  if (value === "stream") return "stream";
  if (typeof value !== "string") return undefined;
  return providerDiagnosticPhases.includes(value as ProviderDiagnostic["phase"]) ? (value as ProviderDiagnostic["phase"]) : undefined;
}

function headersRecord(value: unknown): Record<string, string> {
  if (value instanceof Headers) {
    return Object.fromEntries([...value.entries()].map(([key, headerValue]) => [key.toLowerCase(), headerValue]));
  }
  const record = objectRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, headerValue]) => [key.toLowerCase(), headerValue])
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

const providerStreamErrorKinds: readonly ProviderStreamErrorKind[] = [
  "network",
  "gateway-challenge",
  "rate-limit",
  "auth",
  "quota",
  "endpoint-unavailable",
  "schema",
  "server",
  "unknown",
  "timeout",
  "cancelled",
  "invalid-stream",
  "invalid-tool-call"
];

const providerDiagnosticPhases: readonly ProviderDiagnostic["phase"][] = [
  "request-start",
  "response-start",
  "sse-first-byte",
  "retry",
  "request-error",
  "stream-end",
  "endpoint-fallback",
  "transport-fallback",
  "model-selected",
  "model-mismatch"
];
