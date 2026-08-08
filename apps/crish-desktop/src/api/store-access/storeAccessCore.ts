/**
 * Store 基础接口、实例注入与跨域事务核心。
 */
import { useLayoutStore } from '../../store/layoutStore';
import type { LayoutStore } from '../../store/layoutStore';

export type LayoutStoreHook = typeof useLayoutStore;

export interface StoreLike<S = unknown> {
  getState(): S;
  setState(partial: S | Partial<S> | ((state: S) => S | Partial<S>), replace?: boolean): void;
  subscribe(listener: (state: S, prevState: S) => void): () => void;
}

let _sessionStore: StoreLike<unknown> | null = null;
let _workspaceStore: StoreLike<unknown> | null = null;
let _settingsUiStore: StoreLike<unknown> | null = null;

export function initStoreAccess(
  session: StoreLike<unknown>,
  workspace: StoreLike<unknown>,
  settingsUi: StoreLike<unknown>
): void {
  _sessionStore = session;
  _workspaceStore = workspace;
  _settingsUiStore = settingsUi;
}

export function getLayoutState(): LayoutStore {
  return useLayoutStore.getState();
}

export function resolveSessionState(): LayoutStore {
  if (_sessionStore) return _sessionStore.getState() as LayoutStore;
  return getLayoutState();
}

export function resolveWorkspaceState(): LayoutStore {
  if (_workspaceStore) return _workspaceStore.getState() as LayoutStore;
  return getLayoutState();
}
