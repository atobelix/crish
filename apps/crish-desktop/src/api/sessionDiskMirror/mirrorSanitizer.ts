/**
 * 会话磁盘镜像纯函数层：规范化、校验、形状转换与结构组装
 */

import type { SessionMessage, SessionState } from '../../store/layoutStore';
import {
  jsonlToMessages,
  sanitizeMessagesForHydrate,
} from '../session-persistence/sessionHydration';
import type { SessionIndexEntry } from '../session-persistence/sessionPersistenceTypes';
import { coerceSessionTimestamp } from '../sessionTime';
import { prepareSessionsForUi } from '../sessionTitle';
import {
  MIRROR_BODY_EXT,
  MIRROR_INDEX_FILENAME,
  MIRROR_INDEX_VERSION,
  MIRROR_SESSION_ID_MAX_LEN,
  type MirrorIndexDocument,
  type MirrorRestoreResult,
  type SessionDiskMirrorMeta,
} from './mirrorTypes';

/** Windows 保留设备名（basename，忽略扩展；与导出/apply 对齐） */
const WINDOWS_RESERVED_BASENAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 安全会话 id：单路径段、无穿越、无盘符/ADS、非保留设备名。
 * 允许常见 `sess-…` / UUID / 字母数字 + `._-`。
 */
const SAFE_MIRROR_SESSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ── 路径安全 ──────────────────────────────────────────────────────────

/**
 * 规范化镜像根目录：trim、统一 `/`、去尾分隔符。
 * 空 / 非字符串 → null。
 */
export function normalizeMirrorBaseDir(
  dir: string | null | undefined,
): string | null {
  if (typeof dir !== 'string') return null;
  let d = dir.trim();
  if (!d) return null;
  d = d.replace(/\\/g, '/').replace(/\/+$/, '');
  return d || null;
}

/**
 * 会话 id 是否可安全作为镜像文件名（相对 baseDir 的单段）。
 * 拒绝：空、路径分隔、`..`、盘符/ADS 冒号、控制符、Windows 保留名、超长。
 */
export function isSafeMirrorSessionId(
  id: string | null | undefined,
): boolean {
  if (typeof id !== 'string') return false;
  if (!id || id !== id.trim()) return false;
  if (id.length > MIRROR_SESSION_ID_MAX_LEN) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;
  if (id.includes(':')) return false;
  if (/[\x00-\x1f\x7f<>"|?*]/.test(id)) return false;
  if (WINDOWS_RESERVED_BASENAME.test(id)) return false;
  if (!SAFE_MIRROR_SESSION_ID.test(id)) return false;
  return true;
}

/**
 * 取安全会话 id：trim 后校验；不安全 → null。
 */
export function sanitizeMirrorSessionId(
  id: string | null | undefined,
): string | null {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  if (!isSafeMirrorSessionId(s)) return null;
  return s;
}

/** `${base}/index.json`；base 非法 → null */
export function mirrorIndexFilePath(
  baseDir: string | null | undefined,
): string | null {
  const base = normalizeMirrorBaseDir(baseDir);
  if (!base) return null;
  return `${base}/${MIRROR_INDEX_FILENAME}`;
}

/**
 * `${base}/${sessionId}.jsonl`；base/id 非法 → null（防路径穿越）。
 */
export function mirrorSessionBodyFilePath(
  baseDir: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  const base = normalizeMirrorBaseDir(baseDir);
  const id = sanitizeMirrorSessionId(sessionId);
  if (!base || !id) return null;
  return `${base}/${id}${MIRROR_BODY_EXT}`;
}

// ── Meta 形状守卫 / 损坏恢复 ──────────────────────────────────────────

const MIRROR_MODES = new Set(['tauri', 'localStorage-only', 'unavailable']);

/**
 * 将任意值收敛为 SessionDiskMirrorMeta（损坏字段丢弃，永不抛）。
 */
export function normalizeMirrorMeta(value: unknown): SessionDiskMirrorMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;
  const out: SessionDiskMirrorMeta = {};

  if (typeof o.lastPath === 'string') {
    const p = o.lastPath.trim();
    if (p) out.lastPath = p;
  }
  if (typeof o.lastAt === 'number' && Number.isFinite(o.lastAt) && o.lastAt >= 0) {
    out.lastAt = o.lastAt;
  }
  if (
    typeof o.sessionCount === 'number' &&
    Number.isFinite(o.sessionCount) &&
    o.sessionCount >= 0
  ) {
    out.sessionCount = Math.floor(o.sessionCount);
  }
  if (typeof o.mode === 'string' && MIRROR_MODES.has(o.mode)) {
    out.mode = o.mode as 'tauri' | 'localStorage-only' | 'unavailable';
  }
  return out;
}

/**
 * 解析 meta JSON 字符串；null/空/损坏 → {}。
 */
export function parseMirrorMetaJson(
  raw: string | null | undefined,
): SessionDiskMirrorMeta {
  if (raw == null) return {};
  const t = String(raw).trim();
  if (!t) return {};
  try {
    return normalizeMirrorMeta(JSON.parse(t));
  } catch {
    return {};
  }
}

export function buildMirrorMeta(partial: {
  mode: NonNullable<SessionDiskMirrorMeta['mode']>;
  sessionCount: number;
  lastPath?: string;
  lastAt?: number;
}): SessionDiskMirrorMeta {
  const count =
    Number.isFinite(partial.sessionCount) && partial.sessionCount >= 0
      ? Math.floor(partial.sessionCount)
      : 0;
  const meta: SessionDiskMirrorMeta = {
    mode: partial.mode,
    lastAt:
      typeof partial.lastAt === 'number' && Number.isFinite(partial.lastAt)
        ? partial.lastAt
        : Date.now(),
    sessionCount: count,
  };
  if (partial.lastPath) {
    const p = normalizeMirrorBaseDir(partial.lastPath);
    if (p) meta.lastPath = p;
  }
  return meta;
}

// ── Index 条目 / 文档形状 ─────────────────────────────────────────────

function asFiniteNonNegInt(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

function asOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * 单条 index entry 形状守卫：无安全 id → null（跳过损坏项）。
 * 缺省字段给合理默认；不发明远程壳字段。
 */
export function normalizeMirrorIndexEntry(
  value: unknown,
): SessionIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const id = sanitizeMirrorSessionId(
    typeof o.id === 'string' ? o.id : null,
  );
  if (!id) return null;

  const title =
    typeof o.title === 'string' && o.title.trim() ? o.title.trim() : '新会话';
  const folder =
    typeof o.folder === 'string' && o.folder.trim()
      ? o.folder.trim()
      : '常规会话';
  const timestamp =
    typeof o.timestamp === 'string' && o.timestamp.trim()
      ? o.timestamp.trim()
      : '恢复';
  const updatedAt = asFiniteNonNegInt(o.updatedAt) ?? 0;
  const messageCount = asFiniteNonNegInt(o.messageCount) ?? 0;
  const pinnedMessageIds = asStringArray(o.pinnedMessageIds);
  const branchParentId = asOptionalString(o.branchParentId);
  const safeBranch =
    branchParentId && isSafeMirrorSessionId(branchParentId)
      ? branchParentId
      : undefined;
  const engineCursor = asFiniteNonNegInt(o.engineCursor);
  const engineLastRunId = asOptionalString(o.engineLastRunId);
  const hydratedFromEngine =
    typeof o.hydratedFromEngine === 'boolean' ? o.hydratedFromEngine : undefined;

  const entry: SessionIndexEntry = {
    id,
    title,
    folder,
    isPinned: Boolean(o.isPinned),
    isArchived: Boolean(o.isArchived),
    timestamp,
    updatedAt,
    messageCount,
  };
  if (safeBranch) entry.branchParentId = safeBranch;
  if (pinnedMessageIds?.length) entry.pinnedMessageIds = pinnedMessageIds;
  if (engineCursor !== undefined) entry.engineCursor = engineCursor;
  if (engineLastRunId) entry.engineLastRunId = engineLastRunId;
  if (hydratedFromEngine !== undefined) {
    entry.hydratedFromEngine = hydratedFromEngine;
  }
  return entry;
}

/**
 * 规范化 sessions 数组：跳过坏项、按 id 去重（先出现优先）。
 * 非数组 → []。
 */
export function normalizeMirrorIndexEntries(
  value: unknown,
): SessionIndexEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SessionIndexEntry[] = [];
  for (const item of value) {
    const e = normalizeMirrorIndexEntry(item);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * 构建 index.json 文档（纯写侧契约）。
 * 仅纳入安全 id 的条目；空列表合法（读侧再决定不恢复）。
 */
export function buildMirrorIndexDocument(
  sessions: SessionIndexEntry[],
  activeSessionId: string,
  folderOrder: string[],
  opts?: { writtenAt?: string; writtenAtMs?: number },
): MirrorIndexDocument {
  const entries = normalizeMirrorIndexEntries(sessions);
  const activeSafe = sanitizeMirrorSessionId(activeSessionId);
  const active =
    activeSafe && entries.some((e) => e.id === activeSafe)
      ? activeSafe
      : entries[0]?.id ?? '';

  const folders = Array.isArray(folderOrder)
    ? folderOrder
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  let writtenAt = opts?.writtenAt;
  if (!writtenAt) {
    const ms =
      typeof opts?.writtenAtMs === 'number' && Number.isFinite(opts.writtenAtMs)
        ? opts.writtenAtMs
        : Date.now();
    writtenAt = new Date(ms).toISOString();
  }

  return {
    version: MIRROR_INDEX_VERSION,
    activeSessionId: active,
    folderOrder: folders,
    sessions: entries,
    writtenAt,
  };
}

/** 序列化为 pretty JSON（与历史写盘格式一致） */
export function serializeMirrorIndexDocument(doc: MirrorIndexDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * 解析 index.json 原文；损坏 / 非对象 → null。
 * sessions 损坏条目被跳过；全坏仍返回 doc（sessions: []），由 finalize 判空。
 */
export function parseMirrorIndexJson(
  raw: string | null | undefined,
): MirrorIndexDocument | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  return normalizeMirrorIndexDocument(parsed);
}

/**
 * 将任意值收敛为 MirrorIndexDocument；无法识别根形状 → null。
 */
export function normalizeMirrorIndexDocument(
  value: unknown,
): MirrorIndexDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const hasSessions = 'sessions' in o;
  const hasVersion = 'version' in o;
  const hasActive = 'activeSessionId' in o;
  if (!hasSessions && !hasVersion && !hasActive) return null;

  const version =
    typeof o.version === 'number' && Number.isFinite(o.version)
      ? Math.floor(o.version)
      : MIRROR_INDEX_VERSION;
  const sessions = normalizeMirrorIndexEntries(o.sessions);
  const activeRaw =
    typeof o.activeSessionId === 'string' ? o.activeSessionId : '';
  const activeSafe = sanitizeMirrorSessionId(activeRaw);
  const activeSessionId =
    activeSafe && sessions.some((s) => s.id === activeSafe)
      ? activeSafe
      : sessions[0]?.id ?? '';

  const folderOrder = asStringArray(o.folderOrder) ?? [];
  const writtenAt =
    typeof o.writtenAt === 'string' && o.writtenAt.trim()
      ? o.writtenAt.trim()
      : '';

  return {
    version,
    activeSessionId,
    folderOrder,
    sessions,
    writtenAt,
  };
}

// ── 恢复侧纯逻辑 ──────────────────────────────────────────────────────

/**
 * 解析 active：候选在 sessions 内则用，否则首项；空列表 → null。
 * 不发明新 id。
 */
export function resolveMirrorActiveSessionId(
  candidate: string | null | undefined,
  sessions: Array<{ id: string }>,
): string | null {
  if (!sessions.length) return null;
  const c = sanitizeMirrorSessionId(candidate ?? null);
  if (c && sessions.some((s) => s.id === c)) return c;
  const first = sanitizeMirrorSessionId(sessions[0]!.id);
  return first;
}

/**
 * folderOrder：合法非空字符串数组优先；否则从 sessions 去重推导。
 * 空 sessions → []（不发明文件夹）。
 */
export function resolveMirrorFolderOrder(
  folderOrder: unknown,
  sessions: Array<{ folder?: string }>,
): string[] {
  if (Array.isArray(folderOrder) && folderOrder.length) {
    const cleaned = folderOrder
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.trim())
      .filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  if (!sessions.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    const f =
      typeof s.folder === 'string' && s.folder.trim()
        ? s.folder.trim()
        : '常规会话';
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * index entry + 消息体 → SessionState 壳。
 * - agents 恒为 []（不发明远程/协作壳）
 * - 无标题用「新会话」占位；空消息壳由 prepareSessionsForUi 剪
 */
export function mirrorEntryToSessionShell(
  entry: SessionIndexEntry,
  messages: SessionMessage[],
): SessionState {
  const msgs = Array.isArray(messages) ? messages : [];
  return {
    id: entry.id,
    title: entry.title || '新会话',
    folder: entry.folder || '常规会话',
    isPinned: Boolean(entry.isPinned),
    isArchived: Boolean(entry.isArchived),
    ...(entry.branchParentId !== undefined ? { branchParentId: entry.branchParentId } : {}),
    timestamp: coerceSessionTimestamp(
      entry.id,
      entry.timestamp || '恢复',
      msgs,
    ),
    messages: msgs,
    ...(entry.pinnedMessageIds?.length ? { pinnedMessageIds: entry.pinnedMessageIds } : {}),
    agents: [],
    ...(entry.engineCursor !== undefined ? { engineCursor: entry.engineCursor } : {}),
    ...(entry.engineLastRunId !== undefined ? { engineLastRunId: entry.engineLastRunId } : {}),
    ...(entry.hydratedFromEngine !== undefined ? { hydratedFromEngine: entry.hydratedFromEngine } : {}),
  };
}

/**
 * 从条目 + 可选正文 map 组装 SessionState[]（跳过不安全 id）。
 * bodyById 缺省 → 空消息；正文经 sanitizeMessagesForHydrate。
 */
export function assembleSessionsFromMirrorEntries(
  entries: SessionIndexEntry[],
  bodyById?: ReadonlyMap<string, string> | Record<string, string | undefined>,
): SessionState[] {
  const getBody = (id: string): string | undefined => {
    if (!bodyById) return undefined;
    if (bodyById instanceof Map) return bodyById.get(id);
    return (bodyById as Record<string, string | undefined>)[id];
  };

  const sessions: SessionState[] = [];
  for (const e of entries) {
    if (!e?.id || !isSafeMirrorSessionId(e.id)) continue;
    const bodyRaw = getBody(e.id);
    const messages = sanitizeMessagesForHydrate(
      bodyRaw ? jsonlToMessages(bodyRaw) : [],
    );
    sessions.push(mirrorEntryToSessionShell(e, messages));
  }
  return sessions;
}

/**
 * 恢复收尾：补标题 + 剪空壳；无有效会话 → null（不发明壳）。
 */
export function finalizeMirrorRestore(
  sessions: SessionState[],
  activeCandidate: string | null | undefined,
  folderOrder: unknown,
): MirrorRestoreResult | null {
  if (!Array.isArray(sessions) || !sessions.length) return null;

  const activeCandidateSafe =
    activeCandidate &&
    sessions.some((s) => s.id === activeCandidate) &&
    isSafeMirrorSessionId(activeCandidate)
      ? activeCandidate
      : null;

  const prepared = prepareSessionsForUi(sessions, activeCandidateSafe);
  if (!prepared.length) return null;

  const activeSessionId =
    resolveMirrorActiveSessionId(activeCandidateSafe, prepared) ??
    prepared[0]!.id;

  const folders = resolveMirrorFolderOrder(folderOrder, prepared);
  return {
    sessions: prepared,
    activeSessionId,
    folderOrder: folders,
  };
}

/**
 * 写读对称：文档 → 序列化 → 再解析，结构应等价（测试 / 自检用）。
 */
export function mirrorIndexRoundTrip(
  doc: MirrorIndexDocument,
): MirrorIndexDocument | null {
  return parseMirrorIndexJson(serializeMirrorIndexDocument(doc));
}
