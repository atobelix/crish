/**
 * MermaidExtension — Mermaid 图表块 Tiptap 节点定义
 *
 * content: 'text*'，存储 Mermaid 语法文本。
 * MermaidBlockView 在渲染模式下使用 mermaid.js 输出 SVG。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MermaidBlockView } from '../views/fenced/MermaidBlockView';

export const MermaidExtension = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  draggable: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="mermaidBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mermaidBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidBlockView);
  },
});
