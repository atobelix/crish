import type { StreamCallbacks } from '../../chatApi';
import { formatRunFailureForUi, recordStreamDiag } from '../../streamDiag';
import {
  assistantBubbleForFailure,
  classifySoftFailure,
  logInternalError,
  softFailureMessage,
} from '../../userFacingErrors';

export interface StreamState {
  cancelled: boolean;
  finished: boolean;
  assistantText: string;
  assistantThought: string;
  unsub: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Inventory #10 — degraded direct-fetch local abort only.
   * Set when `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` path starts HTTP SSE;
   * null on primary daemon WS. Cancel must invoke this (AbortController)
   * because L2/L3 run-control has no provider run on direct path.
   */
  transportAbort?: (() => void) | null;
}

export function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  // Do not auto-fire transportAbort here — cancel path owns abort + onComplete.
  state.transportAbort = null;
}

export function surfaceStreamFailure(
  raw: unknown,
  scope: string,
  callbacks: StreamCallbacks,
  runId: string
): void {
  logInternalError(scope, raw);
  const kind = classifySoftFailure(raw);
  const formatted = formatRunFailureForUi(raw, scope);
  let msg =
    softFailureMessage(kind) ??
    assistantBubbleForFailure(raw) ??
    formatted.message;
  if (/checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope)) {
    msg = formatted.message;
  }
  const detail = formatted.detail;
  recordStreamDiag({
    runId,
    scope,
    kind: kind || formatted.kindTag,
    message: msg,
    raw: detail,
  });
  if (callbacks.onRunError) {
    callbacks.onRunError(msg, kind || scope || 'ended', detail);
  }
}
