/**
 * 会话反序列化、格式补齐与水合校验纯函数集（hub）
 *
 * Stream D 改造后职责：仅保留「形状守卫」与「水合校验」纯函数。
 * - JSONL 序列化 / 反序列化已删除：SQLite 直接以结构化行存储。
 * - 大数据量异步解析下沉到 Rust 侧。
 *
 * 本文件为 hub：索引解析 + 工具函数在此；消息/agent 解析与水合收尾
 * 已拆到 sessionHydrationMessages / sessionHydrationAgents 子文件，
 * 此处 re-export 以保持对外 import 路径不变。
 */

import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import { EMPTY_SESSION_TITLE } from '../sessionTitle';
import {
  DEFAULT_SESSION_FOLDER,
  type SessionIndexEntry,
  type SessionIndexImportMeta,
} from './sessionPersistenceTypes';

// re-export 消息 / agent 解析与水合收尾纯函数（拆分自本文件，对外路径不变）
export {
  parseSessionMessage,
  parseSessionMessages,
  sanitizeMessagesForHydrate,
} from './sessionHydrationMessages';
export {
  parseSessionAgent,
  parseSessionAgents,
  hydrateSessionAgents,
} from './sessionHydrationAgents';

/** 规范化索引侧 importMeta；非法则 undefined */
function parseSessionIndexImportMeta(
  raw: unknown,
): SessionIndexImportMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const source =
    o.source === 'claude-code' || o.source === 'codex' ? o.source : null;
  const sourceSessionId =
    typeof o.sourceSessionId === 'string' ? o.sourceSessionId.trim() : '';
  if (!source || !sourceSessionId) return undefined;
  const meta: SessionIndexImportMeta = { source, sourceSessionId };
  if (typeof o.sourcePath === 'string' && o.sourcePath.trim()) {
    meta.sourcePath = o.sourcePath.trim();
  }
  if (typeof o.importedAt === 'string' && o.importedAt.trim()) {
    meta.importedAt = o.importedAt.trim();
  }
  return meta;
}

/** JSON.parse 失败 / 空串 → fallback（不抛） */
export function safeParseJson<T>(
  raw: string | null | undefined,
  fallback: T
): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

/** pinnedMessageIds：仅保留非空 string，去空后 undefined */
export function normalizePinnedMessageIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const id = x.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length ? out : undefined;
}

/**
 * 将未知值规范为 SessionIndexEntry。
 * 缺 id → null；其余字段填安全默认（不发明远程会话）。
 * I-DRAFT：PENDING_DRAFT 哨兵永不进入 sessions[] / 索引（C3）。
 */
export function parseSessionIndexEntry(raw: unknown): SessionIndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  if (!id) return null;
  // draft 哨兵禁止水合为索引条目（脏盘 / 旧 bug 兜底）
  if (isPendingDraft(id)) return null;

  const title =
    typeof o.title === 'string' && o.title.trim()
      ? o.title.trim()
      : EMPTY_SESSION_TITLE;
  const folder =
    typeof o.folder === 'string' && o.folder.trim()
      ? o.folder.trim()
      : DEFAULT_SESSION_FOLDER;

  const updatedAt = asFiniteNumber(o.updatedAt);
  const messageCount = asFiniteNumber(o.messageCount);
  const engineCursor = asFiniteNumber(o.engineCursor);

  const branchParentId = asNonEmptyString(o.branchParentId) ?? undefined;
  const engineLastRunId = asNonEmptyString(o.engineLastRunId) ?? undefined;
  const timestamp =
    typeof o.timestamp === 'string'
      ? o.timestamp
      : typeof o.timestamp === 'number' && Number.isFinite(o.timestamp)
        ? String(o.timestamp)
        : '';

  const entry: SessionIndexEntry = {
    id,
    title,
    folder,
    isPinned: asBoolean(o.isPinned),
    isArchived: asBoolean(o.isArchived),
    timestamp,
    updatedAt: updatedAt != null && updatedAt >= 0 ? updatedAt : 0,
    messageCount:
      messageCount != null && messageCount >= 0 ? Math.floor(messageCount) : 0,
  };

  if (branchParentId) entry.branchParentId = branchParentId;
  const pins = normalizePinnedMessageIds(o.pinnedMessageIds);
  if (pins) entry.pinnedMessageIds = pins;
  if (engineCursor != null && engineCursor >= 0) {
    entry.engineCursor = Math.floor(engineCursor);
  }
  if (engineLastRunId) entry.engineLastRunId = engineLastRunId;
  if (typeof o.hydratedFromEngine === 'boolean') {
    entry.hydratedFromEngine = o.hydratedFromEngine;
  }
  const importMeta = parseSessionIndexImportMeta(o.importMeta);
  if (importMeta) entry.importMeta = importMeta;

  return entry;
}

/**
 * 索引列表形状守卫：非数组 / 坏元素丢弃；同 id 先到先得。
 * 空结果 → []（不发明会话）。
 */
export function parseSessionIndexList(raw: unknown): SessionIndexEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const e = parseSessionIndexEntry(item);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * folderOrder：string[] 形状；全非法 → null（表示「无持久顺序」）。
 * 空数组保留为 []（显式空顺序，与 null 区分）。
 */
export function parseFolderOrder(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const f = x.trim();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  // 原数组非空但无一合法 → 视为损坏
  if (raw.length > 0 && out.length === 0) return null;
  return out;
}
