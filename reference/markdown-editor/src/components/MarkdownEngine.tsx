import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { useEditorStore } from '../core/EditorStore';
import { useTableStore } from '../core/TableStore';
import { MarkdownParser } from '../core/parser';

import { type CodeState } from '../core/parser';

const LineItem = React.memo(({
  virtualRow,
  lineText,
  offset,
  isCode,
  measureElement
}: {
  virtualRow: any;
  lineText: string;
  offset: number;
  isCode: CodeState;
  measureElement: (el: HTMLElement | null) => void;
}) => {
  const activeStateStr = useEditorStore(state => {
    const { cursorPos, selectionStart, selectionEnd } = state;
    const lineStart = offset;
    const lineEnd = offset + lineText.length;

    const hasRange = selectionStart !== selectionEnd;
    const s = Math.min(selectionStart, selectionEnd);
    const e = Math.max(selectionStart, selectionEnd);

    const isLineActive = hasRange
      ? (lineStart < e && lineEnd >= s)
      : (cursorPos >= lineStart && cursorPos <= lineEnd);

    if (!isLineActive) return null;

    return `${cursorPos},${hasRange ? s : ''},${hasRange ? e : ''}`;
  });

  const activeState = React.useMemo(() => {
    if (!activeStateStr) return null;
    const [cursorStr, selStartStr, selEndStr] = activeStateStr.split(',');
    return {
      cursor: Number(cursorStr),
      selStart: selStartStr ? Number(selStartStr) : undefined,
      selEnd: selEndStr ? Number(selEndStr) : undefined,
    };
  }, [activeStateStr]);

  const tableId = useEditorStore(state => {
    if (!lineText.trim().startsWith('|')) return undefined;
    let firstTableIndex = virtualRow.index;
    while (firstTableIndex > 0) {
       const prevLine = state.lines[firstTableIndex - 1];
       if (prevLine && prevLine.trim().startsWith('|')) {
          firstTableIndex--;
       } else {
          break;
       }
    }
    return `table-${firstTableIndex}`;
  });

  const lineNode = MarkdownParser.parseLine(lineText, offset, isCode);

  return (
    <div
      data-index={virtualRow.index}
      data-line-start={offset}
      data-line-length={lineText.length}
      ref={measureElement}
      className={`virtual-row ${activeState ? 'is-active-line' : ''}`.trim()}
      style={{
        position: 'absolute',
        top: `${virtualRow.start}px`,
        left: 0,
        width: '100%',
        minHeight: lineNode.type === 'table_separator' ? '0px' : '28px',
      }}
    >
      <BlockRenderer
        block={lineNode}
        index={virtualRow.index}
        lineOffset={offset}
        activeState={activeState}
        tableId={tableId}
      />
    </div>
  );
});

export const MarkdownEngine: React.FC = () => {
  const parentRef = useRef<HTMLDivElement>(null);
  const lines = useEditorStore(state => state.lines);
  const offsets = useEditorStore(state => state.lineOffsets);
  const codeBlockState = useEditorStore(state => state.codeBlockState);
  const setCursorPos = useEditorStore(state => state.setCursorPos);

  // Virtualization setup: fixed size = 28px perfectly aligns with grid paper CSS
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const line = lines[i] || '';
      if (line.startsWith('# ')) return 46;
      if (line.startsWith('## ')) return 40;
      if (line.startsWith('### ')) return 36;
      if (line.startsWith('#### ')) return 32;
      if (line.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) return 0; // table separator
      return 28;
    },
    overscan: 40, // Buffer for smooth scrolling
  });

  const handleContainerClick = (e: React.MouseEvent) => {
    // If we just finished a drag selection, ignore the synthetic click
    if (Date.now() - ((window as any).__CRISH_LAST_DRAG_END_TIME || 0) < 50) return;

    const target = e.target as HTMLElement;
    if (!target.closest('.line-table-row')) {
      useTableStore.getState().clearCellSelection();
    }

    // If the user selected text, do NOT clear the selection and do NOT move the custom cursor
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }

    // 1. Try to find if we clicked on a rendered line wrapper
    let clickedLineIndex = parseInt(
      target.closest('[data-index]')?.getAttribute('data-index') || '-1',
      10
    );

    // 1.5 If clicked on padding/margins, try to resolve the line using vertical coordinates
    let clickedPadding = false;
    if (clickedLineIndex === -1 && parentRef.current) {
      const containerRect = parentRef.current.getBoundingClientRect();
      const contentY = e.clientY - containerRect.top + parentRef.current.scrollTop;
      
      const virtualItems = virtualizer.getVirtualItems();
      for (const item of virtualItems) {
        // Find the line that occupies this vertical space
        if (contentY >= item.start && contentY < item.start + item.size) {
          clickedLineIndex = item.index;
          clickedPadding = true;
          break;
        }
      }
    }

    // Prevent table separator from being clicked. Redirect to previous row (table header)
    if (clickedLineIndex !== -1 && lines[clickedLineIndex]?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
      if (clickedLineIndex > 0) {
        const prevLineStart = offsets.getOffset(clickedLineIndex - 1);
        const prevLineLen = lines[clickedLineIndex - 1].length;
        setCursorPos(prevLineStart + prevLineLen);
        return;
      }
    }

    if (clickedPadding && clickedLineIndex !== -1 && parentRef.current) {
       const lineStart = offsets.getOffset(clickedLineIndex);
       const lineLen = lines[clickedLineIndex].length;
       const containerRect = parentRef.current.getBoundingClientRect();
       
       if (e.clientX < containerRect.left + 50) {
         // Clicked left padding/margin
         setCursorPos(lineStart);
       } else {
         // Clicked right padding/margin
         setCursorPos(lineStart + lineLen);
       }
       return;
    }

    let range: Range | null = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if ((document as any).caretPositionFromPoint) {
      const pos = (document as any).caretPositionFromPoint(
        e.clientX,
        e.clientY
      );
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }

    // Clamp the range to the cell we actually clicked on (to prevent clicking padding and jumping to next cell)
    const clickedCell = target.closest('.token-table-cell') as HTMLElement;
    if (clickedCell && range && range.startContainer) {
      const resolvedNode = range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);
      
      const resolvedCell = resolvedNode?.closest('.token-table-cell');
      if (resolvedCell !== clickedCell) {
        const cellStart = parseInt(clickedCell.getAttribute('data-token-start') || '-1', 10);
        const cellLen = parseInt(clickedCell.getAttribute('data-token-length') || '0', 10);
        if (cellStart !== -1) {
          const rect = clickedCell.getBoundingClientRect();
          // If we clicked left half, go to start of cell. Otherwise go to end.
          if (e.clientX < rect.left + rect.width / 2) {
            setCursorPos(cellStart + 1); // +1 because start is the table_cell token itself? Actually start is localOffset.
          } else {
            setCursorPos(cellStart + cellLen);
          }
          return;
        }
      }
    }

    // 3. Check if we clicked directly on an HR (thematic break)
    if (target.tagName === 'HR' || target.classList.contains('hr-rendered')) {
      const lineStart = offsets.getOffset(clickedLineIndex);
      const lineLen = lines[clickedLineIndex].length;
      const rect = target.getBoundingClientRect();
      if (e.clientX - rect.left < rect.width / 2) {
        setCursorPos(lineStart);
      } else {
        setCursorPos(lineStart + lineLen);
      }
      return;
    }

    // 4. Try to use the exact token offset, BUT ONLY if it belongs to the clicked line!
    if (range && range.startContainer) {
      let el: HTMLElement | null =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);

      let foundTokenStart = -1;
      let foundLineIndex = -1;

      while (el && el !== parentRef.current) {
        if (el.hasAttribute('data-token-start') && foundTokenStart === -1) {
          foundTokenStart = parseInt(
            el.getAttribute('data-token-start') || '-1',
            10
          );
        }
        if (el.hasAttribute('data-index')) {
          foundLineIndex = parseInt(el.getAttribute('data-index') || '-1', 10);
          break;
        }
        el = el.parentElement;
      }

      // Only use the precise offset if the browser snapped to the SAME line we clicked
      if (foundLineIndex === clickedLineIndex) {
        if (foundTokenStart !== -1) {
          // It's inside a specific token (like a word)
          // Find if there's an exact sub-offset element
          let subOffset = 0;
          let currentEl: HTMLElement | null =
            range.startContainer.nodeType === Node.TEXT_NODE
              ? range.startContainer.parentElement
              : (range.startContainer as HTMLElement);

          while (currentEl && currentEl !== parentRef.current) {
            if (currentEl.hasAttribute('data-sub-offset')) {
              subOffset = parseInt(
                currentEl.getAttribute('data-sub-offset') || '0',
                10
              );
              break;
            }
            if (currentEl.hasAttribute('data-token-start')) {
              break; // Stop at token boundary
            }
            currentEl = currentEl.parentElement;
          }

          const rawPos =
            foundTokenStart + subOffset + (range.startOffset || 0);
          const lineStart = offsets.getOffset(clickedLineIndex);
          const lineLen = lines[clickedLineIndex].length;
          setCursorPos(Math.min(lineStart + lineLen, rawPos));
        } else {
          // Fallback to line start + offset
          const lineStart = offsets.getOffset(clickedLineIndex);
          const lineLen = lines[clickedLineIndex].length;
          setCursorPos(
            Math.min(lineStart + lineLen, lineStart + (range.startOffset || 0))
          );
        }
        return;
      }
    }

    // 4. Fallback: User clicked an empty line, or empty space far away from text, or a preview element (HR, Math)
    if (clickedLineIndex !== -1) {
      // If user clicked the table separator empty space, redirect to the header row above it
      if (lines[clickedLineIndex]?.trim().match(/^\|?[\s:-]*[-]+[\s:-]*\|/)) {
        if (clickedLineIndex > 0) {
          const prevLineStart = offsets.getOffset(clickedLineIndex - 1);
          const prevLineLen = lines[clickedLineIndex - 1].length;
          setCursorPos(prevLineStart + prevLineLen);
          return;
        }
      }
      const lineStart = offsets.getOffset(clickedLineIndex);
      const lineLen = lines[clickedLineIndex].length;

      // Use token-mapping from closest rendered element
      const tokenEl = (e.target as HTMLElement).closest('[data-token-start]');
      if (tokenEl) {
        const startStr = tokenEl.getAttribute('data-token-start');
        if (startStr) {
          const start = parseInt(startStr, 10);
          if (!isNaN(start)) {
            setCursorPos(start);
            return; // We found the precise token!
          }
        }
      }

      // Final fallback to end of the line
      console.log('Fallback to end of line:', lineStart + lineLen);
      setCursorPos(lineStart + lineLen);
    } else {
      // Clicked in the container but outside any specific line (e.g. bottom empty space)
      // Put cursor at the very end of the document
      const lastLineIdx = lines.length - 1;
      if (lastLineIdx >= 0) {
        const lineStart = offsets.getOffset(lastLineIdx);
        const lineLen = lines[lastLineIdx].length;
        console.log('Fallback to end of doc:', lineStart + lineLen);
        setCursorPos(lineStart + lineLen);
      }
    }
  };

  return (
    <div
      className="engine-container"
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <div
        ref={parentRef}
        className="editor-container editor-scroll-container"
        onClick={handleContainerClick}
        onCopy={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) return;

          const state = useEditorStore.getState();
          const start = Math.min(state.selectionStart, state.selectionEnd);
          const end = Math.max(state.selectionStart, state.selectionEnd);
          
          if (start !== end) {
            const rawText = state.getText().substring(start, end);
            e.clipboardData.setData('text/plain', rawText);
            e.preventDefault();
          }
        }}
        onCut={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) return;

          const state = useEditorStore.getState();
          const start = Math.min(state.selectionStart, state.selectionEnd);
          const end = Math.max(state.selectionStart, state.selectionEnd);
          
          if (start !== end) {
            const rawText = state.getText().substring(start, end);
            e.clipboardData.setData('text/plain', rawText);
            state.deleteSelection(start, end);
            window.getSelection()?.removeAllRanges();
            e.preventDefault();
            // Optional: return focus to textarea if possible, though it's hidden
          }
        }}
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '14px 1rem',
          position: 'relative',
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
            marginTop: '14px',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const lineText = lines[virtualRow.index];
            const offset = offsets.getOffset(virtualRow.index);
            const isCode = codeBlockState[virtualRow.index];
            return (
              <LineItem
                key={virtualRow.index}
                virtualRow={virtualRow}
                lineText={lineText}
                offset={offset}
                isCode={isCode}
                measureElement={virtualizer.measureElement}
              />
            );
          })}
        </div>


        <CursorLayer
          containerRef={parentRef}
          layoutDeps={virtualizer
            .getVirtualItems()
            .map((v) => v.start)
            .join(',')}
        />
        <HiddenInput containerRef={parentRef} />
      </div>
    </div>
  );
};
