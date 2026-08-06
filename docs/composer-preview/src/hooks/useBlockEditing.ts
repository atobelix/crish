/**
 * useBlockEditing — 判断当前 NodeView 是否处于「编辑态」
 *
 * 编辑态 = 光标或选区落在这个节点内部。
 * 围栏类区块（Mermaid、Diff、公式）据此决定展开源码还是显示渲染结果。
 *
 * ── 为什么不用 ProseMirror 插件 ────────────────────────
 *   早先这里依赖一个专门的 LivePreviewPlugin：它在每次事务里遍历全文档，
 *   把「被选区触及的块」收集进一个 Set，NodeView 再来查表。
 *
 *   那套做法有三个问题：
 *     1. 遍历时命中一个块就停止下钻，导致嵌套在列表/引用里的块永远查不到；
 *     2. 插件必须被注册，一旦忘记注册，所有 NodeView 静默退化成「永不编辑」，
 *        而且不会报任何错——这个坑真的踩过一次；
 *     3. 为了 O(1) 的问题付出了 O(文档) 的代价。
 *
 *   实际上这个判断根本不需要全局状态：拿到自己的 pos 和 nodeSize，
 *   跟当前选区比一下区间就行，O(1)，也不可能漏掉嵌套节点。
 */

import { useCallback, useSyncExternalStore, useMemo } from 'react';
import type { Editor } from '@tiptap/core';

interface BlockEditingResult {
  /** 当前节点是否处于编辑模式 */
  isEditing: boolean;
  /** 把光标移入此节点，从渲染态切到编辑态 */
  focusNode: () => void;
}

export function useBlockEditing(
  editor: Editor,
  getPos: (() => number | undefined) | (() => number) | boolean,
): BlockEditingResult {
  /**
   * 订阅编辑器事务。
   *
   * 用 'transaction' 而非 'selectionUpdate'：文档内容变化也会移动节点位置，
   * 只听选区会漏掉「在上方插入内容导致本节点位移」这类情况。
   */
  const subscribe = useMemo(
    () => (onStoreChange: () => void) => {
      editor.on('transaction', onStoreChange);
      return () => {
        editor.off('transaction', onStoreChange);
      };
    },
    [editor],
  );

  /**
   * 每次都重新调用 getPos()，不做任何缓存。
   * 缓存 pos 是旧实现最主要的 bug 来源——文档一变它就失效了。
   */
  const getSnapshot = useMemo(
    () => (): boolean => {
      if (typeof getPos !== 'function') return false;
      try {
        const pos = getPos();
        if (pos === undefined) return false;

        const node = editor.state.doc.nodeAt(pos);
        if (!node) return false;

        const { from, to } = editor.state.selection;
        const end = pos + node.nodeSize;
        // 光标在内部，或选区把整个节点包住（全选、跨块拖选）
        return (from >= pos && from <= end) || (from <= pos && to >= end);
      } catch {
        // 节点被删除后 getPos() 会抛异常
        return false;
      }
    },
    [editor, getPos],
  );

  const isEditing = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const focusNode = useCallback(() => {
    if (typeof getPos !== 'function') return;
    try {
      const pos = getPos();
      if (pos === undefined) return;
      // pos + 1 是节点内部的第一个位置
      editor.commands.setTextSelection(pos + 1);
      editor.commands.focus();
    } catch {
      /* 节点可能已被删除 */
    }
  }, [editor, getPos]);

  return { isEditing, focusNode };
}
