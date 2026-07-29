/**
 * 对话面板同步 hook（Shell redesign Phase 2）。
 *
 * 旧行为：activeSessionId 有值且无 chat leaf → focusOrOpenTreePanel('chat') 强制 split。
 * Phase 1：盲调 ensureAdapterShape（恰好 1 chat）。
 * Phase 2：至少 1 个 chat leaf + 同 session 去重；**允许** multi-chat，禁止单 chat 折叠。
 * Phase 3：检测孤儿功能区（tool 未挂在对应 session 的 H(chat|tools) unit 内）并重投影。
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md U4
 */

import { useEffect, useRef } from 'react';
import {
  useLayoutTreeStore,
  dedupeDuplicateSessionChatLeaves,
  listChatLeaves,
  listToolLeaves,
  findUnitRootId,
} from '../store/layout-tree';
import type { LayoutNode } from '../store/layout-tree/types';
import {
  ensureAdapterShape,
  reprojectAllSessionDocks,
} from '../store/workspace-shell';
import { getCompositionRoot } from '../app/compositionRoot';

/**
 * 孤儿功能区：
 * - tool 无 sessionId
 * - tool 的 session 在树中无 chat
 * - findUnitRootId 退回为 chat leaf（说明 tool 未与 chat 组成 unit）却树中仍有该 session 的 tool
 */
function hasOrphanToolLeaves(root: LayoutNode): boolean {
  const tools = listToolLeaves(root);
  if (tools.length === 0) return false;

  for (const tool of tools) {
    const sid = (tool.sessionId || '').trim();
    if (!sid) return true;

    const chat = listChatLeaves(root).find((c) => c.sessionId === sid);
    if (!chat) return true;

    const unitId = findUnitRootId(root, sid);
    // unit 仅 chat leaf → tool 不在配对 H 内 → 孤儿
    if (!unitId || unitId === chat.id) return true;
  }
  return false;
}

/**
 * 挂载后与 tree 结构变更时：
 * - ensure 至少 1 个 chat leaf（不强制单 chat）
 * - dedupe 同 sessionId 的重复 chat leaves
 * - 孤儿 tool → reprojectAllSessionDocks（按 shell rightDock 重挂 unit）
 */
export function useChatPanelSync(): void {
  const treeVersion = useLayoutTreeStore((s) => s.tree.version);
  const rootType = useLayoutTreeStore((s) => s.tree.root.type);
  const rootId = useLayoutTreeStore((s) => s.tree.root.id);
  const reprojectingRef = useRef(false);

  useEffect(() => {
    if (reprojectingRef.current) return;

    ensureAdapterShape();

    const store = getCompositionRoot().tree.getState();
    const next = dedupeDuplicateSessionChatLeaves(store.tree);
    if (next !== store.tree) {
      store.setTree(next);
    }

    const root = getCompositionRoot().tree.getState().tree.root;
    if (hasOrphanToolLeaves(root)) {
      reprojectingRef.current = true;
      try {
        reprojectAllSessionDocks();
      } finally {
        queueMicrotask(() => {
          reprojectingRef.current = false;
        });
      }
    }
  }, [treeVersion, rootType, rootId]);
}
