/**
 * 会话域 facade — 与 useLayoutStore **同一 zustand 实例**（非独立 create）。
 * 权威状态与 actions 在 layoutStore + sessionActions；本文件只导出域 API。
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useShallow } from '../store/useShallowSelector';
import { useLayoutStore } from './layoutStore';
import { sidebarSessionsEqual } from './sessionListEqual';
import type {
  SessionState,
  SessionAgent,
  SessionMessage,
  SessionGoalTask,
  SessionGoalMode,
} from './types';
import type { SessionActions } from './sessionActions';
import { getSessionById as getSessionByIdFromIndex } from './sessionIndex';
import {
  resolveSessionProgressItems,
  computeChecklistProgress,
  findCurrentLiveTool,
  type ProgressSummary,
  type LiveToolInfo,
} from '../api/sessionProgressApi';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';

const EMPTY_AGENTS_ARRAY: SessionAgent[] = [];

/** 与 layout 同引用：切片式 facade，禁止第二份 sessions 真相源 */
export const useSessionStore = useLayoutStore;

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

export const selectSessions = (s: Pick<SessionFacadeState, 'sessions'>) =>
  s.sessions;

export const selectSessionsById = (
  s: Pick<SessionFacadeState, 'sessionsById'>
) => s.sessionsById;

export const selectActiveSessionId = (
  s: Pick<SessionFacadeState, 'activeSessionId'>
) => s.activeSessionId;

export const selectFolderOrder = (s: Pick<SessionFacadeState, 'folderOrder'>) =>
  s.folderOrder;

export const selectActiveAgentId = (
  s: Pick<SessionFacadeState, 'activeAgentId'>
) => s.activeAgentId;

export const selectPanelAgentId = (
  s: Pick<SessionFacadeState, 'panelAgentId'>
) => s.panelAgentId;

export const selectActiveSession = (
  s: Pick<SessionFacadeState, 'sessions' | 'sessionsById' | 'activeSessionId'>
): SessionState | undefined => getSessionByIdFromIndex(s, s.activeSessionId);

/**
 * 按会话 id + 消息 id 选择单条消息。
 *
 * 返回的是一个选择器函数（curried），便于配合 useShallow 在 hooks 中使用：
 *   ```ts
 *   const msg = useSessionField(useShallow(selectMessageById(sid, mid)));
 *   ```
 *
 * 找不到会话或消息时返回 undefined。返回 undefined 时 useShallow 不会触发重渲染。
 */
export function selectMessageById(
  sessionId: string,
  messageId: string
): (s: SessionFacade) => SessionMessage | undefined {
  return (s: SessionFacade): SessionMessage | undefined => {
    const session = getSessionByIdFromIndex(s, sessionId);
    if (!session) return undefined;
    return session.messages.find((m) => m.id === messageId);
  };
}

export function useSessionField<T>(selector: (state: SessionFacade) => T): T {
  return useSessionStore(
    selector as (state: ReturnType<typeof useSessionStore.getState>) => T
  );
}

export function useSidebarSessions(searching: boolean): SessionState[] {
  const equal = (a: SessionState[], b: SessionState[]) =>
    sidebarSessionsEqual(a, b, searching);
  const snapshotRef = useRef<SessionState[]>(
    useSessionStore.getState().sessions
  );
  if (
    searching ||
    !equal(snapshotRef.current, useSessionStore.getState().sessions)
  ) {
    snapshotRef.current = useSessionStore.getState().sessions;
  }
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  useEffect(() => {
    return useSessionStore.subscribe((state) => {
      const next = state.sessions;
      const eq = sidebarSessionsEqual(
        snapshotRef.current,
        next,
        searchingRef.current
      );
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

export function useSessionAgents(sessionId?: string | null): SessionAgent[] {
  return useSessionStore(
    useShallow((s) => {
      const id = sessionId || s.activeSessionId;
      return s.sessionsById[id]?.agents || EMPTY_AGENTS_ARRAY;
    })
  );
}

export function useSessionAgentById(
  agentId: string | null | undefined,
  sessionId?: string | null
): SessionAgent | undefined {
  return useSessionStore(
    useShallow((s) => {
      if (!agentId) return undefined;
      const parentId = sessionId || s.activeSessionId;
      const parentSess = parentId ? s.sessionsById[parentId] : undefined;
      const agentInParent = parentSess?.agents?.find((a: SessionAgent) => a.id === agentId);
      if (agentInParent) return agentInParent;
      for (const sess of Object.values(s.sessionsById)) {
        const a = sess.agents?.find((item: SessionAgent) => item.id === agentId);
        if (a) return a;
      }
      return undefined;
    })
  );
}

export function useActiveSessionProgress(): {
  items: SessionGoalTask[];
  progress: ProgressSummary;
  goalMode: SessionGoalMode | null;
  liveTool: LiveToolInfo | null;
} {
  const activeSession = useActiveSession();
  return useMemo(() => {
    const items = resolveSessionProgressItems(activeSession);
    const progress = computeChecklistProgress(items);
    const goalMode = activeSession?.goalMode?.active
      ? activeSession.goalMode
      : null;
    const liveTool = findCurrentLiveTool(activeSession);
    return {
      items,
      progress,
      goalMode,
      liveTool,
    };
  }, [activeSession]);
}

/**
 * 域投影：LayoutStore 结构上包含 SessionFacade 全部字段与 actions。
 * 门禁要求 get*StoreState 使用 `as unknown as` 窄化到命名 Facade（禁止 any）。
 */
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
  agentId: string
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

sessionRuntimeRegistry.registerActiveIdResolver(
  () => useSessionStore.getState().activeSessionId
);
