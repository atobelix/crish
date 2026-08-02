import React, { useEffect, useMemo, useState } from 'react';
import styles from './OverviewCard.module.css';
import { useLayoutStore } from '../../store/layoutStore';
import {
  selectActiveSession,
  selectActiveSessionId,
  useSessionField,
} from '../../store/sessionStore';
import { getWorkspacePath } from '../../api/projectStore';
import { setActiveDiffSource } from '../../api/storeAccess';
import { estimateCostUsd } from '../../api/pricingStore';
import {
  getActiveModelId,
  resolveDisplayModelId,
} from '../../api/providerProfiles';
import { useEngineState } from '../../hooks/useEngineState';

import { OverviewHeader } from './OverviewHeader';
import { OverviewStats } from './OverviewStats';
import { OverviewQuickActions } from './OverviewQuickActions';
import { ActiveTasksSection } from './ActiveTasksSection';
import { AgentSection } from './AgentSection';
import { BackgroundSection } from './BackgroundSection';
import { ScheduleSection } from './ScheduleSection';
import { ChangesSection } from './ChangesSection';
import { useOverviewState } from './useOverviewState';

export type OverviewCardProps = {
  wsId: string;
  onOpenPanel: (id: string) => void;
  /** @deprecated 保留 prop 兼容 */
  onShowToast?: (msg: string) => void;
};

type SecKey = 'agents' | 'files' | 'usage' | 'activeTasks' | 'bgTasks' | 'cronJobs';

const OverviewCardInner: React.FC<OverviewCardProps> = ({ wsId, onOpenPanel }) => {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const session = useSessionField(selectActiveSession);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const cronJobs = useLayoutStore((state) => state.scheduledTasks);
  const tokenUsage = useLayoutStore((state) => state.tokenUsage);
  const sessions = useLayoutStore((state) => state.sessions);
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
  } = useOverviewState(sessions, ds.activeRuns, onOpenPanel);

  useEffect(() => {
    setShowAllFiles(false);
  }, [openSec.files, setShowAllFiles]);

  const toggle = (k: SecKey) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  const modelId = resolveDisplayModelId() || getActiveModelId() || 'unknown';
  const estimated =
    tokenUsage.cost > 0
      ? tokenUsage.cost
      : estimateCostUsd(modelId, tokenUsage.input, tokenUsage.output);
  const agents = session?.agents || [];
  const runningAgentCount = agents.filter((a) => a.status === 'running').length;
  const convoFiles = useMemo(
    () => (diffFiles?.length ? diffFiles : activeDiffSource ? [activeDiffSource] : []),
    [diffFiles, activeDiffSource]
  );

  const wsPath = getWorkspacePath();
  const branch = git?.found && git.branch ? git.branch : '';

  return (
    <div
      className={`${styles.card} ${styles.lean}`}
      role="region"
      aria-label="总览"
    >
      <OverviewHeader
        wsPath={wsPath}
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
        workflows={ds.workflows}
        cronJobs={cronJobs}
        onToggle={() => toggle('cronJobs')}
      />

      <ChangesSection
        open={openSec.files}
        git={git}
        gitLoading={gitLoading}
        gitErr={null}
        convoFiles={convoFiles}
        openingPath={openingPath}
        actionErr={actionErr}
        showAllFiles={showAllFiles}
        branch={branch}
        gitHelp={gitHelp}
        onToggle={() => toggle('files')}
        onRefreshGit={refreshGit}
        onOpenGitFile={openGitFile}
        onSetShowAllFiles={setShowAllFiles}
        onOpenPanel={onOpenPanel}
        onOpenDiffSource={(f) => setActiveDiffSource(f)}
      />

      <OverviewQuickActions onOpenPanel={onOpenPanel} />
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
export type { OverviewCardProps as Props };
