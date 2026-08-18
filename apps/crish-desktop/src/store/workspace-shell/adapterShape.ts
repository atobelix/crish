/**
 * Phase 2 Adapter：layout-tree 为 per-session Conversation Unit。
 *
 * UnitRoot =
 *   | chatLeaf(sessionId)                         // dock 折叠
 *   | H-branch( chatLeaf(sessionId), toolSubtree ) // dock 展开
 *
 * 关键：applyDock / ensure* 只改目标 session 的 unit，不整树重建、不剥离其它 session 的 tool。
 * @see docs/plans/2026-07-conversation-unit-shell.md §2.3
 * @see analysis/shell_workspace_redesign.md §4.5.3
 */

import {
  useLayoutTreeStore,
  collectLeaves,
  findNodeById,
  isLeaf,
  isBranch,
  findChatLeafBySessionId,
  listChatLeaves,
  findUnitRootId,
} from '../layout-tree';
import { viewRegistry } from '../../services/view-registry';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  type LayoutTree,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutBranch,
} from '../layout-tree/types';
import { findParent } from '../layout-tree/operations';
import type { RightToolDockState } from './types';
import { getShellReadApi } from './shellReadBridge';
import { withTreeDockProjectionSuppressed } from './treeDockProjection';
import { getActiveSessionId } from '../../api/storeAccess';

// ── 计数 / 查询 ──────────────────────────────────────────────────────

export function countChatLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter((l) => viewRegistry.isPrimary(l.panelId)).length;
}

export function countToolLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter((l) => !viewRegistry.isPrimary(l.panelId)).length;
}

// ── 纯树工具（不可变） ───────────────────────────────────────────────

/** 子树是否完全处于功能区（无 chat leaf） */
function isToolDomainSubtree(node: LayoutNode): boolean {
  if (isLeaf(node)) return !viewRegistry.isPrimary(node.panelId);
  return (
    isToolDomainSubtree(node.children[0]) &&
    isToolDomainSubtree(node.children[1])
  );
}

/** 深度替换指定 id 的节点 */
function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = replaceNode(first, targetId, replacement);
  const newSecond = replaceNode(second, targetId, replacement);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}

/** tool 列宽 → branch.splitRatio（first child 占比）；钳制与 Phase 1 一致 */
export function clampDockWidthRatio(widthRatio: number): number {
  return Math.min(0.55, Math.max(0.15, widthRatio));
}

function makeToolLeaf(
  openPanelIds: string[],
  activePanelId: string,
  ownerSessionId?: string
): LayoutLeaf {
  const panels = openPanelIds.length ? openPanelIds : [activePanelId];
  const active = panels.includes(activePanelId) ? activePanelId : panels[0]!;
  // tool leaf 也带 sessionId，供多 unit 右坞头按会话渲染（非 chat 域）
  return createLeaf(active, panels, active, ownerSessionId);
}

/**
 * 同步 tool 子树 dock 元数据，**保留 split 拓扑**。
 * - leaf：写 tabs / active / owner（保持 leaf id）
 * - branch：不拍扁成单 leaf；仅补 owner，并把 activePanel 落到匹配 leaf（或首 leaf）
 */
function syncToolSubtree(
  toolNode: LayoutNode,
  openPanelIds: string[],
  activePanelId: string,
  ownerSessionId?: string
): LayoutNode {
  const panels = openPanelIds.length ? openPanelIds : [activePanelId];
  const active = panels.includes(activePanelId) ? activePanelId : panels[0]!;
  const owner = (ownerSessionId || '').trim() || undefined;

  if (isLeaf(toolNode)) {
    return {
      ...toolNode,
      type: 'leaf',
      panelId: active,
      tabs: panels,
      activeTab: active,
      ...(owner ? { sessionId: owner } : {}),
    };
  }

  // tool 侧已是 branch（用户 split）：只同步 owner/active，禁止整侧替换
  const toolLeaves = collectLeaves(toolNode).filter(
    (l) => !viewRegistry.isPrimary(l.panelId)
  );
  let targetId: string | null = null;
  for (const l of toolLeaves) {
    if (
      l.panelId === active ||
      l.activeTab === active ||
      (l.tabs && l.tabs.includes(active))
    ) {
      targetId = l.id;
      break;
    }
  }
  if (!targetId && toolLeaves[0]) targetId = toolLeaves[0].id;

  function mapNode(n: LayoutNode): LayoutNode {
    if (isLeaf(n)) {
      if (viewRegistry.isPrimary(n.panelId)) return n;
      const isTarget = n.id === targetId;
      let tabs = n.tabs?.length ? [...n.tabs] : [n.panelId];
      let panelId = n.activeTab || n.panelId;
      let activeTab = n.activeTab || n.panelId;
      if (isTarget) {
        if (!tabs.includes(active)) tabs = [...tabs, active];
        panelId = active;
        activeTab = active;
      }
      return {
        ...n,
        panelId,
        tabs,
        activeTab,
        ...(owner ? { sessionId: owner } : { sessionId: n.sessionId }),
      };
    }
    const [a, b] = n.children;
    const na = mapNode(a);
    const nb = mapNode(b);
    if (na === a && nb === b) return n;
    return { ...n, children: [na, nb] };
  }
  return mapNode(toolNode);
}

/**
 * 解析目标 chat leaf；若无绑定则在「未绑定 / 活动」chat 上写入 sessionId。
 * 纯函数：返回可能改写后的 root + chatLeaf。
 */
export function resolveChatLeafForSession(
  root: LayoutNode,
  sessionId: string,
  activeLeafId: string | null = null
): { root: LayoutNode; chatLeaf: LayoutLeaf } | null {
  const sid = (sessionId || '').trim();
  if (!sid) return null;

  const existing = findChatLeafBySessionId(root, sid);
  if (existing) return { root, chatLeaf: existing };

  const chats = listChatLeaves(root);

  // 优先：活动 leaf 且为未绑定 chat
  let candidate: LayoutLeaf | null = null;
  if (activeLeafId) {
    const active = chats.find((c) => c.id === activeLeafId);
    if (active && !active.sessionId) candidate = active;
  }
  // 其次：任意未绑定 chat
  if (!candidate) {
    candidate = chats.find((c) => !c.sessionId) ?? null;
  }
  // 再次：唯一 chat 且无 sessionId（上面已覆盖）；不抢占其它 session 的 leaf
  if (!candidate) {
    if (chats.length === 0) {
      const newChat = createLeaf('chat', undefined, undefined, sid);
      // 若 root 全是 tool 或空：以 chat 为新 root（调用方 normalize 会兜底）
      if (countToolLeaves(root) > 0 && countChatLeaves(root) === 0) {
        // 保留首个 tool 作为右侧，形成单 unit
        const tool = collectLeaves(root).find((l) => !viewRegistry.isPrimary(l.panelId));
        if (tool) {
          const branch = createBranch('horizontal', newChat, tool, 0.62);
          return { root: branch, chatLeaf: newChat };
        }
      }
      return { root: newChat, chatLeaf: newChat };
    }
    return null;
  }

  const bound: LayoutLeaf = { ...candidate, sessionId: sid };
  return {
    root: replaceNode(root, candidate.id, bound),
    chatLeaf: bound,
  };
}

/**
 * 折叠指定 session 的 unit dock：H(chat|tools) → chatLeaf，保留 sessionId 与在父树中的位置。
 * 其它 session unit 不动。
 */
export function collapseSessionUnitDock(
  tree: LayoutTree,
  sessionId: string
): LayoutTree {
  const sid = (sessionId || '').trim();
  if (!sid) return tree;

  const chatLeaf = findChatLeafBySessionId(tree.root, sid);
  if (!chatLeaf) return tree;

  const unitRootId = findUnitRootId(tree.root, sid);
  if (!unitRootId || unitRootId === chatLeaf.id) {
    // 已是 chat-only unit
    return tree;
  }

  // unit 为 H-branch：用 chat leaf 替换整个 unit，剥离本 unit 的 tool 子树
  const preservedChat: LayoutLeaf = {
    ...chatLeaf,
    type: 'leaf',
    panelId: 'chat',
    tabs: chatLeaf.tabs?.length ? chatLeaf.tabs : ['chat'],
    activeTab: chatLeaf.activeTab || 'chat',
    sessionId: sid,
  };
  const newRoot = replaceNode(tree.root, unitRootId, preservedChat);
  return newRoot === tree.root ? tree : { version: tree.version, root: newRoot };
}

/**
 * 展开 / 更新指定 session 的 unit dock：确保 unit = H(chat, toolLeaf)。
 * 不重建整棵 multi-chat 树；不剥离 sibling session 的 tools。
 */
export function expandSessionUnitDock(
  tree: LayoutTree,
  sessionId: string,
  openPanelIds: string[],
  activePanelId: string,
  widthRatio: number,
  activeLeafId: string | null = null
): LayoutTree {
  const sid = (sessionId || '').trim();
  if (!sid) return tree;

  const resolved = resolveChatLeafForSession(tree.root, sid, activeLeafId);
  if (!resolved) return tree;

  const root = resolved.root;
  const chatLeaf = resolved.chatLeaf;
  const toolLeaf = makeToolLeaf(openPanelIds, activePanelId, sid);
  const toolRatio = clampDockWidthRatio(widthRatio);
  const chatRatio = 1 - toolRatio;

  const unitRootId = findUnitRootId(root, sid);

  // 已是标准 H unit：同步 tool 侧与 splitRatio（tool 已 split 则保留 branch）
  if (unitRootId && unitRootId !== chatLeaf.id) {
    const unitNode = findNodeById(root, unitRootId);
    if (unitNode && isBranch(unitNode) && unitNode.direction === 'horizontal') {
      const [first, second] = unitNode.children;
      let nextUnit: LayoutBranch;
      if (first.id === chatLeaf.id && isToolDomainSubtree(second)) {
        // tool 侧可能是 leaf 或 branch(split)：sync 不拍扁
        const synced = syncToolSubtree(
          second,
          openPanelIds,
          activePanelId,
          sid
        );
        nextUnit = {
          ...unitNode,
          children: [chatLeaf, synced],
          splitRatio: chatRatio,
        };
      } else if (second.id === chatLeaf.id && isToolDomainSubtree(first)) {
        // tool | chat → 归一为 chat | tool，仍保留 tool 侧 split
        const synced = syncToolSubtree(first, openPanelIds, activePanelId, sid);
        nextUnit = {
          ...unitNode,
          children: [chatLeaf, synced],
          splitRatio: chatRatio,
        };
      } else {
        // 非预期结构：退化为在 chat 位置包一层（新单 leaf）
        nextUnit = createBranch('horizontal', chatLeaf, toolLeaf, chatRatio);
        const newRoot = replaceNode(root, chatLeaf.id, nextUnit);
        return { version: tree.version, root: newRoot };
      }
      const newRoot = replaceNode(root, unitRootId, nextUnit);
      return { version: tree.version, root: newRoot };
    }
  }

  // chat-only unit：把 chat leaf 替换为 H(chat, tool)
  const unit = createBranch('horizontal', chatLeaf, toolLeaf, chatRatio);
  const newRoot = replaceNode(root, chatLeaf.id, unit);
  return { version: tree.version, root: newRoot };
}

/**
 * 纯函数：把 dock 投影到指定 session 的 unit。
 * collapsed / 无 activePanelId → 折叠该 unit；否则展开并同步 tabs。
 */
export function projectDockOntoTree(
  tree: LayoutTree,
  dock: RightToolDockState,
  sessionId: string,
  activeLeafId: string | null = null
): LayoutTree {
  const sid = (sessionId || '').trim();
  if (!sid) return tree;

  if (dock.collapsed || !dock.activePanelId) {
    return collapseSessionUnitDock(tree, sid);
  }

  const panels = dock.openPanelIds.length
    ? dock.openPanelIds
    : [dock.activePanelId];
  return expandSessionUnitDock(
    tree,
    sid,
    panels,
    dock.activePanelId,
    dock.widthRatio,
    activeLeafId
  );
}

/**
 * 从树中剥离全部 tool leaves，保留全部 chat leaves 的分屏结构。
 * 仅用于全局 reset / 冷启动；per-session 折叠请用 collapseSessionUnitDock。
 */
function stripToolLeavesPreserveChats(tree: LayoutTree): LayoutTree {
  const leaves = collectLeaves(tree.root);
  const chatLeaves = leaves.filter((l) => viewRegistry.isPrimary(l.panelId));
  const toolLeaves = leaves.filter((l) => !viewRegistry.isPrimary(l.panelId));
  if (toolLeaves.length === 0 && chatLeaves.length >= 1) return tree;
  if (chatLeaves.length === 0) {
    return createDefaultTree('chat');
  }
  if (chatLeaves.length === 1) {
    return {
      version: tree.version,
      root: {
        ...chatLeaves[0]!,
        type: 'leaf',
        panelId: 'chat',
        tabs: chatLeaves[0]!.tabs?.length ? chatLeaves[0]!.tabs : ['chat'],
        activeTab: chatLeaves[0]!.activeTab || 'chat',
      },
    };
  }
  // 多 chat：按现有顺序水平拼回（sessionId 保留）
  let root: LayoutNode = chatLeaves[0]!;
  for (let i = 1; i < chatLeaves.length; i++) {
    root = createBranch('horizontal', root, chatLeaves[i]!, 0.5);
  }
  return { version: tree.version, root };
}

/**
 * 归一化 adapter 形态：
 * - 至少 1 个 chat leaf
 * - **保留**全部 chat leaves（多 chat 分屏）
 * - 不强制合并 chat；tool 过多时仍尽量保持现状（minimal）
 */
export function normalizeToAdapterShape(tree: LayoutTree): LayoutTree {
  const leaves = collectLeaves(tree.root);
  const chatLeaves = leaves.filter((l) => viewRegistry.isPrimary(l.panelId));
  const toolLeaves = leaves.filter((l) => !viewRegistry.isPrimary(l.panelId));

  // 已有 chat：保留多 chat，不折叠
  if (chatLeaves.length >= 1) {
    return tree;
  }

  // 无 chat：注入一个
  const keepTool = toolLeaves[0] ?? null;
  const keepChat = createLeaf('chat');

  if (!keepTool) {
    return {
      version: tree.version,
      root: keepChat,
    };
  }

  const toolNode: LayoutLeaf = {
    ...keepTool,
    type: 'leaf',
    panelId: keepTool.activeTab || keepTool.panelId || 'overview',
    tabs: keepTool.tabs?.length
      ? keepTool.tabs
      : [keepTool.panelId || 'overview'],
    activeTab: keepTool.activeTab || keepTool.tabs[0] || 'overview',
  };

  return {
    version: tree.version,
    root: createBranch('horizontal', keepChat, toolNode, 0.62),
  };
}

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
          treeStore.activeLeafId
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
    const next = projectDockOntoTree(base, dock, sid, store.activeLeafId);

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
          if (isLeaf(toolSide)) {
            targetActiveLeafId = toolSide.id;
          } else {
            const firstTool = collectLeaves(toolSide).find(
              (l) => !viewRegistry.isPrimary(l.panelId)
            );
            if (firstTool) targetActiveLeafId = firstTool.id;
          }
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
        widthRatio: 0.38,
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
    const toolWithTabs = makeToolLeaf(panels, active);
    const ratio = clampDockWidthRatio(widthRatio);
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', chatLeaf, toolWithTabs, 1 - ratio),
    };
    store.setTree(tree);
    store.setToolColumnCollapsed(false);
    store.setActiveLeaf(toolWithTabs.id);
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
