import type { LayoutLeaf } from '../../store/types';

export interface LeafSessionTab {
  tabId: string;
  sessionId: string;
  title?: string;
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
  if (activeTabId === '' && isComposingDraft) return undefined;
  if (activeTabId) {
    return tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0];
  }
  return tabs[0];
}

export function rectPropsEqual(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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
      dockPropsEqual(tab.dock, nextTab.dock)
    );
  });
}
