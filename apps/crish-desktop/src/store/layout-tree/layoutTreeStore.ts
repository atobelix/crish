/**
 * Layout Tree Store — 二叉树布局状态中心。
 *
 * 设计目标：
 * 1. 单一可信源：所有 tree 结构变更通过此 store 流转
 * 2. 纯函数更新：operations.ts 的纯函数返回新树，store 直接赋值（无需 immer）
 * 3. 历史栈：undo/redo（限 50 步，避免内存膨胀）
 * 4. 持久化：localStorage 保存 tree + activeLeafId（不保存 history/drag 状态）
 * 5. 拖拽集中化：commitDrop 调用纯函数 applyDrop 计算变更，仅负责推历史 + 清理状态
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
 *
 * 为何不缓存 flatPanels：
 * - 仅有 BinaryTreeWorkspace 消费，且其已用 useMemo + flattenToRenderList 计算
 * - 缓存意味着每次 tree 变更要同步重算，增加 store 复杂度与出错面
 * - 真正的消费者少时，按需计算更简单
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  LayoutTree,
  SplitDirection,
  DropDirection,
  TreeDragSource,
} from './types';
import { createDefaultTree } from './types';
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
  applyDrop,
} from './operations';
import type { DropZone } from './dropDetection';

// ── 常量 ──────────────────────────────────────────────────────────

/** 历史栈最大长度（避免内存膨胀） */
const MAX_HISTORY = 50;
/** localStorage 持久化 key */
const STORAGE_KEY = 'crish-layout-tree-v1';

// ── 类型 ──────────────────────────────────────────────────────────

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
  /** 提交拖拽：调用 applyDrop 计算变更，推历史，清理拖拽状态 */
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
      past: [],
      future: [],

      // ── 结构操作 ──────────────────────────────────────────

      setTree: (tree) =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
          tree,
          activeLeafId: resolveActiveLeaf(tree, state.activeLeafId),
        })),

      resetTree: (panelId = 'chat') =>
        set((state) => {
          const newTree = createDefaultTree(panelId);
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: newTree,
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
            activeLeafId: resolveActiveLeaf(result, state.activeLeafId),
          };
        }),

      // ── 焦点操作（不推历史） ──────────────────────────────

      setActiveLeaf: (leafId) => set({ activeLeafId: leafId }),

      setActiveTab: (leafId, tabId) =>
        set((state) => {
          const result = setLeafActiveTab(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          return { tree: result };
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

          const resultTree = applyDrop(tree, draggedSource, activeDropZone);
          if (resultTree === tree) {
            return { draggedSource: null, activeDropZone: null };
          }

          return {
            past: [...state.past, tree].slice(-MAX_HISTORY),
            future: [],
            tree: resultTree,
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
            activeLeafId: resolveActiveLeaf(next, state.activeLeafId),
          };
        }),

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 tree + activeLeafId（不保存 history/drag 状态）
      partialize: (s) => ({
        tree: s.tree,
        activeLeafId: s.activeLeafId,
      }),
      // hydrate 后清空临时状态 + 修正 activeLeafId
      onRehydrateStorage: () => (state) => {
        if (!state) return;
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
