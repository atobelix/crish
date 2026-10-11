// 会话纯查询与 id 规范化函数（从 sessionAccess.ts 拆分，纯结构性重构）。
// 这些函数不依赖写入门面的 getSessionStoreState()，仅依赖只读 store 访问，
// 便于在纯查询/校验场景下单独复用。hub（sessionAccess.ts）re-export 保持 import 路径稳定。
import type {
  SessionAgent,
  SessionState,
} from '../../store/types';
import {
  getActiveSessionId as getActiveSessionIdFromFacade,
  getSessionById,
} from '../../store/sessionStore';

export function isNonEmptySessionId(
  sessionId: string | null | undefined
): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0;
}

export function normalizeSessionId(
  sessionId: string | null | undefined
): string | undefined {
  if (typeof sessionId !== 'string') return undefined;
  const id = sessionId.trim();
  return id.length > 0 ? id : undefined;
}

export function getActiveSessionId(): string | null {
  return getActiveSessionIdFromFacade();
}

export function selectSessionById(
  sessions: readonly SessionState[],
  sessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (sessionsById) {
    const hit = sessionsById[id];
    if (hit) return hit;
  }
  return sessions.find((s) => s.id === id);
}

export function selectActiveSession(
  sessions: readonly SessionState[],
  activeSessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  return selectSessionById(sessions, activeSessionId, sessionsById);
}

export function selectSessionAgent(
  session: SessionState | null | undefined,
  agentId: string | null | undefined
): SessionAgent | undefined {
  if (!session?.agents?.length) return undefined;
  const id = normalizeSessionId(agentId);
  if (!id) return undefined;
  return session.agents.find((a) => a.id === id);
}

export function resolveSession(
  sessionId: string | null | undefined
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  return getSessionById(id);
}

export function resolveActiveSession(): SessionState | undefined {
  const id = getActiveSessionIdFromFacade();
  return resolveSession(id);
}

export function hasSession(sessionId: string | null | undefined): boolean {
  return resolveSession(sessionId) !== undefined;
}

export function withSession<T>(
  sessionId: string | null | undefined,
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveSession(sessionId);
  if (!session) return undefined;
  return fn(session);
}

export function withActiveSession<T>(
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveActiveSession();
  if (!session) return undefined;
  return fn(session);
}

export function requireExistingSessionId(
  sessionId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (!getSessionById(id)) return undefined;
  return id;
}
