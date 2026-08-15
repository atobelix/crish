import type { StreamCallbacks } from '../chatApi';
import { formatRunFailureForUi, recordStreamDiag } from '../streamDiag';
import {
  assistantBubbleForFailure,
  classifyErrorDomain,
  classifySoftFailure,
  domainUserMessage,
  logInternalError,
  normalizeErrorText,
  softFailureMessage,
} from '../userFacingErrors';

/**
 * per-run 失败去重（04 §5.1-4 / G6/R5）：同一 run 的同类失败只 surface 一次，
 * 后续重复仅保留 logInternalError（可观测），不再重复 recordStreamDiag / onRunError。
 * 键 = runId + 错误指纹（normalizeErrorText(raw)，空文本用 scope 兜底）——指纹
 * 不含 scope：run-terminal-failed 与 agent-end-error 等失败多源（同错误文本）
 * 也能互相收敛（R5 双源场景）；不同 run 互不污染。
 */
const failedRunFingerprints = new Map<string, Set<string>>();
/** 去重表上限：超出后淘汰最旧 run 的指纹（run 已收口，后续事件不会再来） */
const MAX_TRACKED_FAILED_RUNS = 100;

function failureFingerprint(raw: unknown, scope: string): string {
  const text = normalizeErrorText(raw).trim();
  return text || scope;
}

/** 返回 true 表示该 run+指纹已 surface 过（本次仅 logInternalError）；否则登记并返回 false */
function isFailedRunDeduplicated(runId: string, fingerprint: string): boolean {
  const bucket = failedRunFingerprints.get(runId);
  if (bucket) {
    if (bucket.has(fingerprint)) return true;
    bucket.add(fingerprint);
    return false;
  }
  if (failedRunFingerprints.size >= MAX_TRACKED_FAILED_RUNS) {
    const oldest = failedRunFingerprints.keys().next().value;
    if (oldest !== undefined) failedRunFingerprints.delete(oldest);
  }
  failedRunFingerprints.set(runId, new Set([fingerprint]));
  return false;
}

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

  // 1. 用户主动取消或正常收口：静默退出，绝不弹出错误提示
  const text = normalizeErrorText(raw);
  if (
    /aborted|stopped|ui-stop|ui-force-cancel|user-cancel/i.test(text) ||
    scope === 'ended'
  ) {
    return;
  }

  // 2. per-run 失败去重（04 §5.1-4 / G6/R5）：同 run 同指纹已 surface 过 →
  // 仅保留上面的 logInternalError（可观测），不再重复诊断与展示
  if (isFailedRunDeduplicated(runId, failureFingerprint(raw, scope))) {
    return;
  }
  const kind = classifySoftFailure(raw);
  // 差异化八域优先（03 §④ / S1-S8）：S1-S8 命中 → 按域文案；未命中保留既有分类兼容
  //（auth/no_key/no_project/blocked/ended 走 softFailureMessage 原路径）
  const isCheckpoint =
    /checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope);
  const domain = isCheckpoint ? null : classifyErrorDomain(raw);
  const formatted = formatRunFailureForUi(raw, scope);
  let msg =
    (domain ? domainUserMessage(domain) : null) ??
    softFailureMessage(kind, raw) ??
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
