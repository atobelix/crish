import React, { useEffect, useRef, useState } from 'react';
import { useLeafScope } from '../../contexts/LeafScopeContext';

import type { SessionGoalTask } from '../../store/types';
import styles from './ChatStatusRibbons.module.css';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export interface DynamicChipBarProps {
  /** 空态时 100% 物理不挂载（核心门闩 1）。 */
  shouldRender: boolean;
  activeBgTaskCount: number;
  onOpenTerminal?: () => void;
  hasActivePlan: boolean;
  planDrawerOpen: boolean;
  onTogglePlanDrawer: () => void;
  goalModeActive: boolean;
  goalIteration: number;
  checklistDone: number;
  checklistTotal: number;
  diffCount: number;
  onOpenDiff?: () => void;
}

/**
 * 动态快捷状态浮条：后台任务 / 计划进度 / 文件变更三个 chip。
 * 从 ChatStatusRibbons 抽出以收敛行数；空态由 shouldRender 拦截。
 */
export const DynamicChipBar: React.FC<DynamicChipBarProps> = ({
  shouldRender,
  activeBgTaskCount,
  onOpenTerminal,
  hasActivePlan,
  planDrawerOpen,
  onTogglePlanDrawer,
  goalModeActive,
  goalIteration,
  checklistDone,
  checklistTotal,
  diffCount: _diffCount,
  onOpenDiff: _onOpenDiff,
}) => {
  if (!shouldRender) return null;
  return (
    <div className={styles.dynamicChipBar} role="region" aria-label="快捷状态">
      {activeBgTaskCount > 0 && onOpenTerminal ? (
        <Tooltip content={`点击在终端查看 ${activeBgTaskCount} 个后台运行任务`}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.dynamicChip} ${styles.dynamicChipActive}`}
            aria-label={`后台运行中，${activeBgTaskCount} 个任务`}
            onClick={onOpenTerminal}
          >
            <span className={styles.dynamicChipPulseDot} aria-hidden />
            <span>后台任务 ({activeBgTaskCount})</span>
          </Button>
        </Tooltip>
      ) : null}

      {hasActivePlan ? (
        <Tooltip content="点击查看计划与进度详情">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.dynamicChip}${planDrawerOpen ? ` ${styles.dynamicChipActive}` : ''}`}
            aria-label="查看计划与进度详情"
            onClick={onTogglePlanDrawer}
          >
            <AppIcon name="target" size={13} aria-hidden />
            <span>
              {goalModeActive
                ? `目标模式 · 第 ${goalIteration + 1} 轮`
                : `计划任务 · ${checklistDone}/${checklistTotal}`}
            </span>
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
};

export interface PlanDrawerProps {
  /** 空态时不挂载（核心门闩 2）。 */
  shouldRender: boolean;
  goalModeActive: boolean;
  goalText: string;
  progressItems: SessionGoalTask[];
  onClose: () => void;
  /** focus trap 接力：把抽屉根节点注册到父级 ref（沿用旧聚焦逻辑）。 */
  drawerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 计划详情抽屉：目标文案 / 清单进度；受 shouldRender 与抽屉开关双重拦截。
 * 从 ChatStatusRibbons 抽出以收敛行数；focus trap 由 onMountFocus 接力。
 */
export const PlanDrawer: React.FC<PlanDrawerProps> = ({
  shouldRender,
  goalModeActive,
  goalText,
  progressItems,
  onClose,
  drawerRef,
}) => {
  if (!shouldRender || progressItems.length === 0) return null;
  return (
    <div
      ref={drawerRef}
      className={styles.dynamicPlanDrawer}
      role="dialog"
      aria-label="计划与进度详情"
    >
      <div className={styles.dynamicPlanHeader}>
        <span>{goalModeActive ? goalText || '目标推进中' : '计划清单'}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
          }}
          aria-label="关闭计划详情"
          onClick={onClose}
          icon={<AppIcon name="x" size={14} />}
        />
      </div>
      <ul className={styles.dynamicPlanList}>
        {progressItems.map((item) => (
          <li
            key={item.id}
            className={`${styles.dynamicPlanItem}${item.done ? ` ${styles.isDone}` : ''}`}
          >
            {item.done ? (
              <AppIcon
                name="check-circle"
                size={13}
                style={{ color: 'var(--accent-green)' }}
              />
            ) : (
              <AppIcon
                name="circle"
                size={13}
                style={{ color: 'var(--text-tertiary)' }}
              />
            )}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** 抽屉状态 hook：Escape 关闭 + 打开时聚焦首个可交互元素。 */
export function usePlanDrawerState() {
  const [showPlanDrawer, setShowPlanDrawer] = useState(false);
  const planDrawerRef = useRef<HTMLDivElement>(null);
  const scope = useLeafScope();

  useEffect(() => {
    if (!showPlanDrawer) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const drawer = planDrawerRef.current;
        if (!drawer) return;
        const active = document.activeElement;
        const isFocusedInside = Boolean(active && drawer.contains(active));
        if (!isFocusedInside) {
          if (scope.inLeafScope && !scope.isActive) return;
          if (
            active &&
            active !== document.body &&
            (active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              (active as HTMLElement).isContentEditable ||
              Boolean(
                (active as HTMLElement).closest?.(
                  'input, textarea, [contenteditable="true"]'
                )
              ))
          ) {
            return;
          }
          if (drawer.offsetWidth === 0 && drawer.offsetHeight === 0) {
            return;
          }
        }
        e.preventDefault();
        e.stopPropagation();
        setShowPlanDrawer(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showPlanDrawer, scope.inLeafScope, scope.isActive]);

  useEffect(() => {
    if (!showPlanDrawer) return;
    requestAnimationFrame(() => {
      const first = planDrawerRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
  }, [showPlanDrawer]);

  return {
    showPlanDrawer,
    togglePlanDrawer: () => setShowPlanDrawer((v) => !v),
    closePlanDrawer: () => setShowPlanDrawer(false),
    planDrawerRef,
  };
}
