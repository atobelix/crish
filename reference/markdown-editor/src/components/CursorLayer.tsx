import React, { useLayoutEffect, useState, useEffect } from 'react';
import { useEditorStore } from '../core/EditorStore';
import { getCoordinatesFromIndex, updateActiveElements } from '../core/measure';

interface CursorLayerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  layoutDeps?: string;
}

export const CursorLayer: React.FC<CursorLayerProps> = ({
  containerRef,
  layoutDeps,
}) => {
  const { cursorPos, selectionStart, selectionEnd } = useEditorStore();
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

    // Force synchronous DOM update before we measure!
    updateActiveElements(
      containerRef.current,
      cursorPos,
      selectionStart,
      selectionEnd
    );

    const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
    if (rect && containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      setCoords({
        top: rect.top - containerRect.top + containerRef.current.scrollTop,
        left: rect.left - containerRect.left + containerRef.current.scrollLeft,
        height: rect.height,
        bottom:
          rect.bottom - containerRect.top + containerRef.current.scrollTop,
      });
    }
  }, [cursorPos, selectionStart, selectionEnd, containerRef, layoutDeps]);

  if (!coords || hasSelection) return null;

  return (
    <div
      key={cursorPos}
      className="cursor-caret"
      style={{
        position: 'absolute',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        height: `${coords.height}px`,
        width: '1px',
        backgroundColor: 'var(--black)',
        animation: 'blink 1s step-end infinite',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    />
  );
};
