/**
 * 工作区域 facade — 与 useLayoutStore **同一 zustand 实例**（非独立 create）。
 *
 * Owns (API surface): legacy workspaces / columns / groups / cards, DnD preview,
 * tabModeEnabled：layoutStore 为唯一写端；本字段是投影（不独立 persist）。
 *
 * ## Not the shell
 *
 * **workspaceStore ≠ workspaceShellStore.**
 * - This facade: pre-tree card columns + workspace DnD on the god layout instance.
 * - `workspace-shell`: TabSurface open tabs + rightDock (separate zustand).
 * - `layout-tree`: binary geometry (separate zustand).
 *
 * compositionRoot.`workspace` → this facade; compositionRoot.`shell` → workspace-shell.
 *
 * @see ./storeOwnership.ts
 * @see ./layoutStore.ts package header
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withPersist } from './middleware/withPersist';
import { useShallow } from './useShallowSelector';

import {
  DEFAULT_WORKSPACE_ID,
  seedInitialWorkspaces,
  clampActiveWorkspaceIndex,
  useLayoutStore,
} from './layoutStore';
import type {
  DropPreviewState,
  WorkspaceState,
} from './types';
import {
  createWorkspaceActions,
  type DraggedTabState,
  type WorkspaceActions,
  type WorkspaceStoreSlice,
} from './workspaceActions';

const _initialWorkspaces = seedInitialWorkspaces(DEFAULT_WORKSPACE_ID);

type WorkspaceStoreData = WorkspaceStoreSlice;

export type WorkspaceStore = WorkspaceStoreData & WorkspaceActions;

export const useWorkspaceStore = create<WorkspaceStore>()(
  withDevtools(
    withPersist(
      immer((set, get) => ({
        workspaces: _initialWorkspaces,
        activeWorkspaceIndex: clampActiveWorkspaceIndex(_initialWorkspaces, 0),
        tabModeEnabled: useLayoutStore.getState().tabModeEnabled,
        draggedTab: null,
        dropPreview: null,
        ...createWorkspaceActions(set, get),
      })),
      {
        name: 'crish_workspace_store_v1',
        partialize: (s) => ({
          workspaces: s.workspaces,
          activeWorkspaceIndex: s.activeWorkspaceIndex,
        }),
        merge: (persisted, current) => {
          const raw = (persisted ?? {}) as Record<string, unknown>;
          const { tabModeEnabled: _ignored, ...rest } = raw;
          return { ...current, ...rest, tabModeEnabled: current.tabModeEnabled };
        },
      }
    ),
    'CrishWorkspaceStore'
  )
);

export type WorkspaceFacade = WorkspaceStoreSlice & WorkspaceActions;

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

export const selectActiveWorkspace = (
  s: Pick<WorkspaceStoreSlice, 'workspaces' | 'activeWorkspaceIndex'>,
): WorkspaceState | undefined => s.workspaces[s.activeWorkspaceIndex];

export function useWorkspaceField<T>(selector: (state: WorkspaceFacade) => T): T {
  return useWorkspaceStore(
    selector as (state: ReturnType<typeof useWorkspaceStore.getState>) => T,
  );
}

export function useWorkspaces(): WorkspaceState[] {
  return useWorkspaceStore(useShallow((s) => s.workspaces));
}

export function useActiveWorkspaceIndex(): number {
  return useWorkspaceStore((s) => s.activeWorkspaceIndex);
}

export function useActiveWorkspace(): WorkspaceState | undefined {
  return useWorkspaceStore(useShallow((s) => s.workspaces[s.activeWorkspaceIndex]));
}

export function useDraggedTab(): DraggedTabState | null {
  return useWorkspaceStore((s) => s.draggedTab);
}

export function useDropPreview(): DropPreviewState | null {
  return useWorkspaceStore((s) => s.dropPreview);
}

export function getWorkspaceStoreState(): WorkspaceStore {
  return useWorkspaceStore.getState();
}

export function getActiveWorkspace(): WorkspaceState | undefined {
  const s = getWorkspaceStoreState();
  return s.workspaces[s.activeWorkspaceIndex];
}

export function getDropPreview(): DropPreviewState | null {
  return getWorkspaceStoreState().dropPreview;
}

export function setDropPreview(preview: DropPreviewState | null): void {
  getWorkspaceStoreState().setDropPreview(preview);
}

export function setDraggedTab(dragged: DraggedTabState | null): void {
  getWorkspaceStoreState().setDraggedTab(dragged);
}

export function togglePanel(wsId: string, key: string, isVisible: boolean): void {
  getWorkspaceStoreState().togglePanel(wsId, key, isVisible);
}

export function setGroupActiveCard(
  wsId: string,
  colIdx: number,
  groupIdx: number,
  cardId: string,
): void {
  // P3-4：facade 仅转发（真 action 定义见 workspaceActions.setGroupActiveCard）
  getWorkspaceStoreState().setGroupActiveCard(wsId, colIdx, groupIdx, cardId);
}

export function focusExistingPanelCard(wsId: string, cardId: string): boolean {
  // P3-4：facade 仅转发（真 action 定义见 workspaceActions.focusExistingPanelCard）
  return getWorkspaceStoreState().focusExistingPanelCard(wsId, cardId);
}

export type { DraggedTabState };
