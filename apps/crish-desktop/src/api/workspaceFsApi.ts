/**
 * 工作区文件访问：优先 Tauri 命令，失败时给出可读错误。
 * 设计：按需打开的详细入口，不在运行时往右侧倾倒命令输出。
 */

import { getWorkspacePath } from './projectStore';
export { getWorkspacePath };
export { openPathDefault } from './hostOpenersApi';
import { invokeResult } from './tauriInvoke';

export type FsDirEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: string;
  path: string;
};

export type FsReadResult = {
  content: string;
  lineCount: number;
  truncated: boolean;
  path: string;
};

function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (i <= 0) return norm;
  return norm.slice(0, i) || norm;
}

function getFsRoot(): string {
  return getWorkspacePath() || '';
}

const WINDOWS_RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/;
const MAX_PATH_LENGTH = 4096;

/** Windows 盘符 / UNC / POSIX 绝对路径 */
export function isAbsoluteFsPath(path: string): boolean {
  const p = (path || '').trim();
  if (!p) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\') || p.startsWith('//')) return true;
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * 相对路径且已设置工作区时，拼到工作区下；绝对路径原样返回。
 * 用于 FilesCard 打开/列举及 readTextFile / listDirectory 等入口。
 */
export function resolveWorkspacePath(path: string): string {
  const p = (path || '').trim();
  if (!p) return p;
  // 拒绝 NUL 字节
  if (p.includes('\0')) return '';
  // 拒绝路径过长
  if (p.length > MAX_PATH_LENGTH) return '';
  // 拒绝 Unicode bidi 覆盖字符
  if (BIDI_OVERRIDE_RE.test(p)) return '';
  // 拒绝 Windows 保留设备名
  const lastSegment = p.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '';
  if (WINDOWS_RESERVED_NAME_RE.test(lastSegment)) return '';
  // 拒绝路径遍历 (.. 作为路径组件)
  const norm = p.replace(/\\/g, '/');
  if (/(^|\/)\.\.($|\/)/.test(norm)) return '';
  if (isAbsoluteFsPath(p)) {
    // 绝对路径必须在工作区根目录下（路径边界判定：根自身或「根 + /」前缀，
    // 防止根 c:/work 误放行 c:/workspace/x.txt 这类兄弟前缀目录，A6-H03）
    const root = getFsRoot().trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root) return '';
    const r = root.toLowerCase();
    const n = norm.toLowerCase();
    if (!(n === r || n.startsWith(r + '/'))) return '';
    return p;
  }
  const root = getFsRoot().trim();
  if (!root) return p;
  // 去掉前导 ./ 或 .\
  const rel = p.replace(/^\.[\\/]/, '');
  return joinPath(root, rel);
}

/** 传给 Tauri 的工作区根（绝对路径） */
function workspaceRootArg(): string | undefined {
  const root = getFsRoot().trim();
  return root || undefined;
}

export async function listDirectory(dirPath?: string): Promise<FsDirEntry[]> {
  const root = getFsRoot();
  const path = resolveWorkspacePath(dirPath || root);
  if (!path) throw new Error('未打开项目工作区，请先选择项目');

  const res = await invokeResult<{ items?: Array<Record<string, unknown>> }>('workbench_list_directory', {
    path,
    workspaceRoot: workspaceRootArg(),
  });

  if (res.status === 'ok' && res.data?.items) {
    return res.data.items.map((it) => ({
      name: String(it.name ?? ''),
      isDir: Boolean(it.isDir ?? it.is_dir),
      ...(typeof it.size === 'number' && { size: it.size }),
      ...(it.modified != null && { modified: String(it.modified) }),
      path: joinPath(path, String(it.name ?? '')),
    }));
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法浏览本地目录（需桌面壳）');
}

/** 首屏预览行数；长文件可再分段加载 */
export const FILE_PREVIEW_CHUNK_LINES = 400;
/** 后端硬上限对齐 fs_commands MAX_TEXT_FILE_LINES */
export const FILE_PREVIEW_MAX_LINES = 1000000;

/**
 * 下一段预览行预算（纯函数，供 UI 与单测共用）。
 * 返回 null 表示已达上限，不应再请求。
 */
export function nextFilePreviewLineBudget(
  currentBudget: number,
  chunk: number = FILE_PREVIEW_CHUNK_LINES,
  max: number = FILE_PREVIEW_MAX_LINES,
): number | null {
  const cur = Math.max(0, Math.floor(currentBudget));
  const step = Math.max(1, Math.floor(chunk));
  const cap = Math.max(1, Math.floor(max));
  if (cur >= cap) return null;
  return Math.min(cap, cur + step);
}

export async function readTextFile(
  filePath: string,
  maxLines = FILE_PREVIEW_CHUNK_LINES,
): Promise<FsReadResult> {
  if (!filePath) throw new Error('路径为空');
  const path = resolveWorkspacePath(filePath);
  const lines = Math.max(1, Math.min(FILE_PREVIEW_MAX_LINES, Math.floor(maxLines)));

  const res = await invokeResult<{
    content?: string;
    lineCount?: number;
    line_count?: number;
    truncated?: boolean;
  }>('workbench_read_file_content', {
    path,
    maxLines: lines,
    workspaceRoot: workspaceRootArg(),
  });

  if (res.status === 'ok' && typeof res.data?.content === 'string') {
    const lineCount =
      res.data.lineCount ??
      res.data.line_count ??
      res.data.content.split('\n').length;
    return {
      content: res.data.content,
      lineCount,
      truncated: Boolean(res.data.truncated),
      path,
    };
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法读取本地文件（需桌面壳）');
}

/**
 * 写入文件内容（T-EG-05：overwrite 语义与壳层命令 / 工具侧 write_file
 * 对齐——默认拒绝覆盖，已存在文件需显式传 overwrite=true 才放行；
 * 新建文件不受影响）。覆盖写入的调用方（如 applyFileDiff full_write）
 * 必须显式传 true，避免「写入被拒」回归。
 */
export async function writeTextFile(
  filePath: string,
  content: string,
  overwrite = false,
): Promise<void> {
  const path = resolveWorkspacePath(filePath);
  const res = await invokeResult('workbench_write_file_content', {
    path,
    content,
    overwrite,
    workspaceRoot: workspaceRootArg(),
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法写入文件（需桌面壳写权限）');
}

/** 资源 URL（图片 / PDF 内嵌预览） */
export async function toAssetUrl(filePath: string): Promise<string | null> {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) return filePath;
  const path = resolveWorkspacePath(filePath);
  try {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (mod && typeof (mod as { convertFileSrc?: (p: string) => string }).convertFileSrc === 'function') {
      return (mod as { convertFileSrc: (p: string) => string }).convertFileSrc(path);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 在系统资源管理器中显示 */
export async function revealInOs(filePath: string): Promise<void> {
  const res = await invokeResult('workbench_open_host_target', {
    openerId: 'system-file-manager',
    target: { type: 'path', path: filePath },
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('无法在系统资源管理器中打开（需桌面壳）');
}

export function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

export function pathDirname(p: string): string {
  return parentPath(p);
}

export function pathRelativeToRoot(full: string, root: string): string {
  if (!root || !full) return full;
  const f = full.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (f.toLowerCase().startsWith(r.toLowerCase())) {
    const rel = f.slice(r.length).replace(/^\//, '');
    return rel || '.';
  }
  return full;
}

export function detectFileKind(name: string): 'text' | 'image' | 'pdf' | 'table' | 'binary' {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(n)) return 'image';
  if (/\.pdf$/i.test(n)) return 'pdf';
  if (/\.(csv|tsv)$/i.test(n)) return 'table';
  if (
    /\.(txt|md|markdown|mdx|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|htm|xml|yml|yaml|toml|ini|env|py|rs|go|java|kt|c|cpp|h|hpp|cs|php|rb|sh|bash|zsh|ps1|bat|cmd|log|sql|graphql|vue|svelte|lock|gitignore|dockerignore|editorconfig|prettierrc|eslintrc|conf|cfg|properties|gradle|swift|m|mm|r|lua|vim|dart|scala|clj|ex|exs|erl|hs|ml|fs|fsx|nim|zig|v|sv|vhdl|asm|s|tex|rst|adoc|org)$/i.test(
      n,
    ) ||
    n === 'dockerfile' ||
    n === 'makefile' ||
    n === 'cmakelists.txt' ||
    n.startsWith('.')
  ) {
    return 'text';
  }
  return 'binary';
}

/** Markdown / MDX：可渲染预览 */
export function isMarkdownFilename(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name || '');
}

/** 简易 CSV / TSV → 行列（预览用） */
export function parseCsvPreview(text: string, maxRows = 80): string[][] {
  const lines = text.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l.trim());
  const rows: string[][] = [];
  for (const line of lines.slice(0, maxRows)) {
    if (line.includes('\t') && !line.includes(',')) {
      rows.push(line.split('\t').map((c) => c.trim()));
    } else {
      rows.push(splitCsvLine(line));
    }
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// ── 选区批注：下一条用户消息注入模型（非常驻评论区） ──
export type PendingFileAnnotation = {
  id: string;
  path: string;
  selectedText: string;
  text: string;
  createdAt: number;
};

let pendingAnnotations: PendingFileAnnotation[] = [];

export function addPendingFileAnnotation(input: {
  path: string;
  selectedText: string;
  text: string;
}): PendingFileAnnotation {
  const a: PendingFileAnnotation = {
    id: `ann-${Date.now().toString(36)}`,
    path: input.path,
    selectedText: input.selectedText.trim().slice(0, 2000),
    text: input.text.trim(),
    createdAt: Date.now(),
  };
  pendingAnnotations = [a, ...pendingAnnotations].slice(0, 20);
  try {
    window.dispatchEvent(new CustomEvent('crish-file-annotations-changed'));
  } catch {
    /* ignore */
  }
  return a;
}

export function countPendingFileAnnotations(): number {
  return pendingAnnotations.length;
}

/** 取出并清空待发送批注（发送用户消息时调用） */
export function takePendingFileAnnotations(): PendingFileAnnotation[] {
  const list = pendingAnnotations;
  pendingAnnotations = [];
  try {
    window.dispatchEvent(new CustomEvent('crish-file-annotations-changed'));
  } catch {
    /* ignore */
  }
  return list;
}

/** 格式化为注入模型的上下文块 */
export function formatAnnotationsForModel(list: PendingFileAnnotation[]): string {
  if (!list.length) return '';
  const parts = list.map((a, i) => {
    const path = a.path;
    const sel = a.selectedText.length > 800 ? `${a.selectedText.slice(0, 800)}…` : a.selectedText;
    return [
      `### 文件批注 ${i + 1}`,
      `路径: ${path}`,
      `选中内容:`,
      '```',
      sel,
      '```',
      `用户批注: ${a.text}`,
    ].join('\n');
  });
  return (
    `<file_annotations>\n以下批注来自用户在文件面板中对选区的标注，请优先参考。\n\n` +
    parts.join('\n\n') +
    `\n</file_annotations>`
  );
}

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
    /* plain */
  }
  // 像路径的单行
  if (!raw.includes('\n') && /[\\/]/.test(raw) && raw.length < 400) {
    return raw.replace(/^['"]|['"]$/g, '');
  }
  return null;
}
