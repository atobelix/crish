import { describe, expect, it, vi } from 'vitest';
import { StreamBackpressureRegistry } from './stream-backpressure.js';

describe('StreamBackpressureRegistry', () => {
  it('pause → tryBuffer true; resume returns buffered messages in order', () => {
    const bp = new StreamBackpressureRegistry();
    expect(bp.tryBuffer('run-1', { type: 'a' })).toBe(false);

    bp.pause('run-1');
    expect(bp.isPaused('run-1')).toBe(true);
    expect(bp.tryBuffer('run-1', { type: 'a' })).toBe(true);
    expect(bp.tryBuffer('run-1', { type: 'b' })).toBe(true);
    expect(bp.bufferedCount('run-1')).toBe(2);

    // other runs unaffected
    expect(bp.tryBuffer('run-2', { type: 'x' })).toBe(false);

    const flushed = bp.resume('run-1');
    expect(flushed).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(bp.isPaused('run-1')).toBe(false);
    expect(bp.bufferedCount('run-1')).toBe(0);
    expect(bp.tryBuffer('run-1', { type: 'c' })).toBe(false);
  });

  it('waitIfPaused resolves after resume', async () => {
    const bp = new StreamBackpressureRegistry();
    bp.pause('run-wait');

    let resolved = false;
    const waiting = bp.waitIfPaused('run-wait').then(() => {
      resolved = true;
    });

    // still paused → not resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    bp.resume('run-wait');
    await waiting;
    expect(resolved).toBe(true);
  });

  it('waitIfPaused is a no-op when not paused', async () => {
    const bp = new StreamBackpressureRegistry();
    await expect(bp.waitIfPaused('run-free')).resolves.toBeUndefined();
  });

  it('drop-oldest at maxBuffered', () => {
    const bp = new StreamBackpressureRegistry(3);
    bp.pause('run-cap');
    expect(bp.tryBuffer('run-cap', 1)).toBe(true);
    expect(bp.tryBuffer('run-cap', 2)).toBe(true);
    expect(bp.tryBuffer('run-cap', 3)).toBe(true);
    expect(bp.tryBuffer('run-cap', 4)).toBe(true);
    expect(bp.tryBuffer('run-cap', 5)).toBe(true);
    expect(bp.bufferedCount('run-cap')).toBe(3);
    expect(bp.resume('run-cap')).toEqual([3, 4, 5]);
  });

  it('clearRun drops buffer and wakes waiters', async () => {
    const bp = new StreamBackpressureRegistry();
    bp.pause('run-clear');
    bp.tryBuffer('run-clear', { type: 'lost' });

    const waiting = bp.waitIfPaused('run-clear');
    bp.clearRun('run-clear');

    await waiting;
    expect(bp.isPaused('run-clear')).toBe(false);
    expect(bp.bufferedCount('run-clear')).toBe(0);
    // second resume is empty
    expect(bp.resume('run-clear')).toEqual([]);
  });

  it('ignores empty runId', () => {
    const bp = new StreamBackpressureRegistry();
    bp.pause('');
    expect(bp.isPaused('')).toBe(false);
    expect(bp.tryBuffer('', { type: 'x' })).toBe(false);
    expect(bp.resume('')).toEqual([]);
  });

  it('resume is idempotent and wakes multiple waiters', async () => {
    const bp = new StreamBackpressureRegistry();
    bp.pause('run-multi');

    const a = vi.fn();
    const b = vi.fn();
    const p1 = bp.waitIfPaused('run-multi').then(a);
    const p2 = bp.waitIfPaused('run-multi').then(b);

    bp.resume('run-multi');
    await Promise.all([p1, p2]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();

    // second resume is a no-op flush
    expect(bp.resume('run-multi')).toEqual([]);
  });
});
