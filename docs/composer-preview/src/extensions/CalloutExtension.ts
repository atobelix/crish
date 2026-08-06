/**
 * CalloutExtension — Callout 提示区块的 Tiptap 节点定义
 *
 * 注册 'callout' 节点类型到 ProseMirror Schema。
 * 支持 5 种类型：note / tip / important / warning / caution
 * 使用 CalloutView 作为 React NodeView 渲染器。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CalloutView } from '../views/fenced/CalloutView';
import type { CalloutType } from '../core/types/blocks';

/** Callout 默认属性 */
const DEFAULT_CALLOUT_TYPE: CalloutType = 'note';

export const CalloutExtension = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      type: {
        default: DEFAULT_CALLOUT_TYPE,
        parseHTML: (el) => el.getAttribute('data-callout-type') || DEFAULT_CALLOUT_TYPE,
        renderHTML: (attrs) => ({ 'data-callout-type': attrs.type }),
      },
      icon: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-callout-icon') || '',
        renderHTML: (attrs) => (attrs.icon ? { 'data-callout-icon': attrs.icon } : {}),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-callout-title') || '',
        renderHTML: (attrs) => (attrs.title ? { 'data-callout-title': attrs.title } : {}),
      },
      collapsed: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
