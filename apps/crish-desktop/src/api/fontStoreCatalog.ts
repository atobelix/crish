/**
 * fontStore 字体目录 + 本机探测 + 内嵌加载子模块（从 fontStore.ts 拆出，降低 hub 行数）。
 *
 * 职责：
 *   - catalog：UI/等宽字体选项元数据（设置页下拉用）
 *   - local fonts：canvas 探测本机字体安装情况 + 精选字体列表
 *   - embedded：内嵌 OFL 字体动态 import + 加载守卫
 *
 * 纯函数 + 自包含状态（loadedEmbedded Set）；类型从 hub 仅做 type-only 引用，无运行时循环依赖。
 */

import { logger } from '../services/LoggerService';
import type {
  PlatformId,
  EmbeddedUiFontId,
  EmbeddedMonoFontId,
  FontOptionMeta,
  LocalFontEntry,
} from './fontStore';
import { detectPlatform, platformLabel } from './fontStoreStacks';

/* ---------- catalog (settings UI) ---------- */

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

const loadedEmbedded = new Set<string>();

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

export async function ensureFontsLoaded(
  prefs: import('./fontStore').FontPreferences,
): Promise<void> {
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
