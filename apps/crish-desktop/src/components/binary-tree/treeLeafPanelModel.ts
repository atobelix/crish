import type { LayoutLeaf } from '../../store/types';
import {
  isPendingDraftSessionId,
  mintDraftSessionId,
  getCompositionRoot,
} from '../../store/storeAccess';

export { isPendingDraftSessionId as isDraftSessionId };

export interface LeafSessionTab {
  tabId: string;
  sessionId?: string;
  title?: string;
  kind?: 'chat' | 'terminal' | 'browser' | string;
  terminalKey?: string;
  cwd?: string;
  url?: string;
  favicon?: string;
  dock?: {
    collapsed: boolean;
    openPanelIds: string[];
    activePanelId: string | null;
    widthRatio: number;
  };
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

export const COLLAPSED_DOCK = {
  collapsed: true,
  openPanelIds: [] as string[],
  activePanelId: null as string | null,
  widthRatio: 0.5,
};

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
  const tabs = readLeafTabs(leaf);
  const activeTab = readActiveTab(leaf);
  if (activeTab?.sessionId) {
    return activeTab.sessionId;
  }
  if (activeTab?.terminalKey) {
    return activeTab.terminalKey;
  }
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
  a?: LeafSessionTab['dock'],
  b?: LeafSessionTab['dock']
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.collapsed === b.collapsed &&
    a.activePanelId === b.activePanelId &&
    a.widthRatio === b.widthRatio &&
    a.openPanelIds.length === b.openPanelIds.length &&
    a.openPanelIds.every((id, index) => id === b.openPanelIds[index])
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
  sessionForPanel: string
): void {
  if (panelId === 'terminal' || panelId.startsWith('terminal:')) {
    void import('../../api/ptyRegistry').then((m) => {
      const panelKey =
        panelId === 'terminal'
          ? sessionForPanel
          : `${sessionForPanel}:${panelId}`;
      void m.killPtyForSession(panelKey);
      void m.killPtyForSession(`${panelKey}:split-2`);
    });
  }
}

export function computeNextDockAfterClose(
  openPanelIds: string[],
  activePanelId: string | null,
  closedPanelId: string
): {
  collapsed?: boolean;
  openPanelIds: string[];
  activePanelId: string | null;
} {
  const nextIds = openPanelIds.filter((id) => id !== closedPanelId);
  if (nextIds.length === 0) {
    return { collapsed: true, openPanelIds: [], activePanelId: null };
  }
  const nextActive =
    activePanelId === closedPanelId
      ? (nextIds[nextIds.length - 1] ?? null)
      : activePanelId;
  return { openPanelIds: nextIds, activePanelId: nextActive };
}
