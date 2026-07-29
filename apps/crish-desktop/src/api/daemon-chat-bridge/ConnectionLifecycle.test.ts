import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureDaemonConnected,
} from './ConnectionLifecycle';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import { getDesktopDaemonClient } from '../daemonClient';
import {
  getControlMetrics,
  resetControlMetrics,
} from '../controlMetrics';

const { send, streamViaDirectFetch } = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  streamViaDirectFetch: vi.fn().mockReturnValue(() => undefined),
}));

vi.mock('../daemonClient', () => {
  const startKeepAlive = vi.fn();
  const waitUntilConnected = vi.fn().mockResolvedValue(true);
  const request = vi.fn().mockResolvedValue({ status: 'ok' });
  const isConnected = vi.fn().mockReturnValue(true);
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

vi.mock('../directFetchBridge', () => ({
  streamViaDirectFetch,
}));

vi.mock('../projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectStore')>();
  return {
    ...actual,
    getWorkspacePath: () => 'C:/tmp/ws',
  };
});

vi.mock('../storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storeAccess')>();
  return {
    ...actual,
    getPermissionMode: () => 'ask',
  };
});

vi.mock('../clientApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientApi')>();
  return {
    ...actual,
    clientApi: {
      ...actual.clientApi,
      getSettingsEx: vi.fn().mockResolvedValue({
        defaultThinkingLevel: 'medium',
        responseStyle: 'medium',
      }),
    },
  };
});

describe('ConnectionLifecycle', () => {
  beforeEach(() => {
    send.mockClear();
    streamViaDirectFetch.mockClear();
    resetControlMetrics();
    const client = getDesktopDaemonClient();
    vi.mocked(client.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(client.isConnected).mockReturnValue(true);
  });

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

  describe('createStreamSession clientMessageId wire', () => {
    it('run-task 携带 user/assistant clientMessageId', async () => {
      const onRunError = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
        onRunError,
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
      };
      const client = getDesktopDaemonClient();
      // 强制走 daemon 分支（非 directFetch），避免其它用例污染连接 mock
      vi.mocked(client.waitUntilConnected).mockResolvedValue(true);
      vi.mocked(client.isConnected).mockReturnValue(true);
      const finish = vi.fn();

      await createStreamSession(
        client,
        'hello',
        'sess-id-1',
        'run-id-1',
        callbacks,
        {
          clientMessageId: 'user-msg-fixed-1',
          assistantClientMessageId: 'assistant-msg-fixed-1',
        },
        state,
        () => undefined,
        finish,
        'assistant-msg-fixed-1',
      );

      expect(onRunError).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run-task',
          runId: 'run-id-1',
          sessionId: 'sess-id-1',
          prompt: 'hello',
          clientMessageId: 'user-msg-fixed-1',
          assistantClientMessageId: 'assistant-msg-fixed-1',
        }),
      );
      expect(getControlMetrics().transport_degraded_direct_fetch).toBe(0);
      expect(streamViaDirectFetch).not.toHaveBeenCalled();
    });
  });

  describe('createStreamSession degraded directFetch (OPT-F7 / kill #10)', () => {
    it('records transport_degraded_direct_fetch when daemon WS not ready', async () => {
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: null,
        endTimer: null,
        transportAbort: null,
      };
      const client = getDesktopDaemonClient();
      vi.mocked(client.waitUntilConnected).mockResolvedValue(false);
      vi.mocked(client.isConnected).mockReturnValue(false);
      const finish = vi.fn();

      await createStreamSession(
        client,
        'offline prompt',
        'sess-degraded-1',
        'run-degraded-1',
        callbacks,
        undefined,
        state,
        () => undefined,
        finish,
      );

      expect(send).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(streamViaDirectFetch).toHaveBeenCalledTimes(1);
      expect(streamViaDirectFetch).toHaveBeenCalledWith(
        'offline prompt',
        callbacks,
        'sess-degraded-1',
        'run-degraded-1',
        undefined,
      );
      expect(getControlMetrics().transport_degraded_direct_fetch).toBe(1);
      expect(typeof state.transportAbort).toBe('function');

      // second fallback accumulates (counter, not latch)
      await createStreamSession(
        client,
        'offline prompt 2',
        'sess-degraded-2',
        'run-degraded-2',
        callbacks,
        undefined,
        state,
        () => undefined,
        finish,
      );
      expect(getControlMetrics().transport_degraded_direct_fetch).toBe(2);
    });
  });

  describe('createStreamCancel', () => {
    it('cancels stream and notifies daemon client', async () => {
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
      expect(onComplete).toHaveBeenCalled();
      // 无参默认 force（L3）：async dispatch 经 runControl 门面
      await vi.waitFor(() => {
        expect(client.send).toHaveBeenCalledWith({
          type: 'run-control',
          level: 'force_cancel',
          runId: 'run-test-1',
          reason: 'ui-force-cancel',
        });
        expect(client.send).toHaveBeenCalledWith({
          type: 'cancel-run',
          runId: 'run-test-1',
          mode: 'force',
        });
      });
    });

    it('cooperative mode sends run-control L2 + cancel-run mode=cooperative', async () => {
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
        'run-coop-1',
        callbacks,
        approvalFlow,
        cleanup,
        state
      );

      cancel({ mode: 'cooperative' });

      await vi.waitFor(() => {
        expect(client.send).toHaveBeenCalledWith({
          type: 'run-control',
          level: 'cooperative_stop',
          runId: 'run-coop-1',
          reason: 'ui-stop',
        });
        expect(client.send).toHaveBeenCalledWith({
          type: 'cancel-run',
          runId: 'run-coop-1',
          mode: 'cooperative',
        });
      });
    });
  });
});
