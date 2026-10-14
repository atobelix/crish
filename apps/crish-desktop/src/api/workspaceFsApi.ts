/**
 * 工作区文件访问：优先 Tauri 命令，失败时给出可读错误。
 * 设计：按需打开的详细入口，不在运行时往右侧倾倒命令输出。
 */

import { getWorkspacePath } from './projectStore';
export { getWorkspacePath };
export { openPathDefault } from './hostOpenersApi';
import { invokeResult } from './tauriInvoke';
import { countTextLines } from './countTextLines';
import {
  assertWorkspacePath,
  getWorkspaceRoot,
  joinWorkspaceRootPath,
  resolveReadableFilePath,
  resolveWorkspacePath,
} from './workspacePathResolver';
export {
  assertWorkspacePath,
  isAbsoluteFsPath,
  isInsideWorkspace,
  resolveReadableFilePath,
  resolveWorkspacePath,
  type ResolvedPath,
} from './workspacePathResolver';

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

function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (i <= 0) return norm;
  return norm.slice(0, i) || norm;
}

export async function listDirectory(dirPath?: string): Promise<FsDirEntry[]> {
  const root = getWorkspaceRoot();
  const path = resolveWorkspacePath(dirPath || root);
  if (!path) throw new Error('未打开项目工作区，请先选择项目');

  const res = await invokeResult<{ items?: Array<Record<string, unknown>> }>(
    'workbench_list_directory',
    { path }
  );

  if (res.status === 'ok' && res.data?.items) {
    return res.data.items.map((it) => ({
      name: String(it.name ?? ''),
      isDir: Boolean(it.isDir ?? it.is_dir),
      ...(typeof it.size === 'number' && { size: it.size }),
      ...(it.modified != null && { modified: String(it.modified) }),
      path: joinWorkspaceRootPath(path, String(it.name ?? '')),
    }));
  }
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法浏览本地目录（需桌面壳）');
}

/** 首屏预览行数；长文件可再分段加载 */
export const FILE_PREVIEW_CHUNK_LINES = 400;
/** 后端硬上限对齐 fs_commands 安全最大行数 */
export const FILE_PREVIEW_MAX_LINES = 20000;
/** 虚拟化代码与文档预览全量预算（解除 400 行截断手铐，直连虚拟 DOM） */
export const FILE_PREVIEW_CODE_BUDGET = FILE_PREVIEW_MAX_LINES;

/**
 * 下一段预览行预算（纯函数，供 UI 与单测共用）。
 * 返回 null 表示已达上限，不应再请求。
 */
export function nextFilePreviewLineBudget(
  currentBudget: number,
  chunk: number = FILE_PREVIEW_CHUNK_LINES,
  max: number = FILE_PREVIEW_MAX_LINES
): number | null {
  const cur = Math.max(0, Math.floor(currentBudget));
  const step = Math.max(1, Math.floor(chunk));
  const cap = Math.max(1, Math.floor(max));
  if (cur >= cap) return null;
  return Math.min(cap, cur + step);
}

export async function readTextFile(
  filePath: string,
  maxLines = FILE_PREVIEW_CHUNK_LINES
): Promise<FsReadResult> {
  const path = resolveReadableFilePath(filePath);
  if (!path) throw new Error(`无效或不合法的文件路径: ${filePath}`);
  const lines = Math.max(
    1,
    Math.min(FILE_PREVIEW_MAX_LINES, Math.floor(maxLines))
  );

  const res = await invokeResult<{
    content?: string;
    lineCount?: number;
    line_count?: number;
    truncated?: boolean;
  }>('workbench_read_file_content', {
    path,
    maxLines: lines,
  });

  if (res.status === 'ok' && typeof res.data?.content === 'string') {
    const lineCount =
      res.data.lineCount ??
      res.data.line_count ??
      countTextLines(res.data.content);
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
  overwrite = false
): Promise<void> {
  if (!filePath) throw new Error('路径为空');
  const path = assertWorkspacePath(filePath);
  const res = await invokeResult('workbench_write_file_content', {
    path,
    content,
    overwrite,
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('当前环境无法写入文件（需桌面壳写权限）');
}

/** 资源 URL（图片 / PDF 内嵌预览） */
export async function toAssetUrl(filePath: string): Promise<string | null> {
  if (!filePath) throw new Error('路径为空');
  if (filePath.startsWith('http://') || filePath.startsWith('https://'))
    return filePath;
  const path = resolveReadableFilePath(filePath);
  if (!path) throw new Error(`路径越界或不合法：${filePath}`);
  try {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (
      mod &&
      typeof (mod as { convertFileSrc?: (p: string) => string })
        .convertFileSrc === 'function'
    ) {
      return (mod as { convertFileSrc: (p: string) => string }).convertFileSrc(
        path
      );
    }
  } catch {
    /* swallow-ok: 浏览器/dev 环境无 convertFileSrc 时回退 null（调用方走原始路径） */
  }
  return null;
}

/** 在系统资源管理器中显示 */
export async function revealInOs(filePath: string): Promise<void> {
  const path = resolveReadableFilePath(filePath);
  if (!path) throw new Error('路径为空或不合法');
  try {
    const { openPathDefault } = await import('./hostOpenersApi');
    const target = path.includes('.') ? pathDirname(path) : path;
    await openPathDefault(target || path);
    return;
  } catch {
    /* fallback to workbench_open_host_target */
  }
  const res = await invokeResult('workbench_open_host_target', {
    openerId: 'system-file-manager',
    target: { type: 'path', path },
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('无法在系统资源管理器中打开（需桌面壳）');
}

export {
  pathBasename,
  detectFileKind,
  isMarkdownFilename,
} from './workspaceFileKinds';

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

/**
 * 跨平台文件系统路径规范化纯函数（SSOT 核心算法）：
 * 1. 空值与空白防御：输入为 null/undefined/空串/纯空格时，恒定返回 ''；
 * 2. 分隔符统一：将所有 Windows 反斜杠 '\' 统一转换为标准正斜杠 '/'；
 * 3. UNC 路径保护与连续斜杠压缩：
 *    - 若路径以 '//' 开头且不以 '///' 开头，识别为 UNC 路径，保留前导 '//'，后续连续重复斜杠压缩为单斜杠；
 *    - 其它非 UNC 路径，所有连续重复斜杠统一压缩为单斜杠 '/'；
 * 4. 栈代数消解冗余点号段与相对父级段（/./ 与 /../ 杜绝目录穿越）：
 *    - 对绝对路径前缀（Windows 盘符根、UNC 根、POSIX 根）建立防逃逸边界，.. 到顶后不越界回退；
 * 5. Windows 驱动器盘符标准化（严格遵从 HB-16 与 00-master-plan 铁律）：
 *    - 若路径匹配 '^[a-zA-Z]:(\/|$)'，强制将驱动器盘符转换为小写（如 'C:' -> 'c:/', 'C:/' -> 'c:/', 'D:\repo' -> 'd:/repo'）；
 * 6. 消除非根路径末尾多余斜杠：
 *    - 根路径（'/'、'//'、'^[a-z]:\/$'）保留其末尾斜杠；其余非根路径一律剔除末尾多余正斜杠 '/'；
 * 7. 严格幂等性：恒满足 toCanonicalFsPath(toCanonicalFsPath(p)) === toCanonicalFsPath(p)。
 */
export function toCanonicalFsPath(path: string): string {
  const p = (path || '').trim();
  if (!p) return '';

  // 1. 统一正反斜杠为 '/'
  let norm = p.replace(/\\/g, '/');

  // 2. 识别 UNC 路径并压缩重复斜杠
  const isUnc = norm.startsWith('//') && !norm.startsWith('///');
  if (isUnc) {
    norm = '//' + norm.slice(2).replace(/\/+/g, '/');
  } else {
    norm = norm.replace(/\/+/g, '/');
  }

  // 3. 提取前缀并进行相对段栈解析消解（/./ 与 /../ 杜绝目录穿越）
  const isAbsolutePosix = norm.startsWith('/') && !isUnc;
  const isWindowsDrive = /^[a-zA-Z]:(\/|$)/.test(norm);

  let prefix = '';
  let pathBody = norm;

  if (isUnc) {
    prefix = '//';
    pathBody = norm.slice(2);
  } else if (isWindowsDrive) {
    const colonIdx = norm.indexOf(':');
    const drive = norm.slice(0, colonIdx).toLowerCase();
    prefix = `${drive}:/`;
    pathBody = norm.slice(colonIdx + 1).replace(/^\/+/, '');
  } else if (isAbsolutePosix) {
    prefix = '/';
    pathBody = norm.slice(1);
  }

  const rawSegments = pathBody.split('/');
  const stack: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!prefix) {
        stack.push('..');
      }
      // 拥有绝对路径前缀时，.. 到顶后直接丢弃，防止越界逃逸
    } else {
      stack.push(seg);
    }
  }

  norm = prefix ? prefix + stack.join('/') : stack.join('/');

  // 4. Windows 盘符小写标准化补强（若前面未走 isWindowsDrive 分支）
  norm = norm.replace(
    /^([a-zA-Z]):(\/|$)/,
    (_, drive: string, rest: string) => {
      return `${drive.toLowerCase()}:${rest || '/'}`;
    }
  );

  // 5. 消除非根路径末尾多余斜杠（保留 'c:/'、'/'、'//'）
  const isRoot = norm === '/' || norm === '//' || /^[a-z]:\/$/i.test(norm);
  if (norm.length > 1 && norm.endsWith('/') && !isRoot) {
    norm = norm.slice(0, -1);
  }

  return norm;
}

/**
 * 跨平台路径等值比对（考虑 Windows 文件系统大小写不敏感与斜杠异构）
 */
export function isSameFsPath(
  pathA: string | null | undefined,
  pathB: string | null | undefined
): boolean {
  if (!pathA || !pathB) return false;
  return (
    toCanonicalFsPath(pathA).toLowerCase() ===
    toCanonicalFsPath(pathB).toLowerCase()
  );
}

/**
 * 纯函数：根据目标文件/目录路径与工作区根路径，推导从顶层直属子目录到目标父目录的有序祖先链（自上而下顺序）
 *
 * 边界与安全规则：
 * 1. 目标或工作区根为空时返回空数组；
 * 2. 目标包含未消解遍历段（..）时直接阻断返回空数组；
 * 3. 严格前缀判定：必须以 rootPrefix（如 'c:/work/'）开头，坚决拒绝兄弟前缀（如 'c:/work-extra'）；
 * 4. 目标与工作区根相同、或目标是根的直属子文件时，返回空数组；
 * 5. 返回的祖先数组不包含根自身，不包含目标自身，严格按照自顶向下的物理层级排序。
 */
export function getAncestorDirPaths(
  targetPath: string,
  rootPath: string
): string[] {
  const canonTarget = toCanonicalFsPath(targetPath);
  const canonRoot = toCanonicalFsPath(rootPath);

  if (!canonTarget || !canonRoot) return [];

  // 坚决阻断包含未消解遍历段的恶意逃逸
  if (/(^|\/)\.\.($|\/)/.test(canonTarget)) {
    return [];
  }

  const normRootLower = canonRoot.toLowerCase();
  const normTargetLower = canonTarget.toLowerCase();

  // 安全前缀：杜绝 c:/work 与 c:/work-extra 兄弟前缀假碰撞
  const rootPrefix = normRootLower.endsWith('/')
    ? normRootLower
    : normRootLower + '/';

  if (
    !normTargetLower.startsWith(rootPrefix) ||
    normTargetLower === normRootLower
  ) {
    return [];
  }

  const ancestors: string[] = [];
  let curr = pathDirname(canonTarget);

  while (curr) {
    const currCanon = toCanonicalFsPath(curr);
    const currLower = currCanon.toLowerCase();

    // 终止判定：抵达工作区根或已收敛至根以上
    if (
      currLower === normRootLower ||
      currLower === normRootLower.replace(/\/+$/, '') ||
      currLower.length <= normRootLower.length
    ) {
      break;
    }

    ancestors.unshift(currCanon);
    const next = pathDirname(currCanon);
    if (next === currCanon) {
      break;
    }
    curr = next;
  }

  return ancestors;
}

/** 简易 CSV / TSV → 行列（预览用，游标惰性扫描前 maxRows 行，杜绝全量 split） */
export function parseCsvPreview(text: string, maxRows = 80): string[][] {
  const rows: string[][] = [];
  let start = 0;
  const len = (text || '').length;

  while (start < len && rows.length < maxRows) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = len;

    let line = text.substring(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (start + line.length < len || line.trim()) {
      if (line.includes('\t') && !line.includes(',')) {
        rows.push(line.split('\t').map((c) => c.trim()));
      } else {
        rows.push(splitCsvLine(line));
      }
    }
    start = end + 1;
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
// 批注逻辑拆分到 fileAnnotations.ts，hub 经 re-export 保持对外契约不变
export {
  type PendingFileAnnotation,
  addPendingFileAnnotation,
  removePendingFileAnnotation,
  updatePendingFileAnnotationComment,
  countPendingFileAnnotations,
  takePendingFileAnnotations,
  formatAnnotationsForModel,
} from './fileAnnotations';

// 文件面板打开器 + 工具参数路径抽取拆分到 filePanelOpener.ts，
// hub 经 re-export 保持对外契约不变
export {
  takePendingOpenPath,
  registerFileViewerOpener,
  openFileInPanel,
  extractFilePathFromToolArgs,
  resolveFilePreviewHost,
  looksLikeOpenableFilePath,
  pathFromFileOpenClickTarget,
  type FilePreviewLeafHost,
} from './filePanelOpener';
