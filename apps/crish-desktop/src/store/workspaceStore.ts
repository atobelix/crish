/**
 * 工作区域 facade：当前代理到 useLayoutStore（同一 immer store）。
 *
 * 覆盖 workspaces / 标签 DnD（draggedTab、dropPreview）及 workspaceActions。
 * 新代码优先从本文件取工作区相关状态；未来 multi-store 时只改本文件。
 *
 * 勿破坏：`useLayoutStore` 仍是权威入口（见 layoutStore.ts）。
 *
 * 对齐约定（与 sessionStore / settingsUiStore 一致）：
 * - useWorkspaceStore === useLayoutStore（同引用）
 * - 便捷 hooks 经 useWorkspaceStore 订阅
 * - 命令式：getWorkspaceStoreState / getActiveWorkspace
 */

import { useLayoutStore } from './layoutStore';
import type { DropPreviewState, WorkspaceState } from './types';
import type {
  DraggedTabState,
  WorkspaceActions,
  WorkspaceStoreSlice,
} from './workspaceActions';

/** 工作区域 facade：切片状态 + actions */
export type WorkspaceFacade = WorkspaceStoreSlice & WorkspaceActions;

/**
 * 与 useLayoutStore 同一 zustand 实例。
 * 语义上表示「工作区域订阅」；实现上暂未拆分 store。
 */
export const useWorkspaceStore = useLayoutStore;

// ── selectors ─────────────────────────────────────────────────────────────

export const selectWorkspaces = (s: Pick<WorkspaceStoreSlice, 'workspaces'>) =>
  s.workspaces;

export const selectActiveWorkspaceIndex = (
  s: Pick<WorkspaceStoreSlice, 'activeWorkspaceIndex'>,
) => s.activeWorkspaceIndex;

export const selectTabModeEnabled = (s: Pick<WorkspaceStoreSlice, 'tabModeEnabled'>) =>
  s.tabModeEnabled;

export const selectDraggedTab = (s: Pick<WorkspaceStoreSlice, 'draggedTab'>) =>
  s.draggedTab;

export const selectDropPreview = (s: Pick<WorkspaceStoreSlice, 'dropPreview'>) =>
  s.dropPreview;

/** 当前活动工作区（按 activeWorkspaceIndex） */
export const selectActiveWorkspace = (
  s: Pick<WorkspaceStoreSlice, 'workspaces' | 'activeWorkspaceIndex'>,
): WorkspaceState | undefined => s.workspaces[s.activeWorkspaceIndex];

// ── 便捷 hooks（细粒度订阅，减少无关重渲染）──────────────────────────────

/**
 * 订阅工作区域切片。组件不需要会话 / 遥测字段时优先用此 helper。
 *
 * @example
 *   const tabs = useWorkspaceField((s) => s.draggedTab);
 *   const ws = useWorkspaceField(selectActiveWorkspace);
 */
export function useWorkspaceField<T>(selector: (state: WorkspaceFacade) => T): T {
  return useWorkspaceStore(
    selector as (state: ReturnType<typeof useWorkspaceStore.getState>) => T,
  );
}

export function useWorkspaces(): WorkspaceState[] {
  return useWorkspaceStore((s) => s.workspaces);
}

export function useActiveWorkspaceIndex(): number {
  return useWorkspaceStore((s) => s.activeWorkspaceIndex);
}

export function useActiveWorkspace(): WorkspaceState | undefined {
  return useWorkspaceStore((s) => s.workspaces[s.activeWorkspaceIndex]);
}

export function useDraggedTab(): DraggedTabState | null {
  return useWorkspaceStore((s) => s.draggedTab);
}

export function useDropPreview(): DropPreviewState | null {
  return useWorkspaceStore((s) => s.dropPreview);
}

// ── 非 React helpers ──────────────────────────────────────────────────────

export function getWorkspaceStoreState(): WorkspaceFacade {
  return useWorkspaceStore.getState() as unknown as WorkspaceFacade;
}

export function getActiveWorkspace(): WorkspaceState | undefined {
  const s = getWorkspaceStoreState();
  return s.workspaces[s.activeWorkspaceIndex];
}

/** 当前 DnD 预览快照（命令式；与 storeAccess.getDropPreview 同源） */
export function getDropPreview(): DropPreviewState | null {
  return getWorkspaceStoreState().dropPreview;
}

/** DnD 预览（useTabDrag 热路径；勿在组件 render 调 getState） */
export function setDropPreview(preview: DropPreviewState | null): void {
  getWorkspaceStoreState().setDropPreview(preview);
}

export function setDraggedTab(dragged: DraggedTabState | null): void {
  getWorkspaceStoreState().setDraggedTab(dragged);
}

export function togglePanel(wsId: string, key: string, isVisible: boolean): void {
  getWorkspaceStoreState().togglePanel(wsId, key, isVisible);
}

/**
 * 将指定 group 的 activeCardId 切到 cardId（侧栏 tab 点击）。
 * 不新建面板；仅切换焦点。走 workspace facade setState。
 */
export function setGroupActiveCard(
  wsId: string,
  colIdx: number,
  groupIdx: number,
  cardId: string,
): void {
  useWorkspaceStore.setState((state) => {
    const group = state.workspaces.find((w) => w.id === wsId)?.columns[colIdx]
      ?.groups[groupIdx];
    if (group) group.activeCardId = cardId;
  });
}

/**
 * 在已有面板组内聚焦 cardId（若存在）。返回是否已找到并聚焦。
 * focusOrOpenPanel 编排用；不负责 toggle 打开。
 */
export function focusExistingPanelCard(wsId: string, cardId: string): boolean {
  let found = false;
  useWorkspaceStore.setState((state) => {
    const ws = state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    for (const c of ws.columns) {
      for (const g of c.groups) {
        if (g.cards.some((card) => card.id === cardId)) {
          g.activeCardId = cardId;
          found = true;
          return;
        }
      }
    }
  });
  return found;
}

export type { DraggedTabState };
