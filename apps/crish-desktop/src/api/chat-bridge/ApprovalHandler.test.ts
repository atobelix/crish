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
    it('core_approve_tool 经 transport.send 命令名直发（runId 必填，批 C 第 0 件）', async () => {
      await engineApproveTool('tc-999', 'run-9');
      expect(fakeTransport.send).toHaveBeenCalledWith('core_approve_tool', {
        runId: 'run-9',
        toolCallId: 'tc-999',
      });
    });

    it('core_deny_tool 经 transport.send 命令名直发（runId 必填）', async () => {
      await engineDenyTool('tc-888', 'run-8');
      expect(fakeTransport.send).toHaveBeenCalledWith('core_deny_tool', {
        runId: 'run-8',
        toolCallId: 'tc-888',
      });
    });

    it('runId 缺失 → 显式抛错且不发出必死请求（「批准失败」回归钉）', async () => {
      fakeTransport.send.mockClear();
      await expect(engineApproveTool('tc-1', '')).rejects.toThrow(/runId/);
      await expect(engineDenyTool('tc-1', '   ')).rejects.toThrow(/runId/);
      expect(fakeTransport.send).not.toHaveBeenCalled();
    });
  });
});
