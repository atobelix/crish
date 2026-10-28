/**
 * apps/crish-desktop/src/store/sessionDeleteTransition.ts
 *
 * 会话生命周期转换、DualLatch 终态清理与 Double-Lock 墓碑协调器 (Stage 03 / E3-01)
 *
 * 核心职责：
 * 1. 焦点与工作区迁移：会话删除时的邻近会话推导与工作区目录同步预激活，消除悬垂指针与白屏；
 * 2. DualLatch 终态清理协议：在会话关闭、删除或切换时，注销所有监听器、排空消息缓冲、断开流连接、解引用 DOM 节点；
 * 3. Double-Lock 双重锁墓碑（Tombstone Guard）：墓碑黑名单 + Store 存活性二次校验，彻底杜绝已删除/销毁会话被异步消息、推送或网络重试"幽灵复活"；
 * 4. 多分栏复合草稿与定时器收口：对称清理 `${sessionId}` 与 `${sessionId}::${leafId}` 复合键，取消防抖定时器，清退内存泄漏闭包。
 */

import { dualLatchStateMachine } from './dualLatchProtocol';
import {
  isSessionTombstoned,
  markSessionTombstone,
} from '../utils/lifecycle/ScopedLifecycleRegistry';
import { streamDirectEngine } from '../hooks/chat-stream/streamDirectDomEngine';
import { streamDirectDomEngine } from '../api/streamDirectDomEngine';
import {
  sharedSessionStreamManager,
  abortSessionRenderBuffer,
} from '../hooks/chat-stream/sessionStreamManager';
import { useStreamingStore } from './streamingStore';
import { sessionCascadeCancellation } from './sessionCascadeCancellation';
import { clearMessageSnapshots } from './messageSnapshotsBridge';
import { clearRuntimeStatus } from './sessionRuntimeStatusStore';

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
      console.error(
        `[sessionDeleteTransition] Failed to evict session draft for ${id}:`,
        err
      );
    }
  }
}

/**
 * 【DualLatch 终态清理协议】
 * 刚性注销所有流式监听、清理消息缓冲区、断开连接、解引用 DOM 节点并排空锁存记录。
 */
export function executeDualLatchFinalCleanup(sessionId: string): {
  dualLatchRecordsAborted: boolean;
  domTargetsDereferenced: boolean;
  renderBufferAborted: boolean;
  streamingStoreCleared: boolean;
} {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) {
    return {
      dualLatchRecordsAborted: false,
      domTargetsDereferenced: false,
      renderBufferAborted: false,
      streamingStoreCleared: false,
    };
  }

  // 1. DualLatch 状态机：清退全部 records、清空 snapshotText、取消 pending rAF
  let dualLatchRecordsAborted = false;
  try {
    dualLatchStateMachine.abortSession(id);
    dualLatchRecordsAborted = true;
  } catch (err) {
    console.error(`[DualLatchCleanup] abortSession failed for ${id}:`, err);
  }

  // 2. DOM 节点解引用：彻底清除 StreamDirect 引擎中的 DOM Text 节点引用与影子槽位
  let domTargetsDereferenced = false;
  try {
    streamDirectEngine.abortSession(id);
    streamDirectDomEngine.releaseSession(id);
    domTargetsDereferenced = true;
  } catch (err) {
    console.error(
      `[DualLatchCleanup] StreamDirect DOM dereference failed for ${id}:`,
      err
    );
  }

  // 3. 流式渲染缓冲：取消未决 rAF 分帧刷新并重置清空
  let renderBufferAborted = false;
  try {
    abortSessionRenderBuffer(id);
    renderBufferAborted = true;
  } catch (err) {
    console.error(
      `[DualLatchCleanup] abortSessionRenderBuffer failed for ${id}:`,
      err
    );
  }

  // 4. 清理前端流式状态缓冲（防残留追加）
  let streamingStoreCleared = false;
  try {
    useStreamingStore.getState().clearSession(id);
    streamingStoreCleared = true;
  } catch (err) {
    console.error(`[DualLatchCleanup] clearSession failed for ${id}:`, err);
  }

  return {
    dualLatchRecordsAborted,
    domTargetsDereferenced,
    renderBufferAborted,
    streamingStoreCleared,
  };
}

/**
 * 【会话终态全生命周期原子清理执行器】
 * 统筹级联总线、DualLatch 协议、Double-Lock 墓碑注册、复合草稿清空与运行时快照注销。
 */
export function executeSessionDeleteLifecycle(sessionId: string): {
  sessionId: string;
  tombstoned: boolean;
  dualLatchCleaned: boolean;
  streamCancelled: boolean;
  draftsEvicted: boolean;
} {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) {
    return {
      sessionId: '',
      tombstoned: false,
      dualLatchCleaned: false,
      streamCancelled: false,
      draftsEvicted: false,
    };
  }

  // 1. 触发三级级联取消总线（Tier 1 计算强杀 / Tier 2 通信中止 / Tier 3 500 容量 LRU 墓碑拦截）
  sessionCascadeCancellation.cancelSessionCascade(id);
  markSessionTombstone(id);

  // 2. 刚性执行 DualLatch 终态清理协议（DOM 节点解引用 + rAF 排空）
  const dualLatchResult = executeDualLatchFinalCleanup(id);

  // 3. 本地会话流式句柄强行中止与清理
  let streamCancelled = false;
  try {
    sharedSessionStreamManager.cancelSession(id);
    sharedSessionStreamManager.clearSession(id);
    streamCancelled = true;
  } catch (err) {
    console.error(
      `[sessionDeleteLifecycle] Stream cancel failed for ${id}:`,
      err
    );
  }

  // 4. 彻底回收 SessionDraftManager 中的内存草稿与挂起防抖定时器
  evictSessionDraftsAndTimers(id);

  // 5. 跨 Store 运行时瞬态状态清空（快照栈与状态机）
  try {
    clearMessageSnapshots(id);
    clearRuntimeStatus(id);
  } catch {
    // 容错处理
  }

  return {
    sessionId: id,
    tombstoned: isSessionTombstoned(id),
    dualLatchCleaned:
      dualLatchResult.dualLatchRecordsAborted &&
      dualLatchResult.domTargetsDereferenced,
    streamCancelled,
    draftsEvicted: true,
  };
}
