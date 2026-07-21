import type { StateCreator } from 'zustand';

type SessionsAware = {
  sessions: Array<{ id: string }>;
  sessionsById: Record<string, unknown>;
};

function _buildMap(sessions: Array<{ id: string }>): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null);
  for (const s of sessions) {
    if (s?.id) map[s.id] = s;
  }
  return map;
}

export const withAutoIndex = <S extends SessionsAware>(
  config: StateCreator<S>,
): StateCreator<S> =>
  (set, get, api) => {
    const store = config(set, get, api);
    let prevSessions: Array<{ id: string }> = (store as unknown as SessionsAware).sessions;

    api.subscribe((state) => {
      const currentSessions = (state as unknown as SessionsAware).sessions;
      if (currentSessions !== prevSessions) {
        prevSessions = currentSessions;
        api.setState({ sessionsById: _buildMap(currentSessions) } as Partial<S>);
      }
    });

    return store;
  };
