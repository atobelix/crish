/**
 * 终端卡片顶部工具栏 (V2 兼容升级版)
 *
 * 职责：
 * - 左侧：当前终端标识与标题指示；
 * - 右侧操作按钮：
 *   - 新建终端 (+)
 *   - 左右分屏 (Columns2) - 可选
 *   - 上下分屏 (Rows2) - 可选
 *   - 清屏 (Eraser / Ctrl+L)
 *   - 关闭分屏 (X) - 仅在历史分屏模式下展示
 */
import React from 'react';
import styles from './TerminalCard.module.css';
import { Button, IconButton } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

export type TerminalSplitMode = 'none' | 'horizontal' | 'vertical';

export interface TerminalToolbarProps {
  title?: string;
  onNewTerminal: () => void;
  onClear: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  /** @deprecated 历史假分屏字段 @removeWhen 存量调用方全部迁移到 onSplitHorizontal/onSplitVertical */
  splitMode?: TerminalSplitMode;
  /** @deprecated 历史假分屏字段 @removeWhen 存量调用方全部迁移到 onSplitHorizontal/onSplitVertical */
  activePaneIndex?: number;
  /** @deprecated 历史假分屏字段 @removeWhen 存量调用方全部迁移到 onSplitHorizontal/onSplitVertical */
  onSelectPane?: (index: number) => void;
  /** @deprecated 历史假分屏字段 @removeWhen 存量调用方全部迁移到 onSplitHorizontal/onSplitVertical */
  onCloseSplit?: () => void;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  splitMode = 'none',
  activePaneIndex = 0,
  onSelectPane,
  onNewTerminal,
  onSplitHorizontal,
  onSplitVertical,
  onClear,
  onCloseSplit,
  title,
}) => {
  const isSplit = splitMode !== 'none';

  return (
    <div
      className={styles.terminalToolbar}
      role="toolbar"
      aria-label="终端操作工具栏"
    >
      {/* 左侧：分屏/终端指示列表 */}
      <div className={styles.terminalTabsGroup}>
        {!isSplit ? (
          <div className={`${styles.termTag} ${styles.termTagActive}`}>
            <AppIcon name="terminal" size={12} className={styles.termTagIcon} />
            <span>{title || 'pwsh'}</span>
          </div>
        ) : (
          <div className={styles.termBranchGroup}>
            <Button
              type="button"
              variant="ghost"
              className={`${styles.termBranchItem} ${
                activePaneIndex === 0 ? styles.termBranchActive : ''
              }`}
              onClick={() => onSelectPane?.(0)}
              aria-label="切换到主分屏终端"
            >
              <span className={styles.branchSymbol}>┌</span>
              <AppIcon
                name="terminal"
                size={13}
                className={styles.termTagIcon}
              />
              <span>{title || 'pwsh 1'}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={`${styles.termBranchItem} ${
                activePaneIndex === 1 ? styles.termBranchActive : ''
              }`}
              onClick={() => onSelectPane?.(1)}
              aria-label="切换到副分屏终端"
            >
              <span className={styles.branchSymbol}>└</span>
              <AppIcon
                name="terminal"
                size={13}
                className={styles.termTagIcon}
              />
              <span>{title || 'pwsh 2'}</span>
            </Button>
          </div>
        )}
      </div>

      {/* 右侧：原子操作按钮群 */}
      <div className={styles.terminalToolbarActions}>
        <IconButton
          size="xs"
          variant="ghost"
          aria-label="新建独立终端"
          tooltip="新建独立终端标签"
          onClick={onNewTerminal}
          icon={<AppIcon name="plus" size={13} />}
        />

        {onSplitHorizontal && (
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="左右分屏"
            tooltip={
              splitMode === 'horizontal'
                ? '当前已向右分屏'
                : '向右分屏 (左右并列)'
            }
            onClick={onSplitHorizontal}
            icon={<AppIcon name="columns" size={13} />}
          />
        )}

        {onSplitVertical && (
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="上下分屏"
            tooltip={
              splitMode === 'vertical'
                ? '当前已向下分屏'
                : '向下分屏 (上下堆叠)'
            }
            onClick={onSplitVertical}
            icon={<AppIcon name="rows" size={13} />}
          />
        )}

        <IconButton
          size="xs"
          variant="ghost"
          aria-label="清空当前终端屏幕"
          tooltip="清屏 (Ctrl+L)"
          onClick={onClear}
          icon={<AppIcon name="eraser" size={13} />}
        />

        {isSplit && onCloseSplit && (
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="关闭当前分屏"
            tooltip="关闭副分屏"
            onClick={onCloseSplit}
            icon={<AppIcon name="x" size={13} />}
          />
        )}
      </div>
    </div>
  );
};
