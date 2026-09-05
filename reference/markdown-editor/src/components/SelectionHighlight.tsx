import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useEditorStore, type EditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { getCoordinatesFromIndex } from '../core/measure';
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

    const startCoord = getCoordinatesFromIndex(start, container);
    const endCoord = getCoordinatesFromIndex(end, container);

    const lines = Array.from(container.querySelectorAll('[data-line-start]'));
    if (lines.length === 0) {
      setRects([]);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const newRects: Rect[] = [];

    for (const line of lines) {
      const lineStart = parseInt(line.getAttribute('data-line-start') || '0', 10);
      const lineLen = parseInt(line.getAttribute('data-line-length') || '0', 10);
      const lineEnd = lineStart + lineLen;

      if (start <= lineEnd && end >= lineStart) {
        // Line intersects with selection
        const isTableRow = Boolean(line.querySelector('.line-table-row'));
        // 单元格单选/拖选模式下，表格自身具备油墨蓝背景与边框，抑制重复文本高亮层
        if (isTableRow && isCellSelectionMode) {
          continue;
        }

        const lineRect = line.getBoundingClientRect();

        let left = lineRect.left;
        let right = lineRect.right;

        // If this is the start line, restrict left side
        if (start >= lineStart && start <= lineEnd && startCoord) {
          left = startCoord.left;
        }

        // If this is the end line, restrict right side
        if (end >= lineStart && end <= lineEnd && endCoord) {
          right = endCoord.left;
        }

        // For empty lines selected across
        if (right < left) {
          right = left + 5; // minimum width
        }

        let top = lineRect.top - containerRect.top + container.scrollTop;
        let height = lineRect.height;

        // 表格行编辑态：选区高度贴合文本字高，消除 54px 全高灰色矩形
        if (isTableRow && startCoord && start >= lineStart && start <= lineEnd) {
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

    setRects(newRects);
  }, [decorations, decorationVersion]);

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
