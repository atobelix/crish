/**
 * 协作子 agent 与信封级错误 handler（T7 分派表）。
 *
 * subagent-started / subagent-event / subagent-ended 为信封级遗留事件
 * （不在生成引擎事件联合中），经 legacy 信封直出；
 * error 为 Rust 侧事件通道顶层失败信封，四源失败收敛之一。
 *
 * 本文件另承载子代理面**全局消费者**（T-6 / 00 结论 5 / 04 M1）：
 * 父 run 收口后 per-run 路由退订（cleanupStreamState），跨 run 存活的
 * 子代理事件经 dataPlaneRouter 的子代理面全局路由到达本文件
 * （onSubagentStartedGlobal / onSubagentEventGlobal / onSubagentEndedGlobal），
 * 直写 agents store（与 per-run 面的 useStreamCallbacks 消费语义对齐）。
 */
import { surfaceStreamFailure } from '../BridgeErrorPolicy';
import { useLayoutStore } from '../../../store/layoutStore';
import { applySubagentEventToMessages } from '../../subagentTimeline';
import type { LegacyEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

/** 子代理终态归一（wire status → 展示终态）：cancel/abort/stop → stopped；fail/error → failed；其余 completed */
function mapSubagentEndStatus(raw: string): 'completed' | 'failed' | 'stopped' {
  return /cancel|stopp?ed|abort/i.test(raw)
    ? 'stopped'
    : /fail|error/i.test(raw)
      ? 'failed'
      : 'completed';
}

export function onSubagentStarted(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  env.callbacks.onSubagentStarted?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    parentRunId: String(msg.runId ?? env.runId),
    parentToolCallId: msg.parentToolCallId
      ? String(msg.parentToolCallId)
      : undefined,
    description: String(msg.description ?? '协作 agent'),
    mode: String(msg.mode ?? 'research'),
  });
}

export function onSubagentEvent(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  const ev =
    msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)
      ? (msg.event as Record<string, unknown>)
      : {};
  env.callbacks.onSubagentEvent?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    event: ev,
  });
}

export function onSubagentEnded(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  const st = mapSubagentEndStatus(String(msg.status ?? '').toLowerCase());
  env.callbacks.onSubagentEnded?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    status: st,
    summary: msg.summary ? String(msg.summary) : undefined,
  });
}

// ── 全局子代理面消费者（父 run 收口后兜底，T-6 / 04 M1）─────────

/**
 * 全局消费面会话解析：信封顶层 sessionId（Rust 侧与前端 sid 同源，
 * core_event_bridge 顶层平铺注入）。缺失/空白视为不可归属，跳过。
 */
function resolveSubagentSessionId(raw: Record<string, unknown>): string {
  return typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
}

/**
 * 父 run 收口后的 subagent-started 全局消费：agent 落 agents store
 * （upsert 按 id 合并）。双面共存防双写：同 id agent 已存在（per-run
 * 面已建）则跳过——全局面只兜底「per-run 未及处理」的迟到事件；
 * 父工具卡置 running（per-run 语义对齐，useStreamCallbacks.ts:471-481），
 * 终态工具卡不回退（sanitizeToolCallUpdates 同语义守卫）。
 */
export function onSubagentStartedGlobal(raw: Record<string, unknown>): void {
  const sid = resolveSubagentSessionId(raw);
  const subagentId = String(raw.subagentId ?? '');
  if (!sid || !subagentId) return;
  const store = useLayoutStore.getState();
  const existing = store.sessionsById[sid]?.agents?.find(
    (a) => a.id === subagentId
  );
  if (existing) return;
  const parentToolCallId = raw.parentToolCallId
    ? String(raw.parentToolCallId)
    : undefined;
  store.upsertSessionAgent(sid, {
    id: subagentId,
    subagentRunId: String(raw.subagentRunId ?? ''),
    parentSessionId: sid,
    parentRunId: typeof raw.runId === 'string' ? raw.runId.trim() : '',
    parentToolCallId,
    description: (String(raw.description ?? '协作任务')).trim() || '协作任务',
    mode: String(raw.mode ?? 'research'),
    status: 'running',
    messages: [],
    startedAt: Date.now(),
  });
  if (parentToolCallId) {
    useLayoutStore.setState((state) => {
      const sess = state.sessionsById[sid];
      if (!sess) return;
      for (const m of sess.messages) {
        const tc = m.toolCalls?.find((t) => t.id === parentToolCallId);
        if (!tc) continue;
        // 终态工具卡不回退为 running（与 sanitizeToolCallUpdates 一致）
        if (tc.status === 'success' || tc.status === 'error') return;
        tc.status = 'running';
        tc.output = '协作进行中…';
        return;
      }
    });
  }
}

/**
 * 父 run 收口后的 subagent-event 全局消费：event 结构化负载投影到
 * agent 时间线（applySubagentEventToMessages，与 per-run 面同源纯函数）。
 */
export function onSubagentEventGlobal(raw: Record<string, unknown>): void {
  const sid = resolveSubagentSessionId(raw);
  const subagentId = String(raw.subagentId ?? '');
  if (!sid || !subagentId) return;
  const ev =
    raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
      ? (raw.event as Record<string, unknown>)
      : {};
  useLayoutStore.setState((state) => {
    const sess = state.sessionsById[sid];
    const ag = sess?.agents?.find((a) => a.id === subagentId);
    if (!ag) return;
    ag.messages = applySubagentEventToMessages(ag.messages || [], ev);
  });
}

/**
 * 父 run 收口后的 subagent-ended 全局消费：agent 终态 patch + 时间线
 * 消息收口 + 父工具卡终态（语义对齐 per-run 面
 * useStreamCallbacks.ts:499-544）。
 */
export function onSubagentEndedGlobal(raw: Record<string, unknown>): void {
  const sid = resolveSubagentSessionId(raw);
  const subagentId = String(raw.subagentId ?? '');
  if (!sid || !subagentId) return;
  const status = mapSubagentEndStatus(String(raw.status ?? '').toLowerCase());
  const summary = raw.summary ? String(raw.summary) : undefined;
  useLayoutStore.setState((state) => {
    const sess = state.sessionsById[sid];
    const ag = sess?.agents?.find((a) => a.id === subagentId);
    if (!ag) return;
    ag.status = status;
    if (summary) ag.summary = summary;
    ag.endedAt = Date.now();
    const agSummary = summary || ag.summary || '';
    for (const m of ag.messages || []) {
      if (m.status === 'processing') m.status = 'completed';
    }
    const toolId = ag.parentToolCallId;
    if (toolId && sess?.messages) {
      for (const m of sess.messages) {
        const tc = m.toolCalls?.find((t) => t.id === toolId);
        if (!tc) continue;
        const failed = /fail|error/i.test(status);
        const stopped = /cancel|stopp?ed|abort/i.test(status);
        tc.status = failed || stopped ? 'error' : 'success';
        const body =
          agSummary.trim() ||
          (failed ? '协作未完成' : stopped ? '协作已停止' : '协作已完成');
        tc.output = body.length > 1200 ? body.slice(0, 1199) + '…' : body;
      }
    }
  });
}

export function onError(env: HandlerEnv, envelope: LegacyEnvelope): void {
  const msg = envelope.raw;
  surfaceStreamFailure(
    msg.message ?? msg.error ?? msg,
    'engine-error',
    env.callbacks,
    env.runId
  );
  env.approvalFlow.dispatch({ type: 'clear_all' });
  env.finish(true);
}
