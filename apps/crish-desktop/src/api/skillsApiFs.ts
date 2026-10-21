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
import { listDirectory, readTextFile, type FsDirEntry } from './workspaceFsApi';

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

const FOREIGN_APP_DIRS = new Set([
  '.codex',
  '.claude',
  '.cursor',
  '.agents',
  '.gemini',
]);

/**
 * 外部软件自己的目录。登记进附加目录后会污染已安装列表。
 * 按路径分量判断，工具根目录（没有 skills 子路径）也算。
 * 本应用技能库里若再出现同名子目录，不把它当成外部软件。
 */
export function isForeignExtraSkillDir(dir: string): boolean {
  const parts = dir
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const ownedAt = parts.findIndex(
    (part, index) =>
      (part === '.conex' || part === '.crish') && parts[index + 1] === 'skills'
  );
  return parts.some(
    (part, index) =>
      FOREIGN_APP_DIRS.has(part) && (ownedAt === -1 || index < ownedAt)
  );
}

/** 清掉已经登记的外部软件技能目录，避免下一次发现被它们拖垮。 */
export function pruneForeignExtraSkillDirs(): string[] {
  const current = getExtraSkillDirs();
  const kept = current.filter((dir) => !isForeignExtraSkillDir(dir));
  if (kept.length !== current.length) setExtraSkillDirs(kept);
  return kept;
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
  remove?: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
};

export async function tryPluginFs(): Promise<PluginFsApi | null> {
  const fs: unknown = await (
    import(/* @vite-ignore */ PLUGIN_FS_PKG) as Promise<unknown>
  ).catch(() => null);
  return (fs as NonNullable<Awaited<ReturnType<typeof tryPluginFs>>>) || null;
}

/** 读取插件方法。缺导出时返回空，避免探测本身把导入流程打断。 */
function pluginMethod<T>(
  fs: PluginFsApi | null,
  name: keyof PluginFsApi
): T | null {
  if (!fs) return null;
  try {
    const method = fs[name];
    return typeof method === 'function' ? (method as T) : null;
  } catch {
    return null;
  }
}

export async function tryHomeDir(): Promise<string | null> {
  try {
    const pathApi = (await (
      import(/* @vite-ignore */ TAURI_PATH_PKG) as Promise<unknown>
    ).catch(() => null)) as { homeDir?: () => Promise<string> } | null;
    if (!pathApi || typeof pathApi.homeDir !== 'function') return null;
    const home = await pathApi.homeDir().catch(() => null);
    return home ? String(home) : null;
  } catch {
    return null;
  }
}

/* ---------- 列目录：plugin-fs 优先，回退 listDirectory ---------- */

export async function listDirAny(dirPath: string): Promise<FsDirEntry[]> {
  const path = dirPath.trim();
  if (!path) return [];
  const fs = await tryPluginFs();
  const readDir = pluginMethod<PluginFsApi['readDir']>(fs, 'readDir');
  if (readDir) {
    try {
      const entries = await readDir(path);
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
  const readPlugin = pluginMethod<PluginFsApi['readTextFile']>(
    fs,
    'readTextFile'
  );
  if (readPlugin) {
    try {
      return await readPlugin(path);
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
  const writePlugin = pluginMethod<PluginFsApi['writeTextFile']>(
    fs,
    'writeTextFile'
  );
  if (!writePlugin) return false;
  try {
    await writePlugin(filePath, content);
    return true;
  } catch {
    return false;
  }
}

export async function mkdirAny(dirPath: string): Promise<boolean> {
  const fs = await tryPluginFs();
  const mkdir = pluginMethod<PluginFsApi['mkdir']>(fs, 'mkdir');
  if (!mkdir) return false;
  try {
    await mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 删除技能副本。仅 plugin-fs 提供删除；失败时返回 false，不抛给界面。 */
export async function removePathAny(
  targetPath: string,
  recursive = false
): Promise<boolean> {
  const target = targetPath.trim();
  if (!target) return false;
  const fs = await tryPluginFs();
  const remove = pluginMethod<PluginFsApi['remove']>(fs, 'remove');
  if (!remove) return false;
  try {
    await remove(target, recursive ? { recursive: true } : undefined);
    return true;
  } catch {
    return false;
  }
}

/* ---------- FS 能力探测 ---------- */

/** 开发时探测：是否具备本机文件读取能力 */
export async function skillsFsAvailable(): Promise<boolean> {
  const fs = await tryPluginFs();
  if (pluginMethod(fs, 'readDir') && pluginMethod(fs, 'readTextFile'))
    return true;
  return Boolean(getWorkspacePath());
}
