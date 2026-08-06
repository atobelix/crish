import { describe, expect, it } from 'vitest';
import {
  PENDING_DRAFT,
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
  isPendingDraftSessionId,
} from './draftSession';
import { PENDING_DRAFT_SESSION_ID as SHARED_ID } from '@crish/shared-types';

describe('draftSession / shared-types 对齐', () => {
  it('PENDING_DRAFT 与 shared-types 同一引用与字面量', () => {
    expect(PENDING_DRAFT_SESSION_ID).toBe('__pending_draft__');
    expect(PENDING_DRAFT).toBe(PENDING_DRAFT_SESSION_ID);
    expect(PENDING_DRAFT_SESSION_ID).toBe(SHARED_ID);
    expect(PENDING_DRAFT).toBe(SHARED_ID);
  });

  it('isPendingDraft 与 isPendingDraftSessionId 一致', () => {
    expect(isPendingDraft(PENDING_DRAFT_SESSION_ID)).toBe(true);
    expect(isPendingDraftSessionId(PENDING_DRAFT_SESSION_ID)).toBe(true);
    expect(isPendingDraft(null)).toBe(false);
    expect(isPendingDraft('real-sess')).toBe(false);
  });
});
