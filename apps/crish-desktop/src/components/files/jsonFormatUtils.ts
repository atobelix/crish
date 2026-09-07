/**
 * apps/crish-desktop/src/components/files/jsonFormatUtils.ts
 *
 * JSON 检测与安全格式化纯逻辑工具域
 * 1. 严格支持主流 JSON 派生后缀检测 (.json, .jsonc, .jsonl, .geojson 等) 与内容语法探测；
 * 2. 纯函数安全解析与缩进转换，杜绝运行时异常；
 * 3. 紧凑单行智能判定，提供单轨体验决策支持。
 */

export interface FormatJsonResult {
  success: boolean;
  formatted: string;
  error?: string;
}

const JSON_EXT_RE = /\.(json|jsonc|jsonl|ndjson|geojson|topojson|har|map)$/i;

/**
 * 判断指定文件路径或文本内容是否具有 JSON 特征
 */
export function isJsonFileOrContent(filePath?: string | null, content?: string): boolean {
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

/**
 * 判断指定内容是否为单行紧凑或少行但高度堆叠的未格式化 JSON
 */
export function isCompactOrSingleLineJson(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;

  // 不含换行符或前 2000 字符内无换行
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    return true;
  }

  // 或者行数极少但体积较大 (例如超过 1KB 但不足 3 行)
  if (trimmed.length > 1024) {
    const lines = trimmed.slice(0, 4000).split('\n');
    if (lines.length <= 4) {
      return true;
    }
  }

  return false;
}

/**
 * 安全格式化 JSON 字符串（带 try-catch 与行缩进控制）
 */
export function formatJsonSafe(raw: string, indent = 2): FormatJsonResult {
  if (!raw || !raw.trim()) {
    return { success: true, formatted: raw };
  }

  try {
    const parsed = JSON.parse(raw);
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
