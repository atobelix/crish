import { describe, expect, it } from 'vitest';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  createBranch,
  createLeaf,
} from './types';

describe('clampSplitRatio 参考手感 [0.12, 0.88]', () => {
  it('导出上下限为 0.12 / 0.88', () => {
    expect(MIN_SPLIT_RATIO).toBe(0.12);
    expect(MAX_SPLIT_RATIO).toBe(0.88);
  });

  it('边界内原样通过', () => {
    expect(clampSplitRatio(0.12)).toBe(0.12);
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.88)).toBe(0.88);
  });

  it('低于 0.12 抬到下限；高于 0.88 压到上限', () => {
    expect(clampSplitRatio(0.1)).toBe(0.12);
    expect(clampSplitRatio(0)).toBe(0.12);
    expect(clampSplitRatio(-1)).toBe(0.12);
    expect(clampSplitRatio(0.9)).toBe(0.88);
    expect(clampSplitRatio(1)).toBe(0.88);
  });

  it('createBranch 经 clampSplitRatio 钳制', () => {
    const a = createLeaf('a');
    const b = createLeaf('b');
    expect(createBranch('horizontal', a, b, 0.01).splitRatio).toBe(0.12);
    expect(createBranch('horizontal', a, b, 0.99).splitRatio).toBe(0.88);
    expect(createBranch('horizontal', a, b, 0.5).splitRatio).toBe(0.5);
  });
});
