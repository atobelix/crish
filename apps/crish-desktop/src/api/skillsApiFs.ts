/**
 * 技能 FS 访问层（T4-11 R5 基线清零）。
 *
 * 从 `skillsApi.ts` 拆分而来；本模块承载 plugin-fs 优先、回退 workspaceFsApi 的
 * 文件系统访问函数，无业务 / 激活态 / 斜杠命令逻辑，便于被发现层与创建层复用。
 * 依赖：`./workspaceFsApi`（沙箱内回退）、`./projectStore`（工作区路径探测）、
 * `./skillsApiHelpers`（joinPath）。
 */

import { joinPath, EXTRA_DIRS_KEY } from './skillsApiHelpers';
import { getWorkspacePath } from './projectStore';
import {
  listDirectory,
  readTextFile,
  type FsDirEntry,
} from './workspaceFsApi';

const PLUGIN_FS_PKG = '@tauri-apps/plugin-fs';
const TAURI_PATH_PKG = '@tauri-apps/api/path';

/* ---------- extra skill dirs（localStorage 管理；发现层与 hub 共用） ---------- */

export function getExtraSkillDirs(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_DIRS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function setExtraSkillDirs(dirs: string[]) {
  localStorage.setItem(EXTRA_DIRS_KEY, JSON.stringify(dirs.filter(Boolean)));
}

export function addExtraSkillDir(dir: string) {
  const d = dir.trim();
  if (!d) return getExtraSkillDirs();
  const list = getExtraSkillDirs();
  if (!list.includes(d)) list.push(d);
  setExtraSkillDirs(list);
  return list;
}

export function removeExtraSkillDir(dir: string) {
  const list = getExtraSkillDirs().filter((d) => d !== dir);
  setExtraSkillDirs(list);
  return list;
}

/* ---------- plugin-fs 探测（私有） ---------- */

type PluginFsApi = {
  readDir?: (p: string) => Promise<
    Array<{
      name?: unknown;
      isDirectory?: boolean;
      isDir?: boolean;
      children?: unknown;
    }>
  >;
  readTextFile?: (p: string) => Promise<string>;
  writeTextFile?: (p: string, content: string) => Promise<void>;
  mkdir?: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
};

export async function tryPluginFs(): Promise<PluginFsApi | null> {
  const fs: unknown = await (
    import(/* @vite-ignore */ PLUGIN_FS_PKG) as Promise<unknown>
  ).catch(() => null);
  return (fs as NonNullable<Awaited<ReturnType<typeof tryPluginFs>>>) || null;
}

export async function tryHomeDir(): Promise<string | null> {
  const pathApi = (await (
    import(/* @vite-ignore */ TAURI_PATH_PKG) as Promise<unknown>
  ).catch(() => null)) as { homeDir?: () => Promise<string> } | null;
  const h = pathApi?.homeDir ? await pathApi.homeDir().catch(() => null) : null;
  return h ? String(h) : null;
}

/* ---------- 列目录：plugin-fs 优先，回退 listDirectory ---------- */

export async function listDirAny(dirPath: string): Promise<FsDirEntry[]> {
  const path = dirPath.trim();
  if (!path) return [];
  const fs = await tryPluginFs();
  if (fs?.readDir) {
    try {
      const entries = await fs.readDir(path);
      return (entries || []).map((e) => {
        const name = String(e.name ?? e);
        const isDir = Boolean(e.isDirectory ?? e.isDir ?? e.children);
        return { name, isDir, path: joinPath(path, name) };
      });
    } catch {
      /* swallow-ok: 插件 fs 读取失败时回退底层扫描路径 */
    }
  }
  try {
    return await listDirectory(path);
  } catch {
    return [];
  }
}

/* ---------- 读文本：plugin-fs 优先，回退 readTextFile ---------- */

export async function readTextAny(
  filePath: string,
  maxLines = 8000
): Promise<string | null> {
  const path = filePath.trim();
  if (!path) return null;
  const fs = await tryPluginFs();
  if (fs?.readTextFile) {
    try {
      return await fs.readTextFile(path);
    } catch {
      /* swallow-ok: 插件 fs 读取失败时回退底层 readTextFile */
    }
  }
  try {
    const r = await readTextFile(path, maxLines);
    return r.content;
  } catch {
    return null;
  }
}

/* ---------- 写文本 / 建目录：仅 plugin-fs（无沙箱回退） ---------- */

export async function writeTextAny(
  filePath: string,
  content: string
): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.writeTextFile) {
    try {
      await fs.writeTextFile(filePath, content);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function mkdirAny(dirPath: string): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.mkdir) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/* ---------- FS 能力探测 ---------- */

/** 开发时探测：是否具备本机文件读取能力 */
export async function skillsFsAvailable(): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.readDir && fs?.readTextFile) return true;
  return Boolean(getWorkspacePath());
}
