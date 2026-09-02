/**
 * Adapter 纯树辅助：计数 / 钳制。
 *
 * I5 后坞不在树上。expand / collapse / project / strip 投影行为已删除
 * （符号保留恒等，避免并行维测试编译红）。
 */

import { collectLeaves } from '../layout-tree';
import { viewRegistry } from '../../services/view-registry';
import type { LayoutNode, LayoutTree } from '../layout-tree/types';

/** chat 域叶子数（I5 后应等于全部叶） */
export function countChatLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter((l) =>
    viewRegistry.isPrimary(l.panelId)
  ).length;
}

/** 非 chat 叶数。I5 断言用：生产写路径必须保持 0 */
export function countToolLeaves(treeRoot: LayoutNode): number {
  return collectLeaves(treeRoot).filter(
    (l) => !viewRegistry.isPrimary(l.panelId)
  ).length;
}

/** 抽屉宽度占叶内容区比例；钳制 [0.20, 0.75] */
export function clampDockWidthRatio(widthRatio: number): number {
  return Math.min(0.75, Math.max(0.20, widthRatio));
}

/**
 * 以下符号行为已删除（I5 禁止再造/剥 tool 叶）。
 * 保留恒等函数：维 07 / 并行测试文件尚未改 import。生产路径禁止调用。
 */
export function expandSessionUnitDock(
  tree: LayoutTree,
  ..._rest: unknown[]
): LayoutTree {
  return tree;
}

export function collapseSessionUnitDock(
  tree: LayoutTree,
  ..._rest: unknown[]
): LayoutTree {
  return tree;
}

export function projectDockOntoTree(
  tree: LayoutTree,
  ..._rest: unknown[]
): LayoutTree {
  return tree;
}

export function stripToolLeavesPreserveChats(tree: LayoutTree): LayoutTree {
  return tree;
}

export function normalizeToAdapterShape(tree: LayoutTree): LayoutTree {
  return tree;
}

export function resolveChatLeafForSession(
  ..._rest: unknown[]
): null {
  return null;
}
