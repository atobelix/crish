/**
 * NotePaperStrictHeader — Strict 轨顶栏（SD-04-R 拆分）
 *
 * 包 ID 徽章 / rev / 块数 / slash 写模式 / 刷新 / 打开 slash / 关闭。
 * **≠ EL-01**；slash 入口 ≠ 完整 `/` 键 IME 路径。
 */

import React from 'react';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay';
import { Button } from '../ui';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from './notePaperStrictTrack';
import styles from './NotePaperPanel.module.css';

export type NotePaperStrictHeaderProps = {
  title: string;
  resolvedRev: number | string;
  blockCount: number;
  slashWriteMode: SlashOverlayWriteMode;
  showOpenSlashButton: boolean;
  onReload: () => void;
  onOpenSlash: () => void;
  onClose?: () => void;
};

/**
 * Strict 面板 header：元信息徽章 + 产品入口按钮。
 */
export const NotePaperStrictHeader: React.FC<NotePaperStrictHeaderProps> = ({
  title,
  resolvedRev,
  blockCount,
  slashWriteMode,
  showOpenSlashButton,
  onReload,
  onOpenSlash,
  onClose,
}) => {
  const slashModeHint =
    slashWriteMode === 'readonly'
      ? 'slash 只读（未接 apply；≠假写）'
      : 'slash 可写（Intent → sink）';

  return (
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.meta}>
        <span
          className={styles.badgeSilent}
          data-testid="note-paper-strict-track"
        >
          {W5B_STRICT_PACKAGE_ID}/{W5B_STRICT_TRACK}
        </span>
        <span className={styles.badge} data-testid="note-paper-strict-rev">
          rev={resolvedRev}
        </span>
        <span className={styles.badge} data-testid="note-paper-strict-count">
          {blockCount} 块
        </span>
        <Tooltip content={slashModeHint}>
          <span
            className={styles.badge}
            data-testid="note-paper-strict-slash-mode"
            data-slash-write-mode={slashWriteMode}
          >
            slash={slashWriteMode}
          </span>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.badge}
          onClick={() => {
            void onReload();
          }}
          aria-label="重新 hydrate 投影"
          data-testid="note-paper-strict-refresh"
        >
          刷新
        </Button>
        {showOpenSlashButton ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.badge}
            onClick={onOpenSlash}
            aria-label={
              slashWriteMode === 'readonly'
                ? '打开斜杠菜单（只读 catalog；未接 apply）'
                : '打开斜杠菜单'
            }
            data-testid="note-paper-strict-open-slash"
            data-slash-open-trigger="1"
            data-slash-write-mode={slashWriteMode}
          >
            /
          </Button>
        ) : null}
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.badge}
            onClick={onClose}
            aria-label="关闭 Strict 笔记纸面"
            data-testid="note-paper-strict-close"
          >
            关闭
          </Button>
        ) : null}
      </div>
    </header>
  );
};

export default NotePaperStrictHeader;
