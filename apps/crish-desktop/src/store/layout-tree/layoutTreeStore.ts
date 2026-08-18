/**
 * Layout Tree Store — 二叉树布局状态中心。
 *
 * 设计目标：
 * 1. 单一可信源：所有 tree 结构变更通过此 store 流转
 * 2. 纯函数更新：operations.ts 的纯函数返回新树，store 直接赋值（无需 immer）
 * 3. 历史栈：undo/redo（限 50 步，避免内存膨胀）
 * 4. 持久化：localStorage 保存 tree + activeLeafId + toolColumnCollapsed
 *    （不保存 history/drag 状态）；window-scoped key 支持多窗口隔离
 * 5. 拖拽集中化：commitDrop 调用纯函数 applyDrop 计算变更，仅负责推历史 + 清理状态
 * 6. 冷启动 restore 策略：onRehydrateStorage 读取 crish_restore_last_workspace
 *    开关，配合 validateRestorableLayoutTree 决定保留 multi-unit 树或回退 clean 单 chat
 *
 * Action 命名约定：
 * - 结构操作（推历史）：splitLeaf / mergeBranch / moveLeaf / resetTree / setTree /
 *   commitDrop / setTreeWithDock / setLeafSessionId
 * - 焦点操作（不推历史）：setActiveLeaf / setActiveTab
 * - 拖拽状态（不推历史）：setDraggedSource / setActiveDropZone / cancelDrag
 * - 工具栏折叠（不推历史）：toggleToolColumnCollapsed / setToolColumnCollapsed
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
import type { LayoutTree } from './types';
import { createDefaultTree } from './types';
import {
  splitLeaf,
  mergeBranch,
  moveLeaf,
  resizeBranch,
  addTabToLeaf,
  removeTabFromLeaf,
  setLeafActiveTab,
  setLeafSessionId as setLeafSessionIdOp,
  collectLeaves,
  findNodeById,
  applyDrop,
} from './operations';
// 类型契约从 layoutTreeStoreTypes.ts 拆出（T4-11 基线清零），hub 保留 re-export
export type {
  LayoutTreeStoreState,
  LayoutTreeStoreActions,
  LayoutTreeStore,
} from './layoutTreeStoreTypes';
import type { LayoutTreeStore } from './layoutTreeStoreTypes';
import {
  validateRestorableLayoutTree,
  RESTORE_LAST_WORKSPACE_LS_KEY,
} from './layoutRestorePolicy';
import { migrateScopedStorageKeyIfNeeded } from '../../api/shellWindowScope';

// ── 常量 ──────────────────────────────────────────────────────────

/** 历史栈最大长度（避免内存膨胀） */
const MAX_HISTORY = 50;
/**
 * localStorage 持久化 base key。
 * 运行时实际使用 window-scoped 形式：`${base}::${windowId}`
 * （见 layoutTreeStorageKey() / api/shellWindowScope.ts）
 */
const LAYOUT_TREE_STORAGE_KEY_BASE = 'crish-layout-tree-v1';

/**
 * 返回当前窗口的 layout-tree 持久化 key。
 *
 * 多窗口隔离：每个 workbench 窗口保留独立的 tree 快照。
 * 首次访问时若 scoped key 为空且 legacy 未 scope key 有数据，会一次性迁移
 * （仅主窗口受益；次窗口从空开始）。
 */
export function layoutTreeStorageKey(): string {
  return migrateScopedStorageKeyIfNeeded(LAYOUT_TREE_STORAGE_KEY_BASE);
}

// ── 类型契约 ──────────────────────────────────────────────────────
// LayoutTreeStoreState / LayoutTreeStoreActions / LayoutTreeStore
// 已拆至 ./layoutTreeStoreTypes.ts（见文件顶部 re-export）。

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

/**
 * 读取 restore-last-workspace 开关（同步 localStorage 直读，避免 appSettings race）。
 *
 * - 'true' / '1' → true（opt-in restore multi-unit）
 * - 'false' / '0' → false（默认 clean 单 chat）
 * - 缺失 / 脏值 → false（安全默认）
 */
function readRestoreLastWorkspaceFlag(): boolean {
  try {
    const raw = localStorage.getItem(RESTORE_LAST_WORKSPACE_LS_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  } catch {
    /* private mode / SSR */
  }
  return false;
}

/**
 * 强制 clean 单 chat tree + toolColumnCollapsed=true。
 * 用于 onRehydrateStorage 在 restore=false 或 tree 校验失败时归一化状态。
 */
function applyCleanColdStartOnState(state: LayoutTreeStoreState): void {
  const cleanTree = createDefaultTree('chat');
  state.tree = cleanTree;
  state.activeLeafId = firstLeafId(cleanTree);
  state.toolColumnCollapsed = true;
  state.past = [];
  state.future = [];
  state.draggedSource = null;
  state.activeDropZone = null;
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
      toolColumnCollapsed: false,

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

      setLeafSessionId: (leafId, sessionId) =>
        set((state) => {
          const result = setLeafSessionIdOp(state.tree, leafId, sessionId);
          if (result === state.tree) return {};
          // leaf↔session 绑定是元数据更新，不推历史（与 setActiveTab 同级）
          return { tree: result };
        }),

      /**
       * 同时更新 tree + toolColumnCollapsed + activeLeafId（推历史）。
       * 用于 applyDockToSession 等需要原子性更新多个字段的场景，
       * 避免独立 setState 之间产生中间态 re-render。
       */
      setTreeWithDock: (
        tree: LayoutTree,
        toolColumnCollapsed: boolean,
        activeLeafId?: string | null
      ) =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
          tree,
          activeLeafId:
            activeLeafId !== undefined
              ? activeLeafId
              : resolveActiveLeaf(tree, state.activeLeafId),
          toolColumnCollapsed,
        })),

      // ── 焦点操作（不推历史） ──────────────────────────────

      setActiveLeaf: (leafId) => set({ activeLeafId: leafId }),

      setActiveTab: (leafId, tabId) =>
        set((state) => {
          const result = setLeafActiveTab(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          return { tree: result };
        }),

      toggleToolColumnCollapsed: () =>
        set((state) => ({
          toolColumnCollapsed: !state.toolColumnCollapsed,
        })),

      setToolColumnCollapsed: (collapsed) =>
        set({ toolColumnCollapsed: collapsed }),

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
      name: layoutTreeStorageKey(),
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 tree + activeLeafId + toolColumnCollapsed
      // （不保存 history/drag 状态）
      partialize: (s) => ({
        tree: s.tree,
        activeLeafId: s.activeLeafId,
        toolColumnCollapsed: s.toolColumnCollapsed,
      }),
      /**
       * hydrate 后处理冷启动 restore 策略（D-D / S3）：
       *
       * - restore=false（默认）：强制 clean 单 chat + toolColumnCollapsed=true
       * - restore=true + tree 校验通过：保留持久化 tree，仅 normalize + 清临时状态
       * - restore=true + tree 校验失败：同 restore=false，安全回退
       *
       * 无论分支：临时状态（past/future/draggedSource/activeDropZone）必清空。
       */
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const restore = readRestoreLastWorkspaceFlag();
        const verdict = restore
          ? validateRestorableLayoutTree(state.tree)
          : { ok: false as const };

        if (!restore || !verdict.ok) {
          applyCleanColdStartOnState(state);
          return;
        }

        // restore 通过：保留 tree，仅 normalize activeLeafId + 清临时状态
        state.activeLeafId = resolveActiveLeaf(state.tree, state.activeLeafId);
        state.past = [];
        state.future = [];
        state.draggedSource = null;
        state.activeDropZone = null;
      },
    }
  )
);

// ── Hydration 门闩 ────────────────────────────────────────────────

/**
 * 等待 layout-tree persist rehydrate 完成。
 *
 * AppBootstrap 在调用 hydrateWorkspaceShell 前必须等待，否则脏多 leaf
 * 持久化数据会覆盖 resetTree 的 clean 单 chat 写入。
 *
 * 幂等：已 hydrate 时立即 resolve；未完成时订阅 onFinishHydration。
 */
export function waitLayoutTreeHydration(): Promise<void> {
  const api = useLayoutTreeStore.persist;
  if (api.hasHydrated()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsub = api.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

// ── Selectors ────────────────────────────────────────────────────
//
// 不再提供 selector 工厂函数（selectTree / selectDraggedSource 等）。
// 所有消费者统一使用内联 selector：`useLayoutTreeStore((s) => s.tree)`。
//
// 旧 selector 工厂从未被任何消费者采纳 — 4 个函数均为 0 引用孤儿。
// 保留它们会造成"两种正确写法"的歧义，违背单一可信源原则。
// 若未来需要跨组件共享 selector（如 zod schema 验证），再按需添加。
