import { describe, expect, it } from 'vitest';
import type { AgentMessage, PermissionDecision, ToolResultBlock } from '@crish/shared-types';
import {
  buildPermissionDenyToolOutput,
  detectRecentToolErrorLoop,
  formatPermissionDenyReason,
} from './runtime-helpers';

describe('buildPermissionDenyToolOutput', () => {
  it('expands bare user-denied with retryable:false and stronger replan copy', () => {
    const decision = {
      behavior: 'deny',
      reason: 'user-denied',
    } as PermissionDecision;

    const out = buildPermissionDenyToolOutput(decision);
    expect(out.text).toMatch(/用户拒绝|choose an alternative|do not re-request|do not assume/i);
    expect(out.json).toMatchObject({
      softDeny: true,
      code: 'user_denied',
      retryable: false,
    });
  });

  it('preserves denylist softDeny envelope with retryable:false', () => {
    const decision = {
      behavior: 'deny',
      reason:
        '用户已拒绝相同操作意图；请改用其他方案，勿重复请求同一审批。User already denied this operation intent — choose an alternative; do not re-request the same approval.',
      metadata: {
        softDeny: true,
        matchedRule: 'run-intent-denylist',
        code: 'user_denied',
        intentKey: 'T1|write|edit|edit-family',
      },
    } as PermissionDecision;

    const out = buildPermissionDenyToolOutput(decision);
    expect(out.text).toMatch(/勿重复请求|do not re-request/i);
    expect(out.json).toMatchObject({
      softDeny: true,
      code: 'user_denied',
      retryable: false,
      matchedRule: 'run-intent-denylist',
    });
  });

  it('marks approval_expired as softDeny with retryable true by default', () => {
    const decision = {
      behavior: 'deny',
      reason: 'Approval timed out; operation skipped — retry later or continue with other steps',
      metadata: {
        softDeny: true,
        approval: { status: 'expired', reason: 'timeout' },
      },
    } as PermissionDecision;

    const out = buildPermissionDenyToolOutput(decision);
    expect(out.json).toMatchObject({
      softDeny: true,
      code: 'approval_expired',
      retryable: true,
    });
  });

  it('formatPermissionDenyReason expands bare Denied', () => {
    expect(
      formatPermissionDenyReason({
        behavior: 'deny',
        reason: 'Denied',
      } as PermissionDecision)
    ).toMatch(/choose an alternative|do not re-request/i);
  });
});

describe('detectRecentToolErrorLoop', () => {
  function toolResultMessage(
    blocks: Array<Partial<ToolResultBlock> & { toolCallId: string; toolName: string }>
  ): AgentMessage {
    return {
      id: 'm1',
      role: 'tool',
      createdAt: new Date().toISOString(),
      blocks: blocks.map((b) => ({
        type: 'tool-result' as const,
        toolCallId: b.toolCallId,
        toolName: b.toolName,
        isError: b.isError ?? true,
        output: b.output ?? { text: 'err' },
      })),
    };
  }

  it('does not count softDeny+user_denied toward tool-error recovery', () => {
    const messages: AgentMessage[] = [
      toolResultMessage([
        {
          toolCallId: 'c1',
          toolName: 'edit',
          isError: true,
          output: {
            text: 'user denied',
            json: { softDeny: true, code: 'user_denied', retryable: false },
          },
        },
      ]),
      toolResultMessage([
        {
          toolCallId: 'c2',
          toolName: 'edit',
          isError: true,
          output: {
            text: 'denylist',
            json: {
              softDeny: true,
              code: 'user_denied',
              matchedRule: 'run-intent-denylist',
              retryable: false,
            },
          },
        },
      ]),
    ];

    expect(detectRecentToolErrorLoop(messages, 2)).toBeUndefined();
  });

  it('still detects consecutive real tool errors', () => {
    const messages: AgentMessage[] = [
      toolResultMessage([
        {
          toolCallId: 'c1',
          toolName: 'shell',
          isError: true,
          output: { text: 'boom', json: { exitCode: 1 } },
        },
      ]),
      toolResultMessage([
        {
          toolCallId: 'c2',
          toolName: 'shell',
          isError: true,
          output: { text: 'boom2', json: { exitCode: 1 } },
        },
      ]),
    ];

    expect(detectRecentToolErrorLoop(messages, 2)).toBe('tool-errors');
  });
});
