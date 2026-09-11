/**
 * apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx
 *
 * 过程段内连续工具调用的独立折叠容器（对齐图二设计规范）。
 *
 * 【核心特性】
 * ① 默认折叠：首屏仅展示一行极简摘要（如「已搜索 2 次 · 已运行 1 条命令 〉」）；
 * ② 24px 高度、400 字重、14px 字号，与 ReasoningRow 严格对齐同构；
 * ③ 整行 Hover 统一变黑（var(--text-primary)），展开后详细结果内容 Hover 不变色；
 * ④ 原生 hidden="until-found" 支持 Ctrl+F 页面穿透搜索并自动唤醒展开；
 * ⑤ 运行中流式态直出展开，收口后自收敛折叠。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolRenderItem } from '../../api/toolPresentation';
import {
  DOMINANT_ICON_MAP,
  type ProcessSegmentMetrics,
} from '../../api/tool-presentation/toolPresentationTypes';
import {
  aggregateProcessMetrics,
  formatProcessActionsSummary,
} from '../../api/tool-presentation/processMetricsEngine';
import { AppIcon, type IconName } from '../ui/icons';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import { ChatToolStack, type ChatToolStackProps } from './ChatToolCallBlock';
import styles from './FoldableToolGroup.module.css';

export interface FoldableToolGroupProps {
  items: ToolRenderItem[];
  msgId: string;
  hostProps: ChatToolStackProps;
  onInvalidate?: () => void;
  defaultExpanded?: boolean;
}

export const FoldableToolGroup: React.FC<FoldableToolGroupProps> = React.memo(
  function FoldableToolGroup({
    items,
    msgId: _msgId,
    hostProps,
    onInvalidate,
    defaultExpanded = false,
  }) {
    const slotRef = useRef<HTMLDivElement | null>(null);

    const metrics: ProcessSegmentMetrics = useMemo(() => {
      return aggregateProcessMetrics([
        {
          kind: 'tools',
          items,
          key: 'tool-group-metrics',
        },
      ]);
    }, [items]);

    // 默认折叠，若当前正在运行则直出展开
    const [isExpanded, setIsExpanded] = useState<boolean>(
      () => defaultExpanded || metrics.hasRunning
    );

    // 流式执行中进入 running 时保持展开
    useEffect(() => {
      if (metrics.hasRunning) {
        setIsExpanded(true);
      }
    }, [metrics.hasRunning]);

    const handleToggle = useCallback(() => {
      setIsExpanded((prev) => {
        const next = !prev;
        onInvalidate?.();
        return next;
      });
    }, [onInvalidate]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleToggle();
        }
      },
      [handleToggle]
    );

    // 原生 hidden="until-found" 支持 Ctrl+F 穿透
    const setSlotRef = useCallback(
      (el: HTMLDivElement | null) => {
        slotRef.current = el;
        if (!el) return;
        if (!isExpanded) {
          el.setAttribute('hidden', 'until-found');
        } else {
          el.removeAttribute('hidden');
        }
      },
      [isExpanded]
    );

    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;
      const handleBeforeMatch = () => {
        setIsExpanded(true);
        onInvalidate?.();
      };
      el.addEventListener('beforematch', handleBeforeMatch);
      return () => {
        el.removeEventListener('beforematch', handleBeforeMatch);
      };
    }, [onInvalidate]);

    const summaryText = useMemo(() => {
      return formatProcessActionsSummary(metrics);
    }, [metrics]);

    const iconName = useMemo(() => {
      return (DOMINANT_ICON_MAP[metrics.leadAction] || 'terminal') as IconName;
    }, [metrics.leadAction]);

    return (
      <div
        className={styles.groupContainer}
        data-testid="foldable-tool-group"
        data-expanded={isExpanded ? 'true' : 'false'}
      >
        <div
          className={styles.groupHeader}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
        >
          <AppIcon
            name={iconName}
            size={14}
            className={styles.leadIcon}
            aria-hidden
            data-testid={`tool-group-icon-${metrics.leadAction}`}
          />
          <span className={styles.summaryLabel}>{summaryText}</span>
          {metrics.hasError && (
            <Tooltip content="包含执行错误">
              <span
                className={styles.errorBadge}
                data-testid="tool-group-error-badge"
              >
                <AppIcon name="alert-triangle" size={12} aria-hidden />
              </span>
            </Tooltip>
          )}
          <span
            className={`${styles.chevron} ${isExpanded ? styles.rot : ''}`}
            aria-hidden
            data-testid="tool-group-chevron"
          >
            &#8250;
          </span>
        </div>

        <div
          ref={setSlotRef}
          className={styles.groupBody}
          data-expanded={isExpanded ? 'true' : 'false'}
        >
          <ChatToolStack {...hostProps} />
        </div>
      </div>
    );
  }
);

FoldableToolGroup.displayName = 'FoldableToolGroup';
