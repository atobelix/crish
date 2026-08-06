/**
 * ColumnLayoutExtension — 多列布局 Tiptap 节点定义
 *
 * 注册两个节点:
 * - columnLayout: 容器节点，包含 2~5 个 column 子节点
 * - column: 每列内容区域，允许放置任意块节点
 *
 * 使用 ColumnLayoutView 作为 React NodeView。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ColumnLayoutView } from '../views/panel/ColumnLayoutView';

/** Column 子节点 — 每列的内容容器 */
export const ColumnNode = Node.create({
  name: 'column',
  group: '',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => el.style.width || null,
        renderHTML: (attrs) => (attrs.width ? { style: `width: ${attrs.width}` } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column' }), 0];
  },
});

/** ColumnLayout 容器节点 */
export const ColumnLayoutExtension = Node.create({
  name: 'columnLayout',
  group: 'block',
  content: 'column{2,5}',
  defining: true,
  draggable: true,
  selectable: false,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (el) => parseInt(el.getAttribute('data-columns') || '2', 10),
        renderHTML: (attrs) => ({ 'data-columns': attrs.columns }),
      },
      ratios: {
        default: [1, 1],
        parseHTML: (el) => {
          const raw = el.getAttribute('data-ratios');
          return raw ? JSON.parse(raw) : [1, 1];
        },
        renderHTML: (attrs) => ({ 'data-ratios': JSON.stringify(attrs.ratios) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columnLayout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columnLayout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnLayoutView);
  },
});
