import { describe, expect, it } from 'vitest';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';

describe('draftSession', () => {
  it('PENDING_DRAFT_SESSION_ID is the stable pending sentinel', () => {
    expect(PENDING_DRAFT_SESSION_ID).toBe('__pending_draft__');
  });

  it('isPendingDraft is true only for the pending sentinel', () => {
    expect(isPendingDraft(PENDING_DRAFT_SESSION_ID)).toBe(true);
    expect(isPendingDraft('__pending_draft__')).toBe(true);
  });

  it('isPendingDraft is false for real ids / empty / nullish', () => {
    expect(isPendingDraft('sess-123')).toBe(false);
    expect(isPendingDraft('real')).toBe(false);
    expect(isPendingDraft('')).toBe(false);
    expect(isPendingDraft(null)).toBe(false);
    expect(isPendingDraft(undefined)).toBe(false);
    // near-misses must not match
    expect(isPendingDraft('__pending_draft')).toBe(false);
    expect(isPendingDraft('pending_draft')).toBe(false);
    expect(isPendingDraft(' __pending_draft__ ')).toBe(false);
  });
});
