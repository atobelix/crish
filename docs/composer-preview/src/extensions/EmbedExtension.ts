/**
 * EmbedExtension — 嵌入块 Tiptap 节点定义
 *
 * 支持 iframe / HTML / PDF / Word / Excel 嵌入。
 * atom 节点，EmbedBlockView 根据 type 选择渲染方式。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { EmbedBlockView } from '../views/panel/EmbedBlockView';

export const EmbedExtension = Node.create({
  name: 'embedBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      url: { default: '' },
      type: { default: 'iframe' },
      width: { default: null },
      height: { default: 400 },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embedBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'embedBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedBlockView);
  },
});
