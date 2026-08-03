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
  // 缓存测量域三事件（P5 S3；T-38 先注册显式空实现，宽容静默忽略——
  // 对齐老前端不识别新事件类型的 tolerance，T-48 负责真实展示消费接线）
  'cache-stats-updated': (_env, _envelope) => {},
  'cache-waste-alert': (_env, _envelope) => {},
  'cold-cache-warning': (_env, _envelope) => {},
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
