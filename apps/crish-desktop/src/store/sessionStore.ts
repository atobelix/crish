import { useEffect, useReducer, useRef } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from '../store/useShallowSelector';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withAutoIndex } from './autoIndexMiddleware';

import { seedSessions } from './layoutHelpers';
import { sanitizeSessionSeed } from './layoutStore';
import { sidebarSessionsEqual } from './sessionListEqual';
import type { SessionState, SessionAgent } from './types';
import type { SessionActions, SessionStoreSlice } from './sessionActions';
import { createSessionActions } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import {
  getSessionById as getSessionByIdFromIndex,
  getSessionIndex as getSessionIndexFromIndex,
  type SessionsIndexed,
} from './sessionIndex';

const _sessionSeed = sanitizeSessionSeed(seedSessions());

type SessionStoreData = SessionsIndexed & {
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  terminalBySession: Record<string, string[]>;
  terminalLines: string[];
};

type SessionStore = SessionStoreData & SessionActions;

const _sessionData: SessionStoreData = {
  sessions: _sessionSeed.sessions,
  sessionsById: _sessionSeed.sessionsById,
  folderOrder: _sessionSeed.folderOrder,
  activeSessionId: _sessionSeed.activeSessionId,
  activeAgentId: null,
  panelAgentId: null,
  composerDrafts: {},
  terminalBySession: {},
  terminalLines: [],
};

export const useSessionStore = create<SessionStore>()(
  withDevtools(
    withLogger(
      withAutoIndex(
        immer((set, get) => ({
          ..._sessionData,
          ...createSessionActions(set, get),
        })),
      ),
    ),
    'SessionStore',
  ),
);
export type SessionFacadeState = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  terminalBySession: Record<string, string[]>;
  terminalLines: string[];
};

export type SessionFacade = SessionFacadeState & SessionActions;

export const selectSessions = (s: Pick<SessionFacadeState, 'sessions'>) => s.sessions;

export const selectSessionsById = (s: Pick<SessionFacadeState, 'sessionsById'>) =>
  s.sessionsById;

export const selectActiveSessionId = (s: Pick<SessionFacadeState, 'activeSessionId'>) =>
  s.activeSessionId;

export const selectFolderOrder = (s: Pick<SessionFacadeState, 'folderOrder'>) =>
  s.folderOrder;

export const selectActiveAgentId = (s: Pick<SessionFacadeState, 'activeAgentId'>) =>
  s.activeAgentId;

export const selectPanelAgentId = (s: Pick<SessionFacadeState, 'panelAgentId'>) =>
  s.panelAgentId;

export const selectActiveSession = (
  s: Pick<SessionFacadeState, 'sessions' | 'sessionsById' | 'activeSessionId'>,
): SessionState | undefined => getSessionByIdFromIndex(s, s.activeSessionId);

export function useSessionField<T>(selector: (state: SessionFacade) => T): T {
  return useSessionStore(
    selector as (state: ReturnType<typeof useSessionStore.getState>) => T,
  );
}

export function useSidebarSessions(searching: boolean): SessionState[] {
  const equal = (a: SessionState[], b: SessionState[]) =>
    sidebarSessionsEqual(a, b, searching);
  const snapshotRef = useRef<SessionState[]>(useSessionStore.getState().sessions);
  if (searching || !equal(snapshotRef.current, useSessionStore.getState().sessions)) {
    snapshotRef.current = useSessionStore.getState().sessions;
  }
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  useEffect(() => {
    return useSessionStore.subscribe((state) => {
      const next = state.sessions;
      const eq = sidebarSessionsEqual(snapshotRef.current, next, searchingRef.current);
      if (!eq) {
        snapshotRef.current = next;
        bump();
      }
    });
  }, []);

  return snapshotRef.current;
}

export function useSessions(): SessionState[] {
  return useSessionStore(useShallow((s) => s.sessions));
}

export function useActiveSessionId(): string {
  return useSessionStore((s) => s.activeSessionId);
}

export function useActiveSession(): SessionState | undefined {
  return useSessionStore(useShallow(selectActiveSession));
}

export function useActiveAgentId(): string | null {
  return useSessionStore((s) => s.activeAgentId);
}

export function usePanelAgentId(): string | null {
  return useSessionStore((s) => s.panelAgentId);
}

export function getSessionStoreState(): SessionFacade {
  return useSessionStore.getState() as unknown as SessionFacade;
}

export function getSessionById(sessionId: string): SessionState | undefined {
  return getSessionByIdFromIndex(getSessionStoreState(), sessionId);
}

export function getActiveSession(): SessionState | undefined {
  const s = getSessionStoreState();
  return getSessionByIdFromIndex(s, s.activeSessionId);
}

export function getActiveSessionId(): string {
  return getSessionStoreState().activeSessionId;
}

export function getSessionIndex(sessionId: string): number {
  const state = getSessionStoreState();
  return state.sessions.findIndex((s) => s.id === sessionId);
}

export function getSessionAgent(
  sessionId: string,
  agentId: string,
): SessionAgent | undefined {
  const sess = getSessionById(sessionId);
  return sess?.agents?.find((a) => a.id === agentId);
}

export {
  getSessionById as getSessionByIdFromState,
  buildSessionsById,
  reindexSessionsById,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  findReusableEmptySession,
  isSessionEmpty,
} from './sessionIndex';

export type {
  SessionsIndexIssue,
  FilterSidebarSessionsOpts,
  PartitionSidebarSessionsOpts,
  PartitionedSidebarSessions,
} from './sessionIndex';

export {
  sessionShellEqual,
  sidebarSessionsEqual,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sessionShellFingerprint,
} from './sessionListEqual';

export type { SessionActions } from './sessionActions';
export type { SessionState, SessionAgent, SessionMessage } from './types';

import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
sessionRuntimeRegistry.registerActiveIdResolver(() => useSessionStore.getState().activeSessionId);
