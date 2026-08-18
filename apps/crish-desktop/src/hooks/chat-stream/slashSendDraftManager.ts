/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendDraftManager.ts
 * 负责输入框草稿快照抓取、失败原子回滚、草稿提交与乐观消息撤销（单一职责叶）
 */
import { getCompositionRoot } from '../../app/compositionRoot';
import { getSessionById } from '../../store/sessionStore';
import { isPendingDraft } from '../../store/draftSession';
import { commitDraftIfNeeded } from '../../api/storeAccess';
import { deriveSessionTitle } from '../../api/sessionTitle';
import { resolveStreamSessionId } from './helpers';

export interface DraftSnapshot {
  sessionId: string;
  rawText: string;
  timestamp: number;
}

const draftSnapshots = new Map<string, DraftSnapshot>();

/**
 * 发送前记录草稿快照
 */
export function saveDraftSnapshot(sessionId: string, rawText: string): void {
  if (!sessionId) return;
  draftSnapshots.set(sessionId, {
    sessionId,
    rawText,
    timestamp: Date.now(),
  });
}

/**
 * 发送失败时原子还原输入框文本与 Session 草稿
 */
export function restoreDraftOnFailure(
  sessionId: string,
  setChatInput: (val: string) => void,
  fallbackText?: string
): void {
  const snapshot = draftSnapshots.get(sessionId);
  const textToRestore = snapshot?.rawText ?? fallbackText ?? '';
  if (!textToRestore) return;

  setChatInput(textToRestore);
  try {
    getCompositionRoot()
      .session.getState()
      .setComposerDraft(sessionId, textToRestore);
  } catch (err) {
    console.warn('[slashSendDraftManager] failed to set composer draft:', err);
  }
}

/**
 * 恢复草稿（restoreDraftOnFailure 统一别名）
 */
export function restoreChatDraft(
  sessionId: string,
  setChatInput: (val: string) => void,
  fallbackText?: string
): void {
  restoreDraftOnFailure(sessionId, setChatInput, fallbackText);
}

/**
 * 撤回乐观插入的孤儿用户消息
 */
export function rollbackOptimisticMessage(
  wsId: string,
  sessionId: string,
  userMsgId: string
): void {
  if (!sessionId || !userMsgId) return;
  try {
    getCompositionRoot()
      .session.getState()
      .withdrawMessage(wsId, sessionId, userMsgId);
  } catch (err) {
    console.warn('[slashSendDraftManager] failed to withdraw message:', err);
  }
}

/**
 * 成功发送后清理草稿与快照
 */
export function clearDraftSnapshot(
  sessionId: string,
  setChatInput: (val: string) => void
): void {
  draftSnapshots.delete(sessionId);
  setChatInput('');
  try {
    getCompositionRoot().session.getState().setComposerDraft(sessionId, '');
  } catch {
    /* swallow-ok */
  }
}

/**
 * 撤回回填（R1 统一输入流收敛战役 · 详案 §1.2-⑥）：从 boundary user 节点
 * 原文取回文本回填 composer——**不依赖 draft 快照**（成功发送后
 * clearDraftSnapshot 已清，快照不可用）。
 *
 * 数据源保证：`timeline-truncate.targetMessageId` 对应的 user 节点
 * （事件流 message-start 内 payload message.id == targetMessageId）→
 * 取其 text（不变量 1「一切皆文本」）。
 *
 * 附件恢复（详案 §1.2-⑥）：V1 仅回填文本；user 节点附件 meta 的
 * setAttachments 恢复登记为后续增强（SessionMessage 不承载附件元数据，
 * 展示投影层 V1 承载）。
 */
export function backfillFromBoundaryText(
  sessionId: string,
  text: string,
  setChatInput: (val: string) => void
): void {
  if (!sessionId || !text) return;
  setChatInput(text);
  try {
    getCompositionRoot().session.getState().setComposerDraft(sessionId, text);
  } catch (err) {
    console.warn('[slashSendDraftManager] failed to set composer draft:', err);
  }
}

/**
 * 草稿 → 真会话：commit 后补建 shell tab + 绑 chat leaf
 */
export function commitDraftAndOpenShell(opts?: {
  title?: string;
  folder?: string;
}): string {
  const newId = commitDraftIfNeeded(opts);
  if (!newId || isPendingDraft(newId)) return newId;
  const shell = getCompositionRoot().shell.getState();
  if (!shell.openTabs.some((t) => t.sessionId === newId)) {
    const sess = getSessionById(newId);
    getCompositionRoot().session.openOrFocusSession(newId, {
      title: sess?.title,
    });
  }
  return newId;
}

/**
 * 解析并获取合法 sessionId（草稿/脏 active → mint + 补 shell tab；已有真 active → 原样）
 */
export function resolveTargetSessionId(
  activeSessionId: string | null | undefined,
  rawInput?: string
): string {
  let sessionId = '';
  if (isPendingDraft(activeSessionId)) {
    sessionId = commitDraftAndOpenShell({
      title: rawInput ? deriveSessionTitle(rawInput) : undefined,
    });
  } else {
    sessionId = resolveStreamSessionId(null, activeSessionId) || '';
    if (!sessionId) {
      sessionId = commitDraftAndOpenShell();
    }
  }
  return resolveStreamSessionId(sessionId, null) || '';
}
