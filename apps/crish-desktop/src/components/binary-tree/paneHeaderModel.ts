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

/** 条带成员计算：已提交会话 tabs，分屏下若无真会话但有草稿保留草稿以支持关闭 */
export function computeVisibleLeafTabs(
  leaf: LayoutLeaf,
  isMultiPane: boolean
): LeafSessionTab[] {
  const committedTabs = readCommittedLeafTabs(leaf);
  if (committedTabs.length > 0) {
    return committedTabs;
  }
  const raw = leaf.tabs as unknown;
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as LeafSessionTab;
    return [
      {
        tabId: first.tabId || `draft-${leaf.id}`,
        sessionId: first.sessionId || '',
        title: '新对话',
      },
    ];
  }
  return isMultiPane
    ? [{ tabId: `pane-${leaf.id}`, sessionId: '', title: '新对话' }]
    : [];
}

/** 判断鼠标离开事件是否实际仍处于顶栏物理区域内部 */
export function isMouseStillInsideHeader(
  e: {
    currentTarget: EventTarget | null;
    relatedTarget: EventTarget | null;
    clientX?: number;
    clientY?: number;
  },
  containerEl: HTMLElement | null
): boolean {
  const currentTargetEl = e.currentTarget as HTMLElement | null;
  const headerEl =
    containerEl?.closest('[data-pane-header="true"]') ||
    currentTargetEl?.closest?.('[data-pane-header="true"]') ||
    currentTargetEl;
  if (!headerEl) return false;

  if (typeof headerEl.matches === 'function' && headerEl.matches(':hover')) {
    return true;
  }

  const nextTarget = e.relatedTarget;
  if (
    nextTarget &&
    nextTarget instanceof Node &&
    headerEl.contains(nextTarget)
  ) {
    return true;
  }

  if (
    typeof e.clientX === 'number' &&
    typeof e.clientY === 'number' &&
    e.clientX > 0 &&
    e.clientY > 0
  ) {
    const rect = headerEl.getBoundingClientRect();
    if (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}
