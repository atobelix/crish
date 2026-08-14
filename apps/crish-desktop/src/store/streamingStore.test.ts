import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStreamTextToMessage,
  applyStreamToolsToMessage,
  clearSessionStreams,
  clearStream,
  clearStreams,
  clearStreamTool,
  clearStreamTools,
  getStreamEntry,
  getStreamText,
  getStreamThinking,
  getStreamTool,
  getStreamTools,
  setStreamText,
  setStreamThinking,
  setStreamTool,
  streamStoreKey,
  useStreamingStore,
} from './streamingStore';

describe('streamingStore', () => {
  beforeEach(() => {
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('streamStoreKey matches session::message shape', () => {
    expect(streamStoreKey('s1', 'm1')).toBe('s1::m1');
  });

  it('setStreamText / getStreamText round-trip', () => {
    setStreamText('s1', 'm1', 'hello');
    expect(getStreamText('s1', 'm1')).toBe('hello');
    expect(getStreamEntry('s1', 'm1')).toEqual({
      sessionId: 's1',
      messageId: 'm1',
      text: 'hello',
    });
  });

  it('setStreamText is a no-op when text is unchanged', () => {
    setStreamText('s1', 'm1', 'a');
    const snap = useStreamingStore.getState().byKey;
    setStreamText('s1', 'm1', 'a');
    expect(useStreamingStore.getState().byKey).toBe(snap);
  });

  it('热路径同 key 单写：重复 set 同一 messageId 只有一条 entry', () => {
    setStreamText('s1', 'asst-1', 'hel');
    setStreamText('s1', 'asst-1', 'hello');
    setStreamThinking('s1', 'asst-1', 'think');
    const keys = Object.keys(useStreamingStore.getState().byKey);
    expect(keys).toEqual(['s1::asst-1']);
    expect(getStreamText('s1', 'asst-1')).toBe('hello');
    expect(getStreamThinking('s1', 'asst-1')).toBe('think');
  });

  it('setStreamThinking preserves text and vice versa', () => {
    setStreamText('s1', 'm1', 'body');
    setStreamThinking('s1', 'm1', 'think…');
    expect(getStreamText('s1', 'm1')).toBe('body');
    expect(getStreamThinking('s1', 'm1')).toBe('think…');
    setStreamText('s1', 'm1', 'body2');
    expect(getStreamThinking('s1', 'm1')).toBe('think…');
    expect(getStreamText('s1', 'm1')).toBe('body2');
  });

  it('setStreamTool preserves text/thinking; text update preserves tools', () => {
    setStreamText('s1', 'm1', 'body');
    setStreamThinking('s1', 'm1', 'think');
    setStreamTool('s1', 'm1', 't1', {
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: 'ls',
    });
    expect(getStreamTool('s1', 'm1', 't1')).toMatchObject({
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: 'ls',
    });
    setStreamText('s1', 'm1', 'body2');
    expect(getStreamTools('s1', 'm1')?.t1?.name).toBe('shell');
    expect(getStreamThinking('s1', 'm1')).toBe('think');
    setStreamTool('s1', 'm1', 't1', { id: 't1', output: '…' });
    expect(getStreamTool('s1', 'm1', 't1')?.arguments).toBe('ls');
    expect(getStreamTool('s1', 'm1', 't1')?.output).toBe('…');
  });

  it('setStreamTool is a no-op when patch is identical', () => {
    setStreamTool('s1', 'm1', 't1', { id: 't1', name: 'a', status: 'running' });
    const snap = useStreamingStore.getState().byKey;
    setStreamTool('s1', 'm1', 't1', { id: 't1', name: 'a', status: 'running' });
    expect(useStreamingStore.getState().byKey).toBe(snap);
  });

  it('clearStreamTool / clearStreamTools leave text', () => {
    setStreamText('s1', 'm1', 'x');
    setStreamTool('s1', 'm1', 't1', { id: 't1', name: 'a', status: 'running' });
    setStreamTool('s1', 'm1', 't2', { id: 't2', name: 'b', status: 'running' });
    clearStreamTool('s1', 'm1', 't1');
    expect(getStreamTool('s1', 'm1', 't1')).toBeUndefined();
    expect(getStreamTool('s1', 'm1', 't2')?.name).toBe('b');
    clearStreamTools('s1', 'm1');
    expect(getStreamTools('s1', 'm1')).toBeUndefined();
    expect(getStreamText('s1', 'm1')).toBe('x');
  });

  it('clearStream removes one entry', () => {
    setStreamText('s1', 'm1', 'a');
    setStreamText('s1', 'm2', 'b');
    clearStream('s1', 'm1');
    expect(getStreamText('s1', 'm1')).toBeUndefined();
    expect(getStreamText('s1', 'm2')).toBe('b');
  });

  it('clearStreams 精确清理指定 messageIds，同会话其他流不受影响 (A-06)', () => {
    setStreamText('s1', 'agent-a-m1', 'hello from agent A');
    setStreamText('s1', 'agent-b-m1', 'hello from agent B');
    setStreamText('s1', 'agent-c-m1', 'hello from agent C');

    clearStreams('s1', ['agent-a-m1', 'agent-c-m1']);

    expect(getStreamText('s1', 'agent-a-m1')).toBeUndefined();
    expect(getStreamText('s1', 'agent-b-m1')).toBe('hello from agent B');
    expect(getStreamText('s1', 'agent-c-m1')).toBeUndefined();
  });

  it('clearSession removes all keys for that session', () => {
    setStreamText('s1', 'm1', 'a');
    setStreamText('s1', 'm2', 'b');
    setStreamText('s2', 'm1', 'c');
    clearSessionStreams('s1');
    expect(getStreamText('s1', 'm1')).toBeUndefined();
    expect(getStreamText('s1', 'm2')).toBeUndefined();
    expect(getStreamText('s2', 'm1')).toBe('c');
  });
});

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
    // committed msg.text is "AB" only in this fixture; full stream is longer
    // Simulate committed full "ABCD" with trailing "EF"
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

  // D1 锁（T-E 批次 5）：分叉兜底分支——既有 streamingStore 旧值与 committed 正文
  // 不一致（divergence）时，以 stream 全量为权威正文（streamingStore.ts:445-448）。
  it('分叉兜底：stream 不以 committed 开头 → 以 stream 全量为权威正文', () => {
    const msg = {
      text: 'OLD-COMMITTED',
      blocks: [{ type: 'text', content: 'OLD-COMMITTED' }],
    };
    // stream 全量（重放/新 run 覆盖）与 committed 无前缀关系 → 走 divergence 分支
    const next = applyStreamTextToMessage(msg, 'BRAND-NEW-STREAM');
    expect(next.text).toBe('BRAND-NEW-STREAM');
    // 分叉分支语义：blocks 保持既有结构（仅 text 字段以 stream 为权威）
    expect(next.blocks).toBe(msg.blocks);
  });

  // D1 锁：committed 有正文、stream 与 committed 同源但更长 → 尾部增量拼到
  // 最后一个 text block（非分叉路径的对照，锁 merge 兜底分支语义）
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
