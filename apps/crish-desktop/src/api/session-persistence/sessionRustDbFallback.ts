/**
 * sessionRustDb 子模块 · Fallback：localStorage 同步回退路径 + 降级戳
 *
 * 职责（同步 IO，无 invoke）：
 *   - 当 Tauri invoke 不可用（浏览器 / 旧壳 / 测试 missing 状态）时，所有
 *     API 降级到 localStorage 同步读写。保证 dev / test 环境与渐进迁移期不阻塞。
 *   - 这层回退只读 / 写 localStorage，不再触碰 IndexedDB 或磁盘镜像（已删除）。
 *   - P1-F1（F5-01）降级戳：invoke 失败降级 LS 时留下痕迹，hydrate 据此
 *     以 LS 正文为真源回灌并回写 SQLite（单向修复路径），消除分叉。
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
import {
  clearAgentsTruncation,
  markAgentsTruncated,
} from './sessionAgentsTruncation';
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
      clearAgentsTruncation(sessionId);
      return;
    }
    if (agents.length > SESSION_AGENTS_SAVE_CAP) {
      // P18（AA-07）：LS 镜像受配额保护线约束，截断落盘时置位截断标志
      // （记录 total/saved/cap 事实），不再静默丢弃——数据面可提示。
      localStorage.setItem(
        SESSION_AGENTS_PREFIX + sessionId,
        JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP))
      );
      markAgentsTruncated(sessionId, {
        cap: SESSION_AGENTS_SAVE_CAP,
        total: agents.length,
        saved: SESSION_AGENTS_SAVE_CAP,
        at: Date.now(),
      });
      return;
    }
    // 未超上限：全量落盘并清除历史截断标志（恢复策略，同 P1-F3 quota 口径）
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + sessionId,
      JSON.stringify(agents)
    );
    clearAgentsTruncation(sessionId);
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

// ── 降级戳（P1-F1 F5-01） ─────────────────────────────────────────────────────
//
// 背景：invoke 失败降级 LS 时若不留下任何痕迹，SQLite 保持旧正文，而 LS 持有
// 最新正文——下次 hydrate 以 SQLite 为正文源展示旧数据，新消息「丢失」且用户
// 无从知晓（F5-01）。降级戳记录「该会话 LS 正文为最新、SQLite 可能为旧快照」，
// hydrate 据此以 LS 正文为真源回灌并回写 SQLite（单向修复路径），消除分叉。

/** 降级戳 key 前缀（任务书 T5.1 约定 crish_degraded_） */
const DEGRADED_MARKER_PREFIX = 'crish_degraded_';

function degradedMarkerKey(sessionId: string): string {
  return DEGRADED_MARKER_PREFIX + sessionId;
}

/**
 * 标记会话已降级（值 = 降级时间戳）。
 * 写入自身 try/catch：quota/隐私模式下戳写不进也不阻塞降级路径（AU-03:127 残余细节）。
 */
export function markDegradedSession(sessionId: string): void {
  try {
    localStorage.setItem(degradedMarkerKey(sessionId), String(Date.now()));
  } catch {
    /* swallow-ok: quota/隐私模式下降级标记写失败，下次回放仍可判定 */
  }
}

/** 会话是否存在未修复的降级戳。 */
export function hasDegradedSession(sessionId: string): boolean {
  try {
    return localStorage.getItem(degradedMarkerKey(sessionId)) != null;
  } catch {
    return false;
  }
}

/**
 * 清除会话降级戳。
 * 调用时机约束（AU-03:127）：仅在「修复回写 SQLite 成功」后调用——回写失败时
 * 保持戳，下次 hydrate 重试单向修复，避免分叉在无痕状态下复发。
 */
export function clearDegradedSession(sessionId: string): void {
  try {
    localStorage.removeItem(degradedMarkerKey(sessionId));
  } catch {
    /* swallow-ok: 降级标记清除失败仅留下过期标记，无功能影响 */
  }
}
