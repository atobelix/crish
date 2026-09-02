import { describe, it, expect } from 'vitest';
import { computePaneEdges } from '../paneEdgeGeometry';

describe('computePaneEdges', () => {
  it('单窗格铺满视口时全边缘激活', () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    expect(computePaneEdges(rect)).toEqual({
      isTopRow: true,
      isLeftEdge: true,
      isRightEdge: true,
      isBottomRow: true,
    });
  });

  it('左右二分屏左右叶判定', () => {
    const left = { x: 0, y: 0, width: 0.5, height: 1 };
    const right = { x: 0.5, y: 0, width: 0.5, height: 1 };

    expect(computePaneEdges(left)).toEqual({
      isTopRow: true,
      isLeftEdge: true,
      isRightEdge: false,
      isBottomRow: true,
    });

    expect(computePaneEdges(right)).toEqual({
      isTopRow: true,
      isLeftEdge: false,
      isRightEdge: true,
      isBottomRow: true,
    });
  });

  it('上下二分屏上下叶判定', () => {
    const top = { x: 0, y: 0, width: 1, height: 0.5 };
    const bottom = { x: 0, y: 0.5, width: 1, height: 0.5 };

    expect(computePaneEdges(top)).toEqual({
      isTopRow: true,
      isLeftEdge: true,
      isRightEdge: true,
      isBottomRow: false,
    });

    expect(computePaneEdges(bottom)).toEqual({
      isTopRow: false,
      isLeftEdge: true,
      isRightEdge: true,
      isBottomRow: true,
    });
  });

  it('浮点累积误差容差支持 (1/3, 2/3)', () => {
    const rightThird = { x: 0.3333333333333333, y: 0, width: 0.6666666666666666, height: 1 };
    const flags = computePaneEdges(rightThird);
    expect(flags.isTopRow).toBe(true);
    expect(flags.isRightEdge).toBe(true);
    expect(flags.isLeftEdge).toBe(false);
  });

  it('零尺寸或折叠窗格返回全 false', () => {
    const zeroWidth = { x: 0, y: 0, width: 0, height: 1 };
    expect(computePaneEdges(zeroWidth)).toEqual({
      isTopRow: false,
      isLeftEdge: false,
      isRightEdge: false,
      isBottomRow: false,
    });
  });
});
