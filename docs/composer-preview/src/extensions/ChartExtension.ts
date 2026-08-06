/**
 * ChartExtension — ECharts 图表块 Tiptap 节点定义
 *
 * atom 节点，ChartBlockView 提供图表类型选择 + 数据编辑面板。
 * config 属性存储 JSON 格式的 ECharts option。
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ChartBlockView } from '../views/panel/ChartBlockView';

export const ChartExtension = Node.create({
  name: 'chartBlock',
  group: 'block',
  content: '',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      chartType: { default: 'bar' },
      config: { default: '{}' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="chartBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'chartBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChartBlockView);
  },
});
