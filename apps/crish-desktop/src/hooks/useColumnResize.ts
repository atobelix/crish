import { useCallback } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import {
  beginLayoutInteraction,
  endLayoutInteraction,
} from '../store/layoutAnimationStore';
import {
  createDragOverlay,
  removeDragOverlay,
  createGlobalCursorStyle,
  removeGlobalCursorStyle,
  disableIframePointerEvents,
} from '../utils/dragOverlay';

export function useColumnResize(wsId: string) {
  const resizeColumns = useLayoutStore((s) => s.resizeColumns);
  const resizeGroups = useLayoutStore((s) => s.resizeGroups);

  const handleColResizerPointerDown = useCallback((
    e: React.PointerEvent,
    colIdx: number,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const splitterEl = e.currentTarget as HTMLElement;
    const canvasEl = splitterEl.closest('.workspace-canvas') as HTMLElement;
    if (!canvasEl) return;

    const cols = canvasEl.querySelectorAll('.workspace-column');
    const colLeftEl = cols[colIdx] as HTMLElement;
    const colRightEl = cols[colIdx + 1] as HTMLElement;
    if (!colLeftEl || !colRightEl) return;

    const startX = e.clientX;
    const containerWidth = canvasEl.clientWidth || 1;

    // 用 getBoundingClientRect 读取真实渲染宽度，避免 style.width 空值/transition 时读取失败
    const leftPct = (colLeftEl.getBoundingClientRect().width / containerWidth) * 100;
    const rightPct = (colRightEl.getBoundingClientRect().width / containerWidth) * 100;

    splitterEl.classList.add('active');
    try { splitterEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    beginLayoutInteraction('workspace-resizing');
    document.body.style.cursor = 'col-resize';
    const overlay = createDragOverlay('col-resize');
    const restoreIframes = disableIframePointerEvents();
    const cursorStyle = createGlobalCursorStyle('col-resize');

    let rafId: number | null = null;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const ratioDelta = dx / containerWidth;
      const ratioLeft = (leftPct / 100) + ratioDelta;
      const ratioRight = (rightPct / 100) - ratioDelta;
      if (ratioLeft > 0.12 && ratioRight > 0.12) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          colLeftEl.style.width = `${ratioLeft * 100}%`;
          colRightEl.style.width = `${ratioRight * 100}%`;
        });
      }
    };

    window.addEventListener('pointermove', handlePointerMove);

    let ended = false;
    const endResize = (upEvent: PointerEvent) => {
      if (ended) return; ended = true;
      try {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        try {
          if (splitterEl.hasPointerCapture?.(upEvent.pointerId)) {
            splitterEl.releasePointerCapture(upEvent.pointerId);
          }
        } catch { /* ignore */ }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', endResize);
        window.removeEventListener('pointercancel', endResize);

        removeDragOverlay(overlay);
        restoreIframes();
        removeGlobalCursorStyle(cursorStyle);
        splitterEl.classList.remove('active');

        const dx = upEvent.clientX - startX;
        resizeColumns(wsId, colIdx, dx, containerWidth);
        colLeftEl.style.width = '';
        colRightEl.style.width = '';

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            endLayoutInteraction('workspace-resizing');
            document.body.style.cursor = '';
          });
        });
      } catch (err) {
        console.error('[useColumnResize] endResize error', err);
        endLayoutInteraction('workspace-resizing');
        document.body.style.cursor = '';
        removeDragOverlay(overlay);
        restoreIframes();
        removeGlobalCursorStyle(cursorStyle);
      }
    };

    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }, [wsId, resizeColumns]);

  const handleGroupResizerPointerDown = useCallback((
    e: React.PointerEvent,
    colIdx: number,
    groupIdx: number,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const splitterEl = e.currentTarget as HTMLElement;
    const colEl = splitterEl.parentElement as HTMLElement;
    if (!colEl) return;

    const cards = colEl.querySelectorAll('.workspace-card');
    const topCardEl = cards[groupIdx] as HTMLElement;
    const bottomCardEl = cards[groupIdx + 1] as HTMLElement;
    if (!topCardEl || !bottomCardEl) return;

    const startY = e.clientY;
    const containerHeight = colEl.clientHeight || 1;

    // 用 getBoundingClientRect 读取真实渲染高度，避免 style.height 空值/transition 时读取失败
    const topPct = (topCardEl.getBoundingClientRect().height / containerHeight) * 100;
    const bottomPct = (bottomCardEl.getBoundingClientRect().height / containerHeight) * 100;

    splitterEl.classList.add('active');
    try { splitterEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    beginLayoutInteraction('workspace-resizing');
    document.body.style.cursor = 'row-resize';
    const overlay = createDragOverlay('row-resize');
    const restoreIframes = disableIframePointerEvents();
    const cursorStyle = createGlobalCursorStyle('row-resize');

    let rafId: number | null = null;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dy = moveEvent.clientY - startY;
      const ratioDelta = dy / containerHeight;
      const ratioTop = (topPct / 100) + ratioDelta;
      const ratioBottom = (bottomPct / 100) - ratioDelta;
      if (ratioTop > 0.1 && ratioBottom > 0.1) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          topCardEl.style.height = `${ratioTop * 100}%`;
          bottomCardEl.style.height = `${ratioBottom * 100}%`;
        });
      }
    };

    window.addEventListener('pointermove', handlePointerMove);

    let ended = false;
    const endResize = (upEvent: PointerEvent) => {
      if (ended) return; ended = true;
      try {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        try {
          if (splitterEl.hasPointerCapture?.(upEvent.pointerId)) {
            splitterEl.releasePointerCapture(upEvent.pointerId);
          }
        } catch { /* ignore */ }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', endResize);
        window.removeEventListener('pointercancel', endResize);

        removeDragOverlay(overlay);
        restoreIframes();
        removeGlobalCursorStyle(cursorStyle);
        splitterEl.classList.remove('active');

        const dy = upEvent.clientY - startY;
        resizeGroups(wsId, colIdx, groupIdx, dy, containerHeight);
        topCardEl.style.height = '';
        bottomCardEl.style.height = '';

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            endLayoutInteraction('workspace-resizing');
            document.body.style.cursor = '';
          });
        });
      } catch (err) {
        console.error('[useColumnResize] endResize error', err);
        endLayoutInteraction('workspace-resizing');
        document.body.style.cursor = '';
        removeDragOverlay(overlay);
        restoreIframes();
        removeGlobalCursorStyle(cursorStyle);
      }
    };

    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }, [wsId, resizeGroups]);

  return { handleColResizerPointerDown, handleGroupResizerPointerDown };
}
