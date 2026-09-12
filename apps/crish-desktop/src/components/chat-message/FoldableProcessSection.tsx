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
 *   - 【铁律四】`forceExpanded` 段禁用收起交互、且永不挂载 `hidden`。
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AssistantTimelineItem, ProcessSegmentMetrics } from '../../api/toolPresentation';
import {
  buildSlotId,
  DOMINANT_ICON_MAP,
} from '../../api/tool-presentation/toolPresentationTypes';
import {
  arbitrateLeadAction,
  formatProcessControlLabel,
} from '../../api/tool-presentation/processMetricsEngine';
import { AppIcon, type IconName } from '../ui/icons';
import styles from './FoldableProcessSection.module.css';

export interface FoldableProcessSectionProps {
  /** 宿主消息唯一 ID */
  msgId: string;
  /** 分段唯一稳定键（由 seg.id 传入，格式 `${msgId}-proc-${index}`） */
  sectionId: string;
  /** 该分段包含的子项（仅 thought / tools / injection） */
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
  /** 【铁律四】强制展开段（subagent）。true 时收起交互须被禁用 */
  forceExpanded?: boolean;
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
const SectionLeadIcon: React.FC<{ metrics: ProcessSegmentMetrics }> = React.memo(
  function SectionLeadIcon({ metrics }) {
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
  }
);

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
export const FoldableProcessSection: React.FC<FoldableProcessSectionProps> = React.memo(
  function FoldableProcessSection({
    msgId,
    sectionId,
    items,
    metrics,
    startTime,
    endTime,
    showWorkTime,
    isExpanded,
    isFoldable,
    forceExpanded = false,
    isLive = false,
    onToggle,
    onExpand,
    renderItem,
    onInvalidateActual,
    className = '',
  }) {
    const slotId = useMemo(() => buildSlotId(sectionId), [sectionId]);
    const bodyId = `${slotId}-body`;
    const slotRef = useRef<HTMLDivElement | null>(null);

    // 展开态：强制展开段恒为展开（用户级状态不得覆盖）
    const expanded = forceExpanded ? true : isExpanded;

    // 隐藏判定：可折叠 && 未展开 && 非强制展开
    const isHidden = isFoldable && !expanded && !forceExpanded;

    // ── Callback Ref：原生操纵 hidden 属性 ──
    const setSlotRef = useCallback(
      (el: HTMLDivElement | null) => {
        slotRef.current = el;
        if (!el) return;
        if (isHidden) {
          el.setAttribute('hidden', 'until-found');
        } else {
          el.removeAttribute('hidden');
        }
      },
      [isHidden]
    );

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
    const elapsedMs = useSectionElapsedMs(startTime, endTime, isLive, metrics.totalDurationMs);

    /**
     * 控制栏文案：工作时间优先，单元素段退化为极简语义标签。
     * 【用户裁决】此处即原「已深度思考」所在位置 —— 现在只承载工作时间。
     */
    const summaryText = useMemo(
      () => formatProcessControlLabel(metrics, showWorkTime, elapsedMs, isLive),
      [metrics, showWorkTime, elapsedMs, isLive]
    );

    const handleToggle = useCallback(() => {
      // 铁律四：强制展开段不接受收起
      if (forceExpanded) return;
      onToggle(sectionId, !expanded);
    }, [forceExpanded, onToggle, sectionId, expanded]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (forceExpanded) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(sectionId, !expanded);
        }
      },
      [forceExpanded, onToggle, sectionId, expanded]
    );

    const controlInteractive = isFoldable && !forceExpanded;

    return (
      <div
        className={`${styles.section} ${className}`}
        data-process-segment={sectionId}
        data-force-expanded={forceExpanded ? 'true' : 'false'}
        data-foldable={isFoldable ? 'true' : 'false'}
        data-expanded={expanded ? 'true' : 'false'}
      >
        {/* 控制栏：主导图标 + 工作时间 + 折叠指示（工作时间即原「已深度思考」位置） */}
        <div
          className={`${styles.controlBar} ${controlInteractive ? '' : styles.controlBarStatic}`}
          role={controlInteractive ? 'button' : undefined}
          tabIndex={controlInteractive ? 0 : undefined}
          aria-expanded={controlInteractive ? expanded : undefined}
          aria-controls={controlInteractive ? bodyId : undefined}
          aria-disabled={forceExpanded ? 'true' : undefined}
          data-live={isLive ? 'true' : 'false'}
          data-testid={`process-toggle-${sectionId}`}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          style={controlInteractive ? undefined : { cursor: 'default' }}
        >
          {!showWorkTime && <SectionLeadIcon metrics={metrics} />}
          <span className={styles.summaryLabel}>{summaryText}</span>
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
          data-testid={`process-slot-${sectionId}`}
        >
          {items.map((item, index) => (
            <React.Fragment key={item.key}>{renderItem(item, index)}</React.Fragment>
          ))}
        </div>
      </div>
    );
  }
);

FoldableProcessSection.displayName = 'FoldableProcessSection';
