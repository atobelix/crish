/**
 * TimelineThoughtSection.tsx
 * 交错多步骤时间线中的行内思维链组件（极简行内流规范 §5.1 / reference thinking.css）。
 *
 * 特性：
 * - 彻底废除厚重带外框的灰色大卡片，采用极简行内流排布；
 * - 已完成态：`思考了 3.4秒 >`（或 `第 1 阶段思考 · 2.4s >`，font-variant-numeric: tabular-nums）；
 * - 实时运行态（Live）：`🟢 思考中 · 1.8秒`（5px 翡翠绿脉冲高亮）；
 * - 思考内容直接在折叠面板内自然流式展开，由单一物理滚动容器负责整体滚动（切除内部 168px 矮盒卡死与脆弱吸底）。
 */
import React, { useState, useMemo } from 'react';
import styles from './TimelineThoughtSection.module.css';
import { StreamingMarkdownView } from './StreamingMarkdownView';
import { Priority } from '../../workers';
import { ThinkingTimer } from './ThinkingTimer';

export interface TimelineThoughtSectionProps {
  content: string;
  isLive?: boolean;
  durationMs?: number;
  turnIndex?: number;
  messageId?: string;
  defaultExpanded?: boolean;
}

export const TimelineThoughtSection: React.FC<TimelineThoughtSectionProps> = ({
  content,
  isLive = false,
  durationMs,
  turnIndex,
  defaultExpanded,
}) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded ?? isLive);

  const durationLabel = useMemo(() => {
    if (durationMs != null && durationMs > 0) {
      const sec = (durationMs / 1000).toFixed(1);
      return `${sec}秒`;
    }
    return null;
  }, [durationMs]);

  const titleText = isLive
    ? '思考中'
    : durationLabel
      ? `已思考 · ${durationLabel}`
      : '已思考';

  return (
    <div
      className={`${styles.thoughtTimelineSection} ${isLive ? styles.isLive : ''} ${isOpen ? styles.isOpen : ''}`}
      data-kind="thought"
      data-live={isLive ? 'true' : undefined}
    >
      <div
        className={styles.thoughtHeaderBtn}
        onClick={() => setIsOpen((prev) => !prev)}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
      >
        <span className={styles.thoughtTitle}>
          {titleText}
        </span>

        {isLive ? (
          <ThinkingTimer isLive />
        ) : null}

        <span
          className={`${styles.thoughtChevron} ${isOpen ? styles.isOpen : ''}`}
          aria-hidden
        >
          ›
        </span>
      </div>

      <div
        className={styles.thoughtAccordion}
        data-expanded={isOpen ? 'true' : 'false'}
      >
        <div className={styles.thoughtAccordionInner}>
          <div className={styles.thinkingBodyContainer}>
            <div className={styles.thoughtScrollBody}>
              {isLive ? (
                <div
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {content}
                </div>
              ) : (
                <StreamingMarkdownView
                  text={content}
                  isStreaming={false}
                  priority={Priority.Low}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
