/**
 * Layer 3: 上下文与文件引用卡片区（Attachment Bar）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.4 与 reference/chat-composer-component/css/file-cards.css
 * - 24px 高度圆角芯片卡片（.file-card / .attachChip）；
 * - 官方 160+ 高频彩色格式图标（FileFormatIcon）；
 * - 文件名省略号截断；
 * - 右上角微型删除叉号（.file-remove，无阴影扁平圆钮，Hover 变红）；
 * - 图片缩略图预览（24px）；
 * - 点击文件名/卡片在右侧打开该文件（openFileInPanel / onOpenPath）。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../ui';
import { FileFormatIcon } from '../../assets/icons';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { openFileInPanel } from '../../api/filePanelOpener';
import {
  pathBasename,
  updatePendingFileAnnotationComment,
} from '../../api/workspaceFsApi';

export interface ComposerAttachmentBarProps {
  attachments: ChatAttachment[];
  onRemoveAttachment: (name: string) => void;
  /** 点卡开预览；缺省走 openFileInPanel（工作区叶） */
  onOpenPath?: (path: string) => void;
}

export type AttachKind = 'image' | 'code' | 'table' | 'text' | 'file' | 'annotation';

export function attachKind(a: ChatAttachment): AttachKind {
  if (a.annotation || a.mime === 'text/x-annotation') {
    return 'annotation';
  }
  if (
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
  ) {
    return 'image';
  }
  if (/\.(csv|tsv|xlsx?)$/i.test(a.name)) {
    return 'table';
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(a.name)) {
    return 'code';
  }
  if (a.text || /\.(md|markdown|txt|log|ya?ml|toml)$/i.test(a.name)) {
    return 'text';
  }
  return 'file';
}

interface AnnotationChipItemProps {
  attachment: ChatAttachment;
  isOpen: boolean;
  onRequestOpen: () => void;
  onRequestClose: () => void;
  onRemove: (name: string) => void;
  onOpenPath?: (path: string) => void;
}

export const AnnotationChipItem: React.FC<AnnotationChipItemProps> = React.memo(
  ({
    attachment,
    isOpen,
    onRequestOpen,
    onRequestClose,
    onRemove,
    onOpenPath,
  }) => {
    const [isFocused, setIsFocused] = useState(false);
    const [draftComment, setDraftComment] = useState(
      attachment.annotation?.comment || ''
    );
    const chipRef = useRef<HTMLSpanElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [posStyle, setPosStyle] = useState<React.CSSProperties | null>(null);
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      clearTimers();
      showTimerRef.current = setTimeout(() => {
        onRequestOpen();
      }, 120);
    }, [clearTimers, onRequestOpen]);

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
      const placeAbove = spaceAbove >= 180 || spaceAbove >= (winH - rect.bottom);

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
        updatePendingFileAnnotationComment(attachment.annotation.id, newComment);
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

    const fileName = attachment.path ? pathBasename(attachment.path) : attachment.name;

    return (
      <>
        <span
          ref={chipRef}
          role="listitem"
          tabIndex={0}
          data-testid="composer-attach-card"
          data-attach-kind="annotation"
          data-file-type="annotation"
          data-file-name={attachment.name}
          data-file-open-path={attachment.path || attachment.name}
          className={`${styles.fileCard} ${styles.attachChip} file-card`}
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
          <span className={`${styles.fileIcon} ${styles.attachIconBox} file-icon`} aria-hidden>
            <Lucide.MessageSquareQuote size={20} className={styles.attachIcon} />
          </span>

          <span className={`${styles.fileName} ${styles.attachName} file-name`}>
            <span>批注</span>
            <span className={styles.dotSep}>·</span>
            <span>{fileName}</span>
          </span>

          <button
            type="button"
            className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
            aria-label={`移除附件 ${attachment.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(attachment.name);
            }}
          >
            <Lucide.X size={10} strokeWidth={2.2} aria-hidden />
          </button>
        </span>

        {isOpen &&
          posStyle &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={popoverRef}
              className={styles.annPopoverCard}
              style={posStyle}
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
                <textarea
                  className={styles.annCommentInput}
                  value={draftComment}
                  placeholder="写下批注说明… (Enter 保存，Esc 取消)"
                  rows={2}
                  onFocus={() => setIsFocused(true)}
                  onChange={(e) => {
                    setDraftComment(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveAndClose();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      handleCancel();
                    }
                  }}
                />
              </div>

              <div className={styles.annFooter}>
                <button
                  type="button"
                  className={styles.annCancelBtn}
                  onClick={handleCancel}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={styles.annSaveBtn}
                  onClick={handleSaveAndClose}
                >
                  保存
                </button>
              </div>
            </div>,
            document.body
          )}
      </>
    );
  }
);

AnnotationChipItem.displayName = 'AnnotationChipItem';

interface RegularChipItemProps {
  attachment: ChatAttachment;
  kind: AttachKind;
  onRemove: (id: string) => void;
  onOpenPreview: (a: ChatAttachment) => void;
}

const RegularChipItem: React.FC<RegularChipItemProps> = React.memo(
  ({ attachment: a, kind, onRemove, onOpenPreview }) => {
    const [thumbError, setThumbError] = useState(false);
    const thumbSrc = a.thumbnailUrl || a.dataUrl;
    const hasThumb = Boolean(thumbSrc) && !thumbError;
    const isParsing =
      a.status === 'parsing' ||
      (typeof a.progress === 'number' && a.progress < 100);
    const progressVal =
      typeof a.progress === 'number' ? Math.round(a.progress) : 0;
    const removeId = a.id || a.name;

    return (
      <Tooltip content={a.name}>
        <span
          role="listitem"
          tabIndex={0}
          data-testid="composer-attach-card"
          data-attach-kind={kind}
          data-file-type={kind}
          data-file-name={a.name}
          data-file-open-path={a.path || a.name}
          className={`${styles.fileCard} ${styles.attachChip} file-card ${hasThumb ? `${styles.attachChipImage} type-image` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenPreview(a);
          }}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            onRemove(removeId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenPreview(a);
            }
          }}
        >
          {hasThumb ? (
            <img
              src={thumbSrc}
              alt={a.name}
              onError={() => setThumbError(true)}
              className={`${styles.fileThumbnail} ${styles.attachThumb} file-thumbnail`}
            />
          ) : (
            <span className={`${styles.fileIcon} ${styles.attachIconBox} file-icon`} aria-hidden>
              <FileFormatIcon fileName={a.name} size={20} className={styles.attachIcon} />
            </span>
          )}

          {hasThumb ? null : (
            <span className={`${styles.fileName} ${styles.attachName} file-name`}>
              {a.name}
            </span>
          )}

          {isParsing && (
            <>
              <svg
                className={styles.attachProgressBorder}
                viewBox="0 0 58 58"
                aria-hidden
              >
                <rect
                  x="1"
                  y="1"
                  width="56"
                  height="56"
                  rx="11"
                  fill="none"
                  stroke="var(--composer-attach-progress-color, var(--accent-primary, #10b981))"
                  strokeWidth="2"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - (progressVal || 25)}
                />
              </svg>
              <span
                className={`${styles.attachProgressBadge} ${hasThumb ? styles.attachProgressBadgeImage : ''}`}
                aria-label={`上传解析进度 ${progressVal}%`}
              >
                {progressVal > 0 ? `${progressVal}%` : '…'}
              </span>
            </>
          )}

          <button
            type="button"
            className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
            aria-label={`移除附件 ${a.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(removeId);
            }}
          >
            <Lucide.X size={10} strokeWidth={2.2} aria-hidden />
          </button>
        </span>
      </Tooltip>
    );
  }
);

RegularChipItem.displayName = 'RegularChipItem';

export const ComposerAttachmentBar: React.FC<ComposerAttachmentBarProps> = ({
  attachments,
  onRemoveAttachment,
  onOpenPath,
}) => {
  const [activePopoverId, setActivePopoverId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const openPreview = (a: ChatAttachment) => {
    if (a.path && a.path !== a.name) {
      const open = onOpenPath ?? openFileInPanel;
      open(a.path.trim());
      return;
    }
    if (a.dataUrl) {
      const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
      if (win) {
        win.document.write(
          `<!DOCTYPE html><html><head><title>${a.name}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#111;}img{max-width:95vw;max-height:95vh;object-fit:contain;}</style></head><body><img src="${a.dataUrl}" alt="${a.name}"/></body></html>`
        );
        win.document.close();
      }
      return;
    }
    const targetPath = (a.path || a.name || '').trim();
    const open = onOpenPath ?? openFileInPanel;
    open(targetPath);
  };

  return (
    <div
      className={`${styles.fileZone} ${styles.attachStrip} file-zone`}
      role="list"
      aria-label={`附件，共 ${attachments.length} 个`}
      data-testid="composer-attach-strip"
    >
      {attachments.map((a, index) => {
        const kind = attachKind(a);
        const itemKey = a.id || (a.annotation ? a.annotation.id : `${a.path || a.name}_${index}`);
        if (kind === 'annotation' && a.annotation) {
          return (
            <AnnotationChipItem
              key={itemKey}
              attachment={a}
              isOpen={activePopoverId === itemKey}
              onRequestOpen={() => setActivePopoverId(itemKey)}
              onRequestClose={() =>
                setActivePopoverId((prev) => (prev === itemKey ? null : prev))
              }
              onRemove={onRemoveAttachment}
              onOpenPath={onOpenPath}
            />
          );
        }

        return (
          <RegularChipItem
            key={itemKey}
            attachment={a}
            kind={kind}
            onRemove={onRemoveAttachment}
            onOpenPreview={openPreview}
          />
        );
      })}
    </div>
  );
};
