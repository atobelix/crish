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
import { getLayoutChromeState } from '../../../store/storeAccess';
import type { EngineEnvelope, LegacyEnvelope } from './eventParser';
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
  envelope: LegacyEnvelope | EngineEnvelope<'subagent-started'>
): void {
  if (envelope.kind === 'engine') {
    const ev = envelope.event;
    env.callbacks.onSubagentStarted?.({
      subagentId: ev.subagentId,
      subagentRunId: ev.subagentRunId,
      parentRunId: String(envelope.raw.runId ?? env.runId),
      parentToolCallId: ev.parentToolCallId,
      description: ev.description ?? '协作 agent',
      mode: ev.mode ?? 'research',
    });
    return;
  }
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
  envelope: LegacyEnvelope | EngineEnvelope<'subagent-event'>
): void {
  const msg = envelope.raw;
  const ev =
    msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)
      ? (msg.event as Record<string, unknown>)
      : {};
  const subagentId =
    envelope.kind === 'engine'
      ? envelope.event.subagentId
      : String(msg.subagentId ?? '');
  const subagentRunId =
    envelope.kind === 'engine'
      ? envelope.event.subagentRunId
      : String(msg.subagentRunId ?? '');
  env.callbacks.onSubagentEvent?.({
    subagentId,
    subagentRunId,
    event: ev,
  });
}

export function onSubagentEnded(
  env: HandlerEnv,
  envelope: LegacyEnvelope | EngineEnvelope<'subagent-ended'>
): void {
  if (envelope.kind === 'engine') {
    const ev = envelope.event;
    const st = mapSubagentEndStatus(String(ev.status ?? '').toLowerCase());
    env.callbacks.onSubagentEnded?.({
      subagentId: ev.subagentId,
      subagentRunId: ev.subagentRunId,
      status: st,
      summary: ev.summary,
    });
    return;
  }
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
  const store = getLayoutChromeState();
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
    description: String(raw.description ?? '协作任务').trim() || '协作任务',
    mode: String(raw.mode ?? 'research'),
    status: 'running',
    messages: [],
    startedAt: Date.now(),
  });
  if (parentToolCallId) {
    // T-E 步骤 3（S1）：raw setState → markToolCallLocalStatus（终态工具卡不回退
    // running 的守卫在 action 内建；scope 限定本会话避免全表扫描）
    getLayoutChromeState().markToolCallLocalStatus(
      parentToolCallId,
      'running',
      '协作进行中…',
      {
        sessionId: sid,
      }
    );
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
  // T-E 步骤 3（S2）：raw setState → applySubagentEventToAgent action
  //（applySubagentEventToMessages 纯函数复用内建，与 per-run 面 U2 同承载面）
  getLayoutChromeState().applySubagentEventToAgent(sid, subagentId, ev);
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
  // T-E 步骤 3（S3）：raw setState → patchSessionAgentToolStatus action
  //（与 per-run 面 U3 同一承载面：agent 终态 + 时间线收口 + 父工具卡终态）
  getLayoutChromeState().patchSessionAgentToolStatus(sid, subagentId, {
    status,
    ...(summary !== undefined ? { summary } : {}),
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
