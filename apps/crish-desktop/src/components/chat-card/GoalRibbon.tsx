/**
 * 目标模式 ribbon：slim 视觉 + polite 播报。
 * 纯渲染：文案 / aria / 进度百分比由 chatStatusRibbonsLib 计算。
 * 计划模式已随权限三态（ask / smart / full）收敛移除，本组件只承载目标模式。
 */
import React from 'react';

import styles from './GoalRibbon.module.css';
import { Button, Tooltip } from '@/components/ui';
import {
  formatGoalRibbonLabel,
  goalRibbonProgressPercent,
  resolveGoalRibbonAriaLabel,
} from './chatStatusRibbonsLib';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

/** 目标模式条渲染状态（分数与 TasksCard 同源）。 */
export type GoalRibbonState = {
  goalModeActive: boolean;
  goalText: string;
  goalIteration: number;
  goalTasksDone: number;
  goalTasksTotal: number;
  onStopGoal: () => void;
};

export type GoalRibbonProps = {
  goal: GoalRibbonState;
  /** 叠在输入卡上沿：缩进 + 负边距嵌入卡片 */
  docked?: boolean;
};

export const GoalRibbon: React.FC<GoalRibbonProps> = ({
  goal,
  docked = false,
}) => {
  const { t } = useI18n();
  const goalProgressPct = goalRibbonProgressPercent(
    goal.goalTasksDone,
    goal.goalTasksTotal
  );

  if (!goal.goalModeActive) return null;

  return (
    <div
      className={`${styles.planModeRibbon} ${styles.goalModeRibbon} ${styles.slim}${docked ? ` ${styles.docked}` : ''}`}
      role="status"
      aria-live="polite"
      aria-label={resolveGoalRibbonAriaLabel({
        goalText: goal.goalText,
        goalIteration: goal.goalIteration,
        goalTasksDone: goal.goalTasksDone,
        goalTasksTotal: goal.goalTasksTotal,
      })}
      data-goal-iteration={goal.goalIteration}
      data-goal-tasks-done={goal.goalTasksDone}
      data-goal-tasks-total={goal.goalTasksTotal}
    >
      <AppIcon name="target" size={14} aria-hidden />
      <Tooltip
        content={(goal.goalText || '').trim() || t('chat.goal.modeLabel')}
      >
        <span className={styles.planModeRibbonText}>
          {formatGoalRibbonLabel({
            goalText: goal.goalText,
            goalIteration: goal.goalIteration,
            goalTasksDone: goal.goalTasksDone,
            goalTasksTotal: goal.goalTasksTotal,
          })}
        </span>
      </Tooltip>
      {goalProgressPct != null ? (
        <Tooltip content={`${goal.goalTasksDone}/${goal.goalTasksTotal}`}>
          <span className={styles.goalModeRibbonMeter} aria-hidden>
            <span
              className={styles.goalModeRibbonMeterFill}
              style={{ width: `${goalProgressPct}%` }}
            />
          </span>
        </Tooltip>
      ) : null}
      <Tooltip content={t('chat.goal.stop')}>
        <Button
          type="button"
          variant="danger"
          size="sm"
          className={`${styles.planModeRibbonIconBtn} ${styles.isDanger}`}
          aria-label={t('chat.goal.stop')}
          onClick={goal.onStopGoal}
          icon={
            <AppIcon name="square" size={12} fill="currentColor" aria-hidden />
          }
        />
      </Tooltip>
    </div>
  );
};
