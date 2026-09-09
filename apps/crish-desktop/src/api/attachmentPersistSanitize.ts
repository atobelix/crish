/**
 * 附件落盘脱敏（SYSTEMATIC-FIX-PLAN §3.3）
 * 会话消息默认不存完整 dataUrl / 本机绝对路径；改存工作区相对引用或内容哈希线索。
 */
import type { ChatAttachment } from '../hooks/chat-stream/types';
import type {
  MessageImageRef,
  SessionMessageAttachment,
} from '../store/types';
import {
  getWorkspacePath,
  isAbsoluteFsPath,
  resolveWorkspacePath,
} from './workspaceFsApi';

/** 绝对工作区路径 → 相对引用；失败返回 null */
export function toWorkspaceRelativeRef(filePath: string): string | null {
  const raw = (filePath || '').trim();
  if (!raw) return null;
  const resolved = resolveWorkspacePath(raw);
  if (!resolved) return null;
  const root = (getWorkspacePath() || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!root) return null;
  const n = resolved.replace(/\\/g, '/');
  const r = root.toLowerCase();
  const nl = n.toLowerCase();
  if (nl === r) return '.';
  if (nl.startsWith(r + '/')) return n.slice(root.length + 1);
  return null;
}

function simpleContentHint(dataUrl: string): string {
  // 非加密哈希：仅作稳定线索，避免落盘完整 dataUrl
  let h = 0;
  const sample = dataUrl.slice(0, 256) + String(dataUrl.length);
  for (let i = 0; i < sample.length; i++) {
    h = (Math.imul(31, h) + sample.charCodeAt(i)) | 0;
  }
  return `content:${(h >>> 0).toString(16)}:${dataUrl.length}`;
}

/** 发送入库用图片引用：保留相对/绝对引用及可用缩略图/dataUrl */
export function sanitizeImageRefForPersist(
  a: ChatAttachment,
  id: string
): MessageImageRef {
  const rel = a.path ? toWorkspaceRelativeRef(a.path) : null;
  const resolvedUrl = a.thumbnailUrl || a.dataUrl;
  if (rel) {
    return {
      id,
      source: rel,
      kind: 'local',
      ...(resolvedUrl ? { resolvedUrl } : {}),
      mime: a.mime || 'image/png',
      alt: a.name,
      byteSize: a.imageMeta?.size,
    };
  }
  if (a.path) {
    return {
      id,
      source: a.path.trim(),
      kind: 'local',
      ...(resolvedUrl ? { resolvedUrl } : {}),
      mime: a.mime || 'image/png',
      alt: a.name,
      byteSize: a.imageMeta?.size,
    };
  }
  if (a.dataUrl) {
    return {
      id,
      source: a.name || 'image.png',
      kind: 'data',
      resolvedUrl: a.thumbnailUrl || a.dataUrl,
      mime: a.mime || 'image/png',
      alt: a.name,
      byteSize: a.imageMeta?.size,
    };
  }
  return {
    id,
    source: a.name,
    kind: 'local',
    mime: a.mime || 'image/png',
    alt: a.name,
  };
}

/** 发送入库用附件元数据：去掉 dataUrl；path 支持相对或绝对引用 */
export function sanitizeAttachmentForPersist(
  a: ChatAttachment
): SessionMessageAttachment {
  const rel = a.path ? toWorkspaceRelativeRef(a.path) : undefined;
  const pathOut = rel ?? (a.path ? a.path.trim() : undefined);
  return {
    name: a.name,
    ...(pathOut ? { path: pathOut } : {}),
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.text ? { text: a.text } : {}),
  };
}