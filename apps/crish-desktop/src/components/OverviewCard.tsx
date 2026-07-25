/**
 * 右侧默认总览：只保留有用信息
 * - 有目标/进行中工具时一行提示
 * - 协作体：有则列表，点开右侧；空则不说教
 * - 改动文件：Git/对话变更列表；错误只显示一次
 * - 去掉「工作总览」标题重复、上下文空统计、神秘图标条
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './OverviewCard.module.css';
import * as Lucide from 'lucide-react';
import { produce } from 'immer';
import { useLayoutStore } from '../store/layoutStore';
import {
  selectActiveSession,
  selectActiveSessionId,
  useSessionField,
} from '../store/sessionStore';
import {
  fetchGitDiff,
  fetchGitStatus,
  gitStatusLabel,
  gitStatusUserMessage,
  openGitDownloadPage,
  type GitStatusFile,
  type GitStatusResult,
} from '../api/gitApi';
import { getWorkspacePath } from '../api/projectStore';
import { openAgentInSidePanel, clearAgentPanelFocus } from '../api/openAgentPanel';
import { pushDiffFile, setActiveDiffSource, setActiveSessionId } from '../api/storeAccess';
import type { FileDiff, MessageToolCall } from '../store/layoutStore';
import {
  computeChecklistProgress,
  findCurrentLiveTool,
  resolveSessionProgressItems,
} from '../api/sessionProgressApi';

import { estimateCostUsd } from '../api/pricingStore';
import { getActiveModelId, resolveDisplayModelId } from '../api/providerProfiles';
import {
  type PendingApprovalInfo,
} from '../api/engineStatus';
import { scheduleLabel } from '../api/workflowApi';
import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  backgroundTaskStateLabel,
  getBackgroundTaskOutput,
  openBackgroundTaskInTerminal,
  type BackgroundTaskInfo,
} from '../api/backgroundTasksApi';
import { daemonApproveTool, daemonDenyTool } from '../api/daemonChatBridge';

import { detectFileKind } from '../api/workspaceFsApi';
import { fileExtColor } from '../api/codeHighlight';
import type { CronJob } from '../api/clientApi';
import { useDaemonState } from '../hooks/useDaemonState';
import { Tooltip } from './Tooltip';

type Props = {
  wsId: string;
  onOpenPanel: (id: string) => void;
  /** @deprecated 总览错误改行内；保留 prop 兼容 CardPanel 传参，勿再调用 */
  onShowToast?: (msg: string) => void;
};

type SecKey = 'agents' | 'files' | 'usage' | 'activeTasks' | 'bgTasks' | 'cronJobs';

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

function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

function formatBgTaskMeta(opts: {
  state: unknown;
  command: string | undefined;
  opening: boolean | undefined;
}): string {
  if (opts.opening) return '打开中…';
  const label = backgroundTaskStateLabel(opts.state);
  const cmd = (opts.command || '').trim();
  if (!cmd) return label;
  return `${label} · ${cmd.slice(0, 40)}`;
}

function getGitStatusColor(status: string): string {
  if (status === 'A' || status === '?') return 'var(--accent-green, #22c55e)';
  if (status === 'D') return 'var(--accent-red, #ef4444)';
  if (status === 'U') return 'var(--accent-red, #ef4444)';
  return 'var(--accent-orange, #f97316)';
}

function FileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sw = 1.7;
  const sz = 14;
  if (k === 'image') return <Lucide.Image size={sz} className={styles.ico} style={{ color }} strokeWidth={sw} aria-hidden />;
  if (k === 'pdf') return <Lucide.FileText size={sz} className={styles.ico} style={{ color }} strokeWidth={sw} aria-hidden />;
  if (k === 'table') return <Lucide.Table size={sz} className={styles.ico} style={{ color }} strokeWidth={sw} aria-hidden />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) {
    return <Lucide.FileCode2 size={sz} className={styles.ico} style={{ color }} strokeWidth={sw} aria-hidden />;
  }
  return <Lucide.File size={sz} className={styles.ico} style={{ color }} strokeWidth={sw} aria-hidden />;
}

const OverviewCardInner: React.FC<Props> = ({ onOpenPanel }) => {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);

  const [openSec, setOpenSec] = useState<Record<SecKey, boolean>>({
    agents: true,
    files: true,
    usage: false,
    activeTasks: false,
    bgTasks: false,
    cronJobs: false,
  });
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [, setGitErr] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);

  // ── States and subscriptions migrated from RuntimePanel ──────────────────────
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const sessions = useLayoutStore((state) => state.sessions);

  const [now, setNow] = useState(() => Date.now());
  const ds = useDaemonState();
  const [bgOpeningId, setBgOpeningId] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);

  // 1-second now timer
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  type LiveTask = {
    id: string;
    taskName: string;
    elapsedSeconds: number;
    sessionId?: string | undefined;
    kind: 'session' | 'run';
  };

  const liveTasks = useMemo(() => {
    const fromMessages: LiveTask[] = [];
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.status === 'processing') {
          fromMessages.push({
            id: m.id,
            taskName: s.title || '对话进行中',
            elapsedSeconds: Math.max(0, Math.round((now - (m.timestamp || now)) / 1000)),
            sessionId: s.id,
            kind: 'session',
          });
        }
      }
    }
    for (const r of ds.activeRuns) {
      if (fromMessages.some((t) => t.id === r.runId)) continue;
      const started =
        typeof r.startedAt === 'number'
          ? r.startedAt
          : typeof r.startedAt === 'string'
            ? Date.parse(r.startedAt) || now
            : now;
      const matched = sessions.find(
        (s) => s.engineLastRunId === r.runId || s.id === r.sessionId,
      );
      const rawName = (matched?.title || r.prompt || '').trim();
      fromMessages.push({
        id: r.runId,
        taskName: (rawName || '引擎任务').slice(0, 48),
        elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)),
        sessionId: matched?.id || r.sessionId,
        kind: 'run',
      });
    }
    return fromMessages;
  }, [sessions, ds.activeRuns, now]);

  const focusSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    clearAgentPanelFocus();
    try {
      window.dispatchEvent(new CustomEvent('crish-focus-chat', { detail: { sessionId } }));
    } catch {
      /* ignore */
    }
  };

  const handleLiveTaskClick = (wk: LiveTask) => {
    if (!wk.sessionId) return;
    focusSession(wk.sessionId);
  };

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const toolCallId = a.toolCallId;
    let found = toolCallId
      ? sessions.find(
          (s) =>
            (s.messages || []).some((m) =>
              (m.toolCalls || []).some(
                (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
              ),
            ) ||
            (s.agents || []).some((ag) =>
              (ag.messages || []).some((m) =>
                (m.toolCalls || []).some(
                  (tc) => tc.id === toolCallId && tc.status === 'pending_approval',
                ),
              ),
            ),
        )
      : undefined;
    if (!found && a.runId) {
      found = sessions.find(
        (s) => s.engineLastRunId === a.runId || s.id === a.runId,
      );
    }
    if (found) {
      focusSession(found.id);
    } else {
      showActionErr('未找到待确认会话');
    }
  };

  const markLocalTool = (
    toolCallId: string | undefined,
    status: 'running' | 'error',
    output: string,
  ) => {
    if (!toolCallId) return;
    useLayoutStore.setState(produce((state) => {
      for (const s of state.sessions) {
        for (const m of s.messages || []) {
          const tc = m.toolCalls?.find((t: MessageToolCall) => t.id === toolCallId);
          if (tc) {
            tc.status = status;
            tc.output = output;
          }
        }
        for (const ag of s.agents || []) {
          for (const m of ag.messages || []) {
            const tc = m.toolCalls?.find((t: MessageToolCall) => t.id === toolCallId);
            if (tc) {
              tc.status = status;
              tc.output = output;
            }
          }
        }
      }
    }));
  };

  const handleApprovalAllow = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      showActionErr('缺少工具 id，无法批准');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'running', '执行中…');
    void daemonApproveTool(id)
      .catch(() => {
        markLocalTool(id, 'error', '批准失败');
        showActionErr('批准失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const handleApprovalDeny = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = a.toolCallId;
    if (!id) {
      showActionErr('缺少工具 id，无法拒绝');
      return;
    }
    if (approvalBusyId) return;
    setApprovalBusyId(id);
    markLocalTool(id, 'error', '已拒绝');
    void daemonDenyTool(id)
      .catch(() => {
        showActionErr('拒绝失败，请重试');
      })
      .finally(() => {
        setApprovalBusyId(null);
      });
  };

  const openBgTask = async (t: BackgroundTaskInfo) => {
    if (bgOpeningId) return;
    setBgOpeningId(t.id);
    try {
      const out = await getBackgroundTaskOutput(t.id);
      openBackgroundTaskInTerminal(
        t.label,
        out || t.summary || t.command || BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
      );
    } catch {
      openBackgroundTaskInTerminal(
        t.label,
        t.summary || t.command || '读取失败',
      );
      showActionErr('读取后台任务输出失败');
    } finally {
      setBgOpeningId(null);
    }
  };

  const modelId = resolveDisplayModelId() || getActiveModelId() || 'unknown';
  const estimated =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);

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

  // 切项目或折叠改动区时重置为默认折叠 (最多展示 8 项)
  useEffect(() => {
    setShowAllFiles(false);
  }, [openSec.files]);

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
        const first = diff.files[0]!;
        const merged: FileDiff = { ...first, filePath: first.filePath || f.path };
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
  const liveToolLabel = liveTool ? liveTool.label : '';
  const liveToolStatus = liveTool ? liveTool.statusLabel : '';

  const wsPath = getWorkspacePath();
  const branch = git?.found && git.branch ? git.branch : '';

  return (
    <div
      className={`${styles.card} ${styles.lean}`}
      role="region"
      aria-label="总览"
      data-git-loading={gitLoading ? '1' : '0'}
      data-file-count={fileCount}
    >
      {/* 仅有信息时一行：分支 / 目标 / 当前工具 — 无「工作总览」重复标题 */}
      {wsPath ? (
        <div className={styles.metaLine} aria-label="会话状态">
          <span className={styles.metaChip} title={wsPath}>
            {basename(wsPath)}
          </span>
        </div>
      ) : null}

      {goalMode || progress.total > 0 ? (
        <Tooltip content={goalMode?.goal || '活动任务与进度'}>
          <button
            type="button"
            className={`${styles.liveRow} ${styles['liveRow--goal']}`}
            aria-label={
              goalMode
                ? `目标：${agentOneLineLabel(goalMode.goal, '目标')}`
                : `清单 ${progress.done}/${progress.total}`
            }
            onClick={() => setOpenSec((prev) => ({ ...prev, activeTasks: true }))}
          >
            <Lucide.Target
              size={14}
              strokeWidth={1.75}
              className={styles.liveIco}
              aria-hidden
            />
            <span className={styles.itemName}>
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
        </Tooltip>
      ) : null}

      {liveTool ? (
        <div
          className={styles.liveRow}
          aria-live="polite"
          aria-label={`${liveToolLabel}${liveToolStatus ? `，${liveToolStatus}` : ''}`}
        >
          <span className={`${styles.dot} ${styles.live}`} aria-hidden="true" />
          <span className={styles.itemName} title={liveToolLabel}>
            {liveToolLabel}
          </span>
          <em>{liveToolStatus}</em>
        </div>
      ) : null}

      {/* 协作体：有列表才显示分区；点行 = 右侧打开，不废话 */}
      <section className={styles.sec} aria-labelledby="overview-sec-agents">
        <button
          type="button"
          id="overview-sec-agents"
          className={styles.secH}
          aria-expanded={openSec.agents}
          aria-controls="overview-sec-agents-b"
          onClick={() => toggle('agents')}
        >
          <Lucide.Bot size={15} strokeWidth={1.75} aria-hidden />
          <span>协作体</span>
          {sortedAgents.length > 0 ? (
            <span className={styles.pill}>
              {runningAgentCount > 0 ? `${runningAgentCount} 运行` : sortedAgents.length}
            </span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`${styles.chev} ${openSec.agents ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        {openSec.agents ? (
          <div className={styles.secB} id="overview-sec-agents-b">
            {sortedAgents.length > 0 ? (
              <ul className={`${styles.list} ${styles['list--agents']}`} aria-label="协作体列表">
                {sortedAgents.map((a) => {
                  const name = agentOneLineLabel(a.description, a.id);
                  const st = agentStatusLabel(a.status);
                  return (
                    <li key={a.id}>
                      <Tooltip content={name}>
                        <button
                          type="button"
                          className={`${styles.itemBtn} ${styles['itemBtn--agent']}`}
                          aria-label={`${name}，${st}`}
                          onClick={() => {
                            openAgentInSidePanel(a.id, {
                              ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                            });
                          }}
                        >
                          <span
                            className={`${styles.dot} ${a.status === 'running' ? styles.live : ''}`}
                            aria-hidden="true"
                          />
                          <span className={styles.itemMain}>
                            <span className={styles.itemName}>{name}</span>
                            <em>{st}</em>
                          </span>
                        </button>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
                无
              </p>
            )}
          </div>
        ) : null}
      </section>

      {/* ── 用量 (Usage) Section ── */}
      <section className={styles.sec} aria-labelledby="overview-sec-usage">
        <button
          type="button"
          id="overview-sec-usage"
          className={styles.secH}
          aria-expanded={openSec.usage}
          onClick={() => toggle('usage')}
        >
          <Lucide.Cpu size={15} strokeWidth={1.75} aria-hidden />
          <span>用量</span>
          <span className={styles.pill}>
            {"$"}{estimated.toFixed(3)}
          </span>
          <Lucide.ChevronDown
            size={14}
            className={`${styles.chev} ${openSec.usage ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        {openSec.usage ? (
          <div className={styles.secB}>
            <div className={styles.usageGrid}>
              <div className={styles.usageItem}>
                <span className={styles.usageLabel}>输入</span>
                <span className={styles.usageVal}>{tokenUsage.input.toLocaleString()}</span>
              </div>
              <div className={styles.usageItem}>
                <span className={styles.usageLabel}>输出</span>
                <span className={styles.usageVal}>{tokenUsage.output.toLocaleString()}</span>
              </div>
              <div className={styles.usageItem}>
                <span className={styles.usageLabel}>费用</span>
                <span className={styles.usageVal}>{"$"}{estimated.toFixed(4)}</span>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── 活动任务 (Active Tasks) Section ── */}
      <section className={styles.sec} aria-labelledby="overview-sec-active">
        <button
          type="button"
          id="overview-sec-active"
          className={styles.secH}
          aria-expanded={openSec.activeTasks}
          onClick={() => toggle('activeTasks')}
        >
          <Lucide.Activity size={15} strokeWidth={1.75} aria-hidden />
          <span>活动任务</span>
          {liveTasks.length > 0 || ds.pendingApprovals.length > 0 ? (
            <span className={styles.pill}>
              {liveTasks.length + ds.pendingApprovals.length}
            </span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`${styles.chev} ${openSec.activeTasks ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        {openSec.activeTasks ? (
          <div className={styles.secB}>
            {liveTasks.length === 0 && ds.pendingApprovals.length === 0 ? (
              <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
            ) : (
              <ul className={styles.list}>
                {ds.pendingApprovals.map((a, i) => {
                  const toolLabel = a.toolName || '工具';
                  const busy = approvalBusyId === (a.toolCallId || '');
                  return (
                    <li key={a.toolCallId || i} className={styles.actionRow}>
                      <button
                        type="button"
                        className={styles.itemBtn}
                        onClick={() => handleApprovalClick(a)}
                      >
                        <span className={`${styles.dot} ${styles.warn}`} />
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{toolLabel} (待确认)</span>
                          <em>{a.summary || '等待批准'}</em>
                        </span>
                      </button>
                      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary ui-btn-xs"
                          disabled={Boolean(approvalBusyId)}
                          onClick={(e) => handleApprovalAllow(a, e)}
                        >
                          {busy ? '…' : '允许'}
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-xs"
                          disabled={Boolean(approvalBusyId)}
                          onClick={(e) => handleApprovalDeny(a, e)}
                        >
                          拒绝
                        </button>
                      </div>
                    </li>
                  );
                })}
                {liveTasks.map((wk) => {
                  const elapsedText = formatElapsed(wk.elapsedSeconds);
                  return (
                    <li key={wk.id}>
                      <button
                        type="button"
                        className={styles.itemBtn}
                        onClick={() => { if (wk.sessionId) handleLiveTaskClick(wk); }}
                      >
                        <span className={`${styles.dot} ${styles.live}`} />
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{wk.taskName}</span>
                          <em>{elapsedText}</em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      {/* ── 后台常驻 (Background Tasks) Section ── */}
      <section className={styles.sec} aria-labelledby="overview-sec-bg">
        <button
          type="button"
          id="overview-sec-bg"
          className={styles.secH}
          aria-expanded={openSec.bgTasks}
          onClick={() => toggle('bgTasks')}
        >
          <Lucide.Terminal size={15} strokeWidth={1.75} aria-hidden />
          <span>后台常驻</span>
          {ds.bgTasks.length > 0 ? (
            <span className={styles.pill}>{ds.bgTasks.length}</span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`${styles.chev} ${openSec.bgTasks ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        {openSec.bgTasks ? (
          <div className={styles.secB}>
            {ds.bgTasks.length === 0 ? (
              <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
            ) : (
              <ul className={styles.list}>
                {ds.bgTasks.map((t) => {
                  const opening = bgOpeningId === t.id;
                  const meta = formatBgTaskMeta({
                    state: t.state,
                    command: t.command,
                    opening,
                  });
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={styles.itemBtn}
                        onClick={() => void openBgTask(t)}
                      >
                        <Lucide.Terminal size={12} className={styles.ico} />
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{t.label}</span>
                          <em>{meta}</em>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      {/* ── 计划任务 (Scheduled Tasks) Section ── */}
      <section className={styles.sec} aria-labelledby="overview-sec-cron">
        <button
          type="button"
          id="overview-sec-cron"
          className={styles.secH}
          aria-expanded={openSec.cronJobs}
          onClick={() => toggle('cronJobs')}
        >
          <Lucide.CalendarClock size={15} strokeWidth={1.75} aria-hidden />
          <span>计划任务</span>
          {ds.workflows.length + cronJobs.length > 0 ? (
            <span className={styles.pill}>{ds.workflows.length + cronJobs.length}</span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`${styles.chev} ${openSec.cronJobs ? styles.open : ''}`}
            aria-hidden
          />
        </button>
        {openSec.cronJobs ? (
          <div className={styles.secB}>
            {ds.workflows.length === 0 && cronJobs.length === 0 ? (
              <p className={`${styles.empty} ${styles.emptyQuiet}`}>无</p>
            ) : (
              <ul className={styles.list}>
                {ds.workflows.map((w) => {
                  const enabled = w.enabled !== false;
                  return (
                    <li key={w.id}>
                      <div className={styles.cronRow}>
                        <div className={styles.cronInfo}>
                          <span className={`${styles.dot} ${enabled ? styles.on : styles.off}`} />
                          <span className={styles.cronTitle}>{w.name}</span>
                        </div>
                        <span className={styles.cronMeta}>{scheduleLabel(w.schedule)}</span>
                      </div>
                    </li>
                  );
                })}
                {cronJobs.map((job: CronJob) => {
                  const active = job.status === 'active';
                  return (
                    <li key={job.id}>
                      <div className={styles.cronRow}>
                        <div className={styles.cronInfo}>
                          <span className={`${styles.dot} ${active ? styles.on : styles.off}`} />
                          <span className={styles.cronTitle}>{job.prompt}</span>
                        </div>
                        <span className={styles.cronMeta}>{job.cronExpression}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      <section className={styles.sec} aria-labelledby="overview-sec-files">
        <div className={styles.secHRow}>
          <button
            type="button"
            id="overview-sec-files"
            className={styles.secH}
            aria-expanded={openSec.files}
            aria-controls="overview-sec-files-b"
            onClick={() => toggle('files')}
          >
            <Lucide.GitBranch size={15} strokeWidth={1.75} aria-hidden />
            <span>改动</span>
            {fileCount > 0 ? (
              <span className={styles.pill}>{fileCount}</span>
            ) : null}
            {branch ? (
              <span className={styles.branchLabel}>({branch})</span>
            ) : null}
            <Lucide.ChevronDown
              size={14}
              className={`${styles.chev} ${openSec.files ? styles.open : ''}`}
              aria-hidden
            />
          </button>
          <Tooltip content="刷新">
            <button
              type="button"
              className={styles.iconBtn}
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
          </Tooltip>
        </div>
        {openSec.files ? (
          <div
            className={styles.secB}
            id="overview-sec-files-b"
            aria-busy={gitLoading || Boolean(openingPath)}
          >

            {/* 诊断：无 git / 非仓库 / 超时 — 可操作，不无限转圈 */}
            {!gitLoading && gitHelp ? (
              <div className={styles.gitHelp} role="status">
                <div className={styles.inlineErr} role="alert">
                  {gitHelp.title}
                </div>
                {gitHelp.hint ? (
                  <p className={`${styles.empty} ${styles.emptyQuiet}`}>{gitHelp.hint}</p>
                ) : null}
                <div className={styles.gitActions}>
                  {gitHelp.action === 'download-git' ? (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => void openGitDownloadPage()}
                    >
                      下载 Git
                    </button>
                  ) : null}
                  {gitHelp.action === 'init-repo' ? (
                    <Tooltip content="打开终端，在工作区执行 git init">
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => onOpenPanel('terminal')}
                      >
                        打开终端（git init）
                      </button>
                    </Tooltip>
                  ) : null}
                  {gitHelp.action === 'retry' || gitHelp.action === 'download-git' || gitHelp.action === 'init-repo' ? (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => void refreshGit({ force: true })}
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {actionErr ? (
              <div className={styles.inlineErr} role="alert">
                {actionErr}
              </div>
            ) : null}

            {gitFiles.length > 0 ? (
              <>
                <ul className={styles.list} aria-label="Git 改动文件">
                  {(showAllFiles ? gitFiles : gitFiles.slice(0, 8)).map((f) => {
                    const opening = openingPath === f.path;
                    const stLabel = gitStatusLabel(f.status);
                    const statusColor = getGitStatusColor(f.status);
                    const match = convoFiles.find(
                      (c) => c.filePath === f.path || basename(c.filePath) === basename(f.path)
                    );
                    return (
                      <li key={f.path}>
                        <button
                          type="button"
                          className={styles.itemBtn}
                          disabled={Boolean(openingPath)}
                          aria-busy={opening}
                          aria-label={
                            opening
                              ? `正在打开 ${basename(f.path)}`
                              : `${basename(f.path)}，${stLabel}`
                          }
                          onClick={() => void openGitFile(f)}
                        >
                          <FileIcon name={basename(f.path)} />
                          <span className={`${styles.itemMain} ${styles.mono}`}>
                            <span
                              className={styles.itemName}
                              title={f.path}
                            >
                              {basename(f.path)}
                            </span>
                            <em style={{ color: statusColor, fontWeight: 300 }}>
                              {opening ? (
                                '…'
                              ) : match ? (
                                `+${match.additions} −${match.deletions}`
                              ) : (
                                `${stLabel}${f.conflicted ? ' · 冲突' : ''}`
                              )}
                            </em>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {gitFiles.length > 8 ? (
                  <button
                    type="button"
                    className={styles.link}
                    style={{ marginTop: 6, marginBottom: 6, width: '100%', textAlign: 'center', fontSize: 12 }}
                    onClick={() => setShowAllFiles((v) => !v)}
                  >
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
                        <button
                          type="button"
                          className={styles.itemBtn}
                          aria-label={`打开 ${basename(f.filePath)}`}
                          onClick={() => {
                            setActiveDiffSource(f);
                            onOpenPanel('diff');
                          }}
                        >
                          <FileIcon name={basename(f.filePath)} />
                          <span className={`${styles.itemMain} ${styles.mono}`}>
                            <span
                              className={styles.itemName}
                              title={f.filePath}
                            >
                              {basename(f.filePath)}
                            </span>
                            <em style={{ color: statusColor, fontWeight: 300 }}>
                              +{f.additions} −{f.deletions}
                            </em>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {convoFiles.length > 8 ? (
                  <button
                    type="button"
                    className={styles.link}
                    style={{ marginTop: 6, marginBottom: 6, width: '100%', textAlign: 'center', fontSize: 12 }}
                    onClick={() => setShowAllFiles((v) => !v)}
                  >
                    {showAllFiles ? '收起改动列表' : `展开全部 ${convoFiles.length} 项改动`}
                  </button>
                ) : null}
              </>
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
              <button
                type="button"
                className={styles.link}
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
