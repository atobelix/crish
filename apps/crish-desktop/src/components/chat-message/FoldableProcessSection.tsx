/**
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.tsx
 *
 * 过程段平铺渲染容器（00-design-lock §0.2 / §2-D2 / §3-V1 裁决）：
 * 彻底切除外层「处理过程 / 已完成」手风琴控制栏与大折叠壳；
 * 本组件降级为纯透明线性平铺容器，直接渲染内部的意图组（FoldableToolGroup）与思考行，
 * 绝不再对整组工具做二次包裹与外层折叠。
 */

import * as React from 'react';

import type {
  AssistantTimelineItem,
  ProcessSegmentMetrics,
} from '../../api/toolPresentation';
import { ScrollFadeRegion } from '@/components/ui';
import {
  extractLatestLine,
  stripInlineMarkdownMarkers,
} from '../chat-message-row/ReasoningRow';
import {
  LiveThoughtTickerProvider,
  type LiveThoughtTickerValue,
} from './liveThoughtTickerContext';
import styles from './FoldableProcessSection.module.css';

export interface FoldableProcessSectionProps {
  /** 宿主消息唯一 ID */
  msgId?: string;
  /** 分段唯一稳定键（由 seg.id 传入，格式 `${msgId}-proc-${index}`） */
  sectionId: string;
  /** 该组包含的子项（thought / tools / 组内叙述行 text） */
  items: AssistantTimelineItem[];
  /** 该分段聚合指标（SSOT: processMetricsEngine.aggregateProcessMetrics） */
  metrics?: ProcessSegmentMetrics;
  /** 段起始时间戳（毫秒） */
  startTime?: number;
  /** 段结束时间戳（毫秒） */
  endTime?: number;
  /** 控制栏是否承载「工作时间」文案（平铺容器保留属性兼容契约） */
  showWorkTime?: boolean;
  /** 当前分段是否展开（平铺容器保留属性兼容契约） */
  isExpanded?: boolean;
  /** 是否允许折叠（平铺容器保留属性兼容契约） */
  isFoldable?: boolean;
  /**
   * 【R9 组级窗口化】组体延迟挂载时的占位高度（px）。
   * 设置时组体以等高占位替代条目渲染；宿主在占位进入预热区后
   * 撤除本 prop（传 undefined）真实挂载。
   */
  deferredBodyHeight?: number;
  /** 组体占位元素的注册回调（宿主 IntersectionObserver 观察用） */
  bodyPlaceholderRef?: (el: HTMLElement | null) => void;
  /** 段是否处于流式活跃执行态 */
  isLive?: boolean;
  /** 展开/折叠状态翻转回调 */
  onToggle?: (sectionId: string, nextExpanded: boolean) => void;
  /** 检索命中或外部命令要求单向展开回调 */
  onExpand?: (sectionId: string) => void;
  /** 子项渲染函数（透传 ProcessItemRenderer） */
  renderItem: (item: AssistantTimelineItem, index: number) => React.ReactNode;
  /** 测高作废函数（由宿主统一注入） */
  onInvalidateActual?: (msgId: string) => void;
  /** 自定义类名 */
  className?: string;
}

export const FoldableProcessSection: React.FC<FoldableProcessSectionProps> =
  React.memo(function FoldableProcessSection({
    sectionId,
    items,
    deferredBodyHeight,
    bodyPlaceholderRef,
    renderItem,
    isLive,
    className = '',
  }) {
    // 运行态思考承载（2026-11-06 第 9 条）：段 live 且同时含思考与工具时，
    // 段内最后一个思考项的最新行经 context 交组头 ticker 统一呈现，
    // 思考行自身转静态标签（hosted），全段只留一条动态面。
    const liveThoughtValue = React.useMemo<LiveThoughtTickerValue>(() => {
      if (!isLive) return { line: null, hosted: false, sectionLive: false };
      let thought: string | null = null;
      let hasTools = false;
      for (const item of items) {
        if (item.kind === 'tools') hasTools = true;
        if (item.kind === 'thought' && item.content?.trim()) {
          thought = item.content;
        }
      }
      if (!thought) return { line: null, hosted: false, sectionLive: true };
      const line =
        stripInlineMarkdownMarkers(extractLatestLine(thought)) || null;
      return { line, hosted: hasTools && line !== null, sectionLive: true };
    }, [items, isLive]);

    return (
      <div
        className={`${styles.section} ${className}`}
        data-process-segment={sectionId}
      >
        <LiveThoughtTickerProvider value={liveThoughtValue}>
          <ScrollFadeRegion
            active={true}
            className={styles.sectionBodyInner}
            innerClassName={styles.sectionFadeInner}
            data-testid={`process-slot-${sectionId}`}
          >
            {deferredBodyHeight != null ? (
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
            )}
          </ScrollFadeRegion>
        </LiveThoughtTickerProvider>
      </div>
    );
  });

FoldableProcessSection.displayName = 'FoldableProcessSection';
