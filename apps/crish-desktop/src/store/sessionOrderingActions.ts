import {
  EMPTY_SESSION_TITLE,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionState } from './types';
import {
  getSessionById,
  getSessionIndex,
} from './sessionIndex';
import type { SessionActions, SessionStoreSlice, SessionImmerSet } from './sessionActions';
import {
  cloneMessages,
  normalizeWritableSessionTitle,
  pickFallbackActiveSessionId,
  pruneEmptyShellsInPlace,
} from './sessionSharedHelpers';

export function createSessionOrderingActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'pinSession'
  | 'unpinSession'
  | 'archiveSession'
  | 'unarchiveSession'
  | 'branchSession'
  | 'moveSessionRealtime'
  | 'moveFolderRealtime'
  | 'pinFolderSessions'
  | 'unpinFolderSessions'
> {
  return {
    pinSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (sess) sess.isPinned = true;
      }),

    unpinSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (sess) sess.isPinned = false;
      }),

    archiveSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (!sess || sess.isArchived) return;
        sess.isArchived = true;
        if (state.activeSessionId === sessionId) {
          const idx = getSessionIndex(state, sessionId);
          const fallback = pickFallbackActiveSessionId(
            state,
            sessionId,
            idx >= 0 ? idx : 0
          );
          state.activeSessionId = fallback;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = fallback
            ? state.terminalBySession[fallback] || []
            : [];
          pruneEmptyShellsInPlace(
            state,
            shellPruneKeepIds(fallback || null, null, { activating: true })
          );
        }
      }),

    unarchiveSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (!sess || !sess.isArchived) return;
        sess.isArchived = false;
      }),

    branchSession: (sessionId: string, newTitle: string) =>
      set((state) => {
        if (!sessionId) return;
        const original = getSessionById(state, sessionId);
        if (!original) return;

        const title =
          normalizeWritableSessionTitle(newTitle) ||
          normalizeWritableSessionTitle(original.title) ||
          EMPTY_SESSION_TITLE;

        const newSess: SessionState = {
          id: `sess-branch-${Date.now()}`,
          title,
          folder: original.folder,
          isPinned: false,
          isArchived: false,
          branchParentId: sessionId,
          timestamp: nowIsoTimestamp(),
          timestampSource: 'local',
          messages: original.messages ? cloneMessages(original.messages) : [],
          ...(original.pinnedMessageIds?.length
            ? { pinnedMessageIds: [...original.pinnedMessageIds] }
            : {}),
        };
        const idx = getSessionIndex(state, sessionId);
        if (idx < 0) {
          state.sessions.unshift(newSess);
        } else {
          state.sessions.splice(idx + 1, 0, newSess);
        }
        state.sessionsById[newSess.id] = newSess;
        state.activeSessionId = newSess.id;
        state.activeAgentId = null;
        state.panelAgentId = null;
        state.terminalLines = [];
        pruneEmptyShellsInPlace(
          state,
          shellPruneKeepIds(newSess.id, null, { activating: true })
        );
      }),

    moveSessionRealtime: (
      sessionId: string,
      targetSessionId: string | null,
      targetFolder: string,
      isPinned: boolean
    ) =>
      set((state) => {
        const sessIdx = getSessionIndex(state, sessionId);
        if (sessIdx === -1) return;

        const removed = state.sessions.splice(sessIdx, 1);
        const sess = removed[0];
        if (!sess) return;
        sess.isPinned = isPinned;
        sess.folder = targetFolder;

        if (targetSessionId) {
          const tIdx = getSessionIndex(state, targetSessionId);
          if (tIdx !== -1) {
            state.sessions.splice(tIdx, 0, sess);
          } else {
            state.sessions.push(sess);
          }
        } else {
          state.sessions.push(sess);
        }
        state.sessionsById[sess.id] = sess;
      }),

    moveFolderRealtime: (
      folderName: string,
      targetFolderName: string | null
    ) =>
      set((state) => {
        const idx = state.folderOrder.indexOf(folderName);
        if (idx === -1) return;
        state.folderOrder.splice(idx, 1);
        if (targetFolderName) {
          const tIdx = state.folderOrder.indexOf(targetFolderName);
          if (tIdx !== -1) {
            state.folderOrder.splice(tIdx, 0, folderName);
          } else {
            state.folderOrder.push(folderName);
          }
        } else {
          state.folderOrder.push(folderName);
        }
      }),

    pinFolderSessions: (folderName: string) =>
      set((state) => {
        state.sessions.forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = true;
          }
        });
      }),

    unpinFolderSessions: (folderName: string) =>
      set((state) => {
        state.sessions.forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = false;
          }
        });
      }),
  };
}
