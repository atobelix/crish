/**
 * 右侧默认总览：只保留有用信息
 * - 有目标/进行中工具时一行提示
 * - 协作体：有则列表，点开右侧；空则不说教
 * - 改动文件：Git/对话变更列表；错误只显示一次
 * - 去掉「工作总览」标题重复、上下文空统计、神秘图标条
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import {
  selectActiveSession,
  selectActiveSessionId,
  useSessionField,
} from '../store/sessionStore';
import {
  fetchGitDiff,
  fetchGitStatus,
  gitStatusBadgeClass,
  gitStatusLabel,
  gitStatusUserMessage,
  openGitDownloadPage,
  type GitStatusFile,
  type GitStatusResult,
} from '../api/gitApi';
import { getWorkspacePath } from '../api/projectStore';
import { openAgentInSidePanel } from '../api/openAgentPanel';
import { toolHumanLabel } from '../api/toolPresentation';
import { pushDiffFile, setActiveDiffSource } from '../api/storeAccess';
import {
  computeChecklistProgress,
  findCurrentLiveTool,
  resolveSessionProgressItems,
} from './TasksCard';

type Props = {
  wsId: string;
  onOpenPanel: (id: string) => void;
  /** @deprecated 总览错误改行内；保留 prop 兼容 CardPanel 传参，勿再调用 */
  onShowToast?: (msg: string) => void;
};

type SecKey = 'agents' | 'files';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

/** 协作体展示名：折叠空白为单行 */
function agentOneLineLabel(description: string | undefined, id: string): string {
  const raw = (description || id || '').replace(/\s+/g, ' ').trim();
  return raw || id;
}

function agentStatusLabel(status: string): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '已停止';
  return '完成';
}

const OverviewCardInner: React.FC<Props> = ({ onOpenPanel }) => {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);

  const [openSec, setOpenSec] = useState<Record<SecKey, boolean>>({
    agents: true,
    files: true,
  });
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitErr, setGitErr] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const actionErrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGitRefreshAtRef = useRef(0);
  const gitRefreshSeqRef = useRef(0);

  const agents = session?.agents || [];
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1;
      const br = b.status === 'running' ? 0 : 1;
      if (ar !== br) return ar - br;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  }, [agents]);

  const convoFiles = useMemo(() => {
    if (diffFiles?.length) return diffFiles;
    return activeDiffSource ? [activeDiffSource] : [];
  }, [diffFiles, activeDiffSource]);

  const clearActionErrSoon = useCallback((ms = 4800) => {
    if (actionErrTimerRef.current) {
      clearTimeout(actionErrTimerRef.current);
      actionErrTimerRef.current = null;
    }
    actionErrTimerRef.current = setTimeout(() => {
      setActionErr(null);
      actionErrTimerRef.current = null;
    }, ms);
  }, []);

  const showActionErr = useCallback(
    (msg: string) => {
      setActionErr(msg);
      clearActionErrSoon();
    },
    [clearActionErrSoon],
  );

  useEffect(
    () => () => {
      if (actionErrTimerRef.current) clearTimeout(actionErrTimerRef.current);
    },
    [],
  );

  const refreshGit = useCallback(async (opts?: { force?: boolean }) => {
    const now = Date.now();
    if (!opts?.force && now - lastGitRefreshAtRef.current < 30_000) {
      return;
    }
    lastGitRefreshAtRef.current = now;
    const seq = ++gitRefreshSeqRef.current;
    setGitLoading(true);
    setGitErr(null);
    try {
      const res = await fetchGitStatus();
      if (seq !== gitRefreshSeqRef.current) return;
      setGit(res);
      if (!res.found) {
        const msg = gitStatusUserMessage(res);
        setGitErr(msg.title);
      } else {
        setGitErr(null);
      }
    } catch {
      if (seq !== gitRefreshSeqRef.current) return;
      setGitErr('Git 不可用');
      setGit(null);
    } finally {
      // 无论是否被更新的请求抢占，本轮结束时若仍是最新 seq 则关 loading；
      // 若被抢占，由更新一轮的 finally 负责，避免永久转圈。
      if (seq === gitRefreshSeqRef.current) setGitLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGit({ force: true });
    const onProject = () => {
      void refreshGit({ force: true });
    };
    window.addEventListener('crish-project-changed', onProject);
    const onFocus = () => {
      void refreshGit();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('crish-project-changed', onProject);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshGit]);

  const toggle = (k: SecKey) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  const openGitFile = async (f: GitStatusFile) => {
    if (openingPath) return;
    setOpeningPath(f.path);
    setActionErr(null);
    if (actionErrTimerRef.current) {
      clearTimeout(actionErrTimerRef.current);
      actionErrTimerRef.current = null;
    }
    try {
      const diff = await fetchGitDiff({ path: f.path });
      if (diff.files.length > 0) {
        const first = diff.files[0];
        const merged = { ...first, filePath: first.filePath || f.path };
        pushDiffFile(merged);
        setActiveDiffSource(merged);
        onOpenPanel('diff');
        return;
      }
      const placeholder = {
        filePath: f.path,
        additions: 0,
        deletions: 0,
        changes: [
          {
            type: 'normal' as const,
            content: `（${gitStatusLabel(f.status)}）暂无行级差异可显示`,
          },
        ],
      };
      pushDiffFile(placeholder);
      setActiveDiffSource(placeholder);
      onOpenPanel('diff');
    } catch {
      showActionErr('打开变更失败');
    } finally {
      setOpeningPath(null);
    }
  };

  const gitFiles = git?.found ? git.files : [];
  const fileCount = Math.max(gitFiles.length, convoFiles.length);
  const hasFileList = gitFiles.length > 0 || convoFiles.length > 0;
  const runningAgentCount = sortedAgents.filter((a) => a.status === 'running').length;
  const gitHelp = useMemo(
    () => (git && !git.found ? gitStatusUserMessage(git) : null),
    [git],
  );

  const progressItems = useMemo(
    () => resolveSessionProgressItems(session),
    [session?.messages, session?.goalMode?.tasks],
  );
  const progress = useMemo(
    () => computeChecklistProgress(progressItems),
    [progressItems],
  );
  const goalMode = session?.goalMode?.active ? session.goalMode : null;
  const liveTool = useMemo(
    () => findCurrentLiveTool(session),
    [session?.messages, session?.agents],
  );
  const liveToolLabel = useMemo(
    () => (liveTool ? toolHumanLabel(liveTool) : ''),
    [liveTool],
  );
  const liveToolStatus =
    liveTool?.status === 'pending_approval'
      ? '待确认'
      : liveTool?.status === 'running'
        ? '进行中'
        : '';

  const wsPath = getWorkspacePath();
  const branch = git?.found && git.branch ? git.branch : '';

  return (
    <div
      className="overview-card overview-card--lean"
      role="region"
      aria-label="总览"
      data-git-loading={gitLoading ? '1' : '0'}
      data-file-count={fileCount}
    >
      {/* 仅有信息时一行：分支 / 目标 / 当前工具 — 无「工作总览」重复标题 */}
      {branch || goalMode || progress.total > 0 || liveTool ? (
        <div className="overview-meta-line" aria-label="会话状态">
          {branch ? (
            <span className="overview-meta-chip" title={branch}>
              <Lucide.GitBranch size={12} strokeWidth={1.75} aria-hidden />
              {branch}
            </span>
          ) : null}
          {wsPath ? (
            <span className="overview-meta-chip" title={wsPath}>
              {basename(wsPath)}
            </span>
          ) : null}
        </div>
      ) : null}

      {goalMode || progress.total > 0 ? (
        <button
          type="button"
          className="overview-live-row overview-live-row--goal"
          title={goalMode?.goal || '打开任务'}
          aria-label={
            goalMode
              ? `目标：${agentOneLineLabel(goalMode.goal, '目标')}`
              : `清单 ${progress.done}/${progress.total}`
          }
          onClick={() => onOpenPanel('tasks')}
        >
          <Lucide.Target
            size={14}
            strokeWidth={1.75}
            className="overview-live-ico"
            aria-hidden
          />
          <span className="overview-item-name">
            {goalMode ? agentOneLineLabel(goalMode.goal, '目标') : '清单'}
          </span>
          <em>
            {progress.total > 0
              ? `${progress.done}/${progress.total}`
              : goalMode
                ? `第 ${(goalMode.iteration ?? 0) + 1} 轮`
                : ''}
          </em>
        </button>
      ) : null}

      {liveTool ? (
        <div
          className="overview-live-row"
          aria-live="polite"
          aria-label={`${liveToolLabel}${liveToolStatus ? `，${liveToolStatus}` : ''}`}
        >
          <span className="overview-dot live" aria-hidden="true" />
          <span className="overview-item-name" title={liveToolLabel}>
            {liveToolLabel}
          </span>
          <em>{liveToolStatus}</em>
        </div>
      ) : null}

      {/* 协作体：有列表才显示分区；点行 = 右侧打开，不废话 */}
      <section className="overview-sec" aria-labelledby="overview-sec-agents">
        <button
          type="button"
          id="overview-sec-agents"
          className="overview-sec-h"
          aria-expanded={openSec.agents}
          aria-controls="overview-sec-agents-b"
          onClick={() => toggle('agents')}
        >
          <Lucide.Bot size={15} strokeWidth={1.75} aria-hidden />
          <span>协作体</span>
          {sortedAgents.length > 0 ? (
            <span className="overview-pill">
              {runningAgentCount > 0 ? `${runningAgentCount} 运行` : sortedAgents.length}
            </span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.agents ? 'open' : ''}`}
            aria-hidden
          />
        </button>
        {openSec.agents ? (
          <div className="overview-sec-b" id="overview-sec-agents-b">
            {sortedAgents.length > 0 ? (
              <ul className="overview-list overview-list--agents" aria-label="协作体列表">
                {sortedAgents.map((a) => {
                  const name = agentOneLineLabel(a.description, a.id);
                  const st = agentStatusLabel(a.status);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        className="overview-item-btn overview-item-btn--agent"
                        title={name}
                        aria-label={`${name}，${st}`}
                        onClick={() => {
                          openAgentInSidePanel(a.id, {
                            sessionId: activeSessionId || undefined,
                          });
                        }}
                      >
                        <span
                          className={`overview-dot ${a.status === 'running' ? 'live' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="overview-item-main">
                          <span className="overview-item-name">{name}</span>
                          <em>{st}</em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="overview-empty overview-empty--quiet" role="status">
                无
              </p>
            )}
          </div>
        ) : null}
      </section>

      <section className="overview-sec" aria-labelledby="overview-sec-files">
        <div className="overview-sec-h-row">
          <button
            type="button"
            id="overview-sec-files"
            className="overview-sec-h"
            aria-expanded={openSec.files}
            aria-controls="overview-sec-files-b"
            onClick={() => toggle('files')}
          >
            <Lucide.GitBranch size={15} strokeWidth={1.75} aria-hidden />
            <span>改动</span>
            {fileCount > 0 ? (
              <span className="overview-pill">{fileCount}</span>
            ) : null}
            <Lucide.ChevronDown
              size={14}
              className={`overview-chev ${openSec.files ? 'open' : ''}`}
              aria-hidden
            />
          </button>
          <button
            type="button"
            className="overview-icon-btn"
            title="刷新"
            aria-label={gitLoading ? '正在刷新' : '刷新 Git'}
            disabled={gitLoading}
            onClick={() => {
              setActionErr(null);
              if (actionErrTimerRef.current) {
                clearTimeout(actionErrTimerRef.current);
                actionErrTimerRef.current = null;
              }
              void refreshGit({ force: true });
            }}
          >
            <Lucide.RefreshCw
              size={14}
              strokeWidth={1.75}
              className={gitLoading ? 'spin' : ''}
              aria-hidden
            />
          </button>
        </div>
        {openSec.files ? (
          <div
            className="overview-sec-b"
            id="overview-sec-files-b"
            aria-busy={gitLoading || Boolean(openingPath)}
          >
            {git?.found && git.branch ? (
              <p className="overview-empty overview-empty--quiet" role="status">
                分支 {git.branch}
                {git.clean ? ' · 干净' : ''}
              </p>
            ) : null}

            {/* 诊断：无 git / 非仓库 / 超时 — 可操作，不无限转圈 */}
            {!gitLoading && gitHelp ? (
              <div className="overview-git-help" role="status">
                <div className="overview-inline-err" role="alert">
                  {gitHelp.title}
                </div>
                {gitHelp.hint ? (
                  <p className="overview-empty overview-empty--quiet">{gitHelp.hint}</p>
                ) : null}
                <div className="overview-git-actions">
                  {gitHelp.action === 'download-git' ? (
                    <button
                      type="button"
                      className="overview-link"
                      onClick={() => void openGitDownloadPage()}
                    >
                      下载 Git
                    </button>
                  ) : null}
                  {gitHelp.action === 'init-repo' ? (
                    <button
                      type="button"
                      className="overview-link"
                      title="打开终端，在工作区执行 git init"
                      onClick={() => onOpenPanel('terminal')}
                    >
                      打开终端（git init）
                    </button>
                  ) : null}
                  {gitHelp.action === 'retry' || gitHelp.action === 'download-git' || gitHelp.action === 'init-repo' ? (
                    <button
                      type="button"
                      className="overview-link"
                      onClick={() => void refreshGit({ force: true })}
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {actionErr ? (
              <div className="overview-inline-err" role="alert">
                {actionErr}
              </div>
            ) : null}

            {gitFiles.length > 0 ? (
              <ul className="overview-list" aria-label="Git 改动文件">
                {gitFiles.map((f) => {
                  const opening = openingPath === f.path;
                  const stLabel = gitStatusLabel(f.status);
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        className="overview-item-btn"
                        disabled={Boolean(openingPath)}
                        aria-busy={opening}
                        aria-label={
                          opening
                            ? `正在打开 ${basename(f.path)}`
                            : `${basename(f.path)}，${stLabel}`
                        }
                        onClick={() => void openGitFile(f)}
                      >
                        <span
                          className={gitStatusBadgeClass(f.status)}
                          title={stLabel}
                          aria-hidden="true"
                        >
                          {String(f.status).slice(0, 1)}
                        </span>
                        <span className="overview-item-main mono">
                          <span className="overview-item-name" title={f.path}>
                            {basename(f.path)}
                          </span>
                          <em>
                            {opening
                              ? '…'
                              : `${stLabel}${f.conflicted ? ' · 冲突' : ''}`}
                          </em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : convoFiles.length > 0 ? (
              <ul className="overview-list" aria-label="对话改动文件">
                {convoFiles.map((f) => (
                  <li key={f.filePath}>
                    <button
                      type="button"
                      className="overview-item-btn"
                      aria-label={`打开 ${basename(f.filePath)}`}
                      onClick={() => {
                        setActiveDiffSource(f);
                        onOpenPanel('diff');
                      }}
                    >
                      <Lucide.FileCode2 size={14} strokeWidth={1.75} aria-hidden />
                      <span className="overview-item-main mono">
                        <span className="overview-item-name" title={f.filePath}>
                          {basename(f.filePath)}
                        </span>
                        <em>
                          +{f.additions} −{f.deletions}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : !gitHelp && !gitLoading ? (
              <p className="overview-empty overview-empty--quiet" role="status">
                {git?.found && git.clean ? '干净' : '无改动'}
              </p>
            ) : gitLoading ? (
              <p className="overview-empty overview-empty--quiet" role="status">
                读取 Git…
              </p>
            ) : null}

            {hasFileList ? (
              <button
                type="button"
                className="overview-link"
                onClick={() => onOpenPanel('diff')}
              >
                查看变更
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
