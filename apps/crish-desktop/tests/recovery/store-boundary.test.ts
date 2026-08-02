import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../src/store/sessionStore';
import { useLayoutStore } from '../../src/store/layoutStore';

describe('Store Boundary Conditions', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState());
    useSessionStore.setState(useSessionStore.getInitialState());
  });

  it('handles creating 1000 sessions', () => {
    for (let i = 0; i < 1000; i++) {
    useSessionStore.setState(_s => ({
        sessions: [...s.sessions, { 
          id: `sess-${i}`, title: `Session ${i}`, messages: [], agents: [] 
        } as any]
      }));
    }
    const state = useSessionStore.getState();
    expect(state.sessions.length).toBe(1000);
  });

  it('handles empty session array', () => {
    useSessionStore.setState({ sessions: [] });
    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([]);
  });

  it('handles session with 10000 messages', () => {
    const messages = Array.from({ length: 10000 }, (_, i) => ({
      id: `msg-${i}`, role: 'user' as const, content: `message ${i}`,
    }));
    useSessionStore.setState(_s => ({
      sessions: [{ id: 'big-session', title: 'Big', messages, agents: [] } as any],
    }));
    const state = useSessionStore.getState();
    expect(state.sessions[0].messages.length).toBe(10000);
  });

  it('handles extremely long session title', () => {
    const longTitle = 'x'.repeat(10000);
    useSessionStore.setState(_s => ({
      sessions: [{ id: 'long-title', title: longTitle, messages: [], agents: [] } as any],
    }));
    const state = useSessionStore.getState();
    expect(state.sessions[0].title.length).toBe(10000);
  });

  it('handles session ID collision gracefully', () => {
    useSessionStore.setState(_s => ({
      sessions: [
        { id: 'dup', title: 'First', messages: [], agents: [] } as any,
        { id: 'dup', title: 'Second', messages: [], agents: [] } as any,
      ],
    }));
    const state = useSessionStore.getState();
    expect(state.sessions.filter(s => s.id === 'dup').length).toBe(2); // Zustand allows duplicates
  });
});
