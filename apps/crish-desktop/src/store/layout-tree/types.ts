/**
 * 二叉树布局模型 — 类型定义。
 *
 * 参考 VS Code SerializableGrid：每个节点要么是 leaf（面板），
 * 要么是 branch（严格二叉分割）。支持任意深度的水平/垂直嵌套。
 */

/** 叶子节点：一个面板（可含多个 tab） */
export interface LayoutLeaf {
  type: 'leaf';
  id: string;
  /** 面板类型标识：'chat' | 'diff' | 'terminal' | 'files' | 'agent' | ... */
  panelId: string;
  /** 该面板内的 tab id 列表 */
  tabs: string[];
  /** 当前激活的 tab id */
  activeTab: string;
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
  version: number;
}

/** 渲染用平坦面板描述（flattenToRenderList 输出） */
export interface FlatPanel {
  leafId: string;
  panelId: string;
  tabs: string[];
  activeTab: string;
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
  /** 源 tab id（leaf 拖拽时等于 leafId，tab 拖拽时为具体 tab） */
  tabId: string;
  /** 源面板类型（用于 ghost 标题、applyDrop 决策） */
  panelId: string;
}

/** 判定指定 panelId / tabId 是否属于对话域 */
export function isChatDomain(panelId: string): boolean {
  return panelId === 'chat';
}

/** 判定两个 panel 是否属于同域（对话域只能与对话域拖拽，功能区只能与功能区拖拽） */
export function isSameDomain(panelId1: string, panelId2: string): boolean {
  return isChatDomain(panelId1) === isChatDomain(panelId2);
}

// ── 业务常量（单一来源，禁止在其它文件硬编码） ──────────────────────

/** splitRatio 最小值（branch 第一个 child 占比下限） */
export const MIN_SPLIT_RATIO = 0.1;
/** splitRatio 最大值（branch 第一个 child 占比上限） */
export const MAX_SPLIT_RATIO = 0.9;

/** 将 ratio 钳制到 [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] */
export function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

// ── 工厂函数 ──────────────────────────────────────────────────────────

let idCounter = 0;

/** 生成唯一节点 id */
export function generateNodeId(prefix = 'node'): string {
  return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

/**
 * 创建叶子节点。
 *
 * 不变量归一化（系统性防御 H4）：
 * 1. tabs 永远非空 — undefined 或 [] 都回退到 [panelId]。
 *    旧实现 `tabs ?? [panelId]` 仅处理 undefined，对 `tabs=[]` 放行，
 *    导致 migrateFromColumns 处理空 cards 旧 group 时产生 `tabs=[]` leaf。
 * 2. activeTab 必在 tabs 中 — 否则回退到 tabList[0]。
 *    防止 activeTab 指向已被移除的 tab（如旧数据残留）。
 *
 * 在工厂函数层归一化是单一可信源：所有调用方（migrateFromColumns、
 * splitLeaf、mergeLeafInto 等）自动受益，无需在各调用点重复防御。
 */
export function createLeaf(
  panelId: string,
  tabs?: string[],
  activeTab?: string
): LayoutLeaf {
  const tabList = tabs && tabs.length > 0 ? tabs : [panelId];
  const activeTabResolved =
    activeTab && tabList.includes(activeTab) ? activeTab : tabList[0]!;
  return {
    type: 'leaf',
    id: generateNodeId('leaf'),
    panelId,
    tabs: tabList,
    activeTab: activeTabResolved,
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

/** 创建单面板默认布局 */
export function createDefaultTree(panelId = 'chat'): LayoutTree {
  return {
    root: createLeaf(panelId),
    version: 2,
  };
}

// ── 类型守卫 ──────────────────────────────────────────────────────────

export function isLeaf(node: LayoutNode): node is LayoutLeaf {
  return node.type === 'leaf';
}

export function isBranch(node: LayoutNode): node is LayoutBranch {
  return node.type === 'branch';
}
