/**
 * 双引擎本机字体全量扫描中枢
 * Engine A: Chromium / Tauri window.queryLocalFonts()
 * Engine B: Canvas 2D 差分交叉测宽降级（分片调度 yieldToMain）
 */

import { logger } from '../../../services/LoggerService';
import { sanitizeFontFamily } from './fontPinyinMatcher';
import { detectPlatform } from '../../../api/fontStoreStacks';
import {
  readFontScanCache,
  writeFontScanCache,
} from '../../../api/cache/runtimeCache';
export interface LocalFontEntry {
  family: string;
  fullName?: string;
  style?: string;
  postscriptName?: string;
}

export type FontScanEngine = 'queryLocalFonts' | 'canvas' | 'none';

export interface LocalFontScanResult {
  engine: FontScanEngine;
  fonts: LocalFontEntry[];
  totalCount: number;
  durationMs: number;
}

interface WindowWithLocalFonts extends Window {
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<
    Array<{
      family: string;
      fullName: string;
      postscriptName: string;
      style: string;
    }>
  >;
}

let memoryCache: LocalFontEntry[] | null = null;

/** 各平台精选扩展字体候选库（Canvas 降级引擎使用） */
export const EXTENDED_CURATED_FONTS = {
  windows: {
    ui: [
      'Segoe UI',
      'Segoe UI Variable Text',
      'Microsoft YaHei UI',
      'Microsoft YaHei',
      'HarmonyOS Sans SC',
      'PingFang SC',
      'Noto Sans SC',
      'Source Han Sans SC',
      'SimHei',
      'SimSun',
      'KaiTi',
      'FangSong',
      'Arial',
      'Calibri',
      'Verdana',
      'Tahoma',
    ],
    mono: [
      'Cascadia Mono',
      'Cascadia Code',
      'Consolas',
      'JetBrains Mono',
      'Fira Code',
      'Source Code Pro',
      'Courier New',
      'Lucida Console',
      'Maple Mono',
    ],
  },
  macos: {
    ui: [
      'PingFang SC',
      'Hiragino Sans GB',
      'SF Pro Text',
      'Helvetica Neue',
      'Arial',
      'Songti SC',
      'Kaiti SC',
      'Yuanti SC',
      'Heiti SC',
      'Noto Sans SC',
      'Source Han Sans SC',
    ],
    mono: [
      'SF Mono',
      'Menlo',
      'Monaco',
      'JetBrains Mono',
      'Fira Code',
      'Courier New',
      'Source Code Pro',
    ],
  },
  linux: {
    ui: [
      'Noto Sans CJK SC',
      'Noto Sans SC',
      'Noto Sans',
      'Ubuntu',
      'DejaVu Sans',
      'WenQuanYi Micro Hei',
      'Source Han Sans SC',
      'Liberation Sans',
      'Cantarell',
      'Arial',
    ],
    mono: [
      'DejaVu Sans Mono',
      'Noto Sans Mono',
      'Liberation Mono',
      'Ubuntu Mono',
      'Fira Code',
      'JetBrains Mono',
      'Courier New',
    ],
  },
};

/** 让出主线程切片，避免长任务阻塞渲染 */
export function yieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 嗅探 window.queryLocalFonts 权限与支持状态 */
export async function canQueryLocalFonts(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const win = window as WindowWithLocalFonts;
  if (typeof win.queryLocalFonts !== 'function') return false;

  try {
    if (
      navigator.permissions &&
      typeof navigator.permissions.query === 'function'
    ) {
      const status = await navigator.permissions.query({
        name: 'local-fonts' as PermissionName,
      });
      if (status.state === 'denied') return false;
    }
    return true;
  } catch {
    // 若浏览器不支持 query local-fonts 权限，允许继续向下尝试
    return true;
  }
}

/** 引擎 A: 安全调用 Chromium / Tauri window.queryLocalFonts */
export async function scanViaQueryLocalFontsSafe(
  timeoutMs = 3000
): Promise<LocalFontEntry[]> {
  const supported = await canQueryLocalFonts();
  if (!supported) {
    throw new Error('Local fonts permission denied or unsupported');
  }

  const win = window as WindowWithLocalFonts;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error('queryLocalFonts timeout')),
      timeoutMs
    );
  });

  let rawFonts: LocalFontEntry[];
  try {
    rawFonts = await Promise.race([win.queryLocalFonts!(), timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }

  if (!Array.isArray(rawFonts) || rawFonts.length === 0) {
    throw new Error('queryLocalFonts returned empty font catalog');
  }

  const fontMap = new Map<string, LocalFontEntry>();
  for (const f of rawFonts) {
    const clean = sanitizeFontFamily(f.family);
    if (!clean || clean.startsWith('-') || clean.startsWith('.')) continue;

    const lower = clean.toLowerCase();
    if (!fontMap.has(lower)) {
      fontMap.set(lower, {
        family: clean,
        fullName: f.fullName,
        postscriptName: f.postscriptName,
        style: f.style,
      });
    }
  }

  return Array.from(fontMap.values()).sort((a, b) =>
    a.family.localeCompare(b.family, 'zh-Hans-CN', { sensitivity: 'accent' })
  );
}

/** 双基准 Canvas 差分测宽判定 */
export function isFontInstalledMultiBase(
  family: string,
  ctx: CanvasRenderingContext2D
): boolean {
  const testStr = 'mmmmmmmmmmlli@Ww10';
  const testSize = '72px';
  const cleanFam = `'${family.replace(/'/g, '')}'`;

  // 基准 1: monospace
  ctx.font = `${testSize} monospace`;
  const monoBase = ctx.measureText(testStr).width;
  ctx.font = `${testSize} ${cleanFam}, monospace`;
  const monoTarget = ctx.measureText(testStr).width;

  // 基准 2: sans-serif
  ctx.font = `${testSize} sans-serif`;
  const sansBase = ctx.measureText(testStr).width;
  ctx.font = `${testSize} ${cleanFam}, sans-serif`;
  const sansTarget = ctx.measureText(testStr).width;

  // 任意基准偏离超过 0.2px 即判定安装
  return (
    Math.abs(monoTarget - monoBase) > 0.2 ||
    Math.abs(sansTarget - sansBase) > 0.2
  );
}

/** 引擎 B: 分片调度 Canvas 2D 差分测宽 */
export async function scanViaCanvasChunked(
  candidates?: string[],
  chunkSize = 25
): Promise<LocalFontEntry[]> {
  if (typeof document === 'undefined') return [];

  const platform = detectPlatform();
  let candidateList = candidates;
  if (!candidateList || candidateList.length === 0) {
    const pKey =
      platform === 'macos' || platform === 'ios'
        ? 'macos'
        : platform === 'linux'
          ? 'linux'
          : 'windows';
    const cfg = EXTENDED_CURATED_FONTS[pKey] || EXTENDED_CURATED_FONTS.windows;
    candidateList = [...new Set([...cfg.ui, ...cfg.mono])];
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return [];

  const fontMap = new Map<string, LocalFontEntry>();

  for (let i = 0; i < candidateList.length; i += chunkSize) {
    const chunk = candidateList.slice(i, i + chunkSize);
    for (const fam of chunk) {
      const clean = sanitizeFontFamily(fam);
      if (!clean) continue;
      if (isFontInstalledMultiBase(clean, ctx)) {
        fontMap.set(clean.toLowerCase(), { family: clean });
      }
    }
    // 让出主线程切片，确保 UI 保持响应
    await yieldToMain();
  }

  return Array.from(fontMap.values()).sort((a, b) =>
    a.family.localeCompare(b.family, 'zh-Hans-CN', { sensitivity: 'accent' })
  );
}

/** 读取 LocalStorage 瘦身缓存 */
function readStorageCacheLean(): LocalFontEntry[] | null {
  return readFontScanCache();
}

/** 写入 LocalStorage 瘦身缓存（纯字符串数组，防 Quota 超限） */
function writeStorageCacheLean(fonts: LocalFontEntry[]): void {
  writeFontScanCache(fonts);
}

/** 清理内存缓存（测试或重置使用） */
export function clearMemoryFontCache(): void {
  memoryCache = null;
}

/** 双引擎统一扫描入口（带双级缓存与自适应降级） */
export async function scanSystemFonts(
  forceRefresh = false
): Promise<LocalFontScanResult> {
  const startTime =
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!forceRefresh) {
    if (memoryCache && memoryCache.length > 0) {
      return {
        engine: 'none',
        fonts: memoryCache,
        totalCount: memoryCache.length,
        durationMs: 0,
      };
    }

    const diskCached = readStorageCacheLean();
    if (diskCached && diskCached.length > 0) {
      memoryCache = diskCached;
      return {
        engine: 'none',
        fonts: diskCached,
        totalCount: diskCached.length,
        durationMs: 0,
      };
    }
  }

  let engine: FontScanEngine = 'queryLocalFonts';
  let fonts: LocalFontEntry[] = [];

  try {
    fonts = await scanViaQueryLocalFontsSafe();
    logger.info(
      `[fontStoreScan] scanned ${fonts.length} fonts via queryLocalFonts`
    );
  } catch (err) {
    logger.warn(
      '[fontStoreScan] queryLocalFonts unavailable or failed, falling back to Canvas',
      {
        err: { message: String(err) },
      }
    );
    engine = 'canvas';
    fonts = await scanViaCanvasChunked();
  }

  memoryCache = fonts;
  writeStorageCacheLean(fonts);

  const durationMs = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
      startTime
  );

  return {
    engine,
    fonts,
    totalCount: fonts.length,
    durationMs,
  };
}
