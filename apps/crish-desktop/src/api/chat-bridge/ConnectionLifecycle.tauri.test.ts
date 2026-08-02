/**
 * C1.2 Tauri IPC 路径测试（C3.1 后唯一路径）：mock '../transport'（getTransport 返回 fake Tauri transport），
 * 验证：
 * - run-task 经 startRunTask 分派（'core_run_task'，参数组装保留、不含 type 字段）
 * - 事件经 transport.onMessage → router.onMsg 全流程路由（消息→流→工具→收口）
 * - messageBelongsToRun 过滤不误杀（B6.3 注入 runId 后按 runId 精确路由）
 * - 核心未就绪时拒绝启动（C3.4 后无 directFetch 降级）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStreamSession,
  streamViaEngine,
} from './ConnectionLifecycle';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import {
  resetControlMetrics,
} from '../controlMetrics';

const { fakeTransport, startRunTask, messageListener } =
  vi.hoisted(() => {
    const messageListener = {
      current: null as ((msg: Record<string, unknown>) => void) | null,
    };
    const fakeTransport = {
      waitUntilConnected: vi.fn(async () => true),
      isReady: vi.fn(() => true),
      onMessage: vi.fn((cb: (msg: Record<string, unknown>) => void) => {
        messageListener.current = cb;
        return () => undefined;
      }),
      getStatus: vi.fn(() => 'connected' as const),
      onStatus: vi.fn(() => () => undefined),
      request: vi.fn(async () => ({ runId: 'r', sessionId: 's' })),
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    return {
      fakeTransport,
      startRunTask: vi.fn(async () => undefined),
      messageListener,
    };
  });

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
  startRunTask,
  resetTransportForTests: () => undefined,
  TauriTransport: class TauriTransport {},
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

describe('ConnectionLifecycle Tauri IPC 路径（C1.2）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    messageListener.current = null;
    startRunTask.mockClear();
    resetControlMetrics();
  });

  describe('createStreamSession：core_run_task 参数组装', () => {
    it('run-task 参数经 startRunTask 分派，且不再内嵌 type 字段', async () => {
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
      };
      const finish = vi.fn();

      await createStreamSession(
        'hello',
        'sess-id-1',
        'run-id-1',
        callbacks,
        {
          clientMessageId: 'user-msg-1',
          assistantClientMessageId: 'assistant-msg-1',
        },
        state,
        () => undefined,
        finish,
        'assistant-msg-1',
      );

      expect(finish).not.toHaveBeenCalled();
      expect(startRunTask).toHaveBeenCalledTimes(1);
      const [transport, params] = startRunTask.mock
        .calls[0] as [unknown, Record<string, unknown>];
      expect(transport).toBe(fakeTransport);
      expect(params).toEqual(
        expect.objectContaining({
          runId: 'run-id-1',
          prompt: 'hello',
          sessionId: 'sess-id-1',
          permissionMode: 'ask',
          clientMessageId: 'user-msg-1',
          assistantClientMessageId: 'assistant-msg-1',
        }),
      );
      // 通道名（core_run_task / run-task）由 startRunTask 分派，不再内嵌进 payload
      expect(params.type).toBeUndefined();
      // 事件订阅已挂在 transport.onMessage（懒订阅 listen('workbench-run-event') 的入口）
      expect(fakeTransport.onMessage).toHaveBeenCalledTimes(1);
      expect(messageListener.current).not.toBeNull();
    });

    it('核心未就绪（waitUntilConnected=false）→ 拒绝启动（C3.4 后无 directFetch 降级）', async () => {
      vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
      vi.mocked(fakeTransport.isReady).mockReturnValue(false);
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
      const finish = vi.fn();

      await createStreamSession(
        'offline ipc',
        'sess-t-2',
        'run-t-2',
        callbacks,
        undefined,
        state,
        () => undefined,
        finish,
      );

      expect(startRunTask).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalled();
      expect(onRunError).toHaveBeenCalled();
    });
  });

  describe('streamViaEngine：listen 事件流全流程（消息→流→工具→收口）', () => {
    it('平铺 IPC 事件经 transport.onMessage → router.onMsg 路由；runId 过滤不误杀', async () => {
      let capturedRunId = '';
      const onChunk = vi.fn();
      const onToolStart = vi.fn();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk,
        onThought: vi.fn(),
        onToolStart,
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
        onRunMeta: ({ runId }) => {
          capturedRunId = runId;
        },
      };

      const cancel = streamViaEngine(
        'hello ipc',
        callbacks,
        'sess-ipc-1',
        'asst-ipc-1'
      );

      await vi.waitFor(() => {
        expect(startRunTask).toHaveBeenCalledTimes(1);
        expect(messageListener.current).not.toBeNull();
      });
      // 前端 runId 自管（03 §3.1）：请求携带与本地一致，Rust 回发事件注入同一 runId
      const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
      expect(params.runId).toBe(capturedRunId);
      expect(params.prompt).toBe('hello ipc');
      expect(params.sessionId).toBe('sess-ipc-1');

      const listener = messageListener.current!;
      // 正文增量（B6.3 平铺事件：顶层 runId/sequence）
      listener({
        type: 'message-delta',
        runId: capturedRunId,
        sequence: 1,
        block: { type: 'text', text: 'Hi ' },
      });
      listener({
        type: 'message-delta',
        runId: capturedRunId,
        sequence: 2,
        block: { type: 'text', text: 'IPC' },
      });
      expect(onChunk.mock.calls.map((c) => c[0]).join('')).toBe('Hi IPC');

      // 工具事件
      listener({
        type: 'tool-start',
        runId: capturedRunId,
        sequence: 3,
        call: { id: 't-ipc', toolName: 'bash', args: 'ls' },
      });
      expect(onToolStart).toHaveBeenCalledWith('t-ipc', 'bash', 'ls', '');

      // 过滤不误杀：他 run 事件不路由（runId 注入后 filter 精确命中）
      onChunk.mockClear();
      listener({
        type: 'message-delta',
        runId: 'run-other',
        sequence: 4,
        block: { type: 'text', text: 'DROP' },
      });
      expect(onChunk).not.toHaveBeenCalled();

      // 收口：run-terminal(completed) → finish → onComplete
      listener({
        type: 'run-terminal',
        runId: capturedRunId,
        sequence: 5,
        terminal: 'completed',
      });
      expect(onComplete).toHaveBeenCalled();
      cancel();
    });
  });
});
