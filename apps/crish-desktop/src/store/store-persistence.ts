/**
 * store-persistence.ts — 集合论 3-Way Session Merge 与三道物理写屏障（Stage 10 · ACT-1001）
 *
 * 职责：
 * 1. performThreeWaySessionMerge：O(|L| + |R|) 线性时间无损合并内存态 L 与 SQLite 远端态 R，
 *    彻底修复慢盘响应下 state.sessions.map 丢弃历史会话 (R \ L) 的致命缺陷；
 * 2. 联动 isSessionTombstoned 墓碑守卫，防止用户已删除会话在回灌时复活；
 * 3. 三道物理写屏障：
 *    - BootHoldBarrier：hydrationComplete === false 期间挂起防抖写盘；
 *    - DeltaWriteBarrier：按单会话指纹差分，阻断无变更全量覆写；
 *    - EmptySanitizeBarrier：已知非空持久化库未全墓碑时刚性熔断空数组覆写。
 */
import type {
  SessionAgent as AgentState,
  SessionMessage as Message,
  SessionState,
  WorkspaceState,
} from './types';
import { isSessionTombstoned } from './sessionCascadeCancellation';

export interface PersistableStoreState {
  workspaces?: WorkspaceState[];
  sidebarCollapsed?: boolean;
  activeWorkspaceIndex?: number;
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  activeSessionId: string;
  folderOrder: string[];
  hydrationComplete: boolean;
  activeAgentId: string | null;
  panelAgentId: string | null;
  metaById?: Record<string, Omit<SessionState, 'messages' | 'agents'>>;
  messagesBySessionId?: Record<string, Message[]>;
  agentsBySessionId?: Record<string, AgentState[]>;
  sessionOrder?: string[];
}

export interface StoreApiLike<S extends { hydrationComplete: boolean }> {
  getState: () => S;
  setState: (
    partial: S | Partial<S> | ((state: S) => void),
    replace?: boolean
  ) => void;
  subscribe: (listener: (state: S) => void) => () => void;
}

export type SessionActivatableStore<S extends PersistableStoreState> =
  StoreApiLike<S> & { setActiveSessionId?: (id: string) => void };

export interface ThreeWayMergeResult {
  mergedSessions: SessionState[];
  mergedById: Record<string, SessionState>;
  addedFromRemoteCount: number;
  preservedLocalNewCount: number;
  filledBodiesCount: number;
  skippedTombstonedCount: number;
}

export interface SessionWriteDelta {
  hasChanges: boolean;
  dirtySessionIds: string[];
  removedSessionIds: string[];
  metaChanged: boolean;
}

function mergeMessagesCausally(
  remoteMessages: readonly Message[],
  localMessages: readonly Message[]
): Message[] {
  if (remoteMessages.length === 0) return [...localMessages];
  if (localMessages.length === 0) return [...remoteMessages];

  const byId = new Map<string, Message>();
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

  const merged: Message[] = [];
  for (const id of orderedIds) {
    const msg = byId.get(id);
    if (msg) merged.push(msg);
  }
  return merged;
}

function mergeAgentsById(
  remoteAgents: readonly AgentState[] | undefined,
  localAgents: readonly AgentState[] | undefined
): AgentState[] {
  const rList = remoteAgents ?? [];
  const lList = localAgents ?? [];
  if (rList.length === 0) return [...lList];
  if (lList.length === 0) return [...rList];

  const byId = new Map<string, AgentState>();
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
 * - M_final = (L \ R) ∪ MergeOverlap(L ∩ R) ∪ { s ∈ (R \ L) | s ∉ B ∧ ¬Tombstoned(s) }
 * - 支持 4 参数签名 (baseIds, localSessions, remoteSessions, isTombstoned?)
 *   与 2/3 参数签名 (localSessions, remoteSessions, isTombstoned?)。
 */
export function performThreeWaySessionMerge(
  baseIds: Iterable<string>,
  localSessions: readonly SessionState[],
  remoteSessions: readonly SessionState[],
  isTombstoned?: (id: string) => boolean
): ThreeWayMergeResult;
export function performThreeWaySessionMerge(
  localSessions: readonly SessionState[],
  remoteSessions: readonly SessionState[],
  isTombstoned?: (id: string) => boolean
): ThreeWayMergeResult;
export function performThreeWaySessionMerge(
  arg1: Iterable<string> | readonly SessionState[],
  arg2: readonly SessionState[],
  arg3?: readonly SessionState[] | ((id: string) => boolean),
  arg4?: (id: string) => boolean
): ThreeWayMergeResult {
  const isFourArg = Array.isArray(arg3);
  const baseIds = isFourArg ? (arg1 as Iterable<string>) : [];
  const localSessions = isFourArg ? arg2 : (arg1 as readonly SessionState[]);
  const remoteSessions = isFourArg ? arg3 : arg2;
  const tombstoneGuard = isFourArg
    ? (arg4 ?? isSessionTombstoned)
    : typeof arg3 === 'function'
      ? arg3
      : (arg4 ?? isSessionTombstoned);

  const baseSet = new Set<string>(baseIds);
  const remoteById = new Map<string, SessionState>();
  let skippedTombstonedCount = 0;

  for (const diskS of remoteSessions) {
    if (!diskS?.id) continue;
    if (tombstoneGuard(diskS.id)) {
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
    if (tombstoneGuard(localS.id)) {
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
    if (tombstoneGuard(diskS.id)) continue;
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

/**
 * 第一道写屏障：BootHoldBarrier（启动挂起屏障）
 */
export const BootHoldBarrier = {
  shouldHold(state: Pick<PersistableStoreState, 'hydrationComplete'>): boolean {
    return !state.hydrationComplete;
  },
};

/**
 * 第二道写屏障：DeltaWriteBarrier（单会话增量脏写屏障）
 */
export class DeltaWriteBarrier {
  private digestsById = new Map<string, string>();
  private lastActiveSessionId = '';
  private lastFolderOrderKey = '';

  public static computeSessionDigest(session: SessionState): string {
    const msgs = session.messages ?? [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return [
      session.id,
      session.title ?? '',
      session.folder ?? '',
      session.isPinned ? '1' : '0',
      String(msgs.length),
      lastMsg?.id ?? '',
      String(lastMsg?.text?.length ?? 0),
      String(session.agents?.length ?? 0),
    ].join('|');
  }

  public seedFromSessions(
    sessions: readonly SessionState[],
    activeSessionId: string,
    folderOrder: readonly string[]
  ): void {
    this.digestsById.clear();
    for (const s of sessions) {
      if (!s?.id) continue;
      this.digestsById.set(s.id, DeltaWriteBarrier.computeSessionDigest(s));
    }
    this.lastActiveSessionId = activeSessionId;
    this.lastFolderOrderKey = folderOrder.join('\u0001');
  }

  public computeDelta(
    sessions: readonly SessionState[],
    activeSessionId: string,
    folderOrder: readonly string[]
  ): SessionWriteDelta {
    const dirtySessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const nextDigests = new Map<string, string>();

    for (const s of sessions) {
      if (!s?.id) continue;
      const digest = DeltaWriteBarrier.computeSessionDigest(s);
      nextDigests.set(s.id, digest);
      if (this.digestsById.get(s.id) !== digest) {
        dirtySessionIds.push(s.id);
      }
    }

    for (const prevId of this.digestsById.keys()) {
      if (!nextDigests.has(prevId)) {
        removedSessionIds.push(prevId);
      }
    }

    const folderKey = folderOrder.join('\u0001');
    const metaChanged =
      this.lastActiveSessionId !== activeSessionId ||
      this.lastFolderOrderKey !== folderKey;

    const hasChanges =
      dirtySessionIds.length > 0 || removedSessionIds.length > 0 || metaChanged;

    if (hasChanges) {
      this.digestsById = nextDigests;
      this.lastActiveSessionId = activeSessionId;
      this.lastFolderOrderKey = folderKey;
    }

    return {
      hasChanges,
      dirtySessionIds,
      removedSessionIds,
      metaChanged,
    };
  }
}

/**
 * 第三道写屏障：EmptySanitizeBarrier（空库覆写熔断屏障）
 */
export const EmptySanitizeBarrier = {
  shouldBlockEmptyWrite(
    currentSessions: readonly SessionState[],
    knownPersistedIds: ReadonlySet<string>,
    isTombstoned: (id: string) => boolean = isSessionTombstoned
  ): boolean {
    if (currentSessions.length > 0 || knownPersistedIds.size === 0) {
      return false;
    }
    for (const persistedId of knownPersistedIds) {
      if (!isTombstoned(persistedId)) {
        console.warn(
          '[EmptySanitizeBarrier] FATAL_CORRUPTION_GUARD: 拦截将空会话集覆写至非空持久化库的危险操作'
        );
        return true;
      }
    }
    return false;
  },
};

export function syncOrthogonalSessionSubtrees(
  state: PersistableStoreState,
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
  const nextMsgs: Record<string, Message[]> = {};
  const nextAgents: Record<string, AgentState[]> = {};
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
