import { resolveTabInsertIndex } from './tabDragGeometry';
import { getPanelTitle } from '../../store/layoutHelpers';

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
      const el = cards[i];
      if (
        el instanceof HTMLElement &&
        el.getAttribute('data-group-id') === preferredGroupId
      ) {
        return el;
      }
    }
  }
  const tabs = Array.from(
    document.querySelectorAll('.card-tab[data-card-id]')
  );
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (
      t instanceof HTMLElement &&
      t.getAttribute('data-card-id') === cardId
    ) {
      const card = t.closest('.workspace-card');
      return card instanceof HTMLElement ? card : null;
    }
  }
  if (cardId === 'chat') {
    const card = document.querySelector('.workspace-card.flat-layout');
    return card instanceof HTMLElement ? card : null;
  }
  return null;
}

export function createTabDragOverlay(targetEl: HTMLElement): HTMLDivElement | null {
  const cloned = targetEl.cloneNode(true);
  if (!(cloned instanceof HTMLDivElement)) return null;

  const dragOverlay = cloned;
  dragOverlay.className = 'card-tab is-dragging-ghost';
  dragOverlay.removeAttribute('id');
  const tabR = targetEl.getBoundingClientRect();
  dragOverlay.style.cssText = `
    position: fixed;
    width: ${tabR.width}px;
    height: ${tabR.height}px;
    overflow: hidden;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
    opacity: 0.95;
    pointer-events: none;
    z-index: 10000;
    box-sizing: border-box;
    border: 1px solid var(--border-color);
    background: var(--bg-primary, #ffffff);
    border-radius: var(--radius-sm, 6px);
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  dragOverlay.querySelectorAll('.tab-close-btn').forEach((btn) => btn.remove());
  document.body.appendChild(dragOverlay);
  document.body.classList.add('dragging-card');
  return dragOverlay;
}

export function createCardDragOverlay(
  sourceCard: HTMLElement,
  startWidth: number,
  startHeight: number
): HTMLDivElement | null {
  const cloned = sourceCard.cloneNode(true);
  if (!(cloned instanceof HTMLDivElement)) return null;

  const dragOverlay = cloned;
  dragOverlay.className = 'drag-overlay-preview-card';
  dragOverlay.removeAttribute('id');
  dragOverlay.style.cssText = `
    position: fixed;
    width: ${startWidth}px;
    height: ${startHeight}px;
    overflow: hidden;
    box-shadow: 0 0 16px rgba(0,0,0,0.12);
    border-radius: 0;
    border: 1.5px solid color-mix(in srgb, var(--accent-color, #1a73e8) 35%, var(--border-color));
    background: var(--bg-card, var(--bg-primary));
    opacity: 0.92;
    pointer-events: none;
    z-index: 10000;
    transition: opacity 0.12s ease-out;
    will-change: transform;
  `;
  dragOverlay.querySelectorAll('input, textarea, button').forEach((el) => {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLButtonElement
    ) {
      el.disabled = true;
    }
  });
  document.body.appendChild(dragOverlay);
  document.body.classList.add('dragging-card');
  return dragOverlay;
}

export function removeInsertLine(insertLineEl?: HTMLDivElement | null): void {
  if (insertLineEl) {
    insertLineEl.remove();
  }
  document.querySelectorAll('.tab-insert-line').forEach((el) => el.remove());
  document
    .querySelectorAll('.tab-placeholder-indicator')
    .forEach((el) => el.remove());
}

export function getDropIndicator(wsId: string): HTMLDivElement | null {
  const el = document.getElementById(`drop-indicator-${wsId}`);
  return el instanceof HTMLDivElement ? el : null;
}

export function clearDropIndicator(
  wsId: string,
  insertLineEl?: HTMLDivElement | null
): void {
  const ind = getDropIndicator(wsId);
  if (ind) {
    ind.style.display = 'none';
    ind.removeAttribute('data-drop-type');
  }
  removeInsertLine(insertLineEl);
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
  ).filter((el): el is HTMLElement => el instanceof HTMLElement);
  const barRect = tabsBar.getBoundingClientRect();
  const tabRects = tabs.map((t) => {
    const tr = t.getBoundingClientRect();
    return { left: tr.left, width: tr.width };
  });
  const insertIdx = resolveTabInsertIndex(mouseX, tabRects);
  let insertX = barRect.right;
  if (insertIdx < tabs.length) {
    const ref = tabs[insertIdx];
    if (ref) insertX = ref.getBoundingClientRect().left;
  }

  document.querySelectorAll('.tab-placeholder-indicator').forEach((el) => {
    if (
      el.parentElement !== tabsBar ||
      Array.from(tabsBar.children).indexOf(el) !== insertIdx
    ) {
      el.remove();
    }
  });

  if (!tabsBar.querySelector('.tab-placeholder-indicator')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'card-tab tab-placeholder-indicator';
    placeholder.setAttribute('aria-hidden', 'true');
    const title = getPanelTitle(cardId);
    placeholder.innerHTML = `<span class="tab-label" style="opacity: 0.85">${title}</span>`;

    if (insertIdx < tabs.length) {
      const ref = tabs[insertIdx];
      if (ref) tabsBar.insertBefore(placeholder, ref);
    } else {
      tabsBar.appendChild(placeholder);
    }
  }

  return { insertX, insertIdx };
}

export function animateOverlayAway(
  overlay: HTMLDivElement,
  cardId: string,
  preferredGroupId: string | null
): void {
  document.body.classList.remove('dragging-card');
  requestAnimationFrame(() => {
    const targetCardDOM = findDropTargetCardEl(cardId, preferredGroupId);
    if (targetCardDOM) {
      const destRect = targetCardDOM.getBoundingClientRect();
      overlay.style.transition = 'all 0.28s cubic-bezier(0.19, 1, 0.22, 1)';
      overlay.style.left = `${destRect.left}px`;
      overlay.style.top = `${destRect.top}px`;
      overlay.style.width = `${destRect.width}px`;
      overlay.style.height = `${Math.min(destRect.height, 160)}px`;
      overlay.style.transform = 'scale(1.0)';
      overlay.style.opacity = '0.2';
      window.setTimeout(() => overlay.remove(), 280);
    } else {
      overlay.style.transition = 'all 0.28s ease-out';
      overlay.style.transform = 'scale(0.5)';
      overlay.style.opacity = '0';
      window.setTimeout(() => overlay.remove(), 200);
    }
  });
}
