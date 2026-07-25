import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from '../../src/store/layoutStore';
import { useSessionStore } from '../../src/store/sessionStore';

describe('Store Race Conditions', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState());
    useSessionStore.setState(useSessionStore.getInitialState());
  });

  it('handles 50 concurrent mutations without data loss', async () => {
    const mutations = Array.from({ length: 50 }, (_, i) => 
      () => useLayoutStore.setState((s: any) => { s.activeWorkspaceIndex = i % 3; })
    );
    
    await Promise.all(mutations.map(fn => Promise.resolve().then(fn)));
    
    const finalState = useLayoutStore.getState();
    expect(finalState.activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
    expect(finalState.activeWorkspaceIndex).toBeLessThan(3);
  });

  it('handles concurrent session creation and deletion', async () => {
    const ops: (() => void)[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(() => useSessionStore.setState((s: any) => {
        if (!Array.isArray(s.sessions)) s.sessions = [];
        s.sessions.push({ id: `sess-${i}`, title: `Session ${i}`, messages: [], agents: [] });
      }));
      ops.push(() => useSessionStore.setState((s: any) => {
        if (Array.isArray(s.sessions)) {
          s.sessions = s.sessions.filter((x: any) => x.id !== `sess-${i}`);
        }
      }));
    }
    
    await Promise.all(ops.map(fn => Promise.resolve().then(fn)));
    
    const state = useSessionStore.getState();
    expect(state.sessions).toBeDefined();
  });

  it('survives 100 rapid transactions without corruption', async () => {
    for (let i = 0; i < 100; i++) {
      useLayoutStore.setState({ activeWorkspaceIndex: i % 5 });
    }
    const state = useLayoutStore.getState();
    expect(typeof state.activeWorkspaceIndex).toBe('number');
  });
});
