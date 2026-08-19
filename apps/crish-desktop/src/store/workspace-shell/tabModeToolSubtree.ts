/**
 * 右坞 tool 子树：合并标签（单叶多 tab）vs 分开堆叠（垂直单 tab 叶）。
 * 纯函数，tabMode 由调用方从 layoutStore 读入，本模块不持有状态。
 */
import { collectLeaves } from '../layout-tree/operations';
import { viewRegistry } from '../../services/view-registry';
import {
  createBranch,
  createLeaf,
  isLeaf,
  type LayoutLeaf,
  type LayoutNode,
} from '../layout-tree/types';

/** 自上而下等分垂直堆叠。 */
export function stackToolLeavesVertically(
  panels: string[],
  activePanelId: string,
  ownerSessionId?: string
): LayoutNode {
  const ids = panels.length ? panels : [activePanelId];
  const owner = (ownerSessionId || '').trim() || undefined;
  const leaves = ids.map((id) => createLeaf(id, [id], id, owner));
  const last = leaves[leaves.length - 1];
  if (!last) return createLeaf(activePanelId, ids, activePanelId, owner);
  if (leaves.length === 1) return last;
  let node: LayoutNode = last;
  for (let i = leaves.length - 2; i >= 0; i--) {
    const remaining = leaves.length - i;
    node = createBranch('vertical', leaves[i]!, node, 1 / remaining);
  }
  return node;
}

/**
 * tabMode true → 单叶多 tab；false → 垂直单 tab 叶；undefined → 交给 sync（保留 split）。
 */
export function resolveToolSubtree(
  openPanelIds: string[],
  activePanelId: string,
  ownerSessionId: string | undefined,
  existing: LayoutNode | undefined,
  tabMode: boolean | undefined
): LayoutNode {
  const panels = openPanelIds.length ? openPanelIds : [activePanelId];
  const active = panels.includes(activePanelId) ? activePanelId : panels[0]!;
  const owner = (ownerSessionId || '').trim() || undefined;

  if (tabMode === false) {
    return stackToolLeavesVertically(panels, active, owner);
  }
  if (tabMode === true && existing && isLeaf(existing)) {
    return {
      ...existing,
      type: 'leaf',
      panelId: active,
      tabs: panels,
      activeTab: active,
      ...(owner ? { sessionId: owner } : {}),
    };
  }
  return createLeaf(active, panels, active, owner);
}

/** 在 tool 子树中定位应对齐 active 面板的叶。 */
export function findActiveToolLeaf(
  toolNode: LayoutNode,
  activePanelId: string
): LayoutLeaf | null {
  const leaves = collectLeaves(toolNode).filter(
    (l) => !viewRegistry.isPrimary(l.panelId)
  );
  const hit = leaves.find(
    (l) =>
      l.panelId === activePanelId ||
      l.activeTab === activePanelId ||
      (l.tabs && l.tabs.includes(activePanelId))
  );
  return hit ?? leaves[0] ?? null;
}
