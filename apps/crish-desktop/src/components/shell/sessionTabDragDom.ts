import {
  SESSION_TAB_STRIP_SHIFT_EASE,
  SESSION_TAB_STRIP_SHIFT_MS,
  SESSION_TAB_STRIP_SHIFT_PX,
} from './sessionTabDragFeel';
import styles from './sessionTabDrag.module.css';

export function readTranslateX(el: HTMLElement): number {
  const tr = getComputedStyle(el).transform;
  if (!tr || tr === 'none') return 0;
  try {
    return new DOMMatrix(tr).m41 || 0;
  } catch {
    const m = /matrix\(([^)]+)\)/.exec(tr);
    if (!m?.[1]) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return Number.isFinite(parts[4]) ? parts[4]! : 0;
  }
}

export interface CollectedStripData {
  tabs: Array<{
    left: number;
    right: number;
    width: number;
    el: HTMLElement;
    id: string;
  }>;
  /** 源标签在当前条带的原始 index；若不在本条带中则为 null */
  sourceIndex: number | null;
}

/**
 * 采集条内除源标签外的其余标签几何，并识别源标签原始 index。
 *
 * 会话条主键是 data-tab-id（维 06）；idAttr 仍可覆盖，供抽屉内排序复用位移。
 */
export function collectStripTabs(
  strip: HTMLElement,
  sourceId: string,
  idAttr: string = 'data-tab-id'
): CollectedStripData {
  const allTabs = Array.from(
    strip.querySelectorAll<HTMLElement>(`[role="tab"][${idAttr}]`)
  );
  let sourceIndex: number | null = null;
  const remaining: CollectedStripData['tabs'] = [];

  for (let idx = 0; idx < allTabs.length; idx++) {
    const t = allTabs[idx]!;
    const sid = t.getAttribute(idAttr) || '';
    if (sid === sourceId) {
      sourceIndex = idx;
      continue;
    }
    const r = t.getBoundingClientRect();
    const tx = readTranslateX(t);
    remaining.push({
      left: r.left - tx,
      right: r.right - tx,
      width: r.width,
      el: t,
      id: sid,
    });
  }
  return { tabs: remaining, sourceIndex };
}

export function leaveStrip(strip: HTMLElement | null) {
  if (!strip) return;
  strip.querySelectorAll<HTMLElement>('[role="tab"]').forEach((t) => {
    t.style.transform = '';
    t.style.transition = '';
  });
}

export function shiftStripTabs(
  tabs: CollectedStripData['tabs'],
  offsets: readonly number[]
) {
  tabs.forEach((r, i) => {
    const offset = offsets[i] ?? 0;
    r.el.style.transition = `transform ${SESSION_TAB_STRIP_SHIFT_MS}ms ${SESSION_TAB_STRIP_SHIFT_EASE}`;
    r.el.style.transform = offset !== 0 ? `translateX(${offset}px)` : '';
  });
}

export function posIndicator(
  el: HTMLDivElement,
  box: { left: number; top: number; width: number; height: number }
) {
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
}

export function createIndicator(title: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = styles.indicator || '';
  d.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.className = styles.title || '';
  span.textContent = title || '放置标签';
  d.appendChild(span);
  document.body.appendChild(d);
  return d;
}

export const indicatorClasses = {
  strip: styles.strip || '',
  pane: styles.pane || '',
};

export const ghostClasses = {
  card: styles.card || '',
  detached: styles.detached || '',
};

/** ghost 宽度跟源 tab；class 用 tree-drag-card，配合 is-detached。 */
export function createGhostPill(
  title: string,
  sourceWidth?: number
): HTMLDivElement {
  const ghost = document.createElement('div');
  const moduleClass = styles.card || '';
  ghost.className = [moduleClass, 'tree-drag-card'].filter(Boolean).join(' ');
  ghost.setAttribute('aria-hidden', 'true');
  const computedWidth =
    sourceWidth && sourceWidth > 0
      ? Math.min(Math.max(sourceWidth, 60), 180)
      : 150;
  ghost.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'pointer-events: none',
    'z-index: 100000',
    'box-sizing: border-box',
    'height: 26px',
    `width: ${Math.round(computedWidth)}px`,
    'max-width: 180px',
    'min-width: 60px',
    'padding: 0 8px',
    'display: flex',
    'align-items: center',
    'background: var(--bg-card, #ffffff)',
    'color: var(--text-primary, #111111)',
    'border: 1px solid var(--border-subtle, hsl(0 0% 0% / 0.15))',
    'border-radius: 6px',
    'box-shadow: 0 8px 24px hsl(0 0% 0% / 0.14), 0 2px 6px hsl(0 0% 0% / 0.08)',
    'font-size: 12px',
    'font-weight: 500',
    'font-family: inherit',
    'overflow: hidden',
    'will-change: transform, opacity',
    'transform: translate3d(-9999px, -9999px, 0)',
  ].join(';');

  const titleSpan = document.createElement('span');
  titleSpan.style.cssText = [
    'flex: 1 1 auto',
    'min-width: 0',
    'overflow: hidden',
    'text-overflow: ellipsis',
    'white-space: nowrap',
  ].join(';');
  titleSpan.textContent = title || '会话';
  ghost.appendChild(titleSpan);

  document.body.appendChild(ghost);
  return ghost;
}

export function setGhostDetached(card: HTMLElement | null, detached: boolean) {
  if (!card) return;
  card.classList.toggle('is-detached', detached);
  if (ghostClasses.detached) {
    card.classList.toggle(ghostClasses.detached, detached);
  }
}
