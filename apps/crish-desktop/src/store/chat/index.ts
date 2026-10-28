/**
 * apps/crish-desktop/src/store/chat/index.ts
 *
 * 统一会话生命周期、DualLatch 终态协议与流式状态协调导出入口 (E3-01)
 */

export * from '../sessionDeleteTransition';
export {
  dualLatchStateMachine,
  DualLatchStateMachine,
  executeDualRafHandoff,
  scheduleDualRafHandoff,
  scheduleDualRafClearStream,
  scheduleDualRafClearStreams,
  makeDualLatchKey,
  type DualLatchPhase,
  type DualLatchTurnRecord,
} from '../dualLatchProtocol';
export {
  sessionCascadeCancellation,
  SessionCascadeCancellation,
  isSessionTombstoned,
  markSessionTombstone,
  recordTombstone,
  cancelSessionCascade,
  DEFAULT_TOMBSTONE_CAPACITY,
} from '../sessionCascadeCancellation';
export {
  SessionCoordinator,
  deleteSessionCascade,
} from '../SessionCoordinator';
export { useStreamingStore } from '../streamingStore';
