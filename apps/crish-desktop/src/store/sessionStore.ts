/**
 * sessionStore — 会话域专属独立 Zustand 实例 (Stage 01 SOTA 正交三子树与内置双标量版本代数槽位)。
 * 彻底销毁 export const useSessionStore = useLayoutStore 伪门面别名同体，
 * 独占单一事件总线与订阅者集合，会话流式 Token 不触发全局 Layout 或元数据订阅者重绘。
 */
import { produce } from 'immer';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import { ensureSessionStoreShellKeyMigrated } from '../api/session-persistence/sessionShellKeyMigration';
import { useShallow } from '../store/useShallowSelector';
import {
  initStorePersistence,
  waitForStoreHydration,
  type SessionActivatableStore,
  type StoreApiLike,
} from './layout-helpers/store-persistence';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { createSessionActions, type SessionActions } from './sessionActions';
import { triggerSessionMessageHydrateIfNeeded as triggerSessionMessageHydrate } from './sessionActivateHydrate';
import { getSessionById as getSessionByIdFromIndex } from './sessionIndex';
import { sidebarSessionsEqual } from './sessionListEqual';
import {
  bumpEpochScalar,
  createInitialSubtreeSlice,
  EMPTY_MESSAGES,
  patchSubtreeSessionMeta,
  syncSubtreeFromIndexedState,
  updateSubtreeMessageText,
  type SessionMeta,
  type SessionSubtreeSlice,
} from './sessionSubtreeModel';
import type { SessionAgent, SessionMessage, SessionState } from './types';

export interface SessionStoreState extends SessionSubtreeSlice {
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

export interface SessionSubtreeActions {
  patchSessionMeta: (sessionId: string, patch: Partial<SessionMeta>) => void;
}

export type SessionStore = SessionStoreState &
  SessionActions &
  SessionSubtreeActions;
export type SotaSessionStoreState = SessionStoreState;
export type SotaSessionStore = SessionStore;
export type SessionFacadeState = SessionStoreState;
export type SessionFacade = SessionStore;

/**
 * U-PERSIST-A（D4 票 A）：persist 键在 create 前完成一次迁移——
 * 旧全量 sessions 镜像剥离为轻量 meta 壳；正文唯一来源 = SQLite hydrate。
 */
ensureSessionStoreShellKeyMigrated();

function applyUpdaterWithSubtreeSync(
  prev: SessionStore,
  updater:
    | SessionStore
    | Partial<SessionStore>
    | ((state: SessionStore) => void | SessionStore | Partial<SessionStore>),
  replace?: boolean
): SessionStore {
  const produced =
    typeof updater === 'function'
      ? produce(prev, (draft) => {
          const ret = (updater as (d: SessionStore) => unknown)(
            draft as SessionStore
          );
          if (ret && typeof ret === 'object' && ret !== draft) {
            Object.assign(draft, ret);
          }
        })
      : replace
        ? (updater as SessionStore)
        : ({ ...prev, ...updater } as SessionStore);
  if (produced === prev) return prev;
  return syncSubtreeFromIndexedState(prev, produced);
}

/**
 * 物理独立 SessionStore 实例（正交三子树 + 内置双标量 Epoch 槽位）
 */
export const useSessionStore = create<SessionStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer<SessionStore>((rawSet, get, store) => {
          const set: typeof rawSet = (updater, replace) => {
            const prev = get();
            const next = applyUpdaterWithSubtreeSync(
              prev,
              updater as Parameters<typeof applyUpdaterWithSubtreeSync>[1],
              replace
            );
            if (next !== prev) rawSet(next, true);
          };
          store.setState = set;

          const baseActions = createSessionActions(set, get);

          return {
            ...createInitialSubtreeSlice(),
            sessions: [],
            sessionsById: {},
            folderOrder: [],
            activeSessionId: '',
            draftFolder: '',
            activeAgentId: null,
            panelAgentId: null,
            composerDrafts: {},
            hydrationComplete: false,
            ...baseActions,
            updateMessageText: (
              sessionId,
              messageId,
              text,
              precomputedHtml
            ) => {
              const prev = get();
              const nextSub = updateSubtreeMessageText(
                prev,
                sessionId,
                messageId,
                text,
                precomputedHtml
              );
              if (nextSub === prev) {
                if (
                  prev.sessionsById[sessionId] &&
                  !prev.messagesBySessionId[sessionId]
                ) {
                  baseActions.updateMessageText(
                    sessionId,
                    messageId,
                    text,
                    precomputedHtml
                  );
                }
                return;
              }
              const nextMsgs = nextSub.messagesBySessionId[sessionId]!;
              const legacySess = prev.sessionsById[sessionId];
              if (!legacySess) {
                rawSet(nextSub, true);
                return;
              }
              const updatedSess: SessionState = {
                ...legacySess,
                messages: nextMsgs,
              };
              const nextById = {
                ...prev.sessionsById,
                [sessionId]: updatedSess,
              };
              const idx = prev.sessions.indexOf(legacySess);
              const sIdx =
                idx >= 0
                  ? idx
                  : prev.sessions.findIndex((s) => s.id === sessionId);
              const nextSessions = prev.sessions.slice();
              if (sIdx >= 0) nextSessions[sIdx] = updatedSess;
              rawSet(
                {
                  ...nextSub,
                  sessions: nextSessions,
                  sessionsById: nextById,
                },
                true
              );
            },
            patchSessionMeta: (sessionId, patch) => {
              const prev = get();
              const nextSub = patchSubtreeSessionMeta(prev, sessionId, patch);
              if (nextSub === prev) return;
              const legacySess = prev.sessionsById[sessionId];
              if (!legacySess) {
                rawSet(nextSub, true);
                return;
              }
              const updatedSess: SessionState = {
                ...legacySess,
                ...patch,
                id: legacySess.id,
              };
              const nextById = {
                ...prev.sessionsById,
                [sessionId]: updatedSess,
              };
              const idx = prev.sessions.indexOf(legacySess);
              const sIdx =
                idx >= 0
                  ? idx
                  : prev.sessions.findIndex((s) => s.id === sessionId);
              const nextSessions = prev.sessions.slice();
              if (sIdx >= 0) nextSessions[sIdx] = updatedSess;
              rawSet(
                {
                  ...nextSub,
                  sessions: nextSessions,
                  sessionsById: nextById,
                },
                true
              );
            },
            renameSession: (sessionId, newTitle) => {
              const prev = get();
              if (prev.metaById[sessionId] && !prev.sessionsById[sessionId]) {
                const nextSub = patchSubtreeSessionMeta(prev, sessionId, {
                  title: newTitle,
                  titleSource: 'user',
                });
                if (nextSub !== prev) rawSet(nextSub, true);
                return;
              }
              baseActions.renameSession(sessionId, newTitle);
            },
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

const innerSetState = useSessionStore.setState;
useSessionStore.setState = ((updater, replace) => {
  const prev = useSessionStore.getState();
  const next = applyUpdaterWithSubtreeSync(
    prev,
    updater as Parameters<typeof applyUpdaterWithSubtreeSync>[1],
    replace
  );
  if (next !== prev) innerSetState(next, true);
}) as typeof useSessionStore.setState;

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

export const makeSelectSessionById =
  (sessionId: string) =>
  (s: SessionStoreState): SessionState | undefined =>
    s.sessionsById[sessionId];

export const makeSelectSessionMessages =
  (sessionId: string) =>
  (s: SessionStoreState): SessionMessage[] =>
    s.messagesBySessionId[sessionId] ??
    s.sessionsById[sessionId]?.messages ??
    EMPTY_MESSAGES;

export const makeSelectSessionGoalMode =
  (sessionId: string) => (s: SessionStoreState) =>
    s.metaById[sessionId]?.goalMode ?? s.sessionsById[sessionId]?.goalMode;

export const makeSelectSessionTitle =
  (sessionId: string) =>
  (s: SessionStoreState): string =>
    s.metaById[sessionId]?.title ?? s.sessionsById[sessionId]?.title ?? '';

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
  const orderIdx = state.sessionOrder.indexOf(sessionId);
  return orderIdx >= 0
    ? orderIdx
    : state.sessions.findIndex((s) => s.id === sessionId);
}

export function getSessionAgent(
  sessionId: string,
  agentId: string
): SessionAgent | undefined {
  const state = getSessionStoreState();
  const agents =
    state.agentsBySessionId[sessionId] ??
    getSessionByIdFromIndex(state, sessionId)?.agents;
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

export {
  getSessionById as getSessionByIdFromState,
  getSessionMetaById,
  buildSessionsById,
  reindexSessionsById,
  reorderSessionOrderById,
  reorderSessionOrderByIdList,
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

export { bumpEpochScalar };
export type { SessionActions } from './sessionActions';
export type { SessionMeta, SessionSubtreeSlice } from './sessionSubtreeModel';
export type { SessionState, SessionAgent, SessionMessage } from './types';

/** Store-backed public wrapper; the hydration helper itself remains store-agnostic. */
export function triggerSessionMessageHydrateIfNeeded(sessionId: string): void {
  triggerSessionMessageHydrate(
    sessionId,
    () => useSessionStore.getState(),
    (recipe) => useSessionStore.setState(recipe)
  );
}

// ── 运行时动态注册 ──────────────────────────────────────────────────────────

sessionRuntimeRegistry.registerActiveIdResolver(
  () => useSessionStore.getState().activeSessionId
);

if (typeof window !== 'undefined') {
  window.useSessionStore = useSessionStore;
}
