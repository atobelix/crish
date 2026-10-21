import { TAB_HEIGHT_PX, TAB_WIDTH_MAX_PX } from '../../utils/tabStripGeometry';
import {
  SESSION_TAB_INDICATOR_W,
  SESSION_TAB_STRIP_SHIFT_EASE,
  SESSION_TAB_STRIP_SHIFT_MS,
} from './sessionTabDragFeel';
import styles from './sessionTabDrag.module.css';

const GHOST_MIN_W = 60;

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

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
  const ms = prefersReducedMotion() ? 0 : SESSION_TAB_STRIP_SHIFT_MS;
  tabs.forEach((r, i) => {
    const offset = offsets[i] ?? 0;
    r.el.style.transition = `transform ${ms}ms ${SESSION_TAB_STRIP_SHIFT_EASE}`;
    r.el.style.transform = offset !== 0 ? `translateX(${offset}px)` : '';
  });
}

export function posIndicator(
  el: HTMLDivElement,
  box: { left: number; top: number; width: number; height: number }
) {
  const hidden = el.style.display === 'none' || el.style.display === '';
  const left = `${box.left}px`;
  const top = `${box.top}px`;
  const width = `${box.width}px`;
  const height = `${box.height}px`;
  if (
    !hidden &&
    el.style.left === left &&
    el.style.top === top &&
    el.style.width === width &&
    el.style.height === height
  ) {
    return;
  }
  el.style.display = 'flex';
  el.style.left = left;
  el.style.top = top;
  el.style.width = width;
  el.style.height = height;
  if (!hidden) return;
  el.style.transition = 'none';
  el.style.opacity = '0';
  // 双帧：先提交透明帧，再交还样式表过渡，避免同帧清掉透明度导致淡入被吃掉。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!el.isConnected || el.style.display === 'none') return;
      el.style.transition = '';
      el.style.opacity = '';
    });
  });
}

export function concealIndicator(el: HTMLDivElement | null): void {
  if (!el) return;
  el.style.display = 'none';
  el.style.opacity = '';
  el.style.transition = '';
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

/** 浮卡尺寸跟源标签；外观走样式表。class 保留 tree-drag-card，配合 is-detached。 */
export function createGhostPill(
  title: string,
  sourceWidth?: number,
  sourceHeight?: number
): HTMLDivElement {
  const ghost = document.createElement('div');
  const moduleClass = styles.card || '';
  ghost.className = [moduleClass, 'tree-drag-card'].filter(Boolean).join(' ');
  ghost.setAttribute('aria-hidden', 'true');
  const computedWidth =
    sourceWidth && sourceWidth > 0
      ? Math.min(Math.max(sourceWidth, GHOST_MIN_W), TAB_WIDTH_MAX_PX)
      : SESSION_TAB_INDICATOR_W;
  const computedHeight =
    sourceHeight && sourceHeight > 0 ? Math.round(sourceHeight) : TAB_HEIGHT_PX;
  ghost.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'pointer-events: none',
    'box-sizing: border-box',
    `width: ${Math.round(computedWidth)}px`,
    `height: ${computedHeight}px`,
    'transform: translate3d(-9999px, -9999px, 0)',
    'opacity: 0',
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
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!ghost.isConnected) return;
      ghost.style.opacity = '';
    });
  });
  return ghost;
}

export function setGhostDetached(card: HTMLElement | null, detached: boolean) {
  if (!card) return;
  card.classList.toggle('is-detached', detached);
  if (ghostClasses.detached) {
    card.classList.toggle(ghostClasses.detached, detached);
  }
}
