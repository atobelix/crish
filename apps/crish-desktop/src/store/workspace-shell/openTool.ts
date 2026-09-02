/**
 * 开工具：只改目标 SessionTab.dock（维 02 updateTabDock），不改树拓扑。
 *
 * I3 只改该 tab；I5 不造 tool 叶；I6 不写 setLeafSessionId。
 * 失败原样返回。
 */

import {
  useLayoutTreeStore,
  findNodeById,
  findTabBySessionId as findTabLocationBySessionId,
  updateTabDock as updateTabDockInTree,
  updateLeafDock as updateLeafDockInTree,
} from '../layout-tree';
import { isLeaf, type LayoutLeaf, type LayoutNode } from '../layout-tree/types';
import type { SessionTab } from '../layout-tree/sessionTabModel';
import {
  createDefaultDock,
  DRAFT_SESSION_ID_PREFIX,
  isDraftSessionId,
} from '../layout-tree/sessionTabModel';
import { registerFileViewerOpener } from '../../api/workspaceFsApi';
import type { RightToolDockState } from './types';
import { clampDockWidthRatio } from './adapterShapeTreeOps';

const TOOL_ALIASES: Record<string, string> = {
  tasks: 'overview',
  plan: 'overview',
  browser: 'preview',
};

/** 与维 01 SessionTab 同形；供本维测试与维 05 读坞 */
export type LeafSessionTab = SessionTab;

export type LeafDockView = {
  collapsed: boolean;
  openPanelIds: string[];
  activePanelId: string | null;
  widthRatio: number;
};

/** I1：非 draft sessionId 全树至多一个命中；先序第一个 */
export function findTabBySessionId(
  root: LayoutNode,
  sessionId: string
): { leafId: string; tab: LeafSessionTab } | null {
  const hit = findTabLocationBySessionId(root, (sessionId || '').trim());
  if (!hit) return null;
  return { leafId: hit.leaf.id, tab: hit.tab };
}

export function findActiveLeafActiveTab(): {
  leafId: string;
  tab: LeafSessionTab;
} | null {
  const store = useLayoutTreeStore.getState();
  const activeId = store.activeLeafId;
  if (!activeId) return null;
  const node = findNodeById(store.tree.root, activeId);
  if (!node || !isLeaf(node)) return null;
  const tab = node.tabs.find((t) => t.tabId === node.activeTabId);
  if (!tab) return null;
  return { leafId: node.id, tab };
}

/**
 * Store 包装：调维 02 纯函数，写回 tree。
 * 不走 setTree，避免推历史 / resolveActiveLeaf 拨焦点（I3 / 命令表）。
 */
export function updateTabDock(
  tabId: string,
  patch: Partial<RightToolDockState>
): void {
  const id = (tabId || '').trim();
  if (!id) return;
  const nextPatch: Partial<RightToolDockState> = { ...patch };
  if (typeof patch.widthRatio === 'number') {
    nextPatch.widthRatio = clampDockWidthRatio(patch.widthRatio);
  }
  const store = useLayoutTreeStore.getState();
  const next = updateTabDockInTree(store.tree, id, nextPatch);
  if (next === store.tree) return;
  useLayoutTreeStore.setState({ tree: next });
}

export function updateLeafDock(
  leafId: string,
  patch: Partial<RightToolDockState>
): void {
  const id = (leafId || '').trim();
  if (!id) return;
  const nextPatch: Partial<RightToolDockState> = { ...patch };
  if (typeof patch.widthRatio === 'number') {
    nextPatch.widthRatio = clampDockWidthRatio(patch.widthRatio);
  }
  const store = useLayoutTreeStore.getState();
  const next = updateLeafDockInTree(store.tree, id, nextPatch);
  if (next === store.tree) return;
  useLayoutTreeStore.setState({ tree: next });
}

/** 本叶正在画的坞：活动 tab 优先，否则新对话坞 */
export function readLeafDock(leaf: LayoutLeaf): LeafDockView {
  const tab = leaf.activeTabId
    ? leaf.tabs.find((t) => t.tabId === leaf.activeTabId)
    : undefined;
  return createDefaultDock(tab?.dock ?? leaf.dock);
}

/** 按 session 找到所属叶。草稿哨兵只认本叶，绝不回落到邻叶。 */
export function resolveLeafIdForSession(sessionId: string): string | null {
  const root = useLayoutTreeStore.getState().tree.root;
  const sid = (sessionId || '').trim();
  if (!sid) return null;
  const hit = findTabBySessionId(root, sid);
  if (hit) return hit.leafId;
  if (isDraftSessionId(sid) && sid.startsWith(DRAFT_SESSION_ID_PREFIX)) {
    const leafId = sid.slice(DRAFT_SESSION_ID_PREFIX.length);
    const node = findNodeById(root, leafId);
    if (node && isLeaf(node)) return node.id;
  }
  return null;
}

export function openToolInLeaf(leafId: string, panelId: string): void {
  const id = (leafId || '').trim();
  if (!id) return;
  const mapped = TOOL_ALIASES[panelId] || panelId;
  const store = useLayoutTreeStore.getState();
  const node = findNodeById(store.tree.root, id);
  if (!node || !isLeaf(node)) return;
  const dock = readLeafDock(node);

  if (mapped === 'chat') {
    updateLeafDock(id, { collapsed: true });
    return;
  }

  const openPanelIds = dock.openPanelIds.includes(mapped)
    ? dock.openPanelIds
    : [...dock.openPanelIds, mapped];

  updateLeafDock(id, {
    collapsed: false,
    openPanelIds,
    activePanelId: mapped,
  });

  if (mapped === 'terminal') {
    const sid =
      node.tabs.find((t) => t.tabId === node.activeTabId)?.sessionId ?? '';
    if (sid) {
      void import('../../api/ptyRegistry')
        .then((m) => m.ensurePtyForSession(sid))
        .catch(() => {
          /* PTY 与树无关；C2 未就绪时 no-op */
        });
    }
  }
}

/** 在指定 session 所属叶的坞中打开工具。找不到该叶则不动。 */
export function openToolInSession(sessionId: string, panelId: string): void {
  const leafId = resolveLeafIdForSession(sessionId);
  if (!leafId) return;
  openToolInLeaf(leafId, panelId);
}

export function openToolInActiveTab(panelId: string): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openToolInLeaf(activeId, panelId);
}

/** 文件查看器：panelId 进 dock.openPanelIds。禁止 splitLeaf */
export function openFileViewerInSession(
  filePath: string,
  _initialMode: 'plain' | 'diff' = 'plain'
): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openToolInLeaf(activeId, `file-viewer:${filePath}`);
}

export function collapseActiveTabRightDock(collapsed: boolean): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  const node = findNodeById(
    useLayoutTreeStore.getState().tree.root,
    activeId
  );
  if (!node || !isLeaf(node)) return;
  const dock = readLeafDock(node);
  const patch: Partial<RightToolDockState> = { collapsed };
  if (!collapsed && !dock.activePanelId) {
    patch.activePanelId = 'overview';
    patch.openPanelIds = dock.openPanelIds.length
      ? dock.openPanelIds
      : ['overview'];
  }
  updateLeafDock(activeId, patch);
}

registerFileViewerOpener((path, mode) => {
  openFileViewerInSession(path, mode || 'plain');
});
