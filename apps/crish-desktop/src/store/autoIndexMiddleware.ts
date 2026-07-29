/**
 * 自动会话索引中间件：在 set 路径内维护 sessionsById。
 *
 * 布局：withAutoIndex(immer(...))。
 *
 * 约束：
 * - 绝不对 frozen immer 结果做原地赋值
 * - 只要 sessions 数组引用发生变化，就重建 map，防止 sessionsById 里的 session 对象引用过时
 * - 禁止 subscribe 静默改 state
 */
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';

export interface SessionsAwareState {
  sessions: ReadonlyArray<{ id: string }>;
  sessionsById: Record<string, unknown>;
}

function buildSessionsMap(
  sessions: ReadonlyArray<{ id: string }>
): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null);
  for (const s of sessions) {
    if (s && typeof s.id === 'string' && s.id.length > 0) {
      map[s.id] = s;
    }
  }
  return map;
}

/** 稳定的 id 集合键：顺序敏感 */
function sessionsIdKey(sessions: ReadonlyArray<{ id: string }>): string {
  let key = '';
  for (let i = 0; i < sessions.length; i++) {
    const id = sessions[i]?.id;
    if (typeof id === 'string' && id.length > 0) {
      if (key) key += '\0';
      key += id;
    }
  }
  return key;
}

type AnySet = (partial: unknown, replace?: boolean) => void;

export const withAutoIndex = <
  S extends SessionsAwareState,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  config: StateCreator<S, Mps, Mcs>
): StateCreator<S, Mps, Mcs> =>
  (set, get, api) => {
    let prevSessions: ReadonlyArray<unknown> | null = null;
    const rawSet = set as never as AnySet;

    const setWithIndex: AnySet = (partial, replace) => {
      if (typeof partial === 'function') {
        rawSet((state: S) => {
          const fn = partial as (s: S) => S | void;
          const produced = fn(state);
          const next =
            produced != null && typeof produced === 'object'
              ? (produced as S)
              : state;

          if (!next || !Array.isArray(next.sessions) || next.sessions === prevSessions) {
            return next;
          }
          prevSessions = next.sessions;
          return {
            ...next,
            sessionsById: buildSessionsMap(next.sessions),
          };
        }, replace);
        return;
      }

      rawSet(partial, replace);

      // partial merge 后根据 get() 校正索引
      const after = get() as (S & SessionsAwareState) | undefined;
      if (!after || !Array.isArray(after.sessions) || after.sessions === prevSessions) return;
      prevSessions = after.sessions;
      rawSet({
        sessionsById: buildSessionsMap(after.sessions),
      } as Partial<S>);
    };

    const store = config(setWithIndex as never as typeof set, get, api);

    const seed = store as (S & SessionsAwareState) | undefined;
    if (seed && Array.isArray(seed.sessions)) {
      prevSessions = seed.sessions;
      if (!seed.sessionsById || Object.keys(seed.sessionsById).length === 0) {
        return {
          ...store,
          sessionsById: buildSessionsMap(seed.sessions),
        };
      }
    }

    return store;
  };

export { sessionsIdKey, buildSessionsMap };
