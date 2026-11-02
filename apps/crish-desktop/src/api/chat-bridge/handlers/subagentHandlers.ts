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
import { getSessionStoreState } from '../../../store/storeAccess';
import type { SessionAgent } from '../../../store/types';
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

/** SubagentStarted 展示字段落数结果（R4a 地基） */
export interface SubagentStartedMeta {
  /** 引擎 role 落数；空白/缺失时不设（标题链自行兜底） */
  displayLabel?: string;
  /** 引擎 capabilityMode wire 名（原样落字段，消费方自判） */
  capabilityMode?: string;
  /** 启动时刻 epoch ms（引擎 ISO 时刻优先，本地接收时刻兜底） */
  startedAt: number;
  /** 嵌套深度：0 = 主会话直接子 agent */
  depth: number;
  /** 从根 agent 到自身（含自身）的 id 路径链 */
  subagentPath: string[];
}

/**
 * SubagentStarted 展示字段的统一落数口径（R4a）：per-run 面
 * （streamCallbacksEvents.applySubagentStarted）与本文件全局面共用，
 * 保证两面构建出的 SessionAgent 字段一致、与 DB 回放同名字段同义。
 *
 * - displayLabel ← 引擎 `role`（SubagentRole wire 名，如 researcher）：
 *   started 事件不带 spawn 的 display_label 参数，role 是实时路径上
 *   唯一的角色标签数据源（DB 回放的 displayLabel 来自落库列，实时
 *   路径此前恒缺失，标题链第一环因此在实时会话从不生效）。
 * - startedAt ← 引擎 ISO 8601 时刻（与 DB 的 started_at 同源）；
 *   缺失/不可解析时回退本地接收时刻（近似兜底，量级为桥接延迟）。
 * - depth / subagentPath ← parentToolCallId 链派生：父工具调用所在
 *   agent 为父级（depth + 1、路径续接其 subagentPath）；父工具调用
 *   不在任一 sibling 的时间线内（主会话直派）→ depth 0、[selfId]。
 *   父 agent 的 depth/subagentPath 缺省时按 0 / [parentId] 合成。
 */
export function resolveSubagentStartedMeta(
  raw: { role?: unknown; capabilityMode?: unknown; startedAt?: unknown },
  siblings: readonly SessionAgent[],
  selfId: string,
  parentToolCallId?: string
): SubagentStartedMeta {
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  const capabilityMode =
    typeof raw.capabilityMode === 'string' ? raw.capabilityMode.trim() : '';
  let startedAt = Number.NaN;
  if (typeof raw.startedAt === 'string' && raw.startedAt.trim()) {
    startedAt = Date.parse(raw.startedAt);
  } else if (typeof raw.startedAt === 'number') {
    startedAt = raw.startedAt;
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    startedAt = Date.now();
  }
  let depth = 0;
  let subagentPath: string[] = [selfId];
  if (parentToolCallId) {
    const parent = siblings.find(
      (a) =>
        a.id !== selfId &&
        (a.messages || []).some((m) =>
          (m.toolCalls || []).some((t) => t.id === parentToolCallId)
        )
    );
    if (parent) {
      depth = (parent.depth ?? 0) + 1;
      subagentPath = [...(parent.subagentPath ?? [parent.id]), selfId];
    }
  }
  return {
    ...(role ? { displayLabel: role } : {}),
    ...(capabilityMode ? { capabilityMode } : {}),
    startedAt,
    depth,
    subagentPath,
  };
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
      // R4a：引擎必带展示字段（role/capabilityMode/startedAt）——此前在此丢弃
      role: ev.role,
      capabilityMode: ev.capabilityMode,
      startedAt: ev.startedAt,
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
    // R4a：legacy 信封同 wire 契约，展示字段在场时一并透传
    ...(typeof msg.role === 'string' ? { role: msg.role } : {}),
    ...(typeof msg.capabilityMode === 'string'
      ? { capabilityMode: msg.capabilityMode }
      : {}),
    ...(typeof msg.startedAt === 'string' ? { startedAt: msg.startedAt } : {}),
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
  const store = getSessionStoreState();
  const existing = store.sessionsById[sid]?.agents?.find(
    (a) => a.id === subagentId
  );
  if (existing) return;
  const parentToolCallId = raw.parentToolCallId
    ? String(raw.parentToolCallId)
    : undefined;
  // R4a：展示字段与嵌套链与 per-run 面同一落数口径（共用 resolveSubagentStartedMeta）
  const meta = resolveSubagentStartedMeta(
    raw,
    store.sessionsById[sid]?.agents ?? [],
    subagentId,
    parentToolCallId
  );
  store.upsertSessionAgent(sid, {
    id: subagentId,
    subagentRunId: String(raw.subagentRunId ?? ''),
    parentSessionId: sid,
    parentRunId: typeof raw.runId === 'string' ? raw.runId.trim() : '',
    parentToolCallId,
    description: String(raw.description ?? '协作任务').trim() || '协作任务',
    mode: String(raw.mode ?? 'research'),
    ...(meta.displayLabel ? { displayLabel: meta.displayLabel } : {}),
    ...(meta.capabilityMode ? { capabilityMode: meta.capabilityMode } : {}),
    depth: meta.depth,
    subagentPath: meta.subagentPath,
    status: 'running',
    messages: [],
    startedAt: meta.startedAt,
  });
  if (parentToolCallId) {
    // T-E 步骤 3（S1）：raw setState → markToolCallLocalStatus（终态工具卡不回退
    // running 的守卫在 action 内建；scope 限定本会话避免全表扫描）
    getSessionStoreState().markToolCallLocalStatus(
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
  getSessionStoreState().applySubagentEventToAgent(sid, subagentId, ev);
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
  getSessionStoreState().patchSessionAgentToolStatus(sid, subagentId, {
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
