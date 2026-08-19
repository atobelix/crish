import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  commitSessionPaneDrop,
  commitSessionTabStripReorder,
} from './sessionTabDropCommit';
import {
  collectStripTabs,
  createGhostPill,
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
  type PaneDropRegion,
} from './sessionTabDragFeel';

export interface UseTopBarDragResult {
  isDragging: boolean;
  startSessionDrag: (
    sessionId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  startToolDrag: (
    leafId: string,
    tabId: string,
    panelId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  setGhostRef: (el: HTMLDivElement | null) => void;
  ghostLabel: string | null;
}

const SessionTabDragContext = createContext<UseTopBarDragResult | null>(null);

const NOOP_DRAG: UseTopBarDragResult = {
  isDragging: false,
  startSessionDrag: () => {},
  startToolDrag: () => {},
  setGhostRef: () => {},
  ghostLabel: null,
};

const INDICATOR_GEOM_TRANSITION = [
  `left ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `top ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `width ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  `height ${SESSION_TAB_INDICATOR_GEOM_MS}ms cubic-bezier(.2,0,0,1)`,
  'border-radius 100ms ease',
  'opacity 80ms ease',
].join(', ');

const INDICATOR_SOFT_TRANSITION =
  'border-radius 100ms ease, opacity 80ms ease';

type DragTarget =
  | { kind: 'strip'; insertIdx: number; remainingIds: string[] }
  | { kind: 'pane'; leafId: string; region: PaneDropRegion };

export function SessionTabDragProvider({ children }: { children: ReactNode }) {
  const [isDragging, setIsDragging] = useState(false);
  const [ghostLabel, setGhostLabel] = useState<string | null>(null);
  const customGhostRef = useRef<HTMLDivElement | null>(null);

  const setGhostRef = useCallback((el: HTMLDivElement | null) => {
    customGhostRef.current = el;
  }, []);

  const startSessionDrag = useCallback(
    (sessionId: string, title: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const closeBtn = (e.target as HTMLElement | null)?.closest?.(
        '[data-tab-close]'
      );
      if (closeBtn) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const sourceTab = (e.currentTarget as HTMLElement | null) ?? null;

      try {
        e.currentTarget?.setPointerCapture?.(pointerId);
      } catch {
        /* ignore */
      }

      let dragging = false;
      let indicator: HTMLDivElement | null = null;
      let foreignStrip: HTMLElement | null = null;
      let cachedTabs: ReturnType<typeof collectStripTabs> | null = null;
      let lastStateKey: string | null = null;
      let currentMode: 'strip' | 'pane' | null = null;
      let target: DragTarget | null = null;

      const onPointerMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (!dragging && !exceedsSessionTabDragThresholdL1(dx, dy)) return;

        if (!dragging) {
          dragging = true;
          setIsDragging(true);
          setGhostLabel(title);
          document.body.classList.add('tab-dragging');
          document.body.style.userSelect = 'none';
          sourceTab?.classList.add('is-dragging');
          indicator = createIndicator(title);
        }

        if (!indicator) return;

        const hit = document.elementFromPoint(me.clientX, me.clientY);
        const stripWrap = hit
          ? (hit.closest('[data-global-session-tab-bar]') as HTMLElement | null)
          : null;
        const strip = stripWrap
          ? (stripWrap.querySelector('[role="tablist"]') as HTMLElement | null)
          : null;

        if (strip) {
          if (foreignStrip !== strip) {
            leaveStrip(foreignStrip);
            foreignStrip = strip;
            cachedTabs = collectStripTabs(strip, sessionId);
            lastStateKey = null;
          }
          if (!cachedTabs) cachedTabs = collectStripTabs(strip, sessionId);
          const insertIdx = computeSessionTabInsertIndex(
            cachedTabs,
            me.clientX,
            dx
          );
          const stateKey = `strip:${insertIdx}`;
          if (lastStateKey !== stateKey) {
            lastStateKey = stateKey;
            shiftStripTabs(cachedTabs, insertIdx);
          }

          const entering = currentMode !== 'strip';
          currentMode = 'strip';
          indicator.classList.add(indicatorClasses.strip);
          indicator.classList.remove(indicatorClasses.pane);
          indicator.style.display = 'flex';
          indicator.style.transition = entering
            ? INDICATOR_GEOM_TRANSITION
            : INDICATOR_SOFT_TRANSITION;
          const scrollRect = strip.getBoundingClientRect();
          posIndicator(
            indicator,
            stripDropIndicatorRect(me.clientX, {
              left: scrollRect.left,
              top: scrollRect.top,
              width: scrollRect.width,
              height: scrollRect.height,
            })
          );
          target = {
            kind: 'strip',
            insertIdx,
            remainingIds: cachedTabs.map((t) => t.sessionId),
          };
          return;
        }

        if (foreignStrip) {
          leaveStrip(foreignStrip);
          foreignStrip = null;
          cachedTabs = null;
        }

        const leaves = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-tree-canvas="true"] [data-leaf-id]'
          )
        );
        for (const pane of leaves) {
          const r = pane.getBoundingClientRect();
          const region = detectPaneDropRegion(me.clientX, me.clientY, {
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
          target = { kind: 'pane', leafId, region };
          indicator.classList.add(indicatorClasses.pane);
          indicator.classList.remove(indicatorClasses.strip);
          indicator.style.display = 'flex';
          indicator.style.transition = entering
            ? INDICATOR_GEOM_TRANSITION
            : INDICATOR_SOFT_TRANSITION;
          posIndicator(
            indicator,
            paneDropIndicatorRect(region, {
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
            })
          );
          return;
        }

        target = null;
        lastStateKey = null;
        currentMode = null;
        indicator.style.display = 'none';
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown);
        sourceTab?.classList.remove('is-dragging');
        leaveStrip(foreignStrip);
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        document.body.classList.remove('tab-dragging');
        document.body.style.userSelect = '';
        setIsDragging(false);
        setGhostLabel(null);
      };

      const onPointerUp = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const drop = target;
        const wasDrag = dragging;
        cleanup();
        if (!wasDrag || !drop) return;
        if (drop.kind === 'strip') {
          commitSessionTabStripReorder(
            sessionId,
            drop.insertIdx,
            drop.remainingIds
          );
          return;
        }
        commitSessionPaneDrop(sessionId, drop.leafId, drop.region, title);
      };

      const onPointerCancel = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        cleanup();
      };

      const onKeyDown = (ke: KeyboardEvent) => {
        if (ke.key === 'Escape') cleanup();
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
    },
    []
  );

  const startToolDrag = useCallback(
    (
      _leafId: string,
      _tabId: string,
      _panelId: string,
      title: string,
      e: React.PointerEvent
    ) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      let dragging = false;
      let ghostEl: HTMLDivElement | null = null;

      const onPointerMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (!dragging && !exceedsSessionTabDragThresholdL1(dx, dy)) return;

        if (!dragging) {
          dragging = true;
          setIsDragging(true);
          setGhostLabel(title);
          document.body.classList.add('tab-dragging');
          if (!customGhostRef.current) {
            ghostEl = createGhostPill(title);
          }
        }

        if (dragging) {
          const targetGhost = customGhostRef.current || ghostEl;
          if (targetGhost) {
            targetGhost.style.transform = `translate3d(${me.clientX + 14}px, ${me.clientY + 14}px, 0)`;
          }
        }
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }
        document.body.classList.remove('tab-dragging');
        setIsDragging(false);
        setGhostLabel(null);
      };

      const onPointerUp = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        cleanup();
      };

      const onPointerCancel = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        cleanup();
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    },
    []
  );

  const value = useMemo<UseTopBarDragResult>(
    () => ({
      isDragging,
      startSessionDrag,
      startToolDrag,
      setGhostRef,
      ghostLabel,
    }),
    [isDragging, startSessionDrag, startToolDrag, setGhostRef, ghostLabel]
  );

  return (
    <SessionTabDragContext.Provider value={value}>
      {children}
    </SessionTabDragContext.Provider>
  );
}

export function useSessionTabDrag(): UseTopBarDragResult {
  return useContext(SessionTabDragContext) ?? NOOP_DRAG;
}

export { SESSION_TAB_DRAG_THRESHOLD_L1 } from './sessionTabDragFeel';
