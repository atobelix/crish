import React, { useCallback, useEffect, useMemo, useState } from 'react';

import styles from './AttachmentCard.module.css';
import { Button, Tooltip } from '../ui';
import { FileFormatIcon } from '../../assets/icons';
import {
  useActiveModelAcceptsImage,
  isComplexDocChatAttachment,
} from '../../api/modelVisionSupport';

/**
 * 进度环载荷描边宽度。
 * 注意：这是几何图形参数（56×56 视口的进度弧视觉重量），**不是图标描边**，
 * 因此不走 ICON_STROKE 契约；在此具名以免散落裸数字被误纳入图标线宽口径。
 */
const PROGRESS_RING_STROKE = 2;

export interface AttachmentItem {
  id?: string;
  name?: string;
  path?: string;
  mime?: string;
  size?: number;
  dataUrl?: string;
  thumbnailUrl?: string;
  status?: string;
  progress?: number;
  alt?: string;
  isImage?: boolean;
  missing?: boolean;
  error?: boolean;
}

export interface AttachmentCardProps {
  item: AttachmentItem;
  onClick?: (item: AttachmentItem) => void;
  onRemove?: (item: AttachmentItem) => void;
  onAuxClick?: (e: React.MouseEvent, item: AttachmentItem) => void;
  warnText?: string | null;
  progress?: number;
  status?: string;
  kind?: string;
  testId?: string;
  className?: string;
}

/**
 * 格式化附件文件大小显示
 */
export {
  formatAttachmentSize,
  normalizeMessageAttachments,
  isImageAttachmentItem,
  resolveCardImageSrc,
  getFileKindBadge,
} from './attachmentCardUtils';
import {
  formatAttachmentSize,
  isImageAttachmentItem,
  resolveCardImageSrc,
  getFileKindBadge,
} from './attachmentCardUtils';
import { AppIcon } from '../ui/icons';

export const AttachmentCard: React.FC<AttachmentCardProps> = React.memo(
  ({
    item,
    onClick,
    onRemove,
    onAuxClick,
    warnText: warnTextProp,
    progress: progressProp,
    status: statusProp,
    kind: kindProp,
    testId,
    className,
  }) => {
    const isImage = useMemo(() => isImageAttachmentItem(item), [item]);
    const imgSrc = useMemo(
      () => (isImage ? resolveCardImageSrc(item) : ''),
      [isImage, item]
    );

    const [imgError, setImgError] = useState(false);

    useEffect(() => {
      setImgError(false);
    }, [item.path, item.dataUrl, item.thumbnailUrl]);

    const extBadge = useMemo(
      () => getFileKindBadge(item.name || item.path || ''),
      [item.name, item.path]
    );

    const sizeText = useMemo(
      () => formatAttachmentSize(item.size),
      [item.size]
    );

    const isItemMissing = Boolean(item.missing || item.error);
    const isImageMissing = isImage && (imgError || !imgSrc || isItemMissing);

    const acceptsImage = useActiveModelAcceptsImage();
    const warnText = useMemo(() => {
      if (warnTextProp !== undefined) return warnTextProp;
      if (acceptsImage) return null;
      if (isImage) {
        return '当前模型不支持多模态视觉解析，发送时可能无法理解此图片内容';
      }
      if (
        isComplexDocChatAttachment({
          name: item.name,
          path: item.path,
          mime: item.mime,
        })
      ) {
        return '当前模型不支持复杂文档解析，发送时可能无法理解此文档内容';
      }
      return null;
    }, [warnTextProp, acceptsImage, isImage, item.name, item.path, item.mime]);

    const effectiveStatus = statusProp || item.status;
    const effectiveProgress =
      typeof progressProp === 'number' ? progressProp : item.progress;
    const isParsing =
      effectiveStatus === 'parsing' ||
      (typeof effectiveProgress === 'number' && effectiveProgress < 100);
    const progressVal =
      typeof effectiveProgress === 'number'
        ? Math.round(effectiveProgress)
        : 0;

    const tooltipContent = useMemo(() => {
      const baseName = isImage
        ? isImageMissing
          ? '[图片无法加载] 本地文件已被移动或删除'
          : item.name || item.path || '图片'
        : isItemMissing
        ? item.name || item.path
          ? `[文件失效] ${item.name || item.path}`
          : '[文件无法访问] 本地文件已被移动或删除'
        : item.name || item.path || '附件';

      if (warnText) {
        return `${baseName}（警告: ${warnText}）`;
      }
      return baseName;
    }, [isImage, isImageMissing, isItemMissing, item.name, item.path, warnText]);

    // 核心拦截（MIN-01）：阻断点击冒泡，严禁意外触发气泡折叠
    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onClick?.(item);
      },
      [onClick, item]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick?.(item);
        }
      },
      [onClick, item]
    );

    const handleAuxClick = useCallback(
      (e: React.MouseEvent) => {
        if (onAuxClick) {
          onAuxClick(e, item);
        } else if (e.button === 1 && onRemove) {
          e.preventDefault();
          e.stopPropagation();
          onRemove(item);
        }
      },
      [onAuxClick, onRemove, item]
    );

    const defaultTestId = onRemove ? 'composer-attach-card' : 'attachment-card-58';
    const resolvedTestId = testId || defaultTestId;
    const kind = kindProp || (isImage ? 'image' : 'file');

    // 图片模式 (Image Mode - 统一 58×58)
    if (isImage) {
      if (isImageMissing) {
        return (
          <Tooltip content={tooltipContent}>
            <div
              role="button"
              tabIndex={0}
              aria-label={
                item.name || item.path
                  ? `附件失效: ${item.name || item.path}`
                  : '图片无法加载'
              }
              className={`${styles.attachmentCard} ${styles.cardImageMode} ${styles.attachChipImage} ${styles.missingCard} file-card type-image ${className || ''}`}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              onAuxClick={handleAuxClick}
              data-testid={resolvedTestId}
              data-attach-kind={kind}
              data-file-type={kind}
              data-file-name={item.name}
              data-file-open-path={item.path || item.name}
            >
              {warnText ? (
                <Tooltip content={warnText}>
                  <span
                    className={`${styles.attachWarnBadge} attach-warn-badge`}
                    data-testid="composer-attach-warn-badge"
                    aria-label={warnText}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AppIcon name="alert-circle" size={12} aria-hidden="true" />
                  </span>
                </Tooltip>
              ) : null}
              <AppIcon name="image-off" size={20} className={styles.missingIcon} />
              <span className={styles.missingBadge}>失效</span>
              {onRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
                  aria-label={`移除附件 ${item.name || '图片'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(item);
                  }}
                >
                  <AppIcon name="x" size={10} aria-hidden />
                </Button>
              ) : null}
            </div>
          </Tooltip>
        );
      }

      return (
        <Tooltip content={tooltipContent}>
          <div
            role="button"
            tabIndex={0}
            aria-label={
              item.name || item.path
                ? `附件: ${item.name || item.path}`
                : '附件卡片'
            }
            className={`${styles.attachmentCard} ${styles.cardImageMode} ${styles.attachChipImage} file-card type-image ${className || ''}`}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onAuxClick={handleAuxClick}
            data-testid={resolvedTestId}
            data-attach-kind={kind}
            data-file-type={kind}
            data-file-name={item.name}
            data-file-open-path={item.path || item.name}
          >
            {warnText ? (
              <Tooltip content={warnText}>
                <span
                  className={`${styles.attachWarnBadge} attach-warn-badge`}
                  data-testid="composer-attach-warn-badge"
                  aria-label={warnText}
                  onClick={(e) => e.stopPropagation()}
                >
                  <AppIcon name="alert-circle" size={12} aria-hidden="true" />
                </span>
              </Tooltip>
            ) : null}
            <div className={styles.imageBox}>
              <img
                src={imgSrc}
                onError={() => setImgError(true)}
                alt={item.name || item.alt || '图片预览'}
                className={`${styles.imagePreview} ${styles.fileThumbnail} ${styles.attachThumb} file-thumbnail`}
                loading="lazy"
              />
            </div>
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
                    stroke="var(--composer-attach-progress-color, var(--accent-primary))"
                    strokeWidth={PROGRESS_RING_STROKE}
                    pathLength="100"
                    strokeDasharray="100"
                    strokeDashoffset={100 - (progressVal || 25)}
                  />
                </svg>
                <span
                  className={`${styles.attachProgressBadge} ${styles.attachProgressBadgeImage}`}
                  aria-label={`上传解析进度 ${progressVal}%`}
                >
                  {progressVal > 0 ? `${progressVal}%` : '…'}
                </span>
              </>
            )}
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
                aria-label={`移除附件 ${item.name || '图片'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item);
                }}
              >
                <AppIcon name="x" size={10} aria-hidden />
              </Button>
            ) : null}
          </div>
        </Tooltip>
      );
    }

    // 文件/文档模式 (Document/File Mode - 48~52px 高度, 160~220px 宽度横向微卡片)
    const displayName =
      item.name || (item.path ? item.path.split(/[\\/]/).pop() : '') || '附件';

    return (
      <Tooltip content={tooltipContent}>
        <div
          role="button"
          tabIndex={0}
          aria-label={
            item.name || item.path
              ? `附件: ${item.name || item.path}`
              : '附件卡片'
          }
          className={`${styles.attachmentCard} ${styles.fileCardHorizontal} file-card ${isItemMissing ? styles.missingCard : ''} ${className || ''}`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onAuxClick={handleAuxClick}
          data-testid={resolvedTestId}
          data-attach-kind={kind}
          data-file-type={kind}
          data-file-name={item.name}
          data-file-open-path={item.path || item.name}
        >
          {warnText ? (
            <Tooltip content={warnText}>
              <span
                className={`${styles.attachWarnBadge} attach-warn-badge`}
                data-testid="composer-attach-warn-badge"
                aria-label={warnText}
                onClick={(e) => e.stopPropagation()}
              >
                <AppIcon name="alert-circle" size={12} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : null}
          <div className={`${styles.fileIconBox} ${styles.fileIcon} file-icon`}>
            {isItemMissing ? (
              <AppIcon name="file-question" size={18} className={styles.missingIcon} />
            ) : (
              <FileFormatIcon
                fileName={item.name || item.path || ''}
                size={20}
                className={styles.attachIcon}
              />
            )}
          </div>
          <div className={`${styles.fileInfoCol} ${styles.fileInfo}`}>
            <span
              className={`${styles.fileName} ${styles.fileNameText} ${styles.attachName} file-name ${isItemMissing ? styles.fileNameMissing : ''}`}
            >
              {item.name || displayName}
            </span>
            <span className={`${styles.fileMeta} ${styles.fileMetaText}`}>
              {extBadge} {sizeText ? `· ${sizeText}` : ''}
            </span>
          </div>
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
                  stroke="var(--composer-attach-progress-color, var(--accent-primary))"
                  strokeWidth={PROGRESS_RING_STROKE}
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - (progressVal || 25)}
                />
              </svg>
              <span
                className={styles.attachProgressBadge}
                aria-label={`上传解析进度 ${progressVal}%`}
              >
                {progressVal > 0 ? `${progressVal}%` : '…'}
              </span>
            </>
          )}
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
              aria-label={`移除附件 ${item.name || displayName}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item);
              }}
            >
              <AppIcon name="x" size={10} aria-hidden />
            </Button>
          ) : null}
        </div>
      </Tooltip>
    );
  }
);

AttachmentCard.displayName = 'AttachmentCard';
