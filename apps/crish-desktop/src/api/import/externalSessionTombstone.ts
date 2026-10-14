/**
 * 外部对话删除墓碑。
 *
 * 重启后内存墓碑会清空，会话索引仍可能把已删对话灌回来。
 * 这里把「来源 + 来源会话标识」记在本地，水合与合并时据此丢弃。
 * 同一条 Codex 记录的文件名和内部标识都登记，避免探测口径不一致时删了又出现。
 */

import { makeExternalImportKey, type ExternalSessionSource } from './types';

const DELETED_EXTERNAL_SESSIONS_STORAGE_KEY =
  'crish_deleted_external_sessions_v1';

/** 仅匹配以合法会话 UUID 结尾的主干（如 rollout-*-<uuid> 或原生纯 UUID），绝不从全路径或父级目录提取 */
const ROLLOUT_TRAILING_UUID_RE =
  /(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface ExternalImportIdentity {
  source?: string;
  sourceSessionId?: string;
  sourcePath?: string;
}

function isExternalSource(source: string): source is ExternalSessionSource {
  return source === 'claude-code' || source === 'codex';
}

function addExactKey(
  keys: Set<string>,
  source: ExternalSessionSource,
  id: string
): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  const key = makeExternalImportKey(source, trimmed);
  keys.add(key);
  keys.add(key.toLowerCase());
}

function rememberKey(
  keys: Set<string>,
  source: ExternalSessionSource,
  id: string
): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  addExactKey(keys, source, trimmed);
  // 严格限定：仅当标识主干以合法会话 UUID 结尾时才追加尾部 UUID 别名，绝不遍历提取中间路径中的 UUID
  const match = trimmed.match(ROLLOUT_TRAILING_UUID_RE);
  if (match?.[1]) {
    addExactKey(keys, source, match[1]);
  }
}

/** 一条外部对话在墓碑里可能对应的全部键。 */
export function externalImportKeyAliases(
  source: ExternalSessionSource,
  sourceSessionId: string,
  sourcePath?: string
): string[] {
  const keys = new Set<string>();
  rememberKey(keys, source, sourceSessionId);
  if (sourcePath) {
    const cleanPath = sourcePath.trim().replace(/[\\/]+$/, '');
    const base = cleanPath.split(/[\\/]/).pop() ?? '';
    const stem = base.replace(/\.jsonl$/i, '').trim();
    if (stem && stem !== sourceSessionId.trim()) {
      rememberKey(keys, source, stem);
    }
  }
  return Array.from(keys);
}

export function getDeletedExternalSessionKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_EXTERNAL_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeDeletedExternalSessionKeys(keys: Set<string>): void {
  localStorage.setItem(
    DELETED_EXTERNAL_SESSIONS_STORAGE_KEY,
    JSON.stringify(Array.from(keys))
  );
}

export function recordDeletedExternalSession(
  source: string,
  sourceSessionId: string,
  sourcePath?: string
): void {
  if (!isExternalSource(source) || !sourceSessionId) return;
  try {
    const set = getDeletedExternalSessionKeys();
    for (const key of externalImportKeyAliases(
      source,
      sourceSessionId,
      sourcePath
    )) {
      set.add(key);
    }
    writeDeletedExternalSessionKeys(set);
  } catch {
    // 墓碑写失败时不阻断删除本身
  }
}

/** 用户再次手动导入时撤掉墓碑，避免下次启动把刚接续的对话清掉。 */
export function clearDeletedExternalSession(
  source: string,
  sourceSessionId: string,
  sourcePath?: string
): void {
  if (!isExternalSource(source) || !sourceSessionId) return;
  try {
    const set = getDeletedExternalSessionKeys();
    let changed = false;
    for (const key of externalImportKeyAliases(
      source,
      sourceSessionId,
      sourcePath
    )) {
      const removedExact = set.delete(key);
      const removedLower = set.delete(key.toLowerCase());
      if (removedExact || removedLower) changed = true;
    }
    if (changed) writeDeletedExternalSessionKeys(set);
  } catch {
    // 忽略
  }
}

export function isExternalImportBlocked(
  source: string,
  sourceSessionId: string,
  sourcePath: string | undefined,
  deletedKeys: Set<string>
): boolean {
  if (!isExternalSource(source) || deletedKeys.size === 0) return false;
  return externalImportKeyAliases(source, sourceSessionId, sourcePath).some(
    (key) => deletedKeys.has(key) || deletedKeys.has(key.toLowerCase())
  );
}

export function sessionMatchesDeletedExternalKey(
  session: { importMeta?: ExternalImportIdentity | null },
  deletedKeys: Set<string>
): boolean {
  const meta = session.importMeta;
  if (!meta?.source || !meta.sourceSessionId) return false;
  return isExternalImportBlocked(
    meta.source,
    meta.sourceSessionId,
    meta.sourcePath,
    deletedKeys
  );
}

export function collectExternallyDeletedSessionIds(
  sessions: ReadonlyArray<{
    id?: string;
    importMeta?: ExternalImportIdentity | null;
  }>,
  deletedKeys: Set<string> = getDeletedExternalSessionKeys()
): Set<string> {
  const ids = new Set<string>();
  if (deletedKeys.size === 0) return ids;
  for (const session of sessions) {
    if (!session?.id) continue;
    if (sessionMatchesDeletedExternalKey(session, deletedKeys)) {
      ids.add(session.id);
    }
  }
  return ids;
}

export function omitExternallyDeletedSessions<
  T extends { id?: string; importMeta?: ExternalImportIdentity | null },
>(
  sessions: T[],
  deletedKeys: Set<string> = getDeletedExternalSessionKeys()
): T[] {
  if (deletedKeys.size === 0) return sessions;
  return sessions.filter(
    (session) => !sessionMatchesDeletedExternalKey(session, deletedKeys)
  );
}
