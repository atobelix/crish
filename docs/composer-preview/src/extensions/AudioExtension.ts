/**
 * AudioExtension — 音频块 Tiptap 节点定义
 *
 * atom 节点，支持本地文件或 URL 音频。
 * AudioBlockView 提供自定义播放器 UI。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { AudioBlockView } from '../views/panel/AudioBlockView';

export const AudioExtension = Node.create({
  name: 'audioBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      title: { default: '' },
      caption: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="audioBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'audioBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AudioBlockView);
  },
});
