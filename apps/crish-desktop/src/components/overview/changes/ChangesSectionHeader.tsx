/**
 * ChangesSectionHeader.tsx — 改动面板头部操作与模式切换组件（单一职责）。
 *
 * 布局契约：
 * 1. 结构与其它 Section 统一：折叠展开按钮位于最右侧，与其它 Section 形成垂直基准线对齐；
 * 2. 选择按钮（Select）紧挨在“改动”标题与数量右侧；
 * 3. 整行支持点击展开/折叠，Select 阻止事件冒泡独立交互。
 */

import React, { useMemo } from 'react';
import { ChevronDownIcon } from '../../../assets/icons';
import { Select } from '@/components/ui';
import type { ChangesScopeMode } from './types';
import styles from './ChangesSectionHeader.module.css';
import { AppIcon } from '@/components/ui/icons';

export interface ChangesSectionHeaderProps {
  open: boolean;
  scope: ChangesScopeMode;
  sessionCount: number;
  gitCount: number;
  gitLoading?: boolean;
  branch: string;
  onToggleOpen: () => void;
  onScopeChange: (scope: ChangesScopeMode) => void;
  onRefreshGit?: () => void;
}

export const ChangesSectionHeader: React.FC<ChangesSectionHeaderProps> = ({
  open,
  scope,
  sessionCount,
  gitCount,
  branch,
  onToggleOpen,
  onScopeChange,
}) => {
  const currentCount = scope === 'session' ? sessionCount : gitCount;
  const branchDisplay = branch || '当前分支';

  const selectOptions = useMemo(
    () => [
      {
        id: 'session',
        label: sessionCount > 0 ? `当前对话 (${sessionCount})` : '当前对话',
      },
      {
        id: 'unstaged',
        label: gitCount > 0 ? `未提交 (${gitCount})` : '未提交',
      },
      {
        id: 'branch',
        label: `${branchDisplay}${gitCount > 0 ? ` (${gitCount})` : ''}`,
      },
    ],
    [sessionCount, gitCount, branchDisplay]
  );

  return (
    <div
      id="overview-sec-files"
      className={styles.headerRow}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls="overview-sec-files-b"
      onClick={onToggleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleOpen();
        }
      }}
    >
      {/* 1. 左侧区域：图标、标题、数量 */}
      <div className={styles.leftCluster}>
        <AppIcon name="file-diff" size={16} aria-hidden />
        <span className={styles.titleText}>改动</span>
        {currentCount > 0 && (
          <span className={styles.countText}>{currentCount}</span>
        )}
      </div>

      {/* 2. 紧挨在改动右侧的选择按钮 */}
      <div
        className={styles.selectWrapper}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Select
          size="sm"
          className={styles.headerSelect}
          value={scope}
          options={selectOptions}
          onChange={(val) => onScopeChange(val as ChangesScopeMode)}
          aria-label="改动视图作用域"
        />
      </div>

      {/* 3. 最右侧折叠展开箭头：与其它 Section 形成垂直对齐基准线 */}
      <ChevronDownIcon
        size={13}
        className={`${styles.chev} ${open ? styles.open : ''}`}
        aria-hidden
      />
    </div>
  );
};
