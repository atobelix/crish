/**
 * 工作区面板开关 / 列宽组高 resize 域 actions（T4-7 拆分）。
 * 包含：setDropPreview / togglePanel / resizeColumns / resizeGroups。
 */
import type { DropPreviewState } from './types';
import {
  collapseToolColumnToTabs,
  ensureChatColumn,
  placePanelCard,
  removePanelCard,
  splitToolColumnToStackedGroups,
} from './layoutHelpers';
import type {
  WorkspaceImmerSet,
  WorkspaceStoreGet,
  WorkspaceStoreSlice,
} from './workspaceActionsCore';
import { findWorkspace } from './workspaceActionsCore';

/** 面板开合 / resize 域 actions 签名 */
export interface WorkspaceCleanupActionsSlice {
  setDropPreview: (preview: DropPreviewState | null) => void;
  togglePanel: (wsId: string, key: string, isVisible: boolean) => void;
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void;
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void;
  /** layoutStore 写端投影：同步字段并合并/拆开工具列。勿当第二写端。 */
  applyTabModeEnabled: (enabled: boolean) => void;
}

/**
 * 创建面板开合 / resize 域 actions。
 * 供 createWorkspaceActions 展开（T4-7 拆分）。
 */
export function createWorkspaceCleanupActions<T extends WorkspaceStoreSlice>(
  set: WorkspaceImmerSet<T>,
  _get: WorkspaceStoreGet<T>,
): WorkspaceCleanupActionsSlice {
  return {
    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),

    togglePanel: (wsId, key, isVisible) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws) return;

      // 浮层 / 空 key / chat 关：不进列；仅 ensure chat 锁列（无 ghost）
      if (isVisible) {
        placePanelCard(ws, key, { tabMode: state.tabModeEnabled });
        ensureChatColumn(ws);
        return;
      }

      // chat 不可关；settings/runtime 等浮层 remove 也会 skipped
      removePanelCard(ws, key);
      ensureChatColumn(ws);
    }),

    resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws || ws.columns.length < 2) return;
      if (!Number.isFinite(containerWidth) || containerWidth <= 0) return;
      if (colIdx < 0 || colIdx >= ws.columns.length - 1) return;

      const colLeft = ws.columns[colIdx];
      const colRight = ws.columns[colIdx + 1];
      if (!colLeft || !colRight) return;

      const ratioDelta = dx / containerWidth;
      const newLeft = colLeft.widthRatio + ratioDelta;
      const newRight = colRight.widthRatio - ratioDelta;

      // 侧栏/主列最小约 12%：过窄时 Diff 容器查询仍可读，但禁止拖到不可用宽度
      if (newLeft > 0.12 && newRight > 0.12) {
        colLeft.widthRatio = newLeft;
        colRight.widthRatio = newRight;
      }
    }),

    resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
      const ws = findWorkspace(state, wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length) return;
      if (!Number.isFinite(containerHeight) || containerHeight <= 0) return;

      const col = ws.columns[colIdx];
      if (!col || col.groups.length < 2) return;
      if (groupIdx < 0 || groupIdx >= col.groups.length - 1) return;

      const groupTop = col.groups[groupIdx];
      const groupBottom = col.groups[groupIdx + 1];
      if (!groupTop || !groupBottom) return;

      const ratioDelta = dy / containerHeight;
      const newTop = groupTop.heightRatio + ratioDelta;
      const newBottom = groupBottom.heightRatio - ratioDelta;

      if (newTop > 0.1 && newBottom > 0.1) {
        groupTop.heightRatio = newTop;
        groupBottom.heightRatio = newBottom;
      }
    }),

    applyTabModeEnabled: (enabled) => set((state) => {
      const on = !!enabled;
      state.tabModeEnabled = on;
      for (const ws of state.workspaces) {
        if (on) collapseToolColumnToTabs(ws);
        else splitToolColumnToStackedGroups(ws);
      }
    }),
  };
}
