/**
 * 工作区面板定位与聚焦门面（自 api/storeAccess.ts 迁入 store 域，SS-P6c 门面合一）。
 *
 * 纯查询（findWorkspaceById / findPanelCardLocation / workspaceHasCard /
 * resolvePanelCardId / getWorkspaceById）与聚焦编排（focusOrOpenPanel）。
 * 面板 key 归一化的单一真源仍是 `./layout-helpers/ui-panel` 的
 * `resolveWorkspacePanelKey`（settings/runtime 浮层剔除 + browser→preview /
 * plan→tasks 别名）；直接引叶模块而非 layout-helpers barrel，避免经由
 * store-initializers 等重模块形成环。
 */
import type { WorkspaceState } from './types';
import {
  focusExistingPanelCard,
  getWorkspaceStoreState,
  togglePanel as togglePanelWs,
} from './workspaceStore';
import { openSettings as openSettingsUi } from './settingsUiStore';
import { resolveWorkspacePanelKey } from './layout-helpers/ui-panel';
import { normalizeSessionId } from './sessionAccessQuery';

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
