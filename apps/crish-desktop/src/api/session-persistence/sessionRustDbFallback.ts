/**
 * sessionRustDb 子模块 · Fallback：localStorage 同步回退路径
 *
 * 职责（同步 IO，无 invoke）：
 *   - 当 Tauri invoke 不可用（浏览器 / 旧壳 / 测试 missing 状态）时，所有
 *     API 降级到 localStorage 同步读写。保证 dev / test 环境与渐进迁移期不阻塞。
 *   - 这层回退只读 / 写 localStorage，不再触碰 IndexedDB 或磁盘镜像（已删除）。
 *   - 降级戳（P1-F1 / F5-01）写面已在维度 1（D2）随读面（T2-1）一并删除，
 *     persist 路径保留一次性 cleanup 清除历史残留的 crish_degraded_* 键。
 */

import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import type { MessageCacheState } from '@crish/shared-types';
import {
  hydrateSessionAgents,
  parseFolderOrder,
  parseSessionAgents,
  parseSessionIndexList,
  parseSessionMessage,
  safeParseJson,
} from './sessionHydration';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import type { SessionAgent, SessionMessage } from '../../store/layoutStore';

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
 * 从原始存盘 JSON 恢复 cacheMetrics（R6-D5 回放面，localStorage 回退路径）。
 * lsSaveSessionBody 整条 JSON.stringify SessionMessage（含 cacheMetrics），
 * 而 parseSessionMessage 是白名单守卫不携带该字段 → 读回时重新挂载，
 * 与 SQLite usage_json 回读（fromRustSessionMessage）行为对齐。
 * MessageCacheState 形状守卫：metrics 非空对象 + source 枚举合法才挂载，
 * 其余情况原样返回（坏数据不传播）。
 */
function attachStoredCacheMetrics(
  parsed: SessionMessage | null,
  raw: unknown
): SessionMessage | null {
  if (!parsed) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parsed;
  const cache = (raw as Record<string, unknown>).cacheMetrics;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache))
    return parsed;
  const cm = cache as Record<string, unknown>;
  const metrics = cm.metrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics))
    return parsed;
  const source = cm.source;
  if (
    source !== 'engine-message-end' &&
    source !== 'degraded-direct' &&
    source !== null
  ) {
    return parsed;
  }
  parsed.cacheMetrics = {
    metrics: metrics as MessageCacheState['metrics'],
    source: source as MessageCacheState['source'],
  };
  return parsed;
}

export function lsLoadSessionBody(sessionId: string): SessionMessage[] {
  try {
    const raw = localStorage.getItem(SESSION_BODY_PREFIX + sessionId);
    if (!raw) return [];
    // 兼容 JSON 数组与 JSONL 两种历史格式
    if (raw.trimStart().startsWith('[')) {
      const parsed = safeParseJson<unknown>(raw, null);
      if (!Array.isArray(parsed)) return [];
      const out: SessionMessage[] = [];
      for (const item of parsed) {
        const m = attachStoredCacheMetrics(parseSessionMessage(item), item);
        if (m) out.push(m);
      }
      return out;
    }
    // JSONL 路径：用 parseSessionMessage 逐行解析（与 sessionHydration 历史行为一致）
    const out: SessionMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const item = JSON.parse(t);
        const m = attachStoredCacheMetrics(parseSessionMessage(item), item);
        if (m) out.push(m);
      } catch {
        /* swallow-ok: 单行损坏跳过，不阻断整批回放 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function lsSaveSessionBody(
  sessionId: string,
  messages: SessionMessage[]
): void {
  try {
    localStorage.setItem(
      SESSION_BODY_PREFIX + sessionId,
      JSON.stringify(messages)
    );
  } catch {
    /* swallow-ok: quota 超限时正文尽力写，失败保留引擎侧数据 */
  }
}

export function lsLoadSessionAgents(sessionId: string): SessionAgent[] {
  try {
    const raw = localStorage.getItem(SESSION_AGENTS_PREFIX + sessionId);
    if (!raw) return [];
    return hydrateSessionAgents(
      parseSessionAgents(safeParseJson<unknown>(raw, null))
    );
  } catch {
    return [];
  }
}

export function lsSaveSessionAgents(
  sessionId: string,
  agents: SessionAgent[]
): void {
  try {
    if (!agents || agents.length === 0) {
      localStorage.removeItem(SESSION_AGENTS_PREFIX + sessionId);
      return;
    }
    // Wave C（D-F03）：LS 镜像受配额保护线约束仍 slice；截断标志已随
    // sessionAgentsTruncation 整模块删除（SQLite 主路径全量保存）。
    if (agents.length > SESSION_AGENTS_SAVE_CAP) {
      localStorage.setItem(
        SESSION_AGENTS_PREFIX + sessionId,
        JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP))
      );
      return;
    }
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + sessionId,
      JSON.stringify(agents)
    );
  } catch {
    /* swallow-ok: quota 超限时 agents 写失败不影响会话主体 */
  }
}

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
