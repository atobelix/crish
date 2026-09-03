import React, { useEffect, useMemo, useState } from 'react';
import styles from './OverviewCard.module.css';
import {
  selectActiveSession,
  selectActiveSessionId,
  selectSessions,
  useSessionField,
} from '../../store/storeAccess';
import {
  useSettingsField,
  selectScheduledTasks,
  selectTokenUsage,
} from '../../store/storeAccess';
import { estimateCostUsd } from '../../api/pricingStore';
import {
  getActiveModelId,
  resolveDisplayModelId,
} from '../../api/providerProfiles';
import { useEngineState } from '../../hooks/useEngineState';
import { listProjects, getWorkspacePath } from '../../api/projectStore';
import { filterWorkflowsByWorkspace } from '../../api/workflowApi';

import { OverviewHeader } from './OverviewHeader';
import { OverviewStats } from './OverviewStats';
import { OverviewQuickActions } from './OverviewQuickActions';
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
};

type SecKey =
  'agents' | 'files' | 'usage' | 'activeTasks' | 'bgTasks' | 'cronJobs';

const OverviewCardInner: React.FC<OverviewCardProps> = ({ onOpenPanel }) => {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const cronJobs = useSettingsField(selectScheduledTasks);
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
  const estimated =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);
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
        session={session}
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
        activeSessionId={activeSessionId || undefined}
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

      <OverviewQuickActions onOpenPanel={onOpenPanel} />
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
export type { OverviewCardProps as Props };
