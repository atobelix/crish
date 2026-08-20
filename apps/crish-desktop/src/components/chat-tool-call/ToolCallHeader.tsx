import React from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  PanelRightOpen,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import type { MessageToolCall } from '../../store/types';
import { toolCommandIcon, toolCommandType } from '../../api/toolPresentation';
import { Button, Tooltip } from '../ui';

export interface ToolCallHeaderProps {
  tc: MessageToolCall;
  human: string;
  statusZh: string;
  running: boolean;
  isOpen: boolean;
  canToggle: boolean;
  durationStr: string | null;
  diffStats: { add: number; del: number } | null;
  pathClickable: boolean;
  filePath: string;
  pathLabel: string;
  rowAriaLabel: string;
  bodyId: string;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onRetryTool?: ((toolId: string) => void) | undefined;
}

export const ToolCallHeader: React.FC<ToolCallHeaderProps> = ({
  tc,
  human,
  running,
  isOpen,
  canToggle,
  durationStr,
  diffStats,
  pathClickable,
  filePath,
  pathLabel,
  rowAriaLabel,
  bodyId,
  onToggleTool,
  onOpenPath,
  onRetryTool,
}) => {
  const pathActions =
    pathClickable && filePath ? (
      <span
        className={styles.toolPathActions}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip content="在文件面板打开">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.toolPathAction}
            aria-label="在文件面板打开"
            onClick={() => onOpenPath?.(filePath)}
            icon={<PanelRightOpen size={14} aria-hidden />}
          />
        </Tooltip>
        <Tooltip content="复制路径">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.toolPathAction}
            aria-label="复制路径"
            onClick={() => {
              void navigator.clipboard.writeText(filePath);
            }}
            icon={<Copy size={14} aria-hidden />}
          />
        </Tooltip>
      </span>
    ) : null;

  const renderSummary = () => {
    if (
      !pathClickable ||
      !filePath ||
      !pathLabel ||
      !human.includes(pathLabel)
    ) {
      return (
        <Tooltip content={human}>
          <span className={styles.toolRowSummary}>
            {human}
            {pathClickable && filePath && pathActions ? (
              <span className={styles.toolPathWrap} style={{ marginLeft: 6 }}>
                {pathActions}
              </span>
            ) : null}
          </span>
        </Tooltip>
      );
    }
    const idx = human.lastIndexOf(pathLabel);
    const link = (
      <span className={styles.toolPathWrap}>
        <Tooltip content={filePath}>
          <button
            type="button"
            className={styles.toolPathLink}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPath?.(filePath);
            }}
          >
            {pathLabel}
          </button>
        </Tooltip>
        {pathActions}
      </span>
    );
    if (idx < 0) {
      return (
        <Tooltip content={filePath}>
          <span className={styles.toolRowSummary}>
            {human} {link}
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={filePath}>
        <span className={styles.toolRowSummary}>
          {human.slice(0, idx)}
          {link}
          {human.slice(idx + pathLabel.length)}
        </span>
      </Tooltip>
    );
  };

  const toolIcon = (() => {
    const sz = 14;
    const sw = 1.6;
    let inner: React.ReactNode;
    if (running) {
      inner = (
        <span className={styles.toolRowLive} aria-hidden>
          <span className={styles.toolLivePulseDot} />
        </span>
      );
    } else if (tc.status === 'error') {
      inner = (
        <XCircle
          size={sz}
          strokeWidth={sw}
          color="var(--accent-red, #c45c5c)"
        />
      );
    } else {
      // 严禁绿勾墙：非 error 均采用精细的中性/命令语义图标（完成态无彩），杜绝大面积刺眼绿勾
      const KindIcon = toolCommandIcon(toolCommandType(tc));
      inner = (
        <KindIcon
          size={sz}
          strokeWidth={sw}
          color="var(--text-tertiary, #8c877d)"
        />
      );
    }
    return (
      <span className={styles.toolRowIcoSlot} aria-hidden>
        {inner}
      </span>
    );
  })();

  return (
    <div
      className={`${styles.toolRowHead}${canToggle ? '' : ' ' + styles.toolRowHeadStatic} tool-row-head${canToggle ? '' : ' tool-row-head-static'}`}
      role={canToggle ? 'button' : undefined}
      tabIndex={canToggle ? 0 : undefined}
      aria-expanded={canToggle ? isOpen : undefined}
      aria-controls={canToggle ? bodyId : undefined}
      aria-label={rowAriaLabel}
      style={canToggle ? undefined : { cursor: 'default' }}
      onClick={() => canToggle && onToggleTool(tc.id, isOpen)}
      onKeyDown={(e) => {
        if (!canToggle) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleTool(tc.id, isOpen);
          return;
        }
        if (e.key === 'Escape' && isOpen) {
          e.preventDefault();
          e.stopPropagation();
          onToggleTool(tc.id, true);
        }
      }}
    >
      <span className={styles.toolRowHeadMain}>
        {toolIcon}
        <span className={styles.toolRowText}>{renderSummary()}</span>
        {diffStats ? (
          <span className={styles.diffStats}>
            <span className={styles.diffStatsAdd}>+{diffStats.add}</span>
            <span className={styles.diffStatsDel}>-{diffStats.del}</span>
          </span>
        ) : null}
        {durationStr ? (
          <span className={styles.duration}>{durationStr}</span>
        ) : null}
      </span>
      <span
        className={`${styles.toolRowChevronSlot} ${canToggle ? styles.isToggle : ''}`}
      >
        {tc.status === 'error' && onRetryTool ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.retryBtn}
            onClick={(e) => {
              e.stopPropagation();
              onRetryTool(tc.id);
            }}
            aria-label="重试"
            icon={<RotateCcw size={12} aria-hidden />}
          />
        ) : null}
        {canToggle ? (
          <ChevronRight
            size={12}
            className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
            aria-hidden
          />
        ) : null}
      </span>
    </div>
  );
};
