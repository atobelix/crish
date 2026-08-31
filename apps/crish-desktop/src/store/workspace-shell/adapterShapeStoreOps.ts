/**
 * Phase 2 Adapter — Store 写入 API（命令式投影入口）。
 *
 * 本模块从 adapterShape.ts 拆出，仅含读写 store 的命令式函数：
 * applyDockToTree / applyDockToSession / reprojectAllSessionDocks /
 * ensureChatOnlyTree / ensureChatPlusSingleToolLeaf / ensureAdapterShape。
 * 纯树操作见 adapterShapeTreeOps.ts；hub re-export 见 adapterShape.ts。
 *
 * T06.9.1：所有投影入口经 withTreeDockProjectionSuppressed 保护，消除回环。
 */

import {
  useLayoutTreeStore,
  collectLeaves,
  findNodeById,
  isLeaf,
  isBranch,
  findChatLeafBySessionId,
  findUnitRootId,
  listChatLeaves,
} from '../layout-tree';
import { viewRegistry } from '../../services/view-registry';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
  type LayoutLeaf,
} from '../layout-tree/types';
import { findParent } from '../layout-tree/operations';
import type { RightToolDockState } from './types';
import { getShellReadApi } from './shellReadBridge';
import { withTreeDockProjectionSuppressed } from './treeDockProjection';
import { getActiveSessionId } from '../../api/storeAccess';
import {
  countChatLeaves,
  countToolLeaves,
  clampDockWidthRatio,
  replaceNode,
  isToolDomainSubtree,
  projectDockOntoTree,
  stripToolLeavesPreserveChats,
  normalizeToAdapterShape,
} from './adapterShapeTreeOps';
import { findActiveToolLeaf, resolveToolSubtree } from './tabModeToolSubtree';
import { readTabModeEnabled } from './tabModeReadBridge';

// ── session 解析（store 路径） ───────────────────────────────────────

/**
 * 解析 applyDock 目标 sessionId。
 * 显式参数优先；否则活动 shell tab；再退到活动 chat leaf / 首个带 session 的 chat。
 */
function resolveTargetSessionId(explicit?: string): string | null {
  const sid = (explicit || '').trim();
  if (sid) return sid;

  // 活动 shell tab（运行期调用；经 shellReadBridge 注册式读取，避免 store 环）
  try {
    const tab = getShellReadApi()?.getActiveTab();
    if (tab?.sessionId) return tab.sessionId;
  } catch {
    /* 循环初始化窗口内忽略，走 tree 回退 */
  }

  try {
    const layout = useLayoutTreeStore.getState();
    const activeId = layout.activeLeafId;
    if (activeId) {
      const node = findNodeById(layout.tree.root, activeId);
      if (node && isLeaf(node)) {
        if (viewRegistry.isPrimary(node.panelId) && node.sessionId) return node.sessionId;
        // 活动 leaf 是 tool：尝试找其 unit 侧的 chat（父 H 另一侧）
        const parent = findParent(layout.tree.root, node.id);
        if (parent && parent.parent.direction === 'horizontal') {
          const sibling = parent.parent.children[parent.index === 0 ? 1 : 0];
          if (
            isLeaf(sibling) &&
            viewRegistry.isPrimary(sibling.panelId) &&
            sibling.sessionId
          ) {
            return sibling.sessionId;
          }
        }
      }
    }
    const chats = listChatLeaves(layout.tree.root).filter((c) => c.sessionId);
    if (chats.length === 1) return chats[0]!.sessionId!;
  } catch {
    /* ignore */
  }
  return null;
}

// ── Store 写入 API ───────────────────────────────────────────────────

/**
 * 将 rightDock 投影到指定 session 的 Conversation Unit。
 * @param sessionId 省略时回退到活动 shell tab / 活动 chat leaf
 *
 * T06.9.1：投影期间置位抑制标志，跳过 tree→shell 反向订阅，
 * 消除 applyDockToTree ↔ syncShellDocksFromTree 互触发回环。
 */
export function applyDockToTree(
  dock: RightToolDockState,
  sessionId?: string
): void {
  withTreeDockProjectionSuppressed(() => {
    const sid = resolveTargetSessionId(sessionId);
    if (!sid) {
      // 无 session 可定位：兼容旧路径 — 全局折叠或单 chat+tool
      if (dock.collapsed || !dock.activePanelId) {
        ensureChatOnlyTree();
        return;
      }
      ensureChatPlusSingleToolLeaf(
        dock.openPanelIds.length ? dock.openPanelIds : [dock.activePanelId],
        dock.activePanelId,
        dock.widthRatio
      );
      return;
    }
    applyDockToSession(sid, dock);
  });
}

/**
 * 若整树是 H(multiChatSubtree, orphanTool) 全局右栏形态，先剥掉 orphan tool，
 * 只保留 chat 分屏，再由 per-session expand 挂回 unit 内坞。
 */
function stripLegacyGlobalToolColumn(tree: LayoutTree): LayoutTree {
  const root = tree.root;
  if (!isBranch(root) || root.direction !== 'horizontal') return tree;
  const [a, b] = root.children;
  const aTools = isToolDomainSubtree(a);
  const bTools = isToolDomainSubtree(b);
  if (aTools === bTools) return tree; // 两侧同域，不是「chat 组 | tool」
  const chatSide = aTools ? b : a;
  const chatN = countChatLeaves(chatSide);
  if (chatN < 2) return tree;
  // 提升 chat 侧为新 root（剥掉全局 tool）
  return { version: tree.version, root: chatSide };
}

/**
 * 按 shell openTabs 的 rightDock 重投影全部会话 unit。
 * 先剥掉所有 tool leaf（保留 multi-chat 结构），再按 dock 逐 session 展开。
 * 用于：分屏/移动后纠偏「功能区脱离对话 unit」的脏树。
 * T06.9.1：整段投影受抑制标志保护（见 applyDockToTree 说明）。
 */
export function reprojectAllSessionDocks(): void {
  withTreeDockProjectionSuppressed(() => {
    const treeStore = useLayoutTreeStore.getState();
    let base = stripLegacyGlobalToolColumn(treeStore.tree);
    // 剥掉全部 tool，只留 chat 分屏骨架
    base = stripToolLeavesPreserveChats(base);
    if (base !== treeStore.tree) {
      treeStore.setTree(base);
    }

    let current = treeStore.tree;
    try {
      const tabs = getShellReadApi()?.getOpenTabs();
      for (const tab of tabs ?? []) {
        const sid = (tab.sessionId || '').trim();
        if (!sid) continue;
        const dock = tab.rightDock;
        if (!dock || dock.collapsed || !dock.activePanelId) continue;
        const next = projectDockOntoTree(
          current,
          dock,
          sid,
          treeStore.activeLeafId,
          readTabModeEnabled()
        );
        if (next !== current) current = next;
      }
    } catch {
      /* shell 未就绪时跳过 */
    }

    if (current !== treeStore.tree) {
      treeStore.setTree(current);
    }

    const chatCount = countChatLeaves(current.root);
    const toolCount = countToolLeaves(current.root);
    if (chatCount <= 1) {
      treeStore.setToolColumnCollapsed(toolCount === 0);
    } else {
      treeStore.setToolColumnCollapsed(toolCount === 0);
    }
  });
}

/** 明确按 session 投影 dock（applyDockToTree 的语义别名；受投影抑制保护） */
export function applyDockToSession(
  sessionId: string,
  dock: RightToolDockState
): void {
  withTreeDockProjectionSuppressed(() => {
    const sid = (sessionId || '').trim();
    if (!sid) return;

    const store = useLayoutTreeStore.getState();
    const originalTree = store.tree;
    const base = stripLegacyGlobalToolColumn(originalTree);
    const next = projectDockOntoTree(
      base,
      dock,
      sid,
      store.activeLeafId,
      readTabModeEnabled()
    );

  // ── 统一计算所有状态变更（避免独立 setState 之间的中间态 re-render） ──
  const chatCount = countChatLeaves(next.root);
  const toolCount = countToolLeaves(next.root);

  let targetCollapsed: boolean;
  let targetActiveLeafId: string | null | undefined = undefined;

  if (dock.collapsed || !dock.activePanelId) {
    // multi-unit：禁止全局 collapsed 把邻居 session 的 tool 全藏掉；
    // 仅单 unit，或整树已无 tool 时，才置 toolColumnCollapsed。
    targetCollapsed = chatCount <= 1 ? true : toolCount === 0;

    const chat = findChatLeafBySessionId(next.root, sid);
    if (chat && store.activeLeafId !== chat.id) {
      // 若活动 leaf 已被剥离（原 tool），切回本 unit chat
      const stillThere =
        store.activeLeafId && findNodeById(next.root, store.activeLeafId);
      if (!stillThere) targetActiveLeafId = chat.id;
    }
  } else {
    targetCollapsed = false;
    const unitId = findUnitRootId(next.root, sid);
    if (unitId) {
      const unit = findNodeById(next.root, unitId);
      if (unit && isBranch(unit)) {
        // tool 侧可能是 leaf 或 split branch：激活首个 tool leaf
        const toolSide = unit.children.find((c) =>
          isLeaf(c) ? !viewRegistry.isPrimary(c.panelId) : isToolDomainSubtree(c)
        );
        if (toolSide) {
          const activeId = dock.activePanelId || '';
          const hit = findActiveToolLeaf(toolSide, activeId);
          if (hit) targetActiveLeafId = hit.id;
        }
      }
    }
  }

  // ── 批量写入（最多两次 setState：base 剥离 + next 投影） ──
  if (base !== originalTree) {
    store.setTree(base);
  }
  if (next !== originalTree) {
    store.setTreeWithDock(
      next,
      targetCollapsed,
      targetActiveLeafId
    );
  } else if (targetActiveLeafId !== undefined) {
    store.setActiveLeaf(targetActiveLeafId);
    store.setToolColumnCollapsed(targetCollapsed);
  } else {
    store.setToolColumnCollapsed(targetCollapsed);
  }
  });
}

/**
 * 确保 chat-only。
 * - 传入 sessionId：仅折叠该 session 的 unit dock
 * - 省略：全局剥离所有 tool（冷启动 / resetToCleanDraft）
 * T06.9.1：投影受抑制标志保护（见 applyDockToTree 说明）。
 */
export function ensureChatOnlyTree(sessionId?: string): void {
  withTreeDockProjectionSuppressed(() => {
    const sid = (sessionId || '').trim();
    if (sid) {
      applyDockToSession(sid, {
        collapsed: true,
        openPanelIds: [],
        activePanelId: null,
        widthRatio: 0.50,
      });
      return;
    }

    const store = useLayoutTreeStore.getState();
    const leaves = collectLeaves(store.tree.root);
    const chatLeaves = leaves.filter((l) => viewRegistry.isPrimary(l.panelId));
    const hasTools = leaves.some((l) => !viewRegistry.isPrimary(l.panelId));

    // 多 chat：保留分屏；剥掉全部 tool
    if (chatLeaves.length > 1) {
      store.setToolColumnCollapsed(true);
      if (hasTools) {
        const next = stripToolLeavesPreserveChats(store.tree);
        if (next !== store.tree) {
          store.setTree(next);
        }
      }
      return;
    }

    // 单 chat 且无 tool：保持（保留 sessionId）
    if (chatLeaves.length === 1 && !hasTools) {
      store.setToolColumnCollapsed(true);
      const only = chatLeaves[0]!;
      if (store.activeLeafId !== only.id) {
        store.setActiveLeaf(only.id);
      }
      return;
    }

    // 单 chat + tool 或无 chat：折叠为干净单 chat（保留原 chat 的 sessionId 若有）
    const keepSessionId = chatLeaves[0]?.sessionId;
    const chatLeaf = createLeaf('chat', undefined, undefined, keepSessionId);
    const tree: LayoutTree = { root: chatLeaf, version: 2 };
    store.setTree(tree);
    store.setToolColumnCollapsed(true);
    store.setActiveLeaf(chatLeaf.id);
  });
}

/**
 * 确保 chat + 单 tool leaf。
 * - 传入 sessionId：仅扩展该 session unit
 * - 省略：回退到活动 session；再无则旧单/多 chat 全局挂 tool（兼容）
 * T06.9.1：投影受抑制标志保护（见 applyDockToTree 说明）。
 */
export function ensureChatPlusSingleToolLeaf(
  openPanelIds: string[],
  activePanelId: string,
  widthRatio: number,
  sessionId?: string
): void {
  withTreeDockProjectionSuppressed(() => {
    const panels = openPanelIds.length ? openPanelIds : [activePanelId];
    const active =
      (panels.includes(activePanelId) ? activePanelId : panels[0]) ??
      activePanelId;

    const sid = resolveTargetSessionId(sessionId);
    if (sid) {
      applyDockToSession(sid, {
        collapsed: false,
        openPanelIds: panels,
        activePanelId: active,
        widthRatio,
      });
      return;
    }

    // 无 session：禁止把 tool 挂到「整棵 chat 树」右侧（会变成全局共享右栏）
    const store = useLayoutTreeStore.getState();
    const existingChats = collectLeaves(store.tree.root).filter((l) =>
      viewRegistry.isPrimary(l.panelId)
    );

    if (existingChats.length >= 1) {
      // 优先活动 chat leaf → 绑定/解析 session 后走 per-unit 投影
      const activeId = store.activeLeafId;
      const target =
        existingChats.find((c) => c.id === activeId) ??
        existingChats.find((c) => !!c.sessionId) ??
        existingChats[0]!;
      let bindSid = (target.sessionId || '').trim();
      if (!bindSid) {
        // 未绑 session 的 leaf：用活动会话，再 per-unit 展开
        bindSid = (getActiveSessionId() || '').trim();
        if (!bindSid) {
          // 无活动会话：不创建全局 tool 列
          return;
        }
        const bound: LayoutLeaf = { ...target, sessionId: bindSid };
        const rooted = replaceNode(store.tree.root, target.id, bound);
        store.setTree({ version: store.tree.version, root: rooted });
      }
      applyDockToSession(bindSid, {
        collapsed: false,
        openPanelIds: panels,
        activePanelId: active,
        widthRatio,
      });
      return;
    }

    const prevChat = existingChats[0];
    const chatLeaf = createLeaf(
      'chat',
      undefined,
      undefined,
      prevChat?.sessionId
    );
    const toolNode = resolveToolSubtree(
      panels,
      active,
      prevChat?.sessionId,
      undefined,
      readTabModeEnabled()
    );
    const ratio = clampDockWidthRatio(widthRatio);
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', chatLeaf, toolNode, 1 - ratio),
    };
    store.setTree(tree);
    store.setToolColumnCollapsed(false);
    const activeTool = findActiveToolLeaf(toolNode, active);
    store.setActiveLeaf(activeTool?.id ?? (isLeaf(toolNode) ? toolNode.id : chatLeaf.id));
  });
}

/** 在 dev 下校验不变量；始终 normalize 后写回（投影受抑制标志保护） */
export function ensureAdapterShape(): void {
  withTreeDockProjectionSuppressed(() => {
    const store = useLayoutTreeStore.getState();
    const before = store.tree;
    const chatCount = countChatLeaves(before.root);
    if (chatCount < 1 && import.meta.env?.DEV) {
      console.warn(
        '[workspace-shell] adapter invariant: chat leaf count =',
        chatCount,
        '→ normalize'
      );
    }
    const next = normalizeToAdapterShape(before);
    if (next !== before) {
      store.setTree(next);
      const leaves = collectLeaves(next.root);
      const chat = leaves.find((l) => viewRegistry.isPrimary(l.panelId));
      if (chat) store.setActiveLeaf(chat.id);
    }
  });
}
