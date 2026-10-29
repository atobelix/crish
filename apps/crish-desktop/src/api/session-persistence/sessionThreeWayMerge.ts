/**
 * sessionThreeWayMerge — 启动回灌：内存态 L 与 SQLite 远端态 R 的集合论 3-Way Session Merge
 *
 * 修复慢盘响应下回灌丢弃历史会话 (R \ L) 的缺陷；墓碑守卫防止已删除会话复活。
 * 迟到快照合并（降级水合后）见 ./sessionLateArrivalMerge。
 */
import type {
  SessionAgent,
  SessionMessage,
  SessionState,
} from '../../store/types';

export interface ThreeWayMergeResult {
  mergedSessions: SessionState[];
  mergedById: Record<string, SessionState>;
  addedFromRemoteCount: number;
  preservedLocalNewCount: number;
  filledBodiesCount: number;
  skippedTombstonedCount: number;
}

/** 正交子树派生字段（存在才同步） */
export interface OrthogonalSubtreeTarget {
  metaById?: Record<string, Omit<SessionState, 'messages' | 'agents'>>;
  messagesBySessionId?: Record<string, SessionMessage[]>;
  agentsBySessionId?: Record<string, SessionAgent[]>;
  sessionOrder?: string[];
}

function mergeMessagesCausally(
  remoteMessages: readonly SessionMessage[],
  localMessages: readonly SessionMessage[]
): SessionMessage[] {
  if (remoteMessages.length === 0) return [...localMessages];
  if (localMessages.length === 0) return [...remoteMessages];

  const byId = new Map<string, SessionMessage>();
  const orderedIds: string[] = [];

  for (const rm of remoteMessages) {
    if (!rm?.id) continue;
    byId.set(rm.id, rm);
    orderedIds.push(rm.id);
  }

  for (const lm of localMessages) {
    if (!lm?.id) continue;
    const existing = byId.get(lm.id);
    if (!existing) {
      byId.set(lm.id, lm);
      orderedIds.push(lm.id);
    } else if ((lm.text?.length ?? 0) >= (existing.text?.length ?? 0)) {
      byId.set(lm.id, lm);
    }
  }

  const merged: SessionMessage[] = [];
  for (const id of orderedIds) {
    const msg = byId.get(id);
    if (msg) merged.push(msg);
  }
  return merged;
}

function mergeAgentsById(
  remoteAgents: readonly SessionAgent[] | undefined,
  localAgents: readonly SessionAgent[] | undefined
): SessionAgent[] {
  const rList = remoteAgents ?? [];
  const lList = localAgents ?? [];
  if (rList.length === 0) return [...lList];
  if (lList.length === 0) return [...rList];

  const byId = new Map<string, SessionAgent>();
  const order: string[] = [];
  for (const a of rList) {
    if (!a?.id) continue;
    byId.set(a.id, a);
    order.push(a.id);
  }
  for (const a of lList) {
    if (!a?.id) continue;
    if (!byId.has(a.id)) order.push(a.id);
    byId.set(a.id, a);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * 集合论无损 3-Way Session Merge 纯函数（O(|L| + |R|) 线性复杂度）：
 * M_final = (L \ R) ∪ MergeOverlap(L ∩ R) ∪ { s ∈ (R \ L) | s ∉ B ∧ ¬Tombstoned(s) }
 * - B：本次启动时内存已知的会话 id（在 B 中却已不在 L 的远端会话视为本地已删除，不复活）；
 * - isTombstoned：墓碑守卫（会话级联删除 / 外部删除），由调用方注入。
 */
export function performThreeWaySessionMerge(
  baseIds: Iterable<string>,
  localSessions: readonly SessionState[],
  remoteSessions: readonly SessionState[],
  isTombstoned: (id: string) => boolean
): ThreeWayMergeResult {
  const baseSet = new Set<string>(baseIds);
  const remoteById = new Map<string, SessionState>();
  let skippedTombstonedCount = 0;

  for (const diskS of remoteSessions) {
    if (!diskS?.id) continue;
    if (isTombstoned(diskS.id)) {
      skippedTombstonedCount += 1;
      continue;
    }
    remoteById.set(diskS.id, diskS);
  }

  const mergedSessions: SessionState[] = [];
  const mergedById: Record<string, SessionState> = {};
  const seenIds = new Set<string>();

  let addedFromRemoteCount = 0;
  let preservedLocalNewCount = 0;
  let filledBodiesCount = 0;

  // 1. 遍历内存态 L：保留新建会话 (L \ R) 与合并交集 (L ∩ R)
  for (const localS of localSessions) {
    if (!localS?.id || seenIds.has(localS.id)) continue;
    if (isTombstoned(localS.id)) {
      skippedTombstonedCount += 1;
      continue;
    }
    seenIds.add(localS.id);

    const diskS = remoteById.get(localS.id);
    if (!diskS) {
      mergedSessions.push(localS);
      mergedById[localS.id] = localS;
      preservedLocalNewCount += 1;
      continue;
    }

    const localMsgs = localS.messages ?? [];
    const diskMsgs = diskS.messages ?? [];

    if (localMsgs.length === 0 && diskMsgs.length > 0) {
      const hydrated: SessionState = {
        ...localS,
        messages: diskMsgs,
        agents: diskS.agents?.length ? diskS.agents : localS.agents,
        messagesHydrated: diskS.messagesHydrated ?? true,
        ...(diskS.engineCursor !== undefined
          ? { engineCursor: diskS.engineCursor }
          : {}),
        ...(diskS.engineLastRunId !== undefined
          ? { engineLastRunId: diskS.engineLastRunId }
          : {}),
        ...(diskS.hydratedFromEngine !== undefined
          ? { hydratedFromEngine: diskS.hydratedFromEngine }
          : {}),
        ...(diskS.pinnedMessageIds?.length
          ? { pinnedMessageIds: diskS.pinnedMessageIds }
          : {}),
      };
      mergedSessions.push(hydrated);
      mergedById[hydrated.id] = hydrated;
      filledBodiesCount += 1;
    } else if (localMsgs.length > 0 && diskMsgs.length > 0) {
      const mergedMsgs = mergeMessagesCausally(diskMsgs, localMsgs);
      const mergedAgents = mergeAgentsById(diskS.agents, localS.agents);
      const mergedSession: SessionState = {
        ...diskS,
        ...localS,
        messages: mergedMsgs,
        agents: mergedAgents,
        messagesHydrated:
          localS.messagesHydrated ?? diskS.messagesHydrated ?? true,
      };
      if (mergedMsgs.length > localMsgs.length) filledBodiesCount += 1;
      mergedSessions.push(mergedSession);
      mergedById[mergedSession.id] = mergedSession;
    } else {
      mergedSessions.push(localS);
      mergedById[localS.id] = localS;
    }
  }

  // 2. 遍历远端态 R：补齐所有未在内存中但存在于 SQLite 的历史会话 (R \ L)
  for (const diskS of remoteSessions) {
    if (!diskS?.id || seenIds.has(diskS.id)) continue;
    if (isTombstoned(diskS.id)) continue;
    if (baseSet.has(diskS.id)) {
      skippedTombstonedCount += 1;
      continue;
    }
    seenIds.add(diskS.id);
    mergedSessions.push(diskS);
    mergedById[diskS.id] = diskS;
    addedFromRemoteCount += 1;
  }

  return {
    mergedSessions,
    mergedById,
    addedFromRemoteCount,
    preservedLocalNewCount,
    filledBodiesCount,
    skippedTombstonedCount,
  };
}

/** 由合并后的会话列表重建正交子树派生字段（仅同步目标上已存在的字段） */
export function syncOrthogonalSessionSubtrees(
  state: OrthogonalSubtreeTarget,
  sessions: readonly SessionState[]
): void {
  if (
    !('metaById' in state) &&
    !('messagesBySessionId' in state) &&
    !('agentsBySessionId' in state) &&
    !('sessionOrder' in state)
  ) {
    return;
  }
  const nextMeta: Record<
    string,
    Omit<SessionState, 'messages' | 'agents'>
  > = {};
  const nextMsgs: Record<string, SessionMessage[]> = {};
  const nextAgents: Record<string, SessionAgent[]> = {};
  const nextOrder: string[] = [];

  for (const s of sessions) {
    if (!s?.id) continue;
    const { messages, agents, ...meta } = s;
    nextMeta[s.id] = meta;
    nextMsgs[s.id] = messages ?? [];
    nextAgents[s.id] = agents ?? [];
    nextOrder.push(s.id);
  }

  if ('metaById' in state) state.metaById = nextMeta;
  if ('messagesBySessionId' in state) state.messagesBySessionId = nextMsgs;
  if ('agentsBySessionId' in state) state.agentsBySessionId = nextAgents;
  if ('sessionOrder' in state) state.sessionOrder = nextOrder;
}
