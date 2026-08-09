import React, { useLayoutEffect, useState, useEffect } from 'react';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { getCoordinatesFromIndex, toContainerCoords } from '../core/measure';

interface CursorLayerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  layoutDeps?: string;
  /**
   * 显式 store 实例（R5 实例工厂）：缺省 = 全局默认单例（向后兼容）。
   * 多实例场景（文档工作区）下光标层必须绑定与内容同一实例，否则光标
   * 坐标读的是全局单例的光标位，与实例内容错位。
   */
  store?: EditorStore;
}

export const CursorLayer: React.FC<CursorLayerProps> = ({
  containerRef,
  layoutDeps,
  store,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）；zustand 的 useStore 在
  // store 引用变化时自动切换订阅（useSyncExternalStore 重订阅语义）
  const editorStore = store ?? useEditorStore;
  const cursorPos = editorStore(state => state.cursorPos);
  const selectionStart = editorStore(state => state.selectionStart);
  const selectionEnd = editorStore(state => state.selectionEnd);
  const isComposing = editorStore(state => state.isComposing);
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
