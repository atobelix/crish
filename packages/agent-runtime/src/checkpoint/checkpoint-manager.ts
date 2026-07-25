/**
 * Checkpoint 加固 - 引用备份 + 恢复警告
 *
 * 解决的问题：
 * 1. Checkpoint 恢复时没有引用完整性检查
 * 2. 恢复操作缺乏警告，可能导致数据丢失
 * 3. 没有备份机制，恢复后无法回退
 * 4. 缺乏恢复前的兼容性检查
 *
 * 设计原则：
 * 1. 恢复前必须创建备份
 * 2. 恢复前必须进行兼容性检查
 * 3. 恢复前必须向用户发出警告
 * 4. 恢复操作可回退
 */

import type { AgentMessage } from "@crish/shared-types";
import { BoundedMap } from "@crish/shared-utils";

/** Checkpoint 记录上限：每 turn 可能创建一个，100 足以覆盖典型会话的回溯需求。 */
const MAX_CHECKPOINTS = 100;
/** 恢复备份上限：恢复操作较少，50 足以覆盖回退链。 */
const MAX_BACKUPS = 50;

// ─── Checkpoint 元数据 ────────────────────────────────────

export interface CheckpointMetadata {
  checkpointId: string;
  sessionId: string;
  createdAt: string;
  messageCount: number;
  turnIndex: number;
  schemaVersion: number;
  /** 引用的消息 ID 列表 */
  referencedMessageIds: string[];
  /** 创建时的配置快照 */
  configSnapshot?: Record<string, unknown>;
  /** 标签 */
  label?: string;
  /** 描述 */
  description?: string;
}

// ─── 恢复警告 ─────────────────────────────────────────────

export type RestoreWarningSeverity = "info" | "warning" | "critical";

export interface RestoreWarning {
  severity: RestoreWarningSeverity;
  code: string;
  message: string;
  detail?: string;
  /** 是否可以强制跳过 */
  dismissible: boolean;
}

// ─── 兼容性检查结果 ───────────────────────────────────────

export interface CompatibilityCheckResult {
  compatible: boolean;
  warnings: RestoreWarning[];
  /** 缺失的引用 */
  missingReferences: string[];
  /** Schema 版本差异 */
  schemaVersionDelta: number;
}

// ─── 恢复结果 ─────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  restoredCheckpointId: string;
  backupCheckpointId: string;
  warnings: RestoreWarning[];
  /** 被丢弃的消息数 */
  discardedMessageCount: number;
  /** 被丢弃的 turn 数 */
  discardedTurnCount: number;
}

// ─── CheckpointManager ────────────────────────────────────

export class CheckpointManager {
  private checkpoints = new BoundedMap<string, CheckpointMetadata>(MAX_CHECKPOINTS, undefined);
  private backups = new BoundedMap<string, CheckpointMetadata>(MAX_BACKUPS, undefined);
  private currentSchemaVersion = 1;

  constructor(private readonly sessionId: string) {}

  /**
   * 创建 Checkpoint
   */
  createCheckpoint(
    messages: AgentMessage[],
    turnIndex: number,
    options?: { label?: string; description?: string }
  ): CheckpointMetadata {
    const checkpointId = createCheckpointId();
    const referencedMessageIds = messages.map((m) => m.id);

    const metadata: CheckpointMetadata = {
      checkpointId,
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
      turnIndex,
      schemaVersion: this.currentSchemaVersion,
      referencedMessageIds,
      ...(options?.label !== undefined ? { label: options.label } : {}),
      ...(options?.description !== undefined ? { description: options.description } : {})
    };

    this.checkpoints.set(checkpointId, metadata);
    return metadata;
  }

  /**
   * 恢复前的兼容性检查
   */
  checkCompatibility(
    checkpoint: CheckpointMetadata,
    currentMessages: AgentMessage[]
  ): CompatibilityCheckResult {
    const warnings: RestoreWarning[] = [];
    const missingReferences: string[] = [];

    // 1. Schema 版本检查
    const schemaVersionDelta = this.currentSchemaVersion - checkpoint.schemaVersion;
    if (schemaVersionDelta > 0) {
      warnings.push({
        severity: "warning",
        code: "SCHEMA_VERSION_MISMATCH",
        message: `Checkpoint was created with schema v${checkpoint.schemaVersion}, current is v${this.currentSchemaVersion}`,
        detail: "Some data may need migration",
        dismissible: true
      });
    } else if (schemaVersionDelta < 0) {
      warnings.push({
        severity: "critical",
        code: "SCHEMA_VERSION_TOO_NEW",
        message: `Checkpoint was created with a newer schema (v${checkpoint.schemaVersion})`,
        detail: "This checkpoint cannot be restored with the current version",
        dismissible: false
      });
    }

    // 2. 引用完整性检查
    const currentMessageIds = new Set(currentMessages.map((m) => m.id));
    for (const refId of checkpoint.referencedMessageIds) {
      if (!currentMessageIds.has(refId)) {
        missingReferences.push(refId);
      }
    }
    if (missingReferences.length > 0) {
      warnings.push({
        severity: "warning",
        code: "MISSING_REFERENCES",
        message: `${missingReferences.length} referenced messages are missing from current state`,
        detail: `Missing IDs: ${missingReferences.slice(0, 5).join(", ")}${missingReferences.length > 5 ? "..." : ""}`,
        dismissible: true
      });
    }

    // 3. 数据丢失警告
    const discardedMessageCount = currentMessages.length - checkpoint.messageCount;
    if (discardedMessageCount > 0) {
      warnings.push({
        severity: "critical",
        code: "DATA_LOSS",
        message: `Restoring will discard ${discardedMessageCount} messages created after this checkpoint`,
        detail: "A backup will be created before restoration",
        dismissible: false
      });
    }

    // 4. Session ID 不匹配
    if (checkpoint.sessionId !== this.sessionId) {
      warnings.push({
        severity: "critical",
        code: "SESSION_MISMATCH",
        message: "Checkpoint belongs to a different session",
        dismissible: false
      });
    }

    const compatible = !warnings.some((w) => w.severity === "critical" && !w.dismissible);

    return {
      compatible,
      warnings,
      missingReferences,
      schemaVersionDelta
    };
  }

  /**
   * 创建恢复前的备份
   */
  createRestoreBackup(
    currentMessages: AgentMessage[],
    currentTurnIndex: number
  ): CheckpointMetadata {
    const backup = this.createCheckpoint(currentMessages, currentTurnIndex, {
      label: "pre-restore-backup",
      description: `Backup created before restoring checkpoint`
    });
    this.backups.set(backup.checkpointId, backup);
    return backup;
  }

  /**
   * 执行恢复
   */
  restore(
    checkpointId: string,
    currentMessages: AgentMessage[],
    currentTurnIndex: number,
    force?: boolean
  ): RestoreResult {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint "${checkpointId}" not found`);
    }

    // 兼容性检查
    const compatibility = this.checkCompatibility(checkpoint, currentMessages);
    if (!compatibility.compatible && !force) {
      throw new Error(
        `Cannot restore checkpoint: ${compatibility.warnings
          .filter((w) => !w.dismissible)
          .map((w) => w.message)
          .join("; ")}`
      );
    }

    // 创建备份
    const backup = this.createRestoreBackup(currentMessages, currentTurnIndex);

    const discardedMessageCount = Math.max(0, currentMessages.length - checkpoint.messageCount);

    return {
      success: true,
      restoredCheckpointId: checkpointId,
      backupCheckpointId: backup.checkpointId,
      warnings: compatibility.warnings,
      discardedMessageCount,
      discardedTurnCount: Math.max(0, currentTurnIndex - checkpoint.turnIndex)
    };
  }

  /**
   * 获取 Checkpoint
   */
  getCheckpoint(checkpointId: string): CheckpointMetadata | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * 列出所有 Checkpoint
   */
  listCheckpoints(): CheckpointMetadata[] {
    return [...this.checkpoints.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * 列出所有备份
   */
  listBackups(): CheckpointMetadata[] {
    return [...this.backups.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}

function createCheckpointId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
