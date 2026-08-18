/**
 * fontStore 平台探测 + 字体栈子模块（从 fontStore.ts 拆出，降低 hub 行数）。
 *
 * 职责：平台识别、中英文统一 UI/等宽字体栈解析、local: 选择工具函数。
 * 纯函数，无 IO；类型从 hub 仅做 type-only 引用，无运行时循环依赖。
 */

import type { PlatformId, UiFontChoice, MonoFontChoice } from './fontStore';

/* ---------- platform ---------- */

export function detectPlatform(): PlatformId {
  try {
    const ua = navigator.userAgent || '';
    const p = navigator.platform || '';
    if (/HarmonyOS|OpenHarmony/i.test(ua)) return 'harmony';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Mac/i.test(p) || /Macintosh/i.test(ua)) return 'macos';
    if (/Win/i.test(p) || /Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(p) || /Linux/i.test(ua)) return 'linux';
  } catch {
    /* swallow-ok: UA 探测失败时按默认字体族降级 */
  }
  return 'unknown';
}

export function platformLabel(p: PlatformId = detectPlatform()): string {
  const map: Record<PlatformId, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android',
    harmony: '鸿蒙',
    unknown: '当前系统',
  };
  return map[p] || map.unknown;
}

/* ---------- stacks ---------- */

/**
 * 中英文统一：优先使用同一套「含 CJK 字形」的 UI 字体作为主族，
 * 避免 Inter/Segoe 只覆盖西文、中文再 fallback 到另一字体造成缝合感。
 * 西文回退仅作该平台缺字时的兜底。
 */
const CJK_UI =
  "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'HarmonyOS Sans SC'";

function platformUiStack(platform: PlatformId): string {
  switch (platform) {
    case 'windows':
      // 微软雅黑 UI 同时承担中/英文，避免 Segoe + YaHei 混排字重不一致
      return `'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, 'Segoe UI', 'Segoe UI Variable Text', ${CJK_UI}, sans-serif`;
    case 'macos':
      return `'PingFang SC', 'Hiragino Sans GB', -apple-system, BlinkMacSystemFont, 'SF Pro Text', ${CJK_UI}, sans-serif`;
    case 'ios':
      return `'PingFang SC', -apple-system, 'SF Pro Text', ${CJK_UI}, sans-serif`;
    case 'linux':
      return `'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans', system-ui, 'Ubuntu', 'DejaVu Sans', ${CJK_UI}, sans-serif`;
    case 'android':
      return `'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans', 'Roboto', ${CJK_UI}, sans-serif`;
    case 'harmony':
      return `'HarmonyOS Sans SC', 'HarmonyOS Sans', 'Noto Sans SC', 'Noto Sans', ${CJK_UI}, sans-serif`;
    default:
      return `${CJK_UI}, system-ui, -apple-system, 'Segoe UI', sans-serif`;
  }
}

function platformMonoStack(platform: PlatformId): string {
  switch (platform) {
    case 'windows':
      return `'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Segoe UI Mono', 'Courier New', ui-monospace, monospace`;
    case 'macos':
    case 'ios':
      return `'SF Mono', Menlo, Monaco, 'Courier New', ui-monospace, monospace`;
    case 'linux':
      return `'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Courier New', ui-monospace, monospace`;
    case 'android':
    case 'harmony':
      return `'Droid Sans Mono', 'Noto Sans Mono', 'Courier New', ui-monospace, monospace`;
    default:
      return `ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, monospace`;
  }
}

function quoteFamily(name: string): string {
  const t = name.trim();
  if (!t) return '';
  if (/^[-a-zA-Z0-9]+$/.test(t)) return t;
  return `'${t.replace(/'/g, "\\'")}'`;
}

export function isLocalFontChoice(id: string): id is `local:${string}` {
  return id.startsWith('local:') && id.length > 6;
}

export function localFontFamily(id: string): string {
  if (!isLocalFontChoice(id)) return '';
  return id.slice(6).trim();
}

export function toLocalChoice(family: string): `local:${string}` {
  return `local:${family.trim()}`;
}

export function resolveUiStack(choice: UiFontChoice, platform: PlatformId = detectPlatform()): string {
  if (choice === 'auto') return platformUiStack(platform);
  if (choice === 'system-ui') {
    // 仍以 CJK UI 为主，system-ui 仅作回退
    return `${CJK_UI}, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  }
  if (choice === 'inter') return `'Inter', ${platformUiStack(platform)}`;
  if (choice === 'ibm-plex-sans') return `'IBM Plex Sans', ${platformUiStack(platform)}`;
  if (isLocalFontChoice(choice)) {
    const fam = quoteFamily(localFontFamily(choice));
    return fam ? `${fam}, ${platformUiStack(platform)}` : platformUiStack(platform);
  }
  return platformUiStack(platform);
}

export function resolveMonoStack(
  choice: MonoFontChoice,
  platform: PlatformId = detectPlatform(),
): string {
  if (choice === 'auto') return platformMonoStack(platform);
  if (choice === 'system-mono') return platformMonoStack(platform);
  if (choice === 'jetbrains-mono') return `'JetBrains Mono', ${platformMonoStack(platform)}`;
  if (choice === 'ibm-plex-mono') return `'IBM Plex Mono', ${platformMonoStack(platform)}`;
  if (isLocalFontChoice(choice)) {
    const fam = quoteFamily(localFontFamily(choice));
    return fam ? `${fam}, ${platformMonoStack(platform)}` : platformMonoStack(platform);
  }
  return platformMonoStack(platform);
}
