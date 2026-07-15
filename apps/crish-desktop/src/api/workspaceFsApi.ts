/**
 * 工作区文件访问：优先 Tauri 命令，失败时给出可读错误。
 * 设计：按需打开的详细入口，不在运行时往右侧倾倒命令输出。
 */

import { getWorkspacePath } from './projectStore';

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

type InvokeResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing' }
  | { status: 'error'; message: string };

function formatInvokeError(err: unknown): string {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return `${o.message} (${o.code})`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

async function invokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  try {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (!mod?.invoke) return { status: 'missing' };
    const data = (await mod.invoke(cmd, args)) as T;
    return { status: 'ok', data };
  } catch (err) {
    // 命令未注册时通常也是 reject；区分 missing 与业务错误靠文案
    const msg = formatInvokeError(err);
    if (/not allowed|command .* not found|unknown command|not implemented/i.test(msg)) {
      return { status: 'missing' };
    }
    return { status: 'error', message: msg };
  }
}

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

export function getFsRoot(): string {
  return getWorkspacePath() || '';
}

/** 传给 Tauri 的工作区根（绝对路径） */
function workspaceRootArg(): string | undefined {
  const root = getFsRoot().trim();
  return root || undefined;
}

export async function listDirectory(dirPath?: string): Promise<FsDirEntry[]> {
  const root = getFsRoot();
  const path = dirPath || root;
  if (!path) throw new Error('未打开项目工作区，请先选择项目');

  const res = await invokeCmd<{ items?: Array<Record<string, unknown>> }>('list_directory', {
    path,
    workspaceRoot: workspaceRootArg(),
  });

  if (res.status === 'ok' && res.data?.items) {
    return res.data.items.map((it) => ({
      name: String(it.name ?? ''),
      isDir: Boolean(it.isDir ?? it.is_dir),
      size: typeof it.size === 'number' ? it.size : undefined,
      modified: it.modified != null ? String(it.modified) : undefined,
      path: joinPath(path, String(it.name ?? '')),
    }));
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法浏览本地目录（需桌面壳）');
}

export async function readTextFile(
  filePath: string,
  maxLines = 4000,
): Promise<FsReadResult> {
  if (!filePath) throw new Error('路径为空');

  const res = await invokeCmd<{
    content?: string;
    lineCount?: number;
    line_count?: number;
    truncated?: boolean;
  }>('read_file_content', {
    path: filePath,
    maxLines,
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
      path: filePath,
    };
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法读取本地文件（需桌面壳）');
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  const res = await invokeCmd('write_file_content', {
    path: filePath,
    content,
    workspaceRoot: workspaceRootArg(),
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法写入文件（需桌面壳写权限）');
}

/** 资源 URL（图片 / PDF 内嵌预览） */
export async function toAssetUrl(filePath: string): Promise<string | null> {
  try {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (mod && typeof (mod as { convertFileSrc?: (p: string) => string }).convertFileSrc === 'function') {
      return (mod as { convertFileSrc: (p: string) => string }).convertFileSrc(filePath);
    }
  } catch {
    /* ignore */
  }
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) return filePath;
  return null;
}

/** 在系统资源管理器中显示 */
export async function revealInOs(filePath: string): Promise<void> {
  const res = await invokeCmd('workbench_open_host_target', {
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
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(n)) return 'image';
  if (/\.pdf$/i.test(n)) return 'pdf';
  if (/\.(csv|tsv)$/i.test(n)) return 'table';
  if (
    /\.(txt|md|markdown|json|jsonc|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|htm|xml|yml|yaml|toml|ini|env|py|rs|go|java|kt|c|cpp|h|hpp|cs|php|rb|sh|bash|zsh|ps1|bat|cmd|log|sql|graphql|vue|svelte|lock|gitignore|dockerignore|editorconfig|prettierrc|eslintrc|conf|cfg|properties|gradle|swift|m|mm)$/i.test(
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

// ── 文件评论（本地持久化） ──
const COMMENT_KEY = 'crish_file_comments_v1';

export type FileComment = {
  id: string;
  path: string;
  text: string;
  createdAt: number;
  line?: number;
};

export function listFileComments(filePath: string): FileComment[] {
  try {
    const all = JSON.parse(localStorage.getItem(COMMENT_KEY) || '{}') as Record<
      string,
      FileComment[]
    >;
    return all[filePath] || [];
  } catch {
    return [];
  }
}

export function addFileComment(filePath: string, text: string, line?: number): FileComment {
  const c: FileComment = {
    id: `c-${Date.now().toString(36)}`,
    path: filePath,
    text: text.trim(),
    createdAt: Date.now(),
    line,
  };
  try {
    const all = JSON.parse(localStorage.getItem(COMMENT_KEY) || '{}') as Record<
      string,
      FileComment[]
    >;
    const list = all[filePath] || [];
    list.unshift(c);
    all[filePath] = list.slice(0, 100);
    localStorage.setItem(COMMENT_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return c;
}

export function removeFileComment(filePath: string, id: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(COMMENT_KEY) || '{}') as Record<
      string,
      FileComment[]
    >;
    all[filePath] = (all[filePath] || []).filter((c) => c.id !== id);
    localStorage.setItem(COMMENT_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** 面板尚未挂载时暂存待打开路径 */
let pendingOpenPath: string | null = null;

export function takePendingOpenPath(): string | null {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
}

/**
 * 打开右侧文件面板并定位到路径。
 * 由对话工具行等入口调用；FilesCard 未挂载时先缓存路径。
 */
export function openFileInPanel(filePath: string): void {
  if (!filePath?.trim()) return;
  const path = filePath.trim();
  pendingOpenPath = path;
  window.dispatchEvent(new CustomEvent('crish-open-file', { detail: { path } }));
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
