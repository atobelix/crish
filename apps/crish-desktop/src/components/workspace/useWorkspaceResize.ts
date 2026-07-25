/**
 * @deprecated Resize pointer handlers (handleColResizerPointerDown / handleGroupResizerPointerDown)
 * 已被 src/hooks/useColumnResize.ts 替代，具备 rAF 节流、PointerCapture、iframe 屏蔽等更完善的实现。
 * WorkspaceCanvas.tsx 中仅保留 nudgeColumnByKey / nudgeGroupByKey（键盘微调）仍从此 hook 获取。
 * 后续应将键盘微调迁移至 useColumnResize 后移除此文件。
 */
import React from 'react';
import type { WorkspaceState } from '../store/layoutStore';

export function useWorkspaceResize(
  ws: WorkspaceState,
  containerRef: React.RefObject<HTMLDivElement | null>,
  focusThisWorkspace: () => void,
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void,
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void,
) {
  const handleColResizerPointerDown = React.useCallback(
    (e: React.PointerEvent, colIdx: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      focusThisWorkspace();
      const splitterEl = e.currentTarget as HTMLElement;
      const canvasEl = containerRef.current?.querySelector('.workspace-canvas') as HTMLElement;
      if (!canvasEl) return;

      const cols = canvasEl.querySelectorAll('.workspace-column');
      const colLeftEl = cols[colIdx] as HTMLElement;
      const colRightEl = cols[colIdx + 1] as HTMLElement;
      if (!colLeftEl || !colRightEl) return;

      const startX = e.clientX;
      const containerWidth = canvasEl.clientWidth || 1;
      const startLeft = splitterEl.getBoundingClientRect().left - canvasEl.getBoundingClientRect().left;
      const colLeftRatio = ws.columns[colIdx].widthRatio;
      const colRightRatio = ws.columns[colIdx + 1].widthRatio;

      splitterEl.classList.add('active');
      document.body.classList.add('resizing-active');
      document.body.style.cursor = 'col-resize';

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const ratioDelta = dx / containerWidth;
        const ratioLeft = colLeftRatio + ratioDelta;
        const ratioRight = colRightRatio - ratioDelta;
        if (ratioLeft > 0.1 && ratioRight > 0.1) {
          colLeftEl.style.width = `${ratioLeft * 100}%`;
          colRightEl.style.width = `${ratioRight * 100}%`;
          splitterEl.style.left = `${startLeft + dx}px`;
        }
      };

      const endResize = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', endResize);
        window.removeEventListener('pointercancel', endResize);
        splitterEl.classList.remove('active');
        document.body.classList.remove('resizing-active');
        document.body.style.cursor = '';
        const dx = upEvent.clientX - startX;
        resizeColumns(ws.id, colIdx, dx, containerWidth);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endResize);
      window.addEventListener('pointercancel', endResize);
    },
    [containerRef, focusThisWorkspace, resizeColumns, ws.columns, ws.id],
  );

  const handleGroupResizerPointerDown = React.useCallback(
    (e: React.PointerEvent, colIdx: number, groupIdx: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      focusThisWorkspace();
      const splitterEl = e.currentTarget as HTMLElement;
      const colEl = splitterEl.parentElement as HTMLElement;
      if (!colEl) return;

      const cards = colEl.querySelectorAll('.workspace-card');
      const topCardEl = cards[groupIdx] as HTMLElement;
      const bottomCardEl = cards[groupIdx + 1] as HTMLElement;
      if (!topCardEl || !bottomCardEl) return;

      const startY = e.clientY;
      const containerHeight = colEl.clientHeight || 1;
      const startTop = splitterEl.getBoundingClientRect().top - colEl.getBoundingClientRect().top;
      const groupTopRatio = ws.columns[colIdx].groups[groupIdx].heightRatio;
      const groupBottomRatio = ws.columns[colIdx].groups[groupIdx + 1].heightRatio;

      splitterEl.classList.add('active');
      document.body.classList.add('resizing-active');
      document.body.style.cursor = 'row-resize';

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const dy = moveEvent.clientY - startY;
        const ratioDelta = dy / containerHeight;
        const ratioTop = groupTopRatio + ratioDelta;
        const ratioBottom = groupBottomRatio - ratioDelta;
        if (ratioTop > 0.1 && ratioBottom > 0.1) {
          topCardEl.style.height = `${ratioTop * 100}%`;
          bottomCardEl.style.height = `${ratioBottom * 100}%`;
          splitterEl.style.top = `${startTop + dy}px`;
        }
      };

      const endResize = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', endResize);
        window.removeEventListener('pointercancel', endResize);
        splitterEl.classList.remove('active');
        document.body.classList.remove('resizing-active');
        document.body.style.cursor = '';
        const dy = upEvent.clientY - startY;
        resizeGroups(ws.id, colIdx, groupIdx, dy, containerHeight);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endResize);
      window.addEventListener('pointercancel', endResize);
    },
    [focusThisWorkspace, resizeGroups, ws.columns, ws.id],
  );

  const nudgeColumnByKey = React.useCallback(
    (leftColIdx: number, dir: -1 | 1) => {
      const id = ws?.id;
      if (!id) return;
      const canvasEl = containerRef.current?.querySelector('.workspace-canvas') as HTMLElement | null;
      if (!canvasEl) return;
      const containerWidth = canvasEl.clientWidth || 1;
      const dx = dir * Math.max(8, Math.round(containerWidth * 0.02));
      resizeColumns(id, leftColIdx, dx, containerWidth);
    },
    [containerRef, resizeColumns, ws?.id],
  );

  const nudgeGroupByKey = React.useCallback(
    (colIdx: number, topGroupIdx: number, dir: -1 | 1) => {
      const id = ws?.id;
      if (!id) return;
      const canvasEl = containerRef.current?.querySelector('.workspace-canvas') as HTMLElement | null;
      if (!canvasEl) return;
      const cols = canvasEl.querySelectorAll('.workspace-column');
      const colEl = cols[colIdx] as HTMLElement | undefined;
      if (!colEl) return;
      const containerHeight = colEl.clientHeight || 1;
      const dy = dir * Math.max(8, Math.round(containerHeight * 0.02));
      resizeGroups(id, colIdx, topGroupIdx, dy, containerHeight);
    },
    [containerRef, resizeGroups, ws?.id],
  );

  return {
    handleColResizerPointerDown,
    handleGroupResizerPointerDown,
    nudgeColumnByKey,
    nudgeGroupByKey,
  };
}
