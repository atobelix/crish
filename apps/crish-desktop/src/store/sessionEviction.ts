/**
 * apps/crish-desktop/src/store/sessionEviction.ts
 *
 * 标签栏与分屏感知的会话消息软驱逐状态机（Wave 1 · Task W1-E）。
 * - 级别 1（PinnedActive）：当前活跃聚焦会话 + 正在接收流式推流的会话（isStreaming=true），绝对禁止驱逐！
 * - 级别 2（OpenRetained）：处于分屏或任意打开标签栏中（WorkspaceShellStore / LayoutTreeStore）的会话，高优先级保活；
 * - 级别 3（EvictableCandidate）：既非当前聚焦、亦非打开标签、且未处于推流态的后台历史会话，按 LRU 顺序软驱逐正文。
 */

import { SESSION_HYDRATE_KEEP_K } from '../api/perfBudgets';
import { getSessionForWrite } from './sessionIndex';
import type { SessionState } from './types';
import {
  addOpenTabsInputToSet,
  clearSessionAccessTimestamps,
  getActiveStreamingSessionIds,
  getOpenTabSessionIds,
  getVisibleSplitSessionIds,
  isSessionBodyHydrated,
  isSessionStreaming,
  isValidRealSessionId,
  recordSessionAccess,
  resolveSessionLruTimestamp,
  type EvictableSessionFields,
  type EvictableSessionState,
  type OpenTabsInput,
  type SessionEvictionDescriptor,
  type SessionEvictionOptions,
  type SessionEvictionPlan,
  type SessionEvictionTier,
} from './sessionEvictionProbes';

export {
  addOpenTabsInputToSet,
  clearSessionAccessTimestamps,
  getActiveStreamingSessionIds,
  getOpenTabSessionIds,
  getVisibleSplitSessionIds,
  isSessionBodyHydrated,
  isSessionStreaming,
  isValidRealSessionId,
  recordSessionAccess,
  resolveSessionLruTimestamp,
  type EvictableSessionFields,
  type EvictableSessionState,
  type OpenTabsInput,
  type SessionEvictionDescriptor,
  type SessionEvictionOptions,
  type SessionEvictionPlan,
  type SessionEvictionTier,
};

/** 计算单个会话的三级保活状态机层级（PinnedActive / OpenRetained / EvictableCandidate） */
export function classifySessionEvictionTier(
  session: SessionState,
  context: {
    activeSessionId?: string | null;
    streamingSessionIds?: ReadonlySet<string>;
    openTabSessionIds?: ReadonlySet<string>;
    visibleSplitSessionIds?: ReadonlySet<string>;
  }
): SessionEvictionTier {
  const sid = (session?.id || '').trim();
  const activeId = (context.activeSessionId || '').trim();
  if (
    (activeId && sid === activeId) ||
    context.streamingSessionIds?.has(sid) ||
    isSessionStreaming(session, context.streamingSessionIds)
  ) {
    return 'PinnedActive';
  }
  if (
    context.visibleSplitSessionIds?.has(sid) ||
    context.openTabSessionIds?.has(sid)
  ) {
    return 'OpenRetained';
  }
  return 'EvictableCandidate';
}

/** 运行三级保活软驱逐状态机评估，生成完整保活分类与待驱逐会话列表 */
export function evaluateSessionEviction(
  sessions: readonly SessionState[],
  sessionsById: Readonly<Record<string, SessionState>>,
  options: SessionEvictionOptions = {}
): SessionEvictionPlan {
  const activeId = (options.activeSessionId || '').trim();
  if (activeId) recordSessionAccess(activeId);

  const visibleSplitIds = getVisibleSplitSessionIds(options.layoutTreeRoot);
  addOpenTabsInputToSet(
    options.visibleSplitSessionIds as OpenTabsInput,
    visibleSplitIds
  );
  const openTabIds = getOpenTabSessionIds({
    openTabs: options.openTabs,
    visibleSplitSessionIds: visibleSplitIds,
    layoutTreeRoot: options.layoutTreeRoot,
  });
  const streamingIds = getActiveStreamingSessionIds(
    sessionsById,
    sessions,
    options.streamingSessionIds
  );

  const orderedSessions: SessionState[] = [];
  const seenIds = new Set<string>();
  for (const s of sessions) {
    if (s?.id && !seenIds.has(s.id)) {
      seenIds.add(s.id);
      orderedSessions.push(sessionsById[s.id] ?? s);
    }
  }
  for (const [id, s] of Object.entries(sessionsById)) {
    if (id && s && !seenIds.has(id)) {
      seenIds.add(id);
      orderedSessions.push(s);
    }
  }

  const descriptorsById: Record<string, SessionEvictionDescriptor> = {};
  const pinnedActiveIds: string[] = [];
  const openRetainedIds: string[] = [];
  const evictableCandidateIds: string[] = [];
  const hydratedPinned: SessionEvictionDescriptor[] = [];
  const hydratedOpenRetained: SessionEvictionDescriptor[] = [];
  const hydratedCandidates: SessionEvictionDescriptor[] = [];

  orderedSessions.forEach((sess, index) => {
    const sid = sess.id;
    const isHydrated = isSessionBodyHydrated(sess);
    const tier = classifySessionEvictionTier(sess, {
      activeSessionId: activeId,
      streamingSessionIds: streamingIds,
      openTabSessionIds: openTabIds,
      visibleSplitSessionIds: visibleSplitIds,
    });
    const desc: SessionEvictionDescriptor = {
      sessionId: sid,
      tier,
      isHydrated,
      isStreaming: streamingIds.has(sid),
      isActive: Boolean(activeId && sid === activeId),
      isVisibleInSplit: visibleSplitIds.has(sid),
      isOpenInTab: openTabIds.has(sid),
      lastAccessedAt: resolveSessionLruTimestamp(sess),
      orderIndex: index,
    };
    descriptorsById[sid] = desc;
    if (tier === 'PinnedActive') {
      pinnedActiveIds.push(sid);
      if (isHydrated) hydratedPinned.push(desc);
    } else if (tier === 'OpenRetained') {
      openRetainedIds.push(sid);
      if (isHydrated) hydratedOpenRetained.push(desc);
    } else {
      evictableCandidateIds.push(sid);
      if (isHydrated) hydratedCandidates.push(desc);
    }
  });

  const normalizedKeepBudget = Math.max(
    1,
    options.keepBudget ?? SESSION_HYDRATE_KEEP_K
  );
  const totalHydratedCount =
    hydratedPinned.length +
    hydratedOpenRetained.length +
    hydratedCandidates.length;
  if (totalHydratedCount <= normalizedKeepBudget) {
    return {
      descriptorsById,
      pinnedActiveIds,
      openRetainedIds,
      evictableCandidateIds,
      sessionIdsToEvict: [],
    };
  }

  const compareLruOldestFirst = (
    a: SessionEvictionDescriptor,
    b: SessionEvictionDescriptor
  ): number =>
    a.lastAccessedAt !== b.lastAccessedAt
      ? a.lastAccessedAt - b.lastAccessedAt
      : b.orderIndex - a.orderIndex;

  hydratedCandidates.sort(compareLruOldestFirst);

  let extraOpenRetainedToEvict: SessionEvictionDescriptor[] = [];
  if (
    typeof options.openRetainedLimit === 'number' &&
    Number.isFinite(options.openRetainedLimit) &&
    options.openRetainedLimit >= 0
  ) {
    const bgTabs = hydratedOpenRetained
      .filter((d) => !d.isVisibleInSplit)
      .sort(compareLruOldestFirst);
    const allowedBg = Math.max(
      0,
      options.openRetainedLimit - (hydratedOpenRetained.length - bgTabs.length)
    );
    if (bgTabs.length > allowedBg)
      extraOpenRetainedToEvict = bgTabs.slice(0, bgTabs.length - allowedBg);
  }

  const protectedCount =
    hydratedPinned.length +
    (hydratedOpenRetained.length - extraOpenRetainedToEvict.length);
  const candidateKeepSlots = Math.max(0, normalizedKeepBudget - protectedCount);
  const candidateEvictCount = Math.max(
    0,
    hydratedCandidates.length - candidateKeepSlots
  );

  const sessionIdsToEvict = hydratedCandidates
    .slice(0, candidateEvictCount)
    .concat(extraOpenRetainedToEvict)
    .map((d) => d.sessionId);

  return {
    descriptorsById,
    pinnedActiveIds,
    openRetainedIds,
    evictableCandidateIds,
    sessionIdsToEvict,
  };
}

/** 规划应被软驱逐的会话 ID 列表（三级保活 + LRU 淘汰） */
export function planSessionsToEvict(
  activeSessionId: string,
  sessions: readonly SessionState[],
  sessionsById: Readonly<Record<string, SessionState>>,
  keepBudget: number = SESSION_HYDRATE_KEEP_K,
  options?: Omit<SessionEvictionOptions, 'activeSessionId' | 'keepBudget'>
): string[] {
  return evaluateSessionEviction(sessions, sessionsById, {
    ...options,
    activeSessionId,
    keepBudget,
  }).sessionIdsToEvict;
}

/** 兼容旧入口签名：返回软驱逐预算之外的非活跃已水合会话 ID 列表 */
export function findInactiveHydratedSessionIdsToEvict(
  activeSessionId: string,
  streamingSessionIds: ReadonlySet<string> = new Set(),
  sessions: readonly SessionState[] = [],
  sessionsById: Readonly<Record<string, SessionState>> = {},
  keepBudget: number = SESSION_HYDRATE_KEEP_K,
  options?: Omit<
    SessionEvictionOptions,
    'activeSessionId' | 'streamingSessionIds' | 'keepBudget'
  >
): string[] {
  return evaluateSessionEviction(sessions, sessionsById, {
    ...options,
    activeSessionId,
    streamingSessionIds,
    keepBudget,
  }).sessionIdsToEvict;
}

/** 将单个会话对象原地重置为软驱逐懒壳（保留壳层元数据，标记 messagesHydrated=false，messages=[]） */
export function softEvictSessionToLazyShell(session: SessionState): void {
  if (!session) return;
  session.messages = [];
  session.messagesHydrated = false;
  delete session.hydratedFromEngine;
  const ext = session as EvictableSessionState;
  if ('hydrationStatus' in ext) ext.hydrationStatus = 'Shell_Lazy';
  if (ext.hydrationMeta && typeof ext.hydrationMeta === 'object') {
    ext.hydrationMeta = { ...ext.hydrationMeta, status: 'Shell_Lazy' };
  }
}

/** 在 Store 状态上执行软驱逐，自带 PinnedActive / OpenRetained 安全守卫 */
export function applySoftEvictionInState<
  T extends {
    activeSessionId?: string;
    sessions: SessionState[];
    sessionsById: Record<string, SessionState>;
  },
>(
  state: T,
  sessionIdsToEvict: readonly string[],
  options?: {
    streamingSessionIds?: ReadonlySet<string>;
    openTabSessionIds?: ReadonlySet<string>;
  }
): string[] {
  const evicted: string[] = [];
  const activeId = (state.activeSessionId || '').trim();
  for (const rawId of sessionIdsToEvict) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    const sess = getSessionForWrite(state, id);
    if (!sess) continue;
    if (
      (activeId && id === activeId) ||
      options?.streamingSessionIds?.has(id) ||
      isSessionStreaming(sess, options?.streamingSessionIds) ||
      options?.openTabSessionIds?.has(id)
    ) {
      continue;
    }
    softEvictSessionToLazyShell(sess);
    state.sessionsById[id] = sess;
    evicted.push(id);
  }
  return evicted;
}
