// 文件域展示纯函数：类型判定、图标、尺寸、敏感文件与错误文案。
import type { ThemeColors } from '@/adapters/platform/theme';
import type { IconName } from '@/presentation/ui/Icon';

export type FileKind = 'text' | 'image' | 'pdf' | 'table' | 'binary';

const TEXT_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'rs',
  'py',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'swift',
  'php',
  'rb',
  'lua',
  'pl',
  'json',
  'md',
  'markdown',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'txt',
  'log',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'graphql',
  'vue',
  'svelte',
  'dockerfile',
]);

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);

export function detectFileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  const extension = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (TABLE_EXTENSIONS.has(extension)) return 'table';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'binary';
}

/** N05 收敛：文件类型图标只保留 folder/file 两个符号（细分类型由色点表达） */
export const FILE_KIND_ICON: Record<FileKind, IconName> = {
  text: 'file',
  image: 'file',
  pdf: 'file',
  table: 'file',
  binary: 'file',
};

export const FILE_KIND_TONE: Record<FileKind, keyof ThemeColors> = {
  text: 'info',
  image: 'success',
  pdf: 'danger',
  table: 'warning',
  binary: 'textTertiary',
};

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function isSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower === '.npmrc' || lower === '.yarnrc') return true;
  for (const prefix of ['id_rsa', 'credentials', 'secrets', 'token']) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const extension of ['.pem', '.key', '.p12', '.pfx']) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

export interface FilesErrorText {
  title: string;
  hint?: string;
}

export function mapFilesErrorCode(
  code: string | null | undefined
): FilesErrorText {
  switch (code) {
    case 'file.not_found':
      return { title: '文件或目录不存在' };
    case 'file.not_granted':
      return { title: '不在已授权工作区内', hint: '请在桌面端检查工作区授权' };
    case 'file.too_large':
      return { title: '文件过大，无法预览', hint: '预览上限 1MB' };
    case 'file.binary':
      return { title: '二进制文件，无法预览' };
    case 'file.encoding':
      return { title: '文件编码不受支持' };
    case 'cmd.invalid':
      return { title: '路径类型不匹配' };
    case 'transport.closed':
      return { title: '未连接', hint: '请检查与桌面的连接' };
    case 'cmd.timeout':
      return { title: '请求超时' };
    default:
      return { title: '加载失败' };
  }
}
