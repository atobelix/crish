/**
 * Store 跨域编排层（瘦身门面）。
 *
 * 三域 facade（session / workspace / settingsUi）与 `useLayoutStore` **同一实例**。
 * 本文件提供跨域操作、StoreTransaction，以及对下兼容的命令式门面。
 * 具体实现位于 `./store-access/` 目录。
 */
import type {
  DiffChange,
  DropPreviewState,
  FileDiff,
  SessionAgent,
  SessionState,
  WorkspaceState,
} from '../store/types';
import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
} from '../store/draftSession';

export { PENDING_DRAFT_SESSION_ID, isPendingDraft };

import type { CronJob } from './clientApi';
import {
  getActiveSession as getActiveSessionFromFacade,
  getActiveSessionId as getActiveSessionIdFromFacade,
  getSessionAgent as getSessionAgentFromFacade,
  getSessionById,
  getSessionStoreState,
} from '../store/sessionStore';
import {
  getPermissionMode as getPermissionModeFromFacade,
  getSettingsUiState,
  openSettings as openSettingsUi,
  closeSettings as closeSettingsUi,
  toggleSettingsOverlay as toggleSettingsOverlayUi,
} from '../store/settingsUiStore';
import {
  focusExistingPanelCard,
  getActiveWorkspace,
  getDropPreview as getDropPreviewFromFacade,
  getWorkspaceStoreState,
  setDropPreview as setDropPreviewWs,
  setGroupActiveCard as setGroupActiveCardWs,
  togglePanel as togglePanelWs,
  type DraggedTabState,
} from '../store/workspaceStore';
import { normalizeSessionId } from './store-access/sessionAccess';

export {
  getSessionById,
  getSessionStoreState,
  getActiveSessionFromFacade as getActiveSession,
  getActiveSessionIdFromFacade as getActiveSessionId,
  getSessionAgentFromFacade as getSessionAgent,
  openSettingsUi as openSettings,
  closeSettingsUi as closeSettings,
  toggleSettingsOverlayUi as toggleSettingsOverlay,
  getSettingsUiState,
  getPermissionModeFromFacade as getPermissionMode,
  getWorkspaceStoreState,
  getActiveWorkspace,
  getDropPreviewFromFacade as getDropPreview,
  setDropPreviewWs as setDropPreview,
  setGroupActiveCardWs as setGroupActiveCard,
  togglePanelWs as togglePanel,
};

export type {
  DraggedTabState,
  DropPreviewState,
  SessionState,
  SessionAgent,
  FileDiff,
  DiffChange,
  CronJob,
  WorkspaceState,
};

export { getLayoutState } from './store-access/storeAccessCore';
export { unarchiveSession, setActiveAgentId, addMessageToolCall, updateMessageToolCall, updateMessageThinking, createSession, archiveSession } from './store-access/sessionAccess';
export { setAppSettings, getAppSettings, getCommandPermissions, addCommandPermission } from './store-access/settingsAccess';
export { setScheduledTasks, syncTelemetryData, pushDiffFile } from './store-access/telemetryAccess';

export * from './store-access/storeAccessCore';
export * from './store-access/sessionAccess';
export * from './store-access/settingsAccess';
export * from './store-access/telemetryAccess';

// ── 工作区域门面与纯函数 ──────────────────────────────────────────────────

export function findWorkspaceById(
  workspaces: readonly WorkspaceState[],
  wsId: string | null | undefined
): WorkspaceState | undefined {
  const id = normalizeSessionId(wsId);
  if (!id) return undefined;
  return workspaces.find((w) => w.id === id);
}

export type PanelCardLocation = {
  colIdx: number;
  groupIdx: number;
  cardId: string;
};

export function findPanelCardLocation(
  workspace: WorkspaceState | null | undefined,
  cardId: string | null | undefined
): PanelCardLocation | undefined {
  if (!workspace?.columns?.length) return undefined;
  const id = normalizeSessionId(cardId);
  if (!id) return undefined;
  for (let colIdx = 0; colIdx < workspace.columns.length; colIdx++) {
    const col = workspace.columns[colIdx];
    if (!col?.groups?.length) continue;
    for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
      const group = col.groups[groupIdx];
      if (group?.cards?.some((card) => card.id === id)) {
        return { colIdx, groupIdx, cardId: id };
      }
    }
  }
  return undefined;
}

export function workspaceHasCard(
  workspace: WorkspaceState | null | undefined,
  cardId: string | null | undefined
): boolean {
  return findPanelCardLocation(workspace, cardId) !== undefined;
}

export function resolvePanelCardId(
  cardId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(cardId);
  if (!id) return undefined;
  if (id === 'settings') return undefined;
  if (id === 'plan') return 'tasks';
  return id;
}

export function getWorkspaceById(
  wsId: string | null | undefined
): WorkspaceState | undefined {
  return findWorkspaceById(getWorkspaceStoreState().workspaces, wsId);
}

export function focusOrOpenPanel(wsId: string, cardId: string): void {
  const workspaceId = normalizeSessionId(wsId);
  if (!workspaceId) return;

  if (normalizeSessionId(cardId) === 'settings') {
    openSettingsUi();
    return;
  }

  const resolvedId = resolvePanelCardId(cardId);
  if (!resolvedId) return;

  if (!getWorkspaceById(workspaceId)) return;

  if (focusExistingPanelCard(workspaceId, resolvedId)) return;

  togglePanelWs(workspaceId, resolvedId, true);
  focusExistingPanelCard(workspaceId, resolvedId);
}
