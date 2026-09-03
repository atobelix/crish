/**
 * SessionChangesView.tsx — 当前对话专属改动视图（单一职责）。
 *
 * 核心优化：
 * 1. 仅消费当前会话产生的 UnifiedFileChange[]；
 * 2. 移除冗余的底部「查看会话变更」按钮；
 * 3. 干净呈现文件列表与纯净空态。
 */

import React from 'react';
import { OverviewChangesList } from '../OverviewChangesList';
import { ChangesEmptyState } from './ChangesEmptyState';
import type { UnifiedFileChange } from './types';
import type { GitStatusFile } from '../../../api/gitTreeHelpers';
import styles from '../OverviewCard.module.css';

export interface SessionChangesViewProps {
  files: UnifiedFileChange[];
  openingPath: string | null;
  gitCount: number;
  onOpenFile: (file: UnifiedFileChange) => void;
  onSwitchToGit: () => void;
}

export const SessionChangesView: React.FC<SessionChangesViewProps> = ({
  files,
  openingPath,
  gitCount,
  onOpenFile,
  onSwitchToGit,
}) => {
  if (files.length === 0) {
    return (
      <ChangesEmptyState message="当前对话暂无文件改动" />
    );
  }

  const gitStatusFiles: GitStatusFile[] = files.map((f) => ({
    path: f.filePath,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));

  const handleItemClick = (gitFile: GitStatusFile) => {
    const matched = files.find((f) => f.filePath === gitFile.path);
    if (matched) {
      onOpenFile(matched);
    }
  };

  return (
    <div className={styles.sessionChangesWrap}>
      <OverviewChangesList
        files={gitStatusFiles}
        openingPath={openingPath}
        onOpenFile={handleItemClick}
      />
    </div>
  );
};
