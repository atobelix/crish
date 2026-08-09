import React, { useEffect, useState } from 'react';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { getCoordinatesFromIndex } from '../core/measure';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface SelectionHighlightProps {
  /**
   * 显式 store 实例（R5 实例工厂）：缺省 = 全局默认单例（向后兼容）。
   * 多实例场景下选区高亮必须绑定与内容同一实例。
   */
  store?: EditorStore;
}

export const SelectionHighlight: React.FC<SelectionHighlightProps> = ({
  store,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）
  const editorStore = store ?? useEditorStore;
  const selectionStart = editorStore(state => state.selectionStart);
  const selectionEnd = editorStore(state => state.selectionEnd);
  
  const [rects, setRects] = useState<Rect[]>([]);

  useEffect(() => {
    if (selectionStart === selectionEnd) {
      setRects([]);
      return;
    }

    const start = Math.min(selectionStart, selectionEnd);
    const end = Math.max(selectionStart, selectionEnd);

    const container = document.querySelector('.engine-container') as HTMLElement;
    if (!container) return;

    const startCoord = getCoordinatesFromIndex(start, container);
    const endCoord = getCoordinatesFromIndex(end, container);
    
    if (!startCoord || !endCoord) {
      setRects([]);
      return;
    }

    const lines = Array.from(container.querySelectorAll('[data-line-start]'));
    const newRects: Rect[] = [];

    for (const line of lines) {
      const lineStart = parseInt(line.getAttribute('data-line-start') || '0', 10);
      const lineLen = parseInt(line.getAttribute('data-line-length') || '0', 10);
      const lineEnd = lineStart + lineLen;

      if (start <= lineEnd && end >= lineStart) {
        // Line intersects with selection
        const lineRect = line.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        let left = lineRect.left;
        let right = lineRect.right;
        
        // If this is the start line, restrict left side
        if (start >= lineStart && start <= lineEnd) {
          left = startCoord.left;
        }
        
        // If this is the end line, restrict right side
        if (end >= lineStart && end <= lineEnd) {
          right = endCoord.left;
        }
        
        // For empty lines selected across
        if (right < left) {
          right = left + 5; // minimum width
        }

        newRects.push({
          top: lineRect.top - containerRect.top + container.scrollTop,
          left: left - containerRect.left + container.scrollLeft,
          width: Math.max(0, right - left),
          height: lineRect.height,
        });
      }
    }
    
    setRects(newRects);
  }, [selectionStart, selectionEnd]);

  if (rects.length === 0) return null;

  return (
    // 选区层是纯装饰性高亮（光标/选区语义由 textarea 承担，R4-H）：
    // aria-hidden 对屏幕阅读器隐藏，避免朗读无意义的矩形几何信息
    <div
      className="selection-layer"
      aria-hidden="true"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 0 }}
    >
      {rects.map((rect, i) => (
        <div
          key={i}
          className="selection-rect"
          style={{
            position: 'absolute',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            backgroundColor: 'var(--blue-selection)',
          }}
        />
      ))}
    </div>
  );
};
