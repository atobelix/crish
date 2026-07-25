/**
 * Layout Tree Store — 二叉树布局状态中心。
 *
 * 设计目标：
 * 1. 单一可信源：所有 tree 结构变更通过此 store 流转
 * 2. 纯函数更新：operations.ts 的纯函数返回新树，store 直接赋值（无需 immer）
 * 3. 历史栈：undo/redo（限 50 步，避免内存膨胀）
 * 4. 持久化：localStorage 保存 tree + activeLeafId（不保存 history/drag 状态）
 * 5. 拖拽集中化：commitDrop 在 store 内根据 draggedSource + activeDropZone 计算变更
 *
 * Action 命名约定：
 * - 结构操作（推历史）：splitLeaf / mergeBranch / moveLeaf / resetTree / setTree / commitDrop
 * - 焦点操作（不推历史）：setActiveLeaf / setActiveTab
 * - 拖拽状态（不推历史）：setDraggedSource / setActiveDropZone / cancelDrag
 * - resize：resizeBranch(branchId, ratio, commit=true) — 键盘默认推历史，拖拽传 false
 * - 历史：undo / redo / canUndo / canRedo / pushHistory（手势前置快照）
 *
 * 为何不用 immer：
 * - operations.ts 的纯函数已返回新树（不可变），store 仅需赋值
 * - LayoutNode 是 LayoutLeaf | LayoutBranch 联合类型，immer 的 WritableDraft
 *   在 declaration: true 下无法被 TypeScript 命名（TS4023）
 * - 移除 immer 后类型更简洁，且无运行时开销
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  LayoutTree,
  LayoutLeaf,
  SplitDirection,
  DropDirection,
} from './types';
import { createDefaultTree, isLeaf } from './types';
import {
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTabToLeaf,
  removeTabFromLeaf,
  setLeafActiveTab,
  collectLeaves,
  findNodeById,
  flattenToRenderList,
} from './operations';
import type { FlatPanel } from './types';
import type { DropZone } from './dropDetection';

// ── 常量 ──────────────────────────────────────────────────────────

/** 历史栈最大长度（避免内存膨胀） */
const MAX_HISTORY = 50;
/** localStorage 持久化 key */
const STORAGE_KEY = 'crish-layout-tree-v1';

// ── 类型 ──────────────────────────────────────────────────────────

/** 拖拽源描述（leaf 拖拽或 tab 拖拽） */
export interface TreeDragSource {
  /** 拖拽类型：整个 leaf 还是单个 tab */
  type: 'leaf' | 'tab';
  /** 源 leaf id */
  leafId: string;
  /** 源 tab id（leaf 拖拽时等于 leafId，tab 拖拽时为具体 tab） */
  tabId: string;
  /** 源面板类型（用于 ghost 标题、commitDrop 决策） */
  panelId: string;
  /** pointerdown 时的源 rect（屏幕坐标，用于 ghost 起始位置/动画） */
  originRect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface LayoutTreeStoreState {
  /** 当前布局树 */
  tree: LayoutTree;
  /** 当前激活（聚焦）的 leaf id */
  activeLeafId: string | null;
  /** 拖拽源（null = 未拖拽） */
  draggedSource: TreeDragSource | null;
  /** 当前检测到的 drop zone */
  activeDropZone: DropZone | null;
  /** 渲染用平坦列表（缓存，tree 变化时重算） */
  flatPanels: FlatPanel[];
  /** 历史栈：过去的 tree 快照（undo 用） */
  past: LayoutTree[];
  /** 历史栈：未来的 tree 快照（redo 用） */
  future: LayoutTree[];
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

  // ── 焦点操作（不推历史） ────────────────────────────────────
  /** 设置激活 leaf */
  setActiveLeaf: (leafId: string | null) => void;
  /** 设置激活 tab */
  setActiveTab: (leafId: string, tabId: string) => void;

  // ── 拖拽状态（不推历史） ────────────────────────────────────
  /** 设置拖拽源（拖拽开始时调用） */
  setDraggedSource: (source: TreeDragSource | null) => void;
  /** 设置当前 drop zone（拖拽移动时调用） */
  setActiveDropZone: (zone: DropZone | null) => void;
  /** 提交拖拽：根据 draggedSource + activeDropZone 计算结构变更 */
  commitDrop: () => void;
  /** 取消拖拽：清空拖拽状态，不变更结构 */
  cancelDrag: () => void;

  // ── 历史操作 ──────────────────────────────────────────────
  /** 手势前置快照：在连续操作（如 resize 拖拽）开始前调用一次 */
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

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 重新计算 flatPanels */
function recomputeFlat(tree: LayoutTree): FlatPanel[] {
  return flattenToRenderList(tree.root);
}

/** 找到树中第一个 leaf 的 id（用于初始化 activeLeafId） */
function firstLeafId(tree: LayoutTree): string | null {
  const leaves = collectLeaves(tree.root);
  return leaves[0]?.id ?? null;
}

/** 验证 activeLeafId 是否仍存在于树中，否则返回首个 leaf id */
function resolveActiveLeaf(
  tree: LayoutTree,
  activeLeafId: string | null
): string | null {
  if (activeLeafId && findNodeById(tree.root, activeLeafId))
    return activeLeafId;
  return firstLeafId(tree);
}

/**
 * DropZone.type → DropDirection 映射。
 * 'merge-tab' 单独处理（不进入 moveLeaf 路径）。
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

// ── Store 实现 ────────────────────────────────────────────────────

const initialTree = createDefaultTree('chat');

export const useLayoutTreeStore = create<LayoutTreeStore>()(
  persist(
    (set, get) => ({
      // ── State ──────────────────────────────────────────────
      tree: initialTree,
      activeLeafId: firstLeafId(initialTree),
      draggedSource: null,
      activeDropZone: null,
      flatPanels: recomputeFlat(initialTree),
      past: [],
      future: [],

      // ── 结构操作 ──────────────────────────────────────────

      setTree: (tree) =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
          tree,
          flatPanels: recomputeFlat(tree),
          activeLeafId: resolveActiveLeaf(tree, state.activeLeafId),
        })),

      resetTree: (panelId = 'chat') =>
        set((state) => {
          const newTree = createDefaultTree(panelId);
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: newTree,
            flatPanels: recomputeFlat(newTree),
            activeLeafId: firstLeafId(newTree),
          };
        }),

      splitLeaf: (
        leafId,
        direction,
        newPanelId,
        position = 'after',
        splitRatio = 0.5
      ) =>
        set((state) => {
          const result = splitLeaf(
            state.tree,
            leafId,
            direction,
            newPanelId,
            position,
            splitRatio
          );
          if (result === state.tree) return {};
          // 新 leaf 成为激活 leaf
          const leaves = collectLeaves(result.root);
          const newLeaf = leaves.find((l) => l.panelId === newPanelId);
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            flatPanels: recomputeFlat(result),
            activeLeafId: newLeaf?.id ?? state.activeLeafId,
          };
        }),

      mergeBranch: (branchId, keepIndex = 0) =>
        set((state) => {
          const result = mergeBranch(state.tree, branchId, keepIndex);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            flatPanels: recomputeFlat(result),
            activeLeafId: resolveActiveLeaf(result, state.activeLeafId),
          };
        }),

      moveLeaf: (sourceId, targetId, direction) =>
        set((state) => {
          const result = moveLeaf(state.tree, sourceId, targetId, direction);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            flatPanels: recomputeFlat(result),
          };
        }),

      resizeBranch: (branchId, ratio, commit = true) =>
        set((state) => {
          const result = resizeBranch(state.tree, branchId, ratio);
          if (result === state.tree) return {};
          return {
            // 拖拽手势（commit=false）：不推历史（由 pushHistory 前置处理）
            // 键盘操作（commit=true）：每次推历史
            past: commit
              ? [...state.past, state.tree].slice(-MAX_HISTORY)
              : state.past,
            future: commit ? [] : state.future,
            tree: result,
            flatPanels: recomputeFlat(result),
          };
        }),

      addTabToLeaf: (leafId, tabId) =>
        set((state) => {
          const result = addTabToLeaf(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            flatPanels: recomputeFlat(result),
          };
        }),

      removeTabFromLeaf: (leafId, tabId) =>
        set((state) => {
          const result = removeTabFromLeaf(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            flatPanels: recomputeFlat(result),
            activeLeafId: resolveActiveLeaf(result, state.activeLeafId),
          };
        }),

      // ── 焦点操作（不推历史） ──────────────────────────────

      setActiveLeaf: (leafId) => set({ activeLeafId: leafId }),

      setActiveTab: (leafId, tabId) =>
        set((state) => {
          const result = setLeafActiveTab(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          // 同步更新 flatPanels 中的 activeTab（rect 不变）
          const flatPanels = state.flatPanels.map((p) =>
            p.leafId === leafId ? { ...p, activeTab: tabId } : p
          );
          return { tree: result, flatPanels };
        }),

      // ── 拖拽状态 ──────────────────────────────────────────

      setDraggedSource: (source) =>
        set(
          source
            ? { draggedSource: source }
            : { draggedSource: null, activeDropZone: null }
        ),

      setActiveDropZone: (zone) => set({ activeDropZone: zone }),

      commitDrop: () =>
        set((state) => {
          const { draggedSource, activeDropZone, tree } = state;
          if (!draggedSource || !activeDropZone) {
            return { draggedSource: null, activeDropZone: null };
          }

          const {
            type: srcType,
            leafId: srcLeafId,
            tabId: srcTabId,
            panelId: srcPanelId,
          } = draggedSource;
          const { type: zoneType, targetLeafId } = activeDropZone;

          // 不允许 drop 到自身 leaf（merge-tab 除外，同 leaf 内 tab 重排）
          if (srcLeafId === targetLeafId && zoneType !== 'merge-tab') {
            return { draggedSource: null, activeDropZone: null };
          }
          // 同 leaf 且 leaf 拖拽：无操作
          if (srcLeafId === targetLeafId && srcType === 'leaf') {
            return { draggedSource: null, activeDropZone: null };
          }

          const direction = dropZoneToDirection(zoneType);
          let resultTree: LayoutTree = tree;

          if (direction !== null) {
            // ── split 路径 ──────────────────────────────────
            if (srcType === 'leaf') {
              // leaf 拖拽到 split：移动整个 leaf
              resultTree = moveLeaf(tree, srcLeafId, targetLeafId, direction);
            } else {
              // tab 拖拽到 split：从源 leaf 移除 tab，在 target 旁边 split 出新 leaf
              const afterRemove = removeTabFromLeaf(tree, srcLeafId, srcTabId);
              const targetStillExists = findNodeById(
                afterRemove.root,
                targetLeafId
              );
              if (!targetStillExists) {
                resultTree = afterRemove;
              } else {
                const splitDir: SplitDirection =
                  direction === 'left' || direction === 'right'
                    ? 'horizontal'
                    : 'vertical';
                const position: 'before' | 'after' =
                  direction === 'left' || direction === 'top'
                    ? 'before'
                    : 'after';
                resultTree = splitLeaf(
                  afterRemove,
                  targetLeafId,
                  splitDir,
                  srcPanelId,
                  position,
                  0.5
                );
              }
            }
          } else {
            // ── merge-tab 路径 ───────────────────────────────
            if (srcType === 'leaf') {
              // leaf 拖拽到 merge：将源 leaf 所有 tabs 转移到 target，然后移除源 leaf
              const srcLeaf = findNodeById(tree.root, srcLeafId);
              if (!srcLeaf || !isLeaf(srcLeaf)) {
                return { draggedSource: null, activeDropZone: null };
              }
              let working = tree;
              // 逐个添加 tab 到 target
              for (const tab of srcLeaf.tabs) {
                working = addTabToLeaf(working, targetLeafId, tab);
              }
              // 循环移除源 leaf 所有 tab（最后一个触发 leaf 删除）
              let checkLeaf = findNodeById(working.root, srcLeafId);
              while (
                checkLeaf &&
                isLeaf(checkLeaf) &&
                checkLeaf.tabs.length > 0
              ) {
                const t = checkLeaf.tabs[checkLeaf.tabs.length - 1]!;
                working = removeTabFromLeaf(working, srcLeafId, t);
                checkLeaf = findNodeById(working.root, srcLeafId);
              }
              resultTree = working;
            } else {
              // tab 拖拽到 merge：将 tab 从源 leaf 移到 target leaf
              const afterRemove = removeTabFromLeaf(tree, srcLeafId, srcTabId);
              const targetStillExists = findNodeById(
                afterRemove.root,
                targetLeafId
              );
              if (!targetStillExists) {
                resultTree = afterRemove;
              } else {
                resultTree = addTabToLeaf(afterRemove, targetLeafId, srcTabId);
              }
            }
          }

          if (resultTree === tree) {
            return { draggedSource: null, activeDropZone: null };
          }

          return {
            past: [...state.past, tree].slice(-MAX_HISTORY),
            future: [],
            tree: resultTree,
            flatPanels: recomputeFlat(resultTree),
            activeLeafId: resolveActiveLeaf(resultTree, state.activeLeafId),
            draggedSource: null,
            activeDropZone: null,
          };
        }),

      cancelDrag: () => set({ draggedSource: null, activeDropZone: null }),

      // ── 历史操作 ──────────────────────────────────────────

      pushHistory: () =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
        })),

      undo: () =>
        set((state) => {
          if (state.past.length === 0) return {};
          const previous = state.past[state.past.length - 1]!;
          return {
            past: state.past.slice(0, -1),
            future: [...state.future, state.tree].slice(-MAX_HISTORY),
            tree: previous,
            flatPanels: recomputeFlat(previous),
            activeLeafId: resolveActiveLeaf(previous, state.activeLeafId),
          };
        }),

      redo: () =>
        set((state) => {
          if (state.future.length === 0) return {};
          const next = state.future[state.future.length - 1]!;
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: state.future.slice(0, -1),
            tree: next,
            flatPanels: recomputeFlat(next),
            activeLeafId: resolveActiveLeaf(next, state.activeLeafId),
          };
        }),

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 tree + activeLeafId（不保存 history/drag/flatPanels）
      partialize: (s) => ({
        tree: s.tree,
        activeLeafId: s.activeLeafId,
      }),
      // hydrate 后重算 flatPanels + 清空临时状态
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.flatPanels = recomputeFlat(state.tree);
        state.activeLeafId = resolveActiveLeaf(state.tree, state.activeLeafId);
        state.past = [];
        state.future = [];
        state.draggedSource = null;
        state.activeDropZone = null;
      },
    }
  )
);

// ── Selectors ────────────────────────────────────────────────────

export const selectTree = (s: LayoutTreeStoreState) => s.tree;
export const selectDraggedSource = (s: LayoutTreeStoreState) => s.draggedSource;
export const selectActiveDropZone = (s: LayoutTreeStoreState) =>
  s.activeDropZone;
export const selectActiveLeafId = (s: LayoutTreeStoreState) => s.activeLeafId;

// ── Hooks ──────────────────────────────────────────────────────────

/** 获取所有叶子面板 */
export function useLeaves(): LayoutLeaf[] {
  return useLayoutTreeStore((s) => collectLeaves(s.tree.root));
}

/** 按 id 获取叶子面板 */
export function useLeafById(leafId: string): LayoutLeaf | null {
  return useLayoutTreeStore((s) => {
    const node = findNodeById(s.tree.root, leafId);
    return node && isLeaf(node) ? node : null;
  });
}
