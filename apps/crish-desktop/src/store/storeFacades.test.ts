import { describe, expect, it } from 'vitest';
import { useLayoutStore } from './layoutStore';
import {
  getActiveSession,
  getActiveSessionId,
  getSessionById,
  getSessionStoreState,
  selectActiveSession,
  selectActiveSessionId,
  useSessionStore,
} from './sessionStore';
import {
  focusExistingPanelCard,
  getActiveWorkspace,
  getDropPreview,
  getWorkspaceStoreState,
  selectActiveWorkspace,
  setDropPreview,
  setGroupActiveCard,
  useWorkspaceStore,
} from './workspaceStore';
import {
  closeSettings,
  getPermissionMode,
  getSettingsUiState,
  openSettings,
  setPermissionMode,
  setPlanApproved,
  setPlanModeEnabled,
  setSettingsActiveTab,
  toggleSettingsOverlay,
  useSettingsUiStore,
} from './settingsUiStore';

describe('domain facades alignment', () => {
  it('useSessionStore / useWorkspaceStore / useSettingsUiStore are the same instance as useLayoutStore', () => {
    expect(useSessionStore).toBe(useLayoutStore);
    expect(useWorkspaceStore).toBe(useLayoutStore);
    expect(useSettingsUiStore).toBe(useLayoutStore);
  });

  it('get*StoreState facades project the live layout snapshot', () => {
    const layout = useLayoutStore.getState();
    const session = getSessionStoreState();
    const workspace = getWorkspaceStoreState();
    const settings = getSettingsUiState();

    expect(session.sessions).toBe(layout.sessions);
    expect(session.sessionsById).toBe(layout.sessionsById);
    expect(session.activeSessionId).toBe(layout.activeSessionId);

    expect(workspace.workspaces).toBe(layout.workspaces);
    expect(workspace.activeWorkspaceIndex).toBe(layout.activeWorkspaceIndex);
    expect(workspace.draggedTab).toBe(layout.draggedTab);

    expect(settings.showSettingsOverlay).toBe(layout.showSettingsOverlay);
    expect(settings.permissionMode).toBe(layout.permissionMode);
    expect(typeof settings.openSettings).toBe('function');
  });

  it('selectActiveSession matches getSessionById(activeSessionId) and getActiveSession()', () => {
    const s = getSessionStoreState();
    const viaSelect = selectActiveSession(s);
    const viaId = getSessionById(selectActiveSessionId(s));
    const viaActive = getActiveSession();
    expect(viaSelect?.id).toBe(viaId?.id);
    expect(viaActive?.id).toBe(viaId?.id);
    expect(getActiveSessionId()).toBe(s.activeSessionId);
    if (viaSelect && viaId) {
      expect(viaSelect).toBe(viaId);
    }
    if (viaActive && viaId) {
      expect(viaActive).toBe(viaId);
    }
  });

  it('selectActiveWorkspace matches getActiveWorkspace()', () => {
    const s = getWorkspaceStoreState();
    expect(selectActiveWorkspace(s)?.id).toBe(getActiveWorkspace()?.id);
  });

  it('settingsUi open/close/toggle helpers mutate the shared store', () => {
    closeSettings();
    expect(getSettingsUiState().showSettingsOverlay).toBe(false);

    openSettings('security');
    expect(useLayoutStore.getState().showSettingsOverlay).toBe(true);
    expect(useLayoutStore.getState().settingsActiveTab).toBe('security');

    setSettingsActiveTab('models');
    expect(getSettingsUiState().settingsActiveTab).toBe('models');

    toggleSettingsOverlay();
    expect(useLayoutStore.getState().showSettingsOverlay).toBe(false);
  });

  it('settingsUi permission / plan imperative helpers share layout', () => {
    setPermissionMode('ask');
    expect(getSettingsUiState().permissionMode).toBe('ask');
    expect(getPermissionMode()).toBe('ask');
    expect(useLayoutStore.getState().permissionMode).toBe('ask');

    setPlanModeEnabled(true);
    expect(getSettingsUiState().planModeEnabled).toBe(true);
    setPlanApproved(true);
    expect(getSettingsUiState().planApproved).toBe(true);

    setPlanApproved(false);
    setPlanModeEnabled(false);
    setPermissionMode('ask');
  });

  it('workspace setGroupActiveCard / setDropPreview / getDropPreview / focusExistingPanelCard', () => {
    const ws = getActiveWorkspace();
    expect(ws).toBeTruthy();
    if (!ws) return;

    setGroupActiveCard(ws.id, 0, 0, 'chat');
    const group = getActiveWorkspace()?.columns[0]?.groups[0];
    expect(group?.activeCardId).toBe('chat');

    setDropPreview({ colIdx: 0, groupIdx: 0, direction: 'bottom' });
    expect(getDropPreview()?.direction).toBe('bottom');
    expect(getWorkspaceStoreState().dropPreview?.direction).toBe('bottom');
    setDropPreview(null);
    expect(getDropPreview()).toBeNull();
    expect(getWorkspaceStoreState().dropPreview).toBeNull();

    const focused = focusExistingPanelCard(ws.id, 'chat');
    expect(focused).toBe(true);
    expect(focusExistingPanelCard(ws.id, '___missing_panel___')).toBe(false);
  });
});
