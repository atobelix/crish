import { describe, it, expect } from 'vitest';
import { calculateDiffStatBars } from './gitTreeHelpers';

describe('gitTreeHelpers - calculateDiffStatBars', () => {
  it('calculates diff stat bars properly', () => {
    // 0 / 0
    expect(calculateDiffStatBars(0, 0, 5)).toEqual({
      addBars: 0,
      delBars: 0,
      emptyBars: 5,
    });
    // additions only
    expect(calculateDiffStatBars(100, 0, 5)).toEqual({
      addBars: 5,
      delBars: 0,
      emptyBars: 0,
    });
    // deletions only
    expect(calculateDiffStatBars(0, 50, 5)).toEqual({
      addBars: 0,
      delBars: 5,
      emptyBars: 0,
    });
    // 50 / 50 split
    const split = calculateDiffStatBars(50, 50, 5);
    expect(split.addBars + split.delBars + split.emptyBars).toBe(5);
    expect(split.addBars).toBeGreaterThanOrEqual(2);
    expect(split.delBars).toBeGreaterThanOrEqual(2);
    // 30 / 10 with maxBars = 4
    const custom = calculateDiffStatBars(30, 10, 4);
    expect(custom.addBars).toBe(3);
    expect(custom.delBars).toBe(1);
    expect(custom.emptyBars).toBe(0);
  });

  it('handles negative or edge values safely', () => {
    expect(calculateDiffStatBars(-1, -1, 5)).toEqual({
      addBars: 0,
      delBars: 0,
      emptyBars: 5,
    });
    expect(calculateDiffStatBars(10, 10, 0)).toEqual({
      addBars: 0,
      delBars: 0,
      emptyBars: 0,
    });
  });
});
