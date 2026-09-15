import React, { useLayoutEffect, useState } from 'react';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { getCoordinatesFromIndex, toContainerCoords } from '../core/measure';
import { useGeometryVersion } from './useGeometryVersion';

interface CursorLayerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  layoutDeps?: string;
  /**
   * 显式 store 实例（R5 实例工厂）：缺省 = 全局默认单例（向后兼容）。
   * 多实例场景（文档工作区）下光标层必须绑定与内容同一实例，否则光标
   * 坐标读的是全局单例的光标位，与实例内容错位。
   */
  store?: EditorStore;
  /** 行级/全局装饰版本：语法展开/折叠/高亮切换时驱动光标重新实测物理贴合 */
  decorationVersion?: number;
}

export const CursorLayer: React.FC<CursorLayerProps> = ({
  containerRef,
  layoutDeps,
  store,
  decorationVersion,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）；zustand 的 useStore 在
  // store 引用变化时自动切换订阅（useSyncExternalStore 重订阅语义）
  const editorStore = store ?? useEditorStore;
  const geometryVersion = useGeometryVersion(containerRef, layoutDeps);
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
  // 与输入宿主共享布局版本：每次布局提交直接实测，不按帧数猜测挂载时机。
  useLayoutEffect(() => {
    const container = containerRef.current;
    const rect = container ? getCoordinatesFromIndex(cursorPos, container) : null;
    setCoords(rect && container ? toContainerCoords(rect, container) : null);
  }, [editorStore, cursorPos, selectionStart, selectionEnd, containerRef, layoutDeps, decorationVersion, geometryVersion]);

  // Do not show the cursor if there is a text selection, or IME composing, or if in cell selection mode (not editing)
  const isCellSelectionMode = Boolean(selectedCell && !selectedCell.isEditing);
  if (!coords || selectionStart !== selectionEnd || isComposing || isCellSelectionMode) {
    return null;
  }

  return (
    <div
      className="cursor-caret custom-cursor-blink"
      style={{
        position: 'absolute',
        transform: `translate3d(${coords.left}px, ${coords.top}px, 0)`,
        height: `${coords.height}px`,
        width: '1px',
        backgroundColor: 'var(--black)',
        zIndex: 'var(--z-cursor)',
        pointerEvents: 'none',
      }}
    />
  );
};
