/**
 * sessionRustDb 子模块 · Sql：SQLite invoke API 面（hub）
 *
 * 职责：
 *   - 14 个 API 中 SQLite 路径的实现（invoke → Tauri → spawn_blocking → SQLite），
 *     命令缺失（浏览器 / 旧壳 / 测试环境）→ 回退到 localStorage 同步路径（Fallback 子模块）
 *   - P18（AA-07）子代理超软上限 meta 留痕（readAgentsOverCapMeta）
 *
 * 写竞态防线已拆到 sessionRustDbWriteGuard；
 * 旧 localStorage 清理已拆到 sessionRustDbLegacyCleanup；
 * 此处 re-export 以保持对外 import 路径不变。
 */

import type { SessionAgent, SessionMessage } from '../../store/layoutStore';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import {
  fromRustSessionAgents,
  fromRustSessionIndexEntries,
  fromRustSessionMessages,
  toRustSessionAgent,
  toRustSessionMessage,
  type RustImportStats,
  type RustSessionAgent,
  type RustSessionIndexEntry,
  type RustSessionMessage,
} from './sessionRustDbWire';
import {
  lsLoadActiveSessionId,
  lsLoadFolderOrder,
  lsLoadSessionAgents,
  lsLoadSessionBody,
  lsLoadSessionIndex,
  lsSaveActiveSessionId,
  lsSaveFolderOrder,
  lsSaveSessionAgents,
} from './sessionRustDbFallback';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_OVER_CAP_META_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  type AgentsTruncationRecord,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { logger } from '../../services/LoggerService';
import { hasQuotaTruncation } from './sessionQuota';
import { readAgentsTruncation } from './sessionAgentsTruncation';
import {
  hydrateSessionAgents,
  parseFolderOrder,
  safeParseJson,
} from './sessionHydration';
import {
  recordWrittenBodyVersion,
  writtenBodyVersion,
} from './sessionRustDbWriteGuard';

// re-export 写竞态防线（拆分自本文件，对外路径不变）
export {
  enqueuePersist,
  isHydrateTruncated,
  nextBatchVersion,
} from './sessionRustDbWriteGuard';
export {
  recordWrittenBodyVersion,
  writtenBodyVersion,
} from './sessionRustDbWriteGuard';
// re-export 旧 localStorage 清理（拆分自本文件，对外路径不变）
export {
  cleanupLegacyLocalStorageSessionsGuarded,
  cleanupOrphanSessions,
  type LegacyCleanupGuardResult,
} from './sessionRustDbLegacyCleanup';

// ── 14 个 async API（invoke + localStorage 回退） ──────────────────────────

/**
 * 加载会话索引列表。
 * 命令缺失 → 回退 localStorage。
 */
export async function listSessions(): Promise<SessionIndexEntry[]> {
  const res = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
  if (res.status === 'ok') return fromRustSessionIndexEntries(res.data || []);
  return lsLoadSessionIndex();
}

/**
 * 加载会话正文消息。
 * 命令缺失 → 回退 localStorage。
 */
export async function loadSessionBody(
  sessionId: string
): Promise<SessionMessage[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  const res = await invokeResult<RustSessionMessage[]>('load_session_body', {
    sessionId,
  });
  // P1-F3（F5-03）：LS quota 截断标志 → 数据面日志提示（提示 UI 最小化，仅日志；
  // 数据面暴露走 sessionQuota.hasQuotaTruncation）。标志存在意味着某次
  // LS 写入因 quota 超限被截断为最后 100 条，旧消息静默丢失——必须留痕。
  if (hasQuotaTruncation(sessionId)) {
    logInternalError('ls-quota-truncated', { sessionId });
  }
  if (res.status === 'ok') return fromRustSessionMessages(res.data || []);
  return lsLoadSessionBody(sessionId);
}

/**
 * 全量保存会话正文（先删后插，事务原子）。
 * T2-1 剥镜像：SQLite 为唯一落点，命令缺失/错误不改写 LS、不打降级戳，
 * 失败经 errorStore 数据面带呈现（persist-degraded-ls，非静默回退）。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 body。
 *
 * @param batchVersion 批次版本戳（CAS 防线 2，裁决 R9 单调递增版本号）。
 * 落库前检查该会话已落库的最高版本，陈旧批次（版本 ≤ 已落库版本）直接
 * 丢弃不覆盖；版本随 IPC 参数传递，Rust 侧可据此实现 updated_at CAS
 * （任务书 T3.2 ③，Rust 命令面改动不在本实现轮范围）。
 */
export async function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  batchVersion: number
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  const msgs = messages || [];
  const rustMessages = msgs.map(toRustSessionMessage);

  // CAS：该会话已有更高版本批次落库 → 本批次为陈旧批次，直接丢弃不覆盖
  //（任何并发窗口下旧批次晚到都不得回滚新批次）。
  const written = writtenBodyVersion(sessionId);
  if (batchVersion <= written) {
    logger.warn(
      `[sessionPersistence] 丢弃陈旧写批次 v${batchVersion}（会话 ${sessionId} 已落库 v${written}）`,
      {
        module: 'sessionPersistence',
      },
    );
    return;
  }

  const res = await invokeResult<void>('save_session_body', {
    sessionId,
    messages: rustMessages,
    batchVersion,
  });
  if (res.status === 'ok') {
    recordWrittenBodyVersion(sessionId, batchVersion);
    // T2-1 剥镜像：SQLite 落库成功 = 唯一落点，不再镜像到 LS，
    // 也不再清除降级戳（无镜像即无降级戳语义）。
    return;
  }
  // T2-1 剥镜像：缺/错命令不再回退写 LS 正文、不再打降级戳。失败改走 errorStore 数据面带
  //（I1/T5 衔接：persist-degraded-ls 经 logInternalError 推入 errorStore → 可感知降级，非静默）。
  logInternalError('persist-degraded-ls', {
    command: 'save_session_body',
    sessionId,
    batchVersion,
    status: res.status,
  });
}

/**
 * 加载会话下的协作子 agent。
 */
export async function loadSessionAgents(
  sessionId: string
): Promise<SessionAgent[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  // P18（AA-07）：LS 镜像截断标志 → 数据面日志留痕（与 P1-F3 quota 截断同款
  // 暴露口径）。标志存在意味着某次 LS 镜像写入被配额保护线截断（saved < total），
  // 回退 LS 展示时数据不完整；SQLite 主路径为全量保存，不属于永久丢失。
  const trunc = readAgentsTruncation(sessionId);
  if (trunc) {
    logInternalError('ls-agents-truncated', {
      sessionId,
      cap: trunc.cap,
      total: trunc.total,
      saved: trunc.saved,
    });
  }
  const res = await invokeResult<RustSessionAgent[]>('load_session_agents', {
    sessionId,
  });
  if (res.status === 'ok')
    return hydrateSessionAgents(fromRustSessionAgents(res.data || []));
  return lsLoadSessionAgents(sessionId);
}

/**
 * 保存会话下的协作子 agent。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 agents。
 *
 * P18（AA-07）语义变更：SQLite 主路径全量保存，不再 slice——
 * Rust 侧 save_session_agents 无数量上限，第 41 个起的子代理及其消息不再
 * 静默丢失；SESSION_AGENTS_SAVE_CAP 退化为「软提示」阈值，超过时写
 * session_meta 留痕（agents_over_cap:<id>），供数据面提示。
 */
export async function saveSessionAgents(
  sessionId: string,
  agents: SessionAgent[]
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  if (!agents || agents.length === 0) {
    // 空列表仍调 invoke 让 Rust 侧清空；missing 时回退到 localStorage
    const res = await invokeResult<void>('save_session_agents', {
      sessionId,
      agents: [],
    });
    if (res.status === 'ok') return;
    logInternalError('persist-degraded-ls', {
      command: 'save_session_agents',
      sessionId,
      status: res.status,
    });
    lsSaveSessionAgents(sessionId, []);
    return;
  }
  const rustAgents = agents.map(toRustSessionAgent);
  const res = await invokeResult<void>('save_session_agents', {
    sessionId,
    agents: rustAgents,
  });
  if (res.status === 'ok') {
    // 超过软上限 → session_meta 记录「子代理过多」事实（全量落盘，saved=total）。
    // 记录用 upsert 覆盖保持最新，不做删除（留痕供审计与数据面提示）。
    if (agents.length > SESSION_AGENTS_SAVE_CAP) {
      await recordAgentsOverCap(sessionId, agents.length);
    }
    return;
  }
  // P1-F1：降级可观测（agents 降级不涉及正文分叉，无需打降级戳）
  logInternalError('persist-degraded-ls', {
    command: 'save_session_agents',
    sessionId,
    status: res.status,
  });
  lsSaveSessionAgents(sessionId, agents);
}

/**
 * 写「子代理超过软上限」session_meta 留痕（P18）。
 * record 携带 cap/total/saved/at 事实；invoke 失败时静默（meta 为提示性记录，
 * 不阻塞保存主流程，日志由 setSessionMeta 降级路径兜底）。
 */
async function recordAgentsOverCap(
  sessionId: string,
  total: number
): Promise<void> {
  const record: AgentsTruncationRecord = {
    cap: SESSION_AGENTS_SAVE_CAP,
    total,
    // SQLite 主路径全量落盘：saved = total（无丢失，仅超软提示阈值）
    saved: total,
    at: Date.now(),
  };
  await setSessionMeta(
    SESSION_AGENTS_OVER_CAP_META_PREFIX + sessionId,
    JSON.stringify(record)
  );
}

/**
 * 读取「子代理超过软上限」meta 留痕（P18 数据面暴露）。
 * 返回 null = 从未超过软上限；UI 层据此展示「会话内子代理过多」提示。
 */
export async function readAgentsOverCapMeta(
  sessionId: string
): Promise<AgentsTruncationRecord | null> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return null;
  const raw = await getSessionMeta(
    SESSION_AGENTS_OVER_CAP_META_PREFIX + sessionId
  );
  if (!raw) return null;
  return safeParseJson<AgentsTruncationRecord | null>(raw, null);
}

/**
 * 读取会话级元数据键。
 * 用于 schema_version / active_session_id / folder_order 等。
 */
export async function getSessionMeta(key: string): Promise<string | null> {
  if (!key?.trim()) return null;
  const res = await invokeResult<string | null>('get_session_meta', { key });
  if (res.status === 'ok') return res.data ?? null;
  // localStorage 回退：active / folder 有专用 key
  if (key === 'active_session_id') return lsLoadActiveSessionId();
  if (key === 'folder_order') {
    const order = lsLoadFolderOrder();
    return order ? JSON.stringify(order) : null;
  }
  if (key === 'schema_version') return null; // localStorage 时代无 schema_version
  return null;
}

/**
 * 写入会话级元数据键。
 */
export async function setSessionMeta(
  key: string,
  value: string
): Promise<void> {
  if (!key?.trim()) return;
  const res = await invokeResult<void>('set_session_meta', { key, value });
  if (res.status === 'ok') return;
  // localStorage 回退。P1-F1：降级可观测（meta 无正文分叉语义，不打降级戳）
  logInternalError('persist-degraded-meta', {
    command: 'set_session_meta',
    key,
    status: res.status,
  });
  if (key === 'active_session_id') lsSaveActiveSessionId(value);
  if (key === 'folder_order') {
    const order = parseFolderOrder(safeParseJson<unknown>(value, null));
    if (order) lsSaveFolderOrder(order);
  }
}

export interface ImportFromLocalStorageData {
  indexJson: string;
  bodies: Record<string, string>;
  agents: Record<string, string>;
  activeSessionId?: string | null;
  folderOrder: string[];
}

/**
 * 从 localStorage 历史数据一次性迁移到 SQLite。
 * 返回迁移统计；命令缺失时返回 null（调用方应直接走 localStorage 路径）。
 */
export async function importFromLocalStorage(
  data: ImportFromLocalStorageData
): Promise<RustImportStats | null> {
  const res = await invokeResult<RustImportStats>('import_from_localstorage', {
    indexJson: data.indexJson,
    bodies: data.bodies,
    agents: data.agents,
    activeSessionId: data.activeSessionId ?? null,
    folderOrder: data.folderOrder || [],
  });
  if (res.status === 'ok') return res.data;
  return null;
}
