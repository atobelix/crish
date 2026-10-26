import { describe, it, expect } from 'vitest';
import {
  parseCssColor,
  rgbToOklab,
  oklabToRgb,
  oklabMix,
  relativeLuminance,
  wcagContrast,
  deltaL,
  blendAlpha,
} from './colorUtils';

describe('colorUtils 纯函数色彩转换与度量工具', () => {
  describe('parseCssColor CSS 颜色解析', () => {
    it('正确解析 16 进制颜色 (#hex)', () => {
      expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
      expect(parseCssColor('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(parseCssColor('#141414')).toEqual({ r: 20, g: 20, b: 20, a: 1 });
      expect(parseCssColor('#ff000080')).toEqual({
        r: 255,
        g: 0,
        b: 0,
        a: 0.502,
      });
      expect(parseCssColor('#0f08')).toEqual({ r: 0, g: 255, b: 0, a: 0.533 });
    });

    it('正确解析 rgb 与 rgba (逗号及现代斜杠空格语法)', () => {
      expect(parseCssColor('rgb(255, 0, 128)')).toEqual({
        r: 255,
        g: 0,
        b: 128,
        a: 1,
      });
      expect(parseCssColor('rgba(255, 0, 128, 0.5)')).toEqual({
        r: 255,
        g: 0,
        b: 128,
        a: 0.5,
      });
      expect(parseCssColor('rgb(100 200 50 / 0.8)')).toEqual({
        r: 100,
        g: 200,
        b: 50,
        a: 0.8,
      });
      expect(parseCssColor('rgb(100% 0% 0% / 50%)')).toEqual({
        r: 255,
        g: 0,
        b: 0,
        a: 0.5,
      });
    });

    it('正确解析 hsl 与 hsla', () => {
      const red = parseCssColor('hsl(0, 100%, 50%)');
      expect(red.r).toBe(255);
      expect(red.g).toBe(0);
      expect(red.b).toBe(0);
      expect(red.a).toBe(1);

      const greenWithAlpha = parseCssColor('hsl(120deg 100% 50% / 0.5)');
      expect(greenWithAlpha.r).toBe(0);
      expect(greenWithAlpha.g).toBe(255);
      expect(greenWithAlpha.b).toBe(0);
      expect(greenWithAlpha.a).toBe(0.5);
    });

    it('正确解析 transparent 与标准颜色名称', () => {
      expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
      expect(parseCssColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
      expect(parseCssColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    });

    it('正确解析 oklab(...) 表达式', () => {
      const parsed = parseCssColor('oklab(0.5 0.1 -0.1 / 0.8)');
      expect(parsed.r).toBeGreaterThan(0);
      expect(parsed.a).toBe(0.8);
    });

    it('退化态容错：非法颜色安全回退至兜底黑色并不抛出异常', () => {
      expect(() => parseCssColor('not-a-color')).not.toThrow();
      expect(parseCssColor('not-a-color')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(parseCssColor('')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(parseCssColor(null as unknown as string)).toEqual({
        r: 0,
        g: 0,
        b: 0,
        a: 1,
      });
    });
  });

  describe('sRGB ↔ Oklab 往返与对称性', () => {
    it('纯黑与纯白在 Oklab 空间的极限值', () => {
      const blackLab = rgbToOklab({ r: 0, g: 0, b: 0 });
      expect(blackLab.L).toBeCloseTo(0, 4);
      expect(blackLab.a).toBeCloseTo(0, 4);
      expect(blackLab.b).toBeCloseTo(0, 4);

      const whiteLab = rgbToOklab({ r: 255, g: 255, b: 255 });
      expect(whiteLab.L).toBeCloseTo(1, 4);
      expect(whiteLab.a).toBeCloseTo(0, 4);
      expect(whiteLab.b).toBeCloseTo(0, 4);
    });

    it('Oklab 转回 sRGB 往返精度误差 <= 1 RGB 阶', () => {
      const testCases = [
        { r: 20, g: 20, b: 20 },
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 128, b: 255 },
        { r: 120, g: 80, b: 200 },
        { r: 250, g: 250, b: 250 },
      ];

      for (const orig of testCases) {
        const lab = rgbToOklab(orig);
        const back = oklabToRgb(lab);
        expect(Math.abs(back.r - orig.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.g - orig.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(back.b - orig.b)).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('oklabMix 颜色插值', () => {
    it('插值满足对称性：oklabMix(c1, c2, 0.3) 与 oklabMix(c2, c1, 0.7) 严格等价', () => {
      const c1 = '#ff5500';
      const c2 = '#0088ff';
      const mix1 = oklabMix(c1, c2, 0.3);
      const mix2 = oklabMix(c2, c1, 0.7);

      expect(Math.abs(mix1.r - mix2.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(mix1.g - mix2.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(mix1.b - mix2.b)).toBeLessThanOrEqual(1);
      expect(mix1.a).toBe(mix2.a);
    });

    it('插值边界：p=0 还原 c1，p=1 还原 c2', () => {
      const c1 = { r: 100, g: 100, b: 100, a: 1 };
      const c2 = { r: 200, g: 200, b: 200, a: 0.8 };

      const atZero = oklabMix(c1, c2, 0);
      expect(Math.abs(atZero.r - 100)).toBeLessThanOrEqual(1);
      expect(atZero.a).toBe(1);

      const atOne = oklabMix(c1, c2, 1);
      expect(Math.abs(atOne.r - 200)).toBeLessThanOrEqual(1);
      expect(atOne.a).toBe(0.8);
    });
  });

  describe('WCAG 2.1 相对亮度与对比度', () => {
    it('纯黑 vs 纯白 对比度严格等于 21.0:1', () => {
      expect(wcagContrast('#000000', '#ffffff')).toBe(21);
      expect(wcagContrast('#ffffff', '#000000')).toBe(21);
    });

    it('对比度具有正逆向对称性', () => {
      const c1 = '#141414';
      const c2 = '#f5f5f5';
      expect(wcagContrast(c1, c2)).toBe(wcagContrast(c2, c1));
    });

    it('相同颜色对比度严格等于 1.0:1', () => {
      expect(wcagContrast('#141414', '#141414')).toBe(1);
      expect(wcagContrast('#ffffff', '#ffffff')).toBe(1);
    });

    it('相对亮度计算符合规范', () => {
      expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
      expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 4);
    });
  });

  describe('deltaL Oklab 明度差', () => {
    it('相同颜色明度差为 0', () => {
      expect(deltaL('#141414', '#141414')).toBe(0);
      expect(deltaL('#ffffff', '#ffffff')).toBe(0);
    });

    it('黑白明度差为 100', () => {
      expect(deltaL('#000000', '#ffffff')).toBe(100);
    });

    it('明度差具备正逆向对称性', () => {
      expect(deltaL('#202020', '#e0e0e0')).toBe(deltaL('#e0e0e0', '#202020'));
    });
  });

  describe('blendAlpha Porter-Duff Source-Over 合成', () => {
    it('纯透明覆盖在底板上保持底板颜色不变', () => {
      const transparent: import('./colorUtils').RGB = {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
      };
      const backdrop: import('./colorUtils').RGB = {
        r: 200,
        g: 100,
        b: 50,
        a: 1,
      };
      const result = blendAlpha(transparent, backdrop);
      expect(result).toEqual({ r: 200, g: 100, b: 50, a: 1 });
    });

    it('完全不透明图层覆盖底板完全遮蔽底板', () => {
      const opaque: import('./colorUtils').RGB = { r: 10, g: 20, b: 30, a: 1 };
      const backdrop: import('./colorUtils').RGB = {
        r: 200,
        g: 100,
        b: 50,
        a: 1,
      };
      const result = blendAlpha(opaque, backdrop);
      expect(result).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    });

    it('半透明图层覆盖在白底下符合加权平均', () => {
      // 50% 黑 (0,0,0, 0.5) 覆盖在 100% 白 (255,255,255, 1) 上 -> 128 灰
      const semiBlack: import('./colorUtils').RGB = {
        r: 0,
        g: 0,
        b: 0,
        a: 0.5,
      };
      const white: import('./colorUtils').RGB = {
        r: 255,
        g: 255,
        b: 255,
        a: 1,
      };
      const result = blendAlpha(semiBlack, white);
      expect(result.r).toBe(128);
      expect(result.g).toBe(128);
      expect(result.b).toBe(128);
      expect(result.a).toBe(1);
    });
  });
});
