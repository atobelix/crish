/**
 * 高精度色彩数学库体系（SSOT: colorMath.ts）
 *
 * 提供标准的 Linear / LMS / OKLCH / Oklab 矩阵变换与 WCAG 2.1 相对亮度计算；
 * 内置黑白灰低彩度色相锁定与全语法色彩解析器。
 */

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch';

export interface Hsva {
  h: number; // 0 ~ 360
  s: number; // 0 ~ 1
  v: number; // 0 ~ 1
  a: number; // 0 ~ 1
}

export interface Rgba {
  r: number; // 0 ~ 1
  g: number; // 0 ~ 1
  b: number; // 0 ~ 1
  a: number; // 0 ~ 1
}

export interface Oklch {
  l: number; // 0 ~ 1
  c: number; // 0 ~ 0.4+
  h: number; // 0 ~ 360
  a: number; // 0 ~ 1
}

export const clamp = (val: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, val));

export const round = (val: number, digits = 0): number => {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
};

// 严谨伽马双向转换（IEC 61966-2-1:1999 标准）
export const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

export const fromLinear = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

// HSV <-> RGB
export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: clamp(f(5)), g: clamp(f(3)), b: clamp(f(1)), a: clamp(a) };
}

export function rgbToHsv({ r, g, b, a = 1 }: Rgba, fallbackHue = 0): Hsva {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = fallbackHue;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a: clamp(a) };
}

// HSL <-> RGB
export function hslToRgb(h: number, s: number, l: number, a = 1): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const c = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - c * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: clamp(f(0)), g: clamp(f(8)), b: clamp(f(4)), a: clamp(a) };
}

export function rgbToHsl(
  { r, g, b, a = 1 }: Rgba,
  fallbackHue = 0
): { h: number; s: number; l: number; a: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = fallbackHue;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s, l, a: clamp(a) };
}

// RGB <-> OKLCH (双向 LMS 矩阵变换)
export function rgbToOklch({ r, g, b, a = 1 }: Rgba, fallbackHue = 0): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;

  return { l: L, c: C, h: C < 0.0005 ? fallbackHue : H, a: clamp(a) };
}

export function oklchToRgb(L: number, C: number, H: number, a = 1): Rgba {
  const rad = (H * Math.PI) / 180;
  const A = C * Math.cos(rad);
  const B = C * Math.sin(rad);

  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

  return {
    r: clamp(
      fromLinear(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    ),
    g: clamp(
      fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    ),
    b: clamp(
      fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    ),
    a: clamp(a),
  };
}

// 格式化输出与全格式解析器
const byte = (c: number) => Math.round(clamp(c) * 255);
const hex2 = (c: number) => byte(c).toString(16).padStart(2, '0').toUpperCase();

export function toHex(hsva: Hsva): string {
  const { r, g, b, a } = hsvToRgb(hsva);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 0.999 ? hex2(a) : ''}`;
}

export const hsvToHex = toHex;

export function hexToHsv(hex: string, fallbackHue = 0): Hsva | null {
  return parseColor(hex, fallbackHue);
}

export function formatColor(hsva: Hsva, kind: ColorFormat): string {
  const rgb = hsvToRgb(hsva);
  const alphaSuffix = hsva.a < 0.999 ? ` / ${Math.round(hsva.a * 100)}%` : '';
  if (kind === 'hex') return toHex(hsva);
  if (kind === 'rgb') {
    return `rgb(${byte(rgb.r)} ${byte(rgb.g)} ${byte(rgb.b)}${alphaSuffix})`;
  }
  if (kind === 'hsl') {
    const hsl = rgbToHsl(rgb, hsva.h);
    return `hsl(${Math.round(hsl.h) % 360} ${Math.round(hsl.s * 100)}% ${Math.round(hsl.l * 100)}%${alphaSuffix})`;
  }
  const oklch = rgbToOklch(rgb, hsva.h);
  return `oklch(${round(oklch.l * 100, 1)}% ${round(oklch.c, 3)} ${round(oklch.h, 1) % 360}${alphaSuffix})`;
}

const readAlpha = (text?: string): number => {
  if (text === undefined) return 1;
  const trimmed = text.trim();
  if (trimmed.endsWith('%')) {
    return clamp(parseFloat(trimmed) / 100);
  }
  return clamp(parseFloat(trimmed));
};

const parseComponent = (text: string, isPercentPreferred = false): number => {
  const trimmed = text.trim();
  if (trimmed.endsWith('%')) {
    return clamp(parseFloat(trimmed) / 100);
  }
  const val = parseFloat(trimmed);
  return isPercentPreferred ? clamp(val / 100) : clamp(val / 255);
};

/**
 * 读取 Hex、rgb()、hsl()、oklch()（支持现代或逗号语法）。
 * 无法识别时返回 null。低彩度时保留 fallbackHue 色相。
 */
export function parseColor(input: string, fallbackHue = 0): Hsva | null {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();

  // 1. Hex
  let match = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (match) {
    let digits = match[1]!;
    if (digits.length <= 4) {
      digits = digits
        .split('')
        .map((d) => d + d)
        .join('');
    }
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
    return rgbToHsv(
      {
        r: n(0),
        g: n(2),
        b: n(4),
        a: digits.length === 8 ? n(6) : 1,
      },
      fallbackHue
    );
  }

  // 2. RGB
  match =
    /^rgba?\(\s*([\d.]+%?)(?:[\s,]+)([\d.]+%?)(?:[\s,]+)([\d.]+%?)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(
      text
    );
  if (match) {
    const r = parseComponent(match[1]!);
    const g = parseComponent(match[2]!);
    const b = parseComponent(match[3]!);
    const a = readAlpha(match[4]);
    return rgbToHsv({ r, g, b, a }, fallbackHue);
  }

  // 3. HSL
  match =
    /^hsla?\(\s*([\d.]+)(?:deg)?(?:[\s,]+)([\d.]+%?)(?:[\s,]+)([\d.]+%?)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(
      text
    );
  if (match) {
    const h = ((parseFloat(match[1]!) % 360) + 360) % 360;
    const s = parseComponent(match[2]!, true);
    const l = parseComponent(match[3]!, true);
    const a = readAlpha(match[4]);
    const next = rgbToHsv(hslToRgb(h, s, l, a), h);
    return { ...next, h };
  }

  // 4. OKLCH
  match =
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
      text
    );
  if (match) {
    const l = match[2] ? parseFloat(match[1]!) / 100 : parseFloat(match[1]!);
    const c = parseFloat(match[3]!);
    const h = ((parseFloat(match[4]!) % 360) + 360) % 360;
    const a = readAlpha(match[5]);
    const rgb = oklchToRgb(clamp(l), c, h, a);
    return rgbToHsv(rgb, fallbackHue);
  }

  return null;
}

// WCAG 2.1 相对亮度与半透明物理合成
export function computeRelativeLuminance(rgba: Rgba): number {
  return (
    0.2126 * toLinear(rgba.r) +
    0.7152 * toLinear(rgba.g) +
    0.0722 * toLinear(rgba.b)
  );
}

export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = clamp(fg.a);
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function computeWcagContrast(fg: Hsva, bgRgba: Rgba): number {
  const fgRgb = hsvToRgb(fg);
  const blended = compositeOver(fgRgb, bgRgba);
  const l1 = computeRelativeLuminance(blended);
  const l2 = computeRelativeLuminance(bgRgba);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function getWcagGrade(
  ratio: number
): 'AAA' | 'AA' | 'AA large' | 'Fails' {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'Fails';
}
