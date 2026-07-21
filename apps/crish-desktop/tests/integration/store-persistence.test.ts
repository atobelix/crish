import { describe, it, expect } from 'vitest';
import {
  useLayoutStore,
  serializeWorkspaceLayout,
  deserializeWorkspaceLayout,
} from '../../src/store/layoutStore';

describe('Store Persistence', () => {
  it('initializes with hydrated=false', () => {
    const state = useLayoutStore.getState();
    expect(state).toBeDefined();
    expect(state.hydrationComplete).toBe(false);
  });

  it('serializes and deserializes workspace layout', () => {
    const state = useLayoutStore.getState();
    const snapshot = serializeWorkspaceLayout(state);
    expect(snapshot.version).toBe(1);
    expect(snapshot.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.workspaces[0]).toHaveProperty('id');
    expect(snapshot.workspaces[0]).toHaveProperty('columns');

    const freshState = useLayoutStore.getState();
    deserializeWorkspaceLayout(snapshot, freshState);
    expect(freshState.workspaces).toHaveLength(snapshot.workspaces.length);
  });
});
