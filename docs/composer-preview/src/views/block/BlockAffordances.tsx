/**
 * BlockAffordances — 块级手柄与插入按钮
 *
 * 就是 Notion 里鼠标移到段落左侧浮出来的那两个东西：
 *
 *   ＋  点击 → 在下方插入一个空段落并直接打开斜杠菜单
 *   ⠿   点击 → 打开块菜单（转换 / 复制 / 颜色 / 删除…）
 *       拖拽 → 移动这个块，落点由 dropcursor 画出蓝线
 *
 * ── 拖拽为什么不自己实现 ──────────────────────────────
 *   ProseMirror 自带完整的节点拖放：只要在 dragstart 时把选区设成
 *   目标块的 NodeSelection，剩下的命中判定、落点计算、事务生成
 *   它自己就做完了，dropcursor 插件还会顺带画好落点指示线。
 *   自己用 pointer 事件重写一套，要处理滚动容器、嵌套块、跨块边界，
 *   收益为零。
 */

import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { Plus, GripVertical } from 'lucide-react';
import { useBlockHover, type BlockHoverTarget } from './useBlockHover';
import { BlockMenu } from '../../menus/BlockMenu';

interface BlockAffordancesProps {
  editor: Editor | null;
  root: HTMLElement | null;
}

/** 手柄相对块左缘的偏移 */
const HANDLE_OFFSET = 26;
const PLUS_OFFSET = 50;
/** 手柄的垂直微调：让它与首行文字的视觉中线对齐，而不是块的几何中线 */
const BASELINE_NUDGE = 2;

export const BlockAffordances: React.FC<BlockAffordancesProps> = ({ editor, root }) => {
  const { target, setLocked } = useBlockHover(editor, root);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [menuTarget, setMenuTarget] = useState<BlockHoverTarget | null>(null);

  const closeMenu = useCallback(() => {
    setMenuAnchor(null);
    setMenuTarget(null);
    setLocked(false);
  }, [setLocked]);

  /* ── ＋：在下方插入并打开斜杠菜单 ── */
  const insertBelow = useCallback(() => {
    if (!editor || !target) return;
    const node = editor.state.doc.nodeAt(target.pos);
    if (!node) return;

    const insertAt = target.pos + node.nodeSize;
    editor
      .chain()
      .focus()
      .insertContentAt(insertAt, { type: 'paragraph' })
      .setTextSelection(insertAt + 1)
      // 直接把 `/` 打进去，斜杠菜单会随之弹出——省掉用户再按一次
      .insertContent('/')
      .run();
  }, [editor, target]);

  /* ── ⠿：打开菜单 ── */
  const openMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!editor || !target) return;
      event.preventDefault();
      selectBlock(editor, target.pos);
      setLocked(true);
      setMenuTarget(target);
      setMenuAnchor({ x: event.clientX, y: event.clientY });
    },
    [editor, target, setLocked],
  );

  /* ── ⠿：拖拽 ── */
  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      if (!editor || !target) return;
      // 建立 NodeSelection，ProseMirror 的 dragstart 处理会据此拖整个块
      selectBlock(editor, target.pos);
      setLocked(true);
      editor.view.dom.classList.add('is-dragging-block');

      // 用块自身作为拖拽预览，比默认的手柄截图直观得多
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setDragImage(target.element, 12, 12);
    },
    [editor, target, setLocked],
  );

  const onDragEnd = useCallback(() => {
    editor?.view.dom.classList.remove('is-dragging-block');
    setLocked(false);
  }, [editor, setLocked]);

  if (!editor || !root) return null;

  const shown = menuTarget ?? target;
  if (!shown) return null;

  const top = shown.rect.top + BASELINE_NUDGE;

  return createPortal(
    <>
      <div className="block-affordances" style={{ top, left: shown.rect.left }}>
        <button
          type="button"
          className="block-aff__btn block-aff__btn--plus"
          style={{ left: -PLUS_OFFSET }}
          onClick={insertBelow}
          title="在下方插入区块"
          aria-label="在下方插入区块"
        >
          <Plus size={15} />
        </button>

        <button
          type="button"
          className="block-aff__btn block-aff__btn--handle"
          style={{ left: -HANDLE_OFFSET }}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={openMenu}
          onContextMenu={openMenu}
          title="拖拽移动 · 点击打开菜单"
          aria-label="块操作"
        >
          <GripVertical size={15} />
        </button>
      </div>

      {menuAnchor && menuTarget && (
        <BlockMenu
          editor={editor}
          pos={menuTarget.pos}
          typeName={menuTarget.typeName}
          anchor={menuAnchor}
          onClose={closeMenu}
        />
      )}
    </>,
    document.body,
  );
};

/** 把选区设成指定位置的整块，便于拖拽与批量操作 */
function selectBlock(editor: Editor, pos: number): void {
  try {
    const selection = NodeSelection.create(editor.state.doc, pos);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  } catch {
    /* 该位置不是可选中的节点时忽略 */
  }
}
