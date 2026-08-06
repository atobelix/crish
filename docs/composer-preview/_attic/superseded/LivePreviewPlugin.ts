/**
 * LivePreviewPlugin — 统一管理所有区块的编辑/渲染状态
 *
 * 核心思路：
 * 1. 每次 Selection 变化时，遍历文档找出所有被光标/选区触及的 L1/L2 节点
 * 2. 将这些节点的起始位置存入 Plugin State 的 `activeNodePositions` 集合
 * 3. 各 NodeView 通过 useBlockEditing Hook 读取 Plugin State 来判断自身编辑状态
 *
 * 优势（相比旧版 useLivePreviewEditing）：
 * - 单一事实来源：所有节点的编辑状态由同一个 Plugin 管理
 * - 性能优化：一次遍历即可计算所有节点状态，避免每个 NodeView 独立监听
 * - Undo/Redo 安全：Plugin State 跟随 EditorState 变化，不会出现 pos 失效
 * - 全选一致性：Ctrl+A 时所有 L1/L2 节点一次性全部标记为 editing
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isLivePreviewBlock } from '../types/blocks';

/* ────────────────────────────────────────────
 * Plugin Key（外部通过此 Key 读取 Plugin State）
 * ──────────────────────────────────────────── */

export const livePreviewPluginKey = new PluginKey<LivePreviewState>('livePreview');

/* ────────────────────────────────────────────
 * Plugin State 类型
 * ──────────────────────────────────────────── */

export interface LivePreviewState {
  /**
   * 当前处于编辑模式的节点起始位置集合。
   * NodeView 通过 getPos() 获取自身位置，然后检查是否在此集合中。
   */
  activeNodePositions: Set<number>;

  /**
   * 是否处于全选状态。
   * 当 Ctrl+A 全选整篇文档时，所有 L1/L2 节点同时进入编辑模式。
   */
  isAllSelected: boolean;
}

/* ────────────────────────────────────────────
 * 计算 Active Nodes
 * ──────────────────────────────────────────── */

/**
 * 根据当前编辑器状态计算哪些 Live Preview 节点应该处于编辑模式。
 *
 * 规则：
 * 1. 如果光标（空选区）在某个 L1/L2 节点内部 → 该节点进入编辑模式
 * 2. 如果选区覆盖了某个 L1/L2 节点（部分或全部）→ 该节点进入编辑模式
 * 3. 如果选区覆盖了整篇文档（全选）→ 所有 L1/L2 节点进入编辑模式
 */
function computeActiveNodes(state: EditorState): LivePreviewState {
  const { from, to } = state.selection;
  const docSize = state.doc.content.size;
  const activeNodePositions = new Set<number>();

  // 判断是否全选（选区覆盖整个文档）
  const isAllSelected = from === 0 && to >= docSize - 1;

  state.doc.descendants((node, pos) => {
    if (!isLivePreviewBlock(node.type.name)) {
      return true; // 继续遍历子节点
    }

    const nodeEnd = pos + node.nodeSize;

    if (isAllSelected) {
      // 全选时所有 Live Preview 节点都进入编辑模式
      activeNodePositions.add(pos);
      return false; // 不遍历 Live Preview 节点的子节点
    }

    // 检查光标/选区是否与此节点重叠
    const cursorInside = from >= pos && from <= nodeEnd;
    const selectionOverlaps = from < nodeEnd && to > pos;

    if (cursorInside || selectionOverlaps) {
      activeNodePositions.add(pos);
    }

    return false; // 不遍历 Live Preview 节点的子节点
  });

  return { activeNodePositions, isAllSelected };
}

/* ────────────────────────────────────────────
 * 创建 Plugin 实例
 * ──────────────────────────────────────────── */

export function createLivePreviewPlugin(): Plugin<LivePreviewState> {
  return new Plugin<LivePreviewState>({
    key: livePreviewPluginKey,

    state: {
      init(_config, state): LivePreviewState {
        return computeActiveNodes(state);
      },

      apply(_tr, _prevState, _oldState, newState): LivePreviewState {
        // 每次事务后重新计算活跃节点
        // 性能说明：descendants 遍历是 O(n)，对于正常文档大小（<10000 节点）
        // 耗时 <1ms，可以接受。如果未来需要优化，可以只在选区变化时重算。
        return computeActiveNodes(newState);
      },
    },

    props: {
      // 不需要额外的 decorations — NodeView 直接从 Plugin state 读取
      // 不需要 handleDOMEvents — 选区变化通过 EditorState 自动追踪
    },
  });
}

/* ────────────────────────────────────────────
 * 辅助函数：外部读取 Plugin State
 * ──────────────────────────────────────────── */

/**
 * 检查指定位置的节点是否当前处于编辑模式。
 *
 * @param state - 当前 EditorState
 * @param pos - 节点的起始位置（通过 getPos() 获取）
 * @returns 节点是否处于编辑模式
 */
export function isNodeEditing(state: EditorState, pos: number): boolean {
  const pluginState = livePreviewPluginKey.getState(state);
  if (!pluginState) return false;
  return pluginState.activeNodePositions.has(pos);
}

/**
 * 检查当前是否处于全选状态。
 */
export function isAllSelected(state: EditorState): boolean {
  const pluginState = livePreviewPluginKey.getState(state);
  return pluginState?.isAllSelected ?? false;
}
