/**
 * 工具标签拖拽的指针运行时。
 *
 * 与会话标签拖拽共用同一套手感常量与位移动画（sessionTabDragFeel / sessionTabDragDom），
 * 差异只有两处：认标签用 data-tool-tab-id，落点提交走 toolTabDropCommit。
 *
 * 相对会话链路做了两处优化：
 * 1. pointermove 用 rAF 合帧——高刷鼠标一帧能来七八个事件，
 *    每个都做 elementFromPoint + getBoundingClientRect 是纯浪费；
 * 2. 拖到标签条左右边缘时自动横向滚动，标签多到溢出时也能拖到两端。
 */

import type React from 'react';
import {
  collectStripTabs,
  createIndicator,
  indicatorClasses,
  leaveStrip,
  posIndicator,
  shiftStripTabs,
} from './sessionTabDragDom';
import {
  SESSION_TAB_INDICATOR_GEOM_MS,
  computeSessionTabInsertIndex,
  detectPaneDropRegion,
  exceedsSessionTabDragThresholdL1,
  paneDropIndicatorRect,
  stripDropIndicatorRect,
} from './sessionTabDragFeel';
import {
  beginToolTabDrag,
  cancelToolTabDrag,
  commitToolTabDrop,
  type ToolTabDragSource,
  type ToolTabDropTarget,
} from './toolTabDropCommit';

const GEOM_TRANSITION = [
  `left ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `top ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `width ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `height ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  'border-radius 100ms ease',
  'opacity 80ms ease',
].join(', ');

const SOFT_TRANSITION = 'border-radius 100ms ease, opacity 80ms ease';

/** 边缘自动滚动：命中区宽度与每帧步长 */
const EDGE_SCROLL_ZONE_PX = 36;
const EDGE_SCROLL_STEP_PX = 12;

export interface ToolTabDragCallbacks {
  onDragStart: (title: string) => void;
  onDragEnd: () => void;
}

function autoScrollStrip(track: HTMLElement | null, clientX: number): void {
  if (!track || track.scrollWidth <= track.clientWidth) return;
  const r = track.getBoundingClientRect();
  if (clientX < r.left + EDGE_SCROLL_ZONE_PX) {
    track.scrollLeft -= EDGE_SCROLL_STEP_PX;
  } else if (clientX > r.right - EDGE_SCROLL_ZONE_PX) {
    track.scrollLeft += EDGE_SCROLL_STEP_PX;
  }
}

/**
 * 真正拖动过之后，浏览器仍会在 pointerup 后补一个 click。
 * 不吞掉的话，刚搬走的标签会被源叶的 onClick 再激活一次。
 */
function swallowNextClick(): void {
  const eat = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener('click', eat, { capture: true, once: true });
  // 若这一次没有补发 click（例如源节点已随重排卸载），及时撤掉监听
  window.setTimeout(() => {
    window.removeEventListener('click', eat, { capture: true });
  }, 0);
}

export function runToolTabDrag(
  source: ToolTabDragSource,
  title: string,
  e: React.PointerEvent,
  cb: ToolTabDragCallbacks
): void {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest?.('[data-tab-close], button'))
    return;

  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  const sourceTab = (e.currentTarget as HTMLElement | null) ?? null;

  let dragging = false;
  let indicator: HTMLDivElement | null = null;
  let hoveredStrip: HTMLElement | null = null;
  let cachedTabs: ReturnType<typeof collectStripTabs> | null = null;
  let lastStateKey: string | null = null;
  let currentMode: 'strip' | 'pane' | null = null;
  let target: ToolTabDropTarget | null = null;
  let rafId = 0;
  let pending: { x: number; y: number; dx: number } | null = null;

  const applyStrip = (x: number, dx: number, strip: HTMLElement): boolean => {
    const leafId =
      strip
        .closest('[data-leaf-tool-tab-strip]')
        ?.getAttribute('data-tab-strip-leaf-id') || '';
    if (!leafId || !indicator) return false;

    if (hoveredStrip !== strip) {
      leaveStrip(hoveredStrip);
      hoveredStrip = strip;
      cachedTabs = null;
      lastStateKey = null;
    }
    if (!cachedTabs) {
      cachedTabs = collectStripTabs(strip, source.tabId, 'data-tool-tab-id');
    }

    const insertIdx = computeSessionTabInsertIndex(cachedTabs, x, dx);
    const stateKey = `strip:${leafId}:${insertIdx}`;
    if (lastStateKey !== stateKey) {
      lastStateKey = stateKey;
      shiftStripTabs(cachedTabs, insertIdx);
    }

    const entering = currentMode !== 'strip';
    currentMode = 'strip';
    if (indicatorClasses.strip) indicator.classList.add(indicatorClasses.strip);
    if (indicatorClasses.pane) indicator.classList.remove(indicatorClasses.pane);
    indicator.style.display = 'flex';
    indicator.style.transition = entering ? GEOM_TRANSITION : SOFT_TRANSITION;

    const r = strip.getBoundingClientRect();
    posIndicator(
      indicator,
      stripDropIndicatorRect(x, {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      })
    );

    const beforeTab = cachedTabs[insertIdx]?.id;
    target = {
      kind: 'strip',
      targetLeafId: leafId,
      ...(beforeTab ? { targetTabId: beforeTab } : {}),
    };
    return true;
  };

  const applyPane = (x: number, y: number): boolean => {
    if (!indicator) return false;
    const leaves = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-tree-canvas="true"] [data-leaf-id]'
      )
    );
    for (const pane of leaves) {
      const r = pane.getBoundingClientRect();
      const region = detectPaneDropRegion(x, y, {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      });
      if (!region) continue;
      const leafId = pane.getAttribute('data-leaf-id') || '';
      if (!leafId) continue;

      const stateKey = `pane:${leafId}:${region}`;
      const entering = currentMode !== 'pane' || lastStateKey !== stateKey;
      lastStateKey = stateKey;
      currentMode = 'pane';
      if (indicatorClasses.pane) indicator.classList.add(indicatorClasses.pane);
      if (indicatorClasses.strip)
        indicator.classList.remove(indicatorClasses.strip);
      indicator.style.display = 'flex';
      indicator.style.transition = entering ? GEOM_TRANSITION : SOFT_TRANSITION;
      posIndicator(
        indicator,
        paneDropIndicatorRect(region, {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
        })
      );
      target = { kind: 'pane', targetLeafId: leafId, region };
      return true;
    }
    return false;
  };

  const flush = () => {
    rafId = 0;
    const p = pending;
    pending = null;
    if (!p || !indicator) return;

    const hit = document.elementFromPoint(p.x, p.y);
    const stripHost = hit
      ? (hit.closest('[data-leaf-tool-tab-strip]') as HTMLElement | null)
      : null;
    const strip = stripHost
      ? (stripHost.querySelector('[role="tablist"]') as HTMLElement | null)
      : null;

    if (strip) {
      autoScrollStrip(strip.parentElement, p.x);
      if (applyStrip(p.x, p.dx, strip)) return;
    }

    if (hoveredStrip) {
      leaveStrip(hoveredStrip);
      hoveredStrip = null;
      cachedTabs = null;
    }

    if (applyPane(p.x, p.y)) return;

    target = null;
    lastStateKey = null;
    currentMode = null;
    indicator.style.display = 'none';
  };

  const onPointerMove = (me: PointerEvent) => {
    if (me.pointerId !== pointerId) return;
    const dx = me.clientX - startX;
    const dy = me.clientY - startY;
    if (!dragging && !exceedsSessionTabDragThresholdL1(dx, dy)) return;

    if (!dragging) {
      dragging = true;
      cb.onDragStart(title);
      document.body.classList.add('tab-dragging');
      document.body.style.userSelect = 'none';
      sourceTab?.classList.add('is-dragging');
      indicator = createIndicator(title);
      beginToolTabDrag(source);
    }

    pending = { x: me.clientX, y: me.clientY, dx };
    if (!rafId) rafId = requestAnimationFrame(flush);
  };

  const cleanup = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    pending = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    sourceTab?.classList.remove('is-dragging');
    leaveStrip(hoveredStrip);
    hoveredStrip = null;
    if (indicator) {
      indicator.remove();
      indicator = null;
    }
    document.body.classList.remove('tab-dragging');
    document.body.style.userSelect = '';
    cb.onDragEnd();
  };

  const onPointerUp = (me: PointerEvent) => {
    if (me.pointerId !== pointerId) return;
    const drop = target;
    const wasDrag = dragging;
    cleanup();
    if (wasDrag) swallowNextClick();
    if (!wasDrag || !drop) {
      cancelToolTabDrag();
      return;
    }
    commitToolTabDrop(source, drop);
  };

  const onPointerCancel = (me: PointerEvent) => {
    if (me.pointerId !== pointerId) return;
    cleanup();
    cancelToolTabDrag();
  };

  const onKeyDown = (ke: KeyboardEvent) => {
    if (ke.key !== 'Escape') return;
    cleanup();
    cancelToolTabDrag();
  };

  try {
    e.currentTarget?.setPointerCapture?.(pointerId);
  } catch {
    /* 捕获失败不致命：window 级监听仍能跟到指针 */
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);
}
