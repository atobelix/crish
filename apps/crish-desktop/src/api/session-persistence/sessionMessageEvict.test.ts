/**
 * D5 软驱逐算法单测（纯逻辑 + 注入 stub store）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type EvictStubSession = {
  id: string;
  messages: { id: string }[];
  messagesHydrated: boolean;
  hydratedFromEngine: boolean;
};

const h = vi.hoisted(() => {
  const evictSessionMessages = vi.fn();
  const state = {
    sessionsById: {} as Record<string, EvictStubSession>,
    sessionOrder: [] as string[],
    evictSessionMessages,
  };
  return { state };
});

vi.mock('../../store/sessionStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../store/sessionStore')>();
  return {
    ...actual,
    useSessionStore: {
      getState: () => h.state,
    },
  };
});

import { evictInactiveHydratedSessionsWithGuards } from './sessionMessageEvict';

function seedHydrated(ids: string[]) {
  const sessions = ids.map((id) => ({
    id,
    messages: [{ id: 'm' }],
    messagesHydrated: true,
    hydratedFromEngine: true,
  }));
  h.state.sessionOrder = sessions.map((s) => s.id);
  h.state.sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));
}

describe('evictInactiveHydratedSessionsWithGuards', () => {
  beforeEach(() => {
    h.state.sessionOrder = [];
    h.state.sessionsById = {};
    h.state.evictSessionMessages.mockClear();
  });

  it('超过 K 的非活跃已水合会话被驱逐，活跃保留', () => {
    // K=3：active a + 前 2 已水合（b,c）→ 仅 d 驱逐
    seedHydrated(['a', 'b', 'c', 'd']);

    const evicted = evictInactiveHydratedSessionsWithGuards('a', new Set());
    expect(evicted).toEqual(['d']);
    expect(h.state.evictSessionMessages).toHaveBeenCalledWith(['d']);
  });

  it('流式保护会话不被驱逐', () => {
    seedHydrated(['a', 'b', 'c', 'd']);
    const evicted = evictInactiveHydratedSessionsWithGuards('a', new Set(['b']));
    expect(evicted).not.toContain('b');
  });
});
