const FONT_SANS_PRETEXT = 'Inter';
const FONT_MONO_PRETEXT = 'Consolas';

const WEIGHT_MAP: Record<FontWeight, number> = {
  normal: 400,
  medium: 500,
  semibold: 600,
};

const GENERIC_FONTS = new Set([
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'segoe ui variable text',
  'sans-serif',
  'serif',
  'monospace',
  'ui-monospace',
  'ui-sans-serif',
  'ui-serif',
  'cursive',
  'fantasy',
  'math',
  'emoji',
]);

export type FontRole = 'sans' | 'mono';
export type FontWeight = 'normal' | 'medium' | 'semibold';
export type UiSize = 'small' | 'medium' | 'large';

const fontSizeCache = new Map<string, number>();
let probeElement: HTMLDivElement | null = null;

function isGenericFont(name: string): boolean {
  return GENERIC_FONTS.has(name.toLowerCase());
}

function parseFirstNamedFont(stack: string): string | null {
  for (const part of stack.split(',')) {
    const name = part.trim().replace(/^['"]|['"]$/g, '');
    if (name && !isGenericFont(name)) return name;
  }
  return null;
}

function getFontFamily(role: FontRole): string {
  const cssVar = role === 'sans' ? '--font-sans' : '--font-mono';
  const stack = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return parseFirstNamedFont(stack) ?? (role === 'sans' ? FONT_SANS_PRETEXT : FONT_MONO_PRETEXT);
}

function safePx(px: number, fallback = 14): number {
  return Number.isFinite(px) && px > 0 ? px : fallback;
}

export function getResolvedFontSizePx(cssVar: string): number {
  if (fontSizeCache.has(cssVar)) return fontSizeCache.get(cssVar)!;

  if (!probeElement) {
    probeElement = document.createElement('div');
    probeElement.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:0;overflow:hidden';
    document.documentElement.appendChild(probeElement);
  }

  probeElement.style.fontSize = `var(${cssVar})`;
  const px = safePx(parseFloat(getComputedStyle(probeElement).fontSize));
  if (isFinite(px)) fontSizeCache.set(cssVar, px);
  return px || 14;
}

export function buildPretextFont(
  role: FontRole,
  weight: FontWeight,
  sizePx?: number,
): string {
  const family = getFontFamily(role);
  const px = sizePx ?? getResolvedFontSizePx('--font-size-base');
  return `${WEIGHT_MAP[weight]} ${safePx(px)}px ${family}`;
}

export function buildPretextFontForUiSize(
  uiSize: UiSize,
  role: FontRole = 'sans',
  weight: FontWeight = 'normal',
): string {
  const cacheKey = `${uiSize}:${role}:${weight}`;
  const cached = fontSizeCache.get(cacheKey);
  if (cached) return `${WEIGHT_MAP[weight]} ${cached}px ${getFontFamily(role)}`;

  const html = document.documentElement;
  const current = html.getAttribute('data-ui-size');
  const isCurrentUi =
    uiSize === 'medium'
      ? (current === null || current === 'medium')
      : current === uiSize;

  let px: number;

  if (isCurrentUi) {
    px = getResolvedFontSizePx('--font-size-base');
  } else {
    if (uiSize === 'medium') {
      html.removeAttribute('data-ui-size');
    } else {
      html.setAttribute('data-ui-size', uiSize);
    }

    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:0;overflow:hidden;font-size:var(--font-size-base)';
    html.appendChild(probe);
    px = safePx(parseFloat(getComputedStyle(probe).fontSize));
    html.removeChild(probe);

    if (current === null) {
      html.removeAttribute('data-ui-size');
    } else {
      html.setAttribute('data-ui-size', current);
    }
  }

  fontSizeCache.set(cacheKey, px);
  const family = getFontFamily(role);
  return `${WEIGHT_MAP[weight]} ${px}px ${family}`;
}
