import { MAX_FOLDERS } from '@crish/shared-utils/browser';
import { isDemoMode } from '../../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../../api/projectStore';
import { EMPTY_SESSION_TITLE, prepareSessionsForUi, shellPruneKeepIds } from '../../api/sessionTitle';
import { nowIsoTimestamp } from '../../api/sessionTime';
import type { SessionState } from '../types';
import { getSessionById, getSessionIndex, reindexSessionsById, deleteSessionFromIndexed } from '../sessionIndex';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import { clearMessageSnapshots } from '../messageSnapshotsBridge';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from '../draftSession';
import type { SessionActions, SessionImmerSet, SessionStoreGet } from './types';
import {
  applyTitleIfDefault, normalizeWritableSessionTitle,
  pickFallbackActiveSessionId, dropTerminalForSession,
  pruneEmptyShellsInPlace, maybeAutoTitleSession,
} from './_shared';

export function createSessionCrudActions(
  set: SessionImmerSet,
  get: SessionStoreGet,
): Pick<SessionActions, 'setActiveSessionId' | 'setSessions' | 'enterDraftMode' | 'setDraftFolder' | 'clearDraft' | 'commitDraftIfNeeded' | 'createSession' | 'deleteSession' | 'renameSession'> {
  const actions: Pick<SessionActions, 'setActiveSessionId' | 'setSessions' | 'enterDraftMode' | 'setDraftFolder' | 'clearDraft' | 'commitDraftIfNeeded' | 'createSession' | 'deleteSession' | 'renameSession'> = {

    setSessions: (sessions) =>
      set((state) => {
        state.sessions = prepareSessionsForUi(sessions, state.activeSessionId || null);
        reindexSessionsById(state);
        for (const s of state.sessions) {
          if (s.folder && !state.folderOrder.includes(s.folder) && state.folderOrder.length < MAX_FOLDERS) {
            state.folderOrder.push(s.folder);
          }
        }
        if (state.activeSessionId && !state.sessionsById[state.activeSessionId]) {
          state.activeSessionId = '';
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
        }
        if (state.terminalBySession) {
          for (const tid of Object.keys(state.terminalBySession)) {
            if (!state.sessionsById[tid]) {
              delete state.terminalBySession[tid];
            }
          }
        }
      }),

    setActiveSessionId: (id) => {
      const nextId = typeof id === 'string' ? id : '';
      set((state) => {
        if (nextId && !isPendingDraft(nextId) && !getSessionById(state, nextId)) return;
        const same = state.activeSessionId === nextId;
        state.activeSessionId = nextId;
        if (!isPendingDraft(nextId)) {
          state.draftFolder = '';
        }
        if (!same) {
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = nextId ? state.terminalBySession[nextId] || [] : [];
        }
      });
      if (!isDemoMode() && nextId && !isPendingDraft(nextId)) {
        const sess = getSessionById(get(), nextId);
        if (sess) {
          void import('../../api/projectStore').then(({ activateWorkspaceForSessionFolder }) => {
            activateWorkspaceForSessionFolder(sess.folder);
          });
          if (!sess.hydratedFromEngine && (!sess.messages || sess.messages.length === 0)) {
            void import('../../api/sessionEventHydrate').then(({ hydrateSessionMessagesFromDaemon }) => {
              void hydrateSessionMessagesFromDaemon(nextId).then((res) => {
                if (!res.ok) return;
                set((state) => {
                  const s = getSessionById(state, nextId);
                  if (!s) return;
                  if (s.messages && s.messages.length > 0) {
                    s.hydratedFromEngine = true;
                    maybeAutoTitleSession(state, s);
                    return;
                  }
                  if (res.messages.length > 0) {
                    s.messages = res.messages;
                    s.timestamp = '远程';
                    maybeAutoTitleSession(state, s);
                  }
                  s.engineCursor = res.nextAfterSequence;
                  if (res.lastRunId) s.engineLastRunId = res.lastRunId;
                  s.hydratedFromEngine = true;
                });
              });
            });
          }
        }
      }
    },

    enterDraftMode: (folder) => {
      set((state) => {
        state.activeSessionId = PENDING_DRAFT_SESSION_ID;
        state.draftFolder = (typeof folder === 'string' && folder.trim()) || getActiveProjectId() || GENERAL_FOLDER || '';
        state.activeAgentId = null;
        state.panelAgentId = null;
        state.terminalLines = [];
      });
    },

    setDraftFolder: (folder) => {
      set((state) => {
        state.draftFolder = typeof folder === 'string' ? folder : '';
      });
    },

    clearDraft: () => {
      set((state) => {
        if (isPendingDraft(state.activeSessionId)) {
          state.activeSessionId = '';
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
        }
        state.draftFolder = '';
      });
    },

    commitDraftIfNeeded: (opts) => {
      const st = get();
      if (!isPendingDraft(st.activeSessionId)) {
        return st.activeSessionId && getSessionById(st, st.activeSessionId) ? st.activeSessionId : '';
      }
      const folder = opts?.folder || st.draftFolder || getActiveProjectId() || GENERAL_FOLDER;
      return actions.createSession({ ...(opts?.title !== undefined ? { title: opts.title } : {}), ...(folder !== undefined ? { folder } : {}), activate: true });
    },

    renameSession: (sessionId, title) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const next = normalizeWritableSessionTitle(title);
        if (!next) return;
        if (sess.title === next) return;
        sess.title = next;
      }),

    createSession: (opts) => {
      const explicitId = opts?.id && typeof opts.id === 'string' ? opts.id.trim() : '';
      const activate = opts?.activate !== false;
      const requestedTitle = normalizeWritableSessionTitle(opts?.title);
      const initialTitle = requestedTitle || EMPTY_SESSION_TITLE;
      const id = explicitId || `sess-${Date.now()}`;
      set((state) => {
        const existing = getSessionById(state, id);
        if (existing) {
          const prevActive = state.activeSessionId;
          if (activate) {
            state.activeSessionId = id;
            state.activeAgentId = null;
            state.panelAgentId = null;
            state.terminalLines = state.terminalBySession[id] || [];
            state.draftFolder = '';
          }
          applyTitleIfDefault(existing, requestedTitle);
          pruneEmptyShellsInPlace(state, shellPruneKeepIds(id, prevActive, { activating: activate }));
          return;
        }
        const projectId = getActiveProjectId();
        const activeSess = state.activeSessionId ? getSessionById(state, state.activeSessionId) : null;
        const currentFolder = activeSess?.folder;
        const defaultFolder = isDemoMode()
          ? opts?.folder || '常规会话'
          : opts?.folder || currentFolder || state.draftFolder || projectId || GENERAL_FOLDER;
        const sess: SessionState = {
          id, title: initialTitle, folder: defaultFolder,
          isPinned: false, isArchived: false, timestamp: nowIsoTimestamp(), messages: [],
        };
        state.sessions.unshift(sess);
        reindexSessionsById(state);
        if (!state.folderOrder.includes(sess.folder) && state.folderOrder.length < MAX_FOLDERS) {
          state.folderOrder.unshift(sess.folder);
        }
        if (activate) {
          state.activeSessionId = id;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
          state.draftFolder = '';
        }
      });
      return id;
    },

    deleteSession: (sessionId) => {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return false;
      let removed = false;
      set((state) => {
        const idx = getSessionIndex(state, id);
        const wasActive = state.activeSessionId === id;
        const fallback = wasActive ? pickFallbackActiveSessionId(state, id, idx >= 0 ? idx : 0) : '';
        removed = deleteSessionFromIndexed(state, id);
        if (!removed) return;
        dropTerminalForSession(state, id);
        if (wasActive) {
          state.activeSessionId = fallback;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = fallback ? state.terminalBySession[fallback] || [] : [];
        }
        pruneEmptyShellsInPlace(state, shellPruneKeepIds(state.activeSessionId || null, null, { activating: true }));
      });
      if (removed) {
        sessionRuntimeRegistry.remove(id);
        clearMessageSnapshots(id);
      }
      return removed;
    },
  };

  return actions;
}


