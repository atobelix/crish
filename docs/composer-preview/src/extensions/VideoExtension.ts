/**
 * VideoExtension — 视频块 Tiptap 节点定义
 *
 * 支持 YouTube / Bilibili / Vimeo / MP4 嵌入。
 * atom 节点，provider 自动从 URL 解析。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { VideoBlockView } from '../views/panel/VideoBlockView';

export const VideoExtension = Node.create({
  name: 'videoBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      provider: { default: 'mp4' },
      width: { default: null },
      height: { default: null },
      caption: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="videoBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'videoBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoBlockView);
  },
});
