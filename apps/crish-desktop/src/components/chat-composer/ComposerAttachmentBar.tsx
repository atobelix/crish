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
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatComposer.module.css';
import { Tooltip } from '../ui';
import { FileFormatIcon } from '../../assets/icons';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { openFileInPanel } from '../../api/filePanelOpener';
import {
  formatAttachmentSize,
  getFileKindBadge,
  isImageAttachmentItem,
  resolveCardImageSrc,
} from '../chat-attachment/AttachmentCard';
import {
  useActiveModelAcceptsImage,
  isComplexDocChatAttachment,
} from '../../api/modelVisionSupport';

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
    a.isImage ||
    a.dataUrl ||
    (a.mime && a.mime.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(a.name || a.path || '')
  ) {
    return 'image';
  }
  if (/\.(csv|tsv|xlsx?)$/i.test(a.name || a.path || '')) {
    return 'table';
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|json)$/i.test(a.name || a.path || '')) {
    return 'code';
  }
  if (a.text || /\.(md|markdown|txt|log|ya?ml|toml)$/i.test(a.name || a.path || '')) {
    return 'text';
  }
  return 'file';
}

import { AnnotationChipItem } from './AnnotationChipItem';

interface RegularChipItemProps {
  attachment: ChatAttachment;
  kind: AttachKind;
  onRemove: (id: string) => void;
  onOpenPreview: (a: ChatAttachment) => void;
}

const RegularChipItem: React.FC<RegularChipItemProps> = React.memo(
  ({ attachment: a, kind, onRemove, onOpenPreview }) => {
    const [thumbError, setThumbError] = useState(false);
    const isImg =
      kind === 'image' ||
      isImageAttachmentItem({
        name: a.name,
        path: a.path,
        mime: a.mime,
        dataUrl: a.dataUrl,
        isImage: a.isImage,
      });
    const thumbCandidate = a.thumbnailUrl || a.dataUrl;
    const thumbSrc = isImg
      ? thumbCandidate &&
        (thumbCandidate.startsWith('data:') ||
          thumbCandidate.startsWith('blob:') ||
          thumbCandidate.startsWith('asset:') ||
          thumbCandidate.startsWith('http://') ||
          thumbCandidate.startsWith('https://'))
        ? thumbCandidate
        : resolveCardImageSrc({
            name: a.name,
            path: a.path || thumbCandidate,
            mime: a.mime,
            dataUrl: thumbCandidate,
            isImage: true,
          })
      : undefined;
    const hasThumb = Boolean(thumbSrc) && !thumbError;
    const isParsing =
      a.status === 'parsing' ||
      (typeof a.progress === 'number' && a.progress < 100);
    const progressVal =
      typeof a.progress === 'number' ? Math.round(a.progress) : 0;
    const removeId = a.id || a.name;

    const extBadge = getFileKindBadge(a.name || a.path || '');
    const sizeText = formatAttachmentSize((a as { size?: number }).size);

    const acceptsImage = useActiveModelAcceptsImage();
    const warnText = React.useMemo(() => {
      if (acceptsImage) return null;
      if (isImg) {
        return '当前模型不支持多模态视觉解析，发送时可能无法理解此图片内容';
      }
      if (isComplexDocChatAttachment(a)) {
        return '当前模型不支持复杂文档解析，发送时可能无法理解此文档内容';
      }
      return null;
    }, [acceptsImage, isImg, a]);

    return (
      <Tooltip content={warnText ? `${a.name}（⚠️ ${warnText}）` : a.name}>
        <span
          role="listitem"
          tabIndex={0}
          data-testid="composer-attach-card"
          data-attach-kind={kind}
          data-file-type={kind}
          data-file-name={a.name}
          data-file-open-path={a.path || a.name}
          className={`${styles.fileCard} ${styles.attachChip} file-card ${
            isImg
              ? `${styles.attachChipImage} type-image`
              : `${styles.fileCardHorizontal}`
          }`}
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
          {/* 左上角橙色感叹号：当前模型不支持视觉/复杂文档时就地预警 */}
          {warnText ? (
            <Tooltip content={warnText}>
              <span
                className={`${styles.attachWarnBadge} attach-warn-badge`}
                data-testid="composer-attach-warn-badge"
                aria-label={warnText}
                onClick={(e) => e.stopPropagation()}
              >
                <Lucide.AlertCircle size={12} strokeWidth={2.4} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : null}
          {isImg ? (
            hasThumb ? (
              <img
                src={thumbSrc}
                alt={a.name}
                onError={() => setThumbError(true)}
                className={`${styles.fileThumbnail} ${styles.attachThumb} file-thumbnail`}
              />
            ) : (
              <span className={`${styles.fileIcon} ${styles.attachIconBox} file-icon`} aria-hidden>
                <Lucide.ImageOff size={20} className={styles.attachIcon} />
              </span>
            )
          ) : (
            <>
              <span className={`${styles.fileIcon} ${styles.fileIconBox} file-icon`} aria-hidden>
                <FileFormatIcon fileName={a.name || a.path || ''} size={20} className={styles.attachIcon} />
              </span>
              <span className={`${styles.fileInfoCol} ${styles.fileInfo}`}>
                <span className={`${styles.fileName} ${styles.attachName} file-name`}>
                  {a.name}
                </span>
                <span className={styles.fileMeta}>
                  {extBadge}{sizeText ? ` · ${sizeText}` : ''}
                </span>
              </span>
            </>
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
                className={`${styles.attachProgressBadge} ${isImg ? styles.attachProgressBadgeImage : ''}`}
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
