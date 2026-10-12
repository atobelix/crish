import { resolveTabInsertIndex } from './tabDragGeometry';
import type { TabBarTabRect } from './tabDragTypes';
import { getPanelTitle } from '../../store/layoutHelpers';

/** 拖拽结束动画：优先 data-group-id / data-card-id，避免 textContent 误匹配 */
function findDropTargetCardEl(
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
  const tabs = Array.from(document.querySelectorAll('.card-tab[data-card-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (t instanceof HTMLElement && t.getAttribute('data-card-id') === cardId) {
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

/** 拖拽浮层：left/top 固定 0，位置只改 transform（避免每帧 left/top 写布局） */
export function setDragOverlayPosition(
  overlay: HTMLElement,
  x: number,
  y: number
): void {
  overlay.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function baseOverlayFixedStyle(width: number, height: number): string {
  return `
    position: fixed;
    left: 0;
    top: 0;
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    pointer-events: none;
    /* F7-F14：z-index 走 token 档位（值等价 --z-toast），禁裸数字 */
    z-index: var(--z-toast);
    box-sizing: border-box;
    will-change: transform;
    transform: translate3d(0, 0, 0);
  `;
}

export function createTabDragOverlay(
  targetEl: HTMLElement
): HTMLDivElement | null {
  const cloned = targetEl.cloneNode(true);
  if (!(cloned instanceof HTMLDivElement)) return null;

  const dragOverlay = cloned;
  dragOverlay.className = 'card-tab is-dragging-ghost';
  dragOverlay.removeAttribute('id');
  const tabR = targetEl.getBoundingClientRect();
  dragOverlay.style.cssText = `
    ${baseOverlayFixedStyle(tabR.width, tabR.height)}
    box-shadow: 0 4px 14px color-mix(in srgb, var(--shadow-color) 12%, transparent), 0 2px 4px color-mix(in srgb, var(--shadow-color) 6%, transparent);
    opacity: 0.95;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    border-radius: var(--radius-sm);
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
    ${baseOverlayFixedStyle(startWidth, startHeight)}
    box-shadow: 0 0 16px color-mix(in srgb, var(--shadow-color) 12%, transparent);
    border-radius: 0;
    border: 1.5px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
    background: var(--bg-card, var(--bg-primary));
    opacity: 0.92;
    transition: opacity 0.12s ease-out;
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

function getDropIndicator(wsId: string): HTMLDivElement | null {
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

export type ShowTabInsertLineOptions = {
  /** pointerdown / 首次测量缓存的 tab 几何，避免 move 时重复 gBCR */
  cachedTabRects?: readonly TabBarTabRect[];
  /** tabs-bar 右边缘（缓存），用于末尾插入线 */
  barRight?: number;
};

/**
 * 标签栏插入指示：复用单个 placeholder，仅在 insertIdx 变化时 insertBefore/append。
 * 优先使用缓存 rects，避免每帧 getBoundingClientRect。
 */
export function showTabInsertLine(
  tabsBar: HTMLElement,
  mouseX: number,
  cardId: string,
  options?: ShowTabInsertLineOptions
): { insertX: number; insertIdx: number } {
  const tabs = Array.from(
    tabsBar.querySelectorAll(
      '.card-tab:not(.dragging-tab-hidden):not(.tab-placeholder-indicator)'
    )
  ).filter((el): el is HTMLElement => el instanceof HTMLElement);

  let tabRects: readonly TabBarTabRect[] | undefined = options?.cachedTabRects;
  if (!tabRects) {
    tabRects = tabs.map((t) => {
      const tr = t.getBoundingClientRect();
      return { left: tr.left, width: tr.width };
    });
  }

  const insertIdx = resolveTabInsertIndex(mouseX, tabRects);

  let insertX: number;
  const atIdx = tabRects[insertIdx];
  if (insertIdx < tabs.length && atIdx) {
    insertX = atIdx.left;
  } else if (options?.barRight != null && Number.isFinite(options.barRight)) {
    insertX = options.barRight;
  } else {
    insertX = tabsBar.getBoundingClientRect().right;
  }

  // 其他 bar 上的残留指示清掉；当前 bar 上的复用
  let placeholder: HTMLDivElement | null = null;
  document.querySelectorAll('.tab-placeholder-indicator').forEach((el) => {
    if (!(el instanceof HTMLDivElement)) {
      el.remove();
      return;
    }
    if (el.parentElement === tabsBar) {
      placeholder = el;
    } else {
      el.remove();
    }
  });

  if (!placeholder) {
    const created = document.createElement('div');
    created.className = 'card-tab tab-placeholder-indicator';
    created.setAttribute('aria-hidden', 'true');
    const title = getPanelTitle(cardId);
    created.innerHTML = `<span class="tab-label" style="opacity: 0.85">${title}</span>`;
    placeholder = created;
  }

  const ref = insertIdx < tabs.length ? tabs[insertIdx] : null;
  if (ref) {
    // 已在正确位置则不动 DOM
    if (
      placeholder.nextSibling !== ref ||
      placeholder.parentElement !== tabsBar
    ) {
      tabsBar.insertBefore(placeholder, ref);
    }
  } else if (
    placeholder.parentElement !== tabsBar ||
    tabsBar.lastElementChild !== placeholder
  ) {
    tabsBar.appendChild(placeholder);
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
      overlay.style.transition =
        'transform 0.28s cubic-bezier(0.19, 1, 0.22, 1), width 0.28s cubic-bezier(0.19, 1, 0.22, 1), height 0.28s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.28s cubic-bezier(0.19, 1, 0.22, 1)';
      // 保持 left/top=0，仅用 transform 落到目标
      setDragOverlayPosition(overlay, destRect.left, destRect.top);
      overlay.style.width = `${destRect.width}px`;
      overlay.style.height = `${Math.min(destRect.height, 160)}px`;
      overlay.style.opacity = '0.2';
      window.setTimeout(() => overlay.remove(), 280);
    } else {
      overlay.style.transition =
        'transform 0.28s ease-out, opacity 0.28s ease-out';
      const m = /translate3d\(([^)]+)\)/.exec(overlay.style.transform);
      overlay.style.transform = m
        ? `translate3d(${m[1]}) scale(0.5)`
        : 'scale(0.5)';
      overlay.style.opacity = '0';
      window.setTimeout(() => overlay.remove(), 280);
    }
  });
}
