/**
 * changes/ChangesSection.tsx — 改动面板顶层容器协调器（单一职责）。
 *
 * 核心调度职责：
 * 1. 负责面板折叠状态与三维选择（scope: 'session' | 'unstaged' | 'branch'）管理；
 * 2. 默认模式为 'session'（当前对话改动），零 Git 脏数据污染；
 * 3. 将分支名称直接传递给头部 Select 下拉展现，彻底干掉独立行；
 * 4. 移除多余的底部跳转按钮，保持轻量纯净。
 */

import React, { useState, useCallback } from 'react';
import { ChangesSectionHeader } from './ChangesSectionHeader';
import { SessionChangesView } from './SessionChangesView';
import { WorkspaceGitChangesView } from './WorkspaceGitChangesView';
import { useSessionScopedChanges } from './useSessionScopedChanges';
import type { ChangesScopeMode, UnifiedFileChange } from './types';
import type { GitStatusResult, GitStatusFile } from '../../../api/gitApi';
import { setActiveDiffSource, pushDiffFile } from '../../../api/storeAccess';
import styles from '../OverviewCard.module.css';

export interface ChangesSectionProps {
  open: boolean;
  git: GitStatusResult | null;
  gitLoading: boolean;
  branch: string;
  openingPath: string | null;
  actionErr: string | null;
  gitHelp: { title: string; hint?: string; action?: string } | null;
  onToggle: () => void;
  onRefreshGit: (opts?: { force?: boolean }) => void;
  onOpenGitFile: (f: GitStatusFile) => void;
  onOpenPanel: (id: string) => void;
  workspaceRoot?: string;
}

export const ChangesSection: React.FC<ChangesSectionProps> = React.memo(
  function ChangesSection({
    open,
    git,
    gitLoading,
    branch,
    openingPath,
    actionErr,
    gitHelp,
    onToggle,
    onRefreshGit,
    onOpenGitFile,
    onOpenPanel,
    workspaceRoot,
  }) {
    // 默认且首要模式为当前对话改动
    const [scope, setScope] = useState<ChangesScopeMode>('session');

    // 提取当前对话专属改动列表
    const { sessionFiles, totalFiles: sessionCount } = useSessionScopedChanges(workspaceRoot);
    const gitCount = git?.found ? git.files.length : 0;

    const handleOpenSessionFile = useCallback(
      (file: UnifiedFileChange) => {
        if (file.rawDiff) {
          setActiveDiffSource(file.rawDiff);
          pushDiffFile(file.rawDiff);
        }
        onOpenPanel('diff');
      },
      [onOpenPanel]
    );

    return (
      <section className={styles.sec} aria-labelledby="overview-sec-files">
        <ChangesSectionHeader
          open={open}
          scope={scope}
          sessionCount={sessionCount}
          gitCount={gitCount}
          gitLoading={gitLoading}
          branch={branch}
          onToggleOpen={onToggle}
          onScopeChange={setScope}
          onRefreshGit={() => onRefreshGit({ force: true })}
        />

        {open && (
          <div className={styles.secB} id="overview-sec-files-b">
            {scope === 'session' ? (
              <SessionChangesView
                files={sessionFiles}
                openingPath={openingPath}
                gitCount={gitCount}
                onOpenFile={handleOpenSessionFile}
                onSwitchToGit={() => setScope('unstaged')}
              />
            ) : (
              <WorkspaceGitChangesView
                git={git}
                gitLoading={gitLoading}
                openingPath={openingPath}
                actionErr={actionErr}
                gitHelp={gitHelp}
                onRefreshGit={onRefreshGit}
                onOpenGitFile={onOpenGitFile}
                onOpenTerminalPanel={() => onOpenPanel('terminal')}
              />
            )}
          </div>
        )}
      </section>
    );
  }
);
