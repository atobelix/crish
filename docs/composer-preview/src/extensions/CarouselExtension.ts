import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CarouselBlockView } from '../views/panel/CarouselBlockView';

export const CarouselExtension = Node.create({
  name: 'carouselBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      images: { default: [] },        // Array<{ src: string; alt: string; caption: string }>
      activeIndex: { default: 0 },     // 当前显示的图片索引
      autoPlay: { default: false },    // 是否自动轮播
      interval: { default: 5000 },     // 自动轮播间隔 ms
    };
  },

  parseHTML() { return [{ tag: 'div[data-type="carousel"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', { 'data-type': 'carousel', ...HTMLAttributes }]; },
  addNodeView() { return ReactNodeViewRenderer(CarouselBlockView); },
});
