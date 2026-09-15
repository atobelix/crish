import React, { useLayoutEffect, useState } from 'react';
import type { EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { syncDOMSelection, toContainerCoords } from '../core/measure';
import { getMeasurementContext } from '../core/sourceProjectionCache';
import { unionSelectionRects, type SelectionRect } from '../core/selectionGeometry';
import { useGeometryVersion } from './useGeometryVersion';

interface SelectionHighlightProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  store: EditorStore;
  layoutDeps?: string;
  decorationVersion?: number;
}

/** 选区端点由文档模型持有；高亮仅投影当前挂载的真实编辑面。 */
export const SelectionHighlight: React.FC<SelectionHighlightProps> = ({
  containerRef, store, layoutDeps, decorationVersion,
}) => {
  const anchor = store(state => state.anchorPos);
  const head = store(state => state.headPos);
  const isComposing = store(state => state.isComposing);
  const selectedCell = useTableStore(state => state.selectedCell);
  const geometryVersion = useGeometryVersion(containerRef, layoutDeps);
  const [rects, setRects] = useState<SelectionRect[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || anchor === head || isComposing) {
      setRects([]);
      return;
    }
    const next: SelectionRect[] = [];
    const { projection } = getMeasurementContext(container);
    for (const { range, owner, empty } of projection.selectionRanges(anchor, head)) {
      const table = owner.closest('[data-table-id]');
      if (selectedCell && !selectedCell.isEditing && table?.getAttribute('data-table-id') === selectedCell.tableId) continue;
      if (typeof range.getClientRects !== 'function') continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.height <= 0 || (!empty && rect.width <= 0)) continue;
        const point = toContainerCoords(rect, container);
        next.push({ top: point.top, left: point.left, width: empty ? 0 : rect.width, height: point.height, empty });
      }
    }
    setRects(unionSelectionRects(next));
    syncDOMSelection(container, anchor, head);
  }, [anchor, head, isComposing, selectedCell, containerRef, geometryVersion, layoutDeps, decorationVersion]);

  if (rects.length === 0) return null;
  return (
    <div className="selection-layer" aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 'var(--z-selection)' }}>
      {rects.map((rect, index) => (
        <div key={index} className="selection-rect"
          style={{
            position: 'absolute', top: rect.top, left: rect.left,
            width: rect.width, height: rect.height,
            minWidth: rect.empty ? '1ch' : undefined,
            backgroundColor: 'var(--blue-selection)',
          }} />
      ))}
    </div>
  );
};
