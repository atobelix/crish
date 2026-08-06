/**
 * ButtonExtension — 按钮块 Tiptap 节点定义
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ButtonBlockView } from '../views/panel/ButtonBlockView';

export const ButtonExtension = Node.create({
  name: 'buttonBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      label: { default: 'Button' },
      action: { default: 'open_url' },
      url: { default: '' },
      variant: { default: 'primary' },
      size: { default: 'md' },
      icon: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="buttonBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'buttonBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ButtonBlockView);
  },
});
