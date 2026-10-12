import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useSessionStore } from '../../store/storeAccess';
import type { SessionState } from '../../store/types';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';

export const EMPTY_ARRAY: never[] = [];

export type SessionStoreStateShape = {
  activeSessionId: string;
  sessionsById: Record<string, SessionState | undefined>;
};

/**
 * 会话级订阅短路（T4.2，A-10，B-01，清退全局 activeSessionId 耦合）。
 *
 * 1. 优先通过 useScopedSessionId 获取当前子窗口绑定的 sessionId（SSOT），
 *    消除非活跃分屏对全局 activeSessionId 的无谓订阅；
 * 2. 只要本组件解析出的 sid 未变（prevSid === sid）、且该 session 引用未变，直接短路；
 * 3. 增加 Object.is 校验阻断无效 forceUpdate。
 */
export function useScopedSessionField<T>(
  resolveSidOrSessionId:
    string | null | undefined | ((state: SessionStoreStateShape) => string),
  selector: (session: SessionState | undefined) => T
): T {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  // 若传入的是显式 sessionId（或未传函数），优先经 useScopedSessionId 获取作用域会话 ID
  const explicitOrNullSid =
    typeof resolveSidOrSessionId === 'string' || resolveSidOrSessionId == null
      ? resolveSidOrSessionId
      : undefined;
  const leafScopedSid = useScopedSessionId(explicitOrNullSid);

  const resolveSid = useCallback(
    (st: SessionStoreStateShape): string => {
      if (typeof resolveSidOrSessionId === 'function') {
        const resolved = resolveSidOrSessionId(st);
        // 若函数返回了全局 activeSessionId，但在子窗口内有专属会话 ID，优先收敛为子窗口专属 ID
        if (resolved === st.activeSessionId && leafScopedSid) {
          return leafScopedSid;
        }
        return resolved;
      }
      return leafScopedSid;
    },
    [resolveSidOrSessionId, leafScopedSid]
  );

  const resolveSidRef = useRef(resolveSid);
  resolveSidRef.current = resolveSid;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{
    sid: string;
    session: SessionState | undefined;
    value: T;
  } | null>(null);

  useEffect(() => {
    return useSessionStore.subscribe((state, prev) => {
      const st = state;
      const sid = resolveSidRef.current(st);
      const prevSid = resolveSidRef.current(prev);
      const session = st.sessionsById[sid];
      const cached = cacheRef.current;

      // 会话级订阅短路：本组件解析出的 sid 未变且 session 引用未变 -> 直接短路
      if (
        cached &&
        cached.sid === sid &&
        prevSid === sid &&
        cached.session === session
      ) {
        return;
      }

      const nextValue = selectorRef.current(session);
      if (cached && cached.sid === sid && Object.is(cached.value, nextValue)) {
        cached.session = session;
        return;
      }

      cacheRef.current = { sid, session, value: nextValue };
      forceUpdate();
    });
  }, []);

  // 渲染期求值（首次挂载 / forceUpdate 后）：缓存命中直接复用
  const st = useSessionStore.getState();
  const sid = resolveSid(st);
  const session = st.sessionsById[sid];
  const cached = cacheRef.current;
  if (!cached || cached.sid !== sid || cached.session !== session) {
    const value = selector(session);
    cacheRef.current = { sid, session, value };
  }
  return cacheRef.current!.value;
}
