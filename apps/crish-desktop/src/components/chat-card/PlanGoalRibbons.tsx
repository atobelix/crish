/**
 * 计划模式 / 目标模式双 ribbon 条：slim 视觉 + polite 播报。
 * 纯渲染：文案 / aria / 进度百分比由 chatStatusRibbonsLib 计算。
 * 含计划批准动作（已批准后隐藏）与目标停止动作。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './PlanGoalRibbons.module.css';
import { Tooltip } from '../ui';
import {
  formatGoalRibbonLabel,
  formatPlanModeRibbonLabel,
  goalRibbonProgressPercent,
  resolveGoalRibbonAriaLabel,
  resolvePlanModeAriaLabel,
  resolvePlanModeTitle,
  shouldShowPlanApproveAction,
} from './chatStatusRibbonsLib';

/** 计划模式条渲染状态。 */
export type PlanRibbonState = {
  inPlanMode: boolean;
  planApproved: boolean;
  onApprovePlan: () => void;
};

/** 目标模式条渲染状态（分数与 TasksCard 同源）。 */
export type GoalRibbonState = {
  goalModeActive: boolean;
  goalText: string;
  goalIteration: number;
  goalTasksDone: number;
  goalTasksTotal: number;
  onStopGoal: () => void;
};

export type PlanGoalRibbonsProps = {
  plan: PlanRibbonState;
  goal: GoalRibbonState;
};

export const PlanGoalRibbons: React.FC<PlanGoalRibbonsProps> = ({
  plan,
  goal,
}) => {
  const showPlanApprove = shouldShowPlanApproveAction(plan.planApproved);
  const goalProgressPct = goalRibbonProgressPercent(
    goal.goalTasksDone,
    goal.goalTasksTotal,
  );

  return (
    <>
      {plan.inPlanMode ? (
        <div
          className={`${styles.planModeRibbon} ${styles.slim}`}
          role="status"
          aria-live="polite"
          aria-label={resolvePlanModeAriaLabel(plan.planApproved)}
        >
          <Lucide.ListChecks size={14} strokeWidth={1.75} aria-hidden />
          <Tooltip content={resolvePlanModeTitle(plan.planApproved)}>
            <span className={styles.planModeRibbonText}>
              {formatPlanModeRibbonLabel(plan.planApproved)}
            </span>
          </Tooltip>
          {showPlanApprove ? (
            <Tooltip content="批准执行">
              <button
                type="button"
                className={styles.planModeRibbonIconBtn}
                aria-label="批准计划执行"
                onClick={plan.onApprovePlan}
              >
                <Lucide.Check size={14} strokeWidth={2} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {goal.goalModeActive ? (
        <div
          className={`${styles.planModeRibbon} ${styles.goalModeRibbon} ${styles.slim}`}
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
          <Lucide.Target size={14} strokeWidth={1.75} aria-hidden />
          <Tooltip content={(goal.goalText || '').trim() || '目标模式'}>
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
          <Tooltip content="停止目标">
            <button
              type="button"
              className={`${styles.planModeRibbonIconBtn} ${styles.isDanger}`}
              aria-label="停止目标"
              onClick={goal.onStopGoal}
            >
              <Lucide.Square size={12} fill="currentColor" aria-hidden />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </>
  );
};
