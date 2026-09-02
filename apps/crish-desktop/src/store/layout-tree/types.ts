/**
 * 二叉树布局模型 — 类型定义。
 *
 * 树上只有 chat 叶；会话身份在 SessionTab.sessionId，不在叶字段。
 * 参考 VS Code SerializableGrid：每个节点要么是 leaf，要么是严格二叉 branch。
 */

import {
  normalizeSessionTab,
  isRealSessionId,
  activeSessionIdOf,
  createDefaultDock,
  type SessionTab,
  type RightToolDockState,
} from './sessionTabModel';

export type { SessionTab, RightToolDockState } from './sessionTabModel';

/** 本战役起 LayoutTree.version。v2 = 旧 leaf.sessionId + tabs: string[] + 可含 tool 叶 */
export const LAYOUT_TREE_VERSION = 3 as const;

/** 叶子节点：一片 chat 窗格，自己拥有会话标签 */
export interface LayoutLeaf {
  type: 'leaf';
  id: string;
  /** 树上只有 chat 叶（I5） */
  panelId: 'chat';
  /** 权威。只放已发送成功的真会话；草稿不进此数组 */
  tabs: SessionTab[];
  /**
   * 当前选中的真会话 tab。空字符串 = 本叶处于未提交的新对话界面
   * （条带无选中、不创建标签）。非空时必须属于 tabs[].tabId。
   */
  activeTabId: string;
  /**
   * 未提交新对话时本叶的坞。有活动 tab 时以 tab.dock 为准。
   */
  dock?: RightToolDockState;
}

/** 分支节点：严格二叉分割 */
export interface LayoutBranch {
  type: 'branch';
  id: string;
  /** 分割方向：horizontal = 左右排列，vertical = 上下排列 */
  direction: 'horizontal' | 'vertical';
  /** 严格两个子节点 */
  children: [LayoutNode, LayoutNode];
  /** 第一个 child 占比（0-1），第二个为 1 - splitRatio */
  splitRatio: number;
}

/** 布局节点联合类型 */
export type LayoutNode = LayoutLeaf | LayoutBranch;

/** 完整布局树 */
export interface LayoutTree {
  root: LayoutNode;
  version: typeof LAYOUT_TREE_VERSION | number;
}

/** 渲染用平坦面板描述（flattenToRenderList 输出） */
export interface FlatPanel {
  leafId: string;
  panelId: 'chat';
  tabs: SessionTab[];
  activeTabId: string;
  dock: RightToolDockState;
  /** 派生自活动 tab，禁止当写源 */
  sessionId: string;
  /** 相对于整个工作区的 rect（0-1 百分比） */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * 渲染用平坦分支描述（flattenBranches 输出）。
 *
 * 与 FlatPanel 对应，但面向 branch 节点 — 用于 sash 定位与 resize 计算。
 * rect 是 branch 在 canvas 中的绝对占比（0-1），与 leaf rect 同坐标系。
 */
export interface FlatBranch {
  branchId: string;
  direction: 'horizontal' | 'vertical';
  splitRatio: number;
  /** branch 在 canvas 中的 rect（0-1 百分比，与 FlatPanel.rect 同坐标系） */
  rect: { x: number; y: number; width: number; height: number };
}

/** 分割方向 */
export type SplitDirection = 'horizontal' | 'vertical';

/** 拖拽放置方向 */
export type DropDirection = 'left' | 'right' | 'top' | 'bottom';

/**
 * 拖拽源描述（leaf 拖拽或 tab 拖拽）。
 *
 * 纯数据类型，放在 types.ts 以便 operations.ts 的 applyDrop 引用，
 * 避免 operations → store 的循环依赖。
 */
export interface TreeDragSource {
  /** 拖拽类型：整个 leaf 还是单个 tab */
  type: 'leaf' | 'tab';
  /** 源 leaf id */
  leafId: string;
  /** SessionTab.tabId（不再是 panelId 字符串） */
  tabId: string;
  panelId: 'chat';
}

// ── 业务常量（单一来源，禁止在其它文件硬编码） ──────────────────────

/** splitRatio 最小值（branch 第一个 child 占比下限；参考手感 [0.12, 0.88]） */
export const MIN_SPLIT_RATIO = 0.12;
/** splitRatio 最大值（branch 第一个 child 占比上限；参考手感 [0.12, 0.88]） */
export const MAX_SPLIT_RATIO = 0.88;

/** 将 ratio 钳制到 [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] */
export function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

// ── 工厂函数 ──────────────────────────────────────────────────────────

let idCounter = 0;

/** 生成唯一节点 id（splitTab 新叶与 createLeaf 同一生成器） */
export function generateNodeId(prefix = 'node'): string {
  return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

export interface CreateLeafInput {
  tabs?: SessionTab[];
  activeTabId?: string;
  dock?: Partial<RightToolDockState>;
  /** 仅测试夹具；生产走 generateNodeId */
  id?: string;
}

/**
 * 创建 chat 叶子：缺省为空的新对话界面（tabs 空、无选中标签）。
 *
 * 归一化：
 * 1. 草稿 tab 丢弃，只保留真会话
 * 2. 无真会话 → activeTabId 空（新对话界面）
 * 3. 有真会话且 active 命中 → 用它；否则回退 tabs[0]
 * 4. 不再接受 panelId / 叶级 sessionId
 */
export function createLeaf(input?: CreateLeafInput): LayoutLeaf {
  const id = input?.id ?? generateNodeId('leaf');
  const tabs = (input?.tabs ?? [])
    .map((t) => normalizeSessionTab(t))
    .filter((t) => isRealSessionId(t.sessionId));
  const activeTabId =
    input?.activeTabId && tabs.some((t) => t.tabId === input.activeTabId)
      ? input.activeTabId
      : tabs[0]?.tabId ?? '';
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs,
    activeTabId,
    dock: createDefaultDock(input?.dock),
  };
}

/** 创建分支节点 */
export function createBranch(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  splitRatio = 0.5
): LayoutBranch {
  return {
    type: 'branch',
    id: generateNodeId('branch'),
    direction,
    children: [first, second],
    splitRatio: clampSplitRatio(splitRatio),
  };
}

/** 创建单 chat 叶、未提交新对话界面的默认布局 */
export function createDefaultTree(): LayoutTree {
  return {
    root: createLeaf(),
    version: LAYOUT_TREE_VERSION,
  };
}

/** 根删光兜底：单叶新对话界面（不保留已删根 id，不创建标签） */
export function createFallbackDraftTree(version: number = LAYOUT_TREE_VERSION): LayoutTree {
  return {
    version,
    root: createLeaf(),
  };
}

/** flatten 用：活动 tab 的 sessionId（派生，禁止当写源） */
export function leafActiveSessionId(leaf: LayoutLeaf): string {
  return activeSessionIdOf(leaf);
}

// ── 类型守卫 ──────────────────────────────────────────────────────────

export function isLeaf(node: LayoutNode): node is LayoutLeaf {
  return node.type === 'leaf';
}

export function isBranch(node: LayoutNode): node is LayoutBranch {
  return node.type === 'branch';
}
