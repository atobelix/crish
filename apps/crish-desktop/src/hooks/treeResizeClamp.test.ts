/**
 * Pure helpers for binary-tree sash resize clamping (no DOM / React).
 */
import { describe, expect, it } from 'vitest';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '../store/layout-tree/types';
import type { LayoutBranch, LayoutNode } from '../store/layout-tree/types';
import {
  MIN_CHILD_PX,
  MIN_LEAF_HEIGHT_PX,
  MIN_LEAF_WIDTH_PX,
  branchChildMinSizesPx,
  clampSplitRatioForChildren,
  clampSplitRatioForParent,
  leafMinSizePx,
  parentPxAlongAxis,
  splitRatioBounds,
  splitRatioBoundsForChildren,
  subtreeMinSizePx,
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

describe('splitRatioBoundsForChildren', () => {
  it('honours asymmetric subtree demands on a large parent', () => {
    // first child is a 2-leaf subtree (640), second is one leaf (320), parent 2000
    const { min, max } = splitRatioBoundsForChildren(2000, 640, 320);
    expect(min).toBeCloseTo(0.32, 6);
    expect(max).toBeCloseTo(0.84, 6);
  });

  it('locks to the proportional share when the parent cannot host both demands', () => {
    // 640 + 320 = 960 > 800 → lock at 640/960 = 2/3, neither side starved
    const { min, max } = splitRatioBoundsForChildren(800, 640, 320);
    expect(min).toBeCloseTo(2 / 3, 6);
    expect(max).toBeCloseTo(2 / 3, 6);
  });

  it('defers to absolute store bounds when the parent is huge', () => {
    const { min, max } = splitRatioBoundsForChildren(5000, 320, 320);
    expect(min).toBe(MIN_SPLIT_RATIO);
    expect(max).toBe(MAX_SPLIT_RATIO);
  });

  it('never produces NaN / inverted bounds for garbage inputs', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const { min, max } = splitRatioBoundsForChildren(bad, NaN, -1);
      expect(Number.isFinite(min)).toBe(true);
      expect(Number.isFinite(max)).toBe(true);
      expect(min).toBeLessThanOrEqual(max);
    }
  });
});

describe('clampSplitRatioForChildren', () => {
  it('clamps up to the first side demand', () => {
    expect(clampSplitRatioForChildren(0.1, 2000, 640, 320)).toBeCloseTo(
      0.32,
      6
    );
  });

  it('clamps down to the second side demand', () => {
    expect(clampSplitRatioForChildren(0.95, 2000, 640, 320)).toBeCloseTo(
      0.84,
      6
    );
  });

  it('passes through values already in range', () => {
    expect(clampSplitRatioForChildren(0.5, 2000, 640, 320)).toBeCloseTo(0.5, 6);
  });

  it('matches the symmetric clamp when demands are equal', () => {
    expect(clampSplitRatioForChildren(0.05, 1000, 240, 240)).toBeCloseTo(
      clampSplitRatioForParent(0.05, 1000),
      6
    );
  });
});

const leaf = (id: string): LayoutNode => ({
  type: 'leaf',
  id,
  panelId: 'chat',
  tabs: [],
  activeTabId: '',
});

const branch = (
  id: string,
  direction: 'horizontal' | 'vertical',
  first: LayoutNode,
  second: LayoutNode
): LayoutNode => ({
  type: 'branch',
  id,
  direction,
  children: [first, second],
  splitRatio: 0.5,
});

describe('leafMinSizePx / subtreeMinSizePx', () => {
  it('uses the width floor on the horizontal axis and the height floor on the vertical axis', () => {
    expect(leafMinSizePx('horizontal')).toBe(MIN_LEAF_WIDTH_PX);
    expect(leafMinSizePx('vertical')).toBe(MIN_LEAF_HEIGHT_PX);
  });

  it('a single leaf demands exactly the axis floor', () => {
    expect(subtreeMinSizePx(leaf('a'), 'horizontal')).toBe(MIN_LEAF_WIDTH_PX);
    expect(subtreeMinSizePx(leaf('a'), 'vertical')).toBe(MIN_LEAF_HEIGHT_PX);
  });

  it('a same-axis branch sums its children', () => {
    const t = branch('b', 'horizontal', leaf('a'), leaf('c'));
    expect(subtreeMinSizePx(t, 'horizontal')).toBe(2 * MIN_LEAF_WIDTH_PX);
  });

  it('a perpendicular branch takes the max of its children along the measured axis', () => {
    const t = branch('b', 'vertical', leaf('a'), leaf('c'));
    expect(subtreeMinSizePx(t, 'horizontal')).toBe(MIN_LEAF_WIDTH_PX);
    expect(subtreeMinSizePx(t, 'vertical')).toBe(2 * MIN_LEAF_HEIGHT_PX);
  });

  it('nested subtrees accumulate along their own axis only', () => {
    const inner = branch('i', 'horizontal', leaf('b'), leaf('c'));
    const t = branch('r', 'horizontal', leaf('a'), inner);
    // width: 320 (leaf) + 640 (inner pair)
    expect(subtreeMinSizePx(t, 'horizontal')).toBe(3 * MIN_LEAF_WIDTH_PX);
    // height: every branch is perpendicular to the height axis → one floor
    expect(subtreeMinSizePx(t, 'vertical')).toBe(MIN_LEAF_HEIGHT_PX);
  });
});

describe('branchChildMinSizesPx', () => {
  it('reports per-side subtree demands for the branch being resized', () => {
    const inner = branch('i', 'horizontal', leaf('b'), leaf('c'));
    const root = branch('r', 'horizontal', leaf('a'), inner) as LayoutBranch;
    expect(branchChildMinSizesPx(root)).toEqual({
      first: MIN_LEAF_WIDTH_PX,
      second: 2 * MIN_LEAF_WIDTH_PX,
    });
  });

  it('uses height demands for vertical branches', () => {
    const root = branch('r', 'vertical', leaf('a'), leaf('b')) as LayoutBranch;
    expect(branchChildMinSizesPx(root)).toEqual({
      first: MIN_LEAF_HEIGHT_PX,
      second: MIN_LEAF_HEIGHT_PX,
    });
  });
});
