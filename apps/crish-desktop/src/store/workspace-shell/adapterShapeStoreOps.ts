/**
 * Adapter Store 写入 API。
 *
 * 本模块仅保留：
 *  - ensureAdapterShape：无 chat 叶时注入 1 个（I2 兜底）
 */

import { useLayoutTreeStore } from '../layout-tree';
import { createLeaf, type LayoutTree } from '../layout-tree/types';
import { countChatLeaves } from './adapterShapeTreeOps';

/**
 * 至少 1 个 chat 叶。已有 chat 则原样。
 * 不再 normalize 出 tool 叶。
 */
export function ensureAdapterShape(): void {
  const store = useLayoutTreeStore.getState();
  const before = store.tree;
  const chatCount = countChatLeaves(before.root);
  if (chatCount >= 1) return;

  const chatLeaf = createLeaf();
  const tree: LayoutTree = { version: before.version, root: chatLeaf };
  store.setTree(tree);
  store.setActiveLeaf(chatLeaf.id);
}

