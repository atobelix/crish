/**
 * 工具输出结构化解析器（纯函数无副作用）
 * 将 Rust 引擎返回的各类信封式原始字符串清洗、提取并结构化为人类友好的展示模型
 */

export interface FileStatData {
  path: string;
  kind: string;
  kindZh: string;
  size: number;
  sizeStr: string;
  mtime: number;
  mtimeStr: string;
  readonly: boolean;
}

export interface ReadFileData {
  path?: string;
  encoding?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  remainingLines?: number;
  isCharTruncated?: boolean;
  code: string;
}

export interface GrepMatchItem {
  filePath: string;
  line?: number;
  column?: number;
  text: string;
}

export interface GrepSearchData {
  query?: string;
  root?: string;
  matchCount?: number;
  visitedFiles?: number;
  isEmpty: boolean;
  matches: GrepMatchItem[];
}

export interface ListDirItem {
  name: string;
  isDir: boolean;
}

export interface ListDirData {
  isEmpty: boolean;
  items: ListDirItem[];
}

/**
 * 格式化字节尺寸为可读字符串
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 字节';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) {
    const kb = (bytes / 1024).toFixed(1);
    return `${kb} KB (${bytes.toLocaleString()} 字节)`;
  }
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  return `${mb} MB (${bytes.toLocaleString()} 字节)`;
}

/**
 * 格式化时间戳为本地友好可读字符串
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
  } catch {
    return String(ms);
  }
}

/**
 * 解析 file_stat 工具输出：
 * 形如：
 * README.md: file\nsize: 8251 bytes\nmtime: 1785676954141 ms\nreadonly: false
 */
export function parseFileStatOutput(raw: string): FileStatData | null {
  if (!raw) return null;
  const match = raw.match(
    /^([\s\S]+?):\s*(file|directory|other)\s*\nsize:\s*(\d+)\s*bytes\s*\nmtime:\s*(\d+)\s*ms\s*\nreadonly:\s*(true|false)/i
  );
  if (!match) return null;

  const [, path, kind, sizeStr, mtimeStr, readonlyStr] = match;
  if (!path || !kind || !sizeStr || !mtimeStr || !readonlyStr) return null;

  const size = parseInt(sizeStr, 10);
  const mtime = parseInt(mtimeStr, 10);
  const isReadonly = readonlyStr.toLowerCase() === 'true';

  let kindZh = '其它';
  if (kind.toLowerCase() === 'file') kindZh = '文件';
  else if (kind.toLowerCase() === 'directory') kindZh = '目录';

  return {
    path: path.trim(),
    kind: kind.toLowerCase(),
    kindZh,
    size,
    sizeStr: formatBytes(size),
    mtime,
    mtimeStr: formatTimestamp(mtime),
    readonly: isReadonly,
  };
}

/**
 * 解析 read_file / view_file 工具输出：
 * 剥除 Rust agent-tools/fs.rs 生成的信封头部：
 * path: ...\nsnapshotTag: ...\nencoding: ...\nlines: ...\nstartLine: ..., endLine: ...\n---\n<content>
 */
export function parseReadFileOutput(
  raw: string,
  toolName?: string
): ReadFileData | null {
  if (!raw) return null;
  const isReadTool =
    Boolean(toolName) &&
    /^(read_file|view_file|cat|read_text_file)$/i.test(toolName!);

  const hasEnvelopeMarker = raw.includes('\n---\n');
  const startsWithEnvelope = /^path:\s+/i.test(raw);

  if (!hasEnvelopeMarker && !isReadTool && !startsWithEnvelope) {
    return null;
  }

  if (hasEnvelopeMarker && (startsWithEnvelope || isReadTool)) {
    const dividerIdx = raw.indexOf('\n---\n');
    const header = raw.slice(0, dividerIdx);
    let code = raw.slice(dividerIdx + 5);

    const pathMatch = header.match(/^path:\s*(.*)$/im);
    const encMatch = header.match(/^encoding:\s*(.*)$/im);
    const linesMatch = header.match(/^lines:\s*(\d+)$/im);
    const rangeMatch = header.match(
      /^startLine:\s*(\d+),\s*endLine:\s*(\d+)$/im
    );
    const remainingMatch = header.match(/(\d+)\s*lines remaining/i);
    const charTruncMatch = header.match(/truncated:\s*true/i);

    let remainingLines = remainingMatch?.[1]
      ? parseInt(remainingMatch[1], 10)
      : undefined;

    // 清洗 code 末尾的引擎截断提示（如 "\n... 93 lines remaining, use contentOffset to continue ..." 或中文提示）
    const trailingNoticeMatch = code.match(
      /\n\s*(\.\.\.|…)\s*(\d+)\s*lines remaining[^\n]*$/i
    );
    if (trailingNoticeMatch) {
      if (!remainingLines && trailingNoticeMatch[2]) {
        remainingLines = parseInt(trailingNoticeMatch[2], 10);
      }
      code = code.slice(0, trailingNoticeMatch.index).trimEnd();
    } else {
      const trailingZhMatch = code.match(
        /\n\s*(\.\.\.|…)\s*剩余\s*(\d+)\s*行[^\n]*$/i
      );
      if (trailingZhMatch) {
        if (!remainingLines && trailingZhMatch[2]) {
          remainingLines = parseInt(trailingZhMatch[2], 10);
        }
        code = code.slice(0, trailingZhMatch.index).trimEnd();
      }
    }

    return {
      path: pathMatch?.[1] ? pathMatch[1].trim() : undefined,
      encoding: encMatch?.[1] ? encMatch[1].trim() : undefined,
      totalLines: linesMatch?.[1] ? parseInt(linesMatch[1], 10) : undefined,
      startLine: rangeMatch?.[1] ? parseInt(rangeMatch[1], 10) : undefined,
      endLine: rangeMatch?.[2] ? parseInt(rangeMatch[2], 10) : undefined,
      remainingLines,
      isCharTruncated: Boolean(charTruncMatch),
      code,
    };
  }

  // 如果没有信封标记但属于 read_file 类的输出，清洗可能的末尾截断提示
  if (isReadTool) {
    let code = raw;
    let remainingLines: number | undefined;
    const trailingNoticeMatch = code.match(
      /\n\s*(\.\.\.|…)\s*(\d+)\s*lines remaining[^\n]*$/i
    );
    if (trailingNoticeMatch) {
      if (trailingNoticeMatch[2]) {
        remainingLines = parseInt(trailingNoticeMatch[2], 10);
      }
      code = code.slice(0, trailingNoticeMatch.index).trimEnd();
      return {
        code,
        remainingLines,
      };
    }
  }

  return null;
}

/**
 * 解析 grep_search 工具输出：
 * query: ...\nroot: ...\nmatches: ...\nvisitedFiles: ...\n---\npath:line:col: content
 *
 * 注：`_toolName` 保留在签名里（既有调用方按位置传第二参，含用例），
 * 但本函数只按输出内容判定，不依赖工具名。
 */
export function parseGrepSearchOutput(
  raw: string,
  _toolName?: string
): GrepSearchData | null {
  if (!raw) return null;

  if (raw.trim() === '(no matches)') {
    return {
      isEmpty: true,
      matches: [],
    };
  }

  const hasDivider = raw.includes('\n---\n');
  const startsWithQuery = /^query:\s+/i.test(raw);

  if (!hasDivider && !startsWithQuery) {
    return null;
  }

  let body = raw;
  let query: string | undefined;
  let root: string | undefined;
  let matchCount: number | undefined;
  let visitedFiles: number | undefined;

  if (hasDivider) {
    const dividerIdx = raw.indexOf('\n---\n');
    const header = raw.slice(0, dividerIdx);
    body = raw.slice(dividerIdx + 5);

    const qm = header.match(/^query:\s*(.*)$/im);
    const rm = header.match(/^root:\s*(.*)$/im);
    const mm = header.match(/^matches:\s*(\d+)$/im);
    const vm = header.match(/^visitedFiles:\s*(\d+)$/im);

    if (qm?.[1]) query = qm[1].trim();
    if (rm?.[1]) root = rm[1].trim();
    if (mm?.[1]) matchCount = parseInt(mm[1], 10);
    if (vm?.[1]) visitedFiles = parseInt(vm[1], 10);
  }

  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0 || body.trim() === '(no matches)') {
    return {
      query,
      root,
      matchCount: 0,
      visitedFiles,
      isEmpty: true,
      matches: [],
    };
  }

  const matches: GrepMatchItem[] = [];
  for (const line of lines) {
    // 匹配 path:line:col: text
    const matchCol = line.match(/^([^:]+):(\d+):(\d+):\s?(.*)$/);
    if (
      matchCol &&
      matchCol[1] &&
      matchCol[2] &&
      matchCol[3] &&
      matchCol[4] !== undefined
    ) {
      matches.push({
        filePath: matchCol[1],
        line: parseInt(matchCol[2], 10),
        column: parseInt(matchCol[3], 10),
        text: matchCol[4],
      });
      continue;
    }

    // 匹配 path:line: text
    const matchLine = line.match(/^([^:]+):(\d+):\s?(.*)$/);
    if (
      matchLine &&
      matchLine[1] &&
      matchLine[2] &&
      matchLine[3] !== undefined
    ) {
      matches.push({
        filePath: matchLine[1],
        line: parseInt(matchLine[2], 10),
        text: matchLine[3],
      });
      continue;
    }

    matches.push({
      filePath: '',
      text: line,
    });
  }

  return {
    query,
    root,
    matchCount: matchCount ?? matches.length,
    visitedFiles,
    isEmpty: matches.length === 0,
    matches,
  };
}

/**
 * 解析 list_dir 工具输出：
 * 形如：
 * /dirA
 *  fileB.txt
 */
export function parseListDirOutput(
  raw: string,
  toolName?: string
): ListDirData | null {
  if (!raw) return null;
  const isListDir = Boolean(toolName) && /list_dir|listdir/i.test(toolName!);
  if (!isListDir) return null;

  const trimmed = raw.trim();
  if (trimmed === '(empty directory)') {
    return { isEmpty: true, items: [] };
  }

  const lines = trimmed.split('\n');
  const items: ListDirItem[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('/')) {
      items.push({ name: line.slice(1).trim(), isDir: true });
    } else if (line.startsWith(' ')) {
      items.push({ name: line.trim(), isDir: false });
    } else {
      items.push({ name: line.trim(), isDir: line.endsWith('/') });
    }
  }

  return {
    isEmpty: items.length === 0,
    items,
  };
}

/**
 * 尝试将 JSON 字符串（对象、数组或顶层包装形式）格式化为美化缩进的 JSON 文本
 */
export function formatJsonIfApplicable(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();

  // 1. 纯 JSON 对象或数组
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // ignore
    }
  }

  // 2. 包装有 markdown 代码块的 JSON (```json ... ```)
  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      const inner = codeBlockMatch[1].trim();
      const parsed = JSON.parse(inner);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // ignore
    }
  }

  return text;
}
