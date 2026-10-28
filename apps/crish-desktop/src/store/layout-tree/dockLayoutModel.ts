/**
 * 右坞二叉树空间模型与正交 ToolTab 实体（Dock Split System Architecture V2）
 *
 * 遵循单一真理源（SSOT）与正交抽象原则。
 * 纯树结构几何与计算函数已解耦至 dockTreeMath.ts 与 dockLayoutOps.ts。
 */

import {
  clampRatio,
  clampSpatialRatio,
  collectSpatialLeaves,
  createSpatialBranch,
  findSpatialNode,
  flattenSpatialTree,
  isSpatialBranch,
  isSpatialLeaf,
  replaceSpatialNode,
  removeSpatialBranch,
} from './spatialTree';
import type {
  DockBranch,
  DockLeaf,
  DockNode,
  DockTree,
  OpenToolInput,
  ToolTab,
  ToolViewId,
} from './dockTreeTypes';
import {
  assertDockLeafInvariants,
  assertDockTreeInvariants,
  collectDockTabs,
  createDefaultDockLeaf,
  createDefaultDockTree,
  findLeafContainingTab,
  findToolTab,
  getActiveDockTab,
  insertTabIntoLeaf,
  isDockTreeEmpty,
  mintDockLeafId,
  mintToolTabId,
  pruneDockLeaf,
  splitDockNode,
} from './dockTreeMath';
import {
  activateDockLeaf,
  activateDockTab,
  closeDockLeaf,
  closeDockTab,
  moveDockTab,
  resizeDockBranch,
  splitDockLeaf,
  splitDockWithTab,
} from './dockLayoutOps';

// ==========================================
// 重新导出泛型空间原语与类型（保持100%消费点兼容）
// ==========================================

export {
  clampRatio,
  clampSpatialRatio,
  collectSpatialLeaves,
  createSpatialBranch,
  findSpatialNode,
  flattenSpatialTree,
  isSpatialBranch,
  isSpatialLeaf,
  replaceSpatialNode,
  removeSpatialBranch,
};

export type {
  BaseSpatialLeaf,
  SpatialBranch,
  SpatialDirection,
  SpatialNode,
  SpatialTree,
  NormalizedRect,
  SashSegment,
  FlattenedSpatialItem,
  FlattenedSpatialBranch,
  FlattenedSpatialTree,
} from './spatialTree';

// ==========================================
// 重新导出右坞核心类型
// ==========================================

export type {
  DockBranch,
  DockLeaf,
  DockNode,
  DockTree,
  OpenToolInput,
  ToolTab,
  ToolViewId,
};

// ==========================================
// 重新导出纯树数学、遍历与拓扑操作纯函数
// ==========================================

export {
  assertDockLeafInvariants,
  assertDockTreeInvariants,
  collectDockTabs,
  createDefaultDockLeaf,
  createDefaultDockTree,
  findLeafContainingTab,
  findToolTab,
  getActiveDockTab,
  insertTabIntoLeaf,
  isDockTreeEmpty,
  mintDockLeafId,
  mintToolTabId,
  pruneDockLeaf,
  splitDockNode,
  activateDockLeaf,
  activateDockTab,
  closeDockLeaf,
  closeDockTab,
  moveDockTab,
  resizeDockBranch,
  splitDockLeaf,
  splitDockWithTab,
};

// ==========================================
// 默认单例视图定义与判定
// ==========================================

export const SINGLETON_TOOL_VIEW_IDS: ReadonlySet<string> = new Set([
  'files',
  'diff',
  'overview',
  'agent',
  'runtime',
  'flow-dag',
]);

export function isViewSingleton(viewId: ToolViewId): boolean {
  if (viewId === 'terminal' || viewId === 'preview') {
    return false;
  }
  return true;
}

// ==========================================
// 路径归一化规范与参数清理
// ==========================================

export function normalizeViewerPath(p?: unknown): string {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  if (!s) return '';

  while (s.startsWith('./')) {
    s = s.slice(2);
  }

  const isUnc = s.startsWith('//');
  if (isUnc) {
    s = '//' + s.slice(2).replace(/\/+/g, '/');
  } else {
    s = s.replace(/\/+/g, '/');
  }

  s = s.replace(/\/\.\//g, '/');
  s = s.replace(
    /^([a-zA-Z]):\//,
    (_, drive: string) => `${drive.toUpperCase()}:/`
  );

  if (s.length > 3 && s.endsWith('/')) {
    s = s.slice(0, -1);
  }

  return s;
}

function cleanParams(
  _viewId: ToolViewId,
  params?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const next = { ...params };
  if (typeof next.filePath === 'string') {
    next.filePath = normalizeViewerPath(next.filePath);
  }
  return next;
}

// ==========================================
// 实体工厂函数
// ==========================================

export function createToolTab(
  inputOrViewId:
    | ToolViewId
    | {
        viewId: ToolViewId;
        title?: string;
        params?: Record<string, unknown>;
        tabId?: string;
      },
  options?: {
    title?: string;
    params?: Record<string, unknown>;
    tabId?: string;
  }
): ToolTab {
  if (typeof inputOrViewId === 'string') {
    const viewId = inputOrViewId;
    const params = cleanParams(viewId, options?.params);
    return {
      tabId: options?.tabId ?? mintToolTabId(viewId),
      viewId,
      title: options?.title,
      params: params ? Object.freeze(params) : undefined,
    };
  }
  const input = inputOrViewId;
  const params = cleanParams(input.viewId, input.params);
  return {
    tabId: input.tabId ?? mintToolTabId(input.viewId),
    viewId: input.viewId,
    title: input.title,
    params: params ? Object.freeze(params) : undefined,
  };
}

// ==========================================
// 标签打开与激活调度（Store 驱动）
// ==========================================

function matchesExistingTab(tab: ToolTab, input: OpenToolInput): boolean {
  if (tab.viewId !== input.viewId) {
    return false;
  }
  if (input.viewId === 'file-viewer') {
    const inputPath = normalizeViewerPath(input.params?.filePath);
    const tabPath = normalizeViewerPath(tab.params?.filePath);
    return Boolean(inputPath && tabPath && inputPath === tabPath);
  }
  return input.isSingleton !== undefined
    ? input.isSingleton
    : isViewSingleton(input.viewId);
}

export function openToolInDock(
  tree: DockTree,
  input: OpenToolInput
): { tree: DockTree; tabId: string } {
  const leaves = collectSpatialLeaves(tree.root);

  // 1. 全树扫描查找匹配的单例标签
  let foundLeaf: DockLeaf | null = null;
  let foundTab: ToolTab | null = null;

  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      if (matchesExistingTab(tab, input)) {
        foundLeaf = leaf;
        foundTab = tab;
        break;
      }
    }
    if (foundLeaf) break;
  }

  // 2. 单例命中：就地激活并热更新 params
  if (foundLeaf && foundTab) {
    const nextParams = cleanParams(input.viewId, input.params);
    const updatedTabs = foundLeaf.tabs.map((tab) => {
      if (tab.tabId !== foundTab.tabId) return tab;
      return {
        ...tab,
        ...(input.title !== undefined ? { title: input.title } : {}),
        params: nextParams
          ? Object.freeze({ ...(tab.params ?? {}), ...nextParams })
          : tab.params,
      };
    });

    const updatedLeaf: DockLeaf = {
      ...foundLeaf,
      tabs: updatedTabs,
      activeTabId: foundTab.tabId,
    };
    assertDockLeafInvariants(updatedLeaf);

    const newRoot = replaceSpatialNode(tree.root, foundLeaf.id, updatedLeaf);
    return {
      tree: {
        ...tree,
        root: newRoot,
        activeDockLeafId: foundLeaf.id,
      },
      tabId: foundTab.tabId,
    };
  }

  // 3. 多实例或首开：创建新标签并插入目标窗格
  const tabId = mintToolTabId(input.viewId);
  const newTab = createToolTab({
    viewId: input.viewId,
    title: input.title,
    params: input.params,
    tabId,
  });

  let targetLeaf: DockLeaf | undefined;
  if (input.targetLeafId) {
    targetLeaf = leaves.find((l) => l.id === input.targetLeafId);
  }
  if (!targetLeaf && tree.activeDockLeafId) {
    targetLeaf = leaves.find((l) => l.id === tree.activeDockLeafId);
  }
  if (!targetLeaf) {
    targetLeaf = leaves[0];
  }
  if (!targetLeaf) {
    targetLeaf = createDefaultDockLeaf();
  }

  const finalRoot =
    insertTabIntoLeaf(tree.root, targetLeaf.id, newTab) ??
    replaceSpatialNode(tree.root, targetLeaf.id, {
      ...targetLeaf,
      tabs: [...targetLeaf.tabs, newTab],
      activeTabId: newTab.tabId,
    });

  return {
    tree: {
      ...tree,
      root: finalRoot,
      activeDockLeafId: targetLeaf.id,
    },
    tabId: newTab.tabId,
  };
}
