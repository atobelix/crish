/**
 * TOCExtension — 目录块 Tiptap 节点定义
 *
 * atom 节点，自动扫描文档中的标题生成目录。
 * TOCBlockView 负责渲染和实时更新。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TOCBlockView } from '../views/panel/TOCBlockView';

export const TOCExtension = Node.create({
  name: 'tableOfContents',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="tableOfContents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tableOfContents' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TOCBlockView);
  },
});
