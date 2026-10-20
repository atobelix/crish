/**
 * Layer 2: 目标/计划模式进度条（Plan Progress Bar & Scrubber Hub）
 * 对齐 reference/chat-composer-component/css/flow/plan.css 与真实会话任务链路
 * - 计划模式文字 + 任务滚动条 + 动态耗时 (00:00 起递增，杜绝假数据) + 快捷操作；
 * - 向上展开抽屉：真实任务步骤列表（完成态黑点、正在执行绿点、等待态空圈）。
 */
import React, { useState, useEffect } from 'react';
import styles from './ChatComposer.module.css';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export interface PlanStepItem {
  id?: string;
  text: string;
  status: 'completed' | 'active' | 'pending';
}

export interface ComposerPlanProgressBarProps {
  active?: boolean;
  mode?: 'plan' | 'goal';
  modeLabel?: string;
  /** 兼容既有调用方/用例保留：进度条按 steps 渲染，本组件不再单独消费序号。 */
  currentStep?: number;
  /** 同 currentStep：总数由 steps.length 决定，保留入参以便调用方逐步收敛。 */
  totalSteps?: number;
  steps?: PlanStepItem[];
  activeStepText?: string;
  durationText?: string;
  isRunning?: boolean;
  onToggleExpand?: () => void;
  isExpanded?: boolean;
  onStepClick?: (index: number) => void;
  onEditGoal?: () => void;
  onTogglePause?: () => void;
  isPaused?: boolean;
  onStop?: () => void;
  /**
   * 未消费：计划审批入口由 ApprovalDock 承担（见 ChatComposerWrapper 的 liftApproval 分支）。
   * 保留入参仅为不打断既有调用方接线；是否下线需 UI 侧裁决。
   */
  onApprovePlan?: () => void;
  className?: string;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const ComposerPlanProgressBar: React.FC<
  ComposerPlanProgressBarProps
> = ({
  active = true,
  mode = 'plan',
  modeLabel = '计划模式',
  steps = [],
  activeStepText,
  durationText,
  isRunning = false,
  onToggleExpand,
  isExpanded: controlledExpanded,
  onStepClick,
  onEditGoal,
  onTogglePause,
  isPaused = false,
  onStop,
  className = '',
}) => {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isExpanded = controlledExpanded ?? internalExpanded;

  useEffect(() => {
    if (!isRunning || isPaused) return;
    const timer = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, isPaused]);

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
    (mode === 'goal' ? '目标推进中…' : '计划推进中…');

  const displayDuration = durationText ?? formatDuration(elapsedSeconds);

  const containerClasses = [
    styles.planProgressBar,
    'plan-progress-bar',
    'active',
    isExpanded ? `${styles.isExpanded} expanded-steps` : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={containerClasses}
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
              </div>
            );
          })}
        </div>
      </div>

      {/* Single-Line Anchored Hub */}
      <div className={`${styles.planCollapsed} plan-collapsed`}>
        <Button
          type="button"
          variant="ghost"
          className={`${styles.planModeBadge} plan-mode-badge`}
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-label={`切换${modeLabel}详情展开`}
        >
          <AppIcon
            name="target"
            size={13}
            className={`${styles.modeIcon} mode-icon`}
            aria-hidden
          />
          <span className="mode-text">{modeLabel}</span>
        </Button>

        <div className={`${styles.planDividerV} plan-divider-v`} aria-hidden />

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
              <div className={`${styles.planStep} plan-step`}>
                {currentActiveText}
              </div>
            </div>
          </div>
        </div>

        <div className={`${styles.planSpacer} plan-spacer`} />

        <div className={`${styles.planRightControls} plan-right-controls`}>
          <span className={`${styles.planDuration} plan-duration`}>
            {displayDuration}
          </span>

          <div className={`${styles.planQuickActions} plan-quick-actions`}>
            {onEditGoal ? (
              <Tooltip content="编辑目标">
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.planActionBtn} plan-action-btn`}
                  onClick={onEditGoal}
                  aria-label="编辑目标"
                >
                  <AppIcon name="edit-alt" size={13} aria-hidden />
                </Button>
              </Tooltip>
            ) : null}

            {onTogglePause ? (
              <Tooltip content={isPaused ? '继续' : '暂停'}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.planActionBtn} plan-action-btn`}
                  onClick={onTogglePause}
                  aria-label={isPaused ? '继续' : '暂停'}
                >
                  {isPaused ? (
                    <AppIcon name="play" size={13} aria-hidden />
                  ) : (
                    <AppIcon name="pause" size={13} aria-hidden />
                  )}
                </Button>
              </Tooltip>
            ) : null}

            {onStop ? (
              <Tooltip content="终止">
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.planActionBtn} ${styles.stop} plan-action-btn stop`}
                  onClick={onStop}
                  aria-label="终止"
                >
                  <AppIcon name="square" size={13} aria-hidden />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
