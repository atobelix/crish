/**
 * TimelineThoughtSection.tsx
 * 交错多步骤时间线中的行内思维链组件（极简行内流规范 §5.1 / reference thinking.css）。
 *
 * 特性：
 * - 彻底废除厚重带外框的灰色大卡片，采用极简行内流排布；
 * - 已完成态：`思考了 3.4秒 >`（或 `第 1 阶段思考 · 2.4s · 共 X 字 >`，font-variant-numeric: tabular-nums）；
 * - 实时运行态（Live）：`🟢 思考中 · 1.8秒`（5px 翡翠绿脉冲高亮）；
 * - 展开内容区带上下 20px 平滑渐变遮罩（linear-gradient），自然融入时间线；
 * - 超过预算时渲染优雅的「查看完整思考链」操作条，支持 openThoughtInspector 万字沉浸式查阅。
 */
import React, { useLayoutEffect, useRef, useState, useMemo } from 'react';
import { Maximize2 } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { AsyncMarkdownBlock } from './AsyncMarkdownBlock';
import {
  Priority,
  budgetThinkingText,
  THINKING_INLINE_CHAR_CAP,
} from '../../workers';
import { openThoughtInspector } from '../../store/storeAccess';
import { ThinkingTimer } from './ThinkingTimer';
import { Tooltip, Button } from '../ui';

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
  messageId,
  defaultExpanded,
}) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded ?? isLive);
  const bodyRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const prevIsLiveRef = useRef(isLive);

  // 8k~12k 自适应 DOM 预算计算（流式阶段启用 Safe Markdown Tail Slicer 尾窗滑动）
  const budget = useMemo(() => {
    return budgetThinkingText(content, {
      cap: THINKING_INLINE_CHAR_CAP,
      mode: isLive ? 'tail' : 'head',
    });
  }, [content, isLive]);

  // 当 isLive 重新开启时，复位用户手动滚动标志，确保自动追尾吸底
  useLayoutEffect(() => {
    if (!prevIsLiveRef.current && isLive) {
      userScrolledUpRef.current = false;
    }
    prevIsLiveRef.current = isLive;
  }, [isLive]);

  // 随流式内容自适应吸底滚动（用户向上滚时暂停吸底）
  useLayoutEffect(() => {
    if (!isLive || !isOpen || !bodyRef.current) return;
    const el = bodyRef.current;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [budget.displayText, isLive, isOpen]);

  const handleScroll = () => {
    if (!bodyRef.current || !isLive) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    userScrolledUpRef.current = scrollHeight - (scrollTop + clientHeight) > 36;
  };

  const durationLabel = useMemo(() => {
    if (durationMs != null && durationMs > 0) {
      const sec = (durationMs / 1000).toFixed(1);
      return turnIndex != null ? `${sec}s` : `${sec}秒`;
    }
    return null;
  }, [durationMs, turnIndex]);

  const totalChars = budget.totalChars;

  const handleOpenInspector = (e: React.MouseEvent) => {
    e.stopPropagation();
    openThoughtInspector({
      messageId: messageId || '',
      content,
      turnIndex,
      durationSec: durationMs ? durationMs / 1000 : undefined,
    });
  };

  const titleText = isLive
    ? '思考中'
    : turnIndex != null
      ? `第 ${turnIndex + 1} 阶段思考`
      : durationLabel
        ? `思考了 ${durationLabel}`
        : '思考过程';

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
        {isLive ? (
          <span className={styles.thoughtLiveDot} aria-hidden />
        ) : null}

        <span className={styles.thoughtTitle}>
          {titleText}
        </span>

        {isLive ? (
          <ThinkingTimer isLive />
        ) : (
          <span className={styles.thoughtMeta}>
            {turnIndex != null && durationLabel ? (
              <span className={styles.thoughtDuration}> · {durationLabel}</span>
            ) : null}
            {totalChars > 0 ? (
              <span className={styles.thoughtWords}>
                {' '}
                · 共 {totalChars.toLocaleString()} 字
              </span>
            ) : null}
            {budget.isTruncated ? ' (行内已截断)' : ''}
          </span>
        )}

        {/* 沉浸式查阅器悬浮入口 */}
        <Tooltip content="在沉浸式查阅器中查看完整思维链">
          <button
            type="button"
            className={styles.thoughtExpandModalBtn}
            onClick={handleOpenInspector}
            aria-label="查看完整思考链"
          >
            <Maximize2 size={12} />
          </button>
        </Tooltip>

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
            <div
              ref={bodyRef}
              onScroll={handleScroll}
              className={styles.thoughtScrollBody}
            >
              {isLive ? (
                <div
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {budget.displayText}
                </div>
              ) : (
                <AsyncMarkdownBlock
                  text={budget.displayText}
                  isStreaming={false}
                  priority={Priority.Low}
                />
              )}
            </div>

            {/* 超出预算时渲染优雅的沉浸查阅引导条 */}
            {budget.isTruncated && !isLive && (
              <div className={styles.thinkingFadeOverlay}>
                <div className={styles.thinkingActionStrip}>
                  <span className={styles.thinkingSummaryText}>
                    已显示前 {budget.displayText.length.toLocaleString()} 字 /
                    共 {totalChars.toLocaleString()} 字
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.fullThoughtBtn}
                    onClick={handleOpenInspector}
                    icon={<Maximize2 size={12} />}
                  >
                    查看完整思考链 (共 {totalChars.toLocaleString()} 字)
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
