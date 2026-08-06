/**
 * DiffExtension — 代码差异对比块
 *
 * 内容是标准的 unified diff 文本（`+` / `-` / ` ` 前缀），
 * 由 DiffView 解析成带行号与增删着色的表格。
 *
 * 与代码块的区别：diff 的语义在于「两个版本的对照」，
 * 因此它不需要语言选择器与语法高亮，而需要行号双列（旧行号 / 新行号）
 * 与增删统计——这是两种同的阅读任务，合并成一个块类型只会互相拖累。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DiffView } from '../views/fenced/DiffView';

export const DiffExtension = Node.create({
  name: 'diffBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      filename: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-filename') || '',
        renderHTML: (attrs) => (attrs.filename ? { 'data-filename': attrs.filename } : {}),
      },
      viewMode: {
        default: 'unified',
        parseHTML: (el) => el.getAttribute('data-view-mode') || 'unified',
        renderHTML: (attrs) => ({ 'data-view-mode': attrs.viewMode }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'pre[data-type="diffBlock"]', preserveWhitespace: 'full' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-type': 'diffBlock' }),
      ['code', 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiffView);
  },
});
