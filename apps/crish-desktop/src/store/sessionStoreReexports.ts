/**
 * sessionStore 公共再导出清单（会话索引工具 / 相等性指纹 / 域类型）。
 * 拆分来源：store/sessionStore.ts（行数门禁收口，`export *` 公共面等价）。
 */

export {
  getSessionById as getSessionByIdFromState,
  getSessionMetaById,
  buildSessionsById,
  reindexSessionsById,
  reorderSessionOrderById,
  reorderSessionOrderByIdList,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
} from './sessionIndex';

export type {
  SessionsIndexIssue,
  FilterSidebarSessionsOpts,
  PartitionSidebarSessionsOpts,
  PartitionedSidebarSessions,
} from './sessionIndex';

export {
  sessionShellEqual,
  sidebarSessionsEqual,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sessionShellFingerprint,
} from './sessionListEqual';

export type { SessionActions } from './sessionActions';
export type { SessionMeta, SessionSubtreeSlice } from './sessionSubtreeModel';
export type { SessionState, SessionAgent, SessionMessage } from './types';
