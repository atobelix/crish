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
 * ⑤ 运行中流式态直出展开，收口后自收敛折叠；
 * ⑥ 仅 ≥2 个工具才做组级折叠；单工具直出工具行（意图说明与命令常驻可见，详情默认折叠）。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ToolRenderItem } from '../../api/toolPresentation';
import {
  DOMINANT_ICON_MAP,
  type ProcessSegmentMetrics,
} from '../../api/tool-presentation/toolPresentationTypes';
import {
  aggregateProcessMetrics,
  formatProcessActionsSummary,
} from '../../api/tool-presentation/processMetricsEngine';
import { AppIcon, type IconName } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui';
import { ChatToolStack, type ChatToolStackProps } from './ChatToolCallBlock';
import * as motionTokens from '../../utils/motionTokens';
import { DURATION_ACCORDION_MS } from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import styles from './FoldableToolGroup.module.css';

/**
 * 距离自适应手风琴折叠展开物理时长计算器（带 motionTokens 动态回退）
 */
function calcAccordionDuration(height: number, isOpening: boolean): number {
  if (
    typeof (motionTokens as Record<string, unknown>).calcAccordionDuration ===
    'function'
  ) {
    return (
      (motionTokens as Record<string, unknown>).calcAccordionDuration as (
        h: number,
        o: boolean
      ) => number
    )(height, isOpening);
  }
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  if (isOpening) {
    const raw = 180 + 90 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(480, Math.max(180, raw)));
  } else {
    const raw = 150 + 65 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(350, Math.max(150, raw)));
  }
}

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
    const containerRef = useRef<HTMLDivElement | null>(null);
    const headerRef = useRef<HTMLDivElement | null>(null);
    const slotRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isInitialMount = useRef(true);
    const userInteractedRef = useRef(false);
    const [transitionDuration, setTransitionDuration] = useState<number>(
      DURATION_ACCORDION_MS
    );

    // 视口保护：折叠收起时若顶部脱离视口，平滑拉回
    const { triggerViewportRecovery } = useAccordionViewportGuard(containerRef);

    const metrics: ProcessSegmentMetrics = useMemo(() => {
      return aggregateProcessMetrics([
        {
          kind: 'tools',
          items,
          key: 'tool-group-metrics',
        },
      ]);
    }, [items]);

    const prevHasRunningRef = useRef(metrics.hasRunning);

    // 组级折叠门槛：仅 ≥2 个工具才聚合为单行摘要（总方案 §终态收敛「单工具则直出展开」、
    // 分段详案 S08）。单工具的摘要（「已运行 1 条命令」）与工具行同为 24px 单行，
    // 却会抹掉意图说明与真实命令——单工具直接渲染工具行，详情仍由工具行自身默认折叠。
    const isGroupFolding = metrics.toolCount >= 2;

    // 默认折叠；若当前正在运行或包含子代理（铁律四）则直出展开
    const [isExpanded, setIsExpanded] = useState<boolean>(
      () => defaultExpanded || metrics.hasRunning || metrics.subagentCount > 0
    );

    // 流式执行中进入 running 时保持展开；全部工具执行完毕后自动收敛折叠（用户手动切换或子代理除外）
    useEffect(() => {
      const wasRunning = prevHasRunningRef.current;
      prevHasRunningRef.current = metrics.hasRunning;
      if (metrics.hasRunning || metrics.subagentCount > 0) {
        setIsExpanded(true);
      } else if (wasRunning && !userInteractedRef.current && !defaultExpanded) {
        const currentHeight =
          innerRef.current?.getBoundingClientRect().height ?? 0;
        setTransitionDuration(calcAccordionDuration(currentHeight, false));
        triggerViewportRecovery();
        setIsExpanded(false);
        onInvalidate?.();
      }
    }, [
      metrics.hasRunning,
      metrics.subagentCount,
      defaultExpanded,
      onInvalidate,
      triggerViewportRecovery,
    ]);

    const handleToggle = useCallback(() => {
      userInteractedRef.current = true;
      setIsExpanded((prev) => {
        const next = !prev;
        if (!next) {
          triggerViewportRecovery();
        }
        const currentHeight =
          innerRef.current?.getBoundingClientRect().height ?? 0;
        const dur = calcAccordionDuration(currentHeight, next);
        setTransitionDuration(dur);
        onInvalidate?.();
        return next;
      });
    }, [onInvalidate, triggerViewportRecovery]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleToggle();
        }
      },
      [handleToggle]
    );

    // 无障碍键盘聚焦穿透：内部子元素获得焦点时平滑展开
    const handleFocusCapture = useCallback(
      (e: React.FocusEvent) => {
        if (isExpanded) return;
        if (headerRef.current?.contains(e.target as Node)) return;
        setIsExpanded(true);
        onInvalidate?.();
      },
      [isExpanded, onInvalidate]
    );

    // 解耦 hidden 阻断：展开态确保无 hidden，收起态在自适应过渡后安全附加 hidden="until-found"
    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;

      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }

      if (isExpanded) {
        el.removeAttribute('hidden');
      } else {
        if (isInitialMount.current) {
          el.setAttribute('hidden', 'until-found');
        } else {
          // 延迟附加，允许 CSS Grid 0fr 过渡动画平滑播放，避免 Chromium 掐死动画
          collapseTimerRef.current = setTimeout(() => {
            if (!isExpanded && slotRef.current) {
              slotRef.current.setAttribute('hidden', 'until-found');
            }
          }, transitionDuration);
        }
      }
      isInitialMount.current = false;
      // isGroupFolding：单工具→多工具时槽位首次挂载，需按当前折叠态补挂 hidden
    }, [isExpanded, isGroupFolding, transitionDuration]);

    // CSS Grid 过渡结束时立即附加 hidden="until-found" 支持 Ctrl+F 页面穿透
    const handleTransitionEnd = useCallback(
      (e: React.TransitionEvent<HTMLDivElement>) => {
        if (e.target !== slotRef.current) return;
        if (e.propertyName === 'grid-template-rows' && !isExpanded) {
          if (collapseTimerRef.current) {
            clearTimeout(collapseTimerRef.current);
            collapseTimerRef.current = null;
          }
          slotRef.current?.setAttribute('hidden', 'until-found');
        }
      },
      [isExpanded]
    );

    useEffect(() => {
      return () => {
        if (collapseTimerRef.current) {
          clearTimeout(collapseTimerRef.current);
        }
      };
    }, []);

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
    }, [onInvalidate, isGroupFolding]);

    const summaryText = useMemo(() => {
      return formatProcessActionsSummary(metrics);
    }, [metrics]);

    const iconName = useMemo(() => {
      return (DOMINANT_ICON_MAP[metrics.leadAction] || 'terminal') as IconName;
    }, [metrics.leadAction]);

    if (!isGroupFolding) {
      return (
        <div
          ref={containerRef}
          className={styles.groupContainer}
          data-testid="foldable-tool-group"
          data-single-tool="true"
        >
          <ChatToolStack {...hostProps} />
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className={styles.groupContainer}
        data-testid="foldable-tool-group"
        data-expanded={isExpanded ? 'true' : 'false'}
        onFocusCapture={handleFocusCapture}
      >
        <div
          ref={headerRef}
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
          ref={slotRef}
          className={styles.groupBody}
          data-expanded={isExpanded ? 'true' : 'false'}
          style={
            {
              '--accordion-duration': `${transitionDuration}ms`,
            } as React.CSSProperties
          }
          onTransitionEnd={handleTransitionEnd}
        >
          <div ref={innerRef} className={styles.groupBodyInner}>
            <ChatToolStack {...hostProps} />
          </div>
        </div>
      </div>
    );
  }
);

FoldableToolGroup.displayName = 'FoldableToolGroup';
