/**
 * BreadcrumbExtension — 路径栏 Tiptap 节点定义
 */

import { Node, mergeAttributes } from '@tiptap/core';

export const BreadcrumbExtension = Node.create({
  name: 'breadcrumb',
  group: 'block',
  content: '',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="breadcrumb"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'breadcrumb' }), 0];
  },
});
