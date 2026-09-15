import * as React from 'react';
import type { InlineNode } from '../core/ast';
import type { ListMarkerOccurrence } from '../core/layout/IndentModel';
import { type ActiveState, getSourceIndexFromPoint } from '../core/measure';
// R5-C：数学渲染统一走注入点（renderTheme 模块级；KaTeX 默认，可替换）
import { InlineMath } from './InlineMath';
// P3 B2（plan-A2 方案 B 样式预演）：未闭合行内标记检测结果类型——
// 预演提示经 InlinePreviewContext 由 MarkdownEngine 的 LineItem 注入
import {
  type IncompleteInlineDecoration,
  type IncompleteInlineHint,
} from '../core/decorateIncompleteInline';

import { useTableStore } from '../core/TableStore';
import { getTableIdentity } from '../core/tableIdentity';
import { isSingleCell, lineToRow, normalizeSelection } from '../core/tableSelection';
import { getEditorViewport } from '../core/editorViewport';
import { doubleClickWordSelection } from './HiddenInput';

/**
 * 任务复选框矢量字形（SSOT）：list_task 前缀与行内 [x] checkbox 共用同一
 * 渲染——尺寸/描边/配色只在此定义（--task-* token），严禁再复制 SVG。
 */
const TaskCheckboxGlyph: React.FC<{ checked: boolean }> = ({ checked }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    className="task-checkbox-svg"
    data-source-role="preview"
  >
    {checked ? (
      <>
        <rect
          x="1"
          y="1"
          width="14"
          height="14"
          rx="3.5"
          fill="var(--task-checked-bg, hsl(217 91% 60%))"
          stroke="var(--task-checked-border, hsl(217 91% 60%))"
          strokeWidth="1.2"
        />
        <path
          d="M4.5 8.2L7 10.7L11.5 5.5"
          stroke="hsl(0 0% 100%)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : (
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="3.5"
        fill="transparent"
        stroke="var(--task-unchecked-border, hsl(215 16% 75%))"
        strokeWidth="1.4"
      />
    )}
  </svg>
);
import { Image as ImageIcon } from 'lucide-react';

/**
 * P3 B2 显示层乐观补全（plan-A2 方案 B 样式预演）：
 * 预演提示上下文（值 = decorateIncompleteInline 结果；非预演为 null）。
 * - Provider 由 MarkdownEngine 的 LineItem 注入（不产生 DOM 节点）；
 * - 消费方仅 text token：命中预演段时在既有 span 上追加预演类——
 *   零新 DOM 节点、零 data-* 变化（data-token 映射不变 → 光标测量
 *   零影响）；闭合切换 = 同一节点类微调（is-preview-* → style-*）。
 */
// oxlint-disable-next-line react/only-export-components -- 上下文随组件导出（LineItem 注入消费）
export const InlinePreviewContext = React.createContext<IncompleteInlineDecoration | null>(null);

/** 预演类映射（样式定义见组件内 <style> 块——与真实 style-* 族同参数，
 *  闭合切换肉眼不可察） */
const PREVIEW_CLASS_BY_HINT: Record<IncompleteInlineHint, string> = {
  bold: 'is-preview-bold',
  italic: 'is-preview-italic',
  bold_italic: 'is-preview-bold-italic',
  code: 'is-preview-code',
  strike: 'is-preview-strike',
  math: 'is-preview-math',
};

const ImagePreviewWidget: React.FC<{ url: string; alt: string }> = ({ url, alt }) => {
  const [hasError, setHasError] = React.useState(false);

  if (hasError || !url) {
    return (
      <span className="image-fallback-badge" title={url || '无图片地址'}>
        <ImageIcon size={14} aria-hidden />
        <span>{alt || '图片'}</span>
        <span className="image-fallback-hint">(无法加载)</span>
      </span>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      className="markdown-preview-image"
      onError={() => setHasError(true)}
      loading="lazy"
    />
  );
};

interface InlineRendererProps {
  tokens: InlineNode[];
  lineOffset: number;
  activeState?: ActiveState | null;
  tableId?: string;
  lineIndex?: number;
  listMarkers?: readonly ListMarkerOccurrence[];
}

/**
 * 一个标记只占当前层的一格。祖先缩进由列表行容器统一排布，不能在每个
 * 标记内部重复累计深度。标记源码是原子区间，预览字形不产生字符边界；
 * 移动光标或选中前缀均不切换源码层，复选框也始终保持可操作。
 */
const ListMarkerToken: React.FC<{
  start: number;
  len: number;
  className: string;
  style?: React.CSSProperties;
  depth: number;
  sourceText: string;
  visual: React.ReactNode;
  align: 'center' | 'end';
}> = ({
  start,
  len,
  className,
  style,
  depth,
  sourceText,
  visual,
  align,
}) => (
  <span
    data-token-start={start}
    data-token-length={len}
    data-source-role="atomic"
    data-list-marker-depth={depth}
    className={`list-marker ${className}`}
    style={style}
  >
    <span className={`list-marker-slot is-align-${align}`}>
      <span className="marker-source" data-source-role="hidden">
        {sourceText}
      </span>
      <span className="marker-visual" data-source-role="preview">
        {visual}
      </span>
    </span>
  </span>
);

export const InlineRenderer: React.FC<InlineRendererProps> = React.memo(
  ({ tokens, lineOffset, activeState, tableId, lineIndex, listMarkers }) => {
    const listMarkersByOffset = listMarkers && new Map(listMarkers.map(marker => [marker.sourceStart, marker]));
    const tableWidths = useTableStore(state => tableId ? state.tableWidths[tableId] : null);
    const tableAlignments = useTableStore(state => tableId ? state.tableAlignments[tableId] : null);
    const selectedCell = useTableStore(state => state.selectedCell);
    // P3 B2：预演提示（LineItem 注入；React.memo 不拦截 context 更新——
    // 预演类随提示变化即时刷新，非预演恒 null 引用稳定零重渲染）
    const previewHint = React.useContext(InlinePreviewContext);
    let colIndexCounter = 0;

    return (
      <>
        {/* P3 B2：预演样式定义（仅流式预演期间挂载——非预演不渲染该
            节点；类选择器与真实 style-* 族同参数，闭合切换像素一致） */}
        {previewHint !== null && (
          <style>{`
.is-preview-bold{font-weight:700}
.is-preview-italic{font-style:italic}
.is-preview-bold-italic{font-weight:700;font-style:italic}
.is-preview-strike{text-decoration:line-through}
.is-preview-code{font-family:var(--font-mono);font-size:0.9em}
.is-preview-math{font-style:italic;font-family:'Times New Roman',serif}
`}</style>
        )}
        {tokens.map((token) => {
          const start = lineOffset + token.localOffset;
          const len = token.length;
          // P3 B2 零跳动键（plan-A2 §2）：token key 取「起始偏移」而非
          // 「type-index」——同一源码区间的 token 在类型演化时（text →
          // bold/code/math，如 `**text` 闭合）保持同一 DOM 节点，React
          // 原地更新类与内容：闭合切换 = 类微调（is-preview-* → style-*），
          // 非重建。偏移在行内 token 序列中唯一（顺序无缝覆盖），
          // 各递归层 key 空间独立（子 InlineRenderer 各自 map）。
          const key = `${start}`;

          let className = '';
          switch (token.type) {
            case 'heading_prefix':
              className = 'token-heading-prefix';
              break;
            case 'list_bullet':
              className = 'token-list-bullet';
              break;
            case 'list_number':
              className = 'token-list-number';
              break;
            case 'list_task':
              className = 'interactive-checkbox token-list-task';
              break;
            case 'blockquote_prefix':
              className = 'token-blockquote-prefix';
              break;
            case 'comment':
              className = 'token-comment';
              break;
            case 'string':
              className = 'token-string';
              break;
            case 'keyword':
              className = 'token-keyword';
              break;
            case 'bold':
              className = 'style-bold';
              break;
            case 'italic':
              className = 'style-italic';
              break;
            case 'bold_italic':
              className = 'style-bold-italic';
              break;
            case 'strike':
              className = 'style-strike';
              break;
            case 'code':
              className = 'style-inline-code';
              break;
            case 'mark':
              className = 'style-mark';
              break;
            case 'sub':
              className = 'style-sub';
              break;
            case 'sup':
              className = 'style-sup';
              break;
            case 'kbd':
              className = 'style-kbd';
              break;
            case 'spoiler':
              className = 'style-spoiler';
              break;
            case 'footnote':
              className = 'style-footnote';
              break;
            case 'math':
              className = 'style-math';
              break;
            case 'link':
              className = 'interactive-link';
              break;
            case 'image':
              className = 'style-image';
              break;
            case 'checkbox':
              className = 'interactive-checkbox style-checkbox';
              break;
            case 'html_element': {
              let tagClass = 'token-html-element';
              const tag = (token.tagName || '').toLowerCase();
              if (tag === 'sub') tagClass += ' style-sub';
              else if (tag === 'sup') tagClass += ' style-sup';
              else if (tag === 'kbd') tagClass += ' style-kbd';
              else if (tag === 'b' || tag === 'strong')
                tagClass += ' style-bold';
              else if (tag === 'i' || tag === 'em') tagClass += ' style-italic';
              else if (tag === 's' || tag === 'del' || tag === 'strike')
                tagClass += ' style-strike';
              else if (tag === 'mark') tagClass += ' style-mark';
              else if (tag === 'code') tagClass += ' style-inline-code';
              className = tagClass;
              break;
            }

            case 'table_cell':
              className = 'token-table-cell';
              break;
            case 'table_pipe':
              className = 'token-table-pipe syntax-delimiter';
              break;
            case 'text':
            default:
              break;
          }

          // If a styling token is completely empty of visible content (e.g. **** or ** **),
          // we want to ensure it remains physically clickable/visible so the user can type inside it.
          const isStyleToken = [
            'style-bold',
            'style-italic',
            'style-bold-italic',
            'style-strike',
            'style-inline-code',
            'style-mark',
            'style-sub',
            'style-sup',
            'style-kbd',
            'style-spoiler',
            'style-footnote',
            'style-math',
          ].some(c => className.includes(c));

          const isEmpty =
            isStyleToken &&
            (!token.content || token.content.trim() === '');
            
          let isActive = false;
          let isSelected = false;

          if (activeState) {
            const hasRangeSelection =
              activeState.selStart !== undefined &&
              activeState.selEnd !== undefined &&
              activeState.selStart !== activeState.selEnd;

            if (hasRangeSelection) {
              const selMin = Math.min(activeState.selStart!, activeState.selEnd!);
              const selMax = Math.max(activeState.selStart!, activeState.selEnd!);
              isSelected = start < selMax && (start + len) > selMin;
              // 选区只改变高亮，不能打开多个公式编辑面或改变正文几何。
              isActive = token.type === 'math'
                ? isSelected && selMin >= start && selMax <= start + len
                : isSelected && !token.type.startsWith('list_') && token.type !== 'blockquote_prefix' && token.type !== 'heading_prefix';
            } else {
              // 聚焦光标单点模式：支持键盘左移、边缘点击等触发源码编辑
              if (token.type.startsWith('list_')) {
                // 列表前缀是原子交互面，光标与选区都不能将控件切成源码。
                isActive = false;
              } else if (token.type === 'blockquote_prefix') {
                // 引用行激活时呈现源码模式 `> `
                isActive = true;
              } else {
                isActive = activeState.cursor >= start && activeState.cursor <= start + len;
              }
            }
          }

          const baseClassName = isEmpty ? `${className} is-empty-token` : className;
          let finalClassName = isActive ? `${baseClassName} is-active-token` : baseClassName;
          if (isSelected) {
            finalClassName += ' is-selected-token';
          }
          // P3 B2：预演段判定（仅 text token）——token 与预演段
          // [previewStart, 行尾) 重叠即命中。未闭合 `**text` 整段是一个
          // text token（含标记字符原文），与预演段部分重叠时对整个既有
          // span 追加预演类：零新 DOM 节点、不拆 token、不改 data-token
          // 映射（测量零影响）；闭合后同一节点切换为真实样式类。
          const previewClass =
            previewHint !== null &&
            previewHint.previewStart !== undefined &&
            previewHint.hint !== undefined &&
            token.type === 'text' &&
            token.localOffset + len > previewHint.previewStart
              ? ` ${PREVIEW_CLASS_BY_HINT[previewHint.hint]}`
              : '';
          if (previewClass) {
            finalClassName += previewClass;
          }

          // Specialized KaTeX rendering for math formulas
          if (token.type === 'math') {
            return (
              <span key={key} data-token-start={start} data-token-length={len} className={finalClassName}>
                <InlineMath token={token} start={start} className="" active={isActive} />
              </span>
            );
          }

          if (token.type === 'image') {
            const url = token.url || '';
            const alt = token.content || '图片';
            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={`${finalClassName} token-image-wrapper`}
                style={token.style}
              >
                <span className="syntax-hidden" data-sub-offset={0}>
                  {token.raw}
                </span>
                <span className="syntax-content">
                  <ImagePreviewWidget url={url} alt={alt} />
                </span>
              </span>
            );
          }

          // Specialized <br> handling (html_tag / html_element):
          // Render a real visual line break in rendered mode, while preserving source for live preview editing.
          if (token.type === 'html_tag' || token.type === 'html_element') {
            const rawLower = (token.raw || '').toLowerCase().trim();
            if (rawLower === '<br>' || rawLower === '<br/>' || rawLower === '<br />') {
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  className={`${finalClassName} token-br-wrapper`}
                  style={token.style}
                >
                  <span className="syntax-hidden" data-sub-offset={0}>
                    {token.raw}
                  </span>
                  <span className="syntax-content">
                    <br className="token-br" />
                  </span>
                </span>
              );
            }
          }

          if (token.type === 'text') {
            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                data-source-role="text"
                data-source-boundaries={token.sourceBoundaries ? JSON.stringify(token.sourceBoundaries) : undefined}
                className={finalClassName}
                style={token.style}
              >
                {token.content}
              </span>
            );
          }

          if (token.type === 'table_cell') {
            const colIndex = colIndexCounter++;
            // 表格状态使用不含分隔行的相对行号；源码行号只经语义模型换算。
            const identity = getTableIdentity(tableId);
            const rowIndex = identity && lineIndex !== undefined
              ? lineToRow(lineIndex, identity.startLine, identity.endLine, identity.separatorLine)
              : null;
            const cell = rowIndex === null ? null : { row: rowIndex, col: colIndex };

            // 从属合并单元格 (isMergedSlave: > 或 ^)：在非源码激活态下彻底隐藏
            if (token.isMergedSlave && !isActive) {
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  data-col-index={colIndex}
                  data-line-index={lineIndex}
                  data-row-index={rowIndex ?? undefined}
                  data-table-id={tableId}
                  className="token-table-cell token-table-cell-slave"
                  style={{ display: 'none' }}
                />
              );
            }

            // 计算跨列物理总宽
            let cellWidth = 0;
            if (token.isMergedMaster && token.colSpan && token.colSpan > 1) {
              for (let c = 0; c < token.colSpan; c++) {
                cellWidth += tableWidths?.[colIndex + c] ?? 100;
              }
            } else {
              cellWidth = tableWidths?.[colIndex] ?? 0;
            }

            const cellStyle: React.CSSProperties = cellWidth > 0
              ? { ...token.style, flex: `0 0 ${cellWidth}px`, minWidth: `${cellWidth}px` }
              : { ...token.style, minWidth: '100px', flex: '1 0 auto' };

            // 动态列文本对齐 (左对齐 / 居中 / 右对齐)
            const align = tableAlignments?.[colIndex] || 'left';
            if (align === 'center') {
              cellStyle.justifyContent = 'center';
              cellStyle.textAlign = 'center';
            } else if (align === 'right') {
              cellStyle.justifyContent = 'flex-end';
              cellStyle.textAlign = 'right';
            } else {
              cellStyle.justifyContent = 'flex-start';
              cellStyle.textAlign = 'left';
            }
            
            const cellSelection = selectedCell?.tableId === tableId ? selectedCell : null;
            const bounds = cellSelection ? normalizeSelection(cellSelection) : null;
            const isCellSelected = rowIndex !== null && bounds !== null &&
              rowIndex >= bounds.r0 && rowIndex <= bounds.r1 &&
              colIndex >= bounds.c0 && colIndex <= bounds.c1;

            const isCellEditing = isCellSelected && cellSelection !== null &&
              cellSelection.isEditing && isSingleCell(cellSelection);

            let selectionShadow = '';
            let isBottomRight = false;
            if (isCellSelected && bounds && cellSelection) {
              if (isCellEditing) {
                finalClassName += ' is-cell-editing';
              } else {
                finalClassName += ' is-cell-selected';
                const shadows = [];
                const borderToken = 'var(--border-focus)';
                if (isSingleCell(cellSelection)) {
                  selectionShadow = `0 0 0 1.5px ${borderToken}`;
                  cellStyle.borderRadius = '2px';
                  cellStyle.zIndex = 'var(--z-table-cell)';
                  isBottomRight = true;
                } else {
                  if (rowIndex === bounds.r0) shadows.push(`inset 0 1.5px 0 0 ${borderToken}`);
                  if (rowIndex === bounds.r1) shadows.push(`inset 0 -1.5px 0 0 ${borderToken}`);
                  if (colIndex === bounds.c0) shadows.push(`inset 1.5px 0 0 0 ${borderToken}`);
                  if (colIndex === bounds.c1) shadows.push(`inset -1.5px 0 0 0 ${borderToken}`);

                  selectionShadow = shadows.join(', ');
                  if (rowIndex === bounds.r1 && (colIndex === bounds.c1 || (!!token.colSpan && colIndex + token.colSpan - 1 >= bounds.c1))) {
                    finalClassName += ' is-selection-bottom-right';
                    isBottomRight = true;
                  }
                }
              }
            }
            if (selectionShadow) {
              cellStyle.boxShadow = selectionShadow;
            }

            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                data-col-index={colIndex}
                data-line-index={lineIndex}
                data-row-index={rowIndex ?? undefined}
                data-table-id={tableId}
                className={finalClassName}
                style={cellStyle}
                onMouseDown={(e) => {
                  if (e.button === 2 || !cell || !tableId) return;

                  const tableStore = useTableStore.getState();
                  const editorContainer = e.currentTarget.closest<HTMLElement>('.editor-scroll-container');
                  if (!editorContainer) return;
                  const editorStore = getEditorViewport(editorContainer)?.store.getState();
                  if (!editorStore) return;

                  // 1. Shift+Click: 扩展单元格多选范围
                  const currentSelection = tableStore.selectedCell;
                  if (e.shiftKey && currentSelection?.tableId === tableId) {
                    tableStore.enterCellSelection(tableId, currentSelection.anchor, cell);
                    e.preventDefault?.();
                    return;
                  }

                  // 2. 单元格处于编辑模式 (isCellEditing)：支持单元格内精确物理定位与划词拖选
                  if (isCellEditing) {
                    const targetIdx = getSourceIndexFromPoint(e.clientX, e.clientY, e.currentTarget);
                    if (targetIdx === null) return;
                    const clampedIdx = Math.max(start, Math.min(start + len, targetIdx));
                    editorStore.setSelection(clampedIdx, clampedIdx);
                    editorStore.setCursorPos(clampedIdx);

                    (window as any).__CRISH_CELL_TEXT_DRAG = {
                      cellEl: e.currentTarget,
                      start,
                      len,
                      anchorIdx: clampedIdx,
                    };

                    e.preventDefault?.();
                    setTimeout(() => {
                      const input = editorContainer.querySelector('textarea');
                      if (input) input.focus({ preventScroll: true });
                    }, 0);
                    return;
                  }

                  // 3. 单元格已单选且二次点击同一单元格：进入就地文本编辑
                  if (
                    isCellSelected &&
                    cellSelection &&
                    !cellSelection.isEditing &&
                    isSingleCell(cellSelection)
                  ) {
                    tableStore.enterCellEdit({ tableId, ...cell });
                    tableStore.setDraggingCell(false);

                    const targetIdx = getSourceIndexFromPoint(e.clientX, e.clientY, e.currentTarget);
                    if (targetIdx === null) return;
                    const clampedIdx = Math.max(start, Math.min(start + len, targetIdx));
                    editorStore.setSelection(clampedIdx, clampedIdx);
                    editorStore.setCursorPos(clampedIdx);
                    e.preventDefault?.();
                    setTimeout(() => {
                      const input = editorContainer.querySelector('textarea');
                      if (input) input.focus({ preventScroll: true });
                    }, 0);
                    return;
                  }

                  // 4. 单击/拖选进入单元格选择模式（支持从该单元格向外拖选多单元格）
                  tableStore.enterCellSelection(tableId, cell);
                  tableStore.setDraggingCell(true);
                  window.getSelection()?.removeAllRanges();
                  editorStore.setSelection(start, start);
                  editorStore.setCursorPos(start);
                  e.preventDefault?.();

                  setTimeout(() => {
                    const input = editorContainer.querySelector('textarea');
                    if (input) input.focus({ preventScroll: true });
                  }, 0);
                }}
                onMouseEnter={() => {
                  const tableStore = useTableStore.getState();
                  if (cell && tableStore.isDraggingCell && tableStore.selectedCell?.tableId === tableId) {
                    tableStore.updateCellSelectionEnd(cell);
                    window.getSelection()?.removeAllRanges();
                  }
                }}
                onMouseMove={() => {
                  const tableStore = useTableStore.getState();
                  const selection = tableStore.selectedCell;
                  if (cell && selection && tableStore.isDraggingCell && selection.tableId === tableId) {
                    if (selection.focus.row !== cell.row || selection.focus.col !== cell.col) {
                      tableStore.updateCellSelectionEnd(cell);
                      window.getSelection()?.removeAllRanges();
                    }
                  }
                }}
                onMouseUp={(e) => {
                  if (e.button === 2) return;
                  const tableStore = useTableStore.getState();
                  if (tableStore.isDraggingCell) {
                    tableStore.setDraggingCell(false);
                    if (cell && tableStore.selectedCell?.tableId === tableId) {
                      tableStore.updateCellSelectionEnd(cell);
                    }
                    (window as any).__CRISH_LAST_DRAG_END_TIME = Date.now();
                  }
                }}
                onDoubleClick={(e) => {
                  if (!cell || !tableId) return;
                  const tableStore = useTableStore.getState();
                  const editorContainer = e.currentTarget.closest<HTMLElement>('.editor-scroll-container');
                  if (!editorContainer) return;
                  const editorStore = getEditorViewport(editorContainer)?.store.getState();
                  if (!editorStore) return;
                  const targetIdx = getSourceIndexFromPoint(e.clientX, e.clientY, e.currentTarget);
                  if (!isCellEditing || targetIdx !== null) window.getSelection()?.removeAllRanges();

                  if (!isCellEditing) {
                    tableStore.enterCellEdit({ tableId, ...cell });
                    // 进入编辑不依赖文字命中。start 是解析器给出的单元格内容边界，
                    // 空格或空单元格也能从此开始输入，不以猜测像素替代命中结果。
                    const clampedIdx = targetIdx === null
                      ? start
                      : Math.max(start, Math.min(start + len, targetIdx));
                    editorStore.setSelection(clampedIdx, clampedIdx);
                    editorStore.setCursorPos(clampedIdx);
                  } else {
                    if (targetIdx === null) return;
                    const clampedIdx = Math.max(start, Math.min(start + len, targetIdx));
                    // 已处于就地编辑状态：双击触发单元格内词级划词选区
                    const cellText = token.raw || '';
                    const offsetInCell = clampedIdx - start;
                    const sel = doubleClickWordSelection(cellText, offsetInCell);
                    if (sel) {
                      editorStore.setSelection(start + sel.start, start + sel.end);
                    } else {
                      editorStore.setSelection(clampedIdx, clampedIdx);
                      editorStore.setCursorPos(clampedIdx);
                    }
                  }
                  const input = (editorContainer.querySelector('.hidden-input') ||
                    editorContainer.querySelector('textarea')) as HTMLTextAreaElement | null;
                  if (input) input.focus({ preventScroll: true });
                }}
                onContextMenu={(e) => {
                  // Shift + 右键：放行 Chrome 原生上下文菜单（识别复制/搜索/翻译）
                  if (e.shiftKey || !cell || !tableId) return;

                  // Prevent default context menu and trigger our custom one
                  e.preventDefault();
                  e.stopPropagation();
                  
                  const tableStore = useTableStore.getState();
                  // If cell is not selected, select it first
                  if (!isCellSelected) {
                    tableStore.enterCellSelection(tableId, cell);
                  }
                  
                  // Dispatch custom event to ContextMenu component
                  const event = new CustomEvent('open-table-context-menu', {
                    detail: {
                      x: e.clientX,
                      y: e.clientY,
                      isEditing: isCellEditing,
                      tableId: tableId,
                    }
                  });
                  window.dispatchEvent(event);
                }}
              >
                <span className="cell-content-wrapper" style={{ width: '100%' }}>
                  {token.children && (
                    <InlineRenderer
                      tokens={token.children}
                      lineOffset={lineOffset}
                      activeState={isCellEditing ? activeState : undefined}
                      tableId={tableId}
                      lineIndex={lineIndex}
                    />
                  )}
                </span>
                {isBottomRight && (
                  <span className="table-fill-handle" aria-hidden="true" />
                )}
              </span>
            );
          }

          if (token.type === 'list_number' || token.type === 'list_bullet' || token.type === 'list_task') {
            const occurrence = listMarkersByOffset?.get(token.localOffset);
            if (!occurrence) throw new Error('列表标记必须携带解析器的容器轨迹');
            const { markerStart, contentStart, marker, depth } = occurrence;
            const taskRange = marker.taskRange;
            const handleTaskClick = (e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              const container = e.currentTarget.closest<HTMLElement>('.editor-scroll-container');
              if (!container || !taskRange || container.dataset.readonly === 'true') return;
              const viewport = getEditorViewport(container);
              viewport?.flushPending();
              const state = viewport?.store.getState();
              if (!state || state.readOnly) return;
              // 任务范围来自解析器；事务同时保留方向选区，不挪动正文光标。
              state.applyChange(
                lineOffset + markerStart + taskRange.from,
                lineOffset + markerStart + taskRange.to,
                token.isChecked ? '[ ]' : '[x]',
                { selectionAfter: { anchor: state.anchorPos, head: state.headPos }, merge: 'none' },
              );
            };
            return (
              <ListMarkerToken
                key={key}
                start={lineOffset + markerStart}
                len={contentStart - markerStart}
                className={finalClassName}
                style={token.style}
                depth={depth}
                sourceText={token.raw.slice(markerStart - token.localOffset, contentStart - token.localOffset)}
                visual={
                  <>
                    {marker.kind === 'ol' && (
                      <span className="token-number-char" data-source-role="preview" aria-hidden="true">
                        {marker.structuralPrefix}
                      </span>
                    )}
                    {!taskRange && marker.kind !== 'ol' && (
                      <span className="token-bullet-char" data-source-role="preview" aria-hidden="true">•</span>
                    )}
                    {taskRange && (
                      <button
                        className="task-checkbox-wrapper"
                        type="button"
                        data-source-role="preview"
                        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={handleTaskClick}
                        role="checkbox"
                        aria-checked={!!token.isChecked}
                        aria-label={token.isChecked ? '标记为未完成' : '标记为已完成'}
                      >
                        <TaskCheckboxGlyph checked={!!token.isChecked} />
                      </button>
                    )}
                  </>
                }
                align={marker.kind === 'ol' ? 'end' : 'center'}
              />
            );
          }

          if (token.type === 'blockquote_prefix') {
            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={finalClassName}
                style={{
                  ...token.style,
                  width: `${len}ch`,
                }}
              >
                <span className="syntax-hidden" data-sub-offset={0}>
                  {token.raw}
                </span>
                <span className="syntax-content" data-sub-offset={len - 1}>
                  <span className="blockquote-bar" aria-hidden="true" />
                  <span className="blockquote-space">
                    {' '}
                  </span>
                </span>
              </span>
            );
          }

          if (token.type === 'checkbox') {
            // 行内 [x] 任务标记：矢量复选框（与 list_task 同一 Glyph——SSOT）；
            // 语法原文恒以 syntax-hidden 承载（测量/选区 data 映射不变）
            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={finalClassName}
                style={token.style}
              >
                <span className="syntax-hidden" data-sub-offset={0}>
                  {token.raw}
                </span>
                <span className="syntax-content" data-sub-offset={len - 1}>
                  <TaskCheckboxGlyph checked={!!token.isChecked} />
                </span>
              </span>
            );
          }

          // If it's a token with `content` different from `raw`
          if (token.content !== undefined && token.content !== token.raw) {
            const prefixLen = token.contentOffset;
            if (prefixLen !== undefined) {
              // 内容边界来自解析器，属性值和重复文字不会改变源码定位。
              const sourceLength = token.contentSourceLength ?? token.content.length;
              const prefix = token.raw.substring(0, prefixLen);
              const suffix = token.raw.substring(
                prefixLen + sourceLength
              );
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  className={finalClassName}
                  style={token.style}
                >
                  {prefix && (
                    <span data-sub-offset={0} className="syntax-hidden">
                      {prefix}
                    </span>
                  )}
                  <span
                    data-sub-offset={prefixLen}
                    data-source-role="text"
                    data-source-boundaries={token.sourceBoundaries ? JSON.stringify(token.sourceBoundaries) : undefined}
                  >
                    {token.children ? (
                      <InlineRenderer
                        tokens={token.children}
                        lineOffset={lineOffset}
                        activeState={activeState}
                      />
                    ) : (
                      token.content
                    )}
                  </span>
                  {suffix && (
                    <span
                      data-sub-offset={prefixLen + sourceLength}
                      className="syntax-hidden"
                    >
                      {suffix}
                    </span>
                  )}
                </span>
              );
            } else {
              // Complete replacement case (e.g. heading_prefix "## " -> "")
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  className={finalClassName}
                  style={token.style}
                >
                  <span data-sub-offset={0} className="syntax-hidden">
                    {token.raw}
                  </span>
                  <span className="syntax-content">
                    {token.content}
                  </span>
                </span>
              );
            }
          }

          return (
            <span
              key={key}
              data-token-start={start}
              data-token-length={len}
              className={finalClassName}
              style={token.style}
            >
              {token.raw}
            </span>
          );
        })}
      </>
    );
  }
);
