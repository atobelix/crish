/**
 * 会话磁盘镜像（H3）
 *
 * - 主路径仍是 localStorage（sessionPersistence）
 * - 有 Tauri 时尽力写入应用数据目录，防配额炸
 * - 浏览器环境仅写 localStorage，不报错
 *
 * 纯函数层：索引形状守卫、损坏恢复、空列表、路径安全、写读对称。
 * 空会话：恢复时不发明远程壳；无有效条目 → null。
 */

import type { SessionMessage, SessionState } from '../store/layoutStore';
import {
  jsonlToMessages,
  messagesToJsonl,
  sanitizeMessagesForHydrate,
  sessionsToIndex,
  type SessionIndexEntry,
} from './sessionPersistence';
import { coerceSessionTimestamp } from './sessionTime';
import { prepareSessionsForUi } from './sessionTitle';
import { logInternalError } from './userFacingErrors';

/** localStorage 元数据键 */
export const MIRROR_META_STORAGE_KEY = 'crish_session_disk_mirror_v1';

/** 磁盘 index.json 契约版本 */
export const MIRROR_INDEX_VERSION = 1 as const;

/** 镜像目录内索引文件名 */
export const MIRROR_INDEX_FILENAME = 'index.json';

/** 会话正文扩展名 */
export const MIRROR_BODY_EXT = '.jsonl';

/** 会话 id 作文件名时最大长度（留余量给扩展名） */
export const MIRROR_SESSION_ID_MAX_LEN = 128;

/** Windows 保留设备名（basename，忽略扩展；与导出/apply 对齐） */
const WINDOWS_RESERVED_BASENAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 安全会话 id：单路径段、无穿越、无盘符/ADS、非保留设备名。
 * 允许常见 `sess-…` / UUID / 字母数字 + `._-`。
 */
const SAFE_MIRROR_SESSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SessionDiskMirrorMeta = {
  lastPath?: string;
  lastAt?: number;
  sessionCount?: number;
  mode?: 'tauri' | 'localStorage-only' | 'unavailable' | undefined;
};

/** 磁盘 index.json 根形状（写读对称契约） */
export type MirrorIndexDocument = {
  version: number;
  activeSessionId: string;
  folderOrder: string[];
  sessions: SessionIndexEntry[];
  writtenAt: string;
};

export type MirrorRestoreResult = {
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
};

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
  // 首尾空白不得进路径；调用方应用 sanitizeMirrorSessionId 先 trim
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
  // branchParentId 也须是安全 id（否则丢弃，避免脏引用）
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
  // 必须像索引：至少有 sessions 字段或 version（兼容极简历史）
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
  // 剪完后空 → 不发明远程/默认壳
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

// ── IO 薄封装（依赖 localStorage / Tauri） ────────────────────────────

export function loadMirrorMeta(): SessionDiskMirrorMeta {
  try {
    const raw = localStorage.getItem(MIRROR_META_STORAGE_KEY);
    return parseMirrorMetaJson(raw);
  } catch {
    return {};
  }
}

function saveMirrorMeta(meta: SessionDiskMirrorMeta) {
  try {
    localStorage.setItem(
      MIRROR_META_STORAGE_KEY,
      JSON.stringify(normalizeMirrorMeta(meta)),
    );
  } catch {
    /* ignore */
  }
}

/**
 * 动态加载 Tauri 插件，缓存 Promise 避免每次写盘都重新 import。
 * `Function('return import(...)')` 绕过打包器静态分析——这是有意为之，
 * 因为 `@tauri-apps/plugin-fs` 不是 web 端依赖，浏览器环境会解析失败。
 */
let tauriFsPromise: Promise<any> | null = null;
function loadTauriFs(): Promise<any> {
  if (!tauriFsPromise) {
    tauriFsPromise = (Function(
      'return import("@tauri-apps/plugin-fs")',
    )() as Promise<any>).catch(() => null);
  }
  return tauriFsPromise;
}

let tauriPathPromise: Promise<any> | null = null;
function loadTauriPath(): Promise<any> {
  if (!tauriPathPromise) {
    tauriPathPromise = (Function(
      'return import("@tauri-apps/api/path")',
    )() as Promise<any>).catch(() => null);
  }
  return tauriPathPromise;
}

async function tryTauriWrite(path: string, contents: string): Promise<boolean> {
  try {
    const fs = await loadTauriFs();
    if (!fs?.writeTextFile) return false;
    // 确保目录：writeTextFile 在部分版本会自动创建父目录，失败则忽略
    await fs.writeTextFile(path, contents);
    return true;
  } catch {
    return false;
  }
}

async function tryTauriMkdir(path: string): Promise<void> {
  try {
    const fs = await loadTauriFs();
    if (fs?.mkdir) {
      await fs.mkdir(path, { recursive: true }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

async function tryMigrateOldSessions(newDir: string, pathApi: any): Promise<void> {
  try {
    const fs = await loadTauriFs();
    if (!fs?.writeTextFile) return;

    const newIndexPath = pathApi.join
      ? await pathApi.join(newDir, 'index.json')
      : `${newDir}/index.json`;
      
    // 检查新 index 是否已有内容
    const existingNewIndex = await tryTauriRead(newIndexPath);
    if (existingNewIndex && existingNewIndex.trim()) {
      return; // 已经有索引，直接返回不重复迁移
    }

    if (!pathApi.appDataDir) return;
    const currentAppData = await pathApi.appDataDir();
    if (!currentAppData) return;

    // 寻找 me.flowbit.crish 旧数据
    const oldFlowbitDir = pathApi.join
      ? await pathApi.join(currentAppData, '..', 'me.flowbit.crish', 'crish', 'sessions')
      : `${String(currentAppData).replace(/[\\/]+$/, '')}/../me.flowbit.crish/crish/sessions`;

    const oldIndexPath = pathApi.join
      ? await pathApi.join(oldFlowbitDir, 'index.json')
      : `${oldFlowbitDir}/index.json`;

    const indexRaw = await tryTauriRead(oldIndexPath);
    if (!indexRaw || !indexRaw.trim()) {
      return; // 旧数据为空或不存在，退出
    }

    // 写入新 index
    await fs.writeTextFile(newIndexPath, indexRaw);

    // 解析出所有的会话并备份
    try {
      const indexData = JSON.parse(indexRaw);
      if (indexData && Array.isArray(indexData.sessions)) {
        for (const s of indexData.sessions) {
        const bodyName = `${s.id}.jsonl`;
        const oldBodyPath = pathApi.join
          ? await pathApi.join(oldFlowbitDir, bodyName)
          : `${oldFlowbitDir}/${bodyName}`;
        const newBodyPath = pathApi.join
          ? await pathApi.join(newDir, bodyName)
          : `${newDir}/${bodyName}`;

        const bodyRaw = await tryTauriRead(oldBodyPath);
        if (bodyRaw) {
          await fs.writeTextFile(newBodyPath, bodyRaw);
        }
        }
      }
    } catch {
      /* ignore parse error */
    }
  } catch (e) {
    /* ignore migration errors */
  }
}

async function resolveMirrorDir(): Promise<string | null> {
  try {
    const pathApi = await loadTauriPath();
    if (!pathApi) return null;
    
    // 优先采用用户主目录下的 .crish 文件夹作为通用数据持久化路径，保障在 identifier 重构或修改打包名后历史对话不丢失
    let base: string | null = null;
    if (pathApi.homeDir) {
      base = await pathApi.homeDir();
    } else if (pathApi.appDataDir) {
      base = await pathApi.appDataDir();
    }
    if (!base) return null;
    
    const join = pathApi.join
      ? await pathApi.join(base, '.crish', 'sessions')
      : `${String(base).replace(/[\\/]+$/, '')}/.crish/sessions`;
      
    await tryTauriMkdir(join);
    void tryMigrateOldSessions(join, pathApi);
    return normalizeMirrorBaseDir(join);
  } catch {
    return null;
  }
}

/**
 * 将会话索引 + 各会话 JSONL 镜像到磁盘（尽力而为）。
 * 空列表仍写 index（sessions: []）并记 meta；读侧不会发明壳。
 */
export async function mirrorSessionsToDisk(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
): Promise<SessionDiskMirrorMeta> {
  const list = Array.isArray(sessions) ? sessions : [];
  const dir = await resolveMirrorDir();
  if (!dir) {
    const meta = buildMirrorMeta({
      mode: 'localStorage-only',
      sessionCount: list.length,
    });
    saveMirrorMeta(meta);
    return meta;
  }

  try {
    const indexEntries = sessionsToIndex(list).filter((e) =>
      isSafeMirrorSessionId(e.id),
    );
    const doc = buildMirrorIndexDocument(
      indexEntries,
      activeSessionId,
      Array.isArray(folderOrder) ? folderOrder : [],
    );
    const indexPath = mirrorIndexFilePath(dir);
    if (!indexPath) {
      const meta = buildMirrorMeta({
        mode: 'unavailable',
        sessionCount: list.length,
      });
      saveMirrorMeta(meta);
      return meta;
    }

    // 原子顺序：先并行写所有 body，再写 index。
    // 若先写 index 后写 body 中途失败，磁盘索引会指向不存在的 body。
    // 并行写降低大会话数延迟（取代串行 await）。
    const bodyWrites: Promise<boolean>[] = [];
    for (const s of list) {
      const bodyPath = mirrorSessionBodyFilePath(dir, s.id);
      if (!bodyPath) continue; // 不安全 id 跳过，防路径穿越
      bodyWrites.push(
        tryTauriWrite(bodyPath, messagesToJsonl(s.messages || [])),
      );
    }
    await Promise.all(bodyWrites);

    // body 全部写完后再写 index，确保索引只指向已落地的 body
    const okIndex = await tryTauriWrite(
      indexPath,
      serializeMirrorIndexDocument(doc),
    );
    if (!okIndex) {
      const meta = buildMirrorMeta({
        mode: 'unavailable',
        sessionCount: list.length,
      });
      saveMirrorMeta(meta);
      return meta;
    }

    const meta = buildMirrorMeta({
      mode: 'tauri',
      lastPath: dir,
      sessionCount: list.length,
    });
    saveMirrorMeta(meta);
    return meta;
  } catch (e) {
    logInternalError('mirrorSessionsToDisk', e);
    const meta = buildMirrorMeta({
      mode: 'unavailable',
      sessionCount: list.length,
    });
    saveMirrorMeta(meta);
    return meta;
  }
}

async function tryTauriRead(path: string): Promise<string | null> {
  try {
    const fs: any = await (Function(
      'return import("@tauri-apps/plugin-fs")',
    )() as Promise<any>).catch(() => null);
    if (!fs?.readTextFile) return null;
    const text = await fs.readTextFile(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * localStorage 会话空时，从磁盘镜像回灌（防站点数据清空后丢历史）。
 * 损坏 / 空列表 / 剪壳后空 → null，不发明远程壳。
 */
export async function restoreSessionsFromDiskMirror(): Promise<MirrorRestoreResult | null> {
  const meta = loadMirrorMeta();
  const dir =
    normalizeMirrorBaseDir(meta.lastPath) || (await resolveMirrorDir());
  if (!dir) return null;

  const indexPath = mirrorIndexFilePath(dir);
  if (!indexPath) return null;
  const raw = await tryTauriRead(indexPath);
  if (!raw?.trim()) return null;

  try {
    const index = parseMirrorIndexJson(raw);
    if (!index) return null;
    const entries = index.sessions;
    if (!entries.length) return null;

    const bodyById = new Map<string, string>();
    for (const e of entries) {
      const bodyPath = mirrorSessionBodyFilePath(dir, e.id);
      if (!bodyPath) continue;
      const bodyRaw = await tryTauriRead(bodyPath);
      if (bodyRaw != null && bodyRaw.length) bodyById.set(e.id, bodyRaw);
    }

    const sessions = assembleSessionsFromMirrorEntries(entries, bodyById);
    return finalizeMirrorRestore(
      sessions,
      index.activeSessionId,
      index.folderOrder,
    );
  } catch (e) {
    logInternalError('restoreSessionsFromDiskMirror', e);
    return null;
  }
}
