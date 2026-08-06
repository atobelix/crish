/**
 * ImageExtension — 图片块 Tiptap 节点定义
 *
 * 注册 'imageBlock' 节点到 ProseMirror Schema。
 * 支持 src / alt / caption / alignment / width / height 属性。
 * atom 节点，通过 ImageBlockView 面板交互编辑。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageBlockView } from '../views/panel/ImageBlockView';

export const ImageExtension = Node.create({
  name: 'imageBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '', parseHTML: (el) => el.getAttribute('src') || '' },
      alt: { default: '', parseHTML: (el) => el.getAttribute('alt') || '' },
      title: { default: '', parseHTML: (el) => el.getAttribute('title') || '' },
      width: { default: null, parseHTML: (el) => parseInt(el.getAttribute('width') || '', 10) || null },
      height: { default: null, parseHTML: (el) => parseInt(el.getAttribute('height') || '', 10) || null },
      alignment: { default: 'center', parseHTML: (el) => el.getAttribute('data-alignment') || 'center' },
      caption: { default: '', parseHTML: (el) => el.getAttribute('data-caption') || '' },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="imageBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-type': 'imageBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageBlockView);
  },
});
