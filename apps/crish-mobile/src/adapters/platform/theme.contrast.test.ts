// theme 对比度审计测试（R2-05 部分 11，R2UX-06-05 / R2UX §4.2 验收另一半）：
// - WCAG 1.4.3 相对亮度 → 对比度：正文 ≥4.5:1、元信息 ≥3:1（R2-ux-best-practice.md §4.2）；
// - 全 token 对扫描：20 对 × 浅/深/中性灰三套 + 深色 success 3 对 = 63 断言
//   （配对集随 M1 原型对齐修订，逐项理由见 SCAN_PAIRS 上方注释）；
// - 数据源直接读 theme.ts 的 lightTheme / darkTheme / neutralTheme（单一真源，
//   防测试与实现漂移）；
// - 复算口径与 R2-16 走查 §3.3 脚本一致（rgba 合成到白底，半透明元信息按实机观感合成）。
import { darkTheme, lightTheme, neutralTheme } from './theme';

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
// ── M1 原型对齐后的配对修订（2026-11-01，逐项注明，不得无声回退）──
// 1) 气泡反色：用户气泡改墨底白字（原型），文字配对由 textPrimary/bubbleUser
//    改为 bubbleUserText/bubbleUser（原配对在界面中已不存在）。
// 2) warning 图形/文字分工：warning 本体改原型琥珀 #f59e0b（点/徽标/图标图形档），
//    文字配对改扫 warningText（深棕，仍 ≥4.5)；琥珀作正文的固有低对比由图形档承担。
// 3) danger 阈值 4.5→3.0：原型红 #ef4444 作文字的固有对比 ≈3.4–3.8（浅色），
//    系用户原型逐值对齐裁决的已知取舍（WCAG 大字/强调级），收口验收时复核；
//    深色 danger #f87171 实测 ≈6.1–7.0，远超此阈值。
// 4) success / actionPrimaryText 配对移出正文扫描：二者已改为原型品牌绿
//    #10b981 的图形/品牌配对（点、图标、填充、主按钮），固有对比 ≈2.4–2.5，
//    不再按正文文字口径断言；success 配对仅在深色保留（深色实测 ≈5.6–7.4，单列
//    DARK_SCAN_PAIRS)。主按钮白字绿底为原型定版配对，收口验收时一并复核。
// 5) M7 纯净中性灰（推导档）纳入同一扫描集：其文字/结构层与浅色同值，配对
//    自动成立；功能色收敛后的新配对按实测复核——actionPrimaryText/bubbleUser
//    等墨白配对 ≈17.9、info（改 #555555 中性灰）/canvas ≈7.1、danger（降饱和
//    #c62f2f) 作文字 ≈5.2–5.5（反而高于浅色原型的 ≈3.4–3.8)、warningText
//    （#876a1e) ≈4.65–4.90 守住 4.5、danger/dangerSoft ≈4.8。success 在本档
//    已收敛为墨，不再单列绿色配对。
const SCAN_PAIRS = [
  // 正文/元信息文字对（bg 全背景面）
  ['textPrimary', 'canvas', 4.5],
  ['textPrimary', 'fillSubtle', 4.5],
  ['bubbleUserText', 'bubbleUser', 4.5],
  ['textPrimary', 'surface', 4.5],
  ['textPrimary', 'surfaceRaised', 4.5],
  ['textSecondary', 'canvas', 4.5],
  ['textSecondary', 'fillSubtle', 4.5],
  ['textSecondary', 'surface', 4.5],
  ['textTertiary', 'canvas', 3],
  ['textTertiary', 'surface', 3],
  ['textTertiary', 'canvasGrouped', 3],
  ['textTertiary', 'fillSubtle', 3],
  // 语义色作文字对（状态/横幅/角标）
  ['danger', 'canvas', 3],
  ['danger', 'surface', 3],
  ['danger', 'dangerSoft', 3],
  ['dangerForeground', 'danger', 3],
  ['info', 'canvas', 4.5],
  ['info', 'surface', 4.5],
  ['warningText', 'canvas', 4.5],
  ['warningText', 'surface', 4.5],
] as const;

// 深色专属对集：success 在深色底上仍满足正文级对比，继续按 4.5 断言
const DARK_SCAN_PAIRS = [
  ['success', 'canvas', 4.5],
  ['success', 'surface', 4.5],
  ['success', 'successSoft', 4.5],
] as const;

describe('主题 token 对比度审计（R2-05 部分 11 / R2UX-06-05）', () => {
  describe.each([
    ['浅色', lightTheme.colors],
    ['深色', darkTheme.colors],
    ['纯净中性灰（推导）', neutralTheme.colors],
  ] as const)('%s套 token', (_name, tokens) => {
    it.each(SCAN_PAIRS)(
      '%s / %s 对比度 ≥ %s:1',
      (foreground, background, threshold) => {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        expect(ratio).toBeGreaterThanOrEqual(threshold);
      }
    );
  });

  // ── 带文字主按钮配对（用户裁决 2026-11-02，推翻 D3 深绿填充）──
  // 主按钮填充恢复 actionPrimary 亮绿 #10b981（用户原话：之前鲜亮一点的绿色
  // 就挺好的）；白字其上实测 ≈2.54:1，不达 WCAG 正文 4.5 / 大字 3.0——这是
  // 用户知情取舍（原型定版配对亦同此值），本块不再按达标口径断言，而是把
  // 比值钉在 2.54 附近：主绿任何漂移都必须同步改此口径说明，不许无声变更。
  // 中性灰档 actionPrimary 收敛为墨 #171717，白字 ≈17.9:1，仍按 ≥4.5 断言。
  // brandStrong 退回「浅底深绿文字」档：其作文字对浅底的 ≥4.5 性质保留断言
  // （仅浅色/中性灰——深色底上深绿字不在 sanctioned 用法内，且已无消费面）。
  describe('带文字主按钮配对（用户裁决：亮绿填充）', () => {
    it.each([
      ['浅色', lightTheme.colors],
      ['深色', darkTheme.colors],
    ] as const)(
      '%s：actionPrimaryText / actionPrimary ≈ 2.54:1（知情取舍，钉值）',
      (_name, tokens) => {
        expect(
          contrastRatio(tokens.actionPrimaryText, tokens.actionPrimary)
        ).toBeCloseTo(2.54, 1);
      }
    );

    it('纯净中性灰（推导）：actionPrimaryText / actionPrimary ≥ 4.5:1（墨底白字）', () => {
      expect(
        contrastRatio(
          neutralTheme.colors.actionPrimaryText,
          neutralTheme.colors.actionPrimary
        )
      ).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ['浅色', lightTheme.colors],
      ['纯净中性灰（推导）', neutralTheme.colors],
    ] as const)(
      '%s：brandStrong 作文字 / canvas ≥ 4.5:1（深绿文字档保留）',
      (_name, tokens) => {
        expect(
          contrastRatio(tokens.brandStrong, tokens.canvas)
        ).toBeGreaterThanOrEqual(4.5);
      }
    );
  });

  describe('深色套 token（success 对集）', () => {
    it.each(DARK_SCAN_PAIRS)(
      '%s / %s 对比度 ≥ %s:1',
      (foreground, background, threshold) => {
        const ratio = contrastRatio(
          darkTheme.colors[foreground],
          darkTheme.colors[background]
        );
        expect(ratio).toBeGreaterThanOrEqual(threshold);
      }
    );
  });
});
