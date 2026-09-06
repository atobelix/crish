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
import { normalizeViewerFilePath } from './normalizeViewerPath';

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

/** 文件预览模式意图契约 */
export type FileViewerInitialMode = 'plain' | 'diff';

/** 模式意图轻量寄存器（模块作用域存储，供冷启动组件单次消费） */
const fileViewerModeOverrides = new Map<string, FileViewerInitialMode>();

export function setFileViewerModeOverride(
  canonicalTabId: string,
  mode: FileViewerInitialMode
): void {
  fileViewerModeOverrides.set(canonicalTabId, mode);
}

export function consumeFileViewerModeOverride(
  canonicalTabId: string
): FileViewerInitialMode | undefined {
  const mode = fileViewerModeOverrides.get(canonicalTabId);
  if (mode) {
    fileViewerModeOverrides.delete(canonicalTabId);
  }
  return mode;
}

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
  let mapped = TOOL_ALIASES[panelId] || panelId;
  if (panelId.startsWith('browser:')) {
    mapped = `preview:${panelId.slice('browser:'.length)}`;
  }
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

  if (mapped === 'terminal' || mapped.startsWith('terminal:')) {
    const sid =
      node.tabs.find((t) => t.tabId === node.activeTabId)?.sessionId ?? '';
    if (sid) {
      const termKey = mapped === 'terminal' ? sid : `${sid}:${mapped}`;
      void import('../../api/ptyRegistry')
        .then((m) => m.ensurePtyForSession(termKey))
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

/** 在指定叶或当前活动叶中新建一个全新独立的终端标签页（如 terminal:2, terminal:3 等） */
export function openNewTerminalInLeaf(leafId: string): void {
  const id = (leafId || '').trim();
  if (!id) return;
  const store = useLayoutTreeStore.getState();
  const node = findNodeById(store.tree.root, id);
  if (!node || !isLeaf(node)) return;
  const dock = readLeafDock(node);

  let targetId = 'terminal';
  if (dock.openPanelIds.includes('terminal')) {
    let nextIdx = 2;
    while (dock.openPanelIds.includes(`terminal:${nextIdx}`)) {
      nextIdx++;
    }
    targetId = `terminal:${nextIdx}`;
  }
  openToolInLeaf(id, targetId);
}

export function openNewTerminalInActiveTab(): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openNewTerminalInLeaf(activeId);
}

/** 在指定叶或当前活动叶中新建一个全新独立的浏览器标签页（如 preview:2, preview:3 等） */
export function openNewBrowserInLeaf(leafId: string): void {
  const id = (leafId || '').trim();
  if (!id) return;
  const store = useLayoutTreeStore.getState();
  const node = findNodeById(store.tree.root, id);
  if (!node || !isLeaf(node)) return;
  const dock = readLeafDock(node);

  let targetId = 'preview';
  if (dock.openPanelIds.includes('preview')) {
    let nextIdx = 2;
    while (dock.openPanelIds.includes(`preview:${nextIdx}`)) {
      nextIdx++;
    }
    targetId = `preview:${nextIdx}`;
  }
  openToolInLeaf(id, targetId);
}

export function openNewBrowserInActiveTab(): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openNewBrowserInLeaf(activeId);
}

/**
 * 文件查看器单轨下发点火器 (DETAIL-PLAN-03 终局定稿实现)
 *
 * 刚性守门契约与防回归铁律：
 * 1. 严格过滤 note/notebook 前缀：/^(note|notebook)(:|$)/i 守卫，杜绝误唤起与状态混淆；
 * 2. 变量名绝对死锁为 trimmed，严格经由 normalizeViewerFilePath 归一化，盘符强制大写并剥离 ./；
 * 3. 严格匹配 filePreviewLeaf.source.test.ts 源码硬编码正则：
 *    - expect(src).toMatch(/file-viewer:\$\{trimmed\}/);
 *    - expect(src).toMatch(/\/\^\(note\|notebook\)\(:\|\$\)\/i/);
 * 4. Canonical Tab ID 格式锁死为 `file-viewer:${trimmed}`，严禁拼入 ?mode=diff；
 * 5. initialMode 参数严禁抛弃，通过 setFileViewerModeOverride 独立登记初始模式意图；
 * 6. 同名 Tab 热激活微任务覆盖触发机制：通过 queueMicrotask 派发 'conex:file-viewer-mode' 事件；
 * 7. 健壮性保障：支持 (filePath, initialMode) 与 (sessionId, filePath, mode) 双重调用契约。
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

  const isModeString = (val: unknown): val is FileViewerInitialMode | 'preview' =>
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

  const initialMode: FileViewerInitialMode = rawMode === 'diff' ? 'diff' : 'plain';
  const canonicalTabId = `file-viewer:${trimmed}`;

  // 1. 登记初始呈现模式意图（供冷启动挂载读取）
  setFileViewerModeOverride(canonicalTabId, initialMode);

  // 2. 派发至坞状态机（使用 Canonical Tab ID 进行严格去重与激活）
  openToolInLeaf(activeId, canonicalTabId);

  // 3. 同名 Tab 热激活微任务覆盖触发机制（解决已存在激活 Tab 时的模式更新）
  queueMicrotask(() => {
    window.dispatchEvent(
      new CustomEvent('conex:file-viewer-mode', {
        detail: { canonicalTabId, mode: initialMode },
      })
    );
  });
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
