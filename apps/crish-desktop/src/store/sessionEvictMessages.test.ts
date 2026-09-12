/**
 * D5 软驱逐单测：恢复懒壳 + 清 hydratedFromEngine + 不写库。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionActions } from './sessionActions';
import type { SessionActions, SessionStoreSlice } from './sessionActions';
import type { SessionState } from './types';

type Slice = SessionStoreSlice & Partial<SessionActions> & {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
};

function makeState(): Slice {
  const base: SessionStoreSlice = {
    sessions: [],
    sessionsById: {},
    folderOrder: [],
    activeSessionId: '',
    draftFolder: '',
    activeAgentId: null,
    panelAgentId: null,
    composerDrafts: {},
  };
  return base as Slice;
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
  let state: Slice;
  let actions: SessionActions;

  beforeEach(() => {
    state = makeState();
    // @ts-expect-error test harness set
    const set = (fn: (s: Slice) => void) => {
      fn(state);
    };
    actions = createSessionActions(set as never, () => state) as SessionActions;
  });

  it('驱逐后 messages=[]、messagesHydrated=false、无 hydratedFromEngine', () => {
    state.sessions = [sess('s1', [{ id: 'm1', text: 'hi' } as never])];
    state.sessionsById = { s1: state.sessions[0]! };

    actions.evictSessionMessages(['s1']);

    const s = state.sessionsById['s1']!;
    expect(s.messages).toEqual([]);
    expect(s.messagesHydrated).toBe(false);
    expect('hydratedFromEngine' in s ? s.hydratedFromEngine : undefined).toBeUndefined();
  });

  it('空 id 与不存在会话为 no-op', () => {
    state.sessions = [];
    state.sessionsById = {};
    actions.evictSessionMessages(['', 'ghost']);
    expect(Object.keys(state.sessionsById)).toHaveLength(0);
  });
});
