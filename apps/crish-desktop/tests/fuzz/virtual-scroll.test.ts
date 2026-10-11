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
    const messageIds = Array.from(
      { length: 1_000_000 },
      (_, index) => `message-${index}`
    );
    vsm.syncOrder(messageIds);
    // 保留一百万条高度缓存写入，覆盖 Map + Fenwick Tree 的真实内存/更新压力。
    for (const id of messageIds) {
      vsm.setEstimated(id, 100);
    }
    expect(vsm.getOrderCount()).toBe(1_000_000);
    expect(vsm.getDebugInfo().heightsSize).toBe(1_000_000);
    expect(vsm.getIndex('message-0')).toBe(0);
    expect(vsm.getIndex('message-500000')).toBe(500_000);
    expect(vsm.getIndex('message-999999')).toBe(999_999);
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
