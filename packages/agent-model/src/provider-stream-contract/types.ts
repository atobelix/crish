import type {
  JsonObject,
  ProviderDiagnostic,
  ProviderErrorKind,
} from '@crish/shared-types';
import type { ProviderUsage } from '@crish/shared-types';

export type ProviderStreamEnvelopeType =
  'start' | 'delta' | 'tool-call' | 'end' | 'done' | 'error';
export type ProviderStreamFinishReason =
  'stop' | 'tool-call' | 'length' | 'error' | 'cancelled' | 'unknown';
export type ProviderStreamErrorKind =
  | ProviderErrorKind
  | 'timeout'
  | 'cancelled'
  | 'invalid-stream'
  | 'invalid-tool-call';

export interface ProviderStreamEnvelopeBase {
  type: ProviderStreamEnvelopeType;
  sequence: number;
  streamId?: string;
  providerId?: string;
  metadata?: JsonObject;
}

export interface ProviderStreamStartEvent extends ProviderStreamEnvelopeBase {
  type: 'start';
  model?: string;
}

export type ProviderStreamDelta =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string; redacted?: boolean }
  | { type: 'diagnostic'; diagnostic: ProviderDiagnostic }
  | { type: 'custom'; data: JsonObject; description?: string };

export interface ProviderStreamDeltaEvent extends ProviderStreamEnvelopeBase {
  type: 'delta';
  delta: ProviderStreamDelta;
}

export type ProviderStreamToolCallPhase = 'start' | 'delta' | 'end';

export interface ProviderStreamToolCall {
  id: string;
  index: number;
  toolName: string;
  argumentsText: string;
  input?: JsonObject;
}

export interface ProviderStreamToolCallEvent extends ProviderStreamEnvelopeBase {
  type: 'tool-call';
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
  phase?: ProviderDiagnostic['phase'] | 'stream';
}

export interface ProviderStreamErrorEvent extends ProviderStreamEnvelopeBase {
  type: 'error';
  error: ProviderStreamProviderError;
}

export interface ProviderStreamEndEvent extends ProviderStreamEnvelopeBase {
  type: 'end';
  finishReason: ProviderStreamFinishReason;
  usage?: ProviderUsage;
  error?: ProviderStreamProviderError;
}

export interface ProviderStreamDoneEvent extends ProviderStreamEnvelopeBase {
  type: 'done';
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
  | Omit<ProviderStreamStartEvent, 'sequence'>
  | Omit<ProviderStreamDeltaEvent, 'sequence'>
  | Omit<ProviderStreamToolCallEvent, 'sequence'>
  | Omit<ProviderStreamEndEvent, 'sequence'>
  | Omit<ProviderStreamDoneEvent, 'sequence'>
  | Omit<ProviderStreamErrorEvent, 'sequence'>;

export interface ProviderStreamSequenceOptions {
  initialSequence?: number;
  streamId?: string;
  providerId?: string;
}

export interface ProviderStreamSequencer {
  next(event: ProviderStreamContractEventInput): ProviderStreamContractEvent;
  current(): number;
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
  flush(
    identity?: ProviderStreamCoalescingIdentity
  ): ProviderStreamContractEvent[];
  flushExpired(now?: number): ProviderStreamContractEvent[];
  timeUntilNextFlush(now?: number): number | undefined;
}

export const DEFAULT_PROVIDER_STREAM_DELTA_COALESCING_OPTIONS = {
  maxDelayMs: 5,
  maxChars: 2048,
  maxEvents: 32,
} as const satisfies Required<
  Omit<ProviderStreamDeltaCoalescingOptions, 'now'>
>;

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

export type ProviderToolCallJsonRepairStatus = 'valid' | 'repaired' | 'invalid';

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
  phase?: ProviderDiagnostic['phase'] | 'stream';
  errorKind?: ProviderStreamErrorKind;
}
