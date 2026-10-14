import { getWorkspacePath } from './projectStore';

function joinWorkspacePath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function getWorkspaceRoot(): string {
  return getWorkspacePath() || '';
}

const WINDOWS_RESERVED_NAME_RE =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
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
 * 路径穿越、保留设备名、危险控制字符、超长路径和根外绝对路径均拒绝。
 */
export function resolveWorkspacePath(path: string): string {
  const p = (path || '').trim();
  if (!p) return p;
  if (p.includes('\0') || p.length > MAX_PATH_LENGTH) return '';
  if (BIDI_OVERRIDE_RE.test(p)) return '';
  const lastSegment =
    p
      .replace(/[\\/]$/, '')
      .split(/[\\/]/)
      .pop() || '';
  if (WINDOWS_RESERVED_NAME_RE.test(lastSegment)) return '';
  const norm = p.replace(/\\/g, '/');
  if (/(^|\/)\.\.($|\/)/.test(norm)) return '';
  if (isAbsoluteFsPath(p)) {
    const root = getWorkspaceRoot()
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    if (!root) return '';
    const rootLower = root.toLowerCase();
    const pathLower = norm.toLowerCase();
    if (!(pathLower === rootLower || pathLower.startsWith(rootLower + '/'))) {
      return '';
    }
    return p;
  }
  const root = getWorkspaceRoot().trim();
  if (!root) return '';
  const relativePath = p.replace(/^\.[\\/]/, '');
  return joinWorkspacePath(root, relativePath);
}

/**
 * 供用户界面只读查看/预览的文件路径解析。
 *
 * 用户在 UI 打开查看文件（如代码、文本、图片、Skill 等）不属于 Agent 工具调用，
 * 不受工作区沙箱限制；相对路径拼到工作区下，绝对路径在安全校验后放行。
 * 路径穿越（..）、保留设备名、危险控制字符、超长路径仍严格拦截。
 */
export function resolveReadableFilePath(path: string): string {
  const p = (path || '').trim();
  if (!p) return '';
  if (p.includes('\0') || p.length > MAX_PATH_LENGTH) return '';
  if (BIDI_OVERRIDE_RE.test(p)) return '';
  const lastSegment =
    p
      .replace(/[\\/]$/, '')
      .split(/[\\/]/)
      .pop() || '';
  if (WINDOWS_RESERVED_NAME_RE.test(lastSegment)) return '';
  const norm = p.replace(/\\/g, '/');
  if (/(^|\/)\.\.($|\/)/.test(norm)) return '';
  if (isAbsoluteFsPath(p)) {
    return p;
  }
  const root = getWorkspaceRoot().trim();
  if (!root) return '';
  const relativePath = p.replace(/^\.[\\/]/, '');
  return joinWorkspacePath(root, relativePath);
}

/** 经 resolveWorkspacePath 校验后的工作区路径（空/越界不可构造） */
export type ResolvedPath = string & { readonly __brand: 'ResolvedPath' };

/** 硬失败版路径沙箱：空串、越界、非法组件一律 throw。 */
export function assertWorkspacePath(
  path: string,
  label = '路径'
): ResolvedPath {
  const raw = (path || '').trim();
  if (!raw) throw new Error(`${label}为空`);
  const resolved = resolveWorkspacePath(raw);
  if (!resolved) throw new Error(`文件不在当前工作区内: ${path}`);
  return resolved as ResolvedPath;
}

/** 是否已解析为工作区内路径（不抛错；供 UI 分支） */
export function isInsideWorkspace(path: string): boolean {
  const raw = (path || '').trim();
  return Boolean(raw && resolveWorkspacePath(raw));
}

export function joinWorkspaceRootPath(base: string, name: string): string {
  return joinWorkspacePath(base, name);
}
