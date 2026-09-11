/**
 * apps/crish-desktop/src/api/tool-presentation/timelineSegmenter.ts
 *
 * 正文交错过程分段状态机（纯逻辑，无 React 依赖）。
 *
 * 分段以「AI 正文」为天然物理界标：正文之前的思考/工具/注入聚合为一个可折叠过程段，
 * 正文本身作为不可折叠的叙事段平铺常驻。
 *
 * 【四铁律裁决优先级（短路顺序）】
 *   1. 铁律四：subagentCount >= 1 → foldable=true, defaultExpanded=true, forceExpanded=true
 *   2. 铁律一：hasNextText       → foldable=true, defaultExpanded=false
 *   3. 铁律二：isTurnLive        → foldable=true, defaultExpanded=true, isLive=true
 *   4. 铁律三：toolCount >= 2    → foldable=true, defaultExpanded=false
 *              否则              → foldable=false, defaultExpanded=true
 *
 * 【SSOT】权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.2）。
 * 负向红线：禁止在本模块外实现分段逻辑；禁止调用方本地重推导 foldable/forceExpanded。
 */

import type {
  AssistantTimelineItem,
  ProcessTimelineSegment,
  TextTimelineSegment,
  TimelineSegment,
  TimelineTextItem,
} from './toolPresentationTypes';
import { aggregateProcessMetrics } from './processMetricsEngine';

/**
 * 判断单个时间线项是否属于「过程」（思考 / 工具 / 注入）。
 */
function isProcessItem(item: AssistantTimelineItem): boolean {
  return item.kind === 'thought' || item.kind === 'tools' || item.kind === 'injection';
}

/**
 * 判断正文项是否具备实际内容（空正文不作为有效界标）。
 */
function hasTextContent(item: TimelineTextItem): boolean {
  return (item.content || '').trim().length > 0;
}

/**
 * 将线性时间线切割为交错的分段序列。
 *
 * @param msgId       消息唯一 ID（用于生成稳定 sectionId）
 * @param items       已去重的线性时间线项
 * @param isTurnLive  本轮是否处于流式活跃态
 * @param hasStreamText 是否存在流式正文（用于铁律二的补强判定）
 */
export function partitionTimelineSegments(
  msgId: string,
  items: readonly AssistantTimelineItem[],
  isTurnLive: boolean,
  hasStreamText: boolean
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let procIndex = 0;
  let textIndex = 0;

  /** 当前累积的过程项缓冲 */
  let buffer: AssistantTimelineItem[] = [];

  const flushProcessBuffer = (hasNextText: boolean, isLast: boolean): void => {
    if (buffer.length === 0) return;

    const current = buffer;
    buffer = [];

    const metrics = aggregateProcessMetrics(current);

    // ── 铁律四：子代理可见性特权（最高优先级，命中即返回）──
    let foldable: boolean;
    let defaultExpanded: boolean;
    let forceExpanded = false;
    let isLive = false;

    if (metrics.subagentCount >= 1) {
      foldable = true;
      defaultExpanded = true;
      forceExpanded = true;
    } else if (hasNextText) {
      // ── 铁律一：后继存在正文 → 过程履职完毕，收拢 ──
      foldable = true;
      defaultExpanded = false;
    } else if (isTurnLive) {
      // ── 铁律二：尾部流式无正文 → 直出展开 ──
      foldable = true;
      defaultExpanded = true;
      isLive = true;
    } else {
      // ── 铁律三：纯工具终态自收敛 ──
      if (metrics.toolCount >= 2) {
        foldable = true;
        defaultExpanded = false;
      } else {
        foldable = false;
        defaultExpanded = true;
      }
    }

    // 无任何过程产出时不产生过程段（避免空折叠栏）
    if (metrics.toolCount === 0 && metrics.thoughtCount === 0 && metrics.injectionCount === 0) {
      return;
    }

    const seg: ProcessTimelineSegment = {
      kind: 'process_section',
      id: `${msgId}-proc-${procIndex++}`,
      items: current,
      metrics,
      foldable,
      defaultExpanded,
      forceExpanded,
      isLive,
    };
    segments.push(seg);
    void isLast;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    if (isProcessItem(item)) {
      buffer.push(item);
      continue;
    }

    // 命中正文项：作为物理界标，先冲掉前置过程段
    if (item.kind === 'text') {
      if (!hasTextContent(item)) {
        // 空正文不构成界标，但也不吞掉它（交由宿主渲染层决定是否显示）
        continue;
      }

      // 判断该正文之后是否还有正文（用于 isFinalAnswer 与铁律一的 hasNextText）
      const isFinalAnswer = !hasLaterText(items, i);

      // 冲掉缓冲：此正文是其后继，故 hasNextText = true（铁律一）
      flushProcessBuffer(true, false);

      const textSeg: TextTimelineSegment = {
        kind: 'text_narrative',
        id: `${msgId}-text-${textIndex++}`,
        item,
        isFinalAnswer,
        isStreaming: hasStreamText && isFinalAnswer && isTurnLive,
      };
      segments.push(textSeg);
    }
  }

  // 收尾：尾部残留过程段（无后继正文）
  flushProcessBuffer(false, true);

  return segments;
}

/**
 * 判断给定索引之后是否还存在非空正文项。
 */
function hasLaterText(items: readonly AssistantTimelineItem[], fromIndex: number): boolean {
  for (let j = fromIndex + 1; j < items.length; j++) {
    const it = items[j]!;
    if (it.kind === 'text' && hasTextContent(it)) return true;
  }
  return false;
}
