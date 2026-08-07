import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BlockRenderer } from './BlockRenderer';
import { HiddenInput } from './HiddenInput';
import { CursorLayer } from './CursorLayer';
import { useEditorStore } from '../core/EditorStore';
import { MarkdownParser } from '../core/parser';
import { getCoordinatesFromIndex } from '../core/measure';

export const MarkdownEngine: React.FC = () => {
  const parentRef = useRef<HTMLDivElement>(null);
  const {
    lines,
    lineOffsets: offsets,
    codeBlockState,
    setCursorPos,
  } = useEditorStore();

  // Virtualization setup: fixed size = 28px perfectly aligns with grid paper CSS
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28, // Strict grid size
    overscan: 40, // Buffer for smooth scrolling
  });

  const handleContainerClick = (e: React.MouseEvent) => {
    // If the user selected text, do NOT clear the selection and do NOT move the custom cursor
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }

    // 1. Find the line index the user actually clicked on
    let clickedLineIndex = -1;
    let target = e.target as HTMLElement;
    while (target && target !== parentRef.current) {
      if (target.hasAttribute('data-index')) {
        clickedLineIndex = parseInt(
          target.getAttribute('data-index') || '-1',
          10
        );
        break;
      }
      target = target.parentElement as HTMLElement;
    }

    // 2. Find the closest text offset using browser API
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

    // 3. Try to use the exact token offset, BUT ONLY if it belongs to the clicked line!
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
      if (foundTokenStart !== -1 && foundLineIndex === clickedLineIndex) {
        let subOffset = 0;

        let targetNode = range.startContainer;
        let isText = targetNode.nodeType === Node.TEXT_NODE;
        if (
          !isText &&
          range.startOffset >= 0 &&
          range.startOffset < targetNode.childNodes.length
        ) {
          targetNode = targetNode.childNodes[range.startOffset];
        }

        let currentEl: HTMLElement | null =
          targetNode.nodeType === Node.TEXT_NODE
            ? targetNode.parentElement
            : (targetNode as HTMLElement);

        while (currentEl && currentEl !== parentRef.current) {
          if (currentEl.hasAttribute('data-sub-offset')) {
            subOffset = parseInt(
              currentEl.getAttribute('data-sub-offset') || '0',
              10
            );
            break;
          }
          if (currentEl.hasAttribute('data-token-start')) {
            break;
          }
          currentEl = currentEl.parentElement;
        }

        const offset = isText ? range.startOffset : 0;

        // Check if user clicked far to the left of the actual text (e.g., in the padding of a heading with hidden prefix)
        if (currentEl) {
          const rect = currentEl.getBoundingClientRect();
          if (e.clientX < rect.left - 10) {
            const lineStart = offsets[clickedLineIndex];
            setCursorPos(lineStart);
            return;
          }
        }

        setCursorPos(foundTokenStart + subOffset + offset);
        return;
      }
    }

    // 4. Fallback: User clicked an empty line, or empty space far away from text, or a preview element (HR, Math)
    if (clickedLineIndex !== -1) {
      const lineStart = offsets[clickedLineIndex];
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
      setCursorPos(lineStart + lineLen);
    } else {
      // Clicked in the container but outside any specific line (e.g. bottom empty space)
      // Put cursor at the very end of the document
      const lastLineIdx = lines.length - 1;
      if (lastLineIdx >= 0) {
        const lineStart = offsets[lastLineIdx];
        const lineLen = lines[lastLineIdx].length;
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
        className="editor-container"
        onClick={handleContainerClick}
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
            const offset = offsets[virtualRow.index];
            const isCode = codeBlockState[virtualRow.index];
            // 2. Synchronously parse ONLY visible lines (cached)
            const lineOffset = offsets[virtualRow.index] ?? 0;
            const lineNode = MarkdownParser.parseLine(
              lineText,
              lineOffset,
              isCode
            );

            return (
              <div
                key={virtualRow.index}
                data-index={virtualRow.index}
                data-line-start={offset}
                data-line-length={lineText.length}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: `${virtualRow.start}px`,
                  left: 0,
                  width: '100%',
                  minHeight: '28px', // Allows wrapping to 56px, 84px etc.
                }}
              >
                <BlockRenderer
                  block={lineNode}
                  index={virtualRow.index}
                  lineOffset={offset}
                />
              </div>
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
