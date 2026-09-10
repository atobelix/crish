import { convertFileSrc } from '@tauri-apps/api/core';
import {
  getWorkspacePath,
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from '../../api/workspaceFsApi';
import type { SessionMessage } from '../../store/types';
import type { AttachmentItem } from './AttachmentCard';

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
  if (
    candidate &&
    (candidate.startsWith('data:') ||
      candidate.startsWith('blob:') ||
      candidate.startsWith('asset:') ||
      candidate.startsWith('http:') ||
      candidate.startsWith('https:'))
  ) {
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
