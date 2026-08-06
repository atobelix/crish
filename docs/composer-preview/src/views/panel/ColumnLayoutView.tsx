/**
 * ColumnLayoutView — 多列布局
 *
 * Notion 的分栏：2~5 列，列间可拖拽分隔条调整宽度，每列内部是
 * 独立的编辑区域（可放任意块）。
 *
 * ── 交互清单 ──────────────────────────────────────────
 *   悬浮列间隙   → 出现 2px 分隔条，cursor: col-resize
 *   拖拽分隔条   → 实时改变左右两列比例，最小 12%
 *   双击分隔条   → 两列宽度重置为等分
 *   悬浮块       → 右上角出现「加一列 / 减一列」
 *   列数上限     → 5 列（再多每列就窄到没法排版了）
 *
 * ── 性能 ──────────────────────────────────────────────
 *   拖拽过程中只改 CSS 自定义属性 `--col-ratios`（不触发 PM 事务），
 *   松手时才把最终比例写进节点属性。
 *   这样一次拖拽只产生一个撤销步骤，且拖拽过程中没有任何文档序列化开销。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Columns3, Plus, Minus } from 'lucide-react';
import { BlockShell } from '../_shared/BlockShell';

/** 单列最小占比，防止拖到看不见 */
const MIN_RATIO = 0.12;
const MAX_COLUMNS = 5;
const MIN_COLUMNS = 2;

export const ColumnLayoutView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected,
  editor,
  getPos,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  /** memo 掉，避免每次渲染都生成新数组导致 startResize 回调失效 */
  const storedRatios = useMemo(
    () => (node.attrs.ratios as number[]) ?? [],
    [node.attrs.ratios],
  );
  const columnCount = node.childCount;

  /** 拖拽期间的临时比例；为 null 时使用节点属性里的值 */
  const [dragRatios, setDragRatios] = useState<number[] | null>(null);

  const ratios = normalize(dragRatios ?? storedRatios, columnCount);

  /* ── 分隔条拖拽 ── */
  const startResize = useCallback(
    (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const totalWidth = container.getBoundingClientRect().width;
      const startX = event.clientX;
      const base = normalize(storedRatios, columnCount);
      const pointerId = event.pointerId;
      (event.target as HTMLElement).setPointerCapture(pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const deltaRatio = (moveEvent.clientX - startX) / totalWidth;
        const next = [...base];
        const left = base[index] + deltaRatio;
        const right = base[index + 1] - deltaRatio;
        if (left < MIN_RATIO || right < MIN_RATIO) return;
        next[index] = left;
        next[index + 1] = right;
        setDragRatios(next);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDragRatios((finalRatios) => {
          // 只在松手时写一次事务：整段拖拽合并成一个撤销步骤
          if (finalRatios) updateAttributes({ ratios: finalRatios });
          return null;
        });
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [columnCount, storedRatios, updateAttributes],
  );

  /** 双击分隔条 → 等分 */
  const resetRatios = useCallback(() => {
    updateAttributes({ ratios: Array.from({ length: columnCount }, () => 1 / columnCount) });
  }, [columnCount, updateAttributes]);

  /* ── 增减列 ── */
  const changeColumnCount = useCallback(
    (delta: number) => {
      const target = columnCount + delta;
      if (target < MIN_COLUMNS || target > MAX_COLUMNS) return;
      if (typeof getPos !== 'function') return;

      const pos = getPos();
      if (pos === undefined) return;

      const columnType = editor.schema.nodes.column;
      const paragraph = editor.schema.nodes.paragraph;
      if (!columnType || !paragraph) return;

      const tr = editor.state.tr;
      if (delta > 0) {
        // 追加空列：插到最后一列之后
        const insertAt = pos + node.nodeSize - 1;
        tr.insert(insertAt, columnType.create(null, paragraph.create()));
      } else {
        // 删掉最后一列
        const last = node.lastChild;
        if (!last) return;
        const from = pos + node.nodeSize - 1 - last.nodeSize;
        tr.delete(from, pos + node.nodeSize - 1);
      }
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        columns: target,
        ratios: Array.from({ length: target }, () => 1 / target),
      });
      editor.view.dispatch(tr);
    },
    [columnCount, editor, getPos, node],
  );

  return (
    <BlockShell
      kind="columns"
      selected={selected}
      badge={
        <span className="block-badge">
          <Columns3 size={12} />
          {columnCount} 列
        </span>
      }
      actions={[
        {
          id: 'add',
          label: `增加一列（最多 ${MAX_COLUMNS} 列）`,
          icon: Plus,
          onClick: () => changeColumnCount(1),
        },
        {
          id: 'remove',
          label: `减少一列（最少 ${MIN_COLUMNS} 列）`,
          icon: Minus,
          onClick: () => changeColumnCount(-1),
        },
      ]}
    >
      <div
        ref={containerRef}
        className="column-layout"
        style={{ ['--col-ratios' as string]: ratios.map((r) => `${r}fr`).join(' ') }}
      >
        <NodeViewContent className="column-layout__content" />

        {/* 分隔条覆盖在列之间，绝对定位，不参与网格布局 */}
        <div className="column-layout__dividers" contentEditable={false}>
          {ratios.slice(0, -1).map((_, index) => (
            <div
              key={index}
              className="column-divider"
              style={{ left: `${cumulative(ratios, index) * 100}%` }}
              onPointerDown={startResize(index)}
              onDoubleClick={resetRatios}
              role="separator"
              aria-orientation="vertical"
              aria-label={`调整第 ${index + 1} 与第 ${index + 2} 列的宽度`}
            >
              <div className="column-divider__grip" />
            </div>
          ))}
        </div>
      </div>
    </BlockShell>
  );
};

/* ────────────────────────────────────────────
 * 工具
 * ──────────────────────────────────────────── */

/** 把比例数组补齐到指定列数并归一化，保证任何脏数据都能安全渲染 */
function normalize(ratios: number[], count: number): number[] {
  const safe = Array.from({ length: count }, (_, i) =>
    Number.isFinite(ratios[i]) && ratios[i] > 0 ? ratios[i] : 1 / count,
  );
  const sum = safe.reduce((a, b) => a + b, 0);
  return safe.map((r) => r / sum);
}

/** 前 index+1 列的累计占比，用于定位分隔条 */
function cumulative(ratios: number[], index: number): number {
  let total = 0;
  for (let i = 0; i <= index; i++) total += ratios[i];
  return total;
}
