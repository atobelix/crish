/**
 * Layer 2: 目标/计划模式进度条（Plan Progress Bar & Scrubber Hub）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.3 与 reference/chat-composer-component/css/flow/plan.css
 * - 目标徽标 [ 🎯 计划模式 ] + 进度计数器 2/5 + 任务滚动条 + 耗时 84:09 + 快捷操作 ⏸ ⏹ □；
 * - 向上展开抽屉步骤列表（完成、正在执行 1.4s 呼吸绿点、等待态）。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../ui';

export interface PlanStepItem {
  id?: string;
  text: string;
  status: 'completed' | 'active' | 'pending';
}

export interface ComposerPlanProgressBarProps {
  active?: boolean;
  mode?: 'plan' | 'goal';
  modeLabel?: string;
  currentStep?: number;
  totalSteps?: number;
  steps?: PlanStepItem[];
  activeStepText?: string;
  durationText?: string;
  onToggleExpand?: () => void;
  isExpanded?: boolean;
  onStepClick?: (index: number) => void;
  onEditGoal?: () => void;
  onTogglePause?: () => void;
  isPaused?: boolean;
  onStop?: () => void;
  onApprovePlan?: () => void;
  className?: string;
}

const DEFAULT_STEPS: PlanStepItem[] = [
  { id: '1', text: '摸清 crates/session-loop 的 IPC 通道瓶颈', status: 'completed' },
  { id: '2', text: '重构 crates/session-loop 批量缓冲与调度器', status: 'active' },
  { id: '3', text: '优化 apps/crish-desktop 虚拟流式渲染管线', status: 'pending' },
  { id: '4', text: '执行 cargo test --workspace 与端到端压测', status: 'pending' },
  { id: '5', text: '生成 Conex IPC 性能优化评审与变更摘要报告', status: 'pending' },
];

export const ComposerPlanProgressBar: React.FC<ComposerPlanProgressBarProps> = ({
  active = true,
  mode = 'plan',
  modeLabel = '计划模式',
  currentStep = 2,
  totalSteps = 5,
  steps = DEFAULT_STEPS,
  activeStepText,
  durationText = '84:09',
  onToggleExpand,
  isExpanded: controlledExpanded,
  onStepClick,
  onEditGoal,
  onTogglePause,
  isPaused = false,
  onStop,
  onApprovePlan,
  className = '',
}) => {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = controlledExpanded ?? internalExpanded;

  if (!active) return null;

  const handleToggle = () => {
    if (onToggleExpand) {
      onToggleExpand();
    } else {
      setInternalExpanded((prev) => !prev);
    }
  };

  const currentActiveText =
    activeStepText ||
    steps.find((s) => s.status === 'active')?.text ||
    steps[0]?.text ||
    '正在执行计划步骤…';

  return (
    <div
      className={`${styles.planProgressBar} plan-progress-bar active${isExpanded ? ` ${styles.isExpanded} expanded-steps` : ''}${className ? ` ${className}` : ''}`}
      data-mode={mode}
      data-testid="composer-plan-progress-bar"
      role="region"
      aria-label="目标与计划进度条"
    >
      {/* Upward Step Drawer List */}
      <div className={`${styles.planStepList} plan-step-list`}>
        <div className={`${styles.planStepListInner} plan-step-list-inner`}>
          {steps.map((step, idx) => {
            const isCompleted = step.status === 'completed';
            const isActive = step.status === 'active';
            const isPending = step.status === 'pending';

            return (
              <div
                key={step.id || idx}
                className={`${styles.planExpandedStep} plan-expanded-step ${isCompleted ? `${styles.completed} completed` : ''} ${isActive ? `${styles.active} active` : ''} ${isPending ? `${styles.pending} pending` : ''}`}
                onClick={() => onStepClick?.(idx)}
                role="button"
                tabIndex={0}
                aria-label={`步骤 ${idx + 1}: ${step.text}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onStepClick?.(idx);
                  }
                }}
              >
                <span className={`${styles.planStepDot} plan-step-dot`} />
                <span className={`${styles.stepText} step-text`}>
                  {idx + 1}. {step.text}
                </span>
                {isActive && onApprovePlan ? (
                  <button
                    type="button"
                    className={styles.planStepApproveBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      onApprovePlan();
                    }}
                  >
                    批准此步骤
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Single-Line Anchored Hub */}
      <div className={`${styles.planCollapsed} plan-collapsed`}>
        <Tooltip content="点击展开/收起计划详情">
          <button
            type="button"
            className={`${styles.planModeBadge} plan-mode-badge`}
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-label={`切换${modeLabel}详情展开`}
          >
            <Lucide.Target size={13} className={`${styles.modeIcon} mode-icon`} aria-hidden />
            <span className="mode-text">{modeLabel}</span>
          </button>
        </Tooltip>

        <div className={`${styles.planDividerV} plan-divider-v`} aria-hidden />

        <Tooltip content={`当前进度：第 ${currentStep} 步 / 共 ${totalSteps} 步`}>
          <span className={`${styles.planStepCounter} plan-step-counter`} title="当前进度">
            {currentStep}/{totalSteps}
          </span>
        </Tooltip>

        <div
          className={`${styles.planActiveTaskBox} plan-active-task-box`}
          onClick={handleToggle}
          role="button"
          tabIndex={0}
          aria-label={`当前活动任务：${currentActiveText}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggle();
            }
          }}
        >
          <div className={`${styles.planRoller} plan-roller`}>
            <div className={`${styles.planRollerTrack} plan-roller-track`}>
              <div className={`${styles.planStep} plan-step`}>{currentActiveText}</div>
            </div>
          </div>
        </div>

        <div className={`${styles.planSpacer} plan-spacer`} />

        <div className={`${styles.planRightControls} plan-right-controls`}>
          <Tooltip content="已执行耗时">
            <span className={`${styles.planDuration} plan-duration`}>{durationText}</span>
          </Tooltip>

          <div className={`${styles.planQuickActions} plan-quick-actions`}>
            {onEditGoal ? (
              <Tooltip content="编辑目标描述">
                <button
                  type="button"
                  className={`${styles.planActionBtn} plan-action-btn`}
                  onClick={onEditGoal}
                  aria-label="编辑目标描述"
                >
                  <Lucide.Edit3 size={13} strokeWidth={1.8} aria-hidden />
                </button>
              </Tooltip>
            ) : null}

            {onTogglePause ? (
              <Tooltip content={isPaused ? '继续任务' : '暂停任务'}>
                <button
                  type="button"
                  className={`${styles.planActionBtn} plan-action-btn`}
                  onClick={onTogglePause}
                  aria-label={isPaused ? '继续任务' : '暂停任务'}
                >
                  {isPaused ? (
                    <Lucide.Play size={13} strokeWidth={1.8} aria-hidden />
                  ) : (
                    <Lucide.Pause size={13} strokeWidth={1.8} aria-hidden />
                  )}
                </button>
              </Tooltip>
            ) : null}

            {onStop ? (
              <Tooltip content="终止任务">
                <button
                  type="button"
                  className={`${styles.planActionBtn} ${styles.stop} plan-action-btn stop`}
                  onClick={onStop}
                  aria-label="终止任务"
                >
                  <Lucide.Square size={13} strokeWidth={1.8} aria-hidden />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
