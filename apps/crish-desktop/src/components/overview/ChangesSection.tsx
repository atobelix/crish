import React, { useMemo, useCallback } from 'react';
import styles from './OverviewCard.module.css';
import { Button, Tooltip } from '../ui';
import { ChevronDown, GitBranch, RefreshCw } from 'lucide-react';
import { openGitDownloadPage } from '../../api/gitApi';
import type { GitStatusResult } from '../../api/gitApi';
import type { GitStatusFile, GitStatusCode } from '../../api/gitTreeHelpers';
import type { DiffFileInfo } from '../../api/storeAccess';
import { OverviewGitTree } from './OverviewGitTree';

interface ChangesSectionProps {
  open: boolean;
  git: GitStatusResult | null;
  gitLoading: boolean;
  gitErr: string | null;
  convoFiles: DiffFileInfo[];
  openingPath: string | null;
  actionErr: string | null;
  showAllFiles: boolean;
  branch: string;
  gitHelp: { title: string; hint?: string; action?: string } | null;
  onToggle: () => void;
  onRefreshGit: (opts?: { force?: boolean }) => void;
  onOpenGitFile: (f: import('../../api/gitApi').GitStatusFile) => void;
  onSetShowAllFiles: (v: boolean) => void;
  onOpenPanel: (id: string) => void;
  onOpenDiffSource: (f: DiffFileInfo) => void;
}

export const ChangesSection = React.memo(function ChangesSection({
  open,
  git,
  gitLoading,
  convoFiles,
  openingPath,
  actionErr,
  branch,
  gitHelp,
  onToggle,
  onRefreshGit,
  onOpenGitFile,
  onOpenPanel,
  onOpenDiffSource,
}: ChangesSectionProps) {
  const rawGitFiles = useMemo(() => (git?.found ? git.files : []), [git]);

  const treeGitFiles = useMemo<GitStatusFile[]>(() => {
    return rawGitFiles.map((f) => ({
      path: f.path,
      status: (f.status as GitStatusCode) || 'M',
      additions: (f as unknown as { additions?: number }).additions || 0,
      deletions: (f as unknown as { deletions?: number }).deletions || 0,
      conflicted: f.conflicted,
      staged: f.staged,
    }));
  }, [rawGitFiles]);

  // 对话改动文件转为标准 GitStatusFile 结构
  const normalizedConvoFiles = useMemo<GitStatusFile[]>(() => {
    return convoFiles.map((c) => ({
      path: c.filePath,
      status: 'M' as GitStatusCode,
      additions: c.additions,
      deletions: c.deletions,
    }));
  }, [convoFiles]);

  const activeFiles =
    treeGitFiles.length > 0 ? treeGitFiles : normalizedConvoFiles;
  const fileCount = activeFiles.length;
  const hasFileList = fileCount > 0;

  const handleOpenFile = useCallback(
    (file: GitStatusFile) => {
      if (rawGitFiles.length > 0) {
        const found = rawGitFiles.find((f) => f.path === file.path);
        if (found) {
          onOpenGitFile(found);
          return;
        }
      }
      const match = convoFiles.find(
        (c) => c.filePath === file.path || c.filePath.endsWith(file.path)
      );
      if (match) {
        onOpenDiffSource(match);
      } else {
        onOpenDiffSource({
          filePath: file.path,
          additions: file.additions || 0,
          deletions: file.deletions || 0,
          changes: [],
        });
      }
      onOpenPanel('diff');
    },
    [rawGitFiles, onOpenGitFile, convoFiles, onOpenDiffSource, onOpenPanel]
  );

  return (
    <section className={styles.sec} aria-labelledby="overview-sec-files">
      <div className={styles.secHRow}>
        <button
          type="button"
          id="overview-sec-files"
          className={styles.secH}
          aria-expanded={open}
          aria-controls="overview-sec-files-b"
          onClick={onToggle}
        >
          <GitBranch size={15} strokeWidth={1.75} aria-hidden />
          <span>改动</span>
          {fileCount > 0 ? (
            <span className={styles.pill}>{fileCount}</span>
          ) : null}
          {branch ? (
            <span className={styles.branchLabel}>({branch})</span>
          ) : null}
          <ChevronDown
            size={14}
            className={`${styles.chev} ${open ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        <Tooltip content="刷新">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.iconBtn}
            aria-label={gitLoading ? '正在刷新' : '刷新 Git'}
            disabled={gitLoading}
            onClick={() => onRefreshGit({ force: true })}
            icon={
              <RefreshCw
                size={14}
                strokeWidth={1.75}
                className={gitLoading ? 'spin' : ''}
                aria-hidden
              />
            }
          />
        </Tooltip>
      </div>
      {open ? (
        <div
          className={styles.secB}
          id="overview-sec-files-b"
          aria-busy={gitLoading || Boolean(openingPath)}
        >
          {!gitLoading && gitHelp ? (
            <div className={styles.gitHelp} role="status">
              <div className={styles.inlineErr} role="alert">
                {gitHelp.title}
              </div>
              {gitHelp.hint ? (
                <p className={`${styles.empty} ${styles.emptyQuiet}`}>
                  {gitHelp.hint}
                </p>
              ) : null}
              <div className={styles.gitActions}>
                {gitHelp.action === 'download-git' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.link}
                    onClick={() => void openGitDownloadPage()}
                  >
                    下载 Git
                  </Button>
                ) : null}
                {gitHelp.action === 'init-repo' ? (
                  <Tooltip content="打开终端，在工作区执行 git init">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.link}
                      onClick={() => onOpenPanel('terminal')}
                    >
                      打开终端（git init）
                    </Button>
                  </Tooltip>
                ) : null}
                {gitHelp.action === 'retry' ||
                gitHelp.action === 'download-git' ||
                gitHelp.action === 'init-repo' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.link}
                    onClick={() => onRefreshGit({ force: true })}
                  >
                    重试
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {actionErr ? (
            <div className={styles.inlineErr} role="alert">
              {actionErr}
            </div>
          ) : null}

          {hasFileList ? (
            <OverviewGitTree
              files={activeFiles}
              openingPath={openingPath}
              onOpenFile={handleOpenFile}
            />
          ) : !gitHelp && !gitLoading ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
              {git?.found && git.clean ? '干净' : '无改动'}
            </p>
          ) : gitLoading ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
              读取 Git…
            </p>
          ) : null}

          {hasFileList ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.link}
              onClick={() => onOpenPanel('diff')}
            >
              查看变更
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
