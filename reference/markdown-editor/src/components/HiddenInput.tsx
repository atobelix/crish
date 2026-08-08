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
import { useTableStore } from '../core/TableStore';
import {
  navigateTable,
  findTableRange,
  clearCell,
  setCellContent,
} from '../core/TableOperations';

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
      if (handleTableInteraction(e)) {
        return;
      }
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

  const handleTableInteraction = (e: KeyboardEvent | React.KeyboardEvent) => {
    const selectedCell = useTableStore.getState().selectedCell;
    if (!selectedCell) return false;
    const text = useEditorStore.getState().getText();
    const cursorPos = useEditorStore.getState().cursorPos;

    if (!selectedCell.isEditing) {
      // 1. 单元格模式 (Cell Selection Mode - 仅限单元格级别操作)
      if (e.key === 'F2') {
        e.preventDefault();
        useTableStore.getState().enterCellEdit();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        useTableStore.getState().clearCellSelection();
        return true;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const res = clearCell(text, cursorPos);
        if (res.newText !== text) {
          useEditorStore.setState({ lines: res.newText.split('\n') });
        }
        useEditorStore.getState().setCursorPos(res.newCursorPos);
        return true;
      }

      // 单元格网格导航键（Tab, Shift+Tab, Enter, Shift+Enter, 方向键）
      let action: 'tab' | 'shift-tab' | 'enter' | 'shift-enter' | null = null;
      if (e.key === 'Tab') {
        action = e.shiftKey ? 'shift-tab' : 'tab';
      } else if (e.key === 'Enter') {
        action = e.shiftKey ? 'shift-enter' : 'enter';
      } else if (e.key === 'ArrowLeft' && !e.shiftKey) {
        action = 'shift-tab';
      } else if (e.key === 'ArrowRight' && !e.shiftKey) {
        action = 'tab';
      } else if (e.key === 'ArrowUp' && !e.shiftKey) {
        action = 'shift-enter';
      } else if (e.key === 'ArrowDown' && !e.shiftKey) {
        action = 'enter';
      }

      if (action) {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, action);
        if (res) {
          if (res.newText !== text) {
            useEditorStore.setState({ lines: res.newText.split('\n') });
          }
          useEditorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore.getState().enterCellSelection(
              selectedCell.tableId,
              newTable.absoluteLineIndex ?? newTable.activeLineIndex,
              newTable.activeCellIndex
            );
          }
        }
        return true;
      }

      // 如果按普通字符键（单字符输入），清空当前单元格并直接输入该字符并转为编辑态
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        const res = setCellContent(text, cursorPos, e.key);
        if (res.newText !== text) {
          useEditorStore.setState({ lines: res.newText.split('\n') });
        }
        useEditorStore.getState().setCursorPos(res.newCursorPos);
        useTableStore.getState().enterCellEdit();
        return true;
      }
    } else {
      // 2. 单元格就地编辑模式 (Cell In-place Text Edit Mode)
      if (e.key === 'Escape') {
        e.preventDefault();
        useTableStore.getState().exitCellEdit();
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, e.shiftKey ? 'shift-tab' : 'tab');
        if (res) {
          if (res.newText !== text) {
            useEditorStore.setState({ lines: res.newText.split('\n') });
          }
          useEditorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore.getState().enterCellSelection(
              selectedCell.tableId,
              newTable.absoluteLineIndex ?? newTable.activeLineIndex,
              newTable.activeCellIndex
            );
          }
        }
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const res = navigateTable(text, cursorPos, 'enter');
        if (res) {
          if (res.newText !== text) {
            useEditorStore.setState({ lines: res.newText.split('\n') });
          }
          useEditorStore.getState().setCursorPos(res.newCursorPos);
          const newTable = findTableRange(res.newText, res.newCursorPos);
          if (newTable) {
            useTableStore.getState().enterCellSelection(
              selectedCell.tableId,
              newTable.absoluteLineIndex ?? newTable.activeLineIndex,
              newTable.activeCellIndex
            );
          }
        }
        return true;
      }
    }
    return false;
  };

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

    // --- 表格单元格交互状态机 (Excel Mode) ---
    if (handleTableInteraction(e)) {
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
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const res = navigateTable(text, cursorPos, e.shiftKey ? 'shift-tab' : 'tab');
      if (res) {
        if (res.newText !== text) {
          useEditorStore.setState({ lines: res.newText.split('\n') });
        }
        useEditorStore.getState().setCursorPos(res.newCursorPos);
      }
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
