/**
 * Pure helpers for binary-tree sash resize clamping (no DOM / React).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
} from '../store/layout-tree/types';
import {
  MIN_CHILD_PX,
  clampSplitRatioForParent,
  parentPxAlongAxis,
  splitRatioBounds,
} from './treeResizeClamp';

describe('splitRatioBounds', () => {
  it('enforces ~240px per child on a large parent', () => {
    // 1000px parent → min ratio 0.24, max 0.76
    const { min, max } = splitRatioBounds(1000);
    expect(min).toBeCloseTo(MIN_CHILD_PX / 1000, 6);
    expect(max).toBeCloseTo(1 - MIN_CHILD_PX / 1000, 6);
    expect(min).toBeGreaterThan(MIN_SPLIT_RATIO);
    expect(max).toBeLessThan(MAX_SPLIT_RATIO);
  });

  it('defers to absolute store bounds when parent is huge', () => {
    // 5000px → pixel min 240/5000 = 0.048 < 0.12 → abs floor wins
    const { min, max } = splitRatioBounds(5000);
    expect(min).toBe(MIN_SPLIT_RATIO);
    expect(max).toBe(MAX_SPLIT_RATIO);
  });

  it('locks near 50/50 when parent cannot host 2× minChildPx', () => {
    // 300px < 480 → effective min = 150 → ratio 0.5
    const { min, max } = splitRatioBounds(300);
    expect(min).toBeCloseTo(0.5, 6);
    expect(max).toBeCloseTo(0.5, 6);
  });

  it('handles zero / negative / non-finite parent without NaN', () => {
    for (const bad of [0, -10, NaN, Infinity, -Infinity]) {
      const { min, max } = splitRatioBounds(bad);
      expect(Number.isFinite(min)).toBe(true);
      expect(Number.isFinite(max)).toBe(true);
      expect(min).toBeLessThanOrEqual(max);
    }
  });

  it('always keeps min ≤ max', () => {
    for (const dim of [1, 50, 240, 479, 480, 500, 1000, 2400, 10000]) {
      const { min, max } = splitRatioBounds(dim);
      expect(min).toBeLessThanOrEqual(max);
    }
  });
});

describe('clampSplitRatioForParent', () => {
  it('clamps below pixel min up to min child size', () => {
    // 1000px parent, raw 0.05 → 0.24
    expect(clampSplitRatioForParent(0.05, 1000)).toBeCloseTo(0.24, 6);
  });

  it('clamps above pixel max', () => {
    expect(clampSplitRatioForParent(0.95, 1000)).toBeCloseTo(0.76, 6);
  });

  it('passes through values already in range', () => {
    expect(clampSplitRatioForParent(0.4, 1000)).toBeCloseTo(0.4, 6);
  });

  it('returns midpoint for non-finite ratio', () => {
    const mid = clampSplitRatioForParent(NaN, 1000);
    expect(mid).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(mid)).toBe(true);
  });

  it('never returns NaN for garbage inputs', () => {
    const r = clampSplitRatioForParent(NaN, NaN);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe('parentPxAlongAxis', () => {
  it('picks width for horizontal and height for vertical', () => {
    const rect = { width: 800, height: 400 };
    expect(parentPxAlongAxis(rect, 'horizontal')).toBe(800);
    expect(parentPxAlongAxis(rect, 'vertical')).toBe(400);
  });

  it('falls back to 1 for bad dimensions', () => {
    expect(parentPxAlongAxis({ width: 0, height: 100 }, 'horizontal')).toBe(1);
    expect(parentPxAlongAxis({ width: 100, height: NaN }, 'vertical')).toBe(1);
  });
});
