// DAO 汇总出口（仅保留真实接线 DAO）
export type { SettingRow, SettingsDao } from './settingsDao';
export { SqlSettingsDao } from './settingsDao';
export type { NotificationRow, NotificationsDao } from './notificationsDao';
export { SqlNotificationsDao } from './notificationsDao';
export type { ApprovalQueueDao, ApprovalQueueRow } from './approvalQueueDao';
export { SqlApprovalQueueDao, rowToOutboxItem } from './approvalQueueDao';
