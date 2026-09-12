/**
 * sessionRustDb 子模块 · Fallback：localStorage 同步回退路径
 *
 * 职责（同步 IO，无 invoke）：
 *   - 索引 / active / folder 的 localStorage 同步读写兜底。
 *   - **正文与 agents 无读写口**（D-F06）：SQLite 为唯一权威；
 *     30 天清理护栏仅用键存在性/非空判定，不再解析全文。
 *   - 降级时仅内存 store + errorStore 留痕。
 */

import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import {
  parseFolderOrder,
  parseSessionIndexList,
  safeParseJson,
} from './sessionHydration';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';

export function lsLoadSessionIndex(): SessionIndexEntry[] {
  try {
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    if (!raw) return [];
    return parseSessionIndexList(safeParseJson<unknown>(raw, null));
  } catch {
    return [];
  }
}

export function lsSaveSessionIndex(entries: SessionIndexEntry[]): void {
  try {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify(parseSessionIndexList(entries))
    );
  } catch {
    /* swallow-ok: quota/隐私模式写索引尽力而为，失败走内存态 */
  }
}

/**
 * LS 正文键是否仍持有非空数据（清理护栏判定，不解析全文）。
 *
 * 读失败/坏 JSON → `true`（无法确认则保留，防唯一副本误删）。
 */
export function hasNonEmptyLegacySessionBody(sessionId: string): boolean {
  try {
    const raw = localStorage.getItem(SESSION_BODY_PREFIX + sessionId);
    if (!raw) return false;
    const t = raw.trimStart();
    if (t.startsWith('[')) {
      const arr = safeParseJson<unknown[] | null>(raw, null);
      return Array.isArray(arr) && arr.length > 0;
    }
    return raw.split(/\r?\n/).some((line) => line.trim().length > 0);
  } catch {
    return true;
  }
}

/**
 * LS agents 键是否仍持有非空数据（清理护栏判定，不解析全文）。
 */
export function hasNonEmptyLegacySessionAgents(sessionId: string): boolean {
  try {
    const raw = localStorage.getItem(SESSION_AGENTS_PREFIX + sessionId);
    if (!raw) return false;
    const arr = safeParseJson<unknown[] | null>(raw, null);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return true;
  }
}

// D-F06：lsSaveSessionBody / lsSaveSessionAgents / lsLoadSessionBody /
// lsLoadSessionAgents 已全部物理删除。SQLite 为正文与 agents 唯一权威；
// 迁移直接读 raw key 字符串交给 Rust import；清理护栏用 hasNonEmptyLegacy*。

export function lsLoadActiveSessionId(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_ACTIVE_KEY);
    if (raw == null) return null;
    const id = raw.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function lsSaveActiveSessionId(id: string): void {
  try {
    if (!id?.trim() || isPendingDraft(id)) {
      localStorage.removeItem(SESSION_ACTIVE_KEY);
      return;
    }
    localStorage.setItem(SESSION_ACTIVE_KEY, String(id).trim());
  } catch {
    /* swallow-ok: 活跃会话标记写失败仅影响重启后的默认选中 */
  }
}

export function lsLoadFolderOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(SESSION_FOLDER_KEY);
    if (!raw) return null;
    return parseFolderOrder(safeParseJson<unknown>(raw, null));
  } catch {
    return null;
  }
}

export function lsSaveFolderOrder(order: string[]): void {
  try {
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(order || []));
  } catch {
    /* swallow-ok: 文件夹顺序持久化尽力而为，失败回退默认排序 */
  }
}

// ── 降级戳残留键一次性清理（维度 1 / D2） ───────────────────────────────────
//
// 背景：降级戳写面与读面（T2-1 已删）均已删除，但用户环境中可能仍残留历史
// crish_degraded_* 键。cleanupDegradedMarkerKeys 遍历 localStorage 删除该前缀键，
// 全程 try/catch + 模块级 once 守卫，仅在首次 persist 路径执行一次
// （进程生命周期内幂等，不重复扫描）。

let degradedCleanupDone = false;

/**
 * 一次性清除 localStorage 中残留的降级戳键（crish_degraded_*）。
 * 模块级 once 守卫保证进程内仅执行一次；扫描失败静默忽略，下次进程再清。
 */
export function cleanupDegradedMarkerKeys(): void {
  if (degradedCleanupDone) return;
  degradedCleanupDone = true;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('crish_degraded_')) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* swallow-ok: 残留键清理失败不阻塞 persist 主流程，下次进程再清 */
  }
}
