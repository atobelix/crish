import { getWorkspaceStoreState, setDropPreview } from '../../store/workspaceStore';

import type { DropPreviewState } from '../../store/types';
import { resolveTabInsertIndex, dropPreviewEquals } from './types';

/** 拖拽结束动画：优先 data-group-id / data-card-id，避免 textContent 误匹配 */
export function findDropTargetCardEl(
  cardId: string,
  preferredGroupId?: string | null
): HTMLElement | null {
  if (preferredGroupId) {
    const cards = Array.from(
      document.querySelectorAll('.workspace-card[data-group-id]')
    );
    for (let i = 0; i < cards.length; i++) {
      const el = cards[i] as HTMLElement;
      if (el.getAttribute('data-group-id') === preferredGroupId) return el;
    }
  }
  const tabs = Array.from(document.querySelectorAll('.card-tab[data-card-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i] as HTMLElement;
    if (t.getAttribute('data-card-id') === cardId) {
      return t.closest('.workspace-card') as HTMLElement | null;
    }
  }
  if (cardId === 'chat') {
    return document.querySelector(
      '.workspace-card.flat-layout'
    ) as HTMLElement | null;
  }
  return null;
}

export function getIndicator(wsId: string): HTMLDivElement | null {
  return document.getElementById(
    `drop-indicator-${wsId}`
  ) as HTMLDivElement | null;
}

export function removeInsertLine(): void {
  document
    .querySelectorAll('.tab-insert-line')
    .forEach((el) => el.remove());
  document
    .querySelectorAll('.tabs-bar[data-tab-insert-idx]')
    .forEach((el) => {
      el.removeAttribute('data-tab-insert-idx');
      el.removeAttribute('data-tab-insert-x');
    });
}

export function clearIndicator(wsId: string): void {
  const ind = getIndicator(wsId);
  if (ind) {
    ind.style.display = 'none';
    ind.removeAttribute('data-drop-type');
  }
  removeInsertLine();
}

export function showTabInsertLine(
  tabsBar: HTMLElement,
  mouseX: number,
  cardId: string
): { insertX: number; insertIdx: number } {
  const tabs = Array.from(
    tabsBar.querySelectorAll(
      '.card-tab:not(.dragging-tab-hidden):not(.tab-placeholder-indicator)'
    )
  ) as HTMLElement[];
  const tabRects = tabs.map((t) => {
    const tr = t.getBoundingClientRect();
    return { left: tr.left, width: tr.width };
  });
  const insertIdx = resolveTabInsertIndex(mouseX, tabRects);
  let insertX = tabsBar.getBoundingClientRect().right;
  if (insertIdx < tabs.length) {
    insertX = tabs[insertIdx].getBoundingClientRect().left;
  }

  document.querySelectorAll('.tabs-bar[data-tab-insert-idx]').forEach((el) => {
    el.removeAttribute('data-tab-insert-idx');
    el.removeAttribute('data-tab-insert-x');
  });
  tabsBar.dataset.tabInsertIdx = String(insertIdx);
  tabsBar.dataset.tabInsertX = String(insertX);

  return { insertX, insertIdx };
}

export function safeSetDropPreview(nextPreview: DropPreviewState | null): void {
  const currentPreview = getWorkspaceStoreState().dropPreview;
  if (!nextPreview) {
    if (currentPreview !== null) {
      setDropPreview(null);
    }
    return;
  }
  if (!dropPreviewEquals(currentPreview, nextPreview)) {
    setDropPreview(nextPreview);
  }
}
