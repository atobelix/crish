/**
 * apps/crish-desktop/src/api/projectAliases.ts
 *
 * 项目文件夹别名（folderIdOrLegacy → 绝对路径）持久化微模块。
 * 拆分来源：api/projectStore.ts（行数门禁收口，行为不变）。
 */

import { safeSetJson } from './localStorageApi';

const FOLDER_ALIASES_KEY = 'crish_project_folder_aliases_v1';

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export type AliasMap = Record<string, string>; // folderIdOrLegacy → absolute path

export function loadAliases(): AliasMap {
  try {
    const raw = localStorage.getItem(FOLDER_ALIASES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: AliasMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v.trim()) {
        out[k] = normalizePath(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAliases(map: AliasMap) {
  // 统一存储单轨：safeSetJson 内置序列化/quota 容错（swallow-ok：尽力写，失败下次启动重试）
  safeSetJson(FOLDER_ALIASES_KEY, map);
}

/** 记录 id→path，供幽灵 proj-* 找回 */
export function rememberProjectFolderAlias(
  projectId: string,
  path: string
): void {
  if (!projectId || !path) return;
  const map = loadAliases();
  map[projectId] = normalizePath(path);
  saveAliases(map);
}
