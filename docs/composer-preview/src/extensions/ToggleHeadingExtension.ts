/**
 * ToggleHeadingExtension — 折叠标题 Tiptap 节点定义
 *
 * 支持 H1/H2/H3 级别的可折叠标题。
 * 点击箭头或快捷键切换折叠/展开。
 * 内容为 block+（折叠内容区域）。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ToggleHeadingView } from '../views/panel/ToggleHeadingView';
import type { HeadingLevel } from '../core/types/blocks';

export const ToggleHeadingExtension = Node.create({
  name: 'toggleHeading',
  group: 'block',
  content: 'block+',
  defining: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      level: {
        default: 2 as HeadingLevel,
        parseHTML: (el) => parseInt(el.getAttribute('data-level') || '2', 10) as HeadingLevel,
        renderHTML: (attrs) => ({ 'data-level': attrs.level }),
      },
      collapsed: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
      },
      id: {
        default: null,
        parseHTML: (el) => el.id || null,
        renderHTML: (attrs) => (attrs.id ? { id: attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggleHeading"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggleHeading' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleHeadingView);
  },
});
