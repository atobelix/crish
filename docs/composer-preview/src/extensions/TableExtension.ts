/**
 * TableExtension — 表格
 *
 * 基于 prosemirror-tables，保留它自带的列宽拖拽与单元格选区实现——
 * 那是一套经过大量边界打磨的代码，自己重写不划算。
 *
 * 因此这里**不挂 React NodeView**：一旦用 React 接管 `<table>` 的渲染，
 * columnResizing 插件维护的 `<colgroup>` 就会被 React 的 diff 冲掉。
 * 悬浮加行加列这类交互改由独立的覆盖层组件 `TableAffordances` 实现，
 * 它只读取真实 DOM 的几何信息，不介入表格自身的渲染，两边互不干扰。
 *
 * 扩展的属性：
 *   - 单元格 `backgroundColor` / `textAlign`：对应右键菜单里的颜色与对齐
 *   - 表格 `hasHeaderRow`：控制首行是否渲染为表头
 */

import { Table } from '@tiptap/extension-table/table';
import { TableRow } from '@tiptap/extension-table/row';
import { TableHeader } from '@tiptap/extension-table/header';
import { TableCell } from '@tiptap/extension-table/cell';

/** 单元格共用的扩展属性 */
function cellAttributes() {
  return {
    backgroundColor: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-bg') || null,
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.backgroundColor ? { 'data-bg': attrs.backgroundColor as string } : {},
    },
    textAlign: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || null,
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.textAlign ? { 'data-align': attrs.textAlign as string } : {},
    },
  };
}

export const TableExtension = Table.configure({
  resizable: true,
  /** 列宽拖拽把手的命中宽度，5px 太窄、10px 会误触相邻单元格 */
  handleWidth: 6,
  cellMinWidth: 56,
  lastColumnResizable: true,
  allowTableNodeSelection: true,
  HTMLAttributes: { class: 'md-table' },
});

export const TableRowExtension = TableRow;

export const TableHeaderExtension = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

export const TableCellExtension = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

/** 一次性导出，Editor 里按这个顺序注册 */
export const TABLE_EXTENSIONS = [
  TableExtension,
  TableRowExtension,
  TableHeaderExtension,
  TableCellExtension,
];
