// @vitest-environment node
/**
 * WCAG 2.1 AA 对比度断言（08-步6 T5-1，04-detail ③表验收器 + 防回潮门禁）
 *
 * - 值/fs 契约模式（仿 style-contract.test.ts）：直接读 tokens.css，
 *   值断言不受 vitest 覆盖率口径约束（04-detail 风险 R6 缓解口径）。
 * - 判定：正文/文字组合 ≥ 4.5:1；UI/状态点组合 ≥ 3:1（04-detail ③表分类阈值）。
 * - 组成：③表 8 行 + 全部语义文字/状态 token × 主题主背景（light/dark 双块遍历）。
 * - 语义约定（③表）：accent 装饰色（--accent-orange/--color-warning 等）保留作
 *   图标/装饰用途不参与文字断言；文字用途一律走 --text-*-strong 等文字专用 token。
 * - 取值以断言绿为唯一判据：任何「新增不达标组合」或「达标项被调浅」即红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

const LIGHT_BLOCK_RE = /:root,[\s\S]*?\n\}/;
const DARK_BLOCK_RE = /html\[data-theme=['"]dark['"]\]\s*\{[\s\S]*?\n\}/;

type Rgb = { r: number; g: number; b: number };
type TokenTable = Map<string, string>;

function parseBlock(blockRe: RegExp): TokenTable {
  const block = CSS.match(blockRe)?.[0] ?? '';
  expect(block, 'tokens.css 主题块应可匹配').toBeTruthy();
  const table = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    table.set(m[1], m[2].trim());
  }
  return table;
}

const LIGHT_TOKENS = parseBlock(LIGHT_BLOCK_RE);
const DARK_TOKENS = parseBlock(DARK_BLOCK_RE);

function hexToRgb(value: string): Rgb | null {
  const h = value.replace('#', '').trim();
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

function hslToRgb(value: string): Rgb | null {
  const m = value.match(
    /hsla?\(\s*([\d.]+)(?:deg)?(?:\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%(?:\s*(?:,|\/)\s*[\d.]+%?)?\s*\)/i
  );
  if (!m) return null;
  const h = ((parseFloat(m[1]) % 360) + 360) % 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + base) * 255),
    g: Math.round((g + base) * 255),
    b: Math.round((b + base) * 255),
  };
}

function oklchToRgb(value: string, bg: Rgb): Rgb | null {
  const m = value.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i
  );
  if (!m) return null;
  const L = parseFloat(m[1]);
  const C = parseFloat(m[2]);
  const hDeg = parseFloat(m[3]);
  const alphaStr = m[4];
  const alpha = alphaStr
    ? alphaStr.endsWith('%')
      ? parseFloat(alphaStr) / 100
      : parseFloat(alphaStr)
    : 1;

  const hRad = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l_cube = l_ * l_ * l_;
  const m_cube = m_ * m_ * m_;
  const s_cube = s_ * s_ * s_;

  const r_lin =
    +4.0767416621 * l_cube - 3.3077115913 * m_cube + 0.2309699292 * s_cube;
  const g_lin =
    -1.2684380046 * l_cube + 2.6097574011 * m_cube - 0.3413193965 * s_cube;
  const b_lin =
    -0.0041960863 * l_cube - 0.7034186147 * m_cube + 1.707614701 * s_cube;

  const toSrgb = (c: number) => {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };

  const r = Math.round(toSrgb(r_lin) * 255);
  const g = Math.round(toSrgb(g_lin) * 255);
  const b_val = Math.round(toSrgb(b_lin) * 255);

  if (alpha < 1) {
    return {
      r: Math.round(r * alpha + bg.r * (1 - alpha)),
      g: Math.round(g * alpha + bg.g * (1 - alpha)),
      b: Math.round(b_val * alpha + bg.b * (1 - alpha)),
    };
  }

  return { r, g, b: b_val };
}

/** 解析 token 值为 sRGB；color-mix(in srgb, A p%, transparent) 按主题背景合成 */
function resolveColor(
  value: string,
  table: TokenTable,
  bg: Rgb,
  depth = 0
): Rgb | null {
  if (depth > 8) return null;
  const v = value.trim();
  const hex = hexToRgb(v);
  if (hex) return hex;
  const hsl = hslToRgb(v);
  if (hsl) return hsl;
  const oklch = oklchToRgb(v, bg);
  if (oklch) return oklch;
  const varMatch = v.match(/^var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)$/);
  if (varMatch) {
    const resolved = resolveColor(
      table.get(varMatch[1]) ?? '',
      table,
      bg,
      depth + 1
    );
    if (resolved) return resolved;
    if (varMatch[2]) return resolveColor(varMatch[2], table, bg, depth + 1);
    return null;
  }
  const mix = v.match(
    /^color-mix\(in srgb,\s*(.*)\s+([\d.]+)%\s*,\s*(transparent|black|#000|#000000)\)$/i
  );
  if (mix) {
    const base = resolveColor(mix[1], table, bg, depth + 1);
    if (!base) return null;
    const pct = parseFloat(mix[2]) / 100;
    const towardBlack = mix[3].toLowerCase() !== 'transparent';
    const dest = towardBlack ? { r: 0, g: 0, b: 0 } : bg;
    return {
      r: base.r * pct + dest.r * (1 - pct),
      g: base.g * pct + dest.g * (1 - pct),
      b: base.b * pct + dest.b * (1 - pct),
    };
  }
  return null;
}

function linearize(ch: number): number {
  const c = ch / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(c: Rgb): number {
  return (
    0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b)
  );
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function resolveToken(token: string, table: TokenTable, bg: Rgb): Rgb {
  const value = table.get(token);
  expect(value, `${token} 应在当前主题块内定义`).toBeTruthy();
  const rgb = resolveColor(value ?? '', table, bg);
  expect(rgb, `${token}（${value}）应可解析为 sRGB 颜色`).toBeTruthy();
  return rgb as Rgb;
}

function assertMin(
  token: string,
  bg: Rgb,
  threshold: number,
  table: TokenTable,
  label: string
) {
  const ratio = contrastRatio(resolveToken(token, table, bg), bg);
  expect(
    ratio,
    `${label}：${token} 对比度 ${ratio.toFixed(2)}:1 未达 WCAG AA ${threshold}:1`
  ).toBeGreaterThanOrEqual(threshold);
}

const LIGHT_BG_PRIMARY = resolveToken('--bg-primary', LIGHT_TOKENS, {
  r: 0,
  g: 0,
  b: 0,
});
const LIGHT_BG_SECONDARY = resolveToken('--bg-secondary', LIGHT_TOKENS, {
  r: 0,
  g: 0,
  b: 0,
});
const DARK_BG_PRIMARY = resolveToken('--bg-primary', DARK_TOKENS, {
  r: 0,
  g: 0,
  b: 0,
});

describe('对比度验收（04-detail ③表 8 行，WCAG 2.1 AA）', () => {
  it('行 1：light text-tertiary vs 主背景 ≥ 4.5:1（时间戳/ghost 按钮/提示文字）', () => {
    assertMin('--text-tertiary', LIGHT_BG_PRIMARY, 4.5, LIGHT_TOKENS, '行 1');
  });

  it('行 2：light text-tertiary vs 侧栏背景 ≥ 4.5:1（侧栏元信息）', () => {
    assertMin('--text-tertiary', LIGHT_BG_SECONDARY, 4.5, LIGHT_TOKENS, '行 2');
  });

  it('行 3：light text-warning-strong vs 主背景 ≥ 4.5:1（橙色文字专用 token）', () => {
    assertMin(
      '--text-warning-strong',
      LIGHT_BG_PRIMARY,
      4.5,
      LIGHT_TOKENS,
      '行 3'
    );
  });

  it('行 4：light accent-blue vs 主背景 ≥ 4.5:1（链接/强调文字）', () => {
    assertMin('--accent-blue', LIGHT_BG_PRIMARY, 4.5, LIGHT_TOKENS, '行 4');
  });

  it('行 5：light color-active vs 主背景 ≥ 3:1（状态点 UI 组件线）', () => {
    assertMin('--color-active', LIGHT_BG_PRIMARY, 3.0, LIGHT_TOKENS, '行 5');
  });

  it('行 6：light ui-text-warning vs 主背景 ≥ 4.5:1（StatusDiagnosticsPanel WARN）', () => {
    assertMin('--ui-text-warning', LIGHT_BG_PRIMARY, 4.5, LIGHT_TOKENS, '行 6');
  });

  it('行 7：dark text-tertiary vs 主背景（灰度 60%，用户锁定，约 3.0:1）', () => {
    assertMin('--text-tertiary', DARK_BG_PRIMARY, 2.9, DARK_TOKENS, '行 7');
  });

  it('行 8：dark text-secondary vs 主背景（灰度 40%，用户锁定，约 6.0:1）', () => {
    assertMin('--text-secondary', DARK_BG_PRIMARY, 5.8, DARK_TOKENS, '行 8');
  });

  it('深色正文四档：灰度 20 / 40 / 60 / 70，向黑混合未压灰前景', () => {
    expect(DARK_TOKENS.get('--text-primary')).toBe(
      'color-mix(in srgb, var(--user-text-primary) 80%, black)'
    );
    expect(DARK_TOKENS.get('--text-secondary')).toBe(
      'color-mix(in srgb, var(--user-text-primary) 60%, black)'
    );
    expect(DARK_TOKENS.get('--text-tertiary')).toBe(
      'color-mix(in srgb, var(--user-text-primary) 40%, black)'
    );
    expect(DARK_TOKENS.get('--text-faint')).toBe(
      'color-mix(in srgb, var(--user-text-primary) 30%, black)'
    );
    expect(DARK_TOKENS.get('--text-quiet')).toBe('var(--text-tertiary)');
    expect(DARK_TOKENS.get('--user-text-primary')).toBe('#f5f5f5');
  });
});

describe('对比度验收（全部语义文字/状态 token × 主题主背景）', () => {
  // 分类阈值（04-detail ③表语义）：
  //   TEXT（≥4.5:1）：正文/次级正文/强调文字/链接/状态文字
  //   UI（≥3:1）：状态点与状态组件、danger/success 语义别名（审计 3.3 大字场景口径）
  const TEXT_TOKENS = [
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
    '--text-muted',
    '--text-warning-strong',
    '--text-success-strong',
    '--accent-blue',
    '--ui-text-warning',
  ];
  const UI_TOKENS = [
    '--text-danger',
    '--text-success',
    '--ui-text-success',
    '--ui-text-danger',
    '--ui-text-muted',
    '--ui-text-info',
    '--color-active',
    '--color-success',
    '--color-error',
    '--color-info',
  ];

  it.each(TEXT_TOKENS.map((t) => [t]))(
    'light 文字 token %s ≥ 4.5:1',
    (token) => {
      assertMin(token, LIGHT_BG_PRIMARY, 4.5, LIGHT_TOKENS, 'light 文字');
    }
  );

  it.each(UI_TOKENS.map((t) => [t]))(
    'light UI/状态 token %s ≥ 3:1',
    (token) => {
      assertMin(token, LIGHT_BG_PRIMARY, 3.0, LIGHT_TOKENS, 'light UI');
    }
  );

  it.each(
    TEXT_TOKENS.filter(
      (t) => t !== '--text-tertiary' && t !== '--text-muted'
    ).map((t) => [t])
  )('dark 文字 token %s ≥ 4.5:1', (token) => {
    assertMin(token, DARK_BG_PRIMARY, 4.5, DARK_TOKENS, 'dark 文字');
  });

  it.each(['--text-tertiary', '--text-muted'].map((t) => [t]))(
    'dark 弱文字 token %s ≥ 2.9:1（灰度 60%）',
    (token) => {
      assertMin(token, DARK_BG_PRIMARY, 2.9, DARK_TOKENS, 'dark 弱文字');
    }
  );

  it.each(UI_TOKENS.map((t) => [t]))('dark UI/状态 token %s ≥ 3:1', (token) => {
    assertMin(token, DARK_BG_PRIMARY, 3.0, DARK_TOKENS, 'dark UI');
  });
});
