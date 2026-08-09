/**
 * Stream D: Rust SQLite 会话持久化层
 *
 * 设计目标（系统化改造，非补丁式）：
 *   - 用 SQLite（conex-db）作为唯一会话存储，替代 localStorage + IndexedDB + 磁盘镜像三层冗余
 *   - 全部 14 个 API 走 Tauri invoke → Rust spawn_blocking → SQLite
 *   - 命令缺失（浏览器 / 旧壳 / 测试环境）→ 回退到 localStorage 同步路径
 *   - JS ↔ Rust 数据形状转换在此层完成（toolCalls/blocks 数组 ↔ JSON 字符串）
 *
 * 数据形状差异：
 *   - JS SessionMessage.toolCalls   ↔ Rust SessionMessage.tool_calls_json  (JSON 字符串)
 *   - JS SessionMessage.blocks      ↔ Rust SessionMessage.blocks_json     (JSON 字符串)
 *   - JS SessionMessage.toolCallResults ↔ Rust SessionMessage.tool_call_results_json
 *   - JS SessionMessage.streamTextOffset ↔ Rust SessionMessage.stream_text_offset (仅命名差异，serde camelCase 已对齐)
 *   - JS SessionMessage.thinkingTime ↔ Rust SessionMessage.thinking_time (serde camelCase 已对齐)
 *   - JS SessionAgent.subagentPath  ↔ Rust SessionAgent.subagent_path_json (JSON 字符串)
 *   - JS SessionIndexEntry.pinnedMessageIds: string[] ↔ Rust SessionIndexEntry.pinned_message_ids: Option<String> (JSON 字符串)
 *
 * 命令错误协议：invokeResult 三态（ok/missing/error）。
 *   - ok → 返回 Rust 数据
 *   - missing → 返回 null，调用方回退到 localStorage
 *   - error → 返回 null，调用方回退到 localStorage（错误细节仅日志记录）
 * Rust 侧 CoreError（serde tagged enum）序列化形态保留，但 JS 侧不按 kind 路由——
 * 当前所有错误一律回退 localStorage，避免单点错误阻塞会话读写。
 */

import type {
  SessionAgent,
  SessionMessage,
  SessionState,
} from '../../store/layoutStore';
import type {
  MessageTimelineBlock,
  MessageToolCall,
  SessionMessageToolCallResult,
} from '../../store/types';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';
import type { MessageCacheState } from '@crish/shared-types';
import { computeCacheMetricsFromUsage } from '../chat-bridge/handlers/cacheMetricsCompute';
import { coerceSessionTimestamp } from '../sessionTime';
import { prepareSessionsForUi } from '../sessionTitle';
import { normalizeAssistantTimeline } from '../toolPresentation';

import {
  parseSessionAgent,
  parseSessionAgents,
  parseSessionIndexEntry,
  parseSessionIndexList,
  parseSessionMessage,
  sanitizeMessagesForHydrate,
  hydrateSessionAgents,
  safeParseJson,
  parseFolderOrder,
} from './sessionHydration';
import {
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_AGENTS_OVER_CAP_META_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type AgentsTruncationRecord,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { hasQuotaTruncation } from './sessionQuota';
import {
  clearAgentsTruncation,
  markAgentsTruncated,
  readAgentsTruncation,
} from './sessionAgentsTruncation';

// ── Rust 侧类型（serde camelCase 反序列化产物） ─────────────────────────────

/**
 * Rust SessionMessage 形状（conex-types::SessionMessage 的 JS 投影）。
 * 与 store/types.ts 的 SessionMessage 区别：
 *   - toolCalls/blocks/toolCallResults 在 Rust 侧序列化为 JSON 字符串
 *   - streamTextOffset/thinkingTime 仅命名差异（serde camelCase 已对齐）
 */
interface RustSessionMessage {
  id: string;
  sender: string;
  text?: string | null;
  thinking?: string | null;
  timestamp: number;
  status?: string | null;
  streamTextOffset?: number | null;
  thinkingTime?: number | null;
  toolCallsJson?: string | null;
  blocksJson?: string | null;
  toolCallResultsJson?: string | null;
  /**
   * 消息级 usage 快照（P5 C8：v5 列 usage_json 的 IPC 投影）。
   * 线上键为 camelCase 的 `usage`，内容为 CacheUsage 形状的 JSON 字符串
   * （如 `{"promptTokens":12000,"cacheReadTokens":9000}`，与 conex-db
   * tests.rs `usage_json_column_read_write_roundtrip` fixture 同形）。
   * R6-D5 核对结论：Rust `SessionMessage` 结构体尚未实现该字段（serde
   * 未知字段静默丢弃）——前端按契约先行写入，待 Rust 侧补字段后生效。
   */
  usage?: string | null;
}

/**
 * Rust SessionAgent 形状。
 * - subagentPath 在 Rust 侧序列化为 subagent_path_json 字符串
 */
interface RustSessionAgent {
  id: string;
  subagentRunId: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string | null;
  description: string;
  mode: string;
  status: string;
  summary?: string | null;
  messages: RustSessionMessage[];
  startedAt: number;
  endedAt?: number | null;
  depth?: number | null;
  subagentPathJson?: string | null;
}

/**
 * Rust SessionIndexEntry 形状。
 * - pinnedMessageIds 在 Rust 侧为 JSON 字符串
 */
interface RustSessionIndexEntry {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string | null;
  timestamp: string;
  updatedAt: number;
  messageCount: number;
  pinnedMessageIds?: string | null;
  engineCursor?: number | null;
  engineLastRunId?: string | null;
  hydratedFromEngine?: boolean | null;
}

interface RustImportStats {
  sessions: number;
  messages: number;
  agents: number;
}

// ── 形状转换：JS → Rust ────────────────────────────────────────────────────

function messageToolCallsToJson(
  toolCalls: MessageToolCall[] | undefined
): string | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  try {
    return JSON.stringify(toolCalls);
  } catch {
    return null;
  }
}

function messageBlocksToJson(
  blocks: MessageTimelineBlock[] | undefined
): string | null {
  if (!blocks || blocks.length === 0) return null;
  try {
    return JSON.stringify(blocks);
  } catch {
    return null;
  }
}

function toolCallResultsToJson(
  results: SessionMessageToolCallResult[] | undefined
): string | null {
  if (!results || results.length === 0) return null;
  try {
    return JSON.stringify(results);
  } catch {
    return null;
  }
}

/**
 * SessionMessage.cacheMetrics → usage_json 快照（R6-D5 写入面）。
 * - 只落原始计数（read/write/miss）与 inputTotal；inputTotal 以 Included
 *   权威口径映射为 promptTokens（T-45 fixture 契约），回放时
 *   computeCacheMetricsFromUsage 可重派生命中率；
 * - hitRate/writeRate 为派生值不落库（回放可重算）；
 * - 无缓存指标（含全零）→ null（不写 usage_json，C15：0 与未上报不可混淆）。
 */
function messageUsageToJson(msg: SessionMessage): string | null {
  const m = msg.cacheMetrics?.metrics;
  if (!m) return null;
  const usage: Record<string, number> = {};
  if (m.cacheReadTokens != null) usage.cacheReadTokens = m.cacheReadTokens;
  if (m.cacheWriteTokens != null) usage.cacheWriteTokens = m.cacheWriteTokens;
  if (m.cacheMissTokens != null) usage.cacheMissTokens = m.cacheMissTokens;
  if (m.inputTotal != null) usage.promptTokens = m.inputTotal;
  if (Object.keys(usage).length === 0) return null;
  try {
    return JSON.stringify(usage);
  } catch {
    return null;
  }
}

/** JS SessionMessage → Rust SessionMessage（数组字段序列化为 JSON 字符串） */
function toRustSessionMessage(msg: SessionMessage): RustSessionMessage {
  const out: RustSessionMessage = {
    id: msg.id,
    sender: msg.sender,
    timestamp: msg.timestamp,
  };
  if (msg.text != null) out.text = msg.text;
  if (msg.thinking != null) out.thinking = msg.thinking;
  if (msg.status != null) out.status = msg.status;
  if (msg.streamTextOffset != null) out.streamTextOffset = msg.streamTextOffset;
  if (msg.thinkingTime != null) out.thinkingTime = msg.thinkingTime;
  const tc = messageToolCallsToJson(msg.toolCalls);
  if (tc != null) out.toolCallsJson = tc;
  const bl = messageBlocksToJson(msg.blocks);
  if (bl != null) out.blocksJson = bl;
  const tr = toolCallResultsToJson(msg.toolCallResults);
  if (tr != null) out.toolCallResultsJson = tr;
  const usage = messageUsageToJson(msg);
  if (usage != null) out.usage = usage;
  return out;
}

function toRustSessionAgent(agent: SessionAgent): RustSessionAgent {
  const out: RustSessionAgent = {
    id: agent.id,
    subagentRunId: agent.subagentRunId,
    parentSessionId: agent.parentSessionId,
    parentRunId: agent.parentRunId,
    description: agent.description,
    mode: agent.mode,
    status: agent.status,
    messages: (agent.messages || []).map(toRustSessionMessage),
    startedAt: agent.startedAt,
  };
  if (agent.parentToolCallId != null)
    out.parentToolCallId = agent.parentToolCallId;
  if (agent.summary != null) out.summary = agent.summary;
  if (agent.endedAt != null) out.endedAt = agent.endedAt;
  if (agent.depth != null) out.depth = agent.depth;
  if (agent.subagentPath && agent.subagentPath.length) {
    try {
      out.subagentPathJson = JSON.stringify(agent.subagentPath);
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ── 形状转换：Rust → JS ────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  return safeParseJson<T>(raw, fallback);
}

/**
 * usage_json → 消息级缓存状态（R6-D5 回放面）。
 * - 复用消息级派生纯函数 computeCacheMetricsFromUsage：从 CacheUsage 形状
 *   快照重派生命中率（C9 口径唯一真源），与 message-end 实时链同源；
 * - null / 坏 JSON / 全零 → undefined（C15：未上报 → 隐藏而非 0%）；
 * - source 标 engine-message-end：快照源头即 message-end（写入侧契约），
 *   消费面（CacheMetricsBadge）只读 metrics，source 为溯源信息。
 */
function cacheStateFromUsageJson(
  raw: string | null | undefined
): MessageCacheState | undefined {
  if (raw == null || raw === '') return undefined;
  const usage = safeParseJson<unknown>(raw, null);
  const metrics = computeCacheMetricsFromUsage({ usage });
  if (!metrics) return undefined;
  return { metrics, source: 'engine-message-end' };
}

/** Rust SessionMessage → JS SessionMessage（JSON 字符串字段还原为数组） */
function fromRustSessionMessage(
  rust: RustSessionMessage
): SessionMessage | null {
  // 复用 sessionHydration 的形状守卫，确保数据干净
  const normalized: unknown = {
    id: rust.id,
    sender: rust.sender,
    timestamp: rust.timestamp,
    ...(rust.text != null ? { text: rust.text } : {}),
    ...(rust.thinking != null ? { thinking: rust.thinking } : {}),
    ...(rust.status != null ? { status: rust.status } : {}),
    ...(rust.streamTextOffset != null
      ? { streamTextOffset: rust.streamTextOffset }
      : {}),
    ...(rust.thinkingTime != null ? { thinkingTime: rust.thinkingTime } : {}),
    ...(rust.toolCallsJson != null
      ? { toolCalls: parseJsonArray<unknown[]>(rust.toolCallsJson, []) }
      : {}),
    ...(rust.blocksJson != null
      ? { blocks: parseJsonArray<unknown[]>(rust.blocksJson, []) }
      : {}),
    ...(rust.toolCallResultsJson != null
      ? {
          toolCallResults: parseJsonArray<unknown[]>(
            rust.toolCallResultsJson,
            []
          ),
        }
      : {}),
  };
  const parsed = parseSessionMessage(normalized);
  if (!parsed) return null;
  // 徽标回放：usage_json 回读 → 派生 cacheMetrics（守卫是白名单不携带该字段，
  // 因此在守卫之后挂载；无 usage → 不写字段，渲染层隐藏）
  const cacheMetrics = cacheStateFromUsageJson(rust.usage);
  if (cacheMetrics) parsed.cacheMetrics = cacheMetrics;
  return parsed;
}

function fromRustSessionMessages(list: RustSessionMessage[]): SessionMessage[] {
  if (!Array.isArray(list)) return [];
  const out: SessionMessage[] = [];
  for (const r of list) {
    const m = fromRustSessionMessage(r);
    if (m) out.push(m);
  }
  return out;
}

/** Rust SessionAgent → JS SessionAgent */
function fromRustSessionAgent(rust: RustSessionAgent): SessionAgent | null {
  const subagentPath = rust.subagentPathJson
    ? parseJsonArray<unknown[]>(rust.subagentPathJson, [])
    : undefined;
  const normalized: unknown = {
    id: rust.id,
    subagentRunId: rust.subagentRunId,
    parentSessionId: rust.parentSessionId,
    parentRunId: rust.parentRunId,
    description: rust.description,
    mode: rust.mode,
    status: rust.status,
    messages: fromRustSessionMessages(rust.messages || []),
    startedAt: rust.startedAt,
    ...(rust.parentToolCallId != null
      ? { parentToolCallId: rust.parentToolCallId }
      : {}),
    ...(rust.summary != null ? { summary: rust.summary } : {}),
    ...(rust.endedAt != null ? { endedAt: rust.endedAt } : {}),
    ...(rust.depth != null ? { depth: rust.depth } : {}),
    ...(subagentPath && Array.isArray(subagentPath) ? { subagentPath } : {}),
  };
  return parseSessionAgent(normalized);
}

function fromRustSessionAgents(list: RustSessionAgent[]): SessionAgent[] {
  if (!Array.isArray(list)) return [];
  const out: SessionAgent[] = [];
  for (const r of list) {
    const a = fromRustSessionAgent(r);
    if (a) out.push(a);
  }
  return out;
}

/** Rust SessionIndexEntry → JS SessionIndexEntry */
function fromRustSessionIndexEntry(
  rust: RustSessionIndexEntry
): SessionIndexEntry | null {
  const pinnedIds = rust.pinnedMessageIds
    ? parseJsonArray<string[]>(rust.pinnedMessageIds, [])
    : undefined;
  const normalized: unknown = {
    id: rust.id,
    title: rust.title,
    folder: rust.folder,
    isPinned: rust.isPinned,
    isArchived: rust.isArchived,
    timestamp: rust.timestamp,
    updatedAt: rust.updatedAt,
    messageCount: rust.messageCount,
    ...(rust.branchParentId != null
      ? { branchParentId: rust.branchParentId }
      : {}),
    ...(pinnedIds && pinnedIds.length ? { pinnedMessageIds: pinnedIds } : {}),
    ...(rust.engineCursor != null ? { engineCursor: rust.engineCursor } : {}),
    ...(rust.engineLastRunId != null
      ? { engineLastRunId: rust.engineLastRunId }
      : {}),
    ...(rust.hydratedFromEngine != null
      ? { hydratedFromEngine: rust.hydratedFromEngine }
      : {}),
  };
  return parseSessionIndexEntry(normalized);
}

function fromRustSessionIndexEntries(
  list: RustSessionIndexEntry[]
): SessionIndexEntry[] {
  if (!Array.isArray(list)) return [];
  const out: SessionIndexEntry[] = [];
  for (const r of list) {
    const e = fromRustSessionIndexEntry(r);
    if (e) out.push(e);
  }
  return out;
}

// ── localStorage 同步回退路径 ──────────────────────────────────────────────
//
// 当 Tauri invoke 不可用（浏览器 / 旧壳 / 测试 missing 状态）时，所有 API 降级到
// localStorage 同步读写。这保证 dev / test 环境与渐进迁移期不阻塞。
//
// 这层回退只读 / 写 localStorage，不再触碰 IndexedDB 或磁盘镜像（已删除）。

function lsLoadSessionIndex(): SessionIndexEntry[] {
  try {
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    if (!raw) return [];
    return parseSessionIndexList(safeParseJson<unknown>(raw, null));
  } catch {
    return [];
  }
}

function lsSaveSessionIndex(entries: SessionIndexEntry[]): void {
  try {
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify(parseSessionIndexList(entries))
    );
  } catch {
    /* quota / private mode */
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

function lsLoadSessionBody(sessionId: string): SessionMessage[] {
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
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function lsSaveSessionBody(
  sessionId: string,
  messages: SessionMessage[]
): void {
  try {
    localStorage.setItem(
      SESSION_BODY_PREFIX + sessionId,
      JSON.stringify(messages)
    );
  } catch {
    /* quota */
  }
}

function lsLoadSessionAgents(sessionId: string): SessionAgent[] {
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

function lsSaveSessionAgents(sessionId: string, agents: SessionAgent[]): void {
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
    /* quota */
  }
}

function lsLoadActiveSessionId(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_ACTIVE_KEY);
    if (raw == null) return null;
    const id = raw.trim();
    return id || null;
  } catch {
    return null;
  }
}

function lsSaveActiveSessionId(id: string): void {
  try {
    if (!id?.trim() || isPendingDraft(id)) {
      localStorage.removeItem(SESSION_ACTIVE_KEY);
      return;
    }
    localStorage.setItem(SESSION_ACTIVE_KEY, String(id).trim());
  } catch {
    /* quota */
  }
}

function lsLoadFolderOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(SESSION_FOLDER_KEY);
    if (!raw) return null;
    return parseFolderOrder(safeParseJson<unknown>(raw, null));
  } catch {
    return null;
  }
}

function lsSaveFolderOrder(order: string[]): void {
  try {
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(order || []));
  } catch {
    /* quota */
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
function markDegradedSession(sessionId: string): void {
  try {
    localStorage.setItem(degradedMarkerKey(sessionId), String(Date.now()));
  } catch {
    /* quota / private mode */
  }
}

/** 会话是否存在未修复的降级戳。 */
function hasDegradedSession(sessionId: string): boolean {
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
function clearDegradedSession(sessionId: string): void {
  try {
    localStorage.removeItem(degradedMarkerKey(sessionId));
  } catch {
    /* ignore */
  }
}

// ── 14 个 async API（invoke + localStorage 回退） ──────────────────────────

/**
 * 加载会话索引列表。
 * 命令缺失 → 回退 localStorage。
 */
async function listSessions(): Promise<SessionIndexEntry[]> {
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
 * 命令缺失 → 回退 localStorage（同步）。
 * I-DRAFT：PENDING_DRAFT 哨兵永不写 body。
 *
 * @param batchVersion 批次版本戳（CAS 防线 2，裁决 R9 单调递增版本号）。
 * 落库前检查该会话已落库的最高版本，陈旧批次（版本 ≤ 已落库版本）直接
 * 丢弃不覆盖；版本随 IPC 参数传递，Rust 侧可据此实现 updated_at CAS
 * （任务书 T3.2 ③，Rust 命令面改动不在本实现轮范围）。
 */
async function saveSessionBody(
  sessionId: string,
  messages: SessionMessage[],
  batchVersion: number
): Promise<void> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return;
  const msgs = messages || [];
  const rustMessages = msgs.map(toRustSessionMessage);

  // CAS：该会话已有更高版本批次落库 → 本批次为陈旧批次，直接丢弃不覆盖
  //（任何并发窗口下旧批次晚到都不得回滚新批次）。
  const written = writtenBodyBatchVersions.get(sessionId) ?? -1;
  if (batchVersion <= written) {
    console.warn(
      `[sessionPersistence] 丢弃陈旧写批次 v${batchVersion}（会话 ${sessionId} 已落库 v${written}）`
    );
    return;
  }

  const res = await invokeResult<void>('save_session_body', {
    sessionId,
    messages: rustMessages,
    batchVersion,
  });
  if (res.status === 'ok') {
    writtenBodyBatchVersions.set(sessionId, batchVersion);
    // Stream D 主存 SQLite；非空正文额外镜像到 LS，供 seedSessions 同步路径与 MCP 观测。
    // 空数组不写 LS：避免远程懒壳把 crish_session_body_v1:* 刷成 [] 误报「丢消息」。
    if (msgs.length > 0) {
      lsSaveSessionBody(sessionId, msgs);
    }
    // P1-F1：SQLite 落库成功 = 本会话已无分叉（LS 镜像可能陈旧，如 quota 写失败），
    // 清除遗留降级戳，防止下次 hydrate 以 LS 旧正文回灌盖掉 SQLite 新数据。
    clearDegradedSession(sessionId);
    return;
  }
  // missing / error → localStorage 回退。P1-F1：降级不再静默——记日志 + 打降级戳，
  // hydrate 分叉恢复据此识别「LS 正文为最新真源」的会话并回写 SQLite。
  logInternalError('persist-degraded-ls', {
    command: 'save_session_body',
    sessionId,
    batchVersion,
    status: res.status,
  });
  lsSaveSessionBody(sessionId, msgs);
  // 空正文不标记：无内容可回灌，标记反而会让 hydrate 以空正文盖掉 SQLite 已有数据
  if (msgs.length > 0) markDegradedSession(sessionId);
}

/**
 * 加载会话下的协作子 agent。
 */
async function loadSessionAgents(sessionId: string): Promise<SessionAgent[]> {
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
async function saveSessionAgents(
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

/**
 * 清理不在 activeIds 中的会话（孤儿清理）。
 *
 * N1-2 守卫：空 keepIds 一律拒绝清理，与 Rust 侧 guard_cleanup_keep
 * 语义对齐（session_commands.rs:94-101 默认拒绝空 keepIds）。JS 回退分支
 * 此前无守卫——Rust 拒绝后错误码落入此分支，等于「守卫被绕过」，boot
 * 窗口一次 persist 即清空全部 LS 会话镜像；keep 为空时直接返回 0 不删。
 */
async function cleanupOrphanSessions(activeIds: string[]): Promise<number> {
  if (!activeIds || activeIds.length === 0) return 0;
  const res = await invokeResult<number>('cleanup_orphan_sessions', {
    activeIds: activeIds || [],
  });
  if (res.status === 'ok') return res.data || 0;
  // localStorage 回退：扫描 body/agents key，删除不在 keep 集合中的
  // （keep 非空已由上方守卫保证——空 keep 不清除任何数据）
  try {
    const keep = new Set(activeIds || []);
    let deleted = 0;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      let id: string | null = null;
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        id = k.slice(SESSION_BODY_PREFIX.length);
      } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        id = k.slice(SESSION_AGENTS_PREFIX.length);
      }
      if (id != null && !keep.has(id)) {
        localStorage.removeItem(k);
        deleted++;
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * P0-1（N0-1）修复：30 天 LS 清理前逐 key 校验 SQLite 存在性。
 *
 * 背景：sessions.db 打开失败会降级为内存库（main.rs 降级路径），降级期间
 * 全部写入落在内存库 + LS 镜像；磁盘恢复后若 30 天到期直接清空 LS，
 * 降级期数据（磁盘 SQLite 无对应）即永久丢失。本函数保证：
 *   - SQLite 持有该会话且正文/子代理非空 → 对应 LS key 可删（镜像已冗余）；
 *   - SQLite 无该会话，或 SQLite 正文/子代理为空而 LS 非空 → 保留
 *     （LS 为唯一副本，保留后可经 hydrate 回迁 SQLite）；
 *   - SQLite invoke 不可用（missing/error）→ 无法校验，一律保留（不删）。
 * 全部会话确认后才删除索引/active/folder 元数据 key；有保留则整体保留
 * （索引需继续承载保留会话供 hydrate 读取）。
 */
export interface LegacyCleanupGuardResult {
  /** 本次实际删除的 localStorage key */
  removed: string[];
  /** 因 SQLite 无对应数据而保留的会话 id */
  preserved: string[];
  /** 保留原因：sqlite-unavailable（invoke 不可用，无法校验）/ confirmed（已校验） */
  reason: 'sqlite-unavailable' | 'confirmed';
}

/** 收集 LS 侧会话 id（body / agents key + 索引条目三重来源） */
function collectLegacySessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(SESSION_BODY_PREFIX)) {
        ids.add(k.slice(SESSION_BODY_PREFIX.length));
      } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
        ids.add(k.slice(SESSION_AGENTS_PREFIX.length));
      }
    }
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    if (raw) {
      const entries = parseSessionIndexList(safeParseJson<unknown>(raw, null));
      for (const e of entries) if (e?.id) ids.add(e.id);
    }
  } catch {
    /* localStorage 不可用 → 空集合 */
  }
  return ids;
}

/** 删除一组 LS key（尽力而为；key 缺失时 removeItem 为 no-op） */
function removeLegacyKeys(keys: string[], removed: string[]): void {
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
      removed.push(k);
    } catch {
      /* quota / private mode */
    }
  }
}

/**
 * 30 天 LS 清理的安全护栏（P0-1 / N0-1 修复入口）。
 * 由 migrateFromLocalStorage.runMigrationCleanupIfNeeded 在 boot 阶段调用；
 * 返回删除/保留明细，调用方仅在 `preserved` 为空时置位清理完成标记。
 */
export async function cleanupLegacyLocalStorageSessionsGuarded(): Promise<LegacyCleanupGuardResult> {
  const removed: string[] = [];
  const preserved: string[] = [];

  // 1. 收集 LS 侧会话 id；无会话数据时仅清理元数据 key
  // （active/folder/index 已冗余于 SQLite session_meta，删除无风险）
  const lsIds = collectLegacySessionIds();
  if (lsIds.size === 0) {
    removeLegacyKeys(
      [SESSION_INDEX_KEY, SESSION_ACTIVE_KEY, SESSION_FOLDER_KEY],
      removed
    );
    return { removed, preserved, reason: 'confirmed' };
  }

  // 2. SQLite 可用性校验：invoke 不可用（missing/error）→ 无法校验，全保留
  const listRes = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
  if (listRes.status !== 'ok') {
    return { removed, preserved: [...lsIds], reason: 'sqlite-unavailable' };
  }
  const sqliteIds = new Set((listRes.data || []).map((e) => e.id));

  // 3. 逐会话校验：LS 有数据且 SQLite 无对应（缺会话 / 正文空）→ 保留
  for (const id of lsIds) {
    const lsBody = lsLoadSessionBody(id);
    const lsAgents = lsLoadSessionAgents(id);
    const hasLsData = lsBody.length > 0 || lsAgents.length > 0;
    if (!hasLsData) {
      // LS 镜像为空：删除无风险（key 缺失时 removeItem 为 no-op）
      removeLegacyKeys([SESSION_BODY_PREFIX + id, SESSION_AGENTS_PREFIX + id], removed);
      continue;
    }
    if (!sqliteIds.has(id)) {
      // 降级窗口期唯一副本：SQLite 无该会话 → 保留，待 hydrate 回迁
      preserved.push(id);
      continue;
    }
    const [bodyRes, agentsRes] = await Promise.all([
      invokeResult<RustSessionMessage[]>('load_session_body', { sessionId: id }),
      invokeResult<RustSessionAgent[]>('load_session_agents', { sessionId: id }),
    ]);
    // invoke 异常按「未校验」处理 → 保留（无法确认则不删）
    const sqliteBodyOk = bodyRes.status === 'ok' && (bodyRes.data || []).length > 0;
    const sqliteAgentsOk = agentsRes.status === 'ok' && (agentsRes.data || []).length > 0;
    const bodyRisk = lsBody.length > 0 && !sqliteBodyOk;
    const agentsRisk = lsAgents.length > 0 && !sqliteAgentsOk;
    if (bodyRisk || agentsRisk) {
      preserved.push(id);
      continue;
    }
    // 4. SQLite 确认持有数据 → 删除该会话的 LS 镜像 key
    removeLegacyKeys([SESSION_BODY_PREFIX + id, SESSION_AGENTS_PREFIX + id], removed);
  }

  // 5. 元数据 key：全部会话确认后才删；有保留则整体保留（索引承载保留会话）
  if (preserved.length === 0) {
    removeLegacyKeys([SESSION_INDEX_KEY, SESSION_ACTIVE_KEY, SESSION_FOLDER_KEY], removed);
  }

  return { removed, preserved, reason: 'confirmed' };
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

// ── 复合 API：hydrateSessionsFromRust ──────────────────────────────────────

/**
 * P1-F1 hydrate 分叉恢复（F5-01 单向修复路径）。
 *
 * 会话带降级戳（期间 invoke 失败 → LS 正文为最新、SQLite 为旧快照）时：
 *   ① 以 LS 正文为真源（跳过 SQLite 读取）；
 *   ② 回写 SQLite（save_session_body，载荷 = LS 正文，取新批次戳）——回写失败
 *      （invoke 仍未恢复）→ 保持降级戳待下次 hydrate 重试，不丢数据；本次
 *      hydrate 仍展示 LS 最新正文；
 *   ③ 回写成功（或 LS 正文为空、无回灌价值）→ 清戳，后续 hydrate 恢复
 *      SQLite 优先（37/37 基线契约不回归）。
 *
 * 回写直接走 invokeResult 而非 saveSessionBody：修复失败时不能走其降级分支
 * 的「打戳 → 本函数清戳」抵消序列（AU-03:127：清戳时机 = 回写成功后）。
 * 批次戳取模块级新版本号，保证不被 CAS（writtenBodyBatchVersions）误判陈旧。
 */
async function loadSessionBodyWithDegradedRecovery(
  sessionId: string
): Promise<SessionMessage[]> {
  if (!hasDegradedSession(sessionId)) return loadSessionBody(sessionId);

  const lsMessages = lsLoadSessionBody(sessionId);
  if (lsMessages.length === 0) {
    // LS 正文为空：无最新证据可回灌，清戳后按 SQLite 现状加载，
    // 避免空正文经回灌盖掉 SQLite 已有数据
    clearDegradedSession(sessionId);
    return loadSessionBody(sessionId);
  }

  logInternalError('hydrate-degraded-repair', {
    sessionId,
    messageCount: lsMessages.length,
  });
  const version = ++batchVersionCounter;
  const res = await invokeResult<void>('save_session_body', {
    sessionId,
    messages: lsMessages.map(toRustSessionMessage),
    batchVersion: version,
  });
  if (res.status === 'ok') {
    writtenBodyBatchVersions.set(sessionId, version);
    clearDegradedSession(sessionId);
  } else {
    // 回写失败：保持降级戳（下次 hydrate 重试单向修复），日志暴露修复未完成
    logInternalError('hydrate-degraded-repair-failed', {
      sessionId,
      status: res.status,
    });
  }
  return lsMessages;
}

/**
 * 从存储层加载全部会话（index + bodies + agents），构造 SessionState[]。
 *
 * 索引加载策略（Stream D 过渡期）：
 *   1. 优先读 localStorage 索引（侧栏元数据真相源，由 persistAllSessionsRust 维护）
 *   2. localStorage 为空时回退到 SQLite list_sessions（30 天清理后或新装机场景）
 *   3. 两者都为空 → 返回空会话列表
 *
 * bodies / agents 加载策略：
 *   - 优先 SQLite（load_session_body / load_session_agents）
 *   - invoke 缺失时回退 localStorage
 *
 * 注意：此 API 在 boot 时调用一次。为兼容现有 store 初始化（同步 seedSessions），
 * seedSessions 仍调用同步回退路径；此 async 版本供 store-persistence 使用。
 */
export async function hydrateSessionsFromRust(): Promise<{
  sessions: SessionState[];
  activeSessionId: string | null;
  folderOrder: string[] | null;
}> {
  // 1. 索引：localStorage 优先（真相源），回退 SQLite
  let index = lsLoadSessionIndex();
  if (!index.length) {
    index = await listSessions();
  }
  if (!index.length) {
    return {
      sessions: [],
      activeSessionId: await getSessionMeta('active_session_id'),
      folderOrder: parseFolderOrder(
        safeParseJson<unknown>(await getSessionMeta('folder_order'), null)
      ),
    };
  }

  // I-DRAFT：索引层再滤哨兵；parseSessionIndexEntry 已拒，双保险
  const ordered = [...index]
    .filter((e) => e.id && !isPendingDraft(e.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // 并行加载每个会话的 body 与 agents
  const sessions: SessionState[] = await Promise.all(
    ordered.map(async (e) => {
      const [messages, agents] = await Promise.all([
        loadSessionBodyWithDegradedRecovery(e.id),
        loadSessionAgents(e.id),
      ]);
      const sanitized = sanitizeMessagesForHydrate(messages);
      const state: SessionState = {
        id: e.id,
        title: e.title,
        folder: e.folder,
        isPinned: e.isPinned,
        isArchived: e.isArchived,
        timestamp: coerceSessionTimestamp(e.id, e.timestamp, sanitized),
        messages: sanitized,
        agents,
        ...(e.branchParentId !== undefined
          ? { branchParentId: e.branchParentId }
          : {}),
        ...(e.pinnedMessageIds?.length
          ? { pinnedMessageIds: e.pinnedMessageIds }
          : {}),
        ...(e.engineCursor !== undefined
          ? { engineCursor: e.engineCursor }
          : {}),
        ...(e.engineLastRunId !== undefined
          ? { engineLastRunId: e.engineLastRunId }
          : {}),
        ...(e.hydratedFromEngine !== undefined
          ? { hydratedFromEngine: e.hydratedFromEngine }
          : {}),
        // importMeta 仅存 localStorage 索引；SQLite 行无此列，从 LS 索引水合时带回
        ...(e.importMeta ? { importMeta: e.importMeta } : {}),
      };
      return state;
    })
  );

  const activeRaw = await getSessionMeta('active_session_id');
  const active = activeRaw && !isPendingDraft(activeRaw) ? activeRaw : null;
  // prepareSessionsForUi：加载后 prune 非 keep 空壳
  const prepared = prepareSessionsForUi(sessions, active);
  const activeSessionId =
    active && prepared.some((s) => s.id === active) ? active : null;
  const folderOrderRaw = await getSessionMeta('folder_order');
  const folderOrder = parseFolderOrder(
    safeParseJson<unknown>(folderOrderRaw, null)
  );

  return { sessions: prepared, activeSessionId, folderOrder };
}

// ── 写竞态防线（PS-03 T3.2 D6）：模块级串行队列 + 批次版本戳 CAS ────────────

/**
 * 模块级写串行队列（主防线）。
 *
 * 问题背景（R2 §5 / F5-02）：persist 批次间无队列、无版本戳；store 层 350ms
 * debounce（store-persistence.ts:136-145）只保证「调度串行」，不保证「IPC
 * 飞行期互斥」——store 高频变更时两个 persist 周期可并发飞行，旧批次晚完成
 * 整体覆盖新批次（sessionRustDbWriteModel.test.ts 曾把回滚固化为契约，
 * T3.2 已翻转）。本队列把每个 persist 批次整体串入 promise 链：
 *
 * - 新批次执行前先 await 上一轮 promise → 同一时刻至多一个批次在飞行期，
 *   同会话写任务严格按发起顺序落库（后发批次最后写，最终 = 最新快照）；
 * - 单轮失败吞掉，不影响链上后续批次（对齐 persistAllSessionsRust 既有
 *   「内部 allSettled、不对外抛错」语义）；
 * - 队列语义 = 每会话保留最新快照：过期批次被后续批次覆盖，不产生回滚。
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 批次版本计数器（CAS 防线 2）。
 *
 * 裁决 R9：CAS 哨兵用单调递增版本号（替代任务书原方案的 batchAt 时间戳——
 * ms 粒度在快速连续 commit 下可能相同，无法区分新旧）。每个 persist 调用
 * 在发起时领取递增版本号（发起序 = 版本序，后发起 = 高版本），版本随
 * save_session_body 调用路径传递到 IPC 边界，供 Rust 侧未来 updated_at
 * CAS 消费（任务书 T3.2 ③；Rust 命令面改动不在本实现轮范围）。
 */
let batchVersionCounter = 0;

/**
 * 各会话已落库正文的最高批次版本（CAS 比较基准）。
 * 串行队列下单上下文内写序已确定，本表是第二道防线：任何路径下旧版本
 * 批次在落库前被识别并直接丢弃（不覆盖已落库的新版本）。
 */
const writtenBodyBatchVersions = new Map<string, number>();

/**
 * 把持久化任务串入模块级写队列。
 * 返回任务自身 promise（调用方可 await 感知完成）；链尾由 writeChain 承接，
 * 单轮失败由 catch 吞掉，保证链永不因单轮异常而断裂。
 */
function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const run = writeChain
    .then(() => task())
    .catch(() => {
      /* 单轮失败吞掉：不影响链上后续批次 */
    });
  writeChain = run;
  return run;
}

/**
 * P1-D2（T3.6）persist 熔断判定：引擎懒水合「未完整」的会话禁止回写正文。
 *
 * 根因（R2 §6）：hydrate 单页截断 → hydratedFromEngine=true 封死重试 → 350ms
 * debounce → save_session_body 先删后插 → 截断正文不可逆覆盖 SQLite。
 * 修复后 hydrate 已分页拉全；但引擎异常（超页数上限/游标停滞）仍可能产生
 * 截断态，store 以 hydrateTruncated 标记刻画，此处为兜底防线：任何 persist
 * 周期（主路径 / LS 降级镜像 / beforeunload 同步）对未完整会话一律跳过
 * 正文回写——截断态永不固化；分页拉全后标记清除，熔断自然解除。
 */
function isHydrateTruncated(s: {
  hydratedFromEngine?: boolean;
  hydrateTruncated?: boolean;
}): boolean {
  return s.hydratedFromEngine === true && s.hydrateTruncated === true;
}

// ── 复合 API：persistAllSessionsRust ────────────────────────────────────────

/**
 * 全量持久化所有会话到 SQLite（per-session invoke，避免单次 IPC 携带所有数据）。
 *
 * 设计要点：
 *   - 每个会话单独 save_session_body / save_session_agents（细粒度并发）
 *   - activeSessionId / folderOrder 写入 session_meta 表
 *   - 孤儿清理走 cleanup_orphan_sessions
 *   - assistant 消息统一走 normalizeAssistantTimeline（与原 persistAllSessions 对齐）
 *   - 写竞态防线（PS-03 T3.2 D6）：批次发起时领取单调递增版本号（R9），
 *     整批任务（probe + 全部写 IPC）串入模块级写队列 writeChain——同会话写
 *     任务按发起序落库，后发批次最终落库；saveSessionBody 落库前做版本
 *     CAS，陈旧批次直接丢弃不覆盖。350ms debounce / boot 回灌 / 手动触发
 *     全部经本入口，版本戳覆盖全部 save_session_body 调用路径。
 *
 * 命令缺失时回退到 localStorage 同步路径（persistAllSessionsSync 等价行为）。
 */
export async function persistAllSessionsRust(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
  options?: {
    /** 把 SessionState[] 投影为索引条目（侧栏元数据真相源） */
    sessionsToIndex?: (sessions: SessionState[]) => SessionIndexEntry[];
  }
): Promise<void> {
  // 批次版本戳：发起时领取（发起序 = 版本序，后发起 = 高版本，R9）。
  // 整批任务串入模块级写队列，与上一批不并发飞行。
  const batchVersion = ++batchVersionCounter;
  await enqueuePersist(async () => {
    // I-DRAFT：persist 路径剔除 PENDING_DRAFT，永不写 sessions[]/body
    const list = (sessions || []).filter(
      (s) => Boolean(s?.id) && !isPendingDraft(s.id)
    );
    const activePersistable =
      activeSessionId && !isPendingDraft(activeSessionId)
        ? activeSessionId
        : '';

    // 索引层：始终写一份到 localStorage（侧栏元数据真相源，过渡期设计）。
    // invoke 缺失时，这就是唯一的索引落盘点。
    if (options?.sessionsToIndex) {
      try {
        const entries = options.sessionsToIndex(list);
        lsSaveSessionIndex(entries);
      } catch {
        /* ignore */
      }
    }

    // 检测 invoke 可用性（用 list_sessions 作为探针）
    const probe = await invokeResult<RustSessionIndexEntry[]>('list_sessions');
    if (probe.status !== 'ok') {
      // 回退：localStorage 同步路径（索引已写入，只需写 body/agents/meta）。
      // P1-F1：整批降级必须可观测；fallback 写入的 LS 正文是 SQLite 缺失的
      // 最新快照（启动竞态期 invoke 未就绪即触发），由 fallback 打戳供 hydrate 回灌。
      logInternalError('persist-degraded-ls', {
        command: 'list_sessions(probe)',
        status: probe.status,
      });
      persistAllSessionsLocalFallback(list, activePersistable, folderOrder);
      return;
    }

    // 1. 写入每个会话的 body + agents（并发）
    // 空 messages 不调用 save_session_body：Rust 侧是先删后插，空数组会擦掉已落盘正文。
    // boot 窗口里 seed 的远程懒壳 messages=[] 很常见；等 SQLite 回灌 / 引擎 hydrate 后再写。
    const keepIds = new Set<string>();
    const bodyJobs: Promise<void>[] = [];
    for (const s of list) {
      if (!s?.id) continue;
      keepIds.add(s.id);
      const msgs = (s.messages || []).map((m) =>
        m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
      );
      if (msgs.length > 0 && !isHydrateTruncated(s)) {
        bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));
      }
      bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
    }
    await Promise.allSettled(bodyJobs);

    // 2. 元数据：active_session_id / folder_order
    const metaJobs: Promise<void>[] = [];
    if (activePersistable) {
      metaJobs.push(setSessionMeta('active_session_id', activePersistable));
    }
    if (folderOrder && folderOrder.length) {
      metaJobs.push(
        setSessionMeta('folder_order', JSON.stringify(folderOrder))
      );
    }
    await Promise.allSettled(metaJobs);

    // 3. 孤儿清理
    // P0-2 防护：空会话列表（boot 窗口 hydrate 未完成 / 全删场景）跳过清理——
    // Rust 壳层对空 keepIds 默认拒绝（guard_cleanup_keep），此处直接不发起，
    // 避免错误码触发 JS 回退分支清空 LS 镜像（N1-2 双保险）；
    // 部分 keepIds 的 boot 窗口风险由 Rust 库层护栏兜底（引擎子代理会话豁免
    // + 活动 run 豁免 + 宽限期，见 conex-db sessions.rs cleanup_orphan_sessions）。
    if (keepIds.size > 0) {
      await cleanupOrphanSessions(Array.from(keepIds));
    }
  });
}

/**
 * localStorage 同步回退：仅在 invoke 不可用时使用。
 * 索引已由调用方（persistAllSessionsRust）写入 localStorage，此处仅写 body/agents/meta。
 */
function persistAllSessionsLocalFallback(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[]
): void {
  // 调用方已 filter；再拒一次 draft
  const list = (sessions || []).filter(
    (s) => Boolean(s?.id) && !isPendingDraft(s.id)
  );
  const keep = new Set(list.map((s) => s.id).filter(Boolean) as string[]);

  // 写入 keep 集合中的 body / agents（空 body 不覆盖，防懒壳擦掉已有 LS 正文）
  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    if (msgs.length > 0 && !isHydrateTruncated(s)) {
      lsSaveSessionBody(s.id, msgs);
      // P1-F1：本次降级落 LS 的正文是 SQLite 缺失的最新快照，打戳供 hydrate
      // 单向修复（以 LS 为真源回灌回写 SQLite）
      markDegradedSession(s.id);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

  // 清理孤儿（N1-2 守卫：空 keep 不清除——与 Rust guard_cleanup_keep
  // 语义对齐，boot 窗口 / 全删场景不得清空 LS 镜像）
  if (keep.size > 0) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        let id: string | null = null;
        if (k.startsWith(SESSION_BODY_PREFIX))
          id = k.slice(SESSION_BODY_PREFIX.length);
        else if (k.startsWith(SESSION_AGENTS_PREFIX))
          id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (id != null && !keep.has(id)) localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  }

  lsSaveActiveSessionId(activeSessionId || '');
  lsSaveFolderOrder(folderOrder || []);
}

// ── 同步辅助：供 beforeunload flush 使用 ───────────────────────────────────

/**
 * 同步持久化全部会话（beforeunload 场景，禁止 await）。
 *
 * 此函数始终走 localStorage（同步），因为 beforeunload 事件中无法 await IPC。
 * Rust 侧数据由后续 persistAllSessionsRust 在正常生命周期内同步。
 * 注（PS-03 T3.2）：本路径不调用 save_session_body（无 IPC），故无需批次
 * 版本戳；SQLite 侧由后续异步 persist 带版本写入（版本戳覆盖全部
 * save_session_body 调用路径：350ms debounce / boot 回灌 / 手动触发）。
 */
export function persistAllSessionsSyncViaLocalStorage(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[],
  options?: {
    sessionsToIndex?: (sessions: SessionState[]) => SessionIndexEntry[];
  }
): void {
  // I-DRAFT：sync flush 同样剔除 PENDING_DRAFT
  const list = (sessions || []).filter(
    (s) => Boolean(s?.id) && !isPendingDraft(s.id)
  );
  const keep = new Set(list.map((s) => s.id).filter(Boolean) as string[]);
  const activePersistable =
    activeSessionId && !isPendingDraft(activeSessionId) ? activeSessionId : '';

  if (options?.sessionsToIndex) {
    try {
      lsSaveSessionIndex(options.sessionsToIndex(list));
    } catch {
      /* ignore */
    }
  }

  for (const s of list) {
    if (!s?.id) continue;
    const msgs = (s.messages || []).map((m) =>
      m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
    );
    // beforeunload 同步路径：仅镜像非空正文，避免把未 hydrate 懒壳写成 [];
    // P1-D2 熔断：未完整（截断）会话同样跳过，防截断态固化 LS 镜像
    if (msgs.length > 0 && !isHydrateTruncated(s)) {
      lsSaveSessionBody(s.id, msgs);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

  // 清理孤儿（N1-2 守卫：空 keep 不清除——beforeunload 同步路径同样
  // 对齐 Rust guard_cleanup_keep 语义，boot 窗口不得清空 LS 镜像）
  if (keep.size > 0) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      for (const k of keys) {
        let id: string | null = null;
        if (k.startsWith(SESSION_BODY_PREFIX))
          id = k.slice(SESSION_BODY_PREFIX.length);
        else if (k.startsWith(SESSION_AGENTS_PREFIX))
          id = k.slice(SESSION_AGENTS_PREFIX.length);
        if (id != null && !keep.has(id)) localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  }

  lsSaveActiveSessionId(activePersistable);
  lsSaveFolderOrder(folderOrder || []);
}
