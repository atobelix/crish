import { describe, expect, it, vi } from 'vitest';
import {
  daemonApproveTool,
  daemonDenyTool,
  parseApprovalResolvedFields,
} from './ApprovalHandler';
import { getDesktopDaemonClient } from '../daemonClient';

vi.mock('../daemonClient', () => {
  const sendMock = vi.fn().mockResolvedValue(undefined);
  return {
    getDesktopDaemonClient: () => ({
      send: sendMock,
    }),
  };
});

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
    it('sends approve-tool message via daemon client', async () => {
      await daemonApproveTool('tc-999', 'project');
      const client = getDesktopDaemonClient();
      expect(client.send).toHaveBeenCalledWith({
        type: 'approve-tool',
        toolCallId: 'tc-999',
        scope: 'project',
      });
    });

    it('sends deny-tool message via daemon client', async () => {
      await daemonDenyTool('tc-888');
      const client = getDesktopDaemonClient();
      expect(client.send).toHaveBeenCalledWith({
        type: 'deny-tool',
        toolCallId: 'tc-888',
      });
    });
  });
});
