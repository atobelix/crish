/**
 * 开工具：操作目标 SessionTab.dock.tree（V2 DockTree 纯函数），不改叶拓扑。
 *
 * 遵循单一真理源（SSOT）与正交抽象：
 * 1. 彻底清退数字后缀拼接循环（terminal:2 / preview:2），由 openToolInDock 自动分配全新独立不可变的 tabId；
 * 2. 彻底清退全局 Map 寄存器与微任务 CustomEvent 补丁，所有参数通过 ToolTab.params 正交下发；
 * 3. 依赖 layout-tree 的纯函数变迁。
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
import {
  openToolInDock,
  createDefaultDockTree,
  type ToolViewId,
} from '../layout-tree/dockLayoutModel';
import { registerFileViewerOpener } from '../../api/filePanelOpener';
import type { RightToolDockState } from './types';
import { clampDockWidthRatio } from './adapterShapeTreeOps';
import { normalizeViewerFilePath } from './normalizeViewerPath';

const TOOL_ALIASES: Record<string, string> = {
  tasks: 'overview',
  plan: 'overview',
  browser: 'preview',
};

/** 与维 01 SessionTab 同形；供本维测试与维 05 读坞 */
export type LeafSessionTab = SessionTab;

export type LeafDockView = RightToolDockState;

/** 文件预览模式意图契约 */
export type FileViewerInitialMode = 'plain' | 'diff';

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
  const nextPatch: Partial<RightToolDockState> = {
    ...patch,
    ...(typeof patch.widthRatio === 'number'
      ? { widthRatio: clampDockWidthRatio(patch.widthRatio) }
      : {}),
  };
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
  const nextPatch: Partial<RightToolDockState> = {
    ...patch,
    ...(typeof patch.widthRatio === 'number'
      ? { widthRatio: clampDockWidthRatio(patch.widthRatio) }
      : {}),
  };
  const store = useLayoutTreeStore.getState();
  const next = updateLeafDockInTree(store.tree, id, nextPatch);
  if (next === store.tree) return;
  useLayoutTreeStore.setState({ tree: next });
}

/** 本叶正在画的坞：活动 tab 优先，否则新对话坞 */
export function readLeafDock(leaf: LayoutLeaf): RightToolDockState {
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

/**
 * 在指定叶的右坞中打开工具标签页
 */
export function openToolInLeaf(
  leafId: string,
  viewId: string,
  params?: Record<string, unknown>,
  opts?: { isSingleton?: boolean }
): void {
  const id = (leafId || '').trim();
  if (!id) return;

  const mapped = TOOL_ALIASES[viewId] || viewId;

  if (mapped === 'chat') {
    updateLeafDock(id, { collapsed: true });
    return;
  }

  const store = useLayoutTreeStore.getState();
  const node = findNodeById(store.tree.root, id);
  if (!node || !isLeaf(node)) return;

  const dock = readLeafDock(node);
  const currentTree = dock.tree ?? createDefaultDockTree();
  const isSingleton =
    opts?.isSingleton ?? (mapped !== 'terminal' && mapped !== 'preview');

  const { tree: nextTree, tabId } = openToolInDock(currentTree, {
    viewId: mapped as ToolViewId,
    params,
    isSingleton,
  });

  updateLeafDock(id, {
    collapsed: false,
    tree: nextTree,
  });

  if (mapped === 'terminal') {
    void import('../../api/ptyRegistry')
      .then((m) => m.ensurePtyForSession(tabId))
      .catch(() => {
        /* PTY 与树无关；未就绪时 no-op */
      });
  }
}

/** 在指定 session 所属叶的坞中打开工具。找不到该叶则不动。 */
export function openToolInSession(
  sessionId: string,
  viewId: string,
  params?: Record<string, unknown>,
  opts?: { isSingleton?: boolean }
): void {
  const leafId = resolveLeafIdForSession(sessionId);
  if (!leafId) return;
  openToolInLeaf(leafId, viewId, params, opts);
}

export function openToolInActiveTab(
  viewId: string,
  params?: Record<string, unknown>,
  opts?: { isSingleton?: boolean }
): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openToolInLeaf(activeId, viewId, params, opts);
}

/** 在指定叶中新建一个全新独立的终端标签页 */
export function openNewTerminalInLeaf(leafId: string): void {
  const id = (leafId || '').trim();
  if (!id) return;
  openToolInLeaf(id, 'terminal', undefined, { isSingleton: false });
}

export function openNewTerminalInActiveTab(): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openNewTerminalInLeaf(activeId);
}

/** 在指定叶中新建一个全新独立的浏览器标签页（参数直通） */
export function openNewBrowserInLeaf(
  leafId: string,
  initialUrl?: string
): void {
  const id = (leafId || '').trim();
  if (!id) return;
  const params = initialUrl ? { url: initialUrl } : undefined;
  openToolInLeaf(id, 'preview', params, { isSingleton: false });
}

export function openNewBrowserInActiveTab(initialUrl?: string): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openNewBrowserInLeaf(activeId, initialUrl);
}

/**
 * 文件查看器单轨下发点火器（V2 正交参数与 Clean Break SSOT）
 *
 * 遵循原则：
 * 1. 严格过滤 note/notebook 前缀：/^(note|notebook)(:|$)/i 守卫；
 * 2. 路径严格经由 normalizeViewerFilePath 归一化；
 * 3. 初始呈现模式 initialMode 直接封装入 params 透传；
 * 4. 彻底消除全局 Map 寄存器与微任务事件，由 openToolInDock 自动根据 filePath 匹配或创建 Tab 并热更新 params。
 */
export function openFileViewerInSession(
  filePath: string,
  initialMode?: FileViewerInitialMode | 'preview'
): void;
export function openFileViewerInSession(
  sessionId: string,
  filePath: string,
  mode?: FileViewerInitialMode | 'preview'
): void;
export function openFileViewerInSession(
  arg1: string,
  arg2?: string | FileViewerInitialMode | 'preview',
  arg3?: FileViewerInitialMode | 'preview'
): void {
  let targetSessionId: string | undefined;
  let rawPath: string;
  let rawMode: string | undefined;

  const isModeString = (
    val: unknown
  ): val is FileViewerInitialMode | 'preview' =>
    val === 'plain' || val === 'diff' || val === 'preview';

  if (arg3 !== undefined) {
    targetSessionId = arg1;
    rawPath = typeof arg2 === 'string' ? arg2 : '';
    rawMode = arg3;
  } else if (arg2 !== undefined) {
    if (isModeString(arg2)) {
      rawPath = arg1;
      rawMode = arg2;
    } else {
      targetSessionId = arg1;
      rawPath = arg2;
    }
  } else {
    rawPath = arg1;
  }

  const raw = (rawPath || '').trim();
  if (!raw || /^(note|notebook)(:|$)/i.test(raw)) return;

  const trimmed = normalizeViewerFilePath(raw);
  if (!trimmed) return;

  const activeId =
    (targetSessionId ? resolveLeafIdForSession(targetSessionId) : null) ||
    useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;

  const initialMode: FileViewerInitialMode =
    rawMode === 'diff' ? 'diff' : 'plain';

  openToolInLeaf(
    activeId,
    'file-viewer',
    { filePath: trimmed, initialMode },
    { isSingleton: true }
  );
}

export function collapseActiveTabRightDock(collapsed: boolean): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  updateLeafDock(activeId, { collapsed });
}

registerFileViewerOpener((path, mode) => {
  openFileViewerInSession(path, mode || 'plain');
});
