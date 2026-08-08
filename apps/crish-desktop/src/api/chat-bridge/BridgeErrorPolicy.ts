import type { StreamCallbacks } from '../chatApi';
import { formatRunFailureForUi, recordStreamDiag } from '../streamDiag';
import {
  assistantBubbleForFailure,
  classifyErrorDomain,
  classifySoftFailure,
  domainUserMessage,
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
  // 差异化六域优先（03 §④）：S1-S6 命中 → 按域文案；未命中保留既有分类兼容
  //（auth/no_key/no_project/blocked/ended 走 softFailureMessage 原路径）
  const isCheckpoint =
    /checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope);
  const domain = isCheckpoint ? null : classifyErrorDomain(raw);
  const formatted = formatRunFailureForUi(raw, scope);
  let msg =
    (domain ? domainUserMessage(domain) : null) ??
    softFailureMessage(kind) ??
    assistantBubbleForFailure(raw) ??
    formatted.message;
  if (isCheckpoint) {
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
    // 展示面按 kind、文案按域：域命中统一归 'network' kind（T-1 分级分发 →
    // 持久条面），不破坏既有分发逻辑；未命中保留原分类 kind
    callbacks.onRunError(
      msg,
      domain ? 'network' : kind || scope || 'ended',
      detail
    );
  }
}
