/**
 * Store 基础接口、实例注入与跨域事务核心。
 */
import { useLayoutStore } from '../../store/layoutStore';
import type { LayoutStore } from '../../store/layoutStore';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionStore } from '../../store/sessionStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { WorkspaceStore } from '../../store/workspaceStore';

export type LayoutStoreHook = typeof useLayoutStore;
export type SessionStoreHook = typeof useSessionStore;
export type WorkspaceStoreHook = typeof useWorkspaceStore;

export interface StoreLike<S = unknown> {
  getState(): S;
  setState(partial: S | Partial<S> | ((state: S) => S | Partial<S>), replace?: boolean): void;
  subscribe(listener: (state: S, prevState: S) => void): () => void;
}

let _sessionStore: StoreLike<SessionStore> | null = null;
let _workspaceStore: StoreLike<WorkspaceStore> | null = null;
let _settingsUiStore: StoreLike<unknown> | null = null;

export function initStoreAccess(
  session: StoreLike<SessionStore>,
  workspace: StoreLike<WorkspaceStore>,
  settingsUi: StoreLike<unknown>
): void {
  _sessionStore = session;
  _workspaceStore = workspace;
  _settingsUiStore = settingsUi;
}

export function getLayoutState(): LayoutStore {
  return useLayoutStore.getState();
}

export function resolveSessionState(): SessionStore {
  if (_sessionStore) return _sessionStore.getState();
  return useSessionStore.getState();
}

export function resolveWorkspaceState(): WorkspaceStore {
  if (_workspaceStore) return _workspaceStore.getState();
  return useWorkspaceStore.getState();
}

