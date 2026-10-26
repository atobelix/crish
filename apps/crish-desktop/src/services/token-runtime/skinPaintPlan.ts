/**
 * apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts
 *
 * 皮肤表面基准参数（surfaceBase / surfaceTint / surfaceDeep / elevDirection）
 * 与单一文字基准参数（textBase）及 P2 四级对比度保底（contrastGuard）纯派生计划。
 */

import type { SkinPreset } from '../../api/themePresets';
import { shiftSurfaceBase, shiftWarmLayers } from '../warmLayerShift';
import { parseColorToOklch } from '../../api/oklchColorGuard';

/** P2 四级文字阶梯 WCAG 对比度硬下限常量（SSOT） */
export const CONTRAST_THRESHOLD_PRIMARY = 12.0;
export const CONTRAST_THRESHOLD_SECONDARY = 7.0;
export const CONTRAST_THRESHOLD_TERTIARY = 4.5;
export const CONTRAST_THRESHOLD_DECOR = 3.0;

export const CONTRAST_GUARD_THRESHOLDS = {
  primary: CONTRAST_THRESHOLD_PRIMARY,
  secondary: CONTRAST_THRESHOLD_SECONDARY,
  tertiary: CONTRAST_THRESHOLD_TERTIARY,
  decor: CONTRAST_THRESHOLD_DECOR,
} as const;

/** P2 文字阶梯与 surfaceBase 的混合步长常量（与 tokens-text.css 严格同源） */
export const TEXT_STEP_SECONDARY_DARK = 0.75;
export const TEXT_STEP_TERTIARY_DARK = 0.58;
export const TEXT_STEP_DECOR_DARK = 0.4;
export const TEXT_STEP_SECONDARY_LIGHT = 0.75;
export const TEXT_STEP_TERTIARY_LIGHT = 0.62;
export const TEXT_STEP_DECOR_LIGHT = 0.45;

export interface SkinPaintInput {
  skinConfig: SkinPreset;
  skinKey: string;
  isDark: boolean;
  adjust: number;
  solarWarmthMix: number;
  vibrant: boolean;
}

export interface SkinPaintPlan {
  surfaceBase: string;
  surfaceTint: string;
  surfaceDeep: string;
  elevDirection: 1 | -1;
  textBase: string;
  mixColor: string;
  borderColor: string;
  borderSubtle: string;
  // [WAVE2-DEPRECATED] 过渡只读属性
  readonly bgPrimary: string;
  readonly bgSecondary: string;
  readonly composerBg: string;
  readonly finalFg: string;
  readonly finalSec: string;
  readonly finalTert: string;
  readonly finalFaint: string;
  readonly textDecor: string;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function sRgbChannelToLinear(channel: number): number {
  const c = Math.max(0, Math.min(255, channel)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: RgbColor): number {
  return (
    0.2126 * sRgbChannelToLinear(rgb.r) +
    0.7152 * sRgbChannelToLinear(rgb.g) +
    0.0722 * sRgbChannelToLinear(rgb.b)
  );
}

/** 计算两个 RGB 颜色的 WCAG 2.1 对比度比值（1.0 ~ 21.0） */
export function computeWcagContrastRgb(fg: RgbColor, bg: RgbColor): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hslToRgb(h: number, s: number, l: number): RgbColor {
  const normH = ((h % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(100, s)) / 100;
  const normL = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL - c / 2;
  const sectors: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r1, g1, b1] = sectors[Math.min(5, Math.floor(normH / 60))]!;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function parseColorToRgb(colorStr: string, isDarkFallback: boolean): RgbColor {
  const fallback: RgbColor = isDarkFallback
    ? { r: 20, g: 20, b: 20 }
    : { r: 247, g: 246, b: 244 };
  if (!colorStr || typeof colorStr !== 'string') return fallback;
  const s = colorStr.trim().toLowerCase();

  if (s.startsWith('#')) {
    const raw = s.slice(1);
    if (raw.length === 3 || raw.length === 4) {
      const [r, g, b] = [0, 1, 2].map((i) => parseInt(raw[i]! + raw[i]!, 16));
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b))
        return { r: r!, g: g!, b: b! };
    } else if (raw.length === 6 || raw.length === 8) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b))
        return { r: r!, g: g!, b: b! };
    }
    return fallback;
  }

  const hslMatch = s.match(
    /hsla?\(\s*([\d.]+)(?:deg)?(?:\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%/
  );
  if (hslMatch) {
    return hslToRgb(
      parseFloat(hslMatch[1]!),
      parseFloat(hslMatch[2]!),
      parseFloat(hslMatch[3]!)
    );
  }

  const rgbMatch = s.match(
    /rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)/
  );
  if (rgbMatch) {
    const clamp = (v: string) =>
      Math.max(0, Math.min(255, Math.round(parseFloat(v))));
    return {
      r: clamp(rgbMatch[1]!),
      g: clamp(rgbMatch[2]!),
      b: clamp(rgbMatch[3]!),
    };
  }
  return fallback;
}

function rgbToHex(rgb: RgbColor): string {
  const hex = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

function mixRgb(
  base: RgbColor,
  target: RgbColor,
  weightTarget: number
): RgbColor {
  const w = Math.max(0, Math.min(1, weightTarget));
  return {
    r: Math.round(base.r * (1 - w) + target.r * w),
    g: Math.round(base.g * (1 - w) + target.g * w),
    b: Math.round(base.b * (1 - w) + target.b * w),
  };
}

/** 将候选前景色向极端高对比方向做最小幅度推升，确保相对背景色的对比度达到 minRatio */
function ensureContrastFloor(
  candidateRgb: RgbColor,
  bgRgb: RgbColor,
  minRatio: number,
  isDarkBg: boolean,
  preserveString?: string
): string {
  if (computeWcagContrastRgb(candidateRgb, bgRgb) >= minRatio) {
    return preserveString ?? rgbToHex(candidateRgb);
  }
  const extreme: RgbColor = isDarkBg
    ? { r: 255, g: 255, b: 255 }
    : { r: 0, g: 0, b: 0 };
  if (computeWcagContrastRgb(extreme, bgRgb) <= minRatio)
    return rgbToHex(extreme);

  let lo = 0;
  let hi = 1;
  let best = extreme;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const mixed = mixRgb(candidateRgb, extreme, mid);
    if (computeWcagContrastRgb(mixed, bgRgb) >= minRatio) {
      best = mixed;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return rgbToHex(best);
}

export interface ContrastGuardedTextResult {
  isDarkBg: boolean;
  textBase: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDecor: string;
}

/**
 * P2 对比度保底纯函数（contrastGuard 上提）：
 * 对齐 P2 四级文字下限（Primary ≥ 12, Secondary ≥ 7, Tertiary ≥ 4.5, Decor ≥ 3.0），
 * 消除历史低对比度魔术百分比。
 */
export function resolveContrastGuardedText(args: {
  surfaceBase: string;
  candidateTextBase: string;
  isDark: boolean;
  isCustomSkin?: boolean;
}): ContrastGuardedTextResult {
  const { surfaceBase, candidateTextBase, isDark } = args;
  const bgRgb = parseColorToRgb(surfaceBase, isDark);

  let isDarkBg = isDark;
  try {
    const oklch = parseColorToOklch(surfaceBase, isDark);
    if (!Number.isNaN(oklch.l)) isDarkBg = oklch.l <= 0.52;
  } catch {
    isDarkBg = isDark;
  }

  const rawTextRgb = parseColorToRgb(candidateTextBase, !isDarkBg);
  const defaultBaseHex = isDarkBg ? '#f5f5f5' : '#121212';
  const lowInitial =
    computeWcagContrastRgb(rawTextRgb, bgRgb) < CONTRAST_THRESHOLD_PRIMARY;
  const seedRgb = lowInitial
    ? parseColorToRgb(defaultBaseHex, !isDarkBg)
    : rawTextRgb;
  const seedStr = lowInitial ? defaultBaseHex : candidateTextBase;

  const textBase = ensureContrastFloor(
    seedRgb,
    bgRgb,
    CONTRAST_THRESHOLD_PRIMARY,
    isDarkBg,
    seedStr
  );
  const baseRgb = parseColorToRgb(textBase, !isDarkBg);
  const stepSec = isDarkBg
    ? TEXT_STEP_SECONDARY_DARK
    : TEXT_STEP_SECONDARY_LIGHT;
  const stepTert = isDarkBg
    ? TEXT_STEP_TERTIARY_DARK
    : TEXT_STEP_TERTIARY_LIGHT;
  const stepDecor = isDarkBg ? TEXT_STEP_DECOR_DARK : TEXT_STEP_DECOR_LIGHT;
  const guardTier = (step: number, minRatio: number) =>
    ensureContrastFloor(
      mixRgb(bgRgb, baseRgb, step),
      bgRgb,
      minRatio,
      isDarkBg
    );

  return {
    isDarkBg,
    textBase,
    textPrimary: textBase,
    textSecondary: guardTier(stepSec, CONTRAST_THRESHOLD_SECONDARY),
    textTertiary: guardTier(stepTert, CONTRAST_THRESHOLD_TERTIARY),
    textDecor: guardTier(stepDecor, CONTRAST_THRESHOLD_DECOR),
  };
}

/** 由皮肤配置派生一整套表面/文字注入计划（纯函数） */
export function deriveSkinPaintPlan(input: SkinPaintInput): SkinPaintPlan {
  const { skinConfig, skinKey, isDark, adjust, solarWarmthMix, vibrant } =
    input;
  const elevDirection: 1 | -1 = skinConfig.elevDirection ?? (isDark ? 1 : -1);

  let surfaceBase =
    skinConfig.surfaceBase ||
    skinConfig.bgPrimary ||
    (isDark ? '#141414' : '#f7f6f4');
  let surfaceTint = skinConfig.surfaceTint || '#ffffff';
  const surfaceDeep = skinConfig.surfaceDeep || '#000000';
  const candidateTextBase =
    skinConfig.textBase ||
    skinConfig.textPrimary ||
    (isDark ? '#f5f5f5' : '#121212');
  let borderColor = skinConfig.borderColor;
  let borderSubtle = skinConfig.borderSubtle;

  // [WAVE2-DEPRECATED] 过渡只读属性初始值
  let bgPrimary = skinConfig.bgPrimary || surfaceBase;
  let bgSecondary = skinConfig.bgSecondary || surfaceBase;
  let bgCard = skinConfig.bgCard || surfaceBase;

  const mixColor =
    skinConfig.mixColor ||
    (isDark ? 'var(--text-primary)' : 'hsl(35, 50%, 20%)');

  let vibrantTint = mixColor;
  if (!isDark) {
    const hslMatch = mixColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (hslMatch) {
      const h = parseInt(hslMatch[1]!, 10);
      const originalSat = parseInt(hslMatch[2]!, 10);
      const [sat, light] =
        originalSat <= 10
          ? [0, 92]
          : h >= 100 && h <= 150
            ? [40, 91]
            : h >= 160 && h <= 210
              ? [45, 92]
              : h >= 270 && h <= 320
                ? [55, 92]
                : [45, 90];
      vibrantTint = `hsl(${h}, ${sat}%, ${light}%)`;
    }
  }

  let mixTarget = adjust > 0 ? 'hsl(0 0% 100%)' : 'hsl(0 0% 0%)';
  if (vibrant) {
    const tintTarget = `color-mix(in srgb, ${mixColor} 8%, hsl(0 0% 100%))`;
    const shadeTarget = `color-mix(in srgb, ${mixColor} 14%, hsl(0 0% 0%))`;
    mixTarget = adjust > 0 ? tintTarget : shadeTarget;
    surfaceTint = isDark ? tintTarget : vibrantTint;
  }

  const twilightTarget = `color-mix(in srgb, ${mixColor} 15%, hsl(34, 30%, 45%))`;
  const mixSrgb = (c: string, p: number, t: string) =>
    `color-mix(in srgb, ${c} ${100 - p}%, ${t})`;
  const isNeutralLight =
    skinKey === 'warm-gray' ||
    skinKey === 'paper' ||
    skinKey === 'classic-gray' ||
    skinKey === 'custom';

  if (solarWarmthMix > 0 && !isDark && !isNeutralLight) {
    const sunsetTone = 'hsl(30, 40%, 90%)';
    const pct = solarWarmthMix * 100;
    surfaceBase = `color-mix(in srgb, ${sunsetTone} ${pct}%, ${surfaceBase})`;
    bgPrimary = `color-mix(in srgb, ${sunsetTone} ${pct}%, ${bgPrimary})`;
    bgSecondary = `color-mix(in srgb, ${sunsetTone} ${pct}%, ${bgSecondary})`;
    bgCard = `color-mix(in srgb, ${sunsetTone} ${pct}%, ${bgCard})`;
    vibrantTint = `color-mix(in srgb, hsl(30, 50%, 65%) ${pct}%, ${vibrantTint})`;
  }

  if (adjust !== 0) {
    surfaceBase = shiftSurfaceBase(surfaceBase, adjust, isDark);
  }

  // [WAVE2-DEPRECATED] 过渡期兼容层计算
  let darkLayersShifted = false;
  if (!isDark && skinKey === 'warm-gray') {
    const layers = shiftWarmLayers(
      { outer: '#f7f6f5', main: '#ffffff', input: '#ffffff' },
      adjust,
      false
    );
    bgPrimary = layers.main;
    bgSecondary = layers.outer;
    bgCard = '#ffffff';
    borderColor = '#e2e1e0';
    borderSubtle = '#f0efee';
  } else if (isDark && skinKey === 'dark-cozy') {
    const layers = shiftWarmLayers(
      {
        outer: skinConfig.bgSecondary || '#1e1e1e',
        main: skinConfig.bgPrimary || '#141414',
        input: skinConfig.bgCard || '#232323',
      },
      adjust,
      true
    );
    bgPrimary = layers.main;
    bgSecondary = layers.outer;
    bgCard = layers.input;
    darkLayersShifted = true;
  } else if (adjust !== 0) {
    const absA = Math.abs(adjust);
    const [pBase, pSec, pElev, target] = isDark
      ? [
          absA * 3.5,
          absA * (adjust > 0 ? 2.8 : 2.3),
          absA * (adjust > 0 ? 2.0 : 1.5),
          mixTarget,
        ]
      : adjust > 0
        ? [adjust * 4.5, adjust * 2.5, adjust * 4.5, 'hsl(0 0% 100%)']
        : [absA * 3.0, absA * 4.8, absA * 1.2, twilightTarget];
    bgPrimary = mixSrgb(bgPrimary, pBase, target);
    bgSecondary = mixSrgb(bgSecondary, pSec, target);
    bgCard = mixSrgb(bgCard, pElev, target);
    borderColor = mixSrgb(borderColor, pSec, target);
    borderSubtle = mixSrgb(borderSubtle, pSec, target);
  }

  if (!isDark && skinKey === 'cream') {
    bgCard = `color-mix(in srgb, ${vibrantTint} 6.0%, ${bgCard})`;
  }
  if (!isDark && isNeutralLight) {
    bgCard = 'hsl(0 0% 100%)';
  } else if (isDark && !darkLayersShifted && skinConfig.bgCard) {
    bgCard = skinConfig.bgCard;
  }

  const composerBg =
    !isDark && skinKey === 'warm-gray'
      ? '#ffffff'
      : skinConfig.composerBg || bgCard;
  const guarded = resolveContrastGuardedText({
    surfaceBase,
    candidateTextBase,
    isDark,
    isCustomSkin: skinKey === 'custom',
  });

  return {
    surfaceBase,
    surfaceTint,
    surfaceDeep,
    elevDirection,
    textBase: guarded.textBase,
    mixColor,
    borderColor,
    borderSubtle,
    bgPrimary,
    bgSecondary,
    composerBg,
    finalFg: guarded.textPrimary,
    finalSec: guarded.textSecondary,
    finalTert: guarded.textTertiary,
    finalFaint: guarded.textDecor,
    textDecor: guarded.textDecor,
  };
}
