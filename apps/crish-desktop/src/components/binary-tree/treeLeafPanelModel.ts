import type { LayoutLeaf } from '../../store/types';
import {
  DEFAULT_RIGHT_DOCK,
  collectSpatialLeaves,
  isPendingDraftSessionId,
  mintDraftSessionId,
  getCompositionRoot,
  type RightToolDockState,
  type DockTree,
} from '../../store/storeAccess';

export { isPendingDraftSessionId as isDraftSessionId };

export interface LeafSessionTab {
  tabId: string;
  sessionId?: string;
  title?: string;
  kind?: 'chat' | 'terminal' | 'browser';
  terminalKey?: string;
  cwd?: string;
  isStandalone?: boolean;
  url?: string;
  favicon?: string;
  dock?: RightToolDockState;
}

export function readLeafTabs(leaf: LayoutLeaf): LeafSessionTab[] {
  const raw = leaf.tabs as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (tab): tab is LeafSessionTab =>
      typeof tab === 'object' &&
      tab !== null &&
      typeof (tab as LeafSessionTab).tabId === 'string'
  );
}

export function readActiveTabId(leaf: LayoutLeaf): string {
  const id = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  return typeof id === 'string' ? id : '';
}

/**
 * 叶子草稿态单一真理源（SSOT，B-01）：
 * 当且仅当叶子无选中 tab（activeTabId 为空）或 leaf.tabs 为空时，叶子处于新对话草稿态。
 * 彻底解除对全局 isPendingDraft(activeSessionId) 的耦合。
 */
export function isLeafInDraftMode(leaf: LayoutLeaf): boolean {
  return readActiveTabId(leaf) === '' || readLeafTabs(leaf).length === 0;
}

export const COLLAPSED_DOCK: RightToolDockState = DEFAULT_RIGHT_DOCK;

export function readActiveTab(
  leaf: LayoutLeaf,
  isComposingDraft?: boolean
): LeafSessionTab | undefined {
  const tabs = readLeafTabs(leaf);
  if (tabs.length === 0) return undefined;
  const activeTabId = readActiveTabId(leaf);
  if (activeTabId === '' || isComposingDraft) return undefined;
  if (activeTabId) {
    return tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0];
  }
  return undefined;
}

/**
 * 解析分屏叶子绑定的会话 ID（F-01 / RC-01 单一真理源）：
 * 1. 当叶子节点有显式 activeTab?.sessionId 时，返回 activeTab.sessionId。
 * 2. 当叶子节点 tabs.length === 0（无打开标签）时：
 *    如果当前叶子是焦点叶子（isFocused）且全局 globalActiveSessionId 是非草稿真实会话 ID
 *    （!isPendingDraftSessionId(globalActiveSessionId)），回退使用 globalActiveSessionId；
 *    只有当全局本身处于草稿态或该叶子是非焦点空分屏时，才使用 mintDraftSessionId(leaf.id)。
 */
export function resolveLeafSessionId(
  leaf: LayoutLeaf,
  options?: {
    isFocused?: boolean;
    globalActiveSessionId?: string | null;
  }
): string {
  const activeTab = readActiveTab(leaf);

  // 🔒 1. 独立常规终端专属隔离分支（ACT-04）
  // 严格返回 activeTab.terminalKey（格式如 standalone:term_<tabId>）
  // 绝不回退到 globalActiveSessionId！
  if (activeTab?.kind === 'terminal') {
    return activeTab.terminalKey || `standalone:${activeTab.tabId}`;
  }

  // 🔒 1.1 独立浏览器专属隔离分支
  if (activeTab?.kind === 'browser') {
    return activeTab.sessionId || activeTab.tabId;
  }

  // 2. ChatTab 正常返回 sessionId
  if (activeTab?.sessionId) {
    return activeTab.sessionId;
  }

  // 3. 空叶子兜底
  const tabs = readLeafTabs(leaf);
  if (tabs.length === 0) {
    const isFocused = options?.isFocused ?? false;
    const globalId = options?.globalActiveSessionId;
    if (isFocused && globalId && !isPendingDraftSessionId(globalId)) {
      return globalId;
    }
  }
  return mintDraftSessionId(leaf.id);
}

export function rectPropsEqual(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function dockPropsEqual(
  a?: RightToolDockState,
  b?: RightToolDockState
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.collapsed === b.collapsed &&
    a.widthRatio === b.widthRatio &&
    a.tree === b.tree
  );
}

export function leafPropsEqual(a: LayoutLeaf, b: LayoutLeaf): boolean {
  if (a === b) return true;
  if (a.id !== b.id || readActiveTabId(a) !== readActiveTabId(b)) return false;
  if (!dockPropsEqual(a.dock, b.dock)) return false;
  const aTabs = readLeafTabs(a);
  const bTabs = readLeafTabs(b);
  if (aTabs.length !== bTabs.length) return false;
  return aTabs.every((tab, index) => {
    const nextTab = bTabs[index]!;
    return (
      tab.tabId === nextTab.tabId &&
      tab.sessionId === nextTab.sessionId &&
      tab.kind === nextTab.kind &&
      tab.terminalKey === nextTab.terminalKey &&
      tab.cwd === nextTab.cwd &&
      tab.isStandalone === nextTab.isStandalone &&
      tab.url === nextTab.url &&
      dockPropsEqual(tab.dock, nextTab.dock)
    );
  });
}

export interface TreeLeafPanelProps {
  leaf: LayoutLeaf;
  /** leaf 的渲染 rect（百分比，0-1） */
  rect: { x: number; y: number; width: number; height: number };
  /** 是否为激活 leaf */
  isActive: boolean;
  /** 是否为拖拽源（旧拖拽兼容，缺省 false） */
  isDragSource?: boolean;
  /** 当前是否多 chat 分屏（>1 chat leaf）；条带不再依赖此旗标 */
  isMultiChat?: boolean;
}

export type SessionShellCommands = {
  activateTab: (leafId: string, tabId: string) => void;
};

export function sessionShell(): SessionShellCommands {
  return getCompositionRoot().shell as unknown as SessionShellCommands;
}

export function killDockTerminalPty(
  panelId: string,
  sessionForPanel?: string
): void {
  void import('../../api/ptyRegistry').then((m) => {
    // 1. 若为精确 tabId（非 'terminal' 且非 'terminal:'），直接按 tabId 精准析构 PTY
    if (panelId && panelId !== 'terminal' && !panelId.startsWith('terminal:')) {
      void m.killPtyForSession(panelId);
      return;
    }
    // 2. 兼容历史伪 URI / 别名: 'terminal' 或 'terminal:X'
    if (panelId === 'terminal' || panelId.startsWith('terminal:')) {
      if (sessionForPanel) {
        const panelKey =
          panelId === 'terminal'
            ? sessionForPanel
            : `${sessionForPanel}:${panelId}`;
        void m.killPtyForSession(panelKey);
        void m.killPtyForSession(`${panelKey}:split-2`);
      } else {
        void m.killPtyForSession(panelId);
      }
    }
  });
}

/**
 * 递归全量析构整棵 DockTree 下全部窗格与标签的底层物理资源（ConPTY 与原生 WebView2）
 */
export function teardownDockTree(
  tree?: DockTree | null,
  sessionId?: string | null
): void {
  if (!tree || !tree.root) return;
  const leaves = collectSpatialLeaves(tree.root);
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      if (tab.viewId === 'terminal' || tab.viewId.startsWith('terminal:')) {
        killDockTerminalPty(tab.tabId, sessionId || undefined);
      } else if (
        tab.viewId === 'preview' ||
        tab.viewId.startsWith('preview:')
      ) {
        void import('../../api/nativeBrowserApi').then((m) => {
          void m.browserWebviewClose(tab.tabId);
        });
      }
    }
  }
}
