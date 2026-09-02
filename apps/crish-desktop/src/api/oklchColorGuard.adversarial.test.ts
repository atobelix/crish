/**
 * oklchColorGuard 对抗性测试套件
 *
 * 目标：暴露颜色解析的数学错误、格式覆盖不全、对比度阈值不合理等 bug。
 *
 * 期望暴露的 bug：
 *  - 8 位 hex (#RRGGBBAA) 静默丢弃 alpha
 *  - 非法 hex 长度产生 NaN，不报错
 *  - HSL 正则不接受小数、deg 单位、现代 slash alpha 语法
 *  - color-mix 检测过宽（substring 匹配）
 *  - "OKLCH" L 实际是相对亮度（Y），不是真正 OKLCH L
 *  - 色度计算忽略蓝色通道
 *  - 灰色色调不稳定
 *  - 对比度阈值 0.52 与 WCAG 0.179 不一致
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseColorToOklch, getContrastGuardedText } from './oklchColorGuard';

describe('parseColorToOklch — hex 解析', () => {
  it('6 位 hex 正确解析', () => {
    const r = parseColorToOklch('#ff0000');
    // 纯红
    expect(r.l).toBeGreaterThan(0.2);
    expect(r.l).toBeLessThan(0.5);
  });

  it('3 位 hex 正确展开', () => {
    const r3 = parseColorToOklch('#f00');
    const r6 = parseColorToOklch('#ff0000');
    expect(r3).toEqual(r6);
  });

  it('暴露 bug: 8 位 hex (#RRGGBBAA) 静默丢弃 alpha', () => {
    const r = parseColorToOklch('#ff0000ff');
    // 解析时只取前 6 位，alpha 被忽略
    // 但结果与 #ff0000 相同
    const r6 = parseColorToOklch('#ff0000');
    expect(r).toEqual(r6);
  });

  it('暴露 bug: 1 位 hex 不报错，产生 NaN', () => {
    const r = parseColorToOklch('#f');
    // parseInt('', 16) = NaN
    expect(Number.isNaN(r.l)).toBe(true);
  });

  it('暴露 bug: 2 位 hex 不报错，产生部分 NaN', () => {
    const r = parseColorToOklch('#ff');
    // parsedHex = 'ff'
    // r = parseInt('ff', 16)/255 = 1
    // g = parseInt('', 16)/255 = NaN
    // b = parseInt('', 16)/255 = NaN
    expect(Number.isNaN(r.l)).toBe(true);
  });

  it('暴露 bug: 5 位 hex 不报错，产生 NaN', () => {
    const r = parseColorToOklch('#12345');
    expect(Number.isNaN(r.l)).toBe(true);
  });

  it('暴露 bug: 非 hex 字符静默解析为 NaN', () => {
    const r = parseColorToOklch('#zzzzzz');
    // parseInt('zz', 16) = NaN
    expect(Number.isNaN(r.l)).toBe(true);
  });

  it('hex 大小写不敏感', () => {
    const upper = parseColorToOklch('#FF0000');
    const lower = parseColorToOklch('#ff0000');
    expect(upper).toEqual(lower);
  });

  it('属性测试: 6 位 hex 解析结果应在合理范围', () => {
    fc.assert(
      fc.property(fc.hexaString({ minLength: 6, maxLength: 6 }), (hex) => {
        const r = parseColorToOklch(`#${hex}`);
        // L 应在 [0, 1] 范围内（线性 sRGB 加权）
        if (!Number.isNaN(r.l)) {
          expect(r.l).toBeGreaterThanOrEqual(0);
          expect(r.l).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('parseColorToOklch — HSL 解析', () => {
  it('标准 HSL 正确解析', () => {
    const r = parseColorToOklch('hsl(0, 100%, 50%)');
    // 纯红
    expect(r.l).toBeGreaterThan(0.2);
  });

  it('HSL 含小数值正确解析', () => {
    const r = parseColorToOklch('hsl(35.5, 10%, 50%)');
    expect(r.l).toBeGreaterThan(0.2);
    expect(r.l).toBeLessThan(0.3);
  });

  it('HSL 含 deg 单位正确解析', () => {
    const r = parseColorToOklch('hsl(35deg, 10%, 50%)');
    expect(r.l).toBeGreaterThan(0.2);
    expect(r.l).toBeLessThan(0.3);
  });

  it('HSL 现代 slash alpha 语法正确解析', () => {
    const r = parseColorToOklch('hsl(35, 10%, 50% / 50%)');
    expect(r.l).toBeGreaterThan(0.2);
    expect(r.l).toBeLessThan(0.3);
  });

  it('HSL 空格分隔语法正确解析', () => {
    const r = parseColorToOklch('hsl(35 10% 50%)');
    expect(r.l).toBeGreaterThan(0.2);
    expect(r.l).toBeLessThan(0.3);
  });

  it('暴露 bug: HSL 百分号缺失不匹配', () => {
    const r = parseColorToOklch('hsl(35, 100, 50)');
    const defaultR = parseColorToOklch('nonexistent');
    expect(r).toEqual(defaultR);
  });

  it('hsla 与 hsl 行为一致', () => {
    const r1 = parseColorToOklch('hsl(120, 50%, 50%)');
    const r2 = parseColorToOklch('hsla(120, 50%, 50%)');
    expect(r1).toEqual(r2);
  });
});

describe('parseColorToOklch — color-mix 检测', () => {
  it('暴露 bug: color-mix 检测使用 substring 匹配，过宽', () => {
    // 任何包含 "color-mix" 子串的字符串都会触发
    const r = parseColorToOklch('some-color-mix-thing');
    // 进入 color-mix 分支，返回固定值
    expect(r.l).toBe(0.1); // 默认深色
  });

  it('暴露 bug: color-mix 在 isDark=true 时返回固定值，忽略实际颜色', () => {
    const r1 = parseColorToOklch('color-mix(in srgb, red 50%, blue 50%)', true);
    const r2 = parseColorToOklch('color-mix(in srgb, white 50%, black 50%)', true);
    expect(r1).toEqual(r2); // 完全相同
    expect(r1.l).toBe(0.1);
  });

  it('暴露 bug: color-mix 在 isDark=false 时返回固定值', () => {
    const r1 = parseColorToOklch('color-mix(in srgb, red 50%, blue 50%)', false);
    const r2 = parseColorToOklch('color-mix(in srgb, white 50%, black 50%)', false);
    expect(r1).toEqual(r2);
    expect(r1.l).toBe(0.9);
  });

  it('color-mix 含 #ffffff 关键字时返回浅色', () => {
    const r = parseColorToOklch('color-mix(in srgb, #ffffff 50%, black 50%)');
    expect(r.l).toBe(0.9);
  });

  it('color-mix 含 transparent 时返回浅色', () => {
    const r = parseColorToOklch('color-mix(in srgb, transparent, red)');
    expect(r.l).toBe(0.9);
  });
});

describe('parseColorToOklch — 数学正确性', () => {
  it('暴露 bug: 返回的 L 实际是相对亮度（Y），不是 OKLCH L', () => {
    // 纯白 #ffffff 的相对亮度 Y = 1
    // 但真正 OKLCH L 也是 1，所以白色无法区分
    // 用纯红 #ff0000 测试：
    //   sRGB (1, 0, 0) → linear sRGB (1, 0, 0)
    //   相对亮度 Y = 0.2126*1 + 0.7152*0 + 0.0722*0 = 0.2126
    //   OKLCH L ≈ 0.628
    const r = parseColorToOklch('#ff0000');
    expect(r.l).toBeCloseTo(0.2126, 3); // 实际是相对亮度
    // 真正 OKLCH L 应该是 ~0.628
  });

  it('纯黑 L=0', () => {
    const r = parseColorToOklch('#000000');
    expect(r.l).toBe(0);
  });

  it('纯白 L=1', () => {
    const r = parseColorToOklch('#ffffff');
    expect(r.l).toBe(1);
  });

  it('暴露 bug: 色度 c 计算忽略蓝色通道', () => {
    // 蓝色 #0000ff 的色度应非零，但公式只用了 r 和 g
    // c = sqrt((r-l)^2 + (g-l)^2) * 0.35
    // 蓝色：r=0, g=0, l = 0.0722
    // c = sqrt((0-0.0722)^2 + (0-0.0722)^2) * 0.35 = sqrt(2*0.0052) * 0.35 ≈ 0.0357
    // 真正 OKLCH C ≈ 0.323
    const r = parseColorToOklch('#0000ff');
    expect(r.c).toBeLessThan(0.1); // 远小于真正 OKLCH C
  });

  it('暴露 bug: 灰色色调不稳定（atan2(0, 0) = 0）', () => {
    // 中灰 #808080: r=g=b≈0.215
    // h = atan2(g-r, r-b) = atan2(0, 0) = 0
    // 但 0 度是红色，灰色不应有明确色调
    const r = parseColorToOklch('#808080');
    expect(r.h).toBe(0); // 不稳定的 0
  });

  it('属性测试: L 应在 [0, 1] 范围内（对合法 hex）', () => {
    fc.assert(
      fc.property(fc.hexaString({ minLength: 6, maxLength: 6 }), (hex) => {
        const r = parseColorToOklch(`#${hex}`);
        if (!Number.isNaN(r.l)) {
          expect(r.l).toBeGreaterThanOrEqual(0);
          expect(r.l).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('getContrastGuardedText — 对比度阈值', () => {
  it('深色背景返回浅色文字', () => {
    const text = getContrastGuardedText('#000000');
    expect(text).toBe('hsl(0, 0%, 94%)');
  });

  it('浅色背景返回深色文字', () => {
    const text = getContrastGuardedText('#ffffff');
    expect(text).toBe('hsl(35, 12%, 11%)');
  });

  it('暴露 bug: 阈值 0.52 与 WCAG 推荐 0.179 不一致', () => {
    // WCAG 用相对亮度，阈值约 0.179（对应 sRGB ~46% 灰）
    // 当前实现用 0.52，对应更亮的灰
    // 中灰 #808080: 相对亮度 ≈ 0.215
    // 0.215 > 0.179 → WCAG 认为是浅色背景，应用深色文字
    // 0.215 < 0.52 → 当前实现认为是深色背景，应用浅色文字
    const text = getContrastGuardedText('#808080');
    expect(text).toBe('hsl(0, 0%, 94%)'); // 浅色文字（当前实现）
    // WCAG 会推荐深色文字
  });

  it('阈值附近的颜色对比度选择敏感', () => {
    // 找到阈值附近的颜色
    // L = 0.2126*R + 0.7152*G + 0.0722*B (linear)
    // #bdbdbd: sRGB ≈ 0.741, linear ≈ 0.509, L ≈ 0.509 < 0.52 → 浅色文字
    // #bfbfbf: sRGB ≈ 0.749, linear ≈ 0.521, L ≈ 0.521 > 0.52 → 深色文字
    // 原 fixture #bebebe 线性化后 L ≈ 0.515 位于阈值之下（fixture 计算误差，已修正）
    const below = getContrastGuardedText('#bdbdbd'); // L < 0.52
    const above = getContrastGuardedText('#bfbfbf'); // L > 0.52
    expect(below).toBe('hsl(0, 0%, 94%)'); // 浅色文字
    expect(above).toBe('hsl(35, 12%, 11%)'); // 深色文字
  });

  it('无效颜色字符串回退到默认', () => {
    const text = getContrastGuardedText('not-a-color');
    // 解析失败，r/g/b 保持默认 0.9 → L 较高 → 深色文字
    expect(text).toBe('hsl(35, 12%, 11%)');
  });

  it('带 isDark 参数时影响 color-mix 路径', () => {
    const textDark = getContrastGuardedText('color-mix(in srgb, red, blue)', true);
    const textLight = getContrastGuardedText('color-mix(in srgb, red, blue)', false);
    // isDark=true → L=0.1 → 浅色文字
    // isDark=false → L=0.9 → 深色文字
    expect(textDark).toBe('hsl(0, 0%, 94%)');
    expect(textLight).toBe('hsl(35, 12%, 11%)');
  });
});
