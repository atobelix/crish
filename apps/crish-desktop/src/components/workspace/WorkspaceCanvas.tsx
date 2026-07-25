import React from 'react';
import { Plus } from 'lucide-react';
import styles from '../Workspace.module.css';
import type { WorkspaceState } from '../store/layoutStore';
import { CardPanel } from '../CardPanel';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { WorkspaceResizer } from './WorkspaceResizer';
import { useWorkspaceResize } from './useWorkspaceResize';
import { useColumnResize } from '../hooks/useColumnResize';

type RenderedGroup = import('../Workspace').RenderedGroup;
type RenderedColumn = import('../Workspace').RenderedColumn;

interface WorkspaceCanvasProps {
  ws: WorkspaceState;
  renderedColumns: RenderedColumn[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  focusThisWorkspace: () => void;
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void;
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void;
  regionLabel: string;
  colCountLabel: string;
  onShowToast: ShowToastFn;
}

function ratioToPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export const WorkspaceCanvas: React.FC<WorkspaceCanvasProps> = React.memo(
  ({ ws, renderedColumns, containerRef, focusThisWorkspace, resizeColumns, resizeGroups, regionLabel, colCountLabel, onShowToast }) => {
    const { handleColResizerPointerDown, handleGroupResizerPointerDown } = useColumnResize(ws.id);
    const { nudgeColumnByKey, nudgeGroupByKey } = useWorkspaceResize(
      ws, containerRef, focusThisWorkspace, resizeColumns, resizeGroups
    );

    return (
      <div
        className={`${styles.canvas} workspace-canvas`}
        role="group"
        aria-label={`${regionLabel}画布，${colCountLabel}`}
      >
        {renderedColumns.map((col, colIdx) => {
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
          const splitterLeftIdx = showColSplitter ? col.origColIdx - 1 : -1;
          const leftRatio =
            splitterLeftIdx >= 0
              ? (ws.columns[splitterLeftIdx]?.widthRatio ?? col.widthRatio)
              : col.widthRatio;
          const rightRatio =
            splitterLeftIdx >= 0
              ? (ws.columns[splitterLeftIdx + 1]?.widthRatio ?? 0)
              : 0;

          return (
            <React.Fragment key={col.id}>
              {showColSplitter && (
                <WorkspaceResizer
                  className={`${styles.colSplitter} col-splitter`}
                  orientation="vertical"
                  ariaLabel={`调整第 ${splitterLeftIdx + 1} 与第 ${splitterLeftIdx + 2} 列宽度`}
                  ariaValueMin={10}
                  ariaValueMax={90}
                  ariaValueNow={ratioToPercent(leftRatio)}
                  ariaValueText={`左列 ${ratioToPercent(leftRatio)}%，右列 ${ratioToPercent(rightRatio)}%`}
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
                      e.preventDefault();
                      focusThisWorkspace();
                      const canvasEl =
                        containerRef.current?.querySelector(
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

              <div
                className={
                  isPlaceholderCol
                    ? `${styles.placeholderCol} workspace-column--placeholder`
                    : `${styles.column} workspace-column`
                }
                role={isPlaceholderCol ? 'status' : 'group'}
                aria-label={
                  isPlaceholderCol
                    ? col.groups[0]?.cards[0]?.title || '释放以创建列'
                    : `第 ${col.origColIdx + 1} 列`
                }
                data-col-idx={col.origColIdx}
                data-placeholder={isPlaceholderCol ? 'true' : undefined}
                style={
                  isPlaceholderCol
                    ? undefined
                    : {
                        width: `${col.widthRatio * 100}%`,
                        flex: '0 0 auto',
                      }
                }
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
                      ? (ws.columns[col.origColIdx]?.groups[topGroupIdx]
                          ?.heightRatio ?? 0.5)
                      : 0.5;
                  const bottomH =
                    topGroupIdx >= 0
                      ? (ws.columns[col.origColIdx]?.groups[
                          topGroupIdx + 1
                        ]?.heightRatio ?? 0.5)
                      : 0.5;

                  return (
                    <React.Fragment key={group.id}>
                      {showGroupSplitter && (
                        <WorkspaceResizer
                          className={`${styles.groupSplitter} group-splitter`}
                          orientation="horizontal"
                          ariaLabel={`调整第 ${col.origColIdx + 1} 列内面板高度`}
                          ariaValueMin={10}
                          ariaValueMax={90}
                          ariaValueNow={ratioToPercent(topH)}
                          ariaValueText={`上 ${ratioToPercent(topH)}%，下 ${ratioToPercent(bottomH)}%`}
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
                              nudgeGroupByKey(
                                col.origColIdx,
                                topGroupIdx,
                                -1,
                              );
                            } else if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              focusThisWorkspace();
                              nudgeGroupByKey(
                                col.origColIdx,
                                topGroupIdx,
                                1,
                              );
                            }
                          }}
                          style={{
                            top: `calc(${topOffsetPercent}% - 3px)`,
                          }}
                        />
                      )}

                      {isPlaceholderGroup ? (
                        <div
                          className={`${styles.placeholderCardGroup} workspace-card placeholder-card-group`}
                          role="status"
                          aria-live="polite"
                          aria-label={group.cards[0]?.title || '释放以拆分'}
                          style={{
                            height: `${group.heightRatio * 100}%`,
                          }}
                        >
                          <Plus
                            size={16}
                            strokeWidth={1.75}
                            aria-hidden
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
    );
  },
);

WorkspaceCanvas.displayName = 'WorkspaceCanvas';
