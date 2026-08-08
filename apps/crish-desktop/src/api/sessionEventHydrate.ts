/**
 * 从引擎 read-session-events 投影本地对话消息。
 *
 * H2：打开空远程会话时补全文案 / 工具调用。
 * H3：可在此基础上挂 lastSequence 增量同步与 run snapshot usage。
 */

import { pickStableMessageId } from '@crish/shared-types';
import type { SessionMessage } from '../store/layoutStore';
import { mergeSessionMessageFields } from './store-access/helperAccess';
import { getTransport } from './transport';
import { normalizeAssistantTimeline } from './toolPresentation';
import { logInternalError } from './userFacingErrors';
import { toolCallFieldsFromEvent } from './chat-bridge/handlers/toolUtils';

export type SessionHydrateResult = {
  ok: boolean;
  messages: SessionMessage[];
  /** 引擎事件游标，供 H3 增量拉取 */
  nextAfterSequence: number;
  hasMore: boolean;
  error?: string;
  /**
   * 水合「未完整」截断标记（P1-D2）：分页拉全超过页数上限或游标停滞
   * （引擎异常 hasMore 恒真）时置位。消费方（store）据此刻画 SessionState
   * hydrateTruncated，persist 熔断禁止截断态正文回写 SQLite（不可逆）。
   */
  truncated?: boolean;
  /** 最近一次 runId（若可解析），供 H3 拉 usage */
  lastRunId?: string;
};

type AnyRec = Record<string, unknown>;

function asRec(v: unknown): AnyRec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : null;
}

function agentEventFromOrchestrator(ev: AnyRec): AnyRec | null {
  if (ev.type === 'runtime-event') {
    const payload = asRec(ev.payload) || asRec(ev);
    const nested = asRec(payload?.event) || asRec(ev.event);
    return nested;
  }
  // 顶层摊平：放行 message* 与 tool* 事件（live 桥与 daemon 回放同协议形态；
  // 只放行 message* 会导致会话恢复丢工具卡 —— tool-start/tool-end 被当 run 级事件跳过）
  if (typeof ev.type === 'string' && ev.type) {
    const t = String(ev.type);
    if (t.startsWith('message') || t.startsWith('tool')) return ev;
  }
  return null;
}

function blockText(block: unknown): string {
  const b = asRec(block);
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

function toolResult(result: unknown): {
  id: string;
  text: string;
  isError: boolean;
} {
  const r = asRec(result) || {};
  const id = String(r.toolCallId ?? r.id ?? '');
  const isError = Boolean(r.isError ?? r.error);
  let text = '';
  if (typeof r.output === 'string') text = r.output;
  else if (r.output && typeof r.output === 'object') {
    const o = r.output as AnyRec;
    text = typeof o.text === 'string' ? o.text : JSON.stringify(o);
  } else if (typeof r.text === 'string') text = r.text;
  else if (r.error) text = String(r.error);
  return { id, text, isError };
}

/**
 * 从引擎 message 载荷解析稳定 id（clientMessageId / messageId / id）。
 * 字段优先级与 shared-types pickStableMessageId 对齐。
 * 无稳定 id 时回退到确定性 hyd 前缀 + 序号（同事件流重放 id 不变）。
 */
function resolveProjectedMessageId(
  msg: AnyRec | null,
  role: 'user' | 'assistant',
  msgSeq: number
): string {
  const stable = pickStableMessageId(msg);
  if (stable) return stable;
  return role === 'user' ? `hyd-user-${msgSeq}` : `hyd-asst-${msgSeq}`;
}

/**
 * message-end 带来稳定 client id 时，把 delta 阶段的 hyd-* 助手 id 重键到稳定 id，
 * 便于与本地 stream final 同 id merge（不双气泡）。
 */
function rekeyAssistantIfStable(
  messages: SessionMessage[],
  assistant: SessionMessage,
  stableId: string
): void {
  if (!stableId || stableId.startsWith('hyd-') || assistant.id === stableId) {
    return;
  }
  // 仅当当前是 hyd 临时 id 且目标 id 未被占用时重键
  if (!assistant.id.startsWith('hyd-')) return;
  if (messages.some((m) => m !== assistant && m.id === stableId)) return;
  assistant.id = stableId;
}

/**
 * 按 id 合并消息列表：同 id 原地 merge，否则 append。
 * 用于 hydrate 与本地乐观消息合并 / 重放去重（重放 length 不增）。
 * existing 为空时也对 incoming 自身按 id 折叠（对抗重复事件数组）。
 */
export function mergeMessagesById(
  existing: SessionMessage[],
  incoming: SessionMessage[]
): SessionMessage[] {
  if (!incoming.length) return existing.slice();

  const out: SessionMessage[] = existing.map((m) => ({ ...m }));
  const indexById = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const id = out[i]?.id;
    if (id) indexById.set(id, i);
  }

  for (const msg of incoming) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) {
      out.push(msg);
      continue;
    }
    const idx = indexById.get(id);
    if (idx === undefined) {
      indexById.set(id, out.length);
      // 浅拷贝，避免调用方改写 incoming 元素污染 out
      out.push({ ...msg });
    } else {
      const target = { ...out[idx]! };
      mergeSessionMessageFields(target, msg);
      out[idx] = target;
    }
  }
  return out;
}

/**
 * 将 orchestrator session-events 投影为 Chat 消息列表。
 * 只保证文本 + 工具主路径；复杂分支可后续增强。
 */
export function projectEventsToMessages(events: unknown[]): {
  messages: SessionMessage[];
  lastRunId?: string;
  maxSequence: number;
} {
  const messages: SessionMessage[] = [];
  let currentAssistant: SessionMessage | null = null;
  let lastRunId: string | undefined;
  let maxSequence = 0;
  let msgSeq = 0;
  /**
   * 每消息的 turn 分段账本（G4 / 04 §5.2-5）：messageId → 已固化轮次与该轮
   * 终态文本。同 turn message-end 幂等覆盖（终态权威），跨 turn 追加新段——
   * 消灭 M2「多轮 run reload 后只剩末轮文本」；旧载荷（无 turnIndex）按 0。
   */
  const turnTextByMessage = new Map<
    string,
    { turnIndex: number; text: string }
  >();

  const pushUser = (text: string, ts: number, stableId?: string) => {
    currentAssistant = null;
    const id = stableId || `hyd-user-${++msgSeq}`;
    // 同 id 已存在则 update（事件流内幂等）
    const existing = messages.find((m) => m.id === id);
    if (existing) {
      existing.text = text;
      existing.timestamp = ts;
      existing.status = 'completed';
      return;
    }
    messages.push({
      id,
      sender: 'user',
      text,
      timestamp: ts,
      status: 'completed',
    });
  };

  const ensureAssistant = (ts: number, stableId?: string) => {
    if (!currentAssistant) {
      const id = stableId || `hyd-asst-${++msgSeq}`;
      const existing = messages.find(
        (m) => m.id === id && m.sender === 'assistant'
      );
      if (existing) {
        currentAssistant = existing;
        return currentAssistant;
      }
      currentAssistant = {
        id,
        sender: 'assistant',
        text: '',
        timestamp: ts,
        status: 'completed',
        toolCalls: [],
        blocks: [],
      };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const raw of events) {
    const ev = asRec(raw);
    if (!ev) continue;
    if (typeof ev.sequence === 'number')
      maxSequence = Math.max(maxSequence, ev.sequence);
    if (typeof ev.runId === 'string') lastRunId = ev.runId;
    const payload = asRec(ev.payload);
    if (payload && typeof payload.runId === 'string')
      lastRunId = payload.runId as string;

    const agent = agentEventFromOrchestrator(ev);
    if (!agent) {
      // run 级事件：仅跟踪 runId
      continue;
    }

    const type = String(agent.type ?? '');
    const ts =
      typeof agent.timestamp === 'string'
        ? Date.parse(agent.timestamp) || Date.now()
        : typeof agent.timestamp === 'number'
          ? agent.timestamp
          : Date.now();

    if (type === 'message-end' && agent.message) {
      const msg = asRec(agent.message);
      if (!msg) continue;
      const role = String(msg.role ?? '');
      let text = '';
      let thought = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.blocks)) {
        for (const bl of msg.blocks) {
          const b = asRec(bl);
          if (!b) continue;
          if (b.type === 'thought' || b.kind === 'thought')
            thought += blockText(b);
          else if (b.type === 'text') text += blockText(b);
        }
      }
      text = text.trim();
      thought = thought.trim();
      if (role === 'user') {
        if (text) {
          // 优先用引擎/客户端稳定 id，便于与本地乐观消息 upsert 合并
          const id = resolveProjectedMessageId(msg, 'user', msgSeq + 1);
          if (id.startsWith('hyd-')) msgSeq += 1;
          pushUser(text, ts, id);
        }
      } else if (role === 'assistant') {
        const id = resolveProjectedMessageId(msg, 'assistant', msgSeq + 1);
        if (!currentAssistant && id.startsWith('hyd-')) msgSeq += 1;
        const a = ensureAssistant(ts, id);
        rekeyAssistantIfStable(messages, a, id);
        // message-end 为终态；后续 partial 不得经 merge 回退
        a.status = 'completed';
        if (thought) a.thinking = thought;
        if (text) {
          // G4 / 04 §5.2-5：按 turnIndex 分段——同 turn 幂等覆盖（终态权威，
          // 亦覆盖 delta 累积碎片），跨 turn 追加新段（reload 后多轮文本
          // 完整）；旧载荷（无 turnIndex）按 0 处理，单段路径与旧行为一致
          const turnIndex =
            typeof agent.turnIndex === 'number' ? agent.turnIndex : 0;
          const st = turnTextByMessage.get(a.id) ?? { turnIndex: -1, text: '' };
          if (turnIndex === st.turnIndex) {
            st.text = text;
            a.text = text;
          } else {
            st.turnIndex = turnIndex;
            st.text = st.text ? `${st.text}\n\n${text}` : text;
            a.text = st.text;
          }
          turnTextByMessage.set(a.id, st);
          // 合并正文，绝不抹掉已有 tool_call 块
          if (!a.blocks) a.blocks = [];
          const hasTools = a.blocks.some((b) => b.type === 'tool_call');
          if (!hasTools) {
            a.blocks = [{ type: 'text', content: text }];
          } else {
            // 保留 tool 块；把全文挂到末尾 text 段（或新建）
            const last = a.blocks[a.blocks.length - 1];
            if (last?.type === 'text') last.content = text;
            else a.blocks.push({ type: 'text', content: text });
            // 若全文应覆盖各 text 段，至少保证 msg.text 正确
            a.streamTextOffset = text.length;
          }
        }
      }
      continue;
    }

    if (type === 'message-delta') {
      const b = asRec(agent.block);
      if (!b) continue;
      const t = blockText(b);
      if (!t) continue;
      const a = ensureAssistant(ts);
      if (b.type === 'thought' || b.kind === 'thought') {
        a.thinking = (a.thinking || '') + t;
      } else {
        a.text = (a.text || '') + t;
        if (!a.blocks) a.blocks = [];
        // 与 live store 类似：当前 text 段
        const offset =
          typeof a.streamTextOffset === 'number' ? a.streamTextOffset : 0;
        const segment =
          (a.text || '').length >= offset
            ? (a.text || '').slice(offset)
            : a.text || '';
        const last = a.blocks[a.blocks.length - 1];
        if (last?.type === 'text') last.content = segment;
        else if (segment) a.blocks.push({ type: 'text', content: segment });
      }
      continue;
    }

    if (type === 'tool-start') {
      // 与 live EventRouter 同一协议解析：兼容 call 包装与顶层字段两种形态
      //（真实 daemon 回放与 live 桥事件同源，禁止只认 call 包装导致恢复丢工具卡）
      const { id, name, args, explanation } = toolCallFieldsFromEvent(agent);
      const a = ensureAssistant(ts);
      if (!a.toolCalls) a.toolCalls = [];
      if (!a.blocks) a.blocks = [];
      // 工具前固化正文偏移
      a.streamTextOffset = (a.text || '').length;
      const existing = a.toolCalls.find((t) => t.id === id);
      if (existing) {
        existing.name = name;
        if (args) existing.arguments = args;
        if (explanation) existing.explanation = explanation;
        if (existing.status !== 'success' && existing.status !== 'error') {
          existing.status = 'running';
        }
      } else {
        a.toolCalls.push({
          id,
          name,
          arguments: args,
          status: 'running',
          ...(explanation ? { explanation } : {}),
        });
        if (!a.blocks.some((b) => b.type === 'tool_call' && b.id === id)) {
          a.blocks.push({ type: 'tool_call', id });
        }
      }
      continue;
    }

    if (type === 'tool-end') {
      const { id, text, isError } = toolResult(agent.result);
      const a = currentAssistant as SessionMessage | null;
      if (!a || !a.toolCalls) continue;
      const tc =
        a.toolCalls.find((t) => t.id === id) ||
        a.toolCalls[a.toolCalls.length - 1];
      if (tc) {
        tc.status = isError ? 'error' : 'success';
        tc.output = text || (isError ? 'failed' : 'OK');
      }
      continue;
    }
  }

  // 收尾仍 running 的工具标为中断（会在 UI 层隐藏）
  for (const m of messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.status === 'running') {
          tc.status = 'error';
          tc.output = tc.output || '上次会话中断，工具未完成';
        }
      }
    }
    if (m.status === 'processing') m.status = 'completed';
  }

  // 与 live / 本地持久化共用同一套 blocks 对齐规则
  const normalized = messages.map((m) =>
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
  );

  return {
    messages: normalized,
    maxSequence,
    ...(lastRunId !== undefined && { lastRunId }),
  };
}

export async function fetchSessionEvents(
  sessionId: string,
  afterSequence = 0,
  maxEvents = 500
): Promise<{
  events: unknown[];
  nextAfterSequence: number;
  hasMore: boolean;
} | null> {
  const transport = getTransport();
  try {
    if (!transport.isReady()) {
      const ok = await transport.waitUntilConnected(10_000);
      if (!ok) return null;
    }
    const res = (await transport.request<Record<string, unknown>>(
      'core_read_session_events',
      { sessionId, afterSequence, maxEvents },
      { timeoutMs: 15_000 }
    )) as Record<string, unknown>;
    const events = Array.isArray(res.events) ? res.events : [];
    const nextAfterSequence =
      typeof res.nextAfterSequence === 'number'
        ? res.nextAfterSequence
        : afterSequence;
    const hasMore = Boolean(res.hasMore);
    return { events, nextAfterSequence, hasMore };
  } catch (e) {
    logInternalError('fetchSessionEvents', e);
    return null;
  }
}

/**
 * hydrate 分页页数上限：50 页 × 800 = 40000 事件。
 * 引擎异常（hasMore 恒真）时在此截止并按「未完整」截断态返回，
 * 防无限翻页拖死会话；截断态由持久化熔断拦截，不会固化回写 SQLite。
 */
export const MAX_HYDRATE_PAGES = 50;

/** hydrate 单页事件数（与 fetchSessionEvents 默认尺寸同源） */
export const HYDRATE_PAGE_SIZE = 800;

export async function hydrateSessionMessagesFromEngine(
  sessionId: string
): Promise<SessionHydrateResult> {
  // P1-D2：消费 hasMore 按 nextAfterSequence 循环翻页直至拉全——
  // 修复前只拉单页 800 事件（R2 §6：hasMore 全仓无消费方），长会话被截断。
  // 各页事件先合并、最后统一 projectEventsToMessages：跨页的同一 assistant
  // 消息（delta/end 分属两页）合并后投影才能正确组装，分页边界不撕裂消息。
  const allEvents: unknown[] = [];
  let cursor = 0;
  let hasMore = false;

  for (let page = 0; page < MAX_HYDRATE_PAGES; page++) {
    const res = await fetchSessionEvents(sessionId, cursor, HYDRATE_PAGE_SIZE);
    if (!res) {
      return {
        ok: false,
        messages: [],
        nextAfterSequence: cursor,
        hasMore,
        error: 'not_connected',
      };
    }
    allEvents.push(...res.events);
    hasMore = res.hasMore;
    if (!hasMore) {
      cursor = Math.max(res.nextAfterSequence, cursor);
      break;
    }
    const next = Math.max(res.nextAfterSequence, cursor);
    if (next <= cursor) {
      // 防御：hasMore=true 但游标不前进 → 引擎状态异常，终止翻页按截断态返回
      break;
    }
    cursor = next;
  }
  // 循环结束后仍 hasMore = 未拉全（页数上限截断或游标停滞）→ 打截断标记
  const truncated = hasMore;

  if (allEvents.length === 0) {
    return {
      ok: true,
      messages: [],
      nextAfterSequence: cursor,
      hasMore,
      ...(truncated ? { truncated } : {}),
    };
  }
  const { messages, lastRunId, maxSequence } = projectEventsToMessages(
    allEvents
  );
  return {
    ok: true,
    messages,
    nextAfterSequence: Math.max(cursor, maxSequence),
    hasMore,
    ...(truncated ? { truncated } : {}),
    ...(lastRunId !== undefined && { lastRunId }),
  };
}

/**
 * H3 钩子：拉取 run snapshot 中的 usage（若协议可用）。
 * H2 仅提供 API，UI 可选用。
 *
 * T-47：透出 cache 字段（cacheReadTokens / cacheWriteTokens / cacheMissTokens /
 * hitRatio / writeRatio / missedTokens / warmUntilMs），解析统一走
 * `parseRunSnapshotUsage`（与 H2 投影同口径，禁止两套解析漂移）。
 */
export async function fetchRunSnapshotUsage(
  runId: string
): Promise<RunSnapshotUsage | null> {
  const transport = getTransport();
  try {
    if (!transport.isReady()) return null;
    const res = (await transport.request<Record<string, unknown>>(
      'core_get_run_snapshot',
      { runId },
      { timeoutMs: 10_000 }
    )) as Record<string, unknown>;
    return parseRunSnapshotUsage(res);
  } catch (e) {
    logInternalError('fetchRunSnapshotUsage', e);
    return null;
  }
}

/**
 * 将 snapshot usage 并入本地 tokenUsage（累加）。
 * sampleCount 为 0 时视为无真实样本，调用方可回退估算。
 */
/** usage delta 累加状态（4D：支持 cache read/write + savedCost） */
export type UsageDeltaState = {
  input: number;
  output: number;
  cost: number;
  inputMax: number;
  outputMax: number;
  cacheRead?: number;
  cacheWrite?: number;
  savedCost?: number;
};

/** run-snapshot usage 解析结果（4D 可选字段） */
export type RunSnapshotUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  sampleCount: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 命中率 = cacheRead / inputTotal；undefined = 未上报（隐藏而非 0%） */
  hitRatio?: number;
  /** 写入占比 = cacheWrite / inputTotal；undefined = 未上报 */
  writeRatio?: number;
  /** 本 run 审计出的浪费量（detectMiss 累计） */
  missedTokens?: number;
  /** 缓存温暖截止（now + TTL）；undefined = 无 TTL 数据 */
  warmUntilMs?: number;
};

/**
 * 同步解析 run-snapshot 原始数据为规范化 usage 结构。
 * 支持 snapshot.cache.readTokens/writeTokens（legacy daemon 形态）和
 * usage.cacheReadTokens/cacheWriteTokens（T-40 wire 形态）两种字段路径；
 * cacheMissTokens / hitRatio / writeRatio / missedTokens / warmUntilMs 同源透出。
 * null 语义：缺失/非法值 → undefined（UI 隐藏而非显示 0）。
 */
export function parseRunSnapshotUsage(raw: unknown): RunSnapshotUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as AnyRec;
  // 优先从 snapshot.usage 读
  const snap = asRec(r.snapshot);
  const usage = asRec(snap?.usage) ?? asRec(r.usage);
  if (!usage) return null;

  const promptTokens =
    typeof usage.promptTokens === 'number' ? usage.promptTokens : null;
  const completionTokens =
    typeof usage.completionTokens === 'number' ? usage.completionTokens : null;
  const totalTokens =
    typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : (promptTokens ?? 0) + (completionTokens ?? 0);
  const sampleCount =
    typeof usage.sampleCount === 'number' ? usage.sampleCount : 0;

  if (promptTokens === null && completionTokens === null) return null;

  // cache 字段（T-47）：优先 snapshot.cache（legacy daemon 形态），
  // 否则 usage.*（T-40 wire 形态 RunUsage camelCase）。
  const cache = snap ? asRec(snap.cache) : null;
  const readRaw = cache ? cache.readTokens : usage.cacheReadTokens;
  const writeRaw = cache ? cache.writeTokens : usage.cacheWriteTokens;
  const missRaw = cache ? cache.missTokens : usage.cacheMissTokens;
  const hitRatioRaw = cache ? cache.hitRatio : usage.hitRatio;
  const writeRatioRaw = cache ? cache.writeRatio : usage.writeRatio;

  // 计数类仅正数透出（0 = 无缓存活动；undefined = 未上报，UI 隐藏）
  const positive = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  // 比例类非负即透出（0 是合法报告值，区别于未上报 undefined）
  const nonNegative = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const cacheReadTokens = positive(readRaw);
  const cacheWriteTokens = positive(writeRaw);
  const cacheMissTokens = positive(missRaw);
  const hitRatio = nonNegative(hitRatioRaw);
  const writeRatio = nonNegative(writeRatioRaw);
  const missedTokens = positive(usage.missedTokens);
  const warmUntilMs = positive(usage.warmUntilMs);

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens,
    sampleCount,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
    ...(cacheMissTokens !== undefined && { cacheMissTokens }),
    ...(hitRatio !== undefined && { hitRatio }),
    ...(writeRatio !== undefined && { writeRatio }),
    ...(missedTokens !== undefined && { missedTokens }),
    ...(warmUntilMs !== undefined && { warmUntilMs }),
  };
}

/**
 * 将 usage delta 并入本地累计状态（4D：支持 cache read/write + savedCost）。
 * sampleCount 为 0 时视为无真实样本，调用方可回退估算。
 *
 * @param current      当前累计状态
 * @param usage        本次增量（promptTokens / completionTokens / cacheRead/WriteTokens）
 * @param estimateCost (input, output, cacheRead?, cacheWrite?) => cost
 * @param estimateSavings (input, output, cacheRead?, cacheWrite?) => savedCost（可选）
 */
export function applyUsageDelta(
  current: UsageDeltaState,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  estimateCost: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number,
  estimateSavings?: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheWrite?: number
  ) => number
): UsageDeltaState {
  const din = Math.max(0, usage.promptTokens ?? 0);
  const dout = Math.max(0, usage.completionTokens ?? 0);
  const dcr = Math.max(0, usage.cacheReadTokens ?? 0);
  const dcw = Math.max(0, usage.cacheWriteTokens ?? 0);
  if (din === 0 && dout === 0 && dcr === 0 && dcw === 0) return current;

  const nextIn = current.input + din;
  const nextOut = current.output + dout;
  const nextCost =
    current.cost + estimateCost(din, dout, dcr || undefined, dcw || undefined);

  const hasCacheRead = dcr > 0;
  const hasCacheWrite = dcw > 0;
  const nextCacheRead = hasCacheRead
    ? (current.cacheRead ?? 0) + dcr
    : current.cacheRead;
  const nextCacheWrite = hasCacheWrite
    ? (current.cacheWrite ?? 0) + dcw
    : current.cacheWrite;

  let nextSavedCost = current.savedCost;
  if (estimateSavings && (dcr > 0 || dcw > 0)) {
    const ds = estimateSavings(din, dout, dcr || undefined, dcw || undefined);
    nextSavedCost = (current.savedCost ?? 0) + ds;
  }

  return {
    ...current,
    input: nextIn,
    output: nextOut,
    cost: nextCost,
    ...(nextCacheRead !== undefined && { cacheRead: nextCacheRead }),
    ...(nextCacheWrite !== undefined && { cacheWrite: nextCacheWrite }),
    ...(nextSavedCost !== undefined && { savedCost: nextSavedCost }),
  };
}
