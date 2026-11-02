// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SessionMessage } from '../../store/types';
import { streamStoreKey, useStreamingStore } from '../../store/storeAccess';
import {
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
  useStreamMessageViewModel,
} from './streamMessageViewModel';

const alignSpy = vi.hoisted(() => vi.fn());
vi.mock(
  '../../api/tool-presentation/timelineNormalizer',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../api/tool-presentation/timelineNormalizer')
      >();
    return {
      ...actual,
      alignToolCallBlocks: (
        blocks: Parameters<typeof actual.alignToolCallBlocks>[0],
        toolCalls: Parameters<typeof actual.alignToolCallBlocks>[1]
      ) => {
        alignSpy(blocks, toolCalls);
        return actual.alignToolCallBlocks(blocks, toolCalls);
      },
    };
  }
);

describe('applyStreamTextToMessage', () => {
  it('returns msg when streamText is undefined', () => {
    const msg = { text: 'x' };
    expect(applyStreamTextToMessage(msg, undefined)).toBe(msg);
  });

  it('returns msg reference when streamText equals msg.text', () => {
    const msg = { text: 'already committed' };
    expect(applyStreamTextToMessage(msg, 'already committed')).toBe(msg);
  });

  it('sets text when no blocks', () => {
    expect(applyStreamTextToMessage({ text: '' }, 'hi')).toEqual({
      text: 'hi',
    });
  });

  it('preserves message blocks without string slicing or block mutation', () => {
    const blocks = [
      { type: 'text', content: 'AB' },
      { type: 'tool_call', id: 't1' },
      { type: 'text', content: 'CD' },
    ];
    const msg = {
      text: 'ABCD',
      blocks,
    };
    const next = applyStreamTextToMessage(msg, 'ABCDEF');
    expect(next.text).toBe('ABCDEF');
    expect(next.blocks).toBe(blocks);
  });

  it('单轨权威流正文：直接以 streamText 为准更新正文，不切片拼接 blocks', () => {
    const blocks = [{ type: 'text', content: 'OLD-COMMITTED' }];
    const msg = {
      text: 'OLD-COMMITTED',
      blocks,
    };
    const next = applyStreamTextToMessage(msg, 'BRAND-NEW-STREAM');
    expect(next.text).toBe('BRAND-NEW-STREAM');
    expect(next.blocks).toBe(blocks);
  });

  it('单轨权威流正文：同源增量直接直通全量流正文', () => {
    const blocks = [{ type: 'text', content: 'AB' }];
    const msg = {
      text: 'AB',
      blocks,
    };
    const next = applyStreamTextToMessage(msg, 'ABCDEF');
    expect(next.text).toBe('ABCDEF');
    expect(next.blocks).toBe(blocks);
  });
});

describe('applyStreamToolsToMessage', () => {
  it('returns msg when tools is empty/undefined', () => {
    const msg = { text: 'x', toolCalls: [] as never[] };
    expect(applyStreamToolsToMessage(msg, undefined)).toBe(msg);
    expect(applyStreamToolsToMessage(msg, {})).toBe(msg);
  });

  it('inserts live running tools and tool_call blocks', () => {
    const msg = { text: 'hi', toolCalls: [] as never[], blocks: [] as never[] };
    const next = applyStreamToolsToMessage(msg, {
      t1: { id: 't1', name: 'shell', status: 'running', arguments: 'pwd' },
    });
    expect(next.toolCalls).toEqual([
      { id: 't1', name: 'shell', status: 'running', arguments: 'pwd' },
    ]);
    expect(next.blocks).toContainEqual({ type: 'tool_call', id: 't1' });
  });

  it('does not downgrade session terminal status', () => {
    const msg = {
      toolCalls: [
        {
          id: 't1',
          name: 'shell',
          status: 'success' as const,
          arguments: 'pwd',
          output: 'ok',
        },
      ],
      blocks: [{ type: 'tool_call', id: 't1' }],
    };
    const next = applyStreamToolsToMessage(msg, {
      t1: { id: 't1', status: 'running', output: 'stale' },
    });
    expect(next).toBe(msg);
    expect(next.toolCalls?.[0]?.status).toBe('success');
  });

  it('merges intermediate fields onto existing running row', () => {
    const msg = {
      toolCalls: [
        { id: 't1', name: 'shell', status: 'running' as const, arguments: '' },
      ],
    };
    const next = applyStreamToolsToMessage(msg, {
      t1: { id: 't1', arguments: '{"path":"/tmp"}', output: '执行中…' },
    });
    expect(next.toolCalls?.[0]).toMatchObject({
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: '{"path":"/tmp"}',
      output: '执行中…',
    });
  });
});

describe('useStreamMessageViewModel 分层装配（R3）', () => {
  beforeEach(() => {
    alignSpy.mockClear();
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('纯文本帧不重跑工具对齐；工具变更才重跑', () => {
    const sessionId = 'sess-r3';
    const msgId = 'msg-r3';
    const baseMsg = {
      id: msgId,
      sender: 'assistant',
      text: '',
      status: 'processing',
      toolCalls: [],
      blocks: [],
    } as unknown as SessionMessage;

    act(() => {
      useStreamingStore.setState({
        byKey: {
          [streamStoreKey(sessionId, msgId)]: {
            sessionId,
            messageId: msgId,
            text: 'A',
            tools: {
              t1: { id: 't1', name: 'shell', status: 'running' },
            },
          },
        },
      });
    });

    const { result, rerender } = renderHook(() =>
      useStreamMessageViewModel(baseMsg, sessionId)
    );
    const alignAfterMount = alignSpy.mock.calls.length;
    expect(alignAfterMount).toBeGreaterThan(0);
    expect(result.current.msg.toolCalls?.length).toBe(1);
    expect(result.current.msg.text).toBe('A');
    const toolCallsRef = result.current.msg.toolCalls;
    const blocksRef = result.current.msg.blocks;

    // 纯文本帧 ×5（setStreamText 按引用保留 tools）→ 工具层 memo 恒命中
    for (let f = 1; f <= 5; f += 1) {
      act(() => {
        useStreamingStore
          .getState()
          .setStreamText(sessionId, msgId, 'A' + 'x'.repeat(f));
      });
      rerender();
    }
    expect(alignSpy.mock.calls.length).toBe(alignAfterMount);
    expect(result.current.msg.text).toBe('Axxxxx');
    // 工具层产物引用稳定（下游时间线签名的 toolCalls/blocks 输入不变）
    expect(result.current.msg.toolCalls).toBe(toolCallsRef);
    expect(result.current.msg.blocks).toBe(blocksRef);

    // 工具变更 → 工具层重算，对齐恰好再跑一次
    act(() => {
      useStreamingStore.getState().setStreamTool(sessionId, msgId, 't1', {
        id: 't1',
        status: 'success',
        output: 'done',
      });
    });
    rerender();
    expect(alignSpy.mock.calls.length).toBe(alignAfterMount + 1);
    expect(result.current.msg.toolCalls?.[0]?.status).toBe('success');
  });
});
