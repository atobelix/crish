import { describe, expect, it } from 'vitest';
import {
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
} from './streamMessageViewModel';

describe('applyStreamTextToMessage', () => {
  it('returns msg when streamText is undefined', () => {
    const msg = { text: 'x' };
    expect(applyStreamTextToMessage(msg, undefined)).toBe(msg);
  });

  it('sets text when no blocks', () => {
    expect(applyStreamTextToMessage({ text: '' }, 'hi')).toEqual({
      text: 'hi',
    });
  });

  it('appends trailing delta to last text block after committed prefix', () => {
    const msg = {
      text: 'AB',
      blocks: [
        { type: 'text', content: 'AB' },
        { type: 'tool_call', id: 't1' },
        { type: 'text', content: 'CD' },
      ],
    };
    const committed = {
      text: 'ABCD',
      blocks: msg.blocks,
    };
    const next = applyStreamTextToMessage(committed, 'ABCDEF');
    expect(next.text).toBe('ABCDEF');
    expect(next.blocks?.[2]).toEqual({ type: 'text', content: 'CDEF' });
  });

  it('pushes new text block when last block is a tool', () => {
    const msg = {
      text: 'hi',
      blocks: [
        { type: 'text', content: 'hi' },
        { type: 'tool_call', id: 't1' },
      ],
    };
    const next = applyStreamTextToMessage(msg, 'hi there');
    expect(next.blocks?.[2]).toEqual({ type: 'text', content: ' there' });
  });

  it('分叉兜底：stream 不以 committed 开头 → 以 stream 全量为权威正文', () => {
    const msg = {
      text: 'OLD-COMMITTED',
      blocks: [{ type: 'text', content: 'OLD-COMMITTED' }],
    };
    const next = applyStreamTextToMessage(msg, 'BRAND-NEW-STREAM');
    expect(next.text).toBe('BRAND-NEW-STREAM');
    expect(next.blocks).toBe(msg.blocks);
  });

  it('同源增量：stream 以 committed 开头 → trailing delta 追加', () => {
    const msg = {
      text: 'AB',
      blocks: [{ type: 'text', content: 'AB' }],
    };
    const next = applyStreamTextToMessage(msg, 'ABCDEF');
    expect(next.text).toBe('ABCDEF');
    expect(next.blocks?.[0]).toEqual({ type: 'text', content: 'ABCDEF' });
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
