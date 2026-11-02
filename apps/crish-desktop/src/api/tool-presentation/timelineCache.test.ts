import { describe, expect, it } from 'vitest';
import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  buildAssistantTimeline,
  buildAssistantTimelineCached,
} from './timelineNormalizer';
import { partitionTimelineSegments } from './timelineSegmenter';
import {
  reconcileTimelineItems,
  reconcileTimelineSegments,
  timelineSignature,
} from './timelineCache';

function makeToolCall(
  partial: Partial<MessageToolCall> &
    Pick<MessageToolCall, 'id' | 'name' | 'status'>
): MessageToolCall {
  return {
    arguments: '',
    ...partial,
  };
}

function makeMessage(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id' | 'sender'>
): SessionMessage {
  return {
    timestamp: 1700000000000,
    ...partial,
  };
}

type Blocks = NonNullable<SessionMessage['blocks']>;

describe('timelineSignature 敏感性口径（与旧实现逐项等价）', () => {
  it('同一消息两次签名恒等', () => {
    const msg = makeMessage({
      id: 'm-sig-1',
      sender: 'assistant',
      status: 'completed',
      text: '正文',
      blocks: [{ type: 'text', content: '正文' }] as Blocks,
      toolCalls: [makeToolCall({ id: 't1', name: 'bash', status: 'success' })],
    });
    expect(timelineSignature(msg)).toBe(timelineSignature(msg));
    expect(timelineSignature({ ...msg })).toBe(timelineSignature(msg));
  });

  it('status 跃迁改变签名', () => {
    const base = makeMessage({
      id: 'm-sig-2',
      sender: 'assistant',
      status: 'processing',
      blocks: [{ type: 'text', content: '正文' }] as Blocks,
    });
    const done = { ...base, status: 'completed' as const };
    expect(timelineSignature(done)).not.toBe(timelineSignature(base));
  });

  it('工具 status / startedAt 变化改变签名', () => {
    const base = makeMessage({
      id: 'm-sig-3',
      sender: 'assistant',
      status: 'completed',
      blocks: [{ type: 'tool_call', id: 't1' }] as Blocks,
      toolCalls: [
        makeToolCall({
          id: 't1',
          name: 'bash',
          status: 'running',
          startedAt: 1,
        }),
      ],
    });
    const statusFlipped = {
      ...base,
      toolCalls: [
        makeToolCall({
          id: 't1',
          name: 'bash',
          status: 'success',
          startedAt: 1,
        }),
      ],
    };
    const startedMoved = {
      ...base,
      toolCalls: [
        makeToolCall({
          id: 't1',
          name: 'bash',
          status: 'running',
          startedAt: 2,
        }),
      ],
    };
    expect(timelineSignature(statusFlipped)).not.toBe(timelineSignature(base));
    expect(timelineSignature(startedMoved)).not.toBe(timelineSignature(base));
  });

  it('live 尾文本增长签名不变；封口后尾文本变化签名改变', () => {
    const liveA = makeMessage({
      id: 'm-sig-4',
      sender: 'assistant',
      status: 'processing',
      blocks: [{ type: 'text', content: 'abc' }] as Blocks,
    });
    const liveB = {
      ...liveA,
      blocks: [{ type: 'text', content: 'abcdef' }] as Blocks,
    };
    expect(timelineSignature(liveB)).toBe(timelineSignature(liveA));

    const sealedA = { ...liveA, status: 'completed' as const };
    const sealedB = { ...liveB, status: 'completed' as const };
    expect(timelineSignature(sealedB)).not.toBe(timelineSignature(sealedA));
  });

  it('live 尾思考增长签名不变；封口思考变化签名改变', () => {
    const liveA = makeMessage({
      id: 'm-sig-5',
      sender: 'assistant',
      status: 'processing',
      blocks: [
        { type: 'thought', content: '想', turnIndex: 0 },
        { type: 'text', content: '正文' },
      ] as Blocks,
    });
    const liveB = {
      ...liveA,
      blocks: [
        { type: 'thought', content: '想了很多', turnIndex: 0 },
        { type: 'text', content: '正文' },
      ] as Blocks,
    };
    expect(timelineSignature(liveB)).toBe(timelineSignature(liveA));
    const sealedA = { ...liveA, status: 'completed' as const };
    const sealedB = { ...liveB, status: 'completed' as const };
    expect(timelineSignature(sealedB)).not.toBe(timelineSignature(sealedA));
  });

  it('有显式正文块时 msg.text 变化不影响签名；无显式正文时影响（非 live）', () => {
    const withBlocks = makeMessage({
      id: 'm-sig-6',
      sender: 'assistant',
      status: 'completed',
      text: '甲',
      blocks: [{ type: 'text', content: '正文' }] as Blocks,
    });
    expect(timelineSignature({ ...withBlocks, text: '乙' })).toBe(
      timelineSignature(withBlocks)
    );

    const noBlocks = makeMessage({
      id: 'm-sig-7',
      sender: 'assistant',
      status: 'completed',
      text: '甲',
      blocks: [] as Blocks,
    });
    expect(timelineSignature({ ...noBlocks, text: '乙' })).not.toBe(
      timelineSignature(noBlocks)
    );
  });

  it('注入状态变化改变签名', () => {
    const base = makeMessage({
      id: 'm-sig-8',
      sender: 'assistant',
      status: 'completed',
      blocks: [{ type: 'text', content: '正文' }] as Blocks,
      injections: [
        {
          id: 'inj-1',
          kind: 'rule',
          title: '规则',
          summary: 's',
          status: 'injected',
          source: 'rule_loader',
          content: 'c',
          tokenEstimate: 10,
          timestamp: 1,
        },
      ],
    });
    const changed = {
      ...base,
      injections: [{ ...base.injections![0]!, status: 'failed' }],
    };
    expect(timelineSignature(changed)).not.toBe(timelineSignature(base));
  });
});

describe('timelineSignature 增量装配：封口内容零重读', () => {
  it('数组引用不变时，工具 output 与文本 content 的 getter 零触发', () => {
    let outputReads = 0;
    const tc = makeToolCall({ id: 't1', name: 'read_file', status: 'success' });
    Object.defineProperty(tc, 'output', {
      enumerable: true,
      configurable: true,
      get() {
        outputReads += 1;
        return 'file-body';
      },
    });

    let contentReads = 0;
    const textBlock: Record<string, unknown> = { type: 'text' };
    Object.defineProperty(textBlock, 'content', {
      enumerable: true,
      configurable: true,
      get() {
        contentReads += 1;
        return '正文内容';
      },
    });

    const blocks = [
      textBlock,
      { type: 'tool_call', id: 't1' },
    ] as unknown as Blocks;
    const msg = makeMessage({
      id: 'm-inc-1',
      sender: 'assistant',
      status: 'completed',
      text: '正文内容',
      blocks,
      toolCalls: [tc],
    });

    const sig1 = timelineSignature(msg);
    outputReads = 0;
    contentReads = 0;

    // 新 msg 包装、同一数组引用（= 流式文本帧的形态）
    const sig2 = timelineSignature({ ...msg });
    expect(sig2).toBe(sig1);
    expect(outputReads).toBe(0);
    expect(contentReads).toBe(0);
  });
});

describe('reconcileTimelineItems 身份保持', () => {
  function fixture(statusFlip: boolean, tailText: string) {
    return makeMessage({
      id: 'm-rec-1',
      sender: 'assistant',
      status: 'completed',
      text: tailText,
      blocks: [
        { type: 'thought', content: '先检索', turnIndex: 0 },
        { type: 'tool_call', id: 't1' },
        { type: 'text', content: '中间结论' },
        { type: 'thought', content: '再验证', turnIndex: 1 },
        { type: 'tool_call', id: 't2' },
        { type: 'text', content: tailText },
      ] as Blocks,
      toolCalls: [
        makeToolCall({
          id: 't1',
          name: 'search',
          status: 'success',
          output: 'r1',
        }),
        makeToolCall({
          id: 't2',
          name: 'bash',
          status: statusFlip ? 'success' : 'running',
          output: 'r2',
        }),
      ],
    });
  }

  it('全等重建返回上一帧数组本身', () => {
    const msg = fixture(false, '最终答案');
    const prev = buildAssistantTimeline(msg);
    const next = buildAssistantTimeline(msg);
    expect(next).not.toBe(prev);
    expect(reconcileTimelineItems(prev, next)).toBe(prev);
  });

  it('仅尾部变化时，已封口条目逐个保持引用，变化条目换新', () => {
    const prev = buildAssistantTimeline(fixture(false, '最终答案'));
    const next = buildAssistantTimeline(fixture(true, '最终答案（修订）'));
    const reconciled = reconcileTimelineItems(prev, next);
    expect(reconciled).not.toBe(prev);
    expect(reconciled.length).toBe(prev.length);
    // 结构：[thought, tools(t1), text, thought, tools(t2), text]
    expect(reconciled[0]).toBe(prev[0]);
    expect(reconciled[1]).toBe(prev[1]);
    expect(reconciled[2]).toBe(prev[2]);
    expect(reconciled[3]).toBe(prev[3]);
    expect(reconciled[4]).not.toBe(prev[4]);
    expect(reconciled[5]).not.toBe(prev[5]);
  });
});

describe('reconcileTimelineSegments 身份保持', () => {
  function fixture(tailText: string) {
    return makeMessage({
      id: 'm-rec-2',
      sender: 'assistant',
      status: 'completed',
      text: tailText,
      blocks: [
        { type: 'thought', content: '思考一', turnIndex: 0 },
        { type: 'tool_call', id: 't1' },
        { type: 'text', content: '第一段结论' },
        { type: 'thought', content: '思考二', turnIndex: 1 },
        { type: 'tool_call', id: 't2' },
        { type: 'text', content: tailText },
      ] as Blocks,
      toolCalls: [
        makeToolCall({
          id: 't1',
          name: 'search',
          status: 'success',
          output: 'r1',
        }),
        makeToolCall({
          id: 't2',
          name: 'bash',
          status: 'success',
          output: 'r2',
        }),
      ],
    });
  }

  it('全等重建返回上一帧段数组本身', () => {
    const msg = fixture('最终答案');
    const items = buildAssistantTimeline(msg);
    const segsPrev = partitionTimelineSegments(msg.id, items, false, false, {});
    const itemsNext = reconcileTimelineItems(
      items,
      buildAssistantTimeline(msg)
    );
    expect(itemsNext).toBe(items);
    const segsNext = partitionTimelineSegments(
      msg.id,
      itemsNext,
      false,
      false,
      {}
    );
    expect(reconcileTimelineSegments(segsPrev, segsNext)).toBe(segsPrev);
  });

  it('尾文本变化时，历史段保持引用', () => {
    const msgA = fixture('最终答案');
    const itemsA = buildAssistantTimeline(msgA);
    const segsA = partitionTimelineSegments(msgA.id, itemsA, false, false, {});
    const msgB = fixture('最终答案（补完）');
    const itemsB = reconcileTimelineItems(itemsA, buildAssistantTimeline(msgB));
    const segsB = partitionTimelineSegments(msgA.id, itemsB, false, false, {});
    const reconciled = reconcileTimelineSegments(segsA, segsB);
    expect(reconciled.length).toBe(segsA.length);
    // 除最后一段（尾文本所在段）外全部复用
    for (let i = 0; i < reconciled.length - 1; i += 1) {
      expect(reconciled[i]).toBe(segsA[i]);
    }
    expect(reconciled[reconciled.length - 1]).not.toBe(segsA[segsA.length - 1]);
  });
});

describe('长回合回放：逐帧仅尾段增量（R3 验收夹具）', () => {
  const ROUNDS = 70; // 70 轮 ×（思考+工具+正文）= 210 块 / 约 210 条目 / 约 140 段

  function longMessage(): SessionMessage {
    const blocks: unknown[] = [];
    const toolCalls: MessageToolCall[] = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      blocks.push({
        type: 'thought',
        content: `第 ${r} 轮思考：分析现状并规划下一步`,
        turnIndex: r,
      });
      blocks.push({ type: 'tool_call', id: `t-${r}` });
      blocks.push({ type: 'text', content: `第 ${r} 轮阶段结论。` });
      toolCalls.push(
        makeToolCall({
          id: `t-${r}`,
          name: 'read_file',
          status: 'success',
          output: `output-${r}-` + 'x'.repeat(200),
          startedAt: 1700000000000 + r * 1000,
        })
      );
    }
    return makeMessage({
      id: 'm-long-1',
      sender: 'assistant',
      status: 'processing',
      text: '',
      blocks: blocks as Blocks,
      toolCalls,
    });
  }

  it('纯文本帧 ×40：签名恒等、缓存时间线引用恒定、封口工具 output 零重读', () => {
    const msg = longMessage();
    let outputReads = 0;
    const tc0 = msg.toolCalls![0]!;
    const originalOutput = tc0.output;
    Object.defineProperty(tc0, 'output', {
      enumerable: true,
      configurable: true,
      get() {
        outputReads += 1;
        return originalOutput;
      },
    });

    const first = buildAssistantTimelineCached(msg, null, null);
    expect(first.timeline.length).toBeGreaterThanOrEqual(200);
    outputReads = 0;

    let sig = first.sig;
    let timeline = first.timeline;
    for (let f = 1; f <= 40; f += 1) {
      const frame = { ...msg, text: '流式正文' + 'x'.repeat(f) };
      const r = buildAssistantTimelineCached(frame, sig, timeline);
      expect(r.sig).toBe(sig);
      expect(r.timeline).toBe(timeline);
      sig = r.sig;
      timeline = r.timeline;
    }
    expect(outputReads).toBe(0);
  });

  it('提交帧（块被复制 + 中段工具状态翻转）：仅受影响条目换新，其余逐个保持引用', () => {
    const msg = longMessage();
    // 基线：第 35 轮工具仍在 running
    const baseline: SessionMessage = {
      ...msg,
      toolCalls: (msg.toolCalls || []).map((tc, i) =>
        i === 35 ? { ...tc, status: 'running' as const } : tc
      ),
    };
    const baseFirst = buildAssistantTimelineCached(baseline, null, null);
    const baseItems = reconcileTimelineItems(null, baseFirst.timeline);

    // 提交帧：blocks 整体复制（normalize 口径）、第 35 轮工具终态落定
    const committed: SessionMessage = {
      ...baseline,
      blocks: (baseline.blocks || []).map((b) => ({ ...b })) as Blocks,
      toolCalls: (baseline.toolCalls || []).map((tc, i) =>
        i === 35 ? { ...tc, status: 'success' as const, output: 'done-35' } : tc
      ),
    };
    const rebuilt = buildAssistantTimelineCached(
      committed,
      baseFirst.sig,
      baseFirst.timeline
    );
    expect(rebuilt.timeline).not.toBe(baseFirst.timeline);
    const reconciled = reconcileTimelineItems(baseItems, rebuilt.timeline);
    expect(reconciled.length).toBe(baseItems.length);
    const changedIdx: number[] = [];
    for (let i = 0; i < reconciled.length; i += 1) {
      if (reconciled[i] !== baseItems[i]) changedIdx.push(i);
    }
    // 变化被严格限制在第 35 轮的条目区间（每轮 3 条：thought/tools/text → 105..107），
    // 且 tools 条目必然在其中；其余 200+ 条已封口条目全部保持上一帧引用。
    expect(changedIdx.length).toBeGreaterThanOrEqual(1);
    expect(changedIdx.length).toBeLessThanOrEqual(3);
    for (const idx of changedIdx) {
      expect(idx).toBeGreaterThanOrEqual(105);
      expect(idx).toBeLessThanOrEqual(107);
    }
    expect(reconciled[106]).not.toBe(baseItems[106]);
    expect(reconciled[106]!.kind).toBe('tools');
  });
});
