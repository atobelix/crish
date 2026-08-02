import { describe, expect, it, vi } from 'vitest';
import {
  engineApproveTool,
  engineDenyTool,
  parseApprovalResolvedFields,
} from './ApprovalHandler';

const { fakeTransport } = vi.hoisted(() => {
  const fakeTransport = {
    send: vi.fn(async () => undefined),
  };
  return { fakeTransport };
});

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
}));

describe('ApprovalHandler', () => {
  describe('parseApprovalResolvedFields', () => {
    it('successfully parses allow decision', () => {
      const res = parseApprovalResolvedFields({
        toolCallId: 'tc-123',
        decision: 'allow',
        denied: false,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({
          toolCallId: 'tc-123',
          denied: false,
          decision: 'allow',
        });
      }
    });

    it('returns error when toolCallId is empty', () => {
      const res = parseApprovalResolvedFields({
        toolCallId: '   ',
        decision: 'allow',
      });
      expect(res.ok).toBe(false);
    });

    it('maps non-allow decision to deny', () => {
      const res = parseApprovalResolvedFields({
        toolCallId: 'tc-456',
        decision: 'deny',
        denied: true,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.decision).toBe('deny');
        expect(res.data.denied).toBe(true);
      }
    });
  });

  describe('engineApproveTool and engineDenyTool', () => {
    it('core_approve_tool 经 transport.send 命令名直发', async () => {
      await engineApproveTool('tc-999', 'project');
      expect(fakeTransport.send).toHaveBeenCalledWith('core_approve_tool', {
        toolCallId: 'tc-999',
        scope: 'project',
      });
    });

    it('core_deny_tool 经 transport.send 命令名直发', async () => {
      await engineDenyTool('tc-888');
      expect(fakeTransport.send).toHaveBeenCalledWith('core_deny_tool', {
        toolCallId: 'tc-888',
      });
    });
  });
});
