import React, { useMemo } from 'react';
import styles from './ChatToolCallBlock.module.css';
import type { FileDiff, MessageToolCall } from '../../store/types';
import { toolCommandType, toolCommandIcon } from '../../api/toolPresentation';
import { Button, NumericText, Tooltip } from '@/components/ui';
import { ToolNumericText } from './ToolNumericText';
import { AppIcon } from '@/components/ui/icons';
import {
  type ResolvedToolAction,
  extractFallbackParam,
  resolveToolActionAndParam,
  resolveToolSecondaryMeta,
  resolveToolSecondaryMetaTitle,
  shouldShowHumanLabel,
} from './toolHeaderPresentation';
import { toolHumanLabelSource } from '../../api/tool-presentation/toolHumanDescriptions';

export type { ResolvedToolAction };
export {
  extractFallbackParam,
  resolveToolActionAndParam,
  resolveToolSecondaryMeta,
  resolveToolSecondaryMetaTitle,
  shouldShowHumanLabel,
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
  /** E1：一处派生的改道目标 diff（resolveToolCallDiffs 首项）；缺省时退回 tc.diffs 首项 */
  targetDiff?: FileDiff | undefined;
  /** E1：本行是否为 side-diff 改道行（与 onOpenDiff + targetDiff 同时具备才实际生效） */
  sideDiff?: boolean | undefined;
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
  targetDiff: targetDiffProp,
  sideDiff,
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
  // 行头单权威文本源（HC1 · D-1）：入参派生的人话标签与 action+param 同源同文，
  // 不再并列渲染（退守行级 aria-label 与下方 Tooltip）；explanation 仅在与
  // action+param 不构成包含关系时并列。判定收口在 toolHeaderPresentation。
  const humanSource = toolHumanLabelSource(tc);
  const showHumanLabel = shouldShowHumanLabel({
    human,
    humanSource,
    actionText,
    paramText,
  });
  // 人话标签未在行内渲染时，仍可经动作词的 Tooltip 读到全文
  const actionTooltip =
    human && !showHumanLabel && fullTooltip && !fullTooltip.includes(human)
      ? `${human} · ${fullTooltip}`
      : fullTooltip;

  const targetDiff = targetDiffProp ?? tc.diffs?.[0];
  // 数字滚动的实况门时间戳（与工具行入场同口径：completedAt ?? startedAt）
  const eventTs = tc.completedAt ?? tc.startedAt;

  // E1 §6.1：次级元数据接线（此前 helper 已算出却无人渲染）——行头
  // 右侧、耗时之前呈紧凑摘要；stat 行的完整字段经 Tooltip 读出。
  const secondaryMeta = resolveToolSecondaryMeta(tc);
  const secondaryMetaTitle = resolveToolSecondaryMetaTitle(tc);

  // E1 §7：改道行语义（镜像 SubagentDispatchCard 先例）——整行头即
  // 入口：点击 / Enter / Space → onOpenDiff(目标 diff)；无 chevron、
  // 无 aria-expanded；宿主未提供 onOpenDiff 时诚实降级为静态行。
  const sideDiffActive = Boolean(sideDiff && targetDiff && onOpenDiff);
  const interactive = canToggle || sideDiffActive;

  return (
    <div
      className={`${styles.toolRowHead}${interactive ? '' : ' ' + styles.toolRowHeadStatic} tool-row-head${interactive ? '' : ' tool-row-head-static'}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={canToggle ? isOpen : undefined}
      aria-controls={canToggle ? bodyId : undefined}
      aria-label={rowAriaLabel}
      data-open-target={sideDiffActive ? 'side-diff-panel' : undefined}
      style={interactive ? undefined : { cursor: 'default' }}
      onClick={() => {
        if (canToggle) onToggleTool(tc.id, isOpen);
        else if (sideDiffActive) onOpenDiff!(targetDiff!);
      }}
      onKeyDown={(e) => {
        if (canToggle) {
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
          return;
        }
        if (sideDiffActive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpenDiff!(targetDiff!);
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
            {showHumanLabel ? (
              <Tooltip content={human}>
                <span
                  className={`${styles.toolActionText} ${styles.toolHumanText}`}
                  data-testid={`tool-human-label-${tc.id}`}
                >
                  {human}
                </span>
              </Tooltip>
            ) : null}
            <Tooltip content={actionTooltip}>
              <span className={styles.toolActionText}>{actionText}</span>
            </Tooltip>
            {paramText ? (
              isError ? (
                <Tooltip content={tc.output || fullTooltip}>
                  <span className={styles.toolErrorParamText}>{paramText}</span>
                </Tooltip>
              ) : isPath && pathClickable && filePath ? (
                (() => {
                  const colonIdx = paramText.lastIndexOf(':');
                  const lineSuffix =
                    colonIdx > 0 ? paramText.slice(colonIdx + 1) : '';
                  const hasLineRange = Boolean(
                    lineSuffix && /^\d+(-\d+)?$/.test(lineSuffix)
                  );
                  const targetPath = hasLineRange
                    ? `${filePath}:${lineSuffix}`
                    : filePath;
                  const linkTooltip = hasLineRange
                    ? `${filePath}:${lineSuffix}`
                    : filePath;

                  return (
                    <Tooltip content={linkTooltip}>
                      <Button
                        type="button"
                        variant="ghost"
                        className={styles.toolPathLink}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPath?.(targetPath);
                        }}
                      >
                        {paramText}
                      </Button>
                    </Tooltip>
                  );
                })()
              ) : (
                <Tooltip content={fullTooltip}>
                  {/* 链接色只属于真正可点击的路径（上方 toolPathLink 分支）；
                      不可点击的参数一律素面 mono，不谎报可点击性 */}
                  <span className={styles.toolParamText}>{paramText}</span>
                </Tooltip>
              )
            ) : null}

            {/* 次要指标（如 "1 处匹配"、"32 行"、"L1–50 / 120 行"）紧跟在参数后方，放在左侧自然阅读流中 */}
            {secondaryMeta ? (
              secondaryMetaTitle ? (
                <Tooltip content={secondaryMetaTitle}>
                  <span className={styles.toolSecondaryMetaInline}>
                    <ToolNumericText text={secondaryMeta} eventTs={eventTs} />
                  </span>
                </Tooltip>
              ) : (
                <span className={styles.toolSecondaryMetaInline}>
                  <ToolNumericText text={secondaryMeta} eventTs={eventTs} />
                </span>
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
                    <ToolNumericText
                      className={styles.diffStatsAdd}
                      text={`+${diffStats.add}`}
                      eventTs={eventTs}
                    />
                    <ToolNumericText
                      className={styles.diffStatsDel}
                      text={`-${diffStats.del}`}
                      eventTs={eventTs}
                    />
                  </Button>
                </Tooltip>
              ) : (
                <span className={styles.diffStatsInline}>
                  <ToolNumericText
                    className={styles.diffStatsAdd}
                    text={`+${diffStats.add}`}
                    eventTs={eventTs}
                  />
                  <ToolNumericText
                    className={styles.diffStatsDel}
                    text={`-${diffStats.del}`}
                    eventTs={eventTs}
                  />
                </span>
              )
            ) : null}
          </span>
        </span>
      </span>
      <span className={styles.toolRowHeadRight}>
        {durationStr ? (
          <span className={styles.duration}>
            <NumericText text={durationStr} />
          </span>
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
