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
