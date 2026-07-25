/**
 * 从引擎 read-session-events 投影本地对话消息。
 *
 * H2：打开空远程会话时补全文案 / 工具调用。
 * H3：可在此基础上挂 lastSequence 增量同步与 run snapshot usage。
 */

import type { SessionMessage } from '../store/layoutStore';
import { getDesktopDaemonClient } from './daemonClient';
import { normalizeAssistantTimeline } from './toolPresentation';
import { logInternalError } from './userFacingErrors';

export type SessionHydrateResult = {
  ok: boolean;
  messages: SessionMessage[];
  /** 引擎事件游标，供 H3 增量拉取 */
  nextAfterSequence: number;
  hasMore: boolean;
  error?: string;
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
  // 部分路径直接摊平
  if (typeof ev.type === 'string' && String(ev.type).includes('message')) {
    return ev;
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

function toolFields(call: unknown): { id: string; name: string; args: string; explanation: string } {
  const c = asRec(call) || {};
  const id = String(c.id ?? c.toolCallId ?? `tc-${Date.now()}`);
  const name = String(c.name ?? c.toolName ?? 'tool');
  let args = '';
  if (typeof c.arguments === 'string') args = c.arguments;
  else if (c.input !== undefined) {
    try {
      args = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    } catch {
      args = String(c.input);
    }
  }
  return {
    id,
    name,
    args,
    explanation: String(c.summary ?? c.description ?? name),
  };
}

function toolResult(result: unknown): { id: string; text: string; isError: boolean } {
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

  const pushUser = (text: string, ts: number) => {
    currentAssistant = null;
    messages.push({
      id: `hyd-user-${++msgSeq}`,
      sender: 'user',
      text,
      timestamp: ts,
      status: 'completed',
    });
  };

  const ensureAssistant = (ts: number) => {
    if (!currentAssistant) {
      currentAssistant = {
        id: `hyd-asst-${++msgSeq}`,
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
    if (typeof ev.sequence === 'number') maxSequence = Math.max(maxSequence, ev.sequence);
    if (typeof ev.runId === 'string') lastRunId = ev.runId;
    const payload = asRec(ev.payload);
    if (payload && typeof payload.runId === 'string') lastRunId = payload.runId as string;

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
          if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
          else if (b.type === 'text') text += blockText(b);
        }
      }
      text = text.trim();
      thought = thought.trim();
      if (role === 'user') {
        if (text) pushUser(text, ts);
      } else if (role === 'assistant') {
        const a = ensureAssistant(ts);
        if (thought) a.thinking = thought;
        if (text) {
          a.text = text;
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
        const offset = typeof a.streamTextOffset === 'number' ? a.streamTextOffset : 0;
        const segment = (a.text || '').length >= offset ? (a.text || '').slice(offset) : a.text || '';
        const last = a.blocks[a.blocks.length - 1];
        if (last?.type === 'text') last.content = segment;
        else if (segment) a.blocks.push({ type: 'text', content: segment });
      }
      continue;
    }

    if (type === 'tool-start') {
      const { id, name, args, explanation } = toolFields(agent.call);
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
      const a = currentAssistant as any;
      if (!a?.toolCalls) continue;
      const tc = a.toolCalls.find((t: any) => t.id === id) || a.toolCalls[a.toolCalls.length - 1];
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
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m,
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
  maxEvents = 500,
): Promise<{ events: unknown[]; nextAfterSequence: number; hasMore: boolean } | null> {
  const client = getDesktopDaemonClient();
  try {
    if (!client.isConnected()) {
      const ok = await client.waitUntilConnected(10_000);
      if (!ok) return null;
    }
    const res = (await client.request(
      {
        type: 'read-session-events',
        sessionId,
        afterSequence,
        maxEvents,
      },
      'session-events',
      15_000,
    )) as AnyRec;
    const events = Array.isArray(res.events) ? res.events : [];
    const nextAfterSequence =
      typeof res.nextAfterSequence === 'number' ? res.nextAfterSequence : afterSequence;
    const hasMore = Boolean(res.hasMore);
    return { events, nextAfterSequence, hasMore };
  } catch (e) {
    logInternalError('fetchSessionEvents', e);
    return null;
  }
}

export async function hydrateSessionMessagesFromDaemon(
  sessionId: string,
): Promise<SessionHydrateResult> {
  const page = await fetchSessionEvents(sessionId, 0, 800);
  if (!page) {
    return {
      ok: false,
      messages: [],
      nextAfterSequence: 0,
      hasMore: false,
      error: 'not_connected',
    };
  }
  if (page.events.length === 0) {
    return {
      ok: true,
      messages: [],
      nextAfterSequence: page.nextAfterSequence,
      hasMore: page.hasMore,
    };
  }
  const { messages, lastRunId, maxSequence } = projectEventsToMessages(page.events);
  return {
    ok: true,
    messages,
    nextAfterSequence: Math.max(page.nextAfterSequence, maxSequence),
    hasMore: page.hasMore,
    ...(lastRunId !== undefined && { lastRunId }),
  };
}


/**
 * H3 钩子：拉取 run snapshot 中的 usage（若协议可用）。
 * H2 仅提供 API，UI 可选用。
 */
export async function fetchRunSnapshotUsage(runId: string): Promise<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  sampleCount?: number;
} | null> {
  const client = getDesktopDaemonClient();
  try {
    if (!client.isConnected()) return null;
    const res = (await client.request(
      { type: 'get-run-snapshot', runId },
      'run-snapshot',
      10_000,
    )) as AnyRec;
    const snap = asRec(res.snapshot) || res;
    const usage = asRec(snap?.usage);
    if (!usage) return null;
    const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : undefined;
    const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : undefined;
    const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined;
    const sampleCount = typeof usage.sampleCount === 'number' ? usage.sampleCount : undefined;
    return {
      ...(promptTokens !== undefined && { promptTokens }),
      ...(completionTokens !== undefined && { completionTokens }),
      ...(totalTokens !== undefined && { totalTokens }),
      ...(sampleCount !== undefined && { sampleCount }),
    };
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
};

/**
 * 同步解析 run-snapshot 原始数据为规范化 usage 结构。
 * 支持 snapshot.cache.readTokens/writeTokens（优先）和
 * usage.cacheReadTokens/cacheWriteTokens（兜底）两种字段路径。
 */
export function parseRunSnapshotUsage(raw: unknown): RunSnapshotUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as AnyRec;
  // 优先从 snapshot.usage 读
  const snap = asRec(r.snapshot);
  const usage = asRec(snap?.usage) ?? asRec(r.usage);
  if (!usage) return null;

  const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : null;
  const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : null;
  const totalTokens = typeof usage.totalTokens === 'number'
    ? usage.totalTokens
    : (promptTokens ?? 0) + (completionTokens ?? 0);
  const sampleCount = typeof usage.sampleCount === 'number' ? usage.sampleCount : 0;

  if (promptTokens === null && completionTokens === null) return null;

  // cache 字段：优先 snapshot.cache.readTokens/writeTokens
  const cache = snap ? asRec(snap.cache) : null;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

  if (cache) {
    const r = Number(cache.readTokens);
    const w = Number(cache.writeTokens);
    if (Number.isFinite(r) && r > 0) cacheReadTokens = r;
    if (Number.isFinite(w) && w > 0) cacheWriteTokens = w;
  } else {
    // 兜底：直接在 usage 里找
    const r = Number(usage.cacheReadTokens);
    const w = Number(usage.cacheWriteTokens);
    if (Number.isFinite(r) && r > 0) cacheReadTokens = r;
    if (Number.isFinite(w) && w > 0) cacheWriteTokens = w;
  }

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens,
    sampleCount,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
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
  estimateCost: (input: number, output: number, cacheRead?: number, cacheWrite?: number) => number,
  estimateSavings?: (input: number, output: number, cacheRead?: number, cacheWrite?: number) => number,
): UsageDeltaState {
  const din = Math.max(0, usage.promptTokens ?? 0);
  const dout = Math.max(0, usage.completionTokens ?? 0);
  const dcr = Math.max(0, usage.cacheReadTokens ?? 0);
  const dcw = Math.max(0, usage.cacheWriteTokens ?? 0);
  if (din === 0 && dout === 0 && dcr === 0 && dcw === 0) return current;

  const nextIn = current.input + din;
  const nextOut = current.output + dout;
  const nextCost = current.cost + estimateCost(din, dout, dcr || undefined, dcw || undefined);

  const hasCacheRead = dcr > 0;
  const hasCacheWrite = dcw > 0;
  const nextCacheRead = hasCacheRead ? (current.cacheRead ?? 0) + dcr : current.cacheRead;
  const nextCacheWrite = hasCacheWrite ? (current.cacheWrite ?? 0) + dcw : current.cacheWrite;

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
