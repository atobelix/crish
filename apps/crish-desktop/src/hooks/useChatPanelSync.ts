/**
 * 对话面板同步 hook。
 *
 * I5 后树上无 tool 叶，不再检测孤儿功能区、不再 reprojectAllSessionDocks。
 * 仅 ensure 至少 1 个 chat 叶；同 session 去重留给维 02 persist 损坏兜底。
 */

import { useEffect } from 'react';
import {
  useLayoutTreeStore,
  dedupeDuplicateSessionChatLeaves,
} from '../store/layout-tree';
import { ensureAdapterShape } from '../store/workspace-shell';
import { getCompositionRoot } from '../app/compositionRoot';

/**
 * 挂载后与 tree 结构变更时：
 * - ensure 至少 1 个 chat leaf（不强制单 chat，不造 tool 叶）
 * - dedupe 同 sessionId 的重复 chat leaves（损坏兜底）
 */
export function useChatPanelSync(): void {
  const treeVersion = useLayoutTreeStore((s) => s.tree.version);
  const rootType = useLayoutTreeStore((s) => s.tree.root.type);
  const rootId = useLayoutTreeStore((s) => s.tree.root.id);

  useEffect(() => {
    ensureAdapterShape();

    const store = getCompositionRoot().tree.getState();
    const next = dedupeDuplicateSessionChatLeaves(store.tree);
    if (next !== store.tree) {
      store.setTree(next);
    }
  }, [treeVersion, rootType, rootId]);
}
