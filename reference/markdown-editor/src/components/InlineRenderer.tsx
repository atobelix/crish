import * as React from 'react';
import type { InlineNode } from '../core/ast';
import { type ActiveState, locateRowIndexByPhysicalBisection } from '../core/measure';
// R5-C：数学渲染统一走注入点（renderTheme 模块级；KaTeX 默认，可替换）
import { renderMathToHtml } from '../core/renderTheme';
// P3 B2（plan-A2 方案 B 样式预演）：未闭合行内标记检测结果类型——
// 预演提示经 InlinePreviewContext 由 MarkdownEngine 的 LineItem 注入
import {
  type IncompleteInlineDecoration,
  type IncompleteInlineHint,
} from '../core/decorateIncompleteInline';

import { useTableStore } from '../core/TableStore';
import { useEditorStore } from '../core/EditorStore';
import { doubleClickWordSelection, indexFromClientPoint } from './HiddenInput';

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

function computeIndentGuides(
  indentLen: number,
  lineIndex?: number
): { indentStep: number; indentGuidesCount: number } {
  if (indentLen <= 0) return { indentStep: 2, indentGuidesCount: 0 };
  let indentStep = 2;
  if (indentLen % 3 === 0 && indentLen % 2 !== 0) {
    indentStep = 3;
  } else if (indentLen >= 6 && indentLen % 3 === 0) {
    const prevLine =
      lineIndex !== undefined && lineIndex > 0
        ? useEditorStore.getState().getLine(lineIndex - 1)
        : null;
    const prevIndent = prevLine
      ? (prevLine.match(/^ +/)?.[0]?.length || 0)
      : 0;
    indentStep = prevIndent === 3 || prevIndent === 6 ? 3 : 2;
  }
  const indentGuidesCount = Math.floor(indentLen / indentStep);
  return { indentStep, indentGuidesCount };
}

const ImagePreviewWidget: React.FC<{ url: string; alt: string }> = ({ url, alt }) => {
  const [hasError, setHasError] = React.useState(false);

  if (hasError || !url) {
    return (
      <span className="image-fallback-badge" title={url || '无图片地址'}>
        <span aria-hidden="true">🖼️</span>
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
}

export const InlineRenderer: React.FC<InlineRendererProps> = React.memo(
  ({ tokens, lineOffset, activeState, tableId, lineIndex }) => {
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
              // 划词选中区域时统一展开源码模式（混合渲染核心不变量：选区覆盖处皆为源码，所见即所得，零只渲染开倒车）
              isActive = isSelected;
            } else {
              // 聚焦光标单点模式：支持键盘左移、边缘点击等触发源码编辑
              if (token.type === 'list_bullet' || token.type === 'list_number') {
                isActive = activeState.cursor >= start && activeState.cursor < start + len;
              } else if (token.type === 'list_task') {
                // 光标在任务项前缀区间内（键盘移动/边缘点击）触发源码模式；光标移至正文则恢复控件
                isActive = activeState.cursor >= start && activeState.cursor < start + len;
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
            const isDisplay = token.raw.startsWith('$$');
            const formula = token.content || '';
            const katexHtml = renderMathToHtml(formula, isDisplay);
            const prefix = isDisplay ? '$$' : '$';
            const suffix = isDisplay ? '$$' : '$';

            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={`${finalClassName} token-math-wrapper`}
                style={token.style}
              >
                <span
                  className="math-preview"
                  dangerouslySetInnerHTML={{ __html: katexHtml }}
                />
                <span data-sub-offset={0} className="math-source syntax-hidden">
                  <span className="syntax-delimiter">{prefix}</span>
                  <span
                    data-sub-offset={prefix.length}
                    className="token-content"
                  >
                    {formula}
                  </span>
                  <span
                    data-sub-offset={prefix.length + formula.length}
                    className="syntax-delimiter"
                  >
                    {suffix}
                  </span>
                </span>
              </span>
            );
          }

          if (token.type === 'image') {
            const url = token.url || '';
            const alt = token.content ? token.content.replace(/^🖼️\s*/, '') : '图片';
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
                className={finalClassName}
                style={token.style}
              >
                {isActive ? token.raw : token.content}
              </span>
            );
          }

          if (token.type === 'table_cell') {
            const colIndex = colIndexCounter++;

            // 从属合并单元格 (isMergedSlave: > 或 ^)：在非源码激活态下彻底隐藏
            if (token.isMergedSlave && !isActive) {
              return (
                <span
                  key={key}
                  data-token-start={start}
                  data-token-length={len}
                  data-col-index={colIndex}
                  data-line-index={lineIndex}
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
            
            const isCellSelected = selectedCell &&
              lineIndex !== undefined &&
              tableId === selectedCell.tableId &&
              lineIndex >= Math.min(selectedCell.startLine, selectedCell.endLine) &&
              lineIndex <= Math.max(selectedCell.startLine, selectedCell.endLine) &&
              colIndex >= Math.min(selectedCell.startCol, selectedCell.endCol) &&
              colIndex <= Math.max(selectedCell.startCol, selectedCell.endCol);
              
            const isCellEditing = isCellSelected && selectedCell?.isEditing && selectedCell.startLine === selectedCell.endLine && selectedCell.startCol === selectedCell.endCol;

            let selectionShadow = '';
            let isBottomRight = false;
            if (isCellSelected) {
              if (isCellEditing) {
                finalClassName += ' is-cell-editing';
              } else {
                finalClassName += ' is-cell-selected';
                const shadows = [];
                const minLine = Math.min(selectedCell.startLine, selectedCell.endLine);
                const maxLine = Math.max(selectedCell.startLine, selectedCell.endLine);
                const minCol = Math.min(selectedCell.startCol, selectedCell.endCol);
                const maxCol = Math.max(selectedCell.startCol, selectedCell.endCol);
                
                const borderToken = 'var(--border-focus)';
                const isSingleCell = minLine === maxLine && minCol === maxCol;
                if (isSingleCell) {
                  selectionShadow = `0 0 0 1.5px ${borderToken}`;
                  cellStyle.borderRadius = '2px';
                  cellStyle.zIndex = 3;
                  isBottomRight = true;
                } else {
                  if (lineIndex === minLine) shadows.push(`inset 0 1.5px 0 0 ${borderToken}`);
                  if (lineIndex === maxLine) shadows.push(`inset 0 -1.5px 0 0 ${borderToken}`);
                  if (colIndex === minCol) shadows.push(`inset 1.5px 0 0 0 ${borderToken}`);
                  if (colIndex === maxCol) shadows.push(`inset -1.5px 0 0 0 ${borderToken}`);

                  selectionShadow = shadows.join(', ');
                  if (lineIndex === maxLine && (colIndex === maxCol || (!!token.colSpan && colIndex + token.colSpan - 1 >= maxCol))) {
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
                data-table-id={tableId}
                className={finalClassName}
                style={cellStyle}
                onMouseDown={(e) => {
                  if (e.button === 2) return; // Ignore right click

                  const tableStore = useTableStore.getState();
                  const editorStore = useEditorStore.getState();

                  // 1. Shift+Click: 扩展单元格多选范围
                  if (e.shiftKey && selectedCell && selectedCell.tableId === tableId) {
                    tableStore.updateCellSelectionEnd(lineIndex ?? -1, colIndex);
                    e.preventDefault?.();
                    return;
                  }

                  // 2. 单元格处于编辑模式 (isCellEditing)：支持单元格内精确物理定位与划词拖选
                  if (isCellEditing) {
                    const targetIdx = locateRowIndexByPhysicalBisection(
                      e.currentTarget,
                      e.clientX,
                      start,
                      len,
                      e.clientY
                    ) ?? start;
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
                      const input = document.querySelector('textarea') as HTMLTextAreaElement;
                      if (input) input.focus({ preventScroll: true });
                    }, 0);
                    return;
                  }

                  // 3. 单元格已单选且二次点击同一单元格：进入就地文本编辑
                  if (
                    isCellSelected &&
                    !selectedCell?.isEditing &&
                    selectedCell?.startLine === selectedCell?.endLine &&
                    selectedCell?.startCol === selectedCell?.endCol &&
                    selectedCell?.startLine === lineIndex &&
                    selectedCell?.startCol === colIndex
                  ) {
                    tableStore.enterCellEdit(tableId || '', lineIndex ?? -1, colIndex);
                    tableStore.setDraggingCell(false);

                    const targetIdx = locateRowIndexByPhysicalBisection(
                      e.currentTarget,
                      e.clientX,
                      start,
                      len,
                      e.clientY
                    ) ?? start;
                    const clampedIdx = Math.max(start, Math.min(start + len, targetIdx));
                    editorStore.setSelection(clampedIdx, clampedIdx);
                    editorStore.setCursorPos(clampedIdx);
                    e.preventDefault?.();
                    setTimeout(() => {
                      const input = document.querySelector('textarea') as HTMLTextAreaElement;
                      if (input) input.focus({ preventScroll: true });
                    }, 0);
                    return;
                  }

                  // 4. 单击/拖选进入单元格选择模式（支持从该单元格向外拖选多单元格）
                  tableStore.enterCellSelection(tableId || '', lineIndex ?? -1, colIndex);
                  tableStore.setDraggingCell(true);
                  window.getSelection()?.removeAllRanges();
                  editorStore.setSelection(start, start);
                  editorStore.setCursorPos(start);
                  e.preventDefault?.();

                  setTimeout(() => {
                    const input = document.querySelector('textarea') as HTMLTextAreaElement;
                    if (input) input.focus({ preventScroll: true });
                  }, 0);
                }}
                onMouseEnter={() => {
                  const tableStore = useTableStore.getState();
                  if (tableStore.isDraggingCell) {
                    tableStore.updateCellSelectionEnd(lineIndex ?? -1, colIndex);
                    window.getSelection()?.removeAllRanges();
                  }
                }}
                onMouseMove={() => {
                  const tableStore = useTableStore.getState();
                  if (tableStore.isDraggingCell && tableStore.selectedCell) {
                    if (tableStore.selectedCell.endLine !== lineIndex || tableStore.selectedCell.endCol !== colIndex) {
                      tableStore.updateCellSelectionEnd(lineIndex ?? -1, colIndex);
                      window.getSelection()?.removeAllRanges();
                    }
                  }
                }}
                onMouseUp={(e) => {
                  if (e.button === 2) return;
                  const tableStore = useTableStore.getState();
                  if (tableStore.isDraggingCell) {
                    tableStore.setDraggingCell(false);
                    tableStore.updateCellSelectionEnd(lineIndex ?? -1, colIndex);
                    (window as any).__CRISH_LAST_DRAG_END_TIME = Date.now();
                  }
                }}
                onDoubleClick={(e) => {
                  window.getSelection()?.removeAllRanges();
                  const tableStore = useTableStore.getState();
                  const editorStore = useEditorStore.getState();
                  const targetIdx = locateRowIndexByPhysicalBisection(
                    e.currentTarget,
                    e.clientX,
                    start,
                    len,
                    e.clientY
                  ) ?? start;
                  const clampedIdx = Math.max(start, Math.min(start + len, targetIdx));

                  if (!isCellEditing) {
                    tableStore.enterCellEdit(
                      tableId || '',
                      lineIndex ?? -1,
                      colIndex
                    );
                    editorStore.setSelection(clampedIdx, clampedIdx);
                    editorStore.setCursorPos(clampedIdx);
                  } else {
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
                  const input = (document.querySelector('.hidden-input') ||
                    document.querySelector('textarea')) as HTMLTextAreaElement;
                  if (input) input.focus({ preventScroll: true });
                }}
                onContextMenu={(e) => {
                  // Shift + 右键：放行 Chrome 原生上下文菜单（识别复制/搜索/翻译）
                  if (e.shiftKey) return;

                  // Prevent default context menu and trigger our custom one
                  e.preventDefault();
                  e.stopPropagation();
                  
                  const tableStore = useTableStore.getState();
                  // If cell is not selected, select it first
                  if (!isCellSelected) {
                    tableStore.enterCellSelection(tableId || '', lineIndex ?? -1, colIndex);
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

          // Specialized handling for lists (list_number, list_bullet, list_task)
          // Preserves full physical character offset alignment, zero artificial layout boxes
          if (token.type === 'list_number') {
            const indentLen = token.indent ? token.indent.length : 0;
            const { indentStep, indentGuidesCount } = computeIndentGuides(
              indentLen,
              lineIndex
            );

            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={finalClassName}
                style={token.style}
              >
                {token.indent ? (
                  <>
                    <span className="syntax-indent" data-sub-offset={0}>
                      {token.indent}
                      {Array.from({ length: indentGuidesCount }).map((_, i) => (
                        <span
                          key={i}
                          className={`syntax-indent-guide${i === indentGuidesCount - 1 ? ' syntax-indent-guide-current' : ''}`}
                          style={{
                            left: `calc(${i * indentStep}ch + 0.5ch - 0.5px)`,
                          }}
                          aria-hidden="true"
                        />
                      ))}
                    </span>
                    <span
                      className="syntax-marker"
                      data-sub-offset={indentLen}
                    >
                      {token.marker || token.raw.slice(indentLen)}
                    </span>
                  </>
                ) : (
                  <span className="syntax-marker" data-sub-offset={0}>
                    {token.raw}
                  </span>
                )}
              </span>
            );
          }

          if (token.type === 'list_bullet') {
            const indentLen = token.indent ? token.indent.length : 0;
            const { indentStep, indentGuidesCount } = computeIndentGuides(
              indentLen,
              lineIndex
            );

            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={finalClassName}
                style={token.style}
              >
                {token.indent && (
                  <span className="syntax-indent" data-sub-offset={0}>
                    {token.indent}
                    {Array.from({ length: indentGuidesCount }).map((_, i) => (
                      <span
                        key={i}
                        className={`syntax-indent-guide${i === indentGuidesCount - 1 ? ' syntax-indent-guide-current' : ''}`}
                        style={{
                          left: `calc(${i * indentStep}ch + 0.5ch - 0.5px)`,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                  </span>
                )}
                <span
                  className="syntax-hidden"
                  data-sub-offset={indentLen}
                >
                  {token.marker || token.raw.slice(indentLen)}
                </span>
                <span
                  className="syntax-content"
                  data-sub-offset={indentLen}
                >
                  <span className="token-bullet-char" aria-hidden="true">
                    •
                  </span>
                  <span className="bullet-space">{' '}</span>
                </span>
              </span>
            );
          }

          if (token.type === 'list_task') {
            const indentLen = token.indent ? token.indent.length : 0;
            const { indentStep, indentGuidesCount } = computeIndentGuides(
              indentLen,
              lineIndex
            );

            const handleTaskClick = (e: React.MouseEvent) => {
              if (start !== undefined) {
                // 核心交互区点击：功能优先，直接切换完成状态（彻底移除边缘模糊判定）
                e.stopPropagation();
                e.preventDefault();
                const state = useEditorStore.getState();
                const markerOffset = token.raw.indexOf(token.isChecked ? '[x]' : '[ ]');
                const newMarker = token.isChecked ? '[ ]' : '[x]';
                if (markerOffset >= 0) {
                  const from = start + markerOffset;
                  const to = from + 3;
                  const cur = state.cursorPos;
                  state.applyChange(from, to, newMarker, { cursorAfter: cur });
                }
              }
            };
            return (
              <span
                key={key}
                data-token-start={start}
                data-token-length={len}
                className={finalClassName}
                style={token.style}
              >
                {token.indent && (
                  <span className="syntax-indent" data-sub-offset={0}>
                    {token.indent}
                    {Array.from({ length: indentGuidesCount }).map((_, i) => (
                      <span
                        key={i}
                        className={`syntax-indent-guide${i === indentGuidesCount - 1 ? ' syntax-indent-guide-current' : ''}`}
                        style={{
                          left: `calc(${i * indentStep}ch + 0.5ch - 0.5px)`,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                  </span>
                )}
                <span
                  className="syntax-hidden"
                  data-sub-offset={indentLen}
                >
                  {token.marker || token.raw.slice(indentLen)}
                </span>
                <span
                  className="syntax-content"
                  data-sub-offset={indentLen}
                >
                  <span
                    className="task-checkbox-wrapper"
                    onClick={handleTaskClick}
                    role="checkbox"
                    aria-checked={token.isChecked}
                    title={token.isChecked ? '已完成（单击切换）' : '未完成（单击切换）'}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className="task-checkbox-svg"
                    >
                      {token.isChecked ? (
                        <>
                          <rect
                            x="1"
                            y="1"
                            width="14"
                            height="14"
                            rx="3.5"
                            fill="var(--brand, oklch(0.696 0.149 162.48))"
                            stroke="var(--brand, oklch(0.696 0.149 162.48))"
                            strokeWidth="1.2"
                          />
                          <path
                            d="M4.5 8.2L7 10.7L11.5 5.5"
                            stroke="oklch(1 0 0)"
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
                          stroke="var(--border-strong, hsl(30 2.5% 65%))"
                          strokeWidth="1.5"
                        />
                      )}
                    </svg>
                  </span>
                  <span
                    className="task-space"
                    data-sub-offset={len - 1}
                  >
                    {' '}
                  </span>
                </span>
              </span>
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

          // If it's a token with `content` different from `raw`
          if (token.content !== undefined && token.content !== token.raw) {
            const isListPrefix = ['blockquote_prefix'].includes(token.type);
            const prefixLen = token.raw.indexOf(token.content);
            if (!isListPrefix && prefixLen >= 0 && token.content !== '') {
              // Substring case (e.g. **bold**)
              const prefix = token.raw.substring(0, prefixLen);
              const suffix = token.raw.substring(
                prefixLen + token.content.length
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
                  <span data-sub-offset={prefixLen}>
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
                      data-sub-offset={prefixLen + token.content.length}
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
