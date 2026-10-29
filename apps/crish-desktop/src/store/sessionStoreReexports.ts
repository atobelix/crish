/**
 * sessionStore 公共再导出清单（会话索引工具 / 相等性指纹 / 域类型）。
 * 拆分来源：store/sessionStore.ts（行数门禁收口，`export *` 公共面等价）。
 */

export {
  getSessionById as getSessionByIdFromState,
  buildSessionIndex,
  selectSessionList,
  reorderSessionOrderById,
  reorderSessionOrderByIdList,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
} from './sessionIndex';

export {
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
} from './sessionSidebarProjection';

export type { SessionsIndexIssue } from './sessionIndex';

export type {
  FilterSidebarSessionsOpts,
  PartitionSidebarSessionsOpts,
  PartitionedSidebarSessions,
} from './sessionSidebarProjection';

export {
  sessionShellEqual,
  sidebarSessionsEqual,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sessionShellFingerprint,
} from './sessionListEqual';

export type { SessionActions } from './sessionActions';
export type { SessionMeta } from './sessionMeta';
export type { SessionState, SessionAgent, SessionMessage } from './types';
