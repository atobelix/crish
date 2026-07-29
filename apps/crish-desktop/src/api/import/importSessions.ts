/**
 * 将 map 后的外部会话写入 session store（createSession + addMessage）。
 * 管线：mapExternalSessions（parse* + mapToCrishSession + ImportFs）→ soft-dedup → write。
 * 仅在用户点击「导入所选」后调用；禁止自动导入。
 *
 * 软去重策略（默认 skip）：
 * 若会话已有 importMeta 匹配同一 source+sourceSessionId，则跳过，不覆盖。
 */

import { getSessionStoreState } from '../../store/sessionStore';
import type { SessionImportMeta, SessionMessage, SessionState } from '../../store/types';
import { mapExternalSessions, type MapExternalOptions } from './map';
import {
  makeExternalImportKey,
  type DetectedExternalSession,
  type ImportDuplicatePolicy,
  type ImportFs,
  type ImportPathEnv,
  type ImportSessionsResult,
  type MappedImportSession,
} from './types';

export type ImportSessionsDeps = {
  createSession?: (opts?: {
    title?: string;
    folder?: string;
    id?: string;
    activate?: boolean;
    importMeta?: SessionImportMeta;
  }) => string;
  addMessage?: (
    wsId: string,
    sessionId: string,
    message: SessionMessage,
  ) => void;
  /** 固定 wsId（默认 __global__） */
  wsId?: string;
  /** 注入 FS（单测）；默认 Tauri host via map layer */
  fs?: ImportFs;
  /** 路径环境覆盖 */
  env?: ImportPathEnv;
  maxBytes?: number;
  /**
   * 已有会话列表（用于软去重）。默认读 session store。
   * 单测可注入。
   */
  listSessions?: () => Array<Pick<SessionState, 'id' | 'importMeta'>>;
  /**
   * 重复策略：skip（默认）跳过已导入；reimport 再造一条（忽略已有 meta）。
   */
  duplicatePolicy?: ImportDuplicatePolicy;
  /** 固定 importedAt（单测） */
  nowIso?: () => string;
};

function resolveDeps(deps?: ImportSessionsDeps) {
  const st = getSessionStoreState();
  return {
    createSession:
      deps?.createSession ??
      ((opts?: {
        title?: string;
        folder?: string;
        id?: string;
        activate?: boolean;
        importMeta?: SessionImportMeta;
      }) => st.createSession(opts)),
    addMessage:
      deps?.addMessage ??
      ((wsId: string, sessionId: string, message: SessionMessage) =>
        st.addMessage(wsId, sessionId, message)),
    wsId: deps?.wsId ?? '__global__',
    listSessions:
      deps?.listSessions ??
      (() => st.sessions as Array<Pick<SessionState, 'id' | 'importMeta'>>),
    duplicatePolicy: deps?.duplicatePolicy ?? 'skip',
    nowIso: deps?.nowIso ?? (() => new Date().toISOString()),
  };
}

function mapOptsFromDeps(deps?: ImportSessionsDeps): MapExternalOptions | undefined {
  if (!deps) return undefined;
  const out: MapExternalOptions = {};
  if (deps.fs) out.fs = deps.fs;
  if (deps.env) out.env = deps.env;
  if (deps.maxBytes != null) out.maxBytes = deps.maxBytes;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 从会话列表收集已导入的 external key 集合。
 * 纯函数，便于单测。
 */
export function collectExistingImportKeys(
  sessions: Array<Pick<SessionState, 'importMeta'>>,
): Set<string> {
  const keys = new Set<string>();
  for (const s of sessions) {
    const meta = s.importMeta;
    if (!meta?.source || !meta.sourceSessionId) continue;
    keys.add(makeExternalImportKey(meta.source, meta.sourceSessionId));
  }
  return keys;
}

/** 构建写入 createSession 的 importMeta */
export function buildImportMeta(
  mapped: MappedImportSession,
  importedAt: string,
): SessionImportMeta {
  const meta: SessionImportMeta = {
    source: mapped.source,
    sourceSessionId: mapped.sourceId,
    importedAt,
  };
  if (mapped.path) meta.sourcePath = mapped.path;
  return meta;
}

/** 写入单条已 map 会话；后台创建（activate:false）避免抢焦点；打 importMeta 标签 */
export function writeMappedSession(
  mapped: MappedImportSession,
  deps?: ImportSessionsDeps,
): string {
  const { createSession, addMessage, wsId, nowIso } = resolveDeps(deps);
  const importMeta = buildImportMeta(mapped, nowIso());
  const sessionId = createSession({
    title: mapped.title,
    ...(mapped.folder !== undefined ? { folder: mapped.folder } : {}),
    activate: false,
    importMeta,
  });
  for (const msg of mapped.messages) {
    addMessage(wsId, sessionId, msg);
  }
  return sessionId;
}

/**
 * 导入用户勾选的检测结果：map → soft-dedup → createSession(+messages)。
 * 默认对同一 source+sourceSessionId 跳过（soft-dedup）。
 */
export async function importDetectedSessions(
  selected: DetectedExternalSession[],
  deps?: ImportSessionsDeps,
): Promise<ImportSessionsResult> {
  if (!selected.length) {
    return {
      imported: 0,
      skipped: 0,
      skippedDuplicates: 0,
      errors: [],
      sessionIds: [],
    };
  }

  const resolved = resolveDeps(deps);
  const { mapped, errors } = await mapExternalSessions(
    selected,
    mapOptsFromDeps(deps),
  );
  const sessionIds: string[] = [];
  let imported = 0;
  let writeFailed = 0;
  let skippedDuplicates = 0;

  const existingKeys =
    resolved.duplicatePolicy === 'skip'
      ? collectExistingImportKeys(resolved.listSessions())
      : new Set<string>();
  // 本批次内也去重（勾选了同一源两次时只导一次）
  const batchKeys = new Set<string>();

  for (const m of mapped) {
    const key = makeExternalImportKey(m.source, m.sourceId);
    if (resolved.duplicatePolicy === 'skip') {
      if (existingKeys.has(key) || batchKeys.has(key)) {
        skippedDuplicates += 1;
        continue;
      }
    }
    try {
      const id = writeMappedSession(m, deps);
      sessionIds.push(id);
      imported += 1;
      batchKeys.add(key);
      existingKeys.add(key);
    } catch (err) {
      writeFailed += 1;
      errors.push(`${m.title}：${String(err)}`);
    }
  }

  const mapFailed = selected.length - mapped.length;
  const skipped = mapFailed + writeFailed + skippedDuplicates;

  return { imported, skipped, skippedDuplicates, errors, sessionIds };
}
