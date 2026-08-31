/**
 * 在活动 Tab 的 RightToolDock 中打开工具面板。
 * 替换 focusOrOpenTreePanel 对 tool 的主路径。
 *
 * ## compositionRoot (OPT-G4)
 * Imperative getState here is **same-store only** (`useWorkspaceShellStore`).
 * Keep direct store access — no cross-store tree/session getState in this module.
 * Tree projection stays via `adapterShape` (internal; not rewritten).
 * Migrating shell → `getCompositionRoot().shell` would add store→root coupling
 * with no cross-store benefit.
 */

import { useWorkspaceShellStore } from './workspaceShellStore';
import { ensureChatOnlyTree, applyDockToTree } from './adapterShape';
import { useLayoutTreeStore, collectLeaves } from '../layout-tree';
import { registerFileViewerOpener } from '../../api/workspaceFsApi';

const TOOL_ALIASES: Record<string, string> = {
  tasks: 'overview',
  plan: 'overview',
  browser: 'preview',
};

/** 在指定 session 的 RightToolDock 中打开工具（多 unit 时不抢其它会话） */
export function openToolInSession(sessionId: string, panelId: string): void {
  const mapped = TOOL_ALIASES[panelId] || panelId;
  const sid = (sessionId || '').trim();
  const store = useWorkspaceShellStore.getState();
  const tab = sid
    ? store.openTabs.find((t) => t.sessionId === sid) ?? store.getActiveTab()
    : store.getActiveTab();

  if (mapped === 'chat') {
    /*
     * 收起右坞：树回到 chat-only 的同时，必须把 collapsed 回写 shell store。
     * 少了这一步，两个 store 会各说各话——树上面板已经关了，shell 仍认为坞是开的。
     * 顶栏 UnitChromeActions 正是据此判断的，于是坞开关按钮与 .withDockMargin
     * 的 36px 让位边距会一起消失。
     */
    if (tab && !tab.rightDock.collapsed) {
      store.updateRightDock(tab.tabId, { ...tab.rightDock, collapsed: true });
    }
    ensureChatOnlyTree(tab?.sessionId || sid || undefined);
    return;
  }

  if (!tab) {
    applyDockToTree(
      {
        collapsed: false,
        openPanelIds: [mapped],
        activePanelId: mapped,
        widthRatio: 0.38,
      },
      sid || undefined
    );
    return;
  }

  const openPanelIds = tab.rightDock.openPanelIds.includes(mapped)
    ? tab.rightDock.openPanelIds
    : [...tab.rightDock.openPanelIds, mapped];

  const dock = {
    ...tab.rightDock,
    openPanelIds,
    activePanelId: mapped,
    collapsed: false,
  };
  store.updateRightDock(tab.tabId, dock);
  applyDockToTree(dock, tab.sessionId);

  // 打开终端面板：ensure 该 session 的 PTY（折叠坞不 kill；C2 未就绪时 no-op）
  if (mapped === 'terminal') {
    const ensureSid = tab.sessionId || sid;
    void import('../../api/ptyRegistry')
      .then((m) => m.ensurePtyForSession(ensureSid))
      .catch(() => {
        /* ignore */
      });
  }

  // 确保全局侧栏没有被折叠，如果折叠了就将其展开
  if (useLayoutTreeStore.getState().toolColumnCollapsed) {
    useLayoutTreeStore.getState().setToolColumnCollapsed(false);
  }
}

export function openToolInActiveTab(panelId: string): void {
  const tab = useWorkspaceShellStore.getState().getActiveTab();
  openToolInSession(tab?.sessionId ?? '', panelId);
}

function openFileViewerInSession(filePath: string, _initialMode: 'plain' | 'diff' = 'plain'): void {
  const store = useWorkspaceShellStore.getState();
  const tab = store.getActiveTab();
  if (!tab) return;

  const tabId = `file-viewer:${filePath}`;

  const treeStore = useLayoutTreeStore.getState();
  if (treeStore.toolColumnCollapsed) {
    treeStore.setToolColumnCollapsed(false);
  }

  const root = treeStore.tree.root;
  // 类型化收集（AA-03 Q18 消除 node: any）：复用 layout-tree 唯一 collectLeaves
  const toolLeaves = collectLeaves(root).filter((l) => l.panelId !== 'chat');
  const chatLeaves = collectLeaves(root).filter((l) => l.panelId === 'chat');
  let targetLeafId = treeStore.activeLeafId;

  if (chatLeaves.some(c => c.id === targetLeafId)) {
    targetLeafId = toolLeaves[0]?.id || null;
  }

  if (!targetLeafId && toolLeaves[0]) {
    targetLeafId = toolLeaves[0].id;
  }

  if (targetLeafId) {
    treeStore.addTabToLeaf(targetLeafId, tabId);
    treeStore.setActiveTab(targetLeafId, tabId);
  } else {
    const activeChat = chatLeaves[0];
    if (activeChat) {
      treeStore.splitLeaf(activeChat.id, 'horizontal', tabId, 'after', 0.5);
    }
  }

  const openPanelIds = tab.rightDock.openPanelIds.includes(tabId)
    ? tab.rightDock.openPanelIds
    : [...tab.rightDock.openPanelIds, tabId];
  const dock = {
    ...tab.rightDock,
    openPanelIds,
    activePanelId: tabId,
    collapsed: false,
  };
  store.updateRightDock(tab.tabId, dock);
  applyDockToTree(dock, tab.sessionId);
}

export function collapseActiveTabRightDock(collapsed: boolean): void {
  const store = useWorkspaceShellStore.getState();
  const tab = store.getActiveTab();
  if (!tab) return;
  const dock = {
    ...tab.rightDock,
    collapsed,
    activePanelId:
      !collapsed && !tab.rightDock.activePanelId
        ? 'overview'
        : tab.rightDock.activePanelId,
    openPanelIds:
      !collapsed && !tab.rightDock.openPanelIds.length
        ? ['overview']
        : tab.rightDock.openPanelIds,
  };
  store.updateRightDock(tab.tabId, dock);
  applyDockToTree(dock, tab.sessionId);
}

// 注册回调解耦循环依赖
registerFileViewerOpener((path, mode) => {
  openFileViewerInSession(path, mode || 'plain');
});
