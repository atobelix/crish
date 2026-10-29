/**
 * sessionStore — 会话域独立 Zustand 实例。
 * 唯一源是 sessionsById 与 sessionOrder。流式 token 只改目标会话，不触发布局订阅者重绘。
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ensureSessionStoreShellKeyMigrated } from '../api/session-persistence/sessionShellKeyMigration';
import { useShallow } from '../store/useShallowSelector';
import {
  initStorePersistence,
  waitForStoreHydration,
} from './layout-helpers/store-persistence';
import type {
  SessionActivatableStore,
  StoreApiLike,
} from './layout-helpers/store-persistence-types';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { createSessionActions, type SessionActions } from './sessionActions';
import { triggerSessionMessageHydrateIfNeeded as triggerSessionMessageHydrate } from './sessionActivateHydrate';
import {
  getSessionById as getSessionByIdFromIndex,
  getSessionIndex as getSessionOrderIndex,
  selectSessionList,
} from './sessionIndex';
import { sidebarSessionsEqual } from './sessionListEqual';
import { registerSessionStateProvider } from './draft-routing/draftProjectResolver';
import { EMPTY_MESSAGES } from './persistenceConstants';
import type { SessionAgent, SessionMessage, SessionState } from './types';

export interface SessionStoreState {
  sessionsById: Record<string, SessionState>;
  /** 侧栏顺序。不进 partialize：会话体由 Rust DB 回灌，顺序随 sessionsById 一起重建。 */
  sessionOrder: string[];
  folderOrder: string[];
  activeSessionId: string;
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  hydrationComplete: boolean;
}

export type SessionStore = SessionStoreState & SessionActions;
export type SotaSessionStoreState = SessionStoreState;
export type SotaSessionStore = SessionStore;
export type SessionFacadeState = SessionStoreState;
export type SessionFacade = SessionStore;

/**
 * U-PERSIST-A（D4 票 A）：persist 键在 create 前完成一次迁移——
 * 旧全量 sessions 镜像剥离为轻量 meta 壳；正文唯一来源 = SQLite hydrate。
 */
ensureSessionStoreShellKeyMigrated();

/**
 * 物理独立 SessionStore。唯一源 = sessionsById + sessionOrder。
 */
export const useSessionStore = create<SessionStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer<SessionStore>((set, get) => {
          const baseActions = createSessionActions(set, get);

          return {
            sessionsById: {},
            sessionOrder: [],
            folderOrder: [],
            activeSessionId: '',
            draftFolder: '',
            activeAgentId: null,
            panelAgentId: null,
            composerDrafts: {},
            hydrationComplete: false,
            ...baseActions,
          };
        }),
        {
          name: 'crish_session_store',
          // 票 A：partialize 仅轻量 meta 壳——sessions/sessionsById 物理切除（DEL-5）
          partialize: (s) => ({
            folderOrder: s.folderOrder,
            activeSessionId: s.activeSessionId,
            composerDrafts: s.composerDrafts,
          }),
          // 零兼容读：即使旧键残留 sessions 字段，merge 也绝不并回内存
          merge: (persisted, current) => {
            const p = (persisted ?? {}) as Record<string, unknown>;
            return {
              ...current,
              activeSessionId:
                typeof p.activeSessionId === 'string'
                  ? p.activeSessionId
                  : current.activeSessionId,
              folderOrder: Array.isArray(p.folderOrder)
                ? (p.folderOrder as string[])
                : current.folderOrder,
              composerDrafts:
                p.composerDrafts && typeof p.composerDrafts === 'object'
                  ? (p.composerDrafts as Record<string, string>)
                  : current.composerDrafts,
            };
          },
        }
      )
    ),
    'SessionStore'
  )
);

registerSessionStateProvider(() => useSessionStore.getState());

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
  selectSessionList(s);
export const selectSessionsById = (
  s: SessionStoreState
): Record<string, SessionState> => s.sessionsById;
export const selectComposerDrafts = (
  s: SessionStoreState
): Record<string, string> => s.composerDrafts;
export const selectDraftFolder = (s: SessionStoreState): string =>
  s.draftFolder;

export const selectActiveSession = (
  s: Pick<SessionStoreState, 'sessionsById' | 'activeSessionId'>
): SessionState | undefined => s.sessionsById[s.activeSessionId];

export const makeSelectSessionById =
  (sessionId: string) =>
  (s: SessionStoreState): SessionState | undefined =>
    s.sessionsById[sessionId];

export const makeSelectSessionMessages =
  (sessionId: string) =>
  (s: SessionStoreState): SessionMessage[] =>
    s.sessionsById[sessionId]?.messages ?? EMPTY_MESSAGES;

export const makeSelectSessionGoalMode =
  (sessionId: string) => (s: SessionStoreState) =>
    s.sessionsById[sessionId]?.goalMode;

export const makeSelectSessionTitle =
  (sessionId: string) =>
  (s: SessionStoreState): string =>
    s.sessionsById[sessionId]?.title ?? '';

// ── Hooks 封装 ─────────────────────────────────────────────────────────────

export function useSessionField<T>(selector: (state: SessionStore) => T): T {
  return useSessionStore(selector);
}

export function useSidebarSessions(searching: boolean): SessionState[] {
  const snapshotRef = useRef<SessionState[]>(
    selectSessionList(useSessionStore.getState())
  );
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  const getSnapshot = useCallback((): SessionState[] => {
    const cur = selectSessionList(useSessionStore.getState());
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
  return useSessionStore(selectSessionList);
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
  return getSessionOrderIndex(getSessionStoreState(), sessionId);
}

export function getSessionAgent(
  sessionId: string,
  agentId: string
): SessionAgent | undefined {
  const agents = getSessionByIdFromIndex(
    getSessionStoreState(),
    sessionId
  )?.agents;
  return agents?.find((a) => a.id === agentId);
}

/** 等待 store 会话回灌完成 */
export function waitForHydration(): Promise<void> {
  return waitForStoreHydration(useSessionStore as StoreApiLike<SessionStore>);
}

/** 挂载会话持久化与回灌 */
export function initSessionStorePersistence(): () => void {
  return initStorePersistence(
    useSessionStore as SessionActivatableStore<SessionStore>
  );
}

// ── 会话索引与纯函数工具再导出 ────────────────────────────────────────────────

// ── 会话索引与纯函数工具再导出（清单位于 ./sessionStoreReexports，面等价）──

export * from './sessionStoreReexports';

/** Store-backed public wrapper; the hydration helper itself remains store-agnostic. */
export function triggerSessionMessageHydrateIfNeeded(sessionId: string): void {
  triggerSessionMessageHydrate(
    sessionId,
    () => useSessionStore.getState(),
    (recipe) => useSessionStore.setState(recipe)
  );
}

if (typeof window !== 'undefined') {
  window.useSessionStore = useSessionStore;
}
