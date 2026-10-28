import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchGitDiff,
  fetchGitStatus,
  gitStatusLabel,
  gitStatusUserMessage,
  type GitStatusFile,
  type GitStatusResult,
} from '../../api/gitApi';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import {
  pushDiffFile,
  setActiveDiffSource,
  setActiveSessionId,
} from '../../api/storeAccess';
import {
  getBackgroundTaskOutput,
  openBackgroundTaskInTerminal,
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';
import { engineApproveTool, engineDenyTool } from '../../api/chatBridge';
import { useSessionStore } from '../../store/storeAccess';
import type { SessionState } from '../../store/types';
import type { PendingApprovalInfo } from '../../api/engineStatus';
import { useEngineState } from '../../hooks/useEngineState';

export interface LiveTask {
  id: string;
  taskName: string;
  elapsedSeconds: number;
  sessionId?: string | undefined;
  kind: 'session' | 'run' | 'interrupted';
}

export function useOverviewState(
  sessions: SessionState[],
  activeRuns: Array<{
    runId: string;
    startedAt?: number | string | undefined;
    prompt?: string | undefined;
    sessionId?: string | undefined;
  }>,
  onOpenPanel: (id: string) => void
) {
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [bgOpeningId, setBgOpeningId] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const actionErrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGitRefreshAtRef = useRef(0);
  const gitRefreshSeqRef = useRef(0);
  // T5-2：中断 run 展示数据源（useEngineState 心跳兜底识别——引擎探活
  // 失败窗口内从 activeRuns 消失的 run；与 useEngineState 模块单例共享
  // refcount，零额外轮询）
  const engineDs = useEngineState();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(
    () => () => {
      if (actionErrTimerRef.current) clearTimeout(actionErrTimerRef.current);
    },
    []
  );

  const liveTasks = useMemo(() => {
    const from: LiveTask[] = [];
    for (const s of sessions) {
      for (const m of s.messages || []) {
        if (m.status === 'processing') {
          from.push({
            id: m.id,
            taskName: s.title || '对话进行中',
            elapsedSeconds: Math.max(
              0,
              Math.round((now - (m.timestamp || now)) / 1000)
            ),
            sessionId: s.id,
            kind: 'session',
          });
        }
      }
    }
    for (const r of activeRuns) {
      if (from.some((t) => t.id === r.runId)) continue;
      const started =
        typeof r.startedAt === 'number'
          ? r.startedAt
          : typeof r.startedAt === 'string'
            ? Date.parse(r.startedAt) || now
            : now;
      const matched = sessions.find(
        (s) => s.engineLastRunId === r.runId || s.id === r.sessionId
      );
      from.push({
        id: r.runId,
        taskName: (
          (matched?.title || r.prompt || '').trim() || '引擎任务'
        ).slice(0, 48),
        elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)),
        sessionId: matched?.id || r.sessionId,
        kind: 'run',
      });
    }
    // T5-2：中断 run 展示（引擎异常期间消失、无 run-terminal 事件的心跳
    // 兜底识别；kind='interrupted' 与活动 run 区分，任务名带「已中断」）
    for (const ir of engineDs.interruptedRuns) {
      if (from.some((t) => t.id === ir.runId)) continue;
      const matched = sessions.find((s) => s.engineLastRunId === ir.runId);
      from.push({
        id: ir.runId,
        taskName: `${(matched?.title || ir.prompt || '引擎任务').trim().slice(0, 40)}（已中断）`,
        elapsedSeconds: Math.max(
          0,
          Math.round((now - ir.interruptedAt) / 1000)
        ),
        sessionId: matched?.id,
        kind: 'interrupted',
      });
    }
    return from;
  }, [sessions, activeRuns, engineDs.interruptedRuns, now]);

  const showActionErr = useCallback((msg: string) => {
    setActionErr(msg);
    if (actionErrTimerRef.current) clearTimeout(actionErrTimerRef.current);
    actionErrTimerRef.current = setTimeout(() => {
      setActionErr(null);
      actionErrTimerRef.current = null;
    }, 4800);
  }, []);

  const focusSession = (sid: string) => {
    setActiveSessionId(sid);
    clearAgentPanelFocus();
    try {
      window.dispatchEvent(
        new CustomEvent('crish-focus-chat', { detail: { sessionId: sid } })
      );
    } catch {
      /* ignore */
    }
  };

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const found = a.toolCallId
      ? sessions.find(
          (s) =>
            (s.messages || []).some((m) =>
              (m.toolCalls || []).some(
                (tc) =>
                  tc.id === a.toolCallId && tc.status === 'pending_approval'
              )
            ) ||
            (s.agents || []).some((ag) =>
              (ag.messages || []).some((m) =>
                (m.toolCalls || []).some(
                  (tc) =>
                    tc.id === a.toolCallId && tc.status === 'pending_approval'
                )
              )
            )
        )
      : undefined;
    const found2 =
      !found && a.runId
        ? sessions.find(
            (s) => s.engineLastRunId === a.runId || s.id === a.runId
          )
        : found;
    if (found2) focusSession(found2.id);
    else showActionErr('未找到待确认会话');
  };

  const markLocalTool = (
    toolCallId: string | undefined,
    status: 'running' | 'error',
    output: string,
    runId?: string
  ) => {
    if (!toolCallId) return;
    // T-E 步骤 4（C1）：raw setState 全表扫描 → markToolCallLocalStatus action
    //（scope 命中时只扫 scope 内；handleApprovalAllow 有 a.runId 可传）
    useSessionStore
      .getState()
      .markToolCallLocalStatus(
        toolCallId,
        status,
        output,
        runId ? { runId } : undefined
      );
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
    markLocalTool(id, 'running', '执行中…', a.runId);
    void engineApproveTool(id)
      .catch(() => {
        markLocalTool(id, 'error', '批准失败', a.runId);
        showActionErr('批准失败，请重试');
      })
      .finally(() => setApprovalBusyId(null));
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
    markLocalTool(id, 'error', '已拒绝', a.runId);
    void engineDenyTool(id)
      .catch(() => showActionErr('拒绝失败，请重试'))
      .finally(() => setApprovalBusyId(null));
  };

  const openBgTask = async (t: BackgroundTaskInfo) => {
    if (bgOpeningId) return;
    setBgOpeningId(t.id);
    try {
      const out = await getBackgroundTaskOutput(t.id);
      openBackgroundTaskInTerminal(
        t.label,
        out ||
          t.summary ||
          t.command ||
          BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER
      );
    } catch {
      openBackgroundTaskInTerminal(
        t.label,
        t.summary || t.command || '读取失败'
      );
      showActionErr('读取后台任务输出失败');
    } finally {
      setBgOpeningId(null);
    }
  };

  const refreshGit = useCallback(async (opts?: { force?: boolean }) => {
    const nowTime = Date.now();
    if (!opts?.force && nowTime - lastGitRefreshAtRef.current < 30_000) return;
    lastGitRefreshAtRef.current = nowTime;
    const seq = ++gitRefreshSeqRef.current;
    setGitLoading(true);
    try {
      const res = await fetchGitStatus();
      if (seq !== gitRefreshSeqRef.current) return;
      setGit(res);
    } catch {
      if (seq === gitRefreshSeqRef.current) {
        setGit(null);
      }
    } finally {
      if (seq === gitRefreshSeqRef.current) setGitLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGit({ force: true });
    const p = () => refreshGit({ force: true });
    window.addEventListener('crish-project-changed', p);
    const f = () => refreshGit();
    window.addEventListener('focus', f);
    return () => {
      window.removeEventListener('crish-project-changed', p);
      window.removeEventListener('focus', f);
    };
  }, [refreshGit]);

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
        pushDiffFile({ ...first, filePath: first.filePath || f.path });
        setActiveDiffSource({ ...first, filePath: first.filePath || f.path });
        onOpenPanel('diff');
        return;
      }
      const pl = {
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
      pushDiffFile(pl);
      setActiveDiffSource(pl);
      onOpenPanel('diff');
    } catch (error) {
      showActionErr(error instanceof Error ? error.message : '打开变更失败');
    } finally {
      setOpeningPath(null);
    }
  };

  const gitHelp = useMemo(
    () => (git && !git.found ? gitStatusUserMessage(git) : null),
    [git]
  );

  return {
    git,
    gitLoading,
    openingPath,
    actionErr,
    showAllFiles,
    setShowAllFiles,
    bgOpeningId,
    approvalBusyId,
    liveTasks,
    gitHelp,
    refreshGit,
    openGitFile,
    handleApprovalClick,
    handleApprovalAllow,
    handleApprovalDeny,
    openBgTask,
    focusSession,
  };
}
