import React, { useLayoutEffect, useState, useEffect } from 'react';
import { useEditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { getCoordinatesFromIndex, toContainerCoords } from '../core/measure';

interface CursorLayerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  layoutDeps?: string;
}

export const CursorLayer: React.FC<CursorLayerProps> = ({
  containerRef,
  layoutDeps,
}) => {
  const cursorPos = useEditorStore(state => state.cursorPos);
  const selectionStart = useEditorStore(state => state.selectionStart);
  const selectionEnd = useEditorStore(state => state.selectionEnd);
  const isComposing = useEditorStore(state => state.isComposing);
  const selectedCell = useTableStore(state => state.selectedCell);

  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    height: number;
    bottom: number;
  } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      setHasSelection(selection ? selection.toString().length > 0 : false);
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // Sync physical coordinates synchronously BEFORE browser paint to eliminate 1-frame lag
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    let rAF: number;
    let retries = 0;
    const updateCoords = () => {
      const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
      if (rect && containerRef.current) {
        // 视口坐标 → 容器内容坐标（与 HiddenInput 共用同一换算，测量结果
        // 由 measure 模块的同帧缓存共享：本组件与 HiddenInput 同帧仅一次全量测量）
        setCoords(toContainerCoords(rect, containerRef.current));
      } else if (retries < 10) {
        retries++;
        rAF = requestAnimationFrame(updateCoords);
      } else {
        // If we still can't find it after 10 frames, just clear the cursor
        // It might be outside the virtualized viewport.
        setCoords(null);
      }
    };
    updateCoords();

    return () => {
      if (rAF) cancelAnimationFrame(rAF);
    };
  }, [cursorPos, selectionStart, selectionEnd, containerRef, layoutDeps]);

  // Do not show the cursor if there is a text selection, or IME composing, or if in cell selection mode (not editing)
  const isCellSelectionMode = Boolean(selectedCell && !selectedCell.isEditing);
  if (!coords || hasSelection || isComposing || isCellSelectionMode) {
    return null;
  }

  return (
    <div
      key={cursorPos}
      className="cursor-caret custom-cursor-blink"
      style={{
        position: 'absolute',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        height: `${coords.height}px`,
        width: '1px',
        backgroundColor: 'var(--black)',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    />
  );
};
