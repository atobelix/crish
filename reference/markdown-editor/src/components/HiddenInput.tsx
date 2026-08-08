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
  const lines = useEditorStore((state) => state.lines);
  const selectionStart = useEditorStore((state) => state.selectionStart);
  const selectionEnd = useEditorStore((state) => state.selectionEnd);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    height: number;
  } | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const prevDeps = useRef<any>(null);

  // Sync input value with current line text
  useLayoutEffect(() => {
    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;

    let rAF: number;
    let retries = 0;
    const updateCoords = () => {
      const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
      if (rect) {
        const containerRect = containerRef.current!.getBoundingClientRect();
        const top = rect.top - containerRect.top + containerRef.current!.scrollTop;
        const left =
          rect.left - containerRect.left + containerRef.current!.scrollLeft;

        setCoords({ top, left, height: rect.height });

        const cTop = containerRef.current!.scrollTop;
        const cHeight = containerRef.current!.clientHeight;
        if (top < cTop) {
          containerRef.current!.scrollTop = Math.max(0, top - 40);
        } else if (top + rect.height > cTop + cHeight) {
          containerRef.current!.scrollTop = top + rect.height - cHeight + 40;
        }
      } else if (retries < 10) {
        retries++;
        rAF = requestAnimationFrame(updateCoords);
      } else {
        setCoords(null);
      }
    };
    updateCoords();

    return () => {
      if (rAF) cancelAnimationFrame(rAF);
    };
  }, [cursorPos, selectionStart, selectionEnd, containerRef, lines]);

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

  
  const handleTableNav = (e: React.KeyboardEvent, direction: 'left' | 'right' | 'up' | 'down', text: string, cursorPos: number): boolean => {
      let lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
      let lineEnd = text.indexOf('\n', cursorPos);
      if (lineEnd === -1) lineEnd = text.length;
      const lineStr = text.substring(lineStart, lineEnd);

      if (lineStr.trim().startsWith('|')) {
        const pipes: number[] = [];
        for (let i = lineStart; i <= lineEnd; i++) {
          if (text[i] === '|' && (i === 0 || text[i-1] !== '\\')) pipes.push(i);
        }

        if (pipes.length >= 2) {
          let currentCellIdx = -1;
          for (let i = 0; i < pipes.length - 1; i++) {
            if (cursorPos >= pipes[i] && cursorPos <= pipes[i+1]) {
              currentCellIdx = i;
              break;
            }
          }

          if (currentCellIdx !== -1) {
            e.preventDefault();
            let nextCellIdx = currentCellIdx;
            if (direction === 'left') nextCellIdx--;
            if (direction === 'right') nextCellIdx++;
            
            let targetLineStart = lineStart;
            let targetLineEnd = lineEnd;
            let targetPipes = pipes;

            if (nextCellIdx < 0 || direction === 'up') {
              if (lineStart > 0) {
                let prevLineEnd = lineStart - 1;
                let prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
                let prevLineStr = text.substring(prevLineStart, prevLineEnd);
                
                if (prevLineStr.replace(/[-:| ]/g, '').length === 0 && prevLineStart > 0) {
                  prevLineEnd = prevLineStart - 1;
                  prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
                  prevLineStr = text.substring(prevLineStart, prevLineEnd);
                }

                if (prevLineStr.trim().startsWith('|')) {
                  targetLineStart = prevLineStart;
                  targetLineEnd = prevLineEnd;
                  targetPipes = [];
                  for (let i = targetLineStart; i <= targetLineEnd; i++) {
                    if (text[i] === '|' && (i === 0 || text[i-1] !== '\\')) targetPipes.push(i);
                  }
                  if (direction === 'left') nextCellIdx = Math.max(0, targetPipes.length - 2);
                  if (direction === 'up') nextCellIdx = Math.min(nextCellIdx, targetPipes.length - 2);
                } else if (direction === 'left' || direction === 'right') {
                    return true;
                }
              }
            } else if (nextCellIdx >= pipes.length - 1 || direction === 'down') {
              if (lineEnd < text.length) {
                let nextLineStart = lineEnd + 1;
                let nextLineEnd = text.indexOf('\n', nextLineStart);
                if (nextLineEnd === -1) nextLineEnd = text.length;
                let nextLineStr = text.substring(nextLineStart, nextLineEnd);

                if (nextLineStr.replace(/[-:| ]/g, '').length === 0 && nextLineEnd < text.length) {
                  nextLineStart = nextLineEnd + 1;
                  nextLineEnd = text.indexOf('\n', nextLineStart);
                  if (nextLineEnd === -1) nextLineEnd = text.length;
                  nextLineStr = text.substring(nextLineStart, nextLineEnd);
                }

                if (nextLineStr.trim().startsWith('|')) {
                  targetLineStart = nextLineStart;
                  targetLineEnd = nextLineEnd;
                  targetPipes = [];
                  for (let i = targetLineStart; i <= targetLineEnd; i++) {
                    if (text[i] === '|' && (i === 0 || text[i-1] !== '\\')) targetPipes.push(i);
                  }
                  if (direction === 'right') nextCellIdx = 0;
                  if (direction === 'down') nextCellIdx = Math.min(nextCellIdx, targetPipes.length - 2);
                } else if (direction === 'left' || direction === 'right') {
                    return true;
                }
              }
            }

            if (nextCellIdx >= 0 && nextCellIdx < targetPipes.length - 1) {
              const cellStart = targetPipes[nextCellIdx] + 1;
              const cellEnd = targetPipes[nextCellIdx + 1];
              let selStart = cellStart;
              let selEnd = cellEnd;
              while (selStart < selEnd && text[selStart] === ' ') selStart++;
              while (selEnd > selStart && text[selEnd - 1] === ' ') selEnd--;
              
              const store = useEditorStore.getState();
              store.setSelection(selStart, selEnd);
            }
            return true;
          }
        }
      }
      return false;
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
      let lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
      let lineEnd = text.indexOf('\n', cursorPos);
      if (lineEnd === -1) lineEnd = text.length;
      const lineStr = text.substring(lineStart, lineEnd);
      if (lineStr.trim().startsWith('|')) {
        insertText('<br>');
      } else {
        insertText('\n');
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(0, text.length);
    } else if (e.key === 'Tab') {
      if (handleTableNav(e, e.shiftKey ? 'left' : 'right', text, cursorPos)) return;
    } else if (e.key === 'ArrowUp') {
      if (!e.shiftKey && handleTableNav(e, 'up', text, cursorPos)) return;
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
      if (!e.shiftKey && handleTableNav(e, 'down', text, cursorPos)) return;
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
