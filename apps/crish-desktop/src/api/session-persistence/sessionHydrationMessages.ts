/**
 * 会话消息形状守卫与水合收尾纯函数（从 sessionHydration 拆出）
 *
 * 职责：MessageToolCall / SessionMessage 的形状守卫 + 流式态收尾。
 * - parseToolCall：工具调用形状守卫（内部函数）
 * - parseSessionMessage / parseSessionMessages：消息形状守卫
 * - sanitizeMessagesForHydrate：恢复时把未完成流式状态收成终态
 */

import type { SessionMessage } from '../../store/layoutStore';
import {
  compareMessageOrder,
  getMessageOrderKey,
  isSortedByMessageOrder,
} from '../store-access/helperAccess';
import type {
  FileDiff,
  MessageContextInjection,
  MessageImageRef,
  MessageToolApprovalMeta,
  MessageToolCall,
  SessionMessageAttachment,
} from '../../store/types';
import { normalizeAssistantTimeline } from '../toolPresentation';

const TOOL_STATUSES = new Set<MessageToolCall['status']>([
  'running',
  'success',
  'error',
  'pending_approval',
]);
const MSG_STATUSES = new Set<NonNullable<SessionMessage['status']>>([
  'queued',
  'processing',
  'completed',
  'error',
]);

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asNonNegativeInt(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n != null &&
    Number.isInteger(n) &&
    n >= 0 &&
    n < Number.MAX_SAFE_INTEGER
    ? n
    : null;
}

function parseToolCall(raw: unknown): MessageToolCall | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  if (!id) return null;
  const name = typeof o.name === 'string' ? o.name : 'tool';
  let args = '';
  if (typeof o.arguments === 'string') {
    args = o.arguments;
  } else if (o.arguments != null) {
    try {
      args = JSON.stringify(o.arguments);
    } catch {
      /* swallow-ok: 非可序列化参数退化为空串 */
    }
  }
  const status: MessageToolCall['status'] =
    typeof o.status === 'string' &&
    TOOL_STATUSES.has(o.status as MessageToolCall['status'])
      ? (o.status as MessageToolCall['status'])
      : 'error';
  const tc: MessageToolCall = { id, name, arguments: args, status };
  if (typeof o.output === 'string') tc.output = o.output;
  if (typeof o.explanation === 'string') tc.explanation = o.explanation;
  if (Array.isArray(o.diffs)) tc.diffs = o.diffs as FileDiff[];
  if (o.approvalMeta && typeof o.approvalMeta === 'object')
    tc.approvalMeta = o.approvalMeta as MessageToolApprovalMeta;
  const startedAt = asFiniteNumber(o.startedAt);
  if (startedAt != null) tc.startedAt = startedAt;
  const finishedAt = asFiniteNumber(o.finishedAt);
  if (finishedAt != null) tc.finishedAt = finishedAt;
  const durationMs = asFiniteNumber(o.durationMs);
  if (durationMs != null) tc.durationMs = durationMs;
  else if (startedAt != null && finishedAt != null && finishedAt >= startedAt)
    tc.durationMs = finishedAt - startedAt;
  return tc;
}

function parseTimelineBlocks(
  rawBlocks: unknown[]
): NonNullable<SessionMessage['blocks']> {
  const blocks: NonNullable<SessionMessage['blocks']> = [];
  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') continue;
    const bo = b as Record<string, unknown>;
    const bTurn =
      typeof bo.turnIndex === 'number' && Number.isFinite(bo.turnIndex)
        ? bo.turnIndex
        : undefined;
    const bStart = asFiniteNumber(bo.startTime);
    const bDur = asFiniteNumber(bo.durationMs);
    const bid = typeof bo.id === 'string' ? bo.id : undefined;
    const base = {
      ...(bTurn !== undefined ? { turnIndex: bTurn } : {}),
      ...(bStart != null ? { startTime: bStart } : {}),
      ...(bDur != null ? { durationMs: bDur } : {}),
    };
    const optId = bid !== undefined ? { id: bid } : {};
    if (bo.type === 'text') {
      blocks.push({
        type: 'text',
        content: typeof bo.content === 'string' ? bo.content : '',
        ...base,
      });
    } else if (bo.type === 'tool_call') {
      blocks.push({ type: 'tool_call', ...optId, ...base });
    } else if (bo.type === 'thought') {
      blocks.push({
        type: 'thought',
        content: typeof bo.content === 'string' ? bo.content : '',
        ...optId,
        ...base,
        ...(typeof bo.isStreaming === 'boolean'
          ? { isStreaming: bo.isStreaming }
          : {}),
        ...(typeof bo.isHistoricalCollapsed === 'boolean'
          ? { isHistoricalCollapsed: bo.isHistoricalCollapsed }
          : {}),
        ...(typeof bo.redacted === 'boolean' ? { redacted: bo.redacted } : {}),
      });
    } else if (bo.type === 'context_injection') {
      blocks.push({
        type: 'context_injection',
        ...optId,
        ...(bo.injection
          ? { injection: bo.injection as MessageContextInjection }
          : {}),
        ...base,
      });
    } else if (bo.type === 'image') {
      blocks.push({
        type: 'image',
        ...optId,
        ...(Array.isArray(bo.images)
          ? { images: bo.images as MessageImageRef[] }
          : {}),
        ...base,
      });
    } else if (bo.type === 'step_start' || bo.type === 'step_end') {
      blocks.push({
        type: bo.type,
        ...optId,
        ...(typeof bo.content === 'string' ? { content: bo.content } : {}),
        ...base,
      });
    }
  }
  return blocks;
}

/**
 * 消息形状守卫：必须有 id + user|assistant sender；
 * 坏时间戳 → 0；提取并保留非负有限整数 engineSequence；非法 status / tool 过滤或纠正。
 */
export function parseSessionMessage(raw: unknown): SessionMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  const sender =
    o.sender === 'user' || o.sender === 'assistant' ? o.sender : null;
  if (!id || !sender) return null;

  const ts = asFiniteNumber(o.timestamp);
  const msg: SessionMessage = { id, sender, timestamp: ts != null ? ts : 0 };
  const seq =
    asNonNegativeInt(o.engineSequence) ??
    asNonNegativeInt(o.seq) ??
    asNonNegativeInt(o.sequence);
  if (seq != null) msg.engineSequence = seq;

  if (typeof o.text === 'string') msg.text = o.text;
  if (typeof o.thinking === 'string') msg.thinking = o.thinking;
  if (
    typeof o.status === 'string' &&
    MSG_STATUSES.has(o.status as NonNullable<SessionMessage['status']>)
  ) {
    msg.status = o.status as NonNullable<SessionMessage['status']>;
  }
  if (
    typeof o.streamTextOffset === 'number' &&
    Number.isFinite(o.streamTextOffset)
  ) {
    msg.streamTextOffset = o.streamTextOffset;
  }
  if (typeof o.thinkingTime === 'number' && Number.isFinite(o.thinkingTime)) {
    msg.thinkingTime = o.thinkingTime;
  }
  if (Array.isArray(o.toolCalls) && o.toolCalls.length) {
    const tools = o.toolCalls
      .map(parseToolCall)
      .filter(Boolean) as MessageToolCall[];
    if (tools.length) msg.toolCalls = tools;
  }
  if (Array.isArray(o.blocks) && o.blocks.length) {
    const blocks = parseTimelineBlocks(o.blocks);
    if (blocks.length) msg.blocks = blocks;
  }

  if (Array.isArray(o.thinkingTurns) && o.thinkingTurns.length) {
    msg.thinkingTurns = o.thinkingTurns
      .filter((tt): tt is Record<string, unknown> =>
        Boolean(tt && typeof tt === 'object')
      )
      .map((tt) => ({
        turnIndex: typeof tt.turnIndex === 'number' ? tt.turnIndex : 0,
        content: typeof tt.content === 'string' ? tt.content : '',
        ...(typeof tt.id === 'string' ? { id: tt.id } : {}),
        ...(typeof tt.durationMs === 'number'
          ? { durationMs: tt.durationMs }
          : {}),
        ...(typeof tt.isStreaming === 'boolean'
          ? { isStreaming: tt.isStreaming }
          : {}),
      }));
  } else if (msg.blocks) {
    const derived = msg.blocks
      .filter((b) => b.type === 'thought' && (b.content || '').trim())
      .map((b) => ({
        turnIndex: b.turnIndex ?? 0,
        content: b.content || '',
        ...(b.id ? { id: b.id } : {}),
        ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
      }));
    if (derived.length) msg.thinkingTurns = derived;
  }

  if (Array.isArray(o.injections) && o.injections.length)
    msg.injections = o.injections as MessageContextInjection[];
  if (Array.isArray(o.attachments) && o.attachments.length)
    msg.attachments = o.attachments as SessionMessageAttachment[];
  if (Array.isArray(o.images) && o.images.length)
    msg.images = o.images as MessageImageRef[];
  const rawErrorDetail = o['errorDetail'];
  if (rawErrorDetail && typeof rawErrorDetail === 'object') {
    const ed = rawErrorDetail as Record<string, unknown>;
    if (typeof ed.message === 'string' && typeof ed.kind === 'string') {
      Object.assign(msg, {
        errorDetail: {
          message: ed.message,
          kind: ed.kind,
          ...(typeof ed.technical === 'string'
            ? { technical: ed.technical }
            : {}),
        },
      });
    }
  }
  if (o.metadata !== undefined && o.metadata !== null)
    msg.metadata = o.metadata;

  return msg;
}

/** 数组形态消息列表守卫（JSON 数组存盘兼容路径） */
export function parseSessionMessages(raw: unknown): SessionMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionMessage[] = [];
  for (const item of raw) {
    const m = parseSessionMessage(item);
    if (m) out.push(m);
  }
  return out;
}

function isUuidOrHexHash(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || /^[0-9a-f]{16,}$/i.test(id);
}

function extractExplicitCounter(
  id: string
): { prefix: string; seq: number } | null {
  if (!id || isUuidOrHexHash(id)) return null;
  const m = id.match(/^(.*?[^\d])(\d+)$/);
  if (m) {
    const num = Number.parseInt(m[2]!, 10);
    return Number.isFinite(num) ? { prefix: m[1]!, seq: num } : null;
  }
  if (/^\d+$/.test(id)) {
    const num = Number.parseInt(id, 10);
    return Number.isFinite(num) ? { prefix: '', seq: num } : null;
  }
  return null;
}

function isCausalGroupCorrupted(group: readonly SessionMessage[]): boolean {
  if (group.length <= 1) return false;
  const totalUsers = group.filter((m) => m.sender === 'user').length;
  const totalAssts = group.length - totalUsers;
  if (totalUsers === 0 || totalAssts === 0) return false;

  let seenUsers = 0;
  let seenAssts = 0;
  let asstBeforeUser = false;

  for (const m of group) {
    if (m.sender === 'user') {
      seenUsers += 1;
    } else if (m.sender === 'assistant') {
      seenAssts += 1;
      if (seenUsers === 0) asstBeforeUser = true;
      if (seenAssts > seenUsers && seenUsers < totalUsers) return true;
    }
  }
  if (asstBeforeUser) return true;

  if (totalUsers === totalAssts && totalUsers >= 2) {
    let allUsersFirst = true;
    for (let i = 0; i < totalUsers; i++) {
      if (group[i]?.sender !== 'user') {
        allUsersFirst = false;
        break;
      }
    }
    if (allUsersFirst) return true;
  }

  const hasRoleIdInversion = (sender: SessionMessage['sender']): boolean => {
    let prev: SessionMessage | null = null;
    for (const m of group) {
      if (m.sender !== sender) continue;
      if (prev) {
        const prevCounter = extractExplicitCounter(prev.id);
        const currCounter = extractExplicitCounter(m.id);
        if (
          prevCounter &&
          currCounter &&
          prevCounter.prefix === currCounter.prefix &&
          prevCounter.seq > currCounter.seq
        ) {
          return true;
        }
      }
      prev = m;
    }
    return false;
  };
  return hasRoleIdInversion('user') || hasRoleIdInversion('assistant');
}

function healCausalGroup(group: SessionMessage[]): SessionMessage[] {
  if (!isCausalGroupCorrupted(group)) return group;
  const sortRole = (list: SessionMessage[]): SessionMessage[] => {
    if (list.length <= 1) return list;
    const counters = list.map((m) => extractExplicitCounter(m.id));
    const allHaveSamePrefix =
      counters.every((c) => c !== null) &&
      counters.every((c) => c!.prefix === counters[0]!.prefix);
    if (allHaveSamePrefix) {
      return [...list].sort((a, b) => {
        const ca = extractExplicitCounter(a.id)!;
        const cb = extractExplicitCounter(b.id)!;
        return ca.seq - cb.seq;
      });
    }
    return list;
  };
  const systems = group.filter((m) => (m.sender as string) === 'system');
  const users = sortRole(group.filter((m) => m.sender === 'user'));
  const assts = sortRole(group.filter((m) => m.sender === 'assistant'));
  const out: SessionMessage[] = [...systems];
  const maxLen = Math.max(users.length, assts.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < users.length) out.push(users[i]!);
    if (i < assts.length) out.push(assts[i]!);
  }
  return out;
}

/**
 * 历史脏数据因果自愈：
 * 修复同毫秒碰撞/时间戳倒挂与角色逆序（如 sess-1791764675736），赋予递增因果 engineSequence。
 */
function healMessagesCausalOrder(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length === 0) return [];
  const seqSet = new Set<number>();
  let allHaveUniqueSeq = true;
  for (const m of messages) {
    const s = asNonNegativeInt(m.engineSequence);
    if (s == null || seqSet.has(s)) {
      allHaveUniqueSeq = false;
      break;
    }
    seqSet.add(s);
  }

  const working = messages.slice();
  if (allHaveUniqueSeq) {
    if (!isSortedByMessageOrder(working)) {
      working.sort((a, b) =>
        compareMessageOrder(getMessageOrderKey(a), getMessageOrderKey(b))
      );
    }
    let prevTs = 0;
    return working.map((m) => {
      const ts = m.timestamp >= prevTs ? m.timestamp : prevTs;
      prevTs = ts;
      return ts === m.timestamp ? m : { ...m, timestamp: ts };
    });
  }

  let hasTsInversion = false;
  for (let i = 1; i < working.length; i++) {
    const prev = working[i - 1]!;
    const curr = working[i]!;
    if (
      prev.timestamp > 0 &&
      curr.timestamp > 0 &&
      prev.timestamp > curr.timestamp
    ) {
      if (!(prev.sender === 'user' && curr.sender === 'assistant')) {
        hasTsInversion = true;
        break;
      }
    }
  }
  if (hasTsInversion) {
    working.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  const healed: SessionMessage[] = [];
  let run: SessionMessage[] = [];
  let runTs = -1;
  for (const m of working) {
    const effectiveTs =
      runTs >= 0 && m.timestamp > 0 && m.timestamp < runTs
        ? runTs
        : m.timestamp;
    const normalized =
      effectiveTs === m.timestamp ? m : { ...m, timestamp: effectiveTs };
    if (run.length === 0 || effectiveTs === runTs) {
      run.push(normalized);
      runTs = effectiveTs;
    } else {
      healed.push(...(run.length > 1 ? healCausalGroup(run) : run));
      run = [normalized];
      runTs = effectiveTs;
    }
  }
  if (run.length > 0) {
    healed.push(...(run.length > 1 ? healCausalGroup(run) : run));
  }

  let nextSeq = 0;
  let lastTs = 0;
  return healed.map((m) => {
    const existingSeq = asNonNegativeInt(m.engineSequence);
    const assignedSeq =
      existingSeq != null && existingSeq >= nextSeq ? existingSeq : nextSeq;
    nextSeq = assignedSeq + 1;
    const safeTs = m.timestamp >= lastTs ? m.timestamp : lastTs;
    lastTs = safeTs;
    if (m.engineSequence === assignedSeq && m.timestamp === safeTs) return m;
    return { ...m, engineSequence: assignedSeq, timestamp: safeTs };
  });
}

function isStaleContextStateUserMessage(m: SessionMessage): boolean {
  if (m.sender !== 'user') return false;
  if (
    (m.metadata as Record<string, unknown> | undefined)?.kind ===
    'context-state'
  )
    return true;
  return /^(?:\[系统环境提示：\]?\s*)?当前已切换到模型/.test(
    (m.text || '').trim()
  );
}

function isStaleAssistantBoilerplate(m: SessionMessage): boolean {
  if (
    m.sender !== 'assistant' ||
    (Array.isArray(m.toolCalls) && m.toolCalls.length > 0)
  )
    return false;
  const t = (m.text || '').trim();
  if (t.length > 500) return false;
  return /^(?:明白了[。.]?|收到[。.]?|好的[。.]?)?\s*(?:当前配置[：:]|(?:当前配置|当前状态已切换|已了解当前配置|我已了解|收到环境更新|(?:我已经了解|我已了解)?(?:已切换到模型|当前已切换到模型)))/i.test(
    t
  );
}

/**
 * 历史脏数据自愈净化：识别并移除由旧 Bug 生成的孤儿状态对：
 * (a) 消息为 sender === 'user' 且匹配 /^当前已切换到模型/；
 * (b) 紧邻消息为 sender === 'assistant' 且匹配确认配置废话回复。
 */
export function purgeStaleContextStateBubbles(
  messages: SessionMessage[]
): SessionMessage[] {
  if (!messages?.length) return [];
  const out: SessionMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i]!;
    if (isStaleContextStateUserMessage(curr)) {
      const next = messages[i + 1];
      if (next && isStaleAssistantBoilerplate(next)) i++;
      continue;
    }
    out.push(curr);
  }
  return out;
}

/**
 * 恢复时把未完成的流式状态收成终态，并对历史脏数据执行因果保序自愈。
 */
export function sanitizeMessagesForHydrate(
  messages: SessionMessage[]
): SessionMessage[] {
  if (!messages?.length) return [];
  const purged = purgeStaleContextStateBubbles(messages);
  const cleaned = purged.map((m) => {
    let next = m;
    if (m.status === 'processing') {
      next = {
        ...next,
        status: 'completed',
        text: m.text && m.text.trim() ? m.text : '',
      };
    }
    if (next.toolCalls?.length) {
      next = {
        ...next,
        toolCalls: next.toolCalls.map((tc) =>
          tc.status === 'running' || tc.status === 'pending_approval'
            ? {
                ...tc,
                status: 'error' as const,
                output: tc.output?.trim()
                  ? tc.output
                  : '上次会话中断，工具未完成',
              }
            : tc
        ),
      };
    }
    if (next.sender === 'assistant') {
      if ((next.text || '').trim() === '已结束。') next = { ...next, text: '' };
      next = normalizeAssistantTimeline(next);
    }
    return next;
  });
  return healMessagesCausalOrder(cleaned);
}
