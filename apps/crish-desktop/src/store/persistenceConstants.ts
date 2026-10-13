/**
 * persistenceConstants — 会话持久化防抖配置、3-Way Subtree Merge 与三道增量写屏障协调器 (Stage 01)
 *
 * 1. 权威锁定会话持久化防抖窗口为 300ms (FINAL-PLAN-STAGE-01 §5.4)，合并高频流式写入。
 * 2. 提供 SessionMeta 契约与集合论 3-Way Subtree Merge 无损增量恢复算法 (FINAL-PLAN-STAGE-01 §5.2)。
 * 3. 提供三道物理增量写屏障与 CAS 世代版本号守卫协调器 (SessionPersistenceCoordinator, §5.3 & §5.4)。
 */

import type { SessionAgent, SessionMessage, SessionState } from './types';

export const STORAGE_PERSIST_DEBOUNCE_MS = 300;

const emptyMessages: SessionMessage[] = [];
Object.freeze(emptyMessages);
/** 不可变全局空消息数组常量，杜绝 fallback [] 导致的引用漂移 */
export const EMPTY_MESSAGES: SessionMessage[] = emptyMessages;

const emptyAgents: SessionAgent[] = [];
Object.freeze(emptyAgents);
/** 不可变全局空子 Agent 数组常量，杜绝 fallback [] 导致的引用漂移 */
export const EMPTY_AGENTS: SessionAgent[] = emptyAgents;

export interface SessionMetaExtensions {
  unreadCount?: number;
  createdAt?: string;
  updatedAt?: string;
  activeAgentId?: string | null;
}

/** 权威纯净会话元数据切片 (SessionMeta)，物理剥离高频 messages 与 agents 数组 */
export interface SessionMeta
  extends Omit<SessionState, 'messages' | 'agents'>, SessionMetaExtensions {
  readonly id: string;
}

/** 从会话实体提取纯净、不可变冻结的 SessionMeta（物理剥离 messages 与 agents） */
export function extractSessionMeta(
  sess: (SessionState & SessionMetaExtensions) | SessionMeta
): SessionMeta {
  const {
    messages: _m,
    agents: _a,
    ...rest
  } = sess as SessionMeta & { messages?: unknown; agents?: unknown };
  return Object.freeze({
    ...rest,
    id: sess.id,
    title: sess.title,
    folder: sess.folder,
    isPinned: Boolean(sess.isPinned),
    isArchived: Boolean(sess.isArchived),
    timestamp: sess.timestamp,
  });
}

// ── 集合论 3-Way Subtree Merge 增量恢复算法 (FINAL-PLAN §5.2) ──────────────────

export interface SubtreeMergeInput {
  readonly metaById: Record<string, SessionMeta>;
  readonly messagesBySessionId: Record<string, readonly SessionMessage[]>;
  readonly agentsBySessionId: Record<string, readonly SessionAgent[]>;
  readonly sessionOrder: readonly string[];
}

export interface SubtreeMergeResult {
  readonly metaById: Record<string, SessionMeta>;
  readonly messagesBySessionId: Record<string, SessionMessage[]>;
  readonly agentsBySessionId: Record<string, SessionAgent[]>;
  readonly sessionOrder: string[];
  readonly restoredFromDiskCount: number;
}

function deduplicateMessagesById(
  diskMsgs: readonly SessionMessage[],
  localMsgs: readonly SessionMessage[]
): SessionMessage[] {
  if (diskMsgs.length === 0) return localMsgs as SessionMessage[];
  if (localMsgs.length === 0) return diskMsgs as SessionMessage[];
  const localById = new Map<string, SessionMessage>();
  for (const m of localMsgs) if (m?.id) localById.set(m.id, m);
  const seen = new Set<string>();
  const merged: SessionMessage[] = [];
  for (const dm of diskMsgs) {
    if (dm?.id && !seen.has(dm.id)) {
      seen.add(dm.id);
      merged.push(localById.get(dm.id) ?? dm);
    }
  }
  for (const lm of localMsgs) {
    if (lm?.id && !seen.has(lm.id)) {
      seen.add(lm.id);
      merged.push(lm);
    }
  }
  return merged;
}

/** SOTA 正交三子树 3-Way Merge 增量恢复算法：O(|L| + |R|) 集合论无损合并 */
export function performThreeWaySubtreeMerge(
  local: SubtreeMergeInput,
  diskSessions: readonly SessionState[],
  isTombstoned: (id: string) => boolean = () => false
): SubtreeMergeResult {
  const mergedMeta: Record<string, SessionMeta> = {};
  const mergedMsgs: Record<string, SessionMessage[]> = {};
  const mergedAgents: Record<string, SessionAgent[]> = {};
  const keptLocalOrder: string[] = [];
  const localOrderSet = new Set<string>();

  const seedLocalId = (id: string, meta: SessionMeta | undefined) => {
    if (!id || !meta || isTombstoned(id) || localOrderSet.has(id)) return;
    localOrderSet.add(id);
    keptLocalOrder.push(id);
    mergedMeta[id] = meta;
    mergedMsgs[id] =
      (local.messagesBySessionId[id] as SessionMessage[]) ?? EMPTY_MESSAGES;
    mergedAgents[id] =
      (local.agentsBySessionId[id] as SessionAgent[]) ?? EMPTY_AGENTS;
  };
  for (const id of local.sessionOrder) seedLocalId(id, local.metaById[id]);
  for (const [id, meta] of Object.entries(local.metaById))
    seedLocalId(id, meta);

  const validDiskSessions = diskSessions.filter(
    (s) => Boolean(s?.id) && !isTombstoned(s.id)
  );
  const diskMap = new Map(validDiskSessions.map((s) => [s.id, s] as const));

  for (const id of keptLocalOrder) {
    const localMeta = mergedMeta[id]!;
    const diskS = diskMap.get(id);
    if (!diskS) continue;
    const diskMsgs = diskS.messages ?? EMPTY_MESSAGES;
    const mergedSessionMsgs = deduplicateMessagesById(
      diskMsgs,
      mergedMsgs[id] ?? EMPTY_MESSAGES
    );
    mergedMsgs[id] = mergedSessionMsgs;
    const localAgents = mergedAgents[id] ?? EMPTY_AGENTS;
    mergedAgents[id] =
      localAgents.length > 0
        ? localAgents
        : diskS.agents?.length
          ? diskS.agents
          : EMPTY_AGENTS;
    const latestTimestamp =
      localMeta.timestamp &&
      diskS.timestamp &&
      localMeta.timestamp >= diskS.timestamp
        ? localMeta.timestamp
        : diskS.timestamp || localMeta.timestamp;
    const engineCursor = localMeta.engineCursor ?? diskS.engineCursor;
    const engineLastRunId = localMeta.engineLastRunId ?? diskS.engineLastRunId;
    mergedMeta[id] = Object.freeze({
      ...extractSessionMeta(diskS),
      ...localMeta,
      title:
        localMeta.titleSource === 'user'
          ? localMeta.title
          : localMeta.title || diskS.title,
      timestamp: latestTimestamp,
      messagesHydrated:
        Boolean(localMeta.messagesHydrated) || mergedSessionMsgs.length > 0,
      hydratedFromEngine:
        Boolean(localMeta.hydratedFromEngine) ||
        Boolean(diskS.hydratedFromEngine) ||
        diskMsgs.length > 0,
      messageCount: Math.max(
        mergedSessionMsgs.length,
        localMeta.messageCount ?? 0,
        diskS.messageCount ?? 0
      ),
      ...(engineCursor !== undefined ? { engineCursor } : {}),
      ...(engineLastRunId !== undefined ? { engineLastRunId } : {}),
    });
  }

  let restoredCount = 0;
  const diskOnlyIds: string[] = [];
  for (const diskS of validDiskSessions) {
    if (!localOrderSet.has(diskS.id)) {
      localOrderSet.add(diskS.id);
      const msgs = diskS.messages ?? EMPTY_MESSAGES;
      mergedMeta[diskS.id] = Object.freeze({
        ...extractSessionMeta(diskS),
        messagesHydrated: msgs.length > 0 || Boolean(diskS.messagesHydrated),
        messageCount: msgs.length || (diskS.messageCount ?? 0),
      });
      mergedMsgs[diskS.id] = msgs;
      mergedAgents[diskS.id] = diskS.agents?.length
        ? diskS.agents
        : EMPTY_AGENTS;
      diskOnlyIds.push(diskS.id);
      restoredCount++;
    }
  }

  return {
    metaById: mergedMeta,
    messagesBySessionId: mergedMsgs,
    agentsBySessionId: mergedAgents,
    sessionOrder: [...keptLocalOrder, ...diskOnlyIds],
    restoredFromDiskCount: restoredCount,
  };
}

// ── 三道物理增量写屏障与 CAS 世代版本号守卫协调器 (FINAL-PLAN §5.3 & §5.4) ────

export interface SotaPersistPayload<M = SessionMeta> {
  readonly metaById: Record<string, M>;
  readonly sessionOrder: readonly string[];
  readonly activeSessionId: string;
  readonly folderOrder: readonly string[];
}

export interface PersistCoordinatorState<M = SessionMeta> {
  metaById: Record<string, M>;
  sessionOrder: string[];
  activeSessionId: string;
  folderOrder: string[];
  hydrationComplete: boolean;
}

export class SessionPersistenceCoordinator<M = SessionMeta> {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private currentGeneration = 0;
  private lastFlushedGeneration = 0;
  private isPersisting = false;
  private hadNonEmptyBaseline = false;
  private readonly asyncWriter: (
    payload: SotaPersistPayload<M>
  ) => Promise<void>;
  private readonly syncWriter:
    ((payload: SotaPersistPayload<M>) => void) | undefined;

  constructor(opts: {
    asyncWriter: (payload: SotaPersistPayload<M>) => Promise<void>;
    syncWriter?: (payload: SotaPersistPayload<M>) => void;
  }) {
    this.asyncWriter = opts.asyncWriter;
    this.syncWriter = opts.syncWriter;
  }

  getGenerationSnapshot() {
    return {
      currentGeneration: this.currentGeneration,
      lastFlushedGeneration: this.lastFlushedGeneration,
      isPersisting: this.isPersisting,
    };
  }

  private canPersistState(state: PersistCoordinatorState<M>): boolean {
    if (!state.hydrationComplete) return false;
    if (
      state.sessionOrder.length === 0 &&
      Object.keys(state.metaById).length === 0 &&
      this.hadNonEmptyBaseline
    ) {
      return false;
    }
    if (state.sessionOrder.length > 0) this.hadNonEmptyBaseline = true;
    return true;
  }

  schedulePersist(store: { getState: () => PersistCoordinatorState<M> }): void {
    const state = store.getState();
    if (!state.hydrationComplete) return;
    if (state.sessionOrder.length > 0) this.hadNonEmptyBaseline = true;
    this.currentGeneration = (this.currentGeneration + 1) | 0;
    const targetGeneration = this.currentGeneration;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.executePersist(store, targetGeneration);
    }, STORAGE_PERSIST_DEBOUNCE_MS);
  }

  private async executePersist(
    store: { getState: () => PersistCoordinatorState<M> },
    targetGeneration: number
  ): Promise<void> {
    if (this.isPersisting) return;
    this.isPersisting = true;
    try {
      const state = store.getState();
      if (!this.canPersistState(state)) return;
      await this.asyncWriter({
        metaById: state.metaById,
        sessionOrder: state.sessionOrder,
        activeSessionId: state.activeSessionId,
        folderOrder: state.folderOrder,
      });
      this.lastFlushedGeneration = targetGeneration;
    } finally {
      this.isPersisting = false;
      if (this.currentGeneration > targetGeneration)
        this.schedulePersist(store);
    }
  }

  flushPersistenceSync(store: {
    getState: () => PersistCoordinatorState<M>;
  }): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const state = store.getState();
    if (!this.canPersistState(state)) return;
    this.syncWriter?.({
      metaById: state.metaById,
      sessionOrder: state.sessionOrder,
      activeSessionId: state.activeSessionId,
      folderOrder: state.folderOrder,
    });
    this.lastFlushedGeneration = this.currentGeneration;
  }
}
