/**
 * Conex Composer — Diff Parser Utility
 *
 * 从 DiffBlockView 中抽取的独立 Diff 解析器。
 * 将 Unified Diff 文本解析为结构化的 DiffLine 数组。
 */

/** Diff 行的类型 */
export type DiffLineType = 'add' | 'delete' | 'context' | 'header';

/** 解析后的 Diff 行 */
export interface DiffLine {
  /** 行类型 */
  type: DiffLineType;
  /** 行原始文本（包含 +/- 前缀） */
  text: string;
  /** 旧文件行号（仅 delete 和 context 行有值） */
  oldLineNum?: number;
  /** 新文件行号（仅 add 和 context 行有值） */
  newLineNum?: number;
}

/**
 * 解析 Unified Diff 格式的文本为结构化数组。
 *
 * 解析规则：
 * - `---`/`+++`/`@@` 开头 → header 行（不计行号）
 * - `+` 开头 → add 行（绿色，仅新文件行号）
 * - `-` 开头 → delete 行（红色，仅旧文件行号）
 * - 其他 → context 行（不变行，双行号）
 *
 * @param rawCode - Diff 源码文本
 * @returns 解析后的 DiffLine 数组
 */
export function parseDiff(rawCode: string): DiffLine[] {
  const lines = rawCode.split('\n');
  let oldCounter = 1;
  let newCounter = 1;
  const result: DiffLine[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'header', text: line });
    } else if (line.startsWith('@@')) {
      // 尝试解析 @@ -1,5 +1,6 @@ 中的行号
      const match = line.match(/^@@\s*-(\d+)/);
      if (match) {
        oldCounter = parseInt(match[1], 10);
      }
      const matchNew = line.match(/\+(\d+)/);
      if (matchNew) {
        newCounter = parseInt(matchNew[1], 10);
      }
      result.push({ type: 'header', text: line });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line,
        newLineNum: newCounter++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'delete',
        text: line,
        oldLineNum: oldCounter++,
      });
    } else {
      result.push({
        type: 'context',
        text: line,
        oldLineNum: oldCounter++,
        newLineNum: newCounter++,
      });
    }
  }

  return result;
}

/**
 * 统计 Diff 中的新增和删除行数。
 */
export function getDiffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions++;
    else if (line.type === 'delete') deletions++;
  }
  return { additions, deletions };
}
