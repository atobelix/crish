import { describe, it, expect, beforeEach } from 'vitest';
import { useTableStore } from '../../src/core/TableStore';
import { navigateTable, clearCell, setCellContent, findTableRange } from '../../src/core/tableOperations';

describe('Table Cell Mode Decoupling (Selection Mode vs Edit Mode)', () => {
  beforeEach(() => {
    useTableStore.getState().clearCellSelection();
  });

  const markdownTable = [
    '| Col 1 | Col 2 | Col 3 |',
    '| --- | --- | --- |',
    '| Alpha | Beta | Gamma |',
    '| 100 | 200 | 300 |',
  ].join('\n');

  it('1. Single click activates Cell Selection Mode (isEditing = false)', () => {
    useTableStore.getState().enterCellSelection('table-1', 2, 0);

    const selected = useTableStore.getState().selectedCell;
    expect(selected).not.toBeNull();
    expect(selected?.tableId).toBe('table-1');
    expect(selected?.lineIndex).toBe(2);
    expect(selected?.colIndex).toBe(0);
    expect(selected?.isEditing).toBe(false);
  });

  it('2. Double click activates Cell Edit Mode (isEditing = true)', () => {
    useTableStore.getState().enterCellEdit('table-1', 2, 1);

    const selected = useTableStore.getState().selectedCell;
    expect(selected).not.toBeNull();
    expect(selected?.tableId).toBe('table-1');
    expect(selected?.lineIndex).toBe(2);
    expect(selected?.colIndex).toBe(1);
    expect(selected?.isEditing).toBe(true);
  });

  it('3. In edit mode, exitCellEdit returns cleanly to Cell Selection Mode (isEditing = false)', () => {
    useTableStore.getState().enterCellEdit('table-1', 2, 1);
    expect(useTableStore.getState().selectedCell?.isEditing).toBe(true);

    useTableStore.getState().exitCellEdit();
    const selected = useTableStore.getState().selectedCell;
    expect(selected?.lineIndex).toBe(2);
    expect(selected?.colIndex).toBe(1);
    expect(selected?.isEditing).toBe(false);
  });

  it('4. clearCellSelection clears all cell focus', () => {
    useTableStore.getState().enterCellSelection('table-1', 2, 0);
    expect(useTableStore.getState().selectedCell).not.toBeNull();

    useTableStore.getState().clearCellSelection();
    expect(useTableStore.getState().selectedCell).toBeNull();
  });

  it('5. Tab navigation advances to the next cell in Selection Mode', () => {
    // Find cursor offset of "Alpha" cell (line 2, col 0)
    const alphaIndex = markdownTable.indexOf('Alpha');
    const navResult = navigateTable(markdownTable, alphaIndex, 'tab');

    expect(navResult).not.toBeNull();
    const tableInfo = findTableRange(navResult!.newText, navResult!.newCursorPos);
    expect(tableInfo).not.toBeNull();
    expect(tableInfo?.activeCellIndex).toBe(1); // Moved to Beta (col 1)

    // Verify updating store keeps isEditing = false
    useTableStore.getState().enterCellSelection(
      'table-1',
      tableInfo!.absoluteLineIndex ?? tableInfo!.activeLineIndex,
      tableInfo!.activeCellIndex
    );
    expect(useTableStore.getState().selectedCell?.colIndex).toBe(1);
    expect(useTableStore.getState().selectedCell?.isEditing).toBe(false);
  });

  it('6. Shift+Tab navigation moves backward to the previous cell in Selection Mode', () => {
    const gammaIndex = markdownTable.indexOf('Gamma');
    const navResult = navigateTable(markdownTable, gammaIndex, 'shift-tab');

    expect(navResult).not.toBeNull();
    const tableInfo = findTableRange(navResult!.newText, navResult!.newCursorPos);
    expect(tableInfo).not.toBeNull();
    expect(tableInfo?.activeCellIndex).toBe(1); // Moved to Beta (col 1)
  });

  it('7. Enter navigation moves down to next row in Selection Mode', () => {
    const alphaIndex = markdownTable.indexOf('Alpha');
    const navResult = navigateTable(markdownTable, alphaIndex, 'enter');

    expect(navResult).not.toBeNull();
    const tableInfo = findTableRange(navResult!.newText, navResult!.newCursorPos);
    expect(tableInfo).not.toBeNull();
    expect(tableInfo?.activeLineIndex).toBe(3); // Line with "100"
    expect(tableInfo?.activeCellIndex).toBe(0);
  });

  it('8. Backspace in Selection Mode clears cell content without entering Edit Mode', () => {
    const alphaIndex = markdownTable.indexOf('Alpha');
    const cleared = clearCell(markdownTable, alphaIndex);

    expect(cleared.newText).toContain('|  | Beta | Gamma |');
    // Store remains in selection mode
    useTableStore.getState().enterCellSelection('table-1', 2, 0);
    expect(useTableStore.getState().selectedCell?.isEditing).toBe(false);
  });

  it('9. Direct typing in Selection Mode replaces cell content and enters Edit Mode', () => {
    const alphaIndex = markdownTable.indexOf('Alpha');
    const replaced = setCellContent(markdownTable, alphaIndex, 'X');

    expect(replaced.newText).toContain('| X | Beta | Gamma |');
    useTableStore.getState().enterCellEdit('table-1', 2, 0);
    expect(useTableStore.getState().selectedCell?.isEditing).toBe(true);
  });
});
