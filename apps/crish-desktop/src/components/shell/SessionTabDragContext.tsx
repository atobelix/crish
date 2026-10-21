import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  commitSessionTabDrop,
  type SessionTabDropTarget,
} from './sessionTabDropCommit';
import {
  collectStripTabs,
  concealIndicator,
  createGhostPill,
  createIndicator,
  indicatorClasses,
  leaveStrip,
  posIndicator,
  setGhostDetached,
  shiftStripTabs,
  type CollectedStripData,
} from './sessionTabDragDom';
import {
  SESSION_TAB_SHIFT_GAP,
  computeSessionTabInsertIndex,
  computeStripTabOffsets,
  detectPaneDropRegion,
  exceedsSessionTabDragThresholdL1,
  paneDropIndicatorRect,
} from './sessionTabDragFeel';

export interface StartSessionDragArgs {
  leafId: string;
  tabId: string;
  title: string;
  e: React.PointerEvent;
}

export interface UseSessionTabDragResult {
  isDragging: boolean;
  startSessionDrag: (
    leafId: string,
    tabId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
}

const SessionTabDragContext = createContext<UseSessionTabDragResult | null>(
  null
);

const NOOP_DRAG: UseSessionTabDragResult = {
  isDragging: false,
  startSessionDrag: () => {},
};

const EDGE_SCROLL_ZONE_PX = 36;
const EDGE_SCROLL_STEP_PX = 12;

function autoScrollStrip(track: HTMLElement | null, clientX: number): boolean {
  if (!track || track.scrollWidth <= track.clientWidth) return false;
  const r = track.getBoundingClientRect();
  const before = track.scrollLeft;
  if (clientX < r.left + EDGE_SCROLL_ZONE_PX) {
    track.scrollLeft -= EDGE_SCROLL_STEP_PX;
  } else if (clientX > r.right - EDGE_SCROLL_ZONE_PX) {
    track.scrollLeft += EDGE_SCROLL_STEP_PX;
  }
  return track.scrollLeft !== before;
}

/** 真正拖过之后吞掉随后 click，避免源 tab 卸载前被再激活。 */
function swallowNextClick(): void {
  const eat = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener('click', eat, { capture: true, once: true });
  window.setTimeout(() => {
    window.removeEventListener('click', eat, { capture: true });
  }, 0);
}

export function SessionTabDragProvider({ children }: { children: ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);

  const startSessionDrag = useCallback(
    (
      sourceLeafId: string,
      tabId: string,
      title: string,
      e: React.PointerEvent
    ) => {
      if (e.button !== 0) return;
      if (!sourceLeafId || !tabId) return;
      const closeBtn = (e.target as HTMLElement | null)?.closest?.(
        '[data-tab-close], button'
      );
      if (closeBtn) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const sourceTab = (e.currentTarget as HTMLElement | null) ?? null;
      const sourceRect = sourceTab?.getBoundingClientRect();
      const sourceWidth = sourceRect?.width ?? 0;
      const grabOffsetX = sourceRect
        ? Math.max(
            10,
            Math.min(e.clientX - sourceRect.left, sourceRect.width - 10)
          )
        : 10;
      const grabOffsetY = sourceRect
        ? Math.max(
            5,
            Math.min(e.clientY - sourceRect.top, sourceRect.height - 5)
          )
        : 5;
      const shiftPx =
        (sourceWidth > 0 ? sourceWidth : 150) + SESSION_TAB_SHIFT_GAP;

      try {
        e.currentTarget?.setPointerCapture?.(pointerId);
      } catch {
        /* 捕获失败不致命：window 级监听仍能跟到指针 */
      }

      let dragging = false;
      let card: HTMLDivElement | null = null;
      let indicator: HTMLDivElement | null = null;
      let foreignStrip: HTMLElement | null = null;
      let cachedTabs: CollectedStripData | null = null;
      let lastStateKey: string | null = null;
      let currentMode: 'strip' | 'pane' | null = null;
      let target: SessionTabDropTarget | null = null;
      let rafId = 0;
      let pending: { x: number; y: number; dx: number } | null = null;

      const hideIndicator = () => {
        concealIndicator(indicator);
      };

      const applyStrip = (
        x: number,
        dx: number,
        strip: HTMLElement
      ): boolean => {
        const wrap = strip.closest(
          '[data-pane-header="true"]'
        ) as HTMLElement | null;
        const targetLeafId =
          wrap?.closest('[data-leaf-id]')?.getAttribute('data-leaf-id') || '';
        if (!targetLeafId || !indicator) return false;

        if (foreignStrip !== strip) {
          leaveStrip(foreignStrip);
          foreignStrip = strip;
          cachedTabs = null;
          lastStateKey = null;
        }
        if (!cachedTabs) {
          cachedTabs = collectStripTabs(strip, tabId, 'data-tab-id');
        }

        const insertIdx = computeSessionTabInsertIndex(cachedTabs.tabs, x, dx);
        const stateKey = `strip:${targetLeafId}:${insertIdx}`;
        if (lastStateKey !== stateKey) {
          lastStateKey = stateKey;
          const offsets = computeStripTabOffsets({
            tabCount: cachedTabs.tabs.length,
            sourceIndex: cachedTabs.sourceIndex,
            insertIndex: insertIdx,
            shiftPx,
          });
          shiftStripTabs(cachedTabs.tabs, offsets);
        }

        currentMode = 'strip';
        setGhostDetached(card, false);
        hideIndicator();
        if (indicatorClasses.strip) {
          indicator.classList.add(indicatorClasses.strip);
        }
        if (indicatorClasses.pane) {
          indicator.classList.remove(indicatorClasses.pane);
        }

        target = { kind: 'strip', targetLeafId, insertIdx };
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
          const regionChanged =
            currentMode !== 'pane' || lastStateKey !== stateKey;
          lastStateKey = stateKey;
          currentMode = 'pane';
          target = { kind: 'pane', targetLeafId: leafId, region };
          setGhostDetached(card, true);
          if (indicatorClasses.pane) {
            indicator.classList.add(indicatorClasses.pane);
          }
          if (indicatorClasses.strip) {
            indicator.classList.remove(indicatorClasses.strip);
          }
          if (!regionChanged) return true;
          posIndicator(
            indicator,
            paneDropIndicatorRect(region, {
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
            })
          );
          return true;
        }
        return false;
      };

      const flush = () => {
        rafId = 0;
        const p = pending;
        pending = null;
        if (!p || !indicator) return;

        if (card) {
          card.style.transform = `translate3d(${p.x - grabOffsetX}px, ${p.y - grabOffsetY}px, 0)`;
        }

        const hit = document.elementFromPoint(p.x, p.y);
        const toolStrip = hit
          ? (hit.closest('[data-leaf-tool-tab-strip]') as HTMLElement | null)
          : null;
        const stripWrap =
          !toolStrip && hit
            ? (hit.closest('[data-pane-header="true"]') as HTMLElement | null)
            : null;
        const strip = stripWrap
          ? (stripWrap.querySelector('[role="tablist"]') as HTMLElement | null)
          : null;

        // 垂直防抖滞后区间：双向保护，若已在 strip 模式提供更大滞后缓冲区避免轻微手抖跳出
        const wrapRect = stripWrap?.getBoundingClientRect();
        const preferStrip = wrapRect
          ? currentMode === 'strip'
            ? p.y >= wrapRect.top - 12 && p.y <= wrapRect.bottom + 16
            : p.y >= wrapRect.top - 6 && p.y <= wrapRect.bottom + 8
          : false;

        if (strip && preferStrip) {
          if (autoScrollStrip(strip, p.x)) {
            cachedTabs = collectStripTabs(strip, tabId, 'data-tab-id');
            lastStateKey = null;
          }
          if (applyStrip(p.x, p.dx, strip)) return;
        }

        if (foreignStrip) {
          leaveStrip(foreignStrip);
          foreignStrip = null;
          cachedTabs = null;
        }

        if (applyPane(p.x, p.y)) return;

        target = null;
        lastStateKey = null;
        currentMode = null;
        setGhostDetached(card, true);
        hideIndicator();
      };

      const onPointerMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (!dragging && !exceedsSessionTabDragThresholdL1(dx, dy)) return;

        if (!dragging) {
          dragging = true;
          setIsDragging(true);
          document.body.classList.add('is-tab-dragging');
          sourceTab?.classList.add('is-dragging');
          card = createGhostPill(title, sourceWidth, sourceRect?.height);
          indicator = createIndicator(title);
        }

        pending = { x: me.clientX, y: me.clientY, dx };
        if (card) {
          card.style.transform = `translate3d(${me.clientX - grabOffsetX}px, ${me.clientY - grabOffsetY}px, 0)`;
        }
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
        leaveStrip(foreignStrip);
        foreignStrip = null;
        if (card) {
          card.remove();
          card = null;
        }
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        document.body.classList.remove('is-tab-dragging');
        setIsDragging(false);
      };

      const onPointerUp = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const drop = target;
        const wasDrag = dragging;
        cleanup();
        if (wasDrag) swallowNextClick();
        if (!wasDrag || !drop) return;
        commitSessionTabDrop({
          sourceLeafId,
          tabId,
          target: drop,
        });
      };

      const onPointerCancel = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        cleanup();
      };

      const onKeyDown = (ke: KeyboardEvent) => {
        if (ke.key !== 'Escape') return;
        cleanup();
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
    },
    []
  );

  const value = useMemo<UseSessionTabDragResult>(
    () => ({
      isDragging,
      startSessionDrag,
    }),
    [isDragging, startSessionDrag]
  );

  return (
    <SessionTabDragContext.Provider value={value}>
      {children}
    </SessionTabDragContext.Provider>
  );
}

export function useSessionTabDrag(): UseSessionTabDragResult {
  return useContext(SessionTabDragContext) ?? NOOP_DRAG;
}

export { SESSION_TAB_DRAG_THRESHOLD_L1 } from './sessionTabDragFeel';
