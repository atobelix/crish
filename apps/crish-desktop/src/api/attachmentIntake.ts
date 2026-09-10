/**
 * 附件入队单一管道（SYSTEMATIC-FIX-PLAN §3.1）
 *
 * 唯一消费契约：
 * - OS/Tauri 路径 → intakePaths → assertWorkspacePath + localFileReader
 * - DOM File 拖放 → intakeFiles：有 File.path 时收敛为 intakePaths；否则走 blob 读入
 * - 短窗幂等：同一稳定 key 在 DEDUPE_MS 内只入队一次，消灭 tauri://drag-drop 与 DOM drop 双入队
 */
import type { ChatAttachment } from '../hooks/chat-stream/types';

export const ATTACHMENT_INTAKE_DEDUPE_MS = 500;

/** 稳定幂等键：优先 id → 规范化 path → name+体积线索 */
export function attachmentStableKey(
  a: Pick<ChatAttachment, 'id' | 'path' | 'name' | 'dataUrl' | 'imageMeta'>
): string {
  if (a.id && a.id.trim()) return `id:${a.id.trim()}`;
  const path = (a.path || '').trim().replace(/\\/g, '/').toLowerCase();
  if (path) return `path:${path}`;
  const name = (a.name || '').trim().toLowerCase();
  const size =
    a.imageMeta?.size ??
    (typeof a.dataUrl === 'string' ? a.dataUrl.length : 0);
  return `name:${name}|${size}`;
}

export function normalizeIntakePathKey(p: string): string {
  return (p || '').trim().replace(/\\/g, '/').toLowerCase();
}

/** 从 DOM File 提取本机 path（Tauri webview File.path） */
export function extractFileSystemPath(file: File): string | null {
  const raw = (file as unknown as { path?: string }).path || '';
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('/')
  ) {
    return trimmed;
  }
  return null;
}

export type AttachmentIntakeClock = () => number;

/**
 * 短窗去重器：记录近期已消费的 path/file key，供 tauri 与 DOM 双事件合流。
 */
export function createAttachmentIntakeDedupe(
  clock: AttachmentIntakeClock = () => Date.now()
) {
  const recent = new Map<string, number>();

  function prune(now: number) {
    for (const [k, t] of recent) {
      if (now - t > ATTACHMENT_INTAKE_DEDUPE_MS) recent.delete(k);
    }
  }

  /** @returns 尚未在窗内出现过的 keys（并标记为已见） */
  function claim(keys: string[]): string[] {
    const now = clock();
    prune(now);
    const fresh: string[] = [];
    for (const k of keys) {
      if (!k) continue;
      if (recent.has(k)) continue;
      recent.set(k, now);
      fresh.push(k);
    }
    return fresh;
  }

  function reset() {
    recent.clear();
  }

  return { claim, reset };
}

/** 幂等合并：已存在相同 stable key 的附件不再追加 */
export function mergeAttachmentsIdempotent(
  prev: ChatAttachment[],
  incoming: ChatAttachment[]
): ChatAttachment[] {
  if (!incoming.length) return prev;
  const seen = new Set(prev.map(attachmentStableKey));
  const next = [...prev];
  for (const item of incoming) {
    const key = attachmentStableKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}