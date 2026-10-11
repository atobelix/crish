import type { LayoutLeaf } from '../../store/types';
import { isPendingDraft } from '../../store/storeAccess';
import type { LeafSessionTab } from './paneHeaderGeometry';

/** PaneHeader 的标签模型读取：仅保留已提交会话，草稿由视图层按叶状态补位。 */
export function readCommittedLeafTabs(leaf: LayoutLeaf): LeafSessionTab[] {
  const raw = leaf.tabs as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (tab): tab is LeafSessionTab =>
      typeof tab === 'object' &&
      tab !== null &&
      typeof (tab as LeafSessionTab).tabId === 'string' &&
      !isPendingDraft((tab as LeafSessionTab).sessionId)
  );
}

export function readActiveTabId(leaf: LayoutLeaf): string {
  const id = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  return typeof id === 'string' ? id : '';
}
