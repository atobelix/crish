/**
 * 草稿会话：点击「新对话」后、发送第一条消息前的虚拟态。
 * 不写入 sessions 列表，不持久化，不显示在侧栏。
 *
 * PENDING_DRAFT 真源：@crish/shared-types（session-identity），避免双常量漂移。
 *
 * @see docs/architecture/session-pending-draft-adr.md
 * @see packages/shared-types/src/session-identity.ts
 */

export {
  PENDING_DRAFT_SESSION_ID,
  PENDING_DRAFT,
  isPendingDraftSessionId,
  /** 历史 API 名：等价 isPendingDraftSessionId */
  isPendingDraftSessionId as isPendingDraft,
} from '@crish/shared-types';
