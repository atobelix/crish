import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import attachStyles from './ComposerAttachmentBar.module.css';
import styles from './AnnotationChipItem.module.css';
import type { ChatAttachment } from '../../hooks/chat-stream';
import { openFileInPanel } from '../../api/filePanelOpener';
import { Button, Textarea } from '@/components/ui';
import {
  pathBasename,
  updatePendingFileAnnotationComment,
} from '../../api/workspaceFsApi';
import { AppIcon } from '@/components/ui/icons';
import { useClosingFlag } from '../motion/useExitReveal';
import { useExitReveal } from '../motion/useExitReveal';
import { DURATION_POPOVER_EXIT_MS } from '../../utils/motionTokens';

export interface AnnotationChipItemProps {
  attachment: ChatAttachment;
  isOpen: boolean;
  onRequestOpen: () => void;
  onRequestClose: () => void;
  onRemove: (name: string) => void;
  onOpenPath?: (path: string) => void;
  /**
   * S4 退场：条带移除该 chip 时置 true。chip 根横向收敛 + 淡出；
   * hover 定时器取消、popover 不再打开；popover 自身走下面的
   * useClosingFlag 播 120ms 退场（在 chip 的 200ms 退场窗内播完）。
   */
  closing?: boolean | undefined;
}

export const AnnotationChipItem: React.FC<AnnotationChipItemProps> = React.memo(
  ({
    attachment,
    isOpen,
    onRequestOpen,
    onRequestClose,
    onRemove,
    onOpenPath,
    closing = false,
  }) => {
    const [isFocused, setIsFocused] = useState(false);
    const [draftComment, setDraftComment] = useState(
      attachment.annotation?.comment || ''
    );
    const chipRef = useRef<HTMLSpanElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [posStyle, setPosStyle] = useState<React.CSSProperties | null>(null);
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );

    // S4 退场宿主（popover）：isOpen 翻 false 时保持 portal 挂载播
    // 120ms 退场。popover 不走入场通道（本地 annPopoverFadeIn），
    // entered 取「曾经打开过」——首挂即关闭时直落。
    const wasPopoverOpenRef = useRef(false);
    if (isOpen) wasPopoverOpenRef.current = true;
    const popoverClosing = useClosingFlag(isOpen, {
      key: 'ann-popover',
      durationMs: DURATION_POPOVER_EXIT_MS,
      entered: wasPopoverOpenRef.current,
    });
    // S4 退场（chip 本体）：closing 翻 true 时横向收敛 + 淡出。
    // chip 根自带 composerAttachArrive 入场动画，故直接在根上退场，
    // 不包 wrapper（wrapper 会重挂 chip、入场重播与退场冲突）。
    const exit = useExitReveal({ closing, axis: 'horizontal', gapPx: 8 });

    // S4：退场开始即取消 hover 定时器，杜绝退场中途重开 popover。
    useEffect(() => {
      if (!closing) return undefined;
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = undefined;
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
      return undefined;
    }, [closing]);

    useEffect(() => {
      setDraftComment(attachment.annotation?.comment || '');
    }, [attachment.annotation?.comment]);

    const clearTimers = useCallback(() => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = undefined;
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    }, []);

    const handleMouseEnter = useCallback(() => {
      // S4 退场中：不重开 popover
      if (closing) return;
      clearTimers();
      showTimerRef.current = setTimeout(() => {
        onRequestOpen();
      }, 120);
    }, [clearTimers, onRequestOpen, closing]);

    const handleMouseLeave = useCallback(() => {
      clearTimers();
      if (isFocused) return;
      hideTimerRef.current = setTimeout(() => {
        onRequestClose();
      }, 200);
    }, [clearTimers, isFocused, onRequestClose]);

    const handlePopoverMouseEnter = useCallback(() => {
      clearTimers();
    }, [clearTimers]);

    const handlePopoverMouseLeave = useCallback(() => {
      clearTimers();
      if (isFocused) return;
      hideTimerRef.current = setTimeout(() => {
        onRequestClose();
      }, 200);
    }, [clearTimers, isFocused, onRequestClose]);

    useLayoutEffect(() => {
      if (!isOpen || !chipRef.current) return;
      const rect = chipRef.current.getBoundingClientRect();
      const cardWidth = 320;
      const winW = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const winH = typeof window !== 'undefined' ? window.innerHeight : 800;

      const maxLeft = Math.max(12, winW - cardWidth - 12);
      const left = Math.min(Math.max(12, rect.left), maxLeft);

      // 绝不遮挡胶囊：在视口下方空间有限时，向上锚定，bottom 严格等于 winH - rect.top + 8px
      // 如此卡片底边永远在胶囊上方 8px，卡片再高也绝不会覆盖到胶囊与鼠标！
      const spaceAbove = rect.top;
      const placeAbove = spaceAbove >= 180 || spaceAbove >= winH - rect.bottom;

      if (placeAbove) {
        setPosStyle({
          left: `${left}px`,
          bottom: `${Math.max(0, winH - rect.top + 8)}px`,
          maxHeight: `${Math.max(140, rect.top - 20)}px`,
        });
      } else {
        setPosStyle({
          left: `${left}px`,
          top: `${rect.bottom + 8}px`,
          maxHeight: `${Math.max(140, winH - rect.bottom - 20)}px`,
        });
      }
    }, [isOpen]);

    useEffect(() => {
      if (!isOpen) return;
      const handleOutsideClick = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
          chipRef.current?.contains(target) ||
          popoverRef.current?.contains(target)
        ) {
          return;
        }
        onRequestClose();
        setIsFocused(false);
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onRequestClose();
          setIsFocused(false);
        }
      };
      document.addEventListener('mousedown', handleOutsideClick, true);
      document.addEventListener('keydown', handleKeyDown, true);
      return () => {
        document.removeEventListener('mousedown', handleOutsideClick, true);
        document.removeEventListener('keydown', handleKeyDown, true);
      };
    }, [isOpen, onRequestClose]);

    const handleSave = useCallback(
      (newComment: string) => {
        if (!attachment.annotation?.id) return;
        attachment.annotation.comment = newComment;
        attachment.text = `【代码选区批注: ${attachment.path || attachment.name}】\n选中内容:\n${attachment.annotation.selectedText}\n批注:\n${newComment}`;
        updatePendingFileAnnotationComment(
          attachment.annotation.id,
          newComment
        );
      },
      [attachment]
    );

    const handleCancel = useCallback(() => {
      setDraftComment(attachment.annotation?.comment || '');
      onRequestClose();
      setIsFocused(false);
    }, [attachment.annotation?.comment, onRequestClose]);

    const handleSaveAndClose = useCallback(() => {
      handleSave(draftComment);
      onRequestClose();
      setIsFocused(false);
    }, [draftComment, handleSave, onRequestClose]);

    const openPreview = () => {
      const targetPath = (attachment.path || attachment.name || '').trim();
      const open = onOpenPath ?? openFileInPanel;
      open(targetPath);
    };

    const fileName = attachment.path
      ? pathBasename(attachment.path)
      : attachment.name;

    return (
      <>
        <span
          ref={(el) => {
            chipRef.current = el;
            exit.rootRef(el);
          }}
          role="listitem"
          tabIndex={0}
          data-testid="composer-attach-card"
          data-attach-kind="annotation"
          data-file-type="annotation"
          data-file-name={attachment.name}
          data-file-open-path={attachment.path || attachment.name}
          data-exiting={closing ? 'true' : undefined}
          aria-hidden={closing ? true : undefined}
          className={`${attachStyles.fileCard} ${attachStyles.attachChip} file-card${closing ? ' crish-exit-fade' : ''}`}
          style={closing ? ({ animation: 'none', pointerEvents: 'none' } as React.CSSProperties) : undefined}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={(e) => {
            e.stopPropagation();
            openPreview();
          }}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            onRemove(attachment.name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPreview();
            }
          }}
        >
          <span
            className={`${attachStyles.fileIcon} ${attachStyles.attachIconBox} file-icon`}
            aria-hidden
          >
            <AppIcon
              name="message-square-quote"
              size={20}
              className={attachStyles.attachIcon}
            />
          </span>

          <span
            className={`${attachStyles.fileName} ${attachStyles.attachName} file-name`}
          >
            <span>{fileName}</span>
          </span>

          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={`${attachStyles.fileRemove} ${attachStyles.attachRemove} file-remove chat-attach-remove`}
            aria-label={`移除附件 ${attachment.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(attachment.name);
            }}
          >
            <AppIcon name="x" size={10} aria-hidden />
          </Button>
        </span>

        {popoverClosing.visible &&
          posStyle &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={popoverRef}
              className={styles.annPopoverCard}
              style={posStyle}
              data-closing={popoverClosing.closing ? 'true' : undefined}
              onMouseEnter={handlePopoverMouseEnter}
              onMouseLeave={handlePopoverMouseLeave}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.annPopoverHeader}>
                <span className={styles.annPopoverFileName}>{fileName}</span>
              </div>

              {attachment.annotation?.selectedText && (
                <div
                  className={styles.annSnippetQuote}
                  onWheel={(e) => e.stopPropagation()}
                >
                  <pre className={styles.annSnippetText}>
                    {attachment.annotation.selectedText}
                  </pre>
                </div>
              )}

              <div className={styles.annInputContainer}>
                <Textarea
                  bare
                  className={styles.annCommentInput}
                  value={draftComment}
                  placeholder="写下批注说明… (Enter 保存，Esc 取消)"
                  rows={2}
                  onFocus={() => setIsFocused(true)}
                  onChange={(e) => {
                    setDraftComment(e.target.value);
                  }}
                  onEnter={handleSaveAndClose}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      handleCancel();
                    }
                  }}
                />
              </div>

              <div className={styles.annFooter}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={styles.annCancelBtn}
                  onClick={handleCancel}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  className={styles.annSaveBtn}
                  onClick={handleSaveAndClose}
                >
                  保存
                </Button>
              </div>
            </div>,
            document.body
          )}
      </>
    );
  }
);

AnnotationChipItem.displayName = 'AnnotationChipItem';
