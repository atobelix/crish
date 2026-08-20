/**
 * ui/Menu/calculateSubmenuPosition.test.ts — 二级级联子菜单几何定位纯函数单测
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { calculateSubmenuPosition } from './position';
import { MockPhysicalGeometryEngine } from '../../../test-utils/MockPhysicalGeometryEngine';

describe('calculateSubmenuPosition (刚性双向数学钳位与自适应翻转测试)', () => {
  const engine = MockPhysicalGeometryEngine.getInstance();

  beforeEach(() => {
    engine.reset();
    engine.setViewport({ width: 1280, height: 800 });
  });

  afterEach(() => {
    engine.reset();
  });

  it('视口中间有充足左侧空间时：默认向左展开 (side: left, transformOrigin: top right)', () => {
    const rowRect = {
      left: 600,
      right: 770,
      top: 300,
      bottom: 336,
      width: 170,
      height: 36,
      x: 600,
      y: 300,
      toJSON: () => {},
    } as DOMRect;

    const res = calculateSubmenuPosition(rowRect, 190, 280, 4, 8);
    // targetX = 600 - 190 - 4 = 406
    expect(res.side).toBe('left');
    expect(res.x).toBe(406);
    // targetY = 300 - 4 = 296
    expect(res.y).toBe(296);
    expect(res.transformOrigin).toBe('top right');
  });

  it('左侧空间不足且右侧空间更大时：自动翻转至右侧展开 (side: right, transformOrigin: top left)', () => {
    const rowRect = {
      left: 100,
      right: 270,
      top: 300,
      bottom: 336,
      width: 170,
      height: 36,
      x: 100,
      y: 300,
      toJSON: () => {},
    } as DOMRect;

    const res = calculateSubmenuPosition(rowRect, 190, 280, 4, 8);
    // spaceLeft = 100 - 8 - 4 = 88 < 190, spaceRight = 1272 - 270 - 4 = 998 > 88
    // targetX = 270 + 4 = 274
    expect(res.side).toBe('right');
    expect(res.x).toBe(274);
    expect(res.y).toBe(296);
    expect(res.transformOrigin).toBe('top left');
  });

  it('底部溢出时：垂直方向自动贴底向上钳位 (y <= maxY - height)', () => {
    const rowRect = {
      left: 600,
      right: 770,
      top: 700,
      bottom: 736,
      width: 170,
      height: 36,
      x: 600,
      y: 700,
      toJSON: () => {},
    } as DOMRect;

    const res = calculateSubmenuPosition(rowRect, 190, 280, 4, 8);
    // maxY = 800 - 8 = 792, maxTop = 792 - 280 = 512
    // targetY = 700 - 4 = 696 -> clamped to 512
    expect(res.y).toBe(512);
  });

  it('极限左侧越界情况：刚性钳位杜绝负坐标 (x >= minX)', () => {
    const rowRect = {
      left: 2,
      right: 172,
      top: 10,
      bottom: 46,
      width: 170,
      height: 36,
      x: 2,
      y: 10,
      toJSON: () => {},
    } as DOMRect;

    const res = calculateSubmenuPosition(rowRect, 190, 280, 4, 8);
    expect(res.x).toBeGreaterThanOrEqual(8);
    expect(res.y).toBeGreaterThanOrEqual(8);
  });

  it('窄视口 (600x400) 下依然满足双向刚性约束', () => {
    engine.setViewport({ width: 600, height: 400 });

    const rowRect = {
      left: 120,
      right: 290,
      top: 320,
      bottom: 356,
      width: 170,
      height: 36,
      x: 120,
      y: 320,
      toJSON: () => {},
    } as DOMRect;

    const res = calculateSubmenuPosition(rowRect, 190, 280, 4, 8);
    // spaceLeft = 120 - 8 - 4 = 108 < 190
    // spaceRight = 592 - 290 - 4 = 298 > 108
    expect(res.side).toBe('right');
    expect(res.x).toBe(294); // 290 + 4
    expect(res.x + 190).toBeLessThanOrEqual(600 - 8);
    // maxY = 400 - 8 = 392, maxY - 280 = 112
    expect(res.y).toBe(112);
    expect(res.y + 280).toBeLessThanOrEqual(400 - 8);
  });
});
