// store 域 barrel（对齐桌面 store/index.ts 公共面形态；R2-14 按三波扩充 8 个 store）
export { authStore } from './authStore';
export type { AuthState, PairState } from './authStore';
export { connectionStore } from './connectionStore';
export type { ConnectionState, ConnectionPhase } from './connectionStore';
export { approvalStore } from './approvalStore';
export type { ApprovalState } from './approvalStore';
export type {
  ApprovalItem,
  ApprovalRecord,
  ApprovalRiskMeta,
} from '../types/domain';
export { eventStore, lastSeqOf, windowOf } from './eventStore';
export type { EventState, FeedNetwork } from './eventStore';
export type {
  EventEnvelopeFrame,
  EventWindow,
  FeedEntry,
  FeedFilter,
} from './eventReducers';
export { sessionStore, selectedSessionOf } from './sessionStore';
export type { SessionState } from './sessionStore';
export type { SessionSummary } from './sessionReducers';
export type { StoreIngestAction } from './eventMappers';
