/**
 * sessionStore — 会话域专属独立 Zustand 实例 (Tier 2 Session-Scoped Store)。
 * 彻底销毁 export const useSessionStore = useLayoutStore 伪门面别名同体，
 * 独占单一事件总线与订阅者集合，会话流式 Token 不触发全局 Layout 订阅者遍历。
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from '../store/useShallowSelector';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { sidebarSessionsEqual } from './sessionListEqual';
import type { SessionState, SessionAgent, SessionMessage } from './types';
import { createSessionActions, type SessionActions } from './sessionActions';
import { getSessionById as getSessionByIdFromIndex } from './sessionIndex';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import {
  initStorePersistence,
  waitForStoreHydration,
  type SessionActivatableStore,
  type StoreApiLike,
} from './layout-helpers/store-persistence';

export interface SessionStoreState {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  hydrationComplete: boolean;
}

export type SessionStore = SessionStoreState & SessionActions;

export type SessionFacadeState = SessionStoreState;
export type SessionFacade = SessionStore;

/**
 * 物理独立 SessionStore 实例 (彻底清除 autoIndexMiddleware 隐式全量重构)
 * 彻底消除与 layoutStore 的别名同体引用，独占单一事件总线与订阅者集合
 */
export const useSessionStore = create<SessionStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer<SessionStore>((set, get) => ({
          sessions: [],
          sessionsById: {},
          folderOrder: [],
          activeSessionId: '',
          draftFolder: '',
          activeAgentId: null,
          panelAgentId: null,
          composerDrafts: {},
          hydrationComplete: false,
          ...createSessionActions(set, get),
        })),
        {
          name: 'crish_session_store',
          partialize: (s) => ({
            sessions: s.sessions,
            folderOrder: s.folderOrder,
            activeSessionId: s.activeSessionId,
            composerDrafts: s.composerDrafts,
          }),
        }
      )
    ),
    'SessionStore'
  )
);

// ── 不可变原子选择器契约 (Atomic Selectors) ──────────────────────────────────

export const selectActiveSessionId = (s: SessionStoreState): string =>
  s.activeSessionId;

export const selectActiveAgentId = (s: SessionStoreState): string | null =>
  s.activeAgentId;

export const selectPanelAgentId = (s: SessionStoreState): string | null =>
  s.panelAgentId;

export const selectSessionHydrated = (s: SessionStoreState): boolean =>
  s.hydrationComplete;

export const selectFolderOrder = (s: SessionStoreState): string[] =>
  s.folderOrder;

export const selectSessions = (s: SessionStoreState): SessionState[] =>
  s.sessions;

export const selectSessionsById = (
  s: SessionStoreState
): Record<string, SessionState> => s.sessionsById;

export const selectComposerDrafts = (
  s: SessionStoreState
): Record<string, string> => s.composerDrafts;

export const selectDraftFolder = (s: SessionStoreState): string =>
  s.draftFolder;

export const selectActiveSession = (
  s: Pick<SessionStoreState, 'sessions' | 'sessionsById' | 'activeSessionId'>
): SessionState | undefined => getSessionByIdFromIndex(s, s.activeSessionId);

/**
 * 细粒度单会话实体选择器
 * 基于 sessionsById 进行 O(1) 查找，利用 Object.is 拦截无变化重绘
 */
export const makeSelectSessionById =
  (sessionId: string) =>
  (s: SessionStoreState): SessionState | undefined =>
    s.sessionsById[sessionId];

/**
 * 细粒度消息流选择器
 * 核心设计：返回不可变全局空数组常量 EMPTY_MESSAGES，彻底杜绝 fallback [] 导致的引用漂移与无效重绘
 */
const EMPTY_MESSAGES: readonly SessionMessage[] = Object.freeze([]);
export const makeSelectSessionMessages =
  (sessionId: string) =>
  (s: SessionStoreState): readonly SessionMessage[] =>
    s.sessionsById[sessionId]?.messages ?? EMPTY_MESSAGES;

/** 细粒度 GoalMode 选择器 */
export const makeSelectSessionGoalMode =
  (sessionId: string) => (s: SessionStoreState) =>
    s.sessionsById[sessionId]?.goalMode;

/** 细粒度会话标题选择器 */
export const makeSelectSessionTitle =
  (sessionId: string) =>
  (s: SessionStoreState): string =>
    s.sessionsById[sessionId]?.title || '';

// ── Hooks 封装 ─────────────────────────────────────────────────────────────

export function useSessionField<T>(selector: (state: SessionStore) => T): T {
  return useSessionStore(selector);
}

export function useSidebarSessions(searching: boolean): SessionState[] {
  const snapshotRef = useRef<SessionState[]>(
    useSessionStore.getState().sessions
  );
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  const getSnapshot = useCallback((): SessionState[] => {
    const cur = useSessionStore.getState().sessions;
    if (
      searchingRef.current ||
      !sidebarSessionsEqual(snapshotRef.current, cur)
    ) {
      snapshotRef.current = cur;
    }
    return snapshotRef.current;
  }, []);

  return useSyncExternalStore(
    useCallback((cb: () => void) => useSessionStore.subscribe(cb), []),
    getSnapshot,
    getSnapshot
  );
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

// ── 命令式读写接口 ──────────────────────────────────────────────────────────

export function getSessionStoreState(): SessionStore {
  return useSessionStore.getState();
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

/** 等待 store 会话回灌完成 */
export function waitForHydration(): Promise<void> {
  return waitForStoreHydration(
    useSessionStore as unknown as StoreApiLike<any>
  );
}

/** 挂载会话持久化与回灌 */
export function initSessionStorePersistence(): () => void {
  return initStorePersistence(
    useSessionStore as unknown as SessionActivatableStore<any>
  );
}

// ── 会话索引与纯函数工具再导出 ────────────────────────────────────────────────

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
export { SessionCoordinator, deleteSessionCascade } from './SessionCoordinator';

// ── 运行时动态注册 ──────────────────────────────────────────────────────────

sessionRuntimeRegistry.registerActiveIdResolver(
  () => useSessionStore.getState().activeSessionId
);

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).useSessionStore =
    useSessionStore;
}
