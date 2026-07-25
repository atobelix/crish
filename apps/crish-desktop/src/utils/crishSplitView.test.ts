import { describe, it, expect } from 'vitest';
import { computeResize, checkSnap } from './crishSplitView';

describe('computeResize', () => {
  it('拖拽 -10% 左侧减小右侧增大', () => {
    const items = [
      { ratio: 0.5, constraint: { minimumSize: 0.1, maximumSize: 0.9, priority: 'normal' as const } },
      { ratio: 0.5, constraint: { minimumSize: 0.1, maximumSize: 0.9, priority: 'normal' as const } },
    ];
    const result = computeResize(items, 0, -10, 100);
    expect(result[0]).toBeCloseTo(0.4);
    expect(result[1]).toBeCloseTo(0.6);
  });

  it('不超出最小约束', () => {
    const items = [
      { ratio: 0.15, constraint: { minimumSize: 0.1, maximumSize: 0.9, priority: 'normal' as const } },
      { ratio: 0.85, constraint: { minimumSize: 0.1, maximumSize: 0.9, priority: 'normal' as const } },
    ];
    const result = computeResize(items, 0, -30, 100);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.9);
  });
});

describe('checkSnap', () => {
  it('在吸附阈值内返回吸附位置', () => {
    const result = checkSnap(0.3, [0.25, 0.5, 0.75], 100, 10);
    expect(result).toBeCloseTo(0.25);
  });

  it('超出阈值不吸附', () => {
    const result = checkSnap(0.3, [0.5, 0.75], 100, 10);
    expect(result).toBeNull();
  });
});
