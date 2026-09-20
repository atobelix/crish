import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './FileAnnotationPopover.module.css';
import { Button, Textarea, Tooltip } from '../ui';
import { addPendingFileAnnotation } from '../../api/workspaceFsApi';
import { useSessionStore } from '../../store/storeAccess';
import { AppIcon } from '../ui/icons/index';

export interface FileAnnotationPopoverProps {
  filePath: string;
  containerRef: React.RefObject<HTMLElement | null>;
  targetSessionId?: string | null;
  disabled?: boolean;
  onAnnotated?: () => void;
}

export const FileAnnotationPopover: React.FC<FileAnnotationPopoverProps> = React.memo(
  function FileAnnotationPopover({
    filePath,
    containerRef,
    targetSessionId,
    disabled = false,
    onAnnotated,
  }) {
    const popoverRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [selText, setSelText] = useState('');
    const [commentDraft, setCommentDraft] = useState('');
    const [selAnchor, setSelAnchor] = useState<{ top: number; left: number } | null>(
      null
    );

    const clearSelectionHighlight = useCallback(() => {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        try {
          CSS.highlights.delete('file-annotation-active-selection');
        } catch {
          /* ignore */
        }
      }
    }, []);

    const handleClose = useCallback(() => {
      setSelText('');
      setSelAnchor(null);
      setCommentDraft('');
      clearSelectionHighlight();
    }, [clearSelectionHighlight]);

    useEffect(() => {
      return () => {
        clearSelectionHighlight();
      };
    }, [clearSelectionHighlight]);

    const updateAnchorFromSelection = useCallback(() => {
      if (disabled) {
        handleClose();
        return;
      }

      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      if (!text.length) {
        handleClose();
        return;
      }

      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        handleClose();
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      try {
        const range = selection.getRangeAt(0);
        // 确保选区位于目标容器内部
        const commonAncestor = range.commonAncestorContainer;
        if (!container.contains(commonAncestor)) {
          return;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          return;
        }

        const containerRect = container.getBoundingClientRect();

        // 几何定位：单层轻盈胶囊横向居中于选区，纵向跟随选区底部，支持向上翻转
        const popoverWidth = 280;
        const popoverHeight = 32;

        let top = rect.bottom - containerRect.top + 6;
        // 若下方越界，自适应向上翻转至选区上方
        if (top + popoverHeight > containerRect.height - 10) {
          const topAbove = rect.top - containerRect.top - popoverHeight - 6;
          if (topAbove >= 6) {
            top = topAbove;
          } else {
            top = Math.max(6, containerRect.height - popoverHeight - 10);
          }
        }

        const idealLeft =
          rect.left + rect.width / 2 - containerRect.left - popoverWidth / 2;
        const maxLeft = Math.max(8, containerRect.width - popoverWidth - 10);
        const left = Math.min(Math.max(8, idealLeft), maxLeft);

        setSelText(text.slice(0, 2000));
        setSelAnchor({ top, left });

        // 注册持久化选区高亮：当焦点进入 input 浮层时，浏览器底层通过 CSS.highlights 保持选中文本的高亮态
        if (
          typeof Highlight !== 'undefined' &&
          typeof CSS !== 'undefined' &&
          CSS.highlights
        ) {
          try {
            const highlight = new Highlight(range.cloneRange());
            CSS.highlights.set('file-annotation-active-selection', highlight);
          } catch {
            /* ignore */
          }
        }
      } catch {
        handleClose();
      }
    }, [containerRef, disabled, handleClose]);

    // 监听选区变化与鼠标事件
    useEffect(() => {
      const container = containerRef.current;
      if (!container || disabled) return;

      const handleMouseDown = (e: MouseEvent) => {
        // 若点击在批注框内，不收起
        if (popoverRef.current && popoverRef.current.contains(e.target as Node)) {
          return;
        }
        // 用户在编辑器中按下鼠标准备开始新拖选或取消选区，即刻收起浮层，保证拖选原生流畅
        handleClose();
      };

      const handleMouseUp = (e: MouseEvent) => {
        if (popoverRef.current && popoverRef.current.contains(e.target as Node)) {
          return;
        }
        updateAnchorFromSelection();
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleClose();
          return;
        }
        if (popoverRef.current && popoverRef.current.contains(e.target as Node)) {
          return;
        }
        updateAnchorFromSelection();
      };

      container.addEventListener('mousedown', handleMouseDown);
      container.addEventListener('mouseup', handleMouseUp);
      container.addEventListener('keyup', handleKeyUp);

      return () => {
        container.removeEventListener('mousedown', handleMouseDown);
        container.removeEventListener('mouseup', handleMouseUp);
        container.removeEventListener('keyup', handleKeyUp);
      };
    }, [containerRef, disabled, updateAnchorFromSelection, handleClose]);

    // 容器滚动时动态重新计算或安全隐藏
    useEffect(() => {
      if (!selAnchor) return;
      const container = containerRef.current;
      if (!container) return;

      const handleScroll = () => {
        requestAnimationFrame(updateAnchorFromSelection);
      };

      container.addEventListener('scroll', handleScroll, {
        capture: true,
        passive: true,
      });
      return () => {
        container.removeEventListener('scroll', handleScroll, { capture: true });
      };
    }, [containerRef, selAnchor, updateAnchorFromSelection]);

    // 点击浮层外部自动收起
    useEffect(() => {
      if (!selAnchor) return;

      const handleWindowMouseDown = (e: MouseEvent) => {
        if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
          handleClose();
        }
      };

      window.addEventListener('mousedown', handleWindowMouseDown);
      return () => {
        window.removeEventListener('mousedown', handleWindowMouseDown);
      };
    }, [selAnchor, handleClose]);

    const handleSubmit = useCallback(() => {
      if (!filePath || !selText.trim() || !commentDraft.trim()) return;

      const activeSid =
        targetSessionId || useSessionStore.getState().activeSessionId || undefined;

      addPendingFileAnnotation(
        {
          path: filePath,
          selectedText: selText.trim(),
          text: commentDraft.trim(),
        },
        activeSid ? { targetSessionId: activeSid } : undefined
      );

      handleClose();
      onAnnotated?.();
    }, [filePath, selText, commentDraft, targetSessionId, onAnnotated, handleClose]);

    if (!selText || !selAnchor || disabled) {
      return null;
    }

    const hasInput = Boolean(commentDraft.trim());

    return (
      <div
        ref={popoverRef}
        className={styles.popover}
        role="dialog"
        aria-label="添加代码批注"
        data-annotation-popover="true"
        style={{
          top: `${selAnchor.top}px`,
          left: `${selAnchor.left}px`,
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
      >
        <Textarea
          bare
          ref={textareaRef}
          className={styles.nativeTextarea}
          value={commentDraft}
          rows={1}
          onChange={(e) => {
            setCommentDraft(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(100, Math.max(22, el.scrollHeight))}px`;
          }}
          placeholder="添加批注…"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleClose();
            }
          }}
        />

        <div className={styles.actionGroup}>
          <Tooltip content="添加 (Enter)">
            <Button
              type="button"
              variant="ghost"
              className={`${styles.actionBtn} ${hasInput ? styles.actionBtnActive : ''}`}
              aria-label="确认添加批注"
              disabled={!hasInput}
              onClick={handleSubmit}
            >
              <AppIcon name="corner-down-left" size={12} />
            </Button>
          </Tooltip>
          <Tooltip content="取消 (Esc)">
            <Button
              type="button"
              variant="ghost"
              className={`${styles.actionBtn} ${styles.closeBtn}`}
              aria-label="取消"
              onClick={handleClose}
            >
              <AppIcon name="x" size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }
);

FileAnnotationPopover.displayName = 'FileAnnotationPopover';

