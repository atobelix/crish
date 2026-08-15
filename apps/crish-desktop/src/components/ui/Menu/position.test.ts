/**
 * ui/Menu/position.ts 纯函数测试：视口边界钳制与避让方向
 * T05.3.1 补充：measureMenu（真实尺寸再钳位）、折叠侧栏窄视口、预估高度溢出
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  clampPosition,
  measureMenu,
  calculateMenuPosition,
  MENU_EDGE_PAD,
  MENU_EST_WIDTH,
  MENU_EST_HEIGHT,
} from './position';

/** 固定视口：160×200 菜单在 1280×800 视口下的期望 */
const VW = 1280;
const VH = 800;

describe('ui/Menu clampPosition', () => {
  it('负坐标钳入视口边缘留白', () => {
    const pos = clampPosition(-20, -10, 160, 200, { width: VW, height: VH });
    expect(pos.x).toBe(MENU_EDGE_PAD);
    expect(pos.y).toBe(MENU_EDGE_PAD);
  });

  it('超出视口右下角时钳回并翻转到另一侧', () => {
    const pos = clampPosition(99999, 99999, 160, 200, {
      width: VW,
      height: VH,
    });
    expect(pos.x).toBe(VW - 160 - MENU_EDGE_PAD);
    expect(pos.y).toBe(VH - 200 - MENU_EDGE_PAD);
    expect(pos.transformOrigin).toBe('bottom right');
  });

  it('视口内坐标保持不变', () => {
    const pos = clampPosition(100, 120, 160, 200, { width: VW, height: VH });
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(120);
    expect(pos.transformOrigin).toMatch(/top|bottom/);
  });

  it('右侧贴边时水平左翻（originX=right）', () => {
    const pos = clampPosition(VW - 100, 50, 160, 200, {
      width: VW,
      height: VH,
    });
    expect(pos.x).toBe(VW - 100 - 160);
    expect(pos.transformOrigin).toContain('right');
  });

  it('底部贴边时垂直上翻（originY=bottom）', () => {
    const pos = clampPosition(100, VH - 100, 160, 200, {
      width: VW,
      height: VH,
    });
    expect(pos.y).toBe(VH - 100 - 200);
    expect(pos.transformOrigin).toContain('bottom');
  });

  it('菜单大于视口时钳到边缘（不退化为负坐标）', () => {
    const pos = clampPosition(10, 10, 3000, 3000, { width: VW, height: VH });
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.x).toBe(MENU_EDGE_PAD);
    expect(pos.y).toBe(MENU_EDGE_PAD);
  });

  it('视口尺寸为 0 时回退 1280×800（纯函数路径，不依赖 window）', () => {
    const pos = clampPosition(99999, 99999, 160, 200, { width: 0, height: 0 });
    expect(pos.x).toBe(VW - 160 - MENU_EDGE_PAD);
    expect(pos.y).toBe(VH - 200 - MENU_EDGE_PAD);
  });

  it('折叠侧栏窄视口：菜单不溢出、不产生负坐标', () => {
    // 侧栏折叠后视口仅剩 320 宽：先水平左翻（300-200=100），
    // 纵向 400+280=680 超出 600 视口 → 垂直上翻（400-280=120）
    const pos = clampPosition(300, 400, 200, 280, { width: 320, height: 600 });
    expect(pos.x).toBe(100);
    expect(pos.x + 200).toBeLessThanOrEqual(320 - MENU_EDGE_PAD);
    expect(pos.y).toBe(120);
  });

  it('预估高度溢出（菜单高于视口）时钳到边缘而非负坐标', () => {
    const pos = clampPosition(50, 100, 160, 3000, { width: VW, height: 200 });
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBe(MENU_EDGE_PAD);
  });
});

describe('ui/Menu measureMenu（真实尺寸再钳位）', () => {
  function fakeEl(width: number, height: number): HTMLElement {
    return {
      getBoundingClientRect: () =>
        ({
          width,
          height,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
        }) as DOMRect,
    } as HTMLElement;
  }

  it('按元素真实尺寸钳位，行为与 clampPosition 一致', () => {
    const el = fakeEl(200, 300);
    const pos = measureMenu(el, 99999, 99999, { width: VW, height: VH });
    expect(pos.x).toBe(VW - 200 - MENU_EDGE_PAD);
    expect(pos.y).toBe(VH - 300 - MENU_EDGE_PAD);
    expect(pos.transformOrigin).toBe('bottom right');
  });

  it('视口内坐标保持原值', () => {
    const el = fakeEl(200, 300);
    const pos = measureMenu(el, 100, 120, { width: VW, height: VH });
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(120);
  });

  it('窄视口下按真实尺寸回钳，不溢出', () => {
    const el = fakeEl(240, 300);
    const pos = measureMenu(el, 250, 500, { width: 280, height: 600 });
    // 先水平左翻（250-240=10），落在留白内
    expect(pos.x).toBe(10);
  });

  it('元素未渲染（零矩形）时回退预估尺寸钳位，不按 0 尺寸原样放行（F7-F11）', () => {
    // display:none / 未挂载时 getBoundingClientRect 全 0：
    // 按 0 尺寸钳位等于不钳位（坐标原样放行 → 菜单溢出视口）
    const zeroEl = fakeEl(0, 0);
    const pos = measureMenu(zeroEl, 99999, 99999, { width: 1280, height: 800 });
    expect(pos.x).toBe(1280 - MENU_EST_WIDTH - MENU_EDGE_PAD);
    expect(pos.y).toBe(800 - MENU_EST_HEIGHT - MENU_EDGE_PAD);
    expect(pos.transformOrigin).toBe('bottom right');
  });
});

describe('ui/Menu calculateMenuPosition（不可变纯函数单源定位）', () => {
  it('保持输入 anchor 不可变', () => {
    const anchor = Object.freeze({ x: 500, y: 300, width: 100, height: 30 });
    const pos = calculateMenuPosition({
      anchor,
      menu: { width: 180, height: 240 },
      viewport: { width: VW, height: VH },
      preferredSide: 'bottom',
      preferredAlign: 'start',
    });
    expect(anchor.x).toBe(500);
    expect(anchor.y).toBe(300);
    expect(pos.x).toBe(500);
    expect(pos.y).toBe(330);
    expect(pos.isFlippedX).toBe(false);
    expect(pos.isFlippedY).toBe(false);
  });

  it('右边缘碰撞自动向左展开（isFlippedX = true）', () => {
    const pos = calculateMenuPosition({
      anchor: { x: 1200, y: 100, width: 60, height: 30 },
      menu: { width: 180, height: 200 },
      viewport: { width: VW, height: VH },
      preferredSide: 'bottom',
      preferredAlign: 'start',
    });
    expect(pos.isFlippedX).toBe(true);
    expect(pos.x).toBe(1200 + 60 - 180);
    expect(pos.x + 180).toBeLessThanOrEqual(VW - MENU_EDGE_PAD);
  });

  it('底边缘碰撞自动向上翻转（isFlippedY = true）', () => {
    const pos = calculateMenuPosition({
      anchor: { x: 100, y: 700, width: 60, height: 30 },
      menu: { width: 180, height: 200 },
      viewport: { width: VW, height: VH },
      preferredSide: 'bottom',
    });
    expect(pos.isFlippedY).toBe(true);
    expect(pos.y).toBe(700 - 200);
    expect(pos.placement.side).toBe('top');
  });

  it('侧向展开（preferredSide: right）在右侧不足时翻向左侧', () => {
    const pos = calculateMenuPosition({
      anchor: { x: 1150, y: 200, width: 100, height: 36 },
      menu: { width: 160, height: 120 },
      viewport: { width: VW, height: VH },
      preferredSide: 'right',
      preferredAlign: 'start',
    });
    expect(pos.isFlippedX).toBe(true);
    expect(pos.placement.side).toBe('left');
    expect(pos.x).toBe(1150 - 160);
  });
});
