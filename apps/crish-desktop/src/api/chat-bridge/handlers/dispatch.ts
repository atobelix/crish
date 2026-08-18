/**
 * 分派表（T7）：Record<EventType, Handler>。
 *
 * engineDispatchTable 以 T6 生成的事件联合类型（EngineEventType）为键，
 * 每个 handler 入参为具体事件信封类型（EngineEnvelope<具体类型>）；
 * legacyDispatchTable 承接生成联合之外的信封级事件（subagent-* / error）。
 */
import type { EngineEventType } from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEnvelope,
  LegacyEnvelope,
  LegacyEventType,
} from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useSessionStore } from '../../../store/sessionStore';
import { emitUiEvent } from '../../../api/uiEvents';
import { invalidateEditObjects } from '../editSessionConsumer';
import {
  onMessageStart,
  onMessageDelta,
  onMessageEnd,
} from './messageHandlers';
import {
  onToolStart,
  onToolEnd,
  onToolBatchStart,
  onToolBatchEnd,
} from './toolHandlers';
import {
  onAgentStart,
  onAgentEnd,
  onTurnStart,
  onTurnEnd,
  onRunTerminal,
} from './lifecycleHandlers';
import {
  onProviderDiagnostic,
  onRuntimeError,
  onRuntimeSteering,
  onRuntimeInterventionRequired,
} from './diagnosticHandlers';
import {
  onContextCompressionStart,
  onContextCompressionEnd,
  onCheckpointCreated,
  onCheckpointRestored,
} from './compressionHandlers';
import { onApprovalRequested, onApprovalResolved } from './approvalHandlers';
import {
  onSubagentStarted,
  onSubagentEvent,
  onSubagentEnded,
  onError,
} from './subagentHandlers';
import {
  onCacheStatsUpdated,
  onCacheWasteAlert,
  onColdCacheWarning,
} from './cacheEventHandlers';
import { onSecurityAudit } from './securityAuditHandlers';
import {
  onTaskStarted,
  onTaskOutput,
  onTaskHeartbeat,
  onTaskSuspicious,
  onTaskCompleted,
  onTaskFailed,
  onTaskKilled,
  onTimerFired,
  onTimerCancelled,
  onCronFired,
} from './taskEventHandlers';
import {
  onGoalRoundStarted,
  onGoalRoundCompleted,
  onGoalContinuationDecided,
  onRecoveryEscalated,
  onRecoverySteering,
  onRecoveryFork,
  onRecoveryReport,
  onRecoveryBudgetDenied,
} from './continuityHandlers';

export type EngineHandler<ET extends EngineEventType> = (
  env: HandlerEnv,
  envelope: EngineEnvelope<ET>
) => void;

// 观测与中控增强域（D-03 观测九事件显式空实现）
export function onSteeringEvaluated(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'steering-evaluated'>
): void {}

export function onControlIntent(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'control-intent'>
): void {}

export function onHookOutcome(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'hook-outcome'>
): void {}

export function onSummaryBackground(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'summary-background'>
): void {}

export function onStageSummaryMilestone(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'stage-summary-milestone'>
): void {}

export function onNudgeEnqueued(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'nudge-enqueued'>
): void {}

export function onRecoveryAcknowledged(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-acknowledged'>
): void {}

export function onRecoveryRetryAttempted(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'recovery-retry-attempted'>
): void {}

export function onProviderRequestAnchored(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'provider-request-anchored'>
): void {}

// 撤回域（T1a 统一输入流收敛战役）：timeline-truncate 出站事件，R1 撤回
// 消费接线——投影重放至 boundary（applyTimelineTruncate）+ 从 boundary
// user 节点原文回填 composer（不依赖 draft 快照，详案 §1.2-⑤⑥）+
// R2-b ⑥ 失效传播：截断范围内编辑中对象 invalidate（详案 §1.2-⑥-1）。
export function onTimelineTruncate(
  env: HandlerEnv,
  envelope: EngineEnvelope<'timeline-truncate'>
): void {
  const { event } = envelope;
  if (!event.sessionId) return;
  try {
    const store = useSessionStore.getState();
    // ① 取回 boundary user 节点原文（回填数据源；节点在投影截断前读取）
    let backfillText = '';
    // ② R2-b ⑥：截断范围（boundary target 之后）内的消息 id —— 投影截断前
    // 收集，供编辑会话失效传播（对象已不在时间线，编辑面应立即失效）。
    const truncatedIds: string[] = [];
    const sess = store.sessionsById[event.sessionId];
    if (sess?.messages) {
      const targetIdx = sess.messages.findIndex(
        (m) => m.id === event.targetMessageId
      );
      if (targetIdx !== -1) {
        for (let i = targetIdx + 1; i < sess.messages.length; i++) {
          const m = sess.messages[i];
          if (m?.id) truncatedIds.push(m.id);
        }
        const target = sess.messages[targetIdx];
        if (target?.sender === 'user') {
          backfillText = target.text || '';
        }
      }
    }
    // ③ 投影重放至 boundary（保留边界节点，丢弃其后节点）
    store.applyTimelineTruncate(
      event.sessionId,
      event.boundarySeq,
      event.targetMessageId
    );
    // ④ R2-b ⑥ 失效传播：被截断对象若持有编辑会话 → invalidate('truncate')
    if (truncatedIds.length > 0) {
      invalidateEditObjects(truncatedIds, 'truncate');
    }
    // ⑤ 文本回填 composer（宿主 ChatCard 订阅后 setChatInput +
    // setComposerDraft；附件恢复登记为后续增强）
    if (backfillText) {
      emitUiEvent('retract-backfill', {
        sessionId: event.sessionId,
        text: backfillText,
      });
    }
  } catch (err) {
    console.warn('[dispatch] timeline-truncate 消费失败:', err);
  }
}

export const engineDispatchTable: {
  [ET in EngineEventType]: EngineHandler<ET>;
} = {
  'agent-start': onAgentStart,
  'agent-end': onAgentEnd,
  'turn-start': onTurnStart,
  'turn-end': onTurnEnd,
  'message-start': onMessageStart,
  'message-delta': onMessageDelta,
  'message-end': onMessageEnd,
  'tool-start': onToolStart,
  'tool-end': onToolEnd,
  'tool-batch-start': onToolBatchStart,
  'tool-batch-end': onToolBatchEnd,
  'context-compression-start': onContextCompressionStart,
  'context-compression-end': onContextCompressionEnd,
  'provider-diagnostic': onProviderDiagnostic,
  'runtime-error': onRuntimeError,
  'runtime-steering': onRuntimeSteering,
  'runtime-intervention-required': onRuntimeInterventionRequired,
  'approval-requested': onApprovalRequested,
  'approval-resolved': onApprovalResolved,
  'checkpoint-created': onCheckpointCreated,
  'checkpoint-restored': onCheckpointRestored,
  'run-terminal': onRunTerminal,
  // 缓存测量域三事件（P5 S3；T-38 注册显式空实现，T-48 接线真实消费 →
  // cacheEventsStore → SessionCacheStatsPanel 展示）
  'cache-stats-updated': onCacheStatsUpdated,
  'cache-waste-alert': onCacheWasteAlert,
  'cold-cache-warning': onColdCacheWarning,
  // 安全审计域（I2-S8 事件面 → I3-S9 接线）：security-audit → securityAuditStore
  // （审计日志视图 / 恢复面板数据源）
  'security-audit': onSecurityAudit,
  // 子代理域（I5-M7：注册表新增后 EngineEventType 含此三键；解析路径
  // 优先生成解析器——完整信封带 sessionId 时走 engine 分支，宽容形态
  // （缺 sessionId 等）走 legacy 分支；两分支都转发 legacy handler
  // （消费 raw 原始信封，subagentHandlers.ts），保证行为一致）
  'subagent-started': onSubagentStarted,
  'subagent-event': onSubagentEvent,
  'subagent-ended': onSubagentEnded,
  // 任务域七事件（F3 T-AB-17 数据面；UI 展示层轮询策略下显式空实现，
  // 事件驱动刷新接线待后续轮——taskEventHandlers.ts）
  'task-started': onTaskStarted,
  'task-output': onTaskOutput,
  'task-heartbeat': onTaskHeartbeat,
  'task-suspicious': onTaskSuspicious,
  'task-completed': onTaskCompleted,
  'task-failed': onTaskFailed,
  'task-killed': onTaskKilled,
  // 定时器域两事件（F6 T-CF-04 数据面；唤醒走 steering 面，前端显式空实现）
  'timer-fired': onTimerFired,
  'timer-cancelled': onTimerCancelled,
  // Cron 域（F9 T-CF-08 数据面；唤醒走 steering 面，前端显式空实现）
  'cron-fired': onCronFired,
  // 连续性与恢复域（D8 §3.7）
  'recovery-escalated': onRecoveryEscalated,
  'recovery-steering': onRecoverySteering,
  'recovery-fork': onRecoveryFork,
  'recovery-report': onRecoveryReport,
  'recovery-budget-denied': onRecoveryBudgetDenied,
  'goal-round-started': onGoalRoundStarted,
  'goal-round-completed': onGoalRoundCompleted,
  'goal-continuation-decided': onGoalContinuationDecided,
  // 观测与中控增强域（D-03）
  'steering-evaluated': onSteeringEvaluated,
  'control-intent': onControlIntent,
  'hook-outcome': onHookOutcome,
  'summary-background': onSummaryBackground,
  'stage-summary-milestone': onStageSummaryMilestone,
  'nudge-enqueued': onNudgeEnqueued,
  'recovery-acknowledged': onRecoveryAcknowledged,
  'recovery-retry-attempted': onRecoveryRetryAttempted,
  'provider-request-anchored': onProviderRequestAnchored,
  // 撤回域（T1a 统一输入流收敛战役，显式空实现）
  'timeline-truncate': onTimelineTruncate,
};

type LegacyHandler = (env: HandlerEnv, envelope: LegacyEnvelope) => void;

export const legacyDispatchTable: Record<LegacyEventType, LegacyHandler> = {
  'subagent-started': onSubagentStarted,
  'subagent-event': onSubagentEvent,
  'subagent-ended': onSubagentEnded,
  error: onError,
};

/** 统一分派：engine 信封走生成类型分派表，legacy 信封走遗留表 */
export function dispatchEvent(
  env: HandlerEnv,
  envelope: EngineEnvelope<EngineEventType> | LegacyEnvelope
): void {
  if (envelope.kind !== 'engine') {
    legacyDispatchTable[envelope.type](env, envelope);
    return;
  }
  const handler = engineDispatchTable[
    envelope.type
  ] as EngineHandler<EngineEventType>;
  handler(env, envelope);
}
