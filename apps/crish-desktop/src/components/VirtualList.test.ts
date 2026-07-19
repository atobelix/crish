import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeVisibleRange } from './VirtualList';

describe('computeVisibleRange', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  it('returns [0,0] for empty items', () => {
    expect(computeVisibleRange([], 0, 500, 50, 5)).toEqual([0, 0]);
  });

  it('returns [0,0] for zero container height', () => {
    expect(computeVisibleRange(items, 0, 0, 50, 5)).toEqual([0, 0]);
  });

  it('shows first page at scrollTop 0', () => {
    const [start, end] = computeVisibleRange(items, 0, 500, 50, 5);
    expect(start).toBe(0);
    expect(end).toBeGreaterThanOrEqual(10);
    expect(end).toBeLessThanOrEqual(20);
  });

  it('shows middle items when scrolled', () => {
    const [start, end] = computeVisibleRange(items, 2500, 500, 50, 5);
    expect(start).toBeGreaterThanOrEqual(45);
    expect(end).toBeLessThanOrEqual(65);
    expect(end - start).toBeGreaterThanOrEqual(10);
    expect(end).toBeLessThanOrEqual(100);
  });

  it('handles scroll near the end', () => {
    const [start, end] = computeVisibleRange(items, 4750, 500, 50, 5);
    expect(start).toBeGreaterThanOrEqual(85);
    expect(end).toBe(100);
  });

  it('respects overscan', () => {
    const [s1, e1] = computeVisibleRange(items, 0, 500, 50, 0);
    const [s2, e2] = computeVisibleRange(items, 0, 500, 50, 10);
    expect(e2 - s2).toBeGreaterThan(e1 - s1);
  });

  it('clamps overscan beyond array bounds', () => {
    const [start, end] = computeVisibleRange(items, 0, 500, 50, 999);
    expect(start).toBe(0);
    expect(end).toBe(100);
  });
});

describe('VirtualList component', () => {
  beforeEach(() => {
    // Minimal DOM stubs for node env
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  it('exports expected symbols', async () => {
    const mod = await import('./VirtualList');
    expect(typeof mod.VirtualList).toBe('function');
    expect(typeof mod.computeVisibleRange).toBe('function');
    expect(mod.VirtualList.name).toBe('VirtualList');
  });
});
