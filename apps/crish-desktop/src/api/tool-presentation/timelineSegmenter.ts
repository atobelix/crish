/**
 * apps/crish-desktop/src/api/tool-presentation/timelineSegmenter.ts
 *
 * 按轮单组分段状态机（纯逻辑，无 React 依赖）。
 *
 *
 * 一轮对话 = 一个过程组 + 独立的最终答复：
 * - 同一条 assistant 消息内，全部思考 / 工具连同**中间正文**一起累积进
 * 同一个过程组，组内严格保持发生序、绝不重排；中间正文在组内降级为
 * 叙述行（narration），以过程排版呈现（全文不截断）；
 * - **最终答复** = 最后一个非空正文项、且其后不再有任何过程项 —— 它独立
 * 为 `text_narrative` 段，位于组外、恒显、无组壳、永不折叠；
 * - 其后确无正文的回合（纯工具收尾）整轮只有一个过程组、无答复段；
 * - 单组 id 恒为 `${msgId}-proc-0`。
 *
 * 系统状态通知（上下文压缩 / 模型切换 /
 * 思考强度切换 / 权限切换）是对用户的告知，绝不进折叠组：`state_notice`
 * 段常驻平铺，注入出现时过程组在其位置断开（实践中注入发生在轮次边界，
 * 此为例外而非通则）。注入切分出的后续组 id 顺延为 proc-1、proc-2……。
 *
 * 本模型覆盖 2026-09-19 的两条旧裁决——「有后继正文
 * 默认展开直出」（中间正文不再独立成段，"直出"对象已不存在）与「终态彻底
 * 去除整体折叠」（整体折叠以过程组为单位回归，折叠不卸载 DOM）；亦覆盖
 * 2026-09-18「交错分段、严禁聚合」的切分形态（发生序保留、聚合单位改为
 * 整轮）。依据：〔思考工具同组与折叠机制分析 §3.1〕。
 *
 *
 * 【R8 默认开合表 · 〔同组 §3.3〕两级模型之组级】（2026-11-02 落地，
 * 覆盖 R9 的过渡口径；本表为组级默认唯一权威，消费方禁止本地重推导）：
 * | 情形 | foldable | defaultExpanded | isLive |
 * | 流式尾部组（仍生长） | true | true | true |
 * | 已封口组（终态 / 答复前封口 / 注入切分封口） | true | false | false |
 * | 无组头组（见下） | true | true | 同上 |
 * 「无组头组」= 渲染层不挂控制栏的组：原子单项组（单思考组由思考行
 * 本身承载，单工具组由 CompactToolRow 自带行头承载，避免双层手风琴套娃）。
 * 无组头组不参与组级自动折——折了就没有一行可见的头，内容等于消失；
 * 其组内条目以条目级默认治理（思考行终态自折、工具行详情自折）。【F1 · R-A 修订（2026-11-02）】状态
 * 通知切分出的非首组（showWorkTime=false）原与单思考同列无组头组
 * （R8 裁决），现按用户裁决 (3)「正常只显示正文」补轻量组头：文案
 * 走 formatProcessControlLabel 的非 showWorkTime 分支（动作分布
 * 摘要 + 失败数），与首组同口径参与组级自动折。带组头的组在封口后
 * 一律自动折为组头一行；含失败组同口径自动折，失败数常驻组头
 * （formatProcessControlLabel 归口拼装），展开后失败条目不自动折。
 * 历史消息（重开会话）即终态组，按本表折叠。用户手动开合过的组由
 * 消费方 userInteracted 钉住，永不被本表默认值覆盖。
 *
 * 整轮工作时间由首个过程组承载（showWorkTime）；
 * 段内思考 + 工具计数之和 ≥ 2 才显示胶囊与虚线分割，单思考 / 单工具调用
 * 不显示（用户裁决 · 2026-09-11）。
 *
 * 原子代理可见性特权（subagentCount >= 1 →
 * forceExpanded 强制展开）已随 R4b 分派提取退役；本批将段级 `forceExpanded`
 * 字段物理删除（类型 / 分段器 / 消费方一并清零），禁止以任何条件重新引入
 * 段级强制展开（负向红线）。子 agent 在组内的可见性口径归 R8 容器条目级。
 *
 * 权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.2）。
 * 负向红线：禁止在本模块外实现分段逻辑；禁止调用方本地重推导 foldable。
 */

import type {
  AssistantTimelineItem,
  ProcessTimelineSegment,
  TimelineSegment,
  TimelineTextItem,
} from './toolPresentationTypes';
import { aggregateProcessMetrics } from './processMetricsEngine';

/**
 * 判断单个时间线项是否属于「AI 过程产出」（思考 / 工具）。
 *
 * `injection` **不属过程项**：系统状态通知（上下文压缩 / 模型切换 /
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
 * 将线性时间线按轮切分为「过程组 + 最终答复」序列。
 *
 * @param msgId 消息唯一 ID（用于生成稳定 sectionId）
 * @param items 已去重的线性时间线项
 * @param isTurnLive 本轮是否处于流式活跃态
 * @param hasStreamText 是否存在流式正文（用于最终答复的流式判定）
 * @param timeContext 消息级轮次时间上下文（用于首组精准承载整轮工作耗时）
 */
export function partitionTimelineSegments(
  msgId: string,
  items: readonly AssistantTimelineItem[],
  isTurnLive: boolean,
  hasStreamText: boolean,
  timeContext?: TimelineSegmentationContext
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let groupIndex = 0;
  let textIndex = 0;
  let stateIndex = 0;

  // 最终答复定位：最后一个非空正文项，且其后不再有任何过程项。
  // 其后仍有过程项时，该正文只是中间叙述，本轮不存在答复段。
  let finalAnswerIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'text' && hasTextContent(it)) {
      finalAnswerIndex = i;
      break;
    }
  }
  if (finalAnswerIndex >= 0) {
    for (let i = finalAnswerIndex + 1; i < items.length; i++) {
      if (isProcessItem(items[i]!)) {
        finalAnswerIndex = -1;
        break;
      }
    }
  }

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

  /**
   * 冲刷过程缓冲。
   *
   * @param isTail 是否为时间线末尾的冲刷（决定该组是否仍为流式生长尾段）。
   * 缓冲内无任何过程产出时（只有中间正文的退化情形），正文逐项以普通
   * 叙事段平铺，绝不因「不成组」而丢失内容。
   */
  const flushProcessBuffer = (isTail: boolean): void => {
    if (buffer.length === 0) return;

    const current = buffer;
    buffer = [];

    const metrics = aggregateProcessMetrics(current);

    // 无任何过程产出时不产生过程组：缓冲正文平铺为叙事段（非答复段）
    if (metrics.toolCount === 0 && metrics.thoughtCount === 0) {
      for (const it of current) {
        if (it.kind !== 'text') continue;
        segments.push({
          kind: 'text_narrative',
          id: `${msgId}-text-${textIndex++}`,
          item: it,
          isFinalAnswer: false,
          isStreaming: false,
        });
      }
      return;
    }

    // ── 折叠裁决（〔同组 §3.3〕组级默认，口径见文件头默认开合表）──
    const foldable = true;
    const isLive = isTail && isTurnLive;
    // 组头（控制栏）是否由渲染层挂载：与 FoldableProcessSection 的
    // omitOuterControlBar 判定同构（原子单项组：单思考或单工具 → 无外层控制栏，完全穿透）。
    // 单思考组由 ReasoningRow 自带 24px 独立折叠栏，单工具组由 CompactToolRow
    // （ToolCallHeader）自带 24px 独立行头与折叠展开，外层彻底消除双层折叠套娃。
    // 无组头组保持展开默认（defaultExpanded = true），由条目自身治理折叠。
    const isAtomicSingleGroup =
      (metrics.thoughtCount === 1 &&
        metrics.toolCount === 0 &&
        metrics.subagentCount === 0) ||
      (metrics.thoughtCount === 0 &&
        metrics.toolCount === 1 &&
        metrics.subagentCount === 0);
    const hasGroupHeader = !isAtomicSingleGroup;
    const defaultExpanded = isLive || !hasGroupHeader;

    // 组起止时间戳
    let segStart: number | undefined;
    let segEnd: number | undefined;

    if (groupIndex === 0) {
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

    const isFirstGroup = groupIndex === 0;
    const seg: ProcessTimelineSegment = {
      kind: 'process_section',
      id: `${msgId}-proc-${groupIndex++}`,
      items: current,
      metrics,
      startTime: segStart,
      endTime: segEnd,
      showWorkTime:
        isFirstGroup && metrics.thoughtCount + metrics.toolCount >= 2,
      foldable,
      defaultExpanded,
      isLive,
    };
    segments.push(seg);
  };

  // 单遍因果线性扫描（2026-09-18 发生序铁律保留：组内严格按发生序，绝不重排）
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    if (item.kind === 'injection') {
      // 状态通知是物理界标：过程组在此断开（例外，见文件头）
      flushProcessBuffer(false);
      segments.push({
        kind: 'state_notice',
        id: `${msgId}-state-${stateIndex++}`,
        item,
      });
      continue;
    }

    if (item.kind === 'text') {
      if (!hasTextContent(item)) continue;
      if (i === finalAnswerIndex) {
        flushProcessBuffer(false);
        segments.push({
          kind: 'text_narrative',
          id: `${msgId}-text-${textIndex++}`,
          item,
          isFinalAnswer: true,
          isStreaming: hasStreamText && isTurnLive,
        });
      } else {
        // 中间正文：降级为组内叙述行，随过程缓冲一同入组
        buffer.push(item);
      }
      continue;
    }

    if (isProcessItem(item)) {
      buffer.push(item);
      continue;
    }
  }

  // 冲出末尾剩余的过程缓冲（若存在）：纯过程收尾时整轮只有这一个组
  flushProcessBuffer(true);

  return segments;
}
