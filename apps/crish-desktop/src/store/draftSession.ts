/**
 * 草稿会话：点击「新对话」后、发送第一条消息前的虚拟态。
 * 不写入 sessions 列表，不持久化，不显示在侧栏。
 *
 * PENDING_DRAFT 真源：@crish/shared-types（session-identity），避免双常量漂移。
 *
 * @see docs/architecture/session-pending-draft-adr.md
 * @see packages/shared-types/src/session-identity.ts
 */

import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraftSessionId,
} from '@crish/shared-types';

export { PENDING_DRAFT_SESSION_ID, isPendingDraftSessionId };

/**
 * 历史 API 名：等价 PENDING_DRAFT_SESSION_ID。
 * shared-types 仅导出 PENDING_DRAFT_SESSION_ID（session-identity 真源），
 * 该别名在本地保持（F-A 收尾对齐导出面）。
 */
export const PENDING_DRAFT = PENDING_DRAFT_SESSION_ID;

/** 历史 API 名：等价 isPendingDraftSessionId */
export const isPendingDraft = isPendingDraftSessionId;
