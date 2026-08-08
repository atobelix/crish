import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamBuffer } from '../../src/core/StreamBuffer';

describe('StreamBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(cb, 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('合并同帧多次 push 为单次 callback', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('a');
    buffer.push('b');
    buffer.push('c');
    expect(cb).not.toHaveBeenCalled();
    expect(buffer.pending).toBe(3);

    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('abc');
    expect(buffer.pending).toBe(0);
  });

  it('flush 立即触发', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('a');
    buffer.push('b');
    buffer.flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('ab');
    expect(buffer.pending).toBe(0);

    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it('dispose 清除待处理', () => {
    const cb = vi.fn();
    const buffer = new StreamBuffer(cb);
    buffer.push('a');
    buffer.dispose();
    expect(buffer.pending).toBe(0);

    vi.advanceTimersByTime(16);
    expect(cb).not.toHaveBeenCalled();
  });
});
