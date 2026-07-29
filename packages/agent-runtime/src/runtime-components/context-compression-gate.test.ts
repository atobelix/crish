import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ContextCompressionRecord } from '@crish/shared-types';
import { LifecycleHookRegistry } from '../hooks/lifecycle-hooks';
import { CONTEXT_COMPACT_END, CONTEXT_COMPACT_START } from '../hooks/compact-lifecycle';
import { ContextCompressionGate } from './context-compression-gate';
import type { ContextManager } from './context-manager';

function msg(id: string, text: string): AgentMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    blocks: [{ type: 'text', text }],
  };
}

function record(partial: Partial<ContextCompressionRecord> = {}): ContextCompressionRecord {
  return {
    id: 'compact_gate_1',
    trigger: 'auto',
    reason: 'threshold',
    summary: 'ok',
    compressedMessageIds: ['a', 'b'],
    keptMessageIds: ['c'],
    tokensBefore: 8000,
    tokensAfter: 2000,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function mockContextManager(
  impl: ContextManager['maybeCompress'],
): ContextManager {
  return { maybeCompress: impl } as unknown as ContextManager;
}

describe('ContextCompressionGate lifecycle emit (W6-8)', () => {
  it('emits context.compact.start/end on successful compress', async () => {
    const reg = new LifecycleHookRegistry();
    const events: Array<{ type: string; payload: unknown }> = [];
    reg.observe(CONTEXT_COMPACT_START, (p) => {
      events.push({ type: CONTEXT_COMPACT_START, payload: p });
    });
    reg.observe(CONTEXT_COMPACT_END, (p) => {
      events.push({ type: CONTEXT_COMPACT_END, payload: p });
    });

    const original = [msg('a', 'x'.repeat(100)), msg('b', 'y'.repeat(100)), msg('c', 'kept')];
    const compressed = [msg('summary', 'summary text'), msg('c', 'kept')];
    const rec = record();

    const cm = mockContextManager(async (_messages, replaceMessages, onEvent) => {
      await onEvent('compression-start', {
        trigger: 'auto',
        tokensBefore: 8000,
        messageCount: 3,
        reason: 'threshold',
      });
      replaceMessages(compressed);
      await onEvent('compression-end', { record: rec, aborted: false, trigger: 'auto', tokensBefore: 8000 });
    });

    const gate = new ContextCompressionGate(cm, {
      lifecycleHooks: reg,
      sessionId: 'sess-gate',
    });
    const result = await gate.maybeCompress(original);

    expect(result.compressed).toBe(true);
    expect(result.messages).toEqual(compressed);
    expect(result.record).toEqual(rec);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: CONTEXT_COMPACT_START,
      payload: {
        sessionId: 'sess-gate',
        trigger: 'auto',
        tokensBefore: 8000,
        messageCount: 3,
        reason: 'threshold',
      },
    });
    expect(events[1]).toMatchObject({
      type: CONTEXT_COMPACT_END,
      payload: {
        sessionId: 'sess-gate',
        aborted: false,
        compactionId: 'compact_gate_1',
        tokensBefore: 8000,
        tokensAfter: 2000,
        compressedMessageCount: 2,
        keptMessageCount: 1,
      },
    });
    expect((events[1]!.payload as { durationMs?: number }).durationMs).toBeTypeOf('number');
  });

  it('emits context.compact.end aborted when compress fails region', async () => {
    const reg = new LifecycleHookRegistry();
    const ends: unknown[] = [];
    reg.observe(CONTEXT_COMPACT_END, (p) => {
      ends.push(p);
    });

    const cm = mockContextManager(async (_m, _r, onEvent) => {
      await onEvent('compression-start', { trigger: 'auto', tokensBefore: 100 });
      await onEvent('compression-end', {
        aborted: true,
        error: 'No compressible context region',
        tokensBefore: 100,
        trigger: 'auto',
      });
    });

    const gate = new ContextCompressionGate(cm, {
      lifecycleHooks: reg,
      sessionId: 'sess-abort',
    });
    const result = await gate.maybeCompress([msg('only', 'hi')]);

    expect(result.compressed).toBe(false);
    expect(result.error).toBe('No compressible context region');
    expect(ends).toEqual([
      expect.objectContaining({
        sessionId: 'sess-abort',
        aborted: true,
        error: 'No compressible context region',
        trigger: 'auto',
        tokensBefore: 100,
      }),
    ]);
  });

  it('emits compact.end on compression-error path', async () => {
    const reg = new LifecycleHookRegistry();
    const ends: unknown[] = [];
    reg.observe(CONTEXT_COMPACT_END, (p) => {
      ends.push(p);
    });

    const cm = mockContextManager(async (_m, _r, onEvent) => {
      await onEvent('compression-start', { trigger: 'auto', tokensBefore: 50 });
      await onEvent('compression-error', {
        error: 'boom',
        tokensBefore: 50,
        trigger: 'auto',
      });
    });

    const gate = new ContextCompressionGate(cm, {
      lifecycleHooks: reg,
      sessionId: 'sess-err',
    });
    const result = await gate.maybeCompress([msg('a', 'x')]);

    expect(result.compressed).toBe(false);
    expect(result.error).toBe('boom');
    expect(ends[0]).toMatchObject({
      sessionId: 'sess-err',
      aborted: true,
      error: 'boom',
      trigger: 'auto',
      tokensBefore: 50,
    });
  });

  it('skips lifecycle emit when registry not configured (back-compat)', async () => {
    const onEventSpy = vi.fn(async (type: string, detail?: unknown) => {
      if (type === 'compression-start') {
        /* start */
      } else if (type === 'compression-end') {
        void detail;
      }
    });
    const cm = mockContextManager(async (messages, replaceMessages, onEvent) => {
      await onEvent('compression-start', { trigger: 'auto' });
      replaceMessages(messages);
      await onEvent('compression-end', { record: record(), aborted: false });
      onEventSpy('compression-end');
    });

    const gate = new ContextCompressionGate(cm);
    const result = await gate.maybeCompress([msg('a', 'x')]);
    expect(result.compressed).toBe(true);
    // no registry → no throw, compress still works
    expect(result.record?.id).toBe('compact_gate_1');
  });

  it('lifecycle observe failure does not break compress result', async () => {
    const reg = new LifecycleHookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.observe(CONTEXT_COMPACT_START, () => {
      throw new Error('observe broken');
    });

    const rec = record();
    const cm = mockContextManager(async (_m, replace, onEvent) => {
      await onEvent('compression-start', { trigger: 'auto' });
      replace([msg('s', 'sum')]);
      await onEvent('compression-end', { record: rec, aborted: false });
    });

    const gate = new ContextCompressionGate(cm, {
      lifecycleHooks: reg,
      sessionId: 'sess-obs',
    });
    const result = await gate.maybeCompress([msg('a', 'x')]);
    expect(result.compressed).toBe(true);
    expect(result.record).toEqual(rec);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
