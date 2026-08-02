import { describe, expect, it, vi } from 'vitest';
import {
  daemonApproveTool,
  daemonDenyTool,
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

  describe('daemonApproveTool and daemonDenyTool', () => {
    it('approve-tool 经 transport.send（commandMap 翻译 core_approve_tool）', async () => {
      await daemonApproveTool('tc-999', 'project');
      expect(fakeTransport.send).toHaveBeenCalledWith('approve-tool', {
        toolCallId: 'tc-999',
        scope: 'project',
      });
    });

    it('deny-tool 经 transport.send（commandMap 翻译 core_deny_tool）', async () => {
      await daemonDenyTool('tc-888');
      expect(fakeTransport.send).toHaveBeenCalledWith('deny-tool', {
        toolCallId: 'tc-888',
      });
    });
  });
});
