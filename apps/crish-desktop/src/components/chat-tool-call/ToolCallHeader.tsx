import React, { useMemo } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { FileDiff, MessageToolCall } from '../../store/types';
import { toolCommandType, toolCommandIcon } from '../../api/toolPresentation';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons';
import {
  type ResolvedToolAction,
  extractFallbackParam,
  resolveToolActionAndParam,
  resolveToolSecondaryMeta,
} from './toolHeaderPresentation';

export type { ResolvedToolAction };
export {
  extractFallbackParam,
  resolveToolActionAndParam,
  resolveToolSecondaryMeta,
};

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
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
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
  onOpenDiff,
}) => {
  const { actionText, paramText, isPath } = resolveToolActionAndParam(
    tc,
    human,
    filePath,
    pathLabel
  );

  const isError = tc.status === 'error';
  const kind = useMemo(() => toolCommandType(tc), [tc]);
  const kindIconName = useMemo(() => toolCommandIcon(kind), [kind]);
  const fullTooltip = filePath || tc.arguments || human || '';

  const targetDiff = tc.diffs?.[0];

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
        <span className={styles.toolRowIcoSlot} aria-hidden="true">
          {running ? (
            <span className={styles.toolPulseDot} aria-hidden="true" />
          ) : isError ? (
            <span className={styles.toolErrorDot} aria-hidden="true" />
          ) : (
            <AppIcon
              name={kindIconName}
              size={12}
              className={styles.toolKindIcon}
              aria-hidden
            />
          )}
        </span>
        <span className={styles.toolRowText}>
          <span className={styles.toolRowSummary}>
            <Tooltip content={fullTooltip}>
              <span className={styles.toolActionText}>{actionText}</span>
            </Tooltip>
            {paramText ? (
              isError ? (
                <Tooltip content={tc.output || fullTooltip}>
                  <span className={styles.toolErrorParamText}>{paramText}</span>
                </Tooltip>
              ) : isPath && pathClickable && filePath ? (
                <Tooltip content={filePath}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={styles.toolPathLink}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPath?.(filePath);
                    }}
                  >
                    {paramText}
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip content={fullTooltip}>
                  <span className={styles.toolParamText}>{paramText}</span>
                </Tooltip>
              )
            ) : null}

            {/* 差异统计 (+2 -1) 紧跟在路径与参数后方，点击定位至差异面板 */}
            {diffStats ? (
              targetDiff && onOpenDiff ? (
                <Tooltip content="在右侧面板查看差异">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className={styles.diffStatsBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDiff(targetDiff);
                    }}
                    aria-label={`查看差异：+${diffStats.add} -${diffStats.del}`}
                  >
                    <span className={styles.diffStatsAdd}>
                      +{diffStats.add}
                    </span>
                    <span className={styles.diffStatsDel}>
                      -{diffStats.del}
                    </span>
                  </Button>
                </Tooltip>
              ) : (
                <span className={styles.diffStatsInline}>
                  <span className={styles.diffStatsAdd}>+{diffStats.add}</span>
                  <span className={styles.diffStatsDel}>-{diffStats.del}</span>
                </span>
              )
            ) : null}
          </span>
        </span>
      </span>
      <span className={styles.toolRowHeadRight}>
        {durationStr ? (
          <span className={styles.duration}>{durationStr}</span>
        ) : null}
        {canToggle ? (
          <span
            className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
            aria-hidden="true"
            data-testid={`tool-chevron-${tc.id}`}
          >
            &#8250;
          </span>
        ) : null}
      </span>
    </div>
  );
};
