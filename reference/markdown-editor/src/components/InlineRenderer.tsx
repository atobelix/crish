import * as React from 'react';
import type { InlineNode } from '../core/ast';
import { type ActiveState } from '../core/measure';
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
            
          const isListPrefix = ['list_bullet', 'list_number', 'list_task', 'blockquote_prefix'].includes(token.type);
          let isActive = false;
          if (activeState) {
            if (activeState.selStart !== undefined && activeState.selEnd !== undefined && activeState.selStart !== activeState.selEnd) {
              isActive = start < activeState.selEnd && (start + len) > activeState.selStart;
            } else {
              // For list prefixes, cursor at the very end of the prefix belongs to the following text, not the prefix itself.
              if (isListPrefix) {
                isActive = activeState.cursor >= start && activeState.cursor < start + len;
              } else {
                isActive = activeState.cursor >= start && activeState.cursor <= start + len;
              }
            }
          }
          
          const isSelected = activeState && activeState.selStart !== undefined && activeState.selEnd !== undefined 
                             && activeState.selStart !== activeState.selEnd
                             && start < activeState.selEnd && (start + len) > activeState.selStart;

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

          if (token.type === 'table_cell') {
            const colIndex = colIndexCounter++;
            const cellWidth = tableWidths?.[colIndex];
            const cellStyle: React.CSSProperties = cellWidth ? { ...token.style, flex: `0 0 ${cellWidth}px` } : { ...token.style, flex: '1 1 0%' };
            
            const isCellSelected = selectedCell &&
              lineIndex !== undefined &&
              tableId === selectedCell.tableId &&
              lineIndex >= Math.min(selectedCell.startLine, selectedCell.endLine) &&
              lineIndex <= Math.max(selectedCell.startLine, selectedCell.endLine) &&
              colIndex >= Math.min(selectedCell.startCol, selectedCell.endCol) &&
              colIndex <= Math.max(selectedCell.startCol, selectedCell.endCol);
              
            const isCellEditing = isCellSelected && selectedCell?.isEditing && selectedCell.startLine === selectedCell.endLine && selectedCell.startCol === selectedCell.endCol;

            let selectionShadow = '';
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
                
                if (lineIndex === minLine) shadows.push('inset 0 1.5px 0 0 var(--border-focus)');
                if (lineIndex === maxLine) shadows.push('inset 0 -1.5px 0 0 var(--border-focus)');
                if (colIndex === minCol) shadows.push('inset 1.5px 0 0 0 var(--border-focus)');
                if (colIndex === maxCol) shadows.push('inset -1.5px 0 0 0 var(--border-focus)');
                
                selectionShadow = shadows.join(', ');
                if (lineIndex === maxLine && colIndex === maxCol) {
                  finalClassName += ' is-selection-bottom-right';
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
                className={finalClassName}
                style={cellStyle}
                onMouseDown={(e) => {
                  if (e.button === 2) return; // Ignore right click
                  // Avoid breaking edit mode if we click on the already editing cell
                  if (isCellEditing) return;
                  
                  const tableStore = useTableStore.getState();
                  tableStore.enterCellSelection(tableId || '', lineIndex ?? -1, colIndex);
                  tableStore.setDraggingCell(true);
                  
                  if (start !== undefined) {
                    useEditorStore.getState().setCursorPos(start + 1);
                  }
                  // Ensure HiddenInput gets focus so keyboard navigation works immediately
                  setTimeout(() => {
                    const input = document.querySelector('.hidden-input') as HTMLTextAreaElement;
                    if (input) input.focus();
                  }, 0);
                }}
                onMouseEnter={() => {
                  const tableStore = useTableStore.getState();
                  if (tableStore.isDraggingCell) {
                    tableStore.updateCellSelectionEnd(lineIndex ?? -1, colIndex);
                    // Clear native selection so text isn't highlighted while dragging cells
                    window.getSelection()?.removeAllRanges();
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
                onDoubleClick={() => {
                  window.getSelection()?.removeAllRanges();
                  useTableStore.getState().enterCellEdit(
                    tableId || '',
                    lineIndex ?? -1,
                    colIndex
                  );
                  const input = document.querySelector('.hidden-input') as HTMLTextAreaElement;
                  if (input) input.focus();
                }}
                onContextMenu={(e) => {
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
              </span>
            );
          }

          // If it's a token with `content` different from `raw`
          if (token.content !== undefined && token.content !== token.raw) {
            const isListPrefix = ['list_bullet', 'list_number', 'list_task', 'blockquote_prefix'].includes(token.type);
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
              // Complete replacement case (e.g. list_bullet "- " -> "• ", or heading_prefix "## " -> "")
              const isTask = token.type === 'list_task';
              const handleTaskClick = (e: React.MouseEvent) => {
                if (isTask && start !== undefined) {
                  e.stopPropagation();
                  e.preventDefault();
                  const state = useEditorStore.getState();
                  const oldRaw = token.raw;
                  const newRaw = token.isChecked 
                    ? oldRaw.replace(/\[[xX]\]/, '[ ]') 
                    : oldRaw.replace(/\[ \]/, '[x]');
                  
                  state.setSelection(start, start + len);
                  state.insertText(newRaw);
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
                  <span data-sub-offset={0} className="syntax-hidden">
                    {token.indent !== undefined ? (
                      <>
                        <span className="syntax-indent">{token.indent}</span>
                        <span className="syntax-marker">{token.marker}</span>
                      </>
                    ) : (
                      token.raw
                    )}
                  </span>
                  <span 
                    className="syntax-content"
                    onClick={isTask ? handleTaskClick : undefined}
                    style={isTask ? { cursor: 'pointer' } : undefined}
                  >
                    {isTask ? (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                          verticalAlign: 'text-bottom',
                          transform: 'translateY(-2px)',
                          color: token.isChecked ? 'var(--text-primary)' : 'var(--text-muted)',
                        }}
                      >
                        <rect x="3" y="3" width="18" height="18" rx="6" ry="6" />
                        {token.isChecked && <polyline points="9 12 12 15 16 9" />}
                      </svg>
                    ) : (
                      token.content
                    )}
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
