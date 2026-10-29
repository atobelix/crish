import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../src/store/sessionStore';
import { useLayoutStore } from '../../src/store/layoutStore';
import {
  buildSessionIndex,
  listSessions,
  replaceSessions,
} from '../../src/store/sessionIndex';
import type { SessionMessage, SessionState } from '../../src/store/types';

function boundarySession(
  id: string,
  title: string,
  messages: SessionMessage[] = []
): SessionState {
  return {
    id,
    title,
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages,
    agents: [],
  };
}

describe('Store Boundary Conditions', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState());
    useSessionStore.setState(useSessionStore.getInitialState());
  });

  it('handles creating 1000 sessions', () => {
    for (let i = 0; i < 1000; i++) {
      useSessionStore.setState((s) => {
        replaceSessions(s, [
          ...listSessions(s),
          boundarySession(`sess-${i}`, `Session ${i}`),
        ]);
      });
    }
    const state = useSessionStore.getState();
    expect(listSessions(state).length).toBe(1000);
  });

  it('handles empty session array', () => {
    useSessionStore.setState(buildSessionIndex([]));
    const state = useSessionStore.getState();
    expect(listSessions(state)).toEqual([]);
  });

  it('handles session with 10000 messages', () => {
    const messages: SessionMessage[] = Array.from({ length: 10000 }, (_, i) => ({
      id: `msg-${i}`,
      sender: 'user',
      timestamp: i,
      text: `message ${i}`,
    }));
    useSessionStore.setState(
      buildSessionIndex([boundarySession('big-session', 'Big', messages)])
    );
    const state = useSessionStore.getState();
    expect(listSessions(state)[0]!.messages.length).toBe(10000);
  });

  it('handles extremely long session title', () => {
    const longTitle = 'x'.repeat(10000);
    useSessionStore.setState(
      buildSessionIndex([boundarySession('long-title', longTitle)])
    );
    const state = useSessionStore.getState();
    expect(listSessions(state)[0]!.title.length).toBe(10000);
  });

  it('handles session ID collision gracefully', () => {
    useSessionStore.setState(
      buildSessionIndex([
        boundarySession('dup', 'First'),
        boundarySession('dup', 'Second'),
      ])
    );
    const state = useSessionStore.getState();
    const dups = listSessions(state).filter((s) => s.id === 'dup');
    // 索引先到先得：重复 id 不进入 sessionOrder，不再保留两条数组副本
    expect(dups.length).toBe(1);
    expect(dups[0]!.title).toBe('First');
  });
});
