/**
 * 工作区 actions 共享类型与内部辅助（T4-7 拆分核心）。
 * workspaceActions.ts 保留为 re-export hub + createWorkspaceActions 装配；
 * 子域文件（workspaceCreateActions / workspaceSwitchActions / workspaceCleanupActions）
 * 经本文件共享 slice 类型与 workspace 定位辅助，避免重复定义。
 */
import type { DropPreviewState, WorkspaceState } from './types';

/** 布局快照：供 applyWorkspaceLayout 还原 columns。 */
export type LayoutSnapshot = {
  columns: Array<{
    widthRatio: number;
    groups: Array<{ heightRatio: number; cards: string[]; activeCardId: string }>;
  }>;
  savedAt: number;
};

/** 拖拽中的标签状态（与 LayoutStore.draggedTab 形状一致） */
export interface DraggedTabState {
  cardId: string;
  sourceGroupId: string;
  workspaceId: string;
  isTabDrag?: boolean;
}

/**
 * 工作区域 action 需要读写的 store 切片（避免与 layoutStore 循环 import）。
 * 字段名/形状须与 LayoutStore 对齐；LayoutStore 必须 extends 本切片。
 */
export interface WorkspaceStoreSlice {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
}

/**
 * immer set / get：泛型 T extends WorkspaceStoreSlice，避免 layoutStore 侧 `as any`。
 */
export type WorkspaceImmerSet<T extends WorkspaceStoreSlice = WorkspaceStoreSlice> = (
  recipe: (state: T) => void,
) => void;
export type WorkspaceStoreGet<T extends WorkspaceStoreSlice = WorkspaceStoreSlice> = () => T;

/** 定位工作区；缺失或空切片时返回 null（empty workspace guard） */
export function findWorkspace(
  state: WorkspaceStoreSlice,
  wsId: string,
): WorkspaceState | null {
  if (!state.workspaces.length) return null;
  return state.workspaces.find((w) => w.id === wsId) ?? null;
}

/** 活动工作区；越界 / 空列表 → null */
export function activeWorkspace(state: WorkspaceStoreSlice): WorkspaceState | null {
  if (!state.workspaces.length) return null;
  const idx = Math.min(
    Math.max(0, state.activeWorkspaceIndex),
    state.workspaces.length - 1,
  );
  return state.workspaces[idx] ?? null;
}
