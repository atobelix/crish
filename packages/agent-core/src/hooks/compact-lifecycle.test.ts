import { describe, expect, it, vi } from 'vitest';
import type { ContextCompressionRecord } from '@crish/shared-types';
import { LifecycleHookRegistry } from './lifecycle-hooks';
import { CONTEXT_COMPACT_END, CONTEXT_COMPACT_START } from './compact-lifecycle-types';
import {
  contextCompactEndAborted,
  contextCompactEndFromRecord,
  emitContextCompactEnd,
  emitContextCompactStart,
} from './compact-lifecycle';

function sampleRecord(overrides: Partial<ContextCompressionRecord> = {}): ContextCompressionRecord {
  return {
    id: 'compact_test_1',
    trigger: 'auto',
    reason: 'threshold',
    summary: 'summary',
    compressedMessageIds: ['m1', 'm2'],
    keptMessageIds: ['m3'],
    tokensBefore: 12_000,
    tokensAfter: 3_000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('compact lifecycle (W6-8 observe-only)', () => {
  it('emitContextCompactStart delivers to observe handlers', async () => {
    const reg = new LifecycleHookRegistry();
    const seen: unknown[] = [];
    reg.observe(CONTEXT_COMPACT_START, (p) => {
      seen.push(p);
    });

    await emitContextCompactStart(reg, {
      sessionId: 'sess-1',
      trigger: 'auto',
      tokensBefore: 9000,
      messageCount: 40,
      reason: 'threshold',
    });

    expect(seen).toEqual([
      {
        sessionId: 'sess-1',
        trigger: 'auto',
        tokensBefore: 9000,
        messageCount: 40,
        reason: 'threshold',
      },
    ]);
  });

  it('emitContextCompactEnd delivers success payload from record helper', async () => {
    const reg = new LifecycleHookRegistry();
    const seen: unknown[] = [];
    reg.observe(CONTEXT_COMPACT_END, (p) => {
      seen.push(p);
    });

    const record = sampleRecord();
    await emitContextCompactEnd(
      reg,
      contextCompactEndFromRecord('sess-2', record, { durationMs: 42 }),
    );

    expect(seen).toEqual([
      {
        sessionId: 'sess-2',
        aborted: false,
        trigger: 'auto',
        tokensBefore: 12_000,
        tokensAfter: 3_000,
        compressedMessageCount: 2,
        keptMessageCount: 1,
        compactionId: 'compact_test_1',
        durationMs: 42,
      },
    ]);
  });

  it('emitContextCompactEnd delivers aborted payload', async () => {
    const reg = new LifecycleHookRegistry();
    const seen: unknown[] = [];
    reg.observe(CONTEXT_COMPACT_END, (p) => {
      seen.push(p);
    });

    await emitContextCompactEnd(
      reg,
      contextCompactEndAborted('sess-3', {
        error: 'summarizer failed',
        trigger: 'overflow',
        tokensBefore: 50_000,
        durationMs: 7,
      }),
    );

    expect(seen).toEqual([
      {
        sessionId: 'sess-3',
        aborted: true,
        error: 'summarizer failed',
        trigger: 'overflow',
        tokensBefore: 50_000,
        durationMs: 7,
      },
    ]);
  });

  it('observe(*) captures compact events alongside turn/tool', async () => {
    const reg = new LifecycleHookRegistry();
    const types: string[] = [];
    reg.observe('*', () => {
      types.push('hit');
    });
    // also typed observe for compact
    const compactTypes: string[] = [];
    reg.observe(CONTEXT_COMPACT_START, () => {
      compactTypes.push('start');
    });
    reg.observe(CONTEXT_COMPACT_END, () => {
      compactTypes.push('end');
    });

    await reg.emit('turn.start', { sessionId: 's', turnIndex: 0 });
    await emitContextCompactStart(reg, { sessionId: 's', messageCount: 1 });
    await emitContextCompactEnd(reg, { sessionId: 's', aborted: false });

    expect(types).toHaveLength(3);
    expect(compactTypes).toEqual(['start', 'end']);
  });

  it('observe failure does not throw (observe-only)', async () => {
    const reg = new LifecycleHookRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.observe(CONTEXT_COMPACT_START, () => {
      throw new Error('telemetry boom');
    });
    let second = false;
    reg.observe(CONTEXT_COMPACT_START, () => {
      second = true;
    });

    await expect(
      emitContextCompactStart(reg, { sessionId: 's' }),
    ).resolves.toBeUndefined();
    expect(second).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not break tool/turn event typing when compact handlers registered', async () => {
    const reg = new LifecycleHookRegistry();
    const sequence: string[] = [];
    reg.observe('turn.start', () => {
      sequence.push('turn.start');
    });
    reg.observe(CONTEXT_COMPACT_START, () => {
      sequence.push('compact.start');
    });
    reg.observe('tool.pre', () => {
      sequence.push('tool.pre');
    });
    reg.observe(CONTEXT_COMPACT_END, () => {
      sequence.push('compact.end');
    });

    await reg.emit('turn.start', { sessionId: 's', turnIndex: 1 });
    await emitContextCompactStart(reg, { sessionId: 's' });
    await reg.emit('tool.pre', {
      sessionId: 's',
      toolCallId: 't1',
      toolName: 'read',
      input: {},
      turnIndex: 1,
      cwd: '/',
    });
    await emitContextCompactEnd(reg, { sessionId: 's', aborted: false });

    expect(sequence).toEqual(['turn.start', 'compact.start', 'tool.pre', 'compact.end']);
  });
});
