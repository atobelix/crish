/**
 * layoutTreeStore 类型契约（Store State / Actions / 联合类型）。
 *
 * 从 layoutTreeStore.ts 拆出（T4-11 基线清零）：hub 保留 re-export，
 * 消费方 import 路径不变。
 */

import type {
  LayoutTree,
  SplitDirection,
  DropDirection,
  TreeDragSource,
} from './types';
import type { DropZone } from './dropDetection';

export interface LayoutTreeStoreState {
  /** 当前布局树 */
  tree: LayoutTree;
  /** 当前激活（聚焦）的 leaf id */
  activeLeafId: string | null;
  /** 拖拽源（null = 未拖拽） */
  draggedSource: TreeDragSource | null;
  /** 当前检测到的 drop zone */
  activeDropZone: DropZone | null;
  /** 历史栈：过去的 tree 快照（undo 用） */
  past: LayoutTree[];
  /** 历史栈：未来的 tree 快照（redo 用） */
  future: LayoutTree[];
  /** 右侧面板（功能区）是否折叠 */
  toolColumnCollapsed: boolean;
}

export interface LayoutTreeStoreActions {
  // ── 结构操作（推历史） ──────────────────────────────────────
  /** 替换整棵树（反序列化/迁移） */
  setTree: (tree: LayoutTree) => void;
  /** 重置为单面板 */
  resetTree: (panelId?: string) => void;
  /** 分割叶子 */
  splitLeaf: (
    leafId: string,
    direction: SplitDirection,
    newPanelId: string,
    position?: 'before' | 'after',
    splitRatio?: number
  ) => void;
  /** 合并分支 */
  mergeBranch: (branchId: string, keepIndex?: 0 | 1) => void;
  /** 移动叶子 */
  moveLeaf: (
    sourceId: string,
    targetId: string,
    direction: DropDirection
  ) => void;
  /** 调整分割比例（commit=true 推历史，false 不推用于拖拽手势） */
  resizeBranch: (branchId: string, ratio: number, commit?: boolean) => void;
  /** 向叶子添加 tab */
  addTabToLeaf: (leafId: string, tabId: string) => void;
  /** 从叶子移除 tab */
  removeTabFromLeaf: (leafId: string, tabId: string) => void;
  /** 绑定 chat leaf → sessionId（多 chat 分屏；不推历史） */
  setLeafSessionId: (
    leafId: string,
    sessionId: string | undefined
  ) => void;
  /**
   * 同时更新 tree + toolColumnCollapsed + activeLeafId（推历史）。
   * 用于 dock 展开/折叠等需要原子性更新多个字段的场景。
   */
  setTreeWithDock: (
    tree: LayoutTree,
    toolColumnCollapsed: boolean,
    activeLeafId?: string | null
  ) => void;

  // ── 焦点操作（不推历史） ────────────────────────────────────
  /** 设置激活 leaf */
  setActiveLeaf: (leafId: string | null) => void;
  /** 设置激活 tab */
  setActiveTab: (leafId: string, tabId: string) => void;
  /** 折叠/展开右侧面板（功能区） */
  toggleToolColumnCollapsed: () => void;
  /** 显式设置功能区折叠（Adapter / RightToolDock 用） */
  setToolColumnCollapsed: (collapsed: boolean) => void;

  // ── 拖拽状态（不推历史） ────────────────────────────────────
  /** 设置拖拽源（拖拽开始时调用） */
  setDraggedSource: (source: TreeDragSource | null) => void;
  /** 设置当前 drop zone（拖拽移动时调用） */
  setActiveDropZone: (zone: DropZone | null) => void;
  /** 提交拖拽：调用 applyDrop 计算变更，推历史，清理拖拽状态 */
  commitDrop: () => void;
  /** 取消拖拽：清空拖拽状态，不变更结构 */
  cancelDrag: () => void;

  // ── 历史操作 ──────────────────────────────────────────────
  /** 手势前置快照:在连续操作（如 resize 拖拽）开始前调用一次 */
  pushHistory: () => void;
  /** 撤销 */
  undo: () => void;
  /** 重做 */
  redo: () => void;
  /** 是否可撤销 */
  canUndo: () => boolean;
  /** 是否可重做 */
  canRedo: () => boolean;
}

export type LayoutTreeStore = LayoutTreeStoreState & LayoutTreeStoreActions;
