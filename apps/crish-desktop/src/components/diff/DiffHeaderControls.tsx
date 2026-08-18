import React from 'react';
import {
  Columns2,
  GitBranch,
  GitCommit,
  List,
  Search,
  Copy,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { Button, Select, Tooltip } from '../ui';
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
    return (
      <div
        className={styles.compactHeader}
        role="toolbar"
        aria-label="紧凑变更工具栏"
      >
        {/* 左侧：来源切换胶囊 (AI 改动 / Git) */}
        <div className={styles.leftGroup}>
          <div
            className={styles.sourceSegment}
            role="group"
            aria-label="变更来源"
          >
            <Tooltip content="当前对话中 AI 产生的改动">
              <button
                type="button"
                className={`${styles.sourceTab} ${sourceMode === 'session' ? styles.activeTab : ''}`}
                aria-pressed={sourceMode === 'session'}
                disabled={applyBusy}
                onClick={() => onSourceModeChange('session')}
              >
                <Sparkles size={12} className={styles.tabIcon} aria-hidden />
                <span>AI</span>
              </button>
            </Tooltip>
            <Tooltip content="工作区 Git 未提交变更">
              <button
                type="button"
                className={`${styles.sourceTab} ${sourceMode === 'git' ? styles.activeTab : ''}`}
                aria-pressed={sourceMode === 'git'}
                disabled={gitLoading || applyBusy}
                onClick={() => onSourceModeChange('git')}
              >
                <GitBranch size={12} className={styles.tabIcon} aria-hidden />
                <span>{gitLoading ? 'Git…' : 'Git'}</span>
              </button>
            </Tooltip>
          </div>

          <div className={styles.headerDivider} aria-hidden />

          {/* 中部：回合或分支下拉选择器 */}
          <div className={styles.contextSelector}>
            {sourceMode === 'session' ? (
              <Select
                className={styles.inlineSelect}
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
              <div className={styles.branchWrap}>
                <Select
                  className={styles.inlineSelect}
                  disabled={busy}
                  value={currentBranch}
                  options={branches.map((b) => ({ id: b, label: b }))}
                  onChange={(val) => onBranchChange(val)}
                />
              </div>
            ) : (
              <span className={styles.idleHint}>载入变更源开始对比</span>
            )}
          </div>
        </div>

        {/* 右侧：视图与操作按钮组 */}
        <div className={styles.rightActions}>
          <Tooltip
            content={
              diffViewMode === 'unified'
                ? '切换至分栏视图 (Split View)'
                : '切换至合并视图 (Unified View)'
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.actionBtn}
              aria-label={
                diffViewMode === 'unified' ? '切换至分栏视图' : '切换至合并视图'
              }
              onClick={onViewModeChange}
              icon={
                diffViewMode === 'unified' ? (
                  <Columns2 size={13} aria-hidden />
                ) : (
                  <List size={13} aria-hidden />
                )
              }
            />
          </Tooltip>

          {onCopyPatch && current && (
            <Tooltip content="复制当前文件为标准 Git Patch">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={styles.actionBtn}
                aria-label="复制 Patch"
                onClick={onCopyPatch}
                icon={<Copy size={13} aria-hidden />}
              />
            </Tooltip>
          )}

          {sourceMode === 'git' && fileListLength > 0 && (
            <Tooltip
              content={commitPanelOpen ? '隐藏提交面板' : '显示提交面板'}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={`${styles.actionBtn} ${commitPanelOpen ? styles.isActive : ''}`}
                aria-label="切换提交面板"
                onClick={onCommitPanelToggle}
                icon={<GitCommit size={13} aria-hidden />}
              />
            </Tooltip>
          )}

          <Tooltip content="搜索差异行">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={`${styles.actionBtn} ${searchOpen || searchActive ? styles.isActive : ''}`}
              aria-label="搜索差异行"
              aria-pressed={searchOpen || searchActive}
              onClick={() => onSearchOpenChange(!searchOpen)}
              icon={<Search size={13} aria-hidden />}
            />
          </Tooltip>

          {fileListLength > 0 && (
            <Tooltip content="清空当前审查列表">
              <Button
                type="button"
                variant="danger"
                size="xs"
                className={styles.actionBtn}
                aria-label="清空变更列表"
                disabled={applyBusy}
                onClick={onClear}
                icon={<Trash2 size={13} aria-hidden />}
              />
            </Tooltip>
          )}
        </div>
      </div>
    );
  }
);
