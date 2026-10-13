import type { WorkspaceState } from '../types';
import { isDemoMode } from '../../api/appMode';
import {
  ensureMigrated,
  hydrateSessionsFromRust,
  persistAllSessions,
  runMigrationCleanupIfNeeded,
} from '../../api/sessionPersistence';
import {
  pickSessionDomain,
  sessionDomainChanged,
  type SessionDomainSlice,
} from '../../api/sessionPersistGate';
import {
  clampActiveWorkspaceIndex,
  ensureNonEmptyWorkspaces,
  sanitizeSessionSeed,
} from './store-initializers';
import type { WorkspaceLayoutSnapshot } from './store-types';
import { STORAGE_PERSIST_DEBOUNCE_MS } from '../persistenceConstants';
import { isSessionTombstoned } from '../sessionCascadeCancellation';
import {
  BootHoldBarrier,
  DeltaWriteBarrier,
  EmptySanitizeBarrier,
  performThreeWaySessionMerge,
  syncOrthogonalSessionSubtrees,
  type PersistableStoreState,
  type SessionActivatableStore,
} from '../store-persistence';

export {
  BootHoldBarrier,
  DeltaWriteBarrier,
  EmptySanitizeBarrier,
  performThreeWaySessionMerge,
  syncOrthogonalSessionSubtrees,
  type PersistableStoreState,
  type SessionActivatableStore,
  type SessionWriteDelta,
  type StoreApiLike,
  type ThreeWayMergeResult,
} from '../store-persistence';

export function serializeWorkspaceLayout<
  S extends {
    workspaces: WorkspaceState[];
    sidebarCollapsed: boolean;
    activeWorkspaceIndex: number;
  },
>(state: S): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    workspaces: state.workspaces.map((ws) => ({
      id: ws.id,
      columns: ws.columns,
    })),
    sidebarCollapsed: state.sidebarCollapsed,
    activeWorkspaceIndex: state.activeWorkspaceIndex,
  };
}

export function deserializeWorkspaceLayout<
  S extends {
    workspaces: WorkspaceState[];
    sidebarCollapsed: boolean;
    activeWorkspaceIndex: number;
  },
>(snapshot: WorkspaceLayoutSnapshot, state: S): void {
  const index = clampActiveWorkspaceIndex(
    snapshot.workspaces,
    snapshot.activeWorkspaceIndex
  );
  state.workspaces = snapshot.workspaces.map((ws) => ({
    id: ws.id,
    columns: ws.columns,
  }));
  state.activeWorkspaceIndex = index;
  state.sidebarCollapsed = snapshot.sidebarCollapsed;
}

/** 等待 store 会话回灌完成 */
export function waitForStoreHydration<
  S extends { hydrationComplete: boolean },
>(store: {
  getState: () => S;
  subscribe: (listener: (state: S) => void) => () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    if (store.getState().hydrationComplete) {
      resolve();
      return;
    }
    const unsub = store.subscribe((state) => {
      if (state.hydrationComplete) {
        unsub();
        resolve();
      }
    });
  });
}

function readUrlTargetSessionId(): string | null {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const sid = (params.get('session') || '').trim();
    return sid || null;
  } catch {
    return null;
  }
}

function syncActiveSessionToEmptyLayoutLeaf(
  sessionId: string,
  sessionTitle?: string
): void {
  if (!sessionId) return;
  void import('../layout-tree')
    .then((mod) => {
      try {
        const { useLayoutTreeStore, collectLeaves } = mod;
        if (typeof useLayoutTreeStore?.getState !== 'function') return;
        const treeState = useLayoutTreeStore.getState();
        const root = treeState?.tree?.root;
        if (!root) return;
        if (sessionTitle && typeof treeState.updateTabTitle === 'function') {
          treeState.updateTabTitle(sessionId, sessionTitle);
        }
        const leaves = collectLeaves(root);
        const activeLeafId = treeState.activeLeafId || leaves[0]?.id;
        if (!activeLeafId) return;
        const activeLeaf = leaves.find((l) => l.id === activeLeafId);
        if (activeLeaf && (!activeLeaf.tabs || activeLeaf.tabs.length === 0)) {
          if (typeof treeState.openSession === 'function') {
            treeState.openSession(sessionId, {
              activeLeafId,
              title: sessionTitle || '',
            });
          }
        }
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* ignore */
    });
}

/**
 * 挂载会话持久化订阅（SQLite 主路径 + localStorage 回退 + 三道物理写屏障 + 3-Way Merge）。
 */
export function initStorePersistence<S extends PersistableStoreState>(
  store: SessionActivatableStore<S>
): () => void {
  if (isDemoMode()) {
    return () => undefined;
  }

  const abortController = new AbortController();
  const initialState = store.getState();
  const baseSessionIds = new Set<string>(
    initialState.sessions.map((s) => s.id).filter(Boolean)
  );
  const knownPersistedIds = new Set<string>(baseSessionIds);
  const deltaBarrier = new DeltaWriteBarrier();
  deltaBarrier.seedFromSessions(
    initialState.sessions,
    initialState.activeSessionId,
    initialState.folderOrder
  );

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDomain: SessionDomainSlice | null = pickSessionDomain(initialState);

  const unsub = store.subscribe((state) => {
    const domain = pickSessionDomain(state);
    if (!sessionDomainChanged(lastDomain, domain)) {
      return;
    }
    lastDomain = domain;

    // 写屏障 1（BootHoldBarrier）：3-Way Merge 完成前严禁抢跑写盘覆写历史会话
    if (BootHoldBarrier.shouldHold(state)) {
      return;
    }

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const cur = store.getState();
        if (BootHoldBarrier.shouldHold(cur)) {
          return;
        }
        // 写屏障 3（EmptySanitizeBarrier）：非空库未全墓碑时严禁写空数组
        if (
          EmptySanitizeBarrier.shouldBlockEmptyWrite(
            cur.sessions,
            knownPersistedIds
          )
        ) {
          return;
        }
        // 写屏障 2（DeltaWriteBarrier）：无实质脏会话或元数据变化时跳过写盘
        const delta = deltaBarrier.computeDelta(
          cur.sessions,
          cur.activeSessionId,
          cur.folderOrder
        );
        if (!delta.hasChanges) {
          return;
        }
        for (const s of cur.sessions) {
          if (s?.id) knownPersistedIds.add(s.id);
        }
        void persistAllSessions(
          cur.sessions,
          cur.activeSessionId,
          cur.folderOrder
        );
      } catch (e) {
        console.warn('[sessionPersistence] save failed', e);
      }
    }, STORAGE_PERSIST_DEBOUNCE_MS);
  });

  // 启动时：先迁移，再从 SQLite 回灌会话并执行集合论 3-Way Merge
  void ensureMigrated()
    .then(async () => {
      const restored = await hydrateSessionsFromRust();
      void runMigrationCleanupIfNeeded();
      return restored;
    })
    .then(async (restored) => {
      if (abortController.signal.aborted) return;

      if (restored?.sessions?.length) {
        for (const rs of restored.sessions) {
          if (rs?.id && !isSessionTombstoned(rs.id)) {
            knownPersistedIds.add(rs.id);
          }
        }

        let appliedOrMerged = false;
        const urlSessionId = readUrlTargetSessionId();
        const setActiveSessionId = (id: string) =>
          store.setActiveSessionId?.(id);

        store.setState((state: PersistableStoreState) => {
          const wasEmpty = state.sessions.length === 0;
          const mergeResult = performThreeWaySessionMerge(
            baseSessionIds,
            state.sessions,
            restored.sessions,
            isSessionTombstoned
          );

          const hasMergeChanges =
            wasEmpty ||
            mergeResult.addedFromRemoteCount > 0 ||
            mergeResult.preservedLocalNewCount > 0 ||
            mergeResult.filledBodiesCount > 0 ||
            mergeResult.skippedTombstonedCount > 0;

          if (!hasMergeChanges) return;

          const preferredActiveId =
            urlSessionId && mergeResult.mergedById[urlSessionId]
              ? urlSessionId
              : state.activeSessionId &&
                  mergeResult.mergedById[state.activeSessionId]
                ? state.activeSessionId
                : restored.activeSessionId;

          const mergedFolders = Array.from(
            new Set([
              ...(state.folderOrder ?? []),
              ...(restored.folderOrder ?? []),
            ])
          );

          const sanitized = sanitizeSessionSeed({
            sessions: mergeResult.mergedSessions,
            activeSessionId: preferredActiveId,
            folderOrder: mergedFolders,
          });

          state.sessions = sanitized.sessions;
          state.sessionsById = sanitized.sessionsById;
          state.activeSessionId = sanitized.activeSessionId;
          state.folderOrder = sanitized.folderOrder.length
            ? sanitized.folderOrder
            : state.folderOrder;
          syncOrthogonalSessionSubtrees(state, sanitized.sessions);

          if (wasEmpty) {
            state.activeAgentId = null;
            state.panelAgentId = null;
            if (state.workspaces) {
              state.workspaces = ensureNonEmptyWorkspaces(state.workspaces);
              state.activeWorkspaceIndex = clampActiveWorkspaceIndex(
                state.workspaces,
                state.activeWorkspaceIndex ?? 0
              );
            }
          }
          appliedOrMerged = true;
        });

        try {
          const after = store.getState();
          deltaBarrier.seedFromSessions(
            after.sessions,
            after.activeSessionId,
            after.folderOrder
          );
          if (
            after.activeSessionId &&
            after.sessionsById[after.activeSessionId]
          ) {
            setActiveSessionId(after.activeSessionId);
            syncActiveSessionToEmptyLayoutLeaf(
              after.activeSessionId,
              after.sessionsById[after.activeSessionId]?.title
            );
          }
          if (appliedOrMerged && after.sessions.length > 0) {
            void persistAllSessions(
              after.sessions,
              after.activeSessionId,
              after.folderOrder
            );
          }
        } catch {
          /* ignore */
        }
      }
    })
    .catch((e) => {
      console.warn('[sessionPersistence] migrate/hydrate failed', e);
    })
    .finally(() => {
      if (!abortController.signal.aborted) {
        store.setState((state: PersistableStoreState) => {
          state.hydrationComplete = true;
        });
        const finalState = store.getState();
        if (
          finalState.sessions.length > 0 &&
          deltaBarrier.computeDelta(
            finalState.sessions,
            finalState.activeSessionId,
            finalState.folderOrder
          ).hasChanges
        ) {
          for (const s of finalState.sessions) {
            if (s?.id) knownPersistedIds.add(s.id);
          }
          void persistAllSessions(
            finalState.sessions,
            finalState.activeSessionId,
            finalState.folderOrder
          );
        }
      }
    });

  return () => {
    abortController.abort();
    if (persistTimer) clearTimeout(persistTimer);
    unsub();
  };
}
