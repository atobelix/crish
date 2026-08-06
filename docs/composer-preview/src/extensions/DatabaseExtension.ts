/**
 * DatabaseExtension — 数据库块 Tiptap 节点定义
 *
 * atom 节点，DatabaseView 根据当前视图类型（table/kanban/gallery/calendar/list/form）
 * 渲染对应的数据库视图组件。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DatabaseView } from '../views/panel/database/DatabaseView';

export const DatabaseExtension = Node.create({
  name: 'databaseBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      schemaId: { default: '' },
      viewType: { default: 'table' },
      title: { default: '未命名数据库' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="databaseBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'databaseBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DatabaseView);
  },
});
