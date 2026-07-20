/**
 * Atomic Session State Epoch Snapshot System
 * 
 * 职责：
 * - 借鉴 Hermes CheckpointManager 与 OpenCode Epoch/Sequence 理念
 * - 绑定物理文件快照 (commitHash)、数据库事件日志偏移量 (eventSequenceOffset) 与活动子任务 (subagentStates)
 * - 提供 File Watcher 的静默锁定机制 (Mute/Unmute Gate)，防止物理回滚触发文件监视器向 Agent 上下文灌入变更噪音
 */

export interface EpochSnapshot {
  epochId: string;
  leafId: string;
  timestamp: number;
  workspaceCommitHash: string; // Shadow Git Commit Hash
  dbEventOffset: number;       // SQLite event sourcing sequence number
  subagentStates: Record<string, { runId: string; status: string }>;
}

export type FileWatcherListener = (event: string, path: string) => void;

export class FileWatcherMuteGate {
  private static isMuted = false;
  private static listeners: Set<FileWatcherListener> = new Set();

  /** 注册文件监视器监听器 */
  public static registerListener(listener: FileWatcherListener): void {
    this.listeners.add(listener);
  }

  /** 注销监听器 */
  public static unregisterListener(listener: FileWatcherListener): void {
    this.listeners.delete(listener);
  }

  /** 静默锁定：开始物理回滚，屏蔽一切磁盘变化通知 */
  public static mute(): void {
    this.isMuted = true;
    console.debug("[MuteGate] File watchers MUTED for physical workspace rollback.");
  }

  /** 解除静默：回滚结束，恢复监听 */
  public static unmute(): void {
    this.isMuted = false;
    console.debug("[MuteGate] File watchers UNMUTED.");
  }

  /** 代理分发文件变化事件。如果处于静默期，则直接丢弃事件 */
  public static notify(event: string, path: string): void {
    if (this.isMuted) {
      // 丢弃变更，防止噪音灌入 LLM 上下文
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(event, path);
      } catch {
        /* ignore listener crash */
      }
    }
  }
}

/** Epoch 快照管理器 */
export class EpochSnapshotManager {
  private snapshots: Map<string, EpochSnapshot> = new Map();

  /** 创建一个新的 Epoch 快照并持久化关联 */
  public createSnapshot(
    leafId: string,
    workspaceCommitHash: string,
    dbEventOffset: number,
    subagents: Record<string, { runId: string; status: string }>
  ): EpochSnapshot {
    const epochId = `epoch-${leafId}-${Date.now()}`;
    const snapshot: EpochSnapshot = {
      epochId,
      leafId,
      timestamp: Date.now(),
      workspaceCommitHash,
      dbEventOffset,
      subagentStates: { ...subagents }
    };
    this.snapshots.set(epochId, snapshot);
    return snapshot;
  }

  /** 获取指定 Leaf ID 对应的最新快照 */
  public getSnapshotForLeaf(leafId: string): EpochSnapshot | undefined {
    return Array.from(this.snapshots.values())
      .filter((s) => s.leafId === leafId)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  /** 执行原子回滚：在还原物理文件前后，包裹锁定 MuteGate */
  public async executeAtomicRollback(
    snapshot: EpochSnapshot,
    rollbackFilesCallback: (commitHash: string) => Promise<void>
  ): Promise<void> {
    try {
      // 1. 锁定监视器，防止回退过程产生的文件变化噪音进入 LLM 上下文
      FileWatcherMuteGate.mute();

      // 2. 还原物理文件
      await rollbackFilesCallback(snapshot.workspaceCommitHash);

      console.info(`[EpochSnapshot] Atomic rollback successfully completed for Epoch: ${snapshot.epochId}`);
    } finally {
      // 3. 解锁监视器
      FileWatcherMuteGate.unmute();
    }
  }
}
