/**
 * 字体体系：按平台自动栈 + 内嵌免费字体 + 本机字体。
 * 冷启动同步应用，由 preferencesClient 权威管理。
 */

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

// 字体目录 + 本机探测 + 内嵌加载子模块（拆分自本文件，hub re-export 保持外部 import 路径不变）
export {
  uiFontOptions,
  monoFontOptions,
  curatedLocalFonts,
  isFontInstalled,
  listLocalFonts,
  ensureFontsLoaded,
} from './fontStoreCatalog';
export { scanSystemFonts } from './fontStoreScan';
import { ensureFontsLoaded, uiFontOptions, monoFontOptions } from './fontStoreCatalog';
import { preferencesClient } from './preferences/preferencesClient';

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

export interface FontOptionMeta {
  id: string;
  label: string;
  kind: 'auto' | 'system' | 'embedded' | 'local';
  /** 预览用 family */
  previewFamily?: string;
  desc?: string;
}

export type LocalFontEntry = { family: string; fullName?: string; style?: string };

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

let cachedFonts: FontPreferences = { ...DEFAULT_FONT_PREFS };

export function readStoredFonts(): FontPreferences {
  return cachedFonts;
}

export async function loadStoredFonts(): Promise<FontPreferences> {
  try {
    const direct = await preferencesClient.getPreference('fonts');
    if (direct) {
      cachedFonts = normalizeFontPrefs(direct);
    }
  } catch {
    /* swallow-ok: 偏好读取失败时使用当前缓存或默认值 */
  }
  return cachedFonts;
}

export function persistFonts(prefs: FontPreferences): void {
  const p = normalizeFontPrefs(prefs);
  cachedFonts = p;
  void preferencesClient.setPreference('fonts', p).catch(() => {
    /* swallow-ok: 偏好写入失败保持内存态 */
  });
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
  html.style.setProperty('--md-font-family', uiStack);
  html.style.setProperty('--md-font-sans', uiStack);
  html.style.setProperty('--md-text-font', uiStack);
  html.style.setProperty('--md-font-mono', monoStack);
  html.style.setProperty('--md-code-font', monoStack);
  html.style.setProperty('--sep-font-sans', uiStack);
  html.style.setProperty('--sep-font-mono', monoStack);

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
  // 偏好异步回灌与内嵌字体异步补载，不阻塞首屏
  void loadStoredFonts().then((loaded) => {
    applyFontStacks(loaded, platform);
    void ensureFontsLoaded(loaded).then(() => {
      applyFontStacks(loaded, platform);
    });
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
