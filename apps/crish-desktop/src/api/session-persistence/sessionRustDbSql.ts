/**
 * sessionRustDb 子模块 · Sql：SQLite invoke API 面（hub）
 *
 * 职责：
 *   - 14 个 API 中 SQLite 路径的实现（invoke → Tauri → spawn_blocking → SQLite），
 *     命令缺失（浏览器 / 旧壳 / 测试环境）→ 回退到 localStorage 同步路径（Fallback 子模块）
 *   - P18（AA-07）子代理超软上限 meta 留痕（readAgentsOverCapMeta）
 *
 * 写竞态防线（串行队列 + 批次版本戳）已拆到 sessionRustDbWriteGuard；
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
  lsLoadSessionIndex,
  lsSaveActiveSessionId,
  lsSaveFolderOrder,
} from './sessionRustDbFallback';
import {
  SESSION_AGENTS_OVER_CAP_META_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  type AgentsTruncationRecord,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { hasQuotaTruncation } from './sessionQuota';
import {
  hydrateSessionAgents,
  parseFolderOrder,
  safeParseJson,
} from './sessionHydration';

// re-export 写竞态防线（拆分自本文件，对外路径不变；Wave C 后仅队列+版本戳）
export { enqueuePersist, nextBatchVersion } from './sessionRustDbWriteGuard';
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
 * 命令缺失/失败 → 不再静默回退 LS 正文（D-F06 剥双轨）：SQLite 为正文
 * 唯一权威，失败经 errorStore 数据面留痕并返回空数组；已在内存 store
 * 中的活跃会话正文不受影响（内存即降级留痕）。
 */
export async function loadSessionBody(
  sessionId: string,
  options?: { limit?: number; beforeSeq?: number }
): Promise<SessionMessage[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  const res = await invokeResult<RustSessionMessage[]>('load_session_body', {
    sessionId,
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.beforeSeq !== undefined
      ? { beforeSeq: options.beforeSeq }
      : {}),
  });
  // P1-F3（F5-03）：历史 LS quota 截断标志 → 数据面日志提示（提示 UI 最小化，仅日志；
  // 数据面暴露走 sessionQuota.hasQuotaTruncation）。标志存在意味着迁移前某次
  // LS 写入因 quota 超限被截断为最后 100 条，旧消息静默丢失——必须留痕。
  if (hasQuotaTruncation(sessionId)) {
    logInternalError('ls-quota-truncated', { sessionId });
  }
  if (res.status === 'ok') {
    const msgs = fromRustSessionMessages(res.data || []);
    if (
      options &&
      (options.limit !== undefined || options.beforeSeq !== undefined)
    ) {
      if (
        options.beforeSeq !== undefined &&
        msgs.length > (options.limit ?? 50)
      ) {
        const end = Math.min(options.beforeSeq, msgs.length);
        const start = Math.max(0, end - (options.limit ?? 50));
        return msgs.slice(start, end);
      } else if (options.limit !== undefined && msgs.length > options.limit) {
        return msgs.slice(-options.limit);
      }
    }
    return msgs;
  }
  // D-F06：缺/错命令不再回退 lsLoadSessionBody（该读面降格为迁移专用，
  // 见 sessionRustDbFallback 头注）。失败改走 errorStore 数据面带（与
  // save 路径 persist-degraded-ls 同一专名，command 区分读/写面）。
  logInternalError('persist-degraded-ls', {
    command: 'load_session_body',
    sessionId,
    status: res.status,
    // 观测面（2026-09-15 补）：同 save 路径，后端错误消息必须落进日志。
    message: res.status === 'error' ? res.message : undefined,
  });
  return [];
}

/**
 * 全量保存会话正文（增量 Upsert 由 Rust 侧承接）。
 * T2-1 剥镜像：SQLite 为唯一落点，命令缺失/错误不改写 LS、不打降级戳，
 * 失败经 errorStore 数据面带呈现（persist-degraded-ls，非静默回退）。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 body。
 *
 * @param batchVersion 批次版本戳（R9 单调递增，随 IPC 传递；Wave C 后内存侧
 * 不再做 CAS 丢弃——后端 Upsert 为唯一写安全源）。**`null` = 进程首批的显式
 * 非 CAS rebase**（见 sessionRustDbWriteGuard.nextBatchVersion）；后端在该
 * 分支把 `body_version` 归零，使后续递增版本与库中序列连续。
 */
export async function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  batchVersion: number | null
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  const msgs = messages || [];
  const rustMessages = msgs.map(toRustSessionMessage);

  const res = await invokeResult<void>('save_session_body', {
    sessionId,
    messages: rustMessages,
    batchVersion,
  });
  if (res.status === 'ok') {
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
    // 观测面（2026-09-15 补）：只记 status 时 `CasConflict` 与其它错误在日志里
    // **不可区分**——真实事故（重启后 65 个会话正文全失败）的日志无法指认根因，
    // 只能靠逐层读源码反推。后端错误消息必须落进日志。
    message: res.status === 'error' ? res.message : undefined,
  });
}

/**
 * 加载会话下的协作子 agent。
 * 命令缺失/失败 → 不再静默回退 LS agents（D-F06 偏离 #2 收尾，与正文同构）：
 * SQLite 为 agents 唯一权威，失败经 errorStore 数据面留痕并返回空数组；
 * lsLoadSessionAgents 仅供 30 天清理护栏唯一副本判定（最小只读迁移面）。
 */
export async function loadSessionAgents(
  sessionId: string
): Promise<SessionAgent[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
  // Wave C（D-F03）：LS 截断标志读面已随 sessionAgentsTruncation 整模块删除；
  // SQLite 主路径全量保存。
  const res = await invokeResult<RustSessionAgent[]>('load_session_agents', {
    sessionId,
  });
  if (res.status === 'ok')
    return hydrateSessionAgents(fromRustSessionAgents(res.data || []));
  // D-F06 偏离 #2：缺/错命令不再回退 lsLoadSessionAgents（该读面降格为
  // 清理护栏专用，见 sessionRustDbFallback 头注）。失败改走 errorStore 数据面带。
  logInternalError('persist-degraded-ls', {
    command: 'load_session_agents',
    sessionId,
    status: res.status,
  });
  return [];
}

/**
 * 保存会话下的协作子 agent。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 agents。
 *
 * D-F06 偏离 #2 收尾（与正文同构）：SQLite 为唯一落点，命令缺失/错误不改写
 * LS agents 镜像，失败经 errorStore 数据面带呈现（persist-degraded-ls）。
 * lsSaveSessionAgents 写口已物理删除，严禁恢复。
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
    // 空列表仍调 invoke 让 Rust 侧清空；missing/error 时仅留痕，不写 LS
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
  // D-F06 偏离 #2：缺/错命令不再回退写 LS agents。失败改走 errorStore 数据面带
  //（persist-degraded-ls 经 logInternalError 推入 errorStore → 可感知降级，非静默）。
  logInternalError('persist-degraded-ls', {
    command: 'save_session_agents',
    sessionId,
    status: res.status,
  });
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
