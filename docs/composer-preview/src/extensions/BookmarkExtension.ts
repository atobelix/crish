/**
 * BookmarkExtension — 网页书签块 Tiptap 节点定义
 *
 * atom 节点，存储 url/title/description/thumbnail/favicon。
 * BookmarkBlockView 渲染为 OG 卡片。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { BookmarkBlockView } from '../views/panel/BookmarkBlockView';

export const BookmarkExtension = Node.create({
  name: 'bookmarkBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      url: { default: '' },
      title: { default: '' },
      description: { default: '' },
      thumbnail: { default: '' },
      favicon: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="bookmarkBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'bookmarkBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BookmarkBlockView);
  },
});
