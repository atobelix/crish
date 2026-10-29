// approvalAttention 单测：只有用户裁决、仍待决的条目计入
import type { PermissionRequest } from '@crish/shared-types';
import type { ApprovalItem } from '@/domain/types/domain';
import { countUserDecisions, needsUserDecision } from './approvalAttention';

const NOW = 1_800_000_000_000;

const request: PermissionRequest = {
  id: 'approval-call-1',
  sessionId: 's-1',
  cwd: 'C:\\work',
  toolCallId: 'call-1',
  toolName: 'write_file',
  parameters: { path: 'a.ts' },
  summary: 'write a.ts',
  toolMetadata: {},
};

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    request,
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: NOW,
    expiresAt: NOW + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

describe('needsUserDecision', () => {
  it.each(['pending', 'deciding', 'queued'] as const)(
    '用户裁决 + %s → 需要处理',
    (status) => {
      expect(needsUserDecision(makeItem({ status }))).toBe(true);
    }
  );

  it.each(['approved', 'denied', 'expired', 'conflict'] as const)(
    '终态 %s → 不需要处理',
    (status) => {
      expect(needsUserDecision(makeItem({ status }))).toBe(false);
    }
  );

  it('主 agent 裁决的条目不算用户待办', () => {
    expect(needsUserDecision(makeItem({ arbiter: 'main-agent' }))).toBe(false);
  });
});

describe('countUserDecisions', () => {
  it('只统计用户待决条目', () => {
    expect(
      countUserDecisions([
        makeItem(),
        makeItem({ status: 'queued' }),
        makeItem({ status: 'expired' }),
        makeItem({ arbiter: 'main-agent' }),
      ])
    ).toBe(2);
  });

  it('空列表为 0', () => {
    expect(countUserDecisions([])).toBe(0);
  });
});
