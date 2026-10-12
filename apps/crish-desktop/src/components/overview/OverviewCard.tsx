import React, { useMemo, useState } from 'react';
import styles from './OverviewCard.module.css';
import {
  selectSessions,
  useSessionField,
  useSessionStore,
} from '../../store/storeAccess';
import {
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';
import {
  useSettingsField,
  selectScheduledTasks,
  selectTokenUsage,
} from '../../store/storeAccess';
import {
  getActiveModelId,
  resolveDisplayModelId,
} from '../../api/providerProfiles';
import { useEngineState } from '../../hooks/useEngineState';
import { listProjects, getWorkspacePath } from '../../api/projectStore';
import { filterWorkflowsByWorkspace } from '../../api/workflowApi';

import { OverviewHeader } from './OverviewHeader';
import { OverviewStats } from './OverviewStats';
import { ActiveTasksSection } from './ActiveTasksSection';
import { AgentSection } from './AgentSection';
import { BackgroundSection } from './BackgroundSection';
import { ScheduleSection } from './ScheduleSection';
import { ChangesSection } from './changes';
import { useOverviewState } from './useOverviewState';

export type OverviewCardProps = {
  wsId?: string;
  onOpenPanel: (id: string) => void;
  /** @deprecated 保留 prop 兼容。@removeWhen 调用方全部迁移后移除 */
  sessionId?: string | null;
  leafId?: string | null;
};

type SecKey =
  'agents' | 'files' | 'usage' | 'activeTasks' | 'bgTasks' | 'cronJobs';

const OverviewCardInner: React.FC<OverviewCardProps> = ({
  onOpenPanel,
  sessionId: sessionIdProp,
  leafId: leafIdProp,
}) => {
  const scope = useLeafScope();
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const _effectiveLeafId = leafIdProp ?? scope.leafId;
  const session = useSessionStore((s) =>
    scopedSessionId ? s.sessionsById[scopedSessionId] || null : null
  );
  const _cronJobs = useSettingsField(selectScheduledTasks);
  const tokenUsage = useSettingsField(selectTokenUsage);
  const sessions = useSessionField(selectSessions);
  const ds = useEngineState();

  const [openSec, setOpenSec] = useState<Record<SecKey, boolean>>({
    agents: true,
    files: true,
    usage: false,
    activeTasks: false,
    bgTasks: false,
    cronJobs: false,
  });

  const {
    git,
    gitLoading,
    openingPath,
    actionErr,
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
  } = useOverviewState(sessions, ds.activeRuns, onOpenPanel);

  const toggle = (k: SecKey) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  const modelId = resolveDisplayModelId() || getActiveModelId() || 'unknown';
  // plans/05 T5.4：费用只渲染引擎三态，禁止 JS 估算
  const estimated =
    tokenUsage.costStatus === 'priced'
      ? (tokenUsage.formattedCost ?? '')
      : tokenUsage.costStatus === 'free'
        ? '免费'
        : '未定价';
  void modelId;
  const agents = session?.agents || [];
  const runningAgentCount = agents.filter((a) => a.status === 'running').length;

  const branch = git?.found && git.branch ? git.branch : '';

  const currentWorkspacePath = useMemo(() => {
    const projects = listProjects();
    const folder = session?.folder;
    if (folder) {
      const match = projects.find(
        (p) => p.id === folder || p.name === folder || p.path === folder
      );
      if (match) return match.path;
    }
    return getWorkspacePath() || (projects[0]?.path ?? '');
  }, [session?.folder]);

  const workspaceWorkflows = useMemo(
    () => filterWorkflowsByWorkspace(ds.workflows, currentWorkspacePath),
    [ds.workflows, currentWorkspacePath]
  );

  return (
    <div
      className={`${styles.card} ${styles.lean} chat-side-panel side-panel-body`}
      role="region"
      aria-label="总览"
    >
      <OverviewHeader
        session={session || undefined}
        onGoalClick={() => setOpenSec((p) => ({ ...p, activeTasks: true }))}
      />

      <OverviewStats
        open={openSec.usage}
        estimated={estimated}
        inputTokens={tokenUsage.input}
        outputTokens={tokenUsage.output}
        onToggle={() => toggle('usage')}
      />

      <ActiveTasksSection
        open={openSec.activeTasks}
        liveTasks={liveTasks}
        pendingApprovals={ds.pendingApprovals}
        approvalBusyId={approvalBusyId}
        onToggle={() => toggle('activeTasks')}
        onApprovalClick={handleApprovalClick}
        onApprovalAllow={handleApprovalAllow}
        onApprovalDeny={handleApprovalDeny}
        onLiveTaskClick={(wk) => {
          if (wk.sessionId) focusSession(wk.sessionId);
        }}
      />

      <AgentSection
        open={openSec.agents}
        agents={session?.agents || []}
        runningAgentCount={runningAgentCount}
        activeSessionId={scopedSessionId || undefined}
        onToggle={() => toggle('agents')}
      />

      <BackgroundSection
        open={openSec.bgTasks}
        bgTasks={ds.bgTasks}
        bgOpeningId={bgOpeningId}
        onToggle={() => toggle('bgTasks')}
        onOpenTask={openBgTask}
      />

      <ScheduleSection
        open={openSec.cronJobs}
        workflows={workspaceWorkflows}
        cronJobs={[]}
        onToggle={() => toggle('cronJobs')}
      />

      <ChangesSection
        open={openSec.files}
        git={git}
        gitLoading={gitLoading}
        branch={branch}
        openingPath={openingPath}
        actionErr={actionErr}
        gitHelp={gitHelp}
        onToggle={() => toggle('files')}
        onRefreshGit={refreshGit}
        onOpenGitFile={openGitFile}
        onOpenPanel={onOpenPanel}
      />
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
export type { OverviewCardProps as Props };
