/**
 * apps/crish-desktop/src/api/tool-presentation/__tests__/processClosureChain.test.ts
 *
 * 节点 6 · 软收口全链路物证（触发端 → 介质端 → 消费端）。
 *
 * 现有单测都是分段单元验证（分段器 / 文案 / 度量各自为战），无法证明
 * 「用户在真实产品里看到的那一行『工作 xx 时间』是从真实数据流算出来的」。
 * 本套件把真实链路串起来跑一遍：
 *
 *   轮次收口（resolveTerminalDurationMs → buildTerminalToolPatches）
 *     → 介质落盘（applyToolCallPatches 回写 MessageToolCall / MessageTimelineBlock）
 *     → 时间线归一（buildAssistantTimeline）
 *     → 分段状态机（partitionTimelineSegments）
 *     → 控制栏文案（formatProcessControlLabel）
 *
 * 负向断言：旧口径 `segEnd = max(startTime)` 在本链路上必然产出偏小/归零的耗时，
 * 本套件用数值断言把它钉死，防止回潮。
 */

import { describe, expect, it } from 'vitest';
import type { MessageToolCall, SessionMessage } from '../../../store/layoutStore';
import type { MessageTimelineBlock } from '../../../store/types';
import {
  buildTerminalToolPatches,
  resolveTerminalDurationMs,
} from '../../../hooks/chat-stream/helpers';
import { buildAssistantTimeline } from '../timelineNormalizer';
import { partitionTimelineSegments } from '../timelineSegmenter';
import { formatProcessControlLabel } from '../processMetricsEngine';

const T0 = 1_700_000_000_000;

/**
 * 复刻 store `applyToolCallPatches` 的回写语义（不引入 zustand，保持纯逻辑）。
 * 与 `sessionMessageActionsTools.ts` 的写入口径 1:1 对齐。
 */
function applyPatches(
  msg: SessionMessage,
  patches: Array<{ id: string; durationMs?: number }>
): SessionMessage {
  for (const p of patches) {
    const tc = msg.toolCalls?.find((t) => t.id === p.id);
    if (!tc) continue;
    if (p.durationMs !== undefined) {
      tc.durationMs = p.durationMs;
      const b = msg.blocks?.find(
        (blk) => blk.type === 'tool_call' && blk.id === tc.id
      );
      if (b) b.durationMs = p.durationMs;
    }
  }
  return msg;
}

/** 走完整链路，返回终态过程段控制栏文案与实测跨度。 */
function runChain(msg: SessionMessage) {
  // 1. 触发端：轮次收口，为未终结工具补齐真实挂钟耗时
  //    （buildTerminalToolPatches 内部取真实 Date.now()，故本套件的 T0 一律用
  //     「真实时钟相对基准」构造，patch 相关断言用区间、纯函数断言用定值）
  const patches = buildTerminalToolPatches(msg.toolCalls, 'complete');
  expect(patches.every((p) => p.durationMs === undefined || p.durationMs >= 0)).toBe(true);
  const settled = applyPatches(msg, patches);

  // 2. 介质端 → 消费端：时间线归一 + 分段
  const items = buildAssistantTimeline(settled);
  const segs = partitionTimelineSegments(settled.id, items, false, false);
  const seg = segs.find((s) => s.kind === 'process_section');
  if (seg?.kind !== 'process_section') {
    throw new Error(`期望存在 process_section，实际：${segs.map((s) => s.kind).join(',')}`);
  }

  const spanMs = (seg.endTime ?? 0) - (seg.startTime ?? 0);
  const label = formatProcessControlLabel(seg.metrics, seg.showWorkTime, spanMs, seg.isLive);
  return { seg, spanMs, label, items, patches };
}

function toolCall(id: string, startedAt: number, extra: Partial<MessageToolCall> = {}): MessageToolCall {
  return {
    id,
    name: 'read_file',
    arguments: '{}',
    status: 'running',
    startedAt,
    ...extra,
  } as MessageToolCall;
}

function blockTool(id: string, startedAt: number): MessageTimelineBlock {
  return { type: 'tool_call', id, turnIndex: 0, startTime: startedAt };
}

describe('节点 6 · 软收口全链路物证（收口 → 落盘 → 归一 → 分段 → 文案）', () => {
  it('双工具段：终态「工作 xx 时间」计入末项执行时长（8s），而非首工具起点差（3s）', () => {
    // 真实时钟相对基准：tc-1 3s 前开始（已回报 3s 耗时），tc-2 于 T0+3s 开始且未终结
    const t0 = Date.now() - 8_000;
    const msg: SessionMessage = {
      id: 'm-chain-1',
      sender: 'assistant',
      timestamp: t0,
      text: '',
      toolCalls: [
        toolCall('tc-1', t0, { status: 'success', durationMs: 3_000 }),
        toolCall('tc-2', t0 + 3_000),
      ],
      blocks: [blockTool('tc-1', t0), blockTool('tc-2', t0 + 3_000)],
    } as SessionMessage;

    const { patches, spanMs, label } = runChain(msg);

    // tc-1 已终结且后端已回报 → 软收口不产出 durationMs（禁止覆盖）
    expect(patches.find((p) => p.id === 'tc-1')).toBeUndefined();
    // tc-2 未终结 → 按真实挂钟补齐 ≈ 5s
    const p2 = patches.find((p) => p.id === 'tc-2');
    expect(p2?.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(p2?.durationMs).toBeLessThan(5_000 + 5_000);

    // 物理终点 = max(t0+3000, t0+3000+durationMs(tc-2)) ≈ t0 + 8000 → 跨度 ≈ 8s
    expect(spanMs).toBeGreaterThanOrEqual(8_000);
    expect(spanMs).toBeLessThan(13_000);
    // 负向断言：旧口径 max(startTime) 只能得到 3s
    expect(spanMs).toBeGreaterThan(3_000 + 1_000);
    expect(label).toMatch(/^已完成 \d+(\.\d)? 秒$/);
  });

  it('纯函数定值断言：缺失耗时按传入挂钟补齐（不依赖 Date.now）', () => {
    expect(resolveTerminalDurationMs({ startedAt: T0 + 3_000 }, T0 + 8_000)).toBe(5_000);
    expect(resolveTerminalDurationMs({ startedAt: T0 + 3_000, durationMs: 1_000 }, T0 + 8_000)).toBeUndefined();
    expect(resolveTerminalDurationMs({ startedAt: T0 + 3_000, durationMs: 0 }, T0 + 8_000)).toBe(5_000);
    expect(resolveTerminalDurationMs({}, T0 + 8_000)).toBeUndefined();
  });

  it('思考 + 工具段：跨度 = 思考 5s + 工具 7s = 12s（定值，工具已回报耗时）', () => {
    const t0 = Date.now() - 12_000;
    const msg: SessionMessage = {
      id: 'm-chain-2',
      sender: 'assistant',
      timestamp: t0,
      text: '最终总结正文',
      toolCalls: [toolCall('tc-1', t0 + 5_000, { status: 'success', durationMs: 7_000 })],
      blocks: [
        {
          type: 'thought',
          id: 'thought-turn-0',
          content: '先想清楚',
          turnIndex: 0,
          startTime: t0,
          durationMs: 5_000,
        },
        blockTool('tc-1', t0 + 5_000),
        { type: 'text', content: '最终总结正文', turnIndex: 0, startTime: t0 + 12_000 },
      ],
    } as SessionMessage;

    const { seg, spanMs, label } = runChain(msg);

    // 2026-09-19 用户裁决：去除工作完成后的整体折叠，默认展开
    expect(seg.foldable).toBe(true);
    expect(seg.defaultExpanded).toBe(true);
    expect(seg.isLive).toBe(false);
    expect(spanMs).toBe(12_000);
    expect(label).toBe('已完成 12.0 秒');
  });

  it('首个过程段（紧跟用户消息下方）承载整轮工作时间（2026-09-11 用户裁决）', () => {
    const msg: SessionMessage = {
      id: 'm-chain-3',
      sender: 'assistant',
      timestamp: T0,
      text: '正文',
      blocks: [
        {
          type: 'thought',
          id: 'thought-turn-0',
          content: '只在心里想了一下',
          turnIndex: 0,
          startTime: T0,
          durationMs: 2_000,
        },
        { type: 'text', content: '正文', turnIndex: 0, startTime: T0 + 2_000 },
      ],
    } as SessionMessage;

    const { seg, label } = runChain(msg);
    expect(seg.showWorkTime).toBe(true);
    expect(label).toBe('已完成 2.0 秒');
  });

  it('后续工具段（正文之后）展示工具动作描述「已运行 1 条命令」（2026-09-11 用户裁决）', () => {
    const msg: SessionMessage = {
      id: 'm-chain-4',
      sender: 'assistant',
      timestamp: T0,
      text: '总结',
      toolCalls: [toolCall('tc-1', T0 + 2_000, { name: 'run_command', status: 'success', durationMs: 4_000 })],
      blocks: [
        { type: 'thought', id: 'th-1', content: '思考一下', turnIndex: 0, startTime: T0, durationMs: 2_000 },
        { type: 'text', content: '先输出部分正文', turnIndex: 0 },
        blockTool('tc-1', T0 + 2_000),
      ],
    } as SessionMessage;

    const segs = partitionTimelineSegments(msg.id, buildAssistantTimeline(msg), false, false);
    const procSegs = segs.filter((s) => s.kind === 'process_section') as Array<{
      id: string;
      showWorkTime: boolean;
      metrics: any;
      items: any[];
    }>;
    // 严格按时间线交错输出：思考段 -> 正文 -> 工具段，绝不允许强行聚合重排
    expect(procSegs).toHaveLength(2);
    expect(procSegs[0]?.showWorkTime).toBe(true);
    expect(procSegs[0]?.items).toHaveLength(1);
    expect(procSegs[1]?.showWorkTime).toBe(false);
    expect(procSegs[1]?.items).toHaveLength(1);
    const label = formatProcessControlLabel(procSegs[0]!.metrics, true, 6_000, false);
    expect(label).toBe('已完成 6.0 秒');
  });

  it('负向断言：全链路文案不得出现已废除的「已深度思考」', () => {
    const msg: SessionMessage = {
      id: 'm-chain-5',
      sender: 'assistant',
      timestamp: T0,
      text: '总结',
      toolCalls: [
        toolCall('tc-1', T0, { status: 'success', durationMs: 1_000 }),
        toolCall('tc-2', T0 + 1_000, { status: 'success', durationMs: 1_000 }),
      ],
      blocks: [blockTool('tc-1', T0), blockTool('tc-2', T0 + 1_000), { type: 'text', content: '总结' }],
    } as SessionMessage;

    const { label } = runChain(msg);
    expect(label).not.toContain('已深度思考');
  });

  it('时钟回拨防御：now 早于 startedAt 时耗时夹到 0，链路不产生负数跨度', () => {
    const msg: SessionMessage = {
      id: 'm-chain-6',
      sender: 'assistant',
      timestamp: T0,
      text: '正文',
      toolCalls: [
        toolCall('tc-1', T0, { status: 'success', durationMs: 1_000 }),
        toolCall('tc-2', T0 + 50_000),
      ],
      blocks: [
        blockTool('tc-1', T0),
        blockTool('tc-2', T0 + 50_000),
        { type: 'text', content: '正文', turnIndex: 0 },
      ],
    } as SessionMessage;

    // now 远早于 tc-2 的 startedAt（模拟系统时钟回拨）
    const { spanMs, label } = runChain(msg);
    expect(spanMs).toBeGreaterThanOrEqual(0);
    expect(label).toMatch(/^已完成 \d/);
    expect(label).not.toContain('-');
  });
});
