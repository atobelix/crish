/**
 * D5 软驱逐单测：恢复懒壳 + 清 hydratedFromEngine + 不写库。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionActions } from './sessionActions';
import type { SessionActions, SessionStoreSlice } from './sessionActions';
import { buildSessionIndex, isSessionsIndexConsistent, replaceSessions } from './sessionIndex';
import type { SessionState } from './types';

function makeState(): SessionStoreSlice {
  return {
    ...buildSessionIndex([]),
    folderOrder: [],
    activeSessionId: '',
    draftFolder: '',
    activeAgentId: null,
    panelAgentId: null,
    composerDrafts: {},
  };
}

function sess(
  id: string,
  msgs: SessionState['messages'] = [],
  extra: Partial<SessionState> = {},
): SessionState {
  return {
    id,
    title: id,
    messages: msgs,
    messagesHydrated: true,
    hydratedFromEngine: true,
    ...extra,
  } as SessionState;
}

describe('evictSessionMessages (D5)', () => {
  let state: SessionStoreSlice;
  let actions: SessionActions;

  beforeEach(() => {
    state = makeState();
    const set = (fn: (s: SessionStoreSlice) => void) => {
      fn(state);
    };
    actions = createSessionActions(set, () => state);
  });

  it('驱逐后 messages=[]、messagesHydrated=false、无 hydratedFromEngine', () => {
    replaceSessions(state, [
      sess('s1', [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }]),
    ]);

    actions.evictSessionMessages(['s1']);

    const s = state.sessionsById['s1']!;
    expect(s.messages).toEqual([]);
    expect(s.messagesHydrated).toBe(false);
    expect('hydratedFromEngine' in s ? s.hydratedFromEngine : undefined).toBeUndefined();
    expect(isSessionsIndexConsistent(state)).toBe(true);
  });

  it('空 id 与不存在会话为 no-op', () => {
    replaceSessions(state, []);
    actions.evictSessionMessages(['', 'ghost']);
    expect(Object.keys(state.sessionsById)).toHaveLength(0);
    expect(state.sessionOrder).toHaveLength(0);
    expect(isSessionsIndexConsistent(state)).toBe(true);
  });
});
