/**
 * Workspace 纯函数层：列/组渲染派生（拖拽折叠、占位拼接、宽度再分配）+
 * 读屏播报文案 + 序号/百分比格式化。
 * 从 Workspace.tsx 抽出，零副作用，可独立单测。
 */
import type {
  CardGroupState,
  ColumnState,
  DropPreviewState,
  WorkspaceState,
} from '../../store/layoutStore';
import type { DraggedTabState } from '../../store/workspaceActions';

/** 工作区展示序号（去掉 ws- 前缀；非数字则原样） */
export function workspaceOrdinalLabel(wsId: string): string {
  const raw = wsId.replace(/^ws-/, '');
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // 默认 ws-0 → 工作区 1
    return String(n + 1);
  }
  return raw || '1';
}

/** 列宽占比 → 读屏百分比（整数，避免冗长小数） */
export function ratioToPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export type RenderedGroup = CardGroupState & { origGroupIdx: number };
export type RenderedColumn = Omit<ColumnState, 'groups'> & {
  origColIdx: number;
  groups: RenderedGroup[];
};

/** 拖拽中「整组被拖走」判定（组拖 / 单卡组的 tab 拖） */
function isDraggingWholeGroup(
  g: CardGroupState,
  draggedTab: DraggedTabState | null,
): boolean {
  if (!draggedTab) return false;
  return (
    g.id === draggedTab.sourceGroupId &&
    (!draggedTab.isTabDrag || g.cards.length === 1)
  );
}

/**
 * 渲染列派生：拖拽折叠源组/源列、拆分占位列/占位组拼接、宽度再分配。
 * 输入 (ws, draggedTab, dropPreview)，输出渲染用列结构（纯函数）。
 */
export function computeRenderedColumns(
  ws: WorkspaceState | null | undefined,
  draggedTab: DraggedTabState | null,
  dropPreview: DropPreviewState | null,
): RenderedColumn[] {
  if (!ws) return [];
  // 1. 找源列并判断拖拽期间是否会被拖空
  let sourceColIdx = -1;
  let isSourceColEmpty = false;
  if (draggedTab) {
    sourceColIdx = ws.columns.findIndex((col) =>
      col.groups.some((g) => g.id === draggedTab.sourceGroupId),
    );
    if (sourceColIdx >= 0) {
      isSourceColEmpty = ws.columns[sourceColIdx]!.groups.every((g) => {
        return isDraggingWholeGroup(g, draggedTab);
      });
    }
  }

  // 2. 决定是否折叠/隐藏空源列
  let shouldHideSourceCol = false;
  if (draggedTab && isSourceColEmpty && dropPreview) {
    const { colIdx } = dropPreview;
    if (colIdx >= 0 && Math.abs(colIdx - sourceColIdx) > 1) {
      shouldHideSourceCol = true;
    }
  }

  // 3. 全部列映射为 RenderedColumn 结构
  const originalBaseCols: RenderedColumn[] = ws.columns.map((col, cIdx) => {
    const visibleGroups = draggedTab
      ? col.groups.filter((g) => {
          if (!isDraggingWholeGroup(g, draggedTab)) return true;
          let shouldCollapseSourceGroup = false;
          if (dropPreview) {
            const isSplitInThisCol =
              dropPreview.colIdx === cIdx &&
              (dropPreview.direction === 'top' ||
                dropPreview.direction === 'bottom');
            if (dropPreview.colIdx !== cIdx || isSplitInThisCol) {
              shouldCollapseSourceGroup = true;
            }
          }
          return !shouldCollapseSourceGroup;
        })
      : col.groups;
    const numVisible = visibleGroups.length;

    return {
      ...col,
      origColIdx: cIdx,
      groups: col.groups.map((g, gIdx) => {
        const draggingWholeGroup = isDraggingWholeGroup(g, draggedTab);

        let shouldCollapseSourceGroup = false;
        if (draggingWholeGroup) {
          if (dropPreview) {
            const isSplitInThisCol =
              dropPreview.colIdx === cIdx &&
              (dropPreview.direction === 'top' ||
                dropPreview.direction === 'bottom');
            if (dropPreview.colIdx !== cIdx || isSplitInThisCol) {
              shouldCollapseSourceGroup = true;
            }
          }
        }

        let heightRatio = g.heightRatio;
        if (shouldCollapseSourceGroup) {
          heightRatio = 0;
        } else if (draggedTab) {
          // 检查本列是否有拆分落点预览
          const isSplitInThisCol =
            dropPreview &&
            dropPreview.colIdx === cIdx &&
            (dropPreview.direction === 'top' ||
              dropPreview.direction === 'bottom');

          if (
            draggedTab.isTabDrag &&
            !draggingWholeGroup &&
            !isSplitInThisCol
          ) {
            // 保持原 heightRatio 稳定渲染
            heightRatio = g.heightRatio;
          } else if (draggingWholeGroup && !shouldCollapseSourceGroup) {
            // 源组尚未折叠，保持原 heightRatio
            heightRatio = g.heightRatio;
          } else {
            // 其余情况（整组拖出 / 新组拆分进入）等高均分
            heightRatio = numVisible > 0 ? 1 / numVisible : 1.0;
          }
        }

        return {
          ...g,
          origGroupIdx: gIdx,
          heightRatio,
        };
      }),
    };
  });

  let baseCols = originalBaseCols;
  if (shouldHideSourceCol && sourceColIdx >= 0) {
    // 过滤掉空源列
    baseCols = originalBaseCols.filter(
      (col) => col.origColIdx !== sourceColIdx,
    );

    // 剩余列宽度再分配，保证总和为 1.0
    const totalRemainingWidth = baseCols.reduce(
      (sum, col) => sum + col.widthRatio,
      0,
    );
    if (totalRemainingWidth > 0) {
      baseCols.forEach((col) => {
        col.widthRatio = col.widthRatio / totalRemainingWidth;
      });
    }
  }

  // 4. 拖拽预览激活时拼接占位
  if (!draggedTab || !dropPreview || draggedTab.workspaceId !== ws.id) {
    return baseCols;
  }

  const { colIdx, groupIdx, direction } = dropPreview;
  const phKey = `${ws.id}-${colIdx}-${groupIdx}-${direction}`;

  if (direction === 'left' || direction === 'right') {
    const targetBaseColIdx = baseCols.findIndex(
      (c) => c.origColIdx === colIdx,
    );
    if (targetBaseColIdx >= 0) {
      const insertColIdx =
        direction === 'left' ? targetBaseColIdx : targetBaseColIdx + 1;
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
    }
    return baseCols;
  } else if (direction === 'top' || direction === 'bottom') {
    if (draggedTab.isTabDrag) {
      return baseCols;
    }
    const col = baseCols.find((c) => c.origColIdx === colIdx);
    if (col) {
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
        if (isDraggingWholeGroup(g, draggedTab)) {
          g.heightRatio = 0;
        } else {
          g.heightRatio = evenHeight;
        }
      });
      col.groups.splice(insertGroupIdx, 0, placeholderGroup);
    }
    return baseCols;
  }

  return baseCols;
}

/** 拖标签时的读屏播报（与占位中文同步） */
export function resolveDropLiveMessage(
  ws: WorkspaceState | null | undefined,
  draggedTab: DraggedTabState | null,
  dropPreview: DropPreviewState | null,
): string {
  if (!ws || !draggedTab || draggedTab.workspaceId !== ws.id) return '';
  if (!dropPreview) return '正在拖动标签，移到面板边缘可拆分';
  const { direction } = dropPreview;
  if (direction === 'left' || direction === 'right') return '释放以创建列';
  if (direction === 'top') return '释放以置顶拆分';
  if (direction === 'bottom') return '释放以置底拆分';
  if (direction === 'merge') return '释放以合并到此标签组';
  return '拖动标签以调整布局';
}

/** 空工作区判定：无列 / 全空列 / 渲染列为空 */
export function isEmptyWorkspace(
  ws: WorkspaceState,
  renderedColumns: RenderedColumn[],
): boolean {
  return (
    !ws.columns.length ||
    ws.columns.every((c) => !c.groups.length) ||
    renderedColumns.length === 0
  );
}
