// DAO 汇总出口（仅保留真实接线 DAO）
export type { SettingRow, SettingsDao } from './settingsDao';
export { SqlSettingsDao } from './settingsDao';
export type { NotificationRow, NotificationsDao } from './notificationsDao';
export { SqlNotificationsDao } from './notificationsDao';
export type { ApprovalQueueDao, ApprovalQueueRow } from './approvalQueueDao';
export { SqlApprovalQueueDao, rowToOutboxItem } from './approvalQueueDao';
export type {
  LocalThreadsDao,
  LocalThreadRow,
  LocalMessageRow,
  LocalMessageWithThread,
} from './localThreadsDao';
export {
  SqlLocalThreadsDao,
  rowToThreadMeta,
  rowToLocalMessage,
} from './localThreadsDao';
export type { RemoteSessionRow, RemoteSessionDao } from './remoteSessionDao';
export { SqlRemoteSessionDao } from './remoteSessionDao';
export type { RemoteEventRow, RemoteEventDao } from './remoteEventDao';
export { SqlRemoteEventDao } from './remoteEventDao';
export type { RemoteSyncStateRow, RemoteSyncDao } from './remoteSyncDao';
export { SqlRemoteSyncDao } from './remoteSyncDao';
