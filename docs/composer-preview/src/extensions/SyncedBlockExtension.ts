/**
 * SyncedBlockExtension — 同步区块 Tiptap 节点定义
 */

import { Node, mergeAttributes } from '@tiptap/core';

export const SyncedBlockExtension = Node.create({
  name: 'syncedBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  draggable: true,

  addAttributes() {
    return {
      sourceId: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="syncedBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'syncedBlock' }), 0];
  },
});
