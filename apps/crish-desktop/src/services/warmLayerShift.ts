/**
 * warmLayerShift — 基底表面色亮度微调（P1 U1.4 收口）
 *
 * 核心原则：
 * 1. P1 六级表面阶梯（e0~e5）由 CSS `color-mix(in oklab, ...)` 依据固定步长常量构造保证严格单调；
 * 2. 运行时 JS 仅对单一画布基色 `surfaceBase` 平移 CMYK 的 K（保持色相 C/M/Y 不变），
 *    并在极端档位做防饱和截断保护，确保 e0 下潜与 e5 浮起始终留有物理余量；
 * 3. [WAVE2-DEPRECATED] 保留三层对象重载签名供尚未清理的旧测试过渡兼容。
 */

/**
 * @deprecated [WAVE2-DEPRECATED] 过渡兼容接口，新代码请直接传入单一 surfaceBase 字符串
 * @removeWhen Wave 3 P9 旧三层表面别名全面清零后移除
 */
export interface WarmLayers {
  outer: string;
  main: string;
  input: string;
}

/** 每档亮度微调平移的 K 点数（与原主层斜率 0.6 L/档同量级） */
export const STEP_K = 0.6;
/**
 * @deprecated [WAVE2-DEPRECATED] 旧三层最小 K 差
 * @removeWhen Wave 3 P9 旧三层表面别名全面清零后移除
 */
export const MIN_GAP_K = 1.2;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
}

function rgbToHex([r, g, b]: Rgb): string {
  return (
    '#' +
    [r, g, b]
      .map((c) =>
        Math.max(0, Math.min(255, Math.round(c)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

/** CMYK 的 K（0–100） */
export function kOf(hex: string): number {
  return (1 - Math.max(...hexToRgb(hex)) / 255) * 100;
}

/** 把颜色平移到指定 K（保持 C/M/Y） */
export function withK(hex: string, k: number): string {
  const rgb = hexToRgb(hex);
  const from = 1 - kOf(hex) / 100;
  const to = 1 - k / 100;
  if (from <= 0) return rgbToHex([255 * to, 255 * to, 255 * to]);
  return rgbToHex(rgb.map((c) => (c * to) / from) as Rgb);
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * P1 单一画布基底色亮度微调纯函数：仅对 `surfaceBase` 单值平移 K。
 * 夹紧区间保证在 adjust ∈ [-5, +5] 下：
 * - 暗色不会过黑吞没 e0 Sunken（ΔL* ≥ 2.0），也不会过亮压缩 e4 Raised（ΔL* ≥ 8.0）；
 * - 浅色不会过白导致 e3~e5 坍塌为同值 #ffffff。
 */
export function shiftSurfaceBase(
  surfaceBase: string,
  adjust: number,
  isDark = false
): string {
  if (!adjust) return surfaceBase;
  const trimmed = surfaceBase.trim();
  if (!trimmed.startsWith('#')) {
    const pct = Math.min(25, Math.abs(adjust) * 3.5);
    const target = adjust > 0 ? 'hsl(0 0% 100%)' : 'hsl(0 0% 0%)';
    return `color-mix(in srgb, ${trimmed} ${100 - pct}%, ${target})`;
  }

  const k0 = kOf(trimmed);
  if (isDark) {
    const d = -adjust * STEP_K;
    const maxK = Math.max(k0, 94.5);
    const k = clamp(k0 + d, 70, maxK);
    return withK(trimmed, k);
  }

  const d = -adjust * 0.4;
  const minK = Math.min(k0, 3.1);
  const k = clamp(k0 + d, minK, 25);
  return withK(trimmed, k);
}

/**
 * 亮度微调平移 K：
 * - P1 标准签名：传入单一 `surfaceBase: string`，返回平移后的 hex 字符串；
 * - [WAVE2-DEPRECATED] 兼容签名：传入 `WarmLayers` 三层对象，返回平移后的三层对象。
 */
export function shiftWarmLayers(
  surfaceBase: string,
  adjust: number,
  isDark?: boolean
): string;
export function shiftWarmLayers(
  base: WarmLayers,
  adjust: number,
  isDark: boolean
): WarmLayers;
export function shiftWarmLayers(
  baseOrSurface: string | WarmLayers,
  adjust: number,
  isDark = false
): string | WarmLayers {
  if (typeof baseOrSurface === 'string') {
    return shiftSurfaceBase(baseOrSurface, adjust, isDark);
  }

  // [WAVE2-DEPRECATED] 旧三档底色兼容分支
  const base = baseOrSurface;
  if (!adjust) return { ...base };
  const d = -adjust * STEP_K;
  if (isDark) {
    const kIn0 = kOf(base.input);
    const kInput = clamp(kIn0 + d, 0, 100 - 3 * MIN_GAP_K);
    const kOuter = clamp(
      kOf(base.outer) + d,
      kInput + MIN_GAP_K,
      100 - 2 * MIN_GAP_K
    );
    const kMain = clamp(
      kOf(base.main) + d,
      kOuter + MIN_GAP_K,
      100 - MIN_GAP_K
    );
    return {
      outer: withK(base.outer, kOuter),
      main: withK(base.main, kMain),
      input: withK(base.input, kInput),
    };
  }

  const kIn0 = kOf(base.input);
  const kInput = kIn0;
  const minMainK = base.main === base.input ? kInput : kInput + MIN_GAP_K;
  const kMain = clamp(kOf(base.main) + d, minMainK, 100 - 2 * MIN_GAP_K);
  const kOuter = clamp(kOf(base.outer) + d, kMain + MIN_GAP_K, 100 - MIN_GAP_K);
  return {
    outer: withK(base.outer, kOuter),
    main: withK(base.main, kMain),
    input: base.input,
  };
}
