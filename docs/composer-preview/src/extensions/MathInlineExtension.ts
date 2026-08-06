/**
 * MathInlineExtension — 行内数学公式节点定义
 *
 * 注册 'mathInline' 行内节点。用户输入 $...$ 后自动识别为行内公式。
 * atom 节点，公式文本在 attrs.formula 中，MathInlineView 负责渲染。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MathInlineView } from '../views/inline/MathInlineView';

export const MathInlineExtension = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
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
    return [{ tag: 'span[data-type="mathInline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mathInline' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },
});
