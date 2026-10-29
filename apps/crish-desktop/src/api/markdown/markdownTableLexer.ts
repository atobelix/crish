/**
 * Markdown 表格词法：code-span / 转义感知的单元格切分。
 *
 * 只做表格行解析，不负责草稿闭合或渲染。
 */

/** code-span 感知的表格列数/单元格切分。 */
export function splitTableCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let current = '';
  let codeTicks = 0;
  let endedWithDelimiter = false;
  let i = 0;
  if (text.startsWith('|')) i = 1;

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '`') {
      let run = 0;
      while (text[i + run] === '`') run += 1;
      if (codeTicks === 0) codeTicks = run;
      else if (run === codeTicks) codeTicks = 0;
      current += text.slice(i, i + run);
      i += run;
      endedWithDelimiter = false;
      continue;
    }
    if (codeTicks === 0 && ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 2;
      endedWithDelimiter = false;
      continue;
    }
    if (codeTicks === 0 && ch === '|') {
      cells.push(current.trim());
      current = '';
      endedWithDelimiter = true;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
    endedWithDelimiter = false;
  }

  if (!endedWithDelimiter || cells.length === 0) {
    cells.push(current.trim());
  }
  return cells;
}

export function countTableColumns(line: string): number {
  if (!line.includes('|')) return 0;
  return splitTableCells(line).length;
}

export function isCompleteTableSeparator(
  separator: string,
  columns: number
): boolean {
  const cells = splitTableCells(separator);
  if (cells.length < columns) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

export function completeTableSeparator(
  separator: string,
  columns: number
): string {
  const existing = splitTableCells(separator);
  const cells: string[] = [];
  for (let i = 0; i < columns; i += 1) {
    const raw = (existing[i] ?? '').trim();
    const left = raw.startsWith(':');
    const right = raw.endsWith(':');
    if (left && right) cells.push(':---:');
    else if (left) cells.push(':---');
    else if (right) cells.push('---:');
    else cells.push('---');
  }
  return `| ${cells.join(' | ')} |`;
}
