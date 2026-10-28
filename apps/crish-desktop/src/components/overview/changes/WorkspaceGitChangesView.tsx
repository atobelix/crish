/**
 * WorkspaceGitChangesView.tsx — 工作区 Git 仓库改动视图（单一职责）。
 *
 * 核心优化：
 * 1. 物理删除多余的独立分支行（分支已在头部 Select 下拉中直观显示）；
 * 2. 物理删除多余的「查看工作区变更」按钮，保持列表纯净；
 * 3. 仅在有改动时渲染文件列表，环境异常时精准提示。
 */

import React from 'react';
import { Button, Tooltip } from '@/components/ui';
import { OverviewChangesList } from '../OverviewChangesList';
import { openGitDownloadPage, type GitStatusResult } from '../../../api/gitApi';
import type { GitStatusFile, GitStatusCode } from '../../../api/gitTreeHelpers';
import styles from '../OverviewCard.module.css';

export interface WorkspaceGitChangesViewProps {
  git: GitStatusResult | null;
  gitLoading: boolean;
  openingPath: string | null;
  actionErr: string | null;
  gitHelp: { title: string; hint?: string; action?: string } | null;
  onRefreshGit: (opts?: { force?: boolean }) => void;
  onOpenGitFile: (f: GitStatusFile) => void;
  onOpenTerminalPanel: () => void;
}

export const WorkspaceGitChangesView: React.FC<
  WorkspaceGitChangesViewProps
> = ({
  git,
  gitLoading,
  openingPath,
  actionErr,
  gitHelp,
  onRefreshGit,
  onOpenGitFile,
  onOpenTerminalPanel,
}) => {
  const rawGitFiles = git?.found ? git.files : [];
  const treeGitFiles: GitStatusFile[] = rawGitFiles.map((f) => ({
    path: f.path,
    status: (f.status as GitStatusCode) || 'M',
    additions: (f as unknown as { additions?: number }).additions || 0,
    deletions: (f as unknown as { deletions?: number }).deletions || 0,
    conflicted: f.conflicted,
    staged: f.staged,
  }));

  return (
    <div className={styles.gitChangesWrap}>
      {!gitLoading && gitHelp && (
        <div className={styles.gitHelp} role="status">
          <div className={styles.inlineErr} role="alert">
            {gitHelp.title}
          </div>
          {gitHelp.hint && (
            <p className={`${styles.empty} ${styles.emptyQuiet}`}>
              {gitHelp.hint}
            </p>
          )}
          <div className={styles.gitActions}>
            {gitHelp.action === 'download-git' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.link}
                onClick={() => void openGitDownloadPage()}
              >
                下载 Git
              </Button>
            )}
            {gitHelp.action === 'init-repo' && (
              <Tooltip content="打开终端，在工作区执行 git init">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.link}
                  onClick={onOpenTerminalPanel}
                >
                  打开终端（git init）
                </Button>
              </Tooltip>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.link}
              onClick={() => onRefreshGit({ force: true })}
            >
              重试
            </Button>
          </div>
        </div>
      )}

      {actionErr && (
        <div className={styles.inlineErr} role="alert">
          {actionErr}
        </div>
      )}

      {treeGitFiles.length > 0 ? (
        <OverviewChangesList
          files={treeGitFiles}
          openingPath={openingPath}
          onOpenFile={onOpenGitFile}
          maxInitialFiles={1000}
        />
      ) : !gitHelp && !gitLoading ? (
        <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
          暂无改动
        </p>
      ) : gitLoading ? (
        <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
          读取 Git 仓库…
        </p>
      ) : null}
    </div>
  );
};
