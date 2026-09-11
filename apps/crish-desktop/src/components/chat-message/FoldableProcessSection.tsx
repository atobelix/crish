/**
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.tsx
 *
 * 正文间独立分段折叠容器
 *   ① 顶部：时间胶囊（dashed hairline 居中），仅在「非空过程段」显示
 *      - 运行中：跳秒
 *      - 终态  ：「工作 xx 时间」（xx 可为秒 / 分秒）
 *   ② 33px 发丝底线控制栏：图标 + 摘要文案 + 折叠指示
 *   ③ 内容槽：DOM 常驻，折叠时挂 `hidden="until-found"`
 *      - 同段内的思考 / 工具间间距 0
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
  formatSegmentSummary,
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
   * 缺省时不显示顶部时间胶囊。
   */
  startTime?: number;
  /**
   * 段结束时间戳（毫秒）。当段处于终态时存在，用于定格「工作 xx 时间」。
   * 缺省 + isLive=true 时，胶囊跳秒；终态时退化为以 totalDurationMs 推算。
   */
  endTime?: number;
  /**
   * 顶部「工作时间胶囊 + 虚线分割」是否显示（SSOT 裁决，禁止本地重推导）。
   * 单思考 / 单工具调用段为 false —— 工作时间区域与分割线一律不显示。
   */
  showTimeCapsule: boolean;
  /** 当前分段是否展开（受控） */
  isExpanded: boolean;
  /** 是否允许折叠（透传 seg.foldable，禁止调用方本地推导） */
  isFoldable: boolean;
  /** 【铁律四】强制展开段（subagent）。true 时收起交互须被禁用 */
  forceExpanded?: boolean;
  /**
   * 段是否处于流式活跃执行态。
   * true → 顶部胶囊跳秒；false → 顶部胶囊定格为「工作 xx 时间」。
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
 * 把毫秒数格式化为人类可读的「xx 时间」标签（纯函数，可穷举验证）。
 *   - < 60s       → "x.x 秒"
 *   - < 3600s     → "m 分 s 秒"
 *   - 否则         → "h 小时 m 分"
 */
export function formatDurationLabel(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(1)} 秒`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) {
    return `${m} 分 ${s} 秒`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 小时 ${rm} 分`;
}

/**
 * 顶部时间胶囊：居中、虚线分割、**仅显示时间**（不显示「已深度思考」等状态词）。
 *
 * - 运行中（`isLive`）：100ms 跳秒
 * - 终态：定格为「工作 xx 时间」（xx 可为秒 / 分秒 / 时分）
 * - 终态且无法取得有效耗时（<= 0）：不渲染（杜绝「工作 0.0 秒」样式假象）
 */
const SectionTimeCapsule: React.FC<{
  startTime?: number;
  endTime?: number;
  isLive: boolean;
  totalDurationMs: number;
}> = React.memo(function SectionTimeCapsule({
  startTime,
  endTime,
  isLive,
  totalDurationMs,
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    // 100ms 跳秒频率：与 WorkingStatusIndicator 一致
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [isLive]);

  if (!startTime || startTime <= 0) return null;

  const elapsedMs = isLive
    ? Math.max(0, now - startTime)
    : Math.max(0, (endTime ?? startTime + totalDurationMs) - startTime);

  // 终态无有效耗时 → 不渲染（负向断言见 FoldableProcessSection.test.tsx）
  if (!isLive && elapsedMs <= 0) return null;

  const label = isLive ? formatDurationLabel(elapsedMs) : `工作 ${formatDurationLabel(elapsedMs)}`;

  return (
    <div
      className={styles.timeCapsule}
      data-testid="process-time-capsule"
      data-live={isLive ? 'true' : 'false'}
    >
      <span className={styles.timeCapsuleText}>{label}</span>
    </div>
  );
});

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
    showTimeCapsule,
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

    const summaryText = useMemo(() => formatSegmentSummary(metrics), [metrics]);

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
        {/* 顶部时间胶囊：仅在「思考 + 工具 ≥ 2」的过程段显示（SSOT 裁决） */}
        {showTimeCapsule ? (
          <SectionTimeCapsule
            startTime={startTime}
            endTime={endTime}
            isLive={isLive}
            totalDurationMs={metrics.totalDurationMs}
          />
        ) : null}

        {/* 33px 发丝底线控制栏：图标 + 摘要 + 折叠指示 */}
        <div
          className={`${styles.controlBar} ${controlInteractive ? '' : styles.controlBarStatic}`}
          role={controlInteractive ? 'button' : undefined}
          tabIndex={controlInteractive ? 0 : undefined}
          aria-expanded={controlInteractive ? expanded : undefined}
          aria-controls={controlInteractive ? bodyId : undefined}
          aria-disabled={forceExpanded ? 'true' : undefined}
          data-testid={`process-toggle-${sectionId}`}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          style={controlInteractive ? undefined : { cursor: 'default' }}
        >
          <SectionLeadIcon metrics={metrics} />
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
