/**
 * Store 基础接口、实例注入与跨域事务核心。
 */
import { useLayoutStore } from '../../store/layoutStore';
import type {
  LayoutStore,
  UiSize,
} from '../../store/layoutStore';
import type {
  DropPreviewState,
  SessionState,
  SettingsTabType,
  WorkspaceState,
} from '../../store/types';
import type { PermissionMode } from '../permissionModes';
import type { ShellChromeMode } from '../shellChrome';
import type { DraggedTabState } from '../../store/workspaceStore';
import { usePermissionStore } from '../../store/permissionStore';
import { useTerminalStore } from '../../store/terminalStore';

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

export function isStoreAccessInitialized(): boolean {
  return _sessionStore !== null;
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

export function resolveSettingsUiState(): LayoutStore {
  if (_settingsUiStore) return _settingsUiStore.getState() as LayoutStore;
  return getLayoutState();
}

export type SessionsSnapshot = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
  terminalBySession: Record<string, string[]>;
};

export type WorkspacesSnapshot = {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
};

export type SettingsUiSnapshot = {
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
};

export interface StoreSnapshot {
  sessions: SessionsSnapshot;
  workspaces: WorkspacesSnapshot;
  settingsUi: SettingsUiSnapshot;
}

export class StoreTransaction {
  private snapshots: StoreSnapshot[] = [];

  begin(): void {
    this.snapshots.push({
      sessions: this.cloneSessions(),
      workspaces: this.cloneWorkspaces(),
      settingsUi: this.cloneSettingsUi(),
    });
  }

  commit(): void {
    this.snapshots.pop();
  }

  rollback(): void {
    const snapshot = this.snapshots.pop();
    if (!snapshot) return;
    this.restoreSessions(snapshot.sessions);
    this.restoreWorkspaces(snapshot.workspaces);
    this.restoreSettingsUi(snapshot.settingsUi);
  }

  run<T>(fn: () => T): T {
    this.begin();
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  get depth(): number {
    return this.snapshots.length;
  }

  private cloneSessions(): SessionsSnapshot {
    const state = resolveSessionState();
    return {
      sessions: cloneArray(state.sessions),
      sessionsById: { ...(state.sessionsById ?? {}) },
      folderOrder: cloneArray(state.folderOrder),
      activeSessionId: state.activeSessionId,
      activeAgentId: state.activeAgentId,
      panelAgentId: state.panelAgentId,
      composerDrafts: { ...(state.composerDrafts ?? {}) },
      terminalBySession: { ...(useTerminalStore.getState().terminalBySession ?? {}) },
    };
  }

  private cloneWorkspaces(): WorkspacesSnapshot {
    const state = resolveWorkspaceState();
    return {
      workspaces: cloneArray(state.workspaces),
      activeWorkspaceIndex: state.activeWorkspaceIndex,
      tabModeEnabled: state.tabModeEnabled,
      uiSize: state.uiSize,
      shellChromeMode: state.shellChromeMode,
      chatMainSurface: state.chatMainSurface,
      sidebarCollapsed: state.sidebarCollapsed,
      draggedTab: state.draggedTab ? { ...state.draggedTab } : null,
      dropPreview: state.dropPreview ? { ...state.dropPreview } : null,
    };
  }

  private cloneSettingsUi(): SettingsUiSnapshot {
    const state = resolveSettingsUiState();
    const perm = usePermissionStore.getState();
    return {
      showSettingsOverlay: state.showSettingsOverlay,
      settingsActiveTab: state.settingsActiveTab,
      permissionMode: perm.permissionMode,
      planModeEnabled: perm.planModeEnabled,
      planApproved: perm.planApproved,
    };
  }

  private restoreSessions(snapshot: SessionsSnapshot): void {
    const store = _sessionStore;
    const { terminalBySession, ...rest } = snapshot;
    if (store) {
      store.setState(rest as Partial<unknown>);
    } else {
      useLayoutStore.setState(rest);
    }
    if (terminalBySession) {
      useTerminalStore.setState({ terminalBySession });
    }
  }

  private restoreWorkspaces(snapshot: WorkspacesSnapshot): void {
    const store = _workspaceStore;
    if (store) {
      store.setState(snapshot as Partial<unknown>);
    } else {
      useLayoutStore.setState(snapshot);
    }
  }

  private restoreSettingsUi(snapshot: SettingsUiSnapshot): void {
    const store = _settingsUiStore;
    const { permissionMode, planModeEnabled, planApproved, ...rest } = snapshot;
    if (store) {
      store.setState(rest as Partial<unknown>);
    } else {
      useLayoutStore.setState(rest);
    }
    usePermissionStore.setState({ permissionMode, planModeEnabled, planApproved });
  }
}

function cloneArray<T>(arr: T[]): T[] {
  return arr
    ? arr.map((item) =>
        typeof item === 'object' && item !== null ? ({ ...item } as T) : item
      )
    : [];
}
