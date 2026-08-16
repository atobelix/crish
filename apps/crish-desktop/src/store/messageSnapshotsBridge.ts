/**
 * 打破 init 环：layoutStore → sessionActions ↛ MessageSnapshots → sessionStore → layoutStore。
 * sessionActions 只依赖本桥；bootstrapStores 在模块图稳定后注入真实 messageSnapshots。
 */
import type { SessionMessage } from './types';
import type { VirtualScrollManager } from '../api/VirtualScrollManager';
import { logger } from '../services/LoggerService';

/** 与 MessageSnapshots.save 入参对齐的最小形状（避免 sessionActions 静态 import MessageSnapshots） */
export type SnapshotSaveEntry = {
  sessionId: string;
  /** R1：timeline-truncate 为撤回投影截断快照（统一输入流收敛战役） */
  operation:
    | 'withdraw'
    | 'regenerate'
    | 'archive'
    | 'batch-pin'
    | 'edit'
    | 'timeline-truncate';
  messages: SessionMessage[];
  pinnedMessageIds?: string[];
  diffFilePaths: string[];
  timestamp: number;
  description?: string;
};

export type SnapshotSaveOptions = {
  afterMessages?: SessionMessage[];
  heightMap?: Record<string, number>;
  vsm?: VirtualScrollManager;
};

export type MessageSnapshotsOps = {
  save: (
    sessionId: string,
    entry: SnapshotSaveEntry,
    options?: SnapshotSaveOptions
  ) => string;
  clearSession: (sessionId: string) => void;
};

let _ops: MessageSnapshotsOps | null = null;
const _activeVsmBySession = new Map<string, VirtualScrollManager>();

/**
 * 注册当前活跃会话的 VirtualScrollManager 实例，供快照保存时自动抓取实测高度。
 */
export function registerActiveVsm(
  sessionId: string,
  vsm: VirtualScrollManager
): void {
  if (sessionId && vsm) {
    _activeVsmBySession.set(sessionId, vsm);
  }
}

/**
 * 注销当前会话的 VirtualScrollManager 实例。
 */
export function unregisterActiveVsm(sessionId: string): void {
  if (sessionId) {
    _activeVsmBySession.delete(sessionId);
  }
}

/**
 * 获取指定会话当前活跃的 VirtualScrollManager。
 */
export function getActiveVsm(
  sessionId: string
): VirtualScrollManager | undefined {
  return _activeVsmBySession.get(sessionId);
}

/**
 * 从 VirtualScrollManager 抓取给定消息列表中所有已测量的真实卡片高度映射。
 */
export function captureHeightMapFromVsm(
  messages: readonly SessionMessage[],
  vsm: VirtualScrollManager
): Record<string, number> {
  const heightMap: Record<string, number> = {};
  for (const m of messages) {
    const h = vsm.getActualHeight(m.id) ?? vsm.getHeight(m.id);
    if (h != null && Number.isFinite(h) && h > 0) {
      heightMap[m.id] = h;
    }
  }
  return heightMap;
}

/**
 * 注入真实 MessageSnapshots 适配器（bootstrapStores 在模块图稳定后调用）。
 * 幂等：同实例重复绑定直接返回；不同实例重复注入以最后一次为准并告警。
 */
export function bindMessageSnapshotsOps(ops: MessageSnapshotsOps): void {
  if (ops === _ops) return;
  if (_ops !== null) {
    logger.warn('[Snapshots] bridge already bound — replacing previous ops');
  }
  _ops = ops;
}

export function saveMessageSnapshot(
  sessionId: string,
  entry: SnapshotSaveEntry,
  options?: SnapshotSaveOptions
): void {
  let heightMap = options?.heightMap;
  const vsm = options?.vsm ?? getActiveVsm(sessionId);
  if (!heightMap && vsm) {
    heightMap = captureHeightMapFromVsm(entry.messages, vsm);
  }
  _ops?.save(sessionId, entry, { ...options, heightMap });
}

/**
 * 辅助函数：从 sessionStore 或指定消息列表保存快照并自动捕获 VSM 测高。
 */
export function saveSessionSnapshot(
  sessionId: string,
  operation: SnapshotSaveEntry['operation'],
  messages: SessionMessage[],
  afterMessages?: SessionMessage[],
  vsm?: VirtualScrollManager
): void {
  saveMessageSnapshot(
    sessionId,
    {
      sessionId,
      operation,
      messages,
      diffFilePaths: [],
      timestamp: Date.now(),
    },
    {
      afterMessages,
      vsm,
    }
  );
}

export function clearMessageSnapshots(sessionId: string): void {
  _ops?.clearSession(sessionId);
}
