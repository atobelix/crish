// 文件域展示纯函数（R2-06b 渲染面辅助；无 RN 依赖，jest 直测）：
// - detectFileKind：扩展名 → 类型（桌面 detectFileKind 语义的手机端子集，
//   F4 §2.8 / §4.2 渲染分派母本）；
// - fileKindGlyph / fileKindColor：类型图标字形 + 配色（F4 §6.2 线框图标语言
//   📁/📄/🖼/📕/📊/⚙，扩展名着色同桌面 FileTreeIcon fileExtColor 思路）；
// - formatFileSize / formatRelativeTime：行 meta 区（F4-F17 B/K/M + 相对时间）；
// - isSensitiveFile：F4 §7.1 敏感规则（文件名/路径模式，手机端独立判定）；
// - mapFilesErrorCode：F4 附录 B 错误码 → UI 文案（四态错误态数据面）。

// ── 文件类型判定（F4 §2.8 detectFileKind 子集） ───────────────────────────

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

/** 扩展名 → 类型（无扩展名按文本处理，README/LICENSE 等常见无后缀文本） */
export function detectFileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TABLE_EXTENSIONS.has(ext)) return 'table';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

// ── 图标字形与配色（F4 §6.2 线框图标语言 + fileExtColor 思路） ─────────────

/** 类型 → 图标字形（目录单独处理：📁） */
export function fileKindGlyph(kind: FileKind): string {
  switch (kind) {
    case 'text':
      return '📄';
    case 'image':
      return '🖼';
    case 'pdf':
      return '📕';
    case 'table':
      return '📊';
    case 'binary':
      return '⚙';
  }
}

/** 目录行图标字形 */
export const DIR_GLYPH = '📁';

/** 类型 → 图标主色（hex；浅深色板均可用，对比度达标，R2UX-06-08） */
export function fileKindColor(kind: FileKind): string {
  switch (kind) {
    case 'text':
      return '#2F6FEB';
    case 'image':
      return '#2E9E5B';
    case 'pdf':
      return '#D64545';
    case 'table':
      return '#E08A00';
    case 'binary':
      return '#7A7A7A';
  }
}

// ── 行 meta 格式化（F4-F17：size B/K/M + 相对时间） ────────────────────────

/** 字节 → 可读尺寸（B/K/M；<1KB 原样，≥1MB 保留 1 位小数） */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10}K`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}M`;
}

/** epoch ms → 相对时间文案（刚刚/N 分钟前/N 小时前/昨天/N 天前/日期兜底） */
export function formatRelativeTime(modifiedMs: number, nowMs: number): string {
  const diffMs = nowMs - modifiedMs;
  if (!Number.isFinite(modifiedMs) || diffMs < 0) return '';
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  const d = new Date(modifiedMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// ── 敏感文件判定（F4 §7.1 手机端独立判定；桌面端沙箱兜底） ───────────────

/** 文件是否命中敏感规则（密钥/凭证/配置类，F4 §7.1 表） */
export function isSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower === '.npmrc' || lower === '.yarnrc') return true;
  for (const prefix of ['id_rsa', 'credentials', 'secrets', 'token']) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const ext of ['.pem', '.key', '.p12', '.pfx']) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

// ── 错误码 → UI 文案（F4 附录 B 映射表；四态错误态数据面） ────────────────

export interface FilesErrorText {
  /** 主文案（错误态标题） */
  title: string;
  /** 副文案（引导/提示） */
  hint: string;
}

const UNKNOWN_ERROR_TEXT: FilesErrorText = {
  title: '加载失败',
  hint: '请重试；若持续失败，检查桌面端是否在线',
};

/** 协议错误码 → UI 文案（F4 附录 B；未登记码 → 通用文案保真不丢） */
export function mapFilesErrorCode(
  code: string | null | undefined
): FilesErrorText {
  switch (code) {
    case 'outside_workspace':
      return {
        title: '路径不在已授权工作区内',
        hint: '请在桌面端检查工作区授权',
      };
    case 'path_not_found':
      return {
        title: '文件或目录不存在',
        hint: '可能已被移动或删除（F4 附录 B）',
      };
    case 'not_directory':
    case 'not_file':
      return { title: '路径类型不匹配', hint: '请确认目标为目录或文件后重试' };
    case 'file_too_large':
      return {
        title: '文件过大，无法预览',
        hint: '预览上限 1MB（R2UX-06-02）',
      };
    case 'binary_file':
      return {
        title: '二进制文件，无法预览',
        hint: '仅支持文本类文件内容展示',
      };
    case 'unsupported_encoding':
      return { title: '文件编码不受支持', hint: '请用支持该编码的编辑器查看' };
    case 'workspace_not_granted':
      return {
        title: '工作区未授权',
        hint: '请在桌面端重新添加该工作区（F4-F03）',
      };
    case 'transport.closed':
      return { title: '未连接', hint: '与桌面端连接已断开，请检查网络后重试' };
    case 'cmd.timeout':
      return { title: '请求超时', hint: '桌面端未响应，请重试' };
    case 'internal':
      return {
        title: '桌面端内部错误',
        hint: '请重试；若持续失败请查看桌面端日志',
      };
    case null:
    case undefined:
    case 'idle':
      return { title: '尚未加载', hint: '等待数据到达' };
    default:
      return UNKNOWN_ERROR_TEXT;
  }
}
