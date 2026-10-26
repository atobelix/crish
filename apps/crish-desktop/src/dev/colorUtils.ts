/**
 * 自研轻量纯函数色彩工具
 * 纯逻辑模块：支持 sRGB ↔ Linear RGB ↔ Oklab 颜色转换、oklabMix 插值、
 * WCAG 2.1 相对亮度与对比度 wcagContrast、明度差 deltaL、Porter-Duff blendAlpha。
 * 无外部依赖，输入异常时安全兜底，不抛未捕获异常。
 */

export interface RGB {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
  a?: number; // 0..1, 默认 1.0
}

export interface Oklab {
  L: number; // 0..1 (Lightness)
  a: number; // -0.4..+0.4 (green-red)
  b: number; // -0.4..+0.4 (blue-yellow)
}

/** 伽马解码：sRGB 标量 (0..1) 转 Linear RGB (0..1) */
function sRgbToLinear(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/** 伽马编码：Linear RGB 标量 (0..1) 转 sRGB (0..1) */
function linearToSRgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** HSL 转 RGB 算法 */
function hslToRgbChannels(
  h: number,
  s: number,
  l: number
): [number, number, number] {
  const normH = ((h % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(1, s));
  const normL = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (normH < 60) {
    r1 = c;
    g1 = x;
  } else if (normH < 120) {
    r1 = x;
    g1 = c;
  } else if (normH < 180) {
    g1 = c;
    b1 = x;
  } else if (normH < 240) {
    g1 = x;
    b1 = c;
  } else if (normH < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/**
 * 解析 CSS 颜色字符串
 * 支持 #hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb/rgba (含斜杠语法),
 * hsl/hsla, oklab(...), transparent。非法格式安全回退至黑色。
 */
export function parseCssColor(cssColor: string): RGB {
  const fallback: RGB = { r: 0, g: 0, b: 0, a: 1 };
  if (!cssColor || typeof cssColor !== 'string') return fallback;

  const raw = cssColor.trim().toLowerCase();
  if (raw === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (raw === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (raw === 'white') return { r: 255, g: 255, b: 255, a: 1 };

  // 1. #hex
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const c0 = hex[0];
      const c1 = hex[1];
      const c2 = hex[2];
      const c3 = hex[3];
      if (!c0 || !c1 || !c2) return fallback;

      const r = parseInt(c0 + c0, 16);
      const g = parseInt(c1 + c1, 16);
      const b = parseInt(c2 + c2, 16);
      const a = hex.length === 4 && c3 ? parseInt(c3 + c3, 16) / 255 : 1;
      if (
        Number.isNaN(r) ||
        Number.isNaN(g) ||
        Number.isNaN(b) ||
        Number.isNaN(a)
      ) {
        return fallback;
      }
      return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (
        Number.isNaN(r) ||
        Number.isNaN(g) ||
        Number.isNaN(b) ||
        Number.isNaN(a)
      ) {
        return fallback;
      }
      return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    return fallback;
  }

  // 2. rgb / rgba
  const rgbMatch = raw.match(/^rgba?\((.+)\)$/);
  if (rgbMatch && rgbMatch[1]) {
    const inner = rgbMatch[1].replace(/\//g, ' ').replace(/,/g, ' ').trim();
    const parts = inner.split(/\s+/).filter(Boolean);
    const p0 = parts[0];
    const p1 = parts[1];
    const p2 = parts[2];
    if (p0 && p1 && p2) {
      const parseChannel = (p: string) => {
        if (p.endsWith('%')) return Math.round(parseFloat(p) * 2.55);
        return parseFloat(p);
      };
      const r = Math.max(0, Math.min(255, Math.round(parseChannel(p0))));
      const g = Math.max(0, Math.min(255, Math.round(parseChannel(p1))));
      const b = Math.max(0, Math.min(255, Math.round(parseChannel(p2))));
      let a = 1;
      const rawA = parts[3];
      if (rawA) {
        a = rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
        a = Math.max(0, Math.min(1, a));
      }
      if (
        Number.isNaN(r) ||
        Number.isNaN(g) ||
        Number.isNaN(b) ||
        Number.isNaN(a)
      ) {
        return fallback;
      }
      return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    return fallback;
  }

  // 3. hsl / hsla
  const hslMatch = raw.match(/^hsla?\((.+)\)$/);
  if (hslMatch && hslMatch[1]) {
    const inner = hslMatch[1].replace(/\//g, ' ').replace(/,/g, ' ').trim();
    const parts = inner.split(/\s+/).filter(Boolean);
    const p0 = parts[0];
    const p1 = parts[1];
    const p2 = parts[2];
    if (p0 && p1 && p2) {
      const h = parseFloat(p0.replace('deg', ''));
      const s = parseFloat(p1.replace('%', '')) / 100;
      const l = parseFloat(p2.replace('%', '')) / 100;
      let a = 1;
      const rawA = parts[3];
      if (rawA) {
        a = rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
        a = Math.max(0, Math.min(1, a));
      }
      if (
        Number.isNaN(h) ||
        Number.isNaN(s) ||
        Number.isNaN(l) ||
        Number.isNaN(a)
      ) {
        return fallback;
      }
      const [r, g, b] = hslToRgbChannels(h, s, l);
      return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    return fallback;
  }

  // 4. oklab(L a b / alpha)
  const oklabMatch = raw.match(/^oklab\((.+)\)$/);
  if (oklabMatch && oklabMatch[1]) {
    const inner = oklabMatch[1].replace(/\//g, ' ').replace(/,/g, ' ').trim();
    const parts = inner.split(/\s+/).filter(Boolean);
    const p0 = parts[0];
    const p1 = parts[1];
    const p2 = parts[2];
    if (p0 && p1 && p2) {
      const L = p0.endsWith('%') ? parseFloat(p0) / 100 : parseFloat(p0);
      const labA = parseFloat(p1);
      const labB = parseFloat(p2);
      let alpha = 1;
      const rawAlpha = parts[3];
      if (rawAlpha) {
        alpha = rawAlpha.endsWith('%')
          ? parseFloat(rawAlpha) / 100
          : parseFloat(rawAlpha);
        alpha = Math.max(0, Math.min(1, alpha));
      }
      if (
        Number.isNaN(L) ||
        Number.isNaN(labA) ||
        Number.isNaN(labB) ||
        Number.isNaN(alpha)
      ) {
        return fallback;
      }
      const rgb = oklabToRgb({ L, a: labA, b: labB });
      return { ...rgb, a: Math.round(alpha * 1000) / 1000 };
    }
    return fallback;
  }

  return fallback;
}

/** sRGB 转换为 Oklab 色彩空间 (Ottosson 2020 算法) */
export function rgbToOklab(rgb: RGB): Oklab {
  const rLinear = sRgbToLinear(rgb.r / 255);
  const gLinear = sRgbToLinear(rgb.g / 255);
  const bLinear = sRgbToLinear(rgb.b / 255);

  const l =
    0.4122214708 * rLinear + 0.5363325363 * gLinear + 0.0514459929 * bLinear;
  const m =
    0.2119034982 * rLinear + 0.6806995451 * gLinear + 0.1073969566 * bLinear;
  const s =
    0.0883024619 * rLinear + 0.2817188376 * gLinear + 0.6299787005 * bLinear;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** Oklab 色彩空间转回 sRGB (含 0..255 夹取保护) */
export function oklabToRgb(lab: Oklab): RGB {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLinear = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLinear = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const r = Math.round(Math.max(0, Math.min(255, linearToSRgb(rLinear) * 255)));
  const g = Math.round(Math.max(0, Math.min(255, linearToSRgb(gLinear) * 255)));
  const b = Math.round(Math.max(0, Math.min(255, linearToSRgb(bLinear) * 255)));

  return { r, g, b, a: 1.0 };
}

/**
 * Oklab 色彩空间线性插值: color-mix(in oklab, color1, color2 p%)
 * @param p 0..1，代表 color2 所占比例 (0 = 100% color1, 1 = 100% color2)
 */
export function oklabMix(
  color1: string | RGB,
  color2: string | RGB,
  p: number
): RGB {
  const rgb1 = typeof color1 === 'string' ? parseCssColor(color1) : color1;
  const rgb2 = typeof color2 === 'string' ? parseCssColor(color2) : color2;
  const t = Math.max(0, Math.min(1, p));

  const lab1 = rgbToOklab(rgb1);
  const lab2 = rgbToOklab(rgb2);

  const mixedLab: Oklab = {
    L: lab1.L * (1 - t) + lab2.L * t,
    a: lab1.a * (1 - t) + lab2.a * t,
    b: lab1.b * (1 - t) + lab2.b * t,
  };

  const a1 = rgb1.a ?? 1.0;
  const a2 = rgb2.a ?? 1.0;
  const mixedAlpha = a1 * (1 - t) + a2 * t;

  const result = oklabToRgb(mixedLab);
  result.a = Math.round(mixedAlpha * 1000) / 1000;
  return result;
}

/** 计算 sRGB 相对亮度 L (WCAG 2.1 规范) */
export function relativeLuminance(rgb: RGB): number {
  const rLin = sRgbToLinear(rgb.r / 255);
  const gLin = sRgbToLinear(rgb.g / 255);
  const bLin = sRgbToLinear(rgb.b / 255);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/** 计算两色彩的 WCAG 2.1 对比度 (1.0..21.0) */
export function wcagContrast(
  foreground: string | RGB,
  background: string | RGB
): number {
  const fg =
    typeof foreground === 'string' ? parseCssColor(foreground) : foreground;
  const bg =
    typeof background === 'string' ? parseCssColor(background) : background;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  const ratio = (max + 0.05) / (min + 0.05);
  return Math.round(ratio * 100) / 100;
}

/** 计算两色彩在 Oklab 下的明度差 ΔL* (0..100) */
export function deltaL(color1: string | RGB, color2: string | RGB): number {
  const c1 = typeof color1 === 'string' ? parseCssColor(color1) : color1;
  const c2 = typeof color2 === 'string' ? parseCssColor(color2) : color2;
  const lab1 = rgbToOklab(c1);
  const lab2 = rgbToOklab(c2);
  const diff = Math.abs(lab1.L - lab2.L) * 100;
  return Math.round(diff * 100) / 100;
}

/** 经典 Source-Over Alpha 混合: Cs * as + Cb * ab * (1 - as) */
export function blendAlpha(source: RGB, backdrop: RGB): RGB {
  const as = source.a ?? 1.0;
  const ab = backdrop.a ?? 1.0;
  const aOut = as + ab * (1.0 - as);

  if (aOut <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const blendChannel = (cs: number, cb: number) => {
    return Math.round((cs * as + cb * ab * (1.0 - as)) / aOut);
  };

  return {
    r: Math.max(0, Math.min(255, blendChannel(source.r, backdrop.r))),
    g: Math.max(0, Math.min(255, blendChannel(source.g, backdrop.g))),
    b: Math.max(0, Math.min(255, blendChannel(source.b, backdrop.b))),
    a: Math.round(aOut * 1000) / 1000,
  };
}
