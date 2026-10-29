/**
 * sessionLateArrivalMerge — 迟到磁盘快照与内存会话的集合论无损合并（闭环 VULN-06）
 *
 * 迟到的磁盘快照到达时严禁盲目全盘覆盖：
 * - 集合求并：保留仅在内存中存在的新建会话（用户新建，按最后活动时间置顶）；
 * - 属性合并：同一会话按消息数量与更新时间戳无损合并消息与元数据，用户交互数据 0 丢失；
 * - 时间戳合法性（标准 ISO 串）与排序一致性。
 *
 * 写入门闩见 ./sessionDeltaWriteBarrier；启动回灌 3-Way Merge 见 ./sessionThreeWayMerge。
 */

import type {
  SessionState,
  SessionMessage,
  SessionAgent,
} from '../../store/types';
import { mergeMessagesById } from '../sessionEventProjection';
import { coerceSessionTimestamp } from '../sessionTime';
import { EMPTY_SESSION_TITLE } from '../sessionTitle';
import { DEFAULT_SESSION_FOLDER } from './sessionPersistenceTypes';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';

/**
 * 计算会话的最晚活动时间戳（epoch ms）。
 * 优先级：消息最晚时间戳 > updatedAt > timestamp ISO 解析值 > 0
 */
export function getSessionActivityTime(s: SessionState): number {
  let maxTime = 0;
  const { updatedAt } = s as SessionState & { updatedAt?: unknown };
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    maxTime = Math.max(maxTime, updatedAt);
  }
  if (s.timestamp) {
    const parsed = Date.parse(s.timestamp);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      maxTime = Math.max(maxTime, parsed);
    }
  }
  if (Array.isArray(s.messages) && s.messages.length > 0) {
    for (const m of s.messages) {
      if (!m) continue;
      if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)) {
        maxTime = Math.max(maxTime, m.timestamp);
      } else if (typeof m.timestamp === 'string') {
        const parsed = Date.parse(m.timestamp);
        if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
          maxTime = Math.max(maxTime, parsed);
        }
      }
    }
  }
  return maxTime;
}

/**
 * 合并协作 Agent 列表（按 id 原地无损合并消息与最新属性）
 */
function mergeSessionAgents(
  persisted: SessionAgent[],
  live: SessionAgent[]
): SessionAgent[] {
  if (!live.length) return persisted.slice();
  if (!persisted.length) return live.slice();

  const out = [...persisted];
  const indexById = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const ag = out[i];
    if (ag?.id) indexById.set(ag.id, i);
  }

  for (const ag of live) {
    if (!ag?.id) continue;
    const existingIdx = indexById.get(ag.id);
    if (existingIdx === undefined) {
      out.push(ag);
      indexById.set(ag.id, out.length - 1);
    } else {
      const existing = out[existingIdx]!;
      out[existingIdx] = {
        ...existing,
        ...ag,
        messages: mergeMessagesById(existing.messages || [], ag.messages || []),
      };
    }
  }
  return out;
}

/**
 * 迟到水合快照入参类型（支持数组或包含元数据的对象）
 */
export type LateArrivalSnapshotInput =
  | SessionState[]
  | {
      sessions: SessionState[];
      activeSessionId?: string | null;
      folderOrder?: string[] | null;
    };

/**
 * 迟到水合快照合并结果（既是 SessionState[] 数组，又挂载了元数据字段）
 */
export interface ReconcileResult extends Array<SessionState> {
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[];
}

/**
 * 提取输入中的会话数组
 */
function extractSessionList(
  input: LateArrivalSnapshotInput | undefined
): SessionState[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Array.isArray(input.sessions) ? input.sessions : [];
}

/**
 * 迟到水合数据 3-Way Merge 算法（根治 VULN-06）
 *
 * 集合论无损合并契约：
 * 1. 提取持久化数据中已存的会话列表；
 * 2. 集合求并：保留所有仅在 liveSessions 中存在的新建会话（用户新建，按最后活动时间置顶）；
 * 3. 属性合并：对同一会话，按消息数量与更新时间戳无损合并消息与元数据，确保用户交互数据 0 丢失；
 * 4. 时间戳规范化：一律确保为合法 ISO 格式，保持相对顺序与展示一致性。
 */
export function reconcileLateArrivalSnapshot(
  persistedSessions: LateArrivalSnapshotInput,
  liveSessions: LateArrivalSnapshotInput
): ReconcileResult {
  const diskList = extractSessionList(persistedSessions);
  const liveList = extractSessionList(liveSessions);

  const diskActiveId = Array.isArray(persistedSessions)
    ? null
    : (persistedSessions.activeSessionId ?? null);
  const liveActiveId = Array.isArray(liveSessions)
    ? null
    : (liveSessions.activeSessionId ?? null);

  const diskFolderOrder = Array.isArray(persistedSessions)
    ? []
    : (persistedSessions.folderOrder ?? []);
  const liveFolderOrder = Array.isArray(liveSessions)
    ? []
    : (liveSessions.folderOrder ?? []);

  // 过滤非法及 Draft 会话
  const validDisk = diskList.filter((s) => s?.id && !isPendingDraft(s.id));
  const validLive = liveList.filter((s) => s?.id && !isPendingDraft(s.id));

  const diskMap = new Map<string, SessionState>();
  for (const s of validDisk) {
    diskMap.set(s.id, s);
  }

  const liveMap = new Map<string, SessionState>();
  for (const s of validLive) {
    liveMap.set(s.id, s);
  }

  // 1. 集合差集：提取用户在降级/延迟水合期间新建的会话 (Live 有而 Disk 没有)
  const newlyCreatedInLive: SessionState[] = [];
  for (const s of validLive) {
    if (!diskMap.has(s.id)) {
      newlyCreatedInLive.push(s);
    }
  }

  // 降级期间的新建会话按最晚活动时间置顶排序
  newlyCreatedInLive.sort(
    (a, b) => getSessionActivityTime(b) - getSessionActivityTime(a)
  );

  // 确保新建会话的时间戳规范化为 ISO 串
  const normalizedNewSessions: SessionState[] = newlyCreatedInLive.map((s) => {
    const safeTs = coerceSessionTimestamp(s.id, s.timestamp, s.messages || []);
    return {
      ...s,
      timestamp: safeTs,
      messagesHydrated: s.messagesHydrated ?? true,
    };
  });

  // 2. 属性合并：对同一会话做双向无损合并；对仅在 Disk 的历史会话保留原状
  const mergedDiskSessions: SessionState[] = validDisk.map((diskSession) => {
    const liveSession = liveMap.get(diskSession.id);
    if (!liveSession) {
      // 仅存在于磁盘：保持历史完整性
      return {
        ...diskSession,
        timestamp: coerceSessionTimestamp(
          diskSession.id,
          diskSession.timestamp,
          diskSession.messages || []
        ),
      };
    }

    // 存在于双方：属性与消息无损合并
    const diskMsgs = diskSession.messages || [];
    const liveMsgs = liveSession.messages || [];
    let mergedMessages: SessionMessage[];
    if (diskMsgs.length === 0) {
      mergedMessages = liveMsgs.slice();
    } else if (liveMsgs.length === 0) {
      mergedMessages = diskMsgs.slice();
    } else {
      // 双方均有消息：按 id 无损合并
      mergedMessages = mergeMessagesById(diskMsgs, liveMsgs);
    }

    const mergedMessageCount = Math.max(
      mergedMessages.length,
      liveSession.messageCount ?? 0,
      diskSession.messageCount ?? 0
    );

    const diskTime = getSessionActivityTime(diskSession);
    const liveTime = getSessionActivityTime(liveSession);
    const maxTime = Math.max(diskTime, liveTime);
    const liveIsNewer = liveTime >= diskTime;

    const safeTimestamp =
      maxTime > 0
        ? new Date(maxTime).toISOString()
        : coerceSessionTimestamp(
            diskSession.id,
            liveIsNewer ? liveSession.timestamp : diskSession.timestamp,
            mergedMessages
          );

    // 标题：用户显式改名或更新时间更近时优先
    let mergedTitle = diskSession.title;
    if (liveSession.titleSource === 'user' && liveSession.title) {
      mergedTitle = liveSession.title;
    } else if (
      liveSession.title &&
      liveSession.title !== EMPTY_SESSION_TITLE &&
      diskSession.title === EMPTY_SESSION_TITLE
    ) {
      mergedTitle = liveSession.title;
    } else if (liveIsNewer && liveSession.title) {
      mergedTitle = liveSession.title;
    } else if (!mergedTitle && liveSession.title) {
      mergedTitle = liveSession.title;
    }

    const mergedTitleSource =
      liveSession.titleSource || diskSession.titleSource;
    const mergedFolder =
      liveIsNewer && liveSession.folder
        ? liveSession.folder
        : diskSession.folder || liveSession.folder || DEFAULT_SESSION_FOLDER;

    const mergedIsPinned = liveIsNewer
      ? liveSession.isPinned
      : liveSession.isPinned || diskSession.isPinned;
    const mergedIsArchived = liveIsNewer
      ? liveSession.isArchived
      : (liveSession.isArchived ?? diskSession.isArchived);

    // Agents 协作列表无损合并
    const mergedAgents = mergeSessionAgents(
      diskSession.agents || [],
      liveSession.agents || []
    );

    // 钉住消息集合求并
    const pinnedSet = new Set<string>();
    for (const id of diskSession.pinnedMessageIds || []) pinnedSet.add(id);
    for (const id of liveSession.pinnedMessageIds || []) pinnedSet.add(id);
    const mergedPinnedMessageIds = Array.from(pinnedSet);

    // 钉住颜色字典合并
    const mergedPinnedColors = {
      ...(diskSession.pinnedMessageColors || {}),
      ...(liveSession.pinnedMessageColors || {}),
    };

    return {
      ...diskSession,
      ...liveSession,
      id: diskSession.id,
      title: mergedTitle || EMPTY_SESSION_TITLE,
      ...(mergedTitleSource ? { titleSource: mergedTitleSource } : {}),
      folder: mergedFolder,
      isPinned: mergedIsPinned,
      isArchived: mergedIsArchived,
      timestamp: safeTimestamp,
      messages: mergedMessages,
      messageCount: mergedMessageCount,
      messagesHydrated:
        liveSession.messagesHydrated ||
        diskSession.messagesHydrated ||
        mergedMessages.length > 0,
      agents: mergedAgents,
      ...(mergedPinnedMessageIds.length > 0
        ? { pinnedMessageIds: mergedPinnedMessageIds }
        : {}),
      ...(mergedPinnedColors && Object.keys(mergedPinnedColors).length > 0
        ? { pinnedMessageColors: mergedPinnedColors }
        : {}),
      ...(Boolean(
        liveSession.hasOlderMessages || diskSession.hasOlderMessages
      ) && mergedMessages.length < mergedMessageCount
        ? {
            hasOlderMessages: true,
            oldestLoadedSeq:
              liveSession.oldestLoadedSeq ?? diskSession.oldestLoadedSeq,
          }
        : {}),
      ...(diskSession.branchParentId || liveSession.branchParentId
        ? {
            branchParentId:
              liveSession.branchParentId || diskSession.branchParentId,
          }
        : {}),
      engineCursor: Math.max(
        diskSession.engineCursor ?? 0,
        liveSession.engineCursor ?? 0
      ),
      ...(liveSession.engineLastRunId || diskSession.engineLastRunId
        ? {
            engineLastRunId:
              liveSession.engineLastRunId || diskSession.engineLastRunId,
          }
        : {}),
      hydratedFromEngine: Boolean(
        liveSession.hydratedFromEngine || diskSession.hydratedFromEngine
      ),
      ...(liveSession.importMeta || diskSession.importMeta
        ? { importMeta: liveSession.importMeta || diskSession.importMeta }
        : {}),
      ...(liveSession.goalMode || diskSession.goalMode
        ? { goalMode: liveSession.goalMode || diskSession.goalMode }
        : {}),
    };
  });

  // 3. 最终求并列表：新建会话永远置顶，历史会话紧随其后
  const mergedSessionsList: SessionState[] = [
    ...normalizedNewSessions,
    ...mergedDiskSessions,
  ];

  // 4. 解析 activeSessionId：优先活跃在 live 中的会话或新建的置顶会话
  let resolvedActiveId: string | null = null;
  if (liveActiveId && mergedSessionsList.some((s) => s.id === liveActiveId)) {
    resolvedActiveId = liveActiveId;
  } else if (normalizedNewSessions.length > 0 && normalizedNewSessions[0]) {
    resolvedActiveId = normalizedNewSessions[0].id;
  } else if (
    diskActiveId &&
    mergedSessionsList.some((s) => s.id === diskActiveId)
  ) {
    resolvedActiveId = diskActiveId;
  } else if (mergedSessionsList.length > 0 && mergedSessionsList[0]) {
    resolvedActiveId = mergedSessionsList[0].id;
  }

  // 5. 解析 folderOrder
  const folderSet = new Set<string>();
  for (const f of liveFolderOrder) if (f) folderSet.add(f);
  for (const f of diskFolderOrder) if (f) folderSet.add(f);
  for (const s of mergedSessionsList) if (s.folder) folderSet.add(s.folder);
  const resolvedFolderOrder = Array.from(folderSet);

  // 包装为双形态 ReconcileResult（既可作为 SessionState[] 使用，又具备结构化字段）
  const result = mergedSessionsList as ReconcileResult;
  result.sessions = mergedSessionsList;
  result.activeSessionId = resolvedActiveId;
  result.folderOrder = resolvedFolderOrder;

  return result;
}
