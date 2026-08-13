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
export { filesStore } from './filesStore';
export type { FilesState } from './filesStore';
export type {
  FilesTreeState,
  DirLoadState,
  DirSortMode,
} from './filesReducers';
export type { FileEntry } from '../types/domain';

// ── R2-14 第一波：authStore / connectionStore 追加导出（只追加，不改既有行）────
export { configureAuthPersistence } from './authStore';
export type {
  AuthIdentityMeta,
  AuthPersist,
  PairingMeta,
  PairingStage,
  TokenMeta,
} from './authStore';
export type { ConnectionEndpoint } from './connectionStore';
export {
  CONNECTION_PHASE_TEXT,
  mapWsPhase,
  selectConnectionPhaseText,
} from './connectionStore';
export type { WsPhase } from './connectionStore';
export { transitionPairState } from './authReducers';

// ── R2-14 第三波：terminalStore / settingsStore / notificationStore 追加导出（只追加）────
export { terminalStore, linesOf } from './terminalStore';
export type { TerminalState } from './terminalStore';
export type { TerminalRunState, TerminalView } from './terminalReducers';
export { settingsStore, configureSettingsPersistence } from './settingsStore';
export type { SettingsState, SettingsPersist } from './settingsStore';
export type {
  AppearancePrefs,
  FilesPrefs,
  GeneralPrefs,
  NotifyPrefs,
  NotifyQuietPrefs,
  NotifyScene,
  QuietPolicy,
  ResponseStyle,
  SettingsGroupName,
  SettingsGroups,
} from './settingsReducers';
export {
  SETTINGS_KEY_PREFIX,
  defaultSettingsGroups,
  mergeSettingsGroup,
  settingsGroupKey,
} from './settingsReducers';
export {
  notificationStore,
  configureNotificationsPersistence,
  listOf,
  resetNotificationsForTest,
  unreadOf,
} from './notificationStore';
export type {
  NotificationState,
  NotificationsPersist,
} from './notificationStore';
export type {
  InAppNotification,
  NotificationInput,
  NotificationStatus,
} from './notificationReducers';
export { NOTIFICATION_RESOLVED_RETENTION_MS } from './notificationReducers';
