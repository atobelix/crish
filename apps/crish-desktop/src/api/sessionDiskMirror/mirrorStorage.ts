/**
 * 会话磁盘镜像：IO 交互、Tauri 镜像写入与恢复
 */

import type { SessionState } from '../../store/layoutStore';
import { messagesToJsonl } from '../session-persistence/sessionHydration';
import { sessionsToIndex } from '../session-persistence/sessionLocalStorage';
import { logInternalError } from '../userFacingErrors';

import {
  MIRROR_META_STORAGE_KEY,
  type MirrorRestoreResult,
  type SessionDiskMirrorMeta,
} from './mirrorTypes';

import {
  assembleSessionsFromMirrorEntries,
  buildMirrorIndexDocument,
  buildMirrorMeta,
  finalizeMirrorRestore,
  isSafeMirrorSessionId,
  mirrorIndexFilePath,
  mirrorSessionBodyFilePath,
  normalizeMirrorBaseDir,
  normalizeMirrorMeta,
  parseMirrorIndexJson,
  parseMirrorMetaJson,
  serializeMirrorIndexDocument,
} from './mirrorSanitizer';

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
    await fs.writeTextFile(path, contents);
    return true;
  } catch {
    return false;
  }
}

async function tryTauriRead(path: string): Promise<string | null> {
  try {
    const fs: any = await loadTauriFs();
    if (!fs?.readTextFile) return null;
    const text = await fs.readTextFile(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
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
      
    const existingNewIndex = await tryTauriRead(newIndexPath);
    if (existingNewIndex && existingNewIndex.trim()) {
      return;
    }

    if (!pathApi.appDataDir) return;
    const currentAppData = await pathApi.appDataDir();
    if (!currentAppData) return;

    const oldFlowbitDir = pathApi.join
      ? await pathApi.join(currentAppData, '..', 'me.flowbit.crish', 'crish', 'sessions')
      : `${String(currentAppData).replace(/[\\/]+$/, '')}/../me.flowbit.crish/crish/sessions`;

    const oldIndexPath = pathApi.join
      ? await pathApi.join(oldFlowbitDir, 'index.json')
      : `${oldFlowbitDir}/index.json`;

    const indexRaw = await tryTauriRead(oldIndexPath);
    if (!indexRaw || !indexRaw.trim()) {
      return;
    }

    await fs.writeTextFile(newIndexPath, indexRaw);

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

    const bodyWrites: Promise<boolean>[] = [];
    for (const s of list) {
      const bodyPath = mirrorSessionBodyFilePath(dir, s.id);
      if (!bodyPath) continue;
      bodyWrites.push(
        tryTauriWrite(bodyPath, messagesToJsonl(s.messages || [])),
      );
    }
    await Promise.all(bodyWrites);

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
