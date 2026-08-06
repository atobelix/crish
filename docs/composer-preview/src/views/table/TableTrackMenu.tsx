/**
 * TableTrackMenu — 行/列操作菜单
 *
 * 点击行手柄或列手柄后弹出。内容按 Notion 的分组方式组织：
 * 插入 → 变换 → 外观 → 危险操作，最危险的永远在最后一组、用红色标注。
 *
 * ── 交互细节 ──────────────────────────────────────────
 *   点击外部 / Escape → 关闭
 *   ↑ ↓                → 在菜单项间移动
 *   Enter              → 执行
 *   靠近视口边缘        → 自动翻转，不会被裁掉
 *   颜色子项            → 十色网格就地展开，不再套一层子菜单
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import {
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Copy, Trash2, Paintbrush, AlignLeft, AlignCenter, AlignRight,
  Eraser, Heading,
} from 'lucide-react';
import { BACKGROUND_COLORS } from '../../menus/colorPalette';
import {
  insertRowAbove, insertRowBelow, deleteRow, duplicateRow,
  insertColumnLeft, insertColumnRight, deleteColumn,
  setCellBackground, setCellAlign, clearCells, toggleHeaderRow,
} from './tableCommands';

export type TrackMenuKind = 'row' | 'col';

interface TableTrackMenuProps {
  editor: Editor;
  kind: TrackMenuKind;
  index: number;
  cell: HTMLElement;
  anchor: { x: number; y: number };
  onClose: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.FC<{ size?: number }>;
  shortcut?: string;
  danger?: boolean;
  /** 分组末尾加分隔线 */
  dividerAfter?: boolean;
  run: () => void;
}

/** 菜单距视口边缘的最小留白 */
const EDGE = 10;

export const TableTrackMenu: React.FC<TableTrackMenuProps> = ({
  editor, kind, index, cell, anchor, onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.y, left: anchor.x });
  const [activeIndex, setActiveIndex] = useState(0);
  const [colorOpen, setColorOpen] = useState(false);

  /* ── 构造菜单项 ── */
  const items: MenuItem[] = React.useMemo(() => {
    const done = (fn: () => void) => () => {
      fn();
      onClose();
    };

    if (kind === 'row') {
      return [
        { id: 'above', label: '在上方插入', icon: ArrowUp, run: done(() => insertRowAbove(editor, cell)) },
        { id: 'below', label: '在下方插入', icon: ArrowDown, dividerAfter: true, run: done(() => insertRowBelow(editor, cell)) },
        { id: 'duplicate', label: '创建副本', icon: Copy, shortcut: 'Ctrl+D', run: done(() => duplicateRow(editor, cell)) },
        { id: 'header', label: index === 0 ? '切换表头行' : '设为表头行', icon: Heading, dividerAfter: true, run: done(() => toggleHeaderRow(editor)) },
        { id: 'clear', label: '清除内容', icon: Eraser, run: done(() => clearCells(editor)) },
        { id: 'delete', label: '删除此行', icon: Trash2, danger: true, run: done(() => deleteRow(editor, cell)) },
      ];
    }

    return [
      { id: 'left', label: '在左侧插入', icon: ArrowLeft, run: done(() => insertColumnLeft(editor, cell)) },
      { id: 'right', label: '在右侧插入', icon: ArrowRight, dividerAfter: true, run: done(() => insertColumnRight(editor, cell)) },
      { id: 'align-left', label: '左对齐', icon: AlignLeft, run: done(() => setCellAlign(editor, 'left')) },
      { id: 'align-center', label: '居中对齐', icon: AlignCenter, run: done(() => setCellAlign(editor, 'center')) },
      { id: 'align-right', label: '右对齐', icon: AlignRight, dividerAfter: true, run: done(() => setCellAlign(editor, 'right')) },
      { id: 'clear', label: '清除内容', icon: Eraser, run: done(() => clearCells(editor)) },
      { id: 'delete', label: '删除此列', icon: Trash2, danger: true, run: done(() => deleteColumn(editor, cell)) },
    ];
  }, [cell, editor, index, kind, onClose]);

  /* ── 定位：贴着点击点，超出视口就翻转 ── */
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.min(anchor.x, window.innerWidth - w - EDGE);
    const top =
      anchor.y + h + EDGE > window.innerHeight
        ? Math.max(EDGE, anchor.y - h)
        : anchor.y;
    setPos({ top, left: Math.max(EDGE, left) });
  }, [anchor.x, anchor.y, colorOpen]);

  /* ── 点击外部 / Escape 关闭 ── */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        items[activeIndex]?.run();
      }
    };

    // 延后一帧再绑定，避免「打开菜单的那次点击」立刻把它关掉
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, items, onClose]);

  const applyColor = useCallback(
    (value: string | null) => {
      setCellBackground(editor, value);
      onClose();
    },
    [editor, onClose],
  );

  return (
    <div
      ref={menuRef}
      className="tbl-menu motion-rise-in"
      style={{ top: pos.top, left: pos.left }}
      role="menu"
      aria-label={kind === 'row' ? '行操作' : '列操作'}
    >
      <div className="tbl-menu__title">
        {kind === 'row' ? `第 ${index + 1} 行` : `第 ${index + 1} 列`}
      </div>

      {items.map((item, i) => (
        <React.Fragment key={item.id}>
          <button
            type="button"
            role="menuitem"
            className={[
              'tbl-menu__item',
              i === activeIndex ? 'is-active' : '',
              item.danger ? 'is-danger' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onPointerEnter={() => setActiveIndex(i)}
            onClick={item.run}
          >
            <item.icon size={14} />
            <span className="tbl-menu__label">{item.label}</span>
            {item.shortcut && <kbd className="tbl-menu__shortcut">{item.shortcut}</kbd>}
          </button>
          {item.dividerAfter && <div className="tbl-menu__divider" />}
        </React.Fragment>
      ))}

      {/* 颜色：就地展开十色网格，不再套子菜单 */}
      <div className="tbl-menu__divider" />
      <button
        type="button"
        className={`tbl-menu__item ${colorOpen ? 'is-active' : ''}`}
        onClick={() => setColorOpen((v) => !v)}
        aria-expanded={colorOpen}
      >
        <Paintbrush size={14} />
        <span className="tbl-menu__label">单元格颜色</span>
      </button>

      {colorOpen && (
        <div className="tbl-menu__colors motion-fade-in">
          {BACKGROUND_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              className="tbl-menu__swatch"
              style={{ background: color.value }}
              onClick={() => applyColor(color.id === 'default' ? null : color.value)}
              title={color.label}
              aria-label={color.label}
            />
          ))}
        </div>
      )}
    </div>
  );
};
