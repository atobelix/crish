/**
 * 草稿会话：点击「新对话」后、发送第一条消息前的虚拟态。
 * 不写入 sessions 列表，不持久化，不显示在侧栏。
 *
 * @see docs/architecture/session-pending-draft-adr.md
 */

export const PENDING_DRAFT_SESSION_ID = '__pending_draft__';

/** 是否处于草稿态（未发送过消息的新对话） */
export function isPendingDraft(sessionId: string | null | undefined): boolean {
  return sessionId === PENDING_DRAFT_SESSION_ID;
}
