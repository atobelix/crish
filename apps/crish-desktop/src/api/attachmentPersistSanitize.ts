/**
 * 附件落盘脱敏（SYSTEMATIC-FIX-PLAN §3.3）
 * 会话消息默认不存完整 dataUrl / 本机绝对路径；改存工作区相对引用或内容哈希线索。
 *
 * 不变量（新写必守）：
 * - 工作区内相对路径：原样保留（forward-slash）
 * - 工作区外绝对路径 / 含 .. 的路径：只留 basename + pathRedacted，禁止落盘完整路径
 * - dataUrl 本体：禁止进入 source / resolvedUrl / path；需要线索时写 contentHint
 * - resolvedUrl：仅允许 http(s) 外链；data: / blob: / asset: / 本机路径一律剥离
 * - 运行时缩略图请走调用方内存态（ChatAttachment.thumbnailUrl），不进本模块返回值
 */
import type { ChatAttachment } from '../hooks/chat-stream/types';
import type {
  MessageImageRef,
  SessionMessageAttachment,
} from '../store/types';
import {
  getWorkspacePath,
  isAbsoluteFsPath,
  pathBasename,
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

/** 仅保留 http(s) 外链；data: / blob: / asset: / 本机路径一律拒绝 */
function safeExternalResolvedUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  if (u.startsWith('https://') || u.startsWith('http://')) return u;
  return undefined;
}

/** 相对路径是否含 .. 遍历组件 */
function hasPathTraversal(p: string): boolean {
  return /(^|\/)\.\.($|\/)/.test(p.replace(/\\/g, '/'));
}

/**
 * 路径脱敏决策：
 * - 工作区内 → 相对引用
 * - 绝对路径或含 .. → basename + pathRedacted
 * - 其余相对路径 → 规范化后原样保留（已是工作区相对语义）
 */
function sanitizePathForPersist(rawPath: string | undefined): {
  path?: string;
  pathRedacted?: boolean;
} {
  const raw = (rawPath || '').trim();
  if (!raw) return {};
  const rel = toWorkspaceRelativeRef(raw);
  if (rel) return { path: rel };
  if (isAbsoluteFsPath(raw) || hasPathTraversal(raw)) {
    return { path: pathBasename(raw), pathRedacted: true };
  }
  return { path: raw.replace(/\\/g, '/') };
}

/**
 * 发送入库用图片引用。
 * 产出对象可直接 JSON 序列化落盘：无 dataUrl 本体、无工作区外绝对路径。
 * 运行时缩略图由调用方另持（ChatAttachment），不写入 resolvedUrl。
 */
export function sanitizeImageRefForPersist(
  a: ChatAttachment,
  id: string
): MessageImageRef {
  const { path: pathOut, pathRedacted } = sanitizePathForPersist(a.path);
  const contentHint = a.dataUrl ? simpleContentHint(a.dataUrl) : undefined;
  const safeResolved = safeExternalResolvedUrl(a.thumbnailUrl);

  const common = {
    id,
    mime: a.mime || 'image/png',
    alt: a.name,
    byteSize: a.imageMeta?.size,
    ...(safeResolved ? { resolvedUrl: safeResolved } : {}),
    ...(contentHint ? { contentHint } : {}),
    ...(pathRedacted ? { pathRedacted: true } : {}),
  };

  if (pathOut) {
    return {
      ...common,
      source: pathOut,
      kind: 'local',
    };
  }
  if (a.dataUrl) {
    // 无路径仅有 dataUrl：只留文件名 + contentHint，绝不写 data: 本体
    return {
      ...common,
      source: a.name || 'image.png',
      kind: 'data',
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

/**
 * 发送入库用附件元数据。
 * - 去掉 dataUrl 本体
 * - 工作区外绝对路径 → basename + pathRedacted（禁止原样落盘）
 * - 工作区内相对路径保留
 */
export function sanitizeAttachmentForPersist(
  a: ChatAttachment
): SessionMessageAttachment {
  const { path: pathOut, pathRedacted } = sanitizePathForPersist(a.path);
  return {
    name: a.name,
    ...(pathOut ? { path: pathOut } : {}),
    ...(pathRedacted ? { pathRedacted: true } : {}),
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.text ? { text: a.text } : {}),
  };
}
