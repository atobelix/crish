/**
 * 会话磁盘镜像（H3）
 *
 * - 主路径仍是 localStorage（sessionPersistence）
 * - 有 Tauri 时尽力写入应用数据目录，防配额炸
 * - 浏览器环境仅写 localStorage，不报错
 */

import type { SessionState } from '../store/layoutStore';
import {
  jsonlToMessages,
  messagesToJsonl,
  sanitizeMessagesForHydrate,
  sessionsToIndex,
  type SessionIndexEntry,
} from './sessionPersistence';
import { logInternalError } from './userFacingErrors';

const MIRROR_META_KEY = 'crish_session_disk_mirror_v1';

export type SessionDiskMirrorMeta = {
  lastPath?: string;
  lastAt?: number;
  sessionCount?: number;
  mode?: 'tauri' | 'localStorage-only' | 'unavailable';
};

export function loadMirrorMeta(): SessionDiskMirrorMeta {
  try {
    const raw = localStorage.getItem(MIRROR_META_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SessionDiskMirrorMeta;
  } catch {
    return {};
  }
}

function saveMirrorMeta(meta: SessionDiskMirrorMeta) {
  try {
    localStorage.setItem(MIRROR_META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

async function tryTauriWrite(path: string, contents: string): Promise<boolean> {
  try {
    // 动态加载，浏览器无插件时静默失败
    const fs: any = await (Function('return import("@tauri-apps/plugin-fs")')() as Promise<any>).catch(
      () => null,
    );
    if (!fs?.writeTextFile) return false;
    // 确保目录：writeTextFile 在部分版本会自动创建父目录，失败则忽略
    await fs.writeTextFile(path, contents);
    return true;
  } catch {
    return false;
  }
}

async function resolveMirrorDir(): Promise<string | null> {
  try {
    const pathApi: any = await (Function(
      'return import("@tauri-apps/api/path")',
    )() as Promise<any>).catch(() => null);
    if (!pathApi?.appDataDir) return null;
    const base = await pathApi.appDataDir();
    if (!base) return null;
    const join = pathApi.join
      ? await pathApi.join(base, 'crish', 'sessions')
      : `${String(base).replace(/[\\/]+$/, '')}/crish/sessions`;
    // 尝试 mkdir
    try {
      const fs: any = await (Function('return import("@tauri-apps/plugin-fs")')() as Promise<any>).catch(
        () => null,
      );
      if (fs?.mkdir) {
        await fs.mkdir(join, { recursive: true }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return join;
  } catch {
    return null;
  }
}

/**
 * 将会话索引 + 各会话 JSONL 镜像到磁盘（尽力而为）。
 */
export async function mirrorSessionsToDisk(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
): Promise<SessionDiskMirrorMeta> {
  const dir = await resolveMirrorDir();
  if (!dir) {
    const meta: SessionDiskMirrorMeta = {
      mode: 'localStorage-only',
      lastAt: Date.now(),
      sessionCount: sessions.length,
    };
    saveMirrorMeta(meta);
    return meta;
  }

  try {
    const index = {
      version: 1,
      activeSessionId,
      folderOrder,
      sessions: sessionsToIndex(sessions),
      writtenAt: new Date().toISOString(),
    };
    const indexPath = `${dir.replace(/[\\/]+$/, '')}/index.json`;
    const okIndex = await tryTauriWrite(indexPath, JSON.stringify(index, null, 2));
    if (!okIndex) {
      const meta: SessionDiskMirrorMeta = {
        mode: 'unavailable',
        lastAt: Date.now(),
        sessionCount: sessions.length,
      };
      saveMirrorMeta(meta);
      return meta;
    }

    for (const s of sessions) {
      const bodyPath = `${dir.replace(/[\\/]+$/, '')}/${s.id}.jsonl`;
      await tryTauriWrite(bodyPath, messagesToJsonl(s.messages || []));
    }

    const meta: SessionDiskMirrorMeta = {
      mode: 'tauri',
      lastPath: dir,
      lastAt: Date.now(),
      sessionCount: sessions.length,
    };
    saveMirrorMeta(meta);
    return meta;
  } catch (e) {
    logInternalError('mirrorSessionsToDisk', e);
    const meta: SessionDiskMirrorMeta = {
      mode: 'unavailable',
      lastAt: Date.now(),
      sessionCount: sessions.length,
    };
    saveMirrorMeta(meta);
    return meta;
  }
}

async function tryTauriRead(path: string): Promise<string | null> {
  try {
    const fs: any = await (Function('return import("@tauri-apps/plugin-fs")')() as Promise<any>).catch(
      () => null,
    );
    if (!fs?.readTextFile) return null;
    const text = await fs.readTextFile(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * localStorage 会话空时，从磁盘镜像回灌（防站点数据清空后丢历史）。
 */
export async function restoreSessionsFromDiskMirror(): Promise<{
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
} | null> {
  const meta = loadMirrorMeta();
  const dir = meta.lastPath || (await resolveMirrorDir());
  if (!dir) return null;

  const base = dir.replace(/[\\/]+$/, '');
  const raw = await tryTauriRead(`${base}/index.json`);
  if (!raw?.trim()) return null;

  try {
    const index = JSON.parse(raw) as {
      activeSessionId?: string;
      folderOrder?: string[];
      sessions?: SessionIndexEntry[];
    };
    const entries = Array.isArray(index.sessions) ? index.sessions : [];
    if (!entries.length) return null;

    const sessions: SessionState[] = [];
    for (const e of entries) {
      if (!e?.id) continue;
      const bodyRaw = await tryTauriRead(`${base}/${e.id}.jsonl`);
      const messages = sanitizeMessagesForHydrate(
        bodyRaw ? jsonlToMessages(bodyRaw) : [],
      );
      sessions.push({
        id: e.id,
        title: e.title || '会话',
        folder: e.folder || '常规会话',
        isPinned: Boolean(e.isPinned),
        isArchived: Boolean(e.isArchived),
        branchParentId: e.branchParentId,
        timestamp: e.timestamp || '恢复',
        messages,
        pinnedMessageIds: e.pinnedMessageIds?.length ? e.pinnedMessageIds : undefined,
        agents: [],
        engineCursor: e.engineCursor,
        engineLastRunId: e.engineLastRunId,
        hydratedFromEngine: e.hydratedFromEngine,
      });
    }
    if (!sessions.length) return null;

    const activeSessionId =
      index.activeSessionId && sessions.some((s) => s.id === index.activeSessionId)
        ? index.activeSessionId
        : sessions[0].id;
    const folderOrder =
      Array.isArray(index.folderOrder) && index.folderOrder.length
        ? index.folderOrder
        : Array.from(new Set(sessions.map((s) => s.folder)));

    return { sessions, activeSessionId, folderOrder };
  } catch (e) {
    logInternalError('restoreSessionsFromDiskMirror', e);
    return null;
  }
}
