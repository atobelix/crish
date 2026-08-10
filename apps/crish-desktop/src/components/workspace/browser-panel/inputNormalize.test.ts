/**
 * 输入归一化纯函数测试（P1-B1）：坐标映射 / 滚轮归一化 / 修饰键 / 点击计数。
 * 对齐 12 文档 §1.3（坐标）/§3.1（修饰键）/§3.4（滚轮）/§3.5（点击判定）。
 */
import { describe, expect, it } from 'vitest';
import {
  cdpModifiers,
  ClickCounter,
  containFit,
  normalizeWheelDelta,
  panelPointToPagePoint,
  pointerButtonsMask,
} from './inputNormalize';

describe('containFit（§2.3 object-fit: contain 语义）', () => {
  it('等比缩放 + 居中留边（横向留边）', () => {
    // 画布 800×600，帧图 400×400（4:3 容器 vs 1:1 图）
    const fit = containFit(800, 600, 400, 400);
    expect(fit.scale).toBe(1.5); // min(800/400, 600/400)
    expect(fit.displayWidth).toBe(600);
    expect(fit.displayHeight).toBe(600);
    expect(fit.offsetX).toBe(100); // 水平居中留边
    expect(fit.offsetY).toBe(0);
  });

  it('纵向留边（画布窄于帧图比例）', () => {
    const fit = containFit(600, 800, 400, 400);
    expect(fit.scale).toBe(1.5);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(100);
  });

  it('1:1 匹配（emulation 锁 1:1 的理想态）：无缩放无留边', () => {
    const fit = containFit(800, 600, 800, 600);
    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(0);
  });

  it('零尺寸防御：退化为单位缩放', () => {
    const fit = containFit(0, 0, 800, 600);
    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(0);
  });
});

describe('panelPointToPagePoint（§2.6 单一比例换算）', () => {
  it('1:1（无留边）：面板坐标 = 页面坐标', () => {
    const fit = containFit(800, 600, 800, 600);
    expect(panelPointToPagePoint(400, 300, fit)).toEqual({ x: 400, y: 300 });
  });

  it('等比缩放：页面坐标 = (面板 - 留边) / scale', () => {
    const fit = containFit(800, 600, 400, 400); // scale 1.5, offsetX 100
    // 画布 (100, 0) 为帧图左上角 → 页面 (0, 0)
    expect(panelPointToPagePoint(100, 0, fit)).toEqual({ x: 0, y: 0 });
    // 画布 (700, 600) 为帧图右下角 → 页面 (400, 400)
    expect(panelPointToPagePoint(700, 600, fit)).toEqual({ x: 400, y: 400 });
    // 画布中心 → 页面中心
    const center = panelPointToPagePoint(400, 300, fit);
    expect(center.x).toBeCloseTo(200, 5);
    expect(center.y).toBeCloseTo(200, 5);
  });
});

describe('normalizeWheelDelta（§3.4）', () => {
  it('deltaMode 0：像素直用', () => {
    expect(normalizeWheelDelta(0, 10, -20, 600)).toEqual({ deltaX: 10, deltaY: -20 });
  });

  it('deltaMode 1（行）：×16', () => {
    expect(normalizeWheelDelta(1, 3, -3, 600)).toEqual({ deltaX: 48, deltaY: -48 });
  });

  it('deltaMode 2（页）：×视口高度', () => {
    expect(normalizeWheelDelta(2, 0.5, -1, 600)).toEqual({ deltaX: 300, deltaY: -600 });
  });
});

describe('pointerButtonsMask（§3.2 位掩码）', () => {
  it('1=左 2=右 4=中 8=back 16=forward 并集', () => {
    expect(pointerButtonsMask(0)).toBe(0);
    expect(pointerButtonsMask(1)).toBe(1);
    expect(pointerButtonsMask(3)).toBe(3); // 左+右
    expect(pointerButtonsMask(18)).toBe(16 | 2); // forward+右
    expect(pointerButtonsMask(31)).toBe(31); // 全按
    expect(pointerButtonsMask(0b11100000)).toBe(0); // 高位屏蔽（未知位不转发）
  });
});

describe('cdpModifiers（§3.1：1=Alt 2=Ctrl 4=Meta 8=Shift）', () => {
  it('单键位', () => {
    expect(cdpModifiers(false, false, true, false)).toBe(1);
    expect(cdpModifiers(true, false, false, false)).toBe(2);
    expect(cdpModifiers(false, false, false, true)).toBe(4);
    expect(cdpModifiers(false, true, false, false)).toBe(8);
  });

  it('组合取并集；全空为 0', () => {
    expect(cdpModifiers(true, true, false, false)).toBe(10); // Ctrl+Shift
    expect(cdpModifiers(true, true, true, true)).toBe(15);
    expect(cdpModifiers(false, false, false, false)).toBe(0);
  });
});

describe('ClickCounter（§3.5 点击判定）', () => {
  it('单击：位移超阈值 → 重置 1', () => {
    const counter = new ClickCounter();
    expect(counter.down(0, 0, 0)).toBe(1);
    expect(counter.down(100, 0, 100)).toBe(1); // 位移 > 5px
  });

  it('双击：位移 <5px 且间隔 <500ms → 2', () => {
    const counter = new ClickCounter();
    expect(counter.down(10, 10, 0)).toBe(1);
    expect(counter.down(12, 11, 100)).toBe(2);
  });

  it('三击：连续同点快速 → 3', () => {
    const counter = new ClickCounter();
    counter.down(0, 0, 0);
    counter.down(1, 1, 100);
    expect(counter.down(2, 1, 200)).toBe(3);
  });

  it('间隔 ≥500ms → 重置 1', () => {
    const counter = new ClickCounter();
    counter.down(0, 0, 0);
    expect(counter.down(1, 1, 600)).toBe(1);
  });

  it('reset 后重新起算', () => {
    const counter = new ClickCounter();
    counter.down(0, 0, 0);
    counter.down(1, 1, 100);
    counter.reset();
    expect(counter.down(2, 2, 200)).toBe(1);
  });
});
