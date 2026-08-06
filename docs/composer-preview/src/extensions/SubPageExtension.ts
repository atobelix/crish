/**
 * SubPageExtension — 子页面链接 Tiptap 节点定义
 */

import { Node, mergeAttributes } from '@tiptap/core';

export const SubPageExtension = Node.create({
  name: 'subPage',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: '' },
      title: { default: '未命名页面' },
      icon: { default: '📄' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="subPage"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'subPage' }), 0];
  },
});
