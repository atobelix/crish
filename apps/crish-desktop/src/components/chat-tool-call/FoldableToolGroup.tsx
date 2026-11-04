/**
 * apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx
 *
 * 过程段内连续工具调用的独立折叠容器（对齐图二设计规范）。
 *
 * 【核心特性】
 * ① 默认折叠：首屏仅展示一行极简摘要（如「已搜索 2 次 · 已运行 1 条命令 〉」）；
 * ② 24px 高度、400 字重、13px 字号（D5 定版 2026-11-02，原 14px），与 ReasoningRow 严格对齐同构；
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
import { NumericText, ScrollFadeRegion, Tooltip } from '@/components/ui';
import { ChatToolStack, type ChatToolStackProps } from './ChatToolCallBlock';
import {
  calcAccordionDuration,
  accordionDurationStyle,
  DURATION_ACCORDION_MS,
} from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import {
  AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS,
  hasActiveToolDrain,
  onAllToolDrainsSettled,
} from './toolRevealState';
import { useRevealEntrance } from './useRevealEntrance';
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
    /** AN4：自动折叠延后等待（排空 settle 订阅 + 硬顶定时器）的清理句柄 */
    const collapseWaitCleanupRef = useRef<(() => void) | null>(null);
    const cancelCollapseWait = useCallback(() => {
      collapseWaitCleanupRef.current?.();
      collapseWaitCleanupRef.current = null;
    }, []);

    const groupToolIds = useMemo(() => {
      const ids: string[] = [];
      for (const item of items) {
        if (item.kind === 'single') ids.push(item.tc.id);
        else for (const t of item.tools) ids.push(t.id);
      }
      return ids;
    }, [items]);

    /** 组内最近一次工具事件时间戳（入场实况门判定用） */
    const groupEventTs = useMemo(() => {
      let latest = 0;
      for (const item of items) {
        const tools = item.kind === 'single' ? [item.tc] : item.tools;
        for (const t of tools) {
          latest = Math.max(latest, t.completedAt ?? 0, t.startedAt ?? 0);
        }
      }
      return latest || undefined;
    }, [items]);

    // 组级折叠门槛：仅 ≥2 个工具才聚合为单行摘要（总方案 §终态收敛「单工具则直出展开」、
    // 分段详案 S08）。单工具的摘要（「已运行 1 条命令」）与工具行同为 24px 单行，
    // 却会抹掉意图说明与真实命令——单工具直接渲染工具行，详情仍由工具行自身默认折叠。
    const isGroupFolding = metrics.toolCount >= 2;

    // AN4：组头形成入场（聚合形成的那一帧淡入；结构「更换」保留——
    // 单工具行降级/升级为组时容器换挂即播，不做高度动画避免与手风琴叠播）
    const groupEntrance = useRevealEntrance({
      key: isGroupFolding ? `group:${_msgId}:${groupToolIds[0] ?? ''}` : '',
      eventTs: groupEventTs,
    });

    // 默认折叠；当前正在运行则直出展开。
    // （R4b：原「含子代理强制展开（铁律四）」已删——分派在组合根被提取为
    //  独立卡片，工具组内不再出现子代理调用，无强展豁免。）
    const [isExpanded, setIsExpanded] = useState<boolean>(
      () => defaultExpanded || metrics.hasRunning
    );

    // HC1/F1：组体滚动宿主的边缘渐隐四态——经 ScrollFadeRegion 组件
    // 接入（宿主 JSX 见渲染段；active=isExpanded 透传状态机开关）。
    // （C1 审计 D-1 恢复：本接线曾被旧基线整文件覆盖致接线丢失、在此
    //  重落；F1 组件化后由 hc1.contract 的组件契约 + 宿主存在断言守卫。）

    // 流式执行中进入 running 时保持展开；全部工具执行完毕后自动收敛折叠（用户手动切换除外）
    useEffect(() => {
      const wasRunning = prevHasRunningRef.current;
      prevHasRunningRef.current = metrics.hasRunning;
      if (metrics.hasRunning) {
        cancelCollapseWait();
        setIsExpanded(true);
      } else if (wasRunning && !userInteractedRef.current && !defaultExpanded) {
        const performCollapse = () => {
          const currentHeight =
            innerRef.current?.getBoundingClientRect().height ?? 0;
          setTransitionDuration(calcAccordionDuration(currentHeight, false));
          triggerViewportRecovery();
          setIsExpanded(false);
          onInvalidate?.();
        };
        // AN4 协调段：组内输出仍在排空揭示时，自动折叠延后至排空
        // settle 后再启动（用户在未读完时不会被折叠抢走内容）；硬顶
        // = 排空总时长上限，与时长公式同源。等待期间用户若已切换
        // 过展开态（userInteractedRef 在 toggle 委托里同步置位），
        // 触发时复查并放弃本次自动折叠。
        const pendingDrains = groupToolIds.filter((id) =>
          hasActiveToolDrain(id)
        );
        if (pendingDrains.length === 0) {
          performCollapse();
        } else {
          cancelCollapseWait();
          let fired = false;
          const fire = () => {
            if (fired) return;
            fired = true;
            cancelCollapseWait();
            if (!userInteractedRef.current && !defaultExpanded) {
              performCollapse();
            }
          };
          const unsubscribe = onAllToolDrainsSettled(pendingDrains, fire);
          const timer = setTimeout(fire, AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS);
          collapseWaitCleanupRef.current = () => {
            unsubscribe();
            clearTimeout(timer);
          };
        }
      }
    }, [
      metrics.hasRunning,
      defaultExpanded,
      onInvalidate,
      triggerViewportRecovery,
      groupToolIds,
      cancelCollapseWait,
    ]);

    // AN4：卸载时取消未决的自动折叠等待
    useEffect(() => {
      return () => {
        collapseWaitCleanupRef.current?.();
        collapseWaitCleanupRef.current = null;
      };
    }, []);

    const handleToggle = useCallback(() => {
      // AN4：用户切换即取消未决的排空后自动折叠（人的操作优先）
      cancelCollapseWait();
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
    }, [onInvalidate, triggerViewportRecovery, cancelCollapseWait]);

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
        className={`${styles.groupContainer}${groupEntrance.entering ? ` ${styles.groupEnter}` : ''}`}
        data-testid="foldable-tool-group"
        data-expanded={isExpanded ? 'true' : 'false'}
        data-entering={groupEntrance.entering ? 'true' : undefined}
        onAnimationEnd={groupEntrance.handleAnimationEnd}
        onFocusCapture={handleFocusCapture}
        style={accordionDurationStyle(transitionDuration)}
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
          <span className={styles.summaryLabel}>
            <NumericText text={summaryText} />
          </span>
          {metrics.errorCount > 0 && (
            <Tooltip content={`包含 ${metrics.errorCount} 个执行错误`}>
              <span
                className={styles.errorBadge}
                data-testid="tool-group-error-badge"
              >
                <AppIcon name="alert-triangle" size={12} aria-hidden />
                <span data-testid="tool-group-error-count">
                  <NumericText text={String(metrics.errorCount)} />
                </span>
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
          onTransitionEnd={handleTransitionEnd}
        >
          <ScrollFadeRegion
            ref={innerRef}
            active={isExpanded}
            className={`${styles.groupBodyInner} tool-group-scroll-host`}
          >
            <ChatToolStack {...hostProps} />
          </ScrollFadeRegion>
        </div>
      </div>
    );
  }
);

FoldableToolGroup.displayName = 'FoldableToolGroup';
