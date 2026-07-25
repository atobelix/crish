import { sanitizeSessionTitleText, truncateSessionTitle, isDefaultSessionTitle, isEmptyShellSession, pruneEmptyShellSessions, maybeAutoTitleFromMessages } from '../../api/sessionTitle';
import { getSessionById, reindexSessionsById, type SessionsIndexed } from '../sessionIndex';
import type { SessionMessage, SessionAgent, SessionState, MessageToolCall } from '../types';
import type { SessionStoreSlice } from './types';

const MANUAL_SESSION_TITLE_MAX_LEN = 48;

export function getMessageById(
  messages: SessionMessage[] | undefined,
  messageId: string,
): SessionMessage | undefined {
  return messages?.find((m) => m.id === messageId);
}

export function getSessionMessage(
  state: SessionsIndexed,
  sessionId: string,
  messageId: string,
): { session: SessionState; message: SessionMessage } | undefined {
  const session = getSessionById(state, sessionId);
  if (!session?.messages) return undefined;
  const message = getMessageById(session.messages, messageId);
  if (!message) return undefined;
  return { session, message };
}

export function getSessionAgent(
  session: SessionState,
  agentId: string,
): SessionAgent | undefined {
  return session.agents?.find((a) => a.id === agentId);
}

export function toolCallPatchHasChanges(
  tc: MessageToolCall,
  updates: Partial<MessageToolCall>,
): boolean {
  for (const key of Object.keys(updates) as Array<keyof MessageToolCall>) {
    if (tc[key] !== updates[key]) return true;
  }
  return false;
}

export function normalizeWritableSessionTitle(
  raw: string | null | undefined,
  maxLen: number = MANUAL_SESSION_TITLE_MAX_LEN,
): string | null {
  const cleaned = sanitizeSessionTitleText(raw);
  if (!cleaned) return null;
  return truncateSessionTitle(cleaned, maxLen);
}

export function applyTitleIfDefault(
  sess: SessionState,
  rawTitle: string | null | undefined,
): void {
  if (rawTitle == null) return;
  if (!isDefaultSessionTitle(sess.title)) return;
  const next = normalizeWritableSessionTitle(rawTitle);
  if (next) sess.title = next;
}

export function pickFallbackActiveSessionId(
  state: SessionsIndexed,
  removedId: string,
  removedIndex: number,
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

  return (
    scanNeighbors(solid) ||
    scanAll(solid) ||
    scanNeighbors((s) => !s.isArchived) ||
    scanAll((s) => !s.isArchived) ||
    scanAll(() => true) ||
    ''
  );
}

export function dropTerminalForSession(
  state: SessionStoreSlice,
  sessionId: string,
): void {
  if (!sessionId) return;
  if (state.terminalBySession && sessionId in state.terminalBySession) {
    delete state.terminalBySession[sessionId];
  }
  if (state.activeSessionId === sessionId) {
    state.terminalLines = [];
  }
}

export function pruneEmptyShellsInPlace(
  state: SessionStoreSlice,
  keepIds: Iterable<string>,
): void {
  const pruned = pruneEmptyShellSessions(state.sessions, { keepIds });
  if (pruned !== state.sessions) {
    state.sessions = pruned;
    reindexSessionsById(state);
  }
  if (state.terminalBySession) {
    for (const tid of Object.keys(state.terminalBySession)) {
      if (!state.sessionsById[tid]) {
        delete state.terminalBySession[tid];
      }
    }
  }
}

export function maybeAutoTitleSession(
  state: SessionsIndexed,
  sess: SessionState,
): void {
  const existingTitles = state.sessions
    .filter((s) => s.id !== sess.id)
    .map((s) => s.title);
  const auto = maybeAutoTitleFromMessages(sess.title, sess.messages, {
    existingTitles,
    excludeTitle: sess.title,
  });
  if (auto) sess.title = auto;
}

export { MANUAL_SESSION_TITLE_MAX_LEN };
