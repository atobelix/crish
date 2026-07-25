import { describe, expect, it } from 'vitest';
import { DaemonApprovalHandler } from './daemon-approval-handler';
import { ApprovalQueue } from './approval-queue';
import type { PermissionDecision, PermissionRequest } from '@crish/shared-types';

function createRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'req_1',
    sessionId: 'session_1',
    cwd: '/tmp',
    toolCallId: 'tool_1',
    toolName: 'write_file',
    parameters: { path: '/tmp/test.txt', content: 'hello' },
    summary: 'Write test.txt',
    toolMetadata: { category: 'fs-write', isReadOnly: false },
    ...overrides,
  };
}

describe('DaemonApprovalHandler', () => {
  it('records denied intents and auto-denies subsequent same intent', async () => {
    const queue = new ApprovalQueue({});
    const handler = new DaemonApprovalHandler(queue, 'run_1');

    const req1 = createRequest({ toolCallId: 'tool_1' });
    const promise1 = handler.requestApproval(req1);
    queue.resolve('tool_1', 'denied');
    const result1: PermissionDecision = await promise1;
    expect(result1.behavior).toBe('deny');
    expect(result1.metadata).toMatchObject({ retryable: false });

    const req2 = createRequest({ toolCallId: 'tool_2' });
    const promise2 = handler.requestApproval(req2);
    const result2: PermissionDecision = await promise2;
    expect(result2.behavior).toBe('deny');
    expect(result2.metadata).toMatchObject({ retryable: false });
  });

  it('injects retryable: false on denial', async () => {
    const queue = new ApprovalQueue({});
    const handler = new DaemonApprovalHandler(queue, 'run_2');

    const promise = handler.requestApproval(createRequest({ toolCallId: 'tool_a' }));
    queue.resolve('tool_a', 'denied');
    const result: PermissionDecision = await promise;
    expect(result.behavior).toBe('deny');
    expect(result.metadata).toMatchObject({ retryable: false });
  });
});
