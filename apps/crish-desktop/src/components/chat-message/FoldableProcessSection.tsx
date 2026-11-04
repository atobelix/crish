/**
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.tsx
 *
 * 正文间独立分段折叠容器
 *   ① 控制栏（无发丝底线）：主导图标 + 工作时间文案 + 折叠指示
 *      - 工作时间即原「已深度思考」所在位置（2026-09-11 用户裁决）
 *      - 运行中：跳秒（裸时长，无前缀）
 *      - 终态  ：「工作 xx 时间」（xx 可为秒 / 分秒 / 时分）
 *   ② 内容槽：DOM 常驻，折叠时挂 `hidden="until-found"`
 *      - 同段内的思考 / 工具间间距 0
 *
 * 【已废除（禁止回潮）】
 *   - 顶部 dashed hairline 工作时间区：用户裁决「带上了这个影响排版」，已物理删除；
 *   - 控制栏底部发丝分割线：同批次裁决移除；
 *   - 「已深度思考」文案：全仓根除。
 *
 * 【架构要点】
 *   - 物理切除 `return null`：折叠时使用原生 `hidden="until-found"`，DOM 节点常驻，
 *     Ctrl+F 页面内搜索可穿透；
 *   - Callback Ref 原生操纵 `hidden` 属性（规避 React 布尔属性反射陷阱——
 *     `hidden={false}` 会移除属性，`hidden="until-found"` 无法通过 JSX 表达）；
 *   - 监听原生 `beforematch`，命中时精准展开该段并作废宿主测高；
 *   - 【R9】段级 `forceExpanded` 已物理删除（铁律四退役完结）：本组件不再有
 *     强制展开形态，展开态完全由宿主受控字典决定；
 *   - 【R9 组级窗口化】宿主可传 `deferredBodyHeight`：组头（控制栏）常驻，
 *     组体先以等高占位替代条目渲染，宿主经 IntersectionObserver 预热后
 *     撤除该 prop 真实挂载组体（单向闩在宿主侧）。
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AssistantTimelineItem,
  ProcessSegmentMetrics,
} from '../../api/toolPresentation';
import {
  buildSlotId,
  DOMINANT_ICON_MAP,
} from '../../api/tool-presentation/toolPresentationTypes';
import {
  arbitrateLeadAction,
  formatProcessControlLabel,
} from '../../api/tool-presentation/processMetricsEngine';
import { AppIcon, type IconName } from '@/components/ui/icons';
import { NumericText, ScrollFadeRegion } from '@/components/ui';
import {
  calcAccordionDuration,
  accordionDurationStyle,
  DURATION_ACCORDION_MS,
} from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import styles from './FoldableProcessSection.module.css';

export interface FoldableProcessSectionProps {
  /** 宿主消息唯一 ID */
  msgId: string;
  /** 分段唯一稳定键（由 seg.id 传入，格式 `${msgId}-proc-${index}`） */
  sectionId: string;
  /** 该组包含的子项（thought / tools / 组内叙述行 text） */
  items: AssistantTimelineItem[];
  /** 该分段聚合指标（SSOT: processMetricsEngine.aggregateProcessMetrics） */
  metrics: ProcessSegmentMetrics;
  /**
   * 段起始时间戳（毫秒），取段内最早子项的 startTime。
   * 缺省时耗时恒为 0，控制栏退化为语义标签。
   */
  startTime?: number;
  /**
   * 段结束时间戳（毫秒）。当段处于终态时存在，用于定格「工作 xx 时间」。
   * 缺省 + 终态时退化为以 totalDurationMs 推算。
   */
  endTime?: number;
  /**
   * 控制栏是否承载「工作时间」文案（SSOT 裁决，禁止本地重推导）。
   * 单思考 / 单工具调用段为 false —— 退化为「思考」/「已运行 N 条命令」。
   */
  showWorkTime: boolean;
  /** 当前分段是否展开（受控） */
  isExpanded: boolean;
  /** 是否允许折叠（透传 seg.foldable，禁止调用方本地推导） */
  isFoldable: boolean;
  /**
   * 【R9 组级窗口化】组体延迟挂载时的占位高度（px）。
   * 设置时组头常驻、组体以等高占位替代条目渲染；宿主在占位进入预热区后
   * 撤除本 prop（传 undefined）真实挂载。未设置时行为与既往完全一致。
   */
  deferredBodyHeight?: number;
  /** 组体占位元素的注册回调（宿主 IntersectionObserver 观察用） */
  bodyPlaceholderRef?: (el: HTMLElement | null) => void;
  /**
   * 段是否处于流式活跃执行态。
   * true → 控制栏跳秒；false → 控制栏定格为「工作 xx 时间」。
   */
  isLive?: boolean;
  /** 展开/折叠状态翻转回调 */
  onToggle: (sectionId: string, nextExpanded: boolean) => void;
  /** 检索命中或外部命令要求单向展开回调 */
  onExpand: (sectionId: string) => void;
  /** 子项渲染函数（透传 ProcessItemRenderer） */
  renderItem: (item: AssistantTimelineItem, index: number) => React.ReactNode;
  /** 测高作废函数（由宿主统一注入） */
  onInvalidateActual?: (msgId: string) => void;
  /** 自定义类名 */
  className?: string;
}

/** 主导动作图标（emoji 已废除，统一经 AppIcon / @hugeicons/core-free-icons 渲染） */
const SectionLeadIcon: React.FC<{ metrics: ProcessSegmentMetrics }> =
  React.memo(function SectionLeadIcon({ metrics }) {
    const leadAction = arbitrateLeadAction(metrics);
    return (
      <AppIcon
        name={DOMINANT_ICON_MAP[leadAction] as IconName}
        size={12}
        className={styles.leadIcon}
        aria-hidden
        data-testid={`process-lead-icon-${leadAction}`}
      />
    );
  });

/**
 * 段耗时计算（唯一口径）。
 *
 * - 运行中（`isLive`）：以 100ms 频率跳秒，取 `now - startTime`；
 * - 终态：定格为 `endTime - startTime`；`endTime` 缺失时退化为
 *   `startTime + totalDurationMs`（由分段器保证终态必有其一）；
 * - 无有效 `startTime` 或耗时为负：恒返回 0（由文案层决定是否展示）。
 */
export function useSectionElapsedMs(
  startTime: number | undefined,
  endTime: number | undefined,
  isLive: boolean,
  totalDurationMs: number
): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    // 100ms 跳秒频率：与 WorkingStatusIndicator 一致
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [isLive]);

  return useMemo(() => {
    if (!startTime || startTime <= 0) {
      return !isLive && totalDurationMs > 0 ? totalDurationMs : 0;
    }
    if (isLive) {
      return Math.max(0, now - startTime);
    }
    if (endTime != null && endTime > startTime) {
      return Math.max(0, endTime - startTime);
    }
    if (totalDurationMs > 0) {
      return totalDurationMs;
    }
    return 0;
  }, [startTime, endTime, isLive, totalDurationMs, now]);
}

/**
 * Slot DOM ID 唯一生成规则由 SSOT 承载（`toolPresentationTypes.buildSlotId`），
 * 本组件仅消费，禁止在此重复定义（防止规则漂移）。
 */
export const FoldableProcessSection: React.FC<FoldableProcessSectionProps> =
  React.memo(function FoldableProcessSection({
    msgId,
    sectionId,
    items,
    metrics,
    startTime,
    endTime,
    showWorkTime,
    isExpanded,
    isFoldable,
    deferredBodyHeight,
    bodyPlaceholderRef,
    isLive = false,
    onToggle,
    onExpand,
    renderItem,
    onInvalidateActual,
    className = '',
  }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const slotId = useMemo(() => buildSlotId(sectionId), [sectionId]);
    const bodyId = `${slotId}-body`;
    const slotRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isInitialMount = useRef(true);
    const [transitionDuration, setTransitionDuration] = useState<number>(
      DURATION_ACCORDION_MS
    );

    // 视口保护
    const { triggerViewportRecovery } = useAccordionViewportGuard(containerRef);

    // 展开态完全由宿主受控字典决定（R9：段级强制展开已删除）
    const expanded = isExpanded;

    // 隐藏判定：可折叠 && 未展开
    const isHidden = isFoldable && !expanded;

    // ── Callback Ref：挂载时原生注入 hidden="until-found" ──
    const setSlotRef = useCallback(
      (el: HTMLDivElement | null) => {
        slotRef.current = el;
        if (!el) return;
        if (isInitialMount.current) {
          if (isHidden) {
            el.setAttribute('hidden', 'until-found');
          } else {
            el.removeAttribute('hidden');
          }
        }
      },
      [isHidden]
    );

    // ── 过渡与 hidden 协同：展开即刻剥离 hidden，收合在 CSS Grid 0fr 过渡完成后挂载 ──
    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }

      if (expanded || !isHidden) {
        el.removeAttribute('hidden');
      } else {
        if (isInitialMount.current) {
          el.setAttribute('hidden', 'until-found');
        } else {
          collapseTimerRef.current = setTimeout(() => {
            if (!expanded && slotRef.current) {
              slotRef.current.setAttribute('hidden', 'until-found');
            }
          }, transitionDuration);
        }
      }
      isInitialMount.current = false;
    }, [expanded, isHidden, transitionDuration]);

    const handleTransitionEnd = useCallback(
      (e: React.TransitionEvent<HTMLDivElement>) => {
        if (e.target !== slotRef.current) return;
        if (e.propertyName === 'grid-template-rows' && isHidden) {
          if (collapseTimerRef.current) {
            clearTimeout(collapseTimerRef.current);
            collapseTimerRef.current = null;
          }
          slotRef.current?.setAttribute('hidden', 'until-found');
        }
      },
      [isHidden]
    );

    useEffect(() => {
      return () => {
        if (collapseTimerRef.current) {
          clearTimeout(collapseTimerRef.current);
        }
      };
    }, []);

    // ── beforematch：Ctrl+F 穿透命中时精准唤醒展开 ──
    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;

      const handleBeforeMatch = () => {
        onExpand(sectionId);
        onInvalidateActual?.(msgId);
      };

      el.addEventListener('beforematch', handleBeforeMatch);
      return () => {
        el.removeEventListener('beforematch', handleBeforeMatch);
      };
    }, [sectionId, msgId, onExpand, onInvalidateActual]);

    // 段耗时：运行中跳秒，终态定格（唯一口径，禁止组件层自行计算）
    const elapsedMs = useSectionElapsedMs(
      startTime,
      endTime,
      isLive,
      metrics.totalDurationMs
    );

    /**
     * 控制栏文案：工作时间优先，单元素段退化为极简语义标签。
     * 【用户裁决】此处即原「已深度思考」所在位置 —— 现在只承载工作时间。
     */
    const summaryText = useMemo(
      () => formatProcessControlLabel(metrics, showWorkTime, elapsedMs, isLive),
      [metrics, showWorkTime, elapsedMs, isLive]
    );

    const handleToggle = useCallback(() => {
      const nextExpanded = !expanded;
      if (!nextExpanded) {
        triggerViewportRecovery();
      }
      // 杜绝同步强读未清洁布局 DOM（Layout Thrashing）：改用纯数学条目估高，封顶 280px
      const estimatedHeight = Math.min(
        280,
        Math.max(100, (items?.length ?? 1) * 44)
      );
      setTransitionDuration(
        calcAccordionDuration(estimatedHeight, nextExpanded)
      );
      onToggle(sectionId, nextExpanded);
    }, [onToggle, sectionId, expanded, triggerViewportRecovery]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleToggle();
        }
      },
      [handleToggle]
    );

    // 组体内容：延迟挂载时以等高占位替代条目渲染（组头常驻，R9 二段式占位）
    const bodyContent =
      deferredBodyHeight != null ? (
        <div
          ref={bodyPlaceholderRef}
          data-testid="process-group-body-placeholder"
          data-section-id={sectionId}
          style={{ height: deferredBodyHeight }}
        />
      ) : (
        items.map((item, index) => (
          <React.Fragment key={item.key}>
            {renderItem(item, index)}
          </React.Fragment>
        ))
      );

    const isSingleThought =
      metrics.thoughtCount === 1 &&
      metrics.toolCount === 0 &&
      metrics.subagentCount === 0;
    const isSingleTool =
      metrics.toolCount === 1 &&
      metrics.thoughtCount === 0 &&
      metrics.subagentCount === 0;

    // 原子单项组（单思考组由 ReasoningRow 自带 24px 独立折叠栏，单工具组由
    // CompactToolRow 自带 24px 独立行头与折叠栏）直接渲染内容槽位，完全卸载
    // 外层控制栏，彻底消除双层折叠套娃。
    // 分段器 hasGroupHeader 判定与此同构（原子单项组穿透豁免）。
    const omitOuterControlBar = isSingleThought || isSingleTool;

    if (omitOuterControlBar) {
      return (
        <div
          ref={containerRef}
          className={`${styles.section} ${className}`}
          data-process-segment={sectionId}
          data-single-thought={isSingleThought ? 'true' : undefined}
          data-single-tool={isSingleTool ? 'true' : undefined}
          data-foldable={isFoldable ? 'true' : 'false'}
          data-expanded={expanded ? 'true' : 'false'}
          style={accordionDurationStyle(transitionDuration)}
        >
          <div
            id={bodyId}
            ref={setSlotRef}
            className={styles.sectionBody}
            data-expanded={expanded ? 'true' : 'false'}
            onTransitionEnd={handleTransitionEnd}
            data-testid={`process-slot-${sectionId}`}
          >
            <ScrollFadeRegion
              ref={innerRef}
              active={expanded}
              className={styles.sectionBodyInner}
              innerClassName={styles.sectionFadeInner}
            >
              {bodyContent}
            </ScrollFadeRegion>
          </div>
        </div>
      );
    }

    const controlInteractive = isFoldable;

    return (
      <div
        ref={containerRef}
        className={`${styles.section} ${className}`}
        data-process-segment={sectionId}
        data-foldable={isFoldable ? 'true' : 'false'}
        data-expanded={expanded ? 'true' : 'false'}
        style={accordionDurationStyle(transitionDuration)}
      >
        {/* 控制栏：主导图标 + 工作时间 + 折叠指示（工作时间即原「已深度思考」位置） */}
        <div
          className={`${styles.controlBar} ${controlInteractive ? '' : styles.controlBarStatic}`}
          role={controlInteractive ? 'button' : undefined}
          tabIndex={controlInteractive ? 0 : undefined}
          aria-expanded={controlInteractive ? expanded : undefined}
          aria-controls={controlInteractive ? bodyId : undefined}
          data-live={isLive ? 'true' : 'false'}
          data-testid={`process-toggle-${sectionId}`}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          style={controlInteractive ? undefined : { cursor: 'default' }}
        >
          {!showWorkTime && <SectionLeadIcon metrics={metrics} />}
          <span className={styles.summaryLabel}>
            {/* 运行中跳秒直出纯文本；落定终态走 NumericText，显式禁止从 0 重滚（animateOnView=false），直接定格 */}
            {isLive ? (
              summaryText
            ) : (
              <NumericText text={summaryText} animateOnView={false} />
            )}
          </span>
          {controlInteractive ? (
            <span
              className={`${styles.chevron} ${expanded ? styles.rot : ''}`}
              aria-hidden="true"
              data-testid={`process-chevron-${sectionId}`}
            >
              &#8250;
            </span>
          ) : null}
        </div>

        {/* 内容槽：DOM 常驻，折叠时挂 hidden="until-found" */}
        <div
          id={bodyId}
          ref={setSlotRef}
          className={styles.sectionBody}
          data-expanded={expanded ? 'true' : 'false'}
          onTransitionEnd={handleTransitionEnd}
          data-testid={`process-slot-${sectionId}`}
        >
          <ScrollFadeRegion
            ref={innerRef}
            active={expanded}
            className={styles.sectionBodyInner}
            innerClassName={styles.sectionFadeInner}
          >
            {bodyContent}
          </ScrollFadeRegion>
        </div>
      </div>
    );
  });

FoldableProcessSection.displayName = 'FoldableProcessSection';
