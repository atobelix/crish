/**
 * ToggleListExtension — 折叠列表 Tiptap 节点定义
 *
 * 支持可折叠的列表项。类似 Notion 的 Toggle List。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ToggleListView } from '../views/panel/ToggleListView';

export const ToggleListExtension = Node.create({
  name: 'toggleList',
  group: 'block',
  content: 'block+',
  defining: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      collapsed: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggleList"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggleList' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleListView);
  },
});
