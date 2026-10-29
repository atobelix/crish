// theme 对比度审计测试（R2-05 部分 11，R2UX-06-05 / R2UX §4.2 验收另一半）：
// - WCAG 1.4.3 相对亮度 → 对比度：正文 ≥4.5:1、元信息 ≥3:1（R2-ux-best-practice.md §4.2）；
// - 全 token 对扫描：23 对 × 浅/深两套 = 46 断言（语义色作文字按正文 4.5:1 逐项断言，M4 §6.5）；
// - 数据源直接读 theme.ts 的 lightTokens / darkTokens（单一真源，防测试与实现漂移）；
// - 复算口径与 R2-16 走查 §3.3 脚本一致（rgba 合成到白底，半透明元信息按实机观感合成）。
import { darkTheme, lightTheme } from './theme';

type Rgb = readonly [number, number, number];

/** HSL → sRGB（0-255 数组；h/s/l 为百分比输入，WCAG 复算口径） */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = h / 360;
  const sat = s / 100;
  const light = l / 100;
  const f = (n: number) => {
    const k = (n + hue * 12) % 12;
    const a = sat * Math.min(light, 1 - light);
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** 解析 token 色值 → sRGB（rgba 按白底合成） */
function parseColor(color: string): Rgb {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const value = parseInt(
      hex.length === 3
        ? hex
            .split('')
            .map((x) => x + x)
            .join('')
        : hex,
      16
    );
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  if (c.startsWith('rgba')) {
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 4) throw new Error(`无法解析 rgba 色值：${color}`);
    const alpha = parseFloat(m[3]!);
    return [
      +m[0]! * alpha + 255 * (1 - alpha),
      +m[1]! * alpha + 255 * (1 - alpha),
      +m[2]! * alpha + 255 * (1 - alpha),
    ];
  }
  if (c.startsWith('hsl')) {
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3) throw new Error(`无法解析 hsl 色值：${color}`);
    return hslToRgb(+m[0]!, +m[1]!, +m[2]!);
  }
  throw new Error(`不支持的色值格式：${color}`);
}

/** sRGB 通道 → 线性化（WCAG 相对亮度前置） */
function linearize(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度 */
function relativeLuminance(rgb: Rgb): number {
  return (
    linearize(rgb[0]) * 0.2126 +
    linearize(rgb[1]) * 0.7152 +
    linearize(rgb[2]) * 0.0722
  );
}

/** WCAG 对比度（相对亮度比，1-21） */
function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(parseColor(foreground));
  const l2 = relativeLuminance(parseColor(background));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// 扫描对集（前景/背景/阈值）：正文 ≥4.5:1、元信息 ≥3:1（R2UX §4.2 / R2-16 走查 §3.3 17 组 + 扩展）
const SCAN_PAIRS = [
  // 正文/元信息文字对（bg 全背景面）
  ['textPrimary', 'canvas', 4.5],
  ['textPrimary', 'fillSubtle', 4.5],
  ['textPrimary', 'bubbleUser', 4.5],
  ['textPrimary', 'surface', 4.5],
  ['textPrimary', 'surfaceRaised', 4.5],
  ['textSecondary', 'canvas', 4.5],
  ['textSecondary', 'fillSubtle', 4.5],
  ['textSecondary', 'surface', 4.5],
  ['textTertiary', 'canvas', 3],
  ['textTertiary', 'surface', 3],
  ['textTertiary', 'canvasGrouped', 3],
  ['textTertiary', 'fillSubtle', 3],
  // 语义色作文字对（状态/横幅/角标，正文档 ≥4.5:1）
  ['success', 'canvas', 4.5],
  ['success', 'surface', 4.5],
  ['success', 'successSoft', 4.5],
  ['actionPrimaryText', 'actionPrimary', 4.5],
  ['danger', 'canvas', 4.5],
  ['danger', 'surface', 4.5],
  ['danger', 'dangerSoft', 4.5],
  ['dangerForeground', 'danger', 4.5],
  ['info', 'canvas', 4.5],
  ['info', 'surface', 4.5],
  ['warning', 'canvas', 4.5],
  ['warning', 'surface', 4.5],
] as const;

describe('主题 token 对比度审计（R2-05 部分 11 / R2UX-06-05）', () => {
  describe.each([
    ['浅色', lightTheme.colors],
    ['深色', darkTheme.colors],
  ] as const)('%s套 token（23 对）', (_name, tokens) => {
    it.each(SCAN_PAIRS)(
      '%s / %s 对比度 ≥ %s:1',
      (foreground, background, threshold) => {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        expect(ratio).toBeGreaterThanOrEqual(threshold);
      }
    );
  });
});
