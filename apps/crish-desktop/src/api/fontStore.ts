/**
 * 字体体系：按平台自动栈 + 内嵌免费字体 + 本机字体。
 * 独立 key `crish_fonts`，冷启动同步应用；可与 settings.fonts 合并。
 */

import { logger } from '../services/LoggerService';

// 平台探测 + 字体栈子模块（拆分自本文件，hub re-export 保持外部 import 路径不变）
export {
  detectPlatform,
  platformLabel,
  resolveUiStack,
  resolveMonoStack,
  isLocalFontChoice,
  localFontFamily,
  toLocalChoice,
} from './fontStoreStacks';
import {
  detectPlatform,
  platformLabel,
  resolveUiStack,
  resolveMonoStack,
  isLocalFontChoice,
  localFontFamily,
} from './fontStoreStacks';

export type PlatformId =
  | 'windows'
  | 'macos'
  | 'linux'
  | 'ios'
  | 'android'
  | 'harmony'
  | 'unknown';

/** 内嵌 UI 字体 id（免费 OFL） */
export type EmbeddedUiFontId = 'inter' | 'ibm-plex-sans';
/** 内嵌代码字体 id */
export type EmbeddedMonoFontId = 'jetbrains-mono' | 'ibm-plex-mono';

/**
 * 界面字体选择：
 * - auto: 平台系统栈
 * - system-ui: 通用 system-ui 栈
 * - inter / ibm-plex-sans: 内嵌
 * - local:Family: 本机字体族名
 */
export type UiFontChoice = 'auto' | 'system-ui' | EmbeddedUiFontId | `local:${string}`;

/**
 * 代码字体选择
 */
export type MonoFontChoice =
  | 'auto'
  | 'system-mono'
  | EmbeddedMonoFontId
  | `local:${string}`;

export interface FontPreferences {
  uiFont: UiFontChoice;
  monoFont: MonoFontChoice;
  /** 代码连字（calt/liga） */
  monoLigatures: boolean;
  v: 1;
}

export const DEFAULT_FONT_PREFS: FontPreferences = {
  uiFont: 'auto',
  monoFont: 'auto',
  monoLigatures: false,
  v: 1,
};

const FONTS_KEY = 'crish_fonts';
const SETTINGS_KEY = 'crish_settings';
const SETTINGS_KEY_LEGACY = 'conex_pi_settings';

const loadedEmbedded = new Set<string>();

/* ---------- catalog (settings UI) ---------- */

export interface FontOptionMeta {
  id: string;
  label: string;
  kind: 'auto' | 'system' | 'embedded' | 'local';
  /** 预览用 family */
  previewFamily?: string;
  desc?: string;
}

export function uiFontOptions(): FontOptionMeta[] {
  return [
    {
      id: 'auto',
      label: '自动（系统优化）',
      kind: 'auto',
      desc: `跟随 ${platformLabel()}：中英文同一主字体，零体积`,
    },
    {
      id: 'system-ui',
      label: '系统 UI',
      kind: 'system',
      desc: '中英文统一主字体 + system-ui 回退',
    },
    {
      id: 'inter',
      label: 'Inter（内嵌）',
      kind: 'embedded',
      previewFamily: 'Inter',
      desc: '免费 OFL · 西文为主，中文回退系统字体',
    },
    {
      id: 'ibm-plex-sans',
      label: 'IBM Plex Sans（内嵌）',
      kind: 'embedded',
      previewFamily: 'IBM Plex Sans',
      desc: '免费 OFL · 西文为主，中文回退系统字体',
    },
  ];
}

export function monoFontOptions(): FontOptionMeta[] {
  return [
    {
      id: 'auto',
      label: '自动（系统优化）',
      kind: 'auto',
      desc: `跟随 ${platformLabel()} 等宽字体`,
    },
    {
      id: 'system-mono',
      label: '系统等宽',
      kind: 'system',
      desc: '本机 mono 栈',
    },
    {
      id: 'jetbrains-mono',
      label: 'JetBrains Mono（内嵌）',
      kind: 'embedded',
      previewFamily: 'JetBrains Mono',
      desc: '免费 OFL · 推荐代码字体',
    },
    {
      id: 'ibm-plex-mono',
      label: 'IBM Plex Mono（内嵌）',
      kind: 'embedded',
      previewFamily: 'IBM Plex Mono',
      desc: '免费 OFL · 与 Plex Sans 成套',
    },
  ];
}

/** 各平台常见本机字体（无 Local Font API 时的精选列表） */
export function curatedLocalFonts(platform: PlatformId = detectPlatform()): {
  ui: string[];
  mono: string[];
} {
  const uiCommon = [
    'Segoe UI',
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    'PingFang SC',
    'Hiragino Sans GB',
    'Noto Sans SC',
    'Source Han Sans SC',
    'HarmonyOS Sans',
    'Roboto',
    'Ubuntu',
    'Cantarell',
    'Arial',
    'Helvetica Neue',
    'Tahoma',
    'Verdana',
  ];
  const monoCommon = [
    'Cascadia Mono',
    'Cascadia Code',
    'Consolas',
    'SF Mono',
    'Menlo',
    'Monaco',
    'Courier New',
    'DejaVu Sans Mono',
    'Noto Sans Mono',
    'Liberation Mono',
    'Source Code Pro',
    'Fira Code',
  ];
  if (platform === 'windows') {
    return {
      ui: ['Segoe UI', 'Segoe UI Variable Text', 'Microsoft YaHei UI', 'Microsoft YaHei', 'SimHei', 'SimSun', 'Arial', 'Tahoma', 'Verdana', 'Calibri'],
      mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New', 'Lucida Console'],
    };
  }
  if (platform === 'macos' || platform === 'ios') {
    return {
      ui: ['-apple-system 不可选，用系统自动', 'PingFang SC', 'Hiragino Sans GB', 'Helvetica Neue', 'Arial', 'Songti SC', 'Heiti SC'].filter((x) => !x.includes('不可选')),
      mono: ['SF Mono', 'Menlo', 'Monaco', 'Courier New'],
    };
  }
  if (platform === 'linux') {
    return {
      ui: ['Noto Sans', 'Noto Sans CJK SC', 'Ubuntu', 'DejaVu Sans', 'WenQuanYi Micro Hei', 'Source Han Sans SC', 'Arial'],
      mono: ['DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'Courier New'],
    };
  }
  return { ui: uiCommon, mono: monoCommon };
}

/* ---------- detect local fonts ---------- */

/** canvas 测宽：本机是否安装某字体 */
export function isFontInstalled(family: string): boolean {
  if (typeof document === 'undefined' || !family.trim()) return false;
  try {
    const test = 'mmmmmmmmmmlli@字';
    const size = '72px';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const base = 'monospace';
    ctx.font = `${size} ${base}`;
    const w0 = ctx.measureText(test).width;
    ctx.font = `${size} '${family.replace(/'/g, '')}', ${base}`;
    const w1 = ctx.measureText(test).width;
    return w0 !== w1;
  } catch {
    return false;
  }
}

export type LocalFontEntry = { family: string; fullName?: string; style?: string };

/**
 * 扫描本机字体（产品友好）：
 * - 不用 Local Font Access API（会弹出 localhost 权限框，正式版不可接受）
 * - 用 canvas 探测各平台精选字体 + 用户手动输入
 */
export async function listLocalFonts(): Promise<LocalFontEntry[]> {
  const map = new Map<string, LocalFontEntry>();
  const curated = curatedLocalFonts();
  const all = [...new Set([...curated.ui, ...curated.mono])];
  for (const fam of all) {
    if (!fam || fam.startsWith('-')) continue;
    if (isFontInstalled(fam)) map.set(fam, { family: fam });
  }
  // 微任务让 UI 可先响应用户点击（避免扫描卡顿）
  await Promise.resolve();
  return Array.from(map.values()).sort((a, b) =>
    a.family.localeCompare(b.family, 'zh-CN', { sensitivity: 'base' }),
  );
}

/* ---------- load embedded ---------- */

async function ensureEmbeddedUi(id: EmbeddedUiFontId): Promise<void> {
  if (loadedEmbedded.has(id)) return;
  try {
    // 仅 latin 子集，体积小；中文仍走系统回退栈
    if (id === 'inter') {
      await import('@fontsource/inter/latin-400.css');
      await import('@fontsource/inter/latin-ext-400.css');
    } else if (id === 'ibm-plex-sans') {
      await import('@fontsource/ibm-plex-sans/latin-400.css');
      await import('@fontsource/ibm-plex-sans/latin-ext-400.css');
    }
    loadedEmbedded.add(id);
  } catch (e) {
    logger.warn(`[fontStore] load ui font failed (fontId=${id})`, {
      module: 'fontStore',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
  }
}

async function ensureEmbeddedMono(id: EmbeddedMonoFontId): Promise<void> {
  if (loadedEmbedded.has(id)) return;
  try {
    if (id === 'jetbrains-mono') {
      await import('@fontsource/jetbrains-mono/latin-400.css');
      await import('@fontsource/jetbrains-mono/latin-ext-400.css');
    } else if (id === 'ibm-plex-mono') {
      await import('@fontsource/ibm-plex-mono/latin-400.css');
      await import('@fontsource/ibm-plex-mono/latin-ext-400.css');
    }
    loadedEmbedded.add(id);
  } catch (e) {
    logger.warn(`[fontStore] load mono font failed (fontId=${id})`, {
      module: 'fontStore',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
  }
}

export async function ensureFontsLoaded(prefs: FontPreferences): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (prefs.uiFont === 'inter' || prefs.uiFont === 'ibm-plex-sans') {
    jobs.push(ensureEmbeddedUi(prefs.uiFont));
  }
  if (prefs.monoFont === 'jetbrains-mono' || prefs.monoFont === 'ibm-plex-mono') {
    jobs.push(ensureEmbeddedMono(prefs.monoFont));
  }
  await Promise.all(jobs);
  try {
    await document.fonts.ready;
  } catch {
    /* swallow-ok: document.fonts.ready 等待失败时按已加载字体渲染 */
  }
}

/* ---------- prefs IO ---------- */

function normalizeChoice(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  return raw.trim();
}

export function normalizeFontPrefs(raw: unknown): FontPreferences {
  const base = { ...DEFAULT_FONT_PREFS };
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  base.uiFont = normalizeChoice(o.uiFont, base.uiFont) as UiFontChoice;
  base.monoFont = normalizeChoice(o.monoFont, base.monoFont) as MonoFontChoice;
  base.monoLigatures = Boolean(o.monoLigatures);
  base.v = 1;
  return base;
}

export function readStoredFonts(): FontPreferences {
  try {
    const direct = localStorage.getItem(FONTS_KEY);
    if (direct) return normalizeFontPrefs(JSON.parse(direct));
  } catch {
    /* swallow-ok: 字体设置 JSON 损坏时回退默认值 */
  }
  // 只读回退：兼容旧版 crish_settings JSON 中的 fonts 字段，不再有写入方更新此字段；
  // @deprecated 删除日期 2027-01-01
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = JSON.parse(raw) as { fonts?: unknown };
      if (parsed?.fonts) return normalizeFontPrefs(parsed.fonts);
    }
  } catch {
    /* swallow-ok: 旧版 settings 结构解析失败时跳过该来源 */
  }
  return { ...DEFAULT_FONT_PREFS };
}

export function persistFonts(prefs: FontPreferences): void {
  const p = normalizeFontPrefs(prefs);
  try {
    localStorage.setItem(FONTS_KEY, JSON.stringify(p));
  } catch {
    /* swallow-ok: quota 超限时字体偏好尽力写，失败回退默认 */
  }
}

/* ---------- apply ---------- */

export function applyFontStacks(prefs: FontPreferences, platform: PlatformId = detectPlatform()): void {
  const p = normalizeFontPrefs(prefs);
  const html = document.documentElement;
  const uiStack = resolveUiStack(p.uiFont, platform);
  const monoStack = resolveMonoStack(p.monoFont, platform);
  const lig = p.monoLigatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0';

  html.style.setProperty('--font-sans', uiStack);
  html.style.setProperty('--font-mono', monoStack);
  html.style.setProperty('--font-mono-features', lig);

  html.setAttribute('data-ui-font', p.uiFont.startsWith('local:') ? 'local' : p.uiFont);
  html.setAttribute('data-mono-font', p.monoFont.startsWith('local:') ? 'local' : p.monoFont);
  html.setAttribute('data-platform', platform);
  if (isLocalFontChoice(p.uiFont)) {
    html.setAttribute('data-ui-font-local', localFontFamily(p.uiFont));
  } else {
    html.removeAttribute('data-ui-font-local');
  }
  if (isLocalFontChoice(p.monoFont)) {
    html.setAttribute('data-mono-font-local', localFontFamily(p.monoFont));
  } else {
    html.removeAttribute('data-mono-font-local');
  }
}

/** 同步应用已存偏好（不异步加载内嵌文件；内嵌由 ensure 补） */
export function bootstrapFonts(): FontPreferences {
  const prefs = readStoredFonts();
  const platform = detectPlatform();
  applyFontStacks(prefs, platform);
  // 内嵌字体异步补载，不阻塞首屏
  void ensureFontsLoaded(prefs).then(() => {
    applyFontStacks(prefs, platform);
  });
  return prefs;
}

/** 设置页：应用 + 持久化 + 事件 */
export async function setFontPreferences(
  partial: Partial<FontPreferences>,
): Promise<FontPreferences> {
  const next = normalizeFontPrefs({ ...readStoredFonts(), ...partial });
  await ensureFontsLoaded(next);
  applyFontStacks(next);
  persistFonts(next);
  try {
    window.dispatchEvent(new CustomEvent('crish-fonts-changed', { detail: next }));
  } catch {
    /* swallow-ok: 字体变更事件分发失败不影响已应用样式 */
  }
  return next;
}

export function describeActiveUi(prefs: FontPreferences = readStoredFonts()): string {
  const plat = platformLabel();
  if (prefs.uiFont === 'auto') return `${plat} · 系统界面字体`;
  if (prefs.uiFont === 'system-ui') return 'system-ui';
  if (isLocalFontChoice(prefs.uiFont)) return `本机 · ${localFontFamily(prefs.uiFont)}`;
  const opt = uiFontOptions().find((o) => o.id === prefs.uiFont);
  return opt?.label || prefs.uiFont;
}

export function describeActiveMono(prefs: FontPreferences = readStoredFonts()): string {
  const plat = platformLabel();
  if (prefs.monoFont === 'auto') return `${plat} · 系统等宽字体`;
  if (prefs.monoFont === 'system-mono') return '系统等宽';
  if (isLocalFontChoice(prefs.monoFont)) return `本机 · ${localFontFamily(prefs.monoFont)}`;
  const opt = monoFontOptions().find((o) => o.id === prefs.monoFont);
  return opt?.label || prefs.monoFont;
}
