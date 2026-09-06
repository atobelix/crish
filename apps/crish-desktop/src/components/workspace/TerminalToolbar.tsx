/**
 * 终端卡片顶部工具栏：
 * - 左侧：当前终端标识与分屏分支列表（对齐用户截图：┌ >_ pwsh / └ >_ pwsh）；
 * - 右侧操作按钮：
 *   - 新建终端 (+)
 *   - 左右分屏 (Columns2)
 *   - 上下分屏 (Rows2)
 *   - 清屏 (Eraser / Ctrl+L)
 *   - 关闭分屏 (X)
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './TerminalCard.module.css';
import { IconButton } from '../ui';

export type TerminalSplitMode = 'none' | 'horizontal' | 'vertical';

export interface TerminalToolbarProps {
  splitMode: TerminalSplitMode;
  activePaneIndex: number;
  onSelectPane: (index: number) => void;
  onNewTerminal: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClear: () => void;
  onCloseSplit: () => void;
  title?: string;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  splitMode,
  activePaneIndex,
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
    <div className={styles.terminalToolbar} role="toolbar" aria-label="终端操作工具栏">
      {/* 左侧：分屏/终端指示列表（严格对齐用户截图 media_1788672791905.png） */}
      <div className={styles.terminalTabsGroup}>
        {!isSplit ? (
          <div className={`${styles.termTag} ${styles.termTagActive}`}>
            <Lucide.Terminal size={12} className={styles.termTagIcon} />
            <span>{title || 'pwsh'}</span>
          </div>
        ) : (
          <div className={styles.termBranchGroup}>
            <button
              type="button"
              className={`${styles.termBranchItem} ${
                activePaneIndex === 0 ? styles.termBranchActive : ''
              }`}
              onClick={() => onSelectPane(0)}
              aria-label="切换到主分屏终端"
            >
              <span className={styles.branchSymbol}>┌</span>
              <Lucide.Terminal size={11} className={styles.termTagIcon} />
              <span>{title ? `${title} (主)` : 'pwsh 1'}</span>
            </button>
            <button
              type="button"
              className={`${styles.termBranchItem} ${
                activePaneIndex === 1 ? styles.termBranchActive : ''
              }`}
              onClick={() => onSelectPane(1)}
              aria-label="切换到副分屏终端"
            >
              <span className={styles.branchSymbol}>└</span>
              <Lucide.Terminal size={11} className={styles.termTagIcon} />
              <span>{title ? `${title} (分屏)` : 'pwsh 2'}</span>
            </button>
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
          icon={<Lucide.Plus size={13} strokeWidth={2} />}
        />

        <IconButton
          size="xs"
          variant="ghost"
          aria-label="左右分屏"
          tooltip={splitMode === 'horizontal' ? '当前已向右分屏' : '向右分屏 (左右并列)'}
          onClick={onSplitHorizontal}
          icon={<Lucide.Columns2 size={13} strokeWidth={1.8} />}
        />

        <IconButton
          size="xs"
          variant="ghost"
          aria-label="上下分屏"
          tooltip={splitMode === 'vertical' ? '当前已向下分屏' : '向下分屏 (上下堆叠)'}
          onClick={onSplitVertical}
          icon={<Lucide.Rows2 size={13} strokeWidth={1.8} />}
        />

        <IconButton
          size="xs"
          variant="ghost"
          aria-label="清空当前终端屏幕"
          tooltip="清屏 (Ctrl+L)"
          onClick={onClear}
          icon={<Lucide.Eraser size={13} strokeWidth={1.8} />}
        />

        {isSplit && (
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="关闭当前分屏"
            tooltip="关闭副分屏"
            onClick={onCloseSplit}
            icon={<Lucide.X size={13} strokeWidth={2} />}
          />
        )}
      </div>
    </div>
  );
};
