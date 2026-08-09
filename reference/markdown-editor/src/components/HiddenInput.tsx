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
  toContainerCoords,
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

// 组合结束后的提交延迟窗口（对齐 04 §2.3 方案 2 / CM6 input.ts:843-847
// 的 50ms 清理策略）：compositionend 后浏览器可能延迟写入最终文本
// （Safari dead-key）或在窗口内开启新一轮合成（Android 预测、候选替换的
// 中途 flush）——窗口内新一轮 compositionstart 沿用同 compositionGroupId
// 继续累积 value，窗口到期后以 textarea.value 为准一次性提交。
const FLUSH_DELAY_MS = 50;

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

  // —— IME 合成状态机（R4-C，04 §2 深水区）——
  // 设计：合成期间文本变更一律缓冲（不清空 value、不逐次提交 store），
  // compositionend 后进入 50ms pending flush 延迟窗口，以 textarea.value
  // 为准一次性提交——value 是浏览器最终承诺文本，不依赖 e.data（Android/
  // Safari 空 data 丢字修复）。同一用户合成被浏览器拆成多轮 composition
  // 会话（候选替换、Android 预测、拼写纠错中途 flush）时，50ms 窗口内的
  // 新一轮 compositionstart 沿用同 compositionGroupId，value 持续累积、
  // 最终一次提交 → 整段组合 = 一个 undo 步（撤销粒度，04 §2.2 I4）。
  // 事件回调（含 setTimeout 闭包）读取 state 可能拿到旧值，组合真值
  // 全部走 ref 同步读写；isComposing state 仅供样式/光标隐藏消费。
  const isComposingRef = useRef(false);
  /** compositionGroupId 自增序列（每次「新组合会话」开组 +1） */
  const compositionGroupSeq = useRef(0);
  /** 活跃组合组：组开始时的替换区间快照（id 供延续判定，from/to 供提交） */
  const activeCompositionGroup = useRef<{
    id: number;
    from: number;
    to: number;
  } | null>(null);
  /** 最近一次 compositionend 时间戳（50ms 窗口内开新组 = 同组合延续） */
  const lastCompositionEndAt = useRef(0);
  /** 50ms pending flush 定时器句柄（null = 无待提交组合） */
  const pendingFlushTimer = useRef<number | null>(null);

  // Sync input value with current line text
  useLayoutEffect(() => {
    // Sync physical coordinates whenever cursor or text changes
    if (!containerRef.current) return;

    let rAF: number;
    let retries = 0;
    const updateCoords = () => {
      const rect = getCoordinatesFromIndex(cursorPos, containerRef.current);
      if (rect) {
        // 视口坐标 → 容器内容坐标（与 CursorLayer 共用换算；测量结果由
        // measure 模块的同帧缓存共享，两组件同帧仅一次全量测量）
        const { top, left, height } = toContainerCoords(
          rect,
          containerRef.current!
        );

        setCoords({ top, left, height });

        const cTop = containerRef.current!.scrollTop;
        const cHeight = containerRef.current!.clientHeight;
        
        // Fix for "反反复复刷屏" (Repeated bouncing during native mouse drag)
        // If the user is physically dragging the mouse outside the viewport, 
        // the browser natively triggers an OS-level drag-scroll loop.
        // We MUST NOT fight the browser by setting scrollTop manually here, 
        // otherwise react-virtual and the browser scroll will fight each other causing a bounce loop.
        if (!(window as any).__CRISH_IS_MOUSE_DOWN) {
          if (top < cTop) {
            containerRef.current!.scrollTop = Math.max(0, top - 40);
          } else if (top + height > cTop + cHeight) {
            containerRef.current!.scrollTop = top + height - cHeight + 40;
          }
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
    
    const handleGlobalMouseDown = () => {
      (window as any).__CRISH_IS_MOUSE_DOWN = true;
    };
    const handleGlobalMouseUp = () => {
      (window as any).__CRISH_IS_MOUSE_DOWN = false;
      const tableStore = useTableStore.getState();
      if (tableStore.isDraggingCell) {
        tableStore.setDraggingCell(false);
        (window as any).__CRISH_LAST_DRAG_END_TIME = Date.now();
      }
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
    window.addEventListener('mousedown', handleGlobalMouseDown);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      window.removeEventListener('mousedown', handleGlobalMouseDown);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
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
      // 合成中退格删除的是候选文本（浏览器经 value 缓冲处理），
      // 绝不触达文档——防误删已提交内容（composition 内不重复处理）
      if (isComposingRef.current) return;
      deleteText(true);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (isComposingRef.current) return;
      deleteText(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isComposing) return;

      if (!e.shiftKey) {
        const state = useEditorStore.getState();
        const text = state.getText();
        const pos = state.cursorPos;

        let lineStart = 0;
        for (let i = pos - 1; i >= 0; i--) {
          if (text[i] === '\n') {
            lineStart = i + 1;
            break;
          }
        }

        let lineEnd = text.length;
        for (let i = pos; i < text.length; i++) {
          if (text[i] === '\n') {
            lineEnd = i;
            break;
          }
        }

        const textBeforeCursor = text.substring(lineStart, pos);
        const textAfterCursor = text.substring(pos, lineEnd);
        const listMatch = textBeforeCursor.match(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/);

        if (listMatch) {
          if (textBeforeCursor === listMatch[0] && textAfterCursor.trim() === '') {
            // Empty list item: break out of the list
            state.deleteSelection(lineStart, lineEnd);
          } else {
            // Continue the list
            let newPrefix = listMatch[0];
            const numberMatch = newPrefix.match(/(\d+)\./);
            if (numberMatch) {
              const nextNum = parseInt(numberMatch[1], 10) + 1;
              newPrefix = newPrefix.replace(/\d+\./, `${nextNum}.`);
            }
            // Reset task list to unchecked
            newPrefix = newPrefix.replace(/\[[xX]\]/, '[ ]');
            
            insertText('\n' + newPrefix);
          }
        } else {
          insertText('\n');
        }
      } else {
        // Shift+Enter
        insertText('\n');
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(0, text.length);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const state = useEditorStore.getState();
      const text = state.getText();
      const cursorPos = state.cursorPos;

      const res = navigateTable(text, cursorPos, e.shiftKey ? 'shift-tab' : 'tab');
      if (res) {
        if (res.newText !== text) {
          useEditorStore.setState({ lines: res.newText.split('\n') });
        }
        useEditorStore.getState().setCursorPos(res.newCursorPos);
      } else {
        const selStart = state.selectionStart;
        const selEnd = state.selectionEnd;
        const startLineIdx = state.lineOffsets.findLineIndex(Math.min(selStart, selEnd));
        const endLineIdx = state.lineOffsets.findLineIndex(Math.max(selStart, selEnd));

        const startLineOffset = state.lineOffsets.getOffset(startLineIdx);
        const endLineOffset = state.lineOffsets.getOffset(endLineIdx);
        const endLineLength = state.lines[endLineIdx].length;

        const blockStart = startLineOffset;
        const blockEnd = endLineOffset + endLineLength;
        const blockText = text.substring(blockStart, blockEnd);

        let cursorDelta = 0;
        let newBlockText = '';

        if (e.shiftKey) {
          newBlockText = blockText.split('\n').map(line => {
            const match = line.match(/^ {1,2}/);
            if (match && selStart === selEnd) cursorDelta = -match[0].length;
            return line.replace(/^ {1,2}/, '');
          }).join('\n');
        } else {
          if (selStart !== selEnd) {
             newBlockText = blockText.split('\n').map(line => '  ' + line).join('\n');
          } else {
             const currentLine = state.lines[startLineIdx];
             if (/^(\s*)([-*+]|\d+\.)\s+/.test(currentLine)) {
               newBlockText = '  ' + currentLine;
               cursorDelta = 2;
             } else {
               state.insertText('  ');
               return;
             }
          }
        }

        if (newBlockText !== blockText) {
          state.setSelection(blockStart, blockEnd);
          state.insertText(newBlockText);
          if (selStart !== selEnd) {
            useEditorStore.getState().setSelection(blockStart, blockStart + newBlockText.length);
          } else {
            const newPos = Math.max(blockStart, selStart + cursorDelta);
            useEditorStore.getState().setSelection(newPos, newPos);
          }
        }
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

  /**
   * pending flush：组合结束延迟窗口到期的最终提交。
   * 以 textarea.value 为准（浏览器最终承诺文本）；提交后清空 value
   * 并闭组。窗口内新一轮 compositionstart 会清除定时器取消本次提交，
   * 让 value 继续累积（中途 flush 的同组延续）。
   */
  const flushComposition = () => {
    pendingFlushTimer.current = null;
    const group = activeCompositionGroup.current;
    if (!group) return;
    activeCompositionGroup.current = null;
    const ta = textareaRef.current;
    const value = ta ? ta.value : '';
    if (value) {
      // merge:'typing' 与 insertText 同合并语义：单字符组合并入连续打字
      // 步（连续输入直觉）、多字符组合独立一步（合并条件含单字符约束，
      // 天然满足「整段组合 = 一个 undo 步」的撤销粒度）。
      useEditorStore.getState().applyChange(group.from, group.to, value, {
        merge: 'typing',
      });
    }
    if (ta) ta.value = '';
  };

  /**
   * 开组合组（compositionGroupId 状态机，04 §2.3 方案 1）：
   * - 无活跃组 → 新组：id 自增，快照组开始时的替换区间 [from, to)，
   *   并清空 textarea.value（组开始前必须为空，防历史残留污染缓冲）；
   * - 有活跃组且距上次 compositionend ≤ 50ms → 同组延续（中途 flush 的
   *   候选替换/预测拆段）：沿用同 id 与区间快照，value 保留不清空；
   * - 有活跃组但已超窗口（异常残留）→ 先强制 flush 旧组再开新组。
   */
  const openCompositionGroup = () => {
    const now = Date.now();
    const prev = activeCompositionGroup.current;
    if (prev && now - lastCompositionEndAt.current <= FLUSH_DELAY_MS) {
      return;
    }
    if (prev) {
      flushComposition();
    }
    const s = useEditorStore.getState();
    compositionGroupSeq.current += 1;
    activeCompositionGroup.current = {
      id: compositionGroupSeq.current,
      from: s.selectionStart,
      to: s.selectionEnd,
    };
    if (textareaRef.current) textareaRef.current.value = '';
  };

  const handleCompositionStart = () => {
    openCompositionGroup();
    isComposingRef.current = true;
    setIsComposing(true);
    useEditorStore.getState().setIsComposing(true);
  };

  const handleCompositionEnd = (
    e: React.CompositionEvent<HTMLTextAreaElement>
  ) => {
    isComposingRef.current = false;
    lastCompositionEndAt.current = Date.now();
    setIsComposing(false);
    useEditorStore.getState().setIsComposing(false);
    const ta = textareaRef.current;

    if (!activeCompositionGroup.current) {
      // 防御：浏览器乱序导致 compositionstart 丢失——直接以 value/e.data
      // 兜底提交，不丢字（正常路径组必已开）。
      const fallback = ta ? ta.value : '';
      if (fallback) {
        useEditorStore.getState().insertText(fallback);
        if (ta) ta.value = '';
      } else if (e.data) {
        useEditorStore.getState().insertText(e.data);
      }
      return;
    }

    // 不立即提交：刷新 50ms 延迟窗口，等浏览器把最终文本写入 value
    // （Android 空 data 时 value 已含提交文本；Safari dead-key 需窗口期
    // 后再读一次）。窗口内不提交不清空，供同组延续累积 value。
    if (pendingFlushTimer.current !== null) {
      clearTimeout(pendingFlushTimer.current);
    }
    pendingFlushTimer.current = window.setTimeout(
      flushComposition,
      FLUSH_DELAY_MS
    );
  };

  // beforeinput 接线（04 §2.2 I3 / CM6 input.ts 对齐）：
  // 组合缓冲期（合成中 + end 后延迟窗口）一律不处理——value 由浏览器
  // 维护、组合结束后统一以 value 提交，防止与缓冲重复插入；
  // 合成之外接管浏览器语义缺失的通道：
  // - insertReplacementText：拼写纠错/候选替换 → 替换当前选区（独立步）；
  // - deleteContentBackward/Forward：Android 无可靠 keydown 的退格/删除补丁；
  // - insertParagraph：Android 无 keydown 的换行补丁（列表续写走 keydown）。
  // 处理后清空 value：若 preventDefault 失效（旧浏览器不支持 beforeinput），
  // 后续 input 事件读到空 value 不会重复提交（双写防御）。
  // 注：必须用原生监听器——React 19 的 onBeforeInput 不从原生 beforeinput
  // 事件派生（依赖 compositionend/keypress/textInput/paste），合成转发下
  // insertReplacementText/deleteContentBackward 永远收不到。
  const handleBeforeInput = (native: InputEvent) => {
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const inputType = native.inputType;
    if (!inputType) return;
    const s = useEditorStore.getState();
    const ta = native.target as HTMLTextAreaElement | null;
    if (inputType === 'insertReplacementText') {
      native.preventDefault();
      if (native.data) {
        s.applyChange(s.selectionStart, s.selectionEnd, native.data, {
          merge: 'none',
        });
      }
      if (ta) ta.value = '';
    } else if (inputType === 'deleteContentBackward') {
      native.preventDefault();
      s.deleteText(true);
      if (ta) ta.value = '';
    } else if (inputType === 'deleteContentForward') {
      native.preventDefault();
      s.deleteText(false);
      if (ta) ta.value = '';
    } else if (inputType === 'insertParagraph') {
      native.preventDefault();
      s.insertText('\n');
      if (ta) ta.value = '';
    }
  };

  const handleInput = (e: Event) => {
    // 组合缓冲期（合成中 + end 后 flush 延迟窗口）不直接提交：统一由
    // pending flush 以 value 为准提交，防止中途 flush/候选替换丢字、
    // 或与 flush 双写；组内不清空 value（缓冲累积的载体）。
    if (isComposingRef.current || activeCompositionGroup.current) return;
    const ta = e.target as HTMLTextAreaElement;
    const value = ta.value;
    if (value) {
      useEditorStore.getState().insertText(value);
      // reset textarea so we can catch next input cleanly
      ta.value = '';
    }
  };

  // 原生 input/beforeinput 监听（挂载后一次性注册；textaera 卸载重挂时
  // 随 coords 恢复重新注册——coords 为 null 期间组件返回 null，无监听）。
  // input 走原生监听而非 React onChange：jsdom 中 React 19 的 onChange
  // 值变化提取失效（isInputEventSupported 探测对 jsdom 不适用），且原生
  // 监听与 React 合成行为等价（onChange 语义即原生 input 事件）。
  const mounted = coords !== null;
  useEffect(() => {
    if (!mounted) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.addEventListener('input', handleInput);
    ta.addEventListener('beforeinput', handleBeforeInput);
    return () => {
      ta.removeEventListener('input', handleInput);
      ta.removeEventListener('beforeinput', handleBeforeInput);
    };
    // mounted 布尔：coords 在 null ↔ 非 null 间切换（textarea 卸载/重挂）
    // 时重注册；coords 持续更新（光标移动）不重注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  if (!coords) return null;

  return (
    <textarea
      ref={textareaRef}
      defaultValue=""
      onKeyDown={handleKeyDown}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onBlur={() => {
        setIsComposing(false);
        isComposingRef.current = false;
        useEditorStore.getState().setIsComposing(false);
        // 失焦 = 组合被浏览器强制结束：立即 flush 防丢字（组合取消时
        // value 为空，flush 为空操作），并清掉延迟定时器防双写
        if (pendingFlushTimer.current !== null) {
          clearTimeout(pendingFlushTimer.current);
          pendingFlushTimer.current = null;
        }
        if (activeCompositionGroup.current) {
          flushComposition();
        }
      }}
      style={{
        position: 'absolute',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: isComposing ? '300px' : '1px',
        height: `${coords.height + 15}px`,
        opacity: isComposing ? 1 : 0,
        color: 'var(--text-primary)',
        caretColor: 'var(--black)',
        background: 'transparent',
        padding: 0,
        border: 'none',
        overflow: 'hidden',
        resize: 'none',
        outline: 'none',
        pointerEvents: 'none',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        whiteSpace: 'nowrap',
        zIndex: 100,
      }}
      spellCheck="false"
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
    />
  );
};
