import { describe, expect, it, vi } from 'vitest';
import {
  createFinishController,
  createStreamCancel,
  ensureDaemonConnected,
} from './ConnectionLifecycle';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import { getDesktopDaemonClient } from '../daemonClient';

vi.mock('../daemonClient', () => {
  const startKeepAlive = vi.fn();
  const waitUntilConnected = vi.fn().mockResolvedValue(true);
  const request = vi.fn().mockResolvedValue({ status: 'ok' });
  const isConnected = vi.fn().mockReturnValue(true);
  const send = vi.fn().mockResolvedValue(undefined);
  const onMessage = vi.fn().mockReturnValue(() => undefined);
  const getUrl = vi.fn().mockReturnValue('ws://localhost:18800');

  return {
    getDesktopDaemonClient: () => ({
      startKeepAlive,
      waitUntilConnected,
      request,
      isConnected,
      send,
      onMessage,
      getUrl,
    }),
  };
});

describe('ConnectionLifecycle', () => {
  describe('ensureDaemonConnected', () => {
    it('returns ok: true when daemon responds', async () => {
      const res = await ensureDaemonConnected();
      expect(res.ok).toBe(true);
      expect(res.url).toBe('ws://localhost:18800');
    });
  });

  describe('createFinishController', () => {
    it('invokes onComplete when finishing stream state', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };

      const controller = createFinishController(
        approvalFlow,
        callbacks,
        cleanup,
        state
      );

      controller.finish(true);

      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
    });
  });

  describe('createStreamCancel', () => {
    it('cancels stream and notifies daemon client', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };
      const client = getDesktopDaemonClient();

      const cancel = createStreamCancel(
        client,
        'run-test-1',
        callbacks,
        approvalFlow,
        cleanup,
        state
      );

      cancel();

      expect(state.cancelled).toBe(true);
      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(client.send).toHaveBeenCalledWith({
        type: 'cancel-run',
        runId: 'run-test-1',
      });
      expect(onComplete).toHaveBeenCalled();
    });
  });
});
