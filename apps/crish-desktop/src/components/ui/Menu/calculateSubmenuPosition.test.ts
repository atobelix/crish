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

  it('视口中间有充足左侧空间时：默认向左展开且默认产生 5px 负重叠 (sideOffset = -5)', () => {
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

    // 缺省 sideOffset 参数，验证默认使用 -5px 负重叠
    const res = calculateSubmenuPosition(rowRect, 190, 280);
    // targetX = 600 - 190 - (-5) = 415，子菜单右边界为 415 + 190 = 605，覆盖父级 left 5px
    expect(res.side).toBe('left');
    expect(res.x).toBe(415);
    // targetY = 300 - 4 = 296
    expect(res.y).toBe(296);
    expect(res.transformOrigin).toBe('top right');
  });

  it('左侧空间不足且右侧空间更大时：自动翻转至右侧展开且产生 5px 负重叠 (sideOffset = -5)', () => {
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

    const res = calculateSubmenuPosition(rowRect, 190, 280);
    // spaceLeft = 100 - 8 - (-5) = 97 < 190, spaceRight = 1272 - 270 - (-5) = 1007 > 97
    // targetX = 270 + (-5) = 265，子菜单左边界为 265，覆盖父级 right 5px
    expect(res.side).toBe('right');
    expect(res.x).toBe(265);
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

    const res = calculateSubmenuPosition(rowRect, 190, 280);
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

    const res = calculateSubmenuPosition(rowRect, 190, 280);
    expect(res.x).toBeGreaterThanOrEqual(8);
    expect(res.y).toBeGreaterThanOrEqual(8);
  });

  it('窄视口 (600x400) 下依然满足双向刚性约束与 5px 负重叠', () => {
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

    const res = calculateSubmenuPosition(rowRect, 190, 280);
    // spaceLeft = 120 - 8 - (-5) = 117 < 190
    // spaceRight = 592 - 290 - (-5) = 307 > 117
    expect(res.side).toBe('right');
    expect(res.x).toBe(285); // 290 - 5
    expect(res.x + 190).toBeLessThanOrEqual(600 - 8);
    // maxY = 400 - 8 = 392, maxY - 280 = 112
    expect(res.y).toBe(112);
    expect(res.y + 280).toBeLessThanOrEqual(400 - 8);
  });
});
