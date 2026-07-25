import React, { useCallback } from 'react';
import { Plus } from 'lucide-react';
import styles from '../Workspace.module.css';
import type { WorkspaceState } from '../../store/layoutStore';
import { CardPanel } from '../CardPanel';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { WorkspaceResizer } from './WorkspaceResizer';
import { useWorkspaceResize } from './useWorkspaceResize';
import { useColumnResize } from '../../hooks/useColumnResize';
import type { RenderedColumn } from '../Workspace';

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

/**
 * 累加前 untilIdx 项的 widthRatio（百分比）。下标越界跳过。
 * 抽到模块级纯函数：
 * - 消除 `renderedColumns[i]!.widthRatio` 非空断言
 * - 治理防线 #3（noUncheckedIndexedAccess）：下标访问返回 T | undefined 显式守卫
 */
function sumWidthRatios(
  ratios: ReadonlyArray<{ widthRatio: number }>,
  untilIdx: number,
): number {
  if (untilIdx <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < untilIdx; i++) {
    const item = ratios[i];
    if (!item) continue;
    acc += item.widthRatio * 100;
  }
  return acc;
}

/** 同上，针对组高度比 */
function sumHeightRatios(
  groups: ReadonlyArray<{ heightRatio: number }>,
  untilIdx: number,
): number {
  if (untilIdx <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < untilIdx; i++) {
    const g = groups[i];
    if (!g) continue;
    acc += g.heightRatio * 100;
  }
  return acc;
}

export const WorkspaceCanvas: React.FC<WorkspaceCanvasProps> = React.memo(
  ({
    ws,
    renderedColumns,
    containerRef,
    focusThisWorkspace,
    resizeColumns,
    resizeGroups,
    regionLabel,
    colCountLabel,
    onShowToast,
  }) => {
    const { handleColResizerPointerDown, handleGroupResizerPointerDown } =
      useColumnResize(ws.id);
    const { nudgeColumnByKey, nudgeGroupByKey } = useWorkspaceResize(
      ws,
      containerRef,
      focusThisWorkspace,
      resizeColumns,
      resizeGroups,
    );

    /**
     * 列分割器键盘交互：ArrowLeft/Right 微调；Home/End 极化到 13%/87%。
     * 提取到 useCallback 以稳定 identity，避免每次渲染创建新函数导致
     * React.memo(WorkspaceResizer) 失效（onKeyDown 引用变化触发不必要重渲染）。
     *
     * 直接使用 containerRef.current 作为画布元素，不再 `querySelector('.workspace-canvas')`：
     * - 父级传入的 containerRef 即画布外层容器，clientWidth 即所需
     * - querySelector 返回 Element | null，强转 HTMLElement 是类型逃逸
     */
    const handleColSplitterKeyDown = useCallback(
      (splitterLeftIdx: number) => (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          focusThisWorkspace();
          nudgeColumnByKey(splitterLeftIdx, -1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          focusThisWorkspace();
          nudgeColumnByKey(splitterLeftIdx, 1);
          return;
        }
        if (e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        focusThisWorkspace();
        const canvasEl = containerRef.current;
        if (!(canvasEl instanceof HTMLElement)) return;
        const w = canvasEl.clientWidth || 1;
        const left = ws.columns[splitterLeftIdx];
        const right = ws.columns[splitterLeftIdx + 1];
        if (!left || !right) return;
        const pair = left.widthRatio + right.widthRatio;
        const minR = 0.13;
        const targetLeft =
          e.key === 'Home' ? minR : Math.max(minR, pair - minR);
        const dx = (targetLeft - left.widthRatio) * w;
        if (Math.abs(dx) > 0.5) {
          resizeColumns(ws.id, splitterLeftIdx, dx, w);
        }
      },
      [
        containerRef,
        focusThisWorkspace,
        nudgeColumnByKey,
        resizeColumns,
        ws.columns,
        ws.id,
      ],
    );

    /** 组分割器键盘交互：ArrowUp/Down 微调。同样提取到 useCallback 稳定 identity。 */
    const handleGroupSplitterKeyDown = useCallback(
      (colIdx: number, topGroupIdx: number) => (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusThisWorkspace();
          nudgeGroupByKey(colIdx, topGroupIdx, -1);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusThisWorkspace();
          nudgeGroupByKey(colIdx, topGroupIdx, 1);
        }
      },
      [focusThisWorkspace, nudgeGroupByKey],
    );

    return (
      <div
        className={`${styles.canvas} workspace-canvas`}
        role="group"
        aria-label={`${regionLabel}画布，${colCountLabel}`}
      >
        {renderedColumns.map((col, colIdx) => {
          const leftOffsetPercent = sumWidthRatios(renderedColumns, colIdx);

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
                  onKeyDown={handleColSplitterKeyDown(splitterLeftIdx)}
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
                  const topOffsetPercent = sumHeightRatios(
                    col.groups,
                    groupIdx,
                  );

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

                  // 治理防线 #3（noUncheckedIndexedAccess）：cards[0] 可能 undefined
                  const placeholderCard = group.cards[0];
                  const placeholderTitle = placeholderCard?.title ?? '释放以拆分';

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
                          onKeyDown={handleGroupSplitterKeyDown(
                            col.origColIdx,
                            topGroupIdx,
                          )}
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
                          aria-label={placeholderTitle}
                          style={{
                            height: `${group.heightRatio * 100}%`,
                          }}
                        >
                          <Plus size={16} strokeWidth={1.75} aria-hidden />
                          <span>{placeholderTitle}</span>
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
