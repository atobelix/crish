/**
 * FileExtension — 文件附件块 Tiptap 节点定义
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { FileBlockView } from '../views/panel/FileBlockView';

export const FileExtension = Node.create({
  name: 'fileBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      name: { default: '' },
      size: { default: 0 },
      mimeType: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="fileBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'fileBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileBlockView);
  },
});
