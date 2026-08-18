/**
 * Shell ↔ layout-tree leaf 绑定助手（纯结构性，无自身状态）。
 *
 * 职责：归一化 / 摘 unit / 切邻居投影判定 / tab↔chat-leaf 1:1 绑定。
 * 均直接操作 useLayoutTreeStore，供 workspaceShellStore action 复用。
 */

import type { RightToolDockState } from './types';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  findNodeById,
  findUnitRootId,
  isBranch,
  listChatLeaves,
  removeUnitBySessionId,
  dedupeDuplicateSessionChatLeaves,
} from '../layout-tree';
import { ensureAdapterShape } from './adapterShape';

/**
 * 归一化：去掉同 session 重复 chat leaf，写回 store（有变更才 setTree）。
 * 任意 lifecycle 写树后应调用。
 * T06.9.1：跨 store 读经 compositionRoot.tree 门面（阻断对 layoutTreeStore 的直接 import 环）。
 */
export function dedupeSessionLeavesInStore(): void {
  const store = useLayoutTreeStore.getState();
  const next = dedupeDuplicateSessionChatLeaves(store.tree);
  if (next !== store.tree) {
    store.setTree(next);
  }
}

/**
 * 关闭 tab 时摘掉该 session 的 Conversation Unit（chat + tool 子树），再 dedupe。
 * 不强制 wipe 其它 unit 的 multi 布局。
 */
export function removeSessionUnitFromTree(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  const store = useLayoutTreeStore.getState();
  const next = removeUnitBySessionId(store.tree, sid);
  if (next !== store.tree) {
    store.setTree(next);
  }
  dedupeSessionLeavesInStore();
}

/**
 * closeTab 切邻居时是否需要补投影 dock。
 * 纯 focus 不投影；仅当邻居 tab 声明 dock 展开、但树上该 unit 仍是 chat-only（缺 tool）时补一次。
 * 多 unit 树上邻居工具已在则跳过，避免关 tab 副作用折叠/重投影。
 */
export function neighborDockNeedsProject(
  sessionId: string,
  dock: RightToolDockState
): boolean {
  const sid = (sessionId || '').trim();
  if (!sid) return false;
  // 折叠 / 无 active 面板：不因 focus 去剥树
  if (dock.collapsed || !dock.activePanelId) return false;

  const layout = useLayoutTreeStore.getState();
  const unitId = findUnitRootId(layout.tree.root, sid);
  if (!unitId) return true;
  const unit = findNodeById(layout.tree.root, unitId);
  if (!unit) return true;
  // 已有 H(chat|tool) unit → 多 unit 状态已就位，跳过
  if (isBranch(unit)) return false;
  // chat-only leaf 但 tab 声明 dock 展开 → 需要补投影
  return true;
}

/**
 * 顶栏 tab ↔ chat leaf 1:1 绑定。
 *
 * 规则：
 * 1. 已有 bound leaf → setActiveLeaf 聚焦（不改其它 unit）
 * 2. 无 leaf 且仅 1 个 chat → 把该 leaf 绑到 session（单屏切 tab）
 * 3. 多 chat 且恰好 1 个 unbound → 绑 unbound
 * 4. 多 chat 且无可用 unbound → 不 auto-split（tab 可开而无 leaf，待用户 split）
 * 5. 零 chat → ensureAdapterShape 注入后再绑
 *
 * 注意：focus 永不 applyDockToTree；坞投影仅 updateRightDock / openTool / 恢复路径。
 */
export function bindActiveChatLeafSession(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;

  dedupeSessionLeavesInStore();

  let store = useLayoutTreeStore.getState();
  let chats = listChatLeaves(store.tree.root);

  if (chats.length === 0) {
    ensureAdapterShape();
    store = useLayoutTreeStore.getState();
    chats = listChatLeaves(store.tree.root);
  }

  // 1. 已有绑定 → 聚焦
  const bound = findChatLeafBySessionId(store.tree.root, sid);
  if (bound) {
    if (store.activeLeafId !== bound.id) {
      store.setActiveLeaf(bound.id);
    }
    return;
  }

  if (chats.length === 0) return;

  // 2. 单 chat 表面：切 tab 时 rebind（经典单屏多 tab）
  if (chats.length === 1) {
    const only = chats[0]!;
    if (only.sessionId !== sid) {
      store.setLeafSessionId(only.id, sid);
    }
    if (store.activeLeafId !== only.id) {
      store.setActiveLeaf(only.id);
    }
    return;
  }

  // 3. 多 chat：仅绑恰好一个 unbound leaf，禁止偷别人的 session、禁止 auto-split
  const unbound = chats.filter((l) => !l.sessionId);
  if (unbound.length === 1) {
    const target = unbound[0]!;
    store.setLeafSessionId(target.id, sid);
    if (store.activeLeafId !== target.id) {
      store.setActiveLeaf(target.id);
    }
  }
  // else: tab 打开但无可见 unit，等待用户 split 放置
}
