/**
 * §5.3：确认签名按 session 分桶；销毁清理
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetWorkflowConfirmSignaturesForTests,
  __workflowConfirmBucketCountForTests,
  clearWorkflowConfirmSignaturesForSession,
  getConfirmedBucket,
  getPayloadSignature,
} from './workflowConfirmSignatures';

describe('workflowConfirmSignatures §5.3', () => {
  beforeEach(() => {
    __resetWorkflowConfirmSignaturesForTests();
  });

  it('buckets signatures per session and cleans on destroy', () => {
    const payload = {
      name: 't',
      prompt: 'p',
      scheduleType: 'manual' as const,
    };
    const sig = getPayloadSignature(payload);
    getConfirmedBucket('sess-a').add(sig);
    getConfirmedBucket('sess-b').add(sig);
    expect(__workflowConfirmBucketCountForTests()).toBe(2);
    expect(getConfirmedBucket('sess-a').has(sig)).toBe(true);

    clearWorkflowConfirmSignaturesForSession('sess-a');
    expect(__workflowConfirmBucketCountForTests()).toBe(1);
    expect(getConfirmedBucket('sess-a').has(sig)).toBe(false);
    expect(getConfirmedBucket('sess-b').has(sig)).toBe(true);
  });
});
