import React, { useCallback, useRef, useState } from 'react';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import type { SessionState } from '../../../store/layoutStore';
import styles from '../SidebarSessionList.module.css';
import type { SidebarDragItem } from './sessionListTypes';

export type DropPlace = 'before' | 'after';

export type DropIndicator = {
  sessionId: string;
  place: DropPlace;
};

/** Live visual preview while dragging (does not require store order to match activity sort). */
export type SessionDragPreview = {
  sessionId: string;
  overSessionId: string | null;
  place: DropPlace;
  isPinned: boolean;
  folder: string;
};

export type UseSessionListDragOpts = {
  pinnedZoneRef: React.RefObject<HTMLElement | null>;
  sessionListRef: React.RefObject<HTMLElement | null>;
  renamingSessionId: string | null;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
};

export type UseSessionListDragResult = {
  activeDragItem: SidebarDragItem | null;
  dragOverPinned: boolean;
  dropIndicator: DropIndicator | null;
  dragPreview: SessionDragPreview | null;
  startSessionDrag: (
    e: React.PointerEvent,
    sessionId: string,
    folderName?: string
  ) => void;
};

const DRAG_THRESHOLD_PX = 6;

type LastCommit = {
  targetSessionId: string | null;
  folder: string;
  isPinned: boolean;
};

/**
 * Reorder a section list for live drag preview.
 * - Removes the dragged row from `list`
 * - If this list is the drop target section, re-inserts at overId/place
 * - `dragSession` supplies the row payload when the item originates outside this list
 */
export function applyDragPreview(
  list: SessionState[],
  preview: SessionDragPreview,
  dragSession: SessionState | null,
  listIsTarget: boolean
): SessionState[] {
  const without = list.filter((s) => s.id !== preview.sessionId);
  if (!listIsTarget) return without;

  const source =
    dragSession && dragSession.id === preview.sessionId
      ? dragSession
      : list.find((s) => s.id === preview.sessionId) || null;
  if (!source) return without;

  const virtual: SessionState = {
    ...source,
    isPinned: preview.isPinned,
    folder: preview.folder,
  };

  if (!preview.overSessionId) {
    return [...without, virtual];
  }

  const idx = without.findIndex((s) => s.id === preview.overSessionId);
  if (idx === -1) return [...without, virtual];

  const insertAt = preview.place === 'before' ? idx : idx + 1;
  const next = without.slice();
  next.splice(insertAt, 0, virtual);
  return next;
}

/** Whether a section (pinned / general / project folder) is the preview drop target. */
export function isPreviewTargetSection(
  preview: SessionDragPreview,
  kind: 'pinned' | 'general' | 'project',
  projectId?: string
): boolean {
  if (kind === 'pinned') return preview.isPinned;
  if (preview.isPinned) return false;
  if (kind === 'general') {
    return (
      preview.folder === GENERAL_FOLDER ||
      preview.folder === '会话' ||
      preview.folder === '常规会话' ||
      preview.folder === 'general' ||
      !preview.folder
    );
  }
  return Boolean(projectId && preview.folder === projectId);
}

/** Convert preview place into moveSessionRealtime insert-before target. */
export function previewToInsertBeforeId(
  sectionIds: string[],
  overSessionId: string | null,
  place: DropPlace
): string | null {
  if (!overSessionId) return null;
  const idx = sectionIds.indexOf(overSessionId);
  if (idx === -1) return overSessionId;
  if (place === 'before') return overSessionId;
  const next = sectionIds[idx + 1];
  return next ?? null;
}

function isGeneralFolderName(folder: string | null | undefined): boolean {
  const f = (folder || '').trim();
  return (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  );
}

function resolveDropTarget(
  clientX: number,
  clientY: number,
  pinnedZone: HTMLElement | null,
  fallbackFolder: string
): {
  overPinned: boolean;
  targetSessionId: string | null;
  place: DropPlace;
  folder: string;
} {
  // Ghost has pointer-events:none so elementsFromPoint skips it; no display toggle.
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? (document.elementsFromPoint(clientX, clientY) as Element[])
      : ([document.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[]);

  let hovered: Element | null = null;
  const ghostClass = styles.sidebarDragGhost || 'sidebar-drag-ghost';
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    // Defense in depth if pointer-events is overridden on a clone subtree
    if (
      node.classList.contains(ghostClass) ||
      node.classList.contains('sidebar-drag-ghost') ||
      node.closest(`.${ghostClass}`) ||
      node.closest('.sidebar-drag-ghost')
    ) {
      continue;
    }
    hovered = node;
    break;
  }

  if (!hovered) {
    return {
      overPinned: false,
      targetSessionId: null,
      place: 'before',
      folder: fallbackFolder,
    };
  }

  const overPinned = Boolean(
    hovered.closest('[data-drop-zone="pinned"]') ||
      (styles.pinnedDropZone && hovered.closest(`.${styles.pinnedDropZone}`)) ||
      (styles.pinnedList && hovered.closest(`.${styles.pinnedList}`) && pinnedZone?.contains(hovered)) ||
      (pinnedZone && (hovered === pinnedZone || pinnedZone.contains(hovered as Node)))
  );

  const sessionWrap = hovered.closest('[data-session-id]') as HTMLElement | null;
  const targetSessionId: string | null =
    sessionWrap?.getAttribute('data-session-id') || null;
  let place: DropPlace = 'before';

  if (sessionWrap && targetSessionId) {
    const rect = sessionWrap.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    place = clientY < mid ? 'before' : 'after';
  }

  const folderEl = hovered.closest('[data-folder-name]') as HTMLElement | null;
  const generalZone = hovered.closest('[data-drop-zone="general"]');
  let folder = fallbackFolder;

  if (overPinned) {
    // Keep original folder identity when pinning; pin is orthogonal to folder.
    folder = fallbackFolder || GENERAL_FOLDER;
  } else if (folderEl) {
    folder = folderEl.getAttribute('data-folder-name') || fallbackFolder || GENERAL_FOLDER;
  } else if (generalZone) {
    folder = GENERAL_FOLDER;
  } else if (isGeneralFolderName(fallbackFolder)) {
    folder = GENERAL_FOLDER;
  }

  // Don't treat the dragged row itself as insert target (caller filters).
  return { overPinned, targetSessionId, place, folder };
}

function buildGhostFromRow(
  el: HTMLElement | null,
  elRect: DOMRect | undefined
): HTMLDivElement | null {
  if (!el) return null;
  const ghost = el.cloneNode(true) as HTMLDivElement;
  ghost.className = `${styles.sidebarDragGhost || ''} sidebar-drag-ghost`.trim();
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position:fixed',
    `width:${elRect?.width ?? 180}px`,
    `height:${elRect?.height ?? 40}px`,
    'left:0',
    'top:0',
    'pointer-events:none',
    'z-index:9999',
    'opacity:0.92',
    'margin:0',
    'list-style:none',
    'box-sizing:border-box',
  ].join(';');
  // Flatten nested interactive bits
  ghost.querySelectorAll('button, input, a').forEach((n) => {
    (n as HTMLElement).tabIndex = -1;
  });
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Pointer-based session list drag: live row reorder preview, pin zone, drop indicators.
 * Store commit is throttled to distinct (target, folder, isPinned) tuples; pointerup cleans up.
 */
export function useSessionListDrag(
  opts: UseSessionListDragOpts
): UseSessionListDragResult {
  const {
    pinnedZoneRef,
    renamingSessionId,
    onMoveSessionRealtime,
  } = opts;

  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(null);
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [dragPreview, setDragPreview] = useState<SessionDragPreview | null>(null);

  const onMoveRef = useRef(onMoveSessionRealtime);
  onMoveRef.current = onMoveSessionRealtime;
  const pinnedZoneRefStable = useRef(pinnedZoneRef);
  pinnedZoneRefStable.current = pinnedZoneRef;

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0 || renamingSessionId === sessionId) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const originFolder =
        (folderName && folderName.trim()) || GENERAL_FOLDER;

      let dragging = false;
      let dragOverlay: HTMLDivElement | null = null;
      let raf = 0;
      let pendingPointer: { x: number; y: number } | null = null;
      let lastCommit: LastCommit | null = null;
      let lastPreviewKey = '';

      const el = (e.currentTarget as HTMLElement).closest('li') as HTMLElement | null;
      const elRect = el?.getBoundingClientRect();
      const offsetX = startX - (elRect?.left ?? startX);
      const offsetY = startY - (elRect?.top ?? startY);

      const applyPointer = (clientX: number, clientY: number) => {
        if (!dragging) return;

        if (dragOverlay) {
          dragOverlay.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px)`;
        }

        const hit = resolveDropTarget(
          clientX,
          clientY,
          pinnedZoneRefStable.current.current,
          originFolder
        );

        // Ignore self as drop target for indicator / insert-before
        let overId = hit.targetSessionId;
        if (overId === sessionId) {
          overId = null;
        }

        const isPinned = hit.overPinned;
        const folder = isPinned
          ? originFolder
          : isGeneralFolderName(hit.folder)
            ? GENERAL_FOLDER
            : hit.folder;

        setDragOverPinned(isPinned);

        const preview: SessionDragPreview = {
          sessionId,
          overSessionId: overId,
          place: hit.place,
          isPinned,
          folder,
        };

        const previewKey = `${preview.overSessionId ?? ''}|${preview.place}|${preview.isPinned}|${preview.folder}`;
        if (previewKey !== lastPreviewKey) {
          lastPreviewKey = previewKey;
          setDragPreview(preview);
          setDropIndicator(
            overId ? { sessionId: overId, place: hit.place } : null
          );
        }

        // Insert-before for store: when place=after, next sibling or null (end).
        // Section sibling resolution is approximate here (DOM order among [data-session-id]).
        let insertBeforeId: string | null = overId;
        if (overId && hit.place === 'after') {
          const listRoot =
            (document.querySelector(
              isPinned
                ? '[data-drop-zone="pinned"]'
                : isGeneralFolderName(folder)
                  ? '[data-drop-zone="general"]'
                  : `[data-folder-name="${CSS.escape ? CSS.escape(folder) : folder.replace(/"/g, '\\"')}"]`
            ) as HTMLElement | null) || null;
          const ids = listRoot
            ? Array.from(
                listRoot.querySelectorAll<HTMLElement>('[data-session-id]')
              )
                .map((n) => n.getAttribute('data-session-id') || '')
                .filter((id) => id && id !== sessionId)
            : [];
          insertBeforeId = previewToInsertBeforeId(ids, overId, 'after');
        }

        const commit: LastCommit = {
          targetSessionId: insertBeforeId,
          folder,
          isPinned,
        };

        if (
          !lastCommit ||
          lastCommit.targetSessionId !== commit.targetSessionId ||
          lastCommit.folder !== commit.folder ||
          lastCommit.isPinned !== commit.isPinned
        ) {
          lastCommit = commit;
          onMoveRef.current(
            sessionId,
            commit.targetSessionId,
            commit.folder,
            commit.isPinned
          );
        }
      };

      const scheduleApply = (clientX: number, clientY: number) => {
        pendingPointer = { x: clientX, y: clientY };
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const p = pendingPointer;
          pendingPointer = null;
          if (p) applyPointer(p.x, p.y);
        });
      };

      const move = (me: PointerEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          dragging = true;
          try {
            (e as unknown as PointerEvent).preventDefault?.();
          } catch {
            /* ignore */
          }
          document.body.classList.add('sidebar-dragging');
          setActiveDragItem({
            type: 'session',
            sessionId,
            ...(folderName !== undefined ? { folderName } : {}),
          });
          dragOverlay = buildGhostFromRow(el, elRect);
          if (dragOverlay) {
            dragOverlay.style.transform = `translate(${me.clientX - offsetX}px, ${me.clientY - offsetY}px)`;
          }
          // First frame hit-test immediately (correct pin/folder; no false unpin flash)
          applyPointer(me.clientX, me.clientY);
        }
        if (!dragging) return;
        scheduleApply(me.clientX, me.clientY);
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (dragOverlay) {
          dragOverlay.remove();
          dragOverlay = null;
        }
        document.body.classList.remove('sidebar-dragging');
        setActiveDragItem(null);
        setDragOverPinned(false);
        setDropIndicator(null);
        setDragPreview(null);
      };

      const up = () => {
        // Final rAF flush so last position commits before cleanup
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (dragging && pendingPointer) {
          applyPointer(pendingPointer.x, pendingPointer.y);
          pendingPointer = null;
        } else if (dragging && lastCommit) {
          // Ensure last commit is durable (no-op if store already matches)
          onMoveRef.current(
            sessionId,
            lastCommit.targetSessionId,
            lastCommit.folder,
            lastCommit.isPinned
          );
        }
        cleanup();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [renamingSessionId]
  );

  return {
    activeDragItem,
    dragOverPinned,
    dropIndicator,
    dragPreview,
    startSessionDrag,
  };
}
