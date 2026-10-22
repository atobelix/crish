/**
 * sessionWindowedPagination · 会话消息窗口化分页加载与滚动锚点补偿模块
 *
 * 职责：
 *   - DEFAULT_HYDRATE_WINDOW_SIZE / SessionHydrateOptions / WindowedHydrateResult
 *   - ensureSessionBodyHydrated：会话切换 / 懒水合首屏窗口化拉取（默认最新 50 条）
 *   - loadOlderMessages：按序列号增量向前拉取历史消息
 *   - loadOlderMessagesWithScrollAnchor：配合 VirtualScrollManager 进行前插与滚动锚点补偿
 *   - 窗口化会话装配与局部窗口写屏障拦截辅助函数
 */

import type { SessionState, SessionMessage } from '../../store/types';
import type { VirtualScrollManager } from '../VirtualScrollManager';
import type { SessionIndexEntry } from './sessionPersistenceTypes';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import { loadSessionAgents, loadSessionBody } from './sessionRustDbSql';
import { sanitizeMessagesForHydrate } from './sessionHydration';
import { coerceSessionTimestamp } from '../sessionTime';
import { prepareSessionsForUi } from '../sessionTitle';
import { logger, toErrMeta } from '../../services/LoggerService';
import { sessionDeltaWriteBarrier } from './sessionDeltaWriteBarrier';

export const DEFAULT_HYDRATE_WINDOW_SIZE = 50;

export interface SessionHydrateOptions {
  /** 首屏窗口大小（默认 50 条消息） */
  windowSize?: number;
  /** 是否全量加载，跳过窗口截断（默认 false，优先首屏窗口） */
  full?: boolean;
}

export interface SessionBodyHydrateResult {
  messages: SessionState['messages'];
  agents: NonNullable<SessionState['agents']>;
  totalCount?: number;
  hasMore?: boolean;
  oldestSeq?: number;
}

export type WindowedHydrateResult = SessionBodyHydrateResult;

export interface ActiveWindowedBundle {
  messages: SessionState['messages'];
  agents: NonNullable<SessionState['agents']>;
  hasMore: boolean;
  oldestSeq: number;
  totalCount: number;
}

/**
 * 会话切换 / 懒水合 JIT 拉取：优先窗口化加载最新 N 条消息（默认 50 条），快速达到首屏可用（TTI < 30ms）。
 * 调用方负责 Generation Token 对账——本函数只做 IO，不碰 store。
 */
export async function ensureSessionBodyHydrated(
  sessionId: string,
  options?: SessionHydrateOptions
): Promise<SessionBodyHydrateResult> {
  if (!sessionId || isPendingDraft(sessionId))
    return { messages: [], agents: [] };

  const isFull = options?.full === true;
  const windowSize = isFull
    ? undefined
    : (options?.windowSize ?? DEFAULT_HYDRATE_WINDOW_SIZE);

  const [allMessages, agents] = await Promise.all([
    loadSessionBody(sessionId),
    loadSessionAgents(sessionId),
  ]);

  const sanitized = sanitizeMessagesForHydrate(allMessages);
  const totalCount = sanitized.length;

  let messages: SessionState['messages'];
  let hasMore = false;
  let oldestSeq = 0;

  if (windowSize !== undefined && windowSize > 0 && totalCount > windowSize) {
    oldestSeq = totalCount - windowSize;
    messages = sanitized.slice(oldestSeq);
    hasMore = true;
  } else {
    messages = sanitized;
    hasMore = false;
    oldestSeq = 0;
  }

  // 确保窗口内消息附带 seq 字段
  messages = messages.map((m, idx) => ({
    ...m,
    seq: (m as any).seq ?? oldestSeq + idx,
  }));

  return {
    messages,
    agents: Array.isArray(agents) ? agents : [],
    ...(hasMore || options || totalCount > 0
      ? { totalCount, hasMore, oldestSeq }
      : {}),
  };
}

/**
 * 提供 loadOlderMessages(sessionId: string, beforeSeq: number, limit: number) 增量向前拉取能力。
 * 从存储层中拉取 seq < beforeSeq 的前 limit 条历史记录（按时间升序返回）。
 *
 * @param sessionId 会话 ID
 * @param beforeSeq 截止序列号（向前拉取在此序列号之前的消息）
 * @param limit 拉取条数上限（默认 DEFAULT_HYDRATE_WINDOW_SIZE = 50）
 */
export async function loadOlderMessages(
  sessionId: string,
  beforeSeq: number,
  limit = DEFAULT_HYDRATE_WINDOW_SIZE
): Promise<{
  messages: SessionMessage[];
  hasMore: boolean;
  oldestSeq: number;
}> {
  if (!sessionId || isPendingDraft(sessionId) || beforeSeq <= 0 || limit <= 0) {
    return { messages: [], hasMore: false, oldestSeq: Math.max(0, beforeSeq) };
  }

  const loaded = await loadSessionBody(sessionId, { limit, beforeSeq });
  const sanitized = sanitizeMessagesForHydrate(loaded);

  let olderSlice: SessionMessage[];
  let oldestSeq: number;

  if (sanitized.length > limit) {
    const end = Math.min(beforeSeq, sanitized.length);
    const start = Math.max(0, end - limit);
    olderSlice = sanitized.slice(start, end);
    oldestSeq = start;
  } else {
    oldestSeq = Math.max(0, beforeSeq - sanitized.length);
    olderSlice = sanitized;
  }

  const hasMore = oldestSeq > 0;

  const messagesWithSeq = olderSlice.map((m, idx) => ({
    ...m,
    seq: (m as any).seq ?? oldestSeq + idx,
  }));

  return {
    messages: messagesWithSeq,
    hasMore,
    oldestSeq,
  };
}

/**
 * 增量向前拉取历史消息并配合 VirtualScrollManager 进行平滑前插与滚动锚点补偿：
 * 防止向前翻页加载历史消息时视口发生瞬间跳跃。
 */
export async function loadOlderMessagesWithScrollAnchor(
  sessionId: string,
  beforeSeq: number,
  limit: number,
  vsm: VirtualScrollManager,
  currentScrollTop: number
): Promise<{
  messages: SessionMessage[];
  hasMore: boolean;
  oldestSeq: number;
  newOrder: string[];
  heightDelta: number;
  compensatedScrollTop: number;
}> {
  const res = await loadOlderMessages(sessionId, beforeSeq, limit);
  const olderIds = res.messages.map((m) => m.id);
  const anchorRes = vsm.prependIdsWithScrollAnchor(olderIds, currentScrollTop);
  return {
    messages: res.messages,
    hasMore: res.hasMore,
    oldestSeq: res.oldestSeq,
    newOrder: anchorRes.newOrder,
    heightDelta: anchorRes.heightDelta,
    compensatedScrollTop: anchorRes.compensatedScrollTop,
  };
}

/**
 * 为首屏活跃会话拉取窗口化消息与 agents 包（异常兜底不中断冷启动流程）。
 */
export async function loadActiveWindowedBundle(
  targetActiveId: string | null
): Promise<ActiveWindowedBundle> {
  if (!targetActiveId) {
    return {
      messages: [],
      agents: [],
      hasMore: false,
      oldestSeq: 0,
      totalCount: 0,
    };
  }
  try {
    const loaded = await ensureSessionBodyHydrated(targetActiveId);
    return {
      messages: loaded.messages,
      agents: loaded.agents,
      hasMore: Boolean(loaded.hasMore),
      oldestSeq: loaded.oldestSeq ?? 0,
      totalCount: loaded.totalCount ?? loaded.messages.length,
    };
  } catch (err) {
    logger.error('[hydrate] active session bundle load failed', {
      module: 'hydrate',
      sessionId: targetActiveId,
      err: toErrMeta(err),
    });
    return {
      messages: [],
      agents: [],
      hasMore: false,
      oldestSeq: 0,
      totalCount: 0,
    };
  }
}

/**
 * 单遍内存装配：将排序后的索引条目与首屏活跃会话窗口数据组装为 SessionState 列表（历史保持轻量懒壳）。
 */
export function assembleWindowedHydratedSessions(
  ordered: SessionIndexEntry[],
  targetActiveId: string | null,
  activeBundle: ActiveWindowedBundle
): SessionState[] {
  const {
    messages: activeMessages,
    agents: activeAgents,
    hasMore: activeHasMore,
    oldestSeq: activeOldestSeq,
    totalCount: activeTotalCount,
  } = activeBundle;

  return ordered.map((e) => {
    const isActive = e.id === targetActiveId;
    const safeTimestamp = coerceSessionTimestamp(
      e.id,
      e.timestamp,
      isActive ? activeMessages : [],
      e.updatedAt
    );
    return {
      id: e.id,
      title: e.title,
      folder: e.folder,
      isPinned: e.isPinned,
      isArchived: e.isArchived,
      timestamp: safeTimestamp,
      messages: isActive ? activeMessages : [],
      messagesHydrated: isActive,
      agents: isActive ? activeAgents : [],
      messageCount: isActive
        ? Math.max(e.messageCount ?? 0, activeTotalCount)
        : e.messageCount,
      ...(isActive && activeHasMore
        ? { hasOlderMessages: true, oldestLoadedSeq: activeOldestSeq }
        : {}),
      ...(e.branchParentId !== undefined
        ? { branchParentId: e.branchParentId }
        : {}),
      ...(e.pinnedMessageIds?.length
        ? { pinnedMessageIds: e.pinnedMessageIds }
        : {}),
      ...(e.engineCursor !== undefined ? { engineCursor: e.engineCursor } : {}),
      ...(e.engineLastRunId !== undefined
        ? { engineLastRunId: e.engineLastRunId }
        : {}),
      ...(isActive && e.hydratedFromEngine !== undefined
        ? { hydratedFromEngine: e.hydratedFromEngine }
        : {}),
      ...(e.importMeta ? { importMeta: e.importMeta } : {}),
      ...(e.titleSource ? { titleSource: e.titleSource } : {}),
    };
  });
}

/**
 * 剪枝兼容（方案 A）：未水合但 messageCount > 0 的懒壳并入 keepIds，防止 prepareSessionsForUi 误剪。
 */
export function prepareWindowedSessionsForUi(
  sessions: SessionState[],
  targetActiveId: string | null
): SessionState[] {
  const lazyKeepIds = sessions
    .filter((s) => s.messagesHydrated === false && (s.messageCount ?? 0) > 0)
    .map((s) => s.id);
  return prepareSessionsForUi(sessions, targetActiveId, {
    keepIds: [...lazyKeepIds, ...(targetActiveId ? [targetActiveId] : [])],
  });
}

/**
 * 资产保护硬守卫（W3-4）：若会话仅加载了首屏/局部窗口（hasOlderMessages === true 或 messageCount > msgs.length），
 * 拦截 saveSessionBody 全量覆盖与尾部收缩，防止未拉取的历史记录被抹杀。
 */
export function shouldBlockWindowedSessionBodySave(
  s: SessionState,
  currentMsgCount: number
): boolean {
  const isWindowedPartial =
    Boolean(s.hasOlderMessages) ||
    (typeof s.messageCount === 'number' &&
      s.messageCount > currentMsgCount &&
      s.messagesHydrated === true &&
      !s.hydratedFromEngine);

  if (
    isWindowedPartial &&
    sessionDeltaWriteBarrier.shouldBlockWrite('windowed_session_truncate', {
      sessionId: s.id,
      currentLength: currentMsgCount,
      totalCount: s.messageCount,
      hasOlderMessages: s.hasOlderMessages,
    })
  ) {
    logger.warn(
      `[persistAllSessionsRust] Blocked windowed session body truncate for ${s.id} (${currentMsgCount}/${s.messageCount}) by DeltaWriteBarrier`,
      { module: 'persist' }
    );
    return true;
  }
  return false;
}
