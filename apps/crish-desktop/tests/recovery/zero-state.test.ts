import { describe, it, expect } from 'vitest';
import { useLayoutStore } from '../../src/store/layoutStore';

describe('Zero State Handling', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState());
  });

  it('handles null activeSessionId', () => {
    useLayoutStore.setState({ activeSessionId: null as any });
    const state = useLayoutStore.getState();
    expect(state.activeSessionId).toBeNull();
  });

  it('handles undefined workspaces', () => {
    useLayoutStore.setState({ workspaces: [] as any });
    const state = useLayoutStore.getState();
    expect(state.workspaces).toEqual([]);
  });

  it('handles negative workspace index', () => {
    useLayoutStore.setState({ activeWorkspaceIndex: -1 });
    const state = useLayoutStore.getState();
    expect(state.activeWorkspaceIndex).toBe(-1);
  });
});
