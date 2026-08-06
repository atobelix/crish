/**
 * AIBlockExtension — AI 生成块 Tiptap 节点定义
 *
 * atom 节点，AIBlockView 提供 Prompt 输入 + 流式输出 UI。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { AIBlockView } from '../views/panel/AIBlockView';

export const AIBlockExtension = Node.create({
  name: 'aiBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      prompt: { default: '' },
      status: { default: 'idle' },
      model: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="aiBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'aiBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AIBlockView);
  },
});
