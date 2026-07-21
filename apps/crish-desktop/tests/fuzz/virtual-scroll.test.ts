import { describe, it, expect } from 'vitest';
import { VirtualScrollManager } from '../../src/api/VirtualScrollManager';

describe('VirtualScrollManager Boundaries', () => {
  it('handles zero items', () => {
    const vsm = new VirtualScrollManager();
    const range = vsm.computeVisibleRange(0, 600, 0, 6);
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(0);
  });

  it('handles negative scrollTop', () => {
    const vsm = new VirtualScrollManager();
    vsm.setEstimated(0, 100);
    const range = vsm.computeVisibleRange(-50, 600, 1, 6);
    expect(range.startIndex).toBe(0);
  });

  it('handles one million items', () => {
    const vsm = new VirtualScrollManager();
    for (let i = 0; i < 1000000; i++) {
      vsm.setEstimated(i, 100);
    }
    const range = vsm.computeVisibleRange(800, 600, 1000000, 6);
    expect(range.startIndex).toBeGreaterThanOrEqual(0);
    expect(range.endIndex).toBeGreaterThan(range.startIndex);
  });

  it('handles NaN/Infinity inputs', () => {
    const vsm = new VirtualScrollManager();
    vsm.setEstimated(0, 100);
    expect(() => vsm.computeVisibleRange(NaN, 600, 1, 6)).not.toThrow();
    expect(() => vsm.computeVisibleRange(Infinity, 600, 1, 6)).not.toThrow();
    expect(() => vsm.computeVisibleRange(0, NaN, 1, 6)).not.toThrow();
  });
});
