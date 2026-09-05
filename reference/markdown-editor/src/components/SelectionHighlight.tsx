import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { getCoordinatesFromIndex, getDOMPointFromIndex } from '../core/measure';
import {
  DecorationSet,
  applyCursorSelectionDecorations,
} from '../core/DecorationSet';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 几何区间合并算法（1D/2D Rect Union）
 * 彻底消除内联嵌套元素（父子 span、Token 结构）在 Range.getClientRects() 产生的重叠矩形，
 * 保证任意视觉行内的选区矩形严格互斥，杜绝任何局部叠色或双层灰度。
 */
function mergeOverlappingRects(rawRects: Rect[]): Rect[] {
  if (rawRects.length <= 1) return rawRects;

  const valid = rawRects.filter((r) => r.width > 0 && r.height > 0);
  if (valid.length <= 1) return valid;

  // 按垂直 top 升序排序，同视觉行按水平 left 升序排序
  valid.sort((a, b) => {
    const dTop = a.top - b.top;
    if (Math.abs(dTop) > 3) return dTop;
    return a.left - b.left;
  });

  const merged: Rect[] = [];
  let current = { ...valid[0] };

  for (let i = 1; i < valid.length; i++) {
    const next = valid[i];
    const isSameVisualLine = Math.abs(current.top - next.top) <= 4;

    if (isSameVisualLine) {
      const currentRight = current.left + current.width;
      // 若下一个矩形与当前矩形相交、包含或接壤（容差 1px 亚像素）
      if (next.left <= currentRight + 1) {
        const newRight = Math.max(currentRight, next.left + next.width);
        current.width = newRight - current.left;
        current.top = Math.min(current.top, next.top);
        current.height = Math.max(current.height, next.height);
      } else {
        merged.push(current);
        current = { ...next };
      }
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

interface SelectionHighlightProps {
  /** 滚动内容容器 ref（与 CursorLayer 同款容器引用，保证坐标系 100% 同步） */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * 显式 store 实例（R5 实例工厂）：缺省 = 全局默认单例（向后兼容）。
   * 多实例场景下选区高亮必须绑定与内容同一实例。
   */
  store?: EditorStore;
  /**
   * R5-D 装饰层统一：引擎共享的装饰集（active/选区/搜索统一数据源）。
   * 缺省（独立挂载/测试场景）时组件经 useStandaloneSelectionDecorations
   * 自维护一份光标/选区装饰集——与引擎同一派生规则，行为一致。
   */
  decorations?: DecorationSet;
  /**
   * R5-D 装饰版本号：光标/选区/搜索变化时递增，驱动选区矩形重测
   * （与 decorations 成对注入；缺省 = 自维护版本）。
   */
  decorationVersion?: number;
}

/**
 * 独立挂载兜底（R5-D）：无引擎注入 decorations/decorationVersion 时，
 * 组件自维护一份光标/选区装饰集——维护逻辑与引擎共用纯函数
 * applyCursorSelectionDecorations（同一 store 状态 → 同一装饰集），
 * 保证「消费 DecorationsSet 的 selection 装饰」在两种接入方式下语义一致。
 * 引擎注入时为短路空转（isExternal 跳过维护，仅保留订阅开销）。
 */
function useStandaloneSelectionDecorations(
  store: EditorStore,
  isExternal: boolean
): { decorations: DecorationSet; version: number } {
  const decorations = useMemo(
    () =>
      new DecorationSet({
        // 行边界经权威 LineOffsetTree 解析（store 实例切换时随 useMemo 重建）
        findLineIndex: (pos) => store.getState().lineOffsets.findLineIndex(pos),
      }),
    [store]
  );
  const [version, setVersion] = useState(0);
  const cursorPos = store((s) => s.cursorPos);
  const selectionStart = store((s) => s.selectionStart);
  const selectionEnd = store((s) => s.selectionEnd);
  useLayoutEffect(() => {
    if (isExternal) return;
    applyCursorSelectionDecorations(
      decorations,
      cursorPos,
      selectionStart,
      selectionEnd
    );
    setVersion((v) => v + 1);
  }, [decorations, isExternal, cursorPos, selectionStart, selectionEnd]);
  return { decorations, version };
}

export const SelectionHighlight: React.FC<SelectionHighlightProps> = ({
  containerRef,
  store,
  decorations: externalDecorations,
  decorationVersion: externalVersion,
}) => {
  // R5：绑定实例 store（缺省回退全局单例）
  const editorStore = store ?? useEditorStore;
  const isExternal =
    externalDecorations !== undefined && externalVersion !== undefined;
  const fallback = useStandaloneSelectionDecorations(editorStore, isExternal);
  const decorations = externalDecorations ?? fallback.decorations;
  const decorationVersion = externalVersion ?? fallback.version;

  const [rects, setRects] = useState<Rect[]>([]);

  useEffect(() => {
    // R5-D 数据源统一：选区矩形消费 selection 装饰（取代 store 的
    // selectionStart/selectionEnd 直读）。选区折叠时引擎只写 active
    // 装饰、不写 selection 装饰——此处 getKind 为空即「无选区」，
    // 与旧实现 selectionStart === selectionEnd 的提前返回等价。
    const sel = decorations.getKind('selection')[0];
    if (!sel || sel.from === sel.to) {
      setRects([]);
      return;
    }

    const start = sel.from;
    const end = sel.to;

    const container = (containerRef?.current ||
      document.querySelector('.editor-scroll-container') ||
      document.querySelector('.engine-container')) as HTMLElement;
    if (!container) return;

    const tableState = useTableStore.getState();
    const isCellSelectionMode = Boolean(
      tableState.selectedCell && !tableState.selectedCell.isEditing
    );

    const containerRect = container.getBoundingClientRect();
    const newRects: Rect[] = [];

    // 1. 物理真理源：按行提取选区在每个视觉折行上的独立矩形，严格杜绝跨行 block 容器包含产生的 100% 容器宽矩形与双层叠色
    const lines = Array.from(container.querySelectorAll('[data-line-start]'));
    for (const line of lines) {
      const lineStart = parseInt(
        line.getAttribute('data-line-start') || '0',
        10
      );
      const lineLen = parseInt(
        line.getAttribute('data-line-length') || '0',
        10
      );
      const lineEnd = lineStart + lineLen;

      if (start <= lineEnd && end >= lineStart) {
        // 空行特殊处理：跨空行选区补充占位矩形（空行在 DOM 中为 <br />，Range.getClientRects 经常为 0x0）
        if (lineLen === 0) {
          const lineRect = line.getBoundingClientRect();
          newRects.push({
            top: lineRect.top - containerRect.top + container.scrollTop,
            left: lineRect.left - containerRect.left + container.scrollLeft,
            width: 5,
            height: lineRect.height || 28,
          });
          continue;
        }

        const selStart = Math.max(start, lineStart);
        const selEnd = Math.min(end, lineEnd);

        if (selStart < selEnd) {
          const p1 = getDOMPointFromIndex(selStart, container);
          const p2 = getDOMPointFromIndex(selEnd, container);
          if (p1 && p2) {
            try {
              const range = document.createRange();
              range.setStart(p1.node, p1.offset);
              range.setEnd(p2.node, p2.offset);
              const clientRects = range.getClientRects();

              for (let i = 0; i < clientRects.length; i++) {
                const r = clientRects[i];
                if (r.width <= 0 || r.height <= 0) continue;

                // 单元格单选/多选模式下，表格自身具备油墨蓝背景与边框，抑制重复文本高亮层
                if (isCellSelectionMode) {
                  const elAtPoint = document.elementFromPoint(
                    r.left + r.width / 2,
                    r.top + r.height / 2
                  );
                  if (
                    elAtPoint &&
                    elAtPoint.closest('.token-table-cell, .line-table-row')
                  ) {
                    continue;
                  }
                }

                // 过滤异常的整行/整容器级别的大块盒模型（例如父级 block div）
                if (r.width >= containerRect.width - 20) continue;

                newRects.push({
                  top: r.top - containerRect.top + container.scrollTop,
                  left: r.left - containerRect.left + container.scrollLeft,
                  width: r.width,
                  height: r.height,
                });
              }
            } catch (err) {
              console.error('getClientRects failed:', err);
            }
          }
        }
      }
    }

    // 3. 次级几何兜底（未挂载/无布局环境/单测无 Range getClientRects 时）
    if (newRects.length === 0 && lines.length > 0) {
      const startCoord = getCoordinatesFromIndex(start, container);
      const endCoord = getCoordinatesFromIndex(end, container);

      for (const line of lines) {
        const lineStart = parseInt(
          line.getAttribute('data-line-start') || '0',
          10
        );
        const lineLen = parseInt(
          line.getAttribute('data-line-length') || '0',
          10
        );
        const lineEnd = lineStart + lineLen;

        if (start <= lineEnd && end >= lineStart) {
          const isTableRow = Boolean(line.querySelector('.line-table-row'));
          if (isTableRow && isCellSelectionMode) {
            continue;
          }

          const lineRect = line.getBoundingClientRect();
          let left = lineRect.left;
          let right = lineRect.right;

          if (start >= lineStart && start <= lineEnd && startCoord) {
            left = startCoord.left;
          }
          if (end >= lineStart && end <= lineEnd && endCoord) {
            right = endCoord.left;
          }
          if (right < left) {
            right = left + 5;
          }

          let top = lineRect.top - containerRect.top + container.scrollTop;
          let height = lineRect.height;
          if (
            isTableRow &&
            startCoord &&
            start >= lineStart &&
            start <= lineEnd
          ) {
            top = startCoord.top - containerRect.top + container.scrollTop;
            height = startCoord.height;
          }

          newRects.push({
            top,
            left: left - containerRect.left + container.scrollLeft,
            width: Math.max(0, right - left),
            height,
          });
        }
      }
    }

    // 4. 几何区间合并（彻底消除内联元素嵌套与跨层 DOM 产生的重叠矩形与双层叠色）
    const mergedRects = mergeOverlappingRects(newRects);
    setRects(mergedRects);
  }, [decorations, decorationVersion, containerRef]);

  if (rects.length === 0) return null;

  return (
    // 选区层是纯装饰性高亮（光标/选区语义由 textarea 承担，R4-H）：
    // aria-hidden 对屏幕阅读器隐藏，避免朗读无意义的矩形几何信息
    <div
      className="selection-layer"
      aria-hidden="true"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 0 }}
    >
      {rects.map((rect, i) => (
        <div
          key={i}
          className="selection-rect"
          style={{
            position: 'absolute',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            backgroundColor: 'var(--blue-selection)',
            mixBlendMode: 'multiply',
          }}
        />
      ))}
    </div>
  );
};
