/**
 * TimelineThoughtSection.tsx
 * 交错多步骤时间线中的行内思维链组件（FIN-02 / FIN-03 / RUL-05 落地）。
 *
 * 特性：
 * - 废除 4000 字符硬截断，行内自适应 8k~12k 字符视口（budgetThinkingText）；
 * - 超过预算时渲染优雅的「查看完整思考链（共 X 字）」操作条与渐变遮罩；
 * - 点击操作条或悬浮胶囊触发 openThoughtInspector 打开万字沉浸式查阅器；
 * - 实时流阶段随 Token 输出自适应平滑吸底追尾滚动（用户手动向上翻动时暂停）；
 * - 毫秒级耗时、字数统计与阶段标题呈现。
 */
import React, { useLayoutEffect, useRef, useState, useMemo } from 'react';
import { ChevronRight, BrainCircuit, Sparkles, Maximize2 } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { AsyncMarkdownBlock } from './AsyncMarkdownBlock';
import { Priority } from '../../workers';
import { openThoughtInspector } from '../../store/thoughtInspectorStore';
import { budgetThinkingText } from '../../api/messageWindowDomBudget';
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

  // 8k~12k 自适应 DOM 预算计算
  const budget = useMemo(() => {
    return budgetThinkingText(content);
  }, [content]);

  // 随流式内容自适应吸底滚动（用户向上滚时暂停吸底）
  useLayoutEffect(() => {
    if (!isLive || !isOpen || !bodyRef.current) return;
    const el = bodyRef.current;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content.length, isLive, isOpen]);

  const handleScroll = () => {
    if (!bodyRef.current || !isLive) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    userScrolledUpRef.current = scrollHeight - (scrollTop + clientHeight) > 36;
  };

  const durationLabel = useMemo(() => {
    if (durationMs != null && durationMs > 0) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    }
    return null;
  }, [durationMs]);

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

  const sectionTitle = isLive
    ? '正在深入思考…'
    : turnIndex != null
      ? `第 ${turnIndex + 1} 阶段思考`
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
        <span className={styles.thoughtIconSlot} aria-hidden>
          {isLive ? (
            <Sparkles size={13} className={styles.sparkleLiveIcon} />
          ) : (
            <BrainCircuit size={13} className={styles.brainIcon} />
          )}
        </span>

        <span className={styles.thoughtTitle}>
          {sectionTitle}
          {isLive ? (
            <ThinkingTimer isLive />
          ) : (
            <span className={styles.thoughtMeta}>
              {durationLabel && (
                <span className={styles.thoughtDuration}>
                  {' '}
                  · {durationLabel}
                </span>
              )}
              {totalChars > 0 && (
                <span className={styles.thoughtWords}>
                  {' '}
                  · 共 {totalChars.toLocaleString()} 字
                </span>
              )}
              {budget.isTruncated ? ' (行内已截断)' : ''}
            </span>
          )}
        </span>

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

        <ChevronRight
          size={13}
          className={`${styles.thoughtChevron} ${isOpen ? styles.isOpen : ''}`}
          aria-hidden
        />
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
