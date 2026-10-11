/**
 * Store 跨域编排层（瘦身门面）。
 *
 * 三域 facade（session / workspace / settingsUi）与 `useLayoutStore` **同一实例**。
 * 本文件提供跨域操作、StoreTransaction，以及对下兼容的命令式门面。
 * 具体实现位于 `./store-access/` 目录。
 *
 * ## 双 storeAccess 消费方决策树（维度 3 步骤 1 / 3-L）
 *
 * 仓库内存在两个同名 storeAccess 模块，职责正交，消费方按以下决策树选路：
 *
 * 1. 你需要 **写** 会话/工作区/设置（命令式 mutation，含跨域编排、
 *    setActiveSessionId / enterDraftMode / createSession / setAppSettings /
 *    pushDiffFile / setScheduledTasks 等）？
 *    → 走本文件（`api/storeAccess.ts`，编排层门面；实现于 `./store-access/`）。
 *    - 注：workspace-shell 域的 `enterDraftMode`/`setActiveSessionId` 经
 *      `useSessionStore.getState()` 同层 action 调用（3-C 斩断 store→api 反向边后），
 *      不再经本编排层；其它写路径（settings/telemetry/session 编排）仍经本门面。
 *
 * 2. 你需要 **读** T11 新域 store（terminal / worker / permission / settings）
 *    或布局 chrome（只读快照 / hooks）？
 *    → 走 `store/storeAccess.ts`（公共**读**面；写仍走各域 store actions）。
 *
 * 3. 既有 `api/storeAccess` 的**读**门面（getActiveSession / getSessionById 等）
 *    与 `store/storeAccess` 的会话读面**等价**（同源 store）；
 *    新代码读会话/布局优先 `store/storeAccess`，编排写仍经本文件。
 *
 * 混用文件（同文件既读 store/storeAccess 又写 api/storeAccess）应各补行内注释
 * 标明哪条是读路径、哪条是写路径，避免后续维护者误用反向。
 */
import type {
  DiffChange,
  DropPreviewState,
  FileDiff,
  SessionAgent,
  SessionState,
  WorkspaceState,
} from '../store/types';

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
// 面板 key 归一化的单一真源（settings/runtime 浮层剔除 + browser→preview / plan→tasks 别名）。
// 直接引叶模块而非 layout-helpers barrel：避免经由 store-initializers 等重模块形成环。
import { resolveWorkspacePanelKey } from '../store/layout-helpers/ui-panel';

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
export { reportRuntimeStatus } from '../store/sessionRuntimeStatusStore';
export { setScheduledTasks, syncTelemetryData, pushDiffFile } from './store-access/telemetryAccess';
export { openFileViewerInSession } from '../store/workspace-shell';

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

/**
 * 归一化待聚焦/打开的面板 id。
 *
 * 委托 `resolveWorkspacePanelKey`（唯一别名真源），不再就地维护第二份别名表——
 * 历史上两份已漂移（本处漏了 runtime 守卫，导致运行时面板可被塞进列）。
 * 语义映射：null/空/浮层 → undefined（无卡片可聚焦）。
 */
export function resolvePanelCardId(
  cardId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(cardId);
  if (!id) return undefined;
  return resolveWorkspacePanelKey(id) ?? undefined;
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
