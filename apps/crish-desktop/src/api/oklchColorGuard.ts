interface OKLCH {
  l: number; // Lightness: 0 to 1
  c: number; // Chroma: 0 to 0.4
  h: number; // Hue: 0 to 360
}

/**
 * Parses basic hex or hsl or color-mix code into an approximated OKLCH color space.
 * Utilizes a lightweight color parsing helper.
 */
export function parseColorToOklch(colorStr: string, isDark?: boolean): OKLCH {
  const str = colorStr.trim().toLowerCase();

  // Handlers for common raw formats in Conex (hex, HSL, color-mix)
  let r = 0.9, g = 0.9, b = 0.9; // Default to light grey fallback

  if (str.startsWith('#')) {
    const rawHex = str.slice(1);
    // 8 位 #RRGGBBAA：alpha 不参与明度判定（对比度守卫无背景合成信息），
    // 取前 6 位 RGB 解析（与文档化行为一致：alpha 静默忽略）。
    // 非法长度（1/2/4/5/7+ 位）维持既有 NaN 契约。
    if (rawHex.length !== 3 && rawHex.length !== 6 && rawHex.length !== 8) {
      return { l: NaN, c: NaN, h: NaN };
    }
    const parsedHex = rawHex.length === 3
      ? rawHex.split('').map(char => char + char).join('')
      : rawHex.slice(0, 6);
    r = parseInt(parsedHex.slice(0, 2), 16) / 255;
    g = parseInt(parsedHex.slice(2, 4), 16) / 255;
    b = parseInt(parsedHex.slice(4, 6), 16) / 255;
  } else if (str.startsWith('hsl')) {
    const match = str.match(/hsla?\(\s*([\d.]+)(?:deg)?(?:\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%/);
    if (match) {
      const h = parseFloat(match[1]!) / 360;
      const s = parseFloat(match[2]!) / 100;
      const l = parseFloat(match[3]!) / 100;

      // HSL to RGB conversion
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue2rgb = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      r = hue2rgb(h + 1/3);
      g = hue2rgb(h);
      b = hue2rgb(h - 1/3);
    }
  } else if (str.includes('color-mix')) {
    // If it's a dynamic color mix, we approximate lightness based on whether it is light-mode or dark-mode oriented
    if (typeof isDark === 'boolean') {
      return { l: isDark ? 0.1 : 0.9, c: 0.05, h: 35 };
    }
    if (str.includes('#ffffff') || str.includes('transparent') || str.includes('hsl(35, 10%') || str.includes('hsl(34, 30%, 45%')) {
      return { l: 0.9, c: 0.05, h: 35 };
    } else {
      return { l: 0.1, c: 0.05, h: 35 };
    }
  }

  // Linear sRGB conversion
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

  // Approximate OKLCH lightness
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const c = Math.sqrt((r - l) * (r - l) + (g - l) * (g - l)) * 0.35;
  const h = Math.atan2(g - r, r - b) * (180 / Math.PI);

  return { l, c, h: h < 0 ? h + 360 : h };
}

export function getContrastGuardedText(bgPrimaryColor: string, isDark?: boolean): string {
  try {
    const oklch = parseColorToOklch(bgPrimaryColor, isDark);
    if (oklch.l > 0.52) {
      // Light background: Return deep warm charcoal contrast (soft and highly readable)
      return 'hsl(35, 12%, 11%)';
    } else {
      // Dark background: Return bright soft-white contrast
      return 'hsl(0, 0%, 94%)';
    }
  } catch {
    if (typeof isDark === 'boolean') {
      return isDark ? 'hsl(0, 0%, 94%)' : 'hsl(35, 12%, 11%)';
    }
    return 'hsl(35, 12%, 11%)';
  }
}

/**
 * Updates CSS Custom Properties for text dynamically based on the current skin's background
 */
export function applyTextContrastGuard(
  bgPrimaryColor: string,
  isDark: boolean,
  options?: { isCustomSkin?: boolean; explicitTextPrimary?: string }
): void {
  if (typeof window === 'undefined') return;

  const isCustom = options?.isCustomSkin ?? false;
  const explicitFg = options?.explicitTextPrimary;

  // 官方预设且已显式提供字色时，官方预设已满足 WCAG 规范，保持原汁原味，不作侵入式覆盖
  if (!isCustom && explicitFg) {
    return;
  }

  const root = document.documentElement;
  const textPrimary = getContrastGuardedText(bgPrimaryColor, isDark);

  root.style.setProperty('--text-primary', textPrimary);

  const isComputedDark = textPrimary === 'hsl(0, 0%, 94%)';

  if (isComputedDark) {
    root.style.setProperty('--text-secondary', 'hsl(0, 0%, 72%)');
    root.style.setProperty('--text-tertiary', 'hsl(0, 0%, 50%)');
  } else {
    root.style.setProperty('--text-secondary', 'hsl(35, 8%, 34%)');
    root.style.setProperty('--text-tertiary', 'hsl(35, 6%, 52%)');
  }
}
