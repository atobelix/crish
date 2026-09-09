import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './AttachmentCard.module.css';
import { Tooltip } from '../ui';
import { FileFormatIcon } from '../../assets/icons';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  getWorkspacePath,
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from '../../api/workspaceFsApi';
import {
  useActiveModelAcceptsImage,
  isComplexDocChatAttachment,
} from '../../api/modelVisionSupport';
import type { SessionMessage } from '../../store/types';

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

  // 预建 images 映射，供 attachments 中的图片项回填 resolvedUrl
  const imageMap = new Map<string, NonNullable<SessionMessage['images']>[number]>();
  if (Array.isArray(images)) {
    for (const img of images) {
      const k1 = (img.source || '').trim().toLowerCase();
      if (k1) imageMap.set(k1, img);
      const k2 = (img.alt || '').trim().toLowerCase();
      if (k2) imageMap.set(k2, img);
      const name = (img.source.split(/[\\/]/).pop() || '').trim().toLowerCase();
      if (name) imageMap.set(name, img);
    }
  }

  // 1. 优先提取显式附件 (msg.attachments)
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      const key = (a.path || a.name || '').trim().toLowerCase();
      if (key) {
        seenFingerprints.add(key);
      }
      const pathKey = (a.path || '').trim().toLowerCase();
      const nameKey = (a.name || '').trim().toLowerCase();
      const matchedImg =
        (pathKey ? imageMap.get(pathKey) : undefined) ||
        (nameKey ? imageMap.get(nameKey) : undefined);
      const isImg =
        Boolean(a.dataUrl) ||
        Boolean(matchedImg) ||
        (a.mime && a.mime.startsWith('image/')) ||
        /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(a.name || a.path || '');

      result.push({
        name: a.name,
        path: a.path || matchedImg?.source,
        mime: a.mime || matchedImg?.mime,
        size: (a as { size?: number }).size || matchedImg?.byteSize,
        dataUrl: a.dataUrl || matchedImg?.resolvedUrl,
        isImage: isImg,
      });
    }
  }

  // 2. 融合图片数据 (msg.images)，去重防回潮
  if (Array.isArray(images)) {
    for (const img of images) {
      const key = (img.source || img.alt || '').trim().toLowerCase();
      const fileName = (img.source.split(/[\\/]/).pop() || '').trim().toLowerCase();
      if ((key && seenFingerprints.has(key)) || (fileName && seenFingerprints.has(fileName))) {
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
  const candidate = item.thumbnailUrl || item.dataUrl;
  if (candidate && (candidate.startsWith('data:') || candidate.startsWith('blob:') || candidate.startsWith('asset:') || candidate.startsWith('http:') || candidate.startsWith('https:'))) {
    return candidate;
  }
  const source = (item.path || candidate || '').trim();
  if (!source) return '';
  if (source.startsWith('content:')) {
    return '';
  }
  if (
    source.startsWith('data:') ||
    source.startsWith('blob:') ||
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('asset://')
  ) {
    return source;
  }
  if (isAbsoluteFsPath(source)) {
    return convertFileSrc(source.replace(/\\/g, '/'));
  }
  // 相对路径通过工作区解析为绝对路径
  const resolved = resolveWorkspacePath(source);
  if (resolved && isAbsoluteFsPath(resolved)) {
    return convertFileSrc(resolved.replace(/\\/g, '/'));
  }
  const workspaceRoot = getWorkspacePath()?.trim();
  if (workspaceRoot) {
    const abs = `${workspaceRoot.replace(/[\\/]+$/, '/')}/${source.replace(/^\.[\\/]/, '')}`;
    return convertFileSrc(abs.replace(/\\/g, '/'));
  }
  return source;
}

export function getFileKindBadge(nameOrPath: string): string {
  const ext = nameOrPath.split('.').pop()?.toUpperCase();
  if (!ext || ext.length > 5) return 'FILE';
  return ext;
}

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
        return `${baseName}（⚠️ ${warnText}）`;
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
                    <Lucide.AlertCircle size={12} strokeWidth={2.4} aria-hidden="true" />
                  </span>
                </Tooltip>
              ) : null}
              <Lucide.ImageOff size={20} className={styles.missingIcon} />
              <span className={styles.missingBadge}>失效</span>
              {onRemove ? (
                <button
                  type="button"
                  className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
                  aria-label={`移除附件 ${item.name || '图片'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(item);
                  }}
                >
                  <Lucide.X size={10} strokeWidth={2.2} aria-hidden />
                </button>
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
                  <Lucide.AlertCircle size={12} strokeWidth={2.4} aria-hidden="true" />
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
                    stroke="var(--composer-attach-progress-color, var(--accent-primary, #10b981))"
                    strokeWidth="2"
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
              <button
                type="button"
                className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
                aria-label={`移除附件 ${item.name || '图片'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item);
                }}
              >
                <Lucide.X size={10} strokeWidth={2.2} aria-hidden />
              </button>
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
                <Lucide.AlertCircle size={12} strokeWidth={2.4} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : null}
          <div className={`${styles.fileIconBox} ${styles.fileIcon} file-icon`}>
            {isItemMissing ? (
              <Lucide.FileQuestion size={18} className={styles.missingIcon} />
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
                  stroke="var(--composer-attach-progress-color, var(--accent-primary, #10b981))"
                  strokeWidth="2"
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
            <button
              type="button"
              className={`${styles.fileRemove} ${styles.attachRemove} file-remove chat-attach-remove`}
              aria-label={`移除附件 ${item.name || displayName}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item);
              }}
            >
              <Lucide.X size={10} strokeWidth={2.2} aria-hidden />
            </button>
          ) : null}
        </div>
      </Tooltip>
    );
  }
);

AttachmentCard.displayName = 'AttachmentCard';
