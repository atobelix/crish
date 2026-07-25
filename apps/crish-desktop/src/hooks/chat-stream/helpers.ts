import type { SessionMessage } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import {
  updateMessageText,
} from '../../api/storeAccess';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { parseMarkdownToHtmlAsync } from '../../api/markdownRenderAsync';
import { isPendingDraft } from '../../store/draftSession';
import type { TerminalToolReason, TerminalToolPatch } from './types';

type PublishToolDiffsFn = typeof import('../../api/publishToolDiffs').publishToolDiffs;
let _publishToolDiffs: PublishToolDiffsFn | null = null;
let _publishToolDiffsLoading: Promise<PublishToolDiffsFn> | null = null;

function preloadPublishToolDiffs(): void {
  if (_publishToolDiffs || _publishToolDiffsLoading) return;
  _publishToolDiffsLoading = import('../../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      return m.publishToolDiffs;
    })
    .catch(() => {
      _publishToolDiffsLoading = null;
      return null as unknown as PublishToolDiffsFn;
    });
}

function publishToolDiffsLazy(files: Parameters<PublishToolDiffsFn>[0]): void {
  if (_publishToolDiffs) {
    _publishToolDiffs(files);
    return;
  }
  void import('../../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      m.publishToolDiffs(files);
    })
    .catch(() => { /* ignore */ });
}

export function scheduleFinalMarkdownHtml(
  sessionId: string,
  messageId: string,
  fullText: string
): void {
  const cleaned = stripThoughtPlaceholders(fullText || '');
  if (!cleaned.trim()) return;
  void parseMarkdownToHtmlAsync(cleaned)
    .then((html) => {
      if (!html) return;
      const msg = getSessionById(sessionId)?.messages?.find(
        (m: SessionMessage) => m.id === messageId
      );
      if (!msg) return;
      const now = msg.text || '';
      const nowClean = stripThoughtPlaceholders(now);
      if (nowClean !== cleaned && now !== cleaned && now !== fullText) return;
      const textToKeep = nowClean === cleaned ? now || cleaned : cleaned;
      updateMessageText(sessionId, messageId, textToKeep, html);
    })
    .catch(() => { /* Worker fail: AsyncMarkdown sync fallback */ });
}

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

export function safeCancelStream(
  cancel: (() => void) | null | undefined
): boolean {
  if (typeof cancel !== 'function') return false;
  try {
    cancel();
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

export function stopAssistantPlaceholderText(
  text: string | null | undefined
): string | null {
  return (text || '').trim() ? null : '已停止。';
}

export function buildTerminalToolPatches(
  toolCalls:
    Array<{ id: string; status?: string; output?: string }> | null | undefined,
  reason: TerminalToolReason
): TerminalToolPatch[] {
  if (!toolCalls?.length) return [];
  const out: TerminalToolPatch[] = [];
  for (const tc of toolCalls) {
    if (!tc?.id) continue;
    if (tc.status !== 'running' && tc.status !== 'pending_approval') continue;
    const existing = (tc.output || '').trim();
    if (reason === 'stop') {
      out.push({ id: tc.id, status: 'error', output: existing || '已停止' });
      continue;
    }
    if (tc.status === 'pending_approval') {
      out.push({
        id: tc.id,
        status: 'error',
        output: existing || (reason === 'error' ? '运行失败时仍待确认' : '回合结束时仍待确认'),
      });
      continue;
    }
    const placeholder = !existing || /^(执行中|运行中)…?$/.test(existing);
    const fallback = reason === 'error'
      ? '运行失败时工具未返回结果'
      : '回合结束时工具未返回结果';
    out.push({
      id: tc.id,
      status: 'error',
      output: placeholder ? fallback : existing,
    });
  }
  return out;
}

export function ensureSessionMessages(
  sess: { messages?: SessionMessage[] | null } | null | undefined
): sess is { messages: SessionMessage[] } {
  if (!sess) return false;
  if (!Array.isArray(sess.messages)) sess.messages = [];
  return true;
}

export { preloadPublishToolDiffs, publishToolDiffsLazy };
