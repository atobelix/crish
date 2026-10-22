import type { SessionState } from './sessionStore';
import type { SessionMeta, SessionMetaExtensions } from './sessionSubtreeModel';
import { shallowArrayEqual, shallowRecordEqual } from './sessionSubtreeModel';

/** 零反射固定字段比对：判断 SessionMeta 与目标会话状态元数据是否一致（首行引用相等短路） */
export function isSessionMetaEqual(
  prev: SessionMeta | undefined,
  sess: (SessionState & SessionMetaExtensions) | SessionMeta | undefined
): boolean {
  if (prev === sess) return Boolean(prev);
  if (!prev || !sess) return false;
  const s = sess as SessionMeta;
  if (
    prev.id !== s.id ||
    prev.title !== s.title ||
    prev.folder !== s.folder ||
    Boolean(prev.isPinned) !== Boolean(s.isPinned) ||
    Boolean(prev.isArchived) !== Boolean(s.isArchived) ||
    prev.timestamp !== s.timestamp ||
    prev.titleSource !== s.titleSource ||
    prev.branchParentId !== s.branchParentId ||
    prev.timestampSource !== s.timestampSource ||
    prev.engineCursor !== s.engineCursor ||
    prev.engineLastRunId !== s.engineLastRunId ||
    Boolean(prev.hydratedFromEngine) !== Boolean(s.hydratedFromEngine) ||
    Boolean(prev.messagesHydrated) !== Boolean(s.messagesHydrated) ||
    prev.messageCount !== s.messageCount ||
    Boolean(prev.hasOlderMessages) !== Boolean(s.hasOlderMessages) ||
    prev.oldestLoadedSeq !== s.oldestLoadedSeq ||
    Boolean(prev.hydrateTruncated) !== Boolean(s.hydrateTruncated) ||
    prev.goalMode !== s.goalMode ||
    prev.unreadCount !== s.unreadCount ||
    prev.createdAt !== s.createdAt ||
    prev.updatedAt !== s.updatedAt ||
    prev.activeAgentId !== s.activeAgentId
  ) {
    return false;
  }
  if (
    prev.pinnedMessageIds !== s.pinnedMessageIds &&
    !shallowArrayEqual(prev.pinnedMessageIds, s.pinnedMessageIds)
  ) {
    return false;
  }
  if (
    prev.truncatedToolChainIds !== s.truncatedToolChainIds &&
    !shallowArrayEqual(prev.truncatedToolChainIds, s.truncatedToolChainIds)
  ) {
    return false;
  }
  if (
    prev.pinnedMessageColors !== s.pinnedMessageColors &&
    !shallowRecordEqual(prev.pinnedMessageColors, s.pinnedMessageColors)
  ) {
    return false;
  }
  if (
    prev.importMeta !== s.importMeta &&
    !shallowRecordEqual(prev.importMeta, s.importMeta)
  ) {
    return false;
  }
  return true;
}
