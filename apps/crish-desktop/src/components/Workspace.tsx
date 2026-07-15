import React, { useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { WorkspaceState, CardGroupState, ColumnState } from '../store/layoutStore';
import { AppErrorBoundary } from './AppErrorBoundary';
import { CardPanel } from './CardPanel';
import * as Lucide from 'lucide-react';

interface WorkspaceProps {
  ws: WorkspaceState;
  onShowToast: (message: string) => void;
}

export const Workspace: React.FC<WorkspaceProps> = React.memo(({ ws, onShowToast }) => {
  const resizeColumns = useLayoutStore((s) => s.resizeColumns);
  const resizeGroups = useLayoutStore((s) => s.resizeGroups);
  const closeWorkspace = useLayoutStore((s) => s.closeWorkspace);
  const workspaces = useLayoutStore((s) => s.workspaces);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const dropPreview = useLayoutStore((s) => s.dropPreview);
  const containerRef = useRef<HTMLDivElement>(null);

  // Column Resizer Pointer Events
  const handleColResizerPointerDown = (e: React.PointerEvent, colIdx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
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

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      splitterEl.classList.remove('active');
      document.body.classList.remove('resizing-active');
      document.body.style.cursor = '';

      const dx = upEvent.clientX - startX;
      resizeColumns(ws.id, colIdx, dx, containerWidth);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  // Card Group Resizer Pointer Events
  const handleGroupResizerPointerDown = (
    e: React.PointerEvent,
    colIdx: number,
    groupIdx: number
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

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      splitterEl.classList.remove('active');
      document.body.classList.remove('resizing-active');
      document.body.style.cursor = '';

      const dy = upEvent.clientY - startY;
      resizeGroups(ws.id, colIdx, groupIdx, dy, containerHeight);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const renderedColumns = React.useMemo(() => {
    const baseCols = ws.columns.map((col, cIdx) => {
      const visibleGroups = draggedTab 
        ? col.groups.filter(g => {
            const isDraggingWholeGroup = g.id === draggedTab.sourceGroupId && (!draggedTab.isTabDrag || g.cards.length === 1);
            return !isDraggingWholeGroup;
          })
        : col.groups;
      const numVisible = visibleGroups.length;

      return {
        ...col,
        origColIdx: cIdx,
        groups: col.groups.map((g, gIdx) => {
          const isDragged = draggedTab && g.id === draggedTab.sourceGroupId;
          const isDraggingWholeGroup = isDragged && (!draggedTab.isTabDrag || g.cards.length === 1);
          let heightRatio = g.heightRatio;
          if (isDraggingWholeGroup) {
            heightRatio = 0;
          } else if (draggedTab) {
            heightRatio = numVisible > 0 ? (1 / numVisible) : 1.0;
          }

          return {
            ...g,
            origGroupIdx: gIdx,
            heightRatio,
          };
        })
      };
    });

    if (!draggedTab || !dropPreview || draggedTab.workspaceId !== ws.id) {
      return baseCols;
    }

    const { colIdx, groupIdx, direction } = dropPreview;

    if (direction === 'left' || direction === 'right') {
      const insertColIdx = direction === 'left' ? colIdx : colIdx + 1;
      const placeholderCol = {
        id: `col-placeholder-${Date.now()}`,
        origColIdx: -1,
        widthRatio: 0.25,
        groups: [
          {
            id: `group-placeholder-${Date.now()}`,
            origGroupIdx: -1,
            activeCardId: 'placeholder',
            cards: [{ id: 'placeholder', title: '释放以创建列' }],
            heightRatio: 1.0,
          }
        ]
      };

      baseCols.forEach((c) => {
        c.widthRatio *= 0.75;
      });
      baseCols.splice(insertColIdx, 0, placeholderCol);
      return baseCols as (ColumnState & { origColIdx: number; groups: (CardGroupState & { origGroupIdx: number })[] })[];
    } else if (direction === 'top' || direction === 'bottom') {
      if (colIdx >= 0 && colIdx < baseCols.length) {
        const col = baseCols[colIdx];
        const insertGroupIdx = direction === 'top' ? groupIdx : groupIdx + 1;
        const nonDraggedGroups = col.groups.filter(g => g.id !== draggedTab.sourceGroupId);
        const numGroups = nonDraggedGroups.length + 1;
        const evenHeight = 1 / numGroups;
        const placeholderGroup = {
          id: `group-placeholder-${Date.now()}`,
          origGroupIdx: -1,
          activeCardId: 'placeholder',
          cards: [{ id: 'placeholder', title: direction === 'top' ? '释放以置顶拆分' : '释放以置底拆分' }],
          heightRatio: evenHeight
        };

        col.groups.forEach((g) => {
          if (g.id === draggedTab.sourceGroupId) {
            g.heightRatio = 0;
          } else {
            g.heightRatio = evenHeight;
          }
        });
        col.groups.splice(insertGroupIdx, 0, placeholderGroup);
        return baseCols;
      }
    }

    return baseCols;
  }, [ws.columns, draggedTab, dropPreview, ws.id]);

  return (
    <div
      ref={containerRef}
      className="workspace-section"
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        height: '100%',
        flex: 1,
      }}
    >
      {/* Workspace top close controls (for split views) */}
      {workspaces.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '6px 10px',
            backgroundColor: 'var(--bg-primary)',
            borderBottom: '1px solid var(--border-color)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            borderRadius: '0',
            marginBottom: '0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Lucide.Columns size={12} />
            <span>拆分工作区: {ws.id.replace('ws-', '')}</span>
          </div>
          <button className="workspace-close-btn" onClick={() => closeWorkspace(ws.id)}>
            <Lucide.X size={14} />
          </button>
        </div>
      )}

      {/* Main Column Grid — isolated so a panel crash doesn't blank the whole workspace chrome */}
      <AppErrorBoundary compact>
        <div className="workspace-canvas">
          {renderedColumns.map((col, colIdx) => {
            // Calculate cumulative width ratios to position col-splitter resizer elements
            let leftOffsetPercent = 0;
            for (let i = 0; i < colIdx; i++) {
              leftOffsetPercent += renderedColumns[i].widthRatio * 100;
            }

            return (
              <React.Fragment key={col.id}>
                {/* Column splitter handle (rendered before all columns except column 0, and not for placeholder columns) */}
                {colIdx > 0 && col.origColIdx !== -1 && renderedColumns[colIdx - 1].origColIdx !== -1 && (
                  <div
                    className="col-splitter"
                    onPointerDown={(e) => handleColResizerPointerDown(e, col.origColIdx - 1)}
                    style={{
                      left: `calc(${leftOffsetPercent}% - 3px)`,
                    }}
                  />
                )}

                {/* Column Element */}
                <div
                  className="workspace-column"
                  style={{
                    width: `${col.widthRatio * 100}%`,
                    flex: '0 0 auto',
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    position: 'relative',
                    minWidth: 0,
                  }}
                >
                  {col.groups.map((group, groupIdx) => {
                    let topOffsetPercent = 0;
                    for (let i = 0; i < groupIdx; i++) {
                      topOffsetPercent += col.groups[i].heightRatio * 100;
                    }

                    return (
                      <React.Fragment key={group.id}>
                        {/* Card Group splitter handle (rendered before all groups except group 0, and not for placeholder groups) */}
                        {groupIdx > 0 && group.origGroupIdx !== -1 && col.groups[groupIdx - 1].origGroupIdx !== -1 && (
                          <div
                            className="group-splitter"
                            onPointerDown={(e) =>
                              handleGroupResizerPointerDown(e, col.origColIdx, group.origGroupIdx - 1)
                            }
                            style={{
                              top: `calc(${topOffsetPercent}% - 3px)`,
                            }}
                          />
                        )}

                        {/* Card Group */}
                        {group.origGroupIdx === -1 ? (
                          <div
                            className="workspace-card placeholder-card-group"
                            style={{
                              height: `${group.heightRatio * 100}%`,
                              flex: '0 0 auto',
                              display: 'flex',
                              flexDirection: 'column',
                              minHeight: 0,
                              border: '1.5px dashed var(--accent-color, #333333)',
                              background: 'rgba(55, 65, 81, 0.03)',
                              justifyContent: 'center',
                              alignItems: 'center',
                              fontSize: '11px',
                              color: 'var(--text-secondary)',
                              margin: '4px',
                              borderRadius: '6px',
                              boxSizing: 'border-box',
                            }}
                          >
                            <Lucide.Plus size={16} style={{ marginBottom: '4px', opacity: 0.6 }} />
                            <span>{group.cards[0].title}</span>
                          </div>
                        ) : (
                          <CardPanel
                            wsId={ws.id}
                            colIdx={col.origColIdx}
                            groupIdx={group.origGroupIdx}
                            onShowToast={onShowToast}
                            heightRatio={group.heightRatio}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Drag Indicator drop overlay layer */}
        <div
          id={`drop-indicator-${ws.id}`}
          className="drop-indicator"
          style={{ display: 'none' }}
        />
      </AppErrorBoundary>
    </div>
  );
});
