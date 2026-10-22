import type { CardState, CardGroupState } from '../types';
import { viewRegistry } from '../../services/view-registry/ViewRegistry';

export function getPanelTitle(cardId: string): string {
  return viewRegistry.getTitle(cardId);
}

/**
 * 归一化工作区面板 key → 列内可承载的卡片 id。
 *
 * - 浮层面板（settings / runtime）不进列 → null
 * - 历史别名：browser → preview（决策 1 视图路由收敛，browser 已并入 preview）、
 *   plan → tasks。二者来自旧版本持久化布局，必须在此收敛，
 *   否则 stripGhostPanelsFromWorkspace 会放行「视图已不存在」的幽灵卡。
 *
 * 本函数是别名归一化的**单一真源**；storeAccess.resolvePanelCardId 委托于此，
 * 禁止另建别名表（历史上两份已漂移：storeAccess 侧漏了 runtime 守卫）。
 */
export function resolveWorkspacePanelKey(
  key: string | null | undefined
): string | null {
  if (key == null) return null;
  const id = String(key).trim();
  if (!id) return null;
  if (id === 'settings' || id === 'runtime') return null;
  if (id === 'browser') return 'preview';
  if (id === 'plan') return 'tasks';
  return id;
}

export function makePanelCard(cardId: string): CardState {
  return { id: cardId, title: getPanelTitle(cardId) };
}

export function makePanelGroup(
  cardId: string,
  wsId: string,
  opts?: { groupId?: string; heightRatio?: number }
): CardGroupState {
  return {
    id: opts?.groupId ?? `group-${cardId}-${wsId}`,
    activeCardId: cardId,
    cards: [makePanelCard(cardId)],
    heightRatio: opts?.heightRatio ?? 1,
  };
}
