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
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import { invokeResult } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { hasQuotaTruncation } from './sessionLocalStorage';

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
      return;
    }
    localStorage.setItem(
      SESSION_AGENTS_PREFIX + sessionId,
      JSON.stringify(agents.slice(0, SESSION_AGENTS_SAVE_CAP))
    );
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
  // 数据面暴露走 sessionLocalStorage.hasQuotaTruncation）。标志存在意味着某次
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
    return;
  }
  // missing / error → localStorage 回退
  lsSaveSessionBody(sessionId, msgs);
}

/**
 * 加载会话下的协作子 agent。
 */
async function loadSessionAgents(sessionId: string): Promise<SessionAgent[]> {
  if (!sessionId?.trim() || isPendingDraft(sessionId)) return [];
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
    lsSaveSessionAgents(sessionId, []);
    return;
  }
  const rustAgents = agents
    .slice(0, SESSION_AGENTS_SAVE_CAP)
    .map(toRustSessionAgent);
  const res = await invokeResult<void>('save_session_agents', {
    sessionId,
    agents: rustAgents,
  });
  if (res.status === 'ok') return;
  lsSaveSessionAgents(sessionId, agents);
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
  // localStorage 回退
  if (key === 'active_session_id') lsSaveActiveSessionId(value);
  if (key === 'folder_order') {
    const order = parseFolderOrder(safeParseJson<unknown>(value, null));
    if (order) lsSaveFolderOrder(order);
  }
}

/**
 * 清理不在 activeIds 中的会话（孤儿清理）。
 */
async function cleanupOrphanSessions(activeIds: string[]): Promise<number> {
  const res = await invokeResult<number>('cleanup_orphan_sessions', {
    activeIds: activeIds || [],
  });
  if (res.status === 'ok') return res.data || 0;
  // localStorage 回退：扫描 body/agents key，删除不在 keep 集合中的
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
        loadSessionBody(e.id),
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
      // 回退：localStorage 同步路径（索引已写入，只需写 body/agents/meta）
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
      if (msgs.length > 0) {
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
    await cleanupOrphanSessions(Array.from(keepIds));
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
    if (msgs.length > 0) {
      lsSaveSessionBody(s.id, msgs);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

  // 清理孤儿
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
    // beforeunload 同步路径：仅镜像非空正文，避免把未 hydrate 懒壳写成 []
    if (msgs.length > 0) {
      lsSaveSessionBody(s.id, msgs);
    }
    lsSaveSessionAgents(s.id, s.agents || []);
  }

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

  lsSaveActiveSessionId(activePersistable);
  lsSaveFolderOrder(folderOrder || []);
}
