/**
 * D5 软驱逐算法单测（纯逻辑 + 注入 stub store）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/sessionStore', () => {
  const evictSessionMessages = vi.fn();
  const state = {
    sessions: [] as unknown[],
    sessionsById: {} as Record<string, unknown>,
    evictSessionMessages,
  };
  return {
    useSessionStore: {
      getState: () => state,
    },
    __state: state,
  };
});

import { evictInactiveHydratedSessionsWithGuards } from './sessionMessageEvict';
// @ts-expect-error test mock
import { __state } from '../../store/sessionStore';

describe('evictInactiveHydratedSessionsWithGuards', () => {
  beforeEach(() => {
    __state.sessions = [];
    __state.sessionsById = {};
    __state.evictSessionMessages.mockClear();
  });

  it('超过 K 的非活跃已水合会话被驱逐，活跃保留', () => {
    const mk = (id: string) => ({
      id,
      messages: [{ id: 'm' }],
      messagesHydrated: true,
      hydratedFromEngine: true,
    });
    // K=3：active a + 前 2 已水合（b,c）→ 仅 d 驱逐
    __state.sessions = [mk('a'), mk('b'), mk('c'), mk('d')];
    __state.sessionsById = Object.fromEntries(
      (__state.sessions as { id: string }[]).map((s) => [s.id, s]),
    );

    const evicted = evictInactiveHydratedSessionsWithGuards('a', new Set());
    expect(evicted).toEqual(['d']);
    expect(__state.evictSessionMessages).toHaveBeenCalledWith(['d']);
  });

  it('流式保护会话不被驱逐', () => {
    const mk = (id: string) => ({
      id,
      messages: [{ id: 'm' }],
      messagesHydrated: true,
      hydratedFromEngine: true,
    });
    __state.sessions = [mk('a'), mk('b'), mk('c'), mk('d')];
    __state.sessionsById = Object.fromEntries(
      (__state.sessions as { id: string }[]).map((s) => [s.id, s]),
    );
    const evicted = evictInactiveHydratedSessionsWithGuards('a', new Set(['b']));
    expect(evicted).not.toContain('b');
  });
});
