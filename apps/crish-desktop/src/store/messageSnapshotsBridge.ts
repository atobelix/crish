/**
 * 打破 init 环：layoutStore → sessionActions ↛ MessageSnapshots → sessionStore → layoutStore。
 * sessionActions 只依赖本桥；bootstrapStores 在模块图稳定后注入真实 messageSnapshots。
 */
import type { SessionMessage } from './types';

/** 与 MessageSnapshots.save 入参对齐的最小形状（避免 sessionActions 静态 import MessageSnapshots） */
export type SnapshotSaveEntry = {
  sessionId: string;
  operation: 'withdraw' | 'regenerate' | 'archive' | 'batch-pin' | 'edit';
  messages: SessionMessage[];
  pinnedMessageIds?: string[];
  diffFilePaths: string[];
  timestamp: number;
  description?: string;
};

export type SnapshotSaveOptions = {
  afterMessages?: SessionMessage[];
};

export type MessageSnapshotsOps = {
  save: (
    sessionId: string,
    entry: SnapshotSaveEntry,
    options?: SnapshotSaveOptions,
  ) => string;
  clearSession: (sessionId: string) => void;
};

let _ops: MessageSnapshotsOps | null = null;

export function saveMessageSnapshot(
  sessionId: string,
  entry: SnapshotSaveEntry,
  options?: SnapshotSaveOptions,
): void {
  _ops?.save(sessionId, entry, options);
}

export function clearMessageSnapshots(sessionId: string): void {
  _ops?.clearSession(sessionId);
}
