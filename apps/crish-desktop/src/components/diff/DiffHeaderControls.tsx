import React from 'react';
import { Columns2, GitBranch, GitCommit, List, Search, Trash2 } from 'lucide-react';
import { Select, Tooltip } from '../ui';
import styles from './DiffCard.module.css';
import type { FileDiff } from '../../store/types';

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
  hasAiTurns: boolean;
  onViewModeChange: () => void;
  onSearchOpenChange: (open: boolean) => void;
  onSourceModeChange: (mode: 'session' | 'git') => void;
  onTurnSelect: (key: string) => void;
  onBranchChange: (branch: string) => void;
  onCommitPanelToggle: () => void;
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
    onClear,
  }) {
    return (
      <div className={styles.toolbarContainer} role="toolbar" aria-label="变更工具栏">
        <div className={styles.toolbarRow1}>
          <div className={styles.sourceSeg} role="group" aria-label="变更来源">
            <Tooltip content="当前对话中 AI 产生的改动">
              <button
                type="button"
                className={`${styles.sourceBtn} ${sourceMode === 'session' ? styles.isOn : ''}`}
                aria-pressed={sourceMode === 'session'}
                disabled={applyBusy}
                onClick={() => onSourceModeChange('session')}
              >
                AI 改动
              </button>
            </Tooltip>
            <Tooltip content="工作区 Git 未提交变更">
              <button
                type="button"
                className={`${styles.sourceBtn} ${sourceMode === 'git' ? styles.isOn : ''}`}
                aria-pressed={sourceMode === 'git'}
                disabled={gitLoading || applyBusy}
                onClick={() => onSourceModeChange('git')}
              >
                {gitLoading ? 'Git…' : 'Git'}
              </button>
            </Tooltip>
          </div>

          <div className={styles.toolbarActions1}>
            <Tooltip content={diffViewMode === 'unified' ? '切换至分栏视图 (Split View)' : '切换至合并视图 (Unified View)'}>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={diffViewMode === 'unified' ? '切换至分栏视图' : '切换至合并视图'}
                onClick={onViewModeChange}
              >
                {diffViewMode === 'unified' ? (
                  <Columns2 size={14} aria-hidden />
                ) : (
                  <List size={14} aria-hidden />
                )}
              </button>
            </Tooltip>

            {sourceMode === 'git' && fileListLength > 0 && (
              <Tooltip content={commitPanelOpen ? '隐藏提交面板' : '显示提交面板'}>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${commitPanelOpen ? styles.isOn : ''}`}
                  aria-label="切换提交面板"
                  onClick={onCommitPanelToggle}
                >
                  <GitCommit size={14} aria-hidden />
                </button>
              </Tooltip>
            )}

            <Tooltip content="筛选行">
              <button
                type="button"
                className={`${styles.iconBtn} ${searchOpen || searchActive ? styles.isOn : ''}`}
                aria-label="筛选 diff 行"
                aria-pressed={searchOpen || searchActive}
                disabled={!current}
                onClick={() => onSearchOpenChange(!searchOpen)}
              >
                <Search size={14} aria-hidden />
              </button>
            </Tooltip>

            {fileListLength > 0 ? (
              <Tooltip content="清空列表">
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label="清空变更列表"
                  disabled={applyBusy}
                  onClick={onClear}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className={styles.toolbarRow2}>
          {sourceMode === 'session' ? (
            <Select
              className={styles.turnSettingsSelect}
              disabled={busy}
              value={turnKey}
              options={turnOptions.map((o) => ({
                id: o.value,
                label: o.label,
                ...(o.hint !== undefined ? { hint: o.hint } : {}),
              }))}
              onChange={onTurnSelect}
            />
          ) : sourceMode === 'git' ? (
            <div className={styles.branchSelectWrap}>
              <GitBranch size={13} className={styles.branchIcon} aria-hidden />
              <Select
                className={styles.turnSettingsSelect}
                disabled={busy}
                value={currentBranch}
                options={branches.map((b) => ({ id: b, label: b }))}
                onChange={(val) => onBranchChange(val)}
              />
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>载入变更源开始对比</div>
          )}
        </div>
      </div>
    );
  }
);
