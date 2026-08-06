/**
 * TabsExtension — 选项卡块 Tiptap 节点定义
 *
 * 注册两个节点:
 * - tabsBlock: 容器，管理 Tab 标签列表
 * - tabPanel: 每个 Tab 的内容面板
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { TabsBlockView } from '../views/panel/TabsBlockView';

/** TabPanel 子节点 — 每个 Tab 的内容区域 */
export const TabPanelNode = Node.create({
  name: 'tabPanel',
  group: '',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      tabId: { default: '' },
      label: { default: 'Tab' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tabPanel"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tabPanel' }), 0];
  },
});

/** TabsBlock 容器节点 */
export const TabsExtension = Node.create({
  name: 'tabsBlock',
  group: 'block',
  content: 'tabPanel{1,10}',
  defining: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      activeTabId: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tabsBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tabsBlock' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TabsBlockView);
  },
});
