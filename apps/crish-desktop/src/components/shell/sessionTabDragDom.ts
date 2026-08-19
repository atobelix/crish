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

export function collectStripTabs(strip: HTMLElement, sourceSessionId: string) {
  const tabs = Array.from(
    strip.querySelectorAll<HTMLElement>('[role="tab"][data-session-id]')
  );
  const remaining: Array<{
    left: number;
    right: number;
    width: number;
    el: HTMLElement;
    sessionId: string;
  }> = [];
  for (const t of tabs) {
    const sid = t.getAttribute('data-session-id') || '';
    if (!sid || sid === sourceSessionId) continue;
    const r = t.getBoundingClientRect();
    const tx = readTranslateX(t);
    remaining.push({
      left: r.left - tx,
      right: r.right - tx,
      width: r.width,
      el: t,
      sessionId: sid,
    });
  }
  return remaining;
}

export function leaveStrip(strip: HTMLElement | null) {
  if (!strip) return;
  strip.querySelectorAll<HTMLElement>('[role="tab"]').forEach((t) => {
    t.style.transform = '';
    t.style.transition = '';
  });
}

export function shiftStripTabs(
  tabs: ReturnType<typeof collectStripTabs>,
  insertIdx: number
) {
  tabs.forEach((r, i) => {
    r.el.style.transition = `transform ${SESSION_TAB_STRIP_SHIFT_MS}ms ${SESSION_TAB_STRIP_SHIFT_EASE}`;
    r.el.style.transform =
      i >= insertIdx ? `translateX(${SESSION_TAB_STRIP_SHIFT_PX}px)` : '';
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
  d.className = styles.indicator;
  d.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.className = styles.title;
  span.textContent = title || '放置标签';
  d.appendChild(span);
  document.body.appendChild(d);
  return d;
}

export const indicatorClasses = {
  strip: styles.strip,
  pane: styles.pane,
};

export function createGhostPill(title: string): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.className = 'topbar-tab-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'pointer-events: none',
    'z-index: var(--z-tooltip, 9000)',
    'padding: 4px 12px',
    'background: var(--bg-primary)',
    'color: var(--text-primary)',
    'border: 1px solid var(--border-color)',
    'border-radius: 6px',
    'box-shadow: 0 4px 12px color-mix(in srgb, var(--shadow-color, #000) 18%, transparent)',
    'font-size: 12px',
    'font-family: inherit',
    'white-space: nowrap',
    'opacity: 0.92',
    'will-change: transform',
  ].join(';');
  ghost.textContent = title || '会话';
  document.body.appendChild(ghost);
  return ghost;
}
