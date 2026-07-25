import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../OverviewCard.module.css';
import { Tooltip } from '../Tooltip';
import { useLayoutStore } from '../../store/layoutStore';
import { selectActiveSession, selectActiveSessionId, useSessionField } from '../../store/sessionStore';
import { fetchGitDiff, fetchGitStatus, gitStatusLabel, gitStatusUserMessage, type GitStatusFile, type GitStatusResult } from '../../api/gitApi';
import { getWorkspacePath } from '../../api/projectStore';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { pushDiffFile, setActiveDiffSource, setActiveSessionId } from '../../api/storeAccess';
import { estimateCostUsd } from '../../api/pricingStore';
import { getActiveModelId, resolveDisplayModelId } from '../../api/providerProfiles';
import { type PendingApprovalInfo } from '../../api/engineStatus';
import { getBackgroundTaskOutput, openBackgroundTaskInTerminal, BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER, type BackgroundTaskInfo } from '../../api/backgroundTasksApi';
import { daemonApproveTool, daemonDenyTool } from '../../api/daemonChatBridge';
import { useDaemonState } from '../../hooks/useDaemonState';
import { basename } from './helpers';
import { ProgressSection } from './ProgressSection';
import { UsageSection } from './UsageSection';
import { ActiveTasksSection } from './ActiveTasksSection';
import { AgentSection } from './AgentSection';
import { BackgroundSection } from './BackgroundSection';
import { ScheduleSection } from './ScheduleSection';
import { ChangesSection } from './ChangesSection';

type Props = { wsId: string; onOpenPanel: (id: string) => void; onShowToast?: (msg: string) => void };
type SecKey = 'agents' | 'files' | 'usage' | 'activeTasks' | 'bgTasks' | 'cronJobs';

const OverviewCardInner: React.FC<Props> = ({ wsId, onOpenPanel }) => {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const sessions = useLayoutStore((state) => state.sessions);
  const ds = useDaemonState();

  const [openSec, setOpenSec] = useState<Record<SecKey, boolean>>({ agents: true, files: true, usage: false, activeTasks: false, bgTasks: false, cronJobs: false });
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

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => () => { if (actionErrTimerRef.current) clearTimeout(actionErrTimerRef.current); }, []);

  const liveTasks = useMemo(() => {
    const from: any[] = [];
    for (const s of sessions) for (const m of s.messages || []) if (m.status === 'processing') from.push({ id: m.id, taskName: s.title || '对话进行中', elapsedSeconds: Math.max(0, Math.round((now - (m.timestamp || now)) / 1000)), sessionId: s.id, kind: 'session' });
    for (const r of ds.activeRuns) {
      if (from.some((t: any) => t.id === r.runId)) continue;
      const started = typeof r.startedAt === 'number' ? r.startedAt : typeof r.startedAt === 'string' ? Date.parse(r.startedAt) || now : now;
      const matched = sessions.find((s: any) => s.engineLastRunId === r.runId || s.id === r.sessionId);
      from.push({ id: r.runId, taskName: ((matched?.title || r.prompt || '').trim() || '引擎任务').slice(0, 48), elapsedSeconds: Math.max(0, Math.round((now - started) / 1000)), sessionId: matched?.id || r.sessionId, kind: 'run' });
    }
    return from;
  }, [sessions, ds.activeRuns, now]);

  const showActionErr = useCallback((msg: string) => {
    setActionErr(msg);
    if (actionErrTimerRef.current) clearTimeout(actionErrTimerRef.current);
    actionErrTimerRef.current = setTimeout(() => { setActionErr(null); actionErrTimerRef.current = null; }, 4800);
  }, []);

  const focusSession = (sid: string) => { setActiveSessionId(sid); clearAgentPanelFocus(); try { window.dispatchEvent(new CustomEvent('crish-focus-chat', { detail: { sessionId: sid } })); } catch {} };

  const handleApprovalClick = (a: PendingApprovalInfo) => {
    const found = a.toolCallId ? sessions.find((s) => (s.messages || []).some((m) => (m.toolCalls || []).some((tc: any) => tc.id === a.toolCallId && tc.status === 'pending_approval')) || (s.agents || []).some((ag: any) => (ag.messages || []).some((m: any) => (m.toolCalls || []).some((tc: any) => tc.id === a.toolCallId && tc.status === 'pending_approval')))) : undefined;
    const found2 = !found && a.runId ? sessions.find((s) => s.engineLastRunId === a.runId || s.id === a.runId) : found;
    if (found2) focusSession(found2.id); else showActionErr('未找到待确认会话');
  };

  const markLocalTool = (toolCallId: string | undefined, status: 'running' | 'error', output: string) => {
    if (!toolCallId) return;
    useLayoutStore.setState((state) => { for (const s of state.sessions) { for (const m of s.messages || []) { const tc = m.toolCalls?.find((t: any) => t.id === toolCallId); if (tc) { tc.status = status; tc.output = output; } } for (const ag of s.agents || []) for (const m of ag.messages || []) { const tc = m.toolCalls?.find((t: any) => t.id === toolCallId); if (tc) { tc.status = status; tc.output = output; } } } });
  };

  const handleApprovalAllow = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation(); const id = a.toolCallId; if (!id) { showActionErr('缺少工具 id，无法批准'); return; } if (approvalBusyId) return;
    setApprovalBusyId(id); markLocalTool(id, 'running', '执行中…'); void daemonApproveTool(id).catch(() => { markLocalTool(id, 'error', '批准失败'); showActionErr('批准失败，请重试'); }).finally(() => setApprovalBusyId(null));
  };

  const handleApprovalDeny = (a: PendingApprovalInfo, e: React.MouseEvent) => {
    e.stopPropagation(); const id = a.toolCallId; if (!id) { showActionErr('缺少工具 id，无法拒绝'); return; } if (approvalBusyId) return;
    setApprovalBusyId(id); markLocalTool(id, 'error', '已拒绝'); void daemonDenyTool(id).catch(() => showActionErr('拒绝失败，请重试')).finally(() => setApprovalBusyId(null));
  };

  const openBgTask = async (t: BackgroundTaskInfo) => {
    if (bgOpeningId) return; setBgOpeningId(t.id);
    try { const out = await getBackgroundTaskOutput(t.id); openBackgroundTaskInTerminal(t.label, out || t.summary || t.command || BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER); }
    catch { openBackgroundTaskInTerminal(t.label, t.summary || t.command || '读取失败'); showActionErr('读取后台任务输出失败'); }
    finally { setBgOpeningId(null); }
  };

  const modelId = resolveDisplayModelId() || getActiveModelId() || 'unknown';
  const estimated = tokenUsage.cost > 0 ? tokenUsage.cost : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);
  const agents = session?.agents || [];
  const runningAgentCount = agents.filter((a: any) => a.status === 'running').length;
  const convoFiles = useMemo(() => diffFiles?.length ? diffFiles : activeDiffSource ? [activeDiffSource] : [], [diffFiles, activeDiffSource]);
  const gitHelp = useMemo(() => (git && !git.found ? gitStatusUserMessage(git) : null), [git]);

  const refreshGit = useCallback(async (opts?: { force?: boolean }) => {
    const now = Date.now(); if (!opts?.force && now - lastGitRefreshAtRef.current < 30_000) return;
    lastGitRefreshAtRef.current = now; const seq = ++gitRefreshSeqRef.current;
    setGitLoading(true);
    try { const res = await fetchGitStatus(); if (seq !== gitRefreshSeqRef.current) return; setGit(res); } catch { if (seq === gitRefreshSeqRef.current) { setGit(null); } }
    finally { if (seq === gitRefreshSeqRef.current) setGitLoading(false); }
  }, []);

  useEffect(() => { void refreshGit({ force: true }); const p = () => refreshGit({ force: true }); window.addEventListener('crish-project-changed', p); const f = () => refreshGit(); window.addEventListener('focus', f); return () => { window.removeEventListener('crish-project-changed', p); window.removeEventListener('focus', f); }; }, [refreshGit]);
  useEffect(() => { setShowAllFiles(false); }, [openSec.files]);

  const toggle = (k: SecKey) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  const openGitFile = async (f: GitStatusFile) => {
    if (openingPath) return; setOpeningPath(f.path); setActionErr(null);
    if (actionErrTimerRef.current) { clearTimeout(actionErrTimerRef.current); actionErrTimerRef.current = null; }
    try {
      const diff = await fetchGitDiff({ path: f.path });
      if (diff.files.length > 0) { const first = diff.files[0]; pushDiffFile({ ...first, filePath: first.filePath || f.path }); setActiveDiffSource({ ...first, filePath: first.filePath || f.path }); onOpenPanel('diff'); return; }
      const pl = { filePath: f.path, additions: 0, deletions: 0, changes: [{ type: 'normal' as const, content: `（${gitStatusLabel(f.status)}）暂无行级差异可显示` }] };
      pushDiffFile(pl); setActiveDiffSource(pl); onOpenPanel('diff');
    } catch { showActionErr('打开变更失败'); } finally { setOpeningPath(null); }
  };

  const wsPath = getWorkspacePath();
  const branch = git?.found && git.branch ? git.branch : '';

  return (
    <div className={`${styles.card} ${styles.lean}`} role="region" aria-label="总览">
      {wsPath ? <div className={styles.metaLine} aria-label="会话状态"><Tooltip content={wsPath}><span className={styles.metaChip}>{basename(wsPath)}</span></Tooltip></div> : null}
      <ProgressSection session={session} onGoalClick={() => setOpenSec((p) => ({ ...p, activeTasks: true }))} />
      <UsageSection open={openSec.usage} estimated={estimated} inputTokens={tokenUsage.input} outputTokens={tokenUsage.output} onToggle={() => toggle('usage')} />
      <ActiveTasksSection open={openSec.activeTasks} liveTasks={liveTasks} pendingApprovals={ds.pendingApprovals} approvalBusyId={approvalBusyId} onToggle={() => toggle('activeTasks')} onApprovalClick={handleApprovalClick} onApprovalAllow={handleApprovalAllow} onApprovalDeny={handleApprovalDeny} onLiveTaskClick={(wk) => { if (wk.sessionId) focusSession(wk.sessionId); }} />
      <AgentSection open={openSec.agents} agents={session?.agents || []} runningAgentCount={runningAgentCount} activeSessionId={activeSessionId || undefined} onToggle={() => toggle('agents')} />
      <BackgroundSection open={openSec.bgTasks} bgTasks={ds.bgTasks} bgOpeningId={bgOpeningId} onToggle={() => toggle('bgTasks')} onOpenTask={openBgTask} />
      <ScheduleSection open={openSec.cronJobs} workflows={ds.workflows} cronJobs={cronJobs} onToggle={() => toggle('cronJobs')} />
      <ChangesSection open={openSec.files} git={git} gitLoading={gitLoading} gitErr={null} convoFiles={convoFiles} openingPath={openingPath} actionErr={actionErr} showAllFiles={showAllFiles} branch={branch} gitHelp={gitHelp} onToggle={() => toggle('files')} onRefreshGit={refreshGit} onOpenGitFile={openGitFile} onSetShowAllFiles={setShowAllFiles} onOpenPanel={onOpenPanel} onOpenDiffSource={(f) => setActiveDiffSource(f)} />
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
export type { Props as OverviewCardProps };
