import type { SessionMessage } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import {
  updateMessageText,
  updateMessageThinking,
} from '../../api/storeAccess';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { parseMarkdownToHtmlAsync } from '../../api/markdownRenderAsync';
import { isPendingDraft } from '../../store/draftSession';
import { useLayoutStore } from '../../store/layoutStore';
import {
  clearStream,
  clearStreamTools,
  getStreamText,
  getStreamThinking,
  getStreamTools,
  type StreamToolLive,
} from '../../store/streamingStore';
import type { MessageToolCall } from '../../store/types';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import type { TerminalToolReason, TerminalToolPatch } from './types';

type PublishToolDiffsFn = typeof import('../../api/publishToolDiffs').publishToolDiffs;
let _publishToolDiffs: PublishToolDiffsFn | null = null;
let _publishToolDiffsLoading: Promise<PublishToolDiffsFn | null> | null = null;

function preloadPublishToolDiffs(): void {
  if (_publishToolDiffs || _publishToolDiffsLoading) return;
  _publishToolDiffsLoading = import('../../api/publishToolDiffs')
    .then((m) => {
      _publishToolDiffs = m.publishToolDiffs;
      return m.publishToolDiffs;
    })
    .catch(() => {
      _publishToolDiffsLoading = null;
      return null;
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
  fullText: string,
  options?: {
    /** true = fullText 已由调用方预清理（N6 单次化，08-detail 3.3），不再二次 strip */
    preCleaned?: boolean;
  }
): void {
  // N6：complete 路径已预清理（onComplete 算一次 strip），本处不再重复；
  // 未预清理调用方（stop 等）保持原行为
  const cleaned = options?.preCleaned
    ? fullText || ''
    : stripThoughtPlaceholders(fullText || '');
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

/**
 * Apply one tool patch into session messages (immer once).
 * Merges any lite-store intermediate fields so success patches that omit
 * name/args still land a complete durable row.
 */
export function commitToolPatchToSession(
  sessionId: string,
  messageId: string,
  toolId: string,
  patch: StreamToolCallPatch | StreamToolLive
): void {
  const lite = getStreamTools(sessionId, messageId)?.[toolId];
  const store = useLayoutStore.getState();
  const existing = getSessionById(sessionId)
    ?.messages?.find((m) => m.id === messageId)
    ?.toolCalls?.find((t) => t.id === toolId);

  const name =
    patch.name || lite?.name || existing?.name || 'tool';
  const argumentsText =
    patch.arguments !== undefined
      ? patch.arguments
      : lite?.arguments !== undefined
        ? lite.arguments
        : existing?.arguments;
  const explanation =
    patch.explanation !== undefined
      ? patch.explanation
      : lite?.explanation !== undefined
        ? lite.explanation
        : existing?.explanation;
  const status = (patch.status ||
    lite?.status ||
    existing?.status ||
    'running') as MessageToolCall['status'];
  const output =
    patch.output !== undefined
      ? patch.output
      : lite?.output !== undefined
        ? lite.output
        : existing?.output;
  const approvalMeta =
    'approvalMeta' in patch && patch.approvalMeta !== undefined
      ? patch.approvalMeta
      : lite?.approvalMeta !== undefined
        ? lite.approvalMeta
        : existing?.approvalMeta;
  const diffs =
    'diffs' in patch && patch.diffs !== undefined
      ? patch.diffs
      : existing?.diffs;
  const startedAt =
    'startedAt' in patch && patch.startedAt !== undefined
      ? patch.startedAt
      : lite?.startedAt !== undefined
        ? lite.startedAt
        : existing?.startedAt;

  if (existing) {
    const updates: Partial<MessageToolCall> = {};
    if (patch.name !== undefined || (!existing.name && name)) updates.name = name;
    if (argumentsText !== undefined) updates.arguments = argumentsText;
    if (explanation !== undefined) updates.explanation = explanation;
    if (status !== undefined) updates.status = status;
    if (output !== undefined) updates.output = output;
    if (approvalMeta !== undefined) updates.approvalMeta = approvalMeta;
    if (diffs !== undefined) updates.diffs = diffs;
    if (startedAt !== undefined) updates.startedAt = startedAt;
    store.updateMessageToolCall(sessionId, messageId, toolId, updates);
  } else {
    store.addMessageToolCall(sessionId, messageId, {
      id: toolId,
      name,
      arguments: argumentsText || '',
      status,
      ...(output !== undefined ? { output } : {}),
      ...(explanation !== undefined ? { explanation } : {}),
      ...(approvalMeta !== undefined ? { approvalMeta } : {}),
      ...(diffs !== undefined ? { diffs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
  }
}

/**
 * Flush remaining intermediate tools from streamingStore into session messages,
 * then clear the lite tools map (text/thinking left intact unless clearStream).
 */
export function commitStreamToolsToSession(
  sessionId: string,
  messageId: string
): void {
  const tools = getStreamTools(sessionId, messageId);
  if (!tools) return;
  for (const toolId of Object.keys(tools)) {
    const patch = tools[toolId];
    if (!patch) continue;
    commitToolPatchToSession(sessionId, messageId, toolId, patch);
  }
  clearStreamTools(sessionId, messageId);
}

/**
 * 将热路径 streamingStore 正文一次提交进会话消息（按 messageId update）。
 * 不 addMessage、不产生第二行同语义助手消息；提交后可选 clear 流缓冲。
 * 用于 complete / cancel / 需落盘的工具前快照。
 * Also commits any intermediate lite tools before clear.
 */
export function commitStreamToSession(
  sessionId: string,
  messageId: string,
  options?: {
    /** Override text (e.g. buffer.currentText / streamedFullText). */
    text?: string | null | undefined;
    /** When true, also commit thinking from streaming store. Default true. */
    commitThinking?: boolean;
    /** When true (default), also commit intermediate tools. */
    commitTools?: boolean;
    /** When true (default), clear streaming store entry after commit. */
    clear?: boolean;
  }
): string {
  if (options?.commitTools !== false) {
    commitStreamToolsToSession(sessionId, messageId);
  }
  const fromStore = getStreamText(sessionId, messageId) || '';
  // Prefer non-empty override; empty string falls through to streaming store.
  const text = (options?.text || fromStore || '');
  if (text) {
    updateMessageText(sessionId, messageId, text);
  }
  if (options?.commitThinking !== false) {
    const thinking = getStreamThinking(sessionId, messageId);
    if (thinking != null && thinking !== '') {
      updateMessageThinking(sessionId, messageId, thinking);
    }
  }
  if (options?.clear !== false) {
    clearStream(sessionId, messageId);
  }
  return text;
}

/**
 * Snapshot current stream text into the session store WITHOUT clearing the
 * streaming entry (UI keeps reading the live buffer). Used before tool
 * patches so streamTextOffset / blocks stay correct for interleaving.
 *
 * T4.2（R-05）：同值短路——streamText 与现有 msg.text 相同时跳过
 * updateMessageText（工具开始调用时文本常未变，避免无谓 messages 引用
 * 变更 → 全链重渲染）。
 */
export function snapshotStreamTextToSession(
  sessionId: string,
  messageId: string,
  fallbackText?: string
): string {
  const text =
    getStreamText(sessionId, messageId) ||
    fallbackText ||
    '';
  if (text) {
    const msg = getSessionById(sessionId)?.messages?.find(
      (m) => m.id === messageId
    );
    if (msg?.text !== text) {
      updateMessageText(sessionId, messageId, text);
    }
  }
  return text;
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

/**
 * 运行中再发的产品动作（对齐 pi followUp / L1 soft_inject）：
 * - start：空闲，立即开 stream
 * - follow_up：AI 忙，入队待 idle 交付，**禁止** abort 当前 stream
 *
 * 默认产品路径 = follow_up（等本轮结束再续），不是 force mid-stream 打断。
 * @see docs/architecture/run-control.md §1.1
 */
export type SendWhileRunningAction = 'start' | 'follow_up';

/** 是否判定 AI 忙：有 live stream，或时间线上仍有 processing 助手消息 */
export function isSessionAiBusy(opts: {
  hasLiveStream: boolean;
  messages?: Array<{ sender?: string; status?: string }> | null;
}): boolean {
  if (opts.hasLiveStream) return true;
  const msgs = opts.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return false;
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
 * @param mode cooperative=L2 / force=L3；省略则走 cancel 默认（兼容旧 () => void）
 */
export function safeCancelStream(
  cancel: ((opts?: { mode?: 'cooperative' | 'force' }) => void) | (() => void) | null | undefined,
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
  // 有真实 partial 则不替换；无正文也不再注入系统句到 assistant 消息
  return (text || '').trim() ? null : null;
}

export function buildTerminalToolPatches(
  toolCalls:
    | Array<{ id: string; status?: string | undefined; output?: string | undefined }>
    | null
    | undefined,
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
