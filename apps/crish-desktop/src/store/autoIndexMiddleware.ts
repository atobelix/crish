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

export function isSessionsAwareState(s: unknown): s is SessionsAwareState {
  return (
    typeof s === 'object' &&
    s !== null &&
    'sessions' in s &&
    Array.isArray((s as { sessions: unknown }).sessions)
  );
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

type SetStateFn<S> = (
  partial: S | Partial<S> | ((state: S) => S | Partial<S> | void),
  replace?: boolean
) => void;

export const withAutoIndex =
  <
    S extends SessionsAwareState,
    Mps extends [StoreMutatorIdentifier, unknown][] = [],
    Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  >(
    config: StateCreator<S, Mps, Mcs>
  ): StateCreator<S, Mps, Mcs> =>
  (set, get, api) => {
    let prevSessions: ReadonlyArray<{ id: string }> | null = null;
    const rawSet = set as unknown as SetStateFn<S>;

    const setWithIndex: SetStateFn<S> = (partial, replace) => {
      // 1. 函数形式的 partial（例如未经 immer 或手写函数派发）
      if (typeof partial === 'function') {
        rawSet((state: S) => {
          const produced = partial(state);
          const next =
            produced != null && typeof produced === 'object' ? produced : state;

          if (!isSessionsAwareState(next)) {
            return produced;
          }
          const nextSessions = next.sessions;
          if (nextSessions === prevSessions && next.sessionsById) {
            return produced;
          }
          prevSessions = nextSessions;
          return {
            ...next,
            sessionsById: buildSessionsMap(nextSessions),
          };
        }, replace);
        return;
      }

      // 2. 对象形式的 partial（包括 immer produce 后产生的已结算对象）
      if (partial != null && typeof partial === 'object') {
        // 若设置 replace === true
        if (replace) {
          if (isSessionsAwareState(partial)) {
            if (partial.sessions !== prevSessions || !partial.sessionsById) {
              prevSessions = partial.sessions;
              rawSet(
                {
                  ...partial,
                  sessionsById: buildSessionsMap(partial.sessions),
                } as S,
                true
              );
              return;
            }
          }
          rawSet(partial, true);
          return;
        }

        // replace 为 false 或 undefined 的常规合并更新
        if (isSessionsAwareState(partial)) {
          if (
            partial.sessions !== prevSessions ||
            !('sessionsById' in partial)
          ) {
            prevSessions = partial.sessions;
            rawSet(
              {
                ...partial,
                sessionsById: buildSessionsMap(partial.sessions),
              } as S,
              false
            );
            return;
          }
        }
      }

      // 3. 不涉及 sessions 变更的其他字段更新，单次直接派发
      rawSet(partial, replace);
    };

    const store = config(setWithIndex as unknown as typeof set, get, api);

    if (isSessionsAwareState(store)) {
      prevSessions = store.sessions;
      if (!store.sessionsById || Object.keys(store.sessionsById).length === 0) {
        return {
          ...store,
          sessionsById: buildSessionsMap(store.sessions),
        };
      }
    }

    return store;
  };

export { buildSessionsMap };
