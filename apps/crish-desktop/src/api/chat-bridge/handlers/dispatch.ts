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
import {
  onMessageStart,
  onMessageDelta,
  onMessageEnd,
} from './messageHandlers';
import {
  onToolStart,
  onToolUpdate,
  onToolEnd,
  onToolBatchStart,
  onToolBatchEnd,
  onToolInputRepaired,
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
} from './taskEventHandlers';

export type EngineHandler<ET extends EngineEventType> = (
  env: HandlerEnv,
  envelope: EngineEnvelope<ET>
) => void;

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
  'tool-update': onToolUpdate,
  'tool-end': onToolEnd,
  'tool-batch-start': onToolBatchStart,
  'tool-batch-end': onToolBatchEnd,
  'tool-input-repaired': onToolInputRepaired,
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
  'subagent-started': onSubagentStarted as unknown as EngineHandler<'subagent-started'>,
  'subagent-event': onSubagentEvent as unknown as EngineHandler<'subagent-event'>,
  'subagent-ended': onSubagentEnded as unknown as EngineHandler<'subagent-ended'>,
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
