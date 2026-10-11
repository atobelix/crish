import {
  isDefaultSessionTitle,
  isEmptyShellSession,
  autoTitleAssignment,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  truncateSessionTitle,
} from '../api/sessionTitle';
import { PENDING_DRAFT_SESSION_ID } from './draftSession';
import type { SessionState } from './types';
import { reindexSessionsById, type SessionsIndexed } from './sessionIndex';
import type { SessionStoreSlice } from './sessionActions';
import { useTerminalStore } from './terminalStore';

// 消息合并/补丁/upsert/truncate 等共享辅助拆出至子模块，hub 仅 re-export
export {
  getMessageById,
  getSessionMessage,
  getSessionAgent,
  toolCallPatchHasChanges,
  sanitizeToolCallUpdates,
  applyMessageToolCallPatch,
  applySessionAgentPatch,
  cloneMessages,
  isTerminalSessionMessageStatus,
  preferSessionMessageStatus,
  preferSessionMessageText,
  mergeSessionMessageFields,
  sortMessagesByOrder,
  upsertMessageById,
  truncateMessagesForAppend,
} from './sessionSharedHelpers.messageMerge';

/** 手动 rename / 分叉标题码点上限（略宽于侧栏自动标题 28） */
const MANUAL_SESSION_TITLE_MAX_LEN = 48;

/**
 * 是否应在 activate 时从引擎懒加载正文。
 *
 * 设计（非丢消息 bug）：
 * - 本地落盘 / SQLite hydrate 会带全量 messages（eager）
 * - daemon list-sessions 插入的远程壳只有 title，messages=[]（lazy）
 * - sessions[] 与 sessionsById 同引用；空 messages 两边同时可见
 * - setActiveSessionId 在 !hydratedFromEngine && messages 为空时拉 session-events
 *
 * 因此 MCP / 调试看到「有 title、messages.length===0」对未 activate 的远程壳是预期态。
 */
export function needsEngineMessageHydrate(
  sess: Pick<SessionState, 'hydratedFromEngine' | 'messages'> | null | undefined
): boolean {
  if (!sess) return false;
  if (sess.hydratedFromEngine) return false;
  return !sess.messages || sess.messages.length === 0;
}

export function normalizeWritableSessionTitle(
  raw: string | null | undefined,
  maxLen: number = MANUAL_SESSION_TITLE_MAX_LEN
): string | null {
  const cleaned = sanitizeSessionTitleText(raw);
  if (!cleaned) return null;
  return truncateSessionTitle(cleaned, maxLen);
}

export function applyTitleIfDefault(
  sess: SessionState,
  rawTitle: string | null | undefined
): void {
  if (rawTitle == null) return;
  if (sess.titleSource === 'user') return;
  if (!isDefaultSessionTitle(sess.title)) return;
  const next = normalizeWritableSessionTitle(rawTitle);
  if (next) sess.title = next;
}

export function pickFallbackActiveSessionId(
  state: SessionsIndexed,
  removedId: string,
  removedIndex: number
): string {
  const sessions = state.sessions;
  const isCandidate = (s: SessionState | undefined): s is SessionState =>
    Boolean(s && s.id && s.id !== removedId);

  const scanNeighbors = (pred: (s: SessionState) => boolean): string | null => {
    for (let i = removedIndex + 1; i < sessions.length; i++) {
      const s = sessions[i];
      if (isCandidate(s) && pred(s)) return s.id;
    }
    for (let i = removedIndex - 1; i >= 0; i--) {
      const s = sessions[i];
      if (isCandidate(s) && pred(s)) return s.id;
    }
    return null;
  };

  const scanAll = (pred: (s: SessionState) => boolean): string | null => {
    for (const s of sessions) {
      if (isCandidate(s) && pred(s)) return s.id;
    }
    return null;
  };

  const solid = (s: SessionState) => !s.isArchived && !isEmptyShellSession(s);

  // 不变量：删除活动会话后绝不允许 activeSessionId 落到空字符串
  // （否则会触发"暂无会话"空屏）。无任何后备时返回草稿哨兵，
  // 让 UI 进入"我们该在 X 中处理什么？"欢迎面。
  return (
    scanNeighbors(solid) ||
    scanAll(solid) ||
    scanNeighbors((s) => !s.isArchived) ||
    scanAll((s) => !s.isArchived) ||
    scanAll(() => true) ||
    PENDING_DRAFT_SESSION_ID
  );
}

export function dropTerminalForSession(
  state: SessionStoreSlice,
  sessionId: string
): void {
  void state;
  useTerminalStore.getState().removePtySession(sessionId);
}

export function syncActiveTerminalSession(_sessionId: string | null): void {
  // PTY runs directly in native PTY session
}

export function pruneEmptyShellsInPlace(
  state: SessionStoreSlice,
  keepIds: Iterable<string>
): void {
  const pruned = pruneEmptyShellSessions(state.sessions, { keepIds });
  if (pruned !== state.sessions) {
    state.sessions = pruned;
    reindexSessionsById(state);
  }
  useTerminalStore
    .getState()
    .pruneTerminalSessions(Object.keys(state.sessionsById));
}

export function maybeAutoTitleSession(
  _state: SessionsIndexed,
  sess: SessionState
): void {
  const assigned = autoTitleAssignment(
    sess.title,
    sess.messages,
    sess.titleSource
  );
  if (!assigned) return;
  sess.title = assigned.title;
  sess.titleSource = assigned.titleSource;
}
