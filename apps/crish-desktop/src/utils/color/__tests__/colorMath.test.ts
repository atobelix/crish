import { describe, it, expect } from 'vitest';
import {
  toLinear,
  fromLinear,
  hsvToRgb,
  rgbToHsv,
  hslToRgb,
  rgbToHsl,
  rgbToOklch,
  oklchToRgb,
  parseColor,
  formatColor,
  computeRelativeLuminance,
  compositeOver,
  computeWcagContrast,
  getWcagGrade,
  toHex,
  hexToHsv,
  clamp,
  round,
} from '../colorMath';

describe('colorMath 严谨高精度色彩数学库', () => {
  describe('基础辅助函数', () => {
    it('clamp 正确将数值截断在 [min, max] 范围内', () => {
      expect(clamp(-0.5)).toBe(0);
      expect(clamp(1.5)).toBe(1);
      expect(clamp(0.5)).toBe(0.5);
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(12, 0, 10)).toBe(10);
    });

    it('round 正确按保留位数四舍五入', () => {
      expect(round(3.14159, 2)).toBe(3.14);
      expect(round(3.14159, 4)).toBe(3.1416);
      expect(round(3.5, 0)).toBe(4);
    });
  });

  describe('sRGB <-> Linear 伽马校正（IEC 61966-2-1:1999 标准）', () => {
    it('sRGB <-> Linear 双向伽马变换严格可逆', () => {
      const testValues = [0, 0.001, 0.0031308, 0.04045, 0.1, 0.5, 0.9, 1.0];
      for (const val of testValues) {
        const lin = toLinear(val);
        const rev = fromLinear(lin);
        expect(rev).toBeCloseTo(val, 5);
      }
    });

    it('在断点 0.04045 附近平滑无跳变', () => {
      const lower = toLinear(0.04045);
      const upper = toLinear(0.04046);
      expect(upper).toBeGreaterThan(lower);
      expect(upper - lower).toBeLessThan(0.001);
    });
  });

  describe('HSV <-> RGB 空间变换', () => {
    it('纯红、纯绿、纯蓝、黑白灰互转保真', () => {
      const red = hsvToRgb({ h: 0, s: 1, v: 1, a: 1 });
      expect(red.r).toBeCloseTo(1);
      expect(red.g).toBeCloseTo(0);
      expect(red.b).toBeCloseTo(0);

      const hsvRed = rgbToHsv(red);
      expect(hsvRed.h).toBeCloseTo(0);
      expect(hsvRed.s).toBeCloseTo(1);
      expect(hsvRed.v).toBeCloseTo(1);

      const green = hsvToRgb({ h: 120, s: 1, v: 1, a: 1 });
      expect(green.r).toBeCloseTo(0);
      expect(green.g).toBeCloseTo(1);
      expect(green.b).toBeCloseTo(0);

      const blue = hsvToRgb({ h: 240, s: 1, v: 1, a: 1 });
      expect(blue.r).toBeCloseTo(0);
      expect(blue.g).toBeCloseTo(0);
      expect(blue.b).toBeCloseTo(1);
    });

    it('黑白灰在低彩度时锁定色相（fallbackHue）', () => {
      const gray = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
      const hsv = rgbToHsv(gray, 210);
      expect(hsv.h).toBe(210);
      expect(hsv.s).toBe(0);
      expect(hsv.v).toBeCloseTo(0.5);
    });
  });

  describe('HSL <-> RGB 空间变换', () => {
    it('常见颜色正确互转', () => {
      const cyan = hslToRgb(180, 1, 0.5, 1);
      expect(cyan.r).toBeCloseTo(0);
      expect(cyan.g).toBeCloseTo(1);
      expect(cyan.b).toBeCloseTo(1);

      const hslCyan = rgbToHsl(cyan);
      expect(hslCyan.h).toBeCloseTo(180);
      expect(hslCyan.s).toBeCloseTo(1);
      expect(hslCyan.l).toBeCloseTo(0.5);
    });

    it('低彩度时保留 fallbackHue', () => {
      const white = { r: 1, g: 1, b: 1, a: 1 };
      const hslWhite = rgbToHsl(white, 300);
      expect(hslWhite.h).toBe(300);
      expect(hslWhite.s).toBe(0);
      expect(hslWhite.l).toBe(1);
    });
  });

  describe('RGB <-> OKLCH (LMS 矩阵双向变换)', () => {
    it('标准纯红色在 OKLCH 空间的感知坐标符合理论值', () => {
      const pureRed = { r: 1, g: 0, b: 0, a: 1 };
      const oklch = rgbToOklch(pureRed);
      expect(oklch.l).toBeCloseTo(0.6279, 3);
      expect(oklch.c).toBeCloseTo(0.2576, 3);
      expect(oklch.h).toBeCloseTo(29.23, 1);

      const back = oklchToRgb(oklch.l, oklch.c, oklch.h, oklch.a);
      expect(back.r).toBeCloseTo(1, 4);
      expect(back.g).toBeCloseTo(0, 4);
      expect(back.b).toBeCloseTo(0, 4);
    });

    it('纯白色与纯黑色的明度严格对应 1 与 0', () => {
      const white = rgbToOklch({ r: 1, g: 1, b: 1, a: 1 });
      expect(white.l).toBeCloseTo(1, 4);
      expect(white.c).toBeCloseTo(0, 4);

      const black = rgbToOklch({ r: 0, g: 0, b: 0, a: 1 });
      expect(black.l).toBeCloseTo(0, 4);
      expect(black.c).toBeCloseTo(0, 4);
    });

    it('极低彩度时色相锁定在 fallbackHue', () => {
      const gray = rgbToOklch({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, 150);
      expect(gray.h).toBe(150);
    });
  });

  describe('全语法色彩解析器 parseColor', () => {
    it('解析 3 位、4 位、6 位、8 位 Hex', () => {
      const c3 = parseColor('#F00')!;
      expect(c3).not.toBeNull();
      expect(c3.h).toBeCloseTo(0);
      expect(c3.s).toBeCloseTo(1);
      expect(c3.v).toBeCloseTo(1);
      expect(c3.a).toBe(1);

      const c4 = parseColor('#0f08')!;
      expect(c4).not.toBeNull();
      expect(c4.h).toBeCloseTo(120);
      expect(c4.a).toBeCloseTo(0.533, 2);

      const c6 = parseColor('0000ff')!;
      expect(c6).not.toBeNull();
      expect(c6.h).toBeCloseTo(240);

      const c8 = parseColor('#12345680')!;
      expect(c8).not.toBeNull();
      expect(c8.a).toBeCloseTo(128 / 255, 3);
    });

    it('解析逗号与现代语法 rgb / rgba', () => {
      const rgbModern = parseColor('rgb(255 128 0)')!;
      expect(rgbModern.h).toBeCloseTo(30, 0);

      const rgbaComma = parseColor('rgba(255, 128, 0, 0.5)')!;
      expect(rgbaComma.a).toBe(0.5);

      const rgbSlash = parseColor('rgb(255 128 0 / 80%)')!;
      expect(rgbSlash.a).toBeCloseTo(0.8, 2);
    });

    it('解析 hsl / hsla 语法', () => {
      const hsl1 = parseColor('hsl(120, 100%, 50%)')!;
      expect(hsl1.h).toBe(120);
      expect(hsl1.s).toBeCloseTo(1);
      expect(hsl1.v).toBeCloseTo(1);

      const hsl2 = parseColor('hsla(240deg 100% 50% / 0.75)')!;
      expect(hsl2.h).toBe(240);
      expect(hsl2.a).toBe(0.75);
    });

    it('解析 oklch 语法', () => {
      const oklch = parseColor('oklch(62.8% 0.258 29.2)')!;
      expect(oklch.h).toBeCloseTo(0, 0); // 红色
      expect(oklch.s).toBeGreaterThan(0.9);

      const oklchAlpha = parseColor('oklch(0.628 0.258 29.2 / 50%)')!;
      expect(oklchAlpha.a).toBe(0.5);
    });

    it('非法色彩返回 null', () => {
      expect(parseColor('')).toBeNull();
      expect(parseColor('not-a-color')).toBeNull();
      expect(parseColor('#12345')).toBeNull();
      expect(parseColor('rgb(255 0)')).toBeNull();
    });
  });

  describe('formatColor 格式化与 Hex 输出', () => {
    it('正确格式化为各色彩空间字符串', () => {
      const hsva = { h: 0, s: 1, v: 1, a: 1 };
      expect(toHex(hsva)).toBe('#FF0000');
      expect(formatColor(hsva, 'hex')).toBe('#FF0000');
      expect(formatColor(hsva, 'rgb')).toBe('rgb(255 0 0)');
      expect(formatColor(hsva, 'hsl')).toBe('hsl(0 100% 50%)');
      expect(formatColor(hsva, 'oklch')).toContain('oklch(');

      const semiTransparent = { h: 220, s: 0.8, v: 1, a: 0.5 };
      expect(toHex(semiTransparent).length).toBe(9);
      expect(formatColor(semiTransparent, 'rgb')).toContain('/ 50%');
      expect(formatColor(semiTransparent, 'hsl')).toContain('/ 50%');
    });

    it('hexToHsv 与 toHex 严格闭环', () => {
      const hex = '#2F6BFF';
      const hsva = hexToHsv(hex)!;
      expect(hsva).not.toBeNull();
      expect(toHex(hsva)).toBe(hex);
    });
  });

  describe('WCAG 2.1 相对亮度、透明度物理合成与对比度等级', () => {
    it('纯黑在纯白背景上的对比度为 21:1', () => {
      const black = parseColor('#000000')!;
      const white = { r: 1, g: 1, b: 1, a: 1 };
      const contrast = computeWcagContrast(black, white);
      expect(contrast).toBeCloseTo(21.0, 1);
      expect(getWcagGrade(contrast)).toBe('AAA');
    });

    it('相同颜色对比度为 1:1', () => {
      const black = parseColor('#000000')!;
      const bgBlack = { r: 0, g: 0, b: 0, a: 1 };
      const contrast = computeWcagContrast(black, bgBlack);
      expect(contrast).toBeCloseTo(1.0, 2);
      expect(getWcagGrade(contrast)).toBe('Fails');
    });

    it('半透明颜色经过物理合成后再行判定对比度', () => {
      const semiWhite = { h: 0, s: 0, v: 1, a: 0.5 }; // 50% 白
      const blackBg = { r: 0, g: 0, b: 0, a: 1 };
      // 50% 白在黑背景上混合得到 rgb(0.5, 0.5, 0.5)
      const blended = compositeOver(hsvToRgb(semiWhite), blackBg);
      expect(blended.r).toBeCloseTo(0.5);
      const contrast = computeWcagContrast(semiWhite, blackBg);
      expect(contrast).toBeGreaterThan(1);
      expect(contrast).toBeLessThan(21);
    });

    it('getWcagGrade 四级标准判定', () => {
      expect(getWcagGrade(7.1)).toBe('AAA');
      expect(getWcagGrade(7.0)).toBe('AAA');
      expect(getWcagGrade(4.5)).toBe('AA');
      expect(getWcagGrade(3.0)).toBe('AA large');
      expect(getWcagGrade(2.9)).toBe('Fails');
    });
  });
});
