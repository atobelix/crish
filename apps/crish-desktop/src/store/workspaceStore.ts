/**
 * 工作区域 facade — 与 useLayoutStore **同一 zustand 实例**（非独立 create）。
 *
 * Owns (API surface): legacy workspaces / columns / groups / cards, DnD preview,
 * tabMode flags that still live on layoutStore.
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

import { useShallow } from './useShallowSelector';

import { DEFAULT_WORKSPACE_ID, seedInitialWorkspaces, useLayoutStore } from './layoutStore';
import type {
  DropPreviewState,
  WorkspaceState,
} from './types';
import type {
  DraggedTabState,
  WorkspaceActions,
  WorkspaceStoreSlice,
} from './workspaceActions';
import { expandToolColumnIfCollapsed } from './layoutHelpers';

const _initialWorkspaces = seedInitialWorkspaces(DEFAULT_WORKSPACE_ID);

type WorkspaceStoreData = WorkspaceStoreSlice;

export type WorkspaceStore = WorkspaceStoreData & WorkspaceActions;

export const useWorkspaceStore = useLayoutStore;

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

export function getWorkspaceStoreState(): WorkspaceFacade {
  return useWorkspaceStore.getState() as unknown as WorkspaceFacade;
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
  useWorkspaceStore.setState((state) => {
    const group = state.workspaces.find((w) => w.id === wsId)?.columns[colIdx]
      ?.groups[groupIdx];
    if (group) group.activeCardId = cardId;
  });
}

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
          expandToolColumnIfCollapsed(ws);
          return;
        }
      }
    }
  });
  return found;
}

export type { DraggedTabState };
