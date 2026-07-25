import React from 'react';
import styles from '../OverviewCard.module.css';
import { Tooltip } from '../Tooltip';
import { ChevronDown, File, FileCode2, FileText, GitBranch, Image, RefreshCw, Table } from 'lucide-react';
import { openGitDownloadPage } from '../../api/gitApi';
import { detectFileKind } from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import { gitStatusLabel } from '../../api/gitApi';
import { basename, getGitStatusColor } from './helpers';
import type { GitStatusResult } from '../../api/gitApi';
import type { DiffFileInfo } from '../../api/storeAccess';

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') return <Image size={sz} className={styles.ico} style={{ color }} aria-hidden />;
  if (k === 'pdf') return <FileText size={sz} className={styles.ico} style={{ color }} aria-hidden />;
  if (k === 'table') return <Table size={sz} className={styles.ico} style={{ color }} aria-hidden />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) return <FileCode2 size={sz} className={styles.ico} style={{ color }} aria-hidden />;
  return <File size={sz} className={styles.ico} style={{ color }} aria-hidden />;
}

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
  onOpenGitFile: (f: any) => void;
  onSetShowAllFiles: (v: boolean) => void;
  onOpenPanel: (id: string) => void;
  onOpenDiffSource: (f: DiffFileInfo) => void;
}

export const ChangesSection = React.memo(function ChangesSection({
  open, git, gitLoading, gitErr, convoFiles, openingPath, actionErr,
  showAllFiles, branch, gitHelp,
  onToggle, onRefreshGit, onOpenGitFile, onSetShowAllFiles, onOpenPanel, onOpenDiffSource,
}: ChangesSectionProps) {
  const gitFiles = git?.found ? git.files : [];
  const fileCount = Math.max(gitFiles.length, convoFiles.length);
  const hasFileList = gitFiles.length > 0 || convoFiles.length > 0;

  return (
    <section className={styles.sec} aria-labelledby="overview-sec-files">
      <div className={styles.secHRow}>
        <button type="button" id="overview-sec-files" className={styles.secH}
          aria-expanded={open} aria-controls="overview-sec-files-b" onClick={onToggle}>
          <GitBranch size={15} strokeWidth={1.75} aria-hidden />
          <span>改动</span>
          {fileCount > 0 ? <span className={styles.pill}>{fileCount}</span> : null}
          {branch ? <span className={styles.branchLabel}>({branch})</span> : null}
          <ChevronDown size={14} className={`${styles.chev} ${open ? styles.open : ''}`} aria-hidden />
        </button>
        <Tooltip content="刷新">
          <button type="button" className={styles.iconBtn} aria-label={gitLoading ? '正在刷新' : '刷新 Git'}
            disabled={gitLoading} onClick={() => onRefreshGit({ force: true })}>
            <RefreshCw size={14} strokeWidth={1.75} className={gitLoading ? 'spin' : ''} aria-hidden />
          </button>
        </Tooltip>
      </div>
      {open ? (
        <div className={styles.secB} id="overview-sec-files-b" aria-busy={gitLoading || Boolean(openingPath)}>
          {!gitLoading && gitHelp ? (
            <div className={styles.gitHelp} role="status">
              <div className={styles.inlineErr} role="alert">{gitHelp.title}</div>
              {gitHelp.hint ? <p className={`${styles.empty} ${styles.emptyQuiet}`}>{gitHelp.hint}</p> : null}
              <div className={styles.gitActions}>
                {gitHelp.action === 'download-git' ? <button type="button" className={styles.link} onClick={() => void openGitDownloadPage()}>下载 Git</button> : null}
                {gitHelp.action === 'init-repo' ? <Tooltip content="打开终端，在工作区执行 git init"><button type="button" className={styles.link} onClick={() => onOpenPanel('terminal')}>打开终端（git init）</button></Tooltip> : null}
                {gitHelp.action === 'retry' || gitHelp.action === 'download-git' || gitHelp.action === 'init-repo' ? <button type="button" className={styles.link} onClick={() => onRefreshGit({ force: true })}>重试</button> : null}
              </div>
            </div>
          ) : null}

          {actionErr ? <div className={styles.inlineErr} role="alert">{actionErr}</div> : null}

          {gitFiles.length > 0 ? (
            <>
              <ul className={styles.list} aria-label="Git 改动文件">
                {(showAllFiles ? gitFiles : gitFiles.slice(0, 8)).map((f: any) => {
                  const opening = openingPath === f.path;
                  const stLabel = gitStatusLabel(f.status);
                  const statusColor = getGitStatusColor(f.status);
                  const match = convoFiles.find(
                    (c) => c.filePath === f.path || basename(c.filePath) === basename(f.path),
                  );
                  return (
                    <li key={f.path}>
                      <button type="button" className={styles.itemBtn} disabled={Boolean(openingPath)}
                        aria-busy={opening}
                        aria-label={opening ? `正在打开 ${basename(f.path)}` : `${basename(f.path)}，${stLabel}`}
                        onClick={() => onOpenGitFile(f)}>
                        <FileIcon name={basename(f.path)} />
                        <span className={`${styles.itemMain} ${styles.mono}`}>
                          <Tooltip content={f.path}>
                            <span className={styles.itemName}>{basename(f.path)}</span>
                          </Tooltip>
                          <em style={{ color: statusColor, fontWeight: 300 }}>
                            {opening ? '…' : match ? `+${match.additions} −${match.deletions}` : `${stLabel}${f.conflicted ? ' · 冲突' : ''}`}
                          </em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {gitFiles.length > 8 ? (
                <button type="button" className={styles.link}
                  style={{ marginTop: 6, marginBottom: 6, width: '100%', textAlign: 'center', fontSize: 12 }}
                  onClick={() => onSetShowAllFiles(!showAllFiles)}>
                  {showAllFiles ? '收起改动列表' : `展开全部 ${gitFiles.length} 项改动`}
                </button>
              ) : null}
            </>
          ) : convoFiles.length > 0 ? (
            <>
              <ul className={styles.list} aria-label="对话改动文件">
                {(showAllFiles ? convoFiles : convoFiles.slice(0, 8)).map((f) => {
                  const statusColor = f.additions > 0 ? 'var(--accent-green, #22c55e)' : 'var(--accent-orange, #f97316)';
                  return (
                    <li key={f.filePath}>
                      <button type="button" className={styles.itemBtn}
                        aria-label={`打开 ${basename(f.filePath)}`}
                        onClick={() => { onOpenDiffSource(f); onOpenPanel('diff'); }}>
                        <FileIcon name={basename(f.filePath)} />
                        <span className={`${styles.itemMain} ${styles.mono}`}>
                          <Tooltip content={f.filePath}>
                            <span className={styles.itemName}>{basename(f.filePath)}</span>
                          </Tooltip>
                          <em style={{ color: statusColor, fontWeight: 300 }}>+{f.additions} −{f.deletions}</em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {convoFiles.length > 8 ? (
                <button type="button" className={styles.link}
                  style={{ marginTop: 6, marginBottom: 6, width: '100%', textAlign: 'center', fontSize: 12 }}
                  onClick={() => onSetShowAllFiles(!showAllFiles)}>
                  {showAllFiles ? '收起改动列表' : `展开全部 ${convoFiles.length} 项改动`}
                </button>
              ) : null}
            </>
          ) : !gitHelp && !gitLoading ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
              {git?.found && git.clean ? '干净' : '无改动'}
            </p>
          ) : gitLoading ? (
            <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">读取 Git…</p>
          ) : null}

          {hasFileList ? (
            <button type="button" className={styles.link} onClick={() => onOpenPanel('diff')}>查看变更</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
