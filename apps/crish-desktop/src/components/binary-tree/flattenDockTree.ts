/**
 * 右坞分屏树几何展平算法（Flatten DockTree）
 *
 * 纯逻辑、零 DOM 依赖、无副作用。
 * 基于底层通用空间树几何算法，将 DockTree 拓扑展平为绝对定位百分比矩形与 Sash 分割线段。
 */

import {
  findSpatialNode,
  flattenSpatialTree,
  isSpatialLeaf,
  type NormalizedRect,
  type SashSegment,
  type SpatialDirection,
  type DockLeaf,
  type DockTree,
  type ToolTab,
} from '../../store/storeAccess';

export interface FlatDockLeaf {
  readonly leafId: string;
  readonly tabs: readonly ToolTab[];
  readonly activeTabId: string | null;
  readonly rect: NormalizedRect;
  readonly isActive: boolean; // leaf.id === tree.activeDockLeafId
}

export interface FlatDockBranch {
  readonly branchId: string;
  readonly direction: SpatialDirection;
  readonly splitRatio: number;
  readonly rect: NormalizedRect;
  readonly sash: SashSegment;
}

export interface FlattenedDockLayout {
  readonly leaves: readonly FlatDockLeaf[];
  readonly branches: readonly FlatDockBranch[];
}

/**
 * 将整棵 DockTree 展平为适合绝对定位 Canvas 渲染的几何结构。
 * 若指定 soloLeafId，则该 leaf 100% 占满全屏，Sash 列表清空。
 */
export function flattenDockTree(
  tree: DockTree,
  soloLeafId?: string | null
): FlattenedDockLayout {
  if (soloLeafId) {
    const soloNode = findSpatialNode(tree.root, soloLeafId);
    if (soloNode && isSpatialLeaf(soloNode)) {
      const leaf = soloNode as DockLeaf;
      return {
        leaves: [
          {
            leafId: leaf.id,
            tabs: leaf.tabs,
            activeTabId: leaf.activeTabId,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            isActive: leaf.id === tree.activeDockLeafId,
          },
        ],
        branches: [],
      };
    }
  }

  const flattened = flattenSpatialTree(tree.root);

  const leaves: FlatDockLeaf[] = flattened.leaves.map((item) => ({
    leafId: item.leaf.id,
    tabs: item.leaf.tabs,
    activeTabId: item.leaf.activeTabId,
    rect: item.rect,
    isActive: item.leaf.id === tree.activeDockLeafId,
  }));

  const branches: FlatDockBranch[] = flattened.branches.map((item) => ({
    branchId: item.branch.id,
    direction: item.branch.direction,
    splitRatio: item.branch.splitRatio,
    rect: item.rect,
    sash: item.sash,
  }));

  return { leaves, branches };
}
