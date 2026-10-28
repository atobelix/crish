/**
 * ArtifactCapsuleSyncLine.tsx
 * 代码产物胶囊与实时同步状态行（§5.4 / reference artifact-notebook.css）。
 *
 * 特性：
 * - 产物芯片（ArtifactCapsule）：`已生成 PE-08-session-loop-ipc-batcher`
 *   - 呈现为高级的翡翠绿下划线超链接（color: var(--brand-deep)）；
 *   - Hover 时加深，点击分流至右侧面板或打开 Notebook 预览；
 * - 实时同步行（SyncLine）：
 *   - 正在同步：`正在同步 batcher.rs 与前端虚拟列表渲染管线...`（1.4s 呼吸绿点）；
 *   - 已完成态：`已落盘 (1.2KB)`。
 */
import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import styles from './FlowArtifactChip.module.css';

export interface ArtifactCapsuleProps {
  name: string;
  prefix?: string;
  path?: string;
  docId?: string;
  onClick?: (pathOrDocId?: string) => void;
  className?: string;
}

export const ArtifactCapsule: React.FC<ArtifactCapsuleProps> = ({
  name,
  prefix,
  path,
  docId,
  onClick,
  className,
}) => {
  const target = docId || path;
  return (
    <div
      className={`${styles.flowArtifactRow} ${className || ''} flow-artifact`}
      data-flow-artifact="true"
    >
      <span
        className={`${styles.flowArtifactIcon} flow-artifact__icon`}
        aria-hidden
      >
        <AppIcon name="file-text" size={14} aria-hidden />
      </span>
      {prefix ? <span className="flow-artifact__prefix">{prefix}</span> : null}
      <Tooltip content={`打开产物 ${name}`}>
        <Button
          type="button"
          variant="ghost"
          className={`${styles.flowArtifactChip} flow-artifact__chip`}
          onClick={(e) => {
            e.stopPropagation();
            onClick?.(target);
          }}
          aria-label={`打开产物 ${name}`}
        >
          {name}
        </Button>
      </Tooltip>
    </div>
  );
};

export interface SyncLineProps {
  status: 'syncing' | 'completed';
  label: string;
  size?: string;
  className?: string;
}

export const SyncLine: React.FC<SyncLineProps> = ({
  status,
  label,
  size,
  className,
}) => {
  const isSyncing = status === 'syncing';
  return (
    <div
      className={`${styles.flowSyncLine} ${className || ''} flow-sync-line`}
      data-sync-status={status}
    >
      {isSyncing ? (
        <>
          <span className={`${styles.flowSyncDot} flow-sync-dot`} aria-hidden />
          <span>正在同步 {label}...</span>
        </>
      ) : (
        <span className={`${styles.flowSyncDone} flow-sync-done`}>
          <AppIcon name="check" size={13} aria-hidden />
          {size ? <span>({size})</span> : null}
        </span>
      )}
    </div>
  );
};
