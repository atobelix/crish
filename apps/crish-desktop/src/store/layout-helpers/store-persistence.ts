import type { SessionState, WorkspaceState } from '../types';
import { isDemoMode } from '../../api/appMode';
import { persistAllSessions } from '../../api/sessionPersistence';
import {
  mirrorSessionsToDisk,
  restoreSessionsFromDiskMirror,
} from '../../api/sessionDiskMirror';
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

export interface PersistableStoreState {
  workspaces: WorkspaceState[];
  sidebarCollapsed: boolean;
  activeWorkspaceIndex: number;
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  activeSessionId: string;
  folderOrder: string[];
  hydrationComplete: boolean;
  activeAgentId: string | null;
  panelAgentId: string | null;
}

export interface StoreApiLike<S extends PersistableStoreState> {
  getState: () => S;
  setState: (
    partial: S | Partial<S> | ((state: S) => void | S),
    replace?: boolean
  ) => void;
  subscribe: (listener: (state: S) => void) => () => void;
}

export function serializeWorkspaceLayout<S extends PersistableStoreState>(
  state: S
): WorkspaceLayoutSnapshot {
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

export function deserializeWorkspaceLayout<S extends PersistableStoreState>(
  snapshot: WorkspaceLayoutSnapshot,
  state: S
): void {
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
export function waitForStoreHydration<S extends PersistableStoreState>(
  store: StoreApiLike<S>
): Promise<void> {
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

/**
 * 挂载会话持久化订阅（session index + 磁盘镜像）与空会话磁盘回灌。
 * demo 模式不持久化，直接返回 no-op cleanup。
 * 由 App 在 mount 时调用一次，unmount 时执行返回的 cleanup。
 */
export function initStorePersistence<S extends PersistableStoreState>(
  store: StoreApiLike<S>
): () => void {
  if (isDemoMode()) {
    return () => undefined;
  }

  const abortController = new AbortController();

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let diskTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一份会话域切片：遥测等字段变更时引用不变 → 跳过落盘 */
  let lastDomain: SessionDomainSlice | null = pickSessionDomain(
    store.getState()
  );

  const unsub = store.subscribe((state) => {
    const domain = pickSessionDomain(state);
    // 仅 sessions / activeSessionId / folderOrder 变化时调度写入
    if (!sessionDomainChanged(lastDomain, domain)) {
      return;
    }
    lastDomain = domain;

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const cur = store.getState();
        persistAllSessions(cur.sessions, cur.activeSessionId, cur.folderOrder);
      } catch (e) {
        console.warn('[sessionPersistence] save failed', e);
      }
    }, 350);
    // H3：磁盘镜像更低频，避免每键写文件
    if (diskTimer) clearTimeout(diskTimer);
    diskTimer = setTimeout(() => {
      const cur = store.getState();
      void mirrorSessionsToDisk(
        cur.sessions,
        cur.activeSessionId,
        cur.folderOrder
      );
    }, 2500);
  });

  // localStorage 空时尝试从磁盘镜像回灌（compare-and-swap：写入前再次确认仍为空）
  if (store.getState().sessions.length === 0) {
    void restoreSessionsFromDiskMirror()
      .then((restored) => {
        if (abortController.signal.aborted) return;

        if (restored?.sessions?.length) {
          const cur = store.getState();
          // 用户已新建会话则不覆盖
          if (cur.sessions.length > 0) return;

          let applied = false;
          store.setState((state) => {
            // 二次检查：recipe 内仍空才写入
            if (state.sessions.length > 0) return;

            const sanitized = sanitizeSessionSeed({
              sessions: restored.sessions,
              activeSessionId: restored.activeSessionId,
              folderOrder: restored.folderOrder,
            });
            state.sessions = sanitized.sessions;
            state.sessionsById = sanitized.sessionsById;
            state.activeSessionId = sanitized.activeSessionId;
            state.folderOrder = sanitized.folderOrder.length
              ? sanitized.folderOrder
              : state.folderOrder;
            // 回灌后清 ghost agent 焦点（会话集合已变）
            state.activeAgentId = null;
            state.panelAgentId = null;
            // empty workspace seed：若被外部掏空则重种
            state.workspaces = ensureNonEmptyWorkspaces(state.workspaces);
            state.activeWorkspaceIndex = clampActiveWorkspaceIndex(
              state.workspaces,
              state.activeWorkspaceIndex
            );
            applied = true;
          });

          // 仅在真正写入后落盘；避免旧逻辑用 activeSessionId 巧合匹配误 persist
          if (!applied) return;
          try {
            const after = store.getState();
            persistAllSessions(
              after.sessions,
              after.activeSessionId,
              after.folderOrder
            );
          } catch {
            /* ignore */
          }
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          store.setState((state) => {
            state.hydrationComplete = true;
          });
        }
      });
  } else {
    store.setState((state) => {
      state.hydrationComplete = true;
    });
  }

  return () => {
    abortController.abort();
    if (persistTimer) clearTimeout(persistTimer);
    if (diskTimer) clearTimeout(diskTimer);
    unsub();
  };
}
