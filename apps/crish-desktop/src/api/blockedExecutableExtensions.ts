/**
 * 可执行后缀拦截 SSOT（SYSTEMATIC-FIX-PLAN §4.3）
 *
 * 前后端必须共用同一扩展名集合：本文件为前端唯一真源；
 * Rust `host_openers/execute.rs` 的 BLOCKED_EXECUTABLE_EXTENSIONS 必须与此列表一致；
 * `scripts/check-blocked-executable-ssot.mjs` 做静态对齐门禁。
 *
 * 命中即禁止「系统默认关联打开 / 聊天路径直开」，防止可执行文件被一键拉起。
 */

/** 不含点的小写扩展名（权威列表，排序稳定便于门禁 diff） */
export const BLOCKED_EXECUTABLE_EXTENSIONS = [
  'exe',
  'bat',
  'cmd',
  'msi',
  'ps1',
  'vbs',
  'com',
  'sh',
  'bin',
  // Windows 可执行变体（E1：scr/pif/hta/jse/vbe/wsf/wsh/msc/jar 等，
  // 与 Rust `host_openers/execute.rs` BLOCKED_EXECUTABLE_EXTENSIONS 同步）
  'scr',
  'pif',
  'hta',
  'jse',
  'vbe',
  'wsf',
  'wsh',
  'msc',
  'jar',
  // 2026-10 Markdown 2.0：Windows 高危载体补齐
  'lnk',
  'reg',
  'url',
  'cpl',
  'msix',
  'appx',
  'docm',
  'xlsm',
  'pptm',
  'xll',
  'xlam',
  'inf',
  'scf',
  'settingcontent-ms',
  'appref-ms',
] as const;

export type BlockedExecutableExtension =
  (typeof BLOCKED_EXECUTABLE_EXTENSIONS)[number];

const BLOCKED_SET = new Set<string>(BLOCKED_EXECUTABLE_EXTENSIONS);

/** 从路径取扩展名（小写、无点）；无扩展名返回 '' */
export function extensionOfPath(filePath: string): string {
  const base = filePath.replace(/^.*[\\/]/, '');
  const cleaned = base.replace(/:\d+(:\d+)?$/, '');
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0 || dot === cleaned.length - 1) return '';
  return cleaned.slice(dot + 1).toLowerCase();
}

/** 是否为受拦截的可执行后缀路径 */
export function isBlockedExecutablePath(filePath: string): boolean {
  const ext = extensionOfPath(filePath);
  return Boolean(ext) && BLOCKED_SET.has(ext);
}
