/**
 * apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx
 *
 * 差异面板紧凑工具栏 (v2.0 现代化 SegmentedControl 与 28px 几何对齐版)
 */
import React, { useMemo } from 'react';
import {
  IconButton,
  Select,
  SegmentedControl,
  type SegmentedControlOption,
} from '@/components/ui';
import styles from './DiffCard.module.css';
import type { FileDiff } from '../../store/types';
import { AppIcon } from '@/components/ui/icons';

export interface DiffHeaderControlsProps {
  sourceMode: 'list' | 'session' | 'git';
  diffViewMode: 'unified' | 'split';
  searchOpen: boolean;
  searchActive: boolean;
  gitLoading: boolean;
  applyBusy: boolean;
  busy: boolean;
  turnKey: string;
  turnOptions: { value: string; label: string; hint?: string }[];
  branches: string[];
  currentBranch: string;
  commitPanelOpen: boolean;
  fileListLength: number;
  current: FileDiff | null;
  hasAiTurns?: boolean;
  onViewModeChange: () => void;
  onSearchOpenChange: (open: boolean) => void;
  onSourceModeChange: (mode: 'session' | 'git') => void;
  onTurnSelect: (key: string) => void;
  onBranchChange: (branch: string) => void;
  onCommitPanelToggle: () => void;
  onCopyPatch?: () => void;
  onClear: () => void;
}

export const DiffHeaderControls: React.FC<DiffHeaderControlsProps> = React.memo(
  function DiffHeaderControls({
    sourceMode,
    diffViewMode,
    searchOpen,
    searchActive,
    gitLoading,
    applyBusy,
    busy,
    turnKey,
    turnOptions,
    branches,
    currentBranch,
    commitPanelOpen,
    fileListLength,
    current,
    onViewModeChange,
    onSearchOpenChange,
    onSourceModeChange,
    onTurnSelect,
    onBranchChange,
    onCommitPanelToggle,
    onCopyPatch,
    onClear,
  }) {
    const sourceOptions = useMemo<SegmentedControlOption<'session' | 'git'>[]>(
      () => [
        {
          value: 'session',
          label: 'AI',
          icon: (
            <AppIcon
              name="sparkles"
              size={12}
              className={styles.tabIcon}
              aria-hidden
            />
          ),
          'aria-label': '当前对话中 AI 产生的改动',
          disabled: applyBusy,
        },
        {
          value: 'git',
          label: gitLoading ? 'Git…' : 'Git',
          icon: (
            <AppIcon
              name="git-branch"
              size={12}
              className={styles.tabIcon}
              aria-hidden
            />
          ),
          'aria-label': '工作区 Git 未提交变更',
          disabled: gitLoading || applyBusy,
        },
      ],
      [applyBusy, gitLoading]
    );

    const activeSegmentValue = sourceMode === 'git' ? 'git' : 'session';

    return (
      <div
        className={`${styles.compactHeader} side-panel-toolbar`}
        role="toolbar"
        aria-label="紧凑变更工具栏"
      >
        {/* 左侧：标准原子 SegmentedControl (AI 改动 / Git) */}
        <div className={styles.leftGroup}>
          <SegmentedControl
            size="sm"
            value={activeSegmentValue}
            options={sourceOptions}
            onChange={(val) => onSourceModeChange(val as 'session' | 'git')}
            aria-label="变更来源"
            className={styles.sourceSegmentControl}
          />

          <div className={styles.headerDivider} aria-hidden />

          {/* 中部：回合或分支下拉选择器 */}
          <div className={styles.contextSelector}>
            {sourceMode === 'session' ? (
              <Select
                size="sm"
                className={styles.inlineSelect}
                disabled={busy}
                value={turnKey}
                options={turnOptions.map((o) => ({
                  id: o.value,
                  label: o.label,
                  ...(o.hint !== undefined ? { hint: o.hint } : {}),
                }))}
                onChange={onTurnSelect}
                aria-label="选择对话回合"
              />
            ) : sourceMode === 'git' ? (
              <Select
                size="sm"
                className={styles.inlineSelect}
                disabled={busy}
                value={currentBranch}
                options={branches.map((b) => ({ id: b, label: b }))}
                onChange={(val) => onBranchChange(val)}
                aria-label="选择 Git 分支"
              />
            ) : null}
          </div>
        </div>

        {/* 右侧：视图与操作按钮组 (换装标准原子组件 IconButton size="sm" variant="ghost"，拔除私有 .actionBtn 覆盖) */}
        <div className={styles.rightActions}>
          <IconButton
            size="sm"
            variant="ghost"
            aria-label={
              diffViewMode === 'unified' ? '切换至分栏视图' : '切换至合并视图'
            }
            tooltip={
              diffViewMode === 'unified'
                ? '切换至分栏视图 (Split View)'
                : '切换至合并视图 (Unified View)'
            }
            onClick={onViewModeChange}
            icon={
              diffViewMode === 'unified' ? (
                <AppIcon name="columns" size={14} aria-hidden />
              ) : (
                <AppIcon name="list" size={14} aria-hidden />
              )
            }
          />

          {onCopyPatch && current && (
            <IconButton
              size="sm"
              variant="ghost"
              aria-label="复制 Patch"
              tooltip="复制当前文件为标准 Git Patch"
              onClick={onCopyPatch}
              icon={<AppIcon name="copy" size={14} aria-hidden />}
            />
          )}

          {sourceMode === 'git' && fileListLength > 0 && (
            <IconButton
              size="sm"
              variant="ghost"
              active={commitPanelOpen}
              aria-label="切换提交面板"
              tooltip={commitPanelOpen ? '隐藏提交面板' : '显示提交面板'}
              onClick={onCommitPanelToggle}
              icon={<AppIcon name="git-commit" size={14} aria-hidden />}
            />
          )}

          <IconButton
            size="sm"
            variant="ghost"
            active={searchOpen || searchActive}
            aria-label="搜索差异行"
            aria-pressed={searchOpen || searchActive}
            tooltip="搜索差异行"
            onClick={() => onSearchOpenChange(!searchOpen)}
            icon={<AppIcon name="search" size={14} aria-hidden />}
          />

          {fileListLength > 0 && (
            <IconButton
              size="sm"
              variant="ghost"
              className={styles.dangerBtn}
              aria-label="清空变更列表"
              tooltip="清空当前审查列表"
              disabled={applyBusy}
              onClick={onClear}
              icon={<AppIcon name="trash" size={14} aria-hidden />}
            />
          )}
        </div>
      </div>
    );
  }
);

DiffHeaderControls.displayName = 'DiffHeaderControls';
