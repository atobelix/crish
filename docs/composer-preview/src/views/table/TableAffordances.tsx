/**
 * TableAffordances — 表格的悬浮交互覆盖层
 *
 * 这一层实现的是「表格看起来像 Notion」的绝大部分：
 * 那些平时看不见、鼠标靠近才浮出来的控件。
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   悬浮行左缘      → 行手柄，点击选中整行并弹出行菜单
 *   悬浮列顶部      → 列手柄，点击选中整列并弹出列菜单
 *   悬浮行/列间隙   → 蓝色插入线 + ⊕，点这里插到**中间**而不是末尾
 *   悬浮表格右缘    → 整列高的竖条 + ⊕，追加一列
 *   悬浮表格下缘    → 整行宽的横条 + ⊕，追加一行
 *   悬浮右下角      → ⊕ 方块，同时加一行一列
 *   列边界          → 列宽拖拽（由 prosemirror-tables 自己提供，这里不重复实现）
 *
 * ── 为什么是覆盖层而不是 NodeView ──────────────────
 *   见 TableExtension 的说明：React 接管 `<table>` 会冲掉 columnResizing
 *   维护的 `<colgroup>`。覆盖层只读几何、不改渲染，两边零耦合。
 *   代价是需要自己做坐标计算，收益是列宽拖拽、单元格选区这些
 *   已经很成熟的能力全部原样保留。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { Plus, GripVertical, GripHorizontal } from 'lucide-react';
import { useTableGeometry, type TableGeometry, type TrackGeometry } from './useTableGeometry';
import {
  selectRow, selectColumn,
  insertRowAbove, insertRowBelow, insertColumnLeft, insertColumnRight,
  appendRow, appendColumn,
} from './tableCommands';
import { TableTrackMenu, type TrackMenuKind } from './TableTrackMenu';

interface TableAffordancesProps {
  editor: Editor;
  /** 编辑器根元素，用于限定鼠标追踪范围 */
  root: HTMLElement | null;
}

/** 手柄与表格之间的间距 */
const HANDLE_GAP = 5;
/** 手柄的厚度 */
const HANDLE_SIZE = 13;
/** 插入线的命中区半宽 */
const SEAM_HIT = 7;

interface MenuState {
  kind: TrackMenuKind;
  index: number;
  cell: HTMLElement;
  anchor: { x: number; y: number };
}

export const TableAffordances: React.FC<TableAffordancesProps> = ({ editor, root }) => {
  const geometry = useTableGeometry(root);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 当前高亮的插入缝隙：`row:2` 或 `col:0` */
  const [seam, setSeam] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = useCallback(
    (kind: TrackMenuKind, track: TrackGeometry, event: React.MouseEvent) => {
      if (kind === 'row') selectRow(editor, track.cell);
      else selectColumn(editor, track.cell);
      setMenu({
        kind,
        index: track.index,
        cell: track.cell,
        anchor: { x: event.clientX, y: event.clientY },
      });
    },
    [editor],
  );

  // 表格消失时顺手关掉菜单，避免菜单孤零零地留在屏幕上
  const active = geometry ?? null;
  if (!active && menu) queueMicrotask(closeMenu);

  const lastRowCell = useMemo(
    () => (active ? active.rows[active.rows.length - 1]?.cell : null),
    [active],
  );
  const lastColCell = useMemo(
    () => (active ? active.cols[active.cols.length - 1]?.cell : null),
    [active],
  );

  if (!active) return null;

  const { rect, rows, cols } = active;

  return createPortal(
    <div className="table-affordances" aria-hidden={false}>
      {/* ══════════ 行手柄（左侧） ══════════ */}
      {rows.map((row) => (
        <button
          key={`row-handle-${row.index}`}
          type="button"
          className="tbl-handle tbl-handle--row"
          style={{
            top: row.start,
            left: rect.left - HANDLE_SIZE - HANDLE_GAP,
            height: row.size,
            width: HANDLE_SIZE,
          }}
          onClick={(e) => openMenu('row', row, e)}
          title={`第 ${row.index + 1} 行`}
          aria-label={`第 ${row.index + 1} 行操作`}
        >
          <GripVertical size={10} />
        </button>
      ))}

      {/* ══════════ 列手柄（顶部） ══════════ */}
      {cols.map((col) => (
        <button
          key={`col-handle-${col.index}`}
          type="button"
          className="tbl-handle tbl-handle--col"
          style={{
            left: col.start,
            top: rect.top - HANDLE_SIZE - HANDLE_GAP,
            width: col.size,
            height: HANDLE_SIZE,
          }}
          onClick={(e) => openMenu('col', col, e)}
          title={`第 ${col.index + 1} 列`}
          aria-label={`第 ${col.index + 1} 列操作`}
        >
          <GripHorizontal size={10} />
        </button>
      ))}

      {/* ══════════ 行间插入缝隙 ══════════
          悬浮两行之间时浮出一条蓝线和 ⊕，插到中间而不是末尾 */}
      {rows.map((row) => (
        <div
          key={`row-seam-${row.index}`}
          className={`tbl-seam tbl-seam--row ${seam === `row:${row.index}` ? 'is-active' : ''}`}
          style={{
            top: row.start - SEAM_HIT,
            left: rect.left - HANDLE_SIZE - HANDLE_GAP,
            width: rect.width + HANDLE_SIZE + HANDLE_GAP,
            height: SEAM_HIT * 2,
          }}
          onPointerEnter={() => setSeam(`row:${row.index}`)}
          onPointerLeave={() => setSeam(null)}
          onClick={() => insertRowAbove(editor, row.cell)}
          role="button"
          aria-label={`在第 ${row.index + 1} 行上方插入一行`}
        >
          <span className="tbl-seam__line" />
          <span className="tbl-seam__plus">
            <Plus size={11} />
          </span>
        </div>
      ))}

      {/* ══════════ 列间插入缝隙 ══════════ */}
      {cols.map((col) => (
        <div
          key={`col-seam-${col.index}`}
          className={`tbl-seam tbl-seam--col ${seam === `col:${col.index}` ? 'is-active' : ''}`}
          style={{
            left: col.start - SEAM_HIT,
            top: rect.top - HANDLE_SIZE - HANDLE_GAP,
            height: rect.height + HANDLE_SIZE + HANDLE_GAP,
            width: SEAM_HIT * 2,
          }}
          onPointerEnter={() => setSeam(`col:${col.index}`)}
          onPointerLeave={() => setSeam(null)}
          onClick={() => insertColumnLeft(editor, col.cell)}
          role="button"
          aria-label={`在第 ${col.index + 1} 列左侧插入一列`}
        >
          <span className="tbl-seam__line" />
          <span className="tbl-seam__plus">
            <Plus size={11} />
          </span>
        </div>
      ))}

      {/* ══════════ 右缘：追加一列 ══════════ */}
      {lastColCell && (
        <button
          type="button"
          className="tbl-append tbl-append--col"
          style={{
            left: rect.left + rect.width + 2,
            top: rect.top,
            height: rect.height,
          }}
          onClick={() => appendColumn(editor, lastColCell)}
          title="在末尾添加一列"
          aria-label="在末尾添加一列"
        >
          <span className="tbl-append__bar" />
          <span className="tbl-append__plus">
            <Plus size={13} />
          </span>
        </button>
      )}

      {/* ══════════ 下缘：追加一行 ══════════ */}
      {lastRowCell && (
        <button
          type="button"
          className="tbl-append tbl-append--row"
          style={{
            top: rect.top + rect.height + 2,
            left: rect.left,
            width: rect.width,
          }}
          onClick={() => appendRow(editor, lastRowCell)}
          title="在末尾添加一行"
          aria-label="在末尾添加一行"
        >
          <span className="tbl-append__bar" />
          <span className="tbl-append__plus">
            <Plus size={13} />
          </span>
        </button>
      )}

      {/* ══════════ 右下角：同时加一行一列 ══════════ */}
      {lastRowCell && lastColCell && (
        <button
          type="button"
          className="tbl-corner"
          style={{
            left: rect.left + rect.width + 2,
            top: rect.top + rect.height + 2,
          }}
          onClick={() => {
            appendRow(editor, lastRowCell);
            appendColumn(editor, lastColCell);
          }}
          title="同时添加一行和一列"
          aria-label="同时添加一行和一列"
        >
          <Plus size={12} />
        </button>
      )}

      {/* ══════════ 行/列菜单 ══════════ */}
      {menu && (
        <TableTrackMenu
          editor={editor}
          kind={menu.kind}
          index={menu.index}
          cell={menu.cell}
          anchor={menu.anchor}
          onClose={closeMenu}
        />
      )}
    </div>,
    document.body,
  );
};

export type { TableGeometry };
