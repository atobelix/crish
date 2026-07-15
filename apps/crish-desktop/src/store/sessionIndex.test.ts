import { describe, expect, it } from 'vitest';
import {
  buildSessionsById,
  getSessionById,
  getSessionIndex,
  reindexSessionsById,
  type SessionsIndexed,
} from './sessionIndex';
import type { SessionState } from './types';

function sess(id: string, title = id): SessionState {
  return {
    id,
    title,
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
  };
}

describe('sessionIndex', () => {
  it('buildSessionsById maps id to same object refs', () => {
    const a = sess('a');
    const b = sess('b');
    const map = buildSessionsById([a, b]);
    expect(map.a).toBe(a);
    expect(map.b).toBe(b);
  });

  it('getSessionById is O(1) via sessionsById', () => {
    const a = sess('a');
    const b = sess('b');
    const state: SessionsIndexed = {
      sessions: [a, b],
      sessionsById: buildSessionsById([a, b]),
    };
    expect(getSessionById(state, 'b')).toBe(b);
    expect(getSessionById(state, 'missing')).toBeUndefined();
  });

  it('getSessionById falls back to scan and backfills index', () => {
    const a = sess('a');
    const state: SessionsIndexed = {
      sessions: [a],
      sessionsById: {},
    };
    expect(getSessionById(state, 'a')).toBe(a);
    expect(state.sessionsById.a).toBe(a);
  });

  it('reindexSessionsById rebuilds after structural change', () => {
    const a = sess('a');
    const b = sess('b');
    const state: SessionsIndexed = {
      sessions: [a],
      sessionsById: buildSessionsById([a]),
    };
    state.sessions.push(b);
    reindexSessionsById(state);
    expect(getSessionById(state, 'b')).toBe(b);
    expect(getSessionIndex(state, 'a')).toBe(0);
    expect(getSessionIndex(state, 'b')).toBe(1);
  });
});
