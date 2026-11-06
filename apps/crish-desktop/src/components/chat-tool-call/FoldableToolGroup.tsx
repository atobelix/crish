/**
 * apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx
 *
 * 意图组容器组件（P4 方案 & M-01 静态身份确定律 & F3 任务 A/B）。
 * 废除 toolCount >= 2 门槛，从第 1 项起恒定渲染组头 + 组体，杜绝 DOM 裂变跳动。
 * 组头视觉：12×12 槽内居中 6px 组级聚合状态点（蓝脉冲 / 红 / 橙 / 绿），彻底移除 14px 类别图标。
 * 组头文本：自然语言意图标题与 24px 垂直步进 Ticker 轮播（ΔH ≡ 0，绝不触发虚拟测高失效）。
 * 展开状态与用户意图全量提升至会话级账本（useChatMessageState），拆除 900ms 误杀定时器。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { ProcessSegmentMetrics } from '../../api/tool-presentation/toolPresentationTypes';
import { aggregateProcessMetrics } from '../../api/tool-presentation/processMetricsEngine';
import { ScrollFadeRegion, Tooltip } from '@/components/ui';
import { ChatToolStack, type ChatToolStackProps } from './ChatToolCallBlock';
import { getActiveVsm } from '../../store/storeAccess';
import {
  calcAccordionDuration,
  accordionDurationStyle,
  DURATION_ACCORDION_MS,
} from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import { useRevealEntrance } from './useRevealEntrance';
import {
  AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS,
  hasActiveToolDrain,
  onAllToolDrainsSettled,
} from './toolRevealState';
import { stripReferencesToPlainText } from './Reference';
import { useHeaderTicker } from './useHeaderTicker';
import { useLiveThoughtTicker } from '../chat-message/liveThoughtTickerContext';
import {
  useGroupExpanded,
  markGroupUserInteracted,
  isGroupUserInteracted,
} from '../chat-message-list/useChatMessageState';
import type { MessageToolCall } from '../../store/types';
import styles from './FoldableToolGroup.module.css';

export interface FoldableToolGroupProps {
  items: ToolRenderItem[];
  msgId: string;
  hostProps: ChatToolStackProps;
  /** 外部传入的自然语言意图组标题 */
  groupTitle?: string;
  /** 组封口信号（来自状态机或回合结束） */
  isSealed?: boolean;
  onInvalidate?: () => void;
  defaultExpanded?: boolean;
  groupId?: string;
}

export const FoldableToolGroup: React.FC<FoldableToolGroupProps> = React.memo(
  function FoldableToolGroup({
    items,
    msgId: _msgId,
    hostProps,
    groupTitle,
    isSealed,
    onInvalidate,
    defaultExpanded = false,
    groupId,
  }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const headerRef = useRef<HTMLDivElement | null>(null);
    const slotRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isInitialMount = useRef(true);
    const [transitionDuration, setTransitionDuration] = useState<number>(
      DURATION_ACCORDION_MS
    );
    const animLockReleaseRef = useRef<(() => void) | null>(null);

    const acquireMotionLock = useCallback(
      (duration: number) => {
        if (hostProps?.activeSessionId) {
          const vsm = getActiveVsm(hostProps.activeSessionId);
          if (animLockReleaseRef.current) {
            animLockReleaseRef.current();
          }
          animLockReleaseRef.current =
            vsm?.acquireAccordionMotionLock(duration + 60) ?? null;
        }
      },
      [hostProps?.activeSessionId]
    );

    useEffect(() => {
      return () => {
        if (animLockReleaseRef.current) {
          animLockReleaseRef.current();
          animLockReleaseRef.current = null;
        }
      };
    }, []);

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

    const groupToolIds = useMemo(() => {
      const ids: string[] = [];
      for (const item of items) {
        if (item.kind === 'single') ids.push(item.tc.id);
        else for (const t of item.tools) ids.push(t.id);
      }
      return ids;
    }, [items]);

    const allTools = useMemo(() => {
      const result: MessageToolCall[] = [];
      for (const item of items) {
        if (item.kind === 'single') result.push(item.tc);
        else if (item.kind === 'group') result.push(...item.tools);
      }
      return result;
    }, [items]);

    /** 解析当前组稳定 groupId（M-01 静态身份确定律） */
    const resolvedGroupId = useMemo(() => {
      if (groupId && groupId.trim()) return groupId.trim();
      for (const item of items) {
        if (item.kind === 'group') {
          if (item.groupId && item.groupId.trim()) return item.groupId.trim();
          if (item.id && item.id.trim()) return item.id.trim();
        }
        if (item.kind === 'single' && item.tc?.id) {
          return item.tc.id;
        }
      }
      return groupToolIds[0] || 'default-group';
    }, [groupId, items, groupToolIds]);

    const effectiveSessionId = hostProps?.activeSessionId || '_';

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

    // AN4：组头形成入场动效（统一入场通道 grow 变体，2026-11-06 收口
    // 跟进接入）：fade 之外根高度自 0 同步生长到自然高，时长由通道钩子
    // 内部以 calcAccordionDuration 按高度推导，与手风琴折叠族同口径；
    // 生长只作用于组根自身高度，不经过 ticker 门禁链与封口收敛链。
    const groupEntrance = useRevealEntrance({
      key: `group:${_msgId}:${groupToolIds[0] ?? ''}`,
      eventTs: groupEventTs,
      variant: 'grow',
    });

    // grow 需驱动根元素高度：把通道 rootRef 与既有 containerRef
    // （视口保护用）合成同一回调 ref，两边都登记。
    const entranceRootRef = groupEntrance.rootRef;
    const groupRootRef = useCallback(
      (el: HTMLDivElement | null) => {
        containerRef.current = el;
        entranceRootRef(el);
      },
      [entranceRootRef]
    );

    // 运行态默认折叠（用户裁决 2026-11-06 第 8 条，取代旧「视线保护」）：
    // 运行/排空/未封口信号一律不得把组撑开——展开状态只由用户交互
    // （账本）与显式 defaultExpanded 决定，运行中 items 增减不改变它。
    // 故此处不再向账本回退注入 hasRunning（旧口径曾以其为 fallback 顶开组）。
    const isLiveUnsealed = isSealed === false;

    // 会话级账本读取：彻底移除内部 useState 与 userInteractedRef（F3 §根因 1 & 2）
    const [isExpanded, setIsExpanded] = useGroupExpanded(resolvedGroupId, {
      sessionId: effectiveSessionId,
      defaultExpanded,
    });

    const prevExpandedRef = useRef(isExpanded);
    useEffect(() => {
      if (prevExpandedRef.current !== isExpanded) {
        prevExpandedRef.current = isExpanded;
        if (!isExpanded) {
          triggerViewportRecovery();
        }
        const currentHeight =
          innerRef.current?.getBoundingClientRect().height ?? 0;
        const dur = calcAccordionDuration(currentHeight, isExpanded);
        setTransitionDuration(dur);
        acquireMotionLock(dur);
        onInvalidate?.();
      }
    }, [isExpanded, triggerViewportRecovery, acquireMotionLock, onInvalidate]);

    /** AN4：自动折叠延后等待（排空 settle 订阅 + 硬顶定时器）的清理句柄 */
    const collapseWaitCleanupRef = useRef<(() => void) | null>(null);
    const cancelCollapseWait = useCallback(() => {
      collapseWaitCleanupRef.current?.();
      collapseWaitCleanupRef.current = null;
    }, []);

    useEffect(() => {
      return () => {
        collapseWaitCleanupRef.current?.();
        collapseWaitCleanupRef.current = null;
      };
    }, []);

    const firstToolId = groupToolIds[0];

    // 查询用户是否曾与该组手动交互：优先查询 resolvedGroupId，以 firstToolId 兜底（防换锚孤儿化）
    const userHasInteracted =
      isGroupUserInteracted(effectiveSessionId, resolvedGroupId) ||
      Boolean(firstToolId && isGroupUserInteracted(effectiveSessionId, firstToolId));

    const prevHasRunningRef = useRef(metrics.hasRunning);
    // 封口收敛原则：不在 hasRunning 变 false 的瞬间折叠。
    // 只有当工具组封口且非 running 时才执行自动收敛折叠（用户手动切换除外）。
    // 运行期组恒折叠（2026-11-06 第 8 条），本效应只负责封口一刻把
    // 非交互路径（如 defaultExpanded）留下的展开态收敛回折叠。
    useEffect(() => {
      const wasRunning = prevHasRunningRef.current;
      prevHasRunningRef.current = metrics.hasRunning;
      if (metrics.hasRunning || isLiveUnsealed) {
        cancelCollapseWait();
      } else {
        // 视线保护核心门禁：
        // 1. 若显式传入 isSealed（生产环境真实状态）：严格要求 isSealed === true，在流式运行期（isSealed === false）绝不折叠！
        // 2. 若未显式传入 isSealed（单测模拟场景）：仅在 wasRunning 存在时兼容触发
        const canCollapseBySealed = isSealed !== undefined ? isSealed : wasRunning;

        if (canCollapseBySealed && !userHasInteracted && !defaultExpanded) {
          // 封口收敛（2026-11-06 第 8 条）：运行态默认折叠后组在封口时本就
          // 折叠，≤3 工具不再有「保持展开」特例（旧 UX-04 以 setIsExpanded
          // 强行顶开，与「完成态折叠为主」冲突，物理删除）；少量工具组
          // 无需收敛动作，大组若因非交互路径处于展开态仍在此收敛折叠。
          if (allTools.length <= 3) {
            return;
          }
          const performCollapse = () => {
            if (!userHasInteracted && !defaultExpanded) {
              setIsExpanded(false);
            }
          };
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
              if (!userHasInteracted && !defaultExpanded) {
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
      }
    }, [
      metrics.hasRunning,
      isLiveUnsealed,
      isSealed,
      defaultExpanded,
      userHasInteracted,
      groupToolIds,
      allTools.length,
      cancelCollapseWait,
      setIsExpanded,
    ]);

    // 子工具行的展开交互通过回调向上冒泡，标记 markGroupUserInteracted(groupId)（F3 §4.2）
    const wrappedHostProps = useMemo((): ChatToolStackProps => {
      return {
        ...hostProps,
        onToggleTool: (toolId: string, currentlyOpen: boolean, toolMsgId?: string) => {
          cancelCollapseWait();
          markGroupUserInteracted(effectiveSessionId, resolvedGroupId, true);
          hostProps.onToggleTool?.(toolId, currentlyOpen, toolMsgId);
        },
      };
    }, [hostProps, effectiveSessionId, resolvedGroupId, cancelCollapseWait]);

    const handleToggle = useCallback(() => {
      cancelCollapseWait();
      setIsExpanded((prev) => !prev);
    }, [cancelCollapseWait, setIsExpanded]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleToggle();
        }
      },
      [handleToggle]
    );

    // 无障碍键盘聚焦穿透
    const handleFocusCapture = useCallback(
      (e: React.FocusEvent) => {
        if (isExpanded) return;
        if (headerRef.current?.contains(e.target as Node)) return;
        setIsExpanded(true);
        onInvalidate?.();
      },
      [isExpanded, onInvalidate, setIsExpanded]
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
          collapseTimerRef.current = setTimeout(() => {
            if (!isExpanded && slotRef.current) {
              slotRef.current.setAttribute('hidden', 'until-found');
            }
          }, transitionDuration);
        }
      }
      isInitialMount.current = false;
    }, [isExpanded, transitionDuration]);

    const handleTransitionEnd = useCallback(
      (e: React.TransitionEvent<HTMLDivElement>) => {
        if (e.target !== slotRef.current) return;
        if (e.propertyName === 'grid-template-rows') {
          if (animLockReleaseRef.current) {
            animLockReleaseRef.current();
            animLockReleaseRef.current = null;
          }
          if (!isExpanded) {
            if (collapseTimerRef.current) {
              clearTimeout(collapseTimerRef.current);
              collapseTimerRef.current = null;
            }
            slotRef.current?.setAttribute('hidden', 'until-found');
          }
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
    }, [onInvalidate, setIsExpanded]);

    // 组级自然语言标题解析：优先消费传入的 groupTitle；其次消费组内首个工具意图；最后回退
    const resolvedGroupTitle = useMemo(() => {
      if (groupTitle && groupTitle.trim()) {
        return groupTitle.trim();
      }
      for (const item of items) {
        if (item.kind === 'group' && item.label) {
          return item.label;
        }
        const tools = item.kind === 'single' ? [item.tc] : item.tools;
        for (const t of tools) {
          if (t.group && t.group.trim()) {
            return t.group.trim();
          }
          if (t.intent && t.intent.trim()) {
            return stripReferencesToPlainText(t.intent);
          }
        }
      }
      return '处理过程';
    }, [groupTitle, items]);

    // 运行态思考承载（2026-11-06 第 9 条）：段级 context 提供的当前思考行
    // 只注入 live 的组（已封口的同段子组不承载，保持静态标题）
    const { line: liveThoughtLine, sectionLive } = useLiveThoughtTicker();

    // 组级 live 判定：显式 isSealed 优先；缺失（undefined，单项领衔组块
    // 在 MessageToolCallsSection 取不到组封口信号）时回退段级 live 信号。
    // 缺此回退，这类组运行中不轮播、思考不入列、封口时索引不收敛。
    const tickerIsLive =
      isSealed !== undefined ? isSealed === false : sectionLive;

    // 组标题行意图滚动摘要钩子（F3 任务 B）
    const {
      items: tickerItems,
      currentText: currentTickerText,
      transformStyle,
      pause: pauseTicker,
      resume: resumeTicker,
    } = useHeaderTicker({
      groupTitle: resolvedGroupTitle,
      tools: allTools,
      hasRunning: metrics.hasRunning,
      isSealed,
      isExpanded,
      thoughtLine: tickerIsLive ? liveThoughtLine : null,
      isLive: tickerIsLive,
    });

    // 组级聚合状态仲裁（P4 §8.2：P0 运行蓝脉冲 > P1 失败红 > P2 审批橙 > P3 成功绿）
    const aggregateStatus = useMemo<'running' | 'error' | 'pending' | 'success'>(() => {
      let hasError = false;
      let hasPending = false;
      for (const item of items) {
        const tools = item.kind === 'single' ? [item.tc] : item.tools;
        for (const t of tools) {
          if (t.status === 'running') return 'running';
          if (t.status === 'error') hasError = true;
          if (t.status === 'pending_approval') hasPending = true;
        }
      }
      if (hasError) return 'error';
      if (hasPending) return 'pending';
      return 'success';
    }, [items]);

    const renderGroupStatusDot = () => {
      switch (aggregateStatus) {
        case 'running':
          return <span className={styles.toolPulseDot} aria-hidden="true" />;
        case 'error':
          return <span className={styles.toolErrorDot} aria-hidden="true" />;
        case 'pending':
          return <span className={styles.toolPendingDot} aria-hidden="true" />;
        default:
          return <span className={styles.toolSuccessDot} aria-hidden="true" />;
      }
    };

    const statusZh = useMemo(() => {
      switch (aggregateStatus) {
        case 'running':
          return '运行中';
        case 'error':
          return '失败';
        case 'pending':
          return '待确认';
        default:
          return '已完成';
      }
    }, [aggregateStatus]);

    // J9 裁决：彻底去除「共 N 项工具」统计，保持与无统计红线一致
    const groupAriaLabel = `${statusZh}：${resolvedGroupTitle}，按 Enter 或空格${isExpanded ? '折叠' : '展开'}`;

    return (
      <div
        ref={groupRootRef}
        className={`${styles.groupContainer}${groupEntrance.entering ? ` ${styles.groupEnter}` : ''}`}
        data-testid="foldable-tool-group"
        data-expanded={isExpanded ? 'true' : 'false'}
        data-entering={groupEntrance.entering ? 'true' : undefined}
        onAnimationEnd={groupEntrance.handleAnimationEnd}
        onFocusCapture={handleFocusCapture}
        style={{
          ...accordionDurationStyle(transitionDuration),
          // 入场通道修复（2026-11-06 动效统一封装批）：groupEntrance 的
          // 交错 delayMs 此前从未写入 --reveal-delay，.groupEnter 的
          // animation-delay 恒读缺省 0ms——此处补齐，口径与通道一致。
          ...(groupEntrance.entering
            ? ({
                '--reveal-delay': `${groupEntrance.delayMs}ms`,
              } as React.CSSProperties)
            : null),
        }}
      >
        <div
          ref={headerRef}
          className={styles.groupHeader}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={groupAriaLabel}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          onMouseEnter={pauseTicker}
          onMouseLeave={resumeTicker}
          onFocusCapture={pauseTicker}
          onBlurCapture={resumeTicker}
        >
          {/* 12×12 槽内居中 6px 聚合状态点，杜绝 14px 类别图标 */}
          <span className={styles.groupSlotIco} aria-hidden="true">
            {renderGroupStatusDot()}
          </span>
          {/* 展开态显示静态 groupTitle 文本，停止轮播；折叠态展示 24px 视口垂直轮播 */}
          {isExpanded ? (
            <Tooltip content={resolvedGroupTitle}>
              <span className={styles.summaryLabel}>{resolvedGroupTitle}</span>
            </Tooltip>
          ) : (
            <Tooltip content={currentTickerText}>
              <div className={styles.tickerViewport} aria-hidden="true">
                <div
                  className={`${styles.tickerTrack} ${styles.tickerTrackAnimated}`}
                  style={transformStyle}
                >
                  {tickerItems.map((item) => (
                    <div
                      key={item.id}
                      className={`${styles.tickerCell} ${styles.summaryLabel}`}
                    >
                      <span className={styles.tickerCellText}>{item.text}</span>
                      {/* S1b：chevron 进每个 ticker 单元格、紧跟该格文本之后 */}
                      <span
                        className={styles.chevron}
                        aria-hidden="true"
                        data-testid="tool-group-ticker-chevron"
                      >
                        &#8250;
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Tooltip>
          )}
          {/* S1b：行尾 chevron 只在展开态渲染——折叠态 chevron 已进各 ticker
              单元格，此处再渲染会成双 chevron；展开态恒为旋转 90° */}
          {isExpanded ? (
            <span
              className={`${styles.chevron} ${styles.rot}`}
              aria-hidden="true"
              data-testid="tool-group-chevron"
            >
              &#8250;
            </span>
          ) : null}
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
            <ChatToolStack {...wrappedHostProps} />
          </ScrollFadeRegion>
        </div>
      </div>
    );
  }
);

FoldableToolGroup.displayName = 'FoldableToolGroup';
