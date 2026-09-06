/**
 * TableOperations.ts
 * 
 * 纯函数表格操作原子库，提供无损、高保真的 Markdown 表格解析、增删行列、列对齐与格式化能力。
 */

export interface TableRange {
  startOffset: number;
  endOffset: number;
  startLineIndex?: number;
  absoluteLineIndex?: number;
  lines: string[];
  lineOffsets: number[];
  activeLineIndex: number;
  activeCellIndex: number;
  separatorLineIndex: number;
  columnCount: number;
}

export interface TableOperationResult {
  newText: string;
  newCursorPos: number;
  selection?: { start: number; end: number };
}

/**
 * 计算字符显示宽度（全角/中文字符计为 2，半角字符计为 1）
 */
export function getVisualWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK 统一表意文字、全角字符范围
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 解析单行表格中的所有单元格（支持转义管道符 \|）
 */
export function parseRowCells(lineText: string): { cells: string[]; pipePositions: number[] } {
  const pipePositions: number[] = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '|' && (i === 0 || lineText[i - 1] !== '\\')) {
      pipePositions.push(i);
    }
  }

  if (pipePositions.length < 2) {
    return { cells: [lineText.trim()], pipePositions };
  }

  const cells: string[] = [];
  for (let i = 0; i < pipePositions.length - 1; i++) {
    const rawCell = lineText.substring(pipePositions[i] + 1, pipePositions[i + 1]);
    cells.push(rawCell.trim());
  }

  return { cells, pipePositions };
}

/**
 * 判断某一行是否为合法的 Markdown 表格行（包含管道符或为表格分隔行）
 */
export function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return false;
  const { pipePositions } = parseRowCells(trimmed);
  return pipePositions.length >= 2;
}

/**
 * 判断某一行是否为表格分隔线行 (如 | --- | :---: | ---: |)
 */
export function isSeparatorLine(line: string): boolean {
  if (!isTableLine(line)) return false;
  const { cells } = parseRowCells(line);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-+:?$/.test(c.trim()));
}

/**
 * 定位光标所在的完整表格区域
 */
export function findTableRange(text: string, cursorPos: number): TableRange | null {
  const allLines = text.split('\n');
  const lineStartOffsets: number[] = [];
  let currentOffset = 0;
  for (let i = 0; i < allLines.length; i++) {
    lineStartOffsets.push(currentOffset);
    currentOffset += allLines[i].length + 1; // +1 是换行符 \n
  }

  // 找到当前光标所在行索引
  let activeLineIdx = lineStartOffsets.length - 1;
  for (let i = 0; i < lineStartOffsets.length; i++) {
    const nextStart = i + 1 < lineStartOffsets.length ? lineStartOffsets[i + 1] : Infinity;
    if (cursorPos >= lineStartOffsets[i] && cursorPos < nextStart) {
      activeLineIdx = i;
      break;
    }
  }

  if (!isTableLine(allLines[activeLineIdx])) {
    return null;
  }

  // 向上寻找表格起始行
  let startLineIdx = activeLineIdx;
  while (startLineIdx > 0 && isTableLine(allLines[startLineIdx - 1])) {
    startLineIdx--;
  }

  // 向下寻找表格结束行
  let endLineIdx = activeLineIdx;
  while (endLineIdx < allLines.length - 1 && isTableLine(allLines[endLineIdx + 1])) {
    endLineIdx++;
  }

  const tableLines = allLines.slice(startLineIdx, endLineIdx + 1);
  const tableLineOffsets = lineStartOffsets.slice(startLineIdx, endLineIdx + 1);
  const startOffset = tableLineOffsets[0];
  const lastLine = tableLines[tableLines.length - 1];
  const endOffset = tableLineOffsets[tableLineOffsets.length - 1] + lastLine.length;

  let separatorLineIdx = -1;
  let maxCols = 0;
  for (let i = 0; i < tableLines.length; i++) {
    if (isSeparatorLine(tableLines[i])) {
      separatorLineIdx = i;
    }
    const { cells } = parseRowCells(tableLines[i]);
    if (cells.length > maxCols) maxCols = cells.length;
  }

  const relativeActiveLine = activeLineIdx - startLineIdx;
  const activeLineText = tableLines[relativeActiveLine];
  const cursorInLine = cursorPos - tableLineOffsets[relativeActiveLine];
  const { pipePositions } = parseRowCells(activeLineText);

  let activeCellIdx = 0;
  if (pipePositions.length >= 2) {
    for (let i = 0; i < pipePositions.length - 1; i++) {
      if (cursorInLine >= pipePositions[i] && cursorInLine <= pipePositions[i + 1]) {
        activeCellIdx = i;
        break;
      }
    }
    if (cursorInLine > pipePositions[pipePositions.length - 1]) {
      activeCellIdx = pipePositions.length - 2;
    }
  }

  return {
    startOffset,
    endOffset,
    startLineIndex: startLineIdx,
    absoluteLineIndex: activeLineIdx,
    lines: tableLines,
    lineOffsets: tableLineOffsets,
    activeLineIndex: relativeActiveLine,
    activeCellIndex: activeCellIdx,
    separatorLineIndex: separatorLineIdx,
    columnCount: maxCols || 1,
  };
}

/**
 * 插入新行（上方插入或下方插入）
 */
export function insertRow(text: string, cursorPos: number, position: 'above' | 'below' = 'below'): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  const emptyCells = Array(table.columnCount).fill('  ');
  const newRowText = `| ${emptyCells.join(' | ')} |`;

  const newLines = [...table.lines];
  let insertIdx: number;

  if (position === 'above') {
    // 如果在表头或分隔行上方插入，避免插入到分隔行位置导致语法损坏
    if (table.activeLineIndex === table.separatorLineIndex) {
      insertIdx = table.separatorLineIndex + 1;
    } else {
      insertIdx = table.activeLineIndex;
    }
  } else {
    // below
    insertIdx = table.activeLineIndex + 1;
    // 如果当前在表头行，below 应插在分隔行之后
    if (table.separatorLineIndex !== -1 && table.activeLineIndex < table.separatorLineIndex) {
      insertIdx = table.separatorLineIndex + 1;
    }
  }

  newLines.splice(insertIdx, 0, newRowText);

  // 重组文档
  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  const newText = before + newTableText + after;

  // 计算新行第 1 个单元格（或对应列）的光标位置
  let targetLineOffset = table.startOffset;
  for (let i = 0; i < insertIdx; i++) {
    targetLineOffset += newLines[i].length + 1;
  }
  const { pipePositions } = parseRowCells(newRowText);
  const targetCol = Math.min(table.activeCellIndex, pipePositions.length - 2);
  const targetPipe = pipePositions[targetCol >= 0 ? targetCol : 0];
  const newCursorPos = targetLineOffset + targetPipe + 2;

  return { newText, newCursorPos };
}

/**
 * 删除当前行
 */
export function deleteRow(text: string, cursorPos: number): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  // 不允许直接删除分隔线行，若在分隔线行则不处理
  if (table.activeLineIndex === table.separatorLineIndex) {
    return { newText: text, newCursorPos: cursorPos };
  }

  const newLines = [...table.lines];
  newLines.splice(table.activeLineIndex, 1);

  // 如果只剩下 1 行或者没有数据行了，则删除整个表格
  if (newLines.length <= 1) {
    const before = text.substring(0, table.startOffset);
    const after = text.substring(table.endOffset);
    const newText = before + after;
    return { newText, newCursorPos: table.startOffset };
  }

  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  const newText = before + newTableText + after;

  const targetLineIdx = Math.min(table.activeLineIndex, newLines.length - 1);
  let targetLineOffset = table.startOffset;
  for (let i = 0; i < targetLineIdx; i++) {
    targetLineOffset += newLines[i].length + 1;
  }
  const targetRowText = newLines[targetLineIdx];
  const { pipePositions } = parseRowCells(targetRowText);
  const targetCol = Math.min(table.activeCellIndex, pipePositions.length - 2);
  const targetPipe = pipePositions[targetCol >= 0 ? targetCol : 0];
  const newCursorPos = targetLineOffset + targetPipe + 2;

  return { newText, newCursorPos };
}

/**
 * 插入新列（左侧或右侧）
 */
export function insertColumn(text: string, cursorPos: number, position: 'left' | 'right' = 'right'): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  const insertColIdx = position === 'left' ? table.activeCellIndex : table.activeCellIndex + 1;
  const newLines: string[] = [];

  for (let rowIdx = 0; rowIdx < table.lines.length; rowIdx++) {
    const line = table.lines[rowIdx];
    const { cells } = parseRowCells(line);
    
    // 补齐列数
    while (cells.length < table.columnCount) {
      cells.push('');
    }

    if (rowIdx === table.separatorLineIndex) {
      cells.splice(insertColIdx, 0, '---');
    } else {
      cells.splice(insertColIdx, 0, '  ');
    }

    newLines.push(`| ${cells.join(' | ')} |`);
  }

  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  const newText = before + newTableText + after;

  let targetLineOffset = table.startOffset;
  for (let i = 0; i < table.activeLineIndex; i++) {
    targetLineOffset += newLines[i].length + 1;
  }
  const activeRowText = newLines[table.activeLineIndex];
  const { pipePositions } = parseRowCells(activeRowText);
  const targetPipe = pipePositions[insertColIdx];
  const newCursorPos = targetLineOffset + targetPipe + 2;

  return { newText, newCursorPos };
}

/**
 * 删除当前列
 */
export function deleteColumn(text: string, cursorPos: number): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  if (table.columnCount <= 1) {
    // 若只有一列，删除等同于清除表格
    const before = text.substring(0, table.startOffset);
    const after = text.substring(table.endOffset);
    return { newText: before + after, newCursorPos: table.startOffset };
  }

  const deleteColIdx = table.activeCellIndex;
  const newLines: string[] = [];

  for (let rowIdx = 0; rowIdx < table.lines.length; rowIdx++) {
    const line = table.lines[rowIdx];
    const { cells } = parseRowCells(line);
    if (deleteColIdx < cells.length) {
      cells.splice(deleteColIdx, 1);
    }
    newLines.push(`| ${cells.join(' | ')} |`);
  }

  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  const newText = before + newTableText + after;

  let targetLineOffset = table.startOffset;
  for (let i = 0; i < table.activeLineIndex; i++) {
    targetLineOffset += newLines[i].length + 1;
  }
  const activeRowText = newLines[table.activeLineIndex];
  const { pipePositions } = parseRowCells(activeRowText);
  const targetCol = Math.min(deleteColIdx, pipePositions.length - 2);
  const targetPipe = pipePositions[targetCol >= 0 ? targetCol : 0];
  const newCursorPos = targetLineOffset + targetPipe + 2;

  return { newText, newCursorPos };
}

/**
 * 切换列对齐方式
 */
export function setColumnAlign(
  text: string,
  cursorPos: number,
  align: 'left' | 'center' | 'right',
  targetCol?: number
): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table || table.separatorLineIndex === -1) return { newText: text, newCursorPos: cursorPos };

  const sepLine = table.lines[table.separatorLineIndex];
  const { cells } = parseRowCells(sepLine);

  while (cells.length < table.columnCount) {
    cells.push('---');
  }

  const colIdx = targetCol !== undefined ? targetCol : table.activeCellIndex;
  if (colIdx >= 0 && colIdx < cells.length) {
    if (align === 'center') cells[colIdx] = ':---:';
    else if (align === 'right') cells[colIdx] = '---:';
    else cells[colIdx] = ':---';
  }

  const newLines = [...table.lines];
  newLines[table.separatorLineIndex] = `| ${cells.join(' | ')} |`;

  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  return { newText: before + newTableText + after, newCursorPos: cursorPos };
}

/**
 * 表格自动排版格式化 (Auto-Padding / Pretty Print)
 */
export function formatTable(tableText: string): string {
  const lines = tableText.trim().split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return tableText;

  const parsedRows: string[][] = [];
  let maxCols = 0;

  for (const line of lines) {
    const { cells } = parseRowCells(line);
    parsedRows.push(cells);
    if (cells.length > maxCols) maxCols = cells.length;
  }

  const colWidths: number[] = Array(maxCols).fill(3);

  // 计算每列最大视觉宽度
  for (let r = 0; r < parsedRows.length; r++) {
    const row = parsedRows[r];
    for (let c = 0; c < maxCols; c++) {
      const cellText = row[c] || '';
      const w = getVisualWidth(cellText);
      if (w > colWidths[c]) {
        colWidths[c] = w;
      }
    }
  }

  const formattedLines: string[] = [];

  for (let r = 0; r < parsedRows.length; r++) {
    const isSep = isSeparatorLine(lines[r]);
    const row = parsedRows[r];
    const formattedCells: string[] = [];

    for (let c = 0; c < maxCols; c++) {
      const cell = (row[c] || '').trim();
      const targetW = colWidths[c];

      if (isSep) {
        let alignType: 'left' | 'center' | 'right' | 'none' = 'none';
        if (cell.startsWith(':') && cell.endsWith(':')) alignType = 'center';
        else if (cell.endsWith(':')) alignType = 'right';
        else if (cell.startsWith(':')) alignType = 'left';

        const dashCount = Math.max(3, targetW);
        if (alignType === 'center') {
          formattedCells.push(':' + '-'.repeat(Math.max(1, dashCount - 2)) + ':');
        } else if (alignType === 'right') {
          formattedCells.push('-'.repeat(Math.max(2, dashCount - 1)) + ':');
        } else if (alignType === 'left') {
          formattedCells.push(':' + '-'.repeat(Math.max(2, dashCount - 1)));
        } else {
          formattedCells.push('-'.repeat(dashCount));
        }
      } else {
        const visualW = getVisualWidth(cell);
        const padLen = Math.max(0, targetW - visualW);
        formattedCells.push(cell + ' '.repeat(padLen));
      }
    }

    formattedLines.push(`| ${formattedCells.join(' | ')} |`);
  }

  return formattedLines.join('\n');
}

/**
 * Excel 键盘导航计算器 (Tab, Shift+Tab, Enter, Shift+Enter)
 */
export function navigateTable(
  text: string,
  cursorPos: number,
  action: 'tab' | 'shift-tab' | 'enter' | 'shift-enter'
): TableOperationResult | null {
  const table = findTableRange(text, cursorPos);
  if (!table) return null;

  const { activeLineIndex, activeCellIndex, lines, lineOffsets, separatorLineIndex } = table;

  if (action === 'tab') {
    // 1. 如果在当前行右侧还有单元格，跳到右侧单元格
    if (activeCellIndex < table.columnCount - 1) {
      const nextCell = activeCellIndex + 1;
      const rowText = lines[activeLineIndex];
      const { pipePositions, cells } = parseRowCells(rowText);
      const pipePos = pipePositions[nextCell];
      const cellText = cells[nextCell] || '';
      const cellStart = lineOffsets[activeLineIndex] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }

    // 2. 如果在行末，尝试跳到下一行第 1 单元格（跳过分隔行）
    let nextLineIdx = activeLineIndex + 1;
    if (nextLineIdx === separatorLineIndex) nextLineIdx++;

    if (nextLineIdx < lines.length) {
      const rowText = lines[nextLineIdx];
      const { pipePositions, cells } = parseRowCells(rowText);
      const pipePos = pipePositions[0];
      const cellText = cells[0] || '';
      const cellStart = lineOffsets[nextLineIdx] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }

    // 3. 如果在表格最后一行末尾，自动插入新行！
    return insertRow(text, cursorPos, 'below');
  }

  if (action === 'shift-tab') {
    // 1. 向左跳转
    if (activeCellIndex > 0) {
      const prevCell = activeCellIndex - 1;
      const rowText = lines[activeLineIndex];
      const { pipePositions, cells } = parseRowCells(rowText);
      const pipePos = pipePositions[prevCell];
      const cellText = cells[prevCell] || '';
      const cellStart = lineOffsets[activeLineIndex] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }

    // 2. 在行首，跳转到上一行最后一个单元格（跳过分隔行）
    let prevLineIdx = activeLineIndex - 1;
    if (prevLineIdx === separatorLineIndex) prevLineIdx--;

    if (prevLineIdx >= 0) {
      const rowText = lines[prevLineIdx];
      const { pipePositions, cells } = parseRowCells(rowText);
      const lastCol = Math.max(0, pipePositions.length - 2);
      const pipePos = pipePositions[lastCol];
      const cellText = cells[lastCol] || '';
      const cellStart = lineOffsets[prevLineIdx] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }

    return null;
  }

  if (action === 'enter') {
    let nextLineIdx = activeLineIndex + 1;
    if (nextLineIdx === separatorLineIndex) nextLineIdx++;

    if (nextLineIdx < lines.length) {
      const rowText = lines[nextLineIdx];
      const { pipePositions, cells } = parseRowCells(rowText);
      const targetCol = Math.min(activeCellIndex, pipePositions.length - 2);
      const pipePos = pipePositions[targetCol >= 0 ? targetCol : 0];
      const cellText = cells[targetCol] || '';
      const cellStart = lineOffsets[nextLineIdx] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }

    // 在最后一行按 Enter，自动在下方插入新行并对齐当前列
    return insertRow(text, cursorPos, 'below');
  }

  if (action === 'shift-enter') {
    let prevLineIdx = activeLineIndex - 1;
    if (prevLineIdx === separatorLineIndex) prevLineIdx--;

    if (prevLineIdx >= 0) {
      const rowText = lines[prevLineIdx];
      const { pipePositions, cells } = parseRowCells(rowText);
      const targetCol = Math.min(activeCellIndex, pipePositions.length - 2);
      const pipePos = pipePositions[targetCol >= 0 ? targetCol : 0];
      const cellText = cells[targetCol] || '';
      const cellStart = lineOffsets[prevLineIdx] + pipePos + 2;
      return {
        newText: text,
        newCursorPos: cellStart,
        selection: { start: cellStart, end: cellStart + cellText.length },
      };
    }
  }

  return null;
}

/**
 * 清空指定单元格的内容（保留表格结构与管道符）
 */
export function clearCell(text: string, cursorPos: number): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  const line = table.lines[table.activeLineIndex];
  const { pipePositions } = parseRowCells(line);
  if (table.activeCellIndex < 0 || table.activeCellIndex >= pipePositions.length - 1) {
    return { newText: text, newCursorPos: cursorPos };
  }

  const leftPipe = pipePositions[table.activeCellIndex];
  const rightPipe = pipePositions[table.activeCellIndex + 1];

  let lineOffset = table.startOffset;
  for (let i = 0; i < table.activeLineIndex; i++) {
    lineOffset += table.lines[i].length + 1;
  }

  const cellGlobalStart = lineOffset + leftPipe + 1;
  const cellGlobalEnd = lineOffset + rightPipe;

  const newText = text.substring(0, cellGlobalStart) + '  ' + text.substring(cellGlobalEnd);
  return { newText, newCursorPos: cellGlobalStart + 1 };
}

/**
 * 替换指定单元格的内容并定位光标
 */
export function setCellContent(text: string, cursorPos: number, content: string): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  const line = table.lines[table.activeLineIndex];
  const { pipePositions } = parseRowCells(line);
  if (table.activeCellIndex < 0 || table.activeCellIndex >= pipePositions.length - 1) {
    return { newText: text, newCursorPos: cursorPos };
  }

  const leftPipe = pipePositions[table.activeCellIndex];
  const rightPipe = pipePositions[table.activeCellIndex + 1];

  let lineOffset = table.startOffset;
  for (let i = 0; i < table.activeLineIndex; i++) {
    lineOffset += table.lines[i].length + 1;
  }

  const cellGlobalStart = lineOffset + leftPipe + 1;
  const cellGlobalEnd = lineOffset + rightPipe;

  const newCellStr = ` ${content.trim()} `;
  const newText = text.substring(0, cellGlobalStart) + newCellStr + text.substring(cellGlobalEnd);
  const newCursorPos = cellGlobalStart + newCellStr.length - 1;
  return { newText, newCursorPos };
}

/**
 * 解析表格分隔行各列的对齐特征
 */
export function parseTableAlignments(sepLine: string): ('left' | 'center' | 'right')[] {
  const { cells } = parseRowCells(sepLine);
  return cells.map((cell) => {
    const trimmed = cell.trim();
    const starts = trimmed.startsWith(':');
    const ends = trimmed.endsWith(':');
    if (starts && ends) return 'center';
    if (ends) return 'right';
    return 'left';
  });
}

/**
 * 在表格尾部自动追加一个新数据行（用于末格按 Tab 键自动扩充）
 */
export function appendRowAtEnd(text: string, cursorPos: number): TableOperationResult {
  const table = findTableRange(text, cursorPos);
  if (!table) return { newText: text, newCursorPos: cursorPos };

  const emptyCells = Array(table.columnCount).fill('  ');
  const newRowText = `| ${emptyCells.join(' | ')} |`;
  const newLines = [...table.lines, newRowText];

  const before = text.substring(0, table.startOffset);
  const after = text.substring(table.endOffset);
  const newTableText = newLines.join('\n');
  const newText = before + newTableText + after;

  // 定位新行第一个单元格
  const newRowStart = table.startOffset + table.lines.join('\n').length + 1;
  const newCursorPos = newRowStart + 2;
  return { newText, newCursorPos };
}

/**
 * Excel 级真实单元格合并（Merge Selected Cells）
 * 支持任意矩形选区 [minLine..maxLine] x [minCol..maxCol]
 * - 规则：左上角 (minLine, minCol) 为主合并格，右侧填补 '>'（水平合并占位），下方填补 '^'（垂直合并占位）
 * - 内容：合并选区内所有非空文字
 */
export function mergeSelectedCells(
  text: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number
): TableOperationResult {
  const minLine = Math.min(startLine, endLine);
  const maxLine = Math.max(startLine, endLine);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  if (minLine === maxLine && minCol === maxCol) {
    return { newText: text, newCursorPos: 0 };
  }

  const allLines = text.split('\n');
  if (minLine < 0 || maxLine >= allLines.length) return { newText: text, newCursorPos: 0 };

  // 收集非空文本
  const collectedTexts: string[] = [];
  for (let r = minLine; r <= maxLine; r++) {
    const { cells } = parseRowCells(allLines[r]);
    for (let c = minCol; c <= maxCol; c++) {
      const cellText = (cells[c] ?? '').trim();
      if (cellText && cellText !== '>' && cellText !== '^') {
        collectedTexts.push(cellText);
      }
    }
  }
  const mergedContent = collectedTexts.join(' ') || '  ';

  // 更新各行单元格
  for (let r = minLine; r <= maxLine; r++) {
    const { cells } = parseRowCells(allLines[r]);
    while (cells.length <= maxCol) cells.push('  ');

    for (let c = minCol; c <= maxCol; c++) {
      if (r === minLine && c === minCol) {
        cells[c] = ` ${mergedContent} `;
      } else if (r === minLine) {
        cells[c] = ' > ';
      } else {
        cells[c] = ' ^ ';
      }
    }
    allLines[r] = `| ${cells.join(' | ')} |`;
  }

  const newText = allLines.join('\n');
  let targetOffset = 0;
  for (let i = 0; i < minLine; i++) {
    targetOffset += allLines[i].length + 1;
  }
  const { pipePositions } = parseRowCells(allLines[minLine]);
  const newCursorPos = targetOffset + (pipePositions[minCol] ?? 0) + 2;

  return { newText, newCursorPos };
}

/**
 * Excel 级拆分单元格（Unmerge Cells）
 * 还原选中的主合并格或从属格所关联的所有 '>' 和 '^'
 */
export function unmergeCells(
  text: string,
  targetLine: number,
  targetCol: number
): TableOperationResult {
  const allLines = text.split('\n');
  if (targetLine < 0 || targetLine >= allLines.length) return { newText: text, newCursorPos: 0 };

  let startLine = targetLine;
  while (startLine > 0 && isTableLine(allLines[startLine - 1])) startLine--;
  let endLine = targetLine;
  while (endLine < allLines.length - 1 && isTableLine(allLines[endLine + 1])) endLine++;

  let masterRow = targetLine;
  let masterCol = targetCol;

  // 向上回溯 ^
  while (masterRow > startLine) {
    const { cells } = parseRowCells(allLines[masterRow]);
    if ((cells[masterCol] ?? '').trim() === '^') {
      masterRow--;
    } else {
      break;
    }
  }
  // 向左回溯 >
  while (masterCol > 0) {
    const { cells } = parseRowCells(allLines[masterRow]);
    if ((cells[masterCol] ?? '').trim() === '>') {
      masterCol--;
    } else {
      break;
    }
  }

  const { cells: masterRowCells } = parseRowCells(allLines[masterRow]);
  let spanCols = 1;
  while (masterCol + spanCols < masterRowCells.length && masterRowCells[masterCol + spanCols].trim() === '>') {
    spanCols++;
  }

  let spanRows = 1;
  while (masterRow + spanRows <= endLine) {
    const { cells: nextRowCells } = parseRowCells(allLines[masterRow + spanRows]);
    if (nextRowCells[masterCol]?.trim() === '^') {
      spanRows++;
    } else {
      break;
    }
  }

  for (let r = masterRow; r < masterRow + spanRows; r++) {
    const { cells } = parseRowCells(allLines[r]);
    for (let c = masterCol; c < masterCol + spanCols; c++) {
      if (r === masterRow && c === masterCol) continue;
      if (cells[c] && (cells[c].trim() === '>' || cells[c].trim() === '^')) {
        cells[c] = '  ';
      }
    }
    allLines[r] = `| ${cells.join(' | ')} |`;
  }

  const newText = allLines.join('\n');
  let targetOffset = 0;
  for (let i = 0; i < masterRow; i++) {
    targetOffset += allLines[i].length + 1;
  }
  const { pipePositions } = parseRowCells(allLines[masterRow]);
  const newCursorPos = targetOffset + (pipePositions[masterCol] ?? 0) + 2;

  return { newText, newCursorPos };
}
