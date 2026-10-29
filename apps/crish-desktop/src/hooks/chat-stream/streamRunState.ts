import { isPendingDraft } from '../../store/draftSession';
import type { SessionMessage } from '../../store/types';

/** 运行中再发的产品动作（对齐 pi followUp / L1 soft_inject）。 */
export type SendWhileRunningAction = 'start' | 'follow_up';

export function resolveStreamSessionId(
  override?: string | null,
  activeId?: string | null
): string | null {
  const pick = (v?: string | null): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || isPendingDraft(t)) return null;
    return t;
  };
  return pick(override) ?? pick(activeId);
}

export function isLiveStreamRun(
  entry: { assistantMsgId: string } | null | undefined,
  assistantMsgId: string
): boolean {
  return (
    !!entry &&
    typeof assistantMsgId === 'string' &&
    assistantMsgId.length > 0 &&
    entry.assistantMsgId === assistantMsgId
  );
}

/**
 * 判定会话是否繁忙。
 *
 * 核心不变量（用户裁决）：若 hasLiveStream 为 false，禁止单凭历史消息判定 busy，
 * 避免残留 processing 死锁。
 */
export function isSessionAiBusy(opts: {
  hasLiveStream: boolean;
  messages?: Array<{ sender?: string; status?: string }> | null;
}): boolean {
  if (!opts.hasLiveStream) return false;
  const msgs = opts.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return true;
  return msgs.some(
    (m) => m.sender === 'assistant' && m.status === 'processing'
  );
}

/** 忙 → follow_up；闲 → start。永不返回 force abort。 */
export function decideSendWhileRunning(
  isAiBusy: boolean
): SendWhileRunningAction {
  return isAiBusy ? 'follow_up' : 'start';
}

/**
 * 安全调用 stream cancel。
 * @param mode cooperative=L2 / force=L3；省略则走 cancel 默认
 */
export function safeCancelStream(
  cancel:
    | ((opts?: { mode?: 'cooperative' | 'force' }) => void)
    | (() => void)
    | null
    | undefined,
  mode?: 'cooperative' | 'force'
): boolean {
  if (typeof cancel !== 'function') return false;
  try {
    if (mode) {
      (cancel as (opts?: { mode?: 'cooperative' | 'force' }) => void)({ mode });
    } else {
      (cancel as () => void)();
    }
    return true;
  } catch {
    return false;
  }
}

export function canStreamLocalSession(
  sessionId: string | null | undefined,
  sessionExists: boolean
): boolean {
  const id = resolveStreamSessionId(sessionId, null);
  return !!id && sessionExists === true;
}

/**
 * 停止时若无任何正文：返回 null（不写「已停止。」进气泡）。
 * 有正文则保留 partial；系统提示走 runNotice/toast。
 */
export function stopAssistantPlaceholderText(
  text: string | null | undefined
): string | null {
  return (text || '').trim() ? null : null;
}

export function ensureSessionMessages(
  sess: { messages?: SessionMessage[] | null } | null | undefined
): sess is { messages: SessionMessage[] } {
  if (!sess) return false;
  if (!Array.isArray(sess.messages)) sess.messages = [];
  return true;
}
