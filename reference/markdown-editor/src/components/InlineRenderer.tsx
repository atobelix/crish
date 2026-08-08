import * as React from 'react';
import type { InlineNode } from '../core/ast';
import { checkIsActive, type ActiveState } from '../core/measure';
import katex from 'katex';

function renderMathToHtml(
  formula: string,
  displayMode: boolean = false
): string {
  if (!formula) return '';
  try {
    return katex.renderToString(formula, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return formula;
  }
}

import { useTableStore } from '../core/TableStore';
import { useEditorStore } from '../core/EditorStore';

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
    let colIndexCounter = 0;

    return (
      <>
        {tokens.map((token, index) => {
          const key = `${token.type}-${index}`;
          const start = lineOffset + token.localOffset;
          const len = token.length;

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
            const cellStyle = cellWidth ? { ...token.style, flex: `0 0 ${cellWidth}px` } : { ...token.style, flex: '1 1 0%' };
            
            const isCellSelected = selectedCell?.lineIndex === lineIndex && selectedCell?.colIndex === colIndex;
            const isCellEditing = isCellSelected && selectedCell?.isEditing;

            if (isCellSelected) {
              finalClassName += isCellEditing ? ' is-cell-editing' : ' is-cell-selected';
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
                onClick={(e) => {
                  e.stopPropagation();
                  useTableStore.getState().enterCellSelection(
                    tableId || '',
                    lineIndex ?? -1,
                    colIndex
                  );
                  if (start !== undefined) {
                    useEditorStore.getState().setCursorPos(start + 1);
                  }
                  const input = document.querySelector('.hidden-input') as HTMLTextAreaElement;
                  if (input) input.focus();
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  window.getSelection()?.removeAllRanges();
                  useTableStore.getState().enterCellEdit(
                    tableId || '',
                    lineIndex ?? -1,
                    colIndex
                  );
                  if (start !== undefined) {
                    useEditorStore.getState().setCursorPos(start + 1);
                  }
                  const input = document.querySelector('.hidden-input') as HTMLTextAreaElement;
                  if (input) input.focus();
                }}
              >
                {token.children && (
                  <InlineRenderer
                    tokens={token.children}
                    lineOffset={lineOffset}
                    activeState={activeState}
                    tableId={tableId}
                    lineIndex={lineIndex}
                  />
                )}
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
