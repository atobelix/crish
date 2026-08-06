/**
 * MathBlockExtension — 数学公式块的 Tiptap 节点定义
 *
 * 注册 'mathBlock' 节点类型到 ProseMirror Schema。
 * 内容为原始 LaTeX 文本，由 MathBlockView 渲染为 KaTeX 输出。
 *
 * 设计：atom 节点（不可在内部放置光标），
 * 公式文本存储在 attrs.formula 中，编辑通过弹窗完成。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MathBlockView } from '../views/panel/MathBlockView';

export const MathBlockExtension = Node.create({
  name: 'mathBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      formula: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-formula') || '',
        renderHTML: (attrs) => ({ 'data-formula': attrs.formula }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mathBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mathBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView);
  },
});
