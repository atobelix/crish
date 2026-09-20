/**
 * PlanMilestoneSpine.tsx
 * 消息流中的步骤进度里程碑与纵向中轴脊线组件（§5.2 / §5.5 对齐规范）。
 *
 * 特性：
 * - 16px 呼吸圆点指示器：已完成态「✓」、进行中「②」翡翠脉冲高亮、待开始纯文本数字；
 * - 居中 0.75px 纵向中轴脊线（left: 7.625px，精准对齐 16px 圆点中心 8 - 0.75/2）；
 * - 支持可嵌套的子步骤缩进排版（substeps）；
 * - 折叠/展开平滑动画与旋转 Chevron；
 * - 纯净有机流排布，绝无沉重外框与卡片包袱。
 */
import React, { useState } from 'react';
import { Button } from '../ui';
import styles from './FlowPlanMilestone.module.css';

export interface PlanSubstepItem {
  id: string;
  title: string;
  status?: 'completed' | 'running' | 'pending';
}

export interface PlanStepItem {
  id: string;
  title: string;
  status: 'completed' | 'running' | 'pending';
  substeps?: PlanSubstepItem[];
  children?: React.ReactNode;
  defaultExpanded?: boolean;
}

export interface PlanMilestoneSpineProps {
  steps: PlanStepItem[];
  currentStepIndex?: number;
  onStepClick?: (step: PlanStepItem, index: number) => void;
  className?: string;
}

/** 格式化步骤圆点指示器 */
export function renderStepIndicator(
  status: PlanStepItem['status'],
  stepIndex: number
): React.ReactNode {
  if (status === 'completed') {
    return '✓';
  }
  if (status === 'running') {
    const circledNumbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    return circledNumbers[stepIndex] || String(stepIndex + 1);
  }
  return String(stepIndex + 1);
}

export const PlanMilestoneSpine: React.FC<PlanMilestoneSpineProps> = ({
  steps,
  onStepClick,
  className,
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of steps) {
      init[s.id] =
        s.defaultExpanded ??
        (s.status === 'running' || s.status === 'completed');
    }
    return init;
  });

  const toggleStep = (id: string) => {
    setExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!steps.length) return null;

  return (
    <div
      className={`${styles.flowPlanRoot} ${className || ''} flow-plan-root`}
      data-flow-plan-milestones="true"
    >
      {steps.map((step, idx) => {
        const isRunning = step.status === 'running';
        const isDone = step.status === 'completed';
        const isCollapsed = !expandedMap[step.id];
        const hasBody = Boolean(
          (step.substeps && step.substeps.length > 0) || step.children
        );

        return (
          <div
            key={step.id}
            className={`${styles.flowPlanStep} ${isDone ? `${styles.isDone} is-done` : ''} ${isRunning ? `${styles.isRunning} is-running` : ''} ${isCollapsed ? `${styles.isCollapsed} is-collapsed` : ''} flow-plan-step`}
            data-step-id={step.id}
            data-step-status={step.status}
          >
            <Button
              type="button"
              variant="ghost"
              className={`${styles.flowPlanStepHead} flow-plan-step__head`}
              onClick={() => {
                toggleStep(step.id);
                onStepClick?.(step, idx);
              }}
              aria-expanded={!isCollapsed}
            >
              <span
                className={`${styles.flowPlanStepNum} flow-plan-step__num`}
                aria-hidden
              >
                {renderStepIndicator(step.status, idx)}
              </span>

              <span
                className={`${styles.flowPlanStepTitle} flow-plan-step__title`}
              >
                {step.title}
              </span>

              {hasBody && (
                <span
                  className={`${styles.flowPlanStepChevron} flow-plan-step__chevron`}
                  aria-hidden
                >
                  ›
                </span>
              )}
            </Button>

            {hasBody && !isCollapsed && (
              <div
                className={`${styles.flowPlanStepBody} flow-plan-step__body`}
                data-flow-plan-step-body="true"
              >
                {step.substeps?.map((sub) => (
                  <div
                    key={sub.id}
                    className={`${styles.flowPlanSubstep} flow-plan-substep`}
                    data-substep-id={sub.id}
                  >
                    <span className={styles.flowPlanSubstepDot} aria-hidden />
                    <span>{sub.title}</span>
                  </div>
                ))}
                {step.children}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
