/**
 * tableCommands — 表格操作的统一封装
 *
 * prosemirror-tables 的命令都作用于「当前选区所在的单元格」，
 * 所以要对某一行/某一列动手，必须先把选区挪进那个单元格。
 * 这里把「定位 + 执行」打包起来，让覆盖层的按钮可以直接按行列号调用。
 */

import type { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';

/**
 * 把选区移进给定的单元格 DOM。
 *
 * @returns 是否定位成功
 */
export function focusCell(editor: Editor, cell: HTMLElement): boolean {
  try {
    const pos = editor.view.posAtDOM(cell, 0);
    if (pos < 0) return false;
    const resolved = editor.state.doc.resolve(pos);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(resolved)).scrollIntoView(),
    );
    return true;
  } catch {
    return false;
  }
}

/** 选中整行（用 CellSelection，这样删除/着色能一次作用于整行） */
export function selectRow(editor: Editor, cell: HTMLElement): boolean {
  try {
    const pos = editor.view.posAtDOM(cell, 0);
    const $anchor = editor.state.doc.resolve(pos);
    const selection = CellSelection.rowSelection($anchor);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

/** 选中整列 */
export function selectColumn(editor: Editor, cell: HTMLElement): boolean {
  try {
    const pos = editor.view.posAtDOM(cell, 0);
    const $anchor = editor.state.doc.resolve(pos);
    const selection = CellSelection.colSelection($anchor);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────
 * 行操作
 * ──────────────────────────────────────────── */

export function insertRowAbove(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().addRowBefore().run();
}

export function insertRowBelow(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().addRowAfter().run();
}

export function deleteRow(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().deleteRow().run();
}

/** 复制一行：先在下方插入空行，再把原行内容逐格搬过去 */
export function duplicateRow(editor: Editor, cell: HTMLElement): void {
  const row = cell.closest('tr');
  if (!row || !focusCell(editor, cell)) return;
  const texts = Array.from(row.cells).map((c) => c.textContent ?? '');
  editor.chain().focus().addRowAfter().run();

  const newRow = row.nextElementSibling as HTMLTableRowElement | null;
  if (!newRow) return;
  texts.forEach((text, index) => {
    const targetCell = newRow.cells[index];
    if (!targetCell || !text) return;
    const pos = editor.view.posAtDOM(targetCell, 0);
    editor.chain().insertContentAt(pos, text).run();
  });
}

/* ────────────────────────────────────────────
 * 列操作
 * ──────────────────────────────────────────── */

export function insertColumnLeft(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().addColumnBefore().run();
}

export function insertColumnRight(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().addColumnAfter().run();
}

export function deleteColumn(editor: Editor, cell: HTMLElement): void {
  if (focusCell(editor, cell)) editor.chain().focus().deleteColumn().run();
}

/* ────────────────────────────────────────────
 * 追加（右下边缘的加行加列条）
 * ──────────────────────────────────────────── */

/** 在表格末尾追加一列 */
export function appendColumn(editor: Editor, geometryLastCell: HTMLElement): void {
  if (focusCell(editor, geometryLastCell)) editor.chain().focus().addColumnAfter().run();
}

/** 在表格末尾追加一行 */
export function appendRow(editor: Editor, geometryLastCell: HTMLElement): void {
  if (focusCell(editor, geometryLastCell)) editor.chain().focus().addRowAfter().run();
}

/* ────────────────────────────────────────────
 * 单元格
 * ──────────────────────────────────────────── */

export function setCellBackground(editor: Editor, color: string | null): void {
  editor.chain().focus().setCellAttribute('backgroundColor', color).run();
}

export function setCellAlign(editor: Editor, align: 'left' | 'center' | 'right' | null): void {
  editor.chain().focus().setCellAttribute('textAlign', align).run();
}

export function clearCells(editor: Editor): void {
  const { state } = editor;
  const selection = state.selection;
  if (!(selection instanceof CellSelection)) {
    editor.chain().focus().selectAll().deleteSelection().run();
    return;
  }
  const tr = state.tr;
  // 从后往前删，避免前面的删除让后面的位置失效
  const ranges: Array<{ from: number; to: number }> = [];
  selection.forEachCell((cellNode, pos) => {
    ranges.push({ from: pos + 1, to: pos + cellNode.nodeSize - 1 });
  });
  for (const range of ranges.reverse()) tr.delete(range.from, range.to);
  editor.view.dispatch(tr);
}

export function toggleHeaderRow(editor: Editor): void {
  editor.chain().focus().toggleHeaderRow().run();
}

export function mergeOrSplitCells(editor: Editor): void {
  editor.chain().focus().mergeOrSplit().run();
}

export function deleteTable(editor: Editor): void {
  editor.chain().focus().deleteTable().run();
}
