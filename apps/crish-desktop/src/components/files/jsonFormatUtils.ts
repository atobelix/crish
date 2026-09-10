/**
 * apps/crish-desktop/src/components/files/jsonFormatUtils.ts
 *
 * JSON 检测与安全格式化纯逻辑工具域（§3.2：jsonc/jsonl 真解析，禁止假开通）
 */

export interface FormatJsonResult {
  success: boolean;
  formatted: string;
  error?: string;
}

const JSON_EXT_RE = /\.(json|jsonc|jsonl|ndjson|geojson|topojson|har|map)$/i;
const JSONL_EXT_RE = /\.(jsonl|ndjson)$/i;
const JSONC_EXT_RE = /\.jsonc$/i;

/**
 * 判断指定文件路径或文本内容是否具有 JSON 特征
 */
export function isJsonFileOrContent(
  filePath?: string | null,
  content?: string
): boolean {
  if (filePath) {
    const cleanPath = filePath.trim().split('?')[0]?.split('#')[0] ?? '';
    if (cleanPath && JSON_EXT_RE.test(cleanPath)) {
      return true;
    }
  }

  if (content && typeof content === 'string') {
    const trimmed = content.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return true;
    }
  }

  return false;
}

export function isJsonlPath(filePath?: string | null): boolean {
  if (!filePath) return false;
  const cleanPath = filePath.trim().split('?')[0]?.split('#')[0] ?? '';
  return JSONL_EXT_RE.test(cleanPath);
}

export function isJsoncPath(filePath?: string | null): boolean {
  if (!filePath) return false;
  const cleanPath = filePath.trim().split('?')[0]?.split('#')[0] ?? '';
  return JSONC_EXT_RE.test(cleanPath);
}

/**
 * 判断指定内容是否为单行紧凑或少行但高度堆叠的未格式化 JSON
 */
export function isCompactOrSingleLineJson(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    return true;
  }

  if (trimmed.length > 1024) {
    let lines = 1;
    const slice = trimmed.slice(0, 4000);
    for (let i = 0; i < slice.length; i++) {
      if (slice.charCodeAt(i) === 10) lines++;
      if (lines > 4) return false;
    }
    return lines <= 4;
  }

  return false;
}

/**
 * 剥离 JSONC 注释（保留字符串内的双斜杠与块注释定界符）。
 * 真解析前置：去掉注释后再 JSON.parse。
 */
export function stripJsoncComments(raw: string): string {
  let out = '';
  let i = 0;
  const n = raw.length;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  while (i < n) {
    const ch = raw[i]!;
    const next = i + 1 < n ? raw[i + 1]! : '';

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && raw[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function formatJsonl(raw: string, indent: number): FormatJsonResult {
  const lines = raw.split(/\r?\n/);
  const formattedLines: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const trimmed = line.trim();
    if (!trimmed) {
      formattedLines.push('');
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      // jsonl：每行一个 JSON 值；美化为紧凑单行（保留一行一记录语义）
      formattedLines.push(JSON.stringify(parsed));
    } catch (err) {
      return {
        success: false,
        formatted: raw,
        error: `第 ${li + 1} 行: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // indent>0 时对对象行做可读缩进会破坏 jsonl 行语义；保持单行 stringify
  void indent;
  return { success: true, formatted: formattedLines.join('\n') };
}

/**
 * 安全格式化 JSON / JSONC / JSONL
 * @param filePath 可选：用于选择 jsonc/jsonl 真解析轨
 */
export function formatJsonSafe(
  raw: string,
  indent = 2,
  filePath?: string | null
): FormatJsonResult {
  if (!raw || !raw.trim()) {
    return { success: true, formatted: raw };
  }

  try {
    if (isJsonlPath(filePath)) {
      return formatJsonl(raw, indent);
    }

    const source =
      isJsoncPath(filePath) || /\/\*|\s\/\//.test(raw)
        ? stripJsoncComments(raw)
        : raw;

    // 无扩展名但多行「每行一个 JSON」：尝试 jsonl
    if (
      !filePath &&
      source.includes('\n') &&
      !/^\s*[\[{]/.test(source.trim())
    ) {
      const probe = formatJsonl(source, indent);
      if (probe.success) return probe;
    }

    const parsed = JSON.parse(source);
    return {
      success: true,
      formatted: JSON.stringify(parsed, null, indent),
    };
  } catch (err) {
    return {
      success: false,
      formatted: raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}