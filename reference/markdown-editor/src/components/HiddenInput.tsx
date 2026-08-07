import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useEditorStore,
  findNextGraphemeBoundary,
  findPrevGraphemeBoundary,
  snapToGraphemeBoundary,
} from '../core/EditorStore';
import {
  getCoordinatesFromIndex,
  getGlobalIndexFromDOMNode,
  getArrowNavigationIndex,
  updateActiveElements,
} from '../core/measure';

interface HiddenInputProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export const HiddenInput: React.FC<HiddenInputProps> = ({ containerRef }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPos = useEditorStore((state) => state.cursorPos);
  const insertText = useEditorStore((state) => state.insertText);
  const deleteText = useEditorStore((state) => state.deleteText);
  const setCursorPos = useEditorStore((state) => state.setCursorPos);
  const setSelection = useEditorStore((state) => state.setSelection);
  const selectionStart = useEditorStore((state) => state.selectionStart);
  const selectionEnd = useEditorStore((state) => state.selectionEnd);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    height: number;
  } | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  // Sync input value with current line text
  useLayoutEffect(() => {
    if (!textareaRef.current) return;
    const state = useEditorStore.getState();

    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;
    updateActiveElements(
      containerRef.current,
      cursorPos,
      selectionStart,
      selectionEnd
    );

    const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
    if (rect) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const top = rect.top - containerRect.top + containerRef.current.scrollTop;
      const left =
        rect.left - containerRect.left + containerRef.current.scrollLeft;
      setCoords({ top, left, height: rect.height });

      const cTop = containerRef.current.scrollTop;
      const cHeight = containerRef.current.clientHeight;
      if (top < cTop) {
        containerRef.current.scrollTop = Math.max(0, top - 40);
      } else if (top + rect.height > cTop + cHeight) {
        containerRef.current.scrollTop = top + rect.height - cHeight + 40;
      }
    }
  }, [cursorPos, selectionStart, selectionEnd, containerRef]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (!containerRef.current) return;
      const selection = window.getSelection();
      if (isComposing) {
        setIsComposing(false);
      }
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        console.log('handleSelectionChange: collapsed or no selection');
        return;
      }

      const range = selection.getRangeAt(0);

      // Try to find the start and end DOM nodes
      const startIdx = getGlobalIndexFromDOMNode(
        range.startContainer,
        range.startOffset,
        containerRef.current
      );
      const endIdx = getGlobalIndexFromDOMNode(
        range.endContainer,
        range.endOffset,
        containerRef.current
      );

      console.log('handleSelectionChange: range', {
        startIdx,
        endIdx,
        s: range.startContainer,
        e: range.endContainer,
      });

      if (startIdx !== null && endIdx !== null) {
        const s = Math.min(startIdx, endIdx);
        const e = Math.max(startIdx, endIdx);

        // If it's a drag or double-click selection, update store.
        // If it's a collapsed click (s === e), we IGNORE it here because MarkdownEngine.tsx's onClick
        // will handle it using caretRangeFromPoint, which is more precise.
        // This prevents the "two cursor changes" jitter on mousedown -> click.
        if (s !== e) {
          useEditorStore.setState({
            cursorPos: e,
            selectionStart: s,
            selectionEnd: e,
          });
        }
      }
    };

    // Keep focus
    const handleGlobalClick = () => {
      // If text is selected on the screen, DO NOT steal focus!
      // Stealing focus will immediately destroy the user's DOM text selection.
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }
      textareaRef.current?.focus();
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const state = useEditorStore.getState();
        if (state.selectionStart !== state.selectionEnd) {
          e.preventDefault();
          state.deleteSelection(state.selectionStart, state.selectionEnd);
          window.getSelection()?.removeAllRanges();
          textareaRef.current?.focus();
        }
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [containerRef]);

  const fastCursorMove = (newPos: number) => {
    setCursorPos(newPos);
    // We don't need manual dom manipulation here anymore, since useEffect handles it on cursorPos change
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const text = useEditorStore.getState().getText();
    const { selectionStart, selectionEnd } = useEditorStore.getState();
    const cursorPos = useEditorStore.getState().cursorPos;

    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        useEditorStore.getState().redo();
      } else {
        useEditorStore.getState().undo();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      useEditorStore.getState().redo();
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const newPos = findPrevGraphemeBoundary(text, cursorPos);
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? newPos : selectionStart,
          newPos
        );
        fastCursorMove(newPos);
      } else {
        if (selectionStart !== selectionEnd) fastCursorMove(selectionStart);
        else fastCursorMove(newPos);
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const newPos = findNextGraphemeBoundary(text, cursorPos);
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? newPos : selectionStart,
          newPos
        );
        fastCursorMove(newPos);
      } else {
        if (selectionStart !== selectionEnd) fastCursorMove(selectionEnd);
        else fastCursorMove(newPos);
      }
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      deleteText(true);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      deleteText(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isComposing) return;
      insertText('\n');
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(0, text.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (containerRef.current) {
        const targetIdx = getArrowNavigationIndex(
          cursorPos,
          'up',
          containerRef.current
        );
        if (targetIdx !== null) {
          const newPos = snapToGraphemeBoundary(text, targetIdx);
          if (e.shiftKey) {
            setSelection(
              selectionStart === cursorPos ? newPos : selectionStart,
              newPos
            );
          }
          fastCursorMove(newPos);
        }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (containerRef.current) {
        const targetIdx = getArrowNavigationIndex(
          cursorPos,
          'down',
          containerRef.current
        );
        if (targetIdx !== null) {
          const newPos = snapToGraphemeBoundary(text, targetIdx);
          if (e.shiftKey) {
            setSelection(
              selectionStart === cursorPos ? newPos : selectionStart,
              newPos
            );
          }
          fastCursorMove(newPos);
        }
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      let lineStart = 0;
      for (let i = cursorPos; i >= 0; i--) {
        if (i === 0 || text[i - 1] === '\n') {
          lineStart = i;
          break;
        }
      }
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? lineStart : selectionStart,
          lineStart
        );
      }
      fastCursorMove(lineStart);
    } else if (e.key === 'End') {
      e.preventDefault();
      let lineEnd = text.length;
      for (let i = cursorPos; i < text.length; i++) {
        if (text[i] === '\n') {
          lineEnd = i;
          break;
        }
      }
      if (e.shiftKey) {
        setSelection(
          selectionStart === cursorPos ? lineEnd : selectionStart,
          lineEnd
        );
      }
      fastCursorMove(lineEnd);
    }
  };

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    setIsComposing(false);
    if (e.data) {
      insertText(e.data);
    }
    if (textareaRef.current) textareaRef.current.value = '';
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (isComposing) return;
    const value = e.target.value;
    if (value) {
      insertText(value);
      // reset textarea so we can catch next input cleanly
      e.target.value = '';
    }
  };

  if (!coords) return null;

  return (
    <textarea
      ref={textareaRef}
      value=""
      onKeyDown={handleKeyDown}
      onChange={handleInput}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      style={{
        position: 'absolute',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: '1px',
        height: `${coords.height}px`,
        opacity: 0,
        padding: 0,
        border: 'none',
        overflow: 'hidden',
        resize: 'none',
        outline: 'none',
        pointerEvents: 'none',
      }}
      spellCheck="false"
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
    />
  );
};
