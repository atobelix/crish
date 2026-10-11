import { describe, it, expect } from 'vitest';
import {
  useLayoutStore,
  serializeWorkspaceLayout,
  deserializeWorkspaceLayout,
} from '../../src/store/layoutStore';
import { useWorkspaceStore } from '../../src/store/workspaceStore';

describe('Store Persistence', () => {
  it('initializes with hydrated=false', () => {
    const state = useLayoutStore.getState();
    expect(state).toBeDefined();
    expect(state.hydrationComplete).toBe(false);
  });

  it('serializes and deserializes workspace layout', () => {
    const workspaceState = useWorkspaceStore.getState();
    const layoutState = useLayoutStore.getState();
    const state = {
      workspaces: workspaceState.workspaces,
      activeWorkspaceIndex: workspaceState.activeWorkspaceIndex,
      sidebarCollapsed: layoutState.sidebarCollapsed,
    };
    const snapshot = serializeWorkspaceLayout(state);
    expect(snapshot.version).toBe(1);
    expect(snapshot.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.workspaces[0]).toHaveProperty('id');
    expect(snapshot.workspaces[0]).toHaveProperty('columns');
    expect(snapshot.activeWorkspaceIndex).toBe(workspaceState.activeWorkspaceIndex);
    expect(snapshot.sidebarCollapsed).toBe(layoutState.sidebarCollapsed);

    const freshWorkspaceState = useWorkspaceStore.getState();
    const freshLayoutState = useLayoutStore.getState();
    const freshState = {
      workspaces: freshWorkspaceState.workspaces,
      activeWorkspaceIndex: freshWorkspaceState.activeWorkspaceIndex,
      sidebarCollapsed: freshLayoutState.sidebarCollapsed,
    };
    deserializeWorkspaceLayout(snapshot, freshState);
    expect(freshState.workspaces).toHaveLength(snapshot.workspaces.length);
    expect(freshState.activeWorkspaceIndex).toBe(snapshot.activeWorkspaceIndex);
    expect(freshState.sidebarCollapsed).toBe(snapshot.sidebarCollapsed);
  });
});
