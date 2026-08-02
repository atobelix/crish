import type { StreamCallbacks } from '../chatApi';
import { formatRunFailureForUi, recordStreamDiag } from '../streamDiag';
import {
  assistantBubbleForFailure,
  classifySoftFailure,
  logInternalError,
  softFailureMessage,
} from '../userFacingErrors';

/**
 * Surface stream failures: classify soft vs hard errors, format user-facing messages,
 * record diagnostic logs, and dispatch via StreamCallbacks.
 */
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
