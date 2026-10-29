import {
  EMPTY_SESSION_TITLE,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionState } from './types';
import {
  getSessionById,
  getSessionIndex,
  insertSessionAt,
  listSessions,
} from './sessionIndex';
import type { SessionActions, SessionStoreSlice, SessionImmerSet } from './sessionActions';
import {
  cloneMessages,
  normalizeWritableSessionTitle,
  pickFallbackActiveSessionId,
  pruneEmptyShellsInPlace,
  syncActiveTerminalSession,
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
        if (!sess) return;
        sess.isPinned = true;
        // 移到顺序顶部，置顶区稳定「最近 pin 在上」
        insertSessionAt(state, sess, 0);
      }),

    unpinSession: (sessionId: string) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        // 仅取消置顶，folder 保持原样，由 groupUnpinnedByProject 归入项目/通用
        sess.isPinned = false;
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
          syncActiveTerminalSession(fallback);
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
        insertSessionAt(state, newSess, idx < 0 ? 0 : idx + 1);
        state.activeSessionId = newSess.id;
        state.activeAgentId = null;
        state.panelAgentId = null;
        syncActiveTerminalSession(newSess.id);
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
        const sess = getSessionById(state, sessionId);
        const sessIdx = getSessionIndex(state, sessionId);
        if (!sess || sessIdx === -1) return;
        state.sessionOrder.splice(sessIdx, 1);

        const folder =
          typeof targetFolder === 'string' && targetFolder.trim()
            ? targetFolder.trim()
            : sess.folder;
        sess.isPinned = isPinned;
        sess.folder = folder;

        // Insert before targetSessionId or after targetSessionId if prefixed with after:
        // null / missing / self → append.
        if (targetSessionId && targetSessionId !== sessionId) {
          const isAfter = targetSessionId.startsWith('after:');
          const cleanTargetId = isAfter
            ? targetSessionId.slice(6)
            : targetSessionId;

          const tIdx = getSessionIndex(state, cleanTargetId);
          if (tIdx !== -1) {
            state.sessionOrder.splice(isAfter ? tIdx + 1 : tIdx, 0, sess.id);
          } else {
            state.sessionOrder.push(sess.id);
          }
        } else {
          state.sessionOrder.push(sess.id);
        }
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
        listSessions(state).forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = true;
          }
        });
      }),

    unpinFolderSessions: (folderName: string) =>
      set((state) => {
        listSessions(state).forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = false;
          }
        });
      }),
  };
}
