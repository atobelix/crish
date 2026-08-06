import { useState, useEffect, useCallback } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * 统一的 Live Preview 编辑状态检测 Hook
 *
 * 核心逻辑：检测当前 NodeView 是否处于"编辑模式"（应显示 Markdown 源码）。
 * 触发条件（满足任一即为 true）：
 *   1. 光标（Selection）位于节点内部 → 用户正在编辑该节点
 *   2. 选区完全包含该节点 → 用户执行了全选（Ctrl+A）或拖选覆盖了该节点
 *
 * 同时提供 `focusNode()` 方法，供渲染模式下的 onClick 使用：
 * 点击渲染预览时，将 Prosemirror 光标移入节点内部，自动触发编辑模式。
 *
 * @param editor   - Tiptap Editor 实例
 * @param getPos   - NodeView 的 getPos 回调，返回节点在文档中的绝对位置
 * @param nodeSize - 当前节点的 nodeSize（包含首尾边界的总字符数）
 * @returns {{ isEditing: boolean, focusNode: () => void, pos: number | null }}
 *
 * @example
 * ```tsx
 * const { isEditing, focusNode } = useLivePreviewEditing(editor, getPos, node.nodeSize);
 * // isEditing === true  → 显示 Markdown 源码（可编辑围栏标记 + NodeViewContent）
 * // isEditing === false → 显示渲染结果（美观 UI 预览）
 * ```
 */
export function useLivePreviewEditing(
  editor: Editor,
  getPos: (() => number) | boolean,
  nodeSize: number,
) {
  /** 解析节点在文档中的绝对位置，getPos 可能是 boolean（旧版 Tiptap 兼容） */
  const pos = typeof getPos === 'function' ? getPos() : null;
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    /**
     * 每次 Prosemirror Selection 变化时执行的检测函数。
     * 通过比较 selection.from/to 与节点边界 [pos, pos + nodeSize] 来判断编辑状态。
     *
     * 两种触发编辑模式的场景：
     * - cursorInside: 光标位于节点内部（用户点击进入或键盘导航到此节点）
     * - selectionEncompasses: 选区完全覆盖该节点（Ctrl+A 全选或拖选覆盖）
     */
    const checkSelection = () => {
      if (pos === null) {
        setIsEditing(false);
        return;
      }

      const { from, to } = editor.state.selection;
      const nodeEnd = pos + nodeSize;

      // Case 1: 光标在节点内部（包括光标恰好在节点边界上的情况）
      const cursorInside = from >= pos && to <= nodeEnd;

      // Case 2: 选区完全覆盖了该节点（全选场景 / 跨节点拖选场景）
      const selectionEncompasses = from <= pos && to >= nodeEnd;

      setIsEditing(cursorInside || selectionEncompasses);
    };

    // 初始检测一次（组件挂载时 selection 可能已经在节点内）
    checkSelection();

    // 订阅 Tiptap 的 selectionUpdate 事件（光标移动、拖选、全选均会触发）
    editor.on('selectionUpdate', checkSelection);

    return () => {
      editor.off('selectionUpdate', checkSelection);
    };
  }, [editor, pos, nodeSize]);

  /**
   * 将 Prosemirror 光标移入节点内部。
   * 在渲染预览模式下，用户点击预览区域时调用此方法，
   * 触发 selectionUpdate → isEditing 变为 true → 切换到源码编辑模式。
   */
  const focusNode = useCallback(() => {
    if (!isEditing && pos !== null) {
      editor.commands.setTextSelection(pos + 1);
    }
  }, [editor, isEditing, pos]);

  return { isEditing, focusNode, pos };
}

/**
 * 围栏标记（```language / ``` / $$ / > [!TYPE]）的通用样式常量。
 * 所有 Block NodeView 的可编辑围栏标记共享此样式，确保视觉一致性。
 */
export const FENCE_MARKER_STYLE: React.CSSProperties = {
  padding: '4px 16px',
  color: '#94a3b8',
  fontSize: '14px',
  fontFamily: 'Consolas, Monaco, "Andale Mono", monospace',
  backgroundColor: '#f8fafc',
  outline: 'none',
  whiteSpace: 'pre',
  caretColor: '#334155',
  lineHeight: 1.5,
};

/**
 * 围栏标记的 onKeyDown 通用处理函数。
 * 阻止 Enter 键在围栏标记内换行（围栏标记应该是单行的）。
 * 按 Enter 时将焦点移入节点的 Prosemirror 内容区域。
 */
export function handleFenceKeyDown(
  e: React.KeyboardEvent<HTMLDivElement>,
  editor: Editor,
  pos: number | null,
) {
  if (e.key === 'Enter') {
    e.preventDefault();
    // 将焦点移入节点的 Prosemirror 内容区域
    if (pos !== null) {
      editor.commands.setTextSelection(pos + 1);
      editor.commands.focus();
    }
  }
}
