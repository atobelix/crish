/**
 * Context compact lifecycle events (W6-8) — observe-only.
 *
 * Pi harness emits `session_before_compact` / `session_compact` around
 * AgentHarness.compact(). Conex mirrors that as lifecycle hooks:
 *
 *   context.compact.start  — about to run ContextCompressor
 *   context.compact.end    — compression finished or aborted
 *
 * These are **observe-only**: callers must not use on() results for control
 * (no cancel/block/stop). Use AgentEvent `context-compression-*` for UI
 * streams; use these hooks for in-process telemetry / health / spans.
 *
 * Kept in a separate file so LifecycleHookRegistry core (turn/tool) can
 * evolve independently (e.g. W5-5). Types are merged into
 * LifecycleEventType via lifecycle-hooks.ts re-export.
 *
 * Wire point: ContextCompressionGate.maybeCompress → emit helpers below.
 * Session-loop prepare-turn + payload-recovery both go through the gate.
 *
 * @see docs/hooks.md
 * @see reference/pi/packages/agent/src/harness/agent-harness.ts compact()
 */

import type { ContextCompressionRecord, ContextCompressionTrigger } from '@crish/shared-types';
import type { LifecycleHookRegistry } from './lifecycle-hooks';

// ─── Event names ───────────────────────────────────────────

export const CONTEXT_COMPACT_START = 'context.compact.start' as const;
export const CONTEXT_COMPACT_END = 'context.compact.end' as const;

export type CompactLifecycleEventType =
  | typeof CONTEXT_COMPACT_START
  | typeof CONTEXT_COMPACT_END;

// ─── Payloads ──────────────────────────────────────────────

export interface ContextCompactStartPayload {
  sessionId: string;
  /** Compression trigger when known (auto / overflow / manual / …) */
  trigger?: ContextCompressionTrigger;
  /** Estimated tokens before compact (when known) */
  tokensBefore?: number;
  /** Message count at start */
  messageCount?: number;
  /** Policy reason when known */
  reason?: string;
}

export interface ContextCompactEndPayload {
  sessionId: string;
  /** true when skipped region / summarizer failed / threw */
  aborted: boolean;
  error?: string;
  trigger?: ContextCompressionTrigger;
  tokensBefore?: number;
  tokensAfter?: number;
  compressedMessageCount?: number;
  keptMessageCount?: number;
  /** ContextCompressionRecord.id when success */
  compactionId?: string;
  /** Wall time for this compact attempt (ms) */
  durationMs?: number;
}

export type CompactLifecyclePayloadMap = {
  'context.compact.start': ContextCompactStartPayload;
  'context.compact.end': ContextCompactEndPayload;
};

// ─── Emit helpers (observe-only convenience) ───────────────

/**
 * Emit context.compact.start. Failures inside observe handlers are swallowed
 * by LifecycleHookRegistry; this helper never throws for hook errors.
 */
export async function emitContextCompactStart(
  registry: LifecycleHookRegistry,
  payload: ContextCompactStartPayload,
): Promise<void> {
  await registry.emit(CONTEXT_COMPACT_START, payload);
}

/**
 * Emit context.compact.end (success or abort).
 */
export async function emitContextCompactEnd(
  registry: LifecycleHookRegistry,
  payload: ContextCompactEndPayload,
): Promise<void> {
  await registry.emit(CONTEXT_COMPACT_END, payload);
}

/** Build end payload from a successful ContextCompressionRecord. */
export function contextCompactEndFromRecord(
  sessionId: string,
  record: ContextCompressionRecord,
  options?: { durationMs?: number },
): ContextCompactEndPayload {
  return {
    sessionId,
    aborted: false,
    trigger: record.trigger,
    tokensBefore: record.tokensBefore,
    tokensAfter: record.tokensAfter,
    compressedMessageCount: record.compressedMessageIds.length,
    keptMessageCount: record.keptMessageIds.length,
    compactionId: record.id,
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
  };
}

/** Build end payload for aborted / failed compact. */
export function contextCompactEndAborted(
  sessionId: string,
  options?: {
    error?: string;
    trigger?: ContextCompressionTrigger;
    tokensBefore?: number;
    durationMs?: number;
  },
): ContextCompactEndPayload {
  return {
    sessionId,
    aborted: true,
    ...(options?.error !== undefined ? { error: options.error } : {}),
    ...(options?.trigger !== undefined ? { trigger: options.trigger } : {}),
    ...(options?.tokensBefore !== undefined ? { tokensBefore: options.tokensBefore } : {}),
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
  };
}
