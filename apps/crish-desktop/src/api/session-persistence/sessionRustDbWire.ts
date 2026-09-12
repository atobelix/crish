/**
 * sessionRustDb 子模块 · Wire：JS ↔ Rust 数据形状转换层
 *
 * 职责（纯函数，无 IO）：
 *   - Rust 侧 serde camelCase 投影类型（conex-types::SessionMessage 等）
 *   - JS SessionMessage/SessionAgent/SessionIndexEntry → Rust 形状
 *     （toolCalls/blocks/toolCallResults/subagentPath 数组 → JSON 字符串）
 *   - Rust → JS 反向还原（JSON 字符串 → 数组，复用 sessionHydration 白名单守卫）
 *   - usage_json ↔ cacheMetrics 快照编解码（R6-D5，computeCacheMetricsFromUsage 唯一真源）
 */

import type { SessionAgent, SessionMessage } from '../../store/layoutStore';
import type {
  MessageTimelineBlock,
  MessageToolCall,
  SessionMessageToolCallResult,
} from '../../store/types';
import type { MessageCacheState } from '@crish/shared-types';
import { computeCacheMetricsFromUsage } from '../chat-bridge/handlers/cacheMetricsCompute';
import {
  parseSessionAgent,
  parseSessionIndexEntry,
  parseSessionMessage,
  safeParseJson,
} from './sessionHydration';
import { normalizeAssistantTimeline } from '../toolPresentation';
import type { SessionIndexEntry } from './sessionPersistenceTypes';

// ── Rust 侧类型（serde camelCase 反序列化产物） ─────────────────────────────

/**
 * Rust SessionMessage 形状（conex-types::SessionMessage 的 JS 投影）。
 * 与 store/types.ts 的 SessionMessage 区别：
 *   - toolCalls/blocks/toolCallResults 在 Rust 侧序列化为 JSON 字符串
 *   - streamTextOffset/thinkingTime 仅命名差异（serde camelCase 已对齐）
 */
export interface RustSessionMessage {
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
export interface RustSessionAgent {
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
export interface RustSessionIndexEntry {
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

export interface RustImportStats {
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
export function toRustSessionMessage(msg: SessionMessage): RustSessionMessage {
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

export function toRustSessionAgent(agent: SessionAgent): RustSessionAgent {
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
      /* swallow-ok: 子代理路径序列化失败时字段留空，不阻塞形状转换 */
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
  // 历史兼容：thinking + thinkingTime（秒）→ thought-legacy 块，避免仅
  // blocksJson 时 durationMs 在 normalize 链丢失（cacheReplay 回读契约）。
  if (
    parsed.sender === 'assistant' &&
    typeof parsed.thinking === 'string' &&
    parsed.thinking.trim() &&
    !(parsed.blocks || []).some((b) => b.type === 'thought')
  ) {
    const thinkingTimeSec =
      typeof rust.thinkingTime === 'number' && Number.isFinite(rust.thinkingTime)
        ? rust.thinkingTime
        : undefined;
    parsed.blocks = [
      {
        id: 'thought-legacy',
        type: 'thought',
        content: parsed.thinking,
        turnIndex: 0,
        ...(thinkingTimeSec != null
          ? { durationMs: Math.round(thinkingTimeSec * 1000) }
          : {}),
      },
      ...(parsed.blocks || []),
    ];
  }
  // 徽标回放：usage_json 回读 → 派生 cacheMetrics（守卫是白名单不携带该字段，
  // 因此在守卫之后挂载；无 usage → 不写字段，渲染层隐藏）
  const cacheMetrics = cacheStateFromUsageJson(rust.usage);
  if (cacheMetrics) parsed.cacheMetrics = cacheMetrics;
  return parsed;
}

export function fromRustSessionMessages(
  list: RustSessionMessage[]
): SessionMessage[] {
  if (!Array.isArray(list)) return [];
  const out: SessionMessage[] = [];
  for (const r of list) {
    const m = fromRustSessionMessage(r);
    if (m) {
      out.push(m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m);
    }
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

export function fromRustSessionAgents(
  list: RustSessionAgent[]
): SessionAgent[] {
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

export function fromRustSessionIndexEntries(
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
