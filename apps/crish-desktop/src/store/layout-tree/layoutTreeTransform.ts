/**
 * 二叉树布局操作 — 序列化/迁移/resize/拖拽提交操作子模块。
 *
 * resizeBranch / setLeafActiveTab / setLeafSessionId / applyDrop / migrateFromColumns。
 * flattenTree 独立到 layoutTreeFlatten.ts（flattenRecursive 展开后行数较大）。
 */
import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  SplitDirection,
  DropDirection,
  TreeDragSource,
} from './types';
import { createBranch, createLeaf, isBranch, isLeaf, clampSplitRatio } from './types';
import { isPrimaryPanel } from './index';
import type { DropZone } from './dropDetection';
import { isUnitScopedDropAllowed } from './dropDetection';
import { findNodeById, findParent } from './layoutTreeQuery';
import { removeBranch, replaceNode, splitLeaf } from './layoutTreeInsert';
import { moveLeaf, removeTabFromLeaf } from './layoutTreeMoveRemove';

// ── resize / leaf 绑定 ──────────────────────────────────────────────────

/** 调整分支的分割比例 */
export function resizeBranch(
  tree: LayoutTree,
  branchId: string,
  newRatio: number
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const updated: LayoutBranch = {
    ...target,
    splitRatio: clampSplitRatio(newRatio),
  };
  return { ...tree, root: replaceNode(tree.root, branchId, updated) };
}

/** 设置叶子的激活 tab（不改变 tabs 列表，仅切换 activeTab） */
export function setLeafActiveTab(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.includes(tabId)) return tree;
  if (target.activeTab === tabId) return tree;
  const updated: LayoutLeaf = { ...target, activeTab: tabId };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 设置 chat leaf 绑定的 sessionId（多 chat 分屏）。
 * sessionId 为 undefined 时清除绑定。
 */
export function setLeafSessionId(
  tree: LayoutTree,
  leafId: string,
  sessionId: string | undefined
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (target.sessionId === sessionId) return tree;
  const updated: LayoutLeaf = { ...target };
  if (sessionId) {
    updated.sessionId = sessionId;
  } else {
    delete updated.sessionId;
  }
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

// ── 拖拽提交 ──────────────────────────────────────────────────────────

/**
 * DropZone.type → DropDirection 映射。
 * 'merge-tab' 单独处理（不进入 moveLeaf/splitLeaf 路径）。
 */
function dropZoneToDirection(zoneType: DropZone['type']): DropDirection | null {
  switch (zoneType) {
    case 'split-left':
      return 'left';
    case 'split-right':
      return 'right';
    case 'split-top':
      return 'top';
    case 'split-bottom':
      return 'bottom';
    case 'merge-tab':
      return null;
    default:
      return null;
  }
}

/**
 * 将 srcLeaf 的所有 tabs 合并到 targetLeaf，然后移除 srcLeaf。
 *
 * 单次树重建（O(tree size)），替代旧实现的 O(n × tree size) 循环。
 *
 * 行为约定：
 * - tabs 去重：targetLeaf 已有的 tab 不重复添加，srcLeaf 的 tabs 追加到末尾
 * - activeTab：设为 srcLeaf.activeTab（用户拖过来时正在看的内容），
 *   若该值不在合并后 tabs 中（违反不变量），回退到 targetLeaf.activeTab
 * - srcLeaf 用其兄弟节点替代（移除其父 branch）
 *
 * 不变量：调用前应保证 srcLeafId !== targetLeafId（由 applyDrop 上游校验）。
 */
function mergeLeafInto(
  tree: LayoutTree,
  srcLeafId: string,
  targetLeafId: string
): LayoutTree {
  if (srcLeafId === targetLeafId) return tree;

  const srcLeaf = findNodeById(tree.root, srcLeafId);
  const targetLeaf = findNodeById(tree.root, targetLeafId);
  if (!srcLeaf || !isLeaf(srcLeaf) || !targetLeaf || !isLeaf(targetLeaf)) {
    return tree;
  }

  // 1. 合并 tabs（去重，srcLeaf 的 tabs 追加到末尾）
  const mergedTabs = [...targetLeaf.tabs];
  for (const tab of srcLeaf.tabs) {
    if (!mergedTabs.includes(tab)) {
      mergedTabs.push(tab);
    }
  }

  // 2. 决定合并后的 activeTab：优先 srcLeaf.activeTab（用户拖过来时正在看的内容）
  const mergedActiveTab = mergedTabs.includes(srcLeaf.activeTab)
    ? srcLeaf.activeTab
    : targetLeaf.activeTab;

  // 3. 替换 targetLeaf 为合并后的版本
  //    owner sessionId：优先保留 target，否则继承 src（tool 叶 = 所属 unit）
  const ownerSessionId = targetLeaf.sessionId ?? srcLeaf.sessionId;
  const mergedTarget: LayoutLeaf = {
    ...targetLeaf,
    tabs: mergedTabs,
    activeTab: mergedActiveTab,
  };
  if (ownerSessionId) {
    mergedTarget.sessionId = ownerSessionId;
  } else {
    delete mergedTarget.sessionId;
  }
  const afterMerge = {
    ...tree,
    root: replaceNode(tree.root, targetLeafId, mergedTarget),
  };

  // 4. 移除 srcLeaf（用兄弟节点替代其父 branch）
  //    若 srcLeaf 是根（不应发生，因为 targetLeaf 存在且不同），直接返回合并结果
  if (afterMerge.root.id === srcLeafId) {
    return afterMerge;
  }
  const parentInfo = findParent(afterMerge.root, srcLeafId);
  if (!parentInfo) return afterMerge;
  const { parent, index } = parentInfo;
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;
  const newRoot = removeBranch(afterMerge.root, parent.id, keepIndex);
  return { ...afterMerge, root: newRoot };
}

/**
 * 重排/移动叶子内部的 tab 顺序
 */
function reorderTabInLeaf(
  tree: LayoutTree,
  leafId: string,
  fromTabId: string,
  targetTabId?: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.includes(fromTabId)) return tree;

  const tabs = [...target.tabs];
  const fromIdx = tabs.indexOf(fromTabId);
  if (fromIdx < 0) return tree;

  tabs.splice(fromIdx, 1);
  if (targetTabId && tabs.includes(targetTabId)) {
    const toIdx = tabs.indexOf(targetTabId);
    tabs.splice(toIdx, 0, fromTabId);
  } else {
    tabs.push(fromTabId);
  }

  const updated: LayoutLeaf = {
    ...target,
    tabs,
    activeTab: fromTabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 将单个 tab 从 srcLeaf 移到 targetLeaf（drag merge-tab 路径）。
 *
 * 同 leaf 短路（系统性修复）：
 * 旧实现无条件调用 removeTabFromLeaf，对 srcLeafId === targetLeafId 的同 leaf
 * tab 重排场景致命：若 srcTab 是该 leaf 的唯一 tab，removeTabFromLeaf 会移除
 * 整个 leaf，随后 findNodeById(targetLeafId) 返回 null，函数返回 afterRemove
 * —— leaf 被静默删除，用户丢失面板。
 *
 * 同 leaf 重排的语义本就是"切换 activeTab 到被拖的 tab"，无需 remove+re-add。
 * 直接委托 setLeafActiveTab 即可：tab 必在 tabs 中，仅切换 activeTab。
 *
 * 跨 leaf 路径保持原逻辑：
 * 1. 从 srcLeaf 移除 tab（若为最后一个 tab，srcLeaf 被移除）
 * 2. 若 targetLeaf 仍存在：将 tab 加入 targetLeaf（如已存在则不重复），
 *    并将 activeTab 切换为 srcTabId
 */
function mergeTabIntoLeaf(
  tree: LayoutTree,
  srcLeafId: string,
  srcTabId: string,
  targetLeafId: string,
  targetTabId?: string
): LayoutTree {
  // 同 leaf tab 重排：支持指定目标位置重排，避免 removeTab 导致 leaf 被删除
  if (srcLeafId === targetLeafId) {
    if (targetTabId) {
      return reorderTabInLeaf(tree, srcLeafId, srcTabId, targetTabId);
    }
    return setLeafActiveTab(tree, srcLeafId, srcTabId);
  }

  // 1. 从 srcLeaf 移除 tab
  const afterRemove = removeTabFromLeaf(tree, srcLeafId, srcTabId);

  // 2. 检查 target 是否仍存在（srcLeaf 移除可能重组树）
  const targetLeaf = findNodeById(afterRemove.root, targetLeafId);
  if (!targetLeaf || !isLeaf(targetLeaf)) {
    return afterRemove;
  }

  // 3. 合并 tab：
  //    - srcTabId 已在 target.tabs 中（去重场景）：保持原顺序不变，仅切换 activeTab。
  //    - srcTabId 不在 target.tabs 中：按 targetTabId 插入指定位置，否则追加末尾。
  let newTabs: string[];
  if (targetLeaf.tabs.includes(srcTabId)) {
    newTabs = targetLeaf.tabs;
  } else {
    newTabs = [...targetLeaf.tabs];
    if (targetTabId && newTabs.includes(targetTabId)) {
      const insertIdx = newTabs.indexOf(targetTabId);
      newTabs.splice(insertIdx, 0, srcTabId);
    } else {
      newTabs.push(srcTabId);
    }
  }

  const updatedTarget: LayoutLeaf = {
    ...targetLeaf,
    tabs: newTabs,
    activeTab: srcTabId,
  };
  return {
    ...afterRemove,
    root: replaceNode(afterRemove.root, targetLeafId, updatedTarget),
  };
}

/**
 * 应用拖拽结果：根据拖拽源与 drop zone 计算新树。
 *
 * 纯函数，无副作用 — store 的 commitDrop 仅负责推历史 + 清理拖拽状态，
 * 实际结构变更由本函数完成，便于单元测试。
 *
 * @returns 新树；若无可变更（同 leaf 拖拽、目标不存在等）返回原 tree
 */
export function applyDrop(
  tree: LayoutTree,
  source: TreeDragSource,
  zone: DropZone
): LayoutTree {
  const {
    type: srcType,
    leafId: srcLeafId,
    tabId: srcTabId,
    panelId: srcPanelId,
  } = source;
  const { type: zoneType, targetLeafId } = zone;

  // 多 chat 分屏：允许 chat→chat split。
  // 仅拒绝「同 session 再拆一份」：目标 leaf 已绑定同一 sessionId（若可判定）。
  if (
    zoneType !== 'merge-tab' &&
    isPrimaryPanel(srcPanelId) &&
    (zoneType === 'split-left' ||
      zoneType === 'split-right' ||
      zoneType === 'split-top' ||
      zoneType === 'split-bottom')
  ) {
    const sameSessionTarget = findNodeById(tree.root, targetLeafId);
    if (
      sameSessionTarget &&
      isLeaf(sameSessionTarget) &&
      isPrimaryPanel(sameSessionTarget.panelId) &&
      sameSessionTarget.sessionId &&
      // top-bar session drag 用 sessionId 作为 leafId/tabId
      (srcLeafId === sameSessionTarget.sessionId ||
        srcTabId === sameSessionTarget.sessionId)
    ) {
      return tree;
    }
  }

  // 跨域防护：对话域（Chat）只能与对话域拖拽，功能区只能与功能区拖拽。
  //
  // 同 leaf 操作（srcLeafId === targetLeafId）始终放行：
  // - 该路径仅出现在 tab 拖拽到自身 leaf（merge-tab 同 leaf 重排）
  // - tab 已在该 leaf 中，无跨域问题可言
  const targetNode = findNodeById(tree.root, targetLeafId);
  if (
    targetNode &&
    isLeaf(targetNode) &&
    srcLeafId !== targetLeafId &&
    isPrimaryPanel(srcPanelId) !== isPrimaryPanel(targetNode.panelId)
  ) {
    return tree;
  }

  // Conversation Unit 作用域：tool 源带 ownerSessionId 时不得跨 session。
  const srcNodeForScope = findNodeById(tree.root, srcLeafId);
  const srcOwnerSessionId =
    srcNodeForScope && isLeaf(srcNodeForScope)
      ? srcNodeForScope.sessionId
      : undefined;
  if (
    targetNode &&
    isLeaf(targetNode) &&
    srcLeafId !== targetLeafId &&
    !isUnitScopedDropAllowed(
      srcPanelId,
      srcOwnerSessionId,
      targetNode.panelId,
      targetNode.sessionId
    )
  ) {
    return tree;
  }

  // 同 leaf 且 leaf 拖拽：无操作
  if (srcLeafId === targetLeafId && srcType === 'leaf') return tree;
  // 同 leaf 且 tab 拖拽：若只有一个 tab，无法拆分自身
  if (srcLeafId === targetLeafId && srcType === 'tab' && zoneType !== 'merge-tab') {
    const srcNode = findNodeById(tree.root, srcLeafId);
    if (srcNode && isLeaf(srcNode) && srcNode.tabs.length <= 1) {
      return tree;
    }
  }

  const direction = dropZoneToDirection(zoneType);

  if (direction !== null) {
    // ── split 路径 ──────────────────────────────────────────
    if (srcType === 'leaf') {
      // leaf 拖拽到 split：移动整个 leaf
      return moveLeaf(tree, srcLeafId, targetLeafId, direction);
    }
    // tab 拖拽到 split：从源 leaf 移除 tab，在 target 旁边 split 出新 leaf
    // 新 leaf 继承源 unit 的 ownerSessionId（tool 拆分不得丢 session 归属）
    const ownerForNewLeaf =
      srcOwnerSessionId ??
      (targetNode && isLeaf(targetNode) ? targetNode.sessionId : undefined);
    const afterRemove = removeTabFromLeaf(tree, srcLeafId, srcTabId);
    const targetStillExists = findNodeById(afterRemove.root, targetLeafId);
    if (!targetStillExists) return afterRemove;

    const splitDir: SplitDirection =
      direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
    const position: 'before' | 'after' =
      direction === 'left' || direction === 'top' ? 'before' : 'after';
    return splitLeaf(
      afterRemove,
      targetLeafId,
      splitDir,
      srcPanelId,
      position,
      0.5,
      ownerForNewLeaf
    );
  }

  // ── merge-tab 路径 ──────────────────────────────────────────
  if (srcType === 'leaf') {
    // leaf 拖拽到 merge：将源 leaf 所有 tabs 转移到 target，然后移除源 leaf
    return mergeLeafInto(tree, srcLeafId, targetLeafId);
  }

  // tab 拖拽到 merge：将 tab 从源 leaf 移到 target leaf（支持指定 targetTabId 插入/重排）
  return mergeTabIntoLeaf(tree, srcLeafId, srcTabId, targetLeafId, zone.targetTabId);
}

// ── 迁移 ──────────────────────────────────────────────────────────

interface LegacyColumn {
  id: string;
  widthRatio: number;
  groups: Array<{
    id: string;
    heightRatio: number;
    activeCardId: string;
    cards: Array<{ id: string; title: string }>;
  }>;
}

/**
 * 从旧 columns/groups 模型迁移到二叉树。
 *
 * 策略：columns 从左到右依次水平分割，groups 从上到下垂直分割。
 *
 * splitRatio 计算（系统性修复）：
 * 正确公式（与 column 逻辑对齐）：
 *   splitRatio_i = h_i / sum(h_i..h_{N-1})
 * 即"当前 group 高度 / 当前 branch 及其所有后续 group 的总高度"。
 */
export function migrateFromColumns(columns: LegacyColumn[]): LayoutTree {
  if (columns.length === 0) {
    return { root: createLeaf('chat'), version: 2 };
  }

  // 每列转为垂直子树
  const columnNodes: LayoutNode[] = columns.map((col) => {
    if (col.groups.length === 0) {
      return createLeaf('chat');
    }
    if (col.groups.length === 1) {
      const g = col.groups[0]!;
      return createLeaf(
        g.activeCardId || g.cards[0]?.id || 'chat',
        g.cards.map((c) => c.id),
        g.activeCardId || g.cards[0]?.id
      );
    }

    // 多 group：自底向上构建垂直二叉树
    const groups = col.groups;
    let node: LayoutNode = groupToLeaf(groups[groups.length - 1]!);
    let remainingHeight = groups[groups.length - 1]!.heightRatio;
    for (let i = groups.length - 2; i >= 0; i--) {
      const g = groups[i]!;
      remainingHeight += g.heightRatio;
      const ratio = remainingHeight > 0 ? g.heightRatio / remainingHeight : 0.5;
      node = createBranch('vertical', groupToLeaf(g), node, ratio);
    }
    return node;
  });

  // 列从左到右水平分割（自底向上，与 group 逻辑同构）
  let root = columnNodes[columnNodes.length - 1]!;
  let remainingWidth = columns[columnNodes.length - 1]!.widthRatio;
  for (let i = columnNodes.length - 2; i >= 0; i--) {
    const col = columns[i]!;
    remainingWidth += col.widthRatio;
    const ratio = remainingWidth > 0 ? col.widthRatio / remainingWidth : 0.5;
    root = createBranch('horizontal', columnNodes[i]!, root, ratio);
  }

  return { root, version: 2 };
}

function groupToLeaf(group: LegacyColumn['groups'][number]): LayoutLeaf {
  return createLeaf(
    group.activeCardId || group.cards[0]?.id || 'chat',
    group.cards.map((c) => c.id),
    group.activeCardId || group.cards[0]?.id
  );
}
