import { useEffect, useReducer, useRef } from 'react';
import { useSessionStore } from '../../store/storeAccess';
import type { SessionState } from '../../store/types';

export const EMPTY_ARRAY: never[] = [];

export type SessionStoreStateShape = {
  activeSessionId: string;
  sessionsById: Record<string, SessionState | undefined>;
};

/**
 * 会话级订阅短路（T4.2，R-05，08-detail 4.1-2）。
 *
 * 任何 session 域变更（工具快照/审批/subagent 事件 immer patch）都会触发
 * zustand 订阅——普通 selector 路径每次变更都要重求值 + Object.is 比较。
 * 本 hook 用 vanilla subscribe((state, prev) => ...) 在监听器层短路：
 * 本会话引用未变（immer 结构共享保证未变会话引用不变）且 activeSessionId
 * 未变 -> 不重求值、不触发渲染。
 *
 * 语义边界：短路仅省求值与渲染，不改变渲染结果（依赖「activeSessionId
 * 恒与渲染中的 ChatCard 一致」的既有假设；多会话多 Tab 现状已在 R-05
 * 判定为浪费面，短路后视觉无变化——07 方案风险 7）。
 */
export function useScopedSessionField<T>(
  resolveSid: (state: SessionStoreStateShape) => string,
  selector: (session: SessionState | undefined) => T
): T {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
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
      // 会话级订阅短路：本会话引用未变 + activeSessionId 未变 -> 直接短路
      if (
        cached &&
        cached.sid === prevSid &&
        cached.session === session &&
        prev.activeSessionId === st.activeSessionId
      ) {
        return;
      }
      cacheRef.current = { sid, session, value: selectorRef.current(session) };
      forceUpdate();
    });
  }, []);

  // 渲染期求值（首次挂载 / forceUpdate 后）：缓存命中直接复用
  const st = useSessionStore.getState();
  const sid = resolveSid(st);
  const session = st.sessionsById[sid];
  const cached = cacheRef.current;
  if (!cached || cached.sid !== sid || cached.session !== session) {
    cacheRef.current = { sid, session, value: selector(session) };
  }
  return cacheRef.current!.value;
}
