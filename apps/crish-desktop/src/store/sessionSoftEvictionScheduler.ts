/**
 * sessionSoftEvictionScheduler — D5 会话激活后的软驱逐调度（由 sessionCrudActions 懒加载）
 *
 * 驱逐判定见 ./sessionEviction（findInactiveHydratedSessionIdsToEvict）。
 */

import { SESSION_HYDRATE_KEEP_K } from '../api/perfBudgets';
import { logger, toErrMeta } from '../services/LoggerService';
import { isPendingDraft } from './draftSession';
import type {
  SessionImmerSet,
  SessionStoreGet,
  SessionStoreSlice,
} from './sessionActions';
import { findInactiveHydratedSessionIdsToEvict } from './sessionEviction';
import { evictSessionMessagesInState } from './sessionStateActions';

/**
 * D5 激活后软驱逐调度：会话切换成功后于 microtask 重新读取状态，
 * 收集受保护会话（实时 active + 分屏叶当前激活/打开的 Tab），
 * 按 LRU 软驱逐非活跃已水合消息。
 * 驱逐是尽力而为的内存优化：任一步失败（含布局树模块加载失败）即整体跳过本轮，
 * 绝不在保护集不完整时驱逐，错误经 logger.warn 上报。
 */
export function scheduleSoftEvictionAfterActivation<
  T extends SessionStoreSlice,
>(nextId: string, get: SessionStoreGet<T>, set: SessionImmerSet<T>): void {
  queueMicrotask(() => {
    runSoftEvictionAfterActivation(nextId, get, set).catch((err: unknown) => {
      logger.warn('[softEviction] eviction pass skipped after failure', {
        module: 'sessionEviction',
        sessionId: nextId,
        err: toErrMeta(err),
      });
    });
  });
}

async function collectLayoutProtectedSessionIds(
  protectedSessionIds: Set<string>
): Promise<void> {
  const { useLayoutTreeStore, listChatLeaves } = await import('./layout-tree');
  const { ownedChatLeaves } =
    await import('./workspace-shell/treeSessionQuery');
  const treeRoot = useLayoutTreeStore.getState()?.tree?.root;
  if (!treeRoot) return;
  for (const owned of ownedChatLeaves(treeRoot)) {
    if (!Array.isArray(owned.tabs)) continue;
    for (const t of owned.tabs) {
      if (t.sessionId && !isPendingDraft(t.sessionId)) {
        protectedSessionIds.add(t.sessionId);
      }
    }
  }
  for (const leaf of listChatLeaves(treeRoot)) {
    if (!Array.isArray(leaf.tabs)) continue;
    for (const t of leaf.tabs) {
      const sid = (t as { sessionId?: string })?.sessionId;
      if (sid && !isPendingDraft(sid)) protectedSessionIds.add(sid);
    }
  }
}

async function runSoftEvictionAfterActivation<T extends SessionStoreSlice>(
  nextId: string,
  get: SessionStoreGet<T>,
  set: SessionImmerSet<T>
): Promise<void> {
  const state = get();
  const currentActiveId = (state.activeSessionId || nextId || '').trim();
  // 受保护会话：实时 activeSessionId 及所有分屏叶当前激活或打开的 Tab
  const protectedSessionIds = new Set<string>();
  if (currentActiveId && !isPendingDraft(currentActiveId)) {
    protectedSessionIds.add(currentActiveId);
  }
  await collectLayoutProtectedSessionIds(protectedSessionIds);

  const evictedSessionIds = findInactiveHydratedSessionIdsToEvict(
    currentActiveId,
    new Set(),
    state.sessions || [],
    state.sessionsById || {},
    SESSION_HYDRATE_KEEP_K,
    {
      openTabs: protectedSessionIds,
      visibleSplitSessionIds: protectedSessionIds,
    }
  ).filter((id) => !protectedSessionIds.has(id));

  if (evictedSessionIds.length === 0) return;
  set((current) => {
    evictSessionMessagesInState(current, evictedSessionIds);
  });
}
