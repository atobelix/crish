import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useWorkspaceShellStore } from '../../store/workspace-shell';
import { GENERAL_FOLDER, canonicalSessionFolder } from '../../api/projectStore';

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

const DRAG_THRESHOLD_PX = 4;

function createGhostPill(title: string): HTMLDivElement {
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
    'background: var(--bg-primary, #1e1e2e)',
    'color: var(--text-primary, #cdd6f4)',
    'border: 1px solid var(--border-color, rgba(255,255,255,0.15))',
    'border-radius: 6px',
    'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
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
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      try {
        e.currentTarget?.setPointerCapture?.(pointerId);
      } catch {
        /* ignore */
      }

      let dragging = false;
      let ghostEl: HTMLDivElement | null = null;

      const onPointerMove = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
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
        window.removeEventListener('keydown', onKeyDown);
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
        if (dragging) {
          const elements =
            typeof document.elementsFromPoint === 'function'
              ? document.elementsFromPoint(me.clientX, me.clientY)
              : [document.elementFromPoint(me.clientX, me.clientY)].filter(Boolean);

          let targetTabEl: HTMLElement | null = null;
          for (const el of elements) {
            if (el instanceof HTMLElement) {
              const tab = el.closest('[data-session-id], [data-topbar-session-id]') as HTMLElement | null;
              if (tab) {
                targetTabEl = tab;
                break;
              }
            }
          }

          const targetSessionId =
            targetTabEl?.getAttribute('data-session-id') ||
            targetTabEl?.getAttribute('data-topbar-session-id');

          if (targetSessionId && targetSessionId !== sessionId) {
            const rect = targetTabEl!.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            const place = me.clientX < midX ? 'before' : 'after';

            let beforeId: string | null = targetSessionId;
            if (place === 'after') {
              const shell = useWorkspaceShellStore.getState();
              const sourceTab = shell.openTabs.find((t) => t.sessionId === sessionId);
              const wsKey = canonicalSessionFolder(sourceTab?.workspaceKey) || GENERAL_FOLDER;
              const sameWsTabs = shell.openTabs.filter(
                (t) => (canonicalSessionFolder(t.workspaceKey) || GENERAL_FOLDER) === wsKey
              );
              const targetIdx = sameWsTabs.findIndex((t) => t.sessionId === targetSessionId);
              if (targetIdx >= 0) {
                const nextTab = sameWsTabs[targetIdx + 1];
                beforeId = nextTab ? nextTab.sessionId : null;
              }
            }
            useWorkspaceShellStore.getState().reorderSessionTab(sessionId, beforeId);
          }
        }
        cleanup();
      };

      const onPointerCancel = (me: PointerEvent) => {
        if (me.pointerId !== pointerId) return;
        cleanup();
      };

      const onKeyDown = (ke: KeyboardEvent) => {
        if (ke.key === 'Escape') {
          cleanup();
        }
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

        if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
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
