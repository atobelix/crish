/**
 * apps/crish-desktop/src/store/sessionDeleteTransition.ts
 *
 * 会话删除转换与 Double-Lock 墓碑守卫 (Stage 03 / E3-01)
 *
 * 核心职责：
 * 1. 焦点与工作区迁移：会话删除时的邻近会话推导与工作区目录同步预激活，消除悬垂指针与白屏；
 * 2. Double-Lock 双重锁墓碑（Tombstone Guard）：墓碑黑名单 + Store 存活性二次校验，彻底杜绝已删除/销毁会话被异步消息、推送或网络重试"幽灵复活"；
 * 3. 多分栏复合草稿与定时器收口：对称清理 `${sessionId}` 与 `${sessionId}::${leafId}` 复合键，取消防抖定时器，清退内存泄漏闭包。
 *
 * 流取消、DualLatch / 流式缓冲清理与后端中止统一由 `sessionCascadeCancellation`（deleteSession 首步）单通道完成。
 */

import { isSessionTombstoned } from '../utils/lifecycle/ScopedLifecycleRegistry';
import { logger, toErrMeta } from '../services/LoggerService';

export interface DraftEvictable {
  evictSession: (sessionId: string) => void;
}

let _draftManager: DraftEvictable | null = null;

/** 注入草稿管理器实例（避免启动期 TDZ 环，单测亦可直接注入） */
export function bindDraftManagerForEviction(
  manager: DraftEvictable | null
): void {
  _draftManager = manager;
}

/**
 * 删除目标会话后，计算应转移焦点的下一个会话：
 * 优先选取下一个邻居，其次选取前一个邻居，再次兜底为首个剩余会话。
 */
export function selectSessionAfterDeletion<T extends { id: string }>(
  sessions: readonly T[],
  deletedId: string
): T | null {
  const index = sessions.findIndex((session) => session.id === deletedId);
  return (
    sessions[index + 1] ??
    sessions[index - 1] ??
    sessions.find((session) => session.id !== deletedId) ??
    null
  );
}

/**
 * 活跃会话删除前的平滑过渡准备：
 * 计算目标邻居会话并在非 Demo 模式下同步预留工作区 transition。
 */
export function prepareSessionDeletionTransition<
  T extends { id: string; folder: string },
>(
  sessions: readonly T[],
  deletedId: string,
  isDemoMode: () => boolean,
  activateWorkspace: (folder: string) => unknown
): string | null {
  const nextSession = selectSessionAfterDeletion(sessions, deletedId);
  if (nextSession && !isDemoMode()) void activateWorkspace(nextSession.folder);
  return nextSession?.id ?? null;
}

/**
 * Double-Lock 双重锁守卫结果
 */
export interface DoubleLockGuardResult {
  readonly allowed: boolean;
  readonly reason?: 'tombstoned' | 'not_alive' | 'empty_id';
}

/**
 * 【Double-Lock 双重锁墓碑判定】
 * Lock 1: isSessionTombstoned (检查 500 容量 LRU 墓碑黑名单)
 * Lock 2: sessionAliveOracle (检查 Store 中会话是否物理存活，防御长延迟定时器在 LRU 驱逐后的幽灵唤醒)
 */
export function checkDoubleLockTombstoneGuard(
  sessionId: string,
  sessionAliveOracle?: (id: string) => boolean
): DoubleLockGuardResult {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) {
    return { allowed: false, reason: 'empty_id' };
  }
  if (isSessionTombstoned(sid)) {
    return { allowed: false, reason: 'tombstoned' };
  }
  if (sessionAliveOracle && !sessionAliveOracle(sid)) {
    return { allowed: false, reason: 'not_alive' };
  }
  return { allowed: true };
}

/**
 * 判定会话是否允许被异步消息或续写任务继续处理（true 表示允许，false 表示已被双重锁熔断）
 */
export function isSessionEligibleForContinuation(
  sessionId: string,
  sessionAliveOracle?: (id: string) => boolean
): boolean {
  return checkDoubleLockTombstoneGuard(sessionId, sessionAliveOracle).allowed;
}

/**
 * 对称清理 Store 中由该会话持有的一切单栏及多分栏复合草稿键（`${id}` 及 `${id}::${leafId}`）
 */
export function cleanSessionCompoundDraftsInStore(
  draftsRecord: Record<string, string> | undefined,
  sessionId: string
): number {
  if (!draftsRecord || !sessionId) return 0;
  const id = sessionId.trim();
  if (!id) return 0;
  const prefix = `${id}::`;
  let cleaned = 0;
  for (const key of Object.keys(draftsRecord)) {
    if (key === id || key.startsWith(prefix)) {
      delete draftsRecord[key];
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * 回收 SessionDraftManager 内存池中的草稿内容与未决防抖定时器
 */
export function evictSessionDraftsAndTimers(sessionId: string): void {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  if (_draftManager) {
    try {
      _draftManager.evictSession(id);
    } catch (err) {
      logger.error('[sessionDeleteTransition] draft eviction failed', {
        module: 'sessionDeleteTransition',
        sessionId: id,
        err: toErrMeta(err),
      });
    }
  }
}
