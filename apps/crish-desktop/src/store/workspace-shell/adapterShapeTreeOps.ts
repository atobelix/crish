/**
 * Phase 2 Adapter — 纯树操作（不可变几何变换）。
 *
 * 本模块从 adapterShape.ts 拆出，仅含不触碰 store 的纯函数：
 * 计数 / clamp / 子树同步 / chat leaf 解析 / collapse / expand / project / normalize / strip。
 * Store 写入 API（applyDock* / ensure* / reproject）见 adapterShapeStoreOps.ts。
 * Hub re-export 见 adapterShape.ts。
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md §2.3
 * @see analysis/shell_workspace_redesign.md §4.5.3
 */

import {
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
import type { RightToolDockState } from './types';
import { resolveToolSubtree } from './tabModeToolSubtree';

// ── 计数 / 查询 ──────────────────────────────────────────────────────

export function countChatLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter((l) => viewRegistry.isPrimary(l.panelId)).length;
}

export function countToolLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter((l) => !viewRegistry.isPrimary(l.panelId)).length;
}

// ── 纯树工具（不可变） ───────────────────────────────────────────────

/** 子树是否完全处于功能区（无 chat leaf） */
export function isToolDomainSubtree(node: LayoutNode): boolean {
  if (isLeaf(node)) return !viewRegistry.isPrimary(node.panelId);
  return (
    isToolDomainSubtree(node.children[0]) &&
    isToolDomainSubtree(node.children[1])
  );
}

/** 深度替换指定 id 的节点 */
export function replaceNode(
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
  return Math.min(0.75, Math.max(0.20, widthRatio));
}

export function makeToolLeaf(
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
export function syncToolSubtree(
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

  // 优先：活动 leaf 且为未绑定 / 草稿 chat
  let candidate: LayoutLeaf | null = null;
  if (activeLeafId) {
    const active = chats.find((c) => c.id === activeLeafId);
    if (
      active &&
      (!active.sessionId ||
        active.sessionId.startsWith('__pending') ||
        active.sessionId === sid)
    ) {
      candidate = active;
    }
  }
  // 其次：任意未绑定或草稿 chat
  if (!candidate) {
    candidate =
      chats.find(
        (c) =>
          !c.sessionId ||
          c.sessionId.startsWith('__pending') ||
          c.sessionId === sid
      ) ?? null;
  }
  // 再次：单 chat 布局中唯一直属 chat（不抢占 multi-chat 中明确归属他人的 leaf）
  if (!candidate && chats.length === 1) {
    candidate = chats[0]!;
  }
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
  activeLeafId: string | null = null,
  tabMode?: boolean
): LayoutTree {
  const sid = (sessionId || '').trim();
  if (!sid) return tree;

  const resolved = resolveChatLeafForSession(tree.root, sid, activeLeafId);
  if (!resolved) return tree;

  const root = resolved.root;
  const chatLeaf = resolved.chatLeaf;
  const toolRatio = clampDockWidthRatio(widthRatio);
  const chatRatio = 1 - toolRatio;

  const nextTool = (existing?: LayoutNode): LayoutNode => {
    if (tabMode === true || tabMode === false) {
      return resolveToolSubtree(
        openPanelIds,
        activePanelId,
        sid,
        existing,
        tabMode
      );
    }
    return existing
      ? syncToolSubtree(existing, openPanelIds, activePanelId, sid)
      : makeToolLeaf(openPanelIds, activePanelId, sid);
  };

  const unitRootId = findUnitRootId(root, sid);

  // 已是标准 H unit：同步 tool 侧与 splitRatio
  if (unitRootId && unitRootId !== chatLeaf.id) {
    const unitNode = findNodeById(root, unitRootId);
    if (unitNode && isBranch(unitNode) && unitNode.direction === 'horizontal') {
      const [first, second] = unitNode.children;
      let nextUnit: LayoutBranch;
      if (first.id === chatLeaf.id && isToolDomainSubtree(second)) {
        nextUnit = {
          ...unitNode,
          children: [chatLeaf, nextTool(second)],
          splitRatio: chatRatio,
        };
      } else if (second.id === chatLeaf.id && isToolDomainSubtree(first)) {
        nextUnit = {
          ...unitNode,
          children: [chatLeaf, nextTool(first)],
          splitRatio: chatRatio,
        };
      } else {
        nextUnit = createBranch(
          'horizontal',
          chatLeaf,
          nextTool(),
          chatRatio
        );
        const newRoot = replaceNode(root, chatLeaf.id, nextUnit);
        return { version: tree.version, root: newRoot };
      }
      const newRoot = replaceNode(root, unitRootId, nextUnit);
      return { version: tree.version, root: newRoot };
    }
  }

  const unit = createBranch('horizontal', chatLeaf, nextTool(), chatRatio);
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
  activeLeafId: string | null = null,
  tabMode?: boolean
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
    activeLeafId,
    tabMode
  );
}

/**
 * 从树中剥离全部 tool leaves，保留全部 chat leaves 的分屏结构。
 * 仅用于全局 reset / 冷启动；per-session 折叠请用 collapseSessionUnitDock。
 */
export function stripToolLeavesPreserveChats(tree: LayoutTree): LayoutTree {
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
