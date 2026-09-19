/**
 * apps/crish-desktop/src/api/tool-presentation/timelineSegmenter.ts
 *
 * 正文交错过程分段状态机（纯逻辑，无 React 依赖）。
 *
 * 分段以「AI 正文 / 系统状态通知」为天然物理界标：界标之前的思考与工具聚合为一个
 * 可折叠过程段；正文作为不可折叠的叙事段平铺常驻；系统状态通知
 * （上下文压缩 / 模型切换 / 思考强度切换）作为 `state_notice` 段平铺常驻，
 * 绝不参与折叠。
 *
 * 【顶部工作工作时间区门槛】段内思考 + 工具计数之和 ≥ 2 才显示胶囊与虚线分割；
 * 单思考 / 单工具调用不显示（用户裁决 · 2026-09-11）。
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
  StateNoticeTimelineSegment,
  TextTimelineSegment,
  TimelineSegment,
  TimelineTextItem,
} from './toolPresentationTypes';
import { aggregateProcessMetrics } from './processMetricsEngine';

/**
 * 判断单个时间线项是否属于「AI 过程产出」（思考 / 工具）。
 *
 * 【重要】`injection` **不属过程项**：系统状态通知（上下文压缩 / 模型切换 /
 * 思考强度切换 / 权限切换）是对用户的告知，必须常驻可见，
 * 绝不允许被折叠吞掉。注入项在 `partitionTimelineSegments` 中作为物理界标处理。
 */
function isProcessItem(item: AssistantTimelineItem): boolean {
  return item.kind === 'thought' || item.kind === 'tools';
}


/**
 * 判断正文项是否具备实际内容（空正文不作为有效界标）。
 */
function hasTextContent(item: TimelineTextItem): boolean {
  return (item.content || '').trim().length > 0;
}

export interface TimelineSegmentationContext {
  /** 消息起始时间戳（epoch ms，从用户发送/消息创建起算） */
  msgTimestamp?: number;
  /** 整轮总工作耗时（秒，来自 SessionMessage.thinkingTime / 运行完成统计） */
  totalTurnDurationSec?: number;
}

/**
 * 将线性时间线切割为交错的分段序列。
 *
 * @param msgId       消息唯一 ID（用于生成稳定 sectionId）
 * @param items       已去重的线性时间线项
 * @param isTurnLive  本轮是否处于流式活跃态
 * @param hasStreamText 是否存在流式正文（用于铁律二的补强判定）
 * @param timeContext 消息级轮次时间上下文（用于首段精准承载整轮工作耗时）
 */
export function partitionTimelineSegments(
  msgId: string,
  items: readonly AssistantTimelineItem[],
  isTurnLive: boolean,
  hasStreamText: boolean,
  timeContext?: TimelineSegmentationContext
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let procIndex = 0;
  let textIndex = 0;
  let stateIndex = 0;

  // 预扫描整轮所有过程项（thought / tools），计算整轮总耗时与跨度
  let turnStart: number | undefined;
  let turnEnd: number | undefined;
  let turnTotalDurationMs = 0;
  for (const it of items) {
    if (!isProcessItem(it)) continue;
    const t = (it as { startTime?: number }).startTime;
    if (typeof t === 'number' && t > 0) {
      if (turnStart === undefined || t < turnStart) turnStart = t;
      const d = (it as { durationMs?: number }).durationMs;
      const end = typeof d === 'number' && d > 0 ? t + d : t;
      if (turnEnd === undefined || end > turnEnd) turnEnd = end;
    }
    const d = (it as { durationMs?: number }).durationMs;
    if (typeof d === 'number' && d > 0) {
      turnTotalDurationMs += d;
    }
  }

  let buffer: AssistantTimelineItem[] = [];

  const flushProcessBuffer = (hasNextText: boolean): void => {
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
      // 过程段已履职完成（后继存在正文），不再是 live 尾部段；默认保持展开直出（2026-09-19 用户裁决）
      foldable = true;
      defaultExpanded = true;
      isLive = false;
    } else if (isTurnLive) {
      foldable = true;
      defaultExpanded = true;
      isLive = true;
    } else {
      // 终态过程段（2026-09-19 用户裁决）：彻底去除工作完成后的整体内容折叠，默认平铺展开展现原生时间线
      foldable = true;
      defaultExpanded = true;
    }

    // 无任何过程产出时不产生过程段（避免空折叠栏）
    if (metrics.toolCount === 0 && metrics.thoughtCount === 0) {
      return;
    }

    // 段起止时间戳
    let segStart: number | undefined;
    let segEnd: number | undefined;

    if (procIndex === 0) {
      if (
        typeof timeContext?.msgTimestamp === 'number' &&
        timeContext.msgTimestamp > 0
      ) {
        segStart =
          turnStart !== undefined
            ? Math.min(turnStart, timeContext.msgTimestamp)
            : timeContext.msgTimestamp;
      } else {
        segStart = turnStart;
      }

      if (!isLive) {
        if (
          typeof timeContext?.totalTurnDurationSec === 'number' &&
          timeContext.totalTurnDurationSec > 0
        ) {
          const wallMs = Math.round(timeContext.totalTurnDurationSec * 1000);
          segEnd = (segStart ?? 0) + wallMs;
          metrics.totalDurationMs = Math.max(metrics.totalDurationMs, wallMs);
        } else if (
          segStart !== undefined &&
          (turnEnd === undefined || turnEnd <= segStart) &&
          turnTotalDurationMs > 0
        ) {
          segEnd = segStart + turnTotalDurationMs;
        } else {
          segEnd = turnEnd;
        }
      } else {
        segEnd = undefined;
      }
    } else {
      for (const it of current) {
        const t = (it as { startTime?: number }).startTime;
        if (typeof t === 'number' && t > 0) {
          if (segStart === undefined || t < segStart) segStart = t;
          const d = (it as { durationMs?: number }).durationMs;
          const end = typeof d === 'number' && d > 0 ? t + d : t;
          if (segEnd === undefined || end > segEnd) segEnd = end;
        }
      }
      if (!isLive) {
        if (
          segStart !== undefined &&
          (segEnd === undefined || segEnd <= segStart) &&
          metrics.totalDurationMs > 0
        ) {
          segEnd = segStart + metrics.totalDurationMs;
        }
      } else {
        segEnd = undefined;
      }
    }

    const isFirstProc = procIndex === 0;
    const seg: ProcessTimelineSegment = {
      kind: 'process_section',
      id: `${msgId}-proc-${procIndex++}`,
      items: current,
      metrics,
      startTime: segStart,
      endTime: segEnd,
      showWorkTime: isFirstProc,
      foldable,
      defaultExpanded,
      forceExpanded,
      isLive,
    };
    segments.push(seg);
  };

  // 单遍因果线性切分（2026-09-18 严格按发生序交错展现，严禁聚合重排）
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    if (item.kind === 'injection') {
      flushProcessBuffer(hasLaterText(items, i));
      segments.push({
        kind: 'state_notice',
        id: `${msgId}-state-${stateIndex++}`,
        item,
      });
      continue;
    }

    if (item.kind === 'text') {
      if (!hasTextContent(item)) continue;
      flushProcessBuffer(true);
      const isFinalAnswer = !hasLaterText(items, i);
      segments.push({
        kind: 'text_narrative',
        id: `${msgId}-text-${textIndex++}`,
        item,
        isFinalAnswer,
        isStreaming: hasStreamText && isFinalAnswer && isTurnLive,
      });
      continue;
    }

    if (isProcessItem(item)) {
      buffer.push(item);
      continue;
    }
  }

  // 冲出末尾剩余的过程缓冲（若存在）
  flushProcessBuffer(false);

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
