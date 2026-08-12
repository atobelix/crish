import React from 'react';
import styles from './OverviewCard.module.css';
import { Button, Tooltip } from '../ui';
import { Target } from 'lucide-react';
import {
  computeChecklistProgress,
  findCurrentLiveTool,
  resolveSessionProgressItems,
} from '../../api/sessionProgressApi';
import { agentOneLineLabel } from './helpers';
import type { SessionState } from '../../store/types';

interface ProgressSectionProps {
  session?: SessionState | null;
  onGoalClick?: (() => void) | undefined;
}

export const ProgressSection = React.memo(function ProgressSection({
  session,
  onGoalClick,
}: ProgressSectionProps) {
  const progressItems = React.useMemo(
    () => resolveSessionProgressItems(session),
    [session]
  );
  const progress = React.useMemo(
    () => computeChecklistProgress(progressItems),
    [progressItems]
  );
  const goalMode = session?.goalMode?.active ? session.goalMode : null;
  const liveTool = React.useMemo(() => findCurrentLiveTool(session), [session]);
  const liveToolLabel = liveTool ? liveTool.label : '';
  const liveToolStatus = liveTool ? liveTool.statusLabel : '';

  return (
    <>
      {goalMode || progress.total > 0 ? (
        <Tooltip content={goalMode?.goal || '活动任务与进度'}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.liveRow} ${styles['liveRow--goal']}`}
            aria-label={
              goalMode
                ? `目标：${agentOneLineLabel(goalMode.goal, '目标')}`
                : `清单 ${progress.done}/${progress.total}`
            }
            onClick={onGoalClick}
          >
            <Target
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
          </Button>
        </Tooltip>
      ) : null}
      {liveTool ? (
        <div
          className={styles.liveRow}
          aria-live="polite"
          aria-label={`${liveToolLabel}${liveToolStatus ? `，${liveToolStatus}` : ''}`}
        >
          <span className={`${styles.dot} ${styles.live}`} aria-hidden="true" />
          <span className={styles.itemName}>{liveToolLabel}</span>
          <em>{liveToolStatus}</em>
        </div>
      ) : null}
    </>
  );
});
