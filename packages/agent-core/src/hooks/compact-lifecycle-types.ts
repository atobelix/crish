/**
 * Context compact lifecycle — shared event contract (W6-8).
 *
 * Extracted from `compact-lifecycle.ts` so that `lifecycle-hooks.ts`
 * (which owns `LifecycleHookRegistry`) and `compact-lifecycle.ts`
 * (which owns the emit helpers) can both depend on this neutral type
 * module without forming a file-level cycle.
 *
 *   compact-lifecycle-types.ts   ← (no imports from either file)
 *        ↑                ↑
 *        │                │
 * compact-lifecycle.ts   lifecycle-hooks.ts
 *        │                ↑
 *        └────────────────┘  (LifecycleHookRegistry import, one-directional)
 *
 * @see docs/hooks.md
 */

import type { ContextCompressionTrigger } from '@crish/shared-types';

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
