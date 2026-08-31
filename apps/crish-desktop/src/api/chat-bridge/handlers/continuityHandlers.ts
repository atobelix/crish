/**
 * 连续性观测 handler（D8 §3.7 UI 簇数据面）：
 * goal-* ×3（前端投影化过渡）+ recovery-* ×5（熔断横幅 / 失败卡片数据）。
 *
 * 通道说明：
 * - goal-* 走 BufferedRunEventBridge emit（envelope 带 runId/sequence，D5 §3.9），
 *   per-run 面与连续性全局面均可到达——本批注册后统一投影 session.goalMode；
 * - recovery-* 走 append_event 直写（事件表留痕，D8 §3.2 合成路径可检索），
 *   实时 emit 不发射——本批注册仅为「若未来发射即消费」的宽容面，数据源
 *   缺位时失败卡片降级（summary/run error 回退，诚实化不假装有数据）。
 *
 * 信息分级（用户约束 C / §9.3）：熔断与重连进度不进对话历史、不进 LLM
 * 上下文，仅事件流 + UI 面（横幅 / 临时通知）。
 */
import { applyGoalRoundEventToGoalMode } from '../../../hooks/chat-stream/useGoalMode';
import {
  getSessionById,
  getSessionStoreState,
} from '../../../store/storeAccess';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

/** 熔断 reason 匹配（宽容：circuit 前缀/包含；熔断触发复用 steering 先例） */
export function isCircuitTripReason(
  reason: string | undefined | null
): boolean {
  return /circuit/i.test(String(reason ?? '').trim());
}

/**
 * goal 投影（会话级 patchSession）：goal-* 事件 sessionId 在信封 raw 层
 * （D8 §3.1.1：envelope 事件不列 sessionId 变体字段，读侧信封已含）。
 * 目标会话不在 store → 不投影（幽灵会话不写，防幽灵 goalMode）。
 */
function resolveGoalSessionId(raw: Record<string, unknown>): string {
  return String(raw.sessionId ?? '').trim();
}

export function onGoalRoundStarted(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'goal-round-started'>
): void {
  const sid = resolveGoalSessionId(envelope.raw);
  if (!sid) return;
  const sess = getSessionById(sid);
  if (!sess) return;
  const next = applyGoalRoundEventToGoalMode(sess.goalMode, {
    type: 'goal-round-started',
    round: envelope.event.round,
    maxRounds: envelope.event.maxRounds,
    goal: envelope.event.goal,
  });
  if (next !== null && next !== sess.goalMode) {
    getSessionStoreState().patchSession(sid, { goalMode: next });
  }
}

export function onGoalRoundCompleted(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'goal-round-completed'>
): void {
  const sid = resolveGoalSessionId(envelope.raw);
  if (!sid) return;
  const sess = getSessionById(sid);
  if (!sess) return;
  const next = applyGoalRoundEventToGoalMode(sess.goalMode, {
    type: 'goal-round-completed',
    round: envelope.event.round,
    decision: envelope.event.decision,
    reasonDetail: envelope.event.reasonDetail,
    stalledDelta: envelope.event.stalledDelta,
  });
  if (next !== null && next !== sess.goalMode) {
    getSessionStoreState().patchSession(sid, { goalMode: next });
  }
}

export function onGoalContinuationDecided(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'goal-continuation-decided'>
): void {
  const sid = resolveGoalSessionId(envelope.raw);
  if (!sid) return;
  const sess = getSessionById(sid);
  if (!sess) return;
  const next = applyGoalRoundEventToGoalMode(sess.goalMode, {
    type: 'goal-continuation-decided',
    action: envelope.event.action,
    reason: envelope.event.reason,
  });
  if (next !== null && next !== sess.goalMode) {
    getSessionStoreState().patchSession(sid, { goalMode: next });
  }
}

/**
 * recovery-escalated：双源消费（02-定夺 W1）——
 * - 熔断侧（subagentRunId=None、detail=circuit-trip）→ 熔断横幅（观测面，
 *   不进对话；D1 §3.2.2 C5 / §9.3）；
 * - 子代理侧（subagentRunId=Some）→ 失败卡片 kind/retries 投影（若 emit 到达；
 *   append_event 直写形态下该路径由检索面兜底，见 D8 §3.2）。
 */
export function onRecoveryEscalated(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'recovery-escalated'>
): void {
  const sid = String(envelope.event.sessionId ?? '').trim();
  if (!sid) return;
  const { detail, subagentRunId } = envelope.event;
  if (subagentRunId === undefined || subagentRunId === null || !subagentRunId) {
    // 熔断侧：无子代理归属，已废弃全局断路器状态
    return;
  }
  // 子代理侧：失败卡片 kind/retries 投影（errorKind/retries 字段进 agent 行，
  // 渲染面见失败态卡片；subagentRunId 匹配定位 agent）
  const state = getSessionStoreState();
  const sess =
    state.sessionsById[sid] || state.sessions.find((s) => s.id === sid);
  const agent = sess?.agents?.find((a) => a.subagentRunId === subagentRunId);
  if (!agent) return;
  state.patchSessionAgent(sid, agent.id, {
    errorKind: String(envelope.event.kind ?? ''),
    retries: envelope.event.retries,
  });
}

/**
 * recovery-steering / fork / report / budget-denied：登记面显式空实现。
 * 前端经 core_read_session_events（子代理会话检索，D8 §3.2 合成路径）读取，
 * 不在此实时消费；未来 emit 面变化时此处为接续点。
 */
export function onRecoverySteering(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-steering'>
): void {
  // 检索面消费（core_read_session_events），实时面显式空实现
}

export function onRecoveryFork(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-fork'>
): void {
  // 检索面消费（core_read_session_events），实时面显式空实现
}

export function onRecoveryReport(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-report'>
): void {
  // 检索面消费（core_read_session_events），实时面显式空实现
}

export function onRecoveryBudgetDenied(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-budget-denied'>
): void {
  // 检索面消费（core_read_session_events），实时面显式空实现
}
