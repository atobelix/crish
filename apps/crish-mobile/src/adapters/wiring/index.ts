// 观测面接线层 barrel（R2-05：设备帧 → store 动作 / 相位投影 / 重连对账 / 装配）
export {
  FeedBridge,
  MAX_ACTIVE_WINDOWS,
  RESUME_PAGE_SIZE,
  feedNetworkOf,
} from './feedBridge';
export type { FeedBridgeOptions, ListSessionsRepository } from './feedBridge';
export { dispatchIngestActions } from './ingestRouter';
export type { IngestDispatchOptions } from './ingestRouter';
export { devicePresenceStore } from './devicePresenceStore';
export type { DevicePresenceState } from './devicePresenceStore';
export {
  startObservationWiring,
  ensureObservationWiring,
  getObservationWiring,
  resetObservationWiringForTest,
} from './observationWiring';
export type {
  ObservationWiring,
  ObservationWiringOptions,
} from './observationWiring';
export {
  ApprovalBridge,
  startApprovalWiring,
  ensureApprovalWiring,
  getApprovalWiring,
  resetApprovalWiringForTest,
  enqueueApprovalDecision,
  approvalOutboxCount,
  resetApprovalOutboxForTest,
  buildApproveRequest,
  buildDenyRequest,
  gatewayListPendingApprovals,
  mapReconcileApprovalItem,
} from './approvalWiring';
export type {
  ApprovalWiring,
  ApprovalWiringOptions,
  ApprovalCommandRequest,
  ListPendingApprovalsRepository,
} from './approvalWiring';
export {
  PairingWiring,
  startPairingWiring,
  ensurePairingWiring,
  getPairingWiring,
  resetPairingWiringForTest,
  buildAuthPersist,
  buildSessionGateway,
  buildSignedRequest,
  randomNonce,
  defaultConnectSession,
  PAIRING_META_DEVICE_ID_KEY,
  PAIRING_META_DESKTOP_ID_KEY,
  PAIRING_META_HOST_KEY,
  DEFAULT_DEVICE_NAME,
} from './pairingWiring';
export type {
  PairingWiringOptions,
  PairingInput,
  PairingStartResult,
  PairingSessionContext,
  PairingWiringError,
  PairingSnapshot,
  SessionConnector,
} from './pairingWiring';
