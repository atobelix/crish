/**
 * 协作 agent 形状守卫与水合收尾纯函数（从 sessionHydration 拆出）
 *
 * 职责：SessionAgent 的形状守卫 + 水合态收尾。
 * - parseSessionAgent / parseSessionAgents：协作 agent 形状守卫
 * - hydrateSessionAgents：水合后 sanitize 消息 + running → stopped
 */

import type { SessionAgent } from '../../store/layoutStore';
import { parseSessionMessages, sanitizeMessagesForHydrate } from './sessionHydrationMessages';

const AGENT_STATUSES = new Set<SessionAgent['status']>([
  'running',
  'completed',
  'failed',
  'stopped',
]);

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 协作 agent 形状守卫。缺核心 id 字段 → null。
 * messages 递归守卫；status 非法 → stopped。
 */
export function parseSessionAgent(raw: unknown): SessionAgent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  const subagentRunId = asNonEmptyString(o.subagentRunId);
  const parentSessionId = asNonEmptyString(o.parentSessionId);
  const parentRunId = asNonEmptyString(o.parentRunId);
  if (!id || !subagentRunId || !parentSessionId || !parentRunId) return null;

  const statusRaw = typeof o.status === 'string' ? o.status : '';
  const status: SessionAgent['status'] = AGENT_STATUSES.has(
    statusRaw as SessionAgent['status']
  )
    ? (statusRaw as SessionAgent['status'])
    : 'stopped';

  const startedAt = asFiniteNumber(o.startedAt);
  const endedAt = asFiniteNumber(o.endedAt);

  const agent: SessionAgent = {
    id,
    subagentRunId,
    parentSessionId,
    parentRunId,
    description: typeof o.description === 'string' ? o.description : '',
    mode: typeof o.mode === 'string' ? o.mode : '',
    status,
    messages: parseSessionMessages(o.messages),
    startedAt: startedAt != null ? startedAt : 0,
    depth: typeof o.depth === 'number' && o.depth >= 0 ? o.depth : 0,
    subagentPath: Array.isArray(o.subagentPath)
      ? (o.subagentPath as unknown[]).filter((s): s is string => typeof s === 'string')
      : [id],
  };

  const parentToolCallId = asNonEmptyString(o.parentToolCallId);
  if (parentToolCallId) agent.parentToolCallId = parentToolCallId;
  if (typeof o.summary === 'string') agent.summary = o.summary;
  if (endedAt != null) agent.endedAt = endedAt;

  return agent;
}

export function parseSessionAgents(raw: unknown): SessionAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionAgent[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const a = parseSessionAgent(item);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/**
 * 水合后的 agent：sanitize 消息 + running → stopped（中断非失败）。
 */
export function hydrateSessionAgents(agents: SessionAgent[]): SessionAgent[] {
  if (!agents?.length) return [];
  return agents.map((a) => {
    const summaryVal =
      a.status === 'running'
        ? a.summary || '上次会话中断，协作 agent 未完成'
        : a.summary;
    return {
      ...a,
      messages: sanitizeMessagesForHydrate(a.messages || []),
      status: a.status === 'running' ? ('stopped' as const) : a.status,
      ...(summaryVal !== undefined ? { summary: summaryVal } : {}),
    };
  });
}
