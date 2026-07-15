/**
 * 会话磁盘镜像（H3）
 *
 * - 主路径仍是 localStorage（sessionPersistence）
 * - 有 Tauri 时尽力写入应用数据目录，防配额炸
 * - 浏览器环境仅写 localStorage，不报错
 */

import type { SessionState } from '../store/layoutStore';
import { messagesToJsonl, sessionsToIndex } from './sessionPersistence';
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
