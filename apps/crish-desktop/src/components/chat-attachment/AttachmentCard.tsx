import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './AttachmentCard.module.css';
import { Tooltip } from '../ui';
import { FileFormatIcon } from '../../assets/icons';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isAbsoluteFsPath } from '../../api/workspaceFsApi';
import type { SessionMessage } from '../../store/types';

export interface AttachmentItem {
  id?: string;
  name?: string;
  path?: string;
  mime?: string;
  size?: number;
  dataUrl?: string;
  alt?: string;
  isImage?: boolean;
  missing?: boolean;
  error?: boolean;
}

export interface AttachmentCardProps {
  item: AttachmentItem;
  onClick?: (item: AttachmentItem) => void;
  className?: string;
}

/**
 * 格式化附件文件大小显示
 */
export function formatAttachmentSize(bytes?: number): string {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 附件单轨归一化算法（附件优先、图片融合、指纹去重防回潮）。
 * 由 ChatUserMessageRow 消费；本组件文件一并导出（SSOT，§7.3 直接 import）。
 */
export function normalizeMessageAttachments(
  attachments?: SessionMessage['attachments'],
  images?: SessionMessage['images']
): AttachmentItem[] {
  const result: AttachmentItem[] = [];
  const seenFingerprints = new Set<string>();

  // 1. 优先提取显式附件 (msg.attachments)
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      const key = (a.path || a.name || '').trim().toLowerCase();
      if (key) {
        seenFingerprints.add(key);
      }
      result.push({
        name: a.name,
        path: a.path,
        mime: a.mime,
        size: (a as { size?: number }).size,
        dataUrl: a.dataUrl,
      });
    }
  }

  // 2. 融合图片数据 (msg.images)，去重防回潮
  if (Array.isArray(images)) {
    for (const img of images) {
      const key = (img.source || '').trim().toLowerCase();
      if (key && seenFingerprints.has(key)) {
        continue; // 命中指纹，剔除重复
      }
      if (key) {
        seenFingerprints.add(key);
      }
      result.push({
        id: img.id,
        name: img.alt || (img.source.split(/[\\/]/).pop() || '图片'),
        path: img.source,
        dataUrl: img.resolvedUrl,
        alt: img.alt,
        isImage: true,
      });
    }
  }

  return result;
}

export function isImageAttachmentItem(item: AttachmentItem): boolean {
  if (item.isImage === false) return false;
  if (item.isImage) return true;
  if (item.mime && item.mime.startsWith('image/')) return true;
  const target = item.name || item.path || '';
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(target);
}

export function resolveCardImageSrc(item: AttachmentItem): string {
  if (item.dataUrl) return item.dataUrl;
  const source = item.path || '';
  if (!source) return '';
  if (
    source.startsWith('data:') ||
    source.startsWith('blob:') ||
    source.startsWith('http://') ||
    source.startsWith('https://')
  ) {
    return source;
  }
  if (isAbsoluteFsPath(source)) {
    return convertFileSrc(source);
  }
  return source;
}

export function getFileKindBadge(nameOrPath: string): string {
  const ext = nameOrPath.split('.').pop()?.toUpperCase();
  if (!ext || ext.length > 5) return 'FILE';
  return ext;
}

export const AttachmentCard: React.FC<AttachmentCardProps> = React.memo(
  ({ item, onClick, className }) => {
    const isImage = useMemo(() => isImageAttachmentItem(item), [item]);
    const imgSrc = useMemo(
      () => (isImage ? resolveCardImageSrc(item) : ''),
      [isImage, item]
    );

    const [imgError, setImgError] = useState(false);

    useEffect(() => {
      setImgError(false);
    }, [item.path, item.dataUrl]);

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

    const tooltipContent = useMemo(() => {
      if (isImage) {
        if (isImageMissing) {
          return '[图片无法加载] 本地文件已被移动或删除';
        }
        return item.name || item.path || '图片';
      }
      if (isItemMissing) {
        return item.name || item.path
          ? `[文件失效] ${item.name || item.path}`
          : '[文件无法访问] 本地文件已被移动或删除';
      }
      return item.path || item.name || '附件';
    }, [isImage, isImageMissing, isItemMissing, item.name, item.path]);

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

    // 图片模式 (Image Mode - 58×58)
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
              className={`${styles.attachmentCard} ${styles.cardImageMode} ${styles.missingCard} ${className || ''}`}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              data-testid="attachment-card-58"
            >
              <Lucide.ImageOff size={20} className={styles.missingIcon} />
              <span className={styles.missingBadge}>失效</span>
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
            className={`${styles.attachmentCard} ${styles.cardImageMode} ${className || ''}`}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            data-testid="attachment-card-58"
          >
            <div className={styles.imageBox}>
              <img
                src={imgSrc}
                onError={() => setImgError(true)}
                alt={item.name || item.alt || '图片预览'}
                className={styles.imagePreview}
                loading="lazy"
              />
            </div>
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
          className={`${styles.attachmentCard} ${styles.fileCardHorizontal} ${isItemMissing ? styles.missingCard : ''} ${className || ''}`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          data-testid="attachment-card-58"
        >
          <div className={styles.fileIconBox}>
            {isItemMissing ? (
              <Lucide.FileQuestion size={18} className={styles.missingIcon} />
            ) : (
              <FileFormatIcon
                fileName={item.name || item.path || ''}
                size={20}
              />
            )}
          </div>
          <div className={`${styles.fileInfoCol} ${styles.fileInfo}`}>
            <span
              className={`${styles.fileName} ${styles.fileNameText} ${isItemMissing ? styles.fileNameMissing : ''}`}
            >
              {item.name || displayName}
            </span>
            <span className={`${styles.fileMeta} ${styles.fileMetaText}`}>
              {extBadge} {sizeText ? `· ${sizeText}` : ''}
            </span>
          </div>
        </div>
      </Tooltip>
    );
  }
);

AttachmentCard.displayName = 'AttachmentCard';
