import {
  EMPTY_SESSION_TITLE,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionState } from './types';
import {
  getSessionById,
  getSessionForWrite,
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
        // 走 sessions 数组下标，确保 immer 对 sessions 引用变更可被 useSidebarSessions 感知
        const idx = getSessionIndex(state, sessionId);
        if (idx < 0) return;
        const sess = state.sessions[idx]!;
        sess.isPinned = true;
        // 移到 sessions 顶部，置顶区稳定「最近 pin 在上」
        state.sessions.splice(idx, 1);
        state.sessions.splice(0, 0, sess);
        state.sessionsById[sess.id] = sess;
      }),

    unpinSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const idx = getSessionIndex(state, sessionId);
        if (idx < 0) return;
        const sess = state.sessions[idx]!;
        // 仅取消置顶，folder 保持原样，由 groupUnpinnedByProject 归入项目/通用
        sess.isPinned = false;
        state.sessionsById[sess.id] = sess;
      }),

    archiveSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionForWrite(state, sessionId);
        if (!sess || sess.isArchived) return;
        sess.isArchived = true;
        state.sessionsById[sessionId] = sess;
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
        const sess = getSessionForWrite(state, sessionId);
        if (!sess || !sess.isArchived) return;
        sess.isArchived = false;
        state.sessionsById[sessionId] = sess;
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

        const folder =
          typeof targetFolder === 'string' && targetFolder.trim()
            ? targetFolder.trim()
            : sess.folder;
        sess.isPinned = isPinned;
        sess.folder = folder;

        // Insert before targetSessionId; null / missing / self → append.
        // Callers throttle on (target, folder, isPinned) to limit mid-drag churn.
        if (targetSessionId && targetSessionId !== sessionId) {
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
