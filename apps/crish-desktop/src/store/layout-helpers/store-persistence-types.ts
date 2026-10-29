/**
 * store-persistence-types — initStorePersistence 所需的 store 形状契约（会话持久化切片与最小 StoreApi）
 */

import type { SessionState, WorkspaceState } from '../types';

/** initStorePersistence 读写的会话持久化切片 */
export interface PersistableStoreState {
  workspaces?: WorkspaceState[];
  sidebarCollapsed?: boolean;
  activeWorkspaceIndex?: number;
  sessionsById: Record<string, SessionState>;
  /** 侧栏顺序。与 sessionsById 一起由回灌重建，不进 partialize。 */
  sessionOrder: string[];
  activeSessionId: string;
  folderOrder: string[];
  hydrationComplete: boolean;
  activeAgentId: string | null;
  panelAgentId: string | null;
}

export interface StoreApiLike<S extends { hydrationComplete: boolean }> {
  getState: () => S;
  setState: (
    partial: S | Partial<S> | ((state: S) => void),
    replace?: boolean
  ) => void;
  subscribe: (listener: (state: S) => void) => () => void;
}

export type SessionActivatableStore<S extends PersistableStoreState> =
  StoreApiLike<S> & { setActiveSessionId?: (id: string) => void };
