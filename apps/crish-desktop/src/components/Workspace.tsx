import React, { useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { CardGroupState, ColumnState } from '../store/layoutStore';
import { AppErrorBoundary } from './AppErrorBoundary';
import { CardPanel } from './CardPanel';
import * as Lucide from 'lucide-react';

import type { ShowToastFn } from '../hooks/useToastQueue';

interface WorkspaceProps {
  wsId: string;
  onShowToast: ShowToastFn;
}

/** 工作区展示序号（去掉 ws- 前缀；非数字则原样） */
function workspaceOrdinalLabel(wsId: string): string {
  const raw = wsId.replace(/^ws-/, '');
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // 默认 ws-0 → 工作区 1
    return String(n + 1);
  }
  return raw || '1';
}

/** 列宽占比 → 读屏百分比（整数，避免冗长小数） */
function ratioToPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

type RenderedGroup = CardGroupState & { origGroupIdx: number };
type RenderedColumn = Omit<ColumnState, 'groups'> & {
  origColIdx: number;
  groups: RenderedGroup[];
};

import { WorkspaceEmptyState } from './workspace/WorkspaceEmptyState';

export const Workspace: React.FC<WorkspaceProps> = React.memo(({ wsId, onShowToast }) => {
  const resizeColumns = useLayoutStore((s) => s.resizeColumns);
  const resizeGroups = useLayoutStore((s) => s.resizeGroups);
  const closeWorkspace = useLayoutStore((s) => s.closeWorkspace);
  const activeWorkspaceIndex = useLayoutStore((s) => s.activeWorkspaceIndex);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const dropPreview = useLayoutStore((s) => s.dropPreview);
  const containerRef = useRef<HTMLDivElement>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);

  const ws = useLayoutStore(
    React.useCallback((s) => s.workspaces.find((w) => w.id === wsId), [wsId])
  );

  const wsIndex = useLayoutStore(
    React.useCallback((s) => s.workspaces.findIndex((w) => w.id === wsId), [wsId])
  );

  const isSplitMode = useLayoutStore(
    (s) => s.workspaces.length > 1
  );

  if (!ws) return null;

  const isActiveWorkspace =
    wsIndex >= 0 ? wsIndex === activeWorkspaceIndex : false;
  const ordinal = workspaceOrdinalLabel(ws.id);
  const regionLabel = isSplitMode
    ? `拆分工作区 ${ordinal}${isActiveWorkspace ? '（当前）' : ''}`
    : '主工作区';

  /** 点击 / 聚焦本区时切到活动工作区（多拆分时 panel focus） */
  const focusThisWorkspace = React.useCallback(() => {
    if (wsIndex < 0) return;
    const cur = useLayoutStore.getState().activeWorkspaceIndex;
    if (cur === wsIndex) return;
    useLayoutStore.setState((state) => {
      state.activeWorkspaceIndex = wsIndex;
    });
  }, [wsIndex]);

  /** 键盘微调列宽：相对画布 2% 步进 */
  const nudgeColumnByKey = React.useCallback(
    (leftColIdx: number, dir: -1 | 1) => {
      const canvasEl = containerRef.current?.querySelector(
        '.workspace-canvas',
      ) as HTMLElement | null;
      if (!canvasEl) return;
      const containerWidth = canvasEl.clientWidth || 1;
      const dx = dir * Math.max(8, Math.round(containerWidth * 0.02));
      resizeColumns(ws.id, leftColIdx, dx, containerWidth);
    },
    [resizeColumns, ws.id],
  );

  /** 键盘微调组高：相对列高 2% 步进 */
  const nudgeGroupByKey = React.useCallback(
    (colIdx: number, topGroupIdx: number, dir: -1 | 1) => {
      const canvasEl = containerRef.current?.querySelector(
        '.workspace-canvas',
      ) as HTMLElement | null;
      if (!canvasEl) return;
      const cols = canvasEl.querySelectorAll('.workspace-column');
      const colEl = cols[colIdx] as HTMLElement | undefined;
      if (!colEl) return;
      const containerHeight = colEl.clientHeight || 1;
      const dy = dir * Math.max(8, Math.round(containerHeight * 0.02));
      resizeGroups(ws.id, colIdx, topGroupIdx, dy, containerHeight);
    },
    [resizeGroups, ws.id],
  );

  // Column Resizer Pointer Events
  const handleColResizerPointerDown = (e: React.PointerEvent, colIdx: number) => {
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
  };

  // Card Group Resizer Pointer Events
  const handleGroupResizerPointerDown = (
    e: React.PointerEvent,
    colIdx: number,
    groupIdx: number
  ) => {
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
  };

  const renderedColumns = React.useMemo(() => {
    const baseCols: RenderedColumn[] = ws.columns.map((col, cIdx) => {
      const visibleGroups = draggedTab
        ? col.groups.filter((g) => {
            const isDraggingWholeGroup =
              g.id === draggedTab.sourceGroupId &&
              (!draggedTab.isTabDrag || g.cards.length === 1);
            return !isDraggingWholeGroup;
          })
        : col.groups;
      const numVisible = visibleGroups.length;

      return {
        ...col,
        origColIdx: cIdx,
        groups: col.groups.map((g, gIdx) => {
          const isDragged = draggedTab && g.id === draggedTab.sourceGroupId;
          const isDraggingWholeGroup =
            isDragged && (!draggedTab.isTabDrag || g.cards.length === 1);
          let heightRatio = g.heightRatio;
          if (isDraggingWholeGroup) {
            heightRatio = 0;
          } else if (draggedTab) {
            heightRatio = numVisible > 0 ? 1 / numVisible : 1.0;
          }

          return {
            ...g,
            origGroupIdx: gIdx,
            heightRatio,
          };
        }),
      };
    });

    if (!draggedTab || !dropPreview || draggedTab.workspaceId !== ws.id) {
      return baseCols;
    }

    const { colIdx, groupIdx, direction } = dropPreview;
    // 稳定占位 id，避免 Date.now() 每帧换 key 导致占位闪烁
    const phKey = `${ws.id}-${colIdx}-${groupIdx}-${direction}`;

    if (direction === 'left' || direction === 'right') {
      const insertColIdx = direction === 'left' ? colIdx : colIdx + 1;
      const placeholderCol: RenderedColumn = {
        id: `col-placeholder-${phKey}`,
        origColIdx: -1,
        widthRatio: 0.25,
        groups: [
          {
            id: `group-placeholder-${phKey}`,
            origGroupIdx: -1,
            activeCardId: 'placeholder',
            cards: [{ id: 'placeholder', title: '释放以创建列' }],
            heightRatio: 1.0,
          },
        ],
      };

      baseCols.forEach((c) => {
        c.widthRatio *= 0.75;
      });
      baseCols.splice(insertColIdx, 0, placeholderCol);
      return baseCols;
    } else if (direction === 'top' || direction === 'bottom') {
      if (colIdx >= 0 && colIdx < baseCols.length) {
        const col = baseCols[colIdx];
        const insertGroupIdx = direction === 'top' ? groupIdx : groupIdx + 1;
        const nonDraggedGroups = col.groups.filter(
          (g) => g.id !== draggedTab.sourceGroupId,
        );
        const numGroups = nonDraggedGroups.length + 1;
        const evenHeight = 1 / numGroups;
        const placeholderGroup: RenderedGroup = {
          id: `group-placeholder-${phKey}`,
          origGroupIdx: -1,
          activeCardId: 'placeholder',
          cards: [
            {
              id: 'placeholder',
              title:
                direction === 'top' ? '释放以置顶拆分' : '释放以置底拆分',
            },
          ],
          heightRatio: evenHeight,
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

  /** 拖标签时的读屏播报（与占位中文同步） */
  const dropLiveMessage = React.useMemo(() => {
    if (!draggedTab || draggedTab.workspaceId !== ws.id) return '';
    if (!dropPreview) return '正在拖动标签，移到面板边缘可拆分';
    const { direction } = dropPreview;
    if (direction === 'left' || direction === 'right') return '释放以创建列';
    if (direction === 'top') return '释放以置顶拆分';
    if (direction === 'bottom') return '释放以置底拆分';
    if (direction === 'merge') return '释放以合并到此标签组';
    return '拖动标签以调整布局';
  }, [draggedTab, dropPreview, ws.id]);

  const isEmptyWorkspace =
    !ws.columns.length ||
    ws.columns.every((c) => !c.groups.length) ||
    (renderedColumns.length === 0);

  const colCountLabel = `${ws.columns.length} 列`;

  return (
    <div
      ref={containerRef}
      className={`workspace-section${isActiveWorkspace ? ' workspace-section--active' : ''}${isSplitMode ? ' workspace-section--split' : ''}${isEmptyWorkspace ? ' workspace-section--empty' : ''}`}
      role="region"
      aria-label={regionLabel}
      aria-current={isSplitMode && isActiveWorkspace ? 'true' : undefined}
      data-ws-id={ws.id}
      data-ws-active={isActiveWorkspace ? 'true' : 'false'}
      data-ws-empty={isEmptyWorkspace ? 'true' : 'false'}
      data-ws-ordinal={ordinal}
      onPointerDownCapture={focusThisWorkspace}
      onFocusCapture={focusThisWorkspace}
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        height: '100%',
        flex: 1,
        minWidth: 0,
        // 非活动拆分：略降对比，焦点工作区更清晰
        opacity: isSplitMode && !isActiveWorkspace ? 0.92 : 1,
        outline:
          isSplitMode && isActiveWorkspace
            ? '1px solid color-mix(in srgb, var(--text-primary, #111) 8%, transparent)'
            : undefined,
        outlineOffset: isSplitMode && isActiveWorkspace ? -1 : undefined,
      }}
    >
      {/* 读屏：标签拖放落点（与 CardPanel tablist 协同） */}
      <div
        ref={liveRegionRef}
        className="workspace-dnd-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {dropLiveMessage}
      </div>

      {/* Workspace top close controls (for split views) */}
      {isSplitMode && (
        <div
          className="workspace-split-chrome"
          role="toolbar"
          aria-label={`拆分工作区 ${ordinal} 工具栏`}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 'var(--space-1, 4px) var(--space-3, 8px)',
            minHeight: 'var(--control-height-sm, 28px)',
            backgroundColor: 'var(--bg-primary)',
            borderBottom:
              'var(--hairline-width, 1px) solid var(--hairline, var(--border-color))',
            fontSize: 'var(--font-size-xs, 11px)',
            lineHeight: 'var(--line-height-tight, 1.25)',
            color: 'var(--text-secondary)',
            borderRadius: 0,
            marginBottom: 0,
            gap: 'var(--space-2, 6px)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1, 4px)',
              minWidth: 0,
            }}
          >
            <Lucide.Columns size={12} strokeWidth={1.75} aria-hidden />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              拆分工作区 {ordinal}
              <span
                style={{
                  marginLeft: 'var(--space-2, 6px)',
                  opacity: 0.75,
                  fontSize: 'var(--font-size-xs, 11px)',
                }}
              >
                · {colCountLabel}
                {isActiveWorkspace ? ' · 当前焦点' : ''}
              </span>
            </span>
          </div>
          <button
            type="button"
            className="workspace-close-btn card-action-btn"
            onClick={() => closeWorkspace(ws.id)}
            aria-label={`关闭拆分工作区 ${ordinal}`}
            title={`关闭拆分工作区 ${ordinal}`}
          >
            <Lucide.X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}

      {/* Main Column Grid — isolated so a panel crash doesn't blank the whole workspace chrome */}
      <AppErrorBoundary compact>
        {isEmptyWorkspace ? (
          <WorkspaceEmptyState wsId={ws.id} onActivate={focusThisWorkspace} />
        ) : (
          <div
            className="workspace-canvas"
            role="group"
            aria-label={`${regionLabel}画布，${colCountLabel}`}
          >
            {renderedColumns.map((col, colIdx) => {
              // Calculate cumulative width ratios to position col-splitter resizer elements
              let leftOffsetPercent = 0;
              for (let i = 0; i < colIdx; i++) {
                leftOffsetPercent += renderedColumns[i].widthRatio * 100;
              }

              const isPlaceholderCol = col.origColIdx === -1;
              const leftRealCol = renderedColumns[colIdx - 1];
              const showColSplitter =
                colIdx > 0 &&
                !isPlaceholderCol &&
                leftRealCol != null &&
                leftRealCol.origColIdx !== -1;
              const splitterLeftIdx = showColSplitter
                ? col.origColIdx - 1
                : -1;
              const leftRatio =
                splitterLeftIdx >= 0
                  ? ws.columns[splitterLeftIdx]?.widthRatio ?? col.widthRatio
                  : col.widthRatio;
              const rightRatio =
                splitterLeftIdx >= 0
                  ? ws.columns[splitterLeftIdx + 1]?.widthRatio ?? 0
                  : 0;

              return (
                <React.Fragment key={col.id}>
                  {/* Column splitter handle */}
                  {showColSplitter && (
                    <div
                      className="col-splitter"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`调整第 ${splitterLeftIdx + 1} 与第 ${splitterLeftIdx + 2} 列宽度`}
                      aria-valuemin={10}
                      aria-valuemax={90}
                      aria-valuenow={ratioToPercent(leftRatio)}
                      aria-valuetext={`左列 ${ratioToPercent(leftRatio)}%，右列 ${ratioToPercent(rightRatio)}%`}
                      tabIndex={0}
                      onPointerDown={(e) =>
                        handleColResizerPointerDown(e, splitterLeftIdx)
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft') {
                          e.preventDefault();
                          focusThisWorkspace();
                          nudgeColumnByKey(splitterLeftIdx, -1);
                        } else if (e.key === 'ArrowRight') {
                          e.preventDefault();
                          focusThisWorkspace();
                          nudgeColumnByKey(splitterLeftIdx, 1);
                        } else if (e.key === 'Home' || e.key === 'End') {
                          // 落到 store 最小宽约 12% 内侧，避免整幅 dx 被 clamp 直接 no-op
                          e.preventDefault();
                          focusThisWorkspace();
                          const canvasEl = containerRef.current?.querySelector(
                            '.workspace-canvas',
                          ) as HTMLElement | null;
                          const w = canvasEl?.clientWidth || 1;
                          const left = ws.columns[splitterLeftIdx];
                          const right = ws.columns[splitterLeftIdx + 1];
                          if (!left || !right) return;
                          const pair = left.widthRatio + right.widthRatio;
                          const minR = 0.13;
                          const targetLeft =
                            e.key === 'Home'
                              ? minR
                              : Math.max(minR, pair - minR);
                          const dx = (targetLeft - left.widthRatio) * w;
                          if (Math.abs(dx) > 0.5) {
                            resizeColumns(ws.id, splitterLeftIdx, dx, w);
                          }
                        }
                      }}
                      style={{
                        left: `calc(${leftOffsetPercent}% - 3px)`,
                      }}
                    />
                  )}

                  {/* Column Element */}
                  <div
                    className={`workspace-column${isPlaceholderCol ? ' workspace-column--placeholder' : ''}`}
                    role={isPlaceholderCol ? 'status' : 'group'}
                    aria-label={
                      isPlaceholderCol
                        ? col.groups[0]?.cards[0]?.title || '释放以创建列'
                        : `第 ${col.origColIdx + 1} 列`
                    }
                    data-col-idx={col.origColIdx}
                    data-placeholder={isPlaceholderCol ? 'true' : undefined}
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

                      const isPlaceholderGroup = group.origGroupIdx === -1;
                      const prevGroup = col.groups[groupIdx - 1];
                      const showGroupSplitter =
                        groupIdx > 0 &&
                        !isPlaceholderGroup &&
                        prevGroup != null &&
                        prevGroup.origGroupIdx !== -1 &&
                        col.origColIdx !== -1;
                      const topGroupIdx = showGroupSplitter
                        ? group.origGroupIdx - 1
                        : -1;
                      const topH =
                        topGroupIdx >= 0
                          ? ws.columns[col.origColIdx]?.groups[topGroupIdx]
                              ?.heightRatio ?? 0.5
                          : 0.5;
                      const bottomH =
                        topGroupIdx >= 0
                          ? ws.columns[col.origColIdx]?.groups[topGroupIdx + 1]
                              ?.heightRatio ?? 0.5
                          : 0.5;

                      return (
                        <React.Fragment key={group.id}>
                          {/* Card Group splitter handle */}
                          {showGroupSplitter && (
                            <div
                              className="group-splitter"
                              role="separator"
                              aria-orientation="horizontal"
                              aria-label={`调整第 ${col.origColIdx + 1} 列内面板高度`}
                              aria-valuemin={10}
                              aria-valuemax={90}
                              aria-valuenow={ratioToPercent(topH)}
                              aria-valuetext={`上 ${ratioToPercent(topH)}%，下 ${ratioToPercent(bottomH)}%`}
                              tabIndex={0}
                              onPointerDown={(e) =>
                                handleGroupResizerPointerDown(
                                  e,
                                  col.origColIdx,
                                  topGroupIdx,
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'ArrowUp') {
                                  e.preventDefault();
                                  focusThisWorkspace();
                                  nudgeGroupByKey(col.origColIdx, topGroupIdx, -1);
                                } else if (e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  focusThisWorkspace();
                                  nudgeGroupByKey(col.origColIdx, topGroupIdx, 1);
                                }
                              }}
                              style={{
                                top: `calc(${topOffsetPercent}% - 3px)`,
                              }}
                            />
                          )}

                          {/* Card Group */}
                          {isPlaceholderGroup ? (
                            <div
                              className="workspace-card placeholder-card-group"
                              role="status"
                              aria-live="polite"
                              aria-label={group.cards[0]?.title || '释放以拆分'}
                              style={{
                                height: `${group.heightRatio * 100}%`,
                                flex: '0 0 auto',
                                display: 'flex',
                                flexDirection: 'column',
                                minHeight: 0,
                                border:
                                  '1.5px dashed var(--accent-color, #333333)',
                                background: 'rgba(55, 65, 81, 0.03)',
                                justifyContent: 'center',
                                alignItems: 'center',
                                fontSize: 'var(--font-size-xs, 11px)',
                                lineHeight: 'var(--line-height-tight, 1.25)',
                                color: 'var(--text-secondary)',
                                margin: 'var(--space-1, 4px)',
                                borderRadius: 'var(--radius-sm, 6px)',
                                boxSizing: 'border-box',
                                gap: 'var(--space-1, 4px)',
                                padding: 'var(--space-2, 6px)',
                              }}
                            >
                              <Lucide.Plus
                                size={16}
                                strokeWidth={1.75}
                                aria-hidden
                                style={{ opacity: 0.6 }}
                              />
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
        )}

        {/* Drag Indicator drop overlay layer */}
        <div
          id={`drop-indicator-${ws.id}`}
          className="drop-indicator"
          aria-hidden="true"
          style={{ display: 'none' }}
        />
      </AppErrorBoundary>
    </div>
  );
});
