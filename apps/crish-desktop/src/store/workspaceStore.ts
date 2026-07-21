import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from './useShallowSelector';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';

import { DEFAULT_WORKSPACE_ID, seedInitialWorkspaces, clampActiveWorkspaceIndex } from './layoutStore';
import type {
  CardState,
  CardGroupState,
  ColumnState,
  DropPreviewState,
  FileDiff,
  WorkspaceState,
} from './types';
import type {
  DraggedTabState,
  WorkspaceActions,
  WorkspaceStoreSlice,
} from './workspaceActions';
import { createWorkspaceActions } from './workspaceActions';
import { expandToolColumnIfCollapsed, upsertDiffFile } from './layoutHelpers';

const _initialWorkspaces = seedInitialWorkspaces(DEFAULT_WORKSPACE_ID);

type WorkspaceStoreData = WorkspaceStoreSlice & {
  diffFiles: FileDiff[];
  activeDiffSource: FileDiff | null;
};

type WorkspaceStore = WorkspaceStoreData & WorkspaceActions & {
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) => void;
  pushDiffFile: (diff: FileDiff) => void;
  removeDiffFile: (filePath: string) => void;
};

const _workspaceData: WorkspaceStoreData = {
  workspaces: _initialWorkspaces,
  activeWorkspaceIndex: clampActiveWorkspaceIndex(_initialWorkspaces, 0),
  tabModeEnabled: true,
  draggedTab: null,
  dropPreview: null,
  diffFiles: [],
  activeDiffSource: null,
};

export const useWorkspaceStore = create<WorkspaceStore>()(
  withDevtools(
    withLogger(
      immer((set, get) => ({
        ..._workspaceData,
        ...createWorkspaceActions(set, get),

        setActiveDiffSource: (diff) => set((state) => {
          state.activeDiffSource = diff;
          if (diff) {
            upsertDiffFile(state.diffFiles, diff);
          }
        }),
        setDiffFiles: (files) => set((state) => {
          const next = typeof files === 'function'
            ? (files as (prev: FileDiff[]) => FileDiff[])(state.diffFiles)
            : files;
          state.diffFiles = Array.isArray(next) ? next : [];
          state.activeDiffSource = state.diffFiles[0] || null;
        }),
        pushDiffFile: (diff) => set((state) => {
          upsertDiffFile(state.diffFiles, diff);
          state.activeDiffSource = diff;
        }),
        removeDiffFile: (filePath) => set((state) => {
          const path = filePath || '';
          state.diffFiles = state.diffFiles.filter((f) => f.filePath !== path);
          if (state.activeDiffSource?.filePath === path) {
            state.activeDiffSource = state.diffFiles[0] || null;
          }
        }),
      })),
    ),
    'WorkspaceStore',
  ),
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
