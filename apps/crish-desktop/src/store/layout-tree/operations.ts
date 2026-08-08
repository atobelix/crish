/**
 * 二叉树布局操作 — 纯函数集合。
 *
 * 所有操作返回新树（不可变），不修改输入。
 * 每个函数都是确定性的，便于单元测试和 undo/redo。
 */

import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  FlatPanel,
  FlatBranch,
  SplitDirection,
  DropDirection,
  TreeDragSource,
} from './types';
import {
  createBranch,
  createLeaf,
  isBranch,
  isLeaf,
  clampSplitRatio,
  isSameDomain,
  isChatDomain,
} from './types';
import type { DropZone } from './dropDetection';
import { isUnitScopedDropAllowed } from './dropDetection';

// ── 查询操作 ──────────────────────────────────────────────────────────

/** 按 id 查找节点 */
export function findNodeById(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (isBranch(root)) {
    return (
      findNodeById(root.children[0], id) ?? findNodeById(root.children[1], id)
    );
  }
  return null;
}

/** 查找节点的父 branch 及其在 children 中的索引 */
export function findParent(
  root: LayoutNode,
  id: string
): { parent: LayoutBranch; index: 0 | 1 } | null {
  if (isLeaf(root)) return null;
  if (root.children[0].id === id) return { parent: root, index: 0 };
  if (root.children[1].id === id) return { parent: root, index: 1 };
  return findParent(root.children[0], id) ?? findParent(root.children[1], id);
}

/** 收集所有叶子节点 */
export function collectLeaves(root: LayoutNode): LayoutLeaf[] {
  if (isLeaf(root)) return [root];
  return [
    ...collectLeaves(root.children[0]),
    ...collectLeaves(root.children[1]),
  ];
}

// ── 不可变替换 ──────────────────────────────────────────────────────────

/** 深度克隆并替换指定 id 的节点 */
function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = replaceNode(first, targetId, replacement);
  const newSecond = replaceNode(second, targetId, replacement);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}

/** 深度克隆并移除指定 id 的 branch（用其某个 child 替代） */
function removeBranch(
  root: LayoutNode,
  branchId: string,
  keepIndex: 0 | 1
): LayoutNode {
  if (root.id === branchId && isBranch(root)) {
    return root.children[keepIndex];
  }
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = removeBranch(first, branchId, keepIndex);
  const newSecond = removeBranch(second, branchId, keepIndex);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}

// ── 结构操作 ──────────────────────────────────────────────────────────

/**
 * 分割叶子：将目标 leaf 替换为一个 branch，
 * 原 leaf 和新 leaf 作为 branch 的两个 child。
 *
 * @param direction 'horizontal' → 新 leaf 在右/下；'vertical' → 新 leaf 在下
 * @param position 'before' | 'after' — 新 leaf 放在原 leaf 的前面还是后面
 */
export function splitLeaf(
  tree: LayoutTree,
  leafId: string,
  direction: SplitDirection,
  newPanelId: string,
  position: 'before' | 'after' = 'after',
  splitRatio = 0.5,
  /** 新 leaf 绑定的 sessionId（tool 叶 = ownerSessionId；tab→split 时透传源 unit） */
  newLeafSessionId?: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  const newLeaf = createLeaf(
    newPanelId,
    undefined,
    undefined,
    newLeafSessionId
  );
  const [first, second] =
    position === 'after' ? [target, newLeaf] : [newLeaf, target];

  const branch = createBranch(direction, first, second, splitRatio);
  return { ...tree, root: replaceNode(tree.root, leafId, branch) };
}

/**
 * 合并分支：删除目标 branch，保留指定 child。
 * 如果合并后父 branch 只剩一个 child，自动提升（flatten）。
 */
export function mergeBranch(
  tree: LayoutTree,
  branchId: string,
  keepIndex: 0 | 1 = 0
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const newRoot = removeBranch(tree.root, branchId, keepIndex);
  return { ...tree, root: newRoot };
}

/**
 * 移动叶子：将 source leaf 从原位置移除，
 * 在 target leaf 旁边按 direction 创建新分割。
 */
export function moveLeaf(
  tree: LayoutTree,
  sourceId: string,
  targetId: string,
  direction: DropDirection
): LayoutTree {
  return moveNode(tree, sourceId, targetId, direction);
}

/**
 * 判断 nodeId 是否等于 ancestorId，或位于 ancestor 子树内。
 */
function isNodeUnder(root: LayoutNode, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true;
  const ancestor = findNodeById(root, ancestorId);
  if (!ancestor || isLeaf(ancestor)) return false;
  return findNodeById(ancestor, nodeId) !== null;
}

/**
 * 移动任意节点（leaf 或 Conversation Unit branch）：
 * 从原位置摘下，插到 target 节点旁按 direction 分割。
 *
 * 会话分屏必须用 unit root（H(chat|tools)），不能只移 chat leaf，
 * 否则 tool 子树会变成与多对话并列的「孤儿功能区」。
 */
export function moveNode(
  tree: LayoutTree,
  sourceId: string,
  targetId: string,
  direction: DropDirection
): LayoutTree {
  if (sourceId === targetId) return tree;

  const source = findNodeById(tree.root, sourceId);
  const target = findNodeById(tree.root, targetId);
  if (!source || !target) return tree;

  // 禁止把父节点塞进自己的子孙（会环）
  if (isNodeUnder(tree.root, sourceId, targetId)) return tree;

  // 1. 从原位置移除 source（leaf 或 branch）
  const treeWithout = removeNodeFromTree(tree, sourceId);
  if (!treeWithout) return tree;

  // 2. 在 target 旁边插入 source
  const splitDir: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    direction === 'left' || direction === 'top' ? 'before' : 'after';

  const targetInNew = findNodeById(treeWithout.root, targetId);
  if (!targetInNew) return tree;

  const [first, second] =
    position === 'after' ? [targetInNew, source] : [source, targetInNew];

  const branch = createBranch(splitDir, first, second, 0.5);
  return {
    ...treeWithout,
    root: replaceNode(treeWithout.root, targetId, branch),
  };
}

/**
 * 在 anchor 节点旁插入新 leaf（或已有节点旁挂新 leaf），用于「首次放入会话」分屏。
 * anchor 应为 Conversation Unit root（chat-only 或 H(chat|tools)），
 * 禁止直接 split  unit 内的 chat leaf（会把 tools 变成全局右栏）。
 */
export function insertLeafBesideNode(
  tree: LayoutTree,
  anchorNodeId: string,
  direction: DropDirection,
  newPanelId: string,
  newLeafSessionId?: string,
  splitRatio = 0.5
): LayoutTree {
  const anchor = findNodeById(tree.root, anchorNodeId);
  if (!anchor) return tree;

  const splitDir: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    direction === 'left' || direction === 'top' ? 'before' : 'after';

  const newLeaf = createLeaf(
    newPanelId,
    undefined,
    undefined,
    newLeafSessionId
  );
  const [first, second] =
    position === 'after' ? [anchor, newLeaf] : [newLeaf, anchor];
  const branch = createBranch(splitDir, first, second, splitRatio);
  return {
    ...tree,
    root: replaceNode(tree.root, anchorNodeId, branch),
  };
}

/**
 * 从树中移除任意节点（leaf 或 branch），用兄弟节点替代其父 branch。
 * 若目标就是 root，返回 null（至少保留一棵子树由调用方兜底）。
 */
export function removeNodeFromTree(
  tree: LayoutTree,
  nodeId: string
): LayoutTree | null {
  const { root } = tree;

  // 根节点无法“移除”——调用方应自行替换整树
  if (root.id === nodeId) return null;

  const parentInfo = findParent(root, nodeId);
  if (!parentInfo) return null;

  const { parent, index } = parentInfo;
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;

  // 用兄弟节点替代父 branch
  const newRoot = removeBranch(root, parent.id, keepIndex);
  return { ...tree, root: newRoot };
}

/** 从树中移除一个 leaf，自动合并其父 branch */
export function removeLeafFromTree(
  tree: LayoutTree,
  leafId: string
): LayoutTree | null {
  return removeNodeFromTree(tree, leafId);
}

/**
 * 将 srcLeaf 的所有 tabs 合并到 targetLeaf，然后移除 srcLeaf。
 *
 * 单次树重建（O(tree size)），替代旧实现的 O(n × tree size) 循环：
 *   for (tab of srcLeaf.tabs) addTabToLeaf(...)
 *   while (...) removeTabFromLeaf(...)
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
 * 将单个 tab 从 srcLeaf 移到 targetLeaf（drag merge-tab 路径）。
 *
 * 与 addTabToLeaf 的差异：
 * - addTabToLeaf 是通用 API：tab 已存在时返回原 tree（不切换 activeTab）
 * - mergeTabIntoLeaf 是拖拽专用：tab 已存在时仍切换 activeTab 到 srcTabId
 *   （用户拖入即表示"我要看这个"，应切换激活）
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
 *
 * 单次树重建（removeTabFromLeaf）+ 单次 replaceNode（合并），O(tree size)。
 */
/** 重排/移动叶子内部的 tab 顺序 */
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
  //      旧实现 filter+push 改变顺序，导致 ['diff','files'] 变成 ['files','diff']，
  //      违反"已存在不重复添加"的语义（去重 ≠ 重排）。
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

// ── Tab 操作 ──────────────────────────────────────────────────────────

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

/** 向叶子添加 tab */
export function addTabToLeaf(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (target.tabs.includes(tabId)) return tree;

  // 域隔离：对话域（chat）与功能区不能混在同一个 leaf 里。
  // 这样能保证「对话只能在对话区域内相互排版，功能区在功能区域内排版」。
  if (isChatDomain(tabId) !== isChatDomain(target.panelId)) return tree;

  const updated: LayoutLeaf = {
    ...target,
    tabs: [...target.tabs, tabId],
    activeTab: tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/** 从叶子移除 tab（如果只剩一个 tab 则移除整个 leaf） */
export function removeTabFromLeaf(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.includes(tabId)) return tree;

  const newTabs = target.tabs.filter((t) => t !== tabId);
  if (newTabs.length === 0) {
    // 移除整个 leaf
    const result = removeLeafFromTree(tree, leafId);
    return result ?? tree;
  }

  const newActive =
    target.activeTab === tabId
      ? newTabs[newTabs.length - 1]!
      : target.activeTab;

  const updated: LayoutLeaf = {
    ...target,
    tabs: newTabs,
    activeTab: newActive,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

// ── leaf 会话绑定 ─────────────────────────────────────────────────────

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
    isChatDomain(srcPanelId) &&
    (zoneType === 'split-left' ||
      zoneType === 'split-right' ||
      zoneType === 'split-top' ||
      zoneType === 'split-bottom')
  ) {
    const sameSessionTarget = findNodeById(tree.root, targetLeafId);
    if (
      sameSessionTarget &&
      isLeaf(sameSessionTarget) &&
      isChatDomain(sameSessionTarget.panelId) &&
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
  // - 若强行校验 srcTabId 的域 vs leaf.panelId，会误伤 leaf 含混合域 tab
  //   的边界场景（理论上不应存在，但测试可能构造）
  const targetNode = findNodeById(tree.root, targetLeafId);
  if (
    targetNode &&
    isLeaf(targetNode) &&
    srcLeafId !== targetLeafId &&
    !isSameDomain(srcPanelId, targetNode.panelId)
  ) {
    return tree;
  }

  // Conversation Unit 作用域：tool 源带 ownerSessionId 时不得跨 session。
  // 源 leaf 的 sessionId 即 tool 的 ownerSessionId（adapterShape.makeToolLeaf）。
  // top-bar session drag 的 leafId 不是树内 id → find 失败 → srcOwner 为空 → 本守卫跳过。
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
  // 使用 mergeTabIntoLeaf 而非 addTabToLeaf：拖拽场景下即使 tab 已存在也应切换 activeTab
  return mergeTabIntoLeaf(tree, srcLeafId, srcTabId, targetLeafId, zone.targetTabId);
}

// ── 渲染辅助 ──────────────────────────────────────────────────────────

type Rect = { x: number; y: number; width: number; height: number };

/** 可折叠的域：对话域（chat）或功能区（tool） */
type CollapsedDomain = 'chat' | 'tool';

/** 判断单个 leaf 是否属于被折叠的域 */
function leafMatchesCollapsedDomain(
  leaf: LayoutLeaf,
  collapsedDomain?: CollapsedDomain
): boolean {
  if (!collapsedDomain) return false;
  const isTool = !isChatDomain(leaf.panelId);
  return collapsedDomain === 'tool' ? isTool : !isTool;
}

/**
 * 判断整棵子树是否完全处于被折叠的域。
 * 用于在 flatten 时把该子树整体压缩为 0 面积，把空间全交给另一侧。
 */
function isCollapsedSubtree(
  node: LayoutNode,
  collapsedDomain?: CollapsedDomain
): boolean {
  if (!collapsedDomain) return false;
  if (isLeaf(node)) {
    return leafMatchesCollapsedDomain(node, collapsedDomain);
  }
  return (
    isCollapsedSubtree(node.children[0], collapsedDomain) &&
    isCollapsedSubtree(node.children[1], collapsedDomain)
  );
}

/**
 * 将树展平为渲染列表，同时计算 leaf 与 branch 的百分比 rect。
 *
 * 单次递归遍历，输出两个数组：
 * - leaves：每个 leaf 的 rect（用于绝对定位 leaf 面板）
 * - branches：每个 branch 的 rect（用于 sash 定位 + resize 计算）
 *
 * branch rect 的意义：branch 在 canvas 中的绝对占比（0-1）。
 * 例：根 branch 占满 canvas（rect={0,0,1,1}）；
 * 嵌套在左半区的子 branch rect={0,0,0.5,1}。
 * sash 位置 = branch.rect 的对应边 + splitRatio × branch.rect 的对应维度。
 *
 * 折叠域（collapsedDomain）：
 * - 当传入 'tool' 时，所有功能 leaf/branch 的 rect 压缩为 0，对话域扩展至全画布。
 * - 当传入 'chat' 时，对话域压缩为 0，功能域扩展至全画布。
 * - 该能力服务于右侧面板折叠/展开按钮与顶部标签行宽度联动。
 */
export function flattenTree(
  root: LayoutNode,
  options?: { collapsedDomain?: CollapsedDomain }
): {
  leaves: FlatPanel[];
  branches: FlatBranch[];
} {
  const leaves: FlatPanel[] = [];
  const branches: FlatBranch[] = [];
  flattenRecursive(
    root,
    { x: 0, y: 0, width: 1, height: 1 },
    leaves,
    branches,
    options?.collapsedDomain
  );
  return { leaves, branches };
}

function flattenRecursive(
  node: LayoutNode,
  rect: Rect,
  leavesOut: FlatPanel[],
  branchesOut: FlatBranch[],
  collapsedDomain?: CollapsedDomain
): void {
  if (isLeaf(node)) {
    leavesOut.push({
      leafId: node.id,
      panelId: node.panelId,
      tabs: node.tabs,
      activeTab: node.activeTab,
      ...(node.sessionId ? { sessionId: node.sessionId } : {}),
      rect: leafMatchesCollapsedDomain(node, collapsedDomain)
        ? { x: rect.x, y: rect.y, width: 0, height: 0 }
        : rect,
    });
    return;
  }

  const { direction, splitRatio, children } = node;

  // 记录 branch rect（用于 sash 定位 + resize 计算）
  branchesOut.push({
    branchId: node.id,
    direction,
    splitRatio,
    rect,
  });

  const firstCollapsed = isCollapsedSubtree(children[0], collapsedDomain);
  const secondCollapsed = isCollapsedSubtree(children[1], collapsedDomain);

  if (direction === 'horizontal') {
    if (firstCollapsed && secondCollapsed) {
      // 整棵分支都在折叠域：子树继续递归，但分配 0 宽度
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: 0, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x, y: rect.y, width: 0, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else if (firstCollapsed) {
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: 0, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else if (secondCollapsed) {
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x + rect.width, y: rect.y, width: 0, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else {
      const firstWidth = rect.width * splitRatio;
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: firstWidth, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        {
          x: rect.x + firstWidth,
          y: rect.y,
          width: rect.width - firstWidth,
          height: rect.height,
        },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    }
  } else {
    if (firstCollapsed && secondCollapsed) {
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: rect.width, height: 0 },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x, y: rect.y, width: rect.width, height: 0 },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else if (firstCollapsed) {
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: rect.width, height: 0 },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else if (secondCollapsed) {
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        { x: rect.x, y: rect.y + rect.height, width: rect.width, height: 0 },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    } else {
      const firstHeight = rect.height * splitRatio;
      flattenRecursive(
        children[0],
        { x: rect.x, y: rect.y, width: rect.width, height: firstHeight },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
      flattenRecursive(
        children[1],
        {
          x: rect.x,
          y: rect.y + firstHeight,
          width: rect.width,
          height: rect.height - firstHeight,
        },
        leavesOut,
        branchesOut,
        collapsedDomain
      );
    }
  }
}

// ── 树规范化 ────────────────────────────────────────────────────────

/**
 * 清理叶子中的跨域 tab，保证「对话域」与「功能区」不混在同一 leaf。
 *
 * 规则：
 * 1. 以 leaf.panelId 判定 leaf 所属域（chat / tool）。
 * 2. 过滤掉与 leaf 域不符的 tab。
 * 3. 若过滤后 tabs 为空，回退到 [panelId]。
 * 4. 修正 activeTab，使其一定在 tabs 中。
 * 5. 若 leaf.panelId 与剩余 tabs 的域不一致（如 panelId='chat' 但只剩 tool tab），
  *    把 panelId 也修正为第一个剩余 tab 的 id。
  *
  * 该函数在 store 从 localStorage 恢复时调用，避免旧数据/迁移产生的混合 leaf
  * 继续污染 UI。
  */

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
 * 旧实现 group 用 `g.heightRatio / (g.heightRatio + (1 - g.heightRatio))`，
 * 分母恒为 1 → ratio = g.heightRatio。对 3+ group 树致命错误：
 * 嵌套 branch 的 ratio 是"当前 branch 内部"的分割比，不是"全局占比"。
 *
 * 正确公式（与 column 逻辑对齐）：
 *   splitRatio_i = h_i / sum(h_i..h_{N-1})
 * 即"当前 group 高度 / 当前 branch 及其所有后续 group 的总高度"。
 *
 * 列循环同样从 O(N²) slice+reduce 优化为 O(N) 右向累加。
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
    // remainingHeight 始终维护"当前 node 已代表的 groups 高度之和"
    const groups = col.groups;
    let node: LayoutNode = groupToLeaf(groups[groups.length - 1]!);
    let remainingHeight = groups[groups.length - 1]!.heightRatio;
    for (let i = groups.length - 2; i >= 0; i--) {
      const g = groups[i]!;
      remainingHeight += g.heightRatio;
      // splitRatio = 当前 group 高度 / (当前 + 已构建子树) 总高度
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

