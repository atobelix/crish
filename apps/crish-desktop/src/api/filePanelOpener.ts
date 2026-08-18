/**
 * 文件面板打开器 + 工具参数路径抽取。
 *
 * 从 workspaceFsApi 拆分而来；承载 registerFileViewerOpener / openFileInPanel
 * / takePendingOpenPath 模块内可变状态，以及 extractFilePathFromToolArgs 纯函数。
 * workspaceFsApi hub 经 re-export 保持对外契约不变。
 */

import { resolveWorkspacePath } from './workspaceFsApi';

/** 面板尚未挂载时暂存待打开路径 */
let pendingOpenPath: string | null = null;

export function takePendingOpenPath(): string | null {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
}

let fileViewerOpener: ((filePath: string, mode?: 'plain' | 'diff') => void) | null = null;

export function registerFileViewerOpener(opener: typeof fileViewerOpener): void {
  fileViewerOpener = opener;
}

/**
 * 打开右侧文件面板并定位到路径。
 * 由对话工具行等入口调用；FilesCard 未挂载时先缓存路径。
 * 相对路径会接到当前工作区根下。
 */
export function openFileInPanel(filePath: string, mode?: 'plain' | 'diff'): void {
  if (!filePath?.trim()) return;
  const path = resolveWorkspacePath(filePath.trim());
  if (fileViewerOpener) {
    fileViewerOpener(path, mode);
  } else {
    pendingOpenPath = path;
    window.dispatchEvent(new CustomEvent('crish-open-file', { detail: { path } }));
  }
}

/** 从工具参数中尽量抽出文件路径（相对或绝对） */
export function extractFilePathFromToolArgs(args: string): string | null {
  if (!args?.trim()) return null;
  const raw = args.trim();
  try {
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const inner =
        parsed.parameters && typeof parsed.parameters === 'object'
          ? (parsed.parameters as Record<string, unknown>)
          : parsed.input && typeof parsed.input === 'object'
            ? (parsed.input as Record<string, unknown>)
            : parsed;
      for (const key of [
        'path',
        'filePath',
        'file_path',
        'target_file',
        'targetFile',
        'filename',
        'file',
      ]) {
        const v = inner[key];
        if (typeof v === 'string' && v.trim() && !v.includes('\n') && v.length < 512) {
          return v.trim();
        }
      }
    }
  } catch {
    /* swallow-ok: JSON 参数解析失败时按原串路径兜底 */
  }
  // 像路径的单行
  if (!raw.includes('\n') && /[\\/]/.test(raw) && raw.length < 400) {
    return raw.replace(/^['"]|['"]$/g, '');
  }
  return null;
}
